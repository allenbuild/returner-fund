export const STATIC_GRAPH_SCORING_MODEL_ID = "returner-traction";
export const STATIC_GRAPH_SCORING_MODEL_VERSION = "4.2.0";
export const STATIC_GRAPH_SCORING_MODEL_NAME = "returner-traction-v4-absolute-fixed-platform-global-best";

const MAX_ISSUES = 100;
const DEFAULT_MAX_FUTURE_SKEW_MS = 60_000;
const PUBLIC_GRAPH_EVIDENCE_LIMIT = 5_000;
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);
const CALIBRATION_METHODS = new Set(["global_best_ratio"]);
const EDGE_TYPES = new Set(["industry_similarity", "same_group_partner"]);
const CANONICAL_ACCOUNT_ID_WWW_PLATFORMS = new Set([
  "instagram",
  "linkedin",
  "product_hunt",
  "reddit",
  "tiktok",
  "youtube"
]);
// Browser-safe mirror of the immutable v4 scoring contract.
const V4_CANONICAL_PLATFORM_WEIGHTS = Object.freeze({
  x: 0.21,
  instagram: 0.21,
  linkedin: 0.15,
  github: 0.15,
  youtube: 0.1,
  product_hunt: 0.07,
  hacker_news: 0.05,
  reddit: 0.04,
  bilibili: 0.02
});
const V4_SCORE_ELIGIBLE_PLATFORMS = new Set(
  Object.keys(V4_CANONICAL_PLATFORM_WEIGHTS)
);
const SIGNAL_FAMILY_KEYS = [
  "reach",
  "engagement",
  "developerAdoption",
  "launchAndCommunity",
  "momentum"
];
const EVIDENCE_TIMESTAMP_KEYS = [
  "postedAt",
  "observedAt",
  "metricsCheckedAt",
  "linkCheckedAt",
  "first_seen_at",
  "last_checked_at",
  "last_updated_at"
];
const PUBLICATION_PRECISIONS = new Set(["exact", "day", "unknown"]);
const TRUSTED_OBSERVATION_KEYS = [
  "first_seen_at",
  "observedAt",
  "last_checked_at",
  "linkCheckedAt",
  "metricsCheckedAt"
];
const EXPLICIT_PUBLICATION_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/i;
const CANONICAL_PUBLICATION_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CENTRAL_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

/**
 * Rejects raw evidence snapshots whose active clocks extend past the snapshot
 * observation that contains them. This runs before attribution, dedupe, or
 * scoring so a future timestamp cannot poison graph generation invisibly.
 */
