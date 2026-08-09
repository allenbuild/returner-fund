import assert from "node:assert/strict";
import test from "node:test";

import { physicalSourceKey } from "../scripts/lib/ingestion-source-delta.mjs";
import {
  buildCohortOwnerCatalog,
  buildPromotionCandidateArtifact,
  evaluateHistoricalSidecarRow,
  extractCurrentEvidenceRows,
  extractCurrentHeldRows,
  extractEvidenceRows,
  physicalIdentityKeys,
  recoveryPhysicalKey,
  stableJson,
  summarizeRecoveryJournal,
  validateNativeCandidate
} from "../scripts/lib/repository-sidecar-history-recovery.mjs";

const graph = {
  batch: { slug: "S2026" },
  nodes: [
    {
      entityType: "company",
      entityId: "company-acme",
      batchSlug: "S2026",
      label: "Acme",
      ycProfileUrl: "https://www.ycombinator.com/companies/acme",
      socialAccounts: [
        verifiedAccount("acct-company-x", "x", "acme", "https://x.com/acme"),
        verifiedAccount("acct-company-linkedin", "linkedin", "acme", "https://linkedin.com/company/acme"),
        verifiedAccount("acct-company-youtube", "youtube", "@acme", "https://youtube.com/@acme")
      ],
      founders: [
        {
          id: "founder-acme-alice",
          name: "Alice Founder",
          socialAccounts: [
            verifiedAccount("acct-founder-x", "x", "alice", "https://x.com/alice"),
            verifiedAccount("acct-founder-github", "github", "alice", "https://github.com/alice")
          ]
        }
      ]
    }
  ]
};

test("accepts only current cohort owners on their current verified native accounts", () => {
  const catalog = buildCohortOwnerCatalog([graph]);
  const row = xRow();
  const accepted = evaluateHistoricalSidecarRow(row, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.owner.entityId, "founder-acme-alice");
  assert.equal(accepted.accountMatch.account.id, "acct-founder-x");
  assert.equal(accepted.nativeIdentity.postId, "2070000000000000000");

  const thirdParty = evaluateHistoricalSidecarRow({
    ...row,
    sourceUrl: "https://x.com/ycpartner/status/2070000000000000000",
    authorHandle: "ycpartner",
    accountUrl: "https://x.com/ycpartner",
    socialAccountId: null
  }, { catalog, currentPhysicalKeys: new Set(), sourcePath: "public/graph/s2026.json" });
  assert.equal(thirdParty.accepted, false);
  assert.ok(thirdParty.reasons.includes("native_author_not_current_verified_owner"));

  const topVoice = evaluateHistoricalSidecarRow({ ...row, topVoice: { audienceId: "insiders" } }, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026-insiders.json"
  });
  assert.equal(topVoice.accepted, false);
  assert.ok(topVoice.reasons.includes("third_party_top_voice_post"));
});

test("rejects current physical posts, foreign scopes, review rows, and native ID conflicts", () => {
  const catalog = buildCohortOwnerCatalog([graph]);
  const row = xRow();
  const currentPhysicalKeys = new Set([physicalSourceKey(row)]);
  const duplicate = evaluateHistoricalSidecarRow(row, {
    catalog,
    currentPhysicalKeys,
    sourcePath: "public/graph/s2026.json"
  });
  assert.ok(duplicate.reasons.includes("already_in_current_evidence"));

  const foreign = evaluateHistoricalSidecarRow({ ...row, batchSlug: "S26" }, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  assert.ok(foreign.reasons.includes("path_batch_scope_conflict"));
  assert.ok(foreign.reasons.includes("current_cohort_owner_not_resolved"));

  const review = evaluateHistoricalSidecarRow({ ...row, review_state: "needs_review" }, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  assert.ok(review.reasons.includes("historical_row_not_verified"));

  const conflict = evaluateHistoricalSidecarRow({ ...row, platformPostId: "2060000000000000000" }, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  assert.ok(conflict.reasons.includes("native_url_platform_post_id_conflict"));
});

test("LinkedIn history remains offline and requires exact mapped account evidence", async () => {
  const catalog = buildCohortOwnerCatalog([graph]);
  const row = {
    id: "linkedin-company-acme-activity-7467251847137939459",
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-acme",
    companyName: "Acme",
    platform: "linkedin",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7467251847137939459/",
    platformPostId: "7467251847137939459",
    accountUrl: "https://www.linkedin.com/company/acme/",
    socialAccountId: "acct-company-linkedin",
    review_state: "verified"
  };
  const decision = evaluateHistoricalSidecarRow(row, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "src/lib/social/logged-in-evidence-current.json"
  });
  assert.equal(decision.accepted, true);
  let fetchCalled = false;
  const validation = await validateNativeCandidate({ decision }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("LinkedIn must remain offline");
    }
  });
  assert.equal(fetchCalled, false);
  assert.deepEqual(validation, {
    status: "accepted",
    live: false,
    method: "current_verified_owner_plus_native_url_grammar",
    canonicalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7467251847137939459/",
    reasons: []
  });
});

