import { describe, expect, it } from "vitest";
import { aggregateBalancedTractionScore } from "@/lib/graph/traction-scoring";
import type { CompanyRecord, ScoreBreakdown } from "@/lib/graph/types";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";
import {
  benchmarkCompanyScoresWithPublishedGlobalFactor,
  benchmarkGlobalCompanyScores
} from "@/lib/scoring/global-score-benchmark";

describe("global company score benchmark", () => {
  it("uses one best-company ratio across batches without per-batch stretching", () => {
    const population = [
      company("spring-best", "S2026", 52),
      company("summer-best", "S26", 48),
      company("speedrun-best", "A16ZSR006", 36),
      company("no-evidence", "S26", 0)
    ];

    const benchmarked = benchmarkGlobalCompanyScores(population);
    const byId = new Map(benchmarked.map((row) => [row.id, row]));

    expect(byId.get("spring-best")?.totalScore).toBe(100);
    expect(byId.get("summer-best")?.totalScore).toBe(92);
    expect(byId.get("speedrun-best")?.totalScore).toBe(69);
    expect(byId.get("no-evidence")?.totalScore).toBe(0);
    expect(byId.get("summer-best")?.scoreBreakdown?.calibration).toEqual({
      method: "global_best_ratio",
      cohortSize: 3,
      percentile: null,
      inputScore: 48,
      benchmarkScore: 52,
      scaleFactor: 100 / 52,
      benchmarkScope: "all_supported_batches",
      benchmarkPopulation: "current_company_snapshot"
    });
  });

  it("benchmarks a selected batch against the full global population", () => {
    const globalPopulation = [
      company("global-best", "S2026", 80),
      company("selected-best", "S26", 40),
      company("selected-middle", "S26", 20)
    ];
    const selected = globalPopulation.filter((row) => row.batchSlug === "S26");

    const benchmarked = benchmarkGlobalCompanyScores(selected, globalPopulation);

    expect(benchmarked.map((row) => row.totalScore)).toEqual([50, 25]);
    expect(benchmarked.every((row) => row.scoreBreakdown?.calibration.benchmarkScore === 80)).toBe(true);
  });

  it("preserves raw absolute, platform, and contribution values", () => {
    const best = company("best", "S2026", 80, 16.8);
    const selected = company("selected", "S26", 40, 8.4);
    const originalBreakdown = structuredClone(selected.scoreBreakdown!);

    const [benchmarked] = benchmarkGlobalCompanyScores([selected], [best, selected]);

    expect(benchmarked?.totalScore).toBe(50);
    expect(benchmarked?.scoreBreakdown?.absoluteScore).toBe(40);
    expect(benchmarked?.scoreBreakdown?.platformScores).toEqual(originalBreakdown.platformScores);
    expect(benchmarked?.scoreBreakdown?.weightedPlatforms).toEqual(originalBreakdown.weightedPlatforms);
    expect(benchmarked?.platformScores).toEqual(selected.platformScores);
  });

  it("lets updated selected companies replace their matching global population rows", () => {
    const staleSelected = company("same-id", "S26", 40);
    const otherBatchSameId = company("same-id", "S2026", 60);
    const updatedSelected = company("same-id", "S26", 80);

    const [benchmarked] = benchmarkGlobalCompanyScores(
      [updatedSelected],
      [staleSelected, otherBatchSameId]
    );

    expect(benchmarked?.totalScore).toBe(100);
    expect(benchmarked?.scoreBreakdown?.calibration.cohortSize).toBe(2);
    expect(benchmarked?.scoreBreakdown?.calibration.benchmarkScore).toBe(80);
  });

  it("does not let legacy records participate in the benchmark", () => {
    const canonical = company("canonical", "S26", 25);
    const legacy = { ...company("legacy", "S2026", 100), scoreBreakdown: undefined };

    const result = benchmarkGlobalCompanyScores([canonical, legacy]);

    expect(result[0]?.totalScore).toBe(100);
    expect(result[0]?.scoreBreakdown?.calibration.cohortSize).toBe(1);
    expect(result[1]).toEqual(legacy);
  });

  it("returns a stable canonical zero state when no company has positive evidence", () => {
    const zero = company("zero", "S26", 0);

    const [benchmarked] = benchmarkGlobalCompanyScores([zero]);

    expect(benchmarked?.totalScore).toBe(0);
    expect(benchmarked?.scoreBreakdown?.calibration).toEqual({
      method: "global_best_ratio",
      cohortSize: 0,
      percentile: null,
      inputScore: 0,
      benchmarkScore: 0,
      scaleFactor: 0,
      benchmarkScope: "all_supported_batches",
      benchmarkPopulation: "current_company_snapshot"
    });
  });

  it("reuses a published global factor for partial live overlays", () => {
    const selected = company("selected", "S26", 26, 5.46);

    const [benchmarked] = benchmarkCompanyScoresWithPublishedGlobalFactor(
      [selected],
      {
        method: "global_best_ratio",
        cohortSize: 365,
        percentile: null,
        inputScore: 48,
        benchmarkScore: 52,
        scaleFactor: 100 / 52,
        benchmarkScope: "all_supported_batches",
        benchmarkPopulation: "current_company_snapshot"
      }
    );

    expect(benchmarked?.totalScore).toBe(50);
    expect(benchmarked?.scoreBreakdown?.absoluteScore).toBe(26);
    expect(benchmarked?.scoreBreakdown?.weightedPlatforms[0]?.contribution).toBe(5.46);
    expect(benchmarked?.scoreBreakdown?.calibration).toEqual(
      expect.objectContaining({
        cohortSize: 365,
        inputScore: 26,
        benchmarkScore: 52,
        scaleFactor: 100 / 52
      })
    );
  });

  it("rejects incomplete or internally inconsistent published global metadata", () => {
    const selected = company("selected", "S26", 26);

    expect(() => benchmarkCompanyScoresWithPublishedGlobalFactor(
      [selected],
      {
        method: "global_best_ratio",
        cohortSize: 365,
        percentile: null,
        inputScore: 48,
        benchmarkScore: 52,
        scaleFactor: 2,
        benchmarkScope: "all_supported_batches",
        benchmarkPopulation: "current_company_snapshot"
      }
    )).toThrow(/inconsistent global score benchmark/i);

    expect(() => benchmarkCompanyScoresWithPublishedGlobalFactor(
      [selected],
      {
        method: "none",
        cohortSize: 365,
        percentile: null,
        inputScore: 48
      }
    )).toThrow(/missing a valid global score benchmark/i);
  });
});

