import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyInsiderScenarioScoring,
  computeInsiderScore,
  insiderWeightInfluence
} from "@/lib/graph/insider-scoring";
import { personalizeInsiderGraphSnapshot } from "@/lib/graph/personalized-insider-snapshot";
import type {
  EvidenceItem,
  GraphResponse,
  TopVoiceConnectionPreview
} from "@/lib/graph/types";
import {
  createAddedInsider,
  effectiveInsiderMembers,
  emptyInsiderConfiguration
} from "@/lib/social/user-insiders";
import {
  defaultInsiderMembers,
  matchEvidenceToTopVoice
} from "@/lib/social/top-voices";

describe("weighted Insider scoring", () => {
  it("sums unique quadratic influence once and preserves the published component", () => {
    const score = computeInsiderScore({
      baseScore: 20,
      connections: [
        connection("paul-graham", "Paul Graham", 5, 3),
        connection("ashton-kutcher", "Ashton Kutcher", 2, 2),
        connection("paul-graham", "Paul Graham", 5, 7)
      ]
    });
    expect(score.weightedInsiderSubtotal).toBe(29);
    expect(score.insiderScoreAdjustment).toBe(29);
    expect(score.finalScore).toBe(49);
    expect(score.baseScore).toBe(20);
    expect(score.matches).toHaveLength(2);
  });

  it("uses all enabled insiders by default and only the selected subset when filtered", () => {
    const connections = [
      connection("paul-graham", "Paul Graham", 5),
      connection("ashton-kutcher", "Ashton Kutcher", 2)
    ];
    expect(computeInsiderScore({ baseScore: 10, connections }).weightedInsiderSubtotal).toBe(29);
    const selected = computeInsiderScore({
      baseScore: 10,
      connections,
      selectedInsiderIds: ["paul-graham"]
    });
    expect(selected.weightedInsiderSubtotal).toBe(25);
    expect(selected.finalScore).toBe(35);
    expect(selected.matches.find((match) => match.memberId === "ashton-kutcher"))
      .toMatchObject({ included: false, exclusionReason: "not_selected" });
  });

  it("makes each lower Insider weight dramatically reduce an anchored score", () => {
    const published = connection("paul-graham", "Paul Graham", 5);
    const results = [5, 4, 3, 2, 1].map((weight) => computeInsiderScore({
      baseScore: 100,
      publishedConnections: [published],
      connections: [connection("paul-graham", "Paul Graham", weight)]
    }));

    expect(results.map((result) => result.finalScore)).toEqual([100, 91, 84, 79, 76]);
    expect(results.map((result) => result.insiderScoreAdjustment)).toEqual([0, -9, -16, -21, -24]);
    expect([1, 2, 3, 4, 5].map(insiderWeightInfluence)).toEqual([1, 4, 9, 16, 25]);
  });

  it("disabled and removed identities contribute zero while their stored configuration remains", () => {
    const custom = createAddedInsider({ displayName: "Historical Match", handles: {}, weight: 4 });
    const configuration = {
      ...emptyInsiderConfiguration(),
      excludedDefaultIds: ["paul-graham"],
      addedInsiders: [{ ...custom, active: false }]
    };
    const effective = effectiveInsiderMembers(configuration);
    expect(effective.some((member) => member.personId === "paul-graham")).toBe(false);
    expect(effective.some((member) => member.personId === custom.personId)).toBe(false);
    expect(configuration.addedInsiders).toEqual([
      expect.objectContaining({ personId: custom.personId, active: false })
    ]);
  });

  it("normalizes Phillip Johnston evidence to canonical Philip Johnston", () => {
    const match = matchEvidenceToTopVoice(
      evidence({ authorName: "Phillip Johnston", authorHandle: null }),
      "insiders",
      defaultInsiderMembers()
    );
    expect(match?.member).toMatchObject({
      personId: "philip-johnston",
      displayName: "Philip Johnston",
      weight: 2
    });
  });

  it("new identities dynamically match stored evidence without report regeneration", () => {
    const member = createAddedInsider({
      displayName: "Stored Evidence Person",
      handles: { x: ["stored_person"] },
      weight: 3
    });
    const match = matchEvidenceToTopVoice(
      evidence({ authorName: "Stored Evidence Person", authorHandle: "stored_person" }),
      "insiders",
      [member]
    );
    expect(match?.member.personId).toBe(member.personId);
    expect(match?.member.weight).toBe(3);
  });

  it("re-sorts and tie-ranks every score surface from the effective score", () => {
    const graph = graphFixture();
    const scored = applyInsiderScenarioScoring(graph, {
      configurationVersion: 8,
      publishedInsiderGraph: {
        ...graph,
        nodes: graph.nodes.map((node) => ({ ...node, topVoiceConnections: [] }))
      }
    });
    expect(scored.leaderboard.map((row) => [row.companyId, row.score, row.rank])).toEqual([
      ["beta", 36, 1],
      ["alpha", 35, 2]
    ]);
    expect(scored.fastestGaining).toEqual([
      expect.objectContaining({
        rank: 1,
        companyId: "alpha",
        dod: expect.objectContaining({
          currentScore: 35,
          currentRank: 2,
          baselineScore: 8,
          baselineRank: 1,
          scoreDelta: 27,
          percentDelta: 337.5,
          rankDelta: -1
        }),
        wow: expect.objectContaining({
          currentScore: 35,
          currentRank: 2,
          baselineScore: 10,
          baselineRank: 2,
          scoreDelta: 25,
          percentDelta: 250,
          rankDelta: 0
        })
      }),
      expect.objectContaining({
        rank: 2,
        companyId: "beta",
        dod: expect.objectContaining({
          currentScore: 36,
          currentRank: 1,
          baselineScore: 23,
          baselineRank: 2,
          scoreDelta: 13,
          percentDelta: 56.52,
          rankDelta: 1
        })
      })
    ]);
    expect(scored.nodes.find((node) => node.entityId === "alpha")?.insiderScoreBreakdown)
      .toMatchObject({
        baseScore: 10,
        publishedInsiderInfluence: 0,
        weightedInsiderSubtotal: 25,
        insiderScoreAdjustment: 25,
        configurationVersion: 8
      });
  });

  it("treats the current graph as the published anchor when no separate anchor is supplied", () => {
    const graph = graphFixture();
    const scored = applyInsiderScenarioScoring(graph);

    expect(scored.leaderboard.map((row) => [row.companyId, row.score])).toEqual(
      graph.leaderboard.map((row) => [row.companyId, row.score])
    );
    expect(scored.nodes.map((node) => [node.entityId, node.score])).toEqual(
      graph.nodes.map((node) => [node.entityId, node.score])
    );
  });

  it("preserves every published Insider node and leaderboard score with the default configuration", () => {
    for (const [baseFilename, insiderFilename] of [
      ["a16zsr006.json", "a16zsr006-insiders.json"],
      ["s2026.json", "s2026-insiders.json"],
      ["s26.json", "s26-insiders.json"]
    ]) {
      const baseGraph = publicGraphFixture(baseFilename);
      const insiderGraph = publicGraphFixture(insiderFilename);
      const personalized = personalizeInsiderGraphSnapshot({
        baseGraph,
        insiderGraph,
        configuration: emptyInsiderConfiguration()
      });
      const publishedNodeScores = new Map(
        insiderGraph.nodes
          .filter((node) => node.entityType === "company")
          .map((node) => [node.entityId, node.score] as const)
      );
      const publishedLeaderboardScores = new Map(
        insiderGraph.leaderboard.map((row) => [row.companyId, row.score] as const)
      );

      const personalizedCompanyNodes = personalized.nodes.filter(
        (node) => node.entityType === "company"
      );
      expect(personalizedCompanyNodes).toHaveLength(publishedNodeScores.size);
      for (const node of personalizedCompanyNodes) {
        expect(node.score, `${insiderFilename}:${node.entityId}:node`).toBe(
          publishedNodeScores.get(node.entityId)
        );
      }
      expect(personalized.leaderboard).toHaveLength(publishedLeaderboardScores.size);
      for (const row of personalized.leaderboard) {
        expect(row.score, `${insiderFilename}:${row.companyId}:leaderboard`).toBe(
          publishedLeaderboardScores.get(row.companyId)
        );
      }
    }
  });

  it("applies the quadratic decrease to every affected company in every published batch", () => {
    for (const [baseFilename, insiderFilename] of [
      ["a16zsr006.json", "a16zsr006-insiders.json"],
      ["s2026.json", "s2026-insiders.json"],
      ["s26.json", "s26-insiders.json"]
    ]) {
      const baseGraph = publicGraphFixture(baseFilename);
      const insiderGraph = publicGraphFixture(insiderFilename);
      const candidate = insiderGraph.nodes
        .flatMap((node) => node.topVoiceConnections ?? [])
        .find((connection) => connection.weight > 1);
      if (!candidate) {
        expect(insiderGraph.nodes.filter((node) => node.entityType === "company")).toHaveLength(0);
        continue;
      }
      const loweredWeight = candidate.weight - 1;
      const personalized = personalizeInsiderGraphSnapshot({
        baseGraph,
        insiderGraph,
        configuration: {
          ...emptyInsiderConfiguration(),
          version: 1,
          weightOverrides: { [candidate.memberId]: loweredWeight }
        }
      });
      const expectedDrop = insiderWeightInfluence(candidate.weight) - insiderWeightInfluence(loweredWeight);

      for (const publishedNode of insiderGraph.nodes.filter((node) => node.entityType === "company")) {
        const personalizedNode = personalized.nodes.find((node) => node.entityId === publishedNode.entityId);
        const affected = publishedNode.topVoiceConnections?.some(
          (connection) => connection.memberId === candidate.memberId
        );
        expect(personalizedNode?.score, `${insiderFilename}:${publishedNode.entityId}`).toBe(
          affected ? Math.max(0, publishedNode.score - expectedDrop) : publishedNode.score
        );
        expect(
          personalized.leaderboard.find((row) => row.companyId === publishedNode.entityId)?.score
        ).toBe(personalizedNode?.score);
      }
    }
  });
});

