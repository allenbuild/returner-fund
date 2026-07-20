import {
  V5_PLATFORM_IDS,
  type V5CanonicalObservation,
  type V5LabeledObservation,
  type V5Platform,
  type V5Split,
  type V5SplitBuild,
  type V5TargetSpec
} from "./types";

export interface V5LabeledSplits {
  rows: Record<V5Split, V5LabeledObservation[]>;
  trainingPlatformGrowthThresholds: Partial<Record<V5Platform, number>>;
}

export function labelFromTrainingOnly(
  split: V5SplitBuild,
  target: V5TargetSpec
): V5LabeledSplits {
  const holdout = new Set(split.unseenEntityHoldoutIds);
  const trainingPlatformGrowthThresholds: Partial<Record<V5Platform, number>> = {};
  for (const platform of V5_PLATFORM_IDS) {
    const platformTarget = target.platformTargets[platform];
    if (!platformTarget) continue;
    const growth = split.rows.train
      .filter((row) => row.platform === platform && !holdout.has(row.entityId))
      .map((row) => row.growth)
      .sort((left, right) => left - right);
    if (growth.length === 0) continue;
    trainingPlatformGrowthThresholds[platform] = nearestRankQuantile(
      growth,
      platformTarget.thresholdQuantile
    );
  }

  return {
    trainingPlatformGrowthThresholds,
    rows: {
      train: labelRows(split.rows.train, trainingPlatformGrowthThresholds),
      validation: labelRows(split.rows.validation, trainingPlatformGrowthThresholds),
      test: labelRows(split.rows.test, trainingPlatformGrowthThresholds)
    }
  };
}

export function nearestRankQuantile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) throw new Error("Cannot compute a quantile without training values.");
  if (!(quantile > 0 && quantile <= 1)) throw new Error("Nearest-rank quantile must be in (0, 1].");
  const sorted = [...sortedValues].sort((left, right) => left - right);
  const rank = Math.ceil(quantile * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

function labelRows(
  rows: readonly V5CanonicalObservation[],
  thresholds: Partial<Record<V5Platform, number>>
): V5LabeledObservation[] {
  return rows.flatMap((row) => {
    const threshold = thresholds[row.platform];
    if (threshold === undefined) return [];
    return [{ ...row, highPerformanceOutcome: row.growth > threshold ? 1 : 0 }];
  });
}
