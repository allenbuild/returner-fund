import {
  dedupeEvidenceForScoring,
  hasEvidenceIdentityConflict,
  nativeEvidenceIdentityFromUrl
} from "./dedupe";
import type {
  EvidenceItem,
  EvidenceMetrics,
  Platform,
  ScoreBreakdown,
  ScoreConfidence,
  WeightedPlatformScore
} from "./types";
import { TRACTION_SCORING_CONFIG, normalizeMetricsForScoring, weightedMetricSum } from "./traction-scoring-config";

export const TRACTION_PLATFORM_WEIGHTS = TRACTION_SCORING_CONFIG.platformWeights;

const SUPPORTED_PLATFORM_COUNT = Object.keys(TRACTION_PLATFORM_WEIGHTS).length;

export interface ScoringEligibility {
  eligible: boolean;
  reason:
    | "eligible"
    | "unsupported_platform"
    | "not_verified"
    | "invalid_link"
    | "identity_conflict"
    | "not_native_evidence"
    | "no_visible_metrics"
    | "future_observation"
    | "upstream_excluded";
}

export interface EvidenceScoreNormalizationOptions {
  asOf?: string | Date;
}

export function normalizeEvidenceScores<T extends EvidenceItem>(
  items: T[],
  options: EvidenceScoreNormalizationOptions | string | Date = {}
): T[] {
  const explicitAsOf = normalizeExplicitAsOf(options);
  const rows = items.map((item) => {
    const eligibility = temporalScoringEligibility(item, explicitAsOf);
    const rawEngagement = computeEvidenceRawEngagement(item.platform, item.metrics);
    return { item, eligibility, rawEngagement };
  });
  return rows.map(({ item, eligibility, rawEngagement }) => {
    if (eligibility.reason === "unsupported_platform" && isVerifiedNativeUnscoredEvidence(item)) {
      const limitation = `No calibrated traction model is configured for ${item.platform}; verified native evidence is retained but unscored.`;
      return {
        ...item,
        rawEngagement: undefined,
        normalizedScore: undefined,
        // The legacy numeric field remains transport-compatible; tractionStatus owns the semantics.
        contributionScore: 0,
        tractionStatus: "unscored" as const,
        tractionLimitations: [...new Set([...(item.tractionLimitations ?? []), limitation])],
        why: replaceCanonicalScoreRationale(item.why, limitation)
      };
    }

    if (!eligibility.eligible || rawEngagement <= 0) {
      return {
        ...item,
        rawEngagement: round(rawEngagement, 2),
        normalizedScore: 0,
        contributionScore: 0,
        why: replaceCanonicalScoreRationale(
          item.why,
          `Excluded from ${TRACTION_SCORING_CONFIG.name}: ${eligibility.reason}.`
        )
      };
    }

    const absoluteScore = absoluteEvidenceScore(item.platform, rawEngagement);
    const normalizedScore = Math.round(clamp(absoluteScore, 1, 100));

    return {
      ...item,
      rawEngagement: round(rawEngagement, 2),
      normalizedScore,
      contributionScore: normalizedScore,
      tractionStatus: "scored" as const,
      tractionLimitations: undefined,
      why: replaceCanonicalScoreRationale(
        item.why,
        `${TRACTION_SCORING_CONFIG.name}: raw ${round(rawEngagement, 2)}, absolute ${round(
          absoluteScore,
          1
        )}, cohort evidence adjustment disabled for monotonicity, publication age excluded; scored ${normalizedScore}/100.`
      )
    };
  });
}

export function computeEvidenceRawEngagement(platform: Platform, metrics: EvidenceMetrics): number {
  return round(Math.max(0, weightedMetricSum(platform, metrics)), 4);
}

