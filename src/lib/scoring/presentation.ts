import {
  PLATFORM_VALUES,
  type GraphNode,
  type Platform,
  type WeightedPlatformScore
} from "@/lib/graph/types";
import {
  TRACTION_SCORING_CONFIG,
  type TractionScoringConfig
} from "./traction-config";

export interface ScoringMetricWeightRow {
  platform: Platform;
  metrics: Array<{ metric: string; weight: number }>;
}

export interface DisplayPlatformContribution extends WeightedPlatformScore {
  displayContribution: number;
}

/**
 * Apply the published global calibration to each user-visible platform value.
 * The scoring model and the UI both round, so the independently calibrated
 * tenths can differ from the integer headline. Reconcile that residual through
 * existing lower-ranked platform rows without inventing a synthetic row or
 * changing the leading before/after contribution when the tail can absorb it.
 */
export function displayPlatformContributions(
  node: Pick<GraphNode, "score" | "scoreBreakdown" | "insiderScoreBreakdown">
): DisplayPlatformContribution[] {
  const rows = [...(node.scoreBreakdown?.weightedPlatforms ?? [])]
    .filter((row) => Number.isFinite(row?.contribution) && row.contribution > 0)
    .sort(
      (left, right) =>
        right.contribution - left.contribution || left.platform.localeCompare(right.platform)
    );
  if (rows.length === 0) return [];

  const calibration = node.scoreBreakdown?.calibration;
  const scaleFactor = calibration?.scaleFactor;
  const hasValidGlobalCalibration =
    calibration?.method === "global_best_ratio" &&
    typeof scaleFactor === "number" &&
    Number.isFinite(scaleFactor) &&
    scaleFactor > 0;
  const multiplier = hasValidGlobalCalibration ? Number(scaleFactor) : 1;
  const scaled = rows.map((row) =>
    roundToTenths(roundToTenths(row.contribution) * multiplier)
  );
  const rawTotal = rows.reduce((sum, row) => sum + row.contribution, 0);
  const absoluteScore = node.scoreBreakdown?.absoluteScore;
  const baseScore = node.insiderScoreBreakdown?.baseScore ?? node.score;
  const isCanonicalRoundedSubtotal =
    typeof absoluteScore === "number" &&
    Number.isFinite(absoluteScore) &&
    Math.abs(rawTotal - absoluteScore) <= 1;
  const displayValues =
    hasValidGlobalCalibration &&
    isCanonicalRoundedSubtotal &&
    Number.isFinite(baseScore) &&
    baseScore >= 0
      ? reconcileVisibleTenths(scaled, baseScore)
      : scaled;

  return rows.map((row, index) => ({
    ...row,
    displayContribution: displayValues[index] ?? 0
  }));
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
    scoreLevelMultiplierPercent: number;
    globalBenchmarkTarget: number;
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
      cohortPercentilePercent: percent(config.batchCalibration.cohortPercentileWeight),
      scoreLevelMultiplierPercent: percent(config.scoreLevelMultiplier),
      globalBenchmarkTarget: config.globalBenchmarkTarget
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

function reconcileVisibleTenths(values: number[], target: number): number[] {
  const targetTenths = Math.max(0, Math.round(target * 10));
  const allocatedTenths = values.map((value) => Math.max(0, Math.round(value * 10)));
  const minimumTenths = allocatedTenths.map((value) => (value > 0 ? 1 : 0));
  if (targetTenths < minimumTenths.reduce<number>((sum, value) => sum + value, 0)) {
    return allocatedTenths.map((value) => value / 10);
  }

  let residual = targetTenths - allocatedTenths.reduce((sum, value) => sum + value, 0);
  if (residual > 0) {
    for (let index = allocatedTenths.length - 1; index >= 0 && residual > 0; index -= 1) {
      const capacity = index === 0
        ? residual
        : Math.max(0, allocatedTenths[index - 1] - allocatedTenths[index]);
      const adjustment = Math.min(residual, capacity);
      allocatedTenths[index] += adjustment;
      residual -= adjustment;
    }
  } else if (residual < 0) {
    let reduction = -residual;
    for (let index = allocatedTenths.length - 1; index >= 0 && reduction > 0; index -= 1) {
      const lowerBound = index === allocatedTenths.length - 1
        ? minimumTenths[index]
        : Math.max(minimumTenths[index], allocatedTenths[index + 1]);
      const adjustment = Math.min(reduction, Math.max(0, allocatedTenths[index] - lowerBound));
      allocatedTenths[index] -= adjustment;
      reduction -= adjustment;
    }
    residual = -reduction;
  }

  // Incoherent metadata must not create negative, NaN, or synthetic values.
  // Falling back to independently calibrated tenths is safer than fabricating
  // a reconciliation that the visible platform rows cannot represent.
  if (residual !== 0) return values.map((value) => roundToTenths(value));
  return allocatedTenths.map((value) => value / 10);
}

function roundToTenths(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
