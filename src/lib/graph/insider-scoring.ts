import type {
  GraphResponse,
  InsiderScoreBreakdown,
  MomentumDelta,
  TopVoiceConnectionPreview
} from "./types";
import { momentumSort } from "./benchmarks";

const COMPANY_RADIUS = { min: 5, max: 68 };

export const INSIDER_SCORE_FORMULA =
  "base_plus_unique_weighted_insiders_capped_100" as const;

export function computeInsiderScore(input: {
  baseScore: number;
  connections: TopVoiceConnectionPreview[];
  selectedInsiderIds?: string[];
  configurationVersion?: number | null;
}): InsiderScoreBreakdown {
  const selected = new Set(input.selectedInsiderIds ?? []);
  const hasSelection = selected.size > 0;
  const uniqueConnections = new Map(
    input.connections.map((connection) => [connection.memberId, connection] as const)
  );
  const matches = [...uniqueConnections.values()]
    .map((connection) => {
      const included = !hasSelection || selected.has(connection.memberId);
      return {
        memberId: connection.memberId,
        displayName: connection.displayName,
        effectiveWeight: connection.weight,
        evidenceCount: connection.evidenceCount,
        included,
        exclusionReason: included ? null : "not_selected" as const
      };
    })
    .sort((left, right) =>
      Number(right.included) - Number(left.included) ||
      right.effectiveWeight - left.effectiveWeight ||
      left.displayName.localeCompare(right.displayName)
    );
  const weightedInsiderSubtotal = matches
    .filter((match) => match.included)
    .reduce((total, match) => total + match.effectiveWeight, 0);
  const baseScore = round(input.baseScore);
  const finalScore = round(Math.min(100, Math.max(0, baseScore + weightedInsiderSubtotal)));

  return {
    baseScore,
    weightedInsiderSubtotal,
    finalScore,
    selectedInsiderIds: [...selected].sort(),
    configurationVersion: input.configurationVersion ?? null,
    matches,
    formula: INSIDER_SCORE_FORMULA
  };
}

export function applyInsiderScenarioScoring(
  graph: GraphResponse,
  input: {
    selectedInsiderIds?: string[];
    configurationVersion?: number | null;
    /**
     * The immutable published/default Insider slice. Its connections define
     * the default weight already included in each published company score.
     */
    publishedInsiderGraph?: GraphResponse;
  } = {}
): GraphResponse {
  if (graph.selectedTopVoiceAudience.id !== "insiders") return graph;

  const publishedConnectionsByCompany = new Map(
    (input.publishedInsiderGraph?.nodes ?? [])
      .filter((node) => node.entityType === "company")
      .map((node) => [node.entityId, node.topVoiceConnections ?? []] as const)
  );
  const breakdownByCompany = new Map(
    graph.nodes
      .filter((node) => node.entityType === "company")
      .map((node) => [
        node.entityId,
        computeInsiderScore({
          baseScore: stableInsiderBaseScore(
            node.score,
            publishedConnectionsByCompany.get(node.entityId) ?? []
          ),
          connections: node.topVoiceConnections ?? [],
          selectedInsiderIds: input.selectedInsiderIds,
          configurationVersion: input.configurationVersion
        })
      ] as const)
  );
  const peerScores = [...breakdownByCompany.values()].map((breakdown) => breakdown.finalScore);
  const nodes = graph.nodes.map((node) => {
    if (node.entityType !== "company") return node;
    const breakdown = breakdownByCompany.get(node.entityId);
    if (!breakdown) return node;
    return {
      ...node,
      score: breakdown.finalScore,
      scoreDelta: round(breakdown.finalScore - node.previousScore),
      radius: getCompanyRadius(breakdown.finalScore, peerScores),
      topVoiceScore: breakdown.weightedInsiderSubtotal,
      insiderScoreBreakdown: breakdown
    };
  });
  const sortedRows = graph.leaderboard
    .map((row) => {
      const breakdown = breakdownByCompany.get(row.companyId);
      return breakdown
        ? {
            ...row,
            score: breakdown.finalScore,
            topVoiceScore: breakdown.weightedInsiderSubtotal,
            insiderScoreBreakdown: breakdown
          }
        : row;
    })
    .sort((left, right) =>
      right.score - left.score ||
      left.companyName.localeCompare(right.companyName) ||
      left.companyId.localeCompare(right.companyId)
    );
  let previousScore: number | null = null;
  let tiedRank = 0;
  const leaderboard = sortedRows.map((row, index) => {
    if (previousScore === null || row.score !== previousScore) tiedRank = index + 1;
    previousScore = row.score;
    return { ...row, rank: tiedRank };
  });
  const scoredRowByCompany = new Map(
    leaderboard.map((row) => [row.companyId, row] as const)
  );
  const fastestGaining = graph.fastestGaining
    .map((row) => {
      const scoredRow = scoredRowByCompany.get(row.companyId);
      if (!scoredRow || !breakdownByCompany.has(row.companyId)) return row;
      return {
        ...row,
        dod: recomputeMomentumDelta(row.dod, scoredRow.score, scoredRow.rank),
        wow: recomputeMomentumDelta(row.wow, scoredRow.score, scoredRow.rank)
      };
    })
    .sort(momentumSort("dod"))
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    ...graph,
    nodes,
    leaderboard,
    fastestGaining,
    selectedInsiderIds: [...new Set(input.selectedInsiderIds ?? [])].sort(),
    insiderConfigurationVersion: input.configurationVersion ?? null,
    scoringContext: graph.scoringContext
      ? { ...graph.scoringContext, scoreScope: "top_voice" }
      : graph.scoringContext
  };
}

/**
 * Published Insider scores already include each default member weight once.
 * Subtract that immutable subtotal before applying the effective saved
 * configuration, preserving default scores while making weight edits visible.
 */
export function stableInsiderBaseScore(
  publishedScore: number,
  publishedConnections: TopVoiceConnectionPreview[]
): number {
  const uniquePublishedWeights = new Map(
    publishedConnections.map((connection) => [
      connection.memberId,
      connection.weight
    ] as const)
  );
  const publishedInsiderSubtotal = [...uniquePublishedWeights.values()]
    .reduce((total, weight) => total + weight, 0);
  return round(Math.max(0, publishedScore - publishedInsiderSubtotal));
}

function recomputeMomentumDelta(
  stored: MomentumDelta,
  currentScore: number,
  currentRank: number
): MomentumDelta {
  const scoreDelta = stored.baselineScore === null
    ? 0
    : round(currentScore - stored.baselineScore);
  return {
    ...stored,
    scoreDelta,
    percentDelta: stored.baselineScore === null
      ? 0
      : round((scoreDelta / Math.max(stored.baselineScore, 1)) * 100),
    rankDelta: stored.baselineRank === null ? 0 : stored.baselineRank - currentRank,
    currentScore,
    currentRank
  };
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getCompanyRadius(score: number, peerScores: number[]): number {
  const percentile = scorePercentile(score, peerScores);
  return round(
    COMPANY_RADIUS.min +
    Math.pow(percentile, 2.2) * (COMPANY_RADIUS.max - COMPANY_RADIUS.min)
  );
}

function scorePercentile(score: number, peerScores: number[]): number {
  if (peerScores.length <= 1) return 0.5;
  const min = Math.min(...peerScores);
  const max = Math.max(...peerScores);
  if (max === min) return 0.5;
  return (score - min) / (max - min);
}
