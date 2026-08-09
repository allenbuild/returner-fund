import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "vite";

const BATCHES = [
  { slug: "S2026", file: "s2026" },
  { slug: "S26", file: "s26" },
  { slug: "A16ZSR006", file: "a16zsr006" }
];
const AUDIENCES = ["off", "yc_partners", "insiders"];
const SNAPSHOT_VERSION = "2026-08-09-full-corpus-topics";

export async function buildExpectedTopicFacetSnapshots({ repoRoot = process.cwd() } = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "returner-topic-facets-runtime-"));
  const originalCwd = process.cwd();
  let vite = null;

  try {
    fs.symlinkSync(
      path.join(absoluteRepoRoot, "src"),
      path.join(runtimeRoot, "src"),
      process.platform === "win32" ? "junction" : "dir"
    );
    process.chdir(runtimeRoot);

    // Dataset modules read compact generated-runtime projections. Build those
    // from the canonical snapshots in an isolated temporary root so validation
    // is source-fresh without mutating the checkout.
    const prepareUrl = pathToFileURL(
      path.join(absoluteRepoRoot, "scripts", "prepare-graph-runtime-evidence.mjs")
    );
    prepareUrl.searchParams.set("topicFacetsRun", `${process.pid}-${Date.now()}`);
    await import(prepareUrl.href);

    vite = await createServer({
      root: absoluteRepoRoot,
      configFile: false,
      appType: "custom",
      logLevel: "error",
      resolve: {
        alias: {
          "@": path.join(absoluteRepoRoot, "src")
        }
      },
      server: {
        middlewareMode: true
      }
    });

    const [
      { buildGraphResponse },
      { canonicalPostKey },
      { normalizePostTopics }
    ] = await Promise.all([
      vite.ssrLoadModule("/src/lib/graph/graph-builder.ts"),
      vite.ssrLoadModule("/src/lib/graph/dedupe.ts"),
      vite.ssrLoadModule("/src/lib/graph/post-topics.ts")
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
        outputPath: path.join(absoluteRepoRoot, ...displayPath.split("/")),
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
    if (vite) await vite.close();
    process.chdir(originalCwd);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
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
  const unknownArgs = args.filter((arg) => arg !== "--validate");
  if (unknownArgs.length) {
    throw new Error(`Unknown topic facet argument(s): ${unknownArgs.join(", ")}`);
  }
  const validateOnly = args.includes("--validate");
  const snapshots = await buildExpectedTopicFacetSnapshots();
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
  console.log(JSON.stringify({
    status: "written",
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
