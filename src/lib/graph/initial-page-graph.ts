import { benchmarkStoreVersion, ensureBenchmarkMomentum } from "./benchmarks";
import { buildGraphResponse } from "./graph-builder";
import { sanitizeGraphResponse } from "./response-sanitizer";
import type { GraphResponse } from "./types";
import { YC_SUMMER_2026_BATCH_SLUG, yc2026GraphDataset } from "./yc-spring-2026-dataset";

const INITIAL_EVIDENCE_LIMIT = 20;
const DEFAULT_BATCH_SLUG = YC_SUMMER_2026_BATCH_SLUG;
let cachedInitialPageGraph: { cacheKey: string; graph: GraphResponse } | null = null;

export function buildInitialPageGraph(): GraphResponse {
  const now = new Date();
  const cacheKey = `${DEFAULT_BATCH_SLUG}:${localDayKey(now)}:${benchmarkStoreVersion(DEFAULT_BATCH_SLUG)}`;
  if (cachedInitialPageGraph?.cacheKey !== cacheKey) {
    const graph = sanitizeGraphResponse(buildGraphResponse({ batchSlug: DEFAULT_BATCH_SLUG }, yc2026GraphDataset));
    cachedInitialPageGraph = {
      cacheKey,
      graph: trimInitialEvidence(ensureBenchmarkMomentum(graph, { now }).graph)
    };
  }
  return cachedInitialPageGraph.graph;
}

function localDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
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
