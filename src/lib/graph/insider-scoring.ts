import type {
  GraphResponse,
  InsiderScoreBreakdown,
  MomentumDelta,
  TopVoiceConnectionPreview
} from "./types";
import { momentumSort } from "./benchmarks";

const COMPANY_RADIUS = { min: 5, max: 68 };

export const INSIDER_SCORE_FORMULA =
  "published_score_plus_quadratic_insider_adjustments_capped_0_100" as const;

/**
 * Weight is an editorial confidence level, not a one-point bonus. Squaring it
 * gives each step visible leverage while keeping the 1..5 control intuitive:
 * 1, 4, 9, 16, and 25 influence points.
 */
export function insiderWeightInfluence(weight: number): number {
  const normalized = Number.isFinite(weight) ? Math.max(0, weight) : 0;
  return round(normalized ** 2);
}

export function computeInsiderScore(input: {
  baseScore: number;
  connections: TopVoiceConnectionPreview[];
  publishedConnections?: TopVoiceConnectionPreview[];
  selectedInsiderIds?: string[];
  configurationVersion?: number | null;
}): InsiderScoreBreakdown {
  const selected = new Set(input.selectedInsiderIds ?? []);
  const hasSelection = selected.size > 0;
  const uniqueConnections = new Map(
    input.connections.map((connection) => [connection.memberId, connection] as const)
  );
  const publishedConnections = new Map(
    (input.publishedConnections ?? []).map((connection) => [connection.memberId, connection] as const)
  );
  const memberIds = new Set([...uniqueConnections.keys(), ...publishedConnections.keys()]);
  const matches = [...memberIds]
    .map((memberId) => {
      const connection = uniqueConnections.get(memberId);
      const published = publishedConnections.get(memberId);
      const included = Boolean(connection) && (!hasSelection || selected.has(memberId));
      const effectiveWeight = included ? connection?.weight ?? 0 : 0;
      const publishedWeight = published?.weight ?? 0;
      const influenceScore = insiderWeightInfluence(effectiveWeight);
      const publishedInfluenceScore = insiderWeightInfluence(publishedWeight);
      return {
        memberId,
        displayName: connection?.displayName ?? published?.displayName ?? memberId,
        effectiveWeight,
        influenceScore,
        publishedWeight,
        publishedInfluenceScore,
        adjustment: round(influenceScore - publishedInfluenceScore),
        evidenceCount: connection?.evidenceCount ?? published?.evidenceCount ?? 0,
        included,
        exclusionReason: included
          ? null
          : connection && hasSelection
            ? "not_selected" as const
            : "disabled" as const
      };
    })
    .sort((left, right) =>
      Number(right.included) - Number(left.included) ||
      right.influenceScore - left.influenceScore ||
      right.publishedInfluenceScore - left.publishedInfluenceScore ||
      left.displayName.localeCompare(right.displayName)
    );
  const publishedInsiderInfluence = round(
    matches.reduce((total, match) => total + match.publishedInfluenceScore, 0)
  );
  const weightedInsiderSubtotal = round(
    matches.reduce((total, match) => total + match.influenceScore, 0)
  );
  const insiderScoreAdjustment = round(weightedInsiderSubtotal - publishedInsiderInfluence);
  const baseScore = round(input.baseScore);
  const finalScore = round(Math.min(100, Math.max(0, baseScore + insiderScoreAdjustment)));

  return {
    baseScore,
    publishedInsiderInfluence,
    weightedInsiderSubtotal,
    insiderScoreAdjustment,
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
     * The immutable, published/default Insider slice. Its connections define
     * the baseline influence before a user changed weights or excluded
     * members.
     */
    publishedInsiderGraph?: GraphResponse;
  } = {}
): GraphResponse {
  if (graph.selectedTopVoiceAudience.id !== "insiders") return graph;

  const publishedConnectionsByCompany = new Map(
    (input.publishedInsiderGraph ?? graph).nodes
      .filter((node) => node.entityType === "company")
      .map((node) => [node.entityId, node.topVoiceConnections ?? []] as const)
  );
  const breakdownByCompany = new Map(
    graph.nodes
      .filter((node) => node.entityType === "company")
      .map((node) => [
        node.entityId,
        computeInsiderScore({
          baseScore: node.score,
          connections: node.topVoiceConnections ?? [],
          publishedConnections: publishedConnectionsByCompany.get(node.entityId) ?? [],
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
