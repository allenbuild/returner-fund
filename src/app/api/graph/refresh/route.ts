import { NextResponse } from "next/server";
import { applyBenchmarkMomentumRows, ensureBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { EdgeType, Platform } from "@/lib/graph/types";

interface RefreshRequest {
  action?: "ingest" | "refresh";
  batchSlug?: string;
  platforms?: Platform[];
  edgeTypes?: EdgeType[];
  industries?: string[];
  groupPartners?: string[];
  minScore?: number;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as RefreshRequest;
  const action = body.action === "refresh" ? "refresh" : "ingest";
  const dataset = !body.batchSlug || body.batchSlug === "S2026" ? ycSpring2026GraphDataset : undefined;
  const filteredGraph = buildGraphResponse({
    batchSlug: body.batchSlug,
    platforms: body.platforms,
    edgeTypes: body.edgeTypes,
    industries: body.industries,
    groupPartners: body.groupPartners,
    minScore: body.minScore
  }, dataset);
  let benchmarkRows = filteredGraph.fastestGaining;
  try {
    benchmarkRows = ensureBenchmarkMomentum(buildGraphResponse({ batchSlug: body.batchSlug }, dataset)).graph.fastestGaining;
  } catch (error) {
    console.error("Graph refresh benchmark momentum failed; returning graph without persisted benchmark deltas", error);
  }
  const graph = sanitizeGraphResponse(
    applyBenchmarkMomentumRows(filteredGraph, benchmarkRows)
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
