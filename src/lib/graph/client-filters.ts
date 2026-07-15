import { aggregateBalancedTractionScore } from "./traction-scoring";
import type {
  EvidenceItem,
  GraphResponse,
  NeedsReviewItem,
  Platform,
  TopVoiceConnectionPreview
} from "./types";

export interface ClientGraphFilters {
  platforms: Platform[];
  industries: string[];
  groupPartners: string[];
  minScore: number;
}

export function applyClientGraphFilters(graph: GraphResponse, filters: ClientGraphFilters): GraphResponse {
  const selectedPlatforms = new Set(filters.platforms);
  const selectedIndustries = new Set(filters.industries);
  const selectedGroupPartners = new Set(filters.groupPartners);
  const topVoiceMode = graph.selectedTopVoiceAudience.id !== "off";
  const topVoiceEvidenceByCompany =
    topVoiceMode && selectedPlatforms.size > 0
      ? topVoiceEvidenceByCompanyId(graph, selectedPlatforms)
      : null;
  const baseCompanyNodes = graph.nodes.filter((node) => node.entityType === "company");
  const topVoicePeerScores = topVoiceEvidenceByCompany
    ? baseCompanyNodes.map((node) => filteredTopVoiceScore(topVoiceEvidenceByCompany.get(node.entityId) ?? []))
    : [];

  const companyNodes = baseCompanyNodes.map((node) =>
    topVoiceEvidenceByCompany
      ? nodeWithFilteredTopVoiceEvidence(
          node,
          topVoiceEvidenceByCompany.get(node.entityId) ?? [],
          topVoicePeerScores
        )
      : node
  ).filter((node) => {
    if (node.score < filters.minScore) {
      return false;
    }
    if (selectedIndustries.size > 0 && !selectedIndustries.has(node.primaryIndustry)) {
      return false;
    }
    if (selectedGroupPartners.size > 0 && (!node.groupPartner || !selectedGroupPartners.has(node.groupPartner))) {
      return false;
    }
    if (topVoiceEvidenceByCompany && !topVoiceEvidenceByCompany.has(node.entityId)) {
      return false;
    }
    if (!topVoiceEvidenceByCompany && selectedPlatforms.size > 0 && !nodeMatchesPlatforms(node, selectedPlatforms)) {
      return false;
    }
    return true;
  });

  const visibleCompanyNodeIds = new Set(companyNodes.map((node) => node.id));
  const visibleVoiceNodeIds = new Set<string>();
  const prelimEdges = graph.edges.filter((edge) => {
    if (edge.edgeType === "top_voice_attention") {
      if (!visibleCompanyNodeIds.has(edge.target)) {
        return false;
      }
      visibleVoiceNodeIds.add(edge.source);
      return true;
    }
    return visibleCompanyNodeIds.has(edge.source) && visibleCompanyNodeIds.has(edge.target);
  });
  const nodes = [
    ...companyNodes,
    ...graph.nodes.filter((node) => node.entityType !== "company" && visibleVoiceNodeIds.has(node.id))
  ];
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const visibleCompanyIds = new Set(companyNodes.map((node) => node.entityId));
  const visibleFounderIds = new Set(companyNodes.flatMap((node) => node.founders.map((founder) => founder.id)));
  const visibleEvidence = graph.evidence
    .filter((item) => evidenceMatchesVisibleEntities(item, visibleCompanyIds, visibleFounderIds))
    .filter((item) => selectedPlatforms.size === 0 || selectedPlatforms.has(item.platform))
    .sort((left, right) => right.contributionScore - left.contributionScore);
  const topEvidenceByCompany = buildTopEvidenceByCompany(nodes, visibleEvidence);
  const nodeByCompanyId = new Map(companyNodes.map((node) => [node.entityId, node]));
  const leaderboardRows = graph.leaderboard
    .filter((row) => visibleCompanyIds.has(row.companyId))
    .map((row) => {
      const filteredNode = topVoiceEvidenceByCompany ? nodeByCompanyId.get(row.companyId) : null;
      return {
        ...row,
        score: filteredNode?.score ?? row.score,
        topPlatform: filteredNode?.topPlatform ?? row.topPlatform,
        topVoiceScore: filteredNode?.topVoiceScore ?? row.topVoiceScore,
        topVoiceConnectionCount: filteredNode?.topVoiceConnectionCount ?? row.topVoiceConnectionCount,
        topVoiceConnections: filteredNode?.topVoiceConnections ?? row.topVoiceConnections,
        biggestContribution:
          topEvidenceByCompany.get(row.companyId) ??
          (row.biggestContribution && evidenceMatchesSelectedPlatforms(row.biggestContribution, selectedPlatforms)
            ? row.biggestContribution
            : null)
      };
    });
  const sortedLeaderboardRows = topVoiceEvidenceByCompany
    ? leaderboardRows.sort((left, right) => right.score - left.score || left.companyName.localeCompare(right.companyName))
    : leaderboardRows;

  return {
    ...graph,
    nodes,
    edges: prelimEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    evidence: visibleEvidence,
    leaderboard: sortedLeaderboardRows.map((row, index) => ({ ...row, rank: index + 1 })),
    fastestGaining: graph.fastestGaining
      .filter((row) => visibleCompanyIds.has(row.companyId))
      .map((row, index) => ({ ...row, rank: index + 1 })),
    needsReview: graph.needsReview.filter((item) =>
      needsReviewItemVisible(item, visibleCompanyIds, visibleFounderIds, selectedPlatforms)
    ),
    generatedAt: new Date().toISOString()
  };
}

