import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { yc2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

const BATCHES = ["S2026", "S26", "A16ZSR006"];

describe("global company benchmark integration", () => {
  it("uses one current-company factor across all batches and makes the global best 100", () => {
    const positiveCompanies = yc2026GraphDataset.companies.filter(
      (company) => (company.scoreBreakdown?.absoluteScore ?? 0) > 0
    );
    const benchmarkScore = Math.max(
      ...positiveCompanies.map((company) => company.scoreBreakdown!.absoluteScore)
    );
    const scaleFactor = 100 / benchmarkScore;

    expect(new Set(positiveCompanies.map((company) => company.batchSlug))).toEqual(
      new Set(BATCHES)
    );
    expect(Math.max(...positiveCompanies.map((company) => company.totalScore))).toBe(100);

    for (const company of yc2026GraphDataset.companies) {
      const breakdown = company.scoreBreakdown!;
      const expectedHeadline = breakdown.absoluteScore > 0
        ? Math.max(1, Math.min(100, Math.round(breakdown.absoluteScore * scaleFactor)))
        : 0;
      expect(company.totalScore).toBe(expectedHeadline);
      expect(breakdown.totalScore).toBe(expectedHeadline);
      expect(breakdown.calibration).toEqual({
        method: "global_best_ratio",
        cohortSize: positiveCompanies.length,
        percentile: null,
        inputScore: breakdown.absoluteScore,
        benchmarkScore,
        scaleFactor,
        benchmarkScope: "all_supported_batches",
        benchmarkPopulation: "current_company_snapshot"
      });
    }
  });

  it("keeps raw platform scores and contributions independent of the headline factor", () => {
    for (const company of yc2026GraphDataset.companies) {
      const breakdown = company.scoreBreakdown!;
      const rawContributionTotal = breakdown.weightedPlatforms.reduce(
        (sum, platform) => sum + platform.score * platform.configuredWeight,
        0
      );
      const expectedAbsolute = rawContributionTotal > 0
        ? Math.max(1, Math.round(rawContributionTotal))
        : 0;

      expect(breakdown.absoluteScore).toBe(expectedAbsolute);
      expect(
        breakdown.weightedPlatforms.every(
          (platform) =>
            platform.appliedWeight === platform.configuredWeight &&
            platform.contribution ===
              Math.round(platform.score * platform.configuredWeight * 100) / 100
        )
      ).toBe(true);
    }
  });

  it("does not recalibrate by batch, filter, or Top Voice audience", () => {
    for (const batchSlug of BATCHES) {
      const canonicalById = new Map(
        yc2026GraphDataset.companies
          .filter((company) => company.batchSlug === batchSlug)
          .map((company) => [company.id, company])
      );
      const off = buildGraphResponse({ batchSlug }, yc2026GraphDataset);
      const insiders = buildGraphResponse(
        { batchSlug, topVoices: "insiders" },
        yc2026GraphDataset
      );

      for (const node of [...off.nodes, ...insiders.nodes]) {
        const canonical = canonicalById.get(node.entityId);
        expect(node.score).toBe(canonical?.totalScore);
        expect(node.scoreBreakdown?.calibration).toEqual(
          canonical?.scoreBreakdown?.calibration
        );
      }
    }
  });
});
