import {
  aggregateBalancedTractionScore,
  platformScoresFromEvidence
} from "@/lib/graph/traction-scoring";
import type {
  CompanyRecord,
  EvidenceItem,
  Platform as CanonicalPlatform
} from "@/lib/graph/types";
import type {
  CompanyScoreInput,
  EntityScoreInput,
  EntityScoreResult,
  FounderScoreInput,
  Platform,
  PlatformBreakdown,
  PlatformScoreInput,
  PlatformScoreResult,
  ReviewState
} from "./types";
import { calibrateBatchCompanyScores } from "./batch-calibration";
import { clamp, roundScore } from "./percentiles";
import { TRACTION_SCORING_CONFIG } from "./traction-config";

/** @deprecated Use TRACTION_SCORING_CONFIG.platformWeights in new code. */
export const DEFAULT_PLATFORM_WEIGHTS =
  TRACTION_SCORING_CONFIG.platformWeights as Partial<Record<Platform, number>>;

/** @deprecated New production callers should score EvidenceItem rows directly. */
export function aggregatePlatformScore(input: PlatformScoreInput): PlatformScoreResult {
  const review_state = input.account_review_state;
  const scoreablePosts = input.postScores.filter((post) => post.scoringStatus !== "unscored");
  const scoringStatus = configuredPlatformWeight(input.platform) > 0 ? "scored" : "unscored";
  const sortedPosts = [...scoreablePosts].sort(
    (left, right) => right.normalizedScore - left.normalizedScore
  );
  const topPosts = sortedPosts.slice(0, TRACTION_SCORING_CONFIG.platformEvidenceSlots.length);
  const topPostAverage =
    topPosts.length === 0
      ? 0
      : topPosts.reduce((sum, post) => sum + post.normalizedScore, 0) / topPosts.length;
  const consistencyScore = roundScore(
    (Math.min(scoreablePosts.length, TRACTION_SCORING_CONFIG.platformEvidenceSlots.length) /
      TRACTION_SCORING_CONFIG.platformEvidenceSlots.length) *
      100
  );
  const accountMetricScore =
    input.accountMetrics?.followerPercentile === null ||
    input.accountMetrics?.followerPercentile === undefined
      ? 50
      : roundScore(clamp(input.accountMetrics.followerPercentile) * 100);
  const canonicalScore = canonicalPlatformScore(
    input.entityId,
    input.platform,
    topPosts.map((post) => post.normalizedScore)
  );
  const baselineReliability = input.baselineReliability ?? "low";
  const metricAvailability =
    input.accountMetrics?.metricAvailability === null ||
    input.accountMetrics?.metricAvailability === undefined
      ? scoreablePosts.length > 0
        ? 1
        : 0
      : clamp(input.accountMetrics.metricAvailability);
  const sampleCoverage = clamp(
    scoreablePosts.length / TRACTION_SCORING_CONFIG.platformEvidenceSlots.length
  );
  const limitations: string[] = [
    "Legacy consistency and account metrics are diagnostic only; canonical v4 evidence slots compute the score."
  ];

  if (review_state !== "verified") {
    limitations.push(
      `Account is ${review_state}; it is excluded from canonical scoring until it is verified.`
    );
  }

  if (scoreablePosts.length === 0) {
    limitations.push("No post samples available for this platform.");
  }

  if (scoringStatus === "unscored") {
    limitations.push(
      `Platform ${input.platform} has no calibrated canonical v4 model; imported evidence remains unscored.`
    );
  }

  if (input.baselineReliability === "low" || input.baselineReliability === "none") {
    limitations.push(
      "Global baseline reliability is weak; canonical v4 does not use it as a score multiplier."
    );
  }

  if (
    input.accountMetrics?.followerPercentile === null ||
    input.accountMetrics?.followerPercentile === undefined
  ) {
    limitations.push("Account-level metric percentile unavailable; the diagnostic account score is neutral.");
  }

  if (input.config) {
    limitations.push("Legacy aggregation overrides are accepted but canonical v4 owns top-k configuration.");
  }

  return {
    entityId: input.entityId,
    platform: input.platform,
    score: review_state === "verified" && scoringStatus === "scored" ? canonicalScore : 0,
    scoringStatus,
    review_state,
    explanationJson: {
      platform: input.platform,
      topPostIds: topPosts.map((post) => post.postId),
      topPostAverage,
      consistencyScore,
      accountMetricScore,
      formula: {
        topPostAverageWeight: TRACTION_SCORING_CONFIG.platformEvidenceSlots[0] ?? 0,
        consistencyWeight: 0,
        accountMetricWeight: 0
      },
      qualitySignals: {
        account_review_state: review_state,
        metricAvailability,
        sampleCoverage,
        baselineReliability,
        baselineReliabilityMultiplier: 1
      },
      limitations
    }
  };
}

