import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { archiveAcceptedPublicSnapshot } from "../scripts/lib/archive-public-ingestion.mjs";
import { openLosslessPostArchive } from "../scripts/lib/lossless-post-archive.mjs";

async function withArchive(callback) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "public-ingestion-archive-"));
  try {
    const archive = await openLosslessPostArchive(rootDir);
    return await callback(archive);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("archives accepted native rows losslessly and skips rows without native IDs", async () => {
  await withArchive(async (archive) => {
    const snapshot = {
      source: {
        label: "Public unauthenticated platform/page ingestion",
        fetchedAt: "2026-08-04T12:00:00.000Z"
      },
      evidence: [
        {
          batchSlug: "S2026",
          platform: "X",
          platformPostId: "42",
          sourceUrl: "https://x.com/acme/status/42",
          accountUrl: "https://x.com/acme",
          title: "A launch",
          text: "We launched.",
          rawVisibleText: "{\"id\":\"42\",\"text\":\"We launched.\"}",
          mediaUrls: ["https://cdn.example/launch.png"],
          metrics: { likes: 8, replies: 2 },
          contributionScore: 23,
          last_checked_at: "2026-08-04T11:59:00.000Z"
        },
        {
          batchSlug: "S2026",
          platform: "web",
          sourceUrl: "https://acme.example/launch",
          text: "Context without a native post ID",
          metrics: {}
        }
      ]
    };

    const result = await archiveAcceptedPublicSnapshot({ archive, snapshot });

    assert.deepEqual(result, {
      archived: 1,
      skippedWithoutNativeId: 1,
      checkpointsAdvanced: 1
    });
    const post = archive.getPost("x", "42");
    assert.equal(post.text, "We launched.");
    assert.equal(post.metrics, undefined);
    assert.equal(post.rawVisibleText, undefined);
    assert.deepEqual(
      archive.listRawEnvelopes({ platform: "x", nativeId: "42" })[0].content,
      {
        platform: "x",
        nativeId: "42",
        rawEnvelope: "{\"id\":\"42\",\"text\":\"We launched.\"}",
        source: {
          snapshot: snapshot.source,
          evidence: {
            sourceUrl: "https://x.com/acme/status/42",
            accountUrl: "https://x.com/acme",
            discoverySource: null,
            attributionProvenance: null
          }
        }
      }
    );
    assert.deepEqual(
      archive.listMetricSnapshots({ platform: "x", nativeId: "42" })[0].content.metrics,
      { likes: 8, replies: 2 }
    );
    assert.deepEqual(archive.getCheckpoint("x", "public-ingestion:S2026"), {
      platform: "x",
      scope: "public-ingestion:S2026",
      cursor: "2026-08-04T12:00:00.000Z",
      checkpoint: {
        schemaVersion: 1,
        acceptedNativePostCount: 1,
        batchSlug: "S2026",
        sourceFetchedAt: "2026-08-04T12:00:00.000Z"
      },
      metadata: {
        sourceLabel: "Public unauthenticated platform/page ingestion"
      }
    });
  });
});

test("does not advance any checkpoint when a post archive write fails", async () => {
  const calls = [];
  const archive = {
    async appendPost(input) {
      calls.push(["post", input.nativeId]);
      if (input.nativeId === "2") throw new Error("archive disk write failed");
    },
    async updateCheckpoint(input) {
      calls.push(["checkpoint", input.scope]);
    }
  };

  await assert.rejects(
    archiveAcceptedPublicSnapshot({
      archive,
      observedAt: "2026-08-04T12:00:00.000Z",
      snapshot: {
        source: { fetchedAt: "2026-08-04T12:00:00.000Z" },
        evidence: [
          { platform: "x", platformPostId: "1", batchSlug: "S2026", text: "one", metrics: {} },
          { platform: "x", platformPostId: "2", batchSlug: "S2026", text: "two", metrics: {} }
        ]
      }
    }),
    /archive disk write failed/
  );
  assert.deepEqual(calls, [["post", "1"], ["post", "2"]]);
});
