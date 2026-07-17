import { describe, expect, it } from "vitest";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import type {
  CompanyRecord,
  DemoGraphDataset,
  EvidenceItem,
  GraphResponse,
  NeedsReviewItem,
  Platform,
  ScoreBreakdown,
  TopVoiceConnectionPreview
} from "@/lib/graph/types";

describe("client graph filters", () => {
  it("preserves canonical scores, source ranks, momentum, and scoring context across platform filters", () => {
    const source = canonicalGraph();
    const filtered = applyClientGraphFilters(source, {
      platforms: ["x"],
      industries: [],
      groupPartners: [],
      minScore: 0
    });
    const visibleCompanyIds = new Set(["canonical-high", "x-evidence-high"]);

    expect(companyIds(filtered)).toEqual(["canonical-high", "x-evidence-high"]);
    expect(filtered.leaderboard.map((row) => [row.companyId, row.rank])).toEqual([
      ["canonical-high", 1],
      ["x-evidence-high", 3]
    ]);
    expect(canonicalNodeFields(filtered)).toEqual(
      canonicalNodeFields(source).filter((node) => visibleCompanyIds.has(node.entityId))
    );
    expect(canonicalLeaderboardFields(filtered)).toEqual(
      canonicalLeaderboardFields(source).filter((row) => visibleCompanyIds.has(row.companyId))
    );
    expect(filtered.fastestGaining).toEqual(
      source.fastestGaining.filter((row) => visibleCompanyIds.has(row.companyId))
    );
    expect(filtered.scoringContext).toBe(source.scoringContext);
    expect(filtered.scoringContext).toMatchObject({
      scoreScope: "all_platforms",
      selectedPlatforms: []
    });
    expect(filtered.generatedAt).toBe(source.generatedAt);

    expect(source.leaderboard.find((row) => row.companyId === "canonical-high")?.biggestContribution?.id)
      .toBe("github-high");
    expect(filtered.evidence.map((item) => item.id)).toEqual(["x-high", "x-low"]);
    expect(filtered.evidence.every((item) => item.platform === "x")).toBe(true);
    expect(filtered.nodes.find((node) => node.entityId === "canonical-high")?.evidenceIds).toEqual(["x-low"]);
    expect(filtered.nodes.find((node) => node.entityId === "x-evidence-high")?.evidenceIds).toEqual(["x-high"]);
    expect(filtered.leaderboard.find((row) => row.companyId === "canonical-high")?.biggestContribution)
      .toMatchObject({ id: "x-low", thumbnailUrl: "https://images.example/x-low.jpg" });
    expect(filtered.needsReview.map((item) => item.id)).toEqual(["review-x-high"]);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["edge-visible"]);

    const minScoreFiltered = applyClientGraphFilters(source, {
      platforms: ["x"],
      industries: [],
      groupPartners: [],
      minScore: 50
    });
    expect(companyIds(minScoreFiltered)).toEqual(["canonical-high"]);
  });

  it("retains source ordering and DoD/WoW momentum when non-platform filters hide companies", () => {
    const source = canonicalGraph();
    const filtered = applyClientGraphFilters(source, {
      platforms: [],
      industries: ["consumer"],
      groupPartners: [],
      minScore: 0
    });
    const visibleCompanyIds = new Set(["github-only", "x-evidence-high"]);

    expect(filtered.leaderboard.map((row) => [row.companyId, row.rank])).toEqual([
      ["github-only", 2],
      ["x-evidence-high", 3]
    ]);
    expect(canonicalNodeFields(filtered)).toEqual(
      canonicalNodeFields(source).filter((node) => visibleCompanyIds.has(node.entityId))
    );
    expect(filtered.fastestGaining).toEqual(
      source.fastestGaining.filter((row) => visibleCompanyIds.has(row.companyId))
    );
    expect(filtered.scoringContext).toBe(source.scoringContext);
  });

  it("uses Top Voice evidence only for visibility while preserving source connections and omitting a derived score", () => {
    const canonical = canonicalGraph();
    const connection: TopVoiceConnectionPreview = {
      memberId: "voice-1",
      displayName: "Source Voice",
      category: "operator",
      weight: 1.5,
      contributionScore: 321,
      evidenceCount: 7,
      topEvidenceId: "github-high",
      platforms: ["github"]
    };
    const sourceCompanyNode = canonical.nodes.find((node) => node.entityId === "canonical-high")!;
    const sourceCompanyRow = canonical.leaderboard.find((row) => row.companyId === "canonical-high")!;
    const voiceNode: GraphResponse["nodes"][number] = {
      ...canonical.nodes.find((node) => node.entityId === "github-only")!,
      id: "top-voice:voice-1",
      entityType: "founder",
      entityId: "voice-1",
      label: "Source Voice",
      evidenceIds: [],
      founders: [],
      isTopVoiceNode: true
    };
    const source: GraphResponse = {
      ...canonical,
      selectedTopVoiceAudience: {
        ...canonical.selectedTopVoiceAudience,
        id: "insiders",
        displayName: "Insiders"
      },
      nodes: [
        ...canonical.nodes.map((node) =>
          node.entityId === "canonical-high"
            ? {
                ...node,
                topVoiceScore: undefined,
                topVoiceConnectionCount: 1,
                topVoiceConnections: [connection]
              }
            : node
        ),
        voiceNode
      ],
      leaderboard: canonical.leaderboard.map((row) =>
        row.companyId === "canonical-high"
          ? {
              ...row,
              topVoiceScore: undefined,
              topVoiceConnectionCount: 1,
              topVoiceConnections: [connection]
            }
          : row
      ),
      evidence: canonical.evidence.map((item) => ({
        ...item,
        topVoice: {
          audienceId: "insiders",
          memberId: "voice-1",
          displayName: "Source Voice",
          category: "operator",
          weight: 1.5,
          matchedBy: "native author",
          originalContributionScore: item.contributionScore
        }
      })),
      edges: [
        topVoiceEdge("edge-voice-visible", voiceNode.id, sourceCompanyNode.id),
        topVoiceEdge("edge-voice-hidden", voiceNode.id, "company:github-only")
      ]
    };

    const filtered = applyClientGraphFilters(source, {
      platforms: ["x"],
      industries: [],
      groupPartners: [],
      minScore: 0
    });
    const filteredNode = filtered.nodes.find((node) => node.entityId === "canonical-high")!;
    const filteredRow = filtered.leaderboard.find((row) => row.companyId === "canonical-high")!;

    expect(companyIds(filtered)).toEqual(["canonical-high", "x-evidence-high"]);
    expect(filtered.nodes.some((node) => node.id === voiceNode.id)).toBe(true);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["edge-voice-visible"]);
    expect(canonicalNodeFields(filtered)).toEqual(
      canonicalNodeFields(source).filter((node) =>
        ["canonical-high", "x-evidence-high"].includes(node.entityId)
      )
    );
    expect(filteredNode.topVoiceScore).toBeUndefined();
    expect(filteredRow.topVoiceScore).toBeUndefined();
    expect(filteredNode.topVoiceConnectionCount).toBe(1);
    expect(filteredNode.topVoiceConnections).toBe(source.nodes.find((node) => node.entityId === "canonical-high")?.topVoiceConnections);
    expect(filteredRow.topVoiceConnections).toBe(source.leaderboard.find((row) => row.companyId === "canonical-high")?.topVoiceConnections);
    expect(filteredNode.topVoiceConnections).toEqual([connection]);
    expect(filteredNode.topVoiceConnections).not.toEqual([
      expect.objectContaining({ platforms: ["x"], topEvidenceId: "x-low" })
    ]);
    expect(filtered.scoringContext).toBe(source.scoringContext);
    expect(filtered.scoringContext).toMatchObject({ scoreScope: "all_platforms", selectedPlatforms: [] });
    expect(sourceCompanyRow.topVoiceScore).toBeUndefined();
  });
});

