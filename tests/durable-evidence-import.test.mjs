import { describe, expect, it } from "vitest";
import { importDurableEvidence } from "../scripts/lib/durable-evidence-import.mjs";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const COMPANY_ID = "00000000-0000-0000-0000-000000000002";
const FOUNDER_ID = "00000000-0000-0000-0000-000000000003";
const SECOND_COMPANY_ID = "00000000-0000-0000-0000-000000000004";
const SPRING_BATCH_ID = "00000000-0000-0000-0000-000000000005";
const SUMMER_BATCH_ID = "00000000-0000-0000-0000-000000000006";
const SECOND_FOUNDER_ID = "00000000-0000-0000-0000-000000000007";

function reconciliationCatalog() {
  return {
    batchBySlug: new Map([
      ["S2026", SPRING_BATCH_ID],
      ["S26", SUMMER_BATCH_ID]
    ]),
    companyByBatchEntityId: new Map([
      ["S2026\u0000company-acme", COMPANY_ID],
      ["S2026\u0000company-other", SECOND_COMPANY_ID]
    ]),
    founderByBatchEntityId: new Map([
      ["S2026\u0000founder-acme-alice", FOUNDER_ID],
      ["S2026\u0000founder-acme-bob", SECOND_FOUNDER_ID],
      ["S26\u0000founder-acme-alice", FOUNDER_ID]
    ]),
    founderBatchCountById: new Map([[FOUNDER_ID, 2]])
  };
}

function publicSnapshot(batchSlug, evidence, fetchedAt = "2026-07-18T12:00:00Z") {
  return {
    source: { label: "Public collector", batchSlug, fetchedAt },
    evidence
  };
}

function publicPost({
  entityType,
  entityId,
  companySlug = "acme",
  platform = "x",
  sourceUrl = "https://x.com/acme/status/123",
  platformPostId = "123",
  metrics = { likes: 4 },
  matchReason = "Verified exact owner."
}) {
  return {
    entityType,
    entityId,
    companySlug,
    platform,
    sourceUrl,
    platformPostId,
    metrics,
    review_state: "verified",
    matchReason
  };
}

function reconciliationEntry({
  disposition = "reattributed",
  platform = "x",
  sourceUrl = "https://x.com/acme/status/123",
  platformPostId = "123",
  staleAttribution,
  replacementAttribution = null,
  reason = "Native owner resolved to the exact roster entity."
}) {
  return {
    platform,
    sourceUrl,
    platformPostId,
    disposition,
    reason,
    staleAttribution,
    ...(replacementAttribution ? { replacementAttribution } : {})
  };
}

