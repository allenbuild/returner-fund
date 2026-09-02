import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalPostKey, dedupeEvidenceForScoring } from "@/lib/graph/dedupe";
import {
  buildGraphResponse,
  clearTopVoiceRollupCache
} from "@/lib/graph/graph-builder";
import {
  TRACTION_SCORING_CONFIG,
  normalizeMetricsForScoring
} from "@/lib/graph/traction-scoring-config";
import {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  isNativeEvidenceUrl
} from "@/lib/graph/traction-scoring";
import { yc2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type {
  EvidenceItem,
  GraphFilters,
  GraphNode,
  GraphResponse,
  Platform,
  TopVoiceAudienceId
} from "@/lib/graph/types";

const RESPONSE_BUILT_AT = "2026-07-17T12:00:00.000Z";
const BATCH_SLUGS = ["S2026", "S26", "A16ZSR006"] as const;
const SELECTED_PLATFORMS: Platform[] = ["linkedin"];
const SUPPORTED_PLATFORM_COUNT = Object.values(TRACTION_SCORING_CONFIG.platformWeights)
  .filter((weight) => Number(weight) > 0).length;

interface ResponseMode {
  label: string;
  topVoices?: Exclude<TopVoiceAudienceId, "off">;
}

interface ResponseCase extends ResponseMode {
  batchSlug: (typeof BATCH_SLUGS)[number];
}

const RESPONSE_MODES: ResponseMode[] = [
  { label: "regular" },
  { label: "YC Partners", topVoices: "yc_partners" },
  { label: "Insiders", topVoices: "insiders" }
];

const RESPONSE_CASES: ResponseCase[] = BATCH_SLUGS.flatMap((batchSlug) =>
  RESPONSE_MODES.map((mode) => ({ batchSlug, ...mode }))
);

describe("real scoring dataset contracts v4", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RESPONSE_BUILT_AT);
    clearTopVoiceRollupCache();
  });

  afterAll(() => {
    clearTopVoiceRollupCache();
    vi.useRealTimers();
  });

  it.each(RESPONSE_CASES)(
    "$batchSlug $label response keeps scoring, ranking, evidence, and entity contracts coherent",
    (responseCase) => {
      const graph = graphFor(responseCase);
      const canonicalGraph = graphFor({ batchSlug: responseCase.batchSlug, label: "canonical" });
      const violations = collectGraphViolations(graph, canonicalGraph, responseCase, []);

      assertNoViolations(`${responseCase.batchSlug} ${responseCase.label}`, violations);
    }
  );

  it.each(RESPONSE_CASES)(
    "$batchSlug $label selected-platform response preserves canonical scoring while filtering evidence",
    (responseCase) => {
      const graph = graphFor(responseCase, SELECTED_PLATFORMS);
      const canonicalGraph = graphFor({ batchSlug: responseCase.batchSlug, label: "canonical" });
      const violations = collectGraphViolations(
        graph,
        canonicalGraph,
        responseCase,
        SELECTED_PLATFORMS
      );

      if (!responseCase.topVoices) {
        violations.push(...selectedPlatformFixtureViolations(responseCase.batchSlug));
      }

      assertNoViolations(
        `${responseCase.batchSlug} ${responseCase.label} selected ${SELECTED_PLATFORMS.join(",")}`,
        violations
      );
    }
  );
});

function graphFor(responseCase: ResponseCase, platforms: Platform[] = []): GraphResponse {
  const filters: GraphFilters = { batchSlug: responseCase.batchSlug };
  if (responseCase.topVoices) filters.topVoices = responseCase.topVoices;
  if (platforms.length) filters.platforms = [...platforms];
  return buildGraphResponse(filters, yc2026GraphDataset);
}

