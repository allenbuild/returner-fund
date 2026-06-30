import type { BaselineReliability, Platform } from "./types";

export interface PlatformBaselineSeed {
  platform: Platform;
  metricName: string;
  segment: string;
  value: number;
  sourceUrl: string;
  sourceTitle: string;
  collectedAt: string;
  reliability: Exclude<BaselineReliability, "none">;
  notes: string;
}

const BASELINE_SEEDS: PlatformBaselineSeed[] = [
  {
    platform: "instagram",
    metricName: "engagement_rate",
    segment: "public startup/account benchmark placeholder",
    value: 0.015,
    sourceUrl: "https://www.socialinsider.io/blog/social-media-industry-benchmarks/",
    sourceTitle: "Social media industry benchmarks",
    collectedAt: "2026-06-27",
    reliability: "medium",
    notes:
      "Use only as a platform-local context hint; Instagram engagement should not be directly compared with GitHub, LinkedIn, X, or other platform metrics."
  },
  {
    platform: "linkedin",
    metricName: "engagement_rate",
    segment: "public B2B page benchmark placeholder",
    value: 0.02,
    sourceUrl: "https://www.socialinsider.io/blog/social-media-industry-benchmarks/",
    sourceTitle: "Social media industry benchmarks",
    collectedAt: "2026-06-27",
    reliability: "low",
    notes:
      "Use only as a weak platform-local prior until curated LinkedIn startup baselines are reviewed; values should not be directly compared across platforms."
  }
];

const RELIABILITY_RANK: Record<BaselineReliability, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3
};

export function baselineSeedsForPlatform(platform: Platform): PlatformBaselineSeed[] {
  return BASELINE_SEEDS.filter((seed) => seed.platform === platform);
}

export function strongestBaselineReliability(platform: Platform): BaselineReliability {
  const seeds = baselineSeedsForPlatform(platform);
  if (seeds.length === 0) {
    return "none";
  }

  return seeds.reduce<BaselineReliability>((strongest, seed) => {
    return RELIABILITY_RANK[seed.reliability] > RELIABILITY_RANK[strongest] ? seed.reliability : strongest;
  }, "none");
}
