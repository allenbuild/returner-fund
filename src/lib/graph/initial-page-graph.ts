import { buildGraphResponse } from "./graph-builder";
import { sanitizeGraphResponse } from "./response-sanitizer";
import type { GraphResponse } from "./types";
import { ycSpring2026GraphDataset } from "./yc-spring-2026-dataset";

const INITIAL_EVIDENCE_LIMIT = 20;
let cachedInitialPageGraph: GraphResponse | null = null;

export function buildInitialPageGraph(): GraphResponse {
  cachedInitialPageGraph ??= trimInitialEvidence(
    sanitizeGraphResponse(buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset))
  );
  return cachedInitialPageGraph;
}

function trimInitialEvidence(graph: GraphResponse): GraphResponse {
  const selectedCompanyId = graph.leaderboard[0]?.companyId;
  const selectedNodeId = selectedCompanyId ? `company:${selectedCompanyId}` : graph.nodes[0]?.id;
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const selectedEvidenceIds = new Set(selectedNode?.evidenceIds ?? []);
  const evidence = graph.evidence
    .filter((item) => selectedEvidenceIds.has(item.id))
    .slice(0, INITIAL_EVIDENCE_LIMIT);
  const availableEvidenceIds = new Set(evidence.map((item) => item.id));

  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      scoreBreakdown: node.id === selectedNodeId ? node.scoreBreakdown : undefined,
      socialAccounts: node.id === selectedNodeId ? node.socialAccounts : [],
      evidenceIds: node.id === selectedNodeId ? node.evidenceIds.filter((id) => availableEvidenceIds.has(id)) : [],
      founders: node.founders.map((founder) => ({
        ...founder,
        socialAccounts: node.id === selectedNodeId ? founder.socialAccounts : [],
        evidenceIds: node.id === selectedNodeId
          ? founder.evidenceIds.filter((id) => availableEvidenceIds.has(id))
          : [],
        platformScores: node.id === selectedNodeId ? founder.platformScores : {}
      }))
    })),
    edges: graph.edges.map((edge) => ({ ...edge, explanation: "" })),
    needsReview: [],
    evidence
  };
}
