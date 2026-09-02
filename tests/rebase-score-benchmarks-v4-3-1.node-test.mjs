import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rebaseScoreBenchmarks } from "../scripts/rebase-score-benchmarks-v4-3-1.mjs";

const BATCHES = ["S2026", "S26", "A16ZSR006"];
const SCORE_CALIBRATION = {
  kind: "linear_model_rebase",
  sourceModelVersion: "4.3.0",
  factor: 0.95,
  headlineTarget: 95,
  rounding: "nearest_integer"
};

test("adds ranked 4.3.1 projections without changing 4.3.0 history and is idempotent", async (t) => {
  const rootDir = fixtureRoot(t);
  const originalByBatch = new Map();
  for (const batch of BATCHES) {
    const store = benchmarkStore(batch);
    originalByBatch.set(batch, structuredClone(store));
    writeStore(rootDir, batch, store);
  }

  const first = await rebaseScoreBenchmarks({ rootDir, write: true });
  assert.equal(first.status, "rebased");
  assert.deepEqual(
    first.batches.map((batch) => [batch.insertedDaily, batch.insertedWeekly]),
    [[1, 1], [1, 1], [1, 1]]
  );

  const bytesAfterFirst = new Map();
  for (const batch of BATCHES) {
    const targetPath = storePath(rootDir, batch);
    const store = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    bytesAfterFirst.set(batch, fs.readFileSync(targetPath, "utf8"));
    const original = originalByBatch.get(batch);
    assert.deepEqual(
      store.daily.find((snapshot) => snapshot.scoringModelVersion === "4.3.0"),
      original.daily[0]
    );
    assert.deepEqual(
      store.weekly.find((snapshot) => snapshot.scoringModelVersion === "4.3.0"),
      original.weekly[0]
    );

    const projected = store.daily.find(
      (snapshot) => snapshot.scoringModelVersion === "4.3.1"
    );
    assert.deepEqual(projected.scoreCalibration, SCORE_CALIBRATION);
    assert.deepEqual(
      projected.companies.map(({ companyId, score, rank }) => ({ companyId, score, rank })),
      [
        { companyId: "company-alpha", score: 95, rank: 1 },
        { companyId: "company-beta", score: 80, rank: 2 },
        { companyId: "company-gamma", score: 80, rank: 2 },
        { companyId: "company-zero", score: 0, rank: 4 }
      ]
    );
  }

  const second = await rebaseScoreBenchmarks({ rootDir, write: true });
  assert.deepEqual(
    second.batches.map((batch) => [batch.insertedDaily, batch.insertedWeekly]),
    [[0, 0], [0, 0], [0, 0]]
  );
  for (const batch of BATCHES) {
    assert.equal(fs.readFileSync(storePath(rootDir, batch), "utf8"), bytesAfterFirst.get(batch));
  }
});

test("keeps an observed target-model day and can exclude the active Central day", async (t) => {
  const rootDir = fixtureRoot(t);
  for (const batch of BATCHES) {
    const store = benchmarkStore(batch);
    store.daily.push({
      recordedAt: "2026-09-02T16:00:00.000Z",
      scoringModelVersion: "4.3.0",
      inputGeneratedAt: "2026-09-02T15:00:00.000Z",
      companies: sourceCompanies()
    });
    store.daily.push({
      recordedAt: "2026-09-01T18:00:00.000Z",
      scoringModelVersion: "4.3.1",
      inputGeneratedAt: "2026-09-01T17:00:00.000Z",
      companies: [{
        companyId: "company-observed",
        companyName: "Observed",
        score: 71,
        rank: 1
      }]
    });
    writeStore(rootDir, batch, store);
  }

  const result = await rebaseScoreBenchmarks({
    rootDir,
    write: true,
    beforeCentralDay: "2026-09-02"
  });

  for (const batchResult of result.batches) {
    assert.equal(batchResult.insertedDaily, 0);
    assert.deepEqual(batchResult.skippedExistingDailyDays, ["2026-09-01"]);
    const store = JSON.parse(fs.readFileSync(batchResult.targetPath, "utf8"));
    assert.equal(
      store.daily.filter((snapshot) => snapshot.scoringModelVersion === "4.3.1").length,
      1
    );
    assert.equal(
      store.daily.some(
        (snapshot) =>
          snapshot.scoringModelVersion === "4.3.1" &&
          snapshot.recordedAt.startsWith("2026-09-02")
      ),
      false
    );
  }
});

function fixtureRoot(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "score-benchmark-rebase-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function benchmarkStore(batchSlug) {
  const snapshot = {
    recordedAt: "2026-09-01T16:00:00.000Z",
    scoringModelVersion: "4.3.0",
    inputGeneratedAt: "2026-09-01T15:00:00.000Z",
    legacyMarker: "preserve-me",
    companies: sourceCompanies()
  };
  return {
    version: 1,
    batchSlug,
    updatedAt: snapshot.recordedAt,
    daily: [structuredClone(snapshot)],
    weekly: [structuredClone(snapshot)]
  };
}

function sourceCompanies() {
  return [
    { companyId: "company-zero", companyName: "Zero", score: 0, rank: 99 },
    { companyId: "company-gamma", companyName: "Gamma", score: 84, rank: 99 },
    { companyId: "company-alpha", companyName: "Alpha", score: 100, rank: 99 },
    { companyId: "company-beta", companyName: "Beta", score: 84, rank: 99 }
  ];
}

function writeStore(rootDir, batchSlug, store) {
  const targetPath = storePath(rootDir, batchSlug);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function storePath(rootDir, batchSlug) {
  return path.join(
    rootDir,
    "outputs",
    "benchmarks",
    `${batchSlug.toLowerCase()}-score-benchmarks.json`
  );
}
