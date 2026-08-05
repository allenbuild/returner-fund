import type { CompanyVertical } from "./company-verticals";
import type { PostTopic } from "./post-topics";
import { graphNodeMatchesSearchQuery } from "./search";
import type {
  BusinessModel,
  EdgeType,
  EvidenceItem,
  GraphNode,
  GraphResponse,
  NeedsReviewItem,
  Platform
} from "./types";

export interface ClientGraphFilters {
  platforms: Platform[];
  topics?: PostTopic[];
  verticals?: CompanyVertical[];
  industries: string[];
  groupPartners: string[];
  minScore: number;
  businessModels?: BusinessModel[];
  edgeTypes?: EdgeType[];
  query?: string;
}

export function applyClientGraphFilters(graph: GraphResponse, filters: ClientGraphFilters): GraphResponse {
  const selectedPlatforms = new Set(filters.platforms);
  const selectedTopics = new Set(filters.topics ?? []);
  const selectedVerticals = new Set(filters.verticals ?? []);
  const selectedIndustries = new Set(filters.industries);
  const selectedGroupPartners = new Set(filters.groupPartners);
  const selectedBusinessModels = new Set(filters.businessModels ?? []);
  const selectedEdgeTypes = new Set(filters.edgeTypes ?? []);
  const query = filters.query?.trim() ?? "";
  const topVoiceMode = graph.selectedTopVoiceAudience.id !== "off";
  const evidenceFiltersActive = selectedPlatforms.size > 0 || selectedTopics.size > 0;
  const selectedEvidenceCompanyIds = evidenceFiltersActive
    ? companyIdsWithSelectedEvidence(graph, selectedPlatforms, selectedTopics, {
        positiveOnly: topVoiceMode,
        topVoiceAudience: topVoiceMode ? graph.selectedTopVoiceAudience.id : null
      })
    : null;
  const baseCompanyNodes = graph.nodes.filter((node) => node.entityType === "company");
  const companyNodes = baseCompanyNodes.filter((node) => {
    if (node.score < filters.minScore) return false;
    if (selectedIndustries.size > 0 && !selectedIndustries.has(node.primaryIndustry)) return false;
    if (selectedVerticals.size > 0 && !(node.verticals ?? []).some((vertical) => selectedVerticals.has(vertical))) {
      return false;
    }
    if (selectedGroupPartners.size > 0 && (!node.groupPartner || !selectedGroupPartners.has(node.groupPartner))) {
      return false;
    }
    if (selectedBusinessModels.size > 0 && !selectedBusinessModels.has(node.businessModel)) return false;
    if (query && !graphNodeMatchesSearchQuery(node, query)) return false;
    if (selectedEvidenceCompanyIds && !selectedEvidenceCompanyIds.has(node.entityId)) return false;
    return true;
  });

  const visibleCompanyNodeIds = new Set(companyNodes.map((node) => node.id));
  const visibleAssociatedNodeIds = new Set<string>();
  const prelimEdges = graph.edges.filter((edge) => {
    if (selectedEdgeTypes.size > 0 && !selectedEdgeTypes.has(edge.edgeType)) return false;
    if (edge.edgeType === "top_voice_attention" || edge.edgeType === "founder_of") {
      if (visibleCompanyNodeIds.has(edge.source)) {
        visibleAssociatedNodeIds.add(edge.target);
        return true;
      }
      if (visibleCompanyNodeIds.has(edge.target)) {
        visibleAssociatedNodeIds.add(edge.source);
        return true;
      }
      return false;
    }
    return visibleCompanyNodeIds.has(edge.source) && visibleCompanyNodeIds.has(edge.target);
  });
  const sourceNodes = [
    ...companyNodes,
    ...graph.nodes.filter((node) => node.entityType !== "company" && visibleAssociatedNodeIds.has(node.id))
  ];
  const visibleCompanyIds = new Set(companyNodes.map((node) => node.entityId));
  const visibleFounderIds = new Set(companyNodes.flatMap((node) => node.founders.map((founder) => founder.id)));
  const visibleEvidence = graph.evidence
    .filter((item) => evidenceMatchesVisibleEntities(item, visibleCompanyIds, visibleFounderIds))
    .filter((item) => evidenceMatchesFilters(
      item,
      selectedPlatforms,
      selectedTopics,
      topVoiceMode ? graph.selectedTopVoiceAudience.id : null
    ))
    .sort(compareVisibleEvidence);
  const nodes = evidenceFiltersActive
    ? sourceNodes.map((node) => nodeWithVisibleEvidence(node, visibleEvidence))
    : sourceNodes;
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const topEvidenceByCompany = evidenceFiltersActive
    ? buildTopEvidenceByCompany(companyNodes, visibleEvidence)
    : null;
  const leaderboard = graph.leaderboard
    .filter((row) => visibleCompanyIds.has(row.companyId))
    .map((row) => evidenceFiltersActive
      ? {
          ...row,
          biggestContribution: topEvidenceByCompany?.get(row.companyId) ?? null
        }
      : row);

  return {
    ...graph,
    nodes,
    edges: prelimEdges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    evidence: visibleEvidence,
    leaderboard,
    fastestGaining: graph.fastestGaining.filter((row) => visibleCompanyIds.has(row.companyId)),
    needsReview: graph.needsReview.filter((item) =>
      needsReviewItemVisible(item, visibleCompanyIds, visibleFounderIds, selectedPlatforms, selectedTopics)
    )
  };
}