function collectGraphViolations(
  graph: GraphResponse,
  canonicalGraph: GraphResponse,
  responseCase: ResponseCase,
  selectedPlatforms: Platform[]
): string[] {
  const violations: string[] = [];
  const scope = `${responseCase.batchSlug}/${responseCase.label}`;
  const expectedAudience = responseCase.topVoices ?? "off";

  mismatch(violations, `${scope} batch slug`, graph.batch.slug, responseCase.batchSlug);
  mismatch(violations, `${scope} response mode`, graph.mode, "official_snapshot");
  mismatch(violations, `${scope} generatedAt`, graph.generatedAt, RESPONSE_BUILT_AT);
  mismatch(
    violations,
    `${scope} selected Top Voice audience`,
    graph.selectedTopVoiceAudience.id,
    expectedAudience
  );

  if (!graph.scoringContext) {
    violations.push(`${scope} is missing scoringContext`);
  } else {
    mismatch(violations, `${scope} scoringContext modelId`, graph.scoringContext.modelId, TRACTION_SCORING_CONFIG.modelId);
    mismatch(
      violations,
      `${scope} scoringContext modelVersion`,
      graph.scoringContext.modelVersion,
      TRACTION_SCORING_CONFIG.version
    );
    mismatch(violations, `${scope} scoringContext modelName`, graph.scoringContext.modelName, TRACTION_SCORING_CONFIG.name);
    mismatch(violations, `${scope} scoringContext scoreScope`, graph.scoringContext.scoreScope, "all_platforms");
    mismatch(
      violations,
      `${scope} scoringContext selectedPlatforms`,
      graph.scoringContext.selectedPlatforms,
      []
    );
    mismatch(violations, `${scope} scoringContext responseBuiltAt`, graph.scoringContext.responseBuiltAt, graph.generatedAt);
    mismatch(
      violations,
      `${scope} scoringContext canonical evidenceAsOf`,
      graph.scoringContext.evidenceAsOf,
      canonicalGraph.scoringContext?.evidenceAsOf
    );
  }

  if (!responseCase.topVoices && !selectedPlatforms.length && graph.nodes.length === 0) {
    violations.push(`${scope} regular response unexpectedly has no company nodes`);
  }

  collectPositiveEvidenceViolations(graph, scope, violations);
  collectEntityAndRollupViolations(graph, canonicalGraph, scope, violations);
  collectLeaderboardViolations(graph, canonicalGraph, scope, violations);
  collectCanonicalMomentumViolations(graph, canonicalGraph, scope, violations);
  collectSelectedPlatformViolations(graph, selectedPlatforms, scope, violations);

  return violations;
}

function collectPositiveEvidenceViolations(
  graph: GraphResponse,
  scope: string,
  violations: string[]
): void {
  for (const item of graph.evidence) {
    const itemScope = `${scope} evidence ${item.id}`;
    if (!Number.isFinite(item.contributionScore) || item.contributionScore < 0) {
      violations.push(`${itemScope} has invalid contributionScore ${String(item.contributionScore)}`);
      continue;
    }
    if (item.contributionScore === 0) continue;

    if (!isNativeEvidenceUrl(item.platform, item.sourceUrl)) {
      violations.push(`${itemScope} is not a native ${item.platform} object: ${item.sourceUrl}`);
    }
    if (item.review_state !== "verified") {
      violations.push(`${itemScope} review_state is ${String(item.review_state)}, expected verified`);
    }
    if (item.linkStatus === "invalid" || item.linkStatus === "blocked") {
      violations.push(`${itemScope} has non-scoreable linkStatus ${item.linkStatus}`);
    }

    const canonicalMetrics = normalizeMetricsForScoring(item.platform, item.metrics);
    const metricWeights = TRACTION_SCORING_CONFIG.metricWeights[item.platform] ?? {};
    const hasPositiveCanonicalMetric = Object.entries(canonicalMetrics).some(
      ([metric, value]) =>
        Number.isFinite(value) &&
        Number(value) > 0 &&
        Number(metricWeights[metric as keyof typeof metricWeights] ?? 0) > 0
    );
    const rawEngagement = computeEvidenceRawEngagement(item.platform, item.metrics);

    if (!hasPositiveCanonicalMetric) {
      violations.push(`${itemScope} has no positive canonical metric with a configured weight`);
    }
    if (!Number.isFinite(rawEngagement) || rawEngagement <= 0) {
      violations.push(`${itemScope} has non-positive canonical raw engagement ${String(rawEngagement)}`);
    }
  }
}