describe("durable evidence import", () => {
  it("uses a resolver-stamped row batch when a mixed sanitized snapshot has no source batch", async () => {
    const client = new FakeSupabaseClient();
    const row = publicPost({ entityType: "company", entityId: "company-acme" });
    row.batchSlug = "S2026";
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: reconciliationCatalog(),
      publicSnapshot: {
        source: { label: "Mixed sanitized targeted evidence", fetchedAt: "2026-07-20T12:00:00Z" },
        evidence: [row]
      }
    });

    expect(result.attributions.unresolved).toBe(0);
    expect(result.attributions.stored).toBe(1);
    expect(client.table("evidence_attributions")[0]).toMatchObject({
      company_id: COMPANY_ID,
      batch_id: SPRING_BATCH_ID,
      score_eligible: true
    });
  });

  it("canonicalizes and deduplicates public rows while retaining rejected context", async () => {
    const client = new FakeSupabaseClient();
    const snapshot = {
      source: { label: "Public collector", fetchedAt: "2026-07-18T12:00:00Z" },
      evidence: [
        {
          id: "post-one",
          entityType: "company",
          entityId: "company-acme",
          companySlug: "acme",
          platform: "twitter",
          sourceUrl: "http://mobile.twitter.com/Acme/status/123/photo/1?utm_source=feed#reply",
          platformPostId: "123",
          title: "Launch",
          text: "We launched.",
          postedAt: "2026-07-17T18:00:00Z",
          metrics: { views: 100, likes: 4 },
          review_state: "verified",
          matchReason: "Official company account."
        },
        {
          id: "post-one-copy",
          entityType: "company",
          entityId: "company-acme",
          companySlug: "acme",
          platform: "x",
          sourceUrl: "https://x.com/another_handle/status/123?ref=share",
          metrics: { views: 100, likes: 4 },
          review_state: "verified",
          matchReason: "Same native post."
        },
        {
          id: "profile",
          entityType: "company",
          entityId: "company-acme",
          companySlug: "acme",
          platform: "x",
          sourceUrl: "https://x.com/Acme?utm_campaign=profile",
          metrics: { followers: 9000 },
          review_state: "verified",
          matchReason: "Official profile, context only."
        }
      ]
    };

    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { companies: new Map([["company-acme", COMPANY_ID]]) },
      snapshots: [snapshot]
    });

    expect(result).toMatchObject({
      received: 3,
      rejected: 1,
      duplicates: 1,
      stored: 2,
      readBack: 2,
      attributions: { stored: 2, duplicates: 1, unresolved: 0 },
      metricObservations: { stored: 2, duplicates: 2 }
    });

    const post = client.table("evidence_items").find((row) => row.evidence_kind === "post");
    const profile = client.table("evidence_items").find((row) => row.evidence_kind === "account");
    expect(post).toMatchObject({
      platform: "x",
      canonical_key: "x:post:123",
      platform_object_id: "123",
      canonical_url: "https://x.com/acme/status/123"
    });
    expect(profile).toMatchObject({
      canonical_url: "https://x.com/Acme",
      metadata_json: {
        url_classification: "profile",
        traction_eligible: false,
        rejection_reasons: ["profile_page"]
      }
    });
    expect(client.table("metric_observations").map((row) => row.metric_name).sort()).toEqual(["likes", "views"]);
    expect(client.table("evidence_attributions").find((row) => row.evidence_id === profile.id)).toMatchObject({
      review_state: "verified",
      risk_level: "low",
      score_eligible: false
    });

    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { companies: { "company-acme": COMPANY_ID } },
      publicSnapshot: snapshot
    });
    expect(client.table("evidence_items")).toHaveLength(2);
    expect(client.table("evidence_attributions")).toHaveLength(2);
    expect(client.table("metric_observations")).toHaveLength(2);
  });

  it("imports GitHub accounts as context and repositories as native metric evidence", async () => {
    const client = new FakeSupabaseClient();
    const snapshot = {
      source: { label: "GitHub public API", fetchedAt: "2026-07-18T13:00:00Z" },
      accounts: [
        {
          entityType: "founder",
          entityId: "founder-acme-alice",
          companySlug: "acme",
          companyName: "Acme",
          sourceUrl: "https://example.com/founders/alice?utm_source=catalog",
          githubUrl: "https://github.com/ExampleOrg",
          discoverySource: "yc_profile",
          matchReason: "GitHub URL on the founder profile.",
          login: "ExampleOrg",
          fetched: true,
          account: {
            login: "ExampleOrg",
            htmlUrl: "https://www.github.com/ExampleOrg?tab=repositories",
            followers: 50,
            publicRepos: 1
          },
          aggregate: { totalStars: 12, profileScore: 80 },
          repos: [
            {
              id: 42,
              name: "Returner",
              fullName: "ExampleOrg/Returner",
              htmlUrl: "https://www.github.com/ExampleOrg/Returner.git/tree/main?utm_campaign=launch#readme",
              description: "Evidence importer",
              stars: 12,
              forks: 3,
              watchers: 12,
              openIssues: 1,
              score: 99,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-07-18T10:00:00Z"
            }
          ]
        }
      ]
    };

    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { founderByEntityId: new Map([["founder-acme-alice", { id: FOUNDER_ID }]]) },
      githubSnapshots: [snapshot]
    });

    expect(result).toMatchObject({ received: 2, rejected: 1, duplicates: 0, stored: 2, readBack: 2 });
    expect(client.table("evidence_items")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidence_kind: "account",
        canonical_key: "github:account:exampleorg",
        canonical_url: "https://github.com/ExampleOrg?tab=repositories",
        platform_object_id: "exampleorg",
        metadata_json: expect.objectContaining({ rejection_reasons: ["profile_page"] })
      }),
      expect.objectContaining({
        evidence_kind: "repository",
        canonical_key: "github:repository:exampleorg/returner",
        canonical_url: "https://github.com/exampleorg/returner",
        platform_object_id: "exampleorg/returner"
      })
    ]));
    expect(client.table("metric_observations").map((row) => row.metric_name).sort()).toEqual([
      "forks", "open_issues", "stars", "watchers"
    ]);
    expect(client.table("evidence_attributions")).toHaveLength(2);
    expect(client.table("evidence_attributions").every((row) => row.founder_id === FOUNDER_ID)).toBe(true);
  });

  it("keeps identically keyed companies and shared founders attributed to their exact batches", async () => {
    const client = new FakeSupabaseClient();
    const snapshot = (batchSlug) => ({
      source: { label: "Public collector", batchSlug, fetchedAt: "2026-07-18T12:00:00Z" },
      evidence: [
        {
          entityType: "company",
          entityId: "company-textsidekick",
          companySlug: "textsidekick",
          platform: "x",
          sourceUrl: "https://x.com/textsidekick/status/123",
          metrics: { likes: 2 },
          review_state: "verified",
          matchReason: "Official company account."
        },
        {
          entityType: "founder",
          entityId: "founder-textsidekick-alice-1",
          companySlug: "textsidekick",
          platform: "linkedin",
          sourceUrl: "https://linkedin.com/feed/update/urn:li:activity:456",
          metrics: { likes: 3 },
          review_state: "verified",
          matchReason: "Official founder account."
        }
      ]
    });

    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: {
        batchBySlug: new Map([
          ["S2026", SPRING_BATCH_ID],
          ["S26", SUMMER_BATCH_ID]
        ]),
        companyByBatchEntityId: new Map([
          ["S2026\u0000company-textsidekick", COMPANY_ID],
          ["S26\u0000company-textsidekick", SECOND_COMPANY_ID]
        ]),
        founderByBatchEntityId: new Map([
          ["S2026\u0000founder-textsidekick-alice-1", FOUNDER_ID],
          ["S26\u0000founder-textsidekick-alice-1", FOUNDER_ID]
        ]),
        founderBatchCountById: new Map([[FOUNDER_ID, 2]]),
        // A legacy global map must not win over the exact cohort mapping.
        companyByEntityId: { "company-textsidekick": COMPANY_ID }
      },
      snapshots: [snapshot("S2026"), snapshot("S26")]
    });

    expect(result.attributions).toMatchObject({ stored: 4, duplicates: 0, unresolved: 0 });
    const attributions = client.table("evidence_attributions");
    expect(attributions.filter((row) => row.company_id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ company_id: COMPANY_ID, batch_id: SPRING_BATCH_ID }),
      expect.objectContaining({ company_id: SECOND_COMPANY_ID, batch_id: SUMMER_BATCH_ID })
    ]));
    expect(attributions.filter((row) => row.founder_id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ founder_id: FOUNDER_ID, batch_id: SPRING_BATCH_ID }),
      expect.objectContaining({ founder_id: FOUNDER_ID, batch_id: SUMMER_BATCH_ID })
    ]));
    expect(new Set(attributions.map((row) => row.id)).size).toBe(4);
  });

  it("keeps search, generic context, and conflicting IDs out of traction with reasons", async () => {
    const client = new FakeSupabaseClient();
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: { companyIdsBySlug: { acme: COMPANY_ID } },
      snapshot: {
        source: { fetchedAt: "2026-07-18T14:00:00Z" },
        evidence: [
          {
            entityType: "company",
            companySlug: "acme",
            platform: "youtube",
            sourceUrl: "https://youtube.com/results?search_query=acme&utm_source=feed",
            metrics: { views: 100 },
            review_state: "verified",
            matchReason: "Search context."
          },
          {
            entityType: "company",
            companySlug: "acme",
            platform: "web",
            sourceUrl: "https://example.com/acme?utm_campaign=launch",
            metrics: { views: 100 },
            review_state: "verified",
            matchReason: "Web context."
          },
          {
            entityType: "company",
            companySlug: "acme",
            platform: "x",
            sourceUrl: "https://x.com/acme/status/456",
            platformPostId: "123",
            metrics: { likes: 10 },
            review_state: "verified",
            matchReason: "Conflicting native ID."
          }
        ]
      }
    });

    expect(result).toMatchObject({ received: 3, rejected: 3, duplicates: 0, stored: 3, readBack: 3 });
    expect(client.table("metric_observations")).toHaveLength(0);
    expect(client.table("evidence_items").map((row) => row.metadata_json.rejection_reasons)).toEqual(
      expect.arrayContaining([
        ["search_page"],
        ["context_only_platform"],
        ["native_id_conflict"]
      ])
    );
    expect(client.table("evidence_attributions").every((row) => row.score_eligible === false)).toBe(true);
  });

  it("never writes metrics for traction evidence without a resolved batch attribution", async () => {
    const client = new FakeSupabaseClient();
    const options = {
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: {
        batchBySlug: new Map([["S26", SUMMER_BATCH_ID]]),
        companyByBatchEntityId: new Map()
      },
      snapshot: {
        source: { batchSlug: "S26", fetchedAt: "2026-07-18T14:00:00Z" },
        evidence: [{
          entityType: "company",
          entityId: "company-missing",
          platform: "x",
          sourceUrl: "https://x.com/missing/status/999",
          metrics: { likes: 10 },
          review_state: "verified",
          matchReason: "Claimed official account."
        }]
      }
    };

    const result = await importDurableEvidence(options);
    expect(result.attributions).toMatchObject({ stored: 0, unresolved: 1 });
    expect(result.rejections).toEqual([
      expect.objectContaining({ reasons: ["unresolved_attribution"] })
    ]);
    expect(client.table("metric_observations")).toHaveLength(0);

    await expect(importDurableEvidence({ ...options, requireCompleteAttribution: true }))
      .rejects.toThrow(/unresolved_attribution[\s\S]*metric observations were not written/i);
    expect(client.table("metric_observations")).toHaveLength(0);
  });

  it("retires one enumerated stale target before inserting its exact replacement and is idempotent", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    const wrong = publicSnapshot("S2026", [publicPost({
      entityType: "company",
      entityId: "company-acme"
    })]);
    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: wrong
    });

    const corrected = publicSnapshot("S2026", [publicPost({
      entityType: "founder",
      entityId: "founder-acme-alice",
      sourceUrl: "https://x.com/alice/status/123"
    })], "2026-07-18T13:00:00Z");
    const ledger = [reconciliationEntry({
      sourceUrl: "https://x.com/alice/status/123",
      staleAttribution: {
        batchSlug: "S2026",
        entityType: "company",
        entityId: "company-acme"
      },
      replacementAttribution: {
        batchSlug: "S2026",
        entityType: "founder",
        entityId: "founder-acme-alice"
      }
    })];
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: corrected,
      attributionReconciliationLedger: ledger
    });

    expect(result.attributionReconciliation).toEqual({
      received: 1,
      unique: 1,
      evidenceResolved: 1,
      evidenceMissing: 0,
      retired: 1,
      alreadyRetired: 0,
      staleNotFound: 0,
      legacyNullRetired: 0,
      legacyAmbiguousInactive: 0,
      replacementsExpected: 1
    });
    expect(client.table("evidence_items")).toHaveLength(1);
    expect(client.table("metric_observations")).toHaveLength(2);
    const stale = client.table("evidence_attributions").find((row) => row.company_id === COMPANY_ID);
    const replacement = client.table("evidence_attributions").find((row) => row.founder_id === FOUNDER_ID);
    expect(stale).toMatchObject({
      batch_id: SPRING_BATCH_ID,
      is_primary: false,
      score_eligible: false,
      review_state: "rejected",
      risk_level: "high",
      metadata_json: {
        attribution_reconciliation: {
          schema_version: 1,
          disposition: "reattributed",
          replacement: {
            entity_id: "founder-acme-alice",
            target_id: FOUNDER_ID,
            attribution_id: replacement.id
          }
        }
      }
    });
    expect(replacement).toMatchObject({
      batch_id: SPRING_BATCH_ID,
      score_eligible: true,
      review_state: "verified",
      risk_level: "low"
    });

    const rerun = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: corrected,
      attributionReconciliationLedger: ledger
    });
    expect(rerun.attributionReconciliation).toMatchObject({
      retired: 0,
      alreadyRetired: 1,
      staleNotFound: 0
    });
    expect(client.table("evidence_attributions")).toHaveLength(2);
    expect(client.table("metric_observations")).toHaveLength(2);
  });

  it("supports an explicit cross-company replacement without touching unrelated targets", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "founder",
        entityId: "founder-acme-alice",
        sourceUrl: "https://x.com/alice/status/123"
      })])
    });

    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-other",
        companySlug: "other",
        sourceUrl: "https://x.com/alice/status/123"
      })], "2026-07-18T13:00:00Z"),
      attributionReconciliationLedger: [reconciliationEntry({
        sourceUrl: "https://x.com/alice/status/123",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-acme-alice"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-other"
        }
      })]
    });

    expect(client.table("evidence_attributions").find((row) => row.founder_id === FOUNDER_ID)).toMatchObject({
      score_eligible: false,
      review_state: "rejected",
      risk_level: "high"
    });
    expect(client.table("evidence_attributions").find((row) => row.company_id === SECOND_COMPANY_ID)).toMatchObject({
      score_eligible: true,
      review_state: "verified",
      risk_level: "low"
    });
  });

  it("quarantines only the enumerated stale target while preserving physical evidence, metrics, and valid multi-attribution", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    const sourceUrl = "https://youtube.com/watch?v=Video123";
    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [
        publicPost({
          entityType: "company",
          entityId: "company-acme",
          platform: "youtube",
          sourceUrl,
          platformPostId: "Video123",
          metrics: { views: 500 }
        }),
        publicPost({
          entityType: "company",
          entityId: "company-other",
          companySlug: "other",
          platform: "youtube",
          sourceUrl,
          platformPostId: "Video123",
          metrics: { views: 500 }
        })
      ])
    });

    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [], "2026-07-18T13:00:00Z"),
      attributionReconciliationLedger: [reconciliationEntry({
        disposition: "quarantined",
        platform: "youtube",
        sourceUrl,
        platformPostId: "Video123",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        },
        reason: "Generic-search result resolved to a different native subject."
      })]
    });

    expect(result.attributionReconciliation).toMatchObject({
      evidenceResolved: 1,
      retired: 1,
      replacementsExpected: 0
    });
    expect(client.table("evidence_items")).toHaveLength(1);
    expect(client.table("metric_observations")).toHaveLength(1);
    expect(client.table("evidence_attributions").find((row) => row.company_id === COMPANY_ID)).toMatchObject({
      score_eligible: false,
      review_state: "rejected",
      risk_level: "high"
    });
    expect(client.table("evidence_attributions").find((row) => row.company_id === SECOND_COMPANY_ID)).toMatchObject({
      score_eligible: true,
      review_state: "verified",
      risk_level: "low"
    });
  });

  it("treats a quarantine for a never-imported physical item as an idempotent no-op", async () => {
    const client = new FakeSupabaseClient();
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: reconciliationCatalog(),
      publicSnapshot: publicSnapshot("S2026", []),
      attributionReconciliationLedger: [reconciliationEntry({
        disposition: "quarantined",
        platform: "youtube",
        sourceUrl: "https://youtube.com/watch?v=NeverStored",
        platformPostId: "NeverStored",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        }
      })]
    });
    expect(result.attributionReconciliation).toMatchObject({
      received: 1,
      evidenceResolved: 0,
      evidenceMissing: 1,
      retired: 0,
      staleNotFound: 1
    });
    expect(client.table("evidence_items")).toHaveLength(0);
    expect(client.table("evidence_attributions")).toHaveLength(0);
    expect(client.table("metric_observations")).toHaveLength(0);
  });

  it("skips a quarantined target that no longer exists in the current batch catalog", async () => {
    const client = new FakeSupabaseClient();
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: reconciliationCatalog(),
      publicSnapshot: publicSnapshot("S26", []),
      attributionReconciliationLedger: [reconciliationEntry({
        disposition: "quarantined",
        sourceUrl: "https://x.com/ishan/status/999",
        platformPostId: "999",
        staleAttribution: {
          batchSlug: "S26",
          entityType: "founder",
          entityId: "founder-shepherd-3-ishan-ramrakhiani-2605131"
        },
        reason: "Historical attribution points at an entity removed from the current roster."
      })]
    });

    expect(result.attributionReconciliation).toMatchObject({
      received: 1,
      unique: 0,
      evidenceResolved: 0,
      evidenceMissing: 0,
      retired: 0,
      skippedUnresolved: [{
        ordinal: 1,
        disposition: "quarantined",
        reason: "stale_entity_not_in_current_catalog",
        entityId: "founder-shepherd-3-ishan-ramrakhiani-2605131",
        batchSlug: "S26"
      }]
    });
    expect(client.calls).toHaveLength(0);
  });

  it("still fails closed when a reattributed stale target is absent from the current catalog", async () => {
    await expect(importDurableEvidence({
      client: new FakeSupabaseClient(),
      ingestionRunId: RUN_ID,
      catalogMaps: reconciliationCatalog(),
      publicSnapshot: publicSnapshot("S26", []),
      attributionReconciliationLedger: [reconciliationEntry({
        sourceUrl: "https://x.com/ishan/status/999",
        platformPostId: "999",
        staleAttribution: {
          batchSlug: "S26",
          entityType: "founder",
          entityId: "founder-shepherd-3-ishan-ramrakhiani-2605131"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-acme-alice"
        }
      })]
    })).rejects.toThrow(/did not resolve entity founder-shepherd-3-ishan-ramrakhiani-2605131 in batch S26/);
  });

  it("skips a missing stale rename target when its verified replacement is present", async () => {
    const client = new FakeSupabaseClient();
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps: reconciliationCatalog(),
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme"
      })]),
      attributionReconciliationLedger: [reconciliationEntry({
        staleAttribution: {
          batchSlug: "S26",
          entityType: "company",
          entityId: "company-renamed-away"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        }
      })]
    });

    expect(result.attributionReconciliation).toMatchObject({
      received: 1,
      unique: 0,
      evidenceResolved: 0,
      evidenceMissing: 0,
      retired: 0,
      skippedUnresolved: [{
        ordinal: 1,
        disposition: "reattributed",
        reason: "stale_entity_not_in_current_catalog",
        entityId: "company-renamed-away",
        batchSlug: "S26"
      }]
    });
    expect(client.table("evidence_items")).toHaveLength(1);
    expect(client.table("evidence_attributions")).toHaveLength(1);
    expect(client.table("evidence_attributions")[0]).toMatchObject({
      company_id: COMPANY_ID,
      batch_id: SPRING_BATCH_ID
    });
    expect(client.table("metric_observations")).toHaveLength(1);
  });

  it("treats a historical rename that resolves to the replacement durable row as an idempotent no-op", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    catalogMaps.companyByBatchEntityId.set("S26\u0000company-blueprints", COMPANY_ID);
    catalogMaps.companyByBatchEntityId.set("S26\u0000company-hoplite", COMPANY_ID);
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S26", [publicPost({
        entityType: "company",
        entityId: "company-hoplite",
        companySlug: "hoplite",
        platform: "github",
        sourceUrl: "https://github.com/CarbonCopyInc/carboncopy-mcp",
        platformPostId: "CarbonCopyInc/carboncopy-mcp",
        metrics: { stars: 5 }
      })]),
      attributionReconciliationLedger: [reconciliationEntry({
        platform: "github",
        sourceUrl: "https://github.com/CarbonCopyInc/carboncopy-mcp",
        platformPostId: "CarbonCopyInc/carboncopy-mcp",
        staleAttribution: {
          batchSlug: "S26",
          entityType: "company",
          entityId: "company-blueprints"
        },
        replacementAttribution: {
          batchSlug: "S26",
          entityType: "company",
          entityId: "company-hoplite"
        },
        reason: "Historical company rename preserves one durable catalog row."
      })]
    });

    expect(result.attributionReconciliation).toMatchObject({
      received: 1,
      unique: 0,
      retired: 0,
      skippedUnresolved: [{
        ordinal: 1,
        disposition: "reattributed",
        reason: "stale_target_resolves_to_replacement",
        entityId: "company-blueprints",
        batchSlug: "S26"
      }]
    });
    expect(client.table("evidence_attributions")).toHaveLength(1);
    expect(client.table("evidence_attributions")[0]).toMatchObject({
      company_id: COMPANY_ID,
      batch_id: SUMMER_BATCH_ID,
      review_state: "verified"
    });
  });

  it("drops a stale duplicate physical item when an exact distinct replacement is present", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    const sourceUrl = "https://github.com/acme/acme-sdk";
    const stale = publicPost({
      entityType: "company",
      entityId: "company-acme",
      platform: "github",
      sourceUrl,
      platformPostId: "acme/acme-sdk"
    });
    const replacement = publicPost({
      entityType: "company",
      entityId: "company-other",
      platform: "github",
      sourceUrl,
      platformPostId: "acme/acme-sdk"
    });
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [stale, replacement]),
      attributionReconciliationLedger: [reconciliationEntry({
        platform: "github",
        sourceUrl,
        platformPostId: "acme/acme-sdk",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-other"
        }
      })]
    });

    expect(result.attributions.stored).toBe(1);
    expect(client.table("evidence_attributions")).toHaveLength(1);
    expect(client.table("evidence_attributions")[0]).toMatchObject({
      company_id: SECOND_COMPANY_ID,
      batch_id: SPRING_BATCH_ID,
      review_state: "verified"
    });
  });

  it("retires an exact batch target without changing another cohort attribution for the same physical row", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    const row = publicPost({
      entityType: "founder",
      entityId: "founder-acme-alice",
      sourceUrl: "https://x.com/alice/status/123"
    });
    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshots: [
        publicSnapshot("S2026", [row]),
        publicSnapshot("S26", [row])
      ]
    });

    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [], "2026-07-18T13:00:00Z"),
      attributionReconciliationLedger: [reconciliationEntry({
        disposition: "quarantined",
        sourceUrl: "https://x.com/alice/status/123",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-acme-alice"
        }
      })]
    });

    const attributions = client.table("evidence_attributions").filter((item) => item.founder_id === FOUNDER_ID);
    expect(attributions).toHaveLength(2);
    expect(attributions.find((item) => item.batch_id === SPRING_BATCH_ID)).toMatchObject({
      score_eligible: false,
      review_state: "rejected"
    });
    expect(attributions.find((item) => item.batch_id === SUMMER_BATCH_ID)).toMatchObject({
      score_eligible: true,
      review_state: "verified",
      risk_level: "low"
    });
  });

  it("reconciles safe legacy null-batch targets and fails closed for an active ambiguous shared founder", async () => {
    const catalogMaps = reconciliationCatalog();
    const companyClient = new FakeSupabaseClient();
    await importDurableEvidence({
      client: companyClient,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme"
      })])
    });
    companyClient.table("evidence_attributions")[0].batch_id = null;
    const companyResult = await importDurableEvidence({
      client: companyClient,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", []),
      attributionReconciliationLedger: [reconciliationEntry({
        disposition: "quarantined",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        }
      })]
    });
    expect(companyResult.attributionReconciliation).toMatchObject({
      retired: 1,
      legacyNullRetired: 1,
      legacyAmbiguousInactive: 0
    });
    expect(companyClient.table("evidence_attributions")[0]).toMatchObject({
      batch_id: null,
      score_eligible: false,
      review_state: "rejected",
      risk_level: "high"
    });

    const sharedFounderClient = new FakeSupabaseClient();
    await importDurableEvidence({
      client: sharedFounderClient,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "founder",
        entityId: "founder-acme-alice",
        sourceUrl: "https://x.com/alice/status/123"
      })])
    });
    const legacyFounder = sharedFounderClient.table("evidence_attributions")[0];
    Object.assign(legacyFounder, {
      batch_id: null,
      score_eligible: false,
      review_state: "needs_review",
      risk_level: "medium"
    });
    const sharedLedger = [reconciliationEntry({
      disposition: "quarantined",
      sourceUrl: "https://x.com/alice/status/123",
      staleAttribution: {
        batchSlug: "S2026",
        entityType: "founder",
        entityId: "founder-acme-alice"
      }
    })];
    const inactiveResult = await importDurableEvidence({
      client: sharedFounderClient,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", []),
      attributionReconciliationLedger: sharedLedger
    });
    expect(inactiveResult.attributionReconciliation).toMatchObject({
      retired: 0,
      legacyAmbiguousInactive: 1
    });
    expect(legacyFounder).toMatchObject({
      batch_id: null,
      score_eligible: false,
      review_state: "needs_review",
      risk_level: "medium"
    });

    Object.assign(legacyFounder, {
      score_eligible: true,
      review_state: "verified",
      risk_level: "low"
    });
    await expect(importDurableEvidence({
      client: sharedFounderClient,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", []),
      attributionReconciliationLedger: sharedLedger
    })).rejects.toThrow(/active legacy null-batch shared-founder attribution/i);
  });

  it("does not retire durable attribution merely because a later snapshot omits the row", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme"
      })])
    });
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [], "2026-07-18T13:00:00Z")
    });
    expect(result.attributionReconciliation).toMatchObject({ received: 0, retired: 0 });
    expect(client.table("evidence_attributions")).toEqual([
      expect.objectContaining({
        company_id: COMPANY_ID,
        score_eligible: true,
        review_state: "verified"
      })
    ]);
  });

  it("rejects a ledger whose stale row remains or whose replacement is absent before reconciliation mutation", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    const baseLedger = reconciliationEntry({
      staleAttribution: {
        batchSlug: "S2026",
        entityType: "company",
        entityId: "company-acme"
      },
      replacementAttribution: {
        batchSlug: "S2026",
        entityType: "founder",
        entityId: "founder-acme-alice"
      }
    });
    await expect(importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme"
      })]),
      attributionReconciliationLedger: [baseLedger]
    })).rejects.toThrow(/stale attribution is still present in sanitized snapshots/i);
    expect(client.calls).toHaveLength(0);

    await expect(importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "founder",
        entityId: "founder-acme-bob",
        sourceUrl: "https://x.com/bob/status/123"
      })]),
      attributionReconciliationLedger: [baseLedger]
    })).rejects.toThrow(/replacement attribution is absent from sanitized snapshots/i);
    expect(client.calls).toHaveLength(0);

    await expect(importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", []),
      attributionReconciliationLedger: [{
        ...baseLedger,
        platformPostId: "999"
      }]
    })).rejects.toThrow(/native id conflict: url=123; explicit=999/i);
    expect(client.calls).toHaveLength(0);
  });

  it("matches reconciliation candidates by durable identity across historical source-key aliases", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    catalogMaps.founderByBatchEntityId.set(
      "S2026\u0000founder-acme-alice-historical",
      FOUNDER_ID
    );
    catalogMaps.founderByBatchEntityId.set(
      "S2026\u0000founder-acme-alice-current",
      FOUNDER_ID
    );
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "founder",
        entityId: "founder-acme-alice-current"
      })]),
      attributionReconciliationLedger: [reconciliationEntry({
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-acme-alice-historical"
        }
      })]
    });

    expect(result.attributionReconciliation).toMatchObject({
      received: 1,
      unique: 1,
      replacementsExpected: 1
    });
    expect(client.table("evidence_attributions")).toContainEqual(
      expect.objectContaining({ founder_id: FOUNDER_ID, review_state: "verified" })
    );
  });

  it("still detects a stale durable target when its current source key differs", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    catalogMaps.companyByBatchEntityId.set(
      "S2026\u0000company-acme-historical",
      COMPANY_ID
    );
    catalogMaps.companyByBatchEntityId.set(
      "S2026\u0000company-acme-current",
      COMPANY_ID
    );

    await expect(importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme-current"
      })]),
      attributionReconciliationLedger: [reconciliationEntry({
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme-historical"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-acme-alice"
        }
      })]
    })).rejects.toThrow(/stale attribution is still present in sanitized snapshots/i);
    expect(client.calls).toHaveLength(0);
  });

  it("drops a stale verified row explicitly quarantined by the reconciliation ledger", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    const stale = publicPost({
      entityType: "company",
      entityId: "company-acme"
    });
    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [stale]),
      attributionReconciliationLedger: [reconciliationEntry({
        disposition: "quarantined",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        },
        reason: "Duplicate physical post was quarantined."
      })]
    });

    expect(result).toMatchObject({
      received: 1,
      stored: 0,
      attributions: { stored: 0, unresolved: 0 },
      attributionReconciliation: {
        received: 1,
        unique: 1,
        replacementsExpected: 0
      }
    });
    expect(client.table("evidence_items")).toHaveLength(0);
  });

  it("treats an absent historical reattribution as a no-op without retiring by omission", async () => {
    const client = new FakeSupabaseClient();
    const catalogMaps = reconciliationCatalog();
    await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme"
      })])
    });

    const result = await importDurableEvidence({
      client,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", []),
      attributionReconciliationLedger: [reconciliationEntry({
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-acme"
        },
        replacementAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-acme-alice"
        }
      })]
    });

    expect(result.attributionReconciliation).toMatchObject({
      received: 1,
      unique: 0,
      retired: 0,
      skippedUnresolved: [{
        reason: "historical_reattribution_not_present_in_current_snapshot"
      }]
    });
    expect(client.table("evidence_attributions")[0]).toMatchObject({
      company_id: COMPANY_ID,
      score_eligible: true,
      review_state: "verified"
    });
  });

  it("fails closed on retirement and reconciliation read-back errors before appending new metrics", async () => {
    const catalogMaps = reconciliationCatalog();
    const corrected = publicSnapshot("S2026", [publicPost({
      entityType: "founder",
      entityId: "founder-acme-alice",
      sourceUrl: "https://x.com/alice/status/123"
    })], "2026-07-18T13:00:00Z");
    const ledger = [reconciliationEntry({
      sourceUrl: "https://x.com/alice/status/123",
      staleAttribution: {
        batchSlug: "S2026",
        entityType: "company",
        entityId: "company-acme"
      },
      replacementAttribution: {
        batchSlug: "S2026",
        entityType: "founder",
        entityId: "founder-acme-alice"
      }
    })];

    const updateFailure = new FakeSupabaseClient();
    await importDurableEvidence({
      client: updateFailure,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme"
      })])
    });
    updateFailure.failure = { table: "evidence_attributions", operation: "update" };
    updateFailure.failureMatches = 0;
    await expect(importDurableEvidence({
      client: updateFailure,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: corrected,
      attributionReconciliationLedger: ledger
    })).rejects.toThrow(/evidence_attributions denied \(42501\)/i);
    expect(updateFailure.table("metric_observations")).toHaveLength(1);
    expect(updateFailure.table("evidence_attributions")).toHaveLength(1);
    expect(updateFailure.table("evidence_attributions")[0].score_eligible).toBe(true);

    const readBackFailure = new FakeSupabaseClient();
    await importDurableEvidence({
      client: readBackFailure,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: publicSnapshot("S2026", [publicPost({
        entityType: "company",
        entityId: "company-acme"
      })])
    });
    readBackFailure.failure = {
      table: "evidence_attributions",
      operation: "select",
      occurrence: 2
    };
    readBackFailure.failureMatches = 0;
    await expect(importDurableEvidence({
      client: readBackFailure,
      ingestionRunId: RUN_ID,
      catalogMaps,
      publicSnapshot: corrected,
      attributionReconciliationLedger: ledger
    })).rejects.toThrow(/read back reconciled evidence_attributions.*denied/i);
    expect(readBackFailure.table("metric_observations")).toHaveLength(1);
    expect(readBackFailure.table("evidence_attributions")).toHaveLength(2);
    expect(readBackFailure.table("evidence_attributions").find((row) => row.company_id === COMPANY_ID)).toMatchObject({
      score_eligible: false,
      review_state: "rejected"
    });
  });

  it.each(["evidence_items", "evidence_attributions", "metric_observations"])(
    "surfaces every %s database error",
    async (failedTable) => {
      const client = new FakeSupabaseClient(failedTable);
      const promise = importDurableEvidence({
        client,
        ingestionRunId: RUN_ID,
        catalogMaps: { companies: { "company-acme": COMPANY_ID } },
        snapshots: [{
          source: { fetchedAt: "2026-07-18T12:00:00Z" },
          evidence: [{
            entityType: "company",
            entityId: "company-acme",
            platform: "x",
            sourceUrl: "https://x.com/acme/status/123",
            metrics: { likes: 1 },
            review_state: "verified",
            matchReason: "Verified account."
          }]
        }]
      });

      await expect(promise).rejects.toThrow(`${failedTable} denied (42501)`);
    }
  );
});

