import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  isVerifiedYouTubeNativeMetriclessEvidence,
  planYouTubeNativePromotion
} from "../scripts/lib/youtube-native-promotion.mjs";
import {
  YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
  stableStringify
} from "../scripts/lib/youtube-native-recovery.mjs";
import {
  parseYouTubePromotionArgs,
  promoteYouTubeNativeRecovery
} from "../scripts/promote-youtube-native-recovery.mjs";

const videoId = "AbCdEfGhI12";
const channelId = "UCExample12345";
const owner = {
  batchSlug: "S26",
  entityType: "company",
  entityId: "company-example",
  entityName: "Example Company",
  companyId: "company-example",
  companyName: "Example Company",
  companySlug: "example"
};
const otherOwner = {
  batchSlug: "S26",
  entityType: "company",
  entityId: "company-other",
  entityName: "Other Company",
  companyId: "company-other",
  companyName: "Other Company",
  companySlug: "other"
};

test("appends exact YouTube evidence and resolves only exact current-owner review duplicates", () => {
  const row = recoveredYouTube();
  const existing = { id: "keep-evidence", platform: "x", sourceUrl: "https://x.com/a/status/1" };
  const exactOne = reviewYouTube(videoId, owner, "review-one");
  const exactTwo = reviewYouTube(videoId, owner, "review-two");
  const wrongOwner = reviewYouTube(videoId, otherOwner, "wrong-owner");
  const unrelated = reviewYouTube("ZyXwVuTsR98", owner, "unrelated");
  const canonical = snapshot([existing], [exactOne, exactTwo, wrongOwner, unrelated]);
  const plan = makePlan(canonical, recoveryCandidate([row]));

  assert.equal(plan.candidateCount, 1);
  assert.equal(plan.additions.length, 1);
  assert.equal(plan.zeroEngagementAdditions, 1);
  assert.deepEqual(plan.resolvedReview, [exactOne, exactTwo]);
  assert.deepEqual(plan.retainedReview, [wrongOwner, unrelated]);
  assert.deepEqual(plan.promoted.evidence, [existing, row]);
  assert.deepEqual(plan.promoted.attributionReconciliationLedger, canonical.attributionReconciliationLedger);
  assert.deepEqual(plan.promoted.failures, canonical.failures);
  assert.deepEqual(plan.addedByBatch, { S26: 1 });
  assert.deepEqual(plan.addedByPlatform, { youtube: 1 });
});

test("checks every current reference by physical video ID and fails closed on owner conflict", () => {
  const row = recoveredYouTube();
  const canonical = snapshot([], [reviewYouTube(videoId, owner)]);
  const sameOwner = { ...row, id: "represented" };
  const represented = makePlan(
    canonical,
    recoveryCandidate([row]),
    [{ evidence: [sameOwner] }]
  );
  assert.equal(represented.additions.length, 0);
  assert.equal(represented.alreadyRepresented.length, 1);
  assert.equal(represented.resolvedReview.length, 1);

  const conflicting = {
    id: "conflicting",
    batchSlug: otherOwner.batchSlug,
    entityType: otherOwner.entityType,
    entityId: otherOwner.entityId,
    entityName: otherOwner.entityName,
    companySlug: otherOwner.companySlug,
    companyName: otherOwner.companyName,
    platform: "youtube",
    sourceUrl: row.sourceUrl,
    platformPostId: row.platformPostId
  };
  assert.throws(
    () => makePlan(canonical, recoveryCandidate([row]), [{ evidence: [conflicting] }]),
    /current reference 1 video .* disagrees on entityId/
  );
});

test("reconciles official-anchor authors against only exact-owner current review rows", () => {
  const officialOwner = {
    ...owner,
    entityId: "company-official",
    entityName: "Official Brand",
    companyId: "company-official",
    companyName: "Official Brand",
    companySlug: "official"
  };
  const row = recoveredYouTube({
    owner: officialOwner,
    trustMethod: "official_anchor_exact_native_author",
    channelId: null,
    authorName: "Official Brand",
    authorHandle: "officialbrand"
  });
  const review = reviewYouTube(videoId, officialOwner, "official-review", {
    matchReason: "Official YC company page embedded this native video."
  });
  const plan = planYouTubeNativePromotion({
    canonical: snapshot([], [review]),
    candidate: recoveryCandidate([row]),
    currentSnapshots: [snapshot([], [review])],
    catalogs: catalogs({ officialOwner, officialHasChannel: false })
  });
  assert.equal(plan.additions.length, 1);
  assert.equal(plan.resolvedReview.length, 1);
});

