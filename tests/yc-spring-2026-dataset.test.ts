import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalPostKey,
  contextEvidenceContentUrl,
  dedupePublishedContextEvidence
} from "@/lib/graph/dedupe";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { evidenceBelongsToEntityScope } from "@/lib/graph/evidence-stats";
import { isCrediblyPublishedToday } from "@/lib/graph/native-publication-date";
import { scoringEligibility } from "@/lib/graph/traction-scoring";
import {
  evidenceMatchesBatchScope,
  handleFromUrl,
  hasExplicitLinkedInCommentClaim,
  ycSummer2026GraphDataset,
  ycSpring2026GraphDataset
} from "@/lib/graph/yc-spring-2026-dataset";
import type { SocialAccountSummary } from "@/lib/graph/types";
import springGithubSnapshot from "@/lib/social/github-traction.json";
import summerGithubSnapshot from "@/lib/social/github-traction-summer-2026.json";
import summerCompaniesSnapshot from "@/lib/yc/summer-2026-companies.json";

const targetedEvidenceSnapshot = JSON.parse(
  readFileSync(join(process.cwd(), "src/lib/social/targeted-evidence-current.json"), "utf8")
) as {
  evidence: Array<{
    id: string;
    sourceUrl: string;
    postedAt?: string | null;
    publishedAtPrecision?: string | null;
    first_seen_at?: string | null;
    last_checked_at?: string | null;
    contributionScore?: number;
    rawVisibleText: string;
  }>;
  needsReview: Array<{
    sourceEvidenceId: string;
    candidateUrl: string;
    review_state: string;
    attributionReconciliationDirective?: {
      disposition?: string;
      reason?: string;
      staleAttribution?: {
        batchSlug?: string;
        entityId?: string;
      };
    };
  }>;
};

const githubQuarantineSnapshot = JSON.parse(
  readFileSync(join(process.cwd(), "src/lib/social/github-traction-quarantine.json"), "utf8")
) as {
  source: {
    scoringEligible: false;
    rowCount: number;
  };
  rows: Array<{
    batchSlug: string;
    category: string;
    currentCanonicality: string;
    scoringEligible: false;
    physicalRepresentation: {
      status: string;
    };
    legacyRow: {
      entityId?: string;
      companySlug?: string;
      login?: string;
      repo?: string | null;
      repos?: unknown[];
    };
  }>;
};

const EXPLICIT_S2026_HACKER_NEWS_POST_IDS = [
  "46868675",
  "47950283",
  "45449787",
  "45291644",
  "45968265",
  "43880813",
  "45505190",
  "45929327",
  "46852255",
  "45118425",
  "45090966",
  "46906052",
  "46675614",
  "45773036",
  "45529555",
  "48674312",
  "47169764",
  "45534173",
  "48672548",
  "48677220",
  "46898157",
  "46889163"
] as const;

const VERIFIED_S26_LINKEDIN_POST_IDS = [
  "7478115276312428544",
  "7473272593333166082",
  "7482811226582867968",
  "7474910574120787968",
  "7481966021390647296",
  "7476759966184488960"
] as const;

