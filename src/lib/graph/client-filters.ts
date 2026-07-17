import { graphNodeMatchesSearchQuery } from "./search";
import type {
  BusinessModel,
  EdgeType,
  EvidenceItem,
  GraphResponse,
  NeedsReviewItem,
  Platform
} from "./types";

export interface ClientGraphFilters {
  platforms: Platform[];
  industries: string[];
  groupPartners: string[];
  minScore: number;
  businessModels?: BusinessModel[];
  edgeTypes?: EdgeType[];
  query?: string;
}

export function applyClientGraphFilters(graph: GraphResponse, filters: ClientGraphFilters): GraphResponse {
  const selectedPlatforms = new Set(filters.platforms);
  const selectedIndustries = new Set(filters.industries);
  const selectedGroupPartners = new Set(filters.groupPartners);
  const selectedBusinessModels = new Set(filters.businessModels ?? []);
  const selectedEdgeTypes = new Set(filters.edgeTypes ?? []);
  const query = filters.query?.trim() ?? "";
  const topVoiceMode = graph.selectedTopVoiceAudience.id !== "off";
  const selectedEvidenceCompanyIds = selectedPlatforms.size > 0
    ? companyIdsWithSelectedEvidence(graph, selectedPlatforms, { positiveOnly: topVoiceMode })
    : null;
  const baseCompanyNodes = graph.nodes.filter((node) => node.entityType === "company");
  const companyNodes = baseCompanyNodes.filter((node) => {
    if (node.score < filters.minScore) {
      return false;
    }
    if (selectedIndustries.size > 0 && !selectedIndustries.has(node.primaryIndustry)) {
      return false;
    }
    if (selectedGroupPartners.size > 0 && (!node.groupPartner || !selectedGroupPartners.has(node.groupPartner))) {
      return false;
    }
    if (selectedBusinessModels.size > 0 && !selectedBusinessModels.has(node.businessModel)) {
      return false;
    }
    if (query && !graphNodeMatchesSearchQuery(node, query)) {
      return false;
    }
    if (topVoiceMode && selectedEvidenceCompanyIds && !selectedEvidenceCompanyIds.has(node.entityId)) {
      return false;
    }
    if (
      !topVoiceMode &&
      selectedPlatforms.size > 0 &&
      !nodeMatchesPlatforms(node, selectedPlatforms) &&
      !selectedEvidenceCompanyIds?.has(node.entityId)
    ) {
      return false;
    }
    return true;
  });

  const visibleCompanyNodeIds = new Set(companyNodes.map((node) => node.id));
  const visibleVoiceNodeIds = new Set<string>();
  const prelimEdges = graph.edges.filter((edge) => {
    if (selectedEdgeTypes.size > 0 && !selectedEdgeTypes.has(edge.edgeType)) {
      return false;
    }
    if (edge.edgeType === "top_voice_attention") {
      if (!visibleCompanyNodeIds.has(edge.target)) {
        return false;
      }
      visibleVoiceNodeIds.add(edge.source);
      return true;
    }
    return visibleCompanyNodeIds.has(edge.source) && visibleCompanyNodeIds.has(edge.target);
  });
  const sourceNodes = [
    ...companyNodes,
    ...graph.nodes.filter((node) => node.entityType !== "company" && visibleVoiceNodeIds.has(node.id))
  ];
  const visibleCompanyIds = new Set(companyNodes.map((node) => node.entityId));
  const visibleFounderIds = new Set(companyNodes.flatMap((node) => node.founders.map((founder) => founder.id)));
  const visibleEvidence = graph.evidence
    .filter((item) => evidenceMatchesVisibleEntities(item, visibleCompanyIds, visibleFounderIds))
    .filter((item) => selectedPlatforms.size === 0 || selectedPlatforms.has(item.platform))
    .sort((left, right) => right.contributionScore - left.contributionScore);
  const nodes = selectedPlatforms.size > 0
    ? sourceNodes.map((node) => nodeWithVisibleEvidence(node, visibleEvidence))
    : sourceNodes;
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const topEvidenceByCompany = buildTopEvidenceByCompany(companyNodes, visibleEvidence);
  const leaderboard = graph.leaderboard
    .filter((row) => visibleCompanyIds.has(row.companyId))
    .map((row) => ({
      ...row,
      biggestContribution:
        topEvidenceByCompany.get(row.companyId) ??
        (row.biggestContribution && evidenceMatchesSelectedPlatforms(row.biggestContribution, selectedPlatforms)
          ? row.biggestContribution
          : null)
    }));

  return {
    ...graph,
    nodes,
    edges: prelimEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    evidence: visibleEvidence,
    leaderboard,
    fastestGaining: graph.fastestGaining.filter((row) => visibleCompanyIds.has(row.companyId)),
    needsReview: graph.needsReview.filter((item) =>
      needsReviewItemVisible(item, visibleCompanyIds, visibleFounderIds, selectedPlatforms)
    )
  };
}

function companyIdsWithSelectedEvidence(
  graph: GraphResponse,
  selectedPlatforms: Set<Platform>,
  options: { positiveOnly: boolean }
): Set<string> {
  const founderIdToCompanyId = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.entityType !== "company") {
      continue;
    }
    for (const founder of node.founders) {
      founderIdToCompanyId.set(founder.id, node.entityId);
    }
  }

  const companyIds = new Set<string>();
  for (const item of graph.evidence) {
    if (!selectedPlatforms.has(item.platform) || (options.positiveOnly && item.contributionScore <= 0)) {
      continue;
    }
    const companyId =
      item.attachedCompanyId ??
      (item.entityType === "company" ? item.entityId : founderIdToCompanyId.get(item.entityId));
    if (companyId) {
      companyIds.add(companyId);
    }
  }
  return companyIds;
}

function nodeWithVisibleEvidence(
  node: GraphResponse["nodes"][number],
  visibleEvidence: EvidenceItem[]
): GraphResponse["nodes"][number] {
  if (node.entityType !== "company") {
    const visibleEvidenceIds = new Set(visibleEvidence.map((item) => item.id));
    return {
      ...node,
      evidenceIds: node.evidenceIds.filter((evidenceId) => visibleEvidenceIds.has(evidenceId))
    };
  }

  const companyEvidence = visibleEvidence.filter((item) => evidenceBelongsToCompany(item, node));
  return {
    ...node,
    evidenceIds: companyEvidence.map((item) => item.id),
    founders: node.founders.map((founder) => ({
      ...founder,
      evidenceIds: companyEvidence
        .filter((item) => item.entityType === "founder" && item.entityId === founder.id)
        .map((item) => item.id)
    }))
  };
}

function evidenceBelongsToCompany(
  item: EvidenceItem,
  node: GraphResponse["nodes"][number]
): boolean {
  if (item.attachedCompanyId) {
    return item.attachedCompanyId === node.entityId;
  }
  return item.entityId === node.entityId || node.founders.some((founder) => founder.id === item.entityId);
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
    topEvidenceByCompany.set(
      node.entityId,
      visibleEvidence.find(
        (item) => item.contributionScore > 0 && evidenceBelongsToCompany(item, node)
      ) ?? null
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
  if (item.attachedCompanyId) {
    return visibleCompanyIds.has(item.attachedCompanyId);
  }
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