function collectEntityAndRollupViolations(
  graph: GraphResponse,
  canonicalGraph: GraphResponse,
  scope: string,
  violations: string[]
): void {
  const nodesByCompanyId = uniqueMap(graph.nodes, (node) => node.entityId, `${scope} node entityId`, violations);
  const evidenceById = uniqueMap(graph.evidence, (item) => item.id, `${scope} evidence id`, violations);
  const founderOwners = new Map<string, string[]>();
  const rollupsByCompanyId = new Map<string, EvidenceItem[]>();

  for (const node of graph.nodes) {
    rollupsByCompanyId.set(node.entityId, []);
    for (const founderId of node.relatedEntityIds) {
      founderOwners.set(founderId, [...(founderOwners.get(founderId) ?? []), node.entityId]);
    }
  }

  for (const item of graph.evidence) {
    const ownerCompanyIds = item.attachedCompanyId
      ? [item.attachedCompanyId]
      : item.entityType === "company"
        ? [item.entityId]
        : founderOwners.get(item.entityId) ?? [];

    if (!ownerCompanyIds.length) {
      violations.push(`${scope} evidence ${item.id} references unknown ${item.entityType} ${item.entityId}`);
    }
    if (item.attachedCompanyId && !nodesByCompanyId.has(item.attachedCompanyId)) {
      violations.push(`${scope} evidence ${item.id} attaches to non-visible company ${item.attachedCompanyId}`);
    }

    for (const companyId of ownerCompanyIds) {
      const rollup = rollupsByCompanyId.get(companyId);
      if (rollup) rollup.push(item);
    }
  }

  const canonicalNodesByCompanyId = new Map(
    canonicalGraph.nodes.map((node) => [node.entityId, node])
  );
  const canonicalRollupsByCompanyId = companyEvidenceRollups(canonicalGraph);
  const positiveCalibrationCohort = yc2026GraphDataset.companies.filter(
    (company) => (company.scoreBreakdown?.absoluteScore ?? 0) > 0
  ).length;

  for (const node of graph.nodes) {
    const nodeScope = `${scope} company ${node.label} (${node.entityId})`;
    const rollup = rollupsByCompanyId.get(node.entityId) ?? [];
    const canonicalNode = canonicalNodesByCompanyId.get(node.entityId);
    if (!canonicalNode) {
      violations.push(`${nodeScope} is missing from the canonical base graph`);
      continue;
    }
    collectNodeReferenceViolations(
      node,
      canonicalNode,
      rollup,
      evidenceById,
      graph,
      canonicalGraph,
      nodeScope,
      violations
    );
    collectNodeScoreViolations(
      node,
      canonicalNode,
      canonicalRollupsByCompanyId.get(node.entityId) ?? [],
      positiveCalibrationCohort,
      nodeScope,
      violations
    );
  }

  const referencedEvidenceIds = new Set(graph.nodes.flatMap((node) => node.evidenceIds));
  for (const item of graph.evidence) {
    if (!referencedEvidenceIds.has(item.id)) {
      violations.push(`${scope} evidence ${item.id} is not referenced by a visible company node`);
    }
  }
}

