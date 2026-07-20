import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAutonomousPublicNativeAuthorResolver,
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs,
  mergePublicEvidenceSnapshots
} from "../scripts/lib/autonomous-ingestion-plan.mjs";
import {
  assessLinkedInPrimaryPostBody,
  extractLinkedInPrimaryPostText,
  PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
  publicEvidenceAttributionText
} from "../scripts/lib/public-evidence-attribution.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("autonomous ingestion semantic attribution contracts", () => {
  it("extracts only a complete exact-activity LinkedIn primary post body", () => {
    const sourceUrl = "https://linkedin.com/posts/activity-7483487916195729409-xTVS";
    const row = {
      platform: "linkedin",
      sourceUrl,
      platformPostId: "7483487916195729409",
      title: "Nine Fives RF automation | External Author | LinkedIn",
      text: "[Skip to main content](https://linkedin.com/posts/activity-7483487916195729409-xTVS#main-content)",
      rawVisibleText: [
        `Title: Nine Fives RF automation | LinkedIn URL Source: ${sourceUrl}`,
        "Markdown Content: [Skip to main content](https://linkedin.com/)",
        "# Nine Fives RF automation",
        "[External Author](https://linkedin.com/in/external-author)",
        "[Report this post](https://linkedin.com/uas/login?guestReportContentType=POST)",
        "[Nine Fives](https://linkedin.com/company/ninefives) built new RF automation.",
        "[Noah Levy](https://linkedin.com/in/noahmslevy) and [Andrew Kurtz](https://linkedin.com/in/andrew-e-kurtz) explain the technology.",
        "[![Image: media preview](https://media.example/image.png)](https://example.com/story)",
        "[Like](https://linkedin.com/login)[Comment](https://linkedin.com/login) Share",
        "## More Relevant Posts",
        "A related post claims that Wrong Target and its founder are launching."
      ].join(" ")
    };

    const assessment = assessLinkedInPrimaryPostBody(row);
    assert.equal(assessment.verified, true);
    assert.equal(assessment.reason, "linkedin_primary_body_complete");
    assert.match(assessment.text, /Nine Fives built new RF automation/);
    assert.match(assessment.text, /Noah Levy and Andrew Kurtz/);
    assert.doesNotMatch(assessment.text, /media preview|Wrong Target|More Relevant Posts/);
    assert.equal(extractLinkedInPrimaryPostText(row), assessment.text);
    assert.match(publicEvidenceAttributionText(row), /Nine Fives built new RF automation/);

    const relatedOnly = {
      ...row,
      title: "Unrelated primary post | External Author | LinkedIn",
      text: "",
      rawVisibleText: row.rawVisibleText
        .replace(/# Nine Fives RF automation/, "# An unrelated primary post")
        .replace(/\[Nine Fives\][\s\S]*?explain the technology\./, "This primary body discusses an unrelated subject.")
    };
    assert.doesNotMatch(publicEvidenceAttributionText(relatedOnly), /Wrong Target/);
    assert.doesNotMatch(publicEvidenceAttributionText(relatedOnly), /Nine Fives/);

    assert.deepEqual(
      assessLinkedInPrimaryPostBody({
        ...row,
        rawVisibleText: row.rawVisibleText.replace(
          "URL Source: https://linkedin.com/posts/activity-7483487916195729409-xTVS",
          "URL Source: https://linkedin.com/posts/activity-7483487916195729410-xTVS"
        )
      }),
      {
        verified: false,
        reason: "linkedin_primary_body_activity_id_mismatch:expected=7483487916195729409;source=7483487916195729410",
        text: null
      }
    );
    const incompleteReader = {
      ...row,
      title: "Nine Fives (YC P26) by Noah Levy and Andrew Kurtz",
      text: "Nine Fives (YC P26) by Noah Levy and Andrew Kurtz",
      rawVisibleText: row.rawVisibleText.split("[Like](")[0]
    };
    assert.equal(
      assessLinkedInPrimaryPostBody(incompleteReader).reason,
      "linkedin_primary_body_end_boundary_missing"
    );
    assert.equal(publicEvidenceAttributionText(incompleteReader), "");

    const persistedBody = {
      ...incompleteReader,
      title: "Wrong Target (YC P26) | Native author chrome | LinkedIn",
      text: "Nine Fives built verified RF automation.",
      attributionVersion: PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
      attributionProvenance: "verified_linkedin_primary_body_v3"
    };
    assert.equal(
      publicEvidenceAttributionText(persistedBody),
      "Nine Fives built verified RF automation."
    );
    assert.doesNotMatch(publicEvidenceAttributionText(persistedBody), /Wrong Target/);
  });

  it("does not let native author chrome masquerade as company-subject text", () => {
    const mothers = {
      sourceKey: "company-9-mothers-corporation",
      name: "9 Mothers",
      slug: "9-mothers-corporation",
      websiteUrl: "https://9mothers.com",
      accounts: [],
      founders: [{
        sourceKey: "founder-9-mothers-corporation-russell-smith-1373",
        name: "Russell Smith",
        accounts: []
      }]
    };
    const playabl = {
      sourceKey: "company-playablai",
      name: "Playabl.ai",
      slug: "playablai",
      websiteUrl: "https://playabl.ai",
      accounts: [],
      founders: [{
        sourceKey: "founder-playablai-hamza-al-ali-3185206",
        name: "Hamza Al-Ali",
        accounts: []
      }]
    };
    const ownerResolution = ({ company, founder, handle }) => ({
      status: "matched",
      reason: "native_author_maps_to_unique_canonical_owner",
      author: { platform: "x", key: handle },
      owner: {
        batchSlug: "S2026",
        entityType: "founder",
        entityId: founder.sourceKey,
        entityName: founder.name,
        companySlug: company.slug,
        companyName: company.name,
        companyEntityId: company.sourceKey
      },
      company,
      founder
    });
    const resolveNativeAuthor = (row) => row.platformPostId === "2064729924116914643"
      ? ownerResolution({ company: playabl, founder: playabl.founders[0], handle: "hamzawy998" })
      : ownerResolution({ company: mothers, founder: mothers.founders[0], handle: "rhs" });
    resolveNativeAuthor.companyForRow = (row) => {
      const company = row.companySlug === "playablai" ? playabl : mothers;
      return { company };
    };

    const companySubject = ({ id, company, sourceUrl, platformPostId, title, text, rawVisibleText }) => ({
      id,
      batchSlug: "S2026",
      entityType: "company",
      entityId: company.sourceKey,
      companySlug: company.slug,
      companyName: company.name,
      platform: "x",
      sourceUrl,
      platformPostId,
      title,
      text,
      rawVisibleText,
      attributionMode: "subject",
      metrics: { views: 100 },
      review_state: "verified"
    });
    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [
        companySubject({
          id: "generic-alumni-day",
          company: mothers,
          sourceUrl: "https://x.com/rhs/status/2066558515250860517",
          platformPostId: "2066558515250860517",
          title: "YC Alumni Day",
          text: "A great day reconnecting with alumni and founders.",
          rawVisibleText: "Russell Smith · Founder at 9 Mothers · Profile badge · YC Alumni Day"
        }),
        companySubject({
          id: "explicit-9-mothers-subject",
          company: mothers,
          sourceUrl: "https://x.com/rhs/status/2070898557645660388",
          platformPostId: "2070898557645660388",
          title: "Interview about 9 Mothers and other YC P26 companies",
          text: "We discussed what 9 Mothers is building for YC P26.",
          rawVisibleText: "Russell Smith · Founder at 9 Mothers · Profile badge"
        }),
        companySubject({
          id: "explicit-playabl-subject",
          company: playabl,
          sourceUrl: "https://x.com/hamzawy998/status/2064729924116914643",
          platformPostId: "2064729924116914643",
          title: "A data point that surprised us at Playabl.ai",
          text: "Playabl.ai is studying retention in mobile games.",
          rawVisibleText: "Hamza Al-Ali · Founder at Playabl.ai · Profile badge"
        })
      ],
      needsReview: [{
        id: "redundant-stale-generic-alumni-quarantine",
        batchSlug: "S2026",
        entityType: "company",
        entityId: mothers.sourceKey,
        companySlug: mothers.slug,
        companyName: mothers.name,
        platform: "x",
        sourceUrl: "https://x.com/rhs/status/2066558515250860517",
        platformPostId: "2066558515250860517",
        review_state: "needs_review",
        attributionReconciliationDirective: {
          platform: "x",
          sourceUrl: "https://x.com/rhs/status/2066558515250860517",
          platformPostId: "2066558515250860517",
          disposition: "quarantined",
          reason: "legacy_company_subject_did_not_establish_company",
          staleAttribution: {
            batchSlug: "S2026",
            entityType: "company",
            entityId: mothers.sourceKey
          }
        }
      }]
    }], { resolveNativeAuthor });

    assert.deepEqual(
      merged.evidence.map((row) => [row.id, row.entityType, row.entityId, row.attributionMode]).sort(),
      [
        [
          "explicit-9-mothers-subject",
          "company",
          "company-9-mothers-corporation",
          "subject"
        ],
        ["explicit-playabl-subject", "company", "company-playablai", "subject"],
        [
          "generic-alumni-day",
          "founder",
          "founder-9-mothers-corporation-russell-smith-1373",
          "account_owner"
        ]
      ]
    );
    assert.deepEqual(
      merged.attributionReconciliationLedger.map((row) => [row.platformPostId, row.disposition]),
      [["2066558515250860517", "reattributed"]]
    );
    assert.equal(
      merged.attributionReconciliationLedger.filter(
        (row) => row.platformPostId === "2066558515250860517"
      ).length,
      1,
      "an exact stale-target quarantine must not survive beside its successful reattribution"
    );
  });

  it("accepts a verified third-party company subject but not an unmatched founder author", () => {
    const company = {
      sourceKey: "company-acme-robotics",
      name: "Acme Robotics",
      slug: "acme-robotics",
      websiteUrl: "https://acmerobotics.example",
      tagline: "Warehouse robots for manufacturers",
      description: "Autonomous warehouse robotics",
      accounts: [],
      founders: []
    };
    const otherCompany = {
      sourceKey: "company-beta-systems",
      name: "Beta Systems",
      slug: "beta-systems",
      websiteUrl: "https://betasystems.example",
      tagline: "Industrial software",
      description: "Software for factories",
      accounts: [],
      founders: []
    };
    const resolveNativeAuthor = (row) => {
      if (row.id === "mapped-roster-owner") {
        return {
          status: "matched",
          reason: "native_author_maps_to_unique_canonical_owner",
          author: { platform: "x", key: "alex-founder" },
          owner: {
            batchSlug: "S26",
            entityType: "founder",
            entityId: "founder-acme-robotics-alex-example",
            entityName: "Alex Example",
            companySlug: "acme-robotics",
            companyName: "Acme Robotics",
            companyEntityId: "company-acme-robotics"
          },
          company,
          founder: { sourceKey: "founder-acme-robotics-alex-example", name: "Alex Example" }
        };
      }
      if (row.id === "cross-company-subject") {
        return {
          status: "matched",
          reason: "native_author_maps_to_unique_canonical_owner",
          author: { platform: "x", key: "beta-founder" },
          owner: {
            batchSlug: "S26",
            entityType: "founder",
            entityId: "founder-beta-systems-blair-example",
            entityName: "Blair Example",
            companySlug: "beta-systems",
            companyName: "Beta Systems",
            companyEntityId: "company-beta-systems"
          },
          company: otherCompany,
          founder: { sourceKey: "founder-beta-systems-blair-example", name: "Blair Example" }
        };
      }
      return row.id === "ambiguous-company"
        ? {
          status: "ambiguous",
          reason: "native_author_maps_to_multiple_canonical_owners",
          author: { platform: "x", key: "shared-author" },
          candidates: []
        }
        : {
          status: "unmatched",
          reason: "native_author_not_in_canonical_roster",
          author: { platform: "x", key: "external-reporter" }
        };
    };
    resolveNativeAuthor.companyForRow = () => ({ company });

    const base = {
      batchSlug: "S26",
      companySlug: "acme-robotics",
      companyName: "Acme Robotics",
      platform: "x",
      title: "Acme Robotics launches its YC S26 warehouse robot",
      text: "Acme Robotics launches its YC S26 warehouse robot",
      metrics: { views: 100 },
      review_state: "verified"
    };
    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S26" },
      evidence: [
        {
          ...base,
          id: "third-party-company",
          entityType: "company",
          entityId: "company-acme-robotics",
          sourceUrl: "https://x.com/ext_reporter/status/2100000000000000001",
          platformPostId: "2100000000000000001"
        },
        {
          ...base,
          id: "unmatched-founder",
          entityType: "founder",
          entityId: "founder-acme-robotics-alex-example",
          sourceUrl: "https://x.com/ext_reporter/status/2100000000000000002",
          platformPostId: "2100000000000000002"
        },
        {
          ...base,
          id: "ambiguous-company",
          entityType: "company",
          entityId: "company-acme-robotics",
          sourceUrl: "https://x.com/shared_author/status/2100000000000000003",
          platformPostId: "2100000000000000003"
        },
        {
          ...base,
          id: "mapped-roster-owner",
          attributionMode: "account_owner",
          entityType: "company",
          entityId: "company-acme-robotics",
          sourceUrl: "https://x.com/alex_founder/status/2100000000000000004",
          platformPostId: "2100000000000000004"
        },
        {
          ...base,
          id: "cross-company-subject",
          entityType: "company",
          entityId: "company-acme-robotics",
          sourceUrl: "https://x.com/beta_founder/status/2100000000000000005",
          platformPostId: "2100000000000000005"
        }
      ]
    }], { resolveNativeAuthor });

    assert.deepEqual(
      merged.evidence.map((row) => row.id).sort(),
      ["cross-company-subject", "mapped-roster-owner", "third-party-company"]
    );
    const mappedRosterOwner = merged.evidence.find((row) => row.id === "mapped-roster-owner");
    const thirdPartyCompany = merged.evidence.find((row) => row.id === "third-party-company");
    const crossCompanySubject = merged.evidence.find((row) => row.id === "cross-company-subject");
    assert.deepEqual(
      [mappedRosterOwner.entityType, mappedRosterOwner.entityId],
      ["founder", "founder-acme-robotics-alex-example"]
    );
    assert.equal(mappedRosterOwner.attributionMode, "account_owner");
    assert.equal(mappedRosterOwner.nativeAuthorResolution.changed, true);
    assert.deepEqual(mappedRosterOwner.nativeAuthorResolution.previousAttribution, {
      batchSlug: "S26",
      entityType: "company",
      entityId: "company-acme-robotics",
      companySlug: "acme-robotics",
      companyName: "Acme Robotics"
    });
    assert.equal(thirdPartyCompany.attributionMode, "subject");
    assert.deepEqual(
      [crossCompanySubject.entityType, crossCompanySubject.entityId, crossCompanySubject.attributionMode],
      ["company", "company-acme-robotics", "subject"]
    );
    assert.deepEqual(
      merged.needsReview.map((row) => row.sourceEvidenceId).filter(Boolean).sort(),
      ["ambiguous-company", "unmatched-founder"]
    );
    assert.deepEqual(
      merged.attributionReconciliationLedger.map((row) => row.platformPostId).sort(),
      ["2100000000000000002", "2100000000000000003", "2100000000000000004"]
    );
    assert.equal(
      merged.attributionReconciliationLedger.find((row) => row.platformPostId === "2100000000000000004")?.disposition,
      "reattributed"
    );
  });

  it("suppresses a quarantine only for the exact accepted attribution target", () => {
    const physical = {
      platform: "youtube",
      sourceUrl: "https://www.youtube.com/watch?v=oY9fNCY2qI0",
      platformPostId: "oY9fNCY2qI0",
      batchSlug: "S2026"
    };
    const quarantineReview = {
      ...physical,
      id: "review-archer-false-positive",
      entityType: "company",
      entityId: "company-archer",
      companySlug: "archer",
      companyName: "Archer",
      review_state: "needs_review",
      attributionReconciliationDirective: {
        ...physical,
        disposition: "quarantined",
        reason: "semantic_false_positive",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "company",
          entityId: "company-archer"
        }
      }
    };
    const acceptedFor = (entityId) => ({
      ...physical,
      id: `accepted-${entityId}`,
      entityType: "company",
      entityId,
      companySlug: entityId.replace(/^company-/, ""),
      companyName: entityId,
      title: "Verified native video",
      metrics: { views: 10 },
      review_state: "verified"
    });

    const differentTargets = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [acceptedFor("company-correct-owner"), acceptedFor("company-valid-co-subject")],
      needsReview: [quarantineReview]
    }]);
    assert.equal(differentTargets.evidence.length, 2, "valid multi-attribution must remain target-specific");
    assert.deepEqual(
      differentTargets.attributionReconciliationLedger.map((row) => ({
        disposition: row.disposition,
        staleEntityId: row.staleAttribution.entityId
      })),
      [{ disposition: "quarantined", staleEntityId: "company-archer" }]
    );

    const exactTarget = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [acceptedFor("company-archer")],
      needsReview: [quarantineReview]
    }]);
    assert.equal(exactTarget.attributionReconciliationLedger.length, 0);
  });

  it("repairs a wrong-lane Rekursiv batch before Screenpipe reattribution and stale-target dedupe", async () => {
    const catalogs = await loadAutonomousCatalogs(root);
    const resolveBatchSlug = buildLegacyPublicEvidenceBatchResolver(catalogs);
    const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
    const physical = {
      platform: "linkedin",
      sourceUrl: "https://linkedin.com/posts/y-combinator_screenpipe-yc-s26-lets-you-record-how-you-activity-7482811226582867968-zym2",
      platformPostId: "7482811226582867968"
    };
    const staleRow = {
      ...physical,
      id: "wrong-lane-rekursiv-screenpipe-subject",
      entityType: "founder",
      entityId: "founder-rekursivai-dan-kondratyuk-3527564",
      entityName: "Dan Kondratyuk",
      companySlug: "rekursivai",
      companyName: "rekursiv.ai",
      attributionMode: "subject",
      attributionVersion: PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
      attributionProvenance: "verified_linkedin_primary_body_v3",
      title: "Untrusted native-author title chrome",
      text: "screenpipe | YC S26. Louis Beaumont founded screenpipe.",
      metrics: { reactions: 3 },
      review_state: "verified"
    };
    const staleReview = {
      ...staleRow,
      id: "wrong-lane-rekursiv-screenpipe-review",
      review_state: "needs_review",
      attributionReconciliationDirective: {
        ...physical,
        disposition: "quarantined",
        reason: "collector_founder_subject_requires_canonical_reassignment",
        staleAttribution: {
          batchSlug: "S2026",
          entityType: "founder",
          entityId: "founder-rekursivai-dan-kondratyuk-3527564"
        }
      }
    };

    const merged = mergePublicEvidenceSnapshots([{
      source: { batchSlug: "S2026" },
      evidence: [staleRow],
      needsReview: [staleReview]
    }], { resolveBatchSlug, resolveNativeAuthor });

    assert.equal(merged.evidence.length, 1);
    assert.deepEqual(
      [
        merged.evidence[0].batchSlug,
        merged.evidence[0].entityType,
        merged.evidence[0].entityId,
        merged.evidence[0].companySlug
      ],
      ["S26", "company", "company-screenpipe", "screenpipe"]
    );
    assert.equal(
      merged.needsReview[0].attributionReconciliationDirective.staleAttribution.batchSlug,
      "S26"
    );
    assert.equal(merged.attributionReconciliationLedger.length, 1);
    assert.deepEqual(
      {
        disposition: merged.attributionReconciliationLedger[0].disposition,
        stale: merged.attributionReconciliationLedger[0].staleAttribution,
        replacement: merged.attributionReconciliationLedger[0].replacementAttribution
      },
      {
        disposition: "reattributed",
        stale: {
          batchSlug: "S26",
          entityType: "founder",
          entityId: "founder-rekursivai-dan-kondratyuk-3527564",
          companySlug: "rekursivai",
          companyName: "rekursiv.ai"
        },
        replacement: {
          batchSlug: "S26",
          entityType: "company",
          entityId: "company-screenpipe",
          companySlug: "screenpipe",
          companyName: "screenpipe"
        }
      }
    );
    for (const target of [
      merged.attributionReconciliationLedger[0].staleAttribution,
      merged.attributionReconciliationLedger[0].replacementAttribution
    ]) {
      const catalog = catalogs.find((candidate) => candidate.slug === target.batchSlug);
      assert.ok(catalog, `durable catalog must resolve batch ${target.batchSlug}`);
      assert.ok(
        target.entityType === "company"
          ? catalog.companies.some((company) => company.sourceKey === target.entityId)
          : catalog.companies.some((company) =>
              company.founders.some((founder) => founder.sourceKey === target.entityId)
            ),
        `durable catalog must resolve ${target.entityType} ${target.entityId}`
      );
    }
  });

  it("replays the authoritative 77-row audit as exactly 64 accepted and 13 quarantined", async () => {
    const audit = JSON.parse(await readFile(
      join(root, "outputs/source-hunt/current-run-merge-eligible-public-attribution-audit.json"),
      "utf8"
    ));
    const catalogs = await loadAutonomousCatalogs(root);
    const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
    const snapshots = ["S2026", "S26", "A16ZSR006"].map((batchSlug) => ({
      source: { batchSlug },
      evidence: audit.candidates
        .filter((candidate) => candidate.batch === batchSlug)
        .map((candidate, index) => {
          const nativeChannel = candidate.anchors.find((anchor) => anchor.type === "native_channel")?.value;
          return {
            id: `semantic-audit-${batchSlug}-${index}`,
            batchSlug,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            companySlug: candidate.companySlug,
            companyName: candidate.companyName,
            platform: candidate.platform,
            sourceUrl: candidate.sourceUrl,
            platformPostId: candidate.platformPostId,
            title: candidate.title,
            text: candidate.title,
            rawVisibleText: candidate.title,
            metrics: candidate.platform === "hacker_news" ? { upvotes: 1 } : { views: 1 },
            review_state: "verified",
            matchReason: candidate.platform === "youtube"
              ? "Public YouTube search result audit fixture."
              : "Native attribution audit fixture.",
            attributionVersion: PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
            ...(nativeChannel
              ? {
                  youtubeChannelName: nativeChannel,
                  youtubeChannelUrl: `https://youtube.com/@audit-${candidate.platformPostId}`
                }
              : {})
          };
        })
    }));
    const merged = mergePublicEvidenceSnapshots(snapshots, { resolveNativeAuthor });
    const expectedAccepted = audit.candidates
      .filter((candidate) => candidate.verdict === "accept")
      .map((candidate) => candidate.platformPostId)
      .sort();
    const expectedRejected = audit.candidates
      .filter((candidate) => candidate.verdict !== "accept")
      .map((candidate) => candidate.platformPostId)
      .sort();

    assert.deepEqual(merged.evidence.map((row) => row.platformPostId).sort(), expectedAccepted);
    assert.deepEqual(
      merged.attributionReconciliationLedger
        .filter((entry) => entry.disposition === "quarantined")
        .map((entry) => entry.platformPostId)
        .sort(),
      expectedRejected
    );
  });

  it("resolves every native-author audit record to its exact canonical owner", async () => {
    const audit = JSON.parse(await readFile(
      join(root, "outputs/source-hunt/current-run-native-author-owner-resolution-audit.json"),
      "utf8"
    ));
    const resolveNativeAuthor = buildAutonomousPublicNativeAuthorResolver(
      await loadAutonomousCatalogs(root)
    );
    for (const record of audit.records) {
      const resolution = resolveNativeAuthor({
        platform: record.platform,
        sourceUrl: record.sourceUrl,
        authorHandle: record.nativeAuthorProof?.authorHandle,
        rawVisibleText: record.nativeAuthorProof?.authorUrl
      });
      assert.equal(resolution.status, "matched", record.physicalIdentity);
      assert.deepEqual(
        [resolution.owner.batchSlug, resolution.owner.entityType, resolution.owner.entityId],
        [
          record.resolvedAttribution.batch,
          record.resolvedAttribution.entityType,
          record.resolvedAttribution.entityId
        ],
        record.physicalIdentity
      );
    }
  });
});