function topVoiceEvidenceByCompanyId(
  graph: GraphResponse,
  selectedPlatforms: Set<Platform>
): Map<string, EvidenceItem[]> {
  const founderIdToCompanyId = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.entityType !== "company") {
      continue;
    }
    for (const founder of node.founders) {
      founderIdToCompanyId.set(founder.id, node.entityId);
    }
  }

  const evidenceByCompanyId = new Map<string, EvidenceItem[]>();
  for (const item of graph.evidence) {
    if (!selectedPlatforms.has(item.platform) || item.contributionScore <= 0) {
      continue;
    }
    const companyId =
      item.attachedCompanyId ??
      (item.entityType === "company" ? item.entityId : founderIdToCompanyId.get(item.entityId));
    if (companyId) {
      evidenceByCompanyId.set(companyId, [...(evidenceByCompanyId.get(companyId) ?? []), item]);
    }
  }
  for (const [companyId, items] of evidenceByCompanyId) {
    evidenceByCompanyId.set(companyId, items.sort((left, right) => right.contributionScore - left.contributionScore));
  }
  return evidenceByCompanyId;
}

function nodeWithFilteredTopVoiceEvidence(
  node: GraphResponse["nodes"][number],
  evidence: EvidenceItem[],
  peerScores: number[]
): GraphResponse["nodes"][number] {
  const scoreBreakdown = aggregateBalancedTractionScore(evidence);
  const score = filteredTopVoiceScore(evidence);
  const connections = topVoiceConnectionsFromEvidence(evidence);
  const evidenceIds = evidence.map((item) => item.id);

  return {
    ...node,
    score,
    previousScore: score,
    scoreDelta: 0,
    radius: clientNodeRadius(score, peerScores),
    topPlatform: scoreBreakdown.weightedPlatforms[0]?.platform ?? topPlatform(scoreBreakdown.platformScores),
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown: {
      ...scoreBreakdown,
      totalScore: score,
      explanation:
        score > 0
          ? `${scoreBreakdown.explanation} Filtered to visible Top Voices platform evidence.`
          : "No scored evidence from the selected Top Voices platform filter."
    },
    evidenceIds,
    founders: node.founders.map((founder) => {
      const founderEvidence = evidence.filter((item) => item.entityType === "founder" && item.entityId === founder.id);
      return {
        ...founder,
        evidenceIds: founderEvidence.map((item) => item.id),
        platformScores: aggregateBalancedTractionScore(founderEvidence).platformScores
      };
    }),
    topVoiceScore: score,
    topVoiceConnectionCount: connections.length,
    topVoiceConnections: connections
  };
}

function filteredTopVoiceScore(evidence: EvidenceItem[]): number {
  const scoreBreakdown = aggregateBalancedTractionScore(evidence);
  return Math.min(100, Math.max(0, Math.round(scoreBreakdown.totalScore)));
}

