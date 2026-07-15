"use client";

import {
  Check,
  ChevronDown,
  Filter,
  Palette,
  RefreshCw,
  Search,
  Users
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CytoscapeGraph } from "./CytoscapeGraph";
import { InsightsTabs } from "./InsightsTabs";
import { NodePanel } from "./NodePanel";
import { formatPlatform, PlatformLogo } from "./PlatformLogo";
import { graphBenchmarkDatesAreFresh } from "@/lib/graph/benchmark-freshness";
import { applyClientGraphFilters, type ClientGraphFilters } from "@/lib/graph/client-filters";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { searchGraphNodes, type GraphSearchResult } from "@/lib/graph/search";
import { normalizeTopVoiceAudienceId, topVoiceAudienceSummaries } from "@/lib/social/top-voices";
import type { GraphResponse, Platform, TopVoiceAudienceId } from "@/lib/graph/types";

type FilterMenuId = "platform" | "industry" | "groupPartner" | "topVoices";

interface DropdownOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  color?: string;
  platform?: Platform;
}

const platformOptions: Platform[] = [
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

const defaultBatches = [
  { slug: "S2026", label: "YC Spring 2026 (P26)", companyCountExpected: 197, companyCountObserved: 197 },
  { slug: "S26", label: "YC Summer 2026 (S26)", companyCountExpected: 83, companyCountObserved: 83 },
  { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
];
const DEFAULT_BATCH_SLUG = "S2026";
const A16Z_SPEEDRUN_BATCH_SLUG = "A16ZSR006";
const STATIC_GRAPH_SNAPSHOT_VERSION = "2026-07-14-taro-insider-evidence";
const MIDNIGHT_REFRESH_DELAY_MS = 90_000;
const STATIC_GRAPH_TIMEOUT_MS = 8_000;
const API_GRAPH_TIMEOUT_MS = 20_000;
const REFRESH_TIMEOUT_MS = 45_000;
const REFRESH_RECOVERY_POLL_DELAYS_MS = [1_500, 5_000, 10_000, 20_000, 40_000, 60_000];
const DEFAULT_TOP_VOICE_AUDIENCE: TopVoiceAudienceId = "off";
const defaultTopVoiceAudiences = topVoiceAudienceSummaries();

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchGraphPayload(
  url: string,
  attempts = 3,
  options: { cache?: RequestCache; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<GraphResponse> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        { cache: options.cache ?? "no-store" },
        options.timeoutMs ?? API_GRAPH_TIMEOUT_MS,
        options.signal
      );
      if (!response.ok) {
        throw new Error(`Graph request failed with ${response.status}`);
      }
      return (await response.json()) as GraphResponse;
    } catch (caught) {
      if (isAbortError(caught) || options.signal?.aborted) {
        throw caught;
      }
      lastError = caught instanceof Error ? caught : new Error("Graph request failed");
      if (attempt < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 220 * attempt));
      }
    }
  }

  throw lastError ?? new Error("Graph request failed");
}

async function fetchGraphPayloadWithFreshStaticSnapshot(
  staticSnapshotUrl: string | null,
  apiUrl: string,
  attempts = 3,
  options: { signal?: AbortSignal } = {}
): Promise<GraphPayloadResult> {
  if (staticSnapshotUrl) {
    try {
      const staticPayload = await fetchGraphPayload(staticSnapshotUrl, 2, {
        cache: "no-store",
        timeoutMs: STATIC_GRAPH_TIMEOUT_MS,
        signal: options.signal
      });
      if (graphBenchmarkDatesAreFresh(staticPayload)) {
        return { graph: staticPayload, source: "static" };
      }
    } catch (caught) {
      if (isAbortError(caught) || options.signal?.aborted) {
        throw caught;
      }
    }
  }

  return {
    graph: await fetchGraphPayload(apiUrl, attempts, { cache: "no-store", timeoutMs: API_GRAPH_TIMEOUT_MS, signal: options.signal }),
    source: "api"
  };
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (caught) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw caught;
  } finally {
    window.clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", abort);
  }
}

interface DashboardProps {
  initialGraph?: GraphResponse;
  initialBatchSlug?: string;
  initialTopVoiceAudience?: TopVoiceAudienceId;
  initialFilters?: Partial<ClientGraphFilters>;
}

type GraphPayloadSource = "static" | "api";

interface GraphPayloadResult {
  graph: GraphResponse;
  source: GraphPayloadSource;
}

interface CachedGraphEntry {
  graph: GraphResponse;
  source: GraphPayloadSource;
  cachedAt: number;
}

type RefreshStatus = "completed" | "partial" | "failed";

interface RefreshSummary {
  status?: RefreshStatus;
  acceptedRows?: number;
  visibleRows?: number;
  unsupportedPlatforms?: Platform[];
  newestVisibleEvidence?: Array<{
    companyName?: string;
    platform?: Platform;
    sourceUrl?: string;
  }>;
  hiddenEvidence?: Array<{
    companyName?: string;
    platform?: Platform;
    sourceUrl?: string;
    reason?: string;
  }>;
  failureReasonCounts?: Record<string, number>;
}

interface RefreshResponse {
  graph: GraphResponse;
  status?: RefreshStatus;
  errors?: string[];
  refreshSummary?: RefreshSummary;
}

function initialSelectedNodeId(graph: GraphResponse | undefined): string | null {
  const topCompanyId = graph?.leaderboard[0]?.companyId;
  return topCompanyId ? `company:${topCompanyId}` : graph?.nodes[0]?.id ?? null;
}

