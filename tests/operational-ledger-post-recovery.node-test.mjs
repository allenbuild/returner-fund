import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPERATIONAL_LEDGER_POST_RECOVERY_JOURNAL_VERSION,
  appendValidationJournal,
  auditOperationalLedgerCandidates,
  buildCatalogOwnershipIndex,
  buildCurrentEvidenceIdentityIndex,
  extractOperationalLedgerCandidates,
  loadCurrentEvidenceSources,
  normalizeNativePostUrl,
  readValidationJournal,
  resolveCandidateOwnership,
  sha256,
  stableStringify,
  validateAnonymousNativeCandidate,
  writeRecoveryArtifactAtomic
} from "../scripts/lib/operational-ledger-post-recovery.mjs";

test("normalizes strict native post URLs across supported platforms", () => {
  assert.deepEqual(
    normalizeNativePostUrl("x", "https://twitter.com/Acme/status/2059258665668911561?s=20"),
    {
      platform: "x",
      postId: "2059258665668911561",
      identity: "x:2059258665668911561",
      canonicalUrl: "https://x.com/acme/status/2059258665668911561",
      authorKey: "acme",
      authorAccountKey: "x:acme",
      sourceUrl: "https://twitter.com/Acme/status/2059258665668911561?s=20"
    }
  );
  assert.match(
    normalizeNativePostUrl(
      "linkedin",
      "https://www.linkedin.com/posts/acme_launch-activity-7465493085486133248-a66r?trk=feed"
    ).canonicalUrl,
    /^https:\/\/www\.linkedin\.com\/posts\/acme_launch-activity-7465493085486133248-a66r$/u
  );
  assert.equal(
    normalizeNativePostUrl(
      "linkedin",
      "https://www.linkedin.com/feed/update/urn:li:activity:7465493085486133248"
    ).identity,
    "linkedin:7465493085486133248"
  );
  assert.equal(
    normalizeNativePostUrl("instagram", "https://instagram.com/reel/DX6vUbTlc6w/?igsh=abc").identity,
    "instagram:DX6vUbTlc6w"
  );
  assert.equal(
    normalizeNativePostUrl("youtube", "https://youtu.be/BdZ_pnTEjQ0?si=abc").canonicalUrl,
    "https://www.youtube.com/watch?v=BdZ_pnTEjQ0"
  );
});

test("rejects profiles, searches, host mismatches, and truncated IDs", () => {
  assert.equal(normalizeNativePostUrl("x", "https://x.com/acme"), null);
  assert.equal(normalizeNativePostUrl("linkedin", "https://linkedin.com/company/acme"), null);
  assert.equal(normalizeNativePostUrl("instagram", "https://instagram.com/acme"), null);
  assert.equal(normalizeNativePostUrl("youtube", "https://youtube.com/@acme"), null);
  assert.equal(normalizeNativePostUrl("x", "https://x.com/acme/status/20828"), null);
  assert.equal(normalizeNativePostUrl("x", "https://youtube.com/watch?v=BdZ_pnTEjQ0"), null);
});

