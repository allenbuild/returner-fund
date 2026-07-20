import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs
} from "../scripts/lib/autonomous-ingestion-plan.mjs";
import {
  mergeTargetedEvidenceSnapshots,
  physicalPostIdentity
} from "../scripts/lib/targeted-evidence-merge.mjs";

describe("targeted Top Voice evidence publication merge", () => {
  it("retains remote, local, and isolated-run rows without a lost update", () => {
    const remote = snapshot([trustedRow({ id: "remote", postId: "100" })]);
    const local = snapshot([trustedRow({ id: "local", postId: "101" })]);
    const run = snapshot([liveRow({ id: "run", postId: "102" })]);

    const merged = mergeTargetedEvidenceSnapshots([remote, local], run, { mergedAt: CHECKED_AT });

    assert.deepEqual(new Set(merged.evidence.map((row) => row.id)), new Set(["remote", "local", "run"]));
    assert.equal(merged.source.targetedMergeAudit.existingSnapshots, 2);
    assert.equal(merged.source.targetedMergeAudit.isolatedRunInputRows, 1);
    assert.equal(merged.source.targetedMergeAudit.quarantinedRows, 0);
  });

  it("deduplicates x.com and twitter.com aliases by physical status ID and keeps the freshest observation", () => {
    const old = trustedRow({
      id: "old-alias",
      postId: "200",
      sourceUrl: "https://twitter.com/voice/status/200?ref_src=twsrc",
      checkedAt: "2026-07-19T01:00:00.000Z",
      views: 5
    });
    const fresh = liveRow({ id: "fresh-alias", postId: "200", checkedAt: CHECKED_AT, views: 50 });

    const merged = mergeTargetedEvidenceSnapshots([snapshot([old])], snapshot([fresh]), { mergedAt: CHECKED_AT });

    assert.equal(merged.evidence.length, 1);
    assert.equal(merged.evidence[0].id, "fresh-alias");
    assert.equal(merged.evidence[0].metrics.views, 50);
    assert.equal(merged.source.targetedMergeAudit.duplicateRows, 1);
  });

  it("never collapses one physical post across batches or valid entity attributions", () => {
    const rows = [
      liveRow({ id: "spring-company", batchSlug: "S2026", entityId: "company-shared", postId: "300" }),
      liveRow({ id: "summer-company", batchSlug: "S26", entityId: "company-shared", postId: "300" }),
      liveRow({
        id: "spring-founder",
        batchSlug: "S2026",
        entityType: "founder",
        entityId: "founder-shared",
        postId: "300"
      })
    ];

    const merged = mergeTargetedEvidenceSnapshots([], snapshot(rows), { mergedAt: CHECKED_AT });

    assert.equal(merged.evidence.length, 3);
    assert.deepEqual(new Set(merged.evidence.map((row) => `${row.batchSlug}:${row.entityType}:${row.entityId}`)), new Set([
      "S2026:company:company-shared",
      "S26:company:company-shared",
      "S2026:founder:founder-shared"
    ]));
  });

  it("quarantines native URL and explicit ID conflicts with exact reason codes", () => {
    const conflict = liveRow({ id: "conflict", postId: "401" });
    conflict.sourceUrl = "https://x.com/voice/status/400";

    const merged = mergeTargetedEvidenceSnapshots([], snapshot([conflict]), { mergedAt: CHECKED_AT });

    assert.equal(merged.evidence.length, 0);
    assert.equal(merged.needsReview.length, 1);
    assert.equal(merged.needsReview[0].sourceEvidenceId, "conflict");
    assert.ok(merged.needsReview[0].quarantineReasons.includes("native_url_platform_post_id_conflict"));
    assert.ok(merged.needsReview[0].quarantineReasons.includes("raw_post_id_mismatch"));
    assert.equal(merged.source.targetedMergeAudit.quarantineReasonCounts.native_url_platform_post_id_conflict, 1);
  });

  it("quarantines unsupported and metricless isolated-run evidence instead of scoring it", () => {
    const unsupported = liveRow({ id: "unsupported-metric", postId: "500" });
    unsupported.metrics = { impressions: 10 };
    const metricless = liveRow({ id: "metricless", postId: "501", views: 0 });

    const merged = mergeTargetedEvidenceSnapshots([], snapshot([unsupported, metricless]), { mergedAt: CHECKED_AT });

    assert.equal(merged.evidence.length, 0);
    assert.equal(merged.needsReview.length, 2);
    const bySource = new Map(merged.needsReview.map((row) => [row.sourceEvidenceId, row.quarantineReasons]));
    assert.ok(bySource.get("unsupported-metric").includes("unsupported_visible_metric"));
    assert.ok(bySource.get("metricless").includes("missing_positive_visible_metric"));
  });

  it("quarantines an isolated row whose entity is absent from the canonical batch catalog", () => {
    const merged = mergeTargetedEvidenceSnapshots([], snapshot([liveRow({ id: "unknown-entity" })]), {
      mergedAt: CHECKED_AT,
      validateEntityAttribution: () => false
    });

    assert.equal(merged.evidence.length, 0);
    assert.deepEqual(merged.needsReview[0].quarantineReasons, ["entity_not_in_canonical_batch_catalog"]);
  });

  it("normalizes the native physical X status identity independently of URL aliases", () => {
    assert.equal(
      physicalPostIdentity({ platform: "x", sourceUrl: "https://mobile.twitter.com/voice/status/600", platformPostId: "600" }).value,
      "600"
    );
    assert.equal(
      physicalPostIdentity({ platform: "x", sourceUrl: "https://x.com/i/web/status/600", platformPostId: "600" }).value,
      "600"
    );
  });

  it("quarantines structurally framed LinkedIn company lists but preserves focused multi-attribution", () => {
    const framedLists = [
      "Here's the top DevTech startups in Y Combinator P26!\n+ Alpha - one\n+ Beta - two\n+ Gamma - three\n+ Delta - four",
      "The 11 most agent-pilled startups in Y Combinator 2026 Spring batch\n▫️ Alpha\n▫️ Beta\n▫️ Gamma\n▫️ Delta",
      "Here are some companies I recommend keeping an eye on!\n+ Alpha\n+ Beta\n+ Gamma\n+ Delta"
    ].map((text, index) => legacyLinkedInRow({
      id: `framed-list-${index}`,
      entityId: `company-list-target-${index}`,
      postId: `747000000000000000${index}`,
      text
    }));
    const focused = [
      legacyLinkedInRow({
        id: "focused-pango-founder",
        entityType: "founder",
        entityId: "founder-pango-example",
        postId: "7473269455783948288",
        text: "Pango (YC S26) is joining Y Combinator and building autonomous ecommerce operations.",
        batchSlug: "S26"
      }),
      legacyLinkedInRow({
        id: "focused-pango-company",
        entityId: "company-pango",
        postId: "7473269455783948288",
        text: "Pango (YC S26) is joining Y Combinator and building autonomous ecommerce operations.",
        batchSlug: "S26"
      }),
      legacyLinkedInRow({
        id: "numbered-product-areas",
        entityId: "company-intelligence-factory",
        postId: "7458563618201141249",
        text: "Seven robotics discussion areas for one Intelligence Factory event:\n1. Controls\n2. Sensors\n3. Safety\n4. Deployment\n5. Data\n6. Testing\n7. Reliability"
      }),
      legacyLinkedInRow({
        id: "unstructured-room-lineup",
        entityId: "company-earendil",
        postId: "7478895855991775232",
        text: "A hard-tech room with Earendil, peers, builders, and friends discussing manufacturing."
      })
    ];

    const merged = mergeTargetedEvidenceSnapshots(
      [snapshot([...framedLists, ...focused])],
      snapshot([]),
      { mergedAt: CHECKED_AT }
    );

    assert.deepEqual(merged.evidence.map((row) => row.id).sort(), focused.map((row) => row.id).sort());
    assert.equal(merged.needsReview.length, 3);
    assert.equal(merged.attributionReconciliationLedger.length, 3);
    assert.ok(merged.needsReview.every((row) =>
      row.quarantineReasons.includes("third_party_cohort_roundup_list_entry_only")
    ));
    assert.equal(
      merged.evidence.filter((row) => row.platformPostId === "7473269455783948288").length,
      2,
      "valid founder and company attributions for one focused physical post must both remain"
    );
  });

  it("retires exactly the 46 canonical Taro list-entry targets with durable target-scoped directives", async () => {
    const canonical = JSON.parse(await readFile("src/lib/social/targeted-evidence-current.json", "utf8"));
    const catalogs = await loadAutonomousCatalogs(process.cwd());
    const resolveBatchSlug = buildLegacyPublicEvidenceBatchResolver(catalogs);
    const listPostIds = new Set([
      "7470880751752781824",
      "7471229920451629056",
      "7471592225164906496",
      "7471954633335275520",
      "7472317066167885824"
    ]);
    const merged = mergeTargetedEvidenceSnapshots([canonical], snapshot([]), {
      mergedAt: CHECKED_AT,
      resolveBatchSlug
    });
    const reviews = merged.needsReview.filter((row) => listPostIds.has(row.platformPostId));
    const ledger = merged.attributionReconciliationLedger.filter((row) =>
      listPostIds.has(row.platformPostId)
    );

    assert.equal(canonical.evidence.filter((row) => listPostIds.has(row.platformPostId)).length, 46);
    assert.equal(merged.evidence.filter((row) => listPostIds.has(row.platformPostId)).length, 0);
    assert.equal(reviews.length, 46);
    assert.equal(ledger.length, 46);
    assert.equal(merged.evidence.length, 1032);
    assert.ok(merged.evidence.every((row) => ["S2026", "S26", "A16ZSR006"].includes(row.batchSlug)));
    assert.deepEqual(
      Object.fromEntries([...listPostIds].map((postId) => [
        postId,
        ledger.filter((row) => row.platformPostId === postId).length
      ])),
      {
        "7470880751752781824": 11,
        "7471229920451629056": 8,
        "7471592225164906496": 5,
        "7471954633335275520": 11,
        "7472317066167885824": 11
      }
    );
    assert.ok(ledger.every((row) =>
      row.disposition === "quarantined" &&
      row.reason === "third_party_cohort_roundup_list_entry_only" &&
      row.staleAttribution.batchSlug === "S2026" &&
      row.staleAttribution.entityType === "company" &&
      row.staleAttribution.entityId
    ));
    assert.ok(merged.evidence.some((row) => row.platformPostId === "7473269455783948288"));
    assert.ok(merged.evidence.some((row) => row.platformPostId === "7473616064967266304"));
    assert.equal(
      merged.evidence.find((row) => row.platformPostId === "7473269455783948288")?.batchSlug,
      "S26"
    );
  });
});

