import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareGraphRuntimeEvidence } from "./prepare-graph-runtime-evidence.mjs";
import { validatedRepositoryDataRoot } from "./lib/validated-repository-data-root.mjs";

const BATCHES = [
  { slug: "S2026", file: "s2026" },
  { slug: "S26", file: "s26" },
  { slug: "A16ZSR006", file: "a16zsr006" }
];
const AUDIENCES = ["off", "yc_partners", "insiders"];
const SNAPSHOT_VERSION = "2026-08-09-full-corpus-topics";
const PINNED_CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildExpectedTopicFacetSnapshots({ repoRoot, dataRoot } = {}) {
  const absoluteDataRoot = validatedRepositoryDataRoot(
    dataRoot ?? repoRoot ?? process.env.SCORING_DATA_ROOT ?? process.env.SCORING_ROOT,
    { fallbackRoot: process.cwd(), label: "topic facet data root" }
  );
  const originalCwd = process.cwd();

  try {
    // Pinned modules perform a few explicit cwd-relative runtime reads. Keep
    // those reads bound to publication data while every imported TS/JS module
    // is resolved relative to this immutable source checkout.
    process.chdir(absoluteDataRoot);
    await prepareGraphRuntimeEvidence({ rootDir: absoluteDataRoot });

    const [
      { buildGraphResponse },
      { canonicalPostKey },
      { normalizePostTopics }
    ] = await Promise.all([
      importPinnedModule("src/lib/graph/graph-builder.ts"),
      importPinnedModule("src/lib/graph/dedupe.ts"),
      importPinnedModule("src/lib/graph/post-topics.ts")
    ]);

    return BATCHES.map((batch) => {
      const records = new Map();

      for (const audienceId of AUDIENCES) {
        const graph = buildGraphResponse({
          batchSlug: batch.slug,
          topVoices: audienceId
        });
        const evidence = graph.evidence ?? [];
        const companyByEntity = companyOwnershipIndex(graph.nodes ?? []);

        for (const item of evidence) {
          const companyId = item.attachedCompanyId ?? companyByEntity.get(item.entityId);
          const postKey = canonicalPostKey(item);
          if (!companyId || !postKey) continue;

          for (const topic of normalizePostTopics(item.topics ?? [])) {
            addFacetRow(records, {
              topic,
              postKey,
              platform: item.platform,
              companyId,
              contributionScore: Number.isFinite(item.contributionScore)
                ? item.contributionScore
                : 0,
              audienceId
            });
          }
        }

        if (audienceId === "off") {
          const offPostCount = new Set(
            [...records.values()]
              .filter((row) => row.audienceId === "off")
              .map((row) => row.postKey)
          ).size;
          if (offPostCount !== evidence.length) {
            throw new Error(
              `${batch.slug} owned-corpus topic facets cover ${offPostCount}/${evidence.length} posts.`
            );
          }
        }
      }

      const rows = [...records.values()].sort((left, right) =>
        left.audienceId.localeCompare(right.audienceId) ||
        left.topic.localeCompare(right.topic) ||
        left.postKey.localeCompare(right.postKey) ||
        left.companyId.localeCompare(right.companyId)
      );
      const output = {
        version: SNAPSHOT_VERSION,
        batchSlug: batch.slug,
        rowCount: rows.length,
        rows
      };
      const displayPath = path.posix.join("public", "topic-facets", `${batch.file}.json`);

      return {
        batchSlug: batch.slug,
        displayPath,
        outputPath: path.join(absoluteDataRoot, ...displayPath.split("/")),
        serialized: JSON.stringify(output),
        summary: {
          batch: batch.slug,
          records: records.size,
          rows: rows.length,
          byAudience: countRowsByAudience(rows)
        }
      };
    });
  } finally {
    process.chdir(originalCwd);
  }
}

async function importPinnedModule(relativePath) {
  const modulePath = path.resolve(PINNED_CODE_ROOT, relativePath);
  const pathFromCodeRoot = path.relative(PINNED_CODE_ROOT, modulePath);
  if (pathFromCodeRoot.startsWith("..") || path.isAbsolute(pathFromCodeRoot)) {
    throw new Error(`Pinned topic facet module escapes its source checkout: ${relativePath}`);
  }
  return import(pathToFileURL(modulePath).href);
}

