import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const repositoryRoot = process.cwd();
const statusPath = path.join(repositoryRoot, "scripts", "long-run-status.mjs");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("long-run status", () => {
  it("aggregates only the active sweep's isolated public shard checkpoints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "returner-long-run-status-"));
    temporaryRoots.push(root);
    const idempotencyKey = "source-sweep-contract-sweep-000";
    const workRoot = path.join(
      root,
      "work",
      "autonomous-ingestion",
      safePathSegment(idempotencyKey)
    );
    await Promise.all([
      mkdir(path.join(root, "outputs", "longrun"), { recursive: true }),
      mkdir(path.join(root, "docs"), { recursive: true }),
      mkdir(workRoot, { recursive: true }),
      mkdir(path.join(root, "work"), { recursive: true })
    ]);
    await writeJson(path.join(root, "outputs", "longrun", "active-run.json"), {
      runId: "source-sweep-contract",
      pid: 999_999_999,
      startedAt: new Date().toISOString(),
      launchedAt: new Date().toISOString(),
      status: "running",
      currentSweep: {
        idempotencyKey,
        cycleIndex: 0,
        attempt: 1
      }
    });
    await writeJson(
      path.join(workRoot, "checkpoint-public-s2026-shard-0-of-4.json"),
      {
        attempts: {
          a: { status: "done" },
          b: { status: "failed" }
        },
        evidence: [{ platform: "x" }, { platform: "linkedin" }],
        needsReview: [{ platform: "linkedin" }],
        failures: [{ platform: "x" }],
        discoveryAttempts: [{ id: "attempt-a" }],
        sourceDiscoveryPaths: [{ id: "path-a" }]
      }
    );
    await writeJson(
      path.join(workRoot, "checkpoint-public-s26-shard-1-of-2.json"),
      {
        attempts: {
          c: { status: "done" }
        },
        evidence: [{ platform: "youtube" }],
        needsReview: [{ platform: "instagram" }],
        failures: [{ platform: "reddit" }, { platform: "reddit" }],
        discoveryAttempts: [{ id: "attempt-b" }, { id: "attempt-c" }],
        sourceDiscoveryPaths: []
      }
    );
    await writeJson(path.join(root, "work", "public-traction-checkpoint.json"), {
      attempts: Object.fromEntries(
        Array.from({ length: 99 }, (_, index) => [`legacy-${index}`, { status: "done" }])
      ),
      evidence: Array.from({ length: 99 }, () => ({ platform: "legacy" }))
    });

    const result = spawnSync(process.execPath, [statusPath], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const checkpoint = payload.liveIngestionCheckpoint;
    assert.equal(checkpoint.idempotencyKey, idempotencyKey);
    assert.equal(checkpoint.workRoot, await realpath(workRoot));
    assert.equal(checkpoint.checkpointCount, 2);
    assert.equal(checkpoint.attemptCount, 3);
    assert.deepEqual(checkpoint.attemptStatusCounts, { done: 2, failed: 1 });
    assert.deepEqual(checkpoint.rows, {
      evidence: 3,
      needsReview: 2,
      failures: 3,
      discoveryAttempts: 3,
      sourceDiscoveryPaths: 1
    });
    assert.deepEqual(checkpoint.platformRows.evidence, {
      x: 1,
      linkedin: 1,
      youtube: 1
    });
    assert.equal(checkpoint.shards.length, 2);
    assert.deepEqual(
      checkpoint.shards.map((shard) => [
        shard.batchSlug,
        shard.shardIndex,
        shard.shardCount
      ]),
      [
        ["S2026", 0, 4],
        ["S26", 1, 2]
      ]
    );
  });
});

function safePathSegment(value) {
  const source = String(value);
  const prefix =
    source
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "run";
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