export function scoringEligibility(item: EvidenceItem): ScoringEligibility {
  if (!isWeightedPlatform(item.platform)) return { eligible: false, reason: "unsupported_platform" };
  if (item.review_state !== "verified") return { eligible: false, reason: "not_verified" };
  if (item.linkStatus === "invalid" || item.linkStatus === "blocked") return { eligible: false, reason: "invalid_link" };
  if (!Number.isFinite(item.contributionScore) || item.contributionScore <= 0) {
    return { eligible: false, reason: "upstream_excluded" };
  }
  if (!isNativeEvidenceUrl(item.platform, item.sourceUrl)) return { eligible: false, reason: "not_native_evidence" };
  if (hasEvidenceIdentityConflict(item)) return { eligible: false, reason: "identity_conflict" };
  if (computeEvidenceRawEngagement(item.platform, item.metrics) <= 0) {
    return { eligible: false, reason: "no_visible_metrics" };
  }
  return { eligible: true, reason: "eligible" };
}

export function isNativeEvidenceUrl(platform: Platform, rawUrl: string): boolean {
  return nativeEvidenceIdentityFromUrl(platform, rawUrl) !== null;
}

export function isVerifiedNativeUnscoredEvidence(item: EvidenceItem): boolean {
  return (
    item.review_state === "verified" &&
    item.linkStatus !== "invalid" &&
    item.linkStatus !== "blocked" &&
    nativeEvidenceIdentityFromUrl(item.platform, item.sourceUrl) !== null &&
    !hasEvidenceIdentityConflict(item)
  );
}

export function aggregateBalancedTractionScore(items: EvidenceItem[]): ScoreBreakdown {
  const uniqueItems = dedupeEvidenceForScoring(
    items.filter((item) => scoringEligibility(item).eligible)
  );
  const platformScores = platformScoresFromEvidence(uniqueItems);
  const evidenceCounts = evidenceCountsByPlatform(uniqueItems);
  const primaryPlatform = primaryPlatformFromScores(platformScores);
  const availableWeight = configuredPlatformWeight(platformScores);
  const weightedPlatforms = weightedPlatformScores(
    platformScores,
    evidenceCounts,
    primaryPlatform
  );
  const platformsWithEvidence = weightedPlatforms.length;
  const scoredEvidenceCount = uniqueItems.length;
  const weightedAvailableScore =
    availableWeight > 0
      ? weightedPlatforms.reduce(
        (sum, item) => sum + item.score * item.configuredWeight,
        0
      ) / availableWeight
      : 0;
  const absoluteScoreValue = clamp(
    weightedPlatforms.reduce((sum, item) => sum + item.score * item.appliedWeight, 0),
    0,
    100
  );
  const absoluteScore = absoluteScoreValue > 0 ? Math.max(1, Math.round(absoluteScoreValue)) : 0;
  const coverageFactor = availableWeight;
  const confidence = scoreConfidence(uniqueItems, platformsWithEvidence);
  const limitations = scoreLimitations(uniqueItems, platformsWithEvidence);
  const unscoredPlatforms = [...new Set(
    items.filter((item) => item.tractionStatus === "unscored").map((item) => item.platform)
  )];
  if (unscoredPlatforms.length) {
    limitations.push(
      `Verified native evidence from ${unscoredPlatforms.join(", ")} is retained but unscored because no calibrated model is configured.`
    );
  }
  const evidenceAsOf = latestEvidenceTimestamp(uniqueItems);
  const topPlatform = primaryPlatform
    ? weightedPlatforms.find((item) => item.platform === primaryPlatform)
    : undefined;
  const explanation = topPlatform
    ? `${topPlatform.platform} is the primary signal at ${topPlatform.score}/100 and contributes ` +
      `${round(topPlatform.contribution, 1)} points under the bounded 95/5 blend. ` +
      `${scoredEvidenceCount} unique native evidence row${scoredEvidenceCount === 1 ? "" : "s"} across ` +
      `${platformsWithEvidence}/${SUPPORTED_PLATFORM_COUNT} supported platforms produce ${absoluteScore}/100 ` +
      `with missing-platform influence capped at five points; cohort rank does not change the score.`
    : "No verified native evidence with visible traction metrics was eligible for scoring.";

  return {
    modelId: TRACTION_SCORING_CONFIG.modelId,
    modelVersion: TRACTION_SCORING_CONFIG.version,
    modelName: TRACTION_SCORING_CONFIG.name,
    totalScore: absoluteScore,
    absoluteScore,
    weightedAvailableScore: round(weightedAvailableScore, 2),
    coverageFactor: round(coverageFactor, 3),
    platformsWithEvidence,
    totalSupportedPlatforms: SUPPORTED_PLATFORM_COUNT,
    platformScores,
    weightedPlatforms,
    signalFamilyScores: signalFamilyScores(uniqueItems),
    confidence,
    calibration: {
      method: "none",
      cohortSize: 0,
      percentile: null,
      inputScore: absoluteScore
    },
    limitations,
    evidenceAsOf,
    explanation
  };
}

