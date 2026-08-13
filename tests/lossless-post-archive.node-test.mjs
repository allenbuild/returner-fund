import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_FILES,
  LosslessArchiveConflictError,
  contentHash,
  openLosslessPostArchive
} from "../scripts/lib/lossless-post-archive.mjs";

async function withArchive(callback) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "lossless-post-archive-"));
  try {
    return await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("appends lossless raw and normalized rows, preserving relationships and media", async () => {
  await withArchive(async (rootDir) => {
    const archive = await openLosslessPostArchive(rootDir);
    const rawEnvelope = {
      id: "123",
      body: "raw source payload",
      attachments: [{ type: "image", url: "https://cdn.example/image.jpg" }]
    };
    const normalizedPost = {
      text: "normalized post",
      media: [{ type: "image", url: "https://cdn.example/image.jpg", alt: "diagram" }],
      parentId: "99",
      threadId: "77",
      quoteId: "55"
    };

    const first = await archive.appendPost({
      platform: "X",
      nativeId: "123",
      rawEnvelope,
      normalizedPost,
      observedAt: "2026-08-04T00:00:00.000Z",
      metrics: { likes: 4, replies: 2 }
    });
    const second = await archive.appendPost({
      platform: "x",
      nativeId: "123",
      rawEnvelope,
      normalizedPost,
      observedAt: "2026-08-04T00:00:00.000Z",
      metrics: { likes: 4, replies: 2 }
    });

    assert.equal(first.raw.status, "appended");
    assert.equal(first.normalized.status, "appended");
    assert.equal(second.raw.status, "duplicate");
    assert.equal(second.normalized.status, "duplicate");
    assert.equal(second.metrics[0].status, "duplicate");
    assert.deepEqual(archive.getPost("x", "123"), {
      platform: "x",
      nativeId: "123",
      text: "normalized post",
      media: [{ type: "image", url: "https://cdn.example/image.jpg", alt: "diagram" }],
      parentId: "99",
      threadId: "77",
      quoteId: "55",
      relationships: { parent: "99", thread: "77", quote: "55" }
    });
    assert.deepEqual(archive.listRawEnvelopes({ platform: "x", nativeId: "123" })[0].content.rawEnvelope, rawEnvelope);
    assert.equal(archive.listMetricSnapshots({ platform: "x", nativeId: "123" }).length, 1);

    const rawLines = (await readFile(path.join(rootDir, ARCHIVE_FILES.rawEnvelopes), "utf8")).trim().split("\n");
    const normalizedLines = (await readFile(path.join(rootDir, ARCHIVE_FILES.normalizedPosts), "utf8")).trim().split("\n");
    assert.equal(rawLines.length, 1);
    assert.equal(normalizedLines.length, 1);
    const rawRecord = JSON.parse(rawLines[0]);
    assert.equal(rawRecord.contentHash, contentHash({
      schemaVersion: rawRecord.schemaVersion,
      recordType: rawRecord.recordType,
      key: rawRecord.key,
      content: rawRecord.content
    }));
  });
});

test("rejects a destructive normalized rewrite while retaining the original row", async () => {
  await withArchive(async (rootDir) => {
    const archive = await openLosslessPostArchive(rootDir);
    await archive.appendPost({
      platform: "linkedin",
      nativeId: "activity-1",
      rawEnvelope: { text: "first" },
      normalizedPost: { text: "first", media: [] }
    });

    await assert.rejects(
      archive.appendPost({
        platform: "linkedin",
        nativeId: "activity-1",
        rawEnvelope: { text: "rewritten" },
        normalizedPost: { text: "rewritten", media: [] }
      }),
      (error) => error instanceof LosslessArchiveConflictError && error.code === "LOSSLESS_ARCHIVE_CONFLICT"
    );
    assert.equal(archive.listPosts()[0].text, "first");
    assert.equal(archive.listRawEnvelopes({ platform: "linkedin", nativeId: "activity-1" }).length, 1);
  });
});

test("records metric history, account identity history, checkpoints, and tombstones append-only", async () => {
  await withArchive(async (rootDir) => {
    const archive = await openLosslessPostArchive(rootDir);

    await archive.recordMetricSnapshot({ platform: "instagram", nativeId: "p1", snapshotAt: "t1", metrics: { likes: 1 } });
    await archive.recordMetricSnapshot({ platform: "instagram", nativeId: "p1", snapshotAt: "t2", metrics: { likes: 3 } });
    assert.equal((await archive.recordMetricSnapshot({ platform: "instagram", nativeId: "p1", snapshotAt: "t2", metrics: { likes: 3 } })).status, "duplicate");
    await assert.rejects(
      archive.recordMetricSnapshot({ platform: "instagram", nativeId: "p1", snapshotAt: "t2", metrics: { likes: 4 } }),
      (error) => error.code === "LOSSLESS_ARCHIVE_CONFLICT"
    );

    await archive.recordAccountIdentity({ platform: "instagram", accountKey: "acct-1", snapshotAt: "t1", identity: { handle: "old" } });
    await archive.recordAccountIdentity({ platform: "instagram", accountKey: "acct-1", snapshotAt: "t2", identity: { handle: "new" } });
    assert.deepEqual(archive.getAccountIdentityHistory("instagram:acct-1").map((row) => row.content.identity.handle), ["old", "new"]);

    await archive.updateCheckpoint({ platform: "instagram", scope: "acct-1", cursor: "c1", checkpoint: { page: 1 } });
    await archive.updateCheckpoint({ platform: "instagram", scope: "acct-1", cursor: "c2", checkpoint: { page: 2 } });
    assert.equal(archive.getCheckpoint("instagram", "acct-1").cursor, "c2");
    assert.equal(archive.listCheckpointHistory({ platform: "instagram", scope: "acct-1" }).length, 2);

    await archive.recordTombstone({ platform: "instagram", nativeId: "p1", kind: "not_observed", snapshotAt: "t3", reason: "outside scan window" });
    await archive.recordTombstone({ platform: "instagram", nativeId: "p1", kind: "deleted", snapshotAt: "t4", reason: "source reported deletion" });
    assert.equal((await archive.recordTombstone({ platform: "instagram", nativeId: "p1", kind: "deleted", snapshotAt: "t4", reason: "source reported deletion" })).status, "duplicate");
    assert.deepEqual(archive.listTombstones({ platform: "instagram", nativeId: "p1" }).map((row) => row.content.kind), ["not-observed", "deleted"]);

    const reopened = await openLosslessPostArchive(rootDir);
    assert.equal(reopened.listMetricSnapshots({ platform: "instagram", nativeId: "p1" }).length, 2);
    assert.equal(reopened.getCheckpoint("instagram", "acct-1").cursor, "c2");
    assert.equal(reopened.listTombstones({ platform: "instagram", nativeId: "p1" }).length, 2);
  });
});
