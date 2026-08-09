import assert from "node:assert/strict";
import test from "node:test";

import {
  YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
  buildTrustedYouTubeChannelIndex,
  buildYouTubeCandidatePool,
  buildYouTubePromotionArtifact,
  buildYouTubeRecoveryInputManifest,
  candidateNeedsAnonymousValidation,
  extractYouTubeChannelReceipt,
  isTrustedYouTubeReceiptRow,
  normalizeYouTubeVideo,
  resolveYouTubeCandidateOwnership,
  stableStringify,
  validateAnonymousYouTubeVideo
} from "../scripts/lib/youtube-native-recovery.mjs";

test("normalizes only native YouTube uploads, Shorts, and live archives", () => {
  assert.deepEqual(normalizeYouTubeVideo("https://youtu.be/Abc_def-123?t=2"), {
    platform: "youtube",
    videoId: "Abc_def-123",
    physicalKey: "youtube:Abc_def-123",
    route: "watch",
    canonicalUrl: "https://www.youtube.com/watch?v=Abc_def-123"
  });
  assert.equal(
    normalizeYouTubeVideo("https://youtube.com/shorts/Abc_def-123").route,
    "shorts"
  );
  assert.equal(
    normalizeYouTubeVideo("https://www.youtube.com/live/Abc_def-123?feature=share").videoId,
    "Abc_def-123"
  );
  assert.equal(normalizeYouTubeVideo("https://youtube.com/@acme"), null);
  assert.equal(normalizeYouTubeVideo("https://youtube.com/results?search_query=acme"), null);
  assert.equal(normalizeYouTubeVideo("https://youtube.com/watch"), null);
  assert.equal(normalizeYouTubeVideo("https://youtube.com/watch?v=short"), null);
  assert.equal(normalizeYouTubeVideo({
    platformPostId: "Abc_def-123"
  }).canonicalUrl, "https://www.youtube.com/watch?v=Abc_def-123");
  assert.equal(normalizeYouTubeVideo({
    sourceUrl: "https://youtube.com/watch?v=Abc_def-123",
    platformPostId: "Different01"
  }), null);
});

test("extracts immutable channel IDs, handles, and author names from trusted receipts", () => {
  const receipt = extractYouTubeChannelReceipt({
    youtubeChannelId: "UC1234567890",
    accountUrl: "https://youtube.com/@AcmeAI",
    rawVisibleText: JSON.stringify({
      ownerText: {
        runs: [{
          text: "Acme AI",
          navigationEndpoint: {
            browseEndpoint: {
              browseId: "UC1234567890",
              canonicalBaseUrl: "/@AcmeAI"
            }
          }
        }]
      }
    })
  }, {
    authorName: "Acme AI",
    authorUrl: "https://www.youtube.com/@AcmeAI"
  });
  assert.deepEqual(receipt.keys, [
    "channel:uc1234567890",
    "handle:acmeai"
  ]);
  assert.deepEqual(receipt.authorNames, ["acme ai"]);
  assert.equal(receipt.authorUrl, "https://www.youtube.com/@AcmeAI");
});

test("builds channel ownership only from current verified roster and trusted receipts", () => {
  const trusted = buildTrustedYouTubeChannelIndex({
    catalogs: catalogFixture(),
    trustedRows: [
      {
        sourcePath: "trusted.json",
        row: trustedRow({
          youtubeChannelId: "UCcompany1234",
          youtubeChannelUrl: "https://youtube.com/channel/UCcompany1234"
        })
      },
      {
        sourcePath: "subject-only.json",
        row: {
          ...trustedRow({
            youtubeChannelId: "UCthirdparty9",
            youtubeChannelUrl: "https://youtube.com/channel/UCthirdparty9"
          }),
          attributionMode: "subject",
          attributionProvenance: "youtube_search_result"
        }
      }
    ]
  });
  assert.equal(trusted.channels.get("handle:acme").size, 1);
  assert.equal(trusted.channels.get("handle:alicefounder").size, 1);
  assert.equal(trusted.channels.get("channel:uccompany1234").size, 1);
  assert.equal(trusted.channels.has("channel:ucthirdparty9"), false);
  assert.equal(isTrustedYouTubeReceiptRow(trustedRow()), true);
});