function topVoiceConnectionsFromEvidence(evidence: EvidenceItem[]): TopVoiceConnectionPreview[] {
  const connections = new Map<
    string,
    TopVoiceConnectionPreview & { topEvidenceScore: number }
  >();

  for (const item of evidence) {
    const topVoice = item.topVoice;
    if (!topVoice) {
      continue;
    }
    const connection = connections.get(topVoice.memberId) ?? {
      memberId: topVoice.memberId,
      displayName: topVoice.displayName,
      category: topVoice.category,
      weight: topVoice.weight,
      contributionScore: 0,
      evidenceCount: 0,
      topEvidenceId: null,
      topEvidenceScore: -Infinity,
      platforms: []
    };
    connection.contributionScore = round(connection.contributionScore + item.contributionScore);
    connection.evidenceCount += 1;
    connection.platforms = [...new Set([...connection.platforms, item.platform])].sort();
    if (item.contributionScore > connection.topEvidenceScore) {
      connection.topEvidenceId = item.id;
      connection.topEvidenceScore = item.contributionScore;
    }
    connections.set(topVoice.memberId, connection);
  }

  return [...connections.values()]
    .map(({ topEvidenceScore: _topEvidenceScore, ...connection }) => connection)
    .sort((left, right) => right.contributionScore - left.contributionScore || left.displayName.localeCompare(right.displayName));
}

const COMPANY_RADIUS = { min: 5, max: 68 };

function clientNodeRadius(score: number, peerScores: number[]): number {
  const percentile = scorePercentile(score, peerScores);
  return round(COMPANY_RADIUS.min + Math.pow(percentile, 2.2) * (COMPANY_RADIUS.max - COMPANY_RADIUS.min));
}

function scorePercentile(score: number, peerScores: number[]): number {
  if (peerScores.length <= 1) {
    return 0.5;
  }

  const min = Math.min(...peerScores);
  const max = Math.max(...peerScores);
  if (max === min) {
    return 0.5;
  }

  return (score - min) / (max - min);
}

function topPlatform(platformScores: Partial<Record<Platform, number>>): Platform | null {
  const entries = Object.entries(platformScores) as [Platform, number][];
  if (!entries.length) {
    return null;
  }
  return entries.sort((left, right) => right[1] - left[1])[0][0];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function evidenceMatchesSelectedPlatforms(item: EvidenceItem, selectedPlatforms: Set<Platform>): boolean {
  return selectedPlatforms.size === 0 || selectedPlatforms.has(item.platform);
}

function buildTopEvidenceByCompany(
  nodes: GraphResponse["nodes"],
  visibleEvidence: EvidenceItem[]
): Map<string, EvidenceItem | null> {
  const topEvidenceByCompany = new Map<string, EvidenceItem | null>();

  for (const node of nodes) {
    const allowedEntityIds = new Set([node.entityId, ...node.founders.map((founder) => founder.id)]);
    topEvidenceByCompany.set(
      node.entityId,
      visibleEvidence.find((item) => item.contributionScore > 0 && allowedEntityIds.has(item.entityId)) ?? null
    );
  }

  return topEvidenceByCompany;
}

function nodeMatchesPlatforms(
  node: GraphResponse["nodes"][number],
  selectedPlatforms: Set<Platform>
): boolean {
  const nodePlatforms = new Set<string>([
    ...Object.keys(node.platformScores),
    ...node.socialAccounts.map((account) => account.platform),
    ...node.founders.flatMap((founder) => Object.keys(founder.platformScores)),
    ...node.founders.flatMap((founder) => founder.socialAccounts.map((account) => account.platform))
  ]);

  return [...selectedPlatforms].some((platform) => nodePlatforms.has(platform));
}

function evidenceMatchesVisibleEntities(
  item: EvidenceItem,
  visibleCompanyIds: Set<string>,
  visibleFounderIds: Set<string>
): boolean {
  return item.entityType === "company" ? visibleCompanyIds.has(item.entityId) : visibleFounderIds.has(item.entityId);
}

function needsReviewItemVisible(
  item: NeedsReviewItem,
  visibleCompanyIds: Set<string>,
  visibleFounderIds: Set<string>,
  selectedPlatforms: Set<Platform>
): boolean {
  if (selectedPlatforms.size > 0 && !selectedPlatforms.has(item.platform)) {
    return false;
  }
  return item.entityType === "company" ? visibleCompanyIds.has(item.entityId) : visibleFounderIds.has(item.entityId);
}