export function assertRawEvidenceTemporalPreflight(records, options = {}) {
  if (!Array.isArray(records)) {
    throw new Error("Raw evidence temporal preflight requires an evidence array.");
  }

  const sourceObservedAt = validTemporalTimestamp(options.sourceObservedAt);
  const sourceLabel = nonEmptyString(options.sourceLabel) ?? "raw evidence";
  if (!sourceObservedAt) {
    throw new Error(`${sourceLabel} temporal preflight requires a valid sourceObservedAt timestamp.`);
  }

  const sourceObservedAtMs = Date.parse(sourceObservedAt);
  const sourceObservedDay = centralCalendarDay(sourceObservedAt);
  if (!sourceObservedDay) {
    throw new Error(`${sourceLabel} temporal preflight could not resolve its Central observation day.`);
  }
  const issues = [];

  for (const [index, record] of records.entries()) {
    if (!isRecord(record)) {
      issues.push(`[${index}] must be an object`);
      continue;
    }
    const identity = nonEmptyString(record.id) ?? `index ${index}`;
    for (const key of EVIDENCE_TIMESTAMP_KEYS) {
      const value = record[key];
      if (value === undefined || value === null || value === "") continue;
      const timestamp = validTemporalTimestamp(value);
      if (!timestamp) {
        issues.push(`${identity}.${key} must be a valid timestamp`);
        continue;
      }
      const laterThanSource =
        key === "postedAt" && record.publishedAtPrecision === "day"
          ? publicationCalendarDay(timestamp) > sourceObservedDay
          : Date.parse(timestamp) > sourceObservedAtMs;
      if (laterThanSource) {
        issues.push(`${identity}.${key} must not be later than ${sourceLabel}.sourceObservedAt`);
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `${sourceLabel} temporal preflight failed (${issues.length} issue${issues.length === 1 ? "" : "s"}): ` +
      issues.slice(0, MAX_ISSUES).join("; ")
    );
  }
}

/**
 * Materializes one evidence row with explicit publication/observation
 * semantics. Unsupported or post-observation publication claims are retained
 * as evidence but demoted to an unknown-precision observation fallback. No
 * score, metric, identity, or attribution field is changed.
 */
export function normalizeEvidenceTemporalSemantics(record, options = {}) {
  if (!isRecord(record)) {
    throw new Error("Evidence temporal normalization requires an evidence object.");
  }

  const observation = trustedObservationTimestamp(record, options.sourceObservedAt);
  if (!observation) {
    const identity = nonEmptyString(record.id) ?? "unidentified evidence";
    throw new Error(`${identity} has no trusted observation timestamp.`);
  }

  const precision = PUBLICATION_PRECISIONS.has(record.publishedAtPrecision)
    ? record.publishedAtPrecision
    : "unknown";
  const exactPublication = precision === "exact"
    ? validExplicitPublicationInstant(record.postedAt)
    : null;
  const observationMs = Date.parse(observation);
  const observationDay = centralCalendarDay(observation);

  if (
    precision === "exact" &&
    exactPublication &&
    Date.parse(exactPublication) <= observationMs
  ) {
    return { ...record, postedAt: exactPublication, publishedAtPrecision: "exact", observedAt: observation };
  }

  const publicationDay = precision === "day"
    ? publicationCalendarDay(record.postedAt)
    : null;
  if (publicationDay && observationDay && publicationDay <= observationDay) {
    return { ...record, postedAt: publicationDay, publishedAtPrecision: "day", observedAt: observation };
  }

  return {
    ...record,
    postedAt: observation,
    publishedAtPrecision: "unknown",
    observedAt: observation
  };
}

export function validateStaticGraphSnapshotContract(value, options = {}) {
  const issues = [];
  const addIssue = (path, message) => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  if (!isRecord(value)) {
    addIssue("graph", "must be an object");
    return { ok: false, issues };
  }

  const nowTime = validDateTime(options.now) ?? Date.now();
  const maxFutureSkewMs =
    typeof options.maxFutureSkewMs === "number" &&
    Number.isFinite(options.maxFutureSkewMs) &&
    options.maxFutureSkewMs >= 0
      ? options.maxFutureSkewMs
      : DEFAULT_MAX_FUTURE_SKEW_MS;
  const generatedAtMs = validateIsoTimestamp(
    value.generatedAt,
    "generatedAt",
    addIssue,
    { latestTime: nowTime + maxFutureSkewMs, latestMessage: "must not be in the future" }
  );
  const identity = validateSnapshotIdentity(value, addIssue);
  validateScoringContext(
    value.scoringContext,
    {
      audienceId: identity.audienceId,
      generatedAt: value.generatedAt,
      generatedAtMs,
      latestTime: nowTime + maxFutureSkewMs
    },
    addIssue
  );
  if (value.mode !== "official_snapshot") {
    addIssue("mode", "must be official_snapshot for a static graph");
  }

  const nodes = readArray(value.nodes, "nodes", addIssue);
  const edges = readArray(value.edges, "edges", addIssue);
  const evidence = readArray(value.evidence, "evidence", addIssue);
  const evidenceProjection = validateEvidenceProjection(
    value.evidenceProjection,
    evidence,
    {
      audienceId: identity.audienceId,
      evidenceStats: value.evidenceStats
    },
    addIssue
  );
  const leaderboard = readArray(value.leaderboard, "leaderboard", addIssue);
  const fastestGaining = readArray(value.fastestGaining, "fastestGaining", addIssue);
  const materializedSocialAccountsById = validateMaterializedSocialAccounts(nodes, addIssue);
  const evidenceById = validateEvidence(
    evidence,
    {
      audienceId: identity.audienceId,
      generatedAtMs,
      materializedSocialAccountsById
    },
    addIssue
  );
  const nodeIndex = validateNodes(
    nodes,
    evidenceById,
    {
      audienceId: identity.audienceId,
      batchSlug: identity.batchSlug,
      generatedAtMs,
      canonicalEvidenceFullyVisible:
        identity.audienceId === "off" && evidenceProjection.positiveEvidenceFullyVisible
    },
    addIssue
  );
  validateEdges(edges, nodeIndex.nodesById, addIssue);
  const leaderboardByCompanyId = validateLeaderboard(
    leaderboard,
    nodes,
    nodeIndex.nodesByEntityId,
    evidenceById,
    { allowCanonicalRankGaps: identity.audienceId !== "off" },
    addIssue
  );
  validateFastestGaining(
    fastestGaining,
    leaderboardByCompanyId,
    generatedAtMs,
    { allowCanonicalRankGaps: identity.audienceId !== "off" },
    addIssue
  );

  for (const evidenceId of evidenceById.keys()) {
    if (!nodeIndex.referencedEvidenceIds.has(evidenceId)) {
      addIssue("evidence", `contains unreferenced evidence ${evidenceId}`);
    }
  }

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

function validateEvidenceProjection(value, evidence, context, addIssue) {
  const sourceEvidenceCount = context.audienceId === "off" &&
    isRecord(context.evidenceStats) &&
    Number.isInteger(context.evidenceStats.totalCount) &&
    context.evidenceStats.totalCount >= 0
      ? context.evidenceStats.totalCount
      : null;
  const sourcePositiveEvidenceCount = context.audienceId === "off" &&
    isRecord(context.evidenceStats) &&
    Number.isInteger(context.evidenceStats.scoringEligibleCount) &&
    context.evidenceStats.scoringEligibleCount >= 0
      ? context.evidenceStats.scoringEligibleCount
      : null;

  if (value === undefined) {
    if (
      sourceEvidenceCount !== null &&
      sourceEvidenceCount > evidence.length &&
      evidence.length >= PUBLIC_GRAPH_EVIDENCE_LIMIT
    ) {
      addIssue(
        "evidenceProjection",
        `is required because evidenceStats.totalCount=${sourceEvidenceCount} exceeds the ${evidence.length} retained rows`
      );
    }
    if (evidence.length > PUBLIC_GRAPH_EVIDENCE_LIMIT) {
      addIssue(
        "evidence",
        `must not exceed the ${PUBLIC_GRAPH_EVIDENCE_LIMIT}-row public payload limit`
      );
    }
    return {
      positiveEvidenceFullyVisible:
        sourceEvidenceCount === null || sourceEvidenceCount <= evidence.length
    };
  }
  if (!isRecord(value)) {
    addIssue("evidenceProjection", "must be an object when present");
    return { positiveEvidenceFullyVisible: false };
  }

  const fields = [
    "maxEvidence",
    "sourceEvidenceCount",
    "retainedEvidenceCount",
    "omittedEvidenceCount",
    "sourcePositiveEvidenceCount",
    "retainedPositiveEvidenceCount",
    "omittedPositiveEvidenceCount"
  ];
  const valid = Object.fromEntries(fields.map((field) => [
    field,
    validateNonNegativeInteger(value[field], `evidenceProjection.${field}`, addIssue)
  ]));

  if (valid.maxEvidence && value.maxEvidence > PUBLIC_GRAPH_EVIDENCE_LIMIT) {
    addIssue(
      "evidenceProjection.maxEvidence",
      `must not exceed the ${PUBLIC_GRAPH_EVIDENCE_LIMIT}-row public payload limit`
    );
  }
  if (
    valid.retainedEvidenceCount &&
    value.retainedEvidenceCount !== evidence.length
  ) {
    addIssue(
      "evidenceProjection.retainedEvidenceCount",
      `must equal the ${evidence.length} retained evidence rows`
    );
  }
  if (
    valid.sourceEvidenceCount &&
    valid.retainedEvidenceCount &&
    valid.omittedEvidenceCount &&
    value.sourceEvidenceCount !== value.retainedEvidenceCount + value.omittedEvidenceCount
  ) {
    addIssue(
      "evidenceProjection.sourceEvidenceCount",
      "must equal retainedEvidenceCount plus omittedEvidenceCount"
    );
  }
  if (
    valid.sourceEvidenceCount &&
    sourceEvidenceCount !== null &&
    value.sourceEvidenceCount !== sourceEvidenceCount
  ) {
    addIssue(
      "evidenceProjection.sourceEvidenceCount",
      `must equal evidenceStats.totalCount (${sourceEvidenceCount})`
    );
  }
  if (valid.omittedEvidenceCount && value.omittedEvidenceCount <= 0) {
    addIssue("evidenceProjection.omittedEvidenceCount", "must be positive when projection metadata is present");
  }
  if (
    valid.maxEvidence &&
    valid.retainedEvidenceCount &&
    value.retainedEvidenceCount > value.maxEvidence
  ) {
    addIssue("evidenceProjection.retainedEvidenceCount", "must not exceed maxEvidence");
  }

  const visiblePositiveEvidenceCount = evidence.filter(hasEligiblePositiveScore).length;
  if (
    valid.retainedPositiveEvidenceCount &&
    value.retainedPositiveEvidenceCount !== visiblePositiveEvidenceCount
  ) {
    addIssue(
      "evidenceProjection.retainedPositiveEvidenceCount",
      `must equal the ${visiblePositiveEvidenceCount} retained eligible positive evidence rows`
    );
  }
  if (
    valid.sourcePositiveEvidenceCount &&
    valid.retainedPositiveEvidenceCount &&
    valid.omittedPositiveEvidenceCount &&
    value.sourcePositiveEvidenceCount !==
      value.retainedPositiveEvidenceCount + value.omittedPositiveEvidenceCount
  ) {
    addIssue(
      "evidenceProjection.sourcePositiveEvidenceCount",
      "must equal retainedPositiveEvidenceCount plus omittedPositiveEvidenceCount"
    );
  }
  if (
    valid.sourcePositiveEvidenceCount &&
    valid.sourceEvidenceCount &&
    value.sourcePositiveEvidenceCount > value.sourceEvidenceCount
  ) {
    addIssue(
      "evidenceProjection.sourcePositiveEvidenceCount",
      "must not exceed sourceEvidenceCount"
    );
  }
  if (
    valid.sourcePositiveEvidenceCount &&
    sourcePositiveEvidenceCount !== null &&
    value.sourcePositiveEvidenceCount !== sourcePositiveEvidenceCount
  ) {
    addIssue(
      "evidenceProjection.sourcePositiveEvidenceCount",
      `must equal evidenceStats.scoringEligibleCount (${sourcePositiveEvidenceCount})`
    );
  }

  return {
    positiveEvidenceFullyVisible:
      valid.omittedPositiveEvidenceCount && value.omittedPositiveEvidenceCount === 0
  };
}

export function formatStaticGraphSnapshotContractIssue(issue) {
  return `${issue.path}: ${issue.message}`;
}

function validateSnapshotIdentity(value, addIssue) {
  let batchSlug = null;
  if (!isRecord(value.batch)) {
    addIssue("batch", "must be an object");
  } else {
    batchSlug = nonEmptyString(value.batch.slug);
    if (!batchSlug) addIssue("batch.slug", "must be a non-empty string");
  }

  let audienceId = null;
  if (!isRecord(value.selectedTopVoiceAudience)) {
    addIssue("selectedTopVoiceAudience", "must be an object");
  } else {
    audienceId = nonEmptyString(value.selectedTopVoiceAudience.id);
    if (!audienceId) {
      addIssue("selectedTopVoiceAudience.id", "must be a non-empty string");
    }
  }

  return { audienceId, batchSlug };
}

function validateScoringContext(value, context, addIssue) {
  if (!isRecord(value)) {
    addIssue("scoringContext", "must be an object");
    return;
  }

  expectEqual(value.modelId, STATIC_GRAPH_SCORING_MODEL_ID, "scoringContext.modelId", addIssue);
  expectEqual(value.modelVersion, STATIC_GRAPH_SCORING_MODEL_VERSION, "scoringContext.modelVersion", addIssue);
  expectEqual(value.modelName, STATIC_GRAPH_SCORING_MODEL_NAME, "scoringContext.modelName", addIssue);
  expectEqual(value.scoreScope, "all_platforms", "scoringContext.scoreScope", addIssue);

  const selectedPlatforms = readStringArray(
    value.selectedPlatforms,
    "scoringContext.selectedPlatforms",
    addIssue
  );
  if (selectedPlatforms.length !== 0) {
    addIssue("scoringContext.selectedPlatforms", "must be empty for canonical scoring");
  }

  const responseBuiltAtMs = validateIsoTimestamp(
    value.responseBuiltAt,
    "scoringContext.responseBuiltAt",
    addIssue,
    { latestTime: context.latestTime, latestMessage: "must not be in the future" }
  );
  if (
    responseBuiltAtMs !== null &&
    context.generatedAtMs !== null &&
    value.responseBuiltAt !== context.generatedAt
  ) {
    addIssue("scoringContext.responseBuiltAt", "must equal generatedAt");
  }

  if (value.evidenceAsOf !== null) {
    validateIsoTimestamp(
      value.evidenceAsOf,
      "scoringContext.evidenceAsOf",
      addIssue,
      {
        latestTime: context.generatedAtMs,
        latestMessage: "must not be later than generatedAt"
      }
    );
  }
}

function validateNodes(nodes, evidenceById, context, addIssue) {
  const nodesByEntityId = new Map();
  const nodesById = new Map();
  const referencedEvidenceIds = new Set();

  for (const [index, node] of nodes.entries()) {
    const path = `nodes[${index}]`;
    if (!isRecord(node)) {
      addIssue(path, "must be an object");
      continue;
    }

    const entityType = node.entityType === "company" || node.entityType === "founder"
      ? node.entityType
      : null;
    if (!entityType) {
      addIssue(`${path}.entityType`, "must be company or founder");
    }
    const entityId = nonEmptyString(node.entityId);
    if (!entityId) {
      addIssue(`${path}.entityId`, "must be a non-empty string");
    } else if (nodesByEntityId.has(entityId)) {
      addIssue(`${path}.entityId`, `duplicates node ${entityId}`);
    } else {
      nodesByEntityId.set(entityId, node);
    }

    const id = nonEmptyString(node.id);
    if (!id) {
      addIssue(`${path}.id`, "must be a non-empty string");
    } else if (nodesById.has(id)) {
      addIssue(`${path}.id`, `duplicates node id ${id}`);
    } else {
      nodesById.set(id, node);
    }
    if (id && entityType && entityId && id !== `${entityType}:${entityId}`) {
      addIssue(`${path}.id`, `must be ${entityType}:${entityId}`);
    }
    if (!nonEmptyString(node.label)) {
      addIssue(`${path}.label`, "must be a non-empty string");
    }
    if (context.batchSlug && node.batchSlug !== context.batchSlug) {
      addIssue(`${path}.batchSlug`, `must be ${context.batchSlug}`);
    }
    if (context.audienceId && context.audienceId !== "off") {
      if (node.selectedTopVoiceAudience?.id !== context.audienceId) {
        addIssue(
          `${path}.selectedTopVoiceAudience.id`,
          `must be ${context.audienceId}`
        );
      }
    } else if (
      context.audienceId === "off" &&
      node.selectedTopVoiceAudience !== undefined &&
      node.selectedTopVoiceAudience?.id !== "off"
    ) {
      addIssue(`${path}.selectedTopVoiceAudience.id`, "must be off when present");
    }

    const nodeScoreIsValid = validateScore(node.score, `${path}.score`, addIssue);
    validateScoreMap(node.platformScores, `${path}.platformScores`, addIssue, true);

    const evidenceIds = readStringArray(node.evidenceIds, `${path}.evidenceIds`, addIssue);
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      addIssue(`${path}.evidenceIds`, "must not contain duplicates");
    }
    const referencedEvidence = [];
    for (const [evidenceIndex, evidenceId] of evidenceIds.entries()) {
      referencedEvidenceIds.add(evidenceId);
      const item = evidenceById.get(evidenceId);
      if (!item) {
        addIssue(`${path}.evidenceIds[${evidenceIndex}]`, `references missing evidence ${evidenceId}`);
      } else {
        referencedEvidence.push(item);
        if (entityId && !evidenceBelongsToNode(item, node, entityId)) {
          addIssue(
            `${path}.evidenceIds[${evidenceIndex}]`,
            `references evidence ${evidenceId} belonging to another company`
          );
        }
      }
    }

    const breakdown = node.scoreBreakdown;
    if (!isRecord(breakdown)) {
      addIssue(`${path}.scoreBreakdown`, "must be a complete canonical v4 score breakdown");
      continue;
    }

    expectEqual(breakdown.modelId, STATIC_GRAPH_SCORING_MODEL_ID, `${path}.scoreBreakdown.modelId`, addIssue);
    expectEqual(
      breakdown.modelVersion,
      STATIC_GRAPH_SCORING_MODEL_VERSION,
      `${path}.scoreBreakdown.modelVersion`,
      addIssue
    );
    expectEqual(
      breakdown.modelName,
      STATIC_GRAPH_SCORING_MODEL_NAME,
      `${path}.scoreBreakdown.modelName`,
      addIssue
    );

    const totalScoreIsValid = validateScore(
      breakdown.totalScore,
      `${path}.scoreBreakdown.totalScore`,
      addIssue
    );
    if (nodeScoreIsValid && totalScoreIsValid && node.score !== breakdown.totalScore) {
      addIssue(`${path}.score`, "must equal scoreBreakdown.totalScore");
    }

    const absoluteScoreIsValid = validateScore(
      breakdown.absoluteScore,
      `${path}.scoreBreakdown.absoluteScore`,
      addIssue
    );
    if (
      totalScoreIsValid &&
      absoluteScoreIsValid &&
      breakdown.calibration?.method === "none" &&
      breakdown.totalScore !== breakdown.absoluteScore
    ) {
      addIssue(
        `${path}.scoreBreakdown.totalScore`,
        "must equal the absolute score when no global benchmark is applied"
      );
    }
    const weightedAvailableScoreIsValid = validateScore(
      breakdown.weightedAvailableScore,
      `${path}.scoreBreakdown.weightedAvailableScore`,
      addIssue
    );
    const coverageFactorIsValid = isNonNegativeFiniteNumber(breakdown.coverageFactor);
    if (!coverageFactorIsValid) {
      addIssue(`${path}.scoreBreakdown.coverageFactor`, "must be finite and non-negative");
    }
    validateScoreMap(breakdown.platformScores, `${path}.scoreBreakdown.platformScores`, addIssue, true);
    const weightedEvidenceCount = validateWeightedPlatforms(
      breakdown.weightedPlatforms,
      `${path}.scoreBreakdown.weightedPlatforms`,
      addIssue
    );
    if (Array.isArray(breakdown.weightedPlatforms)) {
      const fixedContributionTotal = breakdown.weightedPlatforms.reduce(
        (sum, row) =>
          sum +
          (isRecord(row) &&
          typeof row.score === "number" &&
          Number.isFinite(row.score) &&
          typeof row.configuredWeight === "number" &&
          Number.isFinite(row.configuredWeight)
            ? row.score * row.configuredWeight
            : 0),
        0
      );
      const configuredCoverage = breakdown.weightedPlatforms.reduce(
        (sum, row) =>
          sum +
          (isRecord(row) &&
          typeof row.configuredWeight === "number" &&
          Number.isFinite(row.configuredWeight)
            ? row.configuredWeight
            : 0),
        0
      );
      const expectedAbsoluteScore =
        fixedContributionTotal > 0 ? Math.max(1, Math.round(fixedContributionTotal)) : 0;
      if (absoluteScoreIsValid && breakdown.absoluteScore !== expectedAbsoluteScore) {
        addIssue(
          `${path}.scoreBreakdown.absoluteScore`,
          `must equal the rounded fixed platform contribution total (${expectedAbsoluteScore})`
        );
      }
      if (
        coverageFactorIsValid &&
        Math.abs(breakdown.coverageFactor - configuredCoverage) > 0.001
      ) {
        addIssue(
          `${path}.scoreBreakdown.coverageFactor`,
          "must equal the configured weight of present platforms"
        );
      }
      const expectedWeightedAvailableScore =
        configuredCoverage > 0 ? fixedContributionTotal / configuredCoverage : 0;
      if (
        weightedAvailableScoreIsValid &&
        Math.abs(breakdown.weightedAvailableScore - expectedWeightedAvailableScore) > 0.011
      ) {
        addIssue(
          `${path}.scoreBreakdown.weightedAvailableScore`,
          "must equal the present-platform weighted average diagnostic"
        );
      }
    }
    if (
      isRecord(node.platformScores) &&
      isRecord(breakdown.platformScores) &&
      !sameNumericRecord(node.platformScores, breakdown.platformScores)
    ) {
      addIssue(`${path}.platformScores`, "must equal scoreBreakdown.platformScores");
    }
    if (Array.isArray(breakdown.weightedPlatforms)) {
      const expectedTopPlatform = breakdown.weightedPlatforms[0]?.platform ?? null;
      if (node.topPlatform !== expectedTopPlatform) {
        addIssue(`${path}.topPlatform`, `must be ${String(expectedTopPlatform)}`);
      }
    }
    validateSignalFamilyScores(
      breakdown.signalFamilyScores,
      `${path}.scoreBreakdown.signalFamilyScores`,
      addIssue
    );

    const platformsWithEvidenceIsValid = validateNonNegativeInteger(
      breakdown.platformsWithEvidence,
      `${path}.scoreBreakdown.platformsWithEvidence`,
      addIssue
    );
    const totalSupportedPlatformsIsValid = validateNonNegativeInteger(
      breakdown.totalSupportedPlatforms,
      `${path}.scoreBreakdown.totalSupportedPlatforms`,
      addIssue
    );
    if (
      platformsWithEvidenceIsValid &&
      totalSupportedPlatformsIsValid &&
      breakdown.platformsWithEvidence > breakdown.totalSupportedPlatforms
    ) {
      addIssue(
        `${path}.scoreBreakdown.platformsWithEvidence`,
        "must not exceed totalSupportedPlatforms"
      );
    }
    if (
      platformsWithEvidenceIsValid &&
      Array.isArray(breakdown.weightedPlatforms) &&
      breakdown.platformsWithEvidence !== breakdown.weightedPlatforms.length
    ) {
      addIssue(
        `${path}.scoreBreakdown.platformsWithEvidence`,
        "must equal weightedPlatforms length"
      );
    }

    const confidence = validateConfidence(
      breakdown.confidence,
      `${path}.scoreBreakdown.confidence`,
      addIssue
    );
    if (breakdown.evidenceAsOf !== null) {
      validateIsoTimestamp(
        breakdown.evidenceAsOf,
        `${path}.scoreBreakdown.evidenceAsOf`,
        addIssue,
        {
          latestTime: context.generatedAtMs,
          latestMessage: "must not be later than generatedAt"
        }
      );
    }
    if (!Array.isArray(breakdown.limitations) || breakdown.limitations.some((item) => typeof item !== "string")) {
      addIssue(`${path}.scoreBreakdown.limitations`, "must be an array of strings");
    }
    if (!nonEmptyString(breakdown.explanation)) {
      addIssue(`${path}.scoreBreakdown.explanation`, "must be a non-empty string");
    }
    validateCalibration(
      breakdown.calibration,
      breakdown.totalScore,
      breakdown.absoluteScore,
      absoluteScoreIsValid,
      `${path}.scoreBreakdown.calibration`,
      addIssue
    );

    if (confidence) {
      const eligiblePositiveEvidence = referencedEvidence.filter(hasEligiblePositiveScore);
      const datedEligibleEvidence = eligiblePositiveEvidence.filter(hasUsablePublicationDate);
      const verifiedEligibleEvidence = eligiblePositiveEvidence.filter((item) => item.linkStatus === "verified");

      if (context.canonicalEvidenceFullyVisible) {
        if (confidence.scoredEvidenceCount > eligiblePositiveEvidence.length) {
          addIssue(
            `${path}.scoreBreakdown.confidence.scoredEvidenceCount`,
            `exceeds the ${eligiblePositiveEvidence.length} eligible positive evidence rows referenced by the node`
          );
        }
        if (confidence.datedEvidenceCount > datedEligibleEvidence.length) {
          addIssue(
            `${path}.scoreBreakdown.confidence.datedEvidenceCount`,
            `exceeds the ${datedEligibleEvidence.length} dated eligible evidence rows referenced by the node`
          );
        }
        if (confidence.verifiedLinkCount > verifiedEligibleEvidence.length) {
          addIssue(
            `${path}.scoreBreakdown.confidence.verifiedLinkCount`,
            `exceeds the ${verifiedEligibleEvidence.length} verified eligible evidence links referenced by the node`
          );
        }
      }
      if (
        platformsWithEvidenceIsValid &&
        breakdown.platformsWithEvidence > confidence.scoredEvidenceCount
      ) {
        addIssue(
          `${path}.scoreBreakdown.platformsWithEvidence`,
          "must not exceed confidence.scoredEvidenceCount"
        );
      }
      if (weightedEvidenceCount !== null && weightedEvidenceCount !== confidence.scoredEvidenceCount) {
        addIssue(
          `${path}.scoreBreakdown.weightedPlatforms`,
          `evidenceCount total ${weightedEvidenceCount} must equal confidence.scoredEvidenceCount ${confidence.scoredEvidenceCount}`
        );
      }
      if (absoluteScoreIsValid && breakdown.absoluteScore > 0 && confidence.scoredEvidenceCount === 0) {
        addIssue(
          `${path}.scoreBreakdown.confidence.scoredEvidenceCount`,
          "must be positive when absoluteScore is positive"
        );
      }
    }
  }

  return { nodesByEntityId, nodesById, referencedEvidenceIds };
}

function validateMaterializedSocialAccounts(nodes, addIssue) {
  const accountsById = new Map();

  for (const [nodeIndex, node] of nodes.entries()) {
    if (!isRecord(node)) continue;

    collectMaterializedSocialAccounts(
      node.socialAccounts,
      `nodes[${nodeIndex}].socialAccounts`,
      node.entityType,
      node.entityId,
      accountsById,
      addIssue
    );

    if (node.founders === undefined) continue;
    if (!Array.isArray(node.founders)) {
      addIssue(`nodes[${nodeIndex}].founders`, "must be an array when present");
      continue;
    }

    for (const [founderIndex, founder] of node.founders.entries()) {
      if (!isRecord(founder)) continue;
      collectMaterializedSocialAccounts(
        founder.socialAccounts,
        `nodes[${nodeIndex}].founders[${founderIndex}].socialAccounts`,
        "founder",
        founder.id,
        accountsById,
        addIssue
      );
    }
  }

  return accountsById;
}

function collectMaterializedSocialAccounts(
  accounts,
  path,
  ownerEntityType,
  ownerEntityId,
  accountsById,
  addIssue
) {
  if (accounts === undefined) return;
  if (!Array.isArray(accounts)) {
    addIssue(path, "must be an array when present");
    return;
  }

  for (const [index, account] of accounts.entries()) {
    const accountPath = `${path}[${index}]`;
    if (!isRecord(account)) {
      addIssue(accountPath, "must be an object");
      continue;
    }

    const id = nonEmptyString(account.id);
    if (!id) {
      addIssue(`${accountPath}.id`, "must be a canonical materialized social account ID");
      continue;
    }

    const materializedAccount = {
      account,
      ownerEntityType,
      ownerEntityId,
      path: accountPath
    };
    const existing = accountsById.get(id) ?? [];
    if (existing.length > 0) {
      addIssue(
        `${accountPath}.id`,
        `collides with an account ID at ${existing[0].path}; materialized account IDs must not be reused`
      );
    }
    accountsById.set(id, [...existing, materializedAccount]);

    const parsedId = parseMaterializedSocialAccountId(id);
    if (!parsedId) {
      addIssue(`${accountPath}.id`, "must be a canonical materialized social account ID");
      continue;
    }

    if (
      parsedId.entityType !== ownerEntityType ||
      parsedId.entityId !== ownerEntityId
    ) {
      addIssue(
        `${accountPath}.id`,
        `must encode its materialized owner ${String(ownerEntityType)}:${String(ownerEntityId)}`
      );
    }

    const platform = nonEmptyString(account.platform);
    if (!platform) {
      addIssue(`${accountPath}.platform`, "must be a non-empty string");
    } else if (parsedId.platform !== platform) {
      addIssue(`${accountPath}.id`, `must encode its materialized platform ${platform}`);
    }

    const accountUrl = nonEmptyString(account.url);
    const canonicalAccountUrl = platform && accountUrl
      ? canonicalSocialAccountUrl(platform, accountUrl)
      : null;
    const canonicalIdUrl = canonicalSocialAccountUrl(parsedId.platform, parsedId.url);
    if (
      !canonicalAccountUrl ||
      !canonicalIdUrl ||
      canonicalIdUrl !== canonicalAccountUrl ||
      !isCanonicalAccountIdUrl(parsedId.url, canonicalIdUrl, parsedId.platform)
    ) {
      addIssue(`${accountPath}.id`, "must encode the account's canonical platform URL");
    }
  }
}

function validateEvidence(evidence, context, addIssue) {
  const evidenceById = new Map();

  for (const [index, item] of evidence.entries()) {
    const path = `evidence[${index}]`;
    if (!isRecord(item)) {
      addIssue(path, "must be an object");
      continue;
    }

    const id = nonEmptyString(item.id);
    if (!id) {
      addIssue(`${path}.id`, "must be a non-empty string");
    } else if (evidenceById.has(id)) {
      addIssue(`${path}.id`, `duplicates evidence ${id}`);
    } else {
      evidenceById.set(id, item);
    }

    if (item.entityType !== "company" && item.entityType !== "founder") {
      addIssue(`${path}.entityType`, "must be company or founder");
    }
    if (!nonEmptyString(item.entityId)) {
      addIssue(`${path}.entityId`, "must be a non-empty string");
    }
    if (!nonEmptyString(item.platform)) {
      addIssue(`${path}.platform`, "must be a non-empty string");
    }
    if (
      item.attachedCompanyId !== undefined &&
      item.attachedCompanyId !== null &&
      !nonEmptyString(item.attachedCompanyId)
    ) {
      addIssue(`${path}.attachedCompanyId`, "must be a non-empty string when present");
    }
    validateEvidenceSocialAccountLineage(
      item,
      path,
      context.materializedSocialAccountsById,
      addIssue
    );
    for (const key of EVIDENCE_TIMESTAMP_KEYS) {
      if (item[key] === undefined || item[key] === null) continue;
      validateEvidenceTimestamp(item[key], `${path}.${key}`, addIssue, {
        latestTime: context.generatedAtMs,
        latestMessage: "must not be later than generatedAt"
      });
    }
    validateEvidencePublicationSemantics(item, path, addIssue);
    if (context.audienceId && context.audienceId !== "off") {
      if (!isRecord(item.topVoice) || item.topVoice.audienceId !== context.audienceId) {
        addIssue(`${path}.topVoice.audienceId`, `must be ${context.audienceId}`);
      }
    }

    validateScore(item.contributionScore, `${path}.contributionScore`, addIssue);
    if (item.normalizedScore !== undefined) {
      validateScore(item.normalizedScore, `${path}.normalizedScore`, addIssue);
    }
    if (isRecord(item.topVoice) && item.topVoice.originalContributionScore !== undefined) {
      const originalScoreIsValid = validateScore(
        item.topVoice.originalContributionScore,
        `${path}.topVoice.originalContributionScore`,
        addIssue
      );
      if (
        originalScoreIsValid &&
        isScore(item.contributionScore) &&
        item.contributionScore !== item.topVoice.originalContributionScore
      ) {
        addIssue(`${path}.contributionScore`, "must not apply a Top Voice member weight");
      }
    }

    if (hasPositiveEvidenceScore(item)) {
      if (item.review_state !== "verified") {
        addIssue(`${path}.review_state`, "must be verified when evidence has a positive score");
      }
      if (!V4_SCORE_ELIGIBLE_PLATFORMS.has(item.platform)) {
        addIssue(`${path}.platform`, "is not score-eligible in canonical v4");
      }
      if (item.tractionStatus === "unscored") {
        addIssue(`${path}.tractionStatus`, "cannot be unscored when evidence has a positive score");
      }
      if (item.linkStatus === "invalid" || item.linkStatus === "blocked") {
        addIssue(`${path}.linkStatus`, "is not score-eligible when evidence has a positive score");
      }
      if (explicitlyIneligible(item)) {
        addIssue(path, "cannot be explicitly noneligible when evidence has a positive score");
      }
    }
  }

  return evidenceById;
}

function validateEvidenceSocialAccountLineage(item, path, accountsById, addIssue) {
  if (item.socialAccountId === undefined || item.socialAccountId === null) return;

  const socialAccountId = nonEmptyString(item.socialAccountId);
  if (!socialAccountId) {
    addIssue(
      `${path}.socialAccountId`,
      "must be null or a canonical materialized social account ID"
    );
    return;
  }

  if (!parseMaterializedSocialAccountId(socialAccountId)) {
    addIssue(`${path}.socialAccountId`, "must be a canonical materialized social account ID");
  }

  const matches = accountsById.get(socialAccountId) ?? [];
  if (matches.length !== 1) {
    addIssue(
      `${path}.socialAccountId`,
      `must resolve to exactly one materialized social account; found ${matches.length}`
    );
    return;
  }

  const [match] = matches;
  if (
    match.ownerEntityType !== item.entityType ||
    match.ownerEntityId !== item.entityId
  ) {
    addIssue(
      `${path}.socialAccountId`,
      `must reference an account owned by ${String(item.entityType)}:${String(item.entityId)}`
    );
  }
  if (match.account.platform !== item.platform) {
    addIssue(
      `${path}.socialAccountId`,
      `must reference an account on platform ${String(item.platform)}`
    );
  }
}

function validateEvidencePublicationSemantics(item, path, addIssue) {
  if (!PUBLICATION_PRECISIONS.has(item.publishedAtPrecision)) {
    addIssue(`${path}.publishedAtPrecision`, "must be exact, day, or unknown");
    return;
  }
  const observation = trustedObservationTimestamp(item);
  if (item.publishedAtPrecision === "unknown") {
    if (!observation || item.postedAt !== observation) {
      addIssue(`${path}.postedAt`, "must equal the earliest trusted observation for unknown precision");
    }
    return;
  }
  if (!observation) return;

  if (item.publishedAtPrecision === "exact") {
    const publication = validExplicitPublicationInstant(item.postedAt);
    if (!publication) {
      addIssue(`${path}.postedAt`, "must be an explicit timezone-qualified instant for exact precision");
      return;
    }
    if (Date.parse(publication) > Date.parse(observation)) {
      addIssue(`${path}.postedAt`, "must not be later than the trusted observation timestamp");
    }
    return;
  }

  const publicationDay = publicationCalendarDay(item.postedAt);
  if (!publicationDay) {
    addIssue(`${path}.postedAt`, "must contain a valid calendar date for day precision");
    return;
  }
  if (publicationDay > centralCalendarDay(observation)) {
    addIssue(`${path}.postedAt`, "calendar date must not be later than the trusted observation date");
  }
}

function validateEdges(edges, nodesById, addIssue) {
  const seenIds = new Set();
  const seenConnections = new Set();

  for (const [index, edge] of edges.entries()) {
    const path = `edges[${index}]`;
    if (!isRecord(edge)) {
      addIssue(path, "must be an object");
      continue;
    }

    const id = nonEmptyString(edge.id);
    if (!id) {
      addIssue(`${path}.id`, "must be a non-empty string");
    } else if (seenIds.has(id)) {
      addIssue(`${path}.id`, `duplicates edge ${id}`);
    } else {
      seenIds.add(id);
    }

    const source = nonEmptyString(edge.source);
    const target = nonEmptyString(edge.target);
    if (!source) {
      addIssue(`${path}.source`, "must be a non-empty node id");
    } else if (!nodesById.has(source)) {
      addIssue(`${path}.source`, `references missing node ${source}`);
    }
    if (!target) {
      addIssue(`${path}.target`, "must be a non-empty node id");
    } else if (!nodesById.has(target)) {
      addIssue(`${path}.target`, `references missing node ${target}`);
    }
    if (source && target && source === target) {
      addIssue(`${path}.target`, "must differ from source");
    }

    if (!EDGE_TYPES.has(edge.edgeType)) {
      addIssue(`${path}.edgeType`, "must be a canonical graph edge type");
    } else if (source && target && source !== target) {
      const [left, right] = [source, target].sort();
      const connection = `${edge.edgeType}:${left}:${right}`;
      if (seenConnections.has(connection)) {
        addIssue(path, `duplicates ${edge.edgeType} connection ${left} to ${right}`);
      } else {
        seenConnections.add(connection);
      }
    }

    validateUnitInterval(edge.weight, `${path}.weight`, addIssue);
    if (!nonEmptyString(edge.label)) addIssue(`${path}.label`, "must be a non-empty string");
    if (!nonEmptyString(edge.explanation)) {
      addIssue(`${path}.explanation`, "must be a non-empty string");
    }
  }
}

function validateFastestGaining(
  rows,
  leaderboardByCompanyId,
  generatedAtMs,
  { allowCanonicalRankGaps },
  addIssue
) {
  const seenCompanyIds = new Set();
  let previousRank = 0;

  if (rows.length !== leaderboardByCompanyId.size) {
    addIssue(
      "fastestGaining",
      `has ${rows.length} rows for ${leaderboardByCompanyId.size} leaderboard companies`
    );
  }

  for (const [index, row] of rows.entries()) {
    const path = `fastestGaining[${index}]`;
    if (!isRecord(row)) {
      addIssue(path, "must be an object");
      continue;
    }

    if (validatePositiveInteger(row.rank, `${path}.rank`, addIssue)) {
      if (allowCanonicalRankGaps) {
        if (row.rank <= previousRank) {
          addIssue(`${path}.rank`, "must preserve increasing canonical momentum rank order");
        }
      } else if (row.rank !== index + 1) {
        addIssue(`${path}.rank`, `must be ${index + 1}`);
      }
      previousRank = row.rank;
    }

    const companyId = nonEmptyString(row.companyId);
    if (!companyId) {
      addIssue(`${path}.companyId`, "must be a non-empty string");
    } else if (seenCompanyIds.has(companyId)) {
      addIssue(`${path}.companyId`, `duplicates momentum company ${companyId}`);
    } else {
      seenCompanyIds.add(companyId);
    }

    const leaderboardRow = companyId ? leaderboardByCompanyId.get(companyId) : undefined;
    if (!leaderboardRow) {
      if (companyId) addIssue(`${path}.companyId`, `references missing leaderboard company ${companyId}`);
    } else if (row.companyName !== leaderboardRow.companyName) {
      addIssue(`${path}.companyName`, "must equal the matching leaderboard companyName");
    }

    validateMomentumDelta(row.dod, leaderboardRow, `${path}.dod`, generatedAtMs, addIssue);
    validateMomentumDelta(row.wow, leaderboardRow, `${path}.wow`, generatedAtMs, addIssue);

    const previous = rows[index - 1];
    if (
      isRecord(previous) &&
      momentumRowIsComparable(previous) &&
      momentumRowIsComparable(row) &&
      compareMomentumRows(previous, row) > 0
    ) {
      addIssue(path, "must follow descending DoD momentum order");
    }
  }

  for (const companyId of leaderboardByCompanyId.keys()) {
    if (!seenCompanyIds.has(companyId)) {
      addIssue("fastestGaining", `is missing leaderboard company ${companyId}`);
    }
  }
}

function validateMomentumDelta(value, leaderboardRow, path, generatedAtMs, addIssue) {
  if (!isRecord(value)) {
    addIssue(path, "must be a complete momentum object");
    return;
  }

  const currentScoreIsValid = validateScore(value.currentScore, `${path}.currentScore`, addIssue);
  const currentRankIsValid = validatePositiveInteger(value.currentRank, `${path}.currentRank`, addIssue);
  if (leaderboardRow && currentScoreIsValid && value.currentScore !== leaderboardRow.score) {
    addIssue(`${path}.currentScore`, "must equal the matching leaderboard score");
  }
  if (leaderboardRow && currentRankIsValid && value.currentRank !== leaderboardRow.rank) {
    addIssue(`${path}.currentRank`, "must equal the matching leaderboard rank");
  }

  const baselineScoreIsNull = value.baselineScore === null;
  const baselineRankIsNull = value.baselineRank === null;
  const baselineScoreIsValid = baselineScoreIsNull ||
    validateScore(value.baselineScore, `${path}.baselineScore`, addIssue);
  const baselineRankIsValid = baselineRankIsNull ||
    validatePositiveInteger(value.baselineRank, `${path}.baselineRank`, addIssue);
  if (baselineScoreIsNull !== baselineRankIsNull) {
    addIssue(
      baselineScoreIsNull ? `${path}.baselineRank` : `${path}.baselineScore`,
      "must be null exactly when the other baseline field is null"
    );
  }

  const scoreDeltaIsValid = isFiniteNumber(value.scoreDelta);
  if (!scoreDeltaIsValid || value.scoreDelta < -100 || value.scoreDelta > 100) {
    addIssue(`${path}.scoreDelta`, "must be a finite number from -100 to 100");
  }
  const percentDeltaIsValid = isFiniteNumber(value.percentDelta);
  if (!percentDeltaIsValid) {
    addIssue(`${path}.percentDelta`, "must be a finite number");
  }
  const rankDeltaIsValid = Number.isInteger(value.rankDelta);
  if (!rankDeltaIsValid) {
    addIssue(`${path}.rankDelta`, "must be an integer");
  }

  if (currentScoreIsValid && baselineScoreIsValid) {
    const expectedScoreDelta = baselineScoreIsNull
      ? 0
      : roundMomentum(value.currentScore - value.baselineScore);
    const expectedPercentDelta = baselineScoreIsNull
      ? 0
      : roundMomentum((expectedScoreDelta / Math.max(value.baselineScore, 1)) * 100);
    if (scoreDeltaIsValid && !numbersEqual(value.scoreDelta, expectedScoreDelta)) {
      addIssue(`${path}.scoreDelta`, `must equal currentScore - baselineScore (${expectedScoreDelta})`);
    }
    if (percentDeltaIsValid && !numbersEqual(value.percentDelta, expectedPercentDelta)) {
      addIssue(`${path}.percentDelta`, `must equal the baseline percent change (${expectedPercentDelta})`);
    }
  }
  if (currentRankIsValid && baselineRankIsValid) {
    const expectedRankDelta = baselineRankIsNull ? 0 : value.baselineRank - value.currentRank;
    if (rankDeltaIsValid && value.rankDelta !== expectedRankDelta) {
      addIssue(`${path}.rankDelta`, `must equal baselineRank - currentRank (${expectedRankDelta})`);
    }
  }

  if (value.benchmarkedAt !== null) {
    validateIsoTimestamp(value.benchmarkedAt, `${path}.benchmarkedAt`, addIssue, {
      latestTime: generatedAtMs,
      latestMessage: "must not be later than generatedAt"
    });
  }
}

function momentumRowIsComparable(row) {
  return isRecord(row.dod) &&
    isFiniteNumber(row.dod.scoreDelta) &&
    isFiniteNumber(row.dod.percentDelta) &&
    isFiniteNumber(row.dod.rankDelta) &&
    isFiniteNumber(row.dod.currentScore) &&
    typeof row.companyName === "string";
}

function compareMomentumRows(left, right) {
  return (
    right.dod.scoreDelta - left.dod.scoreDelta ||
    right.dod.percentDelta - left.dod.percentDelta ||
    right.dod.rankDelta - left.dod.rankDelta ||
    right.dod.currentScore - left.dod.currentScore ||
    left.companyName.localeCompare(right.companyName)
  );
}

function validateLeaderboard(
  leaderboard,
  nodes,
  nodesByEntityId,
  evidenceById,
  { allowCanonicalRankGaps },
  addIssue
) {
  const seenCompanyIds = new Set();
  const leaderboardByCompanyId = new Map();
  const companyNodes = nodes.filter((node) => isRecord(node) && node.entityType === "company");
  let previousScore = null;
  let previousRank = null;
  let expectedRank = 0;

  if (leaderboard.length !== companyNodes.length) {
    addIssue("leaderboard", `has ${leaderboard.length} rows for ${companyNodes.length} company nodes`);
  }

  for (const [index, row] of leaderboard.entries()) {
    const path = `leaderboard[${index}]`;
    if (!isRecord(row)) {
      addIssue(path, "must be an object");
      continue;
    }

    const companyId = nonEmptyString(row.companyId);
    if (!companyId) {
      addIssue(`${path}.companyId`, "must be a non-empty string");
    } else if (seenCompanyIds.has(companyId)) {
      addIssue(`${path}.companyId`, `duplicates leaderboard company ${companyId}`);
    } else {
      seenCompanyIds.add(companyId);
      leaderboardByCompanyId.set(companyId, row);
    }

    if (!nonEmptyString(row.companyName)) {
      addIssue(`${path}.companyName`, "must be a non-empty string");
    }

    const rowScoreIsValid = validateScore(row.score, `${path}.score`, addIssue);
    const rowRankIsValid = validatePositiveInteger(row.rank, `${path}.rank`, addIssue);
    if (rowScoreIsValid) {
      if (previousScore !== null && row.score > previousScore) {
        addIssue(`${path}.score`, "must not exceed the preceding leaderboard score");
      }
      if (allowCanonicalRankGaps) {
        if (
          rowRankIsValid &&
          previousRank !== null &&
          ((row.score === previousScore && row.rank !== previousRank) ||
            (row.score !== previousScore && row.rank <= previousRank))
        ) {
          addIssue(`${path}.rank`, "must preserve canonical tied descending rank order");
        }
      } else {
        if (previousScore === null || row.score !== previousScore) {
          expectedRank = index + 1;
        }
        if (rowRankIsValid && row.rank !== expectedRank) {
          addIssue(`${path}.rank`, `must be ${expectedRank} for tied descending scores`);
        }
      }
      previousScore = row.score;
      if (rowRankIsValid) previousRank = row.rank;
    }

    const node = companyId ? nodesByEntityId.get(companyId) : undefined;
    if (!node) {
      if (companyId) addIssue(`${path}.companyId`, `references missing node ${companyId}`);
    } else if (node.entityType !== "company") {
      addIssue(`${path}.companyId`, `references non-company node ${companyId}`);
    } else {
      if (rowScoreIsValid && isScore(node.score) && row.score !== node.score) {
        addIssue(`${path}.score`, "must equal the matching node score");
      }
      if (typeof node.label === "string" && row.companyName !== node.label) {
        addIssue(`${path}.companyName`, "must equal the matching node label");
      }
      if (Object.hasOwn(node, "topPlatform") && row.topPlatform !== node.topPlatform) {
        addIssue(`${path}.topPlatform`, "must equal the matching node topPlatform");
      }
      validateBiggestContribution(row.biggestContribution, node, evidenceById, `${path}.biggestContribution`, addIssue);
    }
  }

  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node) || node.entityType !== "company") continue;
    const entityId = nonEmptyString(node.entityId);
    if (entityId && !seenCompanyIds.has(entityId)) {
      addIssue(`nodes[${index}].entityId`, `is missing from the leaderboard: ${entityId}`);
    }
  }

  return leaderboardByCompanyId;
}

