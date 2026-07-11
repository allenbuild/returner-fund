import { NextResponse } from "next/server";
import { applyBenchmarkMomentumRows, ensureBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { enrichSummerPlatformStatus } from "@/lib/graph/summer-platform-status";
import { normalizeTopVoiceAudienceId } from "@/lib/social/top-voices";
import { YC_SPRING_2026_BATCH_SLUG, yc2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { EdgeType, Platform, TopVoiceAudienceId } from "@/lib/graph/types";

interface RefreshRequest {
  action?: "ingest" | "refresh";
  batchSlug?: string;
  platforms?: Platform[];
  edgeTypes?: EdgeType[];
  industries?: string[];
  groupPartners?: string[];
  minScore?: number;
  topVoices?: TopVoiceAudienceId;
}

const DEFAULT_BATCH_SLUG = YC_SPRING_2026_BATCH_SLUG;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as RefreshRequest;
  const action = body.action === "refresh" ? "refresh" : "ingest";
  const batchSlug = body.batchSlug ?? DEFAULT_BATCH_SLUG;
  const dataset = yc2026GraphDataset;
  const filteredGraph = buildGraphResponse({
    batchSlug,
    platforms: body.platforms,
    edgeTypes: body.edgeTypes,
    industries: body.industries,
    groupPartners: body.groupPartners,
    minScore: body.minScore,
    topVoices: normalizeTopVoiceAudienceId(body.topVoices)
  }, dataset);
  let benchmarkRows = filteredGraph.fastestGaining;
  if (filteredGraph.selectedTopVoiceAudience.id === "off") {
    try {
      const benchmarkGraph = hasActiveFilters(body) ? buildGraphResponse({ batchSlug }, dataset) : filteredGraph;
      benchmarkRows = ensureBenchmarkMomentum(benchmarkGraph).graph.fastestGaining;
    } catch (error) {
      console.error("Graph refresh benchmark momentum failed; returning graph without persisted benchmark deltas", error);
    }
  }
  const graph = enrichSummerPlatformStatus(
    sanitizeGraphResponse(
      applyBenchmarkMomentumRows(filteredGraph, benchmarkRows)
    )
  );

  return NextResponse.json({
    runId: `${graph.mode}-${action}-${Date.now()}`,
    status: "completed",
    logs: [
      `${formatMode(graph.mode)} ${action} completed for ${graph.batch.slug}.`,
      "Loaded public YC companies, founders, official profile links, evidence, scores, and graph edges.",
      "No external accounts were contacted, no credentials were used, and no logged-in social automation ran."
    ],
    errors: [],
    graph
  });
}

function formatMode(mode: string): string {
  if (mode === "official_snapshot") {
    return "Official YC snapshot";
  }
  if (mode === "database") {
    return "Database";
  }
  return "Demo";
}

function hasActiveFilters(filters: RefreshRequest): boolean {
  return Boolean(
    filters.platforms?.length ||
      filters.edgeTypes?.length ||
      filters.minScore ||
      filters.industries?.length ||
      filters.groupPartners?.length ||
      (filters.topVoices && filters.topVoices !== "off")
  );
}