test("candidate pool excludes current evidence and dedupes review, operational, and history", () => {
  const pool = buildYouTubeCandidatePool({
    currentEvidenceRows: [youtubeRow({
      platformPostId: "Evidence001",
      sourceUrl: "https://youtube.com/watch?v=Evidence001"
    })],
    reviewRows: [
      youtubeRow(),
      { ...youtubeRow(), id: "duplicate-review" },
      { platform: "youtube", sourceUrl: "https://youtube.com/@acme" }
    ],
    operationalCandidates: [{
      platform: "youtube",
      platformPostId: "Operatn0001",
      canonicalUrl: "https://youtube.com/watch?v=Operatn0001",
      metrics: {},
      provenance: [{ context: ownerContext() }]
    }],
    historicalOccurrences: [
      {
        sourcePath: "public/graph/s2026.json",
        commit: "a".repeat(40),
        sourceIndex: 2,
        row: youtubeRow()
      },
      {
        sourcePath: "public/graph/s2026.json",
        commit: "b".repeat(40),
        sourceIndex: 3,
        row: youtubeRow({
          platformPostId: "Evidence001",
          sourceUrl: "https://youtube.com/watch?v=Evidence001"
        })
      }
    ]
  });
  assert.deepEqual(pool.candidates.map((candidate) => candidate.videoId), [
    "Abc_def-123",
    "Operatn0001"
  ]);
  assert.equal(pool.candidates[0].occurrences.length, 3);
  assert.equal(pool.candidates[0].preferred.sourceKind, "current_review");
  assert.equal(pool.rejected[0].reason, "not_native_youtube_video");
});