function validateBiggestContribution(value, node, evidenceById, path, addIssue) {
  if (value === null || value === undefined) return;
  if (!isRecord(value)) {
    addIssue(path, "must be null or an evidence object");
    return;
  }

  const id = nonEmptyString(value.id);
  const canonical = id ? evidenceById.get(id) : undefined;
  if (!id || !canonical) {
    addIssue(`${path}.id`, "must reference evidence in the graph");
    return;
  }
  if (isScore(value.contributionScore) && value.contributionScore !== canonical.contributionScore) {
    addIssue(`${path}.contributionScore`, "must equal the referenced evidence score");
  }

  const entityId = nonEmptyString(node.entityId);
  if (!entityId || !evidenceBelongsToNode(canonical, node, entityId)) {
    addIssue(`${path}.id`, "must reference evidence belonging to the matching node");
  }
}

function validateConfidence(value, path, addIssue) {
  if (!isRecord(value)) {
    addIssue(path, "must be a complete confidence object");
    return null;
  }

  if (!CONFIDENCE_LEVELS.has(value.level)) {
    addIssue(`${path}.level`, "must be low, medium, or high");
  }
  validateUnitInterval(value.value, `${path}.value`, addIssue);
  if (!Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== "string")) {
    addIssue(`${path}.reasons`, "must be an array of strings");
  }

  const scoredIsValid = validateNonNegativeInteger(
    value.scoredEvidenceCount,
    `${path}.scoredEvidenceCount`,
    addIssue
  );
  const datedIsValid = validateNonNegativeInteger(
    value.datedEvidenceCount,
    `${path}.datedEvidenceCount`,
    addIssue
  );
  const verifiedIsValid = validateNonNegativeInteger(
    value.verifiedLinkCount,
    `${path}.verifiedLinkCount`,
    addIssue
  );
  if (scoredIsValid && datedIsValid && value.datedEvidenceCount > value.scoredEvidenceCount) {
    addIssue(`${path}.datedEvidenceCount`, "must not exceed scoredEvidenceCount");
  }
  if (scoredIsValid && verifiedIsValid && value.verifiedLinkCount > value.scoredEvidenceCount) {
    addIssue(`${path}.verifiedLinkCount`, "must not exceed scoredEvidenceCount");
  }

  return scoredIsValid && datedIsValid && verifiedIsValid ? value : null;
}