test("uses anonymous official oEmbed checks for X and YouTube and native GitHub URLs", async () => {
  const catalog = buildCohortOwnerCatalog([graph]);
  const xDecision = evaluateHistoricalSidecarRow(xRow(), {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  const xValidation = await validateNativeCandidate({ decision: xDecision }, {
    fetchImpl: async (url) => {
      assert.equal(new URL(url).hostname, "publish.twitter.com");
      return response({
        url: xDecision.nativeIdentity.url,
        author_url: "https://x.com/alice",
        author_name: "Alice Founder",
        html: "<blockquote>post</blockquote>"
      });
    }
  });
  assert.equal(xValidation.status, "accepted");
  assert.equal(xValidation.method, "official_x_oembed");

  const youtubeRow = {
    id: "youtube-company-acme-video",
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-acme",
    companyName: "Acme",
    platform: "youtube",
    sourceUrl: "https://youtu.be/abcdefghijk",
    platformPostId: "abcdefghijk",
    accountUrl: "https://youtube.com/@acme",
    socialAccountId: "acct-company-youtube",
    review_state: "verified"
  };
  const youtubeDecision = evaluateHistoricalSidecarRow(youtubeRow, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  const youtubeValidation = await validateNativeCandidate({ decision: youtubeDecision }, {
    fetchImpl: async (url) => {
      assert.equal(new URL(url).hostname, "www.youtube.com");
      return response({ type: "video", title: "Acme launch" });
    }
  });
  assert.equal(youtubeValidation.status, "accepted");
  assert.equal(youtubeValidation.method, "official_youtube_oembed");

  const githubRow = {
    id: "github-founder-acme-alice-repo",
    batchSlug: "S2026",
    entityType: "founder",
    entityId: "founder-acme-alice",
    companyName: "Acme",
    platform: "github",
    sourceUrl: "https://github.com/alice/project",
    platformPostId: "alice/project",
    authorHandle: "alice",
    accountUrl: "https://github.com/alice",
    socialAccountId: "acct-founder-github",
    review_state: "verified"
  };
  const githubDecision = evaluateHistoricalSidecarRow(githubRow, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  const githubValidation = await validateNativeCandidate({ decision: githubDecision }, {
    fetchImpl: async () => response(null, { url: "https://github.com/alice/project" })
  });
  assert.equal(githubValidation.status, "accepted");
  assert.equal(githubValidation.method, "github_native_url");
});

test("offline mode never calls a network endpoint, including for X", async () => {
  const catalog = buildCohortOwnerCatalog([graph]);
  const decision = evaluateHistoricalSidecarRow(xRow(), {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  let fetchCalled = false;
  const validation = await validateNativeCandidate({ decision }, {
    offline: true,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("offline mode must not fetch");
    }
  });
  assert.equal(fetchCalled, false);
  assert.equal(validation.status, "accepted");
  assert.equal(validation.live, false);
  assert.equal(validation.method, "offline_current_verified_owner_plus_native_url_grammar");
});

test("journal replay and promotion candidate bytes are deterministic", () => {
  const catalog = buildCohortOwnerCatalog([graph]);
  const row = xRow();
  const decision = evaluateHistoricalSidecarRow(row, {
    catalog,
    currentPhysicalKeys: new Set(),
    sourcePath: "public/graph/s2026.json"
  });
  const candidate = {
    physicalKey: decision.physicalKey,
    blob: "a".repeat(40),
    commit: "b".repeat(40),
    committedAt: "2026-08-01T00:00:00Z",
    path: "public/graph/s2026.json",
    sourceIndex: 4,
    occurrenceCount: 1,
    row,
    decision: { ...decision, row: undefined }
  };
  const events = [
    { type: "blob_checkpoint", token: "one", candidates: [candidate] },
    {
      type: "validation_checkpoint",
      physicalKey: decision.physicalKey,
      status: "accepted",
      live: true,
      method: "official_x_oembed",
      canonicalUrl: decision.nativeIdentity.url,
      reasons: []
    }
  ];
  const first = summarizeRecoveryJournal(events);
  const second = summarizeRecoveryJournal(JSON.parse(JSON.stringify(events)));
  const input = {
    runIdentity: "run",
    baselineCommit: "head",
    historyPaths: ["public/graph/s2026.json"],
    candidates: first.candidates,
    validations: first.validations,
    audit: { scannedRows: 1 }
  };
  const firstArtifact = buildPromotionCandidateArtifact(input);
  const secondArtifact = buildPromotionCandidateArtifact({
    ...input,
    candidates: second.candidates,
    validations: second.validations
  });
  assert.equal(stableJson(firstArtifact), stableJson(secondArtifact));
  assert.equal(firstArtifact.counts.total, 1);
  assert.deepEqual(firstArtifact.counts.byCohortPlatform, { "S2026:x": 1 });
  assert.equal(firstArtifact.evidence[0]._recoveryProvenance.currentOwner.entityId, "founder-acme-alice");
});

test("extracts evidence arrays without treating compact facet rows as evidence", () => {
  const row = xRow();
  assert.deepEqual(extractEvidenceRows({ evidence: [row], needsReview: [row] }), [row]);
  assert.deepEqual(extractEvidenceRows({ batches: { S2026: { rows: [{ platform: "x", postKey: "x:1" }] } } }), []);
});

test("indexes nested repositories from current GitHub traction ledgers", () => {
  const rows = extractCurrentEvidenceRows({
    accounts: [{
      entityType: "company",
      entityId: "company-acme",
      repos: [{
        id: 123456,
        fullName: "Acme/project",
        htmlUrl: "https://github.com/Acme/project"
      }]
    }]
  }, { sourcePath: "src/lib/social/github-traction.json" });
  assert.deepEqual(rows, [{
    platform: "github",
    sourceUrl: "https://github.com/Acme/project",
    platformPostId: "Acme/project",
    platformObjectId: "123456",
    entityType: "company",
    entityId: "company-acme"
  }]);
});

test("indexes current review and quarantine identities as promotion holds", () => {
  const held = extractCurrentHeldRows({
    needsReview: [{
      platform: "x",
      candidateUrl: "https://x.com/alice/status/2070000000000000000",
      platformPostId: null
    }],
    rows: [{
      physicalRepresentation: {
        repositories: [{
          canonicalUrl: "https://github.com/Acme/project",
          repositoryId: "123456"
        }]
      }
    }]
  }, { sourcePath: "src/lib/social/github-traction-quarantine.json" });
  assert.equal(held.length, 2);
  assert.equal(held[0].platform, "x");
  assert.equal(held[1].platform, "github");

  const catalog = buildCohortOwnerCatalog([graph]);
  const row = xRow();
  const decision = evaluateHistoricalSidecarRow(row, {
    catalog,
    currentPhysicalKeys: new Set(),
    currentHeldPhysicalKeys: new Set([recoveryPhysicalKey(row)]),
    sourcePath: "public/graph/s2026.json"
  });
  assert.equal(decision.accepted, false);
  assert.ok(decision.reasons.includes("current_review_hold_not_promotion_ready"));
});

test("deduplicates historical GitHub owner/repo identities against current object IDs", () => {
  const current = {
    platform: "github",
    sourceUrl: "https://github.com/Acme/project",
    platformPostId: "Acme/project",
    platformObjectId: "123456"
  };
  const historical = {
    platform: "github",
    sourceUrl: "https://github.com/acme/project",
    platformPostId: "acme/project"
  };
  const currentKeys = physicalIdentityKeys(current);
  assert.ok(currentKeys.has("github:object:123456"));
  assert.ok(currentKeys.has(physicalSourceKey(historical)));
  assert.equal(recoveryPhysicalKey(current), recoveryPhysicalKey(historical));
});

function xRow() {
  return {
    id: "x-founder-acme-alice-2070000000000000000",
    batchSlug: "S2026",
    entityType: "founder",
    entityId: "founder-acme-alice",
    entityName: "Alice Founder",
    companySlug: "acme",
    companyName: "Acme",
    platform: "x",
    sourceUrl: "https://x.com/alice/status/2070000000000000000",
    platformPostId: "2070000000000000000",
    authorHandle: "alice",
    accountUrl: "https://x.com/alice",
    socialAccountId: "acct-founder-x",
    review_state: "verified",
    linkStatus: "verified",
    text: "Acme launch"
  };
}

function verifiedAccount(id, platform, handle, url) {
  return { id, platform, handle, url, review_state: "verified" };
}

function response(payload, { status = 200, url = "https://example.test/" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async json() {
      return payload;
    }
  };
}