export function aggregateFounderScore(input: FounderScoreInput): EntityScoreResult {
  const base = aggregateEntityScores({
    entityId: input.entityId,
    batchSlug: input.batchSlug,
    platformScores: input.platformScores,
    batchPeerCompositeScores: input.batchPeerCompositeScores
  });
  const relevanceToCompany =
    input.relevanceToCompany === null || input.relevanceToCompany === undefined
      ? 1
      : clamp(input.relevanceToCompany);

  return {
    ...base,
    scoreExplanationJson: {
      ...base.scoreExplanationJson,
      qualitySignals: {
        ...base.scoreExplanationJson.qualitySignals,
        relevanceToCompany
      },
      limitations:
        input.relevanceToCompany === null || input.relevanceToCompany === undefined
          ? [
              ...base.scoreExplanationJson.limitations,
              "Founder-company relevance unavailable; compatibility metadata uses a neutral default."
            ]
          : base.scoreExplanationJson.limitations
    }
  };
}

export function aggregateCompanyScore(input: CompanyScoreInput): EntityScoreResult {
  const platforms = new Set<Platform>([
    ...input.officialAccounts.filter(isScoredVerifiedScore).map((score) => score.platform),
    ...input.founderAccounts.filter(isScoredVerifiedScore).map((score) => score.platform)
  ]);
  const platformScores: Array<PlatformScoreResult<unknown>> = [];
  const platformBreakdownOverrides = new Map<Platform, { sourceCoverage: number }>();

  for (const platform of platforms) {
    const officialScores = input.officialAccounts.filter(
      (score) => score.platform === platform && isScoredVerifiedScore(score)
    );
    const founderScores = input.founderAccounts.filter(
      (score) => score.platform === platform && isScoredVerifiedScore(score)
    );
    const hasOfficial = officialScores.length > 0;
    const hasFounder = founderScores.length > 0;
    const sourceCoverage = (Number(hasOfficial) + Number(hasFounder)) / 2;
    const score = canonicalPlatformScore(
      input.companyId,
      platform,
      [...officialScores, ...founderScores].map((platformScore) => platformScore.score)
    );

    platformScores.push({
      entityId: input.companyId,
      platform,
      score,
      scoringStatus: "scored",
      review_state: "verified",
      explanationJson: {
        platform,
        officialAccountCount: officialScores.length,
        founderAccountCount: founderScores.length,
        sourceCoverage,
        aggregation: "canonical_v4_evidence_slots",
        officialScores: officialScores.map((platformScore) => platformScore.explanationJson),
        founderScores: founderScores.map((platformScore) => platformScore.explanationJson)
      }
    });
    platformBreakdownOverrides.set(platform, { sourceCoverage });
  }

  return aggregateEntityScores(
    {
      entityId: input.companyId,
      batchSlug: input.batchSlug,
      platformScores,
      batchPeerCompositeScores: input.batchPeerCompositeScores
    },
    platformBreakdownOverrides
  );
}