function validateCalibration(value, totalScore, absoluteScore, absoluteScoreIsValid, path, addIssue) {
  if (!isRecord(value)) {
    addIssue(path, "must be a complete calibration object");
    return;
  }

  const methodIsValid = CALIBRATION_METHODS.has(value.method);
  if (!methodIsValid) {
    addIssue(`${path}.method`, "must be global_best_ratio for the 4.2 scoring model");
  }
  validateNonNegativeInteger(value.cohortSize, `${path}.cohortSize`, addIssue);
  const inputScoreIsValid = validateScore(value.inputScore, `${path}.inputScore`, addIssue);
  if (absoluteScoreIsValid && inputScoreIsValid && value.inputScore !== absoluteScore) {
    addIssue(`${path}.inputScore`, "must equal scoreBreakdown.absoluteScore");
  }

  const percentileIsValid =
    value.percentile === null || validateUnitInterval(value.percentile, `${path}.percentile`, addIssue);
  if (methodIsValid && value.method === "none" && value.percentile !== null) {
    addIssue(`${path}.percentile`, "must be null when calibration method is none");
  }
  if (methodIsValid && value.method === "global_best_ratio") {
    if (value.percentile !== null) {
      addIssue(`${path}.percentile`, "must be null for the global ratio benchmark");
    }
    const benchmarkScoreIsValid = validateScore(
      value.benchmarkScore,
      `${path}.benchmarkScore`,
      addIssue
    );
    const scaleFactorIsValid = isNonNegativeFiniteNumber(value.scaleFactor);
    if (!scaleFactorIsValid) {
      addIssue(`${path}.scaleFactor`, "must be finite and non-negative");
    }
    expectEqual(value.benchmarkScope, "all_supported_batches", `${path}.benchmarkScope`, addIssue);
    expectEqual(
      value.benchmarkPopulation,
      "current_company_snapshot",
      `${path}.benchmarkPopulation`,
      addIssue
    );
    if (benchmarkScoreIsValid && scaleFactorIsValid) {
      const expectedFactor = value.benchmarkScore > 0 ? 100 / value.benchmarkScore : 0;
      if (Math.abs(value.scaleFactor - expectedFactor) > 1e-9) {
        addIssue(`${path}.scaleFactor`, "must equal 100 divided by benchmarkScore");
      }
      const expectedTotal = value.benchmarkScore > 0 && absoluteScore > 0
        ? Math.max(1, Math.min(100, Math.round((absoluteScore / value.benchmarkScore) * 100)))
        : 0;
      if (totalScore !== expectedTotal) {
        addIssue(`${path}`, `must map absoluteScore to global headline ${expectedTotal}`);
      }
      if ((value.benchmarkScore > 0) !== (value.cohortSize > 0)) {
        addIssue(`${path}.cohortSize`, "must be positive exactly when the global benchmark is positive");
      }
    }
  }
  return percentileIsValid;
}