function collectNodeReferenceViolations(
  node: GraphNode,
  canonicalNode: GraphNode,
  rollup: EvidenceItem[],
  evidenceById: Map<string, EvidenceItem>,
  graph: GraphResponse,
  canonicalGraph: GraphResponse,
  nodeScope: string,
  violations: string[]
): void {
  if (node.id !== `company:${node.entityId}` || node.entityType !== "company") {
    violations.push(`${nodeScope} has incoherent node identity ${node.id}/${node.entityType}`);
  }
  if (node.batchSlug !== graph.batch.slug) {
    violations.push(`${nodeScope} has batchSlug ${node.batchSlug}, expected ${graph.batch.slug}`);
  }

  const expectedEvidenceIds = [...new Set(rollup.map((item) => item.id))].sort();
  const actualEvidenceIds = [...node.evidenceIds].sort();
  if (new Set(node.evidenceIds).size !== node.evidenceIds.length) {
    violations.push(`${nodeScope} contains duplicate evidenceIds`);
  }
  mismatch(violations, `${nodeScope} evidenceIds`, actualEvidenceIds, expectedEvidenceIds);

  for (const evidenceId of node.evidenceIds) {
    if (!evidenceById.has(evidenceId)) {
      violations.push(`${nodeScope} references missing response evidence ${evidenceId}`);
    }
  }

  const founderIds = node.founders.map((founder) => founder.id);
  if (new Set(founderIds).size !== founderIds.length) {
    violations.push(`${nodeScope} contains duplicate founder summaries`);
  }
  mismatch(
    violations,
    `${nodeScope} founder references`,
    [...founderIds].sort(),
    [...new Set(node.relatedEntityIds)].sort()
  );

  for (const founder of node.founders) {
    const founderScope = `${nodeScope} founder ${founder.name} (${founder.id})`;
    const directEvidence = graph.evidence.filter(
      (item) => item.entityType === "founder" && item.entityId === founder.id
    );
    const expectedFounderEvidenceIds = [...new Set(directEvidence.map((item) => item.id))].sort();
    mismatch(
      violations,
      `${founderScope} evidenceIds`,
      [...founder.evidenceIds].sort(),
      expectedFounderEvidenceIds
    );
    const canonicalFounder = canonicalNode.founders.find((candidate) => candidate.id === founder.id);
    if (!canonicalFounder) {
      violations.push(`${founderScope} is missing from the canonical company node`);
      continue;
    }
    const canonicalDirectEvidence = canonicalGraph.evidence.filter(
      (item) => item.entityType === "founder" && item.entityId === founder.id
    );
    const founderScore = aggregateBalancedTractionScore(canonicalDirectEvidence);
    mismatch(
      violations,
      `${founderScope} platformScores`,
      founder.platformScores,
      founderScore.platformScores
    );
    mismatch(
      violations,
      `${founderScope} canonical platformScores`,
      founder.platformScores,
      canonicalFounder.platformScores
    );
  }
}