function initialBatchSlug(graph: GraphResponse | undefined, batchSlug: string | undefined): string {
  const propBatchSlug = normalizeBatchSlug(batchSlug);
  if (propBatchSlug) {
    return propBatchSlug;
  }
  return graph?.batch.slug ?? DEFAULT_BATCH_SLUG;
}

function initialTopVoiceAudience(
  graph: GraphResponse | undefined,
  initialAudience: TopVoiceAudienceId | undefined
): TopVoiceAudienceId {
  if (initialAudience) {
    return initialAudience;
  }
  return graph?.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE;
}

function graphCacheKey(batchSlug: string, topVoiceAudience: TopVoiceAudienceId): string {
  return `${batchSlug}::${topVoiceAudience}`;
}

function graphMatchesSelection(
  graph: GraphResponse | null | undefined,
  batchSlug: string,
  topVoiceAudience: TopVoiceAudienceId
): graph is GraphResponse {
  return graph?.batch.slug === batchSlug && (graph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE) === topVoiceAudience;
}

function normalizeInitialPlatforms(platforms: Platform[] | undefined): Platform[] {
  if (!platforms?.length) {
    return [];
  }

  const allowed = new Set(platformOptions);
  return [...new Set(platforms.filter((platform) => allowed.has(platform)))];
}

function initialSelectedPlatforms(initialFilters: Partial<ClientGraphFilters> | undefined): Platform[] {
  return normalizeInitialPlatforms(initialFilters?.platforms);
}

function normalizeBatchSlug(value: string | null | undefined): string | null {
  const slug = String(value ?? "").trim();
  return defaultBatches.some((batch) => batch.slug === slug) ? slug : null;
}

function staticGraphSnapshotUrl(batchSlug: string, topVoiceAudience: TopVoiceAudienceId): string | null {
  const filenames: Record<string, string> = {
    A16ZSR006: "a16zsr006",
    S2026: "s2026",
    S26: "s26"
  };
  const audienceSuffixes: Record<TopVoiceAudienceId, string> = {
    off: "",
    yc_partners: "-yc-partners",
    insiders: "-insiders"
  };
  const filename = filenames[batchSlug];
  return filename ? `/graph/${filename}${audienceSuffixes[topVoiceAudience]}.json?v=${STATIC_GRAPH_SNAPSHOT_VERSION}-${localDayKey(new Date())}` : null;
}

function hasClientGraphFilters(filters: ClientGraphFilters): boolean {
  return Boolean(
    filters.platforms.length ||
      filters.industries.length ||
      filters.groupPartners.length ||
      filters.minScore > 0
  );
}

function refreshNoticeFor(action: "ingest" | "refresh", payload: RefreshResponse): string | null {
  const status = payload.status ?? payload.refreshSummary?.status;
  const summary = payload.refreshSummary;
  if (!summary) {
    return status && status !== "completed" ? payload.errors?.[0] ?? `${titleCase(action)} did not complete cleanly.` : null;
  }

  const acceptedRows = summary.acceptedRows ?? 0;
  const visibleRows = summary.visibleRows ?? 0;
  const unsupportedPlatforms = summary.unsupportedPlatforms ?? [];
  if (status === "failed") {
    return payload.errors?.[0] ?? `${titleCase(action)} finished without accepted live evidence.`;
  }
  if (status === "partial") {
    return payload.errors?.[0] ?? `Partial ${action}: surfaced ${visibleRows} of ${acceptedRows} accepted live row(s).`;
  }
  if (visibleRows > 0) {
    const newest = summary.newestVisibleEvidence?.[0];
    const source = newest?.companyName && newest?.platform ? ` Latest: ${newest.companyName} on ${formatPlatform(newest.platform)}.` : "";
    return `${titleCase(action)} surfaced ${visibleRows} live row(s).${source}`;
  }
  if (unsupportedPlatforms.length) {
    return `${titleCase(action)} completed, but ${unsupportedPlatforms.map(formatPlatform).join(", ")} still use snapshot data.`;
  }
  return acceptedRows > 0
    ? `${titleCase(action)} accepted ${acceptedRows} row(s), but active filters hid them.`
    : null;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function localDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function millisecondsUntilNextLocalMidnight(now = new Date()): number {
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, MIDNIGHT_REFRESH_DELAY_MS);
  return Math.max(1_000, nextMidnight.getTime() - now.getTime());
}