function validateWeightedPlatforms(value, path, addIssue) {
  if (!Array.isArray(value)) {
    addIssue(path, "must be an array");
    return null;
  }

  let evidenceCountTotal = 0;
  const seenPlatforms = new Set();
  let allEvidenceCountsValid = true;
  for (const [index, row] of value.entries()) {
    const rowPath = `${path}[${index}]`;
    if (!isRecord(row)) {
      addIssue(rowPath, "must be an object");
      allEvidenceCountsValid = false;
      continue;
    }
    const platform = nonEmptyString(row.platform);
    if (!platform) {
      addIssue(`${rowPath}.platform`, "must be a non-empty string");
    } else if (!V4_SCORE_ELIGIBLE_PLATFORMS.has(platform)) {
      addIssue(`${rowPath}.platform`, "must be a canonical weighted platform");
    } else if (seenPlatforms.has(platform)) {
      addIssue(`${rowPath}.platform`, `duplicates weighted platform ${platform}`);
    } else {
      seenPlatforms.add(platform);
    }
    validateScore(row.score, `${rowPath}.score`, addIssue);
    const configuredWeightIsValid = validateUnitInterval(
      row.configuredWeight,
      `${rowPath}.configuredWeight`,
      addIssue
    );
    if (
      configuredWeightIsValid &&
      platform &&
      V4_SCORE_ELIGIBLE_PLATFORMS.has(platform)
    ) {
      const canonicalWeight = V4_CANONICAL_PLATFORM_WEIGHTS[platform];
      if (row.configuredWeight !== canonicalWeight) {
        addIssue(
          `${rowPath}.configuredWeight`,
          `must equal canonical v4 weight ${canonicalWeight} for ${platform}`
        );
      }
    }
    const appliedWeightIsValid = validateUnitInterval(
      row.appliedWeight,
      `${rowPath}.appliedWeight`,
      addIssue
    );
    if (
      appliedWeightIsValid &&
      configuredWeightIsValid &&
      row.appliedWeight !== row.configuredWeight
    ) {
      addIssue(
        `${rowPath}.appliedWeight`,
        "must equal configuredWeight; present platforms are not renormalized"
      );
    }
    const contributionIsValid = validateScore(
      row.contribution,
      `${rowPath}.contribution`,
      addIssue
    );
    if (
      contributionIsValid &&
      configuredWeightIsValid &&
      typeof row.score === "number" &&
      Number.isFinite(row.score)
    ) {
      const expectedContribution = Math.round(row.score * row.configuredWeight * 100) / 100;
      if (Math.abs(row.contribution - expectedContribution) > 0.001) {
        addIssue(
          `${rowPath}.contribution`,
          `must equal score * configuredWeight (${expectedContribution})`
        );
      }
    }
    if (validateNonNegativeInteger(row.evidenceCount, `${rowPath}.evidenceCount`, addIssue)) {
      evidenceCountTotal += row.evidenceCount;
    } else {
      allEvidenceCountsValid = false;
    }
  }
  return allEvidenceCountsValid ? evidenceCountTotal : null;
}