const CHECKED_AT = "2026-07-20T12:00:00.000Z";

function snapshot(evidence, needsReview = []) {
  return {
    source: { fetchedAt: CHECKED_AT, notes: [] },
    evidence,
    needsReview
  };
}

function trustedRow(options = {}) {
  const row = liveRow(options);
  delete row.rawVisibleText;
  return row;
}

function liveRow({
  id = "run-row",
  batchSlug = "S2026",
  entityType = "company",
  entityId = "company-example",
  companyName = "Example",
  postId = "123",
  sourceUrl = `https://x.com/voice/status/${postId}`,
  checkedAt = CHECKED_AT,
  views = 10
} = {}) {
  return {
    id,
    batchSlug,
    entityType,
    entityId,
    companyName,
    platform: "x",
    sourceUrl,
    platformPostId: postId,
    title: "Verified post",
    text: "Verified post",
    postedAt: "2026-07-19T12:00:00.000Z",
    metrics: { views },
    contributionScore: 1,
    review_state: "verified",
    linkStatus: "verified",
    rawVisibleText: JSON.stringify({
      source: "live_x_top_voice_profile",
      profile: { batchSlug, targetHandle: "voice", topVoiceMemberId: "voice" },
      post: { id: postId, author: { screen_name: "voice" } },
      counts: { views }
    }),
    first_seen_at: checkedAt,
    last_checked_at: checkedAt,
    last_updated_at: checkedAt
  };
}

function legacyLinkedInRow({
  id,
  batchSlug = "S2026",
  entityType = "company",
  entityId,
  postId,
  text
}) {
  return {
    id,
    batchSlug,
    entityType,
    entityId,
    companyName: entityId,
    platform: "linkedin",
    sourceUrl: `https://linkedin.com/posts/example_activity-${postId}-fixture`,
    platformPostId: postId,
    title: text.split("\n")[0],
    text,
    metrics: { reactions: 5 },
    review_state: "verified",
    linkStatus: "verified",
    first_seen_at: CHECKED_AT,
    last_checked_at: CHECKED_AT
  };
}
