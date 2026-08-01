import type { EvidenceMetrics, Platform } from "@/lib/graph/types";

export interface PlatformMetricWeights {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  reactions?: number;
  saves?: number;
  upvotes?: number;
  stars?: number;
  forks?: number;
  watchers?: number;
  issues?: number;
  open_issues?: number;
  recent_commits_30d?: number;
}

export interface PlatformScoringReference {
  /** Raw weighted engagement expected to land near 100. */
  highEngagement: number;
}

export interface BatchCalibrationConfig {
  absoluteScoreWeight: number;
  cohortPercentileWeight: number;
}

export interface ConfidenceScoringConfig {
  base: number;
  evidenceDepthWeight: number;
  evidenceDepthScale: number;
  platformBreadthWeight: number;
  publicationDateWeight: number;
  verifiedLinkWeight: number;
  mediumThreshold: number;
  highThreshold: number;
}

export interface TractionScoringConfig {
  modelId: string;
  version: string;
  name: string;
  platformWeights: Partial<Record<Platform, number>>;
  metricWeights: Partial<Record<Platform, PlatformMetricWeights>>;
  platformReferences: Partial<Record<Platform, PlatformScoringReference>>;
  absoluteEvidenceWeight: number;
  cohortPercentileWeight: number;
  strongestPlatformWeight: number;
  diversifiedPlatformWeight: number;
  platformEvidenceSlots: number[];
  batchCalibration: BatchCalibrationConfig;
  confidence: ConfidenceScoringConfig;
}

const NORMALIZED_WEIGHT_TOLERANCE = 1e-9;

/**
 * Canonical production model. All graph, refresh, diagnostics, and experiments
 * must import this object rather than copy weights or formulas.
 */
export const TRACTION_SCORING_CONFIG: TractionScoringConfig = {
  modelId: "returner-traction",
  version: "4.1.0",
  name: "returner-traction-v4-absolute-fixed-platform",
  platformWeights: {
    x: 0.21,
    instagram: 0.21,
    linkedin: 0.15,
    github: 0.15,
    youtube: 0.1,
    product_hunt: 0.07,
    hacker_news: 0.05,
    reddit: 0.04,
    bilibili: 0.02
  },
  metricWeights: {
    github: { stars: 1.5, forks: 4, issues: 0.5 },
    x: { views: 0.04, likes: 1.4, replies: 4.5, reposts: 6, quotes: 6 },
    linkedin: { views: 0.04, reactions: 1.4, comments: 4.5, reposts: 6 },
    instagram: { views: 0.04, likes: 1.1, comments: 4.5, shares: 5, saves: 4 },
    product_hunt: { upvotes: 2, comments: 3.5 },
    youtube: { views: 0.025, likes: 1, comments: 3.5 },
    hacker_news: { upvotes: 2, comments: 3.5 },
    reddit: { upvotes: 2, comments: 3.5 },
    bilibili: { views: 0.025, likes: 1, comments: 3.5, shares: 4 },
    web: {},
    rss: {}
  },
  platformReferences: {
    github: { highEngagement: 40_000 },
    x: { highEngagement: 120_000 },
    linkedin: { highEngagement: 18_000 },
    instagram: { highEngagement: 80_000 },
    product_hunt: { highEngagement: 4_000 },
    youtube: { highEngagement: 35_000 },
    hacker_news: { highEngagement: 2_500 },
    reddit: { highEngagement: 4_000 },
    bilibili: { highEngagement: 35_000 }
  },
  absoluteEvidenceWeight: 1,
  cohortPercentileWeight: 0,
  strongestPlatformWeight: 0,
  diversifiedPlatformWeight: 1,
  platformEvidenceSlots: [0.82, 0.08, 0.05, 0.03, 0.02],
  batchCalibration: {
    absoluteScoreWeight: 1,
    cohortPercentileWeight: 0
  },
  confidence: {
    base: 0.2,
    evidenceDepthWeight: 0.38,
    evidenceDepthScale: 4,
    platformBreadthWeight: 0.22,
    publicationDateWeight: 0.12,
    verifiedLinkWeight: 0.08,
    mediumThreshold: 0.5,
    highThreshold: 0.75
  }
};

validateTractionScoringConfig(TRACTION_SCORING_CONFIG);