export async function runTopicFacetBoundaryProbe({ dataRoot } = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The topic facet boundary probe is available only under NODE_ENV=test.");
  }
  const absoluteDataRoot = validatedRepositoryDataRoot(
    dataRoot ?? process.env.SCORING_DATA_ROOT ?? process.env.SCORING_ROOT,
    { fallbackRoot: process.cwd(), label: "topic facet boundary-probe data root" }
  );
  const originalCwd = process.cwd();
  try {
    process.chdir(absoluteDataRoot);
    const probe = await importPinnedModule("tests/fixtures/topic-facet-boundary-probe.ts");
    return probe.topicFacetBoundaryProbe;
  } finally {
    process.chdir(originalCwd);
  }
}

export function validateTopicFacetSnapshots(snapshots) {
  const stalePaths = [];
  for (const snapshot of snapshots) {
    let actual;
    try {
      actual = fs.readFileSync(snapshot.outputPath);
    } catch {
      stalePaths.push(snapshot.displayPath);
      continue;
    }
    const expected = Buffer.from(snapshot.serialized, "utf8");
    if (!actual.equals(expected)) stalePaths.push(snapshot.displayPath);
  }
  return { valid: stalePaths.length === 0, stalePaths };
}

export function writeTopicFacetSnapshotsAtomically(snapshots) {
  if (!snapshots.length) return;
  const outputDirectory = path.dirname(snapshots[0].outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(outputDirectory, ".topic-facets-"));

  try {
    const staged = snapshots.map((snapshot, index) => {
      const temporaryPath = path.join(
        temporaryDirectory,
        `${String(index).padStart(2, "0")}-${path.basename(snapshot.outputPath)}`
      );
      fs.writeFileSync(temporaryPath, snapshot.serialized, "utf8");
      return { snapshot, temporaryPath };
    });
    for (const { snapshot, temporaryPath } of staged) {
      fs.renameSync(temporaryPath, snapshot.outputPath);
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const rootArgument = args.find((arg) => arg.startsWith("--root="));
  const unknownArgs = args.filter((arg) =>
    arg !== "--validate" && arg !== "--boundary-probe" && arg !== rootArgument
  );
  if (unknownArgs.length) {
    throw new Error(`Unknown topic facet argument(s): ${unknownArgs.join(", ")}`);
  }
  const validateOnly = args.includes("--validate");
  const dataRoot = rootArgument?.slice("--root=".length);
  if (args.includes("--boundary-probe")) {
    process.stdout.write(`${JSON.stringify(await runTopicFacetBoundaryProbe({ dataRoot }))}\n`);
    return;
  }
  const snapshots = await buildExpectedTopicFacetSnapshots({ dataRoot });
  for (const snapshot of snapshots) console.log(JSON.stringify(snapshot.summary));

  if (validateOnly) {
    const result = validateTopicFacetSnapshots(snapshots);
    if (!result.valid) {
      console.error(JSON.stringify({ status: "stale", stalePaths: result.stalePaths }));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({
      status: "valid",
      paths: snapshots.map((snapshot) => snapshot.displayPath)
    }));
    return;
  }

  writeTopicFacetSnapshotsAtomically(snapshots);
  const written = validateTopicFacetSnapshots(snapshots);
  if (!written.valid) {
    throw new Error(
      `Topic facet publication verification failed for ${written.stalePaths.join(", ")}.`
    );
  }
  console.log(JSON.stringify({
    status: "written_and_validated",
    paths: snapshots.map((snapshot) => snapshot.displayPath)
  }));
}

function addFacetRow(records, row) {
  const recordKey = `${row.audienceId}:${row.topic}:${row.postKey}`;
  const existing = records.get(recordKey);
  if (!existing) {
    records.set(recordKey, row);
    return;
  }

  if (
    existing.companyId !== row.companyId ||
    existing.platform !== row.platform ||
    existing.contributionScore !== row.contributionScore
  ) {
    throw new Error(
      `Conflicting topic facet rows for ${recordKey}: ` +
      `${JSON.stringify(existing)} versus ${JSON.stringify(row)}`
    );
  }
}

function companyOwnershipIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    if (node.entityType !== "company") continue;
    index.set(node.entityId, node.entityId);
    for (const founder of node.founders ?? []) index.set(founder.id, node.entityId);
  }
  return index;
}

function countRowsByAudience(rows) {
  const counts = {};
  for (const row of rows) {
    counts[row.audienceId] = (counts[row.audienceId] ?? 0) + 1;
  }
  return counts;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) await runCli();
