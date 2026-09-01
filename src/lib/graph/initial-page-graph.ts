import { applyBenchmarkMomentumRows, benchmarkStoreVersion, ensureBenchmarkMomentum } from "./benchmarks";
import { buildGraphResponse } from "./graph-builder";
import { initialSelectedNodeId } from "./initial-selection";
import { sanitizeGraphResponse } from "./response-sanitizer";
import type { GraphFilters, GraphResponse } from "./types";
import { YC_SPRING_2026_BATCH_SLUG, yc2026GraphDataset } from "./yc-spring-2026-dataset";

const INITIAL_EVIDENCE_LIMIT = 20;
const DEFAULT_BATCH_SLUG = YC_SPRING_2026_BATCH_SLUG;
let cachedInitialPageGraph: { cacheKey: string; graph: GraphResponse } | null = null;

export function buildInitialPageGraph(filters: GraphFilters = {}): GraphResponse {
  const now = new Date();
  const batchSlug = filters.batchSlug ?? DEFAULT_BATCH_SLUG;
  const cacheKey = JSON.stringify({
    batchSlug,
    platforms: filters.platforms ?? [],
    topVoices: filters.topVoices,
    day: localDayKey(now),
    benchmarkStore: benchmarkStoreVersion(batchSlug)
  });
  if (cachedInitialPageGraph?.cacheKey !== cacheKey) {
    const graph = sanitizeGraphResponse(buildGraphResponse({ ...filters, batchSlug }, yc2026GraphDataset));
    // The default first-paint request is already the canonical batch graph.
    // Reuse it instead of performing the full evidence attribution/scoring pass
    // a second time. Filtered requests still need the unfiltered canonical graph
    // so their momentum rows retain whole-batch ranks.
    const benchmarkGraph = hasOnlyBatchFilter(filters)
      ? graph
      : sanitizeGraphResponse(buildGraphResponse({ batchSlug }, yc2026GraphDataset));
    const benchmarkRows =
      (filters.topVoices ?? "off") === "off"
        ? ensureBenchmarkMomentum(benchmarkGraph, { now }).graph.fastestGaining
        : graph.fastestGaining;
    cachedInitialPageGraph = {
      cacheKey,
      graph: trimInitialEvidence(applyBenchmarkMomentumRows(graph, benchmarkRows))
    };
  }
  return cachedInitialPageGraph.graph;
}

function hasOnlyBatchFilter(filters: GraphFilters): boolean {
  return Object.keys(filters).every((key) => key === "batchSlug");
}

function localDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function trimInitialEvidence(graph: GraphResponse): GraphResponse {
  // Filtered first loads can keep companies that merely have a mapped account for
  // the requested platform. Prefer the highest-ranked company with an actual
  // matching evidence row so the initial evidence projection is not empty while
  // other visible companies do have evidence.
  const selectedNodeId = initialSelectedNodeId(graph);
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
      socialAccounts: node.entityType === "company" || node.entityType === "founder" ? node.socialAccounts : [],
      evidenceIds: node.id === selectedNodeId ? node.evidenceIds.filter((id) => availableEvidenceIds.has(id)) : [],
      founders: node.founders.map((founder) => ({
        ...founder,
        socialAccounts: founder.socialAccounts,
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
