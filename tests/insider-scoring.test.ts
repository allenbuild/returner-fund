import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyInsiderScenarioScoring,
  computeInsiderScore
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
  it("sums unique matched weights once and preserves the base component", () => {
    const score = computeInsiderScore({
      baseScore: 20,
      connections: [
        connection("paul-graham", "Paul Graham", 5, 3),
        connection("ashton-kutcher", "Ashton Kutcher", 2, 2),
        connection("paul-graham", "Paul Graham", 5, 7)
      ]
    });
    expect(score.weightedInsiderSubtotal).toBe(7);
    expect(score.finalScore).toBe(27);
    expect(score.baseScore).toBe(20);
    expect(score.matches).toHaveLength(2);
  });

  it("uses all enabled insiders by default and only the selected subset when filtered", () => {
    const connections = [
      connection("paul-graham", "Paul Graham", 5),
      connection("ashton-kutcher", "Ashton Kutcher", 2)
    ];
    expect(computeInsiderScore({ baseScore: 10, connections }).weightedInsiderSubtotal).toBe(7);
    const selected = computeInsiderScore({
      baseScore: 10,
      connections,
      selectedInsiderIds: ["paul-graham"]
    });
    expect(selected.weightedInsiderSubtotal).toBe(5);
    expect(selected.finalScore).toBe(15);
    expect(selected.matches.find((match) => match.memberId === "ashton-kutcher"))
      .toMatchObject({ included: false, exclusionReason: "not_selected" });
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
      configurationVersion: 8
    });
    expect(scored.leaderboard.map((row) => [row.companyId, row.score, row.rank])).toEqual([
      ["beta", 24, 1],
      ["alpha", 15, 2]
    ]);
    expect(scored.nodes.find((node) => node.entityId === "alpha")?.insiderScoreBreakdown)
      .toMatchObject({ baseScore: 10, weightedInsiderSubtotal: 5, configurationVersion: 8 });
  });

  it("preserves every published Insider score with the default configuration", () => {
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
    fastestGaining: [],
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