function canonicalGraph(): GraphResponse {
  const source = buildGraphResponse({ batchSlug: "S2026" }, platformScopeDataset());
  const responseBuiltAt = "2026-07-16T09:30:00.000Z";

  return {
    ...source,
    generatedAt: responseBuiltAt,
    scoringContext: {
      ...source.scoringContext!,
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt,
      evidenceAsOf: "2026-07-16T08:00:00.000Z"
    },
    edges: [
      graphEdge("edge-visible", "company:canonical-high", "company:x-evidence-high"),
      graphEdge("edge-hidden", "company:canonical-high", "company:github-only")
    ],
    fastestGaining: source.fastestGaining.map((row) => ({
      ...row,
      dod: { ...row.dod, benchmarkedAt: "2026-07-15T09:30:00.000Z" },
      wow: {
        ...row.wow,
        scoreDelta: row.wow.scoreDelta + 100,
        benchmarkedAt: "2026-07-09T09:30:00.000Z"
      }
    }))
  };
}

function platformScopeDataset(): DemoGraphDataset {
  return {
    mode: "demo",
    batches: [{ slug: "S2026", label: "Test batch", companyCountExpected: 3, companyCountObserved: 3 }],
    companies: [
      company({
        id: "canonical-high",
        name: "Canonical High",
        totalScore: 95,
        previousScore: 90,
        platformScores: { github: 95, x: 10 }
      }),
      company({
        id: "github-only",
        name: "GitHub Only",
        primaryIndustry: "consumer",
        industries: ["consumer"],
        totalScore: 60,
        previousScore: 40,
        platformScores: { github: 60 }
      }),
      company({
        id: "x-evidence-high",
        name: "X Evidence High",
        primaryIndustry: "consumer",
        industries: ["consumer"],
        totalScore: 5,
        previousScore: 4,
        platformScores: { x: 80 }
      })
    ],
    founders: [],
    evidence: [
      evidence({
        id: "x-low",
        entityId: "canonical-high",
        contributionScore: 20,
        thumbnailUrl: "https://images.example/x-low.jpg",
        metricsCheckedAt: "2026-07-13T12:00:00.000Z"
      }),
      evidence({
        id: "github-high",
        entityId: "canonical-high",
        platform: "github",
        sourceUrl: "https://github.com/example/canonical-high",
        contributionScore: 95,
        thumbnailUrl: "https://images.example/github-high.jpg",
        metricsCheckedAt: "2026-07-16T12:00:00.000Z"
      }),
      evidence({
        id: "github-only-evidence",
        entityId: "github-only",
        platform: "github",
        sourceUrl: "https://github.com/example/github-only",
        contributionScore: 60,
        metricsCheckedAt: "2026-07-15T12:00:00.000Z"
      }),
      evidence({
        id: "x-high",
        entityId: "x-evidence-high",
        contributionScore: 80,
        thumbnailUrl: "https://images.example/x-high.jpg",
        metricsCheckedAt: "2026-07-14T12:00:00.000Z"
      })
    ],
    needsReview: [
      reviewItem({ id: "review-x-high", entityId: "canonical-high", entityName: "Canonical High" }),
      reviewItem({
        id: "review-github-high",
        entityId: "canonical-high",
        entityName: "Canonical High",
        platform: "github"
      }),
      reviewItem({
        id: "review-hidden-x",
        entityId: "github-only",
        entityName: "GitHub Only"
      })
    ],
    platformStatus: []
  };
}