function validateSignalFamilyScores(value, path, addIssue) {
  if (!isRecord(value)) {
    addIssue(path, "must be an object");
    return;
  }
  for (const family of SIGNAL_FAMILY_KEYS) {
    validateScore(value[family], `${path}.${family}`, addIssue);
  }
}

function validateScoreMap(value, path, addIssue, required) {
  if (value === undefined && !required) return;
  if (!isRecord(value)) {
    addIssue(path, "must be a platform score object");
    return;
  }
  for (const [platform, score] of Object.entries(value)) {
    validateScore(score, `${path}.${platform}`, addIssue);
  }
}

function readArray(value, path, addIssue) {
  if (!Array.isArray(value)) {
    addIssue(path, "must be an array");
    return [];
  }
  return value;
}

function readStringArray(value, path, addIssue) {
  if (!Array.isArray(value)) {
    addIssue(path, "must be an array of strings");
    return [];
  }
  const strings = [];
  for (const [index, item] of value.entries()) {
    if (!nonEmptyString(item)) {
      addIssue(`${path}[${index}]`, "must be a non-empty string");
    } else {
      strings.push(item);
    }
  }
  return strings;
}

function validateScore(value, path, addIssue) {
  if (!isScore(value)) {
    addIssue(path, "must be a finite score from 0 to 100");
    return false;
  }
  return true;
}