test("rejects duplicate videos, schema drift, receipt tampering, and channel drift", () => {
  const row = recoveredYouTube();
  const canonical = snapshot([], [reviewYouTube(videoId, owner)]);
  assert.throws(
    () => makePlan(canonical, recoveryCandidate([row, { ...row, id: "copy" }])),
    /duplicates candidate YouTube video/
  );

  const wrongSchema = recoveryCandidate([row]);
  wrongSchema.schemaVersion = "youtube-native-recovery.v2";
  assert.throws(() => makePlan(canonical, wrongSchema), /Candidate schema must be/);

  const extraReceiptKey = structuredClone(row);
  extraReceiptKey._youtubeNativeRecovery.validation.unexpected = true;
  assert.throws(
    () => makePlan(canonical, recoveryCandidate([extraReceiptKey])),
    /validation receipt does not match the exact schema/
  );

  const wrongVideo = structuredClone(row);
  wrongVideo._youtubeNativeRecovery.validation.videoId = "ZyXwVuTsR98";
  assert.throws(
    () => makePlan(canonical, recoveryCandidate([wrongVideo])),
    /invalid anonymous YouTube validation receipt/
  );

  const driftingCatalogs = catalogs();
  driftingCatalogs[0].companies[0].accounts[0].accountId = "UCDifferent9999";
  driftingCatalogs[0].companies[0].accounts[0].url =
    "https://www.youtube.com/channel/UCDifferent9999";
  assert.throws(
    () => planYouTubeNativePromotion({
      canonical,
      candidate: recoveryCandidate([row]),
      currentSnapshots: [canonical],
      catalogs: driftingCatalogs
    }),
    /fails current owner\/channel reconciliation/
  );
});

test("requires zero-engagement rows to retain contribution score 0", () => {
  const row = recoveredYouTube();
  row.contributionScore = 1;
  const candidate = recoveryCandidate([row]);
  candidate.counts.zeroEngagement = 0;
  assert.throws(
    () => makePlan(snapshot([], [reviewYouTube(videoId, owner)]), candidate),
    /must keep zero engagement at contribution score 0/
  );
});

test("accepts only trusted zero-engagement YouTube recovery evidence", () => {
  const trusted = recoveredYouTube();
  assert.equal(isVerifiedYouTubeNativeMetriclessEvidence(trusted), true);

  const genericMetricless = structuredClone(trusted);
  delete genericMetricless._youtubeNativeRecovery;
  assert.equal(isVerifiedYouTubeNativeMetriclessEvidence(genericMetricless), false);

  const tamperedReceipt = structuredClone(trusted);
  tamperedReceipt._youtubeNativeRecovery.validation.videoId = "ZyXwVuTsR98";
  assert.equal(isVerifiedYouTubeNativeMetriclessEvidence(tamperedReceipt), false);
});

test("requires a pinned SHA, explicit mode, and all expected-count assertions", () => {
  const hash = "a".repeat(64);
  assert.deepEqual(parseYouTubePromotionArgs([
    "--dry-run",
    "--candidate=/tmp/candidate.json",
    `--candidate-sha256=${hash}`,
    "--expected-candidates=9",
    "--expected-additions=9",
    "--expected-resolved-review=10"
  ]), {
    candidate: "/tmp/candidate.json",
    candidateSha256: hash,
    receipt: null,
    expectedCandidates: 9,
    expectedAdditions: 9,
    expectedResolvedReview: 10,
    dryRun: true,
    write: false
  });
  assert.throws(() => parseYouTubePromotionArgs([]), /exactly one/);
  assert.throws(() => parseYouTubePromotionArgs([
    "--dry-run",
    "--candidate=x",
    "--candidate-sha256=bad"
  ]), /lowercase SHA-256/);
});

test("produces deterministic dry-run receipts without invoking the publisher", async () => {
  const fixture = cliFixture();
  const first = await fixture.run("--dry-run");
  const second = await fixture.run("--dry-run");
  assert.deepEqual(first.receipt, second.receipt);
  assert.equal(first.output, second.output);
  assert.equal(first.receipt.status, "dry_run");
  assert.equal(first.receipt.addedEvidence, 1);
  assert.equal(first.receipt.resolvedReview, 1);
  assert.equal(first.receipt.removedEvidence, 0);
  assert.equal(fixture.publishCalls.length, 0);
});

test("passes all three public artifact hash guards to the atomic publisher", async () => {
  const fixture = cliFixture();
  const { receipt } = await fixture.run("--write");
  assert.equal(fixture.publishCalls.length, 1);
  assert.deepEqual(
    {
      canonical: fixture.publishCalls[0].expectedCanonicalSha256,
      operational: fixture.publishCalls[0].expectedLedgerSha256,
      review: fixture.publishCalls[0].expectedReviewLedgerSha256
    },
    { canonical: "canonical-before", operational: "ledger-before", review: "review-before" }
  );
  assert.equal(fixture.publishCalls[0].snapshot.evidence.length, 1);
  assert.equal(receipt.canonicalHashAfter, "canonical-after");
  assert.equal(receipt.operationalLedgerHashAfter, "ledger-after");
  assert.equal(receipt.reviewLedgerHashAfter, "review-after");
});

