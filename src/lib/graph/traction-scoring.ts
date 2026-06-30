import type { EvidenceItem, EvidenceMetrics, Platform, ScoreBreakdown, WeightedPlatformScore } from "./types";
import { TRACTION_SCORING_CONFIG, weightedMetricSum } from "./traction-scoring-config";

export const TRACTION_PLATFORM_WEIGHTS = TRACTION_SCORING_CONFIG.platformWeights;

const SUPPORTED_PLATFORM_COUNT = Object.keys(TRACTION_PLATFORM_WEIGHTS).length;
const VIEW_HEAVY_PLATFORMS = new Set<Platform>(["x", "instagram", "linkedin", "youtube", "bilibili"]);

export function normalizeEvidenceScores<T extends EvidenceItem>(items: T[]): T[] {
  const rows = items.map((item) => ({
    item,
    rawEngagement: computeEvidenceRawEngagement(item.platform, item.metrics),
    recencyWeight: computeEvidenceRecencyWeight(item),
    eligible: item.contributionScore > 0 && isScoredPlatform(item.platform)
  }));
  const samplesByPlatform = new Map<Platform, number[]>();

  for (const row of rows) {
    const adjustedEngagement = row.rawEngagement * row.recencyWeight;
    if (!row.eligible || adjustedEngagement <= 0) {
      continue;
    }
    samplesByPlatform.set(row.item.platform, [
      ...(samplesByPlatform.get(row.item.platform) ?? []),
      Math.log1p(adjustedEngagement)
    ]);
  }

  return rows.map(({ item, rawEngagement, recencyWeight, eligible }) => {
    const adjustedEngagement = rawEngagement * recencyWeight;
    const logEngagement = Math.log1p(adjustedEngagement);
    const normalizedScore =
      eligible && adjustedEngagement > 0
        ? logNormalize(samplesByPlatform.get(item.platform) ?? [], logEngagement)
        : 0;
    const rawText = rawEngagement > 0 ? ` Raw engagement ${round(rawEngagement, 2)}.` : "";
    const recencyText =
      rawEngagement > 0 ? ` Recency-adjusted by ${round(recencyWeight, 3)} to ${round(adjustedEngagement, 2)}.` : "";
    const scoreText = normalizedScore > 0 ? ` Log-normalized ${normalizedScore}/100 within ${item.platform}.` : "";

    return {
      ...item,
      rawEngagement: round(rawEngagement, 2),
      normalizedScore,
      contributionScore: normalizedScore,
      why: `${item.why}${rawText}${recencyText}${scoreText}`
    };
  });
}

export function computeEvidenceRawEngagement(platform: Platform, metrics: EvidenceMetrics): number {
  const weighted = weightedMetricSum(platform, metrics);
  if (weighted > 0) {
    return weighted;
  }

  return weightedMetricSum("x", metrics);
}

export function aggregateBalancedTractionScore(items: EvidenceItem[]): ScoreBreakdown {
  const platformScores = platformScoresFromEvidence(items);
  const evidenceCounts = evidenceCountsByPlatform(items);
  const weightedPlatforms = weightedPlatformScores(platformScores, evidenceCounts);
  const availableWeight = weightedPlatforms.reduce((sum, item) => sum + item.configuredWeight, 0);
  const weightedAvailableScore =
    availableWeight > 0
      ? weightedPlatforms.reduce((sum, item) => sum + item.score * item.configuredWeight, 0) / availableWeight
      : 0;
  const platformsWithEvidence = weightedPlatforms.length;
  const coverageFactor =
    platformsWithEvidence > 0
      ? 0.85 + 0.15 * Math.sqrt(platformsWithEvidence / SUPPORTED_PLATFORM_COUNT)
      : 0;
  const totalScore = Math.round(weightedAvailableScore * coverageFactor);
  const topPlatform = weightedPlatforms[0];
  const explanation =
    platformsWithEvidence === 0
      ? "No scored GitHub or social evidence found."
      : `${topPlatform.platform} contributes ${topPlatform.contribution} weighted points from ${topPlatform.score}/100 before coverage. ${platformsWithEvidence}/${SUPPORTED_PLATFORM_COUNT} weighted platforms have evidence, applying ${round(
          coverageFactor,
          3
        )} coverage.`;

  return {
    totalScore,
    weightedAvailableScore: round(weightedAvailableScore, 2),
    coverageFactor: round(coverageFactor, 3),
    platformsWithEvidence,
    totalSupportedPlatforms: SUPPORTED_PLATFORM_COUNT,
    platformScores,
    weightedPlatforms,
    explanation
  };
}

