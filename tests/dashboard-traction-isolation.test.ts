import { describe, expect, it } from "vitest";

import { buildDashboardSnapshot } from "@/lib/dashboard/pipeline";
import { dashboardCandidatesFromGraph } from "@/lib/dashboard/returner-candidates";
import { selectRankedPosts } from "@/lib/graph/ranked-posts";
import type { EvidenceItem, GraphNode, GraphResponse } from "@/lib/graph/types";

const NOW = new Date("2026-08-31T18:00:00.000Z");

describe("editorial scoring isolation", () => {
  it("keeps Top 100 and Ranked Posts results stable when only company traction aggregates change", () => {
    const v42 = graphFixture("4.2.0", {
      "company-graphify": { score: 79, platformScores: { github: 85, x: 81 } },
      "company-screenpipe": { score: 100, platformScores: { github: 91, x: 80 } }
    });
    const v43 = graphFixture("4.3.0", {
      "company-graphify": { score: 95, platformScores: { github: 95, x: 83 } },
      "company-screenpipe": { score: 84, platformScores: { github: 83, x: 82 } }
    });

    expect(v43.scoringContext).not.toEqual(v42.scoringContext);
    expect(v43.nodes.map((node) => [node.entityId, node.score, node.platformScores]))
      .not.toEqual(v42.nodes.map((node) => [node.entityId, node.score, node.platformScores]));

    const v42Results = editorialResults(v42);
    const v43Results = editorialResults(v43);

    expect(v43Results).toEqual(v42Results);
    expect(v43Results.top100.map(({ sourceIds }) => sourceIds)).toEqual([
      ["returner:S26:graphify-post"],
      ["returner:S26:screenpipe-post"]
    ]);
    expect(v43Results.rankedPosts).toEqual([
      { evidenceId: "graphify-post", rank: 1 },
      { evidenceId: "screenpipe-post", rank: 2 }
    ]);
  });
});

function editorialResults(graph: GraphResponse) {
  const snapshot = buildDashboardSnapshot(dashboardCandidatesFromGraph(graph), { now: NOW }).snapshot;
  return {
    top100: snapshot.stories.map((story) => ({
      rank: story.rank,
      trendScore: story.trendScore,
      sourceIds: story.sources.map((source) => source.id)
    })),
    rankedPosts: selectRankedPosts(graph, { period: "all_time" }).map((post) => ({
      evidenceId: post.evidence.id,
      rank: post.rank
    }))
  };
}

function graphFixture(
  modelVersion: "4.2.0" | "4.3.0",
  scores: Record<string, Pick<GraphNode, "score" | "platformScores">>
): GraphResponse {
  const evidence = [
    socialEvidence({
      id: "graphify-post",
      companyId: "company-graphify",
      companyName: "Graphify Labs",
      handle: "graphifylabs",
      platformPostId: "1001",
      postedAt: "2026-08-31T12:00:00.000Z",
      metrics: { views: 1_200_000, likes: 1_000, reposts: 100 },
      contributionScore: 83
    }),
    socialEvidence({
      id: "screenpipe-post",
      companyId: "company-screenpipe",
      companyName: "screenpipe",
      handle: "screenpipe",
      platformPostId: "1002",
      postedAt: "2026-08-31T10:00:00.000Z",
      metrics: { views: 1_000_000, likes: 500, reposts: 50 },
      contributionScore: 82
    })
  ];
  const nodes = evidence.map((item) => companyNode(
    item.attachedCompanyId!,
    item.attachedCompanyName!,
    item.id,
    scores[item.attachedCompanyId!]!
  ));

  return {
    batch: { slug: "S26", label: "YC Summer 2026" },
    batches: [{ slug: "S26", label: "YC Summer 2026" }],
    nodes,
    edges: [],
    leaderboard: [],
    fastestGaining: [],
    needsReview: [],
    evidence,
    platformStatus: [],
    selectedTopVoiceAudience: audience(),
    topVoiceAudiences: [audience()],
    generatedAt: NOW.toISOString(),
    scoringContext: {
      modelId: "returner-traction",
      modelVersion,
      modelName: modelVersion === "4.3.0"
        ? "returner-traction-v4-bounded-primary-signal-global-best"
        : "returner-traction-v4-absolute-fixed-platform-global-best",
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: NOW.toISOString(),
      evidenceAsOf: NOW.toISOString()
    },
    mode: "official_snapshot"
  };
}

function socialEvidence(input: {
  id: string;
  companyId: string;
  companyName: string;
  handle: string;
  platformPostId: string;
  postedAt: string;
  metrics: EvidenceItem["metrics"];
  contributionScore: number;
}): EvidenceItem {
  return {
    id: input.id,
    batchSlug: "S26",
    entityType: "company",
    entityId: input.companyId,
    platform: "x",
    authorName: input.companyName,
    authorHandle: input.handle,
    postedAt: input.postedAt,
    publishedAtPrecision: "exact",
    title: `${input.companyName} launches an AI developer platform`,
    text: `${input.companyName} launches an AI developer platform for software teams.`,
    mediaType: "video",
    metrics: input.metrics,
    contributionScore: input.contributionScore,
    normalizedScore: input.contributionScore,
    tractionStatus: "scored",
    sourceUrl: `https://x.com/${input.handle}/status/${input.platformPostId}`,
    platformPostId: input.platformPostId,
    attachedCompanyId: input.companyId,
    attachedCompanyName: input.companyName,
    review_state: "verified",
    linkStatus: "verified",
    topics: ["product-launch"],
    why: "Verified native social evidence."
  };
}

function companyNode(
  companyId: string,
  companyName: string,
  evidenceId: string,
  score: Pick<GraphNode, "score" | "platformScores">
): GraphNode {
  return {
    id: `company:${companyId}`,
    entityType: "company",
    entityId: companyId,
    label: companyName,
    batchSlug: "S26",
    score: score.score,
    previousScore: score.score,
    scoreDelta: 0,
    radius: 20,
    topPlatform: "github",
    platformScores: score.platformScores,
    socialAccounts: [],
    evidenceIds: [evidenceId],
    ycProfileUrl: `https://www.ycombinator.com/companies/${companyId.replace(/^company-/, "")}`,
    websiteUrl: `https://${companyId.replace(/^company-/, "")}.example.com`,
    tagline: "AI developer tooling",
    description: "AI developer tooling company",
    groupPartner: null,
    primaryIndustry: "b2b",
    businessModel: "developer_tools",
    review_state: "verified",
    sourceUrl: `https://www.ycombinator.com/companies/${companyId.replace(/^company-/, "")}`,
    visual: {
      industryColor: "#ffffff",
      shape: "ellipse",
      borderStyle: "solid",
      borderColor: "#000000",
      groupRegion: null
    },
    industries: ["b2b"],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 1, needs_review: 0, rejected: 0 }
  };
}

function audience() {
  return {
    id: "off" as const,
    displayName: "All voices",
    description: "All evidence",
    helperText: "All evidence",
    scoreLabel: "Traction score",
    scoreDescription: "Canonical score",
    active: true,
    memberCount: 0
  };
}