export function Dashboard({
  initialGraph,
  initialBatchSlug: initialBatchSlugProp,
  initialTopVoiceAudience: initialTopVoiceAudienceProp,
  initialFilters
}: DashboardProps = {}) {
  const [batchSlug, setBatchSlug] = useState(() => initialBatchSlug(initialGraph, initialBatchSlugProp));
  const [topVoiceAudience, setTopVoiceAudience] = useState<TopVoiceAudienceId>(() =>
    initialTopVoiceAudience(initialGraph, initialTopVoiceAudienceProp)
  );
  const [graph, setGraph] = useState<GraphResponse | null>(initialGraph ?? null);
  const [filterMetadataGraph, setFilterMetadataGraph] = useState<GraphResponse | null>(initialGraph ?? null);
  const graphCacheRef = useRef<Map<string, CachedGraphEntry>>(
    new Map(
      initialGraph
        ? [
            [
              graphCacheKey(initialGraph.batch.slug, initialGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE),
              { graph: initialGraph, source: "api", cachedAt: Date.now() }
            ]
          ]
        : []
    )
  );
  const prefetchInFlightRef = useRef<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => initialSelectedNodeId(initialGraph));
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>(() => initialSelectedPlatforms(initialFilters));
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
  const [selectedGroupPartners, setSelectedGroupPartners] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(initialFilters?.minScore ?? 0);
  const [minScoreDraft, setMinScoreDraft] = useState(initialFilters?.minScore ?? 0);
  const [graphFocusRevision, setGraphFocusRevision] = useState(0);
  const [focusQuery, setFocusQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [openFilterMenu, setOpenFilterMenu] = useState<FilterMenuId | null>(null);
  const [highlightedFounderId, setHighlightedFounderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialGraph);
  const [actionLoading, setActionLoading] = useState<"ingest" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filterBandRef = useRef<HTMLElement | null>(null);
  const dashboardGridRef = useRef<HTMLElement | null>(null);
  const graphRequestIdRef = useRef(0);
  const activeGraphAbortRef = useRef<AbortController | null>(null);
  const activeBackgroundGraphAbortRefs = useRef<Set<AbortController>>(new Set());
  const actionRequestIdRef = useRef(0);
  const activeActionAbortRef = useRef<AbortController | null>(null);
  const refreshRecoveryTimeoutsRef = useRef<number[]>([]);
  const refreshRecoveryRunIdRef = useRef(0);
  const selectionRef = useRef({ batchSlug, topVoiceAudience });
  const initialGraphHydratedRef = useRef(Boolean(initialGraph));
  const currentFilters = useMemo<ClientGraphFilters>(
    () => ({
      platforms: selectedPlatforms,
      industries: selectedIndustries,
      groupPartners: selectedGroupPartners,
      minScore
    }),
    [minScore, selectedGroupPartners, selectedIndustries, selectedPlatforms]
  );
  const currentFiltersRef = useRef(currentFilters);

  useEffect(() => {
    currentFiltersRef.current = currentFilters;
  }, [currentFilters]);

  useEffect(() => {
    selectionRef.current = { batchSlug, topVoiceAudience };
  }, [batchSlug, topVoiceAudience]);

  const rememberGraph = useCallback((payload: GraphResponse, source: GraphPayloadSource = "api") => {
    graphCacheRef.current.set(
      graphCacheKey(payload.batch.slug, payload.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE),
      { graph: payload, source, cachedAt: Date.now() }
    );
  }, []);

  const fetchGraph = useCallback(async (options: { background?: boolean; forceApi?: boolean; unfiltered?: boolean } = {}) => {
    const background = options.background === true;
    const requestFilters = options.unfiltered
      ? { platforms: [], industries: [], groupPartners: [], minScore: 0 }
      : currentFiltersRef.current;
    const requestId = background ? graphRequestIdRef.current : graphRequestIdRef.current + 1;
    if (!background) {
      graphRequestIdRef.current = requestId;
    }
    if (!background) {
      setLoading(true);
    }
    if (!background) {
      setError(null);
    }
    if (!background) {
      activeGraphAbortRef.current?.abort();
    }
    const controller = new AbortController();
    if (background) {
      activeBackgroundGraphAbortRefs.current.add(controller);
    } else {
      activeGraphAbortRef.current = controller;
    }

    const params = new URLSearchParams({ batch: batchSlug });
    if (topVoiceAudience !== DEFAULT_TOP_VOICE_AUDIENCE) {
      params.set("topVoices", topVoiceAudience);
    }
    if (requestFilters.platforms.length) {
      params.set("platforms", requestFilters.platforms.join(","));
    }
    if (requestFilters.minScore > 0) {
      params.set("minScore", String(requestFilters.minScore));
    }
    if (requestFilters.industries.length) {
      params.set("industries", requestFilters.industries.join(","));
    }
    if (requestFilters.groupPartners.length) {
      params.set("groupPartners", requestFilters.groupPartners.join(","));
    }
    try {
      const staticSnapshotUrl =
        options.unfiltered && !options.forceApi
          ? staticGraphSnapshotUrl(batchSlug, topVoiceAudience)
          : null;
      const result = await fetchGraphPayloadWithFreshStaticSnapshot(
        staticSnapshotUrl,
        `/api/graph?${params.toString()}`,
        3,
        { signal: controller.signal }
      );
      const payload = result.graph;
      if (options.unfiltered) {
        rememberGraph(payload, result.source);
      }
      const selected = selectionRef.current;
      const matchesCurrentSelection = graphMatchesSelection(payload, selected.batchSlug, selected.topVoiceAudience);
      if ((!background && requestId !== graphRequestIdRef.current) || !matchesCurrentSelection) {
        return;
      }
      if (options.unfiltered) {
        setFilterMetadataGraph(payload);
      }
      setGraph(options.unfiltered ? applyClientGraphFilters(payload, currentFiltersRef.current) : payload);
      if (result.source === "static" && options.unfiltered && !background) {
        window.setTimeout(() => {
          void fetchGraph({ background: true, forceApi: true, unfiltered: true });
        }, 0);
      }
    } catch (caught) {
      if (!background && requestId !== graphRequestIdRef.current) {
        return;
      }
      if (isAbortError(caught) || controller.signal.aborted) {
        return;
      }
      if (!background) {
        setError(caught instanceof Error ? caught.message : "Graph request failed");
      }
    } finally {
      if (background) {
        activeBackgroundGraphAbortRefs.current.delete(controller);
      } else if (activeGraphAbortRef.current === controller) {
        activeGraphAbortRef.current = null;
      }
      if (!background && requestId === graphRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [batchSlug, rememberGraph, topVoiceAudience]);

  const clearRefreshRecoveryPolling = useCallback(() => {
    refreshRecoveryRunIdRef.current += 1;
    for (const timeoutId of refreshRecoveryTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    refreshRecoveryTimeoutsRef.current = [];
  }, []);

  const scheduleRefreshRecoveryPolling = useCallback(
    (actionRequestId: number) => {
      clearRefreshRecoveryPolling();
      const recoveryRunId = refreshRecoveryRunIdRef.current;
      for (const [index, delay] of REFRESH_RECOVERY_POLL_DELAYS_MS.entries()) {
        const timeoutId = window.setTimeout(() => {
          refreshRecoveryTimeoutsRef.current = refreshRecoveryTimeoutsRef.current.filter((item) => item !== timeoutId);
          if (recoveryRunId !== refreshRecoveryRunIdRef.current || actionRequestId !== actionRequestIdRef.current) {
            return;
          }
          setRefreshNotice(
            index === REFRESH_RECOVERY_POLL_DELAYS_MS.length - 1
              ? "Refresh is still running in the background; updates will continue to appear as the graph refreshes."
              : "Refresh is still running; checking again for completed updates."
          );
          void fetchGraph({ background: true, forceApi: true, unfiltered: true });
        }, delay);
        refreshRecoveryTimeoutsRef.current.push(timeoutId);
      }
    },
    [clearRefreshRecoveryPolling, fetchGraph]
  );

  const prefetchGraph = useCallback(async (prefetchBatchSlug: string, prefetchTopVoiceAudience: TopVoiceAudienceId) => {
    const key = graphCacheKey(prefetchBatchSlug, prefetchTopVoiceAudience);
    if (graphCacheRef.current.has(key) || prefetchInFlightRef.current.has(key)) {
      return;
    }
    prefetchInFlightRef.current.add(key);

    const params = new URLSearchParams({ batch: prefetchBatchSlug });
    if (prefetchTopVoiceAudience !== DEFAULT_TOP_VOICE_AUDIENCE) {
      params.set("topVoices", prefetchTopVoiceAudience);
    }

    try {
      const staticSnapshotUrl = staticGraphSnapshotUrl(prefetchBatchSlug, prefetchTopVoiceAudience);
      const result = await fetchGraphPayloadWithFreshStaticSnapshot(
        staticSnapshotUrl,
        `/api/graph?${params.toString()}`,
        2
      );
      rememberGraph(result.graph, result.source);
    } catch {
      // Background warming should never interrupt the active dashboard.
    } finally {
      prefetchInFlightRef.current.delete(key);
    }
  }, [rememberGraph]);

  useEffect(() => {
    return () => {
      activeGraphAbortRef.current?.abort();
      activeGraphAbortRef.current = null;
      for (const controller of activeBackgroundGraphAbortRefs.current) {
        controller.abort();
      }
      activeBackgroundGraphAbortRefs.current.clear();
      activeActionAbortRef.current?.abort();
      activeActionAbortRef.current = null;
      clearRefreshRecoveryPolling();
    };
  }, [clearRefreshRecoveryPolling]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let timeoutId: number | null = null;
    const scheduleDailyRefresh = () => {
      timeoutId = window.setTimeout(() => {
        graphCacheRef.current.clear();
        prefetchInFlightRef.current.clear();
        void fetchGraph({ background: true, forceApi: true, unfiltered: true });
        scheduleDailyRefresh();
      }, millisecondsUntilNextLocalMidnight());
    };

    scheduleDailyRefresh();

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [fetchGraph]);

  useEffect(() => {
    const cachedEntry = graphCacheRef.current.get(graphCacheKey(batchSlug, topVoiceAudience));
    const cachedGraph =
      graphMatchesSelection(filterMetadataGraph, batchSlug, topVoiceAudience)
        ? filterMetadataGraph
        : cachedEntry?.graph;

    if (cachedGraph) {
      if (!graphMatchesSelection(filterMetadataGraph, cachedGraph.batch.slug, cachedGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE)) {
        graphRequestIdRef.current += 1;
        setFilterMetadataGraph(cachedGraph);
      }

      setGraph(applyClientGraphFilters(cachedGraph, currentFilters));
      setError(null);
      setLoading(false);

      if (cachedEntry?.source === "static") {
        const timeoutId = window.setTimeout(() => {
          void fetchGraph({ background: true, forceApi: true, unfiltered: true });
        }, 0);
        return () => window.clearTimeout(timeoutId);
      }

      if (
        initialGraphHydratedRef.current &&
        initialGraph &&
        batchSlug === initialGraph.batch.slug &&
        topVoiceAudience === (initialGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE)
      ) {
        initialGraphHydratedRef.current = false;
        const timeoutId = window.setTimeout(() => {
          void fetchGraph({ background: true, forceApi: true, unfiltered: true });
        }, 1400);
        return () => window.clearTimeout(timeoutId);
      }
      return;
    }

    initialGraphHydratedRef.current = false;
    void fetchGraph({ unfiltered: true });
  }, [batchSlug, currentFilters, fetchGraph, filterMetadataGraph, initialGraph, topVoiceAudience]);

  useEffect(() => {
    actionRequestIdRef.current += 1;
    activeActionAbortRef.current?.abort();
    activeActionAbortRef.current = null;
    clearRefreshRecoveryPolling();
    setActionLoading(null);
    setRefreshError(null);
    setRefreshNotice(null);
  }, [batchSlug, clearRefreshRecoveryPolling, topVoiceAudience]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    if (topVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE) {
      url.searchParams.delete("topVoices");
    } else {
      url.searchParams.set("topVoices", topVoiceAudience);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [topVoiceAudience]);

  useEffect(() => {
    setMinScoreDraft(minScore);
  }, [minScore]);

  useEffect(() => {
    if (!graph) {
      return;
    }

    const currentSelectionExists = graph.nodes.some((node) => node.id === selectedNodeId);
    if (!currentSelectionExists) {
      const topCompanyId = graph.leaderboard[0]?.companyId;
      setSelectedNodeId(topCompanyId ? `company:${topCompanyId}` : graph.nodes[0]?.id ?? null);
    }
  }, [graph, selectedNodeId]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph, selectedNodeId]
  );

  const selectedEvidence = useMemo(() => {
    if (!graph || !selectedNode) {
      return [];
    }
    return selectedNodeEvidence(graph, selectedNode).slice(0, 20);
  }, [graph, selectedNode]);

  const searchResults = useMemo(
    () => (graph ? searchGraphNodes(graph.nodes, focusQuery, 14) : []),
    [focusQuery, graph]
  );

  const relatedNodes = useMemo(() => {
    if (!graph || !selectedNode) {
      return [];
    }
    return [];
  }, [graph, selectedNode]);

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setHighlightedFounderId(null);
    setGraphFocusRevision((current) => current + 1);
  }, []);

  const selectRankedNode = useCallback(
    (nodeId: string) => {
      selectNode(nodeId);
      window.requestAnimationFrame(() => {
        dashboardGridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [selectNode]
  );

  const selectSearchResult = useCallback((result: GraphSearchResult) => {
    setSelectedNodeId(result.companyNodeId);
    setHighlightedFounderId(result.kind === "founder" ? result.id : null);
    setSearchOpen(false);
    setGraphFocusRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setOpenFilterMenu(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!filterBandRef.current?.contains(event.target as Node)) {
        setOpenFilterMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const batches = filterMetadataGraph?.batches ?? graph?.batches ?? defaultBatches;
  const topVoiceAudiences = filterMetadataGraph?.topVoiceAudiences ?? graph?.topVoiceAudiences ?? defaultTopVoiceAudiences;

  const prefetchTopVoiceGraphs = useCallback((targetBatchSlug: string, skipAudience?: TopVoiceAudienceId) => {
    for (const audience of topVoiceAudiences) {
      if (audience.id === DEFAULT_TOP_VOICE_AUDIENCE || audience.id === skipAudience) {
        continue;
      }
      void prefetchGraph(targetBatchSlug, audience.id);
    }
  }, [prefetchGraph, topVoiceAudiences]);

  useEffect(() => {
    if (!graph) {
      return;
    }
    if (batchSlug === A16Z_SPEEDRUN_BATCH_SLUG) {
      return;
    }
    const batchSlugs = new Set(batches.map((batch) => batch.slug));
    const prefetchBatchSlug = A16Z_SPEEDRUN_BATCH_SLUG;
    if (!batchSlugs.has(prefetchBatchSlug)) {
      return;
    }

    const warmBatch = () => {
      void prefetchGraph(prefetchBatchSlug, topVoiceAudience);
    };
    const requestIdleCallback = window.requestIdleCallback;
    const cancelIdleCallback = window.cancelIdleCallback;
    if (requestIdleCallback && cancelIdleCallback) {
      const idleId = requestIdleCallback(warmBatch, { timeout: 2800 });
      return () => cancelIdleCallback(idleId);
    }

    const timeoutId = window.setTimeout(warmBatch, 2400);
    return () => window.clearTimeout(timeoutId);
  }, [batchSlug, batches, graph, prefetchGraph, topVoiceAudience]);

  const industryOptions = useMemo(() => {
    const byIndustry = new Map<string, { name: string; count: number; color: string }>();

    for (const node of filterMetadataGraph?.nodes ?? graph?.nodes ?? []) {
      if (node.entityType !== "company") {
        continue;
      }
      const current = byIndustry.get(node.primaryIndustry) ?? {
        name: node.primaryIndustry,
        count: 0,
        color: node.visual.industryColor
      };
      current.count += 1;
      byIndustry.set(node.primaryIndustry, current);
    }

    return [...byIndustry.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }, [filterMetadataGraph, graph]);

  const groupPartnerOptions = useMemo(() => {
    const byPartner = new Map<string, { name: string; count: number }>();

    for (const node of filterMetadataGraph?.nodes ?? graph?.nodes ?? []) {
      if (node.entityType !== "company" || !node.groupPartner) {
        continue;
      }
      if (batchSlug === A16Z_SPEEDRUN_BATCH_SLUG && node.groupPartner.toLowerCase() === "a16z speedrun") {
        continue;
      }
      const current = byPartner.get(node.groupPartner) ?? {
        name: node.groupPartner,
        count: 0
      };
      current.count += 1;
      byPartner.set(node.groupPartner, current);
    }

    return [...byPartner.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }, [batchSlug, filterMetadataGraph, graph]);

  const platformDropdownOptions = useMemo<DropdownOption<Platform>[]>(
    () => platformOptions.map((platform) => ({ value: platform, label: formatPlatform(platform), platform })),
    []
  );

  const industryDropdownOptions = useMemo<DropdownOption<string>[]>(
    () =>
      industryOptions.map((industry) => ({
        value: industry.name,
        label: formatIndustry(industry.name),
        count: industry.count,
        color: industry.color
      })),
    [industryOptions]
  );

  const groupPartnerDropdownOptions = useMemo<DropdownOption<string>[]>(
    () =>
      groupPartnerOptions.map((groupPartner) => ({
        value: groupPartner.name,
        label: groupPartner.name,
        count: groupPartner.count
      })),
    [groupPartnerOptions]
  );
  const topVoiceDropdownOptions = useMemo<DropdownOption<TopVoiceAudienceId>[]>(
    () =>
      topVoiceAudiences
        .filter((audience) => audience.id !== DEFAULT_TOP_VOICE_AUDIENCE)
        .map((audience) => ({
          value: audience.id,
          label: audience.displayName
        })),
    [topVoiceAudiences]
  );

  async function runDemoAction(action: "ingest" | "refresh") {
    const actionRequestId = actionRequestIdRef.current + 1;
    actionRequestIdRef.current = actionRequestId;
    clearRefreshRecoveryPolling();
    setActionLoading(action);
    setError(null);
    setRefreshError(null);
    setRefreshNotice(null);
    activeActionAbortRef.current?.abort();
    const controller = new AbortController();
    activeActionAbortRef.current = controller;

    try {
      const response = await fetchWithTimeout(
        "/api/graph/refresh",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            batchSlug,
            platforms: selectedPlatforms,
            industries: selectedIndustries,
            groupPartners: selectedGroupPartners,
            minScore,
            topVoices: topVoiceAudience
          })
        },
        REFRESH_TIMEOUT_MS,
        controller.signal
      );

      if (!response.ok) {
        throw new Error(`${action} request failed with ${response.status}`);
      }

      const payload = (await response.json()) as RefreshResponse;
      if (actionRequestId !== actionRequestIdRef.current) {
        return;
      }
      clearRefreshRecoveryPolling();

      const activeFilters = hasClientGraphFilters({
        platforms: selectedPlatforms,
        industries: selectedIndustries,
        groupPartners: selectedGroupPartners,
        minScore
      });
      graphCacheRef.current.clear();
      prefetchInFlightRef.current.clear();
      setGraph(payload.graph);
      if (!activeFilters) {
        rememberGraph(payload.graph);
        setFilterMetadataGraph(payload.graph);
      } else {
        void fetchGraph({ background: true, forceApi: true, unfiltered: true });
      }
      const notice = refreshNoticeFor(action, payload);
      if (payload.status === "failed") {
        setRefreshError(payload.errors?.[0] ?? notice ?? `${action} finished without visible evidence`);
      } else {
        setRefreshError(null);
        setRefreshNotice(notice);
      }
    } catch (caught) {
      if (actionRequestId !== actionRequestIdRef.current) {
        return;
      }
      const message = caught instanceof Error ? caught.message : `${action} request failed`;
      if (message.includes("timed out")) {
        setRefreshNotice("Refresh is still running; checking for completed updates.");
        scheduleRefreshRecoveryPolling(actionRequestId);
      }
      setError(message);
    } finally {
      if (activeActionAbortRef.current === controller) {
        activeActionAbortRef.current = null;
      }
      if (actionRequestId === actionRequestIdRef.current) {
        setActionLoading(null);
      }
    }
  }

  function togglePlatform(platform: Platform) {
    setSelectedPlatforms((current) =>
      current.includes(platform)
        ? current.filter((item) => item !== platform)
        : [...current, platform]
    );
  }

  function toggleIndustry(industry: string) {
    setSelectedIndustries((current) =>
      current.includes(industry) ? current.filter((item) => item !== industry) : [...current, industry]
    );
  }

  function toggleGroupPartner(groupPartner: string) {
    setSelectedGroupPartners((current) =>
      current.includes(groupPartner) ? current.filter((item) => item !== groupPartner) : [...current, groupPartner]
    );
  }

  function commitMinScore(value: number) {
    const nextScore = clampScore(value);
    setMinScoreDraft(nextScore);
    setMinScore((current) => (current === nextScore ? current : nextScore));
  }

  const topVoiceCompanyCount = graph?.nodes.filter((node) => node.entityType === "company").length ?? 0;
  const topVoicesEmpty =
    Boolean(graph) &&
    (graph?.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE) !== DEFAULT_TOP_VOICE_AUDIENCE &&
    topVoiceCompanyCount === 0;
  const isA16zSpeedrunBatch = batchSlug === A16Z_SPEEDRUN_BATCH_SLUG;
  const brandTitle = isA16zSpeedrunBatch ? "a16z Network Map" : "YC Network Map";
  const loadingMapLabel = isA16zSpeedrunBatch ? "a16z" : "YC";

  useEffect(() => {
    document.title = brandTitle;
  }, [brandTitle]);

  return (
    <main className={`dashboard${isA16zSpeedrunBatch ? " dashboard-a16z" : ""}`}>
      <header className="topbar">
        <div className="brand-block">
          {isA16zSpeedrunBatch ? (
            <span className="a16z-brand-mark">
              <img src="/brand/a16z-speedrun-logo.png" alt="a16z speedrun" />
            </span>
          ) : (
            <span className="yc-brand-mark" aria-hidden="true">Y</span>
          )}
          <div>
            <h1>{brandTitle}</h1>
          </div>
        </div>

        <div className="focus-search">
          <Search size={17} />
          <input
            ref={searchInputRef}
            value={focusQuery}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => {
              setFocusQuery(event.target.value);
              setSearchOpen(true);
            }}
            placeholder="Jump to company or founder"
          />
          <kbd>Ctrl K</kbd>
          {searchOpen && focusQuery.trim() && (
            <div className="focus-search-results">
              {searchResults.map((result) => (
                <button type="button" key={`${result.kind}:${result.id}`} onClick={() => selectSearchResult(result)}>
                  <span>{result.label}</span>
                  <small>{result.subtitle}</small>
                </button>
              ))}
              {!searchResults.length && <div className="focus-search-empty">No matching company or founder</div>}
            </div>
          )}
        </div>

        <div className="control-strip">
          <div className="control-cluster control-cluster-selectors">
            <label className="batch-control">
              <span className="sr-only">Batch</span>
              <select value={batchSlug} onChange={(event) => setBatchSlug(event.target.value)}>
                {batches.map((batch) => (
                  <option key={batch.slug} value={batch.slug}>
                    {batch.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="control-cluster control-cluster-actions">
            <button
              type="button"
              onClick={() => void runDemoAction("refresh")}
              disabled={!!actionLoading}
              title="Refresh now"
            >
              <RefreshCw size={16} className={actionLoading === "refresh" ? "spin" : ""} />
              {actionLoading === "refresh" ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </div>
      </header>

      <section className="filter-band" ref={filterBandRef}>
        <FilterDropdown
          id="platform"
          icon={<Filter size={15} />}
          title="Platform"
          allLabel="All platforms"
          selectedValues={selectedPlatforms}
          options={platformDropdownOptions}
          isOpen={openFilterMenu === "platform"}
          onOpenChange={(open) => setOpenFilterMenu(open ? "platform" : null)}
          onToggle={togglePlatform}
          onClear={() => setSelectedPlatforms([])}
        />

        <FilterDropdown
          id="industry"
          icon={<Palette size={15} />}
          title="Industry"
          allLabel="All industries"
          selectedValues={selectedIndustries}
          options={industryDropdownOptions}
          isOpen={openFilterMenu === "industry"}
          onOpenChange={(open) => setOpenFilterMenu(open ? "industry" : null)}
          onToggle={toggleIndustry}
          onClear={() => setSelectedIndustries([])}
        />

        <FilterDropdown
          id="groupPartner"
          icon={<Filter size={15} />}
          title="Group partner"
          allLabel="All group partners"
          selectedValues={selectedGroupPartners}
          options={groupPartnerDropdownOptions}
          isOpen={openFilterMenu === "groupPartner"}
          onOpenChange={(open) => setOpenFilterMenu(open ? "groupPartner" : null)}
          onToggle={toggleGroupPartner}
          onClear={() => setSelectedGroupPartners([])}
        />

        <SingleSelectFilterDropdown
          id="topVoices"
          icon={<Users size={15} />}
          title="Top Voices"
          allLabel="All voices"
          allValue={DEFAULT_TOP_VOICE_AUDIENCE}
          selectedValue={topVoiceAudience}
          options={topVoiceDropdownOptions}
          isOpen={openFilterMenu === "topVoices"}
          onOpenChange={(open) => {
            if (open) {
              prefetchTopVoiceGraphs(batchSlug, topVoiceAudience);
            }
            setOpenFilterMenu(open ? "topVoices" : null);
          }}
          onSelect={(value) => {
            setTopVoiceAudience(normalizeTopVoiceAudienceId(value));
            setOpenFilterMenu(null);
          }}
        />

        <div className="score-filter">
          <div className="score-filter-header">
            <span>Min score</span>
            <strong>{minScoreDraft}</strong>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={minScoreDraft}
            onChange={(event) => setMinScoreDraft(clampScore(Number(event.target.value)))}
            onPointerUp={(event) => commitMinScore(Number(event.currentTarget.value))}
            onBlur={(event) => commitMinScore(Number(event.currentTarget.value))}
            onKeyUp={(event) => {
              if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End" || event.key === "Enter") {
                commitMinScore(Number(event.currentTarget.value));
              }
            }}
            aria-label="Minimum score"
          />
          <div className="score-filter-footer">
            <input
              type="number"
              min={0}
              max={100}
              value={minScoreDraft}
              onChange={(event) => setMinScoreDraft(clampScore(Number(event.target.value) || 0))}
              onBlur={(event) => commitMinScore(Number(event.currentTarget.value) || 0)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitMinScore(Number(event.currentTarget.value) || 0);
                }
              }}
              aria-label="Minimum score value"
            />
            <button
              type="button"
              onClick={() => {
                setMinScoreDraft(0);
                setMinScore(0);
              }}
              disabled={minScoreDraft === 0 && minScore === 0}
            >
              Reset
            </button>
          </div>
        </div>
      </section>

      {(error || refreshError || refreshNotice) && (
        <section className="status-line" aria-live="polite">
          {error && <span className="error-text">{error}</span>}
          {refreshError && <span className="error-text">{refreshError}</span>}
          {refreshNotice && <span className="refresh-notice-text">{refreshNotice}</span>}
        </section>
      )}

      <section className="dashboard-grid" ref={dashboardGridRef}>
        <div className="graph-column">
          {topVoicesEmpty ? (
            <div className="graph-empty-state">
              <strong>No companies have traction from this Top Voices audience yet.</strong>
              <span>{graph?.selectedTopVoiceAudience?.displayName ?? "Top Voices"}</span>
            </div>
          ) : graph ? (
            <CytoscapeGraph
              nodes={graph.nodes}
              edges={graph.edges}
              batch={graph.batch}
              selectedNodeId={selectedNodeId}
              focusRevision={graphFocusRevision}
              onSelectNode={selectNode}
            />
          ) : (
            <div className="graph-empty-state">
              <strong>{loading ? `Loading ${loadingMapLabel} map...` : "Graph unavailable"}</strong>
              <span>
                {loading
                  ? "Fetching companies, traction evidence, filters, and graph links."
                  : error ?? "Use Refresh to try loading the map again."}
              </span>
            </div>
          )}
          {loading && graph && <div className="overlay-status">Refreshing graph</div>}
        </div>
        <NodePanel
          node={selectedNode}
          relatedNodes={relatedNodes}
          evidence={selectedEvidence}
          highlightedFounderId={highlightedFounderId}
        />
        {graph && <InsightsTabs graph={graph} onSelectNode={selectRankedNode} />}
      </section>
    </main>
  );
}

interface FilterDropdownProps<T extends string> {
  id: FilterMenuId;
  icon: ReactNode;
  title: string;
  allLabel: string;
  selectedValues: T[];
  options: DropdownOption<T>[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (value: T) => void;
  onClear: () => void;
}

function FilterDropdown<T extends string>({
  id,
  icon,
  title,
  allLabel,
  selectedValues,
  options,
  isOpen,
  onOpenChange,
  onToggle,
  onClear
}: FilterDropdownProps<T>) {
  const selectedLabels = options
    .filter((option) => selectedValues.includes(option.value))
    .map((option) => option.label);
  const buttonLabel =
    selectedLabels.length === 0
      ? allLabel
      : selectedLabels.length === 1
        ? selectedLabels[0]
        : `${selectedLabels.length} selected`;
  const menuId = `${id}-filter-menu`;

  return (
    <div className={`filter-dropdown ${isOpen ? "open" : ""}`}>
      <span className="filter-dropdown-label">
        {icon}
        {title}
      </span>
      <button
        type="button"
        className={`filter-dropdown-trigger ${selectedValues.length ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => onOpenChange(!isOpen)}
      >
        <span>{buttonLabel}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="filter-dropdown-menu" id={menuId} role="menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={selectedValues.length === 0}
            className={`filter-menu-option ${selectedValues.length === 0 ? "selected" : ""}`}
            onClick={onClear}
          >
            <span className="filter-check" aria-hidden="true">
              {selectedValues.length === 0 && <Check size={15} />}
            </span>
            <span className="filter-option-label">{allLabel}</span>
          </button>

          {options.map((option) => {
            const selected = selectedValues.includes(option.value);
            return (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={selected}
                className={`filter-menu-option ${selected ? "selected" : ""}`}
                key={option.value}
                onClick={() => onToggle(option.value)}
              >
                <span className="filter-check" aria-hidden="true">
                  {selected && <Check size={15} />}
                </span>
                {option.platform && <PlatformLogo platform={option.platform} />}
                {option.color && <span className="filter-swatch" style={{ backgroundColor: option.color }} />}
                <span className="filter-option-label">{option.label}</span>
                {typeof option.count === "number" && <em>({option.count})</em>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SingleSelectFilterDropdownProps<T extends string> {
  id: FilterMenuId;
  icon: ReactNode;
  title: string;
  allLabel: string;
  allValue: T;
  selectedValue: T;
  options: DropdownOption<T>[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: T) => void;
}

function SingleSelectFilterDropdown<T extends string>({
  id,
  icon,
  title,
  allLabel,
  allValue,
  selectedValue,
  options,
  isOpen,
  onOpenChange,
  onSelect
}: SingleSelectFilterDropdownProps<T>) {
  const selectedOption = options.find((option) => option.value === selectedValue);
  const menuId = `${id}-filter-menu`;
  const entries = [
    { value: allValue, label: allLabel },
    ...options
  ];

  return (
    <div className={`filter-dropdown ${isOpen ? "open" : ""}`}>
      <span className="filter-dropdown-label">
        {icon}
        {title}
      </span>
      <button
        type="button"
        className={`filter-dropdown-trigger ${selectedValue !== allValue ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => onOpenChange(!isOpen)}
      >
        <span>{selectedOption?.label ?? allLabel}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="filter-dropdown-menu" id={menuId} role="menu">
          {entries.map((option) => {
            const selected = selectedValue === option.value;
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`filter-menu-option ${selected ? "selected" : ""}`}
                key={option.value}
                onClick={() => onSelect(option.value)}
              >
                <span className="filter-check" aria-hidden="true">
                  {selected && <Check size={15} />}
                </span>
                <span className="filter-option-label">{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatIndustry(industry: string): string {
  const labels: Record<string, string> = {
    b2b: "B2B",
    industrials: "Industrials",
    fintech: "Fintech",
    healthcare: "Healthcare",
    consumer: "Consumer",
    "real estate and construction": "Real Estate and Construction",
    government: "Government"
  };
  return labels[industry.toLowerCase()] ?? industry.replace(/\b\w/g, (char) => char.toUpperCase());
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}