test("extracts all four operational sections, embedded JSON, and explicit IDs deterministically", () => {
  const fixture = ledgerFixture({
    failures: [{
      id: "failure-x",
      platform: "x",
      sourceUrl: "https://x.com/acme/status/2059258665668911561",
      batchSlug: "S2026",
      entityType: "company",
      entityId: "company-acme",
      companySlug: "acme",
      accountUrl: "https://x.com/acme"
    }],
    attempts: {
      z: {
        platform: "instagram",
        accountUrl: "https://instagram.com/acme",
        batchSlug: "S2026",
        entityType: "company",
        entityId: "company-acme",
        error: "{\"shortcode\":\"DX6vUbTlc6w\",\"metrics\":{\"likes\":4}}"
      }
    },
    discoveryAttempts: [{
      id: "discovery-youtube",
      platform: "youtube",
      selected_url: "https://www.youtube.com/watch?v=BdZ_pnTEjQ0",
      batch_slug: "S2026",
      entityType: "company",
      entityId: "company-acme"
    }],
    sourceDiscoveryPaths: [{
      id: "path-linkedin",
      discovered_platform: "linkedin",
      discovered_url: "https://linkedin.com/posts/acme_launch-activity-7465493085486133248-a66r",
      batch_slug: "S2026",
      discovered_entity_type: "company",
      discovered_entity_id: "company-acme"
    }]
  });
  const first = extractOperationalLedgerCandidates(fixture);
  const second = extractOperationalLedgerCandidates(structuredClone(fixture));
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((candidate) => candidate.identity), [
    "instagram:DX6vUbTlc6w",
    "linkedin:7465493085486133248",
    "x:2059258665668911561",
    "youtube:BdZ_pnTEjQ0"
  ]);
  assert.deepEqual(first[0].metrics, { likes: 4 });
  assert.equal(first[0].provenance[0].section, "attempts");
  assert.equal(first[0].provenance[0].sourceKind, "embedded_native_id");
});

test("accepts retained v2 operational ledgers without treating retention metadata as evidence", () => {
  const candidates = extractOperationalLedgerCandidates(ledgerFixture({
    schemaVersion: "public-ingestion-operational-ledger.v2",
    retention: { schemaVersion: "public-evidence-operational-retention.v1" },
    failures: [{
      id: "failure-x-v2",
      platform: "x",
      sourceUrl: "https://x.com/acme/status/2059258665668911561",
      batchSlug: "S2026",
      entityType: "company",
      entityId: "company-acme"
    }]
  }));
  assert.deepEqual(candidates.map((candidate) => candidate.identity), [
    "x:2059258665668911561"
  ]);
});

test("does not turn metadata slugs or partial URLs into physical post identities", () => {
  const candidates = extractOperationalLedgerCandidates(ledgerFixture({
    failures: [{
      id: "failure-x-acme-status-20474809827612672",
      platform: "x",
      message: "Search mentioned https://x.com/acme/status/20828 and no usable post."
    }]
  }));
  assert.deepEqual(candidates, []);
});

test("dedupes physical identities against both evidence and needsReview in every source", () => {
  const index = buildCurrentEvidenceIdentityIndex([
    {
      path: "a.json",
      snapshot: {
        evidence: [{
          id: "x-row",
          platform: "x",
          sourceUrl: "https://x.com/acme/status/2059258665668911561"
        }],
        needsReview: []
      }
    },
    {
      path: "b.json",
      snapshot: {
        evidence: [],
        needsReview: [{
          id: "yt-row",
          platform: "youtube",
          platformPostId: "BdZ_pnTEjQ0"
        }]
      }
    }
  ]);
  assert.deepEqual([...index.keys()].sort(), [
    "x:2059258665668911561",
    "youtube:BdZ_pnTEjQ0"
  ]);
  assert.equal(index.get("youtube:BdZ_pnTEjQ0")[0].collection, "needsReview");
});

