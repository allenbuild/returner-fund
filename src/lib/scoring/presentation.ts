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
 * Apply the published global calibration to every visible platform row and
 * reconcile only the sub-point rounding residual to the published base score.
 * The model rounds the raw platform subtotal before headline calibration, so
 * independently formatted rows otherwise disagree with the score orb.
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
  const multiplier =
    calibration?.method === "global_best_ratio" &&
    typeof calibration.scaleFactor === "number" &&
    Number.isFinite(calibration.scaleFactor) &&
    calibration.scaleFactor >= 0
      ? calibration.scaleFactor
      : 1;
  const scaled = rows.map((row) => row.contribution * multiplier);
  const rawTotal = rows.reduce((sum, row) => sum + row.contribution, 0);
  const absoluteScore = node.scoreBreakdown?.absoluteScore;
  const baseScore = node.insiderScoreBreakdown?.baseScore ?? node.score;
  const isCanonicalRoundedSubtotal =
    typeof absoluteScore === "number" &&
    Number.isFinite(absoluteScore) &&
    Math.abs(rawTotal - absoluteScore) <= 1;
  const displayValues =
    isCanonicalRoundedSubtotal && Number.isFinite(baseScore) && baseScore >= 0
      ? allocateTenths(scaled, baseScore)
      : scaled.map((value) => roundToTenths(value));

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

function allocateTenths(values: number[], target: number): number[] {
  const targetTenths = Math.max(0, Math.round(target * 10));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || targetTenths === 0) return values.map(() => 0);

  const exactTenths = values.map((value) => (value / total) * targetTenths);
  const allocatedTenths = exactTenths.map((value) => Math.floor(value));
  const remainder = targetTenths - allocatedTenths.reduce((sum, value) => sum + value, 0);
  const allocationOrder = exactTenths
    .map((value, index) => ({ index, fraction: value - Math.floor(value), value: values[index] ?? 0 }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || right.value - left.value || left.index - right.index
    );

  for (let index = 0; index < remainder; index += 1) {
    const targetIndex = allocationOrder[index]?.index;
    if (targetIndex !== undefined) allocatedTenths[targetIndex] += 1;
  }
  return allocatedTenths.map((value) => value / 10);
}

function roundToTenths(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}
