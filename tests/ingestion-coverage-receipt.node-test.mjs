import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INGESTION_CATALOG_MANIFEST_VERSION,
  INGESTION_CORE_PLATFORMS,
  INGESTION_COVERAGE_SCHEMA_VERSION,
  INGESTION_EXTENDED_ONLY_PLATFORMS,
  INGESTION_RECENCY_POLICY_VERSION,
  buildIngestionCoverageReceipt,
  computeIngestionCatalogSourceHash,
  streamIngestionCoverageReceiptJson,
  validateIngestionCoverageReceipt,
  writeIngestionCoverageReceiptJson
} from "../scripts/lib/ingestion-coverage-receipt.mjs";

const GENERATED_AT = "2026-08-02T18:30:00.000Z";
const CHECKED_AT = "2026-08-02T18:29:00.000Z";
const RUN_STARTED_AT = "2026-08-02T18:00:00.000Z";
const ACME_X_PRIMARY = "https://x.com/Acme";
const ACME_X_LABS = "https://x.com/AcmeLabs";
const ADA_GITHUB = "https://github.com/Ada-Founder";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function cutoffAt(generatedAt = GENERATED_AT) {
  return new Date(Date.parse(generatedAt) - 90 * 24 * 60 * 60 * 1_000).toISOString();
}

function catalog({ accounts = null, founders = null } = {}) {
  const value = {
    batchSlug: "TEST",
    sourcePath: "fixtures/test-catalog.json",
    sourceVersion: "test-catalog-2026-08-02",
    companies: [{
      id: "company-acme",
      name: "Acme",
      accounts: accounts ?? [
        { platform: "x", url: ACME_X_LABS, verificationStatus: "verified" },
        { platform: "x", url: ACME_X_PRIMARY, verificationStatus: "verified" }
      ],
      founders: founders ?? [{
        id: "founder-acme-ada",
        name: "Ada Founder",
        accounts: [{
          platform: "github",
          url: ADA_GITHUB,
          verificationStatus: "needs_review"
        }]
      }]
    }]
  };
  value.sourceHash = computeIngestionCatalogSourceHash(value);
  return [value];
}

function manifestForCatalogs(catalogs) {
  return {
    version: INGESTION_CATALOG_MANIFEST_VERSION,
    batches: catalogs.map((value) => {
      const founders = value.companies.reduce(
        (sum, company) => sum + (company.founders ?? []).length,
        0
      );
      return {
        batchSlug: value.batchSlug,
        sourcePath: value.sourcePath,
        sourceVersion: value.sourceVersion,
        sourceHash: computeIngestionCatalogSourceHash(value),
        companies: value.companies.length,
        founders,
        entities: value.companies.length + founders
      };
    }).sort((left, right) => left.batchSlug.localeCompare(right.batchSlug))
  };
}

function scopeReceipts(generatedAt = GENERATED_AT) {
  const cutoff = cutoffAt(generatedAt);
  return {
    objectiveComplete: true,
    recentBackfillReceipt: {
      receiptId: "recent-backfill-1",
      status: "complete",
      checkedAt: generatedAt,
      coveredFrom: cutoff,
      coveredThrough: generatedAt,
      reason: "Every publicly reachable current-window page was traversed through receipt time."
    },
    historicalBackfillReceipt: {
      receiptId: "historical-backfill-1",
      status: "complete",
      checkedAt: generatedAt,
      coveredThrough: cutoff,
      technicalLimit: "Native source pagination was exhausted at its oldest publicly reachable boundary.",
      reason: "Historical pages were traversed backward until the source returned no older cursor."
    },
    storedUnpublishedReceipt: {
      receiptId: "stored-unpublished-1",
      status: "complete",
      checkedAt: generatedAt,
      coveredThrough: generatedAt,
      reason: "Stored evidence was compared with public artifacts through the receipt timestamp."
    },
    schedulerReceipt: {
      receiptId: "scheduler-1",
      status: "current",
      checkedAt: generatedAt,
      freshThrough: generatedAt,
      reason: "The accepted production schedule completed through this receipt timestamp."
    },
    integrityChecks: Object.fromEntries([
      ["duplicates", "Physical native IDs, canonical URLs, and digests were checked for duplicates."],
      ["attribution", "Every evidence owner resolved to an exact canonical company or founder."],
      ["timestamps", "Native timestamps passed strict calendar and ordering validation."],
      ["scoring", "Stored contributions were recomputed using the current scoring contract."]
    ].map(([dimension, reason]) => [dimension, {
      receiptId: `integrity-${dimension}-1`,
      verified: true,
      checkedAt: generatedAt,
      artifactDigest: HASH_A,
      toolVersion: "receipt-integrity-test.v1",
      dependencyHash: HASH_D,
      reason
    }]))
  };
}

