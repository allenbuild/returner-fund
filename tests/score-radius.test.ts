import { describe, expect, it } from "vitest";
import { applyInsiderScenarioScoring, computeInsiderScore } from "@/lib/graph/insider-scoring";
import { getNodeRadius } from "@/lib/graph/score-radius";
import type { GraphResponse } from "@/lib/graph/types";

describe("global score radius", () => {
  it("gives the same headline score the same radius across peer distributions", () => {
    expect(getNodeRadius(0, [90, 100], "company")).toBe(5);
    expect(getNodeRadius(100, [0, 10], "company")).toBe(68);
    expect(getNodeRadius(0, [90, 100], "founder")).toBe(4);
    expect(getNodeRadius(100, [0, 10], "founder")).toBe(38);
    expect(getNodeRadius(55, [50, 55, 60], "company")).toBe(
      getNodeRadius(55, [0, 10, 100], "company")
    );
    expect(getNodeRadius(55, [50, 55, 60], "founder")).toBe(
      getNodeRadius(55, [0, 10, 100], "founder")
    );
  });

  it("uses the same absolute radius mapping after Insider scenario scoring", () => {
    const graph = {
      selectedTopVoiceAudience: { id: "insiders" },
      nodes: [companyNode("low", 10), companyNode("middle", 55)],
      leaderboard: [
        { rank: 1, companyId: "middle", companyName: "middle", score: 55 },
        { rank: 2, companyId: "low", companyName: "low", score: 10 }
      ],
      fastestGaining: []
    } as unknown as GraphResponse;

    const scored = applyInsiderScenarioScoring(graph);
    for (const node of scored.nodes) {
      expect(node.radius).toBe(getNodeRadius(node.score, [], "company"));
    }
    expect(scored.nodes.find((node) => node.entityId === "middle")?.radius).toBeLessThan(68);
  });

  it("retains the dramatic quadratic decrease when an Insider weight is lowered", () => {
    const publishedConnection = insiderConnection(5);
    const results = [5, 4, 3, 2, 1].map((weight) => computeInsiderScore({
      baseScore: 100,
      publishedConnections: [publishedConnection],
      connections: [insiderConnection(weight)]
    }));

    expect(results.map((result) => result.finalScore)).toEqual([100, 91, 84, 79, 76]);
    expect(results.map((result) => result.insiderScoreAdjustment)).toEqual([0, -9, -16, -21, -24]);
  });
});

function companyNode(entityId: string, score: number) {
  return {
    id: `company:${entityId}`,
    entityId,
    entityType: "company" as const,
    label: entityId,
    score,
    previousScore: score,
    radius: 0,
    topVoiceConnections: []
  };
}

function insiderConnection(weight: number) {
  return {
    memberId: "insider-1",
    displayName: "Insider One",
    category: "operator",
    weight,
    contributionScore: 1,
    evidenceCount: 1,
    topEvidenceId: "evidence-1",
    platforms: ["x" as const]
  };
}
