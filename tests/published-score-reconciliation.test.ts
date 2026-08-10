import { describe, expect, it } from "vitest";
import { dedupeEvidenceItems } from "@/lib/graph/dedupe";
import { reconcilePublishedCompanyScores } from "@/lib/graph/published-score-reconciliation";
import { aggregateBalancedTractionScore } from "@/lib/graph/traction-scoring";
import type { CompanyRecord, EvidenceItem } from "@/lib/graph/types";

describe("published score reconciliation", () => {
  it("recomputes each batch score from the evidence that survives global physical-post dedupe", () => {
    const springEvidence = scoredEvidence("spring-row", "S2026");
    const summerEvidence = scoredEvidence("summer-row", "S26");
    const publishedEvidence = dedupeEvidenceItems([springEvidence, summerEvidence]);
    const staleBreakdown = aggregateBalancedTractionScore([springEvidence]);
    const companies = [
      company("S2026", staleBreakdown),
      company("S26", staleBreakdown)
    ];

    expect(publishedEvidence).toHaveLength(1);

    const reconciled = reconcilePublishedCompanyScores(companies, publishedEvidence);
    const spring = reconciled.find((candidate) => candidate.batchSlug === "S2026");
    const summer = reconciled.find((candidate) => candidate.batchSlug === "S26");

    expect(spring?.scoreBreakdown?.confidence.scoredEvidenceCount).toBe(1);
    expect(spring?.scoreBreakdown?.weightedPlatforms[0]?.evidenceCount).toBe(1);
    expect(summer?.scoreBreakdown?.confidence.scoredEvidenceCount).toBe(0);
    expect(summer?.scoreBreakdown?.weightedPlatforms).toEqual([]);
    expect(summer?.totalScore).toBe(0);
  });
});

function scoredEvidence(id: string, batchSlug: string): EvidenceItem {
  return {
    id,
    batchSlug,
    entityType: "company",
    entityId: "shared-company",
    platform: "x",
    authorName: "Shared Company",
    authorHandle: "sharedcompany",
    postedAt: "2026-08-09T12:00:00.000Z",
    publishedAtPrecision: "exact",
    observedAt: "2026-08-09T13:00:00.000Z",
    metricsCheckedAt: "2026-08-09T13:00:00.000Z",
    text: "A shared physical post.",
    mediaType: "text",
    linkStatus: "verified",
    metrics: { views: 10_000 },
    contributionScore: 80,
    normalizedScore: 80,
    tractionStatus: "scored",
    sourceUrl: "https://x.com/sharedcompany/status/1234567890",
    platformPostId: "1234567890",
    why: "Regression fixture.",
    attachedCompanyId: "shared-company",
    review_state: "verified"
  };
}

function company(
  batchSlug: string,
  scoreBreakdown: ReturnType<typeof aggregateBalancedTractionScore>
): CompanyRecord {
  return {
    id: "shared-company",
    batchSlug,
    name: `Shared Company ${batchSlug}`,
    ycProfileUrl: "https://example.com/company",
    websiteUrl: "https://example.com",
    tagline: "Regression fixture",
    description: "Regression fixture",
    groupPartner: null,
    primaryIndustry: "b2b",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://example.com/company",
    industries: ["b2b"],
    founderIds: [],
    socialAccounts: [],
    totalScore: scoreBreakdown.totalScore,
    previousScore: scoreBreakdown.totalScore,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown
  };
}