function company(overrides: Partial<CompanyRecord>): CompanyRecord {
  const base: CompanyRecord = {
    id: "company",
    batchSlug: "S2026",
    name: "Company",
    ycProfileUrl: "https://example.com/yc/company",
    websiteUrl: "https://example.com",
    tagline: "Tagline",
    description: "Description",
    groupPartner: null,
    primaryIndustry: "b2b",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://example.com/source",
    industries: ["b2b"],
    founderIds: [],
    socialAccounts: [],
    totalScore: 50,
    previousScore: 45,
    platformScores: {}
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    scoreBreakdown:
      overrides.scoreBreakdown ?? canonicalScoreBreakdown(merged.id, merged.totalScore, merged.platformScores)
  };
}

function canonicalScoreBreakdown(
  companyId: string,
  totalScore: number,
  platformScores: Partial<Record<Platform, number>>
): ScoreBreakdown {
  const weightedPlatforms = (Object.entries(platformScores) as [Platform, number][])
    .sort((left, right) => right[1] - left[1])
    .map(([platform, score]) => ({
      platform,
      score,
      configuredWeight: 1,
      appliedWeight: 1,
      contribution: score,
      evidenceCount: 1
    }));

  return {
    modelId: "canonical-test-score",
    modelVersion: "1.0.0",
    modelName: "Canonical test score",
    totalScore,
    absoluteScore: totalScore,
    weightedAvailableScore: totalScore,
    coverageFactor: 1,
    platformsWithEvidence: weightedPlatforms.length,
    totalSupportedPlatforms: 9,
    platformScores,
    weightedPlatforms,
    signalFamilyScores: {
      reach: totalScore,
      engagement: totalScore,
      developerAdoption: totalScore,
      launchAndCommunity: totalScore,
      momentum: totalScore
    },
    confidence: {
      level: "high",
      value: 1,
      reasons: [`canonical-${companyId}`],
      scoredEvidenceCount: weightedPlatforms.length,
      datedEvidenceCount: weightedPlatforms.length,
      verifiedLinkCount: weightedPlatforms.length
    },
    calibration: {
      method: "none",
      cohortSize: 3,
      percentile: null,
      inputScore: totalScore
    },
    limitations: [],
    evidenceAsOf: "2026-07-16T08:00:00.000Z",
    explanation: `Canonical score for ${companyId}.`
  };
}