test("aborts before publication when any reference evidence hash changes", async () => {
  const fixture = cliFixture({ mutateReferenceBeforeWrite: true });
  await assert.rejects(() => fixture.run("--write"), /Reference evidence changed during promotion/);
  assert.equal(fixture.publishCalls.length, 0);
});

function makePlan(canonical, candidate, extraSnapshots = []) {
  return planYouTubeNativePromotion({
    canonical,
    candidate,
    currentSnapshots: [canonical, ...extraSnapshots],
    catalogs: catalogs()
  });
}

function snapshot(evidence = [], needsReview = []) {
  return {
    source: {
      fetchedAt: "2026-08-08T00:00:00.000Z",
      evidenceCount: evidence.length,
      needsReviewCount: needsReview.length
    },
    evidence,
    needsReview,
    attributionReconciliationLedger: [{ id: "keep-ledger" }],
    failures: [{ id: "keep-failure" }],
    attempts: { keep: true },
    discoveryAttempts: [{ id: "keep-discovery" }],
    sourceDiscoveryPaths: [{ id: "keep-path" }]
  };
}

function catalogs({ officialOwner = null, officialHasChannel = false } = {}) {
  const companies = [companyCatalog(owner, true), companyCatalog(otherOwner, false)];
  if (officialOwner) companies.push(companyCatalog(officialOwner, officialHasChannel));
  return [{ slug: "S26", companies }];
}

function companyCatalog(value, hasChannel) {
  return {
    sourceKey: value.entityId,
    name: value.entityName,
    slug: value.companySlug,
    websiteUrl: `https://${value.companySlug}.example`,
    profileUrl: `https://www.ycombinator.com/companies/${value.companySlug}`,
    accounts: hasChannel
      ? [{
          platform: "youtube",
          handle: "exampleco",
          url: `https://www.youtube.com/channel/${channelId}`,
          accountId: channelId,
          verified: true
        }]
      : [],
    founders: []
  };
}

function reviewYouTube(id, value, rowId = `review-${id}`, overrides = {}) {
  return {
    id: rowId,
    batchSlug: value.batchSlug,
    entityType: value.entityType,
    entityId: value.entityId,
    entityName: value.entityName,
    companySlug: value.companySlug,
    companyName: value.companyName,
    platform: "youtube",
    sourceUrl: `https://youtu.be/${id}`,
    platformPostId: id,
    review_state: "needs_review",
    ...overrides
  };
}

function recoveredYouTube({
  owner: value = owner,
  trustMethod = "trusted_current_channel_owner",
  channelId: nativeChannelId = channelId,
  authorName = "Example Company",
  authorHandle = "exampleco"
} = {}) {
  const authorUrl = `https://www.youtube.com/@${authorHandle}`;
  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const physicalKey = `youtube:${videoId}`;
  const keys = [
    ...(nativeChannelId ? [`channel:${nativeChannelId.toLowerCase()}`] : []),
    `handle:${authorHandle.toLowerCase().replaceAll("_", "").replaceAll("-", "")}`
  ].sort();
  const validation = {
    authorName,
    authorUrl,
    canonicalUrl: sourceUrl,
    checkedAt: "2026-08-09T12:00:00.000Z",
    httpStatus: 200,
    physicalKey,
    providerName: "YouTube",
    schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    status: "verified",
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    title: "Verified upload",
    type: "video",
    videoId
  };
  return {
    id: `youtube-${value.entityId}-${videoId}`,
    batchSlug: value.batchSlug,
    entityType: value.entityType,
    entityId: value.entityId,
    entityName: value.entityName,
    companySlug: value.companySlug,
    companyName: value.companyName,
    platform: "youtube",
    title: validation.title,
    text: validation.title,
    sourceUrl,
    platformPostId: videoId,
    accountUrl: authorUrl,
    youtubeChannelUrl: authorUrl,
    ...(nativeChannelId ? { youtubeChannelId: nativeChannelId } : {}),
    authorName,
    youtubeChannelName: authorName,
    authorHandle,
    postedAt: null,
    metrics: { views: 0, likes: 0, comments: 0 },
    contributionScore: 0,
    thumbnailUrl: validation.thumbnailUrl,
    thumbnailSource: "youtube",
    review_state: "verified",
    linkStatus: "verified",
    linkCheckedAt: validation.checkedAt,
    matchReason: "Exact current owner",
    first_seen_at: validation.checkedAt,
    last_checked_at: validation.checkedAt,
    last_updated_at: validation.checkedAt,
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionVersion: 3,
    attributionSignals: [
      "official_youtube_oembed_author_match",
      trustMethod,
      "unique_native_author",
      "zero_engagement_explicit_trust_receipt"
    ].sort(),
    attributionDescriptorMatches: [],
    attributionProvenance: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    nativeAuthorResolution: {
      status: "matched",
      reason: trustMethod,
      author: { platform: "youtube", keys, name: authorName, url: authorUrl },
      owner: value
    },
    rawVisibleText: stableStringify({
      source: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
      videoId,
      oembed: {
        title: validation.title,
        authorName,
        authorUrl,
        providerName: "YouTube",
        type: "video"
      },
      trust: {
        method: trustMethod,
        channelKeys: keys,
        receipts: [{ method: "current_test_receipt" }]
      },
      sourceOccurrences: [{ sourceKind: "current_review", sourceRowId: `review-${videoId}` }],
      metricsReceipt: "no_positive_public_metrics_observed_zero_engagement_explicitly_permitted"
    }),
    _youtubeNativeRecovery: {
      physicalKey,
      schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
      trustMethod,
      validation,
      zeroEngagement: true
    }
  };
}

