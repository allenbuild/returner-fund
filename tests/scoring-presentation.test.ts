import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphNode } from "@/lib/graph/types";
import {
  buildScoringMethodologyPresentation,
  displayPlatformContributions
} from "@/lib/scoring/presentation";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";

const BASE_GRAPH_PATHS = [
  "public/graph/s2026.json",
  "public/graph/s26.json",
  "public/graph/a16zsr006.json"
];

describe("scoring methodology presentation", () => {
  it("derives every displayed number from the canonical scoring config", () => {
    const presentation = buildScoringMethodologyPresentation();

    expect(presentation.modelVersion).toBe(TRACTION_SCORING_CONFIG.version);
    expect(presentation.postSlotPercents).toEqual(
      TRACTION_SCORING_CONFIG.platformEvidenceSlots.map((weight) => weight * 100)
    );
    expect(presentation.calibration).toEqual({ absolutePercent: 100, cohortPercentilePercent: 0 });
    expect(presentation.platformReferences.find((row) => row.platform === "x")).toEqual({
      platform: "x",
      highEngagement: 120_000
    });
    expect(presentation).not.toHaveProperty("recencyBlend");
    expect(presentation.platformReferences.every((row) => !("halfLifeDays" in row))).toBe(true);
    expect(presentation.confidence.highThresholdPercent).toBe(75);
    expect(presentation.metricWeights.find((row) => row.platform === "x")?.metrics).toEqual([
      { metric: "views", weight: 0.04 },
      { metric: "likes", weight: 1.4 },
      { metric: "replies", weight: 4.5 },
      { metric: "reposts", weight: 6 },
      { metric: "quotes", weight: 6 }
    ]);
  });

  it("changes when a supplied config fixture changes instead of retaining stale constants", () => {
    const fixture = {
      ...TRACTION_SCORING_CONFIG,
      platformEvidenceSlots: [1],
      batchCalibration: { absoluteScoreWeight: 0.7, cohortPercentileWeight: 0.3 },
      metricWeights: {
        ...TRACTION_SCORING_CONFIG.metricWeights,
        x: { likes: 9 }
      }
    };

    const presentation = buildScoringMethodologyPresentation(fixture);
    expect(presentation.postSlotPercents).toEqual([100]);
    expect(presentation.calibration).toEqual({ absolutePercent: 70, cohortPercentilePercent: 30 });
    expect(presentation.metricWeights.find((row) => row.platform === "x")?.metrics).toEqual([
      { metric: "likes", weight: 9 }
    ]);
  });
});

describe("score presentation conservation", () => {
  it("makes every scored company platform subtotal equal its published base score", () => {
    let checkedCompanies = 0;

    for (const relativePath of BASE_GRAPH_PATHS) {
      const graph = JSON.parse(readFileSync(path.join(process.cwd(), relativePath), "utf8")) as {
        nodes: GraphNode[];
      };
      for (const node of graph.nodes.filter((candidate) => candidate.entityType === "company")) {
        const contributions = displayPlatformContributions(node);
        if (contributions.length === 0) continue;
        const displayedTenths = contributions.reduce(
          (sum, contribution) => sum + Math.round(contribution.displayContribution * 10),
          0
        );
        const publishedBaseTenths = Math.round(
          (node.insiderScoreBreakdown?.baseScore ?? node.score) * 10
        );

        expect(displayedTenths, `${relativePath}:${node.label}`).toBe(publishedBaseTenths);
        if (node.insiderScoreBreakdown) {
          expect(
            node.insiderScoreBreakdown.baseScore + node.insiderScoreBreakdown.insiderScoreAdjustment,
            `${relativePath}:${node.label}:insider adjustment`
          ).toBe(node.insiderScoreBreakdown.finalScore);
        }
        checkedCompanies += 1;
      }
    }

    expect(checkedCompanies).toBe(423);
  });
});
