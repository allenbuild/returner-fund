import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  rebuildPublicGraphMomentum,
  repairBenchmarkHistory
} from "../scripts/repair-benchmark-history.mjs";

const BATCHES = ["S2026", "S26", "A16ZSR006"];

test("recovers only missing Central-day snapshots from the known source snapshot", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "benchmark-history-repair-"));
  await writeHistories(rootDir);

  const dryRun = await repairBenchmarkHistory({ rootDir });
  assert.equal(dryRun.status, "dry-run");
  assert.deepEqual(dryRun.batches.map((batch) => batch.insertedDates), [
    ["2026-08-06", "2026-08-07"],
    ["2026-08-06", "2026-08-07"],
    ["2026-08-06", "2026-08-07"]
  ]);

  const result = await repairBenchmarkHistory({ rootDir, write: true });
  assert.equal(result.status, "repaired");

  for (const batchSlug of BATCHES) {
    const history = JSON.parse(await readFile(historyPath(rootDir, batchSlug), "utf8"));
    const recovered = history.daily.filter((snapshot) => snapshot.recovery);
    assert.deepEqual(recovered.map((snapshot) => snapshot.recordedAt), [
      "2026-08-06T12:00:00.000Z",
      "2026-08-07T12:00:00.000Z"
    ]);
    assert.deepEqual(recovered.map((snapshot) => snapshot.recovery), [
      {
        method: "source-stable-snapshot",
        sourceCentralDate: "2026-08-05",
        sourceRecordedAt: "2026-08-05T06:00:00.000Z",
        sourceInputGeneratedAt: "2026-08-05T06:00:00.000Z"
      },
      {
        method: "source-stable-snapshot",
        sourceCentralDate: "2026-08-05",
        sourceRecordedAt: "2026-08-05T06:00:00.000Z",
        sourceInputGeneratedAt: "2026-08-05T06:00:00.000Z"
      }
    ]);
  }
});

test("rebuilds static week-over-week rows from the repaired exact-day history", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "benchmark-momentum-rebuild-"));
  await writeHistories(rootDir);
  await writeGraphs(rootDir);

  await repairBenchmarkHistory({ rootDir, write: true });
  const result = await rebuildPublicGraphMomentum({ rootDir, write: true });
  assert.equal(result.status, "rebuilt");
  assert.equal(result.batches[1].weekOverWeekBaseline, "2026-08-07T12:00:00.000Z");
  assert.equal(result.batches[1].comparableRows, 2);

  const baseGraph = JSON.parse(await readFile(graphPath(rootDir, "s26.json"), "utf8"));
  const partnerGraph = JSON.parse(await readFile(graphPath(rootDir, "s26-yc-partners.json"), "utf8"));
  assert.equal(baseGraph.fastestGaining[0].wow.benchmarkedAt, "2026-08-07T12:00:00.000Z");
  assert.equal(baseGraph.fastestGaining[0].wow.scoreDelta, 10);
  assert.deepEqual(partnerGraph.fastestGaining, baseGraph.fastestGaining.slice(0, 1));
});

async function writeHistories(rootDir) {
  for (const batchSlug of BATCHES) {
    const directory = path.dirname(historyPath(rootDir, batchSlug));
    await mkdir(directory, { recursive: true });
    const source = snapshot("2026-08-05T06:00:00.000Z");
    const existing = snapshot("2026-08-08T06:00:00.000Z");
    await writeFile(historyPath(rootDir, batchSlug), `${JSON.stringify({
      version: 1,
      batchSlug,
      updatedAt: "2026-08-08T06:00:00.000Z",
      daily: [source, existing],
      weekly: [source]
    }, null, 2)}\n`);
  }
}

function snapshot(recordedAt) {
  return {
    recordedAt,
    scoringModelVersion: "4.2.0",
    inputGeneratedAt: recordedAt,
    companies: [
      { companyId: "company-a", companyName: "A", score: 80, rank: 1 },
      { companyId: "company-b", companyName: "B", score: 70, rank: 2 }
    ]
  };
}

function historyPath(rootDir, batchSlug) {
  return path.join(rootDir, "outputs", "benchmarks", `${batchSlug.toLowerCase()}-score-benchmarks.json`);
}

async function writeGraphs(rootDir) {
  const directory = path.join(rootDir, "public", "graph");
  await mkdir(directory, { recursive: true });
  for (const batchSlug of BATCHES) {
    const baseFilename = `${batchSlug.toLowerCase()}.json`;
    const partnerFilename = `${batchSlug.toLowerCase()}-yc-partners.json`;
    const insiderFilename = `${batchSlug.toLowerCase()}-insiders.json`;
    const base = graph(batchSlug, [
      { companyId: "company-a", companyName: "A", score: 90, rank: 1 },
      { companyId: "company-b", companyName: "B", score: 75, rank: 2 }
    ]);
    await writeFile(graphPath(rootDir, baseFilename), `${JSON.stringify(base)}\n`);
    await writeFile(graphPath(rootDir, partnerFilename), `${JSON.stringify(graph(batchSlug, [base.leaderboard[0]]))}\n`);
    await writeFile(graphPath(rootDir, insiderFilename), `${JSON.stringify(graph(batchSlug, [base.leaderboard[1]]))}\n`);
  }
}

function graph(batchSlug, leaderboard) {
  return {
    batch: { slug: batchSlug },
    generatedAt: "2026-08-14T12:00:00.000Z",
    scoringContext: { modelVersion: "4.2.0" },
    leaderboard,
    fastestGaining: []
  };
}

function graphPath(rootDir, filename) {
  return path.join(rootDir, "public", "graph", filename);
}
