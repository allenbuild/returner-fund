import {
  applyBenchmarkMomentumRows,
  benchmarkStoreVersion,
  ensureBenchmarkMomentum,
  inheritCanonicalCompanyScoring
} from "@/lib/graph/benchmarks";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { enrichGraphTaxonomies } from "@/lib/graph/graph-taxonomies";
import { getOrBuildCachedGraphResponse } from "@/lib/graph/graph-response-cache";
import {
  datasetWithLiveEvidence,
  liveEvidenceCacheVersion
} from "@/lib/graph/live-evidence-dataset";
import { overlayLiveEvidenceOnGraph } from "@/lib/graph/live-evidence-overlay";
import { personalizeInsiderGraphSnapshot } from "@/lib/graph/personalized-insider-snapshot";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { yc2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import { loadLiveEvidenceRecords } from "@/lib/ingestion/live-source-refresh";

/**
 * Heavy diagnostics dependencies are isolated behind a dynamic route import so
 * rejected and ordinary graph requests never evaluate the evidence corpus.
 */
export const fullGraphDependencies = {
  applyBenchmarkMomentumRows,
  benchmarkStoreVersion,
  buildGraphResponse,
  datasetWithLiveEvidence,
  enrichGraphTaxonomies,
  ensureBenchmarkMomentum,
  getOrBuildCachedGraphResponse,
  inheritCanonicalCompanyScoring,
  liveEvidenceCacheVersion,
  loadLiveEvidenceRecords,
  overlayLiveEvidenceOnGraph,
  personalizeInsiderGraphSnapshot,
  sanitizeGraphResponse,
  yc2026GraphDataset
};