function collectNodeScoreViolations(
  node: GraphNode,
  canonicalNode: GraphNode,
  canonicalRollup: EvidenceItem[],
  positiveCalibrationCohort: number,
  nodeScope: string,
  violations: string[]
): void {
  const breakdown = node.scoreBreakdown;
  if (!breakdown) {
    violations.push(`${nodeScope} is missing scoreBreakdown`);
    return;
  }

  mismatch(violations, `${nodeScope} score`, node.score, breakdown.totalScore);
  mismatch(violations, `${nodeScope} platformScores`, node.platformScores, breakdown.platformScores);
  mismatch(violations, `${nodeScope} modelId`, breakdown.modelId, TRACTION_SCORING_CONFIG.modelId);
  mismatch(violations, `${nodeScope} modelVersion`, breakdown.modelVersion, TRACTION_SCORING_CONFIG.version);
  mismatch(violations, `${nodeScope} modelName`, breakdown.modelName, TRACTION_SCORING_CONFIG.name);
  mismatch(violations, `${nodeScope} totalSupportedPlatforms`, breakdown.totalSupportedPlatforms, SUPPORTED_PLATFORM_COUNT);
  mismatch(violations, `${nodeScope} canonical score`, node.score, canonicalNode.score);
  mismatch(violations, `${nodeScope} canonical previousScore`, node.previousScore, canonicalNode.previousScore);
  mismatch(violations, `${nodeScope} canonical scoreDelta`, node.scoreDelta, canonicalNode.scoreDelta);
  mismatch(violations, `${nodeScope} canonical radius`, node.radius, canonicalNode.radius);
  mismatch(violations, `${nodeScope} canonical topPlatform`, node.topPlatform, canonicalNode.topPlatform);
  mismatch(violations, `${nodeScope} canonical platformScores`, node.platformScores, canonicalNode.platformScores);
  mismatch(violations, `${nodeScope} canonical scoreBreakdown`, breakdown, canonicalNode.scoreBreakdown);

  const scoringCandidateRows = canonicalRollup.filter(
    (item) => Number(TRACTION_SCORING_CONFIG.platformWeights[item.platform] ?? 0) > 0
  );
  const rawPositiveRows = scoringCandidateRows.filter((item) => item.contributionScore > 0);
  const uniquePositiveRows = dedupeEvidenceForScoring(scoringCandidateRows).filter(
    (item) => item.contributionScore > 0
  );
  const physicalPostGroups = groupBy(scoringCandidateRows, canonicalPostKey);
  for (const [key, rows] of physicalPostGroups) {
    if (rows.length > 1) {
      violations.push(
        `${nodeScope} has physical scoring key ${key} on ${rows.length} rows: ${rows.map((item) => item.id).join(", ")}`
      );
    }
  }

  const recomputed = aggregateBalancedTractionScore(scoringCandidateRows);
  mismatch(violations, `${nodeScope} absoluteScore`, breakdown.absoluteScore, recomputed.absoluteScore);
  mismatch(violations, `${nodeScope} weightedAvailableScore`, breakdown.weightedAvailableScore, recomputed.weightedAvailableScore);
  mismatch(violations, `${nodeScope} coverageFactor`, breakdown.coverageFactor, recomputed.coverageFactor);
  mismatch(violations, `${nodeScope} platformsWithEvidence`, breakdown.platformsWithEvidence, recomputed.platformsWithEvidence);
  mismatch(violations, `${nodeScope} recomputed platformScores`, breakdown.platformScores, recomputed.platformScores);
  mismatch(violations, `${nodeScope} weightedPlatforms`, breakdown.weightedPlatforms, recomputed.weightedPlatforms);
  mismatch(violations, `${nodeScope} signalFamilyScores`, breakdown.signalFamilyScores, recomputed.signalFamilyScores);
  mismatch(violations, `${nodeScope} confidence`, breakdown.confidence, recomputed.confidence);
  mismatch(violations, `${nodeScope} limitations`, breakdown.limitations, recomputed.limitations);
  mismatch(violations, `${nodeScope} evidenceAsOf`, breakdown.evidenceAsOf, recomputed.evidenceAsOf);

  const expectedPlatformCounts = countByPlatform(uniquePositiveRows);
  if (breakdown.platformsWithEvidence !== expectedPlatformCounts.size) {
    violations.push(
      `${nodeScope} reports ${breakdown.platformsWithEvidence} platforms for ${expectedPlatformCounts.size} scored platforms`
    );
  }
  if (breakdown.confidence.scoredEvidenceCount !== uniquePositiveRows.length) {
    violations.push(
      `${nodeScope} reports ${breakdown.confidence.scoredEvidenceCount} scored posts for ${uniquePositiveRows.length} unique posts`
    );
  }

  const verifiedLinkCount = uniquePositiveRows.filter((item) => item.linkStatus === "verified").length;
  if (breakdown.confidence.verifiedLinkCount !== verifiedLinkCount) {
    violations.push(
      `${nodeScope} reports ${breakdown.confidence.verifiedLinkCount} verified links for ${verifiedLinkCount} verified scored posts`
    );
  }

  const weightedPlatforms = new Map(breakdown.weightedPlatforms.map((item) => [item.platform, item]));
  if (weightedPlatforms.size !== breakdown.weightedPlatforms.length) {
    violations.push(`${nodeScope} contains duplicate weighted platform rows`);
  }
  for (const [platform, expectedCount] of expectedPlatformCounts) {
    const weighted = weightedPlatforms.get(platform);
    if (!weighted) {
      violations.push(`${nodeScope} is missing weighted platform ${platform}`);
      continue;
    }
    if (weighted.evidenceCount !== expectedCount) {
      violations.push(
        `${nodeScope} ${platform} reports ${weighted.evidenceCount} posts for ${expectedCount} unique scored posts`
      );
    }
    mismatch(
      violations,
      `${nodeScope} ${platform} weighted score`,
      weighted.score,
      breakdown.platformScores[platform]
    );
  }
  for (const platform of weightedPlatforms.keys()) {
    if (!expectedPlatformCounts.has(platform)) {
      violations.push(`${nodeScope} reports weighted platform ${platform} without scored evidence`);
    }
  }

  mismatch(
    violations,
    `${nodeScope} topPlatform`,
    node.topPlatform,
    breakdown.weightedPlatforms[0]?.platform ?? null
  );

  if (rawPositiveRows.length > 0 && (node.score <= 0 || breakdown.absoluteScore <= 0)) {
    violations.push(
      `${nodeScope} has ${rawPositiveRows.length} positive evidence rows but score ${node.score}/absolute ${breakdown.absoluteScore}`
    );
  }
  if (rawPositiveRows.length === 0 && breakdown.absoluteScore !== 0) {
    violations.push(`${nodeScope} has no positive scored posts but absoluteScore ${breakdown.absoluteScore}`);
  }

  const calibration = breakdown.calibration;
  mismatch(violations, `${nodeScope} calibration inputScore`, calibration.inputScore, breakdown.absoluteScore);
  mismatch(violations, `${nodeScope} calibration cohortSize`, calibration.cohortSize, positiveCalibrationCohort);
  mismatch(violations, `${nodeScope} calibration method`, calibration.method, "global_best_ratio");
  mismatch(violations, `${nodeScope} calibration percentile`, calibration.percentile, null);
  mismatch(
    violations,
    `${nodeScope} calibration benchmarkTarget`,
    calibration.benchmarkTarget,
    TRACTION_SCORING_CONFIG.globalBenchmarkTarget
  );
  mismatch(
    violations,
    `${nodeScope} calibration benchmarkScope`,
    calibration.benchmarkScope,
    "all_supported_batches"
  );
  mismatch(
    violations,
    `${nodeScope} calibration benchmarkPopulation`,
    calibration.benchmarkPopulation,
    "current_company_snapshot"
  );
  mismatch(
    violations,
    `${nodeScope} global headline score`,
    node.score,
    Math.round(
      (breakdown.absoluteScore / (calibration.benchmarkScore ?? 100)) *
      TRACTION_SCORING_CONFIG.globalBenchmarkTarget
    )
  );
}