function company(
  id: string,
  batchSlug: string,
  absoluteScore: number,
  contribution = absoluteScore
): CompanyRecord {
  const base = aggregateBalancedTractionScore([]);
  const scoreBreakdown: ScoreBreakdown = {
    ...base,
    modelId: TRACTION_SCORING_CONFIG.modelId,
    modelVersion: TRACTION_SCORING_CONFIG.version,
    modelName: TRACTION_SCORING_CONFIG.name,
    totalScore: absoluteScore,
    absoluteScore,
    weightedAvailableScore: absoluteScore,
    coverageFactor: absoluteScore > 0 ? 0.21 : 0,
    platformsWithEvidence: absoluteScore > 0 ? 1 : 0,
    platformScores: absoluteScore > 0 ? { x: absoluteScore } : {},
    weightedPlatforms: absoluteScore > 0
      ? [{
          platform: "x",
          score: absoluteScore,
          configuredWeight: 0.21,
          appliedWeight: 0.21,
          contribution,
          evidenceCount: 1
        }]
      : [],
    calibration: {
      method: "none",
      cohortSize: 0,
      percentile: null,
      inputScore: absoluteScore
    },
    explanation: "Absolute fixed-platform fixture."
  };

  return {
    id,
    batchSlug,
    name: id,
    ycProfileUrl: `https://example.test/${batchSlug}/${id}`,
    websiteUrl: `https://${id}.example.test`,
    tagline: id,
    description: id,
    groupPartner: null,
    primaryIndustry: "test",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: `https://example.test/${batchSlug}/${id}`,
    industries: [],
    founderIds: [],
    socialAccounts: [],
    totalScore: absoluteScore,
    previousScore: absoluteScore,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown
  };
}
