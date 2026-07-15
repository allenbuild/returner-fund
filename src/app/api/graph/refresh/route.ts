import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { applyBenchmarkMomentumRows, ensureBenchmarkMomentum } from "@/lib/graph/benchmarks";
import { graphBenchmarkDatesAreFresh } from "@/lib/graph/benchmark-freshness";
import { buildGraphResponse, clearTopVoiceRollupCache } from "@/lib/graph/graph-builder";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import { clearGraphResponseCache } from "@/lib/graph/graph-response-cache";
import { datasetWithLiveEvidence, liveEvidenceVisibilityForGraph } from "@/lib/graph/live-evidence-dataset";
import { overlayLiveEvidenceOnGraph } from "@/lib/graph/live-evidence-overlay";
import { sanitizeGraphResponse } from "@/lib/graph/response-sanitizer";
import { enrichSummerPlatformStatus } from "@/lib/graph/summer-platform-status";
import { loadLiveEvidenceRecords, runLiveSourceRefresh } from "@/lib/ingestion/live-source-refresh";
import { normalizeTopVoiceAudienceId } from "@/lib/social/top-voices";
import { YC_SPRING_2026_BATCH_SLUG, yc2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { EdgeType, GraphResponse, Platform, TopVoiceAudienceId } from "@/lib/graph/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RefreshRequest {
  action?: "ingest" | "refresh";
  batchSlug?: string;
  platforms?: Platform[];
  sourceUrls?: string[];
  edgeTypes?: EdgeType[];
  industries?: string[];
  groupPartners?: string[];
  minScore?: number;
  topVoices?: TopVoiceAudienceId;
}

const DEFAULT_BATCH_SLUG = YC_SPRING_2026_BATCH_SLUG;

