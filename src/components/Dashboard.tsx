"use client";

import {
  Check,
  ChevronDown,
  Copy,
  Filter,
  Palette,
  RefreshCw,
  Search,
  Share2,
  Users
} from "lucide-react";
import Image from "next/image";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { CytoscapeGraph } from "./CytoscapeGraph";
import { InsightsTabs } from "./InsightsTabs";
import { NodePanel } from "./NodePanel";
import { formatPlatform, PlatformLogo } from "./PlatformLogo";
import { trackAnalyticsEvent, type AnalyticsEventPayloads } from "@/lib/analytics";
import { applyClientGraphFilters, type ClientGraphFilters } from "@/lib/graph/client-filters";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { searchGraphNodes, type GraphSearchResult } from "@/lib/graph/search";
import { validateStaticGraphSnapshotContract } from "@/lib/graph/static-graph-snapshot-contract.mjs";
import {
  centralDayKey,
  millisecondsUntilNextCentralMidnight
} from "@/lib/time/central-day";
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
  "bilibili",
  "tiktok",
  "bluesky"
];

const defaultBatches = [
  { slug: "S2026", label: "YC Spring 2026 (P26)", companyCountExpected: 197, companyCountObserved: 197 },
  { slug: "S26", label: "YC Summer 2026 (S26)", companyCountExpected: 83, companyCountObserved: 83 },
  { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
];
const DEFAULT_BATCH_SLUG = "S2026";
const A16Z_SPEEDRUN_BATCH_SLUG = "A16ZSR006";
const STATIC_GRAPH_SNAPSHOT_VERSION = "2026-07-16-fast-snapshot-loading";
const MIDNIGHT_REFRESH_DELAY_MS = 90_000;
const STATIC_GRAPH_TIMEOUT_MS = 8_000;
const API_GRAPH_TIMEOUT_MS = 20_000;
const REFRESH_TIMEOUT_MS = 45_000;
const BACKGROUND_REVALIDATION_DELAY_MS = 30_000;
const SCOPE_TRANSITION_MINIMUM_MS = 450;
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
      return await fetchWithTimeout(
        url,
        { cache: options.cache ?? "no-store" },
        options.timeoutMs ?? API_GRAPH_TIMEOUT_MS,
        async (response) => {
          if (!response.ok) {
            throw new Error(`Graph request failed with ${response.status}`);
          }
          return (await response.json()) as GraphResponse;
        },
        options.signal
      );
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

async function fetchGraphPayloadWithStaticSnapshot(
  staticSnapshotUrl: string | null,
  apiUrl: string,
  attempts = 3,
  options: {
    signal?: AbortSignal;
    expectedBatchSlug: string;
    expectedTopVoiceAudience: TopVoiceAudienceId;
  }
): Promise<GraphPayloadResult> {
  if (staticSnapshotUrl) {
    try {
      const staticPayload = await fetchGraphPayload(staticSnapshotUrl, 2, {
        cache: "force-cache",
        timeoutMs: STATIC_GRAPH_TIMEOUT_MS,
        signal: options.signal
      });
      if (!validateStaticGraphSnapshotContract(staticPayload).ok) {
        throw new Error("Static graph snapshot does not satisfy the v4 scoring contract");
      }
      if (!graphMatchesSelection(staticPayload, options.expectedBatchSlug, options.expectedTopVoiceAudience)) {
        throw new Error("Static graph snapshot does not match the selected graph scope");
      }
      return { graph: staticPayload, source: "static" };
    } catch (caught) {
      if (isAbortError(caught) || options.signal?.aborted) {
        throw caught;
      }
    }
  }

  const apiGraph = await fetchGraphPayload(apiUrl, attempts, {
    cache: "no-store",
    timeoutMs: API_GRAPH_TIMEOUT_MS,
    signal: options.signal
  });
  if (!graphMatchesSelection(apiGraph, options.expectedBatchSlug, options.expectedTopVoiceAudience)) {
    throw new Error("Graph response does not match the selected graph scope");
  }

  return {
    graph: apiGraph,
    source: "api"
  };
}

async function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  readResponse: (response: Response) => Promise<T>,
  parentSignal?: AbortSignal
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const controller = new AbortController();
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const timeoutId = window.setTimeout(() => {
    rejectCancellation(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`));
    controller.abort();
  }, timeoutMs);
  const abort = () => {
    rejectCancellation(new DOMException("Aborted", "AbortError"));
    controller.abort();
  };
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    const request = fetch(input, { ...init, signal: controller.signal }).then(readResponse);
    return await Promise.race([request, cancellation]);
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
  manualRefreshEnabled?: boolean;
}

type GraphPayloadSource = "static" | "api";

interface GraphPayloadResult {
  graph: GraphResponse;
  source: GraphPayloadSource;
}

interface CachedGraphEntry {
  graph: GraphResponse;
  source: GraphPayloadSource;
}

interface InFlightGraphRequest {
  key: string;
  apiUrl: string;
  requestId: number;
  forceApi: boolean;
  controller: AbortController;
  promise: Promise<GraphPayloadResult>;
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
  graph?: GraphResponse;
  status?: RefreshStatus;
  errors?: string[];
  error?: {
    code?: string;
    message?: string;
  };
  refreshSummary?: RefreshSummary;
}

interface SuccessfulRefreshResponse extends RefreshResponse {
  graph: GraphResponse;
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

function normalizeInitialList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function queryList(params: URLSearchParams, key: string): string[] {
  return normalizeInitialList(params.get(key)?.split(",")).slice(0, 50);
}

function setUrlParameter(url: URL, key: string, value: string | null): void {
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
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
  return filename
    ? `/graph/${filename}${audienceSuffixes[topVoiceAudience]}.json?v=${STATIC_GRAPH_SNAPSHOT_VERSION}-${centralDayKey(new Date()) ?? "invalid"}`
    : null;
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

async function readRefreshResponse(
  response: Response,
  action: "ingest" | "refresh"
): Promise<SuccessfulRefreshResponse> {
  let payload: RefreshResponse | null = null;
  try {
    payload = (await response.json()) as RefreshResponse;
  } catch {
    if (!response.ok) {
      throw new Error(`${titleCase(action)} request failed with ${response.status}.`);
    }
    throw new Error(`${titleCase(action)} returned an unreadable response.`);
  }

  if (!response.ok) {
    const structuredMessage = payload?.errors?.find((message) => message.trim()) ?? payload?.error?.message?.trim();
    const code = payload?.error?.code?.trim();
    throw new Error(
      structuredMessage ||
        `${titleCase(action)} request failed with ${response.status}${code ? ` (${code})` : ""}.`
    );
  }
  if (!payload?.graph) {
    throw new Error(`${titleCase(action)} completed without a graph response.`);
  }

  return payload as SuccessfulRefreshResponse;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function Dashboard({
  initialGraph,
  initialBatchSlug: initialBatchSlugProp,
  initialTopVoiceAudience: initialTopVoiceAudienceProp,
  initialFilters,
  manualRefreshEnabled = true
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
              { graph: initialGraph, source: "api" }
            ]
          ]
        : []
    )
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => initialSelectedNodeId(initialGraph));
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>(() => initialSelectedPlatforms(initialFilters));
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>(() => normalizeInitialList(initialFilters?.industries));
  const [selectedGroupPartners, setSelectedGroupPartners] = useState<string[]>(() => normalizeInitialList(initialFilters?.groupPartners));
  const [minScore, setMinScore] = useState(initialFilters?.minScore ?? 0);
  const [minScoreDraft, setMinScoreDraft] = useState(initialFilters?.minScore ?? 0);
  const [graphFocusRevision, setGraphFocusRevision] = useState(0);
  const [focusQuery, setFocusQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [openFilterMenu, setOpenFilterMenu] = useState<FilterMenuId | null>(null);
  const [highlightedFounderId, setHighlightedFounderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialGraph);
  const [scopeTransitioning, setScopeTransitioning] = useState(false);
  const [actionLoading, setActionLoading] = useState<"ingest" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [urlStateHydrated, setUrlStateHydrated] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filterBandRef = useRef<HTMLElement | null>(null);
  const dashboardGridRef = useRef<HTMLElement | null>(null);
  const graphRequestIdRef = useRef(0);
  const scopeTransitionTimerRef = useRef<number | null>(null);
  const graphFetchSequenceRef = useRef(0);
  const latestGraphFetchIdRef = useRef<Map<string, number>>(new Map());
  const graphInFlightRef = useRef<Map<string, InFlightGraphRequest>>(new Map());
  const actionRequestIdRef = useRef(0);
  const activeActionAbortRef = useRef<AbortController | null>(null);
  const selectionRef = useRef({ batchSlug, topVoiceAudience });
  const initialGraphHydratedRef = useRef(Boolean(initialGraph));
  const lastSubmittedQueryRef = useRef("");
  const currentFilters = useMemo<ClientGraphFilters>(
    () => ({
      platforms: selectedPlatforms,
      industries: [],
      groupPartners: [],
      minScore
    }),
    [minScore, selectedPlatforms]
  );
  const currentFiltersRef = useRef(currentFilters);

  useEffect(() => {
    currentFiltersRef.current = currentFilters;
  }, [currentFilters]);

  useEffect(() => {
    selectionRef.current = { batchSlug, topVoiceAudience };
  }, [batchSlug, topVoiceAudience]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.has("industries")) {
        setSelectedIndustries(queryList(params, "industries"));
      }
      if (params.has("groupPartners")) {
        setSelectedGroupPartners(queryList(params, "groupPartners"));
      }
      const urlMinScore = params.get("minScore");
      if (urlMinScore !== null) {
        const normalizedScore = clampScore(Number(urlMinScore) || 0);
        setMinScore(normalizedScore);
        setMinScoreDraft(normalizedScore);
      }
      const urlNodeId = params.get("node")?.trim();
      if (urlNodeId) {
        setSelectedNodeId(urlNodeId.slice(0, 300));
      }
      setUrlStateHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const rememberGraph = useCallback((payload: GraphResponse, source: GraphPayloadSource = "api") => {
    graphCacheRef.current.set(
      graphCacheKey(payload.batch.slug, payload.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE),
      { graph: payload, source }
    );
  }, []);

  const showCachedGraph = useCallback((targetBatchSlug: string, targetTopVoiceAudience: TopVoiceAudienceId) => {
    const cachedEntry = graphCacheRef.current.get(graphCacheKey(targetBatchSlug, targetTopVoiceAudience));
    if (!graphMatchesSelection(cachedEntry?.graph, targetBatchSlug, targetTopVoiceAudience)) {
      return false;
    }

    graphRequestIdRef.current += 1;
    setFilterMetadataGraph(cachedEntry.graph);
    setGraph(applyClientGraphFilters(cachedEntry.graph, currentFiltersRef.current));
    setError(null);
    setLoading(false);
    return true;
  }, []);

  const abortGraphRequestsExcept = useCallback((keyToKeep: string) => {
    for (const [key, request] of graphInFlightRef.current) {
      if (key === keyToKeep) {
        continue;
      }
      graphFetchSequenceRef.current += 1;
      latestGraphFetchIdRef.current.set(key, graphFetchSequenceRef.current);
      request.controller.abort();
      graphInFlightRef.current.delete(key);
    }
  }, []);

  const transitionGraphScope = useCallback((
    targetBatchSlug: string,
    targetTopVoiceAudience: TopVoiceAudienceId
  ) => {
    const currentSelection = selectionRef.current;
    if (
      currentSelection.batchSlug === targetBatchSlug &&
      currentSelection.topVoiceAudience === targetTopVoiceAudience
    ) {
      return;
    }

    if (currentSelection.batchSlug !== targetBatchSlug) {
      if (scopeTransitionTimerRef.current !== null) {
        window.clearTimeout(scopeTransitionTimerRef.current);
      }
      setScopeTransitioning(true);
      scopeTransitionTimerRef.current = window.setTimeout(() => {
        setScopeTransitioning(false);
        scopeTransitionTimerRef.current = null;
      }, SCOPE_TRANSITION_MINIMUM_MS);
    }

    abortGraphRequestsExcept(graphCacheKey(targetBatchSlug, targetTopVoiceAudience));
    selectionRef.current = {
      batchSlug: targetBatchSlug,
      topVoiceAudience: targetTopVoiceAudience
    };
    const nextFilters = {
      ...currentFiltersRef.current,
      industries: [],
      groupPartners: []
    };
    currentFiltersRef.current = nextFilters;
    setSelectedIndustries([]);
    setSelectedGroupPartners([]);
    setOpenFilterMenu(null);
    setHighlightedFounderId(null);

    actionRequestIdRef.current += 1;
    activeActionAbortRef.current?.abort();
    activeActionAbortRef.current = null;
    setActionLoading(null);
    setRefreshError(null);
    setRefreshNotice(null);

    if (!showCachedGraph(targetBatchSlug, targetTopVoiceAudience)) {
      graphRequestIdRef.current += 1;
      setLoading(true);
      setError(null);
    }

    setBatchSlug(targetBatchSlug);
    setTopVoiceAudience(targetTopVoiceAudience);
  }, [abortGraphRequestsExcept, showCachedGraph]);

  const isCurrentGraphRequest = useCallback((request: InFlightGraphRequest) => {
    return latestGraphFetchIdRef.current.get(request.key) === request.requestId;
  }, []);

  const invalidateGraphRequests = useCallback(() => {
    const keys = new Set([
      ...latestGraphFetchIdRef.current.keys(),
      ...graphInFlightRef.current.keys()
    ]);
    for (const key of keys) {
      graphFetchSequenceRef.current += 1;
      latestGraphFetchIdRef.current.set(key, graphFetchSequenceRef.current);
    }
    for (const request of graphInFlightRef.current.values()) {
      request.controller.abort();
    }
    graphInFlightRef.current.clear();
  }, []);

  const getOrStartGraphRequest = useCallback((options: {
    key: string;
    batchSlug: string;
    topVoiceAudience: TopVoiceAudienceId;
    staticSnapshotUrl: string | null;
    apiUrl: string;
    attempts: number;
    forceApi: boolean;
  }): InFlightGraphRequest => {
    const existing = graphInFlightRef.current.get(options.key);
    if (existing && existing.apiUrl === options.apiUrl && (!options.forceApi || existing.forceApi)) {
      return existing;
    }
    if (existing) {
      graphFetchSequenceRef.current += 1;
      latestGraphFetchIdRef.current.set(options.key, graphFetchSequenceRef.current);
      existing.controller.abort();
      graphInFlightRef.current.delete(options.key);
    }

    const controller = new AbortController();
    graphFetchSequenceRef.current += 1;
    const requestId = graphFetchSequenceRef.current;
    latestGraphFetchIdRef.current.set(options.key, requestId);

    const promise = fetchGraphPayloadWithStaticSnapshot(
      options.forceApi ? null : options.staticSnapshotUrl,
      options.apiUrl,
      options.attempts,
      {
        signal: controller.signal,
        expectedBatchSlug: options.batchSlug,
        expectedTopVoiceAudience: options.topVoiceAudience
      }
    ).finally(() => {
      if (graphInFlightRef.current.get(options.key)?.requestId === requestId) {
        graphInFlightRef.current.delete(options.key);
      }
    });
    const request: InFlightGraphRequest = {
      key: options.key,
      apiUrl: options.apiUrl,
      requestId,
      forceApi: options.forceApi,
      controller,
      promise
    };
    graphInFlightRef.current.set(options.key, request);
    return request;
  }, []);

  const fetchGraph = useCallback(async (options: { background?: boolean; forceApi?: boolean; unfiltered?: boolean } = {}) => {
    const background = options.background === true;
    const key = graphCacheKey(batchSlug, topVoiceAudience);
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
    const request = getOrStartGraphRequest({
      key,
      batchSlug,
      topVoiceAudience,
      staticSnapshotUrl: options.unfiltered ? staticGraphSnapshotUrl(batchSlug, topVoiceAudience) : null,
      apiUrl: `/api/graph?${params.toString()}`,
      attempts: 3,
      forceApi: options.forceApi === true
    });
    try {
      const result = await request.promise;
      if (!isCurrentGraphRequest(request)) {
        return;
      }
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
    } catch (caught) {
      if (!background && requestId !== graphRequestIdRef.current) {
        return;
      }
      if (!isCurrentGraphRequest(request) || isAbortError(caught) || request.controller.signal.aborted) {
        return;
      }
      if (!background) {
        setError(caught instanceof Error ? caught.message : "Graph request failed");
      }
    } finally {
      if (!background && requestId === graphRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [batchSlug, getOrStartGraphRequest, isCurrentGraphRequest, rememberGraph, topVoiceAudience]);

  useEffect(() => {
    return () => {
      if (scopeTransitionTimerRef.current !== null) {
        window.clearTimeout(scopeTransitionTimerRef.current);
      }
      invalidateGraphRequests();
      actionRequestIdRef.current += 1;
      activeActionAbortRef.current?.abort();
      activeActionAbortRef.current = null;
    };
  }, [invalidateGraphRequests]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let timeoutId: number | null = null;
    const scheduleDailyRefresh = () => {
      timeoutId = window.setTimeout(() => {
        invalidateGraphRequests();
        graphCacheRef.current.clear();
        void fetchGraph({ background: true, forceApi: true, unfiltered: true });
        scheduleDailyRefresh();
      }, Math.max(1_000, millisecondsUntilNextCentralMidnight() + MIDNIGHT_REFRESH_DELAY_MS));
    };

    scheduleDailyRefresh();

    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [fetchGraph, invalidateGraphRequests]);

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
        }, BACKGROUND_REVALIDATION_DELAY_MS);
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
        }, BACKGROUND_REVALIDATION_DELAY_MS);
        return () => window.clearTimeout(timeoutId);
      }
      return;
    }

    initialGraphHydratedRef.current = false;
    void fetchGraph({ unfiltered: true });
  }, [batchSlug, currentFilters, fetchGraph, filterMetadataGraph, initialGraph, topVoiceAudience]);

  useEffect(() => {
    const url = new URL(window.location.href);
    setUrlParameter(url, "batch", batchSlug === DEFAULT_BATCH_SLUG ? null : batchSlug);
    setUrlParameter(url, "topVoices", topVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE ? null : topVoiceAudience);
    setUrlParameter(url, "platforms", selectedPlatforms.length ? selectedPlatforms.join(",") : null);

    const nextLocation = `${url.pathname}${url.search}${url.hash}`;
    const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextLocation !== currentLocation) {
      window.history.replaceState(window.history.state, "", nextLocation);
    }
  }, [batchSlug, selectedPlatforms, topVoiceAudience]);

  const settledGraph = graphMatchesSelection(graph, batchSlug, topVoiceAudience) ? graph : null;
  const graphBusy = loading || scopeTransitioning;
  const graphScopeMismatch = graph !== null && settledGraph === null;
  const scopedFilterMetadataGraph = graphMatchesSelection(filterMetadataGraph, batchSlug, topVoiceAudience)
    ? filterMetadataGraph
    : null;
  const mapGraph = useMemo(
    () =>
      scopedFilterMetadataGraph
        ? applyClientGraphFilters(scopedFilterMetadataGraph, {
            platforms: [],
            industries: [],
            groupPartners: [],
            minScore
          })
        : graph,
    [graph, minScore, scopedFilterMetadataGraph]
  );
  const scopeSpecificFiltersDisabled = !settledGraph || !scopedFilterMetadataGraph;

  const activeSelectedNodeId = useMemo(() => {
    if (!mapGraph) {
      return null;
    }
    if (mapGraph.nodes.some((node) => node.id === selectedNodeId)) {
      return selectedNodeId;
    }
    return initialSelectedNodeId(mapGraph);
  }, [mapGraph, selectedNodeId]);

  useEffect(() => {
    if (!urlStateHydrated) {
      return;
    }
    const url = new URL(window.location.href);
    setUrlParameter(url, "batch", batchSlug === DEFAULT_BATCH_SLUG ? null : batchSlug);
    setUrlParameter(url, "topVoices", topVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE ? null : topVoiceAudience);
    setUrlParameter(url, "platforms", selectedPlatforms.length ? selectedPlatforms.join(",") : null);
    setUrlParameter(url, "industries", selectedIndustries.length ? selectedIndustries.join(",") : null);
    setUrlParameter(url, "groupPartners", selectedGroupPartners.length ? selectedGroupPartners.join(",") : null);
    setUrlParameter(url, "minScore", minScore > 0 ? String(minScore) : null);
    setUrlParameter(url, "node", activeSelectedNodeId);

    const nextLocation = `${url.pathname}${url.search}${url.hash}`;
    const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextLocation !== currentLocation) {
      window.history.replaceState(window.history.state, "", nextLocation);
    }
  }, [
    activeSelectedNodeId,
    batchSlug,
    minScore,
    selectedGroupPartners,
    selectedIndustries,
    selectedPlatforms,
    topVoiceAudience,
    urlStateHydrated
  ]);

  const selectedNode = useMemo(
    () => settledGraph ? mapGraph?.nodes.find((node) => node.id === activeSelectedNodeId) ?? null : null,
    [activeSelectedNodeId, mapGraph, settledGraph]
  );

  const selectedEvidence = useMemo(() => {
    if (!mapGraph || !selectedNode) {
      return [];
    }
    return selectedNodeEvidence(mapGraph, selectedNode)
      .filter((item) => selectedPlatforms.length === 0 || selectedPlatforms.includes(item.platform))
      .slice(0, 20);
  }, [mapGraph, selectedNode, selectedPlatforms]);

  const searchResults = useMemo(
    () => mapGraph
      ? searchGraphNodes(
          mapGraph.nodes,
          focusQuery,
          14,
          new Map(mapGraph.leaderboard.map((row) => [row.companyId, row.rank]))
        )
      : [],
    [focusQuery, mapGraph]
  );

  const relatedNodes = useMemo(() => {
    if (!settledGraph || !selectedNode) {
      return [];
    }
    return [];
  }, [selectedNode, settledGraph]);

  const selectNode = useCallback((nodeId: string, source: "graph" | "leaderboard" = "graph") => {
    const node = mapGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }
    setSelectedNodeId(nodeId);
    setHighlightedFounderId(null);
    setGraphFocusRevision((current) => current + 1);
    trackAnalyticsEvent("graph_node_opened", {
      node_type: node.entityType,
      source
    });
  }, [mapGraph]);

  const selectRankedNode = useCallback(
    (nodeId: string) => {
      selectNode(nodeId, "leaderboard");
      window.requestAnimationFrame(() => {
        dashboardGridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [selectNode]
  );

  const submitSearchTelemetry = useCallback(() => {
    const normalizedQuery = focusQuery.trim();
    if (!normalizedQuery || lastSubmittedQueryRef.current === normalizedQuery) {
      return;
    }
    lastSubmittedQueryRef.current = normalizedQuery;
    trackAnalyticsEvent("search_submitted", {
      result_count: searchResults.length,
      has_results: searchResults.length > 0
    });
  }, [focusQuery, searchResults.length]);

  const selectSearchResult = useCallback((result: GraphSearchResult) => {
    const node = mapGraph?.nodes.find((candidate) => candidate.id === result.companyNodeId);
    if (!node) {
      return;
    }
    submitSearchTelemetry();
    trackAnalyticsEvent("result_opened", {
      result_type: result.kind,
      position: Math.max(0, searchResults.findIndex((candidate) => candidate === result)) + 1
    });
    trackAnalyticsEvent("graph_node_opened", {
      node_type: node.entityType,
      source: "search"
    });
    setSelectedNodeId(result.companyNodeId);
    setHighlightedFounderId(result.kind === "founder" ? result.id : null);
    setSearchOpen(false);
    setGraphFocusRevision((current) => current + 1);
  }, [mapGraph, searchResults, submitSearchTelemetry]);

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

  const batches = scopedFilterMetadataGraph?.batches ?? graph?.batches ?? defaultBatches;
  const topVoiceAudiences = scopedFilterMetadataGraph?.topVoiceAudiences ?? graph?.topVoiceAudiences ?? defaultTopVoiceAudiences;

  const industryOptions = useMemo(() => {
    const byIndustry = new Map<string, { name: string; count: number; color: string }>();

    for (const node of scopedFilterMetadataGraph?.nodes ?? []) {
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
  }, [scopedFilterMetadataGraph]);

  const groupPartnerOptions = useMemo(() => {
    const byPartner = new Map<string, { name: string; count: number }>();

    for (const node of scopedFilterMetadataGraph?.nodes ?? []) {
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
  }, [batchSlug, scopedFilterMetadataGraph]);

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
    setActionLoading(action);
    setError(null);
    setRefreshError(null);
    setRefreshNotice(null);
    activeActionAbortRef.current?.abort();
    const controller = new AbortController();
    activeActionAbortRef.current = controller;

    try {
      const payload = await fetchWithTimeout<SuccessfulRefreshResponse>(
        "/api/graph/refresh",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action,
            batchSlug,
            platforms: selectedPlatforms,
            industries: [],
            groupPartners: [],
            minScore,
            topVoices: topVoiceAudience
          })
        },
        REFRESH_TIMEOUT_MS,
        (response) => readRefreshResponse(response, action),
        controller.signal
      );
      if (actionRequestId !== actionRequestIdRef.current) {
        return;
      }
      if (!graphMatchesSelection(payload.graph, batchSlug, topVoiceAudience)) {
        throw new Error(`${titleCase(action)} returned a graph for a different batch or audience.`);
      }
      const activeFilters = hasClientGraphFilters({
        platforms: selectedPlatforms,
        industries: [],
        groupPartners: [],
        minScore
      });
      invalidateGraphRequests();
      graphCacheRef.current.clear();
      setGraph(payload.graph);
      if (!activeFilters) {
        rememberGraph(payload.graph);
        setFilterMetadataGraph(payload.graph);
      } else {
        setFilterMetadataGraph(payload.graph);
        void fetchGraph({ background: true, forceApi: true, unfiltered: true });
      }
      const notice = refreshNoticeFor(action, payload);
      const refreshStatus = payload.status ?? payload.refreshSummary?.status;
      if (refreshStatus === "failed") {
        setRefreshError(payload.errors?.[0] ?? notice ?? `${action} finished without visible evidence`);
      } else {
        setRefreshError(null);
        setRefreshNotice(notice);
      }
    } catch (caught) {
      if (actionRequestId !== actionRequestIdRef.current) {
        return;
      }
      const rawMessage = caught instanceof Error ? caught.message : `${titleCase(action)} request failed.`;
      const message = rawMessage.includes("timed out")
        ? `${titleCase(action)} timed out and was cancelled. Try again with a narrower platform selection.`
        : rawMessage;
      setRefreshNotice(null);
      setRefreshError(message);
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
    const removing = selectedPlatforms.includes(platform);
    const next = removing ? selectedPlatforms.filter((item) => item !== platform) : [...selectedPlatforms, platform];
    setSelectedPlatforms(next);
    trackFilterChange("platform", removing ? "removed" : "added", next.length);
  }

  function toggleIndustry(industry: string) {
    const removing = selectedIndustries.includes(industry);
    const next = removing ? selectedIndustries.filter((item) => item !== industry) : [...selectedIndustries, industry];
    setSelectedIndustries(next);
    trackFilterChange("industry", removing ? "removed" : "added", next.length);
  }

  function toggleGroupPartner(groupPartner: string) {
    const removing = selectedGroupPartners.includes(groupPartner);
    const next = removing
      ? selectedGroupPartners.filter((item) => item !== groupPartner)
      : [...selectedGroupPartners, groupPartner];
    setSelectedGroupPartners(next);
    trackFilterChange("group_partner", removing ? "removed" : "added", next.length);
  }

  function commitMinScore(value: number) {
    const nextScore = clampScore(value);
    setMinScoreDraft(nextScore);
    if (minScore !== nextScore) {
      setMinScore(nextScore);
      trackFilterChange("min_score", nextScore === 0 ? "cleared" : "set", nextScore === 0 ? 0 : 1);
    }
  }

  function trackFilterChange(
    filter: AnalyticsEventPayloads["filter_changed"]["filter"],
    action: AnalyticsEventPayloads["filter_changed"]["action"],
    selectionCount: number
  ) {
    trackAnalyticsEvent("filter_changed", { filter, action, selection_count: selectionCount });
  }

  function clearFilter(filter: "platform" | "industry" | "group_partner") {
    const selectedCount = filter === "platform"
      ? selectedPlatforms.length
      : filter === "industry"
        ? selectedIndustries.length
        : selectedGroupPartners.length;
    if (selectedCount > 0) {
      trackFilterChange(filter, "cleared", 0);
    }
    if (filter === "platform") setSelectedPlatforms([]);
    if (filter === "industry") setSelectedIndustries([]);
    if (filter === "group_partner") setSelectedGroupPartners([]);
  }

  function shareEventContext() {
    return {
      included_filters: hasClientGraphFilters(currentFilters) || selectedIndustries.length > 0 || selectedGroupPartners.length > 0,
      included_node: Boolean(activeSelectedNodeId)
    };
  }

  async function copyViewLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2_000);
      trackAnalyticsEvent("share_copied", { method: "clipboard", ...shareEventContext() });
    } catch {
      // Clipboard permissions can be denied; leave the dashboard unchanged.
    }
  }

  async function shareView() {
    if (typeof navigator.share !== "function") {
      await copyViewLink();
      return;
    }
    try {
      await navigator.share({ title: brandTitle, url: window.location.href });
      trackAnalyticsEvent("social_share", { method: "native", ...shareEventContext() });
    } catch {
      // Cancellation and platform share failures are intentionally not tracked.
    }
  }

  const visibleCompanyCount = mapGraph?.nodes.filter((node) => node.entityType === "company").length ?? 0;
  const graphIsEmpty = Boolean(mapGraph) && visibleCompanyCount === 0;
  const activeClientFilters = hasClientGraphFilters(currentFilters);
  const graphEmptyTitle = activeClientFilters
    ? "No companies match the active filters."
    : topVoiceAudience !== DEFAULT_TOP_VOICE_AUDIENCE
      ? "No verified audience traction is available."
      : "No companies are available in this graph.";
  const graphEmptyDetail = activeClientFilters
    ? "No company in this batch and audience satisfies every selected constraint."
    : topVoiceAudience !== DEFAULT_TOP_VOICE_AUDIENCE
      ? `${graph?.selectedTopVoiceAudience?.displayName ?? "This Top Voices audience"} has no visible company evidence in this snapshot.`
      : graph?.batch.label ?? "The selected graph contains no company records.";
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
              <Image
                src="/brand/a16z-speedrun-logo.png"
                alt="a16z speedrun"
                width={619}
                height={193}
                unoptimized
              />
            </span>
          ) : (
            <span className="yc-brand-mark" aria-hidden="true">Y</span>
          )}
          <div>
            <h1>{brandTitle}</h1>
          </div>
        </div>

        <div className="focus-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={searchInputRef}
            aria-autocomplete="list"
            aria-controls="dashboard-search-results"
            aria-expanded={searchOpen && Boolean(focusQuery.trim())}
            aria-label="Search companies and founders"
            role="combobox"
            value={focusQuery}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => {
              setFocusQuery(event.target.value);
              setSearchOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                submitSearchTelemetry();
              }
            }}
            placeholder="Search companies and founders"
          />
          <kbd>Ctrl K</kbd>
          {searchOpen && focusQuery.trim() && (
            <div className="focus-search-results" id="dashboard-search-results" role="listbox">
              {searchResults.map((result) => (
                <button
                  type="button"
                  key={`${result.kind}:${result.id}`}
                  onClick={() => selectSearchResult(result)}
                  role="option"
                  aria-selected="false"
                >
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
              <select
                value={batchSlug}
                onChange={(event) => {
                  const nextBatchSlug = event.target.value;
                  if (nextBatchSlug !== batchSlug) {
                    trackFilterChange("batch", "set", 1);
                  }
                  transitionGraphScope(nextBatchSlug, topVoiceAudience);
                }}
              >
                {batches.map((batch) => (
                  <option key={batch.slug} value={batch.slug}>
                    {batch.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="control-cluster control-cluster-actions">
            <button type="button" onClick={() => void shareView()} title="Share view" aria-label="Share view">
              <Share2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => void copyViewLink()}
              title={linkCopied ? "Link copied" : "Copy link"}
              aria-label={linkCopied ? "Link copied" : "Copy link"}
            >
              {linkCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            </button>
          </div>

          {manualRefreshEnabled && (
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
          )}
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
          onClear={() => clearFilter("platform")}
        />

        <FilterDropdown
          id="industry"
          icon={<Palette size={15} />}
          title="Industry"
          allLabel="All industries"
          selectedValues={selectedIndustries}
          options={industryDropdownOptions}
          isOpen={openFilterMenu === "industry"}
          disabled={scopeSpecificFiltersDisabled}
          onOpenChange={(open) => setOpenFilterMenu(open ? "industry" : null)}
          onToggle={toggleIndustry}
          onClear={() => clearFilter("industry")}
        />

        <FilterDropdown
          id="groupPartner"
          icon={<Filter size={15} />}
          title="Group partner"
          allLabel="All group partners"
          selectedValues={selectedGroupPartners}
          options={groupPartnerDropdownOptions}
          isOpen={openFilterMenu === "groupPartner"}
          disabled={scopeSpecificFiltersDisabled}
          onOpenChange={(open) => setOpenFilterMenu(open ? "groupPartner" : null)}
          onToggle={toggleGroupPartner}
          onClear={() => clearFilter("group_partner")}
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
          onOpenChange={(open) => setOpenFilterMenu(open ? "topVoices" : null)}
          onSelect={(value) => {
            const nextTopVoiceAudience = normalizeTopVoiceAudienceId(value);
            if (nextTopVoiceAudience !== topVoiceAudience) {
              trackFilterChange("top_voices", nextTopVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE ? "cleared" : "set", nextTopVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE ? 0 : 1);
            }
            transitionGraphScope(batchSlug, nextTopVoiceAudience);
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
                if (minScore !== 0) {
                  trackFilterChange("min_score", "cleared", 0);
                }
              }}
              disabled={minScoreDraft === 0 && minScore === 0}
            >
              Reset
            </button>
          </div>
        </div>
      </section>

      {((error && graph) || refreshError || refreshNotice) && (
        <section className="status-line" aria-live="polite">
          {error && graph && <span className="error-text">{error}</span>}
          {error && graphScopeMismatch && !graphBusy && (
            <button type="button" onClick={() => void fetchGraph({ unfiltered: true })}>
              <RefreshCw size={15} aria-hidden="true" />
              Retry selected graph
            </button>
          )}
          {refreshError && <span className="error-text">{refreshError}</span>}
          {refreshNotice && <span className="refresh-notice-text">{refreshNotice}</span>}
        </section>
      )}

      {graphScopeMismatch && graphBusy && (
        <div className="sr-only" role="status">
          Loading the selected graph. The previous graph remains visible, but its controls are unavailable.
        </div>
      )}
      <div role="region" aria-label="Network map results" aria-busy={graphBusy}>
        <section
          className="dashboard-grid"
          ref={dashboardGridRef}
          inert={graphScopeMismatch}
        >
          <div className="graph-column">
            {graphIsEmpty ? (
              <div className="graph-empty-state">
                <strong>{graphEmptyTitle}</strong>
                <span>{graphEmptyDetail}</span>
              </div>
            ) : mapGraph ? (
              <CytoscapeGraph
                nodes={mapGraph.nodes}
                edges={mapGraph.edges}
                batch={mapGraph.batch}
                selectedNodeId={activeSelectedNodeId}
                focusRevision={graphFocusRevision}
                focusedPlatforms={selectedPlatforms}
                focusedIndustries={selectedIndustries}
                focusedGroupPartners={selectedGroupPartners}
                onSelectNode={selectNode}
              />
            ) : (
              <div className="graph-empty-state">
                <strong>{graphBusy ? `Loading ${loadingMapLabel} map...` : "Graph unavailable"}</strong>
                <span>
                  {graphBusy
                    ? "Fetching companies, traction evidence, filters, and graph links."
                    : error ?? "The selected graph could not be loaded."}
                </span>
                {!graphBusy && error && (
                  <button type="button" onClick={() => void fetchGraph({ unfiltered: true })}>
                    <RefreshCw size={15} aria-hidden="true" />
                    Retry selected graph
                  </button>
                )}
              </div>
            )}
            {graphBusy && graph && (
              <div className="overlay-status" role="status">
                <RefreshCw size={14} className="spin" aria-hidden="true" />
                Refreshing graph
              </div>
            )}
          </div>
          <NodePanel
            node={selectedNode}
            relatedNodes={relatedNodes}
            evidence={selectedEvidence}
            highlightedFounderId={highlightedFounderId}
          />
          {settledGraph && (
            <InsightsTabs
              graph={settledGraph}
              statsGraph={scopedFilterMetadataGraph ?? settledGraph}
              onSelectNode={selectRankedNode}
            />
          )}
        </section>
      </div>
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
  disabled?: boolean;
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
  disabled = false,
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
        disabled={disabled}
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const selectedOption = options.find((option) => option.value === selectedValue);
  const menuId = `${id}-filter-menu`;
  const entries = [
    { value: allValue, label: allLabel },
    ...options
  ];
  const entryCount = entries.length;

  useEffect(() => {
    if (!isOpen || pendingFocusIndexRef.current === null) {
      return;
    }
    const focusIndex = pendingFocusIndexRef.current;
    pendingFocusIndexRef.current = null;
    optionRefs.current[focusIndex]?.focus();
  }, [entryCount, isOpen]);

  function focusOption(index: number) {
    const normalizedIndex = (index + entryCount) % entryCount;
    optionRefs.current[normalizedIndex]?.focus();
  }

  function openAndFocus(index: number) {
    if (isOpen) {
      focusOption(index);
      return;
    }
    pendingFocusIndexRef.current = index;
    onOpenChange(true);
  }

  function selectAndRestoreFocus(value: T) {
    onSelect(value);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Home") {
      event.preventDefault();
      openAndFocus(0);
    } else if (event.key === "ArrowUp" || event.key === "End") {
      event.preventDefault();
      openAndFocus(entryCount - 1);
    }
  }

  function handleOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number, value: T) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(entryCount - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectAndRestoreFocus(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className={`filter-dropdown ${isOpen ? "open" : ""}`}>
      <span className="filter-dropdown-label">
        {icon}
        {title}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-dropdown-trigger ${selectedValue !== allValue ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => onOpenChange(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedOption?.label ?? allLabel}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="filter-dropdown-menu" id={menuId} role="menu">
          {entries.map((option, index) => {
            const selected = selectedValue === option.value;
            return (
              <button
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`filter-menu-option ${selected ? "selected" : ""}`}
                key={option.value}
                onClick={() => selectAndRestoreFocus(option.value)}
                onKeyDown={(event) => handleOptionKeyDown(event, index, option.value)}
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
