import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { archiveTerminalHistoricalJournalEvidence } from
  "../scripts/lib/archive-historical-ingestion.mjs";
import {
  ARCHIVE_FILES,
  openLosslessPostArchive
} from "../scripts/lib/lossless-post-archive.mjs";

async function withDirectory(callback) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "historical-ingestion-archive-"));
  try {
    return await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("streams terminal journal evidence, records missing-ID skips, and replays idempotently", async () => {
  await withDirectory(async (rootDir) => {
    const archiveDir = path.join(rootDir, "archive");
    const journalPath = path.join(rootDir, "pages.ndjson");
    const canonicalPath = path.join(rootDir, "public-evidence-current.json");
    const targetKey = "TEST:company-acme:hacker_news";
    const rawEnvelope = { objectID: "42", title: "Acme launch", points: 11 };
    const evidence = [{
      platform: "hacker_news",
      batchSlug: "TEST",
      externalId: "hn:42",
      sourceUrl: "https://news.ycombinator.com/item?id=42",
      title: "Acme launch",
      text: "Acme launched.",
      discoveredAt: "2026-08-04T12:01:00.000Z",
      metrics: { points: 11, comments: 3 },
      rawEnvelope
    }, {
      platform: "hacker_news",
      batchSlug: "TEST",
      sourceUrl: "https://news.ycombinator.com/item?id=missing",
      title: "Rejected identity-less row"
    }];
    const events = [{
      sequence: 1,
      recordedAt: "2026-08-04T12:00:00.000Z",
      type: "run_initialized",
      configFingerprint: "fixture-fingerprint",
      config: { targetKeys: [targetKey] }
    }, {
      sequence: 2,
      recordedAt: "2026-08-04T12:02:00.000Z",
      type: "page_checkpoint",
      targetKey,
      receipt: {
        platform: "hacker_news",
        batchSlug: "TEST",
        page: 0,
        requestUrl: "https://hn.algolia.com/api/v1/search_by_date?page=0"
      },
      evidence
    }, {
      sequence: 3,
      recordedAt: "2026-08-04T12:03:00.000Z",
      type: "target_completed",
      targetKey,
      receipt: { platform: "hacker_news", batchSlug: "TEST", outcome: "collected" }
    }, {
      sequence: 4,
      recordedAt: "2026-08-04T12:04:00.000Z",
      type: "run_completed",
      summary: {
        status: "completed",
        completedAt: "2026-08-04T12:04:00.000Z",
        targetPlatformPairs: 1,
        completedTargetPlatformPairs: 1,
        totals: { targets: 1 }
      }
    }];
    await writeFile(journalPath, `${events.map(JSON.stringify).join("\n")}\n`, "utf8");
    await writeFile(canonicalPath, "canonical sentinel\n", "utf8");
    const archive = await openLosslessPostArchive(archiveDir);

    const first = await archiveTerminalHistoricalJournalEvidence({ archive, journalPath });
    assert.equal(first.archived, 1);
    assert.equal(first.appended, 1);
    assert.equal(first.replayed, 0);
    assert.equal(first.skippedWithoutNativeId, 1);
    assert.deepEqual(first.skips, [{
      reason: "missing_native_id",
      platform: "hacker_news",
      batchSlug: "TEST",
      targetKey,
      pageSequence: 2,
      evidenceIndex: 1,
      sourceUrl: "https://news.ycombinator.com/item?id=missing"
    }]);

    const post = archive.getPost("hacker_news", "hn:42");
    assert.equal(post.externalId, "hn:42");
    assert.equal(post.text, "Acme launched.");
    assert.equal(post.metrics, undefined);
    assert.equal(post.rawEnvelope, undefined);
    assert.deepEqual(
      archive.listRawEnvelopes({ platform: "hacker_news", nativeId: "hn:42" })[0]
        .content.rawEnvelope,
      rawEnvelope
    );
    assert.deepEqual(
      archive.listMetricSnapshots({ platform: "hacker_news", nativeId: "hn:42" })[0]
        .content.metrics,
      { points: 11, comments: 3 }
    );

    const checkpoint = archive.getCheckpoint("hacker_news", "historical-ingestion:TEST");
    assert.equal(checkpoint.cursor, 4);
    assert.equal(checkpoint.checkpoint.archivedNativePostCount, 1);
    assert.equal(checkpoint.checkpoint.skippedWithoutNativeIdCount, 1);
    assert.deepEqual(checkpoint.checkpoint.skips, first.skips);
    assert.deepEqual(checkpoint.metadata.targetKeys, [targetKey]);
    assert.equal(await readFile(canonicalPath, "utf8"), "canonical sentinel\n");

    const replay = await archiveTerminalHistoricalJournalEvidence({ archive, journalPath });
    assert.equal(replay.archived, 1);
    assert.equal(replay.appended, 0);
    assert.equal(replay.replayed, 1);
    assert.equal(archive.listCheckpointHistory({
      platform: "hacker_news",
      scope: "historical-ingestion:TEST"
    }).length, 1);
    for (const fileName of [
      ARCHIVE_FILES.rawEnvelopes,
      ARCHIVE_FILES.normalizedPosts,
      ARCHIVE_FILES.metricSnapshots,
      ARCHIVE_FILES.checkpoints
    ]) {
      const lines = (await readFile(path.join(archiveDir, fileName), "utf8")).trim().split("\n");
      assert.equal(lines.length, 1, `${fileName} must remain idempotent`);
    }
  });
});

test("accepts normalized page rows and does not checkpoint after a failed archive write", async () => {
  const calls = [];
  const archive = {
    async appendPost(input) {
      calls.push(["post", input.nativeId]);
      if (input.nativeId === "rss:2") throw new Error("archive disk write failed");
      return {
        raw: { status: "appended" },
        normalized: { status: "appended" },
        metrics: [{ status: "appended" }]
      };
    },
    async updateCheckpoint(input) {
      calls.push(["checkpoint", input.scope]);
    }
  };

  await assert.rejects(
    archiveTerminalHistoricalJournalEvidence({
      archive,
      terminal: {
        status: "completed",
        lastSequence: 9,
        recordedAt: "2026-08-04T13:00:00.000Z"
      },
      pageRows: [{
        sequence: 7,
        recordedAt: "2026-08-04T12:59:00.000Z",
        targetKey: "TEST:company-acme:rss",
        receipt: { platform: "rss", batchSlug: "TEST", page: 1 },
        evidence: [
          { externalId: "rss:1", title: "one" },
          { externalId: "rss:2", title: "two" }
        ]
      }]
    }),
    /archive disk write failed/
  );
  assert.deepEqual(calls, [["post", "rss:1"], ["post", "rss:2"]]);
});

test("rejects a nonterminal journal before writing archive rows", async () => {
  await withDirectory(async (rootDir) => {
    const journalPath = path.join(rootDir, "pages.ndjson");
    await writeFile(journalPath, `${JSON.stringify({
      sequence: 1,
      type: "run_initialized",
      config: { targetKeys: ["TEST:company-acme:web"] }
    })}\n`, "utf8");
    const calls = [];
    const archive = {
      async appendPost(input) {
        calls.push(["post", input.nativeId]);
      },
      async updateCheckpoint(input) {
        calls.push(["checkpoint", input.scope]);
      }
    };

    await assert.rejects(
      archiveTerminalHistoricalJournalEvidence({ archive, journalPath }),
      /not terminal and complete/
    );
    assert.deepEqual(calls, []);
  });
});