export function validateTractionScoringConfig(config: TractionScoringConfig): void {
  const platformWeights = sortedRecordEntries(config.platformWeights).map(([platform, weight]) => {
    assertUnitWeight(`platformWeights.${platform}`, weight);
    return [platform, weight] as const;
  });
  assertNormalizedWeightTotal("platform weights", platformWeights.map(([, weight]) => weight));

  for (const [platform, metricWeights] of sortedRecordEntries(config.metricWeights)) {
    if (metricWeights === undefined) continue;
    if (!isRecord(metricWeights)) {
      invalidConfig(`metricWeights.${platform}`, "must be a metric weight map", metricWeights);
    }

    for (const [metric, weight] of sortedRecordEntries(metricWeights)) {
      if (weight !== undefined) {
        assertFiniteNonNegativeWeight(`metricWeights.${platform}.${metric}`, weight);
      }
    }
  }

  for (const [platform, reference] of sortedRecordEntries(config.platformReferences)) {
    if (!isRecord(reference)) {
      invalidConfig(`platformReferences.${platform}`, "must be a scoring reference", reference);
    }
    assertPositiveFinite(`platformReferences.${platform}.highEngagement`, reference.highEngagement);
  }

  for (const [platform, weight] of platformWeights) {
    if (weight === 0) continue;

    if (!config.platformReferences[platform as Platform]) {
      invalidConfig(
        `platformReferences.${platform}`,
        "is required when the platform weight is positive",
        config.platformReferences[platform as Platform]
      );
    }

    const metricWeights = config.metricWeights[platform as Platform];
    const hasPositiveSignal =
      isRecord(metricWeights) &&
      Object.values(metricWeights).some(
        (metricWeight) => typeof metricWeight === "number" && Number.isFinite(metricWeight) && metricWeight > 0
      );
    if (!hasPositiveSignal) {
      invalidConfig(
        `metricWeights.${platform}`,
        "must contain at least one positive metric weight when the platform weight is positive",
        metricWeights
      );
    }
  }

  assertNormalizedWeights("evidence blend", [
    ["absoluteEvidenceWeight", config.absoluteEvidenceWeight],
    ["cohortPercentileWeight", config.cohortPercentileWeight]
  ]);
  if (config.absoluteEvidenceWeight !== 1 || config.cohortPercentileWeight !== 0) {
    invalidConfig(
      "monotonic evidence blend",
      "must be fully reference-anchored (absoluteEvidenceWeight=1, cohortPercentileWeight=0)",
      [config.absoluteEvidenceWeight, config.cohortPercentileWeight]
    );
  }
  assertNormalizedWeights("platform blend", [
    ["strongestPlatformWeight", config.strongestPlatformWeight],
    ["diversifiedPlatformWeight", config.diversifiedPlatformWeight]
  ]);
  if (config.strongestPlatformWeight !== 0 || config.diversifiedPlatformWeight !== 1) {
    invalidConfig(
      "fixed platform blend",
      "must use only configured platform shares (strongestPlatformWeight=0, diversifiedPlatformWeight=1)",
      [config.strongestPlatformWeight, config.diversifiedPlatformWeight]
    );
  }

  if (!Array.isArray(config.platformEvidenceSlots) || config.platformEvidenceSlots.length === 0) {
    invalidConfig("platformEvidenceSlots", "must be a non-empty array", config.platformEvidenceSlots);
  }
  for (const [index, slot] of config.platformEvidenceSlots.entries()) {
    assertPositiveUnitWeight(`platformEvidenceSlots[${index}]`, slot);
    if (index > 0 && slot > config.platformEvidenceSlots[index - 1]!) {
      invalidConfig(
        "platformEvidenceSlots",
        "must be monotonically non-increasing",
        config.platformEvidenceSlots
      );
    }
  }
  assertNormalizedWeightTotal("platform evidence slots", config.platformEvidenceSlots);

  assertNormalizedWeights("batch calibration", [
    ["batchCalibration.absoluteScoreWeight", config.batchCalibration.absoluteScoreWeight],
    ["batchCalibration.cohortPercentileWeight", config.batchCalibration.cohortPercentileWeight]
  ]);
  if (
    config.batchCalibration.absoluteScoreWeight !== 1 ||
    config.batchCalibration.cohortPercentileWeight !== 0
  ) {
    invalidConfig(
      "absolute company score",
      "must disable cohort calibration (absoluteScoreWeight=1, cohortPercentileWeight=0)",
      [
        config.batchCalibration.absoluteScoreWeight,
        config.batchCalibration.cohortPercentileWeight
      ]
    );
  }

  const confidenceWeights: Array<readonly [string, number]> = [
    ["confidence.base", config.confidence.base],
    ["confidence.evidenceDepthWeight", config.confidence.evidenceDepthWeight],
    ["confidence.platformBreadthWeight", config.confidence.platformBreadthWeight],
    ["confidence.publicationDateWeight", config.confidence.publicationDateWeight],
    ["confidence.verifiedLinkWeight", config.confidence.verifiedLinkWeight]
  ];
  assertNormalizedWeights("confidence", confidenceWeights);
  assertPositiveFinite("confidence.evidenceDepthScale", config.confidence.evidenceDepthScale);
  assertUnitWeight("confidence.mediumThreshold", config.confidence.mediumThreshold);
  assertUnitWeight("confidence.highThreshold", config.confidence.highThreshold);
  if (config.confidence.mediumThreshold >= config.confidence.highThreshold) {
    invalidConfig(
      "confidence thresholds",
      "must satisfy mediumThreshold < highThreshold",
      `${config.confidence.mediumThreshold} >= ${config.confidence.highThreshold}`
    );
  }
}