function companyIdsWithSelectedEvidence(
  graph: GraphResponse,
  selectedPlatforms: Set<Platform>,
  selectedTopics: Set<PostTopic>,
  options: { positiveOnly: boolean; topVoiceAudience: GraphResponse["selectedTopVoiceAudience"]["id"] | null }
): Set<string> {
  const founderIdToCompanyId = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.entityType !== "company") continue;
    for (const founder of node.founders) founderIdToCompanyId.set(founder.id, node.entityId);
  }

  const companyIds = new Set<string>();
  for (const item of graph.evidence) {
    if (!evidenceMatchesFilters(item, selectedPlatforms, selectedTopics, options.topVoiceAudience)) continue;
    if (options.positiveOnly && item.contributionScore <= 0) continue;
    const companyId = item.attachedCompanyId ??
      (item.entityType === "company" ? item.entityId : founderIdToCompanyId.get(item.entityId));
    if (companyId) companyIds.add(companyId);
  }

  // The public graph intentionally caps materialized evidence rows. Topic
  // facet rows keep omitted volume evidence usable for company visibility and
  // filter composition without shipping the full post payload to the client.
  for (const row of graph.topicFacetRows ?? []) {
    if (options.topVoiceAudience && row.audienceId !== options.topVoiceAudience) continue;
    if (options.positiveOnly && row.contributionScore <= 0) continue;
    if (selectedPlatforms.size > 0 && !selectedPlatforms.has(row.platform)) continue;
    if (selectedTopics.size > 0 && !selectedTopics.has(row.topic)) continue;
    companyIds.add(row.companyId);
  }
  return companyIds;
}

function evidenceMatchesFilters(
  item: EvidenceItem,
  selectedPlatforms: Set<Platform>,
  selectedTopics: Set<PostTopic>,
  topVoiceAudience: GraphResponse["selectedTopVoiceAudience"]["id"] | null = null
): boolean {
  return (
    (selectedPlatforms.size === 0 || selectedPlatforms.has(item.platform)) &&
    (selectedTopics.size === 0 || (item.topics ?? []).some((topic) => selectedTopics.has(topic))) &&
    (!topVoiceAudience || item.topVoice?.audienceId === topVoiceAudience)
  );
}

function nodeWithVisibleEvidence(node: GraphNode, visibleEvidence: EvidenceItem[]): GraphNode {
  if (node.entityType !== "company") {
    const visibleEvidenceIds = new Set(visibleEvidence.map((item) => item.id));
    return { ...node, evidenceIds: node.evidenceIds.filter((evidenceId) => visibleEvidenceIds.has(evidenceId)) };
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

function evidenceBelongsToCompany(item: EvidenceItem, node: GraphNode): boolean {
  if (item.attachedCompanyId) return item.attachedCompanyId === node.entityId;
  return item.entityId === node.entityId || node.founders.some((founder) => founder.id === item.entityId);
}

function buildTopEvidenceByCompany(
  nodes: GraphNode[],
  visibleEvidence: EvidenceItem[]
): Map<string, EvidenceItem | null> {
  return new Map(nodes.map((node) => [
    node.entityId,
    visibleEvidence.find((item) => item.contributionScore > 0 && evidenceBelongsToCompany(item, node)) ?? null
  ]));
}

function evidenceMatchesVisibleEntities(
  item: EvidenceItem,
  visibleCompanyIds: Set<string>,
  visibleFounderIds: Set<string>
): boolean {
  if (item.attachedCompanyId) return visibleCompanyIds.has(item.attachedCompanyId);
  return item.entityType === "company" ? visibleCompanyIds.has(item.entityId) : visibleFounderIds.has(item.entityId);
}

function needsReviewItemVisible(
  item: NeedsReviewItem,
  visibleCompanyIds: Set<string>,
  visibleFounderIds: Set<string>,
  selectedPlatforms: Set<Platform>,
  selectedTopics: Set<PostTopic>
): boolean {
  if (selectedTopics.size > 0) return false;
  if (selectedPlatforms.size > 0 && !selectedPlatforms.has(item.platform)) return false;
  return item.entityType === "company" ? visibleCompanyIds.has(item.entityId) : visibleFounderIds.has(item.entityId);
}

function compareVisibleEvidence(left: EvidenceItem, right: EvidenceItem): number {
  return right.contributionScore - left.contributionScore || left.id.localeCompare(right.id);
}