function baseInput() {
  const catalogs = catalog();
  return {
    runId: "coverage-test-1",
    run: {
      idempotencyKey: "coverage-test-1-idempotency",
      campaignKey: "coverage-test-1-campaign",
      startedAt: RUN_STARTED_AT,
      completedAt: GENERATED_AT
    },
    generatedAt: GENERATED_AT,
    catalogs,
    expectedCatalogManifest: manifestForCatalogs(catalogs),
    tasks: [
      task("task-acme-x-primary", "company", "company-acme", "x", {
        platform: "x",
        url: ACME_X_PRIMARY,
        verificationStatus: "verified"
      }),
      task("task-acme-x-labs", "company", "company-acme", "x", {
        platform: "x",
        url: ACME_X_LABS,
        verificationStatus: "verified"
      }),
      task("task-ada-github", "founder", "founder-acme-ada", "github", {
        platform: "github",
        url: ADA_GITHUB,
        verificationStatus: "needs_review"
      })
    ],
    outcomes: [
      outcome({
        taskKey: "task-acme-x-primary",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        account: { platform: "x", url: ACME_X_PRIMARY, verificationStatus: "verified" },
        attemptId: "x-primary-1",
        attemptSequence: 1,
        status: "completed",
        reason: "Collector persisted native X row 1001 for the verified primary account.",
        profileReceipt: profileReceipt(ACME_X_PRIMARY, "profile-x-primary-1")
      }),
      outcome({
        taskKey: "task-acme-x-labs",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        account: { platform: "x", url: ACME_X_LABS, verificationStatus: "verified" },
        attemptId: "x-labs-1",
        attemptSequence: 1,
        status: "completed",
        reason: "Collector persisted native X row 1002 for the verified labs account.",
        profileReceipt: profileReceipt(ACME_X_LABS, "profile-x-labs-1")
      }),
      outcome({
        taskKey: "task-linkedin-discovery",
        entityType: "company",
        entityId: "company-acme",
        platform: "linkedin",
        attemptId: "linkedin-1",
        attemptSequence: 1,
        status: "verified_no_account",
        reason: "Official site, canonical profile, and native organization search found no LinkedIn account.",
        absenceVerification: {
          receiptId: "absence-linkedin-1",
          exhaustive: true,
          checkedAt: CHECKED_AT,
          checkedSources: ["canonical_profile", "linkedin_native_search", "official_website"],
          method: "Exact organization name, domain redirects, and every official outbound link were checked."
        }
      }),
      outcome({
        taskKey: "task-instagram-discovery",
        entityType: "company",
        entityId: "company-acme",
        platform: "instagram",
        attemptId: "instagram-1",
        attemptSequence: 1,
        status: "blocked_or_empty",
        reason: "Legacy collector conflated a blocked response with an empty profile result."
      }),
      outcome({
        taskKey: "task-founder-x-discovery",
        entityType: "founder",
        entityId: "founder-acme-ada",
        platform: "x",
        attemptId: "founder-x-1",
        attemptSequence: 1,
        status: "failed",
        reasonCode: "missing_credentials",
        reason: "HTTP 401 occurred because the required production bearer credential is absent."
      }),
      outcome({
        taskKey: "task-ada-github",
        entityType: "founder",
        entityId: "founder-acme-ada",
        platform: "github",
        account: { platform: "github", url: ADA_GITHUB, verificationStatus: "needs_review" },
        attemptId: "github-1",
        attemptSequence: 1,
        status: "completed",
        reason: "Legacy GitHub checkpoint reported completion without retaining native event rows.",
        nativeEvidenceCount: 88
      }),
      outcome({
        taskKey: "task-company-reddit",
        entityType: "company",
        entityId: "company-acme",
        platform: "reddit",
        attemptId: "reddit-1",
        attemptSequence: 1,
        checkedAt: "2026-08-02T18:10:00.000Z",
        status: "completed",
        reason: "Earlier Reddit attempt persisted a native post before the current access failure."
      }),
      outcome({
        taskKey: "task-company-reddit",
        entityType: "company",
        entityId: "company-acme",
        platform: "reddit",
        attemptId: "reddit-2",
        attemptSequence: 2,
        checkedAt: "2026-08-02T18:20:00.000Z",
        status: "failed",
        reasonCode: "access_denied",
        reason: "HTTP 403 access denied the current Reddit collector attempt at the public edge."
      }),
      outcome({
        taskKey: "task-company-web",
        entityType: "company",
        entityId: "company-acme",
        platform: "web",
        attemptId: "web-1",
        attemptSequence: 1,
        status: "failed",
        reason: "Network socket timeout interrupted the official website fetch after thirty seconds."
      }),
      outcome({
        taskKey: "task-company-youtube",
        entityType: "company",
        entityId: "company-acme",
        platform: "youtube",
        attemptId: "youtube-1",
        attemptSequence: 1,
        status: "failed",
        reason: "A CAPTCHA challenge blocked the public YouTube channel response."
      }),
      outcome({
        taskKey: "task-company-product-hunt",
        entityType: "company",
        entityId: "company-acme",
        platform: "product_hunt",
        attemptId: "product-hunt-1",
        attemptSequence: 1,
        status: "failed",
        reason: "HTTP 429 rate limit blocked the Product Hunt public search request."
      }),
      outcome({
        taskKey: "task-company-hn",
        entityType: "company",
        entityId: "company-acme",
        platform: "hacker_news",
        attemptId: "hn-1",
        attemptSequence: 1,
        status: "failed",
        reason: "No matching native Hacker News user or submission identity was found."
      })
    ],
    evidence: [
      evidence({
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        nativeId: "1001",
        digest: HASH_B,
        publishedAt: "2026-08-01T12:00:00.000Z",
        observedAt: "2026-08-02T18:25:00.000Z",
        taskKey: "task-acme-x-primary",
        attemptId: "x-primary-1",
        accountUrl: ACME_X_PRIMARY,
        storedUnpublished: true
      }),
      evidence({
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        nativeId: "1001",
        digest: HASH_B,
        publishedAt: "2026-08-01T12:00:00.000Z",
        observedAt: "2026-08-02T18:26:00.000Z",
        taskKey: "task-acme-x-primary",
        attemptId: "x-primary-1",
        accountUrl: ACME_X_PRIMARY,
        storedUnpublished: true
      }),
      evidence({
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        nativeId: "AbC-1002",
        digest: HASH_C,
        publishedAt: "2026-04-01T12:00:00.000Z",
        observedAt: "2026-08-02T18:27:00.000Z",
        taskKey: "task-acme-x-labs",
        attemptId: "x-labs-1",
        accountUrl: ACME_X_LABS
      }),
      evidence({
        entityType: "company",
        entityId: "company-acme",
        platform: "reddit",
        nativeId: "stale-reddit-post",
        digest: HASH_D,
        publishedAt: "2026-07-01T12:00:00.000Z",
        observedAt: "2026-08-02T18:09:00.000Z",
        taskKey: "task-company-reddit",
        attemptId: "reddit-1"
      })
    ],
    pairScopes: [{
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform: "x",
      scope: scopeReceipts()
    }]
  };
}

function task(taskKey, entityType, entityId, platform, account = null) {
  return { taskKey, batchSlug: "TEST", entityType, entityId, platform, account };
}

function outcome(value) {
  const checkedAt = value.checkedAt ?? CHECKED_AT;
  return {
    batchSlug: "TEST",
    startedAt: new Date(Date.parse(checkedAt) - 5 * 60_000).toISOString(),
    checkedAt,
    ...value
  };
}

function profileReceipt(profileUrl, receiptId, checkedAt = "2026-08-02T18:28:00.000Z") {
  return {
    receiptId,
    status: "scraped",
    checkedAt,
    profileUrl,
    digest: HASH_A
  };
}

function evidence(value) {
  return { batchSlug: "TEST", ...value };
}

function pair(receipt, entityType, entityId, platform) {
  return receipt.pairs.find((candidate) =>
    candidate.entity.type === entityType &&
    candidate.entity.id === entityId &&
    candidate.platform === platform
  );
}

function expectedManifest(receipt) {
  return structuredClone(receipt.catalogManifest);
}

