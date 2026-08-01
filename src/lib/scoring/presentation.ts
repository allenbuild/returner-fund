import { PLATFORM_VALUES, type Platform } from "@/lib/graph/types";
import {
  TRACTION_SCORING_CONFIG,
  type TractionScoringConfig
} from "./traction-config";

export interface ScoringMetricWeightRow {
  platform: Platform;
  metrics: Array<{ metric: string; weight: number }>;
}

export interface ScoringMethodologyPresentation {
  modelId: string;
  modelVersion: string;
  evidenceBlend: {
    absolutePercent: number;
    platformMidrankPercent: number;
  };
  postSlotPercents: number[];
  platformWeights: Array<{ platform: Platform; percent: number }>;
  platformReferences: Array<{
    platform: Platform;
    highEngagement: number;
  }>;
  platformBlend: {
    strongestPercent: number;
    diversifiedPercent: number;
  };
  calibration: {
    absolutePercent: number;
    cohortPercentilePercent: number;
  };
  metricWeights: ScoringMetricWeightRow[];
  confidence: {
    basePercent: number;
    evidenceDepthPercent: number;
    evidenceDepthScale: number;
    platformBreadthPercent: number;
    publicationDatePercent: number;
    verifiedLinkPercent: number;
    mediumThresholdPercent: number;
    highThresholdPercent: number;
  };
}

export function buildScoringMethodologyPresentation(
  config: TractionScoringConfig = TRACTION_SCORING_CONFIG
): ScoringMethodologyPresentation {
  const weightedPlatforms = PLATFORM_VALUES.flatMap((platform) => {
    const weight = config.platformWeights[platform];
    return typeof weight === "number" && weight > 0
      ? [{ platform, percent: percent(weight) }]
      : [];
  });
  const metricWeights = weightedPlatforms.map(({ platform }) => ({
    platform,
    metrics: Object.entries(config.metricWeights[platform] ?? {})
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
      .map(([metric, weight]) => ({ metric, weight }))
  }));

  return {
    modelId: config.modelId,
    modelVersion: config.version,
    evidenceBlend: {
      absolutePercent: percent(config.absoluteEvidenceWeight),
      platformMidrankPercent: percent(config.cohortPercentileWeight)
    },
    postSlotPercents: config.platformEvidenceSlots.map(percent),
    platformWeights: weightedPlatforms,
    platformReferences: weightedPlatforms.flatMap(({ platform }) => {
      const reference = config.platformReferences[platform];
      return reference
        ? [{ platform, highEngagement: reference.highEngagement }]
        : [];
    }),
    platformBlend: {
      strongestPercent: percent(config.strongestPlatformWeight),
      diversifiedPercent: percent(config.diversifiedPlatformWeight)
    },
    calibration: {
      absolutePercent: percent(config.batchCalibration.absoluteScoreWeight),
      cohortPercentilePercent: percent(config.batchCalibration.cohortPercentileWeight)
    },
    metricWeights,
    confidence: {
      basePercent: percent(config.confidence.base),
      evidenceDepthPercent: percent(config.confidence.evidenceDepthWeight),
      evidenceDepthScale: config.confidence.evidenceDepthScale,
      platformBreadthPercent: percent(config.confidence.platformBreadthWeight),
      publicationDatePercent: percent(config.confidence.publicationDateWeight),
      verifiedLinkPercent: percent(config.confidence.verifiedLinkWeight),
      mediumThresholdPercent: percent(config.confidence.mediumThreshold),
      highThresholdPercent: percent(config.confidence.highThreshold)
    }
  };
}

function percent(value: number): number {
  return Math.round(value * 10_000) / 100;
}
