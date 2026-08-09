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
  it("preserves calibrated line-item identity and conservation across every published company", () => {
    let checkedCompanies = 0;
    let contributingCompanies = 0;

    for (const relativePath of BASE_GRAPH_PATHS) {
      const graph = JSON.parse(readFileSync(path.join(process.cwd(), relativePath), "utf8")) as {
        nodes: GraphNode[];
      };
      for (const node of graph.nodes.filter((candidate) => candidate.entityType === "company")) {
        checkedCompanies += 1;
        const sourceRows = [...(node.scoreBreakdown?.weightedPlatforms ?? [])]
          .filter((row) => Number.isFinite(row?.contribution) && row.contribution > 0)
          .sort(
            (left, right) =>
              right.contribution - left.contribution || left.platform.localeCompare(right.platform)
          );
        const contributions = displayPlatformContributions(node);

        expect(
          contributions.map((row) => row.platform),
          `${relativePath}:${node.label}:visible source rows`
        ).toEqual(sourceRows.map((row) => row.platform));
        expect(
          contributions.every(
            (row) => Number.isFinite(row.displayContribution) && row.displayContribution > 0
          ),
          `${relativePath}:${node.label}:finite positive rows`
        ).toBe(true);

        if (contributions.length === 0) {
          expect(sourceRows, `${relativePath}:${node.label}:empty source rows`).toEqual([]);
          continue;
        }
        contributingCompanies += 1;
        const calibration = node.scoreBreakdown?.calibration;
        expect(calibration?.method, `${relativePath}:${node.label}:calibration`).toBe(
          "global_best_ratio"
        );
        expect(calibration?.scaleFactor, `${relativePath}:${node.label}:scale factor`).toSatisfy(
          (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0
        );

        const independentlyCalibratedTenths = sourceRows.map((row) =>
          Math.round(roundToTenths(row.contribution) * calibration!.scaleFactor! * 10)
        );
        const displayedTenths = contributions.reduce(
          (sum, contribution) => sum + Math.round(contribution.displayContribution * 10),
          0
        );
        const publishedBaseTenths = Math.round(
          (node.insiderScoreBreakdown?.baseScore ?? node.score) * 10
        );

        expect(displayedTenths, `${relativePath}:${node.label}`).toBe(publishedBaseTenths);
        const reconciliationTenths = contributions.reduce(
          (sum, contribution, index) =>
            sum +
            Math.round(contribution.displayContribution * 10) -
            (independentlyCalibratedTenths[index] ?? 0),
          0
        );
        expect(reconciliationTenths, `${relativePath}:${node.label}:visible reconciliation`).toBe(
          publishedBaseTenths -
            independentlyCalibratedTenths.reduce((sum, contribution) => sum + contribution, 0)
        );
        const perRowAdjustments = contributions.map(
          (contribution, index) =>
            Math.round(contribution.displayContribution * 10) -
            (independentlyCalibratedTenths[index] ?? 0)
        );
        expect(
          perRowAdjustments.reduce((sum, adjustment) => sum + Math.abs(adjustment), 0),
          `${relativePath}:${node.label}:no hidden counter-adjustment`
        ).toBe(Math.abs(reconciliationTenths));
        expect(
          contributions.every(
            (row, index) =>
              index === 0 ||
              row.displayContribution <= contributions[index - 1]!.displayContribution
          ),
          `${relativePath}:${node.label}:display order`
        ).toBe(true);
        if (node.insiderScoreBreakdown) {
          expect(
            node.insiderScoreBreakdown.baseScore + node.insiderScoreBreakdown.insiderScoreAdjustment,
            `${relativePath}:${node.label}:insider adjustment`
          ).toBe(node.insiderScoreBreakdown.finalScore);
        }
      }
    }

    expect(checkedCompanies).toBe(430);
    expect(contributingCompanies).toBe(423);
  });

  it("renders the Antihero conversion as 20 -> 37.7 while totaling 87", () => {
    const graph = JSON.parse(
      readFileSync(path.join(process.cwd(), "public/graph/a16zsr006.json"), "utf8")
    ) as { nodes: GraphNode[] };
    const antihero = graph.nodes.find(
      (node) => node.entityType === "company" && node.label === "Antihero Studios"
    );

    expect(antihero).toBeDefined();
    const sourceRows = antihero!.scoreBreakdown!.weightedPlatforms;
    expect(roundToTenths(sourceRows[0]!.contribution)).toBe(20);

    const contributions = displayPlatformContributions(antihero!);
    expect(contributions.map((row) => [row.platform, row.displayContribution])).toEqual([
      ["instagram", 37.7],
      ["x", 20.6],
      ["linkedin", 14.7],
      ["youtube", 14]
    ]);
    expect(
      contributions.reduce((sum, row) => sum + Math.round(row.displayContribution * 10), 0)
    ).toBe(870);
  });

  it("never rescales method:none rows, even when their rounded subtotal is near the score", () => {
    const graph = JSON.parse(
      readFileSync(path.join(process.cwd(), "public/graph/a16zsr006.json"), "utf8")
    ) as { nodes: GraphNode[] };
    const antihero = graph.nodes.find(
      (node) => node.entityType === "company" && node.label === "Antihero Studios"
    )!;
    const noCalibrationNode: GraphNode = {
      ...antihero,
      score: 46,
      scoreBreakdown: {
        ...antihero.scoreBreakdown!,
        totalScore: 46,
        calibration: { method: "none", cohortSize: 1, percentile: null, inputScore: 46 }
      }
    };

    expect(
      displayPlatformContributions(noCalibrationNode).map((row) => row.displayContribution)
    ).toEqual([20, 10.9, 7.8, 6.9]);
  });

  it("keeps malformed rows and calibration metadata from leaking invalid or synthetic UI rows", () => {
    const graph = JSON.parse(
      readFileSync(path.join(process.cwd(), "public/graph/a16zsr006.json"), "utf8")
    ) as { nodes: GraphNode[] };
    const antihero = graph.nodes.find(
      (node) => node.entityType === "company" && node.label === "Antihero Studios"
    )!;
    const malformedNode: GraphNode = {
      ...antihero,
      scoreBreakdown: {
        ...antihero.scoreBreakdown!,
        weightedPlatforms: [
          { ...antihero.scoreBreakdown!.weightedPlatforms[0]!, contribution: 19.95 },
          { ...antihero.scoreBreakdown!.weightedPlatforms[1]!, contribution: Number.NaN },
          { ...antihero.scoreBreakdown!.weightedPlatforms[2]!, contribution: -4 },
          { ...antihero.scoreBreakdown!.weightedPlatforms[3]!, contribution: 0 }
        ],
        calibration: {
          ...antihero.scoreBreakdown!.calibration,
          scaleFactor: Number.NaN
        }
      }
    };

    const contributions = displayPlatformContributions(malformedNode);
    expect(contributions.map((row) => row.platform)).toEqual(["instagram"]);
    expect(contributions.map((row) => row.displayContribution)).toEqual([20]);
    expect(contributions.every((row) => Number.isFinite(row.displayContribution))).toBe(true);
  });

  it("reconciles calibrated platform rows to the Insider base without absorbing the adjustment", () => {
    const graph = JSON.parse(
      readFileSync(path.join(process.cwd(), "public/graph/a16zsr006.json"), "utf8")
    ) as { nodes: GraphNode[] };
    const antihero = graph.nodes.find(
      (node) => node.entityType === "company" && node.label === "Antihero Studios"
    )!;
    const insiderNode: GraphNode = {
      ...antihero,
      score: 63,
      insiderScoreBreakdown: {
        baseScore: 87,
        publishedInsiderInfluence: 25,
        weightedInsiderSubtotal: 1,
        insiderScoreAdjustment: -24,
        finalScore: 63,
        selectedInsiderIds: [],
        configurationVersion: 3,
        matches: [],
        formula: "published_score_plus_quadratic_insider_adjustments_capped_0_100"
      }
    };

    const contributions = displayPlatformContributions(insiderNode);
    expect(
      contributions.reduce((sum, row) => sum + Math.round(row.displayContribution * 10), 0)
    ).toBe(870);
    expect(insiderNode.score).toBe(63);
    expect(insiderNode.insiderScoreBreakdown!.baseScore).toBe(87);
  });
});

function roundToTenths(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
