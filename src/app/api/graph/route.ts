import { NextResponse } from "next/server";
import { applyBenchmarkMomentumRows, benchmarkStoreVersion, ensureBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { getCachedGraphResponse, setCachedGraphResponse } from "@/lib/graph/graph-response-cache";
import { datasetWithLiveEvidence, liveEvidenceCacheVersion } from "@/lib/graph/live-evidence-dataset";
import { overlayLiveEvidenceOnGraph } from "@/lib/graph/live-evidence-overlay";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { enrichSummerPlatformStatus } from "@/lib/graph/summer-platform-status";
import { loadLiveEvidenceRecords } from "@/lib/ingestion/live-source-refresh";
import { normalizeTopVoiceAudienceId } from "@/lib/social/top-voices";
import { YC_SPRING_2026_BATCH_SLUG, yc2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { BusinessModel, EdgeType, Platform } from "@/lib/graph/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const platforms: Platform[] = [
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili"
];

const edgeTypes: EdgeType[] = ["founder_of", "industry_similarity", "same_group_partner", "top_voice_attention"];
const businessModels: BusinessModel[] = [
  "b2b",
  "consumer",
  "fintech",
  "healthcare",
  "industrial",
  "developer_tools",
  "api",
  "hardware",
  "open_source",
  "services",
  "marketplace"
];

const GRAPH_RESPONSE_CACHE_TTL_MS = 60_000;
const DEFAULT_BATCH_SLUG = YC_SPRING_2026_BATCH_SLUG;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const batchSlug = params.get("batch") ?? DEFAULT_BATCH_SLUG;
  const dataset = yc2026GraphDataset;
  const includeRaw = params.get("includeRaw") === "1" || params.get("includeRaw") === "true";
  const includeNonScoring =
    params.get("includeNonScoring") === "1" || params.get("includeNonScoring") === "true";
  const includeWhy = params.get("includeWhy") === "1" || params.get("includeWhy") === "true";
  const filters = {
    batchSlug,
    platforms: parseList(params.get("platforms"), platforms),
    edgeTypes: parseList(params.get("edgeTypes"), edgeTypes),
    minScore: parseNumber(params.get("minScore")),
    industries: parseLooseList(params.get("industries")),
    groupPartners: parseLooseList(params.get("groupPartners")),
    businessModels: parseList(params.get("businessModels"), businessModels),
    query: params.get("q") ?? undefined,
    topVoices: normalizeTopVoiceAudienceId(params.get("topVoices"))
  };
  const liveEvidence = await loadLiveEvidenceRecords().catch((error) => {
    console.error("Graph live evidence overlay load failed", error);
    return [];
  });
  const cacheKey = JSON.stringify({
    filters,
    includeRaw,
    includeNonScoring,
    includeWhy,
    dataset: "yc-2026-official",
    benchmarkLocalDay: localDayKey(new Date()),
    benchmarkStore: filters.topVoices === "off" ? benchmarkStoreVersion(batchSlug) : "top-voice-native-2026-07-14",
    liveEvidence: liveEvidenceCacheVersion(liveEvidence)
  });
  const cached = getCachedGraphResponse(cacheKey, GRAPH_RESPONSE_CACHE_TTL_MS);

  if (cached) {
    return noStoreJson(cached);
  }

  const datasetForGraph = filters.topVoices === "off" ? dataset : datasetWithLiveEvidence(dataset, liveEvidence);
  const filteredGraph = buildGraphResponse(filters, datasetForGraph);
  let benchmarkRows = filteredGraph.fastestGaining;
  if (filters.topVoices === "off") {
    try {
      const benchmarkGraph = hasActiveFilters(filters) ? buildGraphResponse({ batchSlug }, dataset) : filteredGraph;
      benchmarkRows = ensureBenchmarkMomentum(benchmarkGraph).graph.fastestGaining;
    } catch (error) {
      console.error("Graph benchmark momentum failed; returning graph without persisted benchmark deltas", error);
    }
  }
  const overlay = filters.topVoices === "off"
    ? overlayLiveEvidenceOnGraph(applyBenchmarkMomentumRows(filteredGraph, benchmarkRows), liveEvidence, {
        selectedPlatforms: filters.platforms,
        topVoices: filters.topVoices
      })
    : {
        graph: applyBenchmarkMomentumRows(filteredGraph, benchmarkRows),
        visibleEvidence: [],
        hiddenEvidence: []
      };
  const graph = enrichSummerPlatformStatus(
    sanitizeGraphResponse(overlay.graph, {
      includeRaw,
      includeNonScoring,
      includeWhy
    })
  );
  setCachedGraphResponse(cacheKey, graph);

  return noStoreJson(graph);
}

function noStoreJson(body: unknown) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

function parseList<T extends string>(value: string | null, allowed: T[]): T[] | undefined {
  if (!value) {
    return undefined;
  }

  const allowedSet = new Set(allowed);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is T => allowedSet.has(item as T));
}

function parseNumber(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseLooseList(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function localDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function hasActiveFilters(filters: {
  platforms?: unknown[];
  edgeTypes?: unknown[];
  minScore?: number;
  industries?: unknown[];
  groupPartners?: unknown[];
  businessModels?: unknown[];
  query?: string;
}): boolean {
  return Boolean(
    filters.platforms?.length ||
      filters.edgeTypes?.length ||
      filters.minScore ||
      filters.industries?.length ||
      filters.groupPartners?.length ||
      filters.businessModels?.length ||
      filters.query?.trim()
  );
}
