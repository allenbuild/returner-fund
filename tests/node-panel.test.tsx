import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NodePanel } from "@/components/NodePanel";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { TOP_POSTS_LIMIT } from "@/lib/graph/presentation-limits";
import type { EvidenceItem, GraphNode, Platform, WeightedPlatformScore } from "@/lib/graph/types";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("NodePanel", () => {
  it("keeps the score in the header and shows platform contributions", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    render(<NodePanel node={node!} relatedNodes={[]} evidence={selectedNodeEvidence(graph, node!)} />);

    expect(screen.getByLabelText(`Score ${node!.score}`)).toBeInTheDocument();
    expect(document.querySelector(".node-panel-header p")).not.toBeInTheDocument();
    expect(document.querySelector(".founder-chip-list")).toHaveTextContent("Michael Jeffords");
    expect(screen.getByRole("heading", { name: "Platform contributions" })).toBeVisible();
    expect(document.querySelector(".node-panel details")).not.toBeInTheDocument();
    expect(document.querySelector(".node-panel summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/platforms with scored evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/company evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/founder evidence/i)).not.toBeInTheDocument();
  });

  it("shows every positive platform contribution in descending order", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    const explainableNode: GraphNode = {
      ...node!,
      score: 87,
      scoreBreakdown: {
        modelId: "traction-v2",
        modelVersion: "2.1.0",
        modelName: "Traction Model",
        totalScore: 87,
        absoluteScore: 46,
        weightedAvailableScore: 71.4,
        coverageFactor: 0.94,
        platformsWithEvidence: 4,
        totalSupportedPlatforms: 11,
        platformScores: { github: 72, x: 61, linkedin: 48, instagram: 32 },
        weightedPlatforms: [
          { platform: "x", score: 61, configuredWeight: 0.25, appliedWeight: 0.25, contribution: 8.2, evidenceCount: 6 },
          { platform: "youtube", score: 0, configuredWeight: 0.05, appliedWeight: 0.05, contribution: 0, evidenceCount: 1 },
          { platform: "instagram", score: 32, configuredWeight: 0.1, appliedWeight: 0.1, contribution: 3.1, evidenceCount: 2 },
          { platform: "github", score: 72, configuredWeight: 0.35, appliedWeight: 0.35, contribution: 12.4, evidenceCount: 7 },
          { platform: "linkedin", score: 48, configuredWeight: 0.15, appliedWeight: 0.15, contribution: 5.6, evidenceCount: 3 },
          { platform: "reddit", score: 0, configuredWeight: 0.05, appliedWeight: 0.05, contribution: -1.2, evidenceCount: 4 }
        ],
        signalFamilyScores: {
          reach: 68,
          engagement: 74,
          developerAdoption: 81,
          launchAndCommunity: 59,
          momentum: 63
        },
        confidence: {
          level: "high",
          value: 0.88,
          reasons: ["Broad verified coverage."],
          scoredEvidenceCount: 18,
          datedEvidenceCount: 16,
          verifiedLinkCount: 14
        },
        calibration: { method: "none", cohortSize: 83, percentile: null, inputScore: 46 },
        limitations: [
          "Private community activity is not included.",
          "LinkedIn engagement may be undercounted."
        ],
        evidenceAsOf: "2026-07-15T20:30:00.000Z",
        explanation: "Calibrated against the selected cohort."
      }
    };

    render(
      <NodePanel
        node={explainableNode}
        relatedNodes={[]}
        evidence={selectedNodeEvidence(graph, node!)}
      />
    );

    const section = screen.getByRole("heading", { name: "Platform contributions" }).closest("section");
    const contributionRows = [...section!.querySelectorAll(".score-platform-contributions li")];

    expect(contributionRows).toHaveLength(4);
    expect(
      contributionRows.map((row) => row.querySelector(".platform-identity > span")?.textContent)
    ).toEqual(["GitHub", "X", "LinkedIn", "Instagram"]);
    [
      ["12.4 pts", "7 items"],
      ["8.2 pts", "6 items"],
      ["5.6 pts", "3 items"],
      ["3.1 pts", "2 items"]
    ].forEach(([points, count], index) => {
      expect(contributionRows[index]).toHaveTextContent(points);
      expect(contributionRows[index]).toHaveTextContent(count);
    });
    const displayedTotal = contributionRows.reduce((sum, row) => {
      const value = Number.parseFloat(row.querySelector("strong")?.textContent ?? "0");
      return sum + value;
    }, 0);
    expect(displayedTotal).toBeCloseTo(29.3, 5);
    expect(within(section!).queryByText("YouTube")).not.toBeInTheDocument();
    expect(within(section!).queryByText("Reddit")).not.toBeInTheDocument();

    expect(document.querySelector(".node-panel details")).not.toBeInTheDocument();
    expect(document.querySelector(".node-panel summary")).not.toBeInTheDocument();
    expect(document.querySelector(".score-explainer-chevron")).not.toBeInTheDocument();
    expect(document.querySelector(".score-explainer-facts")).not.toBeInTheDocument();
    expect(screen.queryByText("How this score works")).not.toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("Traction Model v2.1.0")).not.toBeInTheDocument();
    expect(screen.queryByText("Confidence")).not.toBeInTheDocument();
    expect(screen.queryByText("High confidence")).not.toBeInTheDocument();
    expect(screen.queryByText("Scored evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("Score comparison")).not.toBeInTheDocument();
    expect(screen.queryByText(/positive platform rows shown/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Evidence as of")).not.toBeInTheDocument();
    expect(screen.queryByText("Jul 15, 2026")).not.toBeInTheDocument();
    expect(screen.queryByText("Limitations")).not.toBeInTheDocument();
    expect(screen.queryByText("Private community activity is not included.")).not.toBeInTheDocument();
    expect(screen.queryByText("LinkedIn engagement may be undercounted.")).not.toBeInTheDocument();
  });

  it("keeps legacy platform contributions visible when newer score fields are missing", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    const legacyScoreBreakdown = {
      totalScore: node!.score,
      weightedAvailableScore: 42,
      coverageFactor: 0.9,
      platformsWithEvidence: 1,
      totalSupportedPlatforms: 11,
      platformScores: { github: 42 },
      weightedPlatforms: [
        { platform: "github", score: 42, configuredWeight: 0.35, appliedWeight: 0.35, contribution: 9.5, evidenceCount: 2 }
      ],
      explanation: "Legacy snapshot score."
    } as unknown as NonNullable<GraphNode["scoreBreakdown"]>;

    render(
      <NodePanel
        node={{ ...node!, scoreBreakdown: legacyScoreBreakdown }}
        relatedNodes={[]}
        evidence={[]}
      />
    );

    const section = screen.getByRole("heading", { name: "Platform contributions" }).closest("section");
    expect(section).toHaveTextContent("GitHub");
    expect(section).toHaveTextContent("9.5 pts");
    expect(section).toHaveTextContent("2 items");
    expect(section).not.toHaveTextContent("undefined");
    expect(section).not.toHaveTextContent(/raw score/i);
    expect(document.querySelector(".node-panel details")).not.toBeInTheDocument();
  });

  it("applies global calibration to each individual platform contribution", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    const calibratedNode: GraphNode = {
      ...node!,
      score: 87,
      topPlatform: "instagram",
      platformScores: { instagram: 48 },
      scoreBreakdown: {
        ...node!.scoreBreakdown!,
        totalScore: 87,
        absoluteScore: 46,
        weightedAvailableScore: 48,
        coverageFactor: 0.21,
        platformsWithEvidence: 1,
        platformScores: { instagram: 48 },
        weightedPlatforms: [weightedPlatformFixture("instagram", 48, 63, true)],
        calibration: {
          method: "global_best_ratio",
          cohortSize: 423,
          percentile: null,
          inputScore: 46,
          benchmarkScore: 53,
          scaleFactor: 100 / 53,
          benchmarkScope: "all_supported_batches",
          benchmarkPopulation: "current_company_snapshot"
        },
        explanation: "SCORING EXPLANATION MUST NOT RENDER IN NODEPANEL"
      }
    };

    render(<NodePanel node={calibratedNode} relatedNodes={[]} evidence={[]} />);

    const section = screen.getByRole("heading", { name: "Platform contributions" }).closest("section");
    expect(section).toHaveTextContent("87.0 pts");
    expect(section).not.toHaveTextContent("46.1 pts");
  });

  it("reconciles calibrated platform rows to the published base score", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    const calibratedNode: GraphNode = {
      ...node!,
      score: 87,
      topPlatform: "youtube",
      platformScores: { instagram: 47, x: 52, linkedin: 52, youtube: 69 },
      scoreBreakdown: {
        ...node!.scoreBreakdown!,
        totalScore: 87,
        absoluteScore: 67,
        weightedAvailableScore: 35.49 / 0.67,
        coverageFactor: 0.67,
        platformsWithEvidence: 4,
        platformScores: { instagram: 47, x: 52, linkedin: 52, youtube: 69 },
        weightedPlatforms: [
          weightedPlatformFixture("youtube", 69, 20, true),
          weightedPlatformFixture("x", 52, 20),
          weightedPlatformFixture("instagram", 47, 63),
          weightedPlatformFixture("linkedin", 52, 11),
        ],
        calibration: {
          method: "global_best_ratio",
          cohortSize: 423,
          percentile: null,
          inputScore: 67,
          benchmarkScore: 77,
          scaleFactor: 100 / 77,
          benchmarkScope: "all_supported_batches",
          benchmarkPopulation: "current_company_snapshot"
        },
        explanation: "SCORING EXPLANATION MUST NOT RENDER IN NODEPANEL"
      }
    };

    render(<NodePanel node={calibratedNode} relatedNodes={[]} evidence={[]} />);

    const section = screen.getByRole("heading", { name: "Platform contributions" }).closest("section");
    const contributionRows = [...section!.querySelectorAll(".score-platform-contributions li")];
    const displayedTenths = contributionRows.reduce((sum, row) => {
      const value = Number.parseFloat(row.querySelector("strong")?.textContent ?? "0");
      return sum + Math.round(value * 10);
    }, 0);
    expect(contributionRows).toHaveLength(4);
    expect(
      contributionRows.map((row) => row.querySelector("strong")?.textContent)
    ).toEqual(["85.6 pts", "0.8 pts", "0.5 pts", "0.1 pts"]);
    expect(displayedTenths).toBe(870);
    expect(screen.queryByText("SCORING EXPLANATION MUST NOT RENDER IN NODEPANEL")).not.toBeInTheDocument();
    expect(screen.queryByText(/global calibration|multiplier|rounding residual/i)).not.toBeInTheDocument();
  });

  it("keeps contributions unscaled when no global calibration is applied", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    const noCalibrationNode: GraphNode = {
      ...node!,
      score: 67,
      scoreBreakdown: {
        ...node!.scoreBreakdown!,
        totalScore: 67,
        absoluteScore: 67,
        calibration: { method: "none", cohortSize: 1, percentile: null, inputScore: 67 }
      }
    };

    render(<NodePanel node={noCalibrationNode} relatedNodes={[]} evidence={[]} />);

    const section = screen.getByRole("heading", { name: "Platform contributions" }).closest("section");
    const displayed = [...section!.querySelectorAll(".score-platform-contributions li strong")]
      .map((row) => row.textContent);
    const expected = [...noCalibrationNode.scoreBreakdown!.weightedPlatforms]
      .filter((row) => Number.isFinite(row.contribution) && row.contribution > 0)
      .sort(
        (left, right) =>
          right.contribution - left.contribution || left.platform.localeCompare(right.platform)
      )
      .map((row) => `${new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      }).format(row.contribution)} pts`);
    expect(displayed).toEqual(expected);
    expect(screen.queryByText(/global calibration/i)).not.toBeInTheDocument();
  });

  it("keeps the Insider adjustment separate from the calibrated platform base without an explainer", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    const insiderScoreBreakdown = {
      baseScore: 100,
      publishedInsiderInfluence: 25,
      weightedInsiderSubtotal: 1,
      insiderScoreAdjustment: -24,
      finalScore: 76,
      selectedInsiderIds: [],
      configurationVersion: 3,
      matches: [{
        memberId: "paul-graham",
        displayName: "Paul Graham",
        effectiveWeight: 1,
        evidenceCount: 3,
        included: true,
        exclusionReason: null,
        influenceScore: 1,
        publishedWeight: 5,
        publishedInfluenceScore: 25,
        adjustment: -24
      }],
      formula: "published_score_plus_quadratic_insider_adjustments_capped_0_100"
    } satisfies NonNullable<GraphNode["insiderScoreBreakdown"]>;

    render(
      <NodePanel
        node={{ ...node!, score: 76, insiderScoreBreakdown }}
        relatedNodes={[]}
        evidence={[]}
      />
    );

    const section = screen.getByRole("heading", { name: "Insider adjustment" }).closest("section");
    expect(screen.getByLabelText("Score 76")).toBeInTheDocument();
    expect(section).toHaveTextContent("−24 pts");
    expect(section).not.toHaveTextContent("Published score");
    expect(section).not.toHaveTextContent("Each matched insider");
    expect(section).not.toHaveTextContent("Published influence");
    expect(section).not.toHaveTextContent("Paul Graham");
    expect(section).not.toHaveTextContent("Weight 1²");
    const platformSection = screen.getByRole("heading", { name: "Platform contributions" }).closest("section");
    const displayedBaseTenths = [...platformSection!.querySelectorAll(".score-platform-contributions li strong")]
      .reduce((sum, row) => sum + Math.round(Number.parseFloat(row.textContent ?? "0") * 10), 0);
    expect(displayedBaseTenths).toBe(1_000);
    expect(
      displayedBaseTenths + Math.round(insiderScoreBreakdown.insiderScoreAdjustment * 10)
    ).toBe(Math.round(76 * 10));
  });

  it("counts and renders only evidence that contributes to the score", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");
    const scoredEvidence = node
      ? selectedNodeEvidence(graph, node).find((item) => item.contributionScore > 0)
      : undefined;

    expect(node).toBeDefined();
    expect(scoredEvidence).toBeDefined();
    const unscoredEvidence: EvidenceItem = {
      ...scoredEvidence!,
      id: "unscored-evidence",
      title: "Unscored evidence should stay out of Top Posts",
      text: "Unscored evidence should stay out of Top Posts.",
      contributionScore: 0,
      normalizedScore: 0,
      tractionStatus: "unscored",
      sourceUrl: "https://example.com/unscored-evidence",
      platformPostId: "unscored-evidence"
    };

    render(
      <NodePanel
        node={{ ...node!, scoreBreakdown: undefined }}
        relatedNodes={[]}
        evidence={[scoredEvidence!, unscoredEvidence]}
      />
    );

    const topPosts = screen.getByRole("heading", { name: "Top Posts" }).closest("section");
    expect(within(topPosts!).getByText("1/50")).toBeInTheDocument();
    expect(screen.queryByText("Unscored evidence should stay out of Top Posts")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Platform contributions" }).closest("section")).toHaveTextContent(
      "No positive contributions yet."
    );
  });

  it("renders up to 50 scored Top Posts", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");
    const scoredEvidence = node
      ? selectedNodeEvidence(graph, node).find((item) => item.contributionScore > 0)
      : undefined;

    expect(node).toBeDefined();
    expect(scoredEvidence).toBeDefined();

    const evidence = Array.from({ length: TOP_POSTS_LIMIT + 5 }, (_, index): EvidenceItem => ({
      ...scoredEvidence!,
      id: `synthetic-scored-${index}`,
      title: `Synthetic scored post ${index}`,
      text: `Synthetic scored post ${index}`,
      contributionScore: 100 - index,
      sourceUrl: `https://example.com/synthetic-scored-${index}`,
      platformPostId: `synthetic-scored-${index}`,
      platformObjectId: String(9_000_000_000 + index)
    }));

    render(<NodePanel node={node!} relatedNodes={[]} evidence={evidence} />);

    const topPosts = screen.getByRole("heading", { name: "Top Posts" }).closest("section");
    expect(within(topPosts!).getByText("50/50")).toBeInTheDocument();
    expect(topPosts!.querySelectorAll(".top-post-card")).toHaveLength(TOP_POSTS_LIMIT);
    expect(within(topPosts!).queryByText("Synthetic scored post 50")).not.toBeInTheDocument();
  });

  it("does not restore the old Top Voices panel for a selected score audience", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    render(
      <NodePanel
        node={{
          ...node!,
          selectedTopVoiceAudience: {
            id: "yc_partners",
            displayName: "YC Partners",
            description: "Current YC partners and YC leadership.",
            helperText: "Showing attention from current YC partners only.",
            scoreLabel: "Top Voices score",
            scoreDescription: "Current YC partners and YC leadership.",
            active: true,
            memberCount: 18
          },
          topVoiceScore: 44,
          topVoiceConnectionCount: 1,
          topVoiceConnections: [
            {
              memberId: "grey-baker",
              displayName: "Grey Baker",
              category: "YC partner",
              weight: 2,
              contributionScore: 44,
              evidenceCount: 1,
              topEvidenceId: null,
              platforms: ["x"]
            }
          ]
        }}
        relatedNodes={[]}
        evidence={selectedNodeEvidence(graph, node!)}
      />
    );

    expect(screen.getByLabelText(`Score ${node!.score}`)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top Posts" })).toBeInTheDocument();
    expect(document.querySelector(".top-voices-panel-summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Score scope")).not.toBeInTheDocument();
    expect(screen.queryByText(/Top Voices score/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Grey Baker/i)).not.toBeInTheDocument();
  });

  it("renders A16Z founder social accounts as native platform links", () => {
    const graph = buildGraphResponse({ batchSlug: "A16ZSR006", query: "Thirdbrain Labs" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Thirdbrain Labs");

    expect(node).toBeDefined();
    render(<NodePanel node={node!} relatedNodes={[]} evidence={selectedNodeEvidence(graph, node!)} />);

    const founderAccountHrefs = [...document.querySelectorAll<HTMLAnchorElement>(".founder-account-chip-list a")]
      .map((link) => link.href);

    expect(screen.getByText("Founder accounts")).toBeInTheDocument();
    expect(founderAccountHrefs).toEqual(
      expect.arrayContaining([
        "https://www.linkedin.com/in/margaretczhang",
        "https://x.com/_margaretzhang",
        "https://www.linkedin.com/in/ds-huang",
        "https://x.com/latentius"
      ])
    );
    expect(founderAccountHrefs.some((href) => href.includes("speedrun.a16z.com"))).toBe(false);
  });
});

function weightedPlatformFixture(
  platform: Platform,
  score: number,
  evidenceCount: number,
  primary = false
): WeightedPlatformScore {
  const configuredWeight = TRACTION_SCORING_CONFIG.platformWeights[platform] ?? 0;
  const appliedWeight = TRACTION_SCORING_CONFIG.diversifiedPlatformWeight * configuredWeight +
    (primary ? TRACTION_SCORING_CONFIG.strongestPlatformWeight : 0);
  return {
    platform,
    score,
    configuredWeight,
    appliedWeight,
    contribution: Math.round(score * appliedWeight * 100) / 100,
    evidenceCount
  };
}
