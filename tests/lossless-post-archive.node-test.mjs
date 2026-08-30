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

test("ignores only snapshot-wrapper drift and rejects all other raw or metric observation drift", async () => {
  await withArchive(async (rootDir) => {
    let archive = await openLosslessPostArchive(rootDir);
    const appendObservation = ({
      fetchedAt,
      evidenceCount = 1,
      rawText = "source payload",
      likes = 4,
      rawSourceUrl = "https://linkedin.example/posts/activity-1",
      metricSourceUrl = rawSourceUrl,
      rawSourceExtra = {},
      metricSourceExtra = {}
    }) => {
      const snapshot = { fetchedAt, evidenceCount };
      return archive.appendPost({
        platform: "linkedin",
        nativeId: "activity-1",
        observedAt: "2026-08-04T00:00:00.000Z",
        rawEnvelope: { text: rawText },
        normalizedPost: { text: "normalized post" },
        metricSnapshots: [{
          snapshotAt: "2026-08-04T00:00:00.000Z",
          metrics: { likes },
          source: {
            snapshot,
            evidence: { sourceUrl: metricSourceUrl },
            ...metricSourceExtra
          }
        }],
        source: {
          snapshot,
          evidence: { sourceUrl: rawSourceUrl },
          ...rawSourceExtra
        }
      });
    };

    const first = await appendObservation({ fetchedAt: "2026-08-04T01:00:00.000Z" });
    archive = await openLosslessPostArchive(rootDir);
    const replay = await appendObservation({
      fetchedAt: "2026-08-04T02:00:00.000Z",
      evidenceCount: 2
    });

    assert.equal(replay.raw.status, "duplicate");
    assert.equal(replay.raw.contentHash, first.raw.contentHash);
    assert.equal(replay.metrics[0].status, "duplicate");
    assert.equal(replay.metrics[0].contentHash, first.metrics[0].contentHash);
    assert.equal(archive.listRawEnvelopes({ platform: "linkedin", nativeId: "activity-1" }).length, 1);
    assert.equal(archive.listMetricSnapshots({ platform: "linkedin", nativeId: "activity-1" }).length, 1);
    assert.equal(
      archive.listRawEnvelopes({ platform: "linkedin", nativeId: "activity-1" })[0]
        .content.source.snapshot.fetchedAt,
      "2026-08-04T01:00:00.000Z"
    );

    await assert.rejects(
      appendObservation({ fetchedAt: "2026-08-04T03:00:00.000Z", rawText: "changed source payload" }),
      (error) => error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "raw_envelope"
    );
    await assert.rejects(
      appendObservation({ fetchedAt: "2026-08-04T03:00:00.000Z", likes: 5 }),
      (error) => error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "metric_snapshot"
    );
    await assert.rejects(
      appendObservation({
        fetchedAt: "2026-08-04T03:00:00.000Z",
        rawSourceUrl: "https://linkedin.example/posts/changed"
      }),
      (error) => error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "raw_envelope"
    );
    await assert.rejects(
      appendObservation({
        fetchedAt: "2026-08-04T03:00:00.000Z",
        metricSourceUrl: "https://linkedin.example/posts/changed"
      }),
      (error) => error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "metric_snapshot"
    );
    await assert.rejects(
      appendObservation({
        fetchedAt: "2026-08-04T03:00:00.000Z",
        rawSourceExtra: { futureField: true }
      }),
      (error) => error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "raw_envelope"
    );
    await assert.rejects(
      appendObservation({
        fetchedAt: "2026-08-04T03:00:00.000Z",
        metricSourceExtra: { futureField: true }
      }),
      (error) => error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "metric_snapshot"
    );
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

test("versions only catalog-derived attribution descriptor drift for one source observation", async () => {
  await withArchive(async (rootDir) => {
    const archive = await openLosslessPostArchive(rootDir);
    const observedAt = "2026-08-26T03:53:04.852Z";
    const nativeId = "2078180525601419281";
    const rawEnvelope = { source: "x-public-profile", nativeId, text: "unchanged source post" };
    const normalizedPost = {
      platformPostId: nativeId,
      text: "unchanged source post",
      sourceUrl: `https://x.com/rationaldotto/status/${nativeId}`,
      attributionDescriptorMatches: ["rational", "firms"],
      media: [],
      relationships: { parent: null, thread: null, quote: null }
    };
    const first = await archive.appendPost({
      platform: "x",
      nativeId,
      observedAt,
      rawEnvelope,
      normalizedPost
    });
    const descriptorRevisionInput = {
      platform: "x",
      nativeId,
      observedAt,
      rawEnvelope,
      normalizedPost: {
        ...normalizedPost,
        attributionDescriptorMatches: ["rational"]
      }
    };
    const revised = await archive.appendPost(descriptorRevisionInput);
    const repeatedRevision = await archive.appendPost(descriptorRevisionInput);

    assert.equal(revised.raw.status, "duplicate");
    assert.equal(revised.normalized.status, "appended");
    assert.notEqual(revised.normalized.contentHash, first.normalized.contentHash);
    assert.equal(repeatedRevision.normalized.status, "duplicate");
    assert.equal(repeatedRevision.normalized.contentHash, revised.normalized.contentHash);
    assert.deepEqual(
      archive.listPostRevisions({ platform: "x", nativeId })
        .map((record) => record.content.post.attributionDescriptorMatches),
      [["rational", "firms"], ["rational"]]
    );

    await assert.rejects(
      archive.appendPost({
        ...descriptorRevisionInput,
        normalizedPost: { ...descriptorRevisionInput.normalizedPost, text: "semantic mutation" }
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "normalized_post"
    );
    await assert.rejects(
      archive.appendPost({
        ...descriptorRevisionInput,
        normalizedPost: { ...descriptorRevisionInput.normalizedPost, platformPostId: "different-native-id" }
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" && error.recordType === "normalized_post"
    );

    const reopened = await openLosslessPostArchive(rootDir);
    assert.equal(reopened.listPostRevisions({ platform: "x", nativeId }).length, 2);
    assert.deepEqual(reopened.getPost("x", nativeId).attributionDescriptorMatches, ["rational"]);

    const replayedFirst = await reopened.appendPost({
      platform: "x",
      nativeId,
      observedAt,
      rawEnvelope,
      normalizedPost
    });
    assert.equal(replayedFirst.normalized.status, "duplicate");
    assert.equal(replayedFirst.normalized.contentHash, first.normalized.contentHash);
    assert.deepEqual(reopened.getPost("x", nativeId).attributionDescriptorMatches, ["rational"]);
  });
});

test("keeps normalized same-slot semantic mutations fail-closed", async () => {
  await withArchive(async (rootDir) => {
    const archive = await openLosslessPostArchive(rootDir);
    const observedAt = "2026-08-30T15:48:05.575Z";
    const generatedClause =
      "Canonical write reconciled 1 same-owner observations by native X post ID and retained per-metric maxima.";
    const normalizedPost = {
      platformPostId: "555580343420723200",
      text: "native body",
      sourceUrl: "https://x.com/maryamjm/status/555580343420723200",
      matchReason: `Exact native author verified. ${generatedClause}`
    };
    const input = {
      platform: "x",
      nativeId: "555580343420723200",
      observedAt,
      rawEnvelope: { text: "native body" },
      normalizedPost
    };
    const first = await archive.appendPost(input);
    const replay = await archive.appendPost(input);

    assert.equal(first.normalized.status, "appended");
    assert.equal(replay.normalized.status, "duplicate");
    await assert.rejects(
      archive.appendPost({
        ...input,
        normalizedPost: {
          ...normalizedPost,
          matchReason: `${normalizedPost.matchReason} Analyst changed the semantic provenance.`
        }
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" &&
        error.recordType === "normalized_post"
    );
    assert.equal(
      archive.listPostRevisions({ platform: "x", nativeId: "555580343420723200" }).length,
      1
    );
  });
});

test("versions only exact generated X provenance drift for legacy same-slot rows", async () => {
  await withArchive(async (rootDir) => {
    let archive = await openLosslessPostArchive(rootDir);
    const nativeId = "555580343420723200";
    const observedAt = "2026-08-30T15:48:05.575Z";
    const clause = (count) =>
      `Canonical write reconciled ${count} same-owner observations by native X post ID and retained per-metric maxima.`;
    const conflictClause =
      "Conflicting exact native timestamps were observed for the same X post ID; queued for review.";
    const recentSearchClause =
      "The credentialed X recent-search result independently matched the same native post ID; per-metric maxima were retained.";
    const receipt = {
      source: "x_native_metric_reconciliation_v1",
      nativePostId: nativeId,
      mergedMetrics: { likes: 1 },
      timestampConflict: false,
      observedTimestamps: ["2015-01-15T04:20:50.000Z"],
      observations: [{
        source: "x_recent_search_exact_mapped_author_v1",
        checkedAt: observedAt,
        postedAt: "2015-01-15T04:20:50.000Z",
        metrics: { likes: 1 }
      }]
    };
    const basePost = {
      platformPostId: nativeId,
      text: "native body",
      sourceUrl: `https://x.com/maryamjm/status/${nativeId}`,
      xMetricReceipt: receipt
    };
    const append = (normalizedPost) => archive.appendPost({
      platform: "x",
      nativeId,
      observedAt,
      rawEnvelope: { text: "native body" },
      normalizedPost
    });
    const legacy = await append({
      ...basePost,
      matchReason:
        `Exact native author verified. ${clause(13)} ${clause(2)} ${clause(1)} ${clause(1)} ` +
        `${conflictClause} ${conflictClause} ${recentSearchClause} ${recentSearchClause}`
    });
    const canonicalInput = {
      ...basePost,
      matchReason: `Exact native author verified. ${recentSearchClause} ${clause(1)}`
    };
    const canonical = await append(canonicalInput);
    const replay = await append(canonicalInput);

    assert.equal(legacy.normalized.status, "appended");
    assert.equal(canonical.normalized.status, "appended");
    assert.notEqual(canonical.normalized.contentHash, legacy.normalized.contentHash);
    assert.equal(replay.normalized.status, "duplicate");
    assert.equal(
      archive.listPostRevisions({ platform: "x", nativeId }).length,
      2
    );
    archive = await openLosslessPostArchive(rootDir);
    assert.equal(
      archive.listPostRevisions({ platform: "x", nativeId }).length,
      2
    );
    await assert.rejects(
      append({
        ...canonicalInput,
        matchReason: `Changed analyst provenance. ${clause(1)}`
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" &&
        error.recordType === "normalized_post"
    );
    await assert.rejects(
      append({
        ...canonicalInput,
        text: "changed native body"
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" &&
        error.recordType === "normalized_post"
    );
    await assert.rejects(
      append({
        ...canonicalInput,
        xMetricReceipt: {
          ...receipt,
          timestampConflict: true
        }
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" &&
        error.recordType === "normalized_post"
    );

    const linkedInInput = {
      platform: "linkedin",
      nativeId: "activity-1",
      observedAt,
      rawEnvelope: { text: "linkedin body" },
      normalizedPost: {
        text: "linkedin body",
        matchReason: `Exact native author verified. ${clause(1)}`
      }
    };
    await archive.appendPost(linkedInInput);
    await assert.rejects(
      archive.appendPost({
        ...linkedInInput,
        normalizedPost: {
          ...linkedInInput.normalizedPost,
          matchReason: `Exact native author verified. ${clause(1)} ${clause(1)}`
        }
      }),
      (error) => error instanceof LosslessArchiveConflictError &&
        error.code === "LOSSLESS_ARCHIVE_CONFLICT" &&
        error.recordType === "normalized_post"
    );
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