export function platformScoresFromEvidence(items: EvidenceItem[]): Partial<Record<Platform, number>> {
  const grouped = new Map<Platform, EvidenceItem[]>();

  for (const item of items.filter((candidate) => candidate.contributionScore > 0 && isWeightedPlatform(candidate.platform))) {
    grouped.set(item.platform, [...(grouped.get(item.platform) ?? []), item]);
  }

  return Object.fromEntries(
    [...grouped.entries()].map(([platform, platformItems]) => [
      platform,
      aggregatePlatformEvidenceScore(platform, platformItems)
    ])
  ) as Partial<Record<Platform, number>>;
}

function weightedPlatformScores(
  platformScores: Partial<Record<Platform, number>>,
  evidenceCounts: Map<Platform, number>
): WeightedPlatformScore[] {
  const availableWeight = Object.entries(platformScores).reduce(
    (sum, [platform]) => sum + (TRACTION_PLATFORM_WEIGHTS[platform as Platform] ?? 0),
    0
  );

  return (Object.entries(platformScores) as [Platform, number][])
    .map(([platform, score]) => {
      const configuredWeight = TRACTION_PLATFORM_WEIGHTS[platform] ?? 0;
      const appliedWeight = availableWeight > 0 ? configuredWeight / availableWeight : 0;

      return {
        platform,
        score,
        configuredWeight,
        appliedWeight: round(appliedWeight, 4),
        contribution: round(score * appliedWeight, 2),
        evidenceCount: evidenceCounts.get(platform) ?? 0
      };
    })
    .filter((item) => item.configuredWeight > 0)
    .sort((left, right) => right.contribution - left.contribution || right.score - left.score);
}

function evidenceCountsByPlatform(items: EvidenceItem[]): Map<Platform, number> {
  const counts = new Map<Platform, number>();

  for (const item of items.filter((candidate) => candidate.contributionScore > 0 && isWeightedPlatform(candidate.platform))) {
    counts.set(item.platform, (counts.get(item.platform) ?? 0) + 1);
  }

  return counts;
}

function aggregatePlatformEvidenceScore(platform: Platform, items: EvidenceItem[]): number {
  const scores = items
    .map((item) => item.contributionScore)
    .filter((score) => score > 0)
    .sort((left, right) => right - left);

  if (!scores.length) {
    return 0;
  }

  if (platform === "github") {
    const primarySignal = scores[0];
    const topThreeAverage = average(scores.slice(0, 3));
    const repoDepth = Math.min(100, (Math.log1p(scores.length) / Math.log1p(20)) * 100);

    return Math.round(primarySignal * 0.78 + topThreeAverage * 0.17 + repoDepth * 0.05);
  }

  if (VIEW_HEAVY_PLATFORMS.has(platform)) {
    const primarySignal = scores[0];
    const topThreeAverage = average(scores.slice(0, 3));
    const consistency = Math.min(100, (scores.length / TRACTION_SCORING_CONFIG.topKPosts) * 100);

    return Math.round(primarySignal * 0.6 + topThreeAverage * 0.35 + consistency * 0.05);
  }

  const topScores = scores.slice(0, TRACTION_SCORING_CONFIG.topKPosts);
  const topAverage = average(topScores);
  const allAverage = average(scores);
  const consistency = Math.min(100, (scores.length / TRACTION_SCORING_CONFIG.topKPosts) * 100);

  return Math.round(topAverage * 0.7 + allAverage * 0.2 + consistency * 0.1);
}

function logNormalize(samples: number[], value: number): number {
  const finite = samples.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(value)) {
    return 0;
  }

  const min = Math.min(...finite);
  const max = Math.max(...finite);

  if (max === min) {
    return 50;
  }

  return Math.round(5 + ((value - min) / (max - min)) * 95);
}

function isScoredPlatform(platform: Platform): boolean {
  return platform !== "web" && platform !== "rss";
}

function isWeightedPlatform(platform: Platform): boolean {
  return (TRACTION_PLATFORM_WEIGHTS[platform] ?? 0) > 0;
}

function computeEvidenceRecencyWeight(item: EvidenceItem): number {
  const postedAt = parseDate(item.postedAt);
  if (!postedAt) {
    return 0.75;
  }

  const collectedAt = parseDate(item.last_checked_at ?? item.last_updated_at ?? item.first_seen_at) ?? new Date();
  const ageDays = Math.max(0, (collectedAt.getTime() - postedAt.getTime()) / 86_400_000);
  const halfLifeDays =
    TRACTION_SCORING_CONFIG.platformHalfLifeDays[item.platform] ?? TRACTION_SCORING_CONFIG.defaultHalfLifeDays;

  return Math.pow(0.5, ageDays / Math.max(halfLifeDays, 1));
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