function recoveryCandidate(evidence, rejectedCandidates = []) {
  const by = (selector) => {
    const counts = {};
    for (const row of evidence) {
      const key = selector(row);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
      left.localeCompare(right)
    ));
  };
  return {
    schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
    source: {
      collector: "current_review_operational_and_repository_history_youtube_recovery",
      inputHash: "fixture-input",
      authenticatedAccessUsed: false,
      browserAccessUsed: false,
      linkedinAccessUsed: false,
      anonymousEndpoint: "www.youtube.com/oembed"
    },
    counts: {
      total: evidence.length,
      byCohort: by((row) => row.batchSlug),
      byPlatform: { youtube: evidence.length },
      byOwnerType: by((row) => row.entityType),
      byTrustMethod: by((row) => row._youtubeNativeRecovery.trustMethod),
      zeroEngagement: evidence.filter((row) =>
        Object.values(row.metrics).every((metric) => Number(metric) === 0) &&
        Number(row.contributionScore) === 0
      ).length,
      rejected: rejectedCandidates.length
    },
    inputManifest: {
      schemaVersion: YOUTUBE_NATIVE_RECOVERY_SCHEMA_VERSION,
      inputHash: "fixture-input"
    },
    sourceAudit: {},
    evidence,
    needsReview: [],
    attributionReconciliationLedger: [],
    failures: [],
    attempts: {},
    discoveryAttempts: [],
    sourceDiscoveryPaths: [],
    rejectedCandidates
  };
}

function cliFixture({ mutateReferenceBeforeWrite = false } = {}) {
  const row = recoveredYouTube();
  const candidate = recoveryCandidate([row]);
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  const candidateSha256 = sha256(candidateBytes);
  const canonical = snapshot([], [reviewYouTube(videoId, owner)]);
  const emptyReference = Buffer.from(JSON.stringify({ evidence: [] }));
  const changedReference = Buffer.from(JSON.stringify({ evidence: [], changed: true }));
  const referenceReads = new Map();
  const publishCalls = [];

  return {
    publishCalls,
    async run(mode) {
      let output = "";
      const receipt = await promoteYouTubeNativeRecovery([
        mode,
        "--candidate=/fixture/candidate.json",
        `--candidate-sha256=${candidateSha256}`,
        "--expected-candidates=1",
        "--expected-additions=1",
        "--expected-resolved-review=1"
      ], {
        rootDir: "/fixture",
        readPublicArtifact: async () => ({
          snapshot: canonical,
          canonicalSha256: "canonical-before",
          ledgerSha256: "ledger-before",
          reviewLedgerSha256: "review-before"
        }),
        loadCatalogs: async () => catalogs(),
        readFileImpl: async (sourcePath) => {
          if (String(sourcePath) === "/fixture/candidate.json") return candidateBytes;
          const reads = (referenceReads.get(sourcePath) ?? 0) + 1;
          referenceReads.set(sourcePath, reads);
          if (mutateReferenceBeforeWrite && reads > 1) return changedReference;
          return emptyReference;
        },
        publishArtifact: async (input) => {
          publishCalls.push(input);
          return {
            canonicalSha256: "canonical-after",
            ledgerSha256: "ledger-after",
            reviewLedgerSha256: "review-after"
          };
        },
        stdout: { write: (value) => { output += value; } }
      });
      return { receipt, output };
    }
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