test("hydrates a split current review ledger before physical dedupe", async () => {
  const root = await mkdtemp(join(tmpdir(), "operational-ledger-split-review-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "outputs"), { recursive: true });
    const review = {
      schemaVersion: "public-ingestion-review-ledger.v1",
      needsReview: [{
        id: "review-x",
        platform: "x",
        sourceUrl: "https://x.com/acme/status/2059258665668911561"
      }],
      attributionReconciliationLedger: []
    };
    const reviewBytes = Buffer.from(JSON.stringify(review));
    const canonical = {
      evidence: [],
      reviewLedgerRef: {
        path: "outputs/review.json",
        bytes: reviewBytes.byteLength,
        sha256: sha256(reviewBytes)
      }
    };
    await writeFile(join(root, "outputs", "review.json"), reviewBytes);
    await writeFile(join(root, "src", "public.json"), JSON.stringify(canonical));
    const sources = await loadCurrentEvidenceSources(root, { paths: ["src/public.json"] });
    const index = buildCurrentEvidenceIdentityIndex(sources);
    assert.equal(index.get("x:2059258665668911561")[0].collection, "needsReview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves exact X and LinkedIn native authors to one canonical owner", () => {
  const ownership = buildCatalogOwnershipIndex(catalogFixture());
  const x = candidateFixture({
    platform: "x",
    platformPostId: "2059258665668911561",
    nativeAuthorAccountKey: "x:acme"
  });
  const linkedin = candidateFixture({
    platform: "linkedin",
    platformPostId: "7465493085486133248",
    nativeAuthorAccountKey: "linkedin:acme"
  });
  assert.equal(resolveCandidateOwnership(x, ownership).owner.entityId, "company-acme");
  assert.equal(resolveCandidateOwnership(linkedin, ownership).owner.entityId, "company-acme");
});

test("requires mapped collector account context for Instagram", () => {
  const ownership = buildCatalogOwnershipIndex(catalogFixture());
  const accepted = candidateFixture({
    platform: "instagram",
    platformPostId: "DX6vUbTlc6w",
    provenance: [provenanceFixture({ accountUrl: "https://instagram.com/acme" })]
  });
  const rejected = candidateFixture({
    platform: "instagram",
    platformPostId: "DX6vUbTlc6x",
    provenance: [provenanceFixture({ accountUrl: null })]
  });
  assert.equal(resolveCandidateOwnership(accepted, ownership).receipt.method, "mapped_collector_account_context");
  assert.deepEqual(resolveCandidateOwnership(rejected, ownership).reasons, [
    "instagram_native_owner_unavailable"
  ]);
});

test("accepts mapped YouTube oEmbed channels and rejects third-party channels", () => {
  const ownership = buildCatalogOwnershipIndex(catalogFixture());
  const candidate = candidateFixture({
    platform: "youtube",
    platformPostId: "BdZ_pnTEjQ0"
  });
  const mapped = resolveCandidateOwnership(candidate, ownership, {
    status: "verified",
    authorUrl: "https://www.youtube.com/@acme"
  });
  const thirdParty = resolveCandidateOwnership(candidate, ownership, {
    status: "verified",
    authorUrl: "https://www.youtube.com/@EvapilotsGeekCorner"
  });
  assert.equal(mapped.owner.entityId, "company-acme");
  assert.deepEqual(thirdParty.reasons, ["native_author_not_in_canonical_roster"]);
});

test("allows a verified native video embedded by an exact canonical official page", () => {
  const ownership = buildCatalogOwnershipIndex(catalogFixture());
  const candidate = candidateFixture({
    platform: "youtube",
    platformPostId: "BdZ_pnTEjQ0",
    provenance: [provenanceFixture({
      section: "sourceDiscoveryPaths",
      sourceUrl: "https://acme.example",
      reviewState: "verified",
      matchReason: "Official YC company page embedded native YouTube video BdZ_pnTEjQ0."
    })]
  });
  assert.equal(
    resolveCandidateOwnership(candidate, ownership).receipt.method,
    "canonical_official_page_embedded_native_video"
  );
});

test("audit reports exact existing, attributable, promotion-ready, and rejection counts", () => {
  const ownership = buildCatalogOwnershipIndex(catalogFixture());
  const present = candidateFixture({
    platform: "x",
    platformPostId: "2059258665668911561",
    nativeAuthorAccountKey: "x:acme",
    metrics: { views: 10 }
  });
  const promotable = candidateFixture({
    platform: "x",
    platformPostId: "2059258665668911562",
    nativeAuthorAccountKey: "x:acme",
    metrics: { views: 11 }
  });
  const noMetrics = candidateFixture({
    platform: "linkedin",
    platformPostId: "7465493085486133248",
    nativeAuthorAccountKey: "linkedin:acme",
    metrics: {}
  });
  const current = new Map([[present.identity, [{ path: "public.json", collection: "evidence", rowIndex: 0 }]]]);
  const artifact = auditOperationalLedgerCandidates({
    candidates: [present, promotable, noMetrics],
    currentEvidenceIndex: current,
    ownershipIndex: ownership
  });
  assert.equal(artifact.summary.extractedUniqueNativeIdentities, 3);
  assert.equal(artifact.summary.alreadyInCurrentEvidenceOrReview, 1);
  assert.equal(artifact.summary.trueNetNewBeforeAttribution, 2);
  assert.equal(artifact.summary.trueNetNewAttributable, 2);
  assert.equal(artifact.summary.promotionReadyEvidence, 1);
  assert.equal(artifact.evidence[0].platformPostId, "2059258665668911562");
  assert.equal(artifact.summary.rejectionReasonCounts.missing_positive_metrics_for_promotion, 1);
});

test("anonymous validator never calls a network function for LinkedIn or Instagram", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not be called");
  };
  for (const platform of ["linkedin", "instagram"]) {
    const receipt = await validateAnonymousNativeCandidate(
      candidateFixture({ platform, platformPostId: platform === "linkedin" ? "7465493085486133248" : "DX6vUbTlc6w" }),
      { fetchImpl }
    );
    assert.equal(receipt.status, "skipped");
    assert.equal(receipt.reason, "offline_only_safety_constraint");
  }
  assert.equal(calls, 0);
});

test("anonymous YouTube oEmbed receipt records only stable public owner facts", async () => {
  const receipt = await validateAnonymousNativeCandidate(
    candidateFixture({ platform: "youtube", platformPostId: "BdZ_pnTEjQ0" }),
    {
      fetchImpl: async (url, options) => {
        assert.match(url, /^https:\/\/www\.youtube\.com\/oembed\?/u);
        assert.equal(options.headers["user-agent"], "ReturnerFundOfflineAudit/1.0");
        return new Response(JSON.stringify({
          title: "Belong",
          author_name: "Evapilot's Geek Corner",
          author_url: "https://www.youtube.com/@EvapilotsGeekCorner",
          provider_name: "YouTube"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  );
  assert.deepEqual(receipt, {
    validatorVersion: "anonymous-native-oembed.v1",
    identity: "youtube:BdZ_pnTEjQ0",
    platform: "youtube",
    status: "verified",
    endpointClass: "youtube_anonymous_oembed",
    httpStatus: 200,
    authorUrl: "https://www.youtube.com/@EvapilotsGeekCorner",
    authorName: "Evapilot's Geek Corner",
    title: "Belong",
    providerName: "YouTube"
  });
  assert.equal("fetchedAt" in receipt, false);
});

test("journal resume and atomic artifact output are deterministic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "operational-ledger-recovery-test-"));
  try {
    const journal = join(directory, "journal.ndjson");
    const receipt = {
      validatorVersion: "anonymous-native-oembed.v1",
      identity: "youtube:BdZ_pnTEjQ0",
      platform: "youtube",
      status: "verified"
    };
    await appendValidationJournal(journal, {
      inputHash: "input-hash",
      identity: receipt.identity,
      receipt
    });
    const receipts = await readValidationJournal(journal, { inputHash: "input-hash" });
    assert.deepEqual(receipts.get(receipt.identity), receipt);
    const line = JSON.parse((await readFile(journal, "utf8")).trim());
    assert.equal(line.schemaVersion, OPERATIONAL_LEDGER_POST_RECOVERY_JOURNAL_VERSION);

    const output = join(directory, "candidate.json");
    const artifact = { z: 1, a: { y: 2, x: 3 } };
    const first = await writeRecoveryArtifactAtomic(output, artifact);
    const firstBytes = await readFile(output, "utf8");
    const second = await writeRecoveryArtifactAtomic(output, artifact);
    assert.equal(await readFile(output, "utf8"), firstBytes);
    assert.equal(first.sha256, second.sha256);
    assert.equal(firstBytes, `${stableStringify(artifact, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function ledgerFixture(overrides = {}) {
  return {
    schemaVersion: overrides.schemaVersion ?? "public-ingestion-operational-ledger.v1",
    ...(overrides.retention ? { retention: overrides.retention } : {}),
    failures: overrides.failures ?? [],
    attempts: overrides.attempts ?? {},
    discoveryAttempts: overrides.discoveryAttempts ?? [],
    sourceDiscoveryPaths: overrides.sourceDiscoveryPaths ?? []
  };
}

function catalogFixture() {
  return [{
    slug: "S2026",
    companies: [{
      sourceKey: "company-acme",
      name: "Acme",
      profileUrl: "https://www.ycombinator.com/companies/acme",
      websiteUrl: "https://acme.example",
      accounts: [
        { platform: "x", handle: "acme", url: "https://x.com/acme" },
        { platform: "linkedin", handle: "acme", url: "https://linkedin.com/company/acme" },
        { platform: "instagram", handle: "acme", url: "https://instagram.com/acme" },
        { platform: "youtube", handle: "@acme", url: "https://youtube.com/@acme" }
      ],
      founders: [{
        sourceKey: "founder-acme-ada",
        name: "Ada Acme",
        profileUrl: "https://www.ycombinator.com/people/ada-acme",
        accounts: [{ platform: "x", handle: "ada", url: "https://x.com/ada" }]
      }]
    }]
  }];
}

function candidateFixture(overrides = {}) {
  const platform = overrides.platform ?? "x";
  const platformPostId = overrides.platformPostId ?? "2059258665668911561";
  return {
    identity: `${platform}:${platformPostId}`,
    platform,
    platformPostId,
    canonicalUrl: overrides.canonicalUrl ?? canonicalUrl(platform, platformPostId),
    nativeAuthorKey: overrides.nativeAuthorKey ?? null,
    nativeAuthorAccountKey: overrides.nativeAuthorAccountKey ?? null,
    sourceUrl: overrides.sourceUrl ?? canonicalUrl(platform, platformPostId),
    metrics: overrides.metrics ?? {},
    occurrenceCount: overrides.occurrenceCount ?? 1,
    provenance: overrides.provenance ?? [provenanceFixture()]
  };
}

function provenanceFixture(overrides = {}) {
  return {
    section: overrides.section ?? "failures",
    recordKey: "0",
    recordId: "fixture",
    fieldPath: "sourceUrl",
    sourceKind: "native_url",
    rawValueSha256: "fixture-hash",
    context: {
      platform: overrides.platform ?? null,
      batchSlug: overrides.batchSlug ?? "S2026",
      entityType: overrides.entityType ?? "company",
      entityId: overrides.entityId ?? "company-acme",
      entityName: overrides.entityName ?? "Acme",
      companySlug: overrides.companySlug ?? "acme",
      companyName: overrides.companyName ?? "Acme",
      accountUrl: overrides.accountUrl ?? null,
      sourceUrl: overrides.sourceUrl ?? null,
      discoveredUrl: overrides.discoveredUrl ?? null,
      matchReason: overrides.matchReason ?? null,
      reviewState: overrides.reviewState ?? null,
      status: overrides.status ?? null,
      source: overrides.source ?? null
    }
  };
}

function canonicalUrl(platform, postId) {
  if (platform === "x") return `https://x.com/acme/status/${postId}`;
  if (platform === "linkedin") return `https://linkedin.com/posts/acme_launch-activity-${postId}-abcd`;
  if (platform === "instagram") return `https://instagram.com/p/${postId}`;
  return `https://www.youtube.com/watch?v=${postId}`;
}
