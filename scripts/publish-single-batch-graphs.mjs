import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BATCH_SNAPSHOTS,
  fetchGraph,
  getGraphApiServer,
  inheritCanonicalAudienceSnapshotState,
  publishOperationsAtomically,
  validateGraphSnapshots
} from "./update-daily-benchmarks.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const batchSlug = args.batch ?? "S26";
const port = Number(args.port ?? 3100);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid --port: ${args.port}`);
}

// The production graph bundle reads compact generated-runtime snapshots.
// Refresh them from canonical evidence before starting that bundle so a
// promotion cannot be silently omitted until some unrelated build runs.
execFileSync(
  process.execPath,
  [join(root, "scripts", "prepare-graph-runtime-evidence.mjs")],
  { cwd: root, env: process.env, stdio: "inherit" }
);

const selectedDescriptors = batchSlug === "ALL"
  ? BATCH_SNAPSHOTS
  : BATCH_SNAPSHOTS.filter((descriptor) => descriptor.slug === batchSlug);
if (![3, BATCH_SNAPSHOTS.length].includes(selectedDescriptors.length)) {
  throw new Error(`Expected three batch graphs or all ${BATCH_SNAPSHOTS.length} graphs for ${batchSlug}.`);
}

const runStartedAt = new Date();
const existingEntries = await Promise.all(BATCH_SNAPSHOTS.map(async (descriptor) => ({
  descriptor,
  graph: JSON.parse(await readFile(graphPath(descriptor), "utf8"))
})));
const targetHashes = new Map(await Promise.all(selectedDescriptors.map(async (descriptor) => [
  descriptor.filename,
  sha256(await readFile(graphPath(descriptor)))
])));
const existingGlobalCalibration = uniqueGlobalCalibration(existingEntries);
if (batchSlug !== "ALL" && !existingGlobalCalibration) {
  throw new Error("Existing graph artifacts disagree on the global calibration parameters.");
}

const server = getGraphApiServer({ port });
let fetchedEntries;
try {
  fetchedEntries = await Promise.all(selectedDescriptors.map(async (descriptor) => ({
    descriptor,
    graph: await fetchFreshGraph(server, descriptor)
  })));
} finally {
  await server.finish();
}

for (const { descriptor, graph } of fetchedEntries) {
  const generatedAt = Date.parse(graph?.generatedAt ?? "");
  if (!Number.isFinite(generatedAt) || generatedAt < runStartedAt.getTime() - 60_000) {
    throw new Error(`${descriptor.filename} was not freshly recomputed during this run.`);
  }
}

const fetchedByFilename = new Map(fetchedEntries.map((entry) => [entry.descriptor.filename, entry]));
const combinedEntries = inheritCanonicalAudienceSnapshotState(
  existingEntries.map((entry) => fetchedByFilename.get(entry.descriptor.filename) ?? entry)
);
validateGraphSnapshots(combinedEntries, { now: new Date() });

const nextGlobalCalibration = uniqueGlobalCalibration(combinedEntries);
if (!nextGlobalCalibration) {
  throw new Error("Fresh graph artifacts disagree on the global calibration parameters.");
}
if (
  batchSlug !== "ALL" &&
  (nextGlobalCalibration.benchmarkScore !== existingGlobalCalibration.benchmarkScore ||
    nextGlobalCalibration.cohortSize !== existingGlobalCalibration.cohortSize)
) {
  throw new Error(
    `Global calibration changed from ${JSON.stringify(existingGlobalCalibration)} to ${JSON.stringify(nextGlobalCalibration)}; all cohorts must be rebuilt together.`
  );
}

const publishedEntries = combinedEntries.filter((entry) =>
  batchSlug === "ALL" || entry.descriptor.slug === batchSlug
);
const baseGraph = publishedEntries.find((entry) =>
  entry.descriptor.slug === "S26" && !entry.descriptor.topVoices
)?.graph;
const tashNode = baseGraph?.nodes?.find((node) => node.entityId === "company-tash");
const tashPost = baseGraph?.evidence?.find(
  (row) => row.platform === "linkedin" && row.platformPostId === "7489018280448245760"
);
if (["S26", "ALL"].includes(batchSlug) && (!tashNode || Number(tashNode.score) <= 0 || !tashPost)) {
  throw new Error("Fresh S26 graph did not include the verified Tash LinkedIn post and positive score.");
}

for (const descriptor of selectedDescriptors) {
  const currentHash = sha256(await readFile(graphPath(descriptor)));
  if (currentHash !== targetHashes.get(descriptor.filename)) {
    throw new Error(`${descriptor.filename} changed concurrently; refusing to publish over it.`);
  }
}

await publishOperationsAtomically(publishedEntries.map(({ descriptor, graph }) => ({
  kind: "graph",
  batch: descriptor.slug,
  topVoices: descriptor.topVoices ?? "off",
  targetPath: graphPath(descriptor),
  content: `${JSON.stringify(graph)}\n`
})));

console.log(JSON.stringify({
  status: "published",
  batchSlug,
  files: selectedDescriptors.map((descriptor) => descriptor.filename),
  globalCalibration: nextGlobalCalibration,
  generatedAt: baseGraph?.generatedAt ?? publishedEntries[0]?.graph?.generatedAt,
  tash: ["S26", "ALL"].includes(batchSlug)
    ? {
        score: tashNode.score,
        topPlatform: tashNode.topPlatform,
        linkedinMetrics: tashPost.metrics,
        sourceUrl: tashPost.sourceUrl
      }
    : undefined
}, null, 2));

function uniqueGlobalCalibration(entries) {
  const values = new Map();
  for (const { graph } of entries) {
    for (const node of graph?.nodes ?? []) {
      const calibration = node?.scoreBreakdown?.calibration;
      if (!Number.isFinite(calibration?.benchmarkScore) || !Number.isFinite(calibration?.cohortSize)) continue;
      const key = `${calibration.benchmarkScore}:${calibration.cohortSize}`;
      values.set(key, {
        benchmarkScore: calibration.benchmarkScore,
        cohortSize: calibration.cohortSize
      });
    }
  }
  return values.size === 1 ? [...values.values()][0] : null;
}

async function fetchFreshGraph(server, descriptor) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchGraph(server.baseUrl, descriptor.slug, descriptor.topVoices, {
        publicationToken: server.publicationToken,
        signal: server.signal,
        timeoutMs: 15_000
      });
    } catch (error) {
      lastError = error;
      if (server.signal?.aborted) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  throw new Error(`Graph server was not ready for ${descriptor.filename}: ${lastError?.message ?? lastError}`);
}

function graphPath(descriptor) {
  return join(root, "public", "graph", descriptor.filename);
}

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    const match = value.match(/^--([^=]+)=(.+)$/);
    if (!match) throw new Error(`Expected --name=value; received ${value}`);
    result[match[1]] = match[2];
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