function validateUnitInterval(value, path, addIssue) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    addIssue(path, "must be a finite number from 0 to 1");
    return false;
  }
  return true;
}

function validateNonNegativeInteger(value, path, addIssue) {
  if (!Number.isInteger(value) || value < 0) {
    addIssue(path, "must be a non-negative integer");
    return false;
  }
  return true;
}

function validatePositiveInteger(value, path, addIssue) {
  if (!Number.isInteger(value) || value <= 0) {
    addIssue(path, "must be a positive integer");
    return false;
  }
  return true;
}

function hasEligiblePositiveScore(item) {
  return item.tractionStatus === "unscored" ||
    (hasPositiveEvidenceScore(item) && !isEvidenceNoneligible(item));
}

function hasPositiveEvidenceScore(item) {
  return (isScore(item.contributionScore) && item.contributionScore > 0) ||
    (isScore(item.normalizedScore) && item.normalizedScore > 0);
}

function isEvidenceNoneligible(item) {
  return (
    item.review_state !== "verified" ||
    !V4_SCORE_ELIGIBLE_PLATFORMS.has(item.platform) ||
    item.tractionStatus === "unscored" ||
    item.linkStatus === "invalid" ||
    item.linkStatus === "blocked" ||
    explicitlyIneligible(item)
  );
}