function collectLeaderboardViolations(
  graph: GraphResponse,
  canonicalGraph: GraphResponse,
  scope: string,
  violations: string[]
): void {
  const nodesByCompanyId = new Map(graph.nodes.map((node) => [node.entityId, node]));
  const rowsByCompanyId = uniqueMap(
    graph.leaderboard,
    (row) => row.companyId,
    `${scope} leaderboard companyId`,
    violations
  );
  const canonicalRowsByCompanyId = new Map(
    canonicalGraph.leaderboard.map((row) => [row.companyId, row])
  );

  if (graph.leaderboard.length !== graph.nodes.length) {
    violations.push(
      `${scope} has ${graph.nodes.length} nodes but ${graph.leaderboard.length} leaderboard rows`
    );
  }

  for (const node of graph.nodes) {
    const row = rowsByCompanyId.get(node.entityId);
    if (!row) {
      violations.push(`${scope} company ${node.entityId} is missing from the leaderboard`);
      continue;
    }
    mismatch(violations, `${scope} leaderboard ${node.entityId} score`, row.score, node.score);
    mismatch(violations, `${scope} leaderboard ${node.entityId} name`, row.companyName, node.label);
    mismatch(violations, `${scope} leaderboard ${node.entityId} topPlatform`, row.topPlatform, node.topPlatform);
    const canonicalRow = canonicalRowsByCompanyId.get(node.entityId);
    if (!canonicalRow) {
      violations.push(`${scope} leaderboard ${node.entityId} is missing from the canonical base graph`);
    } else {
      mismatch(violations, `${scope} leaderboard ${node.entityId} canonical score`, row.score, canonicalRow.score);
      mismatch(violations, `${scope} leaderboard ${node.entityId} canonical rank`, row.rank, canonicalRow.rank);
      const expectedCanonicalRank =
        canonicalGraph.leaderboard.findIndex(
          (candidate) => candidate.score === canonicalRow.score
        ) + 1;
      mismatch(
        violations,
        `${scope} leaderboard ${node.entityId} canonical tied rank`,
        canonicalRow.rank,
        expectedCanonicalRank
      );
    }

    if (row.biggestContribution) {
      const belongsToCompany = row.biggestContribution.attachedCompanyId
        ? row.biggestContribution.attachedCompanyId === node.entityId
        : row.biggestContribution.entityId === node.entityId ||
          node.relatedEntityIds.includes(row.biggestContribution.entityId);
      if (!belongsToCompany || !graph.evidence.some((item) => item.id === row.biggestContribution?.id)) {
        violations.push(
          `${scope} leaderboard ${node.entityId} biggestContribution ${row.biggestContribution.id} has an incoherent entity reference`
        );
      }
    }
  }

  for (const row of graph.leaderboard) {
    if (!nodesByCompanyId.has(row.companyId)) {
      violations.push(`${scope} leaderboard references missing company node ${row.companyId}`);
    }
  }

  for (let index = 0; index < graph.leaderboard.length; index += 1) {
    const row = graph.leaderboard[index];
    const previous = graph.leaderboard[index - 1];
    if (previous && row.score > previous.score) {
      violations.push(`${scope} leaderboard is not descending at ${previous.companyId}/${row.companyId}`);
    }
  }
}

