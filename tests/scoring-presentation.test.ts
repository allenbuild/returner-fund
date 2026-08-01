import { describe, expect, it } from "vitest";
import { buildScoringMethodologyPresentation } from "@/lib/scoring/presentation";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";

describe("scoring methodology presentation", () => {
  it("derives every displayed number from the canonical scoring config", () => {
    const presentation = buildScoringMethodologyPresentation();

    expect(presentation.modelVersion).toBe(TRACTION_SCORING_CONFIG.version);
    expect(presentation.postSlotPercents).toEqual(
      TRACTION_SCORING_CONFIG.platformEvidenceSlots.map((weight) => weight * 100)
    );
    expect(presentation.calibration).toEqual({ absolutePercent: 82, cohortPercentilePercent: 18 });
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
