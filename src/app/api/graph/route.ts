import { NextResponse } from "next/server";
import { applyBenchmarkMomentumRows, ensureBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { BusinessModel, EdgeType, Platform } from "@/lib/graph/types";

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

const edgeTypes: EdgeType[] = ["founder_of", "industry_similarity", "same_group_partner"];
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

const graphResponseCache = new Map<string, { createdAt: number; graph: ReturnType<typeof buildGraphResponse> }>();
const GRAPH_RESPONSE_CACHE_LIMIT = 64;
const GRAPH_RESPONSE_CACHE_TTL_MS = 60_000;

export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const batchSlug = params.get("batch") ?? undefined;
  const dataset = batchSlug === undefined || batchSlug === "S2026" ? ycSpring2026GraphDataset : undefined;
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
    query: params.get("q") ?? undefined
  };
  const cacheKey = JSON.stringify({
    filters,
    includeRaw,
    includeNonScoring,
    includeWhy,
    dataset: dataset ? "yc-s2026" : "demo"
  });
  const cached = graphResponseCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < GRAPH_RESPONSE_CACHE_TTL_MS) {
    return NextResponse.json(cached.graph);
  }

  const filteredGraph = buildGraphResponse(filters, dataset);
  let benchmarkRows = filteredGraph.fastestGaining;
  try {
    benchmarkRows = ensureBenchmarkMomentum(buildGraphResponse({ batchSlug }, dataset)).graph.fastestGaining;
  } catch (error) {
    console.error("Graph benchmark momentum failed; returning graph without persisted benchmark deltas", error);
  }
  const graph = sanitizeGraphResponse(applyBenchmarkMomentumRows(filteredGraph, benchmarkRows), {
    includeRaw,
    includeNonScoring,
    includeWhy
  });
  graphResponseCache.set(cacheKey, { createdAt: Date.now(), graph });
  if (graphResponseCache.size > GRAPH_RESPONSE_CACHE_LIMIT) {
    const oldestKey = graphResponseCache.keys().next().value;
    if (oldestKey) {
      graphResponseCache.delete(oldestKey);
    }
  }

  return NextResponse.json(graph);
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