export function platformScoresFromEvidence(items: EvidenceItem[]): Partial<Record<Platform, number>> {
  const grouped = new Map<Platform, EvidenceItem[]>();

  for (const item of dedupeEvidenceForScoring(
    items.filter((candidate) => scoringEligibility(candidate).eligible)
  )) {
    grouped.set(item.platform, [...(grouped.get(item.platform) ?? []), item]);
  }

  return Object.fromEntries(
    [...grouped.entries()].map(([platform, platformItems]) => [platform, aggregatePlatformEvidenceScore(platformItems)])
  ) as Partial<Record<Platform, number>>;
}

function weightedPlatformScores(
  platformScores: Partial<Record<Platform, number>>,
  evidenceCounts: Map<Platform, number>,
  primaryPlatform: Platform | null
): WeightedPlatformScore[] {
  const entries = Object.entries(platformScores) as Array<[Platform, number]>;
  const contributions = entries.map(([platform, score]) => {
    const configuredWeight = TRACTION_PLATFORM_WEIGHTS[platform] ?? 0;
    const corroborationWeight =
      TRACTION_SCORING_CONFIG.diversifiedPlatformWeight * configuredWeight;
    const appliedWeight = corroborationWeight + (
      platform === primaryPlatform ? TRACTION_SCORING_CONFIG.strongestPlatformWeight : 0
    );
    const contribution = score * appliedWeight;
    return { platform, score, configuredWeight, appliedWeight, contribution };
  });

  return contributions
    .filter((item) => item.configuredWeight > 0)
    .map((item) => ({
      ...item,
      contribution: round(item.contribution, 2),
      evidenceCount: evidenceCounts.get(item.platform) ?? 0
    }))
    .sort(
      (left, right) =>
        right.contribution - left.contribution ||
        right.score - left.score ||
        right.configuredWeight - left.configuredWeight ||
        left.platform.localeCompare(right.platform)
    );
}

function primaryPlatformFromScores(
  platformScores: Partial<Record<Platform, number>>
): Platform | null {
  const candidates = (Object.entries(platformScores) as Array<[Platform, number]>)
    .filter(([platform, score]) =>
      (TRACTION_PLATFORM_WEIGHTS[platform] ?? 0) > 0 && Number.isFinite(score) && score > 0
    )
    .sort(
      ([leftPlatform, leftScore], [rightPlatform, rightScore]) =>
        rightScore - leftScore ||
        (TRACTION_PLATFORM_WEIGHTS[rightPlatform] ?? 0) -
          (TRACTION_PLATFORM_WEIGHTS[leftPlatform] ?? 0) ||
        leftPlatform.localeCompare(rightPlatform)
    );
  return candidates[0]?.[0] ?? null;
}

function configuredPlatformWeight(
  platformScores: Partial<Record<Platform, number>>
): number {
  return (Object.entries(platformScores) as Array<[Platform, number]>).reduce(
    (sum, [platform, score]) =>
      Number.isFinite(score) && score > 0
        ? sum + (TRACTION_PLATFORM_WEIGHTS[platform] ?? 0)
        : sum,
    0
  );
}

function evidenceCountsByPlatform(items: EvidenceItem[]): Map<Platform, number> {
  const counts = new Map<Platform, number>();
  for (const item of dedupeEvidenceForScoring(items)) {
    if (!scoringEligibility(item).eligible) continue;
    counts.set(item.platform, (counts.get(item.platform) ?? 0) + 1);
  }
  return counts;
}

function aggregatePlatformEvidenceScore(items: EvidenceItem[]): number {
  const scores = items
    .map((item) => item.contributionScore)
    .filter((score) => Number.isFinite(score) && score > 0)
    .sort((left, right) => right - left)
    .slice(0, TRACTION_SCORING_CONFIG.platformEvidenceSlots.length);

  return Math.round(
    scores.reduce((sum, score, index) => sum + score * (TRACTION_SCORING_CONFIG.platformEvidenceSlots[index] ?? 0), 0)
  );
}