function evidence(overrides: Partial<EvidenceItem>): EvidenceItem {
  return {
    id: "evidence",
    entityType: "company",
    entityId: "company",
    platform: "x",
    authorName: "Author",
    authorHandle: "author",
    postedAt: "2026-07-12T12:00:00.000Z",
    title: "Traction post",
    text: "Visible traction post.",
    mediaType: "text",
    metrics: { likes: 10 },
    contributionScore: 10,
    linkStatus: "verified",
    review_state: "verified",
    sourceUrl: "https://x.com/author/status/1",
    why: "Test evidence.",
    ...overrides
  };
}

function reviewItem(overrides: Partial<NeedsReviewItem>): NeedsReviewItem {
  return {
    id: "review",
    entityType: "company",
    entityId: "company",
    entityName: "Company",
    platform: "x",
    candidateUrl: "https://x.com/company",
    review_state: "needs_review",
    matchReason: "Candidate account",
    ...overrides
  };
}

function graphEdge(
  id: string,
  source: string,
  target: string
): GraphResponse["edges"][number] {
  return {
    id,
    source,
    target,
    edgeType: "industry_similarity",
    weight: 0.8,
    label: "Similarity",
    explanation: "Test edge."
  };
}

function topVoiceEdge(
  id: string,
  source: string,
  target: string
): GraphResponse["edges"][number] {
  return {
    id,
    source,
    target,
    edgeType: "top_voice_attention",
    weight: 1,
    label: "Attention",
    explanation: "Source Top Voice connection."
  };
}

function companyIds(graph: GraphResponse): string[] {
  return graph.nodes.filter((node) => node.entityType === "company").map((node) => node.entityId);
}

function canonicalNodeFields(graph: GraphResponse) {
  return graph.nodes
    .filter((node) => node.entityType === "company")
    .map((node) => ({
      entityId: node.entityId,
      score: node.score,
      previousScore: node.previousScore,
      scoreDelta: node.scoreDelta,
      radius: node.radius,
      topPlatform: node.topPlatform,
      platformScores: node.platformScores,
      scoreBreakdown: node.scoreBreakdown
    }));
}

function canonicalLeaderboardFields(graph: GraphResponse) {
  return graph.leaderboard.map((row) => ({
    companyId: row.companyId,
    rank: row.rank,
    score: row.score,
    topPlatform: row.topPlatform
  }));
}
