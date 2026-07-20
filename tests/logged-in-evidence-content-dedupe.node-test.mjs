import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finalizeLoggedInEvidenceContent } from "../scripts/lib/logged-in-evidence-content-dedupe.mjs";

describe("logged-in evidence exact-content finalization", () => {
  it("deterministically retains Nalin's lower X status and persists its target-scoped quarantine through checkpoint replay", () => {
    const retained = nalinRow("1864872376540033181");
    const duplicate = nalinRow("1864872432437453114", {
      first_seen_at: "2026-06-28T18:35:38.976Z",
      metrics: { likes: 1, reposts: 0, comments: 0, views: 168 }
    });

    const forward = finalizeLoggedInEvidenceContent([retained, duplicate], {
      defaultBatchSlug: "S26",
      resolveBatchSlug: resolveFixtureBatch
    });
    const reversed = finalizeLoggedInEvidenceContent([duplicate, retained], {
      defaultBatchSlug: "S26",
      resolveBatchSlug: resolveFixtureBatch
    });

    for (const finalized of [forward, reversed]) {
      assert.deepEqual(finalized.evidence.map((row) => row.platformPostId), ["1864872376540033181"]);
      assert.equal(finalized.needsReview.length, 1);
      assert.deepEqual(finalized.needsReview[0].quarantineReasons, ["same_platform_author_substantive_body"]);
      assert.deepEqual(finalized.needsReview[0].duplicateEvidenceIdentity, {
        duplicateOfId: retained.id,
        duplicateOfSourceUrl: retained.sourceUrl,
        duplicateOfPlatformPostId: retained.platformPostId,
        contentBodySha256: finalized.needsReview[0].duplicateEvidenceIdentity.contentBodySha256
      });
      assert.match(finalized.needsReview[0].duplicateEvidenceIdentity.contentBodySha256, /^[a-f0-9]{64}$/);
      assert.equal(finalized.attributionReconciliationLedger.length, 1);
      assert.deepEqual(finalized.attributionReconciliationLedger[0], {
        platform: "x",
        sourceUrl: duplicate.sourceUrl,
        platformPostId: duplicate.platformPostId,
        disposition: "quarantined",
        reason: "same_platform_author_substantive_body",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-cignara-nalin-gupta-78606",
          attributionType: "subject"
        }
      });
    }
    assert.deepEqual(reversed, forward);

    const checkpointReplay = finalizeLoggedInEvidenceContent(
      [duplicate, ...forward.evidence],
      {
        defaultBatchSlug: "S26",
        resolveBatchSlug: resolveFixtureBatch,
        existingNeedsReview: forward.needsReview,
        existingAttributionReconciliationLedger: forward.attributionReconciliationLedger
      }
    );
    assert.deepEqual(checkpointReplay.evidence, forward.evidence);
    assert.deepEqual(checkpointReplay.needsReview, forward.needsReview);
    assert.deepEqual(
      checkpointReplay.attributionReconciliationLedger,
      forward.attributionReconciliationLedger
    );
  });
});

const NALIN_BODY = "Super proud of my mom Beena Gupta launching her new startup - BuzzBox: Gift-ready items delivered to your doorstep every month. Have you ever felt miserable because you forgot to buy a gift for an upcoming event, or can’t find something which is unique, gift-worthy? Never go to Show more";

function nalinRow(platformPostId, overrides = {}) {
  return {
    id: `x-founder-cignara-nalin-gupta-78606-${platformPostId}`,
    entityType: "founder",
    entityId: "founder-cignara-nalin-gupta-78606",
    companySlug: "cignara",
    companyName: "Cignara",
    platform: "x",
    sourceUrl: `https://x.com/nalingupta01/status/${platformPostId}`,
    platformPostId,
    text: NALIN_BODY,
    rawVisibleText: JSON.stringify({
      author: "nalingupta01",
      name: "Nalin Gupta",
      id: platformPostId,
      text: NALIN_BODY,
      url: `https://x.com/nalingupta01/status/${platformPostId}`
    }),
    postedAt: "2024-12-05T06:00:00.000Z",
    metrics: { likes: 5, reposts: 0, views: 223 },
    ...overrides
  };
}

function resolveFixtureBatch(row) {
  return row?.entityId === "founder-cignara-nalin-gupta-78606" ? "S2026" : null;
}