function absoluteEvidenceScore(platform: Platform, rawEngagement: number): number {
  const reference = TRACTION_SCORING_CONFIG.platformReferences[platform]?.highEngagement ?? 10_000;
  const boundedScore = clamp(
    (Math.log1p(rawEngagement) / Math.log1p(reference)) * 100,
    0,
    100
  );
  return boundedScore * TRACTION_SCORING_CONFIG.scoreLevelMultiplier;
}

function scoreConfidence(items: EvidenceItem[], platformsWithEvidence: number): ScoreConfidence {
  if (!items.length) {
    return {
      level: "low",
      value: 0,
      reasons: ["No eligible native traction evidence."],
      scoredEvidenceCount: 0,
      datedEvidenceCount: 0,
      verifiedLinkCount: 0
    };
  }
  const datedEvidenceCount = items.filter((item) => item.publishedAtPrecision !== "unknown" && Boolean(parseDate(item.postedAt))).length;
  const verifiedLinkCount = items.filter((item) => item.linkStatus === "verified").length;
  const confidenceConfig = TRACTION_SCORING_CONFIG.confidence;
  const depth = 1 - Math.exp(-items.length / confidenceConfig.evidenceDepthScale);
  const breadth = Math.sqrt(platformsWithEvidence / SUPPORTED_PLATFORM_COUNT);
  const dateCompleteness = datedEvidenceCount / items.length;
  const linkCompleteness = verifiedLinkCount / items.length;
  const value = round(clamp(
    confidenceConfig.base +
      depth * confidenceConfig.evidenceDepthWeight +
      breadth * confidenceConfig.platformBreadthWeight +
      dateCompleteness * confidenceConfig.publicationDateWeight +
      linkCompleteness * confidenceConfig.verifiedLinkWeight,
    0,
    1
  ), 3);
  const reasons = [
    `${items.length} unique scored row${items.length === 1 ? "" : "s"}.`,
    `${platformsWithEvidence} platform${platformsWithEvidence === 1 ? "" : "s"} represented.`,
    `${datedEvidenceCount}/${items.length} rows have publication dates.`
  ];
  if (verifiedLinkCount < items.length) reasons.push(`${verifiedLinkCount}/${items.length} links were explicitly rechecked.`);
  return {
    level:
      value >= confidenceConfig.highThreshold
        ? "high"
        : value >= confidenceConfig.mediumThreshold
          ? "medium"
          : "low",
    value,
    reasons,
    scoredEvidenceCount: items.length,
    datedEvidenceCount,
    verifiedLinkCount
  };
}

function scoreLimitations(items: EvidenceItem[], platformsWithEvidence: number): string[] {
  const limitations: string[] = [];
  if (!items.length) return ["No eligible native evidence with visible metrics."];
  if (items.length < 3) limitations.push("Sparse evidence: fewer than three unique scored items.");
  if (platformsWithEvidence === 1) limitations.push("Single-platform score; cross-platform corroboration is unavailable.");
  const unknownDates = items.filter((item) => item.publishedAtPrecision === "unknown" || !parseDate(item.postedAt)).length;
  if (unknownDates) limitations.push(`${unknownDates} item${unknownDates === 1 ? " has" : "s have"} no verified publication date.`);
  const unchecked = items.filter((item) => item.linkStatus !== "verified").length;
  if (unchecked) limitations.push(`${unchecked} item link${unchecked === 1 ? " was" : "s were"} not explicitly rechecked in this snapshot.`);
  return limitations;
}

function signalFamilyScores(items: EvidenceItem[]): ScoreBreakdown["signalFamilyScores"] {
  return {
    reach: familyScore(items.filter((item) => positiveMetric(item.metrics.views))),
    engagement: familyScore(items.filter((item) => {
      const metrics = normalizeMetricsForScoring(item.platform, item.metrics);
      return [metrics.likes, metrics.reactions, metrics.comments, metrics.replies, metrics.shares, metrics.reposts, metrics.quotes].some(positiveMetric);
    })),
    developerAdoption: familyScore(items.filter((item) => item.platform === "github")),
    launchAndCommunity: familyScore(items.filter((item) => ["product_hunt", "hacker_news", "reddit"].includes(item.platform))),
    // Publication age is deliberately excluded from scoring. Keep the legacy
    // response field at a neutral zero until a non-temporal momentum signal is
    // defined and calibrated.
    momentum: 0
  };
}