class FakeSupabaseClient {
  constructor(failure = null) {
    this.failure = typeof failure === "string" ? { table: failure } : failure;
    this.failureMatches = 0;
    this.tables = new Map([
      ["evidence_items", []],
      ["evidence_attributions", []],
      ["metric_observations", []]
    ]);
    this.calls = [];
    this.nextId = 1;
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  table(name) {
    return this.tables.get(name);
  }

  execute(query) {
    this.calls.push({
      table: query.table,
      operation: query.operation,
      values: structuredClone(query.values),
      options: structuredClone(query.options),
      select: query.selected,
      filters: structuredClone(query.filters)
    });
    const matchesFailure =
      query.table === this.failure?.table &&
      (!this.failure.operation || query.operation === this.failure.operation);
    if (matchesFailure) this.failureMatches += 1;
    if (matchesFailure && (!this.failure.occurrence || this.failureMatches === this.failure.occurrence)) {
      return { data: null, error: { message: `${query.table} denied`, code: "42501" } };
    }

    const table = this.table(query.table);
    const matchesFilters = (row) => query.filters.every((filter) =>
      filter.type === "eq"
        ? row[filter.column] === filter.value
        : filter.values.includes(row[filter.column])
    );
    if (query.operation === "select") {
      const selected = table.filter(matchesFilters);
      return {
        data: query.selected ? selected.map((row) => selectRow(row, query.selected)) : structuredClone(selected),
        error: null
      };
    }
    if (query.operation === "update") {
      const updated = [];
      for (const row of table.filter(matchesFilters)) {
        Object.assign(row, structuredClone(query.values));
        updated.push(row);
      }
      return {
        data: query.selected ? updated.map((row) => selectRow(row, query.selected)) : structuredClone(updated),
        error: null
      };
    }
    const rows = Array.isArray(query.values) ? query.values : [query.values];
    const conflicts = String(query.options?.onConflict ?? "id").split(",");
    const returned = [];
    for (const value of rows) {
      const existing = table.find((row) => conflicts.every((key) => row[key] === value[key]));
      if (existing && query.options?.ignoreDuplicates) continue;
      if (existing) {
        Object.assign(existing, structuredClone(value));
        returned.push(existing);
      } else {
        const row = { id: value.id ?? fakeUuid(this.nextId++), ...structuredClone(value) };
        table.push(row);
        returned.push(row);
      }
    }
    return { data: query.selected ? returned.map((row) => selectRow(row, query.selected)) : returned, error: null };
  }
}

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.operation = null;
    this.values = null;
    this.options = null;
    this.selected = null;
    this.filters = [];
  }

  upsert(values, options) {
    this.operation = "upsert";
    this.values = values;
    this.options = options;
    return this;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  select(columns) {
    this.operation ??= "select";
    this.selected = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: "eq", column, value });
    return this;
  }

  in(column, values) {
    this.filters.push({ type: "in", column, values: [...values] });
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.client.execute(this)).then(resolve, reject);
  }
}

function selectRow(row, columns) {
  return Object.fromEntries(columns.split(",").map((column) => column.trim()).map((column) => [column, row[column]]));
}

function fakeUuid(value) {
  return `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
}
