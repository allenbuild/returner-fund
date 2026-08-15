import type { DashboardCandidate, DashboardScoreBreakdown } from "./contracts";
import {
  clamp,
  dashboardPlatformForCandidate,
  engagementMass,
  finiteMetric,
  round,
  safeDate
} from "./normalization";

const HOUR_MS = 60 * 60 * 1_000;
const FRESHNESS_HALF_LIFE_HOURS = 9;

/**
 * Relative performance is measured against the source's own historical
 * baseline when available. Missing baselines are deliberately neutral rather
 * than guessed from a giant-account multiplier.
 */
export function relativeViralityScore(candidate: Pick<DashboardCandidate, "metrics" | "accountBaseline" | "followerCount">): number {
  const observed = engagementMass(candidate.metrics);
  const baseline = engagementMass(candidate.accountBaseline);
  if (baseline > 0) {
    // 1x expected performance maps to 50.  The logarithm prevents a single
    // outlier from overpowering all other signals.
    return round(clamp(50 + 24 * Math.log2(Math.max(observed, 0.01) / baseline), 0, 100));
  }

  const followers = finiteMetric(candidate.followerCount);
  if (followers > 0) {
    const engagementRate = observed / followers;
    // A conservative follower-normalized fallback: 1% maps near neutral,
    // while still avoiding an assertion about a platform-wide baseline.
    return round(clamp(50 + 18 * Math.log2(Math.max(engagementRate, 0.00001) / 0.01), 0, 100));
  }

  return 50;
}

/** Only real append-only observations contribute velocity; a single scrape never fabricates it. */
export function velocityScore(
  candidate: Pick<DashboardCandidate, "metrics" | "metricHistory" | "publishedAt">,
  now = new Date()
): number {
  const observations = [...(candidate.metricHistory ?? [])]
    .map((item) => ({ ...item, date: safeDate(item.observedAt) }))
    .filter((item): item is typeof item & { date: Date } => item.date !== null)
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  if (observations.length < 2) return 0;

  const current = observations.at(-1)!;
  const previous = [...observations].reverse().find((item) =>
    item.date.getTime() < current.date.getTime() && current.date.getTime() - item.date.getTime() <= 6 * HOUR_MS
  );
  if (!previous) return 0;

  const elapsedHours = Math.max((current.date.getTime() - previous.date.getTime()) / HOUR_MS, 0.1);
  const gain = Math.max(0, engagementMass(current.metrics) - engagementMass(previous.metrics));
  const ageHours = Math.max(0.25, (now.getTime() - new Date(candidate.publishedAt).getTime()) / HOUR_MS);
  const perHour = gain / elapsedHours;
  // The denominator gently reduces the advantage of an older post collecting
  // a large total; this is a velocity signal, not raw engagement.
  const ageNormalized = perHour / Math.sqrt(ageHours);
  return round(clamp(16 * Math.log2(1 + ageNormalized), 0, 100));
}

export function freshnessScore(publishedAt: string, now = new Date()): number {
  const date = safeDate(publishedAt);
  if (!date) return 0;
  const ageHours = (now.getTime() - date.getTime()) / HOUR_MS;
  if (ageHours < 0) return 0;
  return round(clamp(100 * Math.exp((-Math.LN2 * ageHours) / FRESHNESS_HALF_LIFE_HOURS), 0, 100));
}

/**
 * Normalizes raw attention within each native platform population. This avoids
 * equating an HN point, a YouTube view, and a LinkedIn reaction.
 */
export function platformNormalizedSignificance(
  candidates: readonly Pick<DashboardCandidate, "id" | "platform" | "sourceKind" | "metrics">[]
): Map<string, number> {
  const grouped = new Map<string, Array<{ id: string; mass: number }>>();
  for (const candidate of candidates) {
    const platform = dashboardPlatformForCandidate(candidate as DashboardCandidate);
    const group = grouped.get(platform) ?? [];
    group.push({ id: candidate.id, mass: engagementMass(candidate.metrics) });
    grouped.set(platform, group);
  }

  const scores = new Map<string, number>();
  for (const group of grouped.values()) {
    const ordered = [...group].sort((left, right) => left.mass - right.mass || left.id.localeCompare(right.id));
    const denominator = Math.max(1, ordered.length - 1);
    ordered.forEach((item, index) => scores.set(item.id, round(15 + 85 * (index / denominator))));
  }
  return scores;
}

