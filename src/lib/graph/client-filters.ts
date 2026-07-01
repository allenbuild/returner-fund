import type { EvidenceItem, GraphResponse, NeedsReviewItem, Platform } from "./types";

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

  const nodes = graph.nodes.filter((node) => {
    if (node.score < filters.minScore) {
      return false;
    }
    if (selectedIndustries.size > 0 && !selectedIndustries.has(node.primaryIndustry)) {
      return false;
    }
    if (selectedGroupPartners.size > 0 && (!node.groupPartner || !selectedGroupPartners.has(node.groupPartner))) {
      return false;
    }
    if (selectedPlatforms.size > 0 && !nodeMatchesPlatforms(node, selectedPlatforms)) {
      return false;
    }
    return true;
  });

  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const visibleCompanyIds = new Set(nodes.map((node) => node.entityId));
  const visibleFounderIds = new Set(nodes.flatMap((node) => node.founders.map((founder) => founder.id)));
  const visibleEvidence = graph.evidence
    .filter((item) => evidenceMatchesVisibleEntities(item, visibleCompanyIds, visibleFounderIds))
    .filter((item) => selectedPlatforms.size === 0 || selectedPlatforms.has(item.platform))
    .sort((left, right) => right.contributionScore - left.contributionScore);
  const topEvidenceByCompany = buildTopEvidenceByCompany(nodes, visibleEvidence);

  return {
    ...graph,
    nodes,
    edges: graph.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    evidence: visibleEvidence,
    leaderboard: graph.leaderboard
      .filter((row) => visibleCompanyIds.has(row.companyId))
      .map((row, index) => ({
        ...row,
        rank: index + 1,
        biggestContribution: topEvidenceByCompany.get(row.companyId) ?? null
      })),
    fastestGaining: graph.fastestGaining
      .filter((row) => visibleCompanyIds.has(row.companyId))
      .map((row, index) => ({ ...row, rank: index + 1 })),
    needsReview: graph.needsReview.filter((item) =>
      needsReviewItemVisible(item, visibleCompanyIds, visibleFounderIds, selectedPlatforms)
    ),
    generatedAt: new Date().toISOString()
  };
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
