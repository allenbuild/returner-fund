import type { EvidenceItem, GraphNode, GraphResponse } from "./types";

export function selectedNodeEvidence(graph: GraphResponse, selectedNode: GraphNode): EvidenceItem[] {
  const allowedEvidenceIds = new Set(selectedNode.evidenceIds);

  return graph.evidence
    .filter((item) => allowedEvidenceIds.has(item.id))
    .sort((a, b) => b.contributionScore - a.contributionScore);
}
