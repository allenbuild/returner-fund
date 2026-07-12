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
const STATIC_GRAPH_SNAPSHOT_VERSION = "2026-07-12-a16z-labels";
const DEFAULT_TOP_VOICE_AUDIENCE: TopVoiceAudienceId = "off";
const defaultTopVoiceAudiences = topVoiceAudienceSummaries();

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchGraphPayload(
  url: string,
  attempts = 3,
  options: { cache?: RequestCache; signal?: AbortSignal } = {}
): Promise<GraphResponse> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: options.cache ?? "no-store", signal: options.signal });
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

interface DashboardProps {
  initialGraph?: GraphResponse;
  initialBatchSlug?: string;
  initialFilters?: Partial<ClientGraphFilters>;
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
  if (typeof window !== "undefined") {
    const urlBatchSlug = normalizeBatchSlug(new URLSearchParams(window.location.search).get("batch"));
    if (urlBatchSlug) {
      return urlBatchSlug;
    }
  }
  return graph?.batch.slug ?? DEFAULT_BATCH_SLUG;
}

function initialTopVoiceAudience(graph: GraphResponse | undefined): TopVoiceAudienceId {
  if (typeof window !== "undefined") {
    return normalizeTopVoiceAudienceId(new URLSearchParams(window.location.search).get("topVoices"));
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
  const propPlatforms = normalizeInitialPlatforms(initialFilters?.platforms);
  if (propPlatforms.length || typeof window === "undefined") {
    return propPlatforms;
  }

  return normalizeInitialPlatforms(
    new URLSearchParams(window.location.search)
      .get("platforms")
      ?.split(",")
      .map((item) => item.trim() as Platform)
  );
}

function normalizeBatchSlug(value: string | null | undefined): string | null {
  const slug = String(value ?? "").trim();
  return defaultBatches.some((batch) => batch.slug === slug) ? slug : null;
}

function staticGraphSnapshotUrl(batchSlug: string, topVoiceAudience: TopVoiceAudienceId): string | null {
  if (topVoiceAudience !== DEFAULT_TOP_VOICE_AUDIENCE) {
    return null;
  }
  const filenames: Record<string, string> = {
    A16ZSR006: "a16zsr006.json",
    S2026: "s2026.json",
    S26: "s26.json"
  };
  const filename = filenames[batchSlug];
  return filename ? `/graph/${filename}?v=${STATIC_GRAPH_SNAPSHOT_VERSION}` : null;
}

export function Dashboard({ initialGraph, initialBatchSlug: initialBatchSlugProp, initialFilters }: DashboardProps = {}) {
  const [batchSlug, setBatchSlug] = useState(() => initialBatchSlug(initialGraph, initialBatchSlugProp));
  const [topVoiceAudience, setTopVoiceAudience] = useState<TopVoiceAudienceId>(() => initialTopVoiceAudience(initialGraph));
  const [graph, setGraph] = useState<GraphResponse | null>(initialGraph ?? null);
  const [filterMetadataGraph, setFilterMetadataGraph] = useState<GraphResponse | null>(initialGraph ?? null);
  const graphCacheRef = useRef<Map<string, GraphResponse>>(
    new Map(
      initialGraph
        ? [[graphCacheKey(initialGraph.batch.slug, initialGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE), initialGraph]]
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filterBandRef = useRef<HTMLElement | null>(null);
  const dashboardGridRef = useRef<HTMLElement | null>(null);
  const graphRequestIdRef = useRef(0);
  const activeGraphAbortRef = useRef<AbortController | null>(null);
  const actionRequestIdRef = useRef(0);
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

  const rememberGraph = useCallback((payload: GraphResponse) => {
    graphCacheRef.current.set(
      graphCacheKey(payload.batch.slug, payload.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE),
      payload
    );
  }, []);

  const fetchGraph = useCallback(async (options: { background?: boolean; unfiltered?: boolean } = {}) => {
    const background = options.background === true;
    const requestFilters = options.unfiltered
      ? { platforms: [], industries: [], groupPartners: [], minScore: 0 }
      : currentFiltersRef.current;
    const requestId = graphRequestIdRef.current + 1;
    graphRequestIdRef.current = requestId;
    if (!background) {
      setLoading(true);
    }
    setError(null);
    activeGraphAbortRef.current?.abort();
    const controller = new AbortController();
    activeGraphAbortRef.current = controller;

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
      const staticSnapshotUrl = options.unfiltered ? staticGraphSnapshotUrl(batchSlug, topVoiceAudience) : null;
      const payload = await fetchGraphPayload(staticSnapshotUrl ?? `/api/graph?${params.toString()}`, 3, {
        cache: staticSnapshotUrl ? "force-cache" : "no-store",
        signal: controller.signal
      });
      if (options.unfiltered) {
        rememberGraph(payload);
      }
      if (requestId !== graphRequestIdRef.current) {
        return;
      }
      if (options.unfiltered) {
        setFilterMetadataGraph(payload);
      }
      setGraph(options.unfiltered ? applyClientGraphFilters(payload, currentFiltersRef.current) : payload);
    } catch (caught) {
      if (requestId !== graphRequestIdRef.current) {
        return;
      }
      if (isAbortError(caught) || controller.signal.aborted) {
        return;
      }
      if (!background) {
        setError(caught instanceof Error ? caught.message : "Graph request failed");
      }
    } finally {
      if (activeGraphAbortRef.current === controller) {
        activeGraphAbortRef.current = null;
      }
      if (!background && requestId === graphRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [batchSlug, rememberGraph, topVoiceAudience]);

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
      rememberGraph(
        await fetchGraphPayload(staticSnapshotUrl ?? `/api/graph?${params.toString()}`, 2, {
          cache: staticSnapshotUrl ? "force-cache" : "no-store"
        })
      );
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
    };
  }, []);

  useEffect(() => {
    const cachedGraph =
      graphMatchesSelection(filterMetadataGraph, batchSlug, topVoiceAudience)
        ? filterMetadataGraph
        : graphCacheRef.current.get(graphCacheKey(batchSlug, topVoiceAudience));

    if (cachedGraph) {
      if (!graphMatchesSelection(filterMetadataGraph, cachedGraph.batch.slug, cachedGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE)) {
        graphRequestIdRef.current += 1;
        setFilterMetadataGraph(cachedGraph);
      }

      setGraph(applyClientGraphFilters(cachedGraph, currentFilters));
      setError(null);
      setLoading(false);

      if (
        initialGraphHydratedRef.current &&
        initialGraph &&
        batchSlug === initialGraph.batch.slug &&
        topVoiceAudience === (initialGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE)
      ) {
        initialGraphHydratedRef.current = false;
        const timeoutId = window.setTimeout(() => {
          void fetchGraph({ background: true, unfiltered: true });
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
    setActionLoading(null);
  }, [batchSlug, topVoiceAudience]);

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
    setActionLoading(action);
    setError(null);

    try {
      const response = await fetch("/api/graph/refresh", {
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
      });

      if (!response.ok) {
        throw new Error(`${action} request failed with ${response.status}`);
      }

      const payload = (await response.json()) as { graph: GraphResponse };
      if (actionRequestId !== actionRequestIdRef.current) {
        return;
      }

      setGraph(payload.graph);
      if (!selectedPlatforms.length && !selectedIndustries.length && !selectedGroupPartners.length && minScore === 0) {
        rememberGraph(payload.graph);
        setFilterMetadataGraph(payload.graph);
      }
    } catch (caught) {
      if (actionRequestId !== actionRequestIdRef.current) {
        return;
      }
      setError(caught instanceof Error ? caught.message : `${action} request failed`);
    } finally {
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

      {error && (
        <section className="status-line" aria-live="polite">
          <span className="error-text">{error}</span>
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