/** @deprecated New production callers should use aggregateBalancedTractionScore. */
export function aggregateEntityScores(
  input: EntityScoreInput,
  platformBreakdownOverrides = new Map<Platform, { sourceCoverage: number }>()
): EntityScoreResult {
  const presentScores = input.platformScores.filter((score) => {
    return (
      configuredPlatformWeight(score.platform) > 0 &&
      score.scoringStatus !== "unscored" &&
      score.score > 0 &&
      score.review_state === "verified"
    );
  });
  const canonicalBreakdown = aggregateBalancedTractionScore(
    presentScores.flatMap((score, scoreIndex) => compatibilityEntityEvidence(score, scoreIndex))
  );
  const totalConfiguredWeight = Object.values(TRACTION_SCORING_CONFIG.platformWeights).reduce(
    (sum, weight) => sum + (weight ?? 0),
    0
  );
  const availableWeight = canonicalBreakdown.weightedPlatforms.reduce(
    (sum, score) => sum + score.configuredWeight,
    0
  );
  const platformCoverage =
    totalConfiguredWeight <= 0 ? 0 : clamp(availableWeight / totalConfiguredWeight);
  const review_state = entityReviewState(input.platformScores);
  const calibration = calibrateLegacyScore(
    input.entityId,
    canonicalBreakdown.absoluteScore,
    input.batchPeerCompositeScores
  );
  const platformScoresJson: PlatformBreakdown[] = presentScores.map((score) => {
    const canonicalPlatform = toCanonicalPlatform(score.platform);
    const canonicalScore = canonicalPlatform
      ? canonicalBreakdown.platformScores[canonicalPlatform] ?? score.score
      : 0;
    const weightedPlatform = canonicalBreakdown.weightedPlatforms.find(
      (item) => item.platform === canonicalPlatform
    );

    return {
      platform: score.platform,
      score: canonicalScore,
      review_state: score.review_state,
      sourceCoverage: platformBreakdownOverrides.get(score.platform)?.sourceCoverage ?? 1,
      appliedPlatformWeight: weightedPlatform?.appliedWeight ?? 0,
      explanationJson: score.explanationJson
    };
  });
  const limitations: string[] = [];

  if (presentScores.length === 0) {
    limitations.push("No canonical v4 platform scores available.");
  }

  if (platformCoverage < 1) {
    limitations.push("Canonical v4 coverage is incomplete across supported platforms.");
  }

  if (input.batchPeerCompositeScores === undefined) {
    limitations.push("Batch peer scores unavailable; total score is the canonical absolute score.");
  }

  return {
    entityId: input.entityId,
    batchSlug: input.batchSlug,
    totalScore: calibration.totalScore,
    review_state,
    platformScoresJson,
    scoreExplanationJson: {
      entityId: input.entityId,
      batchSlug: input.batchSlug,
      absoluteCompositeScore: canonicalBreakdown.absoluteScore,
      batchPercentile: calibration.percentile,
      platformCoverage,
      defaultPlatformWeights: DEFAULT_PLATFORM_WEIGHTS,
      platformBreakdown: platformScoresJson,
      qualitySignals: {
        review_state,
        modelId: canonicalBreakdown.modelId,
        modelVersion: canonicalBreakdown.modelVersion,
        coverageFactor: canonicalBreakdown.coverageFactor,
        weightedAvailableScore: canonicalBreakdown.weightedAvailableScore,
        platformCoverage,
        availablePlatformWeight: availableWeight,
        totalConfiguredPlatformWeight: totalConfiguredWeight
      },
      limitations
    }
  };
}

function canonicalPlatformScore(entityId: string, platform: Platform, scores: number[]): number {
  const canonicalPlatform = toCanonicalPlatform(platform);
  if (!canonicalPlatform) return 0;

  return (
    platformScoresFromEvidence(
      scores.map((score, index) =>
        compatibilityEvidence(entityId, canonicalPlatform, score, `platform:${index}`)
      )
    )[canonicalPlatform] ?? 0
  );
}

function compatibilityEntityEvidence(
  score: PlatformScoreResult<unknown>,
  scoreIndex: number
): EvidenceItem[] {
  const canonicalPlatform = toCanonicalPlatform(score.platform);
  if (!canonicalPlatform) return [];

  return TRACTION_SCORING_CONFIG.platformEvidenceSlots.map((_, slotIndex) =>
    compatibilityEvidence(
      score.entityId,
      canonicalPlatform,
      score.score,
      `entity:${scoreIndex}:${slotIndex}`
    )
  );
}

function compatibilityEvidence(
  entityId: string,
  platform: CanonicalPlatform,
  contributionScore: number,
  suffix: string
): EvidenceItem {
  const platformPostId = `legacy-compat:${entityId}:${platform}:${suffix}`;
  const nativeEvidence = compatibilityNativeEvidence(platform, platformPostId);

  return {
    id: platformPostId,
    entityType: "company",
    entityId,
    platform,
    authorName: "Legacy compatibility wrapper",
    authorHandle: null,
    postedAt: "1970-01-01T00:00:00.000Z",
    publishedAtPrecision: "unknown",
    text: "",
    mediaType: "unknown",
    metrics: nativeEvidence.metrics,
    contributionScore: Number.isFinite(contributionScore) ? contributionScore : 0,
    sourceUrl: nativeEvidence.sourceUrl,
    platformPostId: null,
    why: "Adapted from a legacy aggregate score.",
    review_state: "verified"
  };
}