describe("YC Summer 2026 official snapshot", () => {
  it("publishes more than 40,000 unique content rows without RSS/web alias inflation", () => {
    const minimumCounts: Record<string, number> = {
      S2026: 20_000,
      S26: 13_000,
      A16ZSR006: 9_000
    };
    let total = 0;

    for (const [batchSlug, minimumCount] of Object.entries(minimumCounts)) {
      const batchEvidence = ycSpring2026GraphDataset.evidence.filter(
        (item) => !item.batchSlug || item.batchSlug.toUpperCase() === batchSlug
      );
      const published = dedupePublishedContextEvidence(batchEvidence, batchSlug);
      const companyIds = new Set(
        ycSpring2026GraphDataset.companies
          .filter((company) => company.batchSlug === batchSlug)
          .map((company) => company.id)
      );
      const founderIds = new Set(
        ycSpring2026GraphDataset.founders
          .filter((founder) => founder.batchSlug === batchSlug)
          .map((founder) => founder.id)
      );
      const entityIds = new Set([...companyIds, ...founderIds]);
      const attributable = published.filter((item) =>
        evidenceBelongsToEntityScope(item, companyIds, entityIds)
      );
      const contextKeys = attributable.flatMap((item) => {
        if (item.platform !== "web" && item.platform !== "rss") return [];
        const contentUrl = contextEvidenceContentUrl(item.platform, item.platformPostId);
        const ownerCompanyId = item.attachedCompanyId ||
          (item.entityType === "company" ? item.entityId : null);
        return contentUrl && ownerCompanyId
          ? [`${item.batchSlug}:${ownerCompanyId}:${contentUrl}`]
          : [];
      });

      expect(attributable.length).toBeGreaterThanOrEqual(minimumCount);
      expect(new Set(contextKeys).size).toBe(contextKeys.length);
      total += attributable.length;
    }

    expect(total).toBeGreaterThanOrEqual(40_000);
    expect(total).toBeLessThanOrEqual(70_000);
  });

  it("normalizes structured public trust receipts before graph materialization", () => {
    const evidence = ycSpring2026GraphDataset.evidence.find(
      (item) => item.platform === "youtube" && item.platformPostId === "MLEMTnvl5c4"
    );

    expect(evidence).toBeDefined();
    expect(typeof evidence?.rawVisibleText).toBe("string");
    expect(JSON.parse(evidence?.rawVisibleText ?? "null")).toEqual(
      expect.objectContaining({
        source: "youtube-native-recovery.v1",
        oembed: expect.objectContaining({
          authorName: "Ploy"
        })
      })
    );
  });

  it("uses GitHub repository creation—not a later refresh or push—as publication time", () => {
    const evidence = ycSummer2026GraphDataset.evidence.find(
      (item) =>
        item.platform === "github" &&
        item.sourceUrl === "https://github.com/screenpipe/screenpipe"
    );
    const repository = summerGithubSnapshot.accounts
      .flatMap((account) => account.repos ?? [])
      .find((repo) => {
        const latestActivity = [repo.updatedAt, repo.pushedAt]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1);
        return (
          repo.htmlUrl === evidence?.sourceUrl &&
          String(repo.id) === evidence?.platformObjectId &&
          latestActivity === evidence?.last_updated_at
        );
      });

    expect(repository).toBeDefined();
    expect(repository?.createdAt).not.toBe(repository?.pushedAt);
    const latestRepositoryActivity = [repository?.updatedAt, repository?.pushedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    expect(evidence).toEqual(
      expect.objectContaining({
        id: "evidence-github-repo-company-screenpipe-screenpipe-screenpipe",
        postedAt: repository?.createdAt,
        publishedAtPrecision: "exact",
        observedAt: summerGithubSnapshot.source.fetchedAt,
        last_updated_at: latestRepositoryActivity
      })
    );
    expect(JSON.parse(evidence?.rawVisibleText ?? "null")).toEqual(
      expect.objectContaining({
        repositoryTimestamps: {
          createdAt: repository?.createdAt,
          updatedAt: repository?.updatedAt,
          pushedAt: repository?.pushedAt,
          observedAt: summerGithubSnapshot.source.fetchedAt
        }
      })
    );
  });

  it("reconciles duplicate and targeted GitHub rows to native repository creation", () => {
    const springCases = [
      "https://github.com/superset-sh/superset",
      "https://github.com/MisoLabsAI/MisoTTS"
    ];
    for (const sourceUrl of springCases) {
      const repository = springGithubSnapshot.accounts
        .flatMap((account) => account.repos ?? [])
        .find((repo) => repo.htmlUrl.toLowerCase() === sourceUrl.toLowerCase());
      const evidence = ycSpring2026GraphDataset.evidence.find(
        (item) => item.sourceUrl.toLowerCase() === sourceUrl.toLowerCase()
      );

      expect(repository?.createdAt).toBeTruthy();
      expect(evidence).toEqual(
        expect.objectContaining({
          postedAt: repository?.createdAt,
          publishedAtPrecision: "exact",
          platformObjectId: String(repository?.id)
        })
      );
      expect(JSON.parse(evidence?.rawVisibleText ?? "null")).toEqual(
        expect.objectContaining({
          repositoryTimestamps: expect.objectContaining({
            createdAt: repository?.createdAt,
            observedAt: expect.any(String)
          })
        })
      );
      expect(evidence?.postedAt).not.toBe("2026-07-15T22:30:00.000Z");
    }

    const embeddedCreationCases = ["https://github.com/onecli/onecli-plugin"];
    for (const sourceUrl of embeddedCreationCases) {
      const source = targetedEvidenceSnapshot.evidence.find(
        (item) => item.sourceUrl.toLowerCase() === sourceUrl.toLowerCase()
      );
      const raw = JSON.parse(source?.rawVisibleText ?? "null") as {
        repository?: { id?: number; createdAt?: string; pushedAt?: string };
      };
      const evidence = ycSpring2026GraphDataset.evidence.find(
        (item) => item.sourceUrl.toLowerCase() === sourceUrl.toLowerCase()
      );

      expect(source).toBeDefined();
      expect(raw.repository?.createdAt).toBeTruthy();
      expect(raw.repository?.createdAt).not.toBe(raw.repository?.pushedAt);
      expect(evidence).toEqual(
        expect.objectContaining({
          postedAt: raw.repository?.createdAt,
          publishedAtPrecision: "exact",
          platformObjectId: String(raw.repository?.id)
        })
      );
      expect(JSON.parse(evidence?.rawVisibleText ?? "null")).toEqual(
        expect.objectContaining({
          repositoryTimestamps: {
            createdAt: raw.repository?.createdAt,
            updatedAt: null,
            pushedAt: raw.repository?.pushedAt,
            observedAt: expect.any(String)
          }
        })
      );
      expect(evidence?.postedAt).not.toBe(source?.postedAt);
    }

    const quarantinedCoastyCases = new Map([
      ["https://github.com/coasty-ai/coasty-osworld", "source-hunt-452be2563adcd2c631e7"],
      ["https://github.com/coasty-ai/llmhub-api", "source-hunt-730012ae25aac6572af2"],
      ["https://github.com/coasty-ai/.github", "source-hunt-b9a9f5da6aef55a798be"]
    ]);
    for (const [sourceUrl, sourceEvidenceId] of quarantinedCoastyCases) {
      const quarantined = targetedEvidenceSnapshot.needsReview.find(
        (item) => item.candidateUrl.toLowerCase() === sourceUrl.toLowerCase()
      );

      expect(quarantined).toEqual(
        expect.objectContaining({
          sourceEvidenceId,
          review_state: "needs_review",
          attributionReconciliationDirective: expect.objectContaining({
            disposition: "quarantined",
            reason: "entity_not_in_canonical_batch_catalog",
            staleAttribution: expect.objectContaining({
              batchSlug: "S26",
              entityId: "company-coasty"
            })
          })
        })
      );
      expect(
        ycSpring2026GraphDataset.evidence.some(
          (item) => item.sourceUrl.toLowerCase() === sourceUrl.toLowerCase()
        )
      ).toBe(false);
    }
  });

  it("fails closed when a GitHub repository row has no auditable native creation time", () => {
    const unauditedRepositories = [
      "https://github.com/experientiallabs/world-model-harness",
      "https://github.com/onecli/node-sdk",
      "https://github.com/onecli/onecli-cli",
      "https://github.com/understudylabs/lowermyaibill"
    ];

    for (const sourceUrl of unauditedRepositories) {
      const evidence = ycSpring2026GraphDataset.evidence.find(
        (item) => item.sourceUrl.toLowerCase() === sourceUrl.toLowerCase()
      );

      expect(evidence).toEqual(expect.objectContaining({ publishedAtPrecision: "unknown" }));
      expect(isCrediblyPublishedToday(evidence!, new Date(evidence!.postedAt))).toBe(false);
    }
  });

  it("preserves upstream publication precision and rejects inferred relative-display dates", () => {
    const inferredProductHunt = ycSpring2026GraphDataset.evidence.find(
      (item) => item.id === "source-hunt-24552534f0e54f7ca54c"
    );
    expect(inferredProductHunt).toEqual(expect.objectContaining({
      platform: "product_hunt",
      publishedAtPrecision: "unknown"
    }));
    expect(isCrediblyPublishedToday(inferredProductHunt!, new Date(inferredProductHunt!.postedAt))).toBe(false);

    const materializedRelativeX = ycSpring2026GraphDataset.evidence.find(
      (item) => item.sourceUrl === "https://x.com/screenpipe/status/2082126608345788464"
    );
    expect(materializedRelativeX).toEqual(expect.objectContaining({
      platform: "x",
      publishedAtPrecision: "unknown"
    }));
  });

  it("demotes a post-observation raw claim to a row-level observation fallback", () => {
    const source = targetedEvidenceSnapshot.evidence.find(
      (item) => item.id === "product_hunt-all_batches_nonx_nonlinkedin_sol_ultra-s2026-company-cignara-nalin-gupta1-products-cignara"
    );
    const evidence = ycSpring2026GraphDataset.evidence.find((item) => item.id === source?.id);

    expect(source).toBeDefined();
    expect(Date.parse(source?.postedAt ?? "")).toBeGreaterThan(Date.parse(source?.first_seen_at ?? ""));
    expect(evidence).toEqual(expect.objectContaining({
      postedAt: source?.first_seen_at,
      observedAt: source?.first_seen_at,
      publishedAtPrecision: "unknown"
    }));
  });

  it("publishes Graphify's verified GitHub, public LinkedIn, and Hacker News evidence", () => {
    const graphifyEvidence = ycSpring2026GraphDataset.evidence.filter(
      (item) => item.attachedCompanyId === "company-graphify-labs"
    );

    expect(graphifyEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          platform: "github",
          sourceUrl: "https://github.com/Graphify-Labs/graphify",
          platformObjectId: "1200597263",
          contributionScore: 100
        }),
        expect.objectContaining({
          platform: "linkedin",
          platformPostId: "7447394137814745088"
        }),
        expect.objectContaining({
          platform: "hacker_news",
          platformPostId: "47682798"
        })
      ])
    );
    const graphifyRepository = graphifyEvidence.find(
      (item) =>
        item.sourceUrl === "https://github.com/Graphify-Labs/graphify" &&
        item.platformObjectId === "1200597263"
    );
    const graphify = ycSpring2026GraphDataset.companies.find(
      (company) => company.id === "company-graphify-labs"
    );
    expect(graphifyRepository?.socialAccountId).toEqual(expect.any(String));
    expect(graphify?.socialAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: graphifyRepository?.socialAccountId,
          platform: "github",
          url: "https://github.com/graphify-labs"
        })
      ])
    );
  });

  it("uses explicit batch provenance to isolate evidence for entities shared by Spring and Summer", () => {
    const sharedCompanyId = "company-textsidekick";
    const sharedFounderId = "founder-textsidekick-justin-so-3332767";

    expect(
      ycSpring2026GraphDataset.companies
        .filter((company) => company.id === sharedCompanyId)
        .map((company) => company.batchSlug)
        .sort()
    ).toEqual(["S2026", "S26"]);
    expect(
      ycSpring2026GraphDataset.founders
        .filter((founder) => founder.id === sharedFounderId)
        .map((founder) => founder.batchSlug)
        .sort()
    ).toEqual(["S2026", "S26"]);

    const springScoped = { batchSlug: "S2026" };
    expect(evidenceMatchesBatchScope(springScoped, "S2026", false)).toBe(true);
    expect(evidenceMatchesBatchScope(springScoped, "S26", true)).toBe(false);

    const summerScoped = { batch_slug: "S26" };
    expect(evidenceMatchesBatchScope(summerScoped, "S26", false)).toBe(true);
    expect(evidenceMatchesBatchScope(summerScoped, "S2026", true)).toBe(false);

    const ambiguousUnscoped = { entityId: sharedCompanyId };
    expect(evidenceMatchesBatchScope(ambiguousUnscoped, "S2026", true)).toBe(false);
    expect(evidenceMatchesBatchScope(ambiguousUnscoped, "S26", true)).toBe(false);

    // Unique legacy entities keep the cohort-text decision until autonomous
    // merge writes explicit provenance. Shared entity IDs fail closed.
    expect(evidenceMatchesBatchScope({}, "S2026", true)).toBe(true);
    expect(evidenceMatchesBatchScope({}, "S2026", false)).toBe(false);
    const sharedEvidence = ycSpring2026GraphDataset.evidence.filter(
      (item) => item.entityId === sharedCompanyId || item.entityId === sharedFounderId
    );
    const sharedReview = (ycSpring2026GraphDataset.needsReview ?? []).filter(
      (item) => item.entityId === sharedCompanyId || item.entityId === sharedFounderId
    );
    expect(sharedEvidence.length).toBeGreaterThan(0);
    expect(sharedEvidence.every((item) => Boolean(item.batchSlug))).toBe(true);
    expect(sharedReview.every((item) => Boolean(item.batchSlug))).toBe(true);

    const springGraph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const summerGraph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    expect(
      springGraph.evidence
        .filter((item) => item.entityId === sharedCompanyId || item.entityId === sharedFounderId)
        .every((item) => item.batchSlug === "S2026")
    ).toBe(true);
    expect(
      summerGraph.evidence
        .filter((item) => item.entityId === sharedCompanyId || item.entityId === sharedFounderId)
        .every((item) => item.batchSlug === "S26")
    ).toBe(true);
    expect(
      springGraph.needsReview
        .filter((item) => item.entityId === sharedCompanyId || item.entityId === sharedFounderId)
        .every((item) => item.batchSlug === "S2026")
    ).toBe(true);
    expect(
      summerGraph.needsReview
        .filter((item) => item.entityId === sharedCompanyId || item.entityId === sharedFounderId)
        .every((item) => item.batchSlug === "S26")
    ).toBe(true);
  });

  it("materializes verified Vestris founders and their two existing physical posts", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const vestris = graph.nodes.find(
      (node) => node.entityType === "company" && node.entityId === "company-vestris"
    );
    const expectedFounderIds = [
      "founder-vestris-aahil-valliani-3411947",
      "founder-vestris-joshua-tang-3411757"
    ];
    const expectedPostIds = ["7467251847137939459", "7467271346683801600"];
    const evidence = graph.evidence.filter((item) => expectedPostIds.includes(item.platformPostId ?? ""));

    expect(vestris?.founders.map((founder) => founder.id).sort()).toEqual(expectedFounderIds.sort());
    expect(evidence).toHaveLength(2);
    expect(evidence.map((item) => item.entityId).sort()).toEqual(expectedFounderIds.sort());
    expect(new Set(evidence.map(canonicalPostKey)).size).toBe(2);
    expect(evidence.every((item) => scoringEligibility(item).eligible)).toBe(true);
    expect(vestris?.score).toBeGreaterThan(0);
  });

  it("keeps the exact Earendil company post visible from explicit native author proof", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const activityId = "7442570736751374336";
    expect(
      ycSummer2026GraphDataset.evidence.find((item) => item.platformPostId === activityId)
    ).toBeTruthy();
    const evidence = graph.evidence.filter((item) => item.platformPostId === activityId);
    const earendil = graph.nodes.find(
      (node) => node.entityType === "company" && node.entityId === "company-earendil-robotics"
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual(expect.objectContaining({
      entityType: "company",
      entityId: "company-earendil-robotics",
      authorHandle: "earendil-robotics",
      accountUrl: "https://linkedin.com/company/earendil-robotics",
      metrics: { reactions: 31, comments: 2 }
    }));
    expect(scoringEligibility(evidence[0]!)).toEqual({ eligible: true, reason: "eligible" });
    expect(earendil?.score).toBeGreaterThan(0);
    expect(graph.evidence.some((item) => item.platformPostId === "7478895855991775232")).toBe(false);
  });

  it("accepts explicitly S2026-scoped native Hacker News rows without requiring batch prose", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const expectedIds = [...EXPLICIT_S2026_HACKER_NEWS_POST_IDS].sort();
    const evidence = graph.evidence.filter((item) =>
      EXPLICIT_S2026_HACKER_NEWS_POST_IDS.includes(
        item.platformPostId as (typeof EXPLICIT_S2026_HACKER_NEWS_POST_IDS)[number]
      )
    );

    expect(evidence.map((item) => item.platformPostId).sort()).toEqual(expectedIds);
    expect(evidence.every((item) => item.platform === "hacker_news")).toBe(true);
    expect(
      evidence.map((item) => ({
        platformPostId: item.platformPostId,
        eligibility: scoringEligibility(item)
      }))
    ).toEqual(
      expect.arrayContaining(
        expectedIds.map((platformPostId) => ({
          platformPostId,
          eligibility: { eligible: true, reason: "eligible" }
        }))
      )
    );
  });

  it("accepts final verified S26 LinkedIn attribution receipts but not the Earendil listicle", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const expectedIds = [...VERIFIED_S26_LINKEDIN_POST_IDS].sort();
    const evidence = graph.evidence.filter((item) =>
      VERIFIED_S26_LINKEDIN_POST_IDS.includes(
        item.platformPostId as (typeof VERIFIED_S26_LINKEDIN_POST_IDS)[number]
      )
    );

    expect(evidence.map((item) => item.platformPostId).sort()).toEqual(expectedIds);
    expect(evidence.every((item) => item.platform === "linkedin")).toBe(true);
    expect(evidence.every((item) => scoringEligibility(item).eligible)).toBe(true);
    expect(graph.evidence.some((item) => item.platformPostId === "7478895855991775232")).toBe(false);
  });

  it("accepts the targeted Libra Robotics post from exact native company-author proof", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const evidence = graph.evidence.filter((item) => item.platformPostId === "7482265767493779456");

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual(expect.objectContaining({
      entityType: "company",
      entityId: "company-libra-robotics",
      platform: "linkedin",
      authorName: "Libra Robotics",
      authorHandle: "librabots",
      metrics: { reactions: 11, comments: 3 },
      review_state: "verified"
    }));
    expect(scoringEligibility(evidence[0]!)).toEqual({ eligible: true, reason: "eligible" });
  });

  it("does not classify native posts as comments from engagement-counter prose", () => {
    expect(
      hasExplicitLinkedInCommentClaim({
        title: "Earendil Robotics native company post",
        matchReason:
          "Native LinkedIn post page identifies the company author and shows 30 reactions plus 2 comments on activity 7442570736751374336."
      })
    ).toBe(false);
    expect(
      hasExplicitLinkedInCommentClaim({
        title: "Andrew Miklas LinkedIn comment about InsForge",
        matchReason: "Native LinkedIn comment retained as context only."
      })
    ).toBe(true);

    const earendilPost = ycSummer2026GraphDataset.evidence.find(
      (item) => item.platformPostId === "7442570736751374336"
    );
    expect(earendilPost).toEqual(expect.objectContaining({
      contributionScore: expect.any(Number),
      review_state: "verified"
    }));
    expect(earendilPost?.contributionScore).toBeGreaterThan(0);
  });

  it("upgrades the existing Hexa physical row in place with founder attribution", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const activityId = "7452780945771966465";
    const evidence = graph.evidence.filter((item) => item.platformPostId === activityId);
    const hexa = graph.nodes.find(
      (node) => node.entityType === "company" && node.entityId === "company-hexa"
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual(expect.objectContaining({
      id: "web-company-hexa-www-linkedin-com-posts-ishaan-makkar-manufacturing-distribution-ycombinator-activity-7452780945771966465-23w1-hexa-yc-p26-backed-by-y-combinator-linkedin",
      entityType: "founder",
      entityId: "founder-hexa-ishaan-makkar-2767100",
      platform: "linkedin",
      authorHandle: "ishaan-makkar",
      accountUrl: "https://www.linkedin.com/in/ishaan-makkar",
      metrics: { reactions: 282, comments: 62 }
    }));
    expect(scoringEligibility(evidence[0]!)).toEqual({ eligible: true, reason: "eligible" });
    expect(hexa?.score).toBeGreaterThan(0);
  });

  it("defaults to YC Spring 2026 while exposing every supported batch in graph metadata", () => {
    const graph = buildGraphResponse({}, ycSpring2026GraphDataset);

    expect(graph.batch).toEqual({
      slug: "S2026",
      label: "YC Spring 2026 (P26)",
      companyCountExpected: 197,
      companyCountObserved: 197
    });
    expect(graph.batches).toEqual([
      graph.batch,
      {
        slug: "S26",
        label: "YC Summer 2026 (S26)",
        companyCountExpected: summerCompaniesSnapshot.source.expectedCompanyCount,
        companyCountObserved: summerCompaniesSnapshot.source.observedCompanyCount
      },
      {
        slug: "A16ZSR006",
        label: "a16z speedrun 006",
        companyCountExpected: 59,
        companyCountObserved: 59
      }
    ]);
    expect(new Set(graph.nodes.map((node) => node.batchSlug))).toEqual(new Set(["S2026"]));
  });

  it("can switch back to the Spring 2026 official snapshot", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");

    expect(graph.batch).toEqual({
      slug: "S2026",
      label: "YC Spring 2026 (P26)",
      companyCountExpected: 197,
      companyCountObserved: 197
    });
    expect(companyNodes).toHaveLength(197);
    expect(graph.leaderboard).toHaveLength(197);
    expect(graph.nodes.some((node) => node.label === "HeyClicky")).toBe(true);
    expect(graph.nodes.some((node) => node.label === "Conifer")).toBe(false);
    expect(graph.evidence.some((item) => item.title === "FarzaTV X post")).toBe(false);
    expect(
      graph.evidence.find((item) => item.sourceUrl === "https://x.com/FarzaTV/status/2077130366230639022")?.title
    ).toContain("Today we're shipping screen-aware dictation.");
  });

  it("loads the complete public YC batch instead of the demo seed", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
    const founderNodes = graph.nodes.filter((node) => node.entityType === "founder");
    const instagramEvidence = graph.evidence.filter((item) => item.platform === "instagram");
    const summerCompanyIds = new Set(
      summerCompaniesSnapshot.companies.map((company) => `company-${company.slug}`)
    );

    expect(graph.mode).toBe("official_snapshot");
    expect(graph.batch.companyCountExpected).toBe(summerCompaniesSnapshot.source.expectedCompanyCount);
    expect(graph.batch.companyCountObserved).toBe(summerCompaniesSnapshot.source.observedCompanyCount);
    expect(companyNodes).toHaveLength(summerCompaniesSnapshot.companies.length);
    expect(founderNodes).toHaveLength(0);
    expect(graph.leaderboard).toHaveLength(summerCompaniesSnapshot.companies.length);
    expect(graph.evidence.length).toBeGreaterThan(39);
    expect(new Set(graph.evidence.map((item) => item.platform))).toEqual(
      new Set(["github", "youtube", "x", "linkedin", "instagram", "hacker_news", "product_hunt", "rss", "web"])
    );
    expect(
      graph.evidence
        .filter((item) => item.platform === "rss" || item.platform === "web")
        .every((item) => item.contributionScore === 0)
    ).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "github" && item.thumbnailUrl)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "youtube" && item.attachedCompanyName === "Archal")).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "x" && item.contributionScore > 0)).toBe(true);
    expect(graph.evidence.some((item) => item.platform === "linkedin" && item.contributionScore > 0)).toBe(true);
    expect(instagramEvidence.length).toBeGreaterThan(0);
    expect(instagramEvidence.every((item) => summerCompanyIds.has(item.attachedCompanyId ?? ""))).toBe(true);
    expect(instagramEvidence.map((item) => item.attachedCompanyName)).toEqual(
      expect.arrayContaining(["Control Seat", "Pluto", "tash"])
    );
    expect(graph.leaderboard[0]?.topPlatform).toBeTruthy();
    expect(companyNodes.filter((node) => node.score > 0).length).toBeGreaterThan(6);
    expect(companyNodes.some((node) => node.founders.length > 0)).toBe(true);
    expect(graph.evidence.some((item) => item.entityType === "founder")).toBe(true);
    expect(graph.needsReview.some((item) => item.candidateUrl === "https://www.producthunt.com/products/screen-studio")).toBe(false);
    expect(JSON.stringify(graph.evidence)).not.toContain("yc-public-directory");
  }, 30_000);

  it("materializes distinct web and RSS articles discovered through one feed or sitemap", () => {
    const summer = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const agencyToolArticles = summer.evidence.filter(
      (item) => item.platform === "web" && item.sourceUrl.startsWith("https://agencytool.com/blog")
    );
    const spring = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const springContext = spring.evidence.filter(
      (item) => item.platform === "web" || item.platform === "rss"
    );

    expect(agencyToolArticles.length).toBeGreaterThan(1);
    expect(agencyToolArticles.some((item) => item.sourceUrl.endsWith("/sitemap.xml"))).toBe(false);
    expect(new Set(agencyToolArticles.map(canonicalPostKey)).size).toBe(agencyToolArticles.length);
    expect(springContext.length).toBeGreaterThan(3_000);
    expect(new Set(springContext.map(canonicalPostKey)).size).toBe(springContext.length);
  }, 30_000);

  it("preserves historical evidence across Summer 2026 company renames", () => {
    const summer = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const spring = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const renames = [
      {
        oldSlug: "blueprints",
        newSlug: "hoplite",
        founderIds: [
          "founder-hoplite-ryan-morrissey-2563241",
          "founder-hoplite-bence-redmond-2614746"
        ]
      },
      {
        oldSlug: "bylaw",
        newSlug: "definite",
        founderIds: [
          "founder-definite-mazin-al-ani-2947432",
          "founder-definite-farhan-ur-rehman-1563459",
          "founder-definite-gurshabd-singh-varaich-2947446"
        ]
      },
      {
        oldSlug: "litmus-build",
        newSlug: "litmus-hiring",
        founderIds: [
          "founder-litmus-hiring-shaivi-rau-1353649",
          "founder-litmus-hiring-elena-zhao-2315600"
        ]
      },
      {
        oldSlug: "notyfi",
        newSlug: "perceptron-ml",
        founderIds: [
          "founder-perceptron-ml-michael-marcotte-3087509",
          "founder-perceptron-ml-peyton-marcotte-3122328"
        ]
      },
      {
        oldSlug: "justinian",
        newSlug: "locke",
        founderIds: [
          "founder-locke-parth-badhwar-2399943"
        ]
      },
      {
        oldSlug: "truffle",
        newSlug: "joinmarble",
        founderIds: [
          "founder-joinmarble-arjun-chaliha-306060",
          "founder-joinmarble-aakar-khanna-1278164"
        ]
      }
    ] as const;
    const summerFounders = ycSpring2026GraphDataset.founders.filter((founder) => founder.batchSlug === "S26");
    const summerEntityIds = [
      ...summer.nodes.map((node) => node.entityId),
      ...summerFounders.map((founder) => founder.id),
      ...summer.evidence.flatMap((item) => [item.entityId, item.attachedCompanyId]),
      ...summer.needsReview.map((item) => item.entityId)
    ].filter(Boolean);

    for (const rename of renames) {
      expect(summer.nodes.some((node) => node.entityId === `company-${rename.newSlug}`)).toBe(true);
      expect(summerFounders.map((founder) => founder.id)).toEqual(expect.arrayContaining([...rename.founderIds]));
      expect(summerEntityIds.some((entityId) => entityId === `company-${rename.oldSlug}`)).toBe(false);
      expect(summerEntityIds.some((entityId) => entityId?.startsWith(`founder-${rename.oldSlug}-`))).toBe(false);
    }

    expect(
      summer.evidence.find(
        (item) => item.platform === "x" && item.platformPostId === "2069484935464042689"
      )
    ).toMatchObject({
      entityId: "founder-hoplite-bence-redmond-2614746",
      attachedCompanyId: "company-hoplite"
    });
    expect(
      summer.evidence.find(
        (item) =>
          item.sourceUrl ===
          "https://x.com/UseBylaw/status/2051128240303955982"
      )
    ).toMatchObject({
      entityId: "company-definite",
      attachedCompanyId: "company-definite"
    });
    expect(
      summer.evidence.some((item) =>
        /linkedin\.com\/in\/(?:bence-redmond|ryan-morrissey-834256271|gvaraich)\/recent-activity\/all\/?#post-/i.test(
          item.sourceUrl
        )
      )
    ).toBe(false);
    expect(
      summer.evidence.some(
        (item) =>
          item.sourceUrl ===
          "https://www.linkedin.com/feed/update/urn:li:activity:6924821470124650496/"
      )
    ).toBe(false);

    const springEntityIds = [
      ...spring.nodes.map((node) => node.entityId),
      ...spring.evidence.flatMap((item) => [item.entityId, item.attachedCompanyId]),
      ...spring.needsReview.map((item) => item.entityId)
    ].filter(Boolean);
    for (const rename of renames) {
      expect(
        springEntityIds.some(
          (entityId) =>
            entityId === `company-${rename.oldSlug}` ||
            entityId === `company-${rename.newSlug}` ||
            entityId?.startsWith(`founder-${rename.oldSlug}-`) ||
            entityId?.startsWith(`founder-${rename.newSlug}-`)
        )
      ).toBe(false);
    }

    expect(
      summer.evidence.find(
        (item) => item.sourceUrl === "https://github.com/CarbonCopyInc/carboncopy-mcp"
      )
    ).toEqual(
      expect.objectContaining({
        entityId: "company-hoplite",
        attachedCompanyId: "company-hoplite",
        platform: "github",
        review_state: "verified",
        contributionScore: expect.any(Number)
      })
    );
    expect(
      summer.evidence.find(
        (item) => item.sourceUrl === "https://github.com/CarbonCopyInc/carboncopy-mcp"
      )?.contributionScore
    ).toBeGreaterThan(0);

    expect(
      summer.evidence.find(
        (item) => item.sourceUrl === "https://x.com/UseBylaw/status/2051128240303955982"
      )
    ).toEqual(
      expect.objectContaining({
        entityId: "company-definite",
        attachedCompanyId: "company-definite",
        platform: "x",
        review_state: "verified",
        contributionScore: expect.any(Number)
      })
    );
    expect(
      summer.evidence.find(
        (item) => item.sourceUrl === "https://x.com/UseBylaw/status/2051128240303955982"
      )?.contributionScore
    ).toBeGreaterThan(0);

    expect(
      summer.evidence.some((item) =>
        item.id === "evidence-github-profile-company-definite" ||
        item.id === "evidence-github-repo-company-definite-usebylaw-python-sdk"
      )
    ).toBe(false);
    expect(
      githubQuarantineSnapshot.rows.find(
        (row) => row.batchSlug === "S26" && row.legacyRow.companySlug === "bylaw"
      )
    ).toEqual(
      expect.objectContaining({
        category: "legacy_account_mapping_absent_from_authoritative_targets",
        currentCanonicality: "absent_from_current_canonical_receipt",
        scoringEligible: false,
        physicalRepresentation: expect.objectContaining({
          status: "not_represented_in_current_canonical_receipt"
        }),
        legacyRow: expect.objectContaining({
          entityId: "company-bylaw",
          login: "UseBylaw",
          repos: expect.any(Array)
        })
      })
    );
  }, 30_000);

  it("provides a thumbnail URL for every evidence item in YC and a16z batches", () => {
    for (const batchSlug of ["S2026", "S26", "A16ZSR006"]) {
      const graph = buildGraphResponse({ batchSlug }, ycSpring2026GraphDataset);
      const missing = graph.evidence.filter((item) => !item.thumbnailUrl);

      expect(
        missing.map((item) => `${item.platform}:${item.id}`).slice(0, 20),
        `${batchSlug} is missing thumbnails for ${missing.length} evidence items`
      ).toEqual([]);
    }
  }, 30_000);

  it("canonicalizes physical evidence while retaining founder and company references", () => {
    const spring = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const allowance = spring.nodes.find((node) => node.entityId === "company-allowance");
    const allowancePost = spring.evidence.filter(
      (item) => canonicalPostKey(item) === "x:post:2057828506399281568"
    );

    expect(allowancePost).toHaveLength(1);
    expect(allowancePost[0]).toEqual(
      expect.objectContaining({
        entityType: "founder",
        entityId: "founder-allowance-dasmer-singh-330737",
        attachedCompanyId: "company-allowance"
      })
    );
    expect(allowance?.evidenceIds).toContain(allowancePost[0]?.id);
    expect(
      allowance?.founders.find((founder) => founder.id === allowancePost[0]?.entityId)?.evidenceIds
    ).toContain(allowancePost[0]?.id);

    const profileRows = spring.evidence.filter((item) => item.id.startsWith("evidence-github-profile-"));
    expect(new Set(spring.evidence.map((item) => item.id)).size).toBe(spring.evidence.length);
    expect(profileRows.every((item) => item.contributionScore === 0)).toBe(true);
    expect(
      profileRows.some(
        (item) =>
          item.entityType === "founder" &&
          item.entityId === "founder-smol-machines-binbin-he-1655532"
      )
    ).toBe(false);
    const quarantinedSmolFounderRows = githubQuarantineSnapshot.rows.filter(
      (row) => row.legacyRow.entityId === "founder-smol-machines-binbin-he-1655532"
    );
    expect(quarantinedSmolFounderRows).toHaveLength(4);
    expect(quarantinedSmolFounderRows.every((row) => row.scoringEligible === false)).toBe(true);
    expect(
      quarantinedSmolFounderRows
        .filter((row) => row.legacyRow.repo)
        .map((row) => `${row.legacyRow.login}/${row.legacyRow.repo}`)
        .sort()
    ).toEqual([
      "containers/libkrun",
      "smol-machines/libkrunfw",
      "smol-machines/smolvm"
    ]);

    const summer = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const pangoPost = summer.evidence.filter(
      (item) => canonicalPostKey(item) === "linkedin:post:7473269455783948288"
    );
    const pangoContext = summer.evidence.filter(
      (item) => item.platformPostId === "7473616064967266304"
    );

    expect(pangoPost).toHaveLength(1);
    expect(pangoPost[0]).toEqual(
      expect.objectContaining({
        entityType: "founder",
        entityId: "founder-pango-lukasz-reszczynski-3331619",
        attachedCompanyId: "company-pango",
        metrics: expect.objectContaining({ reactions: 319, comments: 43 })
      })
    );
    expect(pangoContext).toEqual([]);

    const linkedInCommentContexts = [...spring.evidence, ...summer.evidence].filter((item) =>
      item.sourceUrl.includes("/recent-activity/comments/#post-")
    );
    expect(linkedInCommentContexts).toHaveLength(1);
    for (const item of linkedInCommentContexts) {
      expect(item.contributionScore).toBe(0);
      expect(item.review_state).toBe("verified");
      expect(canonicalPostKey(item)).toBe(`linkedin:post:${item.platformPostId}`);
      expect(Object.values(item.metrics).some((value) => Number(value) > 0)).toBe(true);
      expect(item.why).toContain("Direct comment locator:");
      expect(item.why).toContain("never contribute to regular company or founder traction scores");
    }

    const unlocatedComment = ycSpring2026GraphDataset.evidence.find(
      (item) => item.id === "linkedin-topvoice-company-rise-reforming-alexisohanian-activity-7345937006784356353-comment-george-rose"
    );
    const mislabelledParentComment = ycSpring2026GraphDataset.evidence.find(
      (item) => item.id === "linkedin-topvoice-seventh-pass-s2026-company-insforge-andrew-miklas-7462200339899846656"
    );

    expect(unlocatedComment).toEqual(
      expect.objectContaining({
        contributionScore: 0,
        platformPostId: null,
        review_state: "needs_review"
      })
    );
    expect(unlocatedComment?.why).toContain("no separate stable native comment identity");
    expect(mislabelledParentComment).toEqual(
      expect.objectContaining({
        contributionScore: 0,
        platformPostId: null,
        review_state: "rejected"
      })
    );
    expect(mislabelledParentComment?.why).toContain("owned by y-combinator");
    expect(mislabelledParentComment?.why).toContain("Parent-post IDs and metrics are never attributed");
  }, 30_000);

  it("extracts LinkedIn account identities before nested admin, about, and posts routes", () => {
    const nestedRoutes = new Map([
      ["https://www.linkedin.com/company/acme/admin/dashboard/", "acme"],
      ["https://www.linkedin.com/company/acme/about/", "acme"],
      ["https://www.linkedin.com/company/acme/posts/?feedView=all", "acme"],
      ["https://www.linkedin.com/in/person/recent-activity/all/", "person"]
    ]);
    for (const [url, expectedHandle] of nestedRoutes) {
      expect(handleFromUrl(url)).toBe(expectedHandle);
    }

    for (const malformedUrl of [
      "https://www.linkedin.com/company/admin/dashboard/",
      "https://www.linkedin.com/company/about/",
      "https://www.linkedin.com/company/posts/",
      "https://www.linkedin.com/company/",
      "https://www.linkedin.com/in/posts/",
      "https://www.linkedin.com/posts/acme_activity-123-test",
      "not a url"
    ]) {
      expect(handleFromUrl(malformedUrl)).toBeNull();
    }

    const expectedSnapshotAccounts = new Map([
      ["https://www.linkedin.com/company/109776165/admin/dashboard/", "109776165"],
      ["https://www.linkedin.com/company/huscarl/about/", "huscarl"],
      ["https://www.linkedin.com/company/lamina-labs/about/", "lamina-labs"],
      ["https://www.linkedin.com/company/108252929/admin/dashboard/", "108252929"],
      ["https://www.linkedin.com/company/mountyc26/posts/?feedView=all", "mountyc26"],
      ["https://www.linkedin.com/company/111953568/admin/dashboard/", "111953568"],
      ["https://www.linkedin.com/company/coniferbuild", "coniferbuild"],
      ["https://www.linkedin.com/company/131464079", "131464079"],
      ["https://www.linkedin.com/company/130274179/admin/dashboard/", "130274179"]
    ]);
    const socialAccounts = [
      ...ycSpring2026GraphDataset.companies.flatMap((company) => company.socialAccounts),
      ...ycSpring2026GraphDataset.founders.flatMap((founder) => founder.socialAccounts)
    ];

    for (const [url, expectedHandle] of expectedSnapshotAccounts) {
      expect(socialAccounts.find((account) => account.url === url)).toEqual(
        expect.objectContaining({ handle: expectedHandle, review_state: "verified" })
      );
    }
    expect(
      socialAccounts.find(
        (account) =>
          account.id ===
          "acct:company:company-praxis-robotics:linkedin:https%3A%2F%2Flinkedin.com%2Fcompany%2F130274179"
      )
    ).toEqual(
      expect.objectContaining({
        url: "https://www.linkedin.com/company/130274179/admin/dashboard/",
        handle: "130274179",
        review_state: "verified"
      })
    );
    expect(
      socialAccounts
        .filter((account) => account.review_state === "verified")
        .filter((account) => !account.handle || ["admin", "dashboard", "about", "posts"].includes(account.handle))
    ).toEqual([]);
  });

  it("encodes canonical platform URLs in materialized YouTube, Reddit, and Product Hunt account IDs", () => {
    const accounts = ycSpring2026GraphDataset.companies.flatMap((company) => company.socialAccounts);
    const expectedIdsByUrl = new Map([
      [
        "https://www.youtube.com/@Anoria_inc",
        "acct:company:company-anoria:youtube:https%3A%2F%2Fyoutube.com%2F%40anoria_inc"
      ],
      [
        "https://www.youtube.com/channel/UCsKrXhK7dyIA_ATzzbzZ8bA",
        "acct:company:company-luca-iq:youtube:https%3A%2F%2Fyoutube.com%2Fchannel%2Fucskrxhk7dyia_atzzbzz8ba"
      ],
      [
        "https://www.reddit.com/user/Ecstatic-Tough6503",
        "acct:company:company-gojiberry-ai:reddit:https%3A%2F%2Freddit.com%2Fuser%2Fecstatic-tough6503"
      ],
      [
        "https://www.producthunt.com/products/runtime",
        "acct:company:company-runtime:product_hunt:https%3A%2F%2Fproducthunt.com%2Fproducts%2Fruntime"
      ]
    ]);

    for (const [url, expectedId] of expectedIdsByUrl) {
      expect(accounts.find((account) => account.url === url)?.id).toBe(expectedId);
    }
  });

  it("keeps evidence account lineage materialized, owner-scoped, and score-neutral", () => {
    const owners = materializedAccountOwners(ycSpring2026GraphDataset);
    const ownersById = new Map<string, typeof owners>();
    for (const owner of owners) {
      ownersById.set(owner.account.id, [...(ownersById.get(owner.account.id) ?? []), owner]);
    }

    const linkedEvidence = ycSpring2026GraphDataset.evidence.filter(
      (item) => item.socialAccountId !== null && item.socialAccountId !== undefined
    );
    const unresolvedEvidence = linkedEvidence.filter((item) => !ownersById.has(item.socialAccountId!));
    const wrongOwnerEvidence = linkedEvidence.filter(
      (item) =>
        !ownersById
          .get(item.socialAccountId!)
          ?.some(
            (owner) =>
              owner.entityType === item.entityType &&
              owner.entityId === item.entityId &&
              owner.account.platform === item.platform
          )
    );
    const collidingAccountIds = [...ownersById.entries()].filter(([, accountOwners]) =>
      new Set(
        accountOwners.map(
          (owner) => `${owner.entityType}:${owner.entityId}:${owner.account.platform}:${owner.account.url}`
        )
      ).size > 1
    );
    const scoredLinkedEvidence = linkedEvidence.filter((item) => item.contributionScore > 0);
    const screenpipeRepository = ycSpring2026GraphDataset.evidence.find(
      (item) => item.sourceUrl === "https://github.com/screenpipe/screenpipe"
    );

    expect(linkedEvidence.length).toBeGreaterThan(0);
    expect(scoredLinkedEvidence.length).toBeGreaterThan(0);
    expect(unresolvedEvidence).toHaveLength(0);
    expect(wrongOwnerEvidence).toHaveLength(0);
    expect(collidingAccountIds).toHaveLength(0);
    expect(screenpipeRepository).toEqual(
      expect.objectContaining({
        entityType: "company",
        entityId: "company-screenpipe",
        platform: "github",
        contributionScore: expect.any(Number)
      })
    );
    expect(screenpipeRepository?.contributionScore).toBeGreaterThan(0);
    expect(ownersById.get(screenpipeRepository?.socialAccountId ?? "")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "company",
          entityId: "company-screenpipe",
          account: expect.objectContaining({ platform: "github" })
        })
      ])
    );
  });

  it("does not rematerialize accounts explicitly retired by identity validation", () => {
    const openRelay = ycSpring2026GraphDataset.companies.find(
      (company) => company.batchSlug === "S26" && company.id === "company-openrelay"
    );

    expect(openRelay).toBeTruthy();
    expect(
      openRelay?.socialAccounts.some(
        (account) => account.url.toLowerCase() === "https://github.com/openrelayinc/openrelay"
      )
    ).toBe(false);
  });
});

function materializedAccountOwners(dataset: Pick<typeof ycSpring2026GraphDataset, "companies" | "founders">): Array<{
  entityType: "company" | "founder";
  entityId: string;
  account: SocialAccountSummary;
}> {
  return [
    ...dataset.companies.flatMap((company) =>
      company.socialAccounts.map((account) => ({ entityType: "company" as const, entityId: company.id, account }))
    ),
    ...dataset.founders.flatMap((founder) =>
      founder.socialAccounts.map((account) => ({ entityType: "founder" as const, entityId: founder.id, account }))
    )
  ];
}
