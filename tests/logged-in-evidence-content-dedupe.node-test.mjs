import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { finalizeLoggedInEvidenceContent } from "../scripts/lib/logged-in-evidence-content-dedupe.mjs";

describe("logged-in evidence exact-content finalization", () => {
  it("repairs legacy owner-collision reviews from their canonical company target", () => {
    const legacyReview = {
      id: "native-account-owner-collision-s2026-x-shared",
      batchSlug: "S2026",
      platform: "x",
      candidateUrl: "https://x.com/shared",
      review_state: "needs_review",
      quarantineReasons: ["ambiguous_native_account_owner_mapping"],
      nativeAccountOwnerCollision: {
        accountIdentity: "x:shared",
        entityIds: ["company-acme", "founder-acme-alice"],
        targets: [
          {
            companySlug: "acme",
            companyName: "Acme",
            entityType: "company",
            entityId: "company-acme",
            entityName: "Acme",
            accountUrl: "https://x.com/shared"
          },
          {
            companySlug: "acme",
            companyName: "Acme",
            entityType: "founder",
            entityId: "founder-acme-alice",
            entityName: "Alice",
            accountUrl: "https://x.com/shared"
          }
        ]
      }
    };

    const finalized = finalizeLoggedInEvidenceContent([], {
      defaultBatchSlug: "S2026",
      existingNeedsReview: [legacyReview]
    });

    assert.equal(finalized.needsReview.length, 1);
    assert.deepEqual(
      {
        entityType: finalized.needsReview[0].entityType,
        entityId: finalized.needsReview[0].entityId,
        entityName: finalized.needsReview[0].entityName,
        companySlug: finalized.needsReview[0].companySlug,
        companyName: finalized.needsReview[0].companyName
      },
      {
        entityType: "company",
        entityId: "company-acme",
        entityName: "Acme",
        companySlug: "acme",
        companyName: "Acme"
      }
    );
  });

  it("quarantines explicit LinkedIn repost wrappers so they cannot score", () => {
    const repost = {
      id: "linkedin-repost-wrapper",
      entityType: "founder",
      entityId: "founder-name",
      batchSlug: "S2026",
      companySlug: "acme",
      companyName: "Acme",
      platform: "linkedin",
      sourceUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000005/",
      platformPostId: "7475000000000000005",
      text: "A long copied body from someone else.",
      rawVisibleText:
        "Feed post number 3 Founder Name reposted this Someone Else 2h Original body",
      metrics: { likes: 10 },
      review_state: "verified"
    };

    const result = finalizeLoggedInEvidenceContent([repost], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(result.evidence, []);
    assert.equal(result.needsReview.length, 1);
    assert.deepEqual(result.needsReview[0].quarantineReasons, [
      "non_native_linkedin_repost_wrapper"
    ]);
  });

  it("quarantines metricless native observations so they cannot score", () => {
    const metricless = xRow({
      id: "metricless-x",
      platformPostId: "2079949065148916000",
      metrics: { views: 0, likes: 0, comments: 0, reposts: 0 }
    });

    const result = finalizeLoggedInEvidenceContent([metricless], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(result.evidence, []);
    assert.deepEqual(result.needsReview[0].quarantineReasons, [
      "metricless_native_post"
    ]);
  });

  it("retains an assumed-functional native URL when detail metrics are unavailable", () => {
    const observed = instagramRow({
      id: "assumed-functional-instagram",
      entityType: "company",
      entityId: "company-acme",
      companySlug: "acme",
      companyName: "Acme",
      platformPostId: "REEL_429",
      accountUrl: "https://www.instagram.com/acme/"
    });
    observed.metrics = {};
    observed.contributionScore = 0;
    observed.tractionStatus = "unscored";
    observed.linkStatus = "unchecked";
    observed.postedAt = null;

    const result = finalizeLoggedInEvidenceContent([observed], {
      defaultBatchSlug: "S2026"
    });

    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].sourceUrl, observed.sourceUrl);
    assert.equal(result.evidence[0].tractionStatus, "unscored");
    assert.equal(result.needsReview.length, 0);
  });

  it("retains dated historical native posts but quarantines unknown-date observations", () => {
    const historical = xRow({
      id: "historical-x",
      platformPostId: "1339949065148916000",
      postedAt: "2020-01-01T00:00:00.000Z"
    });
    const unknown = xRow({
      id: "unknown-date-x",
      platformPostId: "not-a-native-id",
      postedAt: null
    });

    const result = finalizeLoggedInEvidenceContent([historical, unknown], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(result.evidence.map((row) => row.id), ["historical-x"]);
    assert.deepEqual(
      result.needsReview.map((row) => row.quarantineReasons[0]).sort(),
      ["invalid_native_post_date"]
    );
  });

  it("derives a stable LinkedIn publication time from the native activity id", () => {
    const row = {
      id: "linkedin-native-no-date",
      entityType: "founder",
      entityId: "founder-acme",
      batchSlug: "S2026",
      companySlug: "acme",
      companyName: "Acme",
      platform: "linkedin",
      sourceUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:7454820693017284608/",
      platformPostId: "7454820693017284608",
      text: "A native founder post.",
      rawVisibleText: "A native founder post.",
      postedAt: null,
      metrics: { likes: 10 },
      review_state: "verified"
    };

    const result = finalizeLoggedInEvidenceContent([row], {
      defaultBatchSlug: "S2026"
    });

    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].postedAt, "2026-04-28T09:15:57.086Z");
    assert.deepEqual(result.needsReview, []);
  });

  it("derives LinkedIn publication time from the activity URL when the id field is absent", () => {
    const row = {
      id: "linkedin-native-url-only",
      entityType: "founder",
      entityId: "founder-acme",
      batchSlug: "S2026",
      companySlug: "acme",
      companyName: "Acme",
      platform: "linkedin",
      sourceUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:7454820693017284608/",
      platformPostId: null,
      text: "A native founder post.",
      rawVisibleText: "A native founder post.",
      postedAt: null,
      metrics: { likes: 10 },
      review_state: "verified"
    };

    const result = finalizeLoggedInEvidenceContent([row], {
      defaultBatchSlug: "S2026"
    });

    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].postedAt, "2026-04-28T09:15:57.086Z");
    assert.deepEqual(result.needsReview, []);
  });

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

  it("keeps one deterministic freshest native observation for the same entity and physical post", () => {
    const older = xRow({
      id: "x-company-agentphone-old",
      entityId: "company-agentphone",
      companySlug: "agentphone",
      platformPostId: "2066325830905860379",
      accountUrl: "https://x.com/agentphonehq",
      first_seen_at: "2026-06-28T18:03:53.742Z",
      last_checked_at: "2026-06-28T18:03:53.742Z",
      metrics: { likes: 12, reposts: 2, comments: 3, views: 3_800 }
    });
    const fresher = xRow({
      id: "x-company-agentphone-fresh",
      entityId: "company-agentphone",
      companySlug: "agentphone",
      platformPostId: "2066325830905860379",
      accountUrl: "https://x.com/agentphonehq",
      first_seen_at: "2026-07-29T08:28:05.646Z",
      last_checked_at: "2026-07-29T08:28:05.646Z",
      metrics: { likes: 13, reposts: 2, comments: 3, views: 3_885 }
    });

    const forward = finalizeLoggedInEvidenceContent([older, fresher], {
      defaultBatchSlug: "S2026"
    });
    const reversed = finalizeLoggedInEvidenceContent([fresher, older], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward.evidence.map((row) => row.id), [fresher.id]);
    assert.deepEqual(forward.needsReview, []);
    assert.deepEqual(forward.attributionReconciliationLedger, []);
  });

  it("uses metric completeness before freshness for same-physical observations", () => {
    const richer = xRow({
      id: "x-company-anoria-richer",
      entityId: "company-anoria",
      companySlug: "anoria",
      platformPostId: "2051714380119839195",
      accountUrl: "https://x.com/anoria_inc",
      last_checked_at: "2026-07-28T00:00:00.000Z",
      metrics: { likes: 29, reposts: 3, comments: 3, views: 2_627 }
    });
    const newerButIncomplete = xRow({
      id: "x-company-anoria-newer-incomplete",
      entityId: "company-anoria",
      companySlug: "anoria",
      platformPostId: "2051714380119839195",
      accountUrl: "https://x.com/anoria_inc",
      last_checked_at: "2026-07-29T00:00:00.000Z",
      metrics: { likes: 30, views: 2_700 }
    });

    const finalized = finalizeLoggedInEvidenceContent([newerButIncomplete, richer], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(finalized.evidence.map((row) => row.id), [richer.id]);
  });

  it("reattributes a shared personal native account from the company catalog path to its founder", () => {
    const company = xRow({
      id: "x-company-allowance-2079949065148916081",
      entityType: "company",
      entityId: "company-allowance",
      companySlug: "allowance",
      companyName: "Allowance",
      platformPostId: "2079949065148916081",
      accountUrl: "https://x.com/dasmersingh"
    });
    const founder = xRow({
      id: "x-founder-allowance-dasmer-singh-2079949065148916081",
      entityType: "founder",
      entityId: "founder-allowance-dasmer-singh-330737",
      companySlug: "allowance",
      companyName: "Allowance",
      platformPostId: "2079949065148916081",
      accountUrl: "https://twitter.com/DasmerSingh/"
    });

    const forward = finalizeLoggedInEvidenceContent([company, founder], {
      defaultBatchSlug: "S2026"
    });
    const reversed = finalizeLoggedInEvidenceContent([founder, company], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward.evidence.map((row) => row.id), [founder.id]);
    assert.equal(forward.needsReview.length, 1);
    assert.deepEqual(forward.needsReview[0].quarantineReasons, ["native_owner_founder_account"]);
    assert.deepEqual(forward.attributionReconciliationLedger, [
      {
        platform: "x",
        sourceUrl: company.sourceUrl,
        platformPostId: company.platformPostId,
        disposition: "reattributed",
        reason: "native_owner_founder_account",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-allowance",
          attributionType: "subject"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-allowance-dasmer-singh-330737",
          attributionType: "subject"
        }
      }
    ]);
  });

  it("uses captured Instagram primary-author proof to retain a founder collaboration post", () => {
    const company = instagramRow({
      id: "instagram-company-heyclicky-DayUBNASjcO",
      entityType: "company",
      entityId: "company-heyclicky",
      companySlug: "heyclicky",
      companyName: "HeyClicky",
      platformPostId: "DayUBNASjcO",
      accountUrl: "https://www.instagram.com/_heyclicky/",
      primaryHandle: "farza954"
    });
    const founder = instagramRow({
      id: "instagram-founder-heyclicky-farza-DayUBNASjcO",
      entityType: "founder",
      entityId: "founder-heyclicky-farza",
      companySlug: "heyclicky",
      companyName: "HeyClicky",
      platformPostId: "DayUBNASjcO",
      accountUrl: "https://www.instagram.com/farza954/",
      primaryHandle: "farza954"
    });

    const forward = finalizeLoggedInEvidenceContent([company, founder], {
      defaultBatchSlug: "S2026"
    });
    const reversed = finalizeLoggedInEvidenceContent([founder, company], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward.evidence.map((row) => row.id), [founder.id]);
    assert.equal(forward.needsReview.length, 1);
    assert.deepEqual(forward.needsReview[0].quarantineReasons, [
      "instagram_collaboration_primary_native_owner"
    ]);
    assert.deepEqual(forward.needsReview[0].instagramPrimaryOwner, {
      handle: "farza954",
      evidence: "captured_post_permalink_or_description"
    });
    assert.deepEqual(forward.attributionReconciliationLedger, [
      {
        platform: "instagram",
        sourceUrl: company.sourceUrl,
        platformPostId: company.platformPostId,
        disposition: "reattributed",
        reason: "instagram_collaboration_primary_native_owner",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-heyclicky",
          attributionType: "subject"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-heyclicky-farza",
          attributionType: "subject"
        }
      }
    ]);
  });

  it("uses the aligned physical observation while preserving the primary owner attribution", () => {
    const company = instagramRow({
      id: "instagram-company-heyclicky-Dai6_tWykGy",
      entityType: "company",
      entityId: "company-heyclicky",
      companySlug: "heyclicky",
      companyName: "HeyClicky",
      platformPostId: "Dai6_tWykGy",
      accountUrl: "https://www.instagram.com/_heyclicky/",
      primaryHandle: "farza954"
    });
    company.metrics = { likes: 2_418, comments: 81 };
    company.contributionScore = 68;
    company.postedAt = "2026-07-08T20:42:52.000Z";
    const companyPayload = JSON.parse(company.rawVisibleText);
    companyPayload.detail.caption = "Native collaboration post";
    company.rawVisibleText = JSON.stringify(companyPayload);

    const founder = instagramRow({
      id: "instagram-founder-heyclicky-farza-Dai6_tWykGy",
      entityType: "founder",
      entityId: "founder-heyclicky-farza",
      companySlug: "heyclicky",
      companyName: "HeyClicky",
      platformPostId: "Dai6_tWykGy",
      accountUrl: "https://www.instagram.com/farza954/",
      primaryHandle: "farza954"
    });
    founder.metrics = { likes: 4_675, comments: 42 };
    founder.contributionScore = 72;
    founder.postedAt = "2026-07-11T17:40:33.000Z";
    const founderPayload = JSON.parse(founder.rawVisibleText);
    founderPayload.detail.caption = "Caption from an adjacent modal post";
    founder.rawVisibleText = JSON.stringify(founderPayload);

    const finalized = finalizeLoggedInEvidenceContent([founder, company], {
      defaultBatchSlug: "S2026"
    });

    assert.equal(finalized.evidence.length, 1);
    assert.equal(finalized.evidence[0].entityType, "founder");
    assert.equal(finalized.evidence[0].entityId, founder.entityId);
    assert.deepEqual(finalized.evidence[0].metrics, company.metrics);
    assert.equal(
      finalized.evidence[0].contributionScore,
      company.contributionScore
    );
    assert.equal(finalized.evidence[0].postedAt, company.postedAt);
    assert.equal(
      JSON.parse(finalized.evidence[0].rawVisibleText).detail.caption,
      "Native collaboration post"
    );
  });

  it("uses captured Instagram primary-author proof to retain a company collaboration post", () => {
    const company = instagramRow({
      id: "instagram-company-mirror-DZaUqGAB-5G",
      entityType: "company",
      entityId: "company-mirror",
      companySlug: "mirror",
      companyName: "Mirror Mirror AI",
      platformPostId: "DZaUqGAB-5G",
      accountUrl: "https://www.instagram.com/mirrormirror.ai/",
      primaryHandle: "mirrormirror.ai"
    });
    const founder = instagramRow({
      id: "instagram-founder-mirror-yusan-DZaUqGAB-5G",
      entityType: "founder",
      entityId: "founder-mirror-yusan",
      companySlug: "mirror",
      companyName: "Mirror Mirror AI",
      platformPostId: "DZaUqGAB-5G",
      accountUrl: "https://www.instagram.com/yusan.lin/",
      primaryHandle: "mirrormirror.ai"
    });

    const finalized = finalizeLoggedInEvidenceContent([founder, company], {
      defaultBatchSlug: "A16ZSR006"
    });

    assert.deepEqual(finalized.evidence.map((row) => row.id), [company.id]);
    assert.equal(finalized.needsReview.length, 1);
    assert.deepEqual(finalized.needsReview[0].quarantineReasons, [
      "instagram_collaboration_primary_native_owner"
    ]);
    assert.deepEqual(
      finalized.attributionReconciliationLedger[0].staleAttribution,
      {
        batchSlug: "A16ZSR006",
        entityType: "founder",
        entityId: "founder-mirror-yusan",
        attributionType: "subject"
      }
    );
    assert.deepEqual(
      finalized.attributionReconciliationLedger[0].replacementAttribution,
      {
        batchSlug: "A16ZSR006",
        entityType: "company",
        entityId: "company-mirror",
        attributionType: "subject"
      }
    );
  });

  it("does not guess Instagram collaboration ownership without one consistent primary-author signal", () => {
    const company = instagramRow({
      id: "instagram-company-ambiguous",
      entityType: "company",
      entityId: "company-ambiguous-instagram",
      companySlug: "ambiguous-instagram",
      companyName: "Ambiguous Instagram",
      platformPostId: "AmbiguousPost",
      accountUrl: "https://www.instagram.com/company.account/",
      primaryHandle: null
    });
    const founder = instagramRow({
      id: "instagram-founder-ambiguous",
      entityType: "founder",
      entityId: "founder-ambiguous-instagram",
      companySlug: "ambiguous-instagram",
      companyName: "Ambiguous Instagram",
      platformPostId: "AmbiguousPost",
      accountUrl: "https://www.instagram.com/founder.account/",
      primaryHandle: null
    });

    const finalized = finalizeLoggedInEvidenceContent([company, founder], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(
      finalized.evidence.map((row) => row.id).sort(),
      [company.id, founder.id].sort()
    );
    assert.deepEqual(finalized.needsReview, []);
    assert.deepEqual(finalized.attributionReconciliationLedger, []);
  });

  it("resolves legacy browser-timeline owner paths when accountUrl was not yet persisted", () => {
    const company = xRow({
      id: "x-company-arlo-2054592506923499633",
      entityId: "company-arlo-industries",
      companySlug: "arlo-industries",
      platformPostId: "2054592506923499633",
      accountUrl: null,
      handle: "deoarlo",
      matchReason:
        "Opt-in read-only X browser timeline scrape for @deoarlo; metrics came from visible aria-label post controls."
    });
    const founder = xRow({
      id: "x-founder-arlo-2054592506923499633",
      entityType: "founder",
      entityId: "founder-arlo-industries-deo-arlo-iron-dome-guy-836806",
      companySlug: "arlo-industries",
      platformPostId: "2054592506923499633",
      accountUrl: null,
      handle: "deoarlo",
      matchReason:
        "Opt-in read-only X browser timeline scrape for @deoarlo; metrics came from visible aria-label post controls."
    });

    const finalized = finalizeLoggedInEvidenceContent([company, founder], {
      defaultBatchSlug: "S2026"
    });

    assert.deepEqual(finalized.evidence.map((row) => row.id), [founder.id]);
    assert.equal(finalized.attributionReconciliationLedger.length, 1);
    assert.equal(
      finalized.attributionReconciliationLedger[0].replacementAttribution.entityId,
      founder.entityId
    );
  });

  it("does not collapse legitimate cross-company subject attribution or distinct account paths", () => {
    const firstCompany = xRow({
      id: "x-company-first-shared-subject",
      entityId: "company-first",
      companySlug: "first",
      platformPostId: "2070000000000000001",
      accountUrl: "https://x.com/thirdparty"
    });
    const secondCompany = xRow({
      id: "x-company-second-shared-subject",
      entityId: "company-second",
      companySlug: "second",
      platformPostId: "2070000000000000001",
      accountUrl: "https://x.com/thirdparty"
    });
    const companyPath = xRow({
      id: "x-company-third-company-path",
      entityId: "company-third",
      companySlug: "third",
      platformPostId: "2070000000000000002",
      accountUrl: "https://x.com/thirdcompany"
    });
    const founderPath = xRow({
      id: "x-founder-third-founder-path",
      entityType: "founder",
      entityId: "founder-third-owner-1",
      companySlug: "third",
      platformPostId: "2070000000000000002",
      accountUrl: "https://x.com/thirdfounder"
    });

    const finalized = finalizeLoggedInEvidenceContent(
      [firstCompany, secondCompany, companyPath, founderPath],
      { defaultBatchSlug: "S2026" }
    );

    assert.deepEqual(
      finalized.evidence.map((row) => row.id).sort(),
      [firstCompany.id, secondCompany.id, companyPath.id, founderPath.id].sort()
    );
    assert.deepEqual(finalized.needsReview, []);
    assert.deepEqual(finalized.attributionReconciliationLedger, []);
  });

  it("fails closed when one native account path is attributed to multiple founders", () => {
    const company = xRow({
      id: "x-company-ambiguous-owner",
      entityId: "company-ambiguous",
      companySlug: "ambiguous",
      platformPostId: "2070000000000000003",
      accountUrl: "https://x.com/sharedfounderaccount"
    });
    const firstFounder = xRow({
      id: "x-founder-ambiguous-first",
      entityType: "founder",
      entityId: "founder-ambiguous-first",
      companySlug: "ambiguous",
      platformPostId: "2070000000000000003",
      accountUrl: "https://x.com/sharedfounderaccount"
    });
    const secondFounder = xRow({
      id: "x-founder-ambiguous-second",
      entityType: "founder",
      entityId: "founder-ambiguous-second",
      companySlug: "ambiguous",
      platformPostId: "2070000000000000003",
      accountUrl: "https://x.com/sharedfounderaccount"
    });

    const finalized = finalizeLoggedInEvidenceContent(
      [company, firstFounder, secondFounder],
      { defaultBatchSlug: "S2026" }
    );

    assert.deepEqual(finalized.evidence, []);
    assert.equal(finalized.needsReview.length, 3);
    assert.equal(
      finalized.needsReview.every(
        (row) =>
          row.review_state === "needs_review" &&
          row.quarantineReasons.includes(
            "ambiguous_native_account_owner_mapping"
          ) &&
          row.nativeAccountOwnerCollision.entityIds.length === 3
      ),
      true
    );
    assert.deepEqual(finalized.attributionReconciliationLedger, []);
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
    postedAt: "2025-12-05T06:00:00.000Z",
    metrics: { likes: 5, reposts: 0, views: 223 },
    ...overrides
  };
}

function resolveFixtureBatch(row) {
  return row?.entityId === "founder-cignara-nalin-gupta-78606" ? "S2026" : null;
}

function xRow({
  id,
  entityType = "company",
  entityId,
  companySlug,
  companyName = companySlug,
  platformPostId,
  accountUrl,
  handle = accountUrl ? new URL(accountUrl).pathname.split("/").filter(Boolean)[0] : null,
  text = "Native X post",
  metrics = { likes: 10, reposts: 2, comments: 3, views: 1_000 },
  postedAt = "2026-07-20T12:00:00.000Z",
  first_seen_at = "2026-07-29T08:28:05.646Z",
  last_checked_at = first_seen_at,
  matchReason = `Verified native timeline for @${handle}.`
}) {
  return {
    id,
    entityType,
    entityId,
    batchSlug: "S2026",
    companySlug,
    companyName,
    platform: "x",
    sourceUrl: `https://x.com/${handle}/status/${platformPostId}`,
    platformPostId,
    ...(accountUrl ? { accountUrl } : {}),
    text,
    rawVisibleText: JSON.stringify({
      author: handle,
      id: platformPostId,
      text,
      url: `https://x.com/${handle}/status/${platformPostId}`
    }),
    postedAt,
    metrics,
    contributionScore: 40,
    review_state: "verified",
    matchReason,
    first_seen_at,
    last_checked_at,
    last_updated_at: "2026-07-20T12:00:00.000Z"
  };
}

function instagramRow({
  id,
  entityType,
  entityId,
  companySlug,
  companyName,
  platformPostId,
  accountUrl,
  primaryHandle
}) {
  const rawVisibleText = primaryHandle
    ? JSON.stringify({
        gridUrl: {
          rawHref:
            `https://www.instagram.com/${primaryHandle}/reel/${platformPostId}/`
        },
        detail: {
          description:
            `100 likes, 10 comments - ${primaryHandle} on July 14, 2026: "Native collaboration post".`
        }
      })
    : JSON.stringify({
        gridUrl: {
          href: `https://www.instagram.com/reel/${platformPostId}/`
        },
        detail: {
          rawText: "Collaboration post with no captured primary author"
        }
      });
  return {
    id,
    entityType,
    entityId,
    companySlug,
    companyName,
    platform: "instagram",
    sourceUrl: `https://www.instagram.com/reel/${platformPostId}/`,
    platformPostId,
    accountUrl,
    text: "Native collaboration post",
    rawVisibleText,
    postedAt: "2026-07-14T12:00:00.000Z",
    metrics: { likes: 100, comments: 10 },
    contributionScore: 40,
    review_state: "verified",
    matchReason: "Opt-in read-only Instagram collaboration scrape.",
    first_seen_at: "2026-07-29T08:28:05.646Z",
    last_checked_at: "2026-07-29T08:28:05.646Z",
    last_updated_at: "2026-07-14T12:00:00.000Z"
  };
}
