import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPhysicalPostIndex,
  buildPromotionEvidence,
  canonicalNativePost,
  discoverNeedsReviewNativeCandidates,
  summarizeRecovery,
  validateNetworkPayload,
  validateOfflineCandidate,
  validationEndpoint
} from "../scripts/lib/needs-review-native-recovery.mjs";

const owner = {
  batchSlug: "S2026",
  entityType: "founder",
  entityId: "founder-example-alice",
  entityName: "Alice Example",
  companySlug: "example",
  companyName: "Example",
  companyEntityId: "company-example"
};

function resolver(row) {
  const platform = String(row.platform).toLowerCase();
  const author = platform === "x"
    ? "aliceexample"
    : platform === "linkedin"
      ? "alice-example"
      : "example.co";
  return {
    status: "matched",
    reason: "native_author_maps_to_unique_canonical_owner",
    author: { platform, key: author },
    owner
  };
}

test("canonicalizes native object IDs while stripping URL presentation suffixes", () => {
  assert.deepEqual(canonicalNativePost({
    platform: "x",
    sourceUrl: "https://twitter.com/AliceExample/status/123456789/quotes?ref=search"
  }), {
    platform: "x",
    postId: "123456789",
    physicalKey: "x:123456789",
    sourceUrl: "https://x.com/aliceexample/status/123456789"
  });
  assert.equal(
    canonicalNativePost({
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/alice-example_demo-activity-7462891697409069056-AbCd"
    }).physicalKey,
    "linkedin:7462891697409069056"
  );
  assert.equal(
    canonicalNativePost({
      platform: "instagram",
      sourceUrl: "https://www.instagram.com/reels/Demo_Code/"
    }).sourceUrl,
    "https://instagram.com/reel/Demo_Code"
  );
  assert.equal(
    canonicalNativePost({
      platform: "youtube",
      sourceUrl: "https://youtu.be/Video_123?t=4"
    }).physicalKey,
    "youtube:Video_123"
  );
  assert.equal(canonicalNativePost({ platform: "linkedin", sourceUrl: "https://linkedin.com/in/alice" }), null);
});

test("discovers only physically absent rows with one unique canonical native owner", () => {
  const existing = {
    evidence: [{ platform: "x", sourceUrl: "https://x.com/aliceexample/status/1" }]
  };
  const rows = [
    reviewRow("x", "https://x.com/aliceexample/status/1"),
    reviewRow("x", "https://x.com/aliceexample/status/2"),
    { ...reviewRow("x", "https://x.com/aliceexample/status/2/quotes"), id: "duplicate" },
    reviewRow("linkedin", "https://linkedin.com/in/alice")
  ];
  const result = discoverNeedsReviewNativeCandidates({
    needsReview: rows,
    currentPhysicalKeys: buildPhysicalPostIndex([existing]),
    resolveNativeAuthor: resolver,
    catalogs: []
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.physicalKey), ["x:2"]);
  const reasons = result.rejected.flatMap((row) => row.reasons);
  assert.ok(reasons.includes("already_in_current_evidence"));
  assert.ok(reasons.includes("duplicate_needs_review_post"));
  assert.ok(reasons.includes("not_supported_native_post_url"));
});

test("accepts a structurally bounded LinkedIn primary body offline", () => {
  const row = {
    ...reviewRow(
      "linkedin",
      "https://linkedin.com/posts/alice-example_demo-activity-7462891697409069056-AbCd"
    ),
    platformPostId: "7462891697409069056",
    rawVisibleText: [
      "URL Source: https://linkedin.com/feed/update/urn:li:activity:7462891697409069056",
      "Markdown Content:",
      "[Report this post](https://linkedin.com/help?guestReportContentType=POST)",
      "Example is shipping today.",
      "[Like](https://linkedin.com/like)"
    ].join("\n")
  };
  const candidate = candidateFor(row);
  const result = validateOfflineCandidate(candidate);
  assert.equal(result.status, "accepted");
  assert.equal(result.receipt.text, "Example is shipping today.");
});

test("accepts only an exact Instagram profile receipt and native shortcode", () => {
  const row = {
    ...reviewRow("instagram", "https://instagram.com/reel/Demo_Code"),
    authorHandle: "example.co",
    accountUrl: "https://instagram.com/example.co",
    rawVisibleText: JSON.stringify({
      receipt: {
        source: "instagram_public_web_profile_info_v1",
        username: "example.co"
      },
      post: {
        shortcode: "Demo_Code",
        authorUsername: "example.co"
      }
    })
  };
  const accepted = validateOfflineCandidate(candidateFor(row));
  assert.equal(accepted.status, "accepted");

  const rejected = validateOfflineCandidate(candidateFor({
    ...row,
    rawVisibleText: row.rawVisibleText.replaceAll("example.co", "other")
  }));
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.reasons.includes("instagram_receipt_author_mismatch"));
});