function connection(
  memberId: string,
  displayName: string,
  weight: number,
  evidenceCount = 1
): TopVoiceConnectionPreview {
  return {
    memberId,
    displayName,
    weight,
    category: "insider",
    contributionScore: 1,
    evidenceCount,
    topEvidenceId: null,
    platforms: ["x"]
  };
}

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "stored-evidence",
    entityType: "company",
    entityId: "company",
    platform: "x",
    authorName: "Author",
    authorHandle: "author",
    postedAt: "2026-07-20T00:00:00.000Z",
    text: "Stored post-level evidence",
    mediaType: "text",
    metrics: { likes: 10 },
    contributionScore: 1,
    sourceUrl: "https://x.com/author/status/1234567890123456789",
    why: "Stored evidence.",
    ...overrides
  };
}

function graphFixture(): GraphResponse {
  const node = (id: string, score: number, insider: TopVoiceConnectionPreview) => ({
    id: `company:${id}`,
    entityType: "company" as const,
    entityId: id,
    label: id,
    batchSlug: "S2026",
    score,
    previousScore: score,
    scoreDelta: 0,
    radius: 10,
    topPlatform: "x" as const,
    platformScores: { x: score },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl: "",
    websiteUrl: "",
    tagline: "",
    description: "",
    groupPartner: null,
    primaryIndustry: "B2B",
    businessModel: "b2b" as const,
    review_state: "verified" as const,
    sourceUrl: "",
    visual: {
      industryColor: "#fff",
      shape: "ellipse" as const,
      borderStyle: "solid" as const,
      borderColor: "#000",
      groupRegion: null
    },
    industries: [],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 0, needs_review: 0, rejected: 0 },
    topVoiceConnections: [insider]
  });
  const alphaConnection = connection("paul-graham", "Paul Graham", 5);
  const betaConnection = connection("sam-altman", "Sam Altman", 4);
  return {
    batch: { slug: "S2026", label: "S2026" },
    batches: [{ slug: "S2026", label: "S2026" }],
    nodes: [node("alpha", 10, alphaConnection), node("beta", 20, betaConnection)],
    edges: [],
    leaderboard: [
      {
        rank: 1,
        companyId: "beta",
        companyName: "beta",
        score: 20,
        topPlatform: "x",
        socialAccounts: [],
        biggestContribution: null,
        topVoiceConnections: [betaConnection]
      },
      {
        rank: 2,
        companyId: "alpha",
        companyName: "alpha",
        score: 10,
        topPlatform: "x",
        socialAccounts: [],
        biggestContribution: null,
        topVoiceConnections: [alphaConnection]
      }
    ],
    fastestGaining: [
      {
        rank: 1,
        companyId: "beta",
        companyName: "beta",
        dod: momentum(20, 1, 23, 2),
        wow: momentum(20, 1, 20, 1)
      },
      {
        rank: 2,
        companyId: "alpha",
        companyName: "alpha",
        dod: momentum(10, 2, 8, 1),
        wow: momentum(10, 2, 10, 2)
      }
    ],
    needsReview: [],
    evidence: [],
    platformStatus: [],
    selectedTopVoiceAudience: {
      id: "insiders",
      displayName: "Insiders",
      description: "",
      helperText: "",
      scoreLabel: "",
      scoreDescription: "",
      active: true,
      memberCount: 2
    },
    topVoiceAudiences: [],
    generatedAt: "2026-07-23T00:00:00.000Z",
    mode: "demo"
  };
}

function publicGraphFixture(filename: string): GraphResponse {
  return JSON.parse(
    readFileSync(join(process.cwd(), "public", "graph", filename), "utf8")
  ) as GraphResponse;
}

function momentum(
  currentScore: number,
  currentRank: number,
  baselineScore: number | null,
  baselineRank: number | null
) {
  const scoreDelta = baselineScore === null ? 0 : currentScore - baselineScore;
  return {
    scoreDelta,
    percentDelta: baselineScore === null ? 0 : (scoreDelta / Math.max(baselineScore, 1)) * 100,
    rankDelta: baselineRank === null ? 0 : baselineRank - currentRank,
    currentScore,
    currentRank,
    baselineScore,
    baselineRank,
    benchmarkedAt: "2026-07-22T00:00:00.000Z"
  };
}