describe("ingestion coverage receipt v1 adversarial contract", () => {
  it("derives catalog-bound 10/13-lane denominators and a measured batch-platform summary", () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    assert.equal(receipt.schemaVersion, INGESTION_COVERAGE_SCHEMA_VERSION);
    assert.equal(receipt.catalogManifest.version, INGESTION_CATALOG_MANIFEST_VERSION);
    assert.equal(receipt.recencyPolicy.version, INGESTION_RECENCY_POLICY_VERSION);
    assert.deepEqual(receipt.inventory, {
      companies: 1,
      founders: 1,
      entities: 2,
      corePlatforms: [...INGESTION_CORE_PLATFORMS],
      extendedOnlyPlatforms: [...INGESTION_EXTENDED_ONLY_PLATFORMS],
      corePairCount: 20,
      extendedPairCount: 26,
      extendedOnlyPairCount: 6,
      taskCount: 27,
      knownVerifiedAccounts: 2,
      mappedEntityPlatformPairs: 2,
      multiAccountExtraTasks: 1
    });
    assert.equal(receipt.pairs.length, 26);
    const xCompany = receipt.summary.byBatchPlatform.TEST.x.company;
    assert.deepEqual({
      pairs: xCompany.pairs,
      mappedPairs: xCompany.mappedPairs,
      verifiedAccounts: xCompany.verifiedAccounts,
      profilesMapped: xCompany.profilesMapped,
      profilesScraped: xCompany.profilesScraped,
      posts: xCompany.posts,
      recentPosts: xCompany.recentPosts,
      historicalPosts: xCompany.historicalPosts,
      terminalCoveragePercent: xCompany.terminalCoveragePercent,
      objectiveCoveragePercent: xCompany.objectiveCoveragePercent,
      mappingCoveragePercent: xCompany.mappingCoveragePercent,
      profileScrapeCoveragePercent: xCompany.profileScrapeCoveragePercent
    }, {
      pairs: 1,
      mappedPairs: 1,
      verifiedAccounts: 2,
      profilesMapped: 2,
      profilesScraped: 2,
      posts: 2,
      recentPosts: 1,
      historicalPosts: 1,
      terminalCoveragePercent: 100,
      objectiveCoveragePercent: 100,
      mappingCoveragePercent: 100,
      profileScrapeCoveragePercent: 100
    });
    assert.equal(receipt.summary.physicalPosts, 3);
    assert.equal(receipt.summary.physicalRecentPosts, 2);
    assert.equal(receipt.summary.physicalHistoricalPosts, 1);
  });

  it("lets the current attempt outrank stale corpus evidence and ignores numeric counts", () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    const reddit = pair(receipt, "company", "company-acme", "reddit");
    const github = pair(receipt, "founder", "founder-acme-ada", "github");
    assert.equal(reddit.evidence.postCount, 1);
    assert.equal(reddit.accountOutcomes[0].attempt.attemptId, "reddit-2");
    assert.equal(reddit.accountOutcomes[0].status, "blocked");
    assert.deepEqual(reddit.accountOutcomes[0].evidenceRefs, []);
    assert.equal(reddit.terminal.status, "blocked");
    assert.equal(github.rawCollectorStatus, "completed");
    assert.equal(github.accountOutcomes[0].status, "queued");
    assert.equal(github.accountOutcomes[0].reasonCode, "missing_native_evidence");

    const forged = structuredClone(receipt);
    const forgedReddit = pair(forged, "company", "company-acme", "reddit");
    forgedReddit.accountOutcomes[0].attempt.attemptId = "reddit-1";
    forgedReddit.accountOutcomes[0].status = "collected";
    forgedReddit.accountOutcomes[0].reasonCode = "native_evidence_collected";
    forgedReddit.accountOutcomes[0].evidenceRefs = ["reddit:native:stale-reddit-post"];
    assert.throws(
      () => validateIngestionCoverageReceipt(forged, {
        expectedCatalogManifest: expectedManifest(receipt)
      }),
      /attempt window does not match current attempt|status does not match/
    );
  });

  it("uses structured taxonomy: credentials/manual/no-match queue while exact access failures block", () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    assert.deepEqual([
      pair(receipt, "founder", "founder-acme-ada", "x").terminal.status,
      pair(receipt, "company", "company-acme", "hacker_news").terminal.status,
      pair(receipt, "company", "company-acme", "instagram").terminal.status
    ], ["queued", "queued", "queued"]);
    assert.equal(
      pair(receipt, "founder", "founder-acme-ada", "x").terminal.reasonCode,
      "missing_credentials"
    );
    assert.equal(
      pair(receipt, "company", "company-acme", "hacker_news").terminal.reasonCode,
      "no_match"
    );
    assert.deepEqual({
      reddit: pair(receipt, "company", "company-acme", "reddit").terminal.reasonCode,
      web: pair(receipt, "company", "company-acme", "web").terminal.reasonCode,
      youtube: pair(receipt, "company", "company-acme", "youtube").terminal.reasonCode,
      productHunt: pair(receipt, "company", "company-acme", "product_hunt").terminal.reasonCode
    }, {
      reddit: "access_denied",
      web: "network_error",
      youtube: "captcha_required",
      productHunt: "rate_limited"
    });
  });

  it("rejects contradictory raw status, reasonCode, and reason signals", () => {
    const completedWithCredentialFailure = baseInput();
    const github = completedWithCredentialFailure.outcomes.find(
      (row) => row.attemptId === "github-1"
    );
    github.reasonCode = "missing_credentials";
    assert.throws(
      () => buildIngestionCoverageReceipt(completedWithCredentialFailure),
      /successful status contradicts/
    );

    const conflictingReason = baseInput();
    const founderX = conflictingReason.outcomes.find(
      (row) => row.attemptId === "founder-x-1"
    );
    founderX.reasonCode = "access_denied";
    assert.throws(
      () => buildIngestionCoverageReceipt(conflictingReason),
      /reasonCode access_denied contradicts reason signal missing_credentials/
    );

    const falseAbsence = baseInput();
    const linkedin = falseAbsence.outcomes.find((row) => row.attemptId === "linkedin-1");
    linkedin.reasonCode = "missing_credentials";
    linkedin.reason = "The required LinkedIn discovery credential is missing in production.";
    assert.throws(
      () => buildIngestionCoverageReceipt(falseAbsence),
      /absence status contradicts/
    );
  });

  it("deduplicates retry evidence, selects attempts deterministically, and rejects ordering ties", () => {
    const input = baseInput();
    const first = buildIngestionCoverageReceipt(input);
    const second = buildIngestionCoverageReceipt({
      ...input,
      tasks: [...input.tasks].reverse(),
      outcomes: [...input.outcomes].reverse(),
      evidence: [...input.evidence].reverse()
    });
    assert.deepEqual(second, first);
    const xPrimary = first.evidenceRegistry.find((entry) => entry.nativeId === "1001");
    assert.equal(xPrimary.sourceRefs.length, 2);
    assert.equal(pair(first, "company", "company-acme", "x").evidence.postCount, 2);

    const tied = baseInput();
    tied.outcomes.push({
      ...tied.outcomes.find((row) => row.taskKey === "task-company-reddit"),
      attemptId: "reddit-tied",
      checkedAt: "2026-08-02T18:25:00.000Z"
    });
    assert.throws(() => buildIngestionCoverageReceipt(tied), /tied attempt sequence or timestamp/);

    const reversedClock = baseInput();
    const reversedAttempt = reversedClock.outcomes.find((row) => row.attemptId === "reddit-2");
    reversedAttempt.startedAt = "2026-08-02T18:04:00.000Z";
    reversedAttempt.checkedAt = "2026-08-02T18:05:00.000Z";
    assert.throws(() => buildIngestionCoverageReceipt(reversedClock), /ordering disagree/);
  });

  it("uses account fallback only when unique and never double-counts task retries", () => {
    const ambiguous = baseInput();
    ambiguous.tasks.push(task(
      "task-acme-x-primary-retry",
      "company",
      "company-acme",
      "x",
      { platform: "x", url: ACME_X_PRIMARY, verificationStatus: "verified" }
    ));
    const primary = ambiguous.outcomes.find((row) => row.taskKey === "task-acme-x-primary");
    primary.taskKey = undefined;
    assert.throws(
      () => buildIngestionCoverageReceipt(ambiguous),
      /account fallback resolved 2 tasks/
    );
  });

  it("folds a URL-less discovery task and its discovered verified account into one task", () => {
    const input = minimalInput();
    input.tasks = [task(
      "discover-acme-x",
      "company",
      "company-acme",
      "x"
    )];
    input.outcomes = [outcome({
      taskKey: "discover-acme-x",
      entityType: "company",
      entityId: "company-acme",
      platform: "x",
      account: {
        platform: "x",
        url: ACME_X_PRIMARY,
        handle: "acme",
        verificationStatus: "verified"
      },
      attemptId: "discovery-x-1",
      attemptSequence: 1,
      status: "completed",
      reason: "Discovery resolved the verified native profile and persisted its first native post.",
      profileReceipt: profileReceipt(ACME_X_PRIMARY, "profile-discovery-x-1")
    })];
    input.evidence = [evidence({
      entityType: "company",
      entityId: "company-acme",
      platform: "x",
      nativeId: "discovery-post-1",
      digest: HASH_B,
      publishedAt: "2026-08-02T12:00:00.000Z",
      observedAt: "2026-08-02T18:27:00.000Z",
      taskKey: "discover-acme-x",
      attemptId: "discovery-x-1",
      accountUrl: ACME_X_PRIMARY
    })];
    const receipt = buildIngestionCoverageReceipt(input);
    const x = pair(receipt, "company", "company-acme", "x");
    assert.equal(x.mapping.accountCount, 1);
    assert.equal(x.mapping.verifiedAccountCount, 1);
    assert.equal(x.accountOutcomes.length, 1);
    assert.equal(x.accountOutcomes[0].taskKey, "discover-acme-x");
    assert.equal(x.accountOutcomes[0].status, "collected");
  });

  it("rejects a taskKey that spans different accounts or duplicate attempt identities", () => {
    const accountConflict = minimalInput();
    accountConflict.tasks = [task(
      "discover-conflict",
      "company",
      "company-acme",
      "x"
    )];
    accountConflict.outcomes = [
      outcome({
        taskKey: "discover-conflict",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        account: { platform: "x", url: ACME_X_PRIMARY },
        attemptId: "conflict-account-1",
        attemptSequence: 1,
        status: "failed",
        reason: "Network timeout interrupted the first bounded profile attempt."
      }),
      outcome({
        taskKey: "discover-conflict",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        account: { platform: "x", url: ACME_X_LABS },
        attemptId: "conflict-account-2",
        attemptSequence: 2,
        checkedAt: "2026-08-02T18:30:00.000Z",
        status: "failed",
        reason: "Network timeout interrupted the second bounded profile attempt."
      })
    ];
    assert.throws(
      () => buildIngestionCoverageReceipt(accountConflict),
      /taskKey .* cannot span multiple accounts/
    );

    const duplicateAttempt = baseInput();
    duplicateAttempt.outcomes.find((row) => row.attemptId === "web-1").attemptId = "youtube-1";
    assert.throws(
      () => buildIngestionCoverageReceipt(duplicateAttempt),
      /Duplicate attemptId youtube-1/
    );

    const receipt = buildIngestionCoverageReceipt(baseInput());
    const forged = structuredClone(receipt);
    const forgedX = pair(forged, "company", "company-acme", "x");
    forgedX.accountOutcomes.find((row) => row.taskKey === "task-acme-x-labs")
      .attempt.attemptId = "x-primary-1";
    forged.evidenceRegistry.find((row) => row.nativeId === "AbC-1002")
      .sourceRefs[0].attemptId = "x-primary-1";
    assert.throws(
      () => validateIngestionCoverageReceipt(forged, {
        expectedCatalogManifest: expectedManifest(receipt)
      }),
      /Duplicate attemptId x-primary-1/
    );
  });

  it("derives profile coverage from successful profile receipts and caps retries at 100 percent", () => {
    const input = minimalInput({
      accounts: [{
        platform: "x",
        url: ACME_X_PRIMARY,
        verificationStatus: "verified"
      }]
    });
    input.tasks = [
      task("profile-retry-1", "company", "company-acme", "x", {
        platform: "x",
        url: ACME_X_PRIMARY,
        verificationStatus: "verified"
      }),
      task("profile-retry-2", "company", "company-acme", "x", {
        platform: "x",
        url: ACME_X_PRIMARY,
        verificationStatus: "verified"
      })
    ];
    input.outcomes = [
      outcome({
        taskKey: "profile-retry-1",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        account: { platform: "x", url: ACME_X_PRIMARY, verificationStatus: "verified" },
        attemptId: "profile-retry-attempt-1",
        attemptSequence: 1,
        status: "completed",
        reason: "The first bounded retry persisted one native profile post row.",
        profileReceipt: profileReceipt(ACME_X_PRIMARY, "profile-retry-receipt-1")
      }),
      outcome({
        taskKey: "profile-retry-2",
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        account: { platform: "x", url: ACME_X_PRIMARY, verificationStatus: "verified" },
        attemptId: "profile-retry-attempt-2",
        attemptSequence: 1,
        status: "completed",
        reason: "The second bounded retry persisted a different native profile post row.",
        profileReceipt: profileReceipt(ACME_X_PRIMARY, "profile-retry-receipt-2")
      })
    ];
    delete input.outcomes[0].account;
    input.evidence = [
      evidence({
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        nativeId: "profile-retry-post-1",
        digest: HASH_B,
        publishedAt: "2026-08-02T12:00:00.000Z",
        observedAt: "2026-08-02T18:27:00.000Z",
        taskKey: "profile-retry-1",
        attemptId: "profile-retry-attempt-1",
        accountUrl: ACME_X_PRIMARY
      }),
      evidence({
        entityType: "company",
        entityId: "company-acme",
        platform: "x",
        nativeId: "profile-retry-post-2",
        digest: HASH_C,
        publishedAt: "2026-08-02T13:00:00.000Z",
        observedAt: "2026-08-02T18:28:00.000Z",
        taskKey: "profile-retry-2",
        attemptId: "profile-retry-attempt-2",
        accountUrl: ACME_X_PRIMARY
      })
    ];
    const receipt = buildIngestionCoverageReceipt(input);
    const xSummary = receipt.summary.byBatchPlatform.TEST.x.company;
    assert.equal(xSummary.profilesMapped, 1);
    assert.equal(xSummary.profilesScraped, 1);
    assert.equal(xSummary.profileScrapeCoveragePercent, 100);

    const forged = structuredClone(receipt);
    const forgedOutcome = pair(forged, "company", "company-acme", "x").accountOutcomes[0];
    forgedOutcome.profileReceipt = null;
    assert.throws(
      () => validateIngestionCoverageReceipt(forged, {
        expectedCatalogManifest: expectedManifest(receipt)
      }),
      /profileScraped must derive from profileReceipt/
    );
  });

  it("normalizes physical evidence globally and requires explicit multi-attribution review", () => {
    const input = multiAttributionInput();
    const pending = buildIngestionCoverageReceipt(input);
    assert.equal(pending.evidenceRegistry.length, 1);
    assert.equal(pending.multiAttributionReviews[0].status, "needs_review");
    assert.equal(pair(pending, "company", "company-acme", "x").terminal.status, "queued");
    assert.equal(pair(pending, "founder", "founder-acme-ada", "x").terminal.status, "queued");

    const evidenceKey = "x:native:shared-post";
    input.multiAttributionReviews = [{
      evidenceKey,
      attributionPairKeys: [
        "TEST:company:company-acme:x",
        "TEST:founder:founder-acme-ada:x"
      ],
      status: "approved",
      reviewedAt: CHECKED_AT,
      reason: "The post explicitly names both canonical owners and represents a verified joint announcement.",
      nextAction: "Retain both reviewed attributions and recheck them if either canonical identity changes."
    }];
    const approved = buildIngestionCoverageReceipt(input);
    assert.equal(pair(approved, "company", "company-acme", "x").terminal.status, "collected");
    assert.equal(pair(approved, "founder", "founder-acme-ada", "x").terminal.status, "collected");
    assert.equal(approved.summary.byBatchPlatform.TEST.x.total.posts, 1);

    const conflict = baseInput();
    conflict.evidence.push({ ...conflict.evidence[0], digest: HASH_D });
    assert.throws(() => buildIngestionCoverageReceipt(conflict), /conflicting physical evidence digests/);
  });

  it("requires concrete dated backfill, integrity, and fresh scheduler receipts for objectiveComplete", () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    const x = pair(receipt, "company", "company-acme", "x");
    assert.equal(x.scope.objectiveComplete, true);
    assert.equal(x.scope.integrityVerified, true);
    assert.equal(x.scope.scheduledIngestionCurrent, true);

    const noScheduler = baseInput();
    delete noScheduler.pairScopes[0].scope.schedulerReceipt;
    assert.throws(() => buildIngestionCoverageReceipt(noScheduler), /missing freshSchedulerReceipt/);

    const staleScheduler = baseInput();
    staleScheduler.pairScopes[0].scope.schedulerReceipt.freshThrough =
      "2026-08-02T17:30:00.000Z";
    assert.throws(() => buildIngestionCoverageReceipt(staleScheduler), /missing freshSchedulerReceipt/);

    const noScoring = baseInput();
    delete noScoring.pairScopes[0].scope.integrityChecks.scoring;
    assert.throws(() => buildIngestionCoverageReceipt(noScoring), /missing scoringIntegrityReceipt/);

    const staleBackfill = baseInput();
    staleBackfill.pairScopes[0].scope.recentBackfillReceipt.checkedAt =
      "2026-08-02T17:59:59.999Z";
    assert.throws(
      () => buildIngestionCoverageReceipt(staleBackfill),
      /must fall within the current run window/
    );

    for (const [field, expected] of [
      ["artifactDigest", /artifactDigest is required/],
      ["toolVersion", /toolVersion is required/],
      ["dependencyHash", /dependencyHash is required/]
    ]) {
      const unverifiableIntegrity = baseInput();
      delete unverifiableIntegrity.pairScopes[0].scope.integrityChecks.duplicates[field];
      assert.throws(
        () => buildIngestionCoverageReceipt(unverifiableIntegrity),
        expected
      );
    }
  });

  it("anchors recent coverage to the immutable pre-request cutoff while allowing later completion", () => {
    const input = baseInput();
    input.run.recentCoverageCutoff = RUN_STARTED_AT;
    const scope = input.pairScopes[0].scope;
    scope.recentBackfillReceipt.coveredFrom = cutoffAt(RUN_STARTED_AT);
    scope.recentBackfillReceipt.coveredThrough = RUN_STARTED_AT;
    scope.historicalBackfillReceipt.coveredThrough = cutoffAt(RUN_STARTED_AT);

    const receipt = buildIngestionCoverageReceipt(input);
    assert.equal(receipt.run.recentCoverageCutoff, RUN_STARTED_AT);
    assert.equal(receipt.recencyPolicy.cutoffAt, cutoffAt(RUN_STARTED_AT));
    assert.equal(
      pair(receipt, "company", "company-acme", "x")
        .scope.receipts.recentBackfill.coveredThrough,
      RUN_STARTED_AT
    );

    const backdated = structuredClone(input);
    backdated.pairScopes[0].scope.recentBackfillReceipt.coveredThrough = GENERATED_AT;
    assert.throws(
      () => buildIngestionCoverageReceipt(backdated),
      /must end at the immutable recent coverage cutoff/
    );

    const lateCutoff = structuredClone(input);
    lateCutoff.run.recentCoverageCutoff = "2026-08-02T18:00:00.001Z";
    assert.throws(
      () => buildIngestionCoverageReceipt(lateCutoff),
      /must be pinned no later than run.startedAt/
    );
  });

  it("binds validation to an independently expected catalog source hash/version/count manifest", () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    assert.throws(
      () => validateIngestionCoverageReceipt(receipt),
      /expectedCatalogManifest is required/
    );
    const wrongHash = expectedManifest(receipt);
    wrongHash.batches[0].sourceHash = HASH_D;
    assert.throws(
      () => validateIngestionCoverageReceipt(receipt, { expectedCatalogManifest: wrongHash }),
      /does not match the independently expected/
    );
    const wrongCount = expectedManifest(receipt);
    wrongCount.batches[0].founders = 2;
    wrongCount.batches[0].entities = 3;
    assert.throws(
      () => validateIngestionCoverageReceipt(receipt, { expectedCatalogManifest: wrongCount }),
      /does not match the independently expected/
    );

    const staleDeclaredHash = baseInput();
    staleDeclaredHash.catalogs[0].companies[0].name = "Changed canonical company";
    assert.throws(
      () => buildIngestionCoverageReceipt(staleDeclaredHash),
      /sourceHash does not match the canonical supplied roster and accounts/
    );

    const independentlyRejected = baseInput();
    independentlyRejected.catalogs[0].companies[0].name = "Changed canonical company";
    independentlyRejected.catalogs[0].sourceHash =
      computeIngestionCatalogSourceHash(independentlyRejected.catalogs[0]);
    assert.throws(
      () => buildIngestionCoverageReceipt(independentlyRejected),
      /does not match the independently expected/
    );
  });

  it("rejects content URLs masquerading as account mappings", () => {
    for (const [platform, url] of [
      ["x", "https://x.com/acme/status/123"],
      ["instagram", "https://instagram.com/p/AbCdEf"],
      ["linkedin", "https://linkedin.com/posts/acme_launch-123"],
      ["github", "https://github.com/acme/repo/issues/7"]
    ]) {
      assert.throws(
        () => buildIngestionCoverageReceipt(minimalInput({ accounts: [{
          platform,
          url,
          verificationStatus: "verified"
        }] })),
        /account URL must identify|profile, not content|not content/
      );
    }
  });

  it("merges account handles and review states deterministically, rejecting true conflicts", () => {
    const makeInput = () => {
      const input = minimalInput();
      input.outcomes = [
        outcome({
          taskKey: "account-merge-a",
          entityType: "company",
          entityId: "company-acme",
          platform: "x",
          account: {
            platform: "x",
            url: ACME_X_PRIMARY,
            handle: "Acme",
            verificationStatus: "needs_review"
          },
          attemptId: "account-merge-attempt-a",
          attemptSequence: 1,
          status: "failed",
          reason: "Network timeout interrupted the bounded account review fetch."
        }),
        outcome({
          taskKey: "account-merge-b",
          entityType: "company",
          entityId: "company-acme",
          platform: "x",
          account: {
            platform: "x",
            url: ACME_X_PRIMARY,
            handle: "acme",
            verificationStatus: "verified"
          },
          attemptId: "account-merge-attempt-b",
          attemptSequence: 1,
          status: "failed",
          reason: "Network timeout interrupted the bounded verification fetch."
        })
      ];
      return input;
    };
    const firstInput = makeInput();
    const secondInput = makeInput();
    secondInput.outcomes.reverse();
    const first = buildIngestionCoverageReceipt(firstInput);
    const second = buildIngestionCoverageReceipt(secondInput);
    assert.deepEqual(second, first);
    const account = pair(first, "company", "company-acme", "x").mapping.accounts[0];
    assert.equal(account.handle, "acme");
    assert.equal(account.verificationStatus, "verified");

    const handleConflict = makeInput();
    handleConflict.outcomes[1].account.handle = "different-handle";
    assert.throws(
      () => buildIngestionCoverageReceipt(handleConflict),
      /conflicting account handles/
    );

    const reviewConflict = makeInput();
    reviewConflict.outcomes[0].account.verificationStatus = "rejected";
    assert.throws(
      () => buildIngestionCoverageReceipt(reviewConflict),
      /conflicting rejected and accepted review states/
    );
  });

  it("canonicalizes case-insensitive LinkedIn slugs without dropping HN or YouTube identity", () => {
    const accounts = [
      {
        platform: "hacker_news",
        url: "https://news.ycombinator.com/user?id=CaseUser",
        verificationStatus: "verified"
      },
      {
        platform: "hacker_news",
        url: "https://news.ycombinator.com/user?id=caseuser",
        verificationStatus: "verified"
      },
      {
        platform: "youtube",
        url: "https://www.youtube.com/channel/UCAbC123",
        verificationStatus: "verified"
      },
      {
        platform: "youtube",
        url: "https://youtube.com/channel/UCabc123",
        verificationStatus: "verified"
      },
      {
        platform: "linkedin",
        url: "https://linkedin.com/company/Oasis-HQ",
        verificationStatus: "verified"
      }
    ];
    const receipt = buildIngestionCoverageReceipt(minimalInput({ accounts }));
    const hn = pair(receipt, "company", "company-acme", "hacker_news");
    const youtube = pair(receipt, "company", "company-acme", "youtube");
    const linkedin = pair(receipt, "company", "company-acme", "linkedin");
    assert.equal(hn.mapping.accountCount, 2);
    assert.deepEqual(hn.mapping.accounts.map((account) => account.url).sort(), [
      "https://news.ycombinator.com/user?id=CaseUser",
      "https://news.ycombinator.com/user?id=caseuser"
    ].sort());
    assert.equal(youtube.mapping.accountCount, 2);
    assert.deepEqual(youtube.mapping.accounts.map((account) => account.url).sort(), [
      "https://youtube.com/channel/UCAbC123",
      "https://youtube.com/channel/UCabc123"
    ]);
    assert.equal(linkedin.mapping.accountCount, 1);
    assert.equal(
      linkedin.mapping.accounts[0].url,
      "https://linkedin.com/company/oasis-hq"
    );

    assert.throws(
      () => buildIngestionCoverageReceipt(minimalInput({ accounts: [{
        platform: "youtube",
        url: "https://youtube.com.evil.example/channel/UCAbC123",
        verificationStatus: "verified"
      }] })),
      /host .* is not allowed/
    );
    assert.throws(
      () => buildIngestionCoverageReceipt(minimalInput({ accounts: [{
        platform: "x",
        url: "http://x.com/acme",
        verificationStatus: "verified"
      }] })),
      /credential-free HTTPS/
    );
  });

  it("rejects collector-specific nested GitHub shapes until an explicit adapter is supplied", () => {
    const input = minimalInput();
    input.tasks = [{
      taskKey: "nested-github",
      batchSlug: "TEST",
      entityType: "company",
      entityId: "company-acme",
      platform: "github",
      github: { owner: "acme", repo: "repo" }
    }];
    assert.throws(
      () => buildIngestionCoverageReceipt(input),
      /use an explicit normalized adapter/
    );
  });

  it("strictly validates calendar/future timestamps and derives recency from receipt time", () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    assert.equal(
      receipt.evidenceRegistry.find((entry) => entry.nativeId === "1001").recency,
      "recent"
    );
    assert.equal(
      receipt.evidenceRegistry.find((entry) => entry.nativeId === "AbC-1002").recency,
      "historical"
    );

    const impossible = baseInput();
    impossible.evidence[0].publishedAt = "2026-02-30T12:00:00.000Z";
    assert.throws(() => buildIngestionCoverageReceipt(impossible), /real calendar timestamp/);

    const future = baseInput();
    future.evidence[0].observedAt = "2026-08-02T18:36:00.000Z";
    assert.throws(() => buildIngestionCoverageReceipt(future), /current run window/);

    const later = baseInput();
    later.generatedAt = "2027-08-02T18:30:00.000Z";
    later.run.startedAt = "2027-08-02T18:00:00.000Z";
    later.run.completedAt = later.generatedAt;
    for (const row of later.outcomes) {
      row.startedAt = row.startedAt.replace("2026-", "2027-");
      row.checkedAt = row.checkedAt.replace("2026-", "2027-");
      if (row.profileReceipt) {
        row.profileReceipt.checkedAt = row.profileReceipt.checkedAt.replace("2026-", "2027-");
      }
      if (row.absenceVerification) {
        row.absenceVerification.checkedAt =
          row.absenceVerification.checkedAt.replace("2026-", "2027-");
      }
    }
    for (const row of later.evidence) {
      row.observedAt = row.observedAt.replace("2026-", "2027-");
    }
    later.pairScopes = [];
    const laterReceipt = buildIngestionCoverageReceipt(later);
    const firstEntry = receipt.evidenceRegistry.find((entry) => entry.nativeId === "1001");
    const laterEntry = laterReceipt.evidenceRegistry.find((entry) => entry.nativeId === "1001");
    assert.equal(laterEntry.digest, firstEntry.digest);
    assert.equal(laterEntry.evidenceKey, firstEntry.evidenceKey);
    assert.equal(laterEntry.recency, "historical");

    const inverted = structuredClone(receipt);
    const invertedX = pair(inverted, "company", "company-acme", "x");
    invertedX.evidence.oldestPublishedAt = "2026-08-01T12:00:00.000Z";
    invertedX.evidence.newestPublishedAt = "2026-04-01T12:00:00.000Z";
    assert.throws(
      () => validateIngestionCoverageReceipt(inverted, {
        expectedCatalogManifest: expectedManifest(receipt)
      }),
      /oldestPublishedAt exceeds newestPublishedAt/
    );
  });

  it("requires a fresh run and temporally correlates evidence to its attempt", () => {
    const staleRun = baseInput();
    staleRun.run.completedAt = "2026-08-02T18:20:00.000Z";
    assert.throws(
      () => buildIngestionCoverageReceipt(staleRun),
      /run.completedAt is stale/
    );

    const oldAttempt = baseInput();
    oldAttempt.outcomes[0].startedAt = "2026-08-02T17:58:00.000Z";
    assert.throws(
      () => buildIngestionCoverageReceipt(oldAttempt),
      /outcome.startedAt must fall within the current run window/
    );

    const observedBeforeAttempt = baseInput();
    observedBeforeAttempt.evidence[0].observedAt = "2026-08-02T18:10:00.000Z";
    assert.throws(
      () => buildIngestionCoverageReceipt(observedBeforeAttempt),
      /must correlate with its current attempt window/
    );

    const observedLongAfterAttempt = baseInput();
    const oldRedditEvidence = observedLongAfterAttempt.evidence.find(
      (row) => row.nativeId === "stale-reddit-post"
    );
    oldRedditEvidence.observedAt = "2026-08-02T18:20:00.000Z";
    assert.throws(
      () => buildIngestionCoverageReceipt(observedLongAfterAttempt),
      /must correlate with its current attempt window/
    );

    const receipt = buildIngestionCoverageReceipt(baseInput());
    const forged = structuredClone(receipt);
    forged.evidenceRegistry.find((row) => row.nativeId === "1001")
      .sourceRefs[0].observedAt = "2026-08-02T18:10:00.000Z";
    assert.throws(
      () => validateIngestionCoverageReceipt(forged, {
        expectedCatalogManifest: expectedManifest(receipt)
      }),
      /must correlate with its current attempt window/
    );
  });

  it("forbids verified_no_account without explicit exhaustive dated proof", () => {
    const input = baseInput();
    const linkedin = input.outcomes.find((row) => row.platform === "linkedin");
    delete linkedin.absenceVerification;
    const receipt = buildIngestionCoverageReceipt(input);
    assert.equal(pair(receipt, "company", "company-acme", "linkedin").terminal.status, "queued");

    const forged = structuredClone(receipt);
    const forgedPair = pair(forged, "company", "company-acme", "linkedin");
    forgedPair.accountOutcomes[0].status = "verified_no_account";
    forgedPair.accountOutcomes[0].reasonCode = "exhaustive_absence_verified";
    forgedPair.accountOutcomes[0].isTerminal = true;
    forgedPair.terminal.status = "verified_no_account";
    forgedPair.terminal.reasonCode = "exhaustive_absence_verified";
    forgedPair.terminal.isTerminal = true;
    assert.throws(
      () => validateIngestionCoverageReceipt(forged, {
        expectedCatalogManifest: expectedManifest(receipt)
      }),
      /must set exhaustive=true/
    );
  });

  it("validates nested canonical ordering and recomputed identities", () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    const manifest = expectedManifest(receipt);
    const badAccounts = structuredClone(receipt);
    pair(badAccounts, "company", "company-acme", "x").mapping.accounts.reverse();
    assert.throws(
      () => validateIngestionCoverageReceipt(badAccounts, { expectedCatalogManifest: manifest }),
      /canonically ordered/
    );

    const badOutcomes = structuredClone(receipt);
    pair(badOutcomes, "company", "company-acme", "x").accountOutcomes.reverse();
    assert.throws(
      () => validateIngestionCoverageReceipt(badOutcomes, { expectedCatalogManifest: manifest }),
      /accountOutcomes must be canonically ordered/
    );

    const badRegistry = structuredClone(receipt);
    badRegistry.evidenceRegistry.find((entry) => entry.nativeId === "1001").sourceRefs.reverse();
    assert.throws(
      () => validateIngestionCoverageReceipt(badRegistry, { expectedCatalogManifest: manifest }),
      /sourceRefs must be canonically ordered/
    );
  });

  it("streams normalized receipts in bounded chunks without duplicating evidence payloads into pairs", async () => {
    const receipt = buildIngestionCoverageReceipt(baseInput());
    const manifest = expectedManifest(receipt);
    assert.ok(receipt.pairs.every((candidate) =>
      candidate.evidence.evidenceRefs.every((reference) => typeof reference === "string")
    ));
    assert.ok(receipt.pairs.every((candidate) =>
      !Object.hasOwn(candidate.evidence, "digest") && !Object.hasOwn(candidate.evidence, "nativeId")
    ));
    const chunks = [...streamIngestionCoverageReceiptJson(receipt, {
      expectedCatalogManifest: manifest,
      maxChunkCharacters: 256
    })];
    assert.ok(Math.max(...chunks.map((chunk) => chunk.length)) <= 256);
    assert.deepEqual(JSON.parse(chunks.join("")), receipt);

    const written = [];
    const result = await writeIngestionCoverageReceiptJson(receipt, {
      expectedCatalogManifest: manifest,
      maxChunkCharacters: 256,
      write: async (chunk) => written.push(chunk)
    });
    assert.equal(result.characters, written.join("").length);
    assert.equal(result.strategy, receipt.serialization.strategy);
  });

  it("never splits UTF-16 surrogate pairs across bounded streaming chunks", () => {
    let chosen = null;
    for (let padding = 0; padding < 256 && !chosen; padding += 1) {
      const input = minimalInput();
      input.catalogs[0].companies[0].name = `Acme ${"x".repeat(padding)}😀 Labs`;
      input.catalogs[0].sourceHash = computeIngestionCatalogSourceHash(input.catalogs[0]);
      input.expectedCatalogManifest = manifestForCatalogs(input.catalogs);
      const receipt = buildIngestionCoverageReceipt(input);
      const hasBoundaryEmoji = receipt.pairs.some((candidate) => {
        const serialized = JSON.stringify(candidate);
        for (let index = 255; index < serialized.length; index += 256) {
          const code = serialized.charCodeAt(index);
          if (code >= 0xD800 && code <= 0xDBFF) return true;
        }
        return false;
      });
      if (hasBoundaryEmoji) chosen = receipt;
    }
    assert.ok(chosen, "fixture must place an emoji surrogate at a 256-character boundary");
    const chunks = [...streamIngestionCoverageReceiptJson(chosen, {
      expectedCatalogManifest: expectedManifest(chosen),
      maxChunkCharacters: 256
    })];
    for (let index = 0; index < chunks.length - 1; index += 1) {
      const last = chunks[index].charCodeAt(chunks[index].length - 1);
      const first = chunks[index + 1].charCodeAt(0);
      assert.equal(last >= 0xD800 && last <= 0xDBFF, false);
      assert.equal(first >= 0xDC00 && first <= 0xDFFF, false);
    }
    const separatelyEncoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "utf8")))
      .toString("utf8");
    assert.deepEqual(JSON.parse(separatelyEncoded), chosen);
  });
});