export async function POST(request: Request) {
  const routeStartedAt = Date.now();
  const body = (await request.json().catch(() => ({}))) as RefreshRequest;
  const action = body.action === "refresh" ? "refresh" : "ingest";
  const batchSlug = body.batchSlug ?? DEFAULT_BATCH_SLUG;
  const topVoices = normalizeTopVoiceAudienceId(body.topVoices);
  clearGraphResponseCache();
  clearTopVoiceRollupCache();
  const liveRefreshStartedAt = Date.now();
  const liveRefresh = await runLiveSourceRefresh({
    batchSlug,
    platforms: body.platforms,
    topVoices,
    xSourceUrls: body.sourceUrls,
    maxPostsPerTarget: 1,
    maxXTargets: 220
  });
  const liveRefreshElapsedMs = Date.now() - liveRefreshStartedAt;
  const liveEvidenceRecords = await loadLiveEvidenceRecords().catch((error) => {
    console.error("Graph refresh live evidence reload failed; falling back to accepted rows only", error);
    return liveRefresh.acceptedEvidence;
  });
  if (topVoices !== "off" && liveRefresh.acceptedEvidence.length === 0 && liveEvidenceRecords.length === 0) {
    const staticGraphStartedAt = Date.now();
    const staticGraph = await loadStaticTopVoiceGraph(batchSlug, topVoices);
    if (staticGraph && staticTopVoiceGraphIsFresh(staticGraph)) {
      clearGraphResponseCache();
      clearTopVoiceRollupCache();
      const filteredStaticGraph = applyClientGraphFilters(staticGraph, {
        platforms: body.platforms ?? [],
        industries: body.industries ?? [],
        groupPartners: body.groupPartners ?? [],
        minScore: body.minScore ?? 0
      });
      const graph = enrichSummerPlatformStatus(sanitizeGraphResponse(filteredStaticGraph));
      const refreshOutcome = classifyRefreshOutcome({
        acceptedCount: 0,
        visibleCount: 0,
        failureReasonCounts: liveRefresh.failureReasonCounts
      });
      const refreshSummary = {
        action,
        batchSlug,
        generatedAt: liveRefresh.generatedAt,
        status: refreshOutcome.status,
        requestedPlatforms: body.platforms ?? [],
        attemptedPlatforms: attemptedPlatformsFromStages(liveRefresh.stageLog),
        unsupportedPlatforms: unsupportedPlatformsFromStages(liveRefresh.stageLog),
        acceptedRows: 0,
        storedRows: 0,
        visibleRows: 0,
        sourceSnapshots: liveRefresh.sourceSnapshots,
        stageSummary: summarizeStages(liveRefresh.stageLog),
        newestIngestedEvidence: [],
        newestVisibleEvidence: [],
        hiddenEvidence: [],
        platformRows: liveRefresh.platformRows,
        failureReasonCounts: liveRefresh.failureReasonCounts,
        appliedFilters: {
          platforms: body.platforms ?? [],
          industries: body.industries ?? [],
          groupPartners: body.groupPartners ?? [],
          minScore: body.minScore ?? 0,
          topVoices
        },
        fastPath: "static_top_voice_noop",
        timings: {
          liveRefreshMs: liveRefreshElapsedMs,
          graphMs: Date.now() - staticGraphStartedAt,
          totalMs: Date.now() - routeStartedAt
        }
      };

      return NextResponse.json({
        runId: `${graph.mode}-${action}-${Date.now()}`,
        status: refreshOutcome.status,
        logs: [
          `${formatMode(graph.mode)} ${action} completed for ${graph.batch.slug}.`,
          "Live source refresh accepted no new top-voice rows; returned the generated public top-voice graph snapshot instead of rebuilding the expensive graph path.",
          `Stage log written to outputs/ingestion-refresh-stage-log-current.json.`
        ],
        errors: refreshOutcome.errors,
        refreshSummary,
        graph
      }, {
        headers: {
          "Cache-Control": "no-store, max-age=0"
        }
      });
    } else if (staticGraph) {
      console.warn("Static top-voice refresh snapshot is stale; rebuilding graph response", {
        batchSlug,
        topVoices,
        generatedAt: staticGraph.generatedAt
      });
    }
  }
  clearGraphResponseCache();
  clearTopVoiceRollupCache();

  const dataset = yc2026GraphDataset;
  const datasetForGraph = topVoices === "off" ? dataset : datasetWithLiveEvidence(dataset, liveEvidenceRecords);
  const filteredGraph = buildGraphResponse({
    batchSlug,
    platforms: body.platforms,
    edgeTypes: body.edgeTypes,
    industries: body.industries,
    groupPartners: body.groupPartners,
    minScore: body.minScore,
    topVoices
  }, datasetForGraph);
  let benchmarkRows = filteredGraph.fastestGaining;
  if (filteredGraph.selectedTopVoiceAudience.id === "off") {
    try {
      const benchmarkGraph = hasActiveFilters(body) ? buildGraphResponse({ batchSlug }, dataset) : filteredGraph;
      benchmarkRows = ensureBenchmarkMomentum(benchmarkGraph).graph.fastestGaining;
    } catch (error) {
      console.error("Graph refresh benchmark momentum failed; returning graph without persisted benchmark deltas", error);
    }
  }
  const graphWithBenchmarks = applyBenchmarkMomentumRows(filteredGraph, benchmarkRows);
  const overlay = topVoices === "off"
    ? overlayLiveEvidenceOnGraph(
        graphWithBenchmarks,
        liveEvidenceRecords,
        {
          selectedPlatforms: body.platforms,
          topVoices
        }
      )
    : {
        graph: graphWithBenchmarks,
        ...liveEvidenceVisibilityForGraph(graphWithBenchmarks.evidence, liveEvidenceRecords)
      };
  const graph = enrichSummerPlatformStatus(sanitizeGraphResponse(overlay.graph));
  const graphElapsedMs = Date.now() - liveRefreshStartedAt - liveRefreshElapsedMs;
  const newestIngestedEvidence = [...liveRefresh.acceptedEvidence].sort(sortLiveRecordsNewestFirst);
  const acceptedVisibleEvidence = visibleEvidenceForAcceptedRows(overlay.visibleEvidence, liveRefresh.acceptedEvidence);
  const acceptedHiddenEvidence = hiddenEvidenceForAcceptedRows(overlay.hiddenEvidence, liveRefresh.acceptedEvidence);
  const newestVisibleEvidence = [...acceptedVisibleEvidence].sort(sortEvidenceNewestFirst);
  const refreshOutcome = classifyRefreshOutcome({
    acceptedCount: liveRefresh.acceptedEvidence.length,
    visibleCount: acceptedVisibleEvidence.length,
    failureReasonCounts: liveRefresh.failureReasonCounts
  });
  const refreshSummary = {
    action,
    batchSlug,
    generatedAt: liveRefresh.generatedAt,
    status: refreshOutcome.status,
    requestedPlatforms: body.platforms ?? [],
    attemptedPlatforms: attemptedPlatformsFromStages(liveRefresh.stageLog),
    unsupportedPlatforms: unsupportedPlatformsFromStages(liveRefresh.stageLog),
    acceptedRows: liveRefresh.acceptedEvidence.length,
    storedRows: liveRefresh.storedEvidence.length,
    visibleRows: acceptedVisibleEvidence.length,
    sourceSnapshots: liveRefresh.sourceSnapshots,
    stageSummary: summarizeStages(liveRefresh.stageLog),
    newestIngestedEvidence: newestIngestedEvidence.slice(0, 8).map((item) => ({
      companyName: item.companyName,
      platform: item.platform,
      sourceUrl: item.sourceUrl,
      postedAt: item.postedAt,
      metrics: item.metrics
    })),
    newestVisibleEvidence: newestVisibleEvidence.slice(0, 8).map((item) => ({
      companyName: item.attachedCompanyName ?? item.authorName,
      platform: item.platform,
      sourceUrl: item.sourceUrl,
      postedAt: item.postedAt,
      score: item.contributionScore,
      metrics: item.metrics
    })),
    hiddenEvidence: acceptedHiddenEvidence.slice(0, 12),
    platformRows: liveRefresh.platformRows,
    failureReasonCounts: liveRefresh.failureReasonCounts,
    appliedFilters: {
      platforms: body.platforms ?? [],
      industries: body.industries ?? [],
      groupPartners: body.groupPartners ?? [],
      minScore: body.minScore ?? 0,
      topVoices
    },
    timings: {
      liveRefreshMs: liveRefreshElapsedMs,
      graphMs: graphElapsedMs,
      totalMs: Date.now() - routeStartedAt
    }
  };

  return NextResponse.json({
    runId: `${graph.mode}-${action}-${Date.now()}`,
    status: refreshOutcome.status,
    logs: [
      `${formatMode(graph.mode)} ${action} completed for ${graph.batch.slug}.`,
      "Loaded public YC companies, founders, official profile links, evidence, scores, and graph edges.",
      `Live source refresh accepted ${liveRefresh.acceptedEvidence.length} new/updated X evidence row(s) and stored ${liveRefresh.storedEvidence.length}.`,
      acceptedVisibleEvidence.length
        ? `Newest visible live evidence: ${newestVisibleEvidence[0]?.attachedCompanyName ?? newestVisibleEvidence[0]?.authorName} / ${newestVisibleEvidence[0]?.platform} / ${newestVisibleEvidence[0]?.sourceUrl}.`
        : "No live evidence was visible in the current filtered graph; see refreshSummary.hiddenEvidence for filter or batch reasons.",
      `Stage log written to outputs/ingestion-refresh-stage-log-current.json. Unsupported real-time adapters are reported with adapter_not_wired reasons.`
    ],
    errors: refreshOutcome.errors,
    refreshSummary,
    graph
  }, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
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

function staticTopVoiceGraphIsFresh(graph: GraphResponse, now = new Date()): boolean {
  if (!graph.generatedAt) {
    return false;
  }

  const generatedAt = new Date(graph.generatedAt);
  if (
    !Number.isFinite(generatedAt.getTime()) ||
    generatedAt.getTime() > now.getTime() + 5 * 60 * 1000 ||
    localDayKey(generatedAt) !== localDayKey(now)
  ) {
    return false;
  }

  const hasBenchmarkDates = graph.fastestGaining.some(
    (row) => row.dod.benchmarkedAt || row.wow.benchmarkedAt
  );
  return !hasBenchmarkDates || graphBenchmarkDatesAreFresh(graph, now);
}

function localDayKey(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
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

async function loadStaticTopVoiceGraph(
  batchSlug: string,
  topVoices: TopVoiceAudienceId
): Promise<GraphResponse | null> {
  const batchFilenames: Record<string, string> = {
    A16ZSR006: "a16zsr006",
    S2026: "s2026",
    S26: "s26"
  };
  const audienceSuffixes: Partial<Record<TopVoiceAudienceId, string>> = {
    yc_partners: "-yc-partners",
    insiders: "-insiders"
  };
  const batchFilename = batchFilenames[batchSlug];
  const suffix = audienceSuffixes[topVoices];
  if (!batchFilename || !suffix) {
    return null;
  }

  try {
    return JSON.parse(await readFile(join(process.cwd(), "public", "graph", `${batchFilename}${suffix}.json`), "utf8")) as GraphResponse;
  } catch (error) {
    console.error("Static top-voice refresh fast path could not read generated graph snapshot", error);
    return null;
  }
}

function summarizeStages(stageLog: Array<{ stage: string; platform: string }>): Record<string, number> {
  return stageLog.reduce<Record<string, number>>((counts, entry) => {
    const key = `${entry.platform}:${entry.stage}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function attemptedPlatformsFromStages(stageLog: Array<{ stage: string; platform: string }>): Platform[] {
  return uniquePlatforms(
    stageLog
      .filter((entry) => entry.platform !== "all")
      .filter((entry) => entry.stage !== "skipped")
      .map((entry) => entry.platform)
  );
}

function unsupportedPlatformsFromStages(stageLog: Array<{ reason?: string; platform: string }>): Platform[] {
  return uniquePlatforms(
    stageLog
      .filter((entry) => entry.platform !== "all" && entry.reason === "adapter_not_wired")
      .map((entry) => entry.platform)
  );
}

function uniquePlatforms(platforms: string[]): Platform[] {
  const allowed = new Set<Platform>([
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
  ]);
  return [...new Set(platforms)].filter((platform): platform is Platform => allowed.has(platform as Platform));
}

function visibleEvidenceForAcceptedRows<T extends { entityId: string; platform: Platform; platformPostId?: string | null; sourceUrl: string }>(
  visibleEvidence: T[],
  acceptedRows: Array<{ entityId: string; platform: Platform; platformPostId?: string | null; sourceUrl: string }>
): T[] {
  const acceptedKeys = new Set(acceptedRows.map(evidenceKey));
  return visibleEvidence.filter((item) => acceptedKeys.has(evidenceKey(item)));
}

function hiddenEvidenceForAcceptedRows<T extends { sourceUrl: string; companyName: string; platform: Platform }>(
  hiddenEvidence: T[],
  acceptedRows: Array<{ sourceUrl: string; companyName: string; platform: Platform }>
): T[] {
  const acceptedKeys = new Set(acceptedRows.map(hiddenEvidenceKey));
  return hiddenEvidence.filter((item) => acceptedKeys.has(hiddenEvidenceKey(item)));
}

function evidenceKey(item: { entityId: string; platform: Platform; platformPostId?: string | null; sourceUrl: string }): string {
  return `${item.entityId}:${item.platform}:${item.platformPostId ?? item.sourceUrl}`;
}

function hiddenEvidenceKey(item: { sourceUrl: string; companyName: string; platform: Platform }): string {
  return `${item.companyName}:${item.platform}:${item.sourceUrl}`;
}

type RefreshOutcomeStatus = "completed" | "partial" | "failed";

function classifyRefreshOutcome(input: {
  acceptedCount: number;
  visibleCount: number;
  failureReasonCounts: Record<string, number>;
}): { status: RefreshOutcomeStatus; errors: string[] } {
  const reasonEntries = Object.entries(input.failureReasonCounts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  const unsupportedAdapterCount = input.failureReasonCounts.adapter_not_wired ?? 0;

  if (input.acceptedCount > 0 && input.visibleCount > 0 && unsupportedAdapterCount === 0) {
    return { status: "completed", errors: [] };
  }

  if (input.acceptedCount > 0 && input.visibleCount > 0) {
    return {
      status: "partial",
      errors: [
        `Live refresh surfaced ${input.visibleCount} row(s), but ${unsupportedAdapterCount} requested adapter stage(s) were not wired.`
      ]
    };
  }

  if (input.acceptedCount > 0) {
    return {
      status: "partial",
      errors: [
        `Live refresh accepted ${input.acceptedCount} row(s), but none were visible after the active batch/filter/top-voice graph was rebuilt.`
      ]
    };
  }

  if (reasonEntries.length) {
    const topReasons = reasonEntries.slice(0, 4).map(([reason, count]) => `${reason}:${count}`).join(", ");
    return {
      status: "failed",
      errors: [`Live refresh finished without accepted evidence. Top reasons: ${topReasons}.`]
    };
  }

  return {
    status: "failed",
    errors: ["Live refresh finished without accepted evidence and did not report a provider reason."]
  };
}

function sortLiveRecordsNewestFirst(left: { postedAt: string | null; last_checked_at: string }, right: { postedAt: string | null; last_checked_at: string }) {
  return Date.parse(right.postedAt ?? right.last_checked_at) - Date.parse(left.postedAt ?? left.last_checked_at);
}

function sortEvidenceNewestFirst(left: { postedAt: string; last_checked_at?: string }, right: { postedAt: string; last_checked_at?: string }) {
  return Date.parse(right.postedAt ?? right.last_checked_at ?? "") - Date.parse(left.postedAt ?? left.last_checked_at ?? "");
}