test("accepts a stored anonymous Instagram native-feed item only for the exact primary owner", () => {
  const row = {
    ...reviewRow("instagram", "https://instagram.com/p/Native_Code"),
    authorHandle: "example.co",
    accountUrl: "https://instagram.com/example.co",
    attributionProvenance: "instagram_anonymous_native_feed_native_owner_v1",
    nativeAuthorResolution: { status: "matched" },
    rawVisibleText: JSON.stringify({
      receipt: {
        source: "instagram_anonymous_native_feed_standalone_v1",
        username: "example.co",
        nativeFeed: {
          source: "instagram_anonymous_native_feed_v1",
          uniqueItemCount: 16,
          sourceExhausted: false
        }
      },
      post: {
        shortcode: "Native_Code",
        authorUsername: "example.co",
        profileRole: "primary",
        nativeFeedOnly: true,
        nativeFeedMetricSource: "instagram_anonymous_native_feed_v1"
      }
    })
  };
  assert.equal(validateOfflineCandidate(candidateFor(row)).status, "accepted");

  const coauthor = {
    ...row,
    rawVisibleText: row.rawVisibleText.replace('"profileRole":"primary"', '"profileRole":"coauthor"')
  };
  const rejected = validateOfflineCandidate(candidateFor(coauthor));
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.reasons.includes("instagram_receipt_source_unverified"));
});

test("validates anonymous official X oEmbed identity and materializes a verified row", () => {
  const row = reviewRow("x", "https://x.com/aliceexample/status/123456789");
  const candidate = candidateFor(row);
  assert.match(validationEndpoint(candidate), /^https:\/\/publish\.twitter\.com\/oembed\?/);
  const decision = validateNetworkPayload(candidate, {
    url: "https://x.com/aliceexample/status/123456789",
    author_url: "https://x.com/AliceExample",
    html: '<blockquote class="twitter-tweet"><p>Hello</p></blockquote>'
  });
  assert.equal(decision.accepted, true);

  const validation = {
    status: "accepted",
    checkedAt: "2026-08-09T00:00:00.000Z",
    receipt: decision.receipt
  };
  const promoted = buildPromotionEvidence(candidate, validation);
  assert.equal(promoted.review_state, "verified");
  assert.equal(promoted.sourceUrl, "https://x.com/aliceexample/status/123456789");
  assert.equal(promoted.platformPostId, "123456789");
  assert.equal(promoted.nativeAuthorResolution.owner.entityId, owner.entityId);
  assert.equal(promoted.text, "Hello");
  assert.match(promoted.rawVisibleText, /twitter-tweet/);
  assert.ok(promoted.attributionSignals.includes("official_x_oembed_author_match"));
});

test("summarizes exact net-new cohort and platform counts without counting rejects", () => {
  const xCandidate = candidateFor(reviewRow("x", "https://x.com/aliceexample/status/7"));
  const linkedinCandidate = candidateFor({
    ...reviewRow(
      "linkedin",
      "https://linkedin.com/posts/alice-example_demo-activity-7462891697409069056-AbCd"
    ),
    rawVisibleText: "unused"
  });
  const validations = new Map([
    [xCandidate.physicalKey, {
      status: "accepted",
      checkedAt: "2026-08-09T00:00:00.000Z",
      receipt: { kind: "official_x_oembed" }
    }],
    [linkedinCandidate.physicalKey, {
      status: "rejected",
      reasons: ["linkedin_primary_body_missing"]
    }]
  ]);
  const summary = summarizeRecovery({
    candidates: [xCandidate, linkedinCandidate],
    validations,
    discoveryRejected: [{ reasons: ["already_in_current_evidence"] }]
  });
  assert.equal(summary.accepted.length, 1);
  assert.deepEqual(summary.byBatch, { S2026: 1 });
  assert.deepEqual(summary.byPlatform, { x: 1 });
  assert.equal(summary.rejectionReasons.linkedin_primary_body_missing, 1);
  assert.equal(summary.rejectionReasons.already_in_current_evidence, 1);
});

function reviewRow(platform, sourceUrl) {
  return {
    id: `${platform}-${sourceUrl}`,
    batchSlug: "S2026",
    entityType: "founder",
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    platform,
    sourceUrl,
    metrics: {},
    review_state: "needs_review"
  };
}

function candidateFor(row) {
  const native = canonicalNativePost(row);
  return {
    physicalKey: native.physicalKey,
    native,
    ownership: resolver(row),
    row
  };
}