test("maps a trusted native channel to the exact founder within the attached company", () => {
  const trustedIndex = buildTrustedYouTubeChannelIndex({
    catalogs: catalogFixture(),
    trustedRows: []
  });
  const candidate = candidateFromRows([youtubeRow({
    accountUrl: "https://youtube.com/@alicefounder",
    youtubeChannelUrl: "https://youtube.com/@alicefounder"
  })]);
  const validationReceipt = verifiedReceipt({
    authorName: "Alice Founder",
    authorUrl: "https://www.youtube.com/@alicefounder"
  });
  const decision = resolveYouTubeCandidateOwnership(candidate, {
    trustedIndex,
    validationReceipt
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.owner.entityType, "founder");
  assert.equal(decision.owner.entityId, "founder-acme-alice");
  assert.equal(decision.method, "trusted_current_channel_owner");
});

test("accepts exact unique native author on an official profile anchor and rejects subject mentions", () => {
  const trustedIndex = buildTrustedYouTubeChannelIndex({
    catalogs: catalogFixture(),
    trustedRows: []
  });
  const anchored = candidateFromRows([youtubeRow({
    accountUrl: null,
    youtubeChannelUrl: null,
    authorName: "Alice Founder",
    matchReason: "Official YC company page embedded this video, but metrics were unavailable."
  })]);
  const decision = resolveYouTubeCandidateOwnership(anchored, {
    trustedIndex,
    validationReceipt: verifiedReceipt({
      authorName: "Alice Founder",
      authorUrl: "https://youtube.com/@newalicechannel"
    })
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.owner.entityId, "founder-acme-alice");
  assert.equal(decision.method, "official_anchor_exact_native_author");

  const oneWordCompany = candidateFromRows([youtubeRow({
    accountUrl: null,
    youtubeChannelUrl: null,
    authorName: "Acme",
    matchReason: "Discovered from official company website; queued for native verification."
  })]);
  const companyDecision = resolveYouTubeCandidateOwnership(oneWordCompany, {
    trustedIndex,
    validationReceipt: verifiedReceipt({
      authorName: "Acme",
      authorUrl: "https://youtube.com/@useacme"
    })
  });
  assert.equal(companyDecision.accepted, true);
  assert.equal(companyDecision.owner.entityId, "company-acme");

  const thirdParty = candidateFromRows([youtubeRow({
    accountUrl: null,
    youtubeChannelUrl: null,
    authorName: "Startup Interviews",
    matchReason: "Search result mentions Acme."
  })]);
  const rejected = resolveYouTubeCandidateOwnership(thirdParty, {
    trustedIndex,
    validationReceipt: verifiedReceipt({
      authorName: "Startup Interviews",
      authorUrl: "https://youtube.com/@startupinterviews"
    })
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "youtube_native_owner_lacks_official_anchor");
});

test("anonymous validation uses only official YouTube oEmbed and handles 404", async () => {
  const candidate = candidateFromRows([youtubeRow()]);
  let calls = 0;
  const verified = await validateAnonymousYouTubeVideo(candidate, {
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(new URL(url).hostname, "www.youtube.com");
      assert.equal(new URL(url).pathname, "/oembed");
      assert.equal(options.headers.accept, "application/json");
      assert.equal(options.credentials, undefined);
      return response({
        title: "Acme launch",
        author_name: "Acme",
        author_url: "https://youtube.com/@acme",
        type: "video",
        provider_name: "YouTube",
        thumbnail_url: "https://i.ytimg.com/vi/Abc_def-123/hqdefault.jpg"
      });
    }
  });
  assert.equal(calls, 1);
  assert.equal(verified.status, "verified");
  assert.equal(verified.authorUrl, "https://youtube.com/@acme");

  const missing = await validateAnonymousYouTubeVideo(candidate, {
    fetchImpl: async () => response(null, { status: 404 })
  });
  assert.equal(missing.status, "not_found");
});

test("promotion artifact permits zero engagement with explicit trust receipt", () => {
  const trustedIndex = buildTrustedYouTubeChannelIndex({
    catalogs: catalogFixture(),
    trustedRows: []
  });
  const candidate = candidateFromRows([youtubeRow({ metrics: {} })]);
  const receipts = new Map([[candidate.videoId, verifiedReceipt()]]);
  const manifest = buildYouTubeRecoveryInputManifest({
    canonicalSha256: "a".repeat(64),
    candidates: [candidate.videoId]
  });
  const first = buildYouTubePromotionArtifact({
    candidates: [candidate],
    trustedIndex,
    validationReceipts: receipts,
    inputManifest: manifest,
    sourceAudit: { currentReviewRows: 1 }
  });
  const second = buildYouTubePromotionArtifact({
    candidates: structuredClone([candidate]),
    trustedIndex,
    validationReceipts: new Map(receipts),
    inputManifest: structuredClone(manifest),
    sourceAudit: { currentReviewRows: 1 }
  });
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.schemaVersion, YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION);
  assert.deepEqual(first.counts.byCohort, { S2026: 1 });
  assert.deepEqual(first.counts.byPlatform, { youtube: 1 });
  assert.equal(first.counts.zeroEngagement, 1);
  assert.deepEqual(first.evidence[0].metrics, {
    comments: 0,
    likes: 0,
    views: 0
  });
  assert.equal(first.evidence[0].contributionScore, 0);
  assert.ok(first.evidence[0].attributionSignals.includes(
    "zero_engagement_explicit_trust_receipt"
  ));
  assert.equal(first.evidence[0].nativeAuthorResolution.status, "matched");
});

test("preflight validates trusted channels, official anchors, and operational discoveries only", () => {
  const trustedIndex = buildTrustedYouTubeChannelIndex({
    catalogs: catalogFixture(),
    trustedRows: []
  });
  const trusted = candidateFromRows([youtubeRow()]);
  const subjectOnly = candidateFromRows([youtubeRow({
    accountUrl: null,
    youtubeChannelUrl: null,
    authorName: "Startup Interviews",
    matchReason: "Search result mentions Acme."
  })]);
  assert.equal(candidateNeedsAnonymousValidation(trusted, { trustedIndex }), true);
  assert.equal(candidateNeedsAnonymousValidation(subjectOnly, { trustedIndex }), false);
});

function catalogFixture() {
  return [{
    slug: "S2026",
    companies: [{
      sourceKey: "company-acme",
      slug: "acme",
      name: "Acme",
      websiteUrl: "https://acme.example",
      profileUrl: "https://www.ycombinator.com/companies/acme",
      accounts: [verifiedAccount(
        "acct-acme-youtube",
        "@acme",
        "https://youtube.com/@acme"
      )],
      founders: [{
        sourceKey: "founder-acme-alice",
        name: "Alice Founder",
        accounts: [verifiedAccount(
          "acct-alice-youtube",
          "@alicefounder",
          "https://youtube.com/@alicefounder"
        )]
      }]
    }]
  }];
}

function verifiedAccount(sourceKey, handle, url) {
  return {
    sourceKey,
    platform: "youtube",
    handle,
    url,
    verified: true,
    reviewState: "verified"
  };
}

function trustedRow(overrides = {}) {
  return youtubeRow({
    review_state: "verified",
    attributionStatus: "verified",
    attributionMode: "account_owner",
    ...overrides
  });
}

function youtubeRow(overrides = {}) {
  return {
    id: "review-youtube-acme-Abc_def-123",
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    companySlug: "acme",
    companyName: "Acme",
    platform: "youtube",
    sourceUrl: "https://youtube.com/watch?v=Abc_def-123",
    platformPostId: "Abc_def-123",
    accountUrl: "https://youtube.com/@acme",
    youtubeChannelUrl: "https://youtube.com/@acme",
    authorName: "Acme",
    title: "Acme launch",
    text: "Acme launch",
    metrics: {},
    matchReason: "Official YC company page embedded this video.",
    review_state: "needs_review",
    ...overrides
  };
}

function candidateFromRows(rows) {
  return buildYouTubeCandidatePool({ reviewRows: rows }).candidates[0];
}

function ownerContext() {
  return {
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    companySlug: "acme",
    companyName: "Acme"
  };
}

function verifiedReceipt(overrides = {}) {
  return {
    schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    videoId: "Abc_def-123",
    physicalKey: "youtube:Abc_def-123",
    canonicalUrl: "https://www.youtube.com/watch?v=Abc_def-123",
    status: "verified",
    checkedAt: "2026-08-09T00:00:00.000Z",
    httpStatus: 200,
    title: "Acme launch",
    authorName: "Acme",
    authorUrl: "https://youtube.com/@acme",
    type: "video",
    providerName: "YouTube",
    thumbnailUrl: "https://i.ytimg.com/vi/Abc_def-123/hqdefault.jpg",
    ...overrides
  };
}

function response(body, { status = 200, url = "https://www.youtube.com/oembed" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async json() {
      return body;
    }
  };
}