function familyScore(items: EvidenceItem[]): number {
  const scores = dedupeEvidenceForScoring(items)
    .map((item) => item.contributionScore)
    .filter((score) => score > 0)
    .sort((left, right) => right - left);
  const slots = [0.55, 0.25, 0.12];
  const primary = slots.reduce((sum, weight, index) => sum + (scores[index] ?? 0) * weight, 0);
  const tail = scores.slice(3).reduce((sum, score) => sum + score / 100, 0);
  return Math.round(clamp(primary + 8 * (1 - Math.exp(-tail / 3)), 0, 100));
}

function latestEvidenceTimestamp(items: EvidenceItem[]): string | null {
  return latestPhysicalObservation(items)?.toISOString() ?? null;
}

function positiveMetric(value: number | undefined): boolean {
  return Number.isFinite(value) && Number(value) > 0;
}

function isWeightedPlatform(platform: Platform): boolean {
  return (TRACTION_PLATFORM_WEIGHTS[platform] ?? 0) > 0;
}

function normalizeExplicitAsOf(options: EvidenceScoreNormalizationOptions | string | Date): Date | null {
  const value = typeof options === "string" || options instanceof Date ? options : options.asOf;
  if (value === undefined) return null;
  const parsed = parseDate(value);
  if (!parsed) throw new TypeError("normalizeEvidenceScores asOf must be a valid date");
  return parsed;
}

function temporalScoringEligibility(
  item: EvidenceItem,
  explicitAsOf: Date | null
): ScoringEligibility {
  const eligibility = scoringEligibility(item);
  if (!eligibility.eligible || !explicitAsOf) return eligibility;

  const availableAt = latestItemAvailability(item);
  return availableAt && availableAt.getTime() > explicitAsOf.getTime()
    ? { eligible: false, reason: "future_observation" }
    : eligibility;
}

function latestItemAvailability(item: EvidenceItem): Date | null {
  const ingestedAt = (item as EvidenceItem & { ingestedAt?: string | null }).ingestedAt;
  const timestamps = [
    item.observedAt,
    item.metricsCheckedAt,
    ingestedAt,
    item.first_seen_at,
    item.last_checked_at,
    item.last_updated_at
  ];
  const latest = Math.max(0, ...timestamps.map((value) => parseDate(value)?.getTime() ?? 0));
  return latest > 0 ? new Date(latest) : null;
}

function latestPhysicalObservation(items: EvidenceItem[]): Date | null {
  const timestamps = items.flatMap((item) => {
    const ingestedAt = (item as EvidenceItem & { ingestedAt?: string | null }).ingestedAt;
    return [item.observedAt, item.metricsCheckedAt, ingestedAt];
  });
  const latest = Math.max(
    0,
    ...timestamps.map((value) => parseDate(value)?.getTime() ?? 0)
  );
  return latest > 0 ? new Date(latest) : null;
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function replaceCanonicalScoreRationale(base: string, addition: string): string {
  const modelName = escapeRegExp(TRACTION_SCORING_CONFIG.name);
  const withoutPriorRationale = base
    .replace(
      new RegExp(`(?:^|\\s+)${modelName}: raw [\\s\\S]*?; scored \\d+(?:\\.\\d+)?/100\\.`, "g"),
      " "
    )
    .replace(new RegExp(`(?:^|\\s+)Excluded from ${modelName}: [a-z_]+\\.`, "g"), " ")
    .replace(
      /(?:^|\s+)No calibrated traction model is configured for [a-z_]+; verified native evidence is retained but unscored\./g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  return `${withoutPriorRationale} ${addition}`.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const scaled = value * factor;
  const roundingGuard = Number.EPSILON * Math.max(1, Math.abs(scaled));
  return Number.isFinite(scaled) ? Math.round(scaled + roundingGuard) / factor : value;
}