function collectCanonicalMomentumViolations(
  graph: GraphResponse,
  canonicalGraph: GraphResponse,
  scope: string,
  violations: string[]
): void {
  const visibleCompanyIds = new Set(graph.nodes.map((node) => node.entityId));
  const expectedMomentum = canonicalGraph.fastestGaining.filter((row) =>
    visibleCompanyIds.has(row.companyId)
  );
  mismatch(violations, `${scope} canonical fastestGaining`, graph.fastestGaining, expectedMomentum);

  const canonicalRowsByCompanyId = new Map(
    canonicalGraph.leaderboard.map((row) => [row.companyId, row])
  );
  for (const row of graph.fastestGaining) {
    const canonicalRow = canonicalRowsByCompanyId.get(row.companyId);
    if (!canonicalRow) {
      violations.push(`${scope} momentum ${row.companyId} is missing from the canonical leaderboard`);
      continue;
    }
    for (const [window, delta] of [["dod", row.dod], ["wow", row.wow]] as const) {
      mismatch(
        violations,
        `${scope} momentum ${row.companyId} ${window} currentScore`,
        delta.currentScore,
        canonicalRow.score
      );
      mismatch(
        violations,
        `${scope} momentum ${row.companyId} ${window} currentRank`,
        delta.currentRank,
        canonicalRow.rank
      );
    }
  }
}

