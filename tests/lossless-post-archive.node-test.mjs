import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_FILES,
  LosslessArchiveConflictError,
  LosslessArchiveDestructiveAmbiguityError,
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

test("appends edited observations as immutable revisions and keeps sparse media and relationships", async () => {
  await withArchive(async (rootDir) => {
    const archive = await openLosslessPostArchive(rootDir);
    const first = await archive.appendPost({
      platform: "linkedin",
      nativeId: "activity-1",
      observedAt: "2026-08-04T00:00:00.000Z",
      rawEnvelope: { text: "first", attachments: [{ url: "https://cdn.example/one.jpg" }] },
      normalizedPost: {
        text: "first",
        media: [{ type: "image", url: "https://cdn.example/one.jpg" }],
        parentId: "parent-1",
        threadId: "thread-1",
        quoteId: "quote-1"
      }
    });
    const editInput = {
      platform: "linkedin",
      nativeId: "activity-1",
      observedAt: "2026-08-04T01:00:00.000Z",
      rawEnvelope: { text: "edited", attachments: [{ url: "https://cdn.example/one.jpg" }] },
      normalizedPost: { text: "edited" }
    };
    const edited = await archive.appendPost(editInput);
    const repeated = await archive.appendPost(editInput);

    assert.equal(first.raw.status, "appended");
    assert.equal(first.normalized.status, "appended");
    assert.equal(edited.raw.status, "appended");
    assert.equal(edited.normalized.status, "appended");
    assert.equal(repeated.raw.status, "duplicate");
    assert.equal(repeated.normalized.status, "duplicate");
    assert.equal(archive.listRawEnvelopes({ platform: "linkedin", nativeId: "activity-1" }).length, 2);

    const revisions = archive.listPostRevisions({ platform: "linkedin", nativeId: "activity-1" });
    assert.equal(revisions.length, 2);
    assert.deepEqual(revisions.map((row) => row.content.post.text), ["first", "edited"]);
    assert.notEqual(revisions[0].contentHash, revisions[1].contentHash);
    assert.deepEqual(archive.getPost("linkedin", "activity-1"), {
      platform: "linkedin",
      nativeId: "activity-1",
      text: "edited",
      media: [{ type: "image", url: "https://cdn.example/one.jpg" }],
      parentId: "parent-1",
      threadId: "thread-1",
      quoteId: "quote-1",
      relationships: { parent: "parent-1", thread: "thread-1", quote: "quote-1" }
    });

    const rawLines = (await readFile(path.join(rootDir, ARCHIVE_FILES.rawEnvelopes), "utf8")).trim().split("\n");
    const normalizedLines = (await readFile(path.join(rootDir, ARCHIVE_FILES.normalizedPosts), "utf8")).trim().split("\n");
    assert.equal(rawLines.length, 2);
    assert.equal(normalizedLines.length, 2);

    const reopened = await openLosslessPostArchive(rootDir);
    assert.equal(reopened.getPost("linkedin", "activity-1").text, "edited");
    assert.equal(reopened.listPostRevisions({ platform: "linkedin", nativeId: "activity-1" }).length, 2);
    assert.equal(reopened.listRawEnvelopes({ platform: "linkedin", nativeId: "activity-1" }).length, 2);
  });
});

test("fails closed on conflicting observation slots and destructive sparse rewrites", async () => {
  await withArchive(async (rootDir) => {
    const archive = await openLosslessPostArchive(rootDir);
    await archive.appendPost({
      platform: "linkedin",
      nativeId: "activity-1",
      observedAt: "2026-08-04T00:00:00.000Z",
      rawEnvelope: { text: "first" },
      normalizedPost: {
        text: "first",
        media: [{ type: "image", url: "https://cdn.example/one.jpg" }],
        relationships: { parent: "parent-1" }
      }
    });

    await assert.rejects(
      archive.appendPost({
        platform: "linkedin",
        nativeId: "activity-1",
        observedAt: "2026-08-04T00:00:00.000Z",
        rawEnvelope: { text: "conflicting source payload" },
        normalizedPost: { text: "conflicting edit" }
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "raw_envelope"
    );
    await assert.rejects(
      archive.appendPost({
        platform: "linkedin",
        nativeId: "activity-1",
        observedAt: "2026-08-04T00:00:00.000Z",
        rawEnvelope: { text: "first" },
        normalizedPost: { text: "conflicting normalization" }
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "normalized_post"
    );
    await assert.rejects(
      archive.appendPost({
        platform: "linkedin",
        nativeId: "activity-1",
        observedAt: "2026-08-04T01:00:00.000Z",
        rawEnvelope: { text: "ambiguous media removal" },
        normalizedPost: { text: "second", media: [], relationships: { parent: null } }
      }),
      (error) => error instanceof LosslessArchiveDestructiveAmbiguityError &&
        error.code === "LOSSLESS_ARCHIVE_DESTRUCTIVE_AMBIGUITY" && error.field === "media"
    );
    await assert.rejects(
      archive.appendPost({
        platform: "linkedin",
        nativeId: "activity-1",
        observedAt: "2026-08-04T01:00:00.000Z",
        rawEnvelope: { text: "ambiguous relationship removal" },
        normalizedPost: { text: "second", relationships: { parent: null } }
      }),
      (error) => error instanceof LosslessArchiveDestructiveAmbiguityError &&
        error.code === "LOSSLESS_ARCHIVE_DESTRUCTIVE_AMBIGUITY" && error.field === "parent relationship"
    );

    assert.equal(archive.getPost("linkedin", "activity-1").text, "first");
    assert.equal(archive.listPostRevisions({ platform: "linkedin", nativeId: "activity-1" }).length, 1);
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