function compatibilityNativeEvidence(
  platform: CanonicalPlatform,
  identitySeed: string
): Pick<EvidenceItem, "metrics" | "sourceUrl"> {
  const suffix = stableCompatibilityNumber(identitySeed);

  switch (platform) {
    case "x":
      return { metrics: { likes: 1 }, sourceUrl: `https://x.com/legacy/status/${suffix}` };
    case "instagram":
      return { metrics: { likes: 1 }, sourceUrl: `https://www.instagram.com/p/Legacy${suffix}/` };
    case "linkedin":
      return {
        metrics: { reactions: 1 },
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${suffix}`
      };
    case "github":
      return { metrics: { stars: 1 }, sourceUrl: `https://github.com/legacy-compat/score-${suffix}` };
    case "youtube":
      return { metrics: { views: 1 }, sourceUrl: `https://www.youtube.com/watch?v=Legacy${suffix}` };
    case "product_hunt":
      return {
        metrics: { upvotes: 1 },
        sourceUrl: `https://www.producthunt.com/posts/legacy-${suffix}`
      };
    case "hacker_news":
      return {
        metrics: { upvotes: 1 },
        sourceUrl: `https://news.ycombinator.com/item?id=${suffix}`
      };
    case "reddit":
      return {
        metrics: { upvotes: 1 },
        sourceUrl: `https://www.reddit.com/r/startups/comments/${suffix.toString(36)}/legacy/`
      };
    case "bilibili":
      return { metrics: { views: 1 }, sourceUrl: `https://www.bilibili.com/video/BV${suffix}/` };
    default:
      throw new Error(`No canonical compatibility evidence fixture for ${platform}.`);
  }
}

function stableCompatibilityNumber(value: string): number {
  let hash = 2_166_136_261;

  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0) + 1;
}

function calibrateLegacyScore(
  entityId: string,
  absoluteScore: number,
  peerScores: number[] | undefined
): { totalScore: number; percentile: number | null } {
  if (peerScores === undefined) {
    return { totalScore: absoluteScore, percentile: null };
  }

  const rows = [absoluteScore, ...peerScores.filter(Number.isFinite)].map((score, index) =>
    compatibilityCompanyRecord(index === 0 ? entityId : `${entityId}:peer:${index}`, score)
  );
  const calibrated = calibrateBatchCompanyScores(rows)[0];
  const calibration = calibrated?.scoreBreakdown?.calibration;

  if (!calibrated || !calibration) {
    return { totalScore: absoluteScore, percentile: null };
  }

  return {
    totalScore: calibrated.totalScore,
    percentile: calibration.percentile
  };
}

function compatibilityCompanyRecord(id: string, score: number): CompanyRecord {
  const sourceUrl = `https://legacy.invalid/calibration/${encodeURIComponent(id)}`;
  const scoreBreakdown = {
    ...aggregateBalancedTractionScore([]),
    modelId: TRACTION_SCORING_CONFIG.modelId,
    modelVersion: TRACTION_SCORING_CONFIG.version,
    modelName: TRACTION_SCORING_CONFIG.name,
    totalScore: score,
    absoluteScore: score,
    calibration: {
      method: "none" as const,
      cohortSize: 0,
      percentile: null,
      inputScore: score
    },
    explanation: "Adapted from a legacy peer score for canonical batch calibration."
  };

  return {
    id,
    batchSlug: "legacy-compatibility",
    name: id,
    ycProfileUrl: sourceUrl,
    websiteUrl: sourceUrl,
    tagline: "Legacy compatibility calibration row",
    description: scoreBreakdown.explanation,
    groupPartner: null,
    primaryIndustry: "unknown",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl,
    industries: [],
    founderIds: [],
    socialAccounts: [],
    totalScore: score,
    previousScore: score,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown
  };
}

function configuredPlatformWeight(platform: Platform): number {
  const canonicalPlatform = toCanonicalPlatform(platform);
  return canonicalPlatform ? TRACTION_SCORING_CONFIG.platformWeights[canonicalPlatform] ?? 0 : 0;
}

function toCanonicalPlatform(platform: Platform): CanonicalPlatform | null {
  const canonicalPlatform = platform === "twitter" ? "x" : platform;
  return (TRACTION_SCORING_CONFIG.platformWeights[canonicalPlatform as CanonicalPlatform] ?? 0) > 0
    ? (canonicalPlatform as CanonicalPlatform)
    : null;
}

function isVerifiedScore(score: PlatformScoreResult<unknown>): boolean {
  return score.review_state === "verified";
}

function isScoredVerifiedScore(score: PlatformScoreResult<unknown>): boolean {
  return isVerifiedScore(score) && score.scoringStatus !== "unscored" && configuredPlatformWeight(score.platform) > 0;
}

function entityReviewState(scores: Array<PlatformScoreResult<unknown>>): ReviewState {
  if (scores.some(isVerifiedScore)) {
    return "verified";
  }

  if (scores.length > 0 && scores.every((score) => score.review_state === "rejected")) {
    return "rejected";
  }

  return "needs_review";
}