function collectSelectedPlatformViolations(
  graph: GraphResponse,
  selectedPlatforms: Platform[],
  scope: string,
  violations: string[]
): void {
  if (!selectedPlatforms.length) return;
  const selected = new Set(selectedPlatforms);

  for (const item of graph.evidence) {
    if (!selected.has(item.platform)) {
      violations.push(`${scope} selected-platform response leaked ${item.platform} evidence ${item.id}`);
    }
  }
  for (const node of graph.nodes) {
    if (!node.evidenceIds.every((evidenceId) => graph.evidence.some((item) => item.id === evidenceId))) {
      violations.push(`${scope} company ${node.entityId} references evidence hidden by the platform filter`);
    }
  }
  for (const row of graph.leaderboard) {
    if (row.biggestContribution && !selected.has(row.biggestContribution.platform)) {
      violations.push(
        `${scope} leaderboard ${row.companyId} uses unselected biggest contribution ${row.biggestContribution.id}`
      );
    }
  }
}

function companyEvidenceRollups(graph: GraphResponse): Map<string, EvidenceItem[]> {
  const founderOwners = new Map<string, string[]>();
  const rollups = new Map(graph.nodes.map((node) => [node.entityId, [] as EvidenceItem[]]));
  for (const node of graph.nodes) {
    for (const founderId of node.relatedEntityIds) {
      founderOwners.set(founderId, [...(founderOwners.get(founderId) ?? []), node.entityId]);
    }
  }
  for (const item of graph.evidence) {
    const ownerCompanyIds = item.attachedCompanyId
      ? [item.attachedCompanyId]
      : item.entityType === "company"
        ? [item.entityId]
        : founderOwners.get(item.entityId) ?? [];
    for (const companyId of ownerCompanyIds) {
      rollups.get(companyId)?.push(item);
    }
  }
  return rollups;
}

function selectedPlatformFixtureViolations(
  batchSlug: (typeof BATCH_SLUGS)[number]
): string[] {
  const violations: string[] = [];
  const companies = yc2026GraphDataset.companies.filter((company) => company.batchSlug === batchSlug);
  const entityIds = new Set(companies.flatMap((company) => [company.id, ...company.founderIds]));
  const positiveRows = yc2026GraphDataset.evidence.filter(
    (item) => entityIds.has(item.entityId) && item.contributionScore > 0
  );
  const selected = new Set(SELECTED_PLATFORMS);

  if (!positiveRows.some((item) => selected.has(item.platform))) {
    violations.push(`${batchSlug} fixture has no positive selected-platform evidence`);
  }
  if (!positiveRows.some((item) => !selected.has(item.platform))) {
    violations.push(`${batchSlug} fixture has no positive unselected evidence to guard against leakage`);
  }
  return violations;
}

function countByPlatform(items: EvidenceItem[]): Map<Platform, number> {
  const counts = new Map<Platform, number>();
  for (const item of items) {
    counts.set(item.platform, (counts.get(item.platform) ?? 0) + 1);
  }
  return counts;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function uniqueMap<T>(
  items: T[],
  keyFor: (item: T) => string,
  label: string,
  violations: string[]
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = keyFor(item);
    if (result.has(key)) violations.push(`${label} ${key} is duplicated`);
    result.set(key, item);
  }
  return result;
}

function mismatch(
  violations: string[],
  label: string,
  actual: unknown,
  expected: unknown
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    violations.push(`${label}: expected ${formatValue(expected)}, received ${formatValue(actual)}`);
  }
}

function formatValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return String(value);
  return serialized.length <= 500 ? serialized : `${serialized.slice(0, 497)}...`;
}

function assertNoViolations(scope: string, violations: string[]): void {
  const displayed = violations.slice(0, 40).map((violation) => `- ${violation}`).join("\n");
  const omitted = violations.length > 40 ? `\n- ... ${violations.length - 40} more` : "";
  expect(
    violations,
    `${scope} contract violations (${violations.length}):\n${displayed}${omitted}`
  ).toHaveLength(0);
}
