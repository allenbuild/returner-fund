import type {
  V5MetricFeature,
  V5Platform,
  V5PlatformTargetSpec,
  V5SplitSpec
} from "./types";

export const V5_PREREG_TARGET_ID = "returner-post-performance-v5-prereg-2026-07-20" as const;

export const V5_PREREG_THRESHOLD_DEFINITION =
  "For each platform, use the deterministic nearest-rank 80th percentile of training-only log1p native-counter growth; apply strict greater-than to training, validation, and test.";

export const V5_PREREG_PLATFORM_TARGETS = Object.freeze({
  x: Object.freeze({ targetMetric: "views", horizonHours: 168, toleranceHours: 12, thresholdQuantile: 0.8 }),
  linkedin: Object.freeze({
    targetMetric: "impressions",
    horizonHours: 168,
    toleranceHours: 12,
    thresholdQuantile: 0.8
  }),
  instagram: Object.freeze({ targetMetric: "plays", horizonHours: 168, toleranceHours: 12, thresholdQuantile: 0.8 }),
  github: Object.freeze({ targetMetric: "stars", horizonHours: 672, toleranceHours: 24, thresholdQuantile: 0.8 }),
  product_hunt: Object.freeze({
    targetMetric: "upvotes",
    horizonHours: 168,
    toleranceHours: 12,
    thresholdQuantile: 0.8
  }),
  youtube: Object.freeze({ targetMetric: "views", horizonHours: 168, toleranceHours: 12, thresholdQuantile: 0.8 }),
  reddit: Object.freeze({ targetMetric: "upvotes", horizonHours: 168, toleranceHours: 12, thresholdQuantile: 0.8 }),
  hacker_news: Object.freeze({ targetMetric: "points", horizonHours: 168, toleranceHours: 12, thresholdQuantile: 0.8 }),
  bilibili: Object.freeze({ targetMetric: "views", horizonHours: 168, toleranceHours: 12, thresholdQuantile: 0.8 })
}) satisfies Readonly<Record<string, Readonly<V5PlatformTargetSpec>>>;

/**
 * Canonical metric namespaces are platform-routed. This table is schema, not a
 * fitted weight vector: a counter cannot become a feature merely because its
 * global spelling is recognized on some other platform.
 */
export const V5_PREREG_PLATFORM_METRICS: Readonly<
  Partial<Record<V5Platform, readonly V5MetricFeature[]>>
> = Object.freeze({
  x: metricNamespace("likes", "comments", "replies", "reposts", "quotes", "views", "saves"),
  linkedin: metricNamespace("reactions", "comments", "shares", "impressions"),
  instagram: metricNamespace("likes", "comments", "shares", "views", "plays", "saves"),
  github: metricNamespace("stars", "forks", "watchers", "issues"),
  product_hunt: metricNamespace("upvotes", "comments"),
  youtube: metricNamespace("views", "likes", "comments"),
  reddit: metricNamespace("upvotes", "comments"),
  hacker_news: metricNamespace("points", "upvotes", "comments"),
  bilibili: metricNamespace("views", "plays", "likes", "comments", "shares", "saves")
});

export function isMetricAllowedForPlatform(platform: V5Platform, metric: V5MetricFeature): boolean {
  return V5_PREREG_PLATFORM_METRICS[platform]?.includes(metric) ?? false;
}

function metricNamespace(...metrics: V5MetricFeature[]): readonly V5MetricFeature[] {
  return Object.freeze(metrics);
}

export const V5_PREREG_SPLIT = Object.freeze({
  trainStart: "2026-07-21T05:00:00.000Z",
  trainEnd: "2026-09-15T04:59:59.999Z",
  validationEnd: "2026-10-13T04:59:59.999Z",
  testEnd: "2026-11-10T05:59:59.999Z",
  groupByEntity: false,
  groupByBatch: false
}) satisfies Readonly<V5SplitSpec>;