function minimalInput({ accounts = [], founders = [] } = {}) {
  const catalogs = catalog({ accounts, founders });
  return {
    run: {
      idempotencyKey: "minimal-idempotency",
      campaignKey: "minimal-campaign",
      startedAt: RUN_STARTED_AT,
      completedAt: GENERATED_AT
    },
    generatedAt: GENERATED_AT,
    catalogs,
    expectedCatalogManifest: manifestForCatalogs(catalogs)
  };
}

function multiAttributionInput() {
  const input = minimalInput({
    accounts: [],
    founders: [{ id: "founder-acme-ada", name: "Ada Founder", accounts: [] }]
  });
  input.outcomes = [
    outcome({
      taskKey: "shared-company-x",
      entityType: "company",
      entityId: "company-acme",
      platform: "x",
      attemptId: "shared-company-attempt",
      attemptSequence: 1,
      status: "completed",
      reason: "Collector linked the shared native announcement to the canonical company."
    }),
    outcome({
      taskKey: "shared-founder-x",
      entityType: "founder",
      entityId: "founder-acme-ada",
      platform: "x",
      attemptId: "shared-founder-attempt",
      attemptSequence: 1,
      status: "completed",
      reason: "Collector linked the shared native announcement to the canonical founder."
    })
  ];
  input.evidence = [
    evidence({
      entityType: "company",
      entityId: "company-acme",
      platform: "x",
      nativeId: "shared-post",
      digest: HASH_B,
      publishedAt: "2026-08-01T12:00:00.000Z",
      observedAt: "2026-08-02T18:26:00.000Z",
      taskKey: "shared-company-x",
      attemptId: "shared-company-attempt"
    }),
    evidence({
      entityType: "founder",
      entityId: "founder-acme-ada",
      platform: "x",
      nativeId: "shared-post",
      digest: HASH_B,
      publishedAt: "2026-08-01T12:00:00.000Z",
      observedAt: "2026-08-02T18:27:00.000Z",
      taskKey: "shared-founder-x",
      attemptId: "shared-founder-attempt"
    })
  ];
  return input;
}