function assertNormalizedWeights(label: string, weights: Array<readonly [string, number]>): void {
  for (const [path, weight] of weights) {
    assertUnitWeight(path, weight);
  }
  assertNormalizedWeightTotal(label, weights.map(([, weight]) => weight));
}

function assertNormalizedWeightTotal(label: string, weights: number[]): void {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || Math.abs(total - 1) > NORMALIZED_WEIGHT_TOLERANCE) {
    invalidConfig(
      label,
      `must sum to 1 within tolerance ${NORMALIZED_WEIGHT_TOLERANCE}`,
      total
    );
  }
}

function assertFiniteNonNegativeWeight(path: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalidConfig(path, "must be a finite non-negative weight", value);
  }
}

function assertUnitWeight(path: string, value: unknown): asserts value is number {
  assertFiniteNonNegativeWeight(path, value);
  if (value > 1) {
    invalidConfig(path, "must be at most 1", value);
  }
}

function assertPositiveUnitWeight(path: string, value: unknown): asserts value is number {
  assertUnitWeight(path, value);
  if (value === 0) {
    invalidConfig(path, "must be positive", value);
  }
}

function assertPositiveFinite(path: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    invalidConfig(path, "must be a positive finite number", value);
  }
}

function sortedRecordEntries<T>(
  record: Record<string, T> | Partial<Record<string, T>>
): Array<[string, T | undefined]> {
  return Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfig(path: string, expectation: string, actual: unknown): never {
  throw new Error(`Invalid traction scoring config: ${path} ${expectation}; received ${String(actual)}.`);
}

export function normalizeMetricsForScoring(platform: Platform, metrics: EvidenceMetrics): EvidenceMetrics {
  const cleaned = Object.fromEntries(
    Object.entries(metrics).flatMap(([key, rawValue]) => {
      const value = Number(rawValue);
      return Number.isFinite(value) && value > 0 ? [[key, value]] : [];
    })
  ) as EvidenceMetrics;

  if (platform === "x") {
    return {
      views: cleaned.views,
      likes: cleaned.likes,
      replies: maxMetric(cleaned.replies, cleaned.comments),
      reposts: maxMetric(cleaned.reposts, cleaned.shares),
      quotes: cleaned.quotes,
      saves: cleaned.saves
    };
  }

  if (platform === "linkedin") {
    return {
      views: cleaned.views,
      reactions: maxMetric(cleaned.reactions, cleaned.likes),
      comments: maxMetric(cleaned.comments, cleaned.replies),
      reposts: maxMetric(cleaned.reposts, cleaned.shares),
      saves: cleaned.saves
    };
  }

  if (platform === "instagram") {
    return {
      views: cleaned.views,
      likes: cleaned.likes,
      comments: maxMetric(cleaned.comments, cleaned.replies),
      shares: maxMetric(cleaned.shares, cleaned.reposts),
      saves: cleaned.saves
    };
  }

  if (platform === "github") {
    return {
      stars: cleaned.stars,
      forks: cleaned.forks,
      // GitHub's watchers_count is ordinarily the same field as stargazers_count.
      watchers: cleaned.watchers === cleaned.stars ? undefined : cleaned.watchers,
      issues: maxMetric(cleaned.issues, cleaned.open_issues)
    };
  }

  return cleaned;
}

export function weightedMetricSum(platform: Platform, metrics: EvidenceMetrics): number {
  const weights = TRACTION_SCORING_CONFIG.metricWeights[platform] ?? {};
  const normalized = normalizeMetricsForScoring(platform, metrics);

  return Object.entries(normalized).reduce((sum, [key, rawValue]) => {
    const value = Number(rawValue);
    const weight = weights[key as keyof PlatformMetricWeights] ?? 0;
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(weight) || weight <= 0) return sum;
    const weightedValue = value * weight;
    if (!Number.isFinite(weightedValue)) return Number.MAX_VALUE;
    const next = sum + weightedValue;
    return Number.isFinite(next) ? next : Number.MAX_VALUE;
  }, 0);
}

function maxMetric(...values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value) && Number(value) > 0);
  return finite.length ? Math.max(...finite) : undefined;
}