function explicitlyIneligible(item) {
  if (
    item.score_eligible === false ||
    item.scoreEligible === false ||
    item.eligible === false ||
    item.scoringEligible === false
  ) {
    return true;
  }
  return isRecord(item.scoringEligibility) && item.scoringEligibility.eligible === false;
}

function hasUsablePublicationDate(item) {
  return item.publishedAtPrecision !== "unknown" &&
    typeof item.postedAt === "string" &&
    Number.isFinite(Date.parse(item.postedAt));
}

function evidenceBelongsToNode(item, node, entityId) {
  const relatedEntityIds = Array.isArray(node.relatedEntityIds) ? node.relatedEntityIds : [];
  return item.attachedCompanyId
    ? item.attachedCompanyId === entityId
    : item.entityId === entityId || relatedEntityIds.includes(item.entityId);
}

function parseMaterializedSocialAccountId(value) {
  const match = /^acct:(company|founder):([A-Za-z0-9][A-Za-z0-9._-]*):([a-z][a-z0-9_]*):([^:]+)$/.exec(value);
  if (!match) return null;

  const [, entityType, entityId, platform, encodedUrl] = match;
  let url;
  try {
    url = decodeURIComponent(encodedUrl);
  } catch {
    return null;
  }
  if (encodeURIComponent(url) !== encodedUrl) return null;

  try {
    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol !== "https:" ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return { entityType, entityId, platform, url };
}

function canonicalSocialAccountUrl(platform, rawUrl) {
  if (!nonEmptyString(rawUrl)) return null;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeUrlPathSegment);

    if (platform === "github" && host === "github.com") {
      const handle = parts[0]?.toLowerCase() === "orgs" ? parts[1] : parts[0];
      return handle ? `https://github.com/${handle.toLowerCase().replace(/\.git$/i, "")}` : null;
    }

    if (platform === "x" && (host === "x.com" || host === "twitter.com")) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? `https://x.com/${handle.toLowerCase()}` : null;
    }

    if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      const markerIndex = parts.findIndex((part) =>
        ["company", "in", "school"].includes(part.toLowerCase())
      );
      const namespace = markerIndex >= 0 ? parts[markerIndex]?.toLowerCase() : null;
      const handle = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      return namespace && handle
        ? `https://linkedin.com/${namespace}/${handle.toLowerCase()}`
        : null;
    }

    if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? `https://instagram.com/${handle.toLowerCase()}` : null;
    }

    if (platform === "tiktok" && (host === "tiktok.com" || host.endsWith(".tiktok.com"))) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? `https://tiktok.com/@${handle.toLowerCase()}` : null;
    }

    if (platform === "bluesky" && host === "bsky.app") {
      const handle = parts[0]?.toLowerCase() === "profile" ? parts[1] : null;
      return handle ? `https://bsky.app/profile/${handle.toLowerCase()}` : null;
    }

    if (platform === "youtube" && host === "youtube.com") {
      if (parts[0]?.startsWith("@")) {
        return parts[0].length > 1
          ? `https://youtube.com/@${parts[0].slice(1).toLowerCase()}`
          : null;
      }
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      return namespace && handle && ["channel", "c", "user"].includes(namespace)
        ? `https://youtube.com/${namespace}/${handle.toLowerCase()}`
        : null;
    }

    if (platform === "reddit" && (host === "reddit.com" || host.endsWith(".reddit.com"))) {
      const namespace = parts[0]?.toLowerCase();
      const handle = ["r", "u", "user"].includes(namespace ?? "") ? parts[1] : parts[0];
      const pathNamespace = ["r", "u", "user"].includes(namespace ?? "") ? namespace : "user";
      return handle ? `https://reddit.com/${pathNamespace}/${handle.toLowerCase()}` : null;
    }

    if (platform === "product_hunt" && host === "producthunt.com") {
      if (parts[0]?.startsWith("@")) {
        return parts[0].length > 1
          ? `https://producthunt.com/@${parts[0].slice(1).toLowerCase()}`
          : null;
      }
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      return namespace && handle && ["products", "posts"].includes(namespace)
        ? `https://producthunt.com/${namespace}/${handle.toLowerCase()}`
        : null;
    }

    if (platform === "hacker_news" && host === "news.ycombinator.com") {
      const handle = url.searchParams.get("id");
      return handle ? `https://news.ycombinator.com/user?id=${handle.toLowerCase()}` : null;
    }

    if (platform === "bilibili" && host === "space.bilibili.com") {
      return parts[0] ? `https://space.bilibili.com/${parts[0]}` : null;
    }

    if (platform !== "rss" && platform !== "web") return null;
    url.hash = "";
    url.search = "";
    url.protocol = "https:";
    url.hostname = host;
    url.pathname = `/${parts.join("/")}`.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function isCanonicalAccountIdUrl(rawUrl, canonicalUrl, platform) {
  if (rawUrl === canonicalUrl) return true;
  return CANONICAL_ACCOUNT_ID_WWW_PLATFORMS.has(platform) &&
    rawUrl === canonicalUrl.replace("https://", "https://www.");
}

function decodeUrlPathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validateIsoTimestamp(value, path, addIssue, { latestTime = null, latestMessage = "" } = {}) {
  if (typeof value !== "string") {
    addIssue(path, "must be a canonical ISO timestamp");
    return null;
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (!Number.isFinite(time) || parsed.toISOString() !== value) {
    addIssue(path, "must be a canonical ISO timestamp");
    return null;
  }
  if (Number.isFinite(latestTime) && time > latestTime) {
    addIssue(path, latestMessage || "is later than allowed");
  }
  return time;
}

function validateEvidenceTimestamp(value, path, addIssue, { latestTime = null, latestMessage = "" } = {}) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) {
    addIssue(path, "must be a valid timestamp");
    return null;
  }
  if (Number.isFinite(latestTime) && time > latestTime) {
    addIssue(path, latestMessage || "is later than allowed");
  }
  return time;
}

function trustedObservationTimestamp(record, sourceObservedAt) {
  const candidates = [
    ...TRUSTED_OBSERVATION_KEYS.map((key) => validTemporalTimestamp(record[key])),
    validTemporalTimestamp(sourceObservedAt)
  ].filter(Boolean);
  candidates.sort((left, right) => Date.parse(left) - Date.parse(right));
  return candidates[0] ?? null;
}

function validTemporalTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? value : null;
}

function publicationCalendarDay(value) {
  if (typeof value !== "string") return null;
  const timestamp = value.trim();
  const day = CANONICAL_PUBLICATION_DAY.test(timestamp)
    ? timestamp
    : timestamp.match(/^(\d{4}-\d{2}-\d{2})T/)?.[1] ?? null;
  if (!day || !validTemporalTimestamp(timestamp)) return null;
  const parsed = new Date(`${day}T12:00:00.000Z`);
  return parsed.toISOString().slice(0, 10) === day ? day : null;
}

function centralCalendarDay(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = Object.fromEntries(
    CENTRAL_DAY_FORMATTER.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validExplicitPublicationInstant(value) {
  if (typeof value !== "string") return null;
  const timestamp = value.trim();
  const parts = timestamp.match(EXPLICIT_PUBLICATION_INSTANT);
  if (!parts || !validExactInstantParts(parts)) return null;
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function validExactInstantParts(parts) {
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = parts[8].toUpperCase() === "Z" ? 0 : Number(parts[9]);
  const offsetMinute = parts[8].toUpperCase() === "Z" ? 0 : Number(parts[10]);

  return (
    Number.isInteger(year) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    offsetHour >= 0 &&
    offsetHour <= 14 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0)
  );
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDateTime(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
}

function sameNumericRecord(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && numbersEqual(left[key], right[key])
    );
}

function numbersEqual(left, right) {
  return isFiniteNumber(left) && isFiniteNumber(right) && Math.abs(left - right) <= 1e-9;
}

function roundMomentum(value) {
  return Math.round(value * 10) / 10;
}

function expectEqual(actual, expected, path, addIssue) {
  if (actual !== expected) addIssue(path, `must be ${expected}`);
}

function isScore(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