export function sourceQualityScore(candidate: Pick<DashboardCandidate, "sourceQuality" | "sourceKind">): number {
  if (typeof candidate.sourceQuality === "number" && Number.isFinite(candidate.sourceQuality)) {
    return round(clamp(candidate.sourceQuality));
  }
  const defaults: Record<DashboardCandidate["sourceKind"], number> = {
    paper: 78,
    repository: 70,
    release: 72,
    launch: 66,
    article: 62,
    video: 60,
    discussion: 58,
    thread: 56,
    post: 54,
    other: 45
  };
  return defaults[candidate.sourceKind];
}

/**
 * Independent confirmation requires sources marked as independently reported.
 * A company copying its launch to six owned accounts remains a zero-bonus
 * distribution event, while an HN/Reddit/news conversation earns support.
 */
export function crossPlatformConfirmationScore(candidates: readonly DashboardCandidate[]): number {
  const independent = candidates.filter((candidate) => candidate.independentlyReported === true);
  const platforms = new Set(independent.map((candidate) => dashboardPlatformForCandidate(candidate)));
  if (platforms.size < 2) return 0;
  const platformStrength = 19 * (platforms.size - 1);
  const sourceStrength = 5 * Math.max(0, independent.length - platforms.size);
  return round(clamp(platformStrength + sourceStrength, 0, 100));
}

export function scoreDashboardStory(
  candidates: readonly DashboardCandidate[],
  options: { now: Date; absoluteSignificance: ReadonlyMap<string, number> }
): DashboardScoreBreakdown & { trendScore: number; breakingScore: number; emergingScore: number } {
  const primary = strongestCandidate(candidates, options.absoluteSignificance);
  const relativeVirality = weightedCandidateAverage(candidates, (candidate) => relativeViralityScore(candidate));
  const velocity = weightedCandidateAverage(candidates, (candidate) => velocityScore(candidate, options.now));
  const freshness = weightedCandidateAverage(candidates, (candidate) => freshnessScore(candidate.publishedAt, options.now));
  const absoluteSignificance = weightedCandidateAverage(
    candidates,
    (candidate) => options.absoluteSignificance.get(candidate.id) ?? 15
  );
  const sourceQuality = weightedCandidateAverage(candidates, sourceQualityScore);
  const crossPlatformConfirmation = crossPlatformConfirmationScore(candidates);
  const trendScore = round(clamp(
    relativeVirality * 0.22 +
    velocity * 0.25 +
    freshness * 0.19 +
    crossPlatformConfirmation * 0.13 +
    sourceQuality * 0.08 +
    absoluteSignificance * 0.13
  ));
  const breakingScore = round(clamp(
    velocity * 0.49 + freshness * 0.24 + relativeVirality * 0.12 + crossPlatformConfirmation * 0.08 + absoluteSignificance * 0.07
  ));
  // Emerging emphasizes unusual performance and acceleration before it has a
  // huge absolute footprint. It is a view over the same stories, never a new
  // ingestion/re-ranking universe.
  const emergingScore = round(clamp(
    relativeVirality * 0.46 + velocity * 0.31 + freshness * 0.12 + sourceQuality * 0.06 + (100 - absoluteSignificance) * 0.05
  ));

  void primary; // Retains a clear extension point for source-specific score explanations.
  return {
    relativeVirality: round(relativeVirality),
    velocity: round(velocity),
    freshness: round(freshness),
    crossPlatformConfirmation: round(crossPlatformConfirmation),
    sourceQuality: round(sourceQuality),
    absoluteSignificance: round(absoluteSignificance),
    trendScore,
    breakingScore,
    emergingScore
  };
}

function weightedCandidateAverage(
  candidates: readonly DashboardCandidate[],
  scorer: (candidate: DashboardCandidate) => number
): number {
  const weights = candidates.map((candidate) => Math.max(1, Math.sqrt(engagementMass(candidate.metrics) + 1)));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (!weightSum) return 0;
  return candidates.reduce((sum, candidate, index) => sum + scorer(candidate) * weights[index], 0) / weightSum;
}

function strongestCandidate(candidates: readonly DashboardCandidate[], significance: ReadonlyMap<string, number>): DashboardCandidate | null {
  return [...candidates].sort((left, right) =>
    (significance.get(right.id) ?? 0) - (significance.get(left.id) ?? 0) || left.id.localeCompare(right.id)
  )[0] ?? null;
}
