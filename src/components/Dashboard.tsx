"use client";

import {
  Check,
  ChevronDown,
  Copy,
  Filter,
  Layers3,
  Palette,
  RefreshCw,
  Search,
  Share2,
  Tags,
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
import { InsidersPanel, type InsidersPanelHandle } from "./InsidersPanel";
import { NodePanel } from "./NodePanel";
import { formatPlatform, PlatformLogo } from "./PlatformLogo";
import { TopStoriesDashboard } from "./dashboard/TopStoriesDashboard";
import { trackAnalyticsEvent, type AnalyticsEventPayloads } from "@/lib/analytics";
import type { DashboardPublicFeedSnapshot } from "@/lib/dashboard/contracts";
import { applyClientGraphFilters, type ClientGraphFilters } from "@/lib/graph/client-filters";
import {
  COMPANY_VERTICALS,
  isCompanyVertical,
  normalizeCompanyVerticals,
  type CompanyVertical
} from "@/lib/graph/company-verticals";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { topicPostFacetCounts } from "@/lib/graph/filter-facets";
import {
  companyVerticalCounts,
  enrichGraphTaxonomies
} from "@/lib/graph/graph-taxonomies";
import { initialSelectedNodeId } from "@/lib/graph/initial-selection";
import {
  topicFacetRowsForAudience,
  withTopicFacetRows
} from "@/lib/graph/topic-facets";
import {
  isTopicFacetBatchSlug,
  loadCurrentTopicFacetSnapshot
} from "@/lib/graph/topic-facet-snapshot-loader";
import { networkMapTitle } from "@/lib/graph/network-map-branding";
import {
  normalizePostTopics,
  POST_TOPIC_TAXONOMY,
  type PostTopic,
  type PostTopicGroup
} from "@/lib/graph/post-topics";
import { TOP_POSTS_LIMIT } from "@/lib/graph/presentation-limits";
import {
  loadRankedPostsSidecarForGraph,
  rankedPostsSidecarScopeForGraph,
  type RankedPostsGraphTarget
} from "@/lib/graph/ranked-posts-sidecar-loader";
import { searchGraphNodes, type GraphSearchResult } from "@/lib/graph/search";
import { validateStaticGraphSnapshotContract } from "@/lib/graph/static-graph-snapshot-contract.mjs";
import {
  centralDayKey,
  millisecondsUntilNextCentralMidnight
} from "@/lib/time/central-day";
import { normalizeTopVoiceAudienceId, topVoiceAudienceSummaries } from "@/lib/social/top-voices";
import {
  insiderAccessToken,
  insiderApiFetch,
  subscribeToInsiderAuth
} from "@/lib/social/user-insiders-client";
import { PLATFORM_VALUES, type GraphResponse, type Platform, type TopVoiceAudienceId } from "@/lib/graph/types";
import type { YcPartnersResponse } from "@/lib/yc-partners/favorite-contracts";

type FilterMenuId = "platform" | "topics" | "verticals" | "industry" | "groupPartner" | "topVoices";
export type DashboardSurface = "map" | "top100";

interface DropdownOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  color?: string;
  platform?: Platform;
  disabled?: boolean;
  description?: string;
  searchText?: string;
}

interface DropdownOptionGroup<T extends string> {
  id: string;
  label: string;
  values: readonly T[];
}

const platformOptions: Platform[] = [...PLATFORM_VALUES];

const defaultBatches = [
  { slug: "S2026", label: "YC Spring 2026 (P26)", companyCountExpected: 197, companyCountObserved: 197 },
  { slug: "S26", label: "YC Summer 2026 (S26)" },
  { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
];
const DEFAULT_BATCH_SLUG = "S2026";
const A16Z_SPEEDRUN_BATCH_SLUG = "A16ZSR006";
const STATIC_GRAPH_SNAPSHOT_VERSION = "2026-07-31-date-invariant-scoring";
const MIDNIGHT_REFRESH_DELAY_MS = 90_000;
const STATIC_GRAPH_TIMEOUT_MS = 8_000;
const API_GRAPH_TIMEOUT_MS = 20_000;
const YC_PARTNERS_TIMEOUT_MS = 15_000;
const YC_PARTNERS_INITIAL_LOAD_DELAY_MS = 2_000;
const YC_PARTNERS_REVALIDATION_INTERVAL_MS = 60_000;
const REFRESH_TIMEOUT_MS = 45_000;
const BACKGROUND_REVALIDATION_DELAY_MS = 30_000;
const IMMEDIATE_MOMENTUM_REVALIDATION_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
const RESUME_REVALIDATION_COOLDOWN_MS = 60_000;
export const RESUME_REVALIDATION_SCOPE_MAX_ENTRIES = 24;
const SCOPE_TRANSITION_MINIMUM_MS = 650;
const MAP_BASELINE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const DEFAULT_TOP_VOICE_AUDIENCE: TopVoiceAudienceId = "off";
const defaultTopVoiceAudiences = topVoiceAudienceSummaries();
const TOPIC_FILTER_GROUP_ORDER = [
  "Business progress",
  "Product & technical",
  "Company narrative",
  "Ecosystem",
  "Other"
] as const satisfies readonly PostTopicGroup[];

export function recordResumeRevalidationAt(
  cache: Map<string, number>,
  graphKey: string,
  refreshedAt: number
): void {
  cache.delete(graphKey);
  cache.set(graphKey, refreshedAt);
  while (cache.size > RESUME_REVALIDATION_SCOPE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function graphNeedsImmediateMomentumRevalidation(
  graph: Pick<GraphResponse, "generatedAt" | "fastestGaining">,
  now = new Date()
): boolean {
  const generatedAt = Date.parse(graph.generatedAt);
  const age = now.getTime() - generatedAt;
  if (
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(now.getTime()) ||
    age < 0 ||
    age > IMMEDIATE_MOMENTUM_REVALIDATION_MAX_AGE_MS ||
    graph.fastestGaining.length === 0
  ) {
    return false;
  }

  const hasDayComparison = graph.fastestGaining.some((row) =>
    row.dod.baselineScore !== null && row.dod.baselineRank !== null
  );
  const hasWeekComparison = graph.fastestGaining.some((row) =>
    row.wow.baselineScore !== null && row.wow.baselineRank !== null
  );
  return !hasDayComparison && !hasWeekComparison;
}

const TOPIC_FILTER_GROUPS: readonly DropdownOptionGroup<PostTopic>[] = TOPIC_FILTER_GROUP_ORDER.map((label) => ({
  id: label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  label,
  values: POST_TOPIC_TAXONOMY.filter((topic) => topic.group === label).map((topic) => topic.slug)
}));

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchGraphPayload(
  url: string,
  attempts = 3,
  options: { cache?: RequestCache; signal?: AbortSignal; timeoutMs?: number; accessToken?: string | null } = {}
): Promise<GraphResponse> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(
        url,
        {
          cache: options.cache ?? "no-store",
          headers: options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : undefined
        },
        options.timeoutMs ?? API_GRAPH_TIMEOUT_MS,
        async (response) => {
          if (!response.ok) {
            throw await graphResponseError(response);
          }
          return enrichGraphTaxonomies((await response.json()) as GraphResponse);
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

async function graphResponseError(response: Response): Promise<Error> {
  const contentType = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
  const requestId =
    response.headers?.get?.("x-vercel-id")?.trim() ||
    response.headers?.get?.("x-request-id")?.trim() ||
    null;
  let detail: string | null = null;

  if (contentType.includes("json") || !contentType) {
    try {
      detail = graphErrorPayloadDetail(await response.json());
    } catch {
      // A proxy or framework error page may claim an empty or incorrect content type.
    }
  }

  if (!detail && !contentType.includes("json") && typeof response.text === "function") {
    try {
      const body = (await response.text()).replace(/\s+/g, " ").trim();
      if (body && !/<(?:!doctype|html|head|body)\b/i.test(body)) {
        detail = body.slice(0, 400);
      }
    } catch {
      // The status and request identifier still provide an actionable failure.
    }
  }

  const message = [
    `Graph request failed with ${response.status}`,
    detail ? `: ${detail}` : "",
    requestId ? ` (request ID: ${requestId})` : ""
  ].join("");
  return new Error(message);
}

function graphErrorPayloadDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim();
  }
  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>;
    const code = typeof error.code === "string" ? error.code.trim() : "";
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (code && message) return `[${code}] ${message}`;
    if (message) return message;
    if (code) return code;
  }
  return typeof record.message === "string" && record.message.trim()
    ? record.message.trim()
    : null;
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
        cache: "no-store",
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

  const accessToken = await insiderAccessToken();
  const apiGraph = await fetchGraphPayload(apiUrl, attempts, {
    cache: "no-store",
    timeoutMs: API_GRAPH_TIMEOUT_MS,
    signal: options.signal,
    accessToken
  });
  if (!graphMatchesSelection(apiGraph, options.expectedBatchSlug, options.expectedTopVoiceAudience)) {
    throw new Error("Graph response does not match the selected graph scope");
  }

  return {
    graph: apiGraph,
    source: "api"
  };
}

async function hydrateGraphTopicFacets(
  graph: GraphResponse,
  batchSlug: string,
  audienceId: TopVoiceAudienceId,
  signal?: AbortSignal
): Promise<GraphResponse> {
  if (!isTopicFacetBatchSlug(batchSlug)) return graph;
  try {
    const snapshot = await loadCurrentTopicFacetSnapshot(batchSlug, { signal });
    return withTopicFacetRows(graph, topicFacetRowsForAudience(snapshot, audienceId));
  } catch (caught) {
    if (isAbortError(caught) || signal?.aborted) throw caught;
    return graph;
  }
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

type YcPartnersApiPayload = YcPartnersResponse | { error?: unknown; message?: unknown };

async function fetchYcPartnersPayload(batchSlug: string, signal?: AbortSignal): Promise<YcPartnersResponse> {
  return fetchWithTimeout(
    `/api/yc-partners?batch=${encodeURIComponent(batchSlug)}`,
    {
      cache: "no-store",
      headers: { accept: "application/json" }
    },
    YC_PARTNERS_TIMEOUT_MS,
    async (response) => {
      const payload = (await response.json().catch(() => null)) as YcPartnersApiPayload | null;
      if (!response.ok) {
        throw new Error(ycPartnersErrorDetail(payload) ?? "YC partner favorites are temporarily unavailable.");
      }
      if (!isYcPartnersResponsePayload(payload)) {
        throw new Error("YC partner favorites returned an invalid response.");
      }
      return payload;
    },
    signal
  );
}

function isYcPartnersResponsePayload(value: unknown): value is YcPartnersResponse {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<YcPartnersResponse>;
  return Boolean(
    typeof payload.generatedAt === "string" &&
      typeof payload.modelVersion === "string" &&
      typeof payload.modelName === "string" &&
      typeof payload.batchCount === "number" &&
      typeof payload.companyCount === "number" &&
      typeof payload.partnerCount === "number" &&
      Array.isArray(payload.partners)
  );
}

function ycPartnersErrorDetail(payload: YcPartnersApiPayload | null): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  return typeof record.message === "string" && record.message.trim() ? record.message.trim() : null;
}

interface DashboardProps {
  initialDashboardSnapshot?: DashboardPublicFeedSnapshot | null;
  initialGraph?: GraphResponse;
  initialBatchSlug?: string;
  initialTopVoiceAudience?: TopVoiceAudienceId;
  initialFilters?: Partial<ClientGraphFilters>;
  initialSurface?: DashboardSurface;
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

interface FetchGraphOptions {
  background?: boolean;
  forceApi?: boolean;
  unfiltered?: boolean;
  insiderIds?: string[];
  propagateError?: boolean;
}

interface InsiderRecomputeResponse {
  configurationVersion?: unknown;
  graph?: unknown;
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

function graphCacheKey(
  batchSlug: string,
  topVoiceAudience: TopVoiceAudienceId,
  insiderIds: readonly string[] = []
): string {
  return `${batchSlug}::${topVoiceAudience}::${[...insiderIds].sort().join(",")}`;
}

function graphMatchesSelection(
  graph: GraphResponse | null | undefined,
  batchSlug: string,
  topVoiceAudience: TopVoiceAudienceId
): graph is GraphResponse {
  return graph?.batch.slug === batchSlug && (graph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE) === topVoiceAudience;
}

function graphMatchesInsiderSelection(
  graph: GraphResponse | null | undefined,
  audience: TopVoiceAudienceId,
  insiderIds: readonly string[]
): boolean {
  return audience !== "insiders" || sameValues(graph?.selectedInsiderIds ?? [], insiderIds);
}

function overlayPersonalizedGraphOnBaseline(
  baselineGraph: GraphResponse,
  personalizedGraph: GraphResponse
): GraphResponse {
  const personalizedNodesById = new Map(
    personalizedGraph.nodes.map((node) => [node.id, node])
  );
  const baselineNodeIds = new Set(baselineGraph.nodes.map((node) => node.id));
  const nodes = baselineGraph.nodes.map(
    (node) => personalizedNodesById.get(node.id) ?? node
  );
  for (const node of personalizedGraph.nodes) {
    if (!baselineNodeIds.has(node.id)) nodes.push(node);
  }

  const personalizedEdgesById = new Map(
    personalizedGraph.edges.map((edge) => [edge.id, edge])
  );
  const baselineEdgeIds = new Set(baselineGraph.edges.map((edge) => edge.id));
  const edges = baselineGraph.edges.map(
    (edge) => personalizedEdgesById.get(edge.id) ?? edge
  );
  for (const edge of personalizedGraph.edges) {
    if (!baselineEdgeIds.has(edge.id)) edges.push(edge);
  }

  return {
    ...baselineGraph,
    ...personalizedGraph,
    nodes,
    edges
  };
}

function isGraphResponsePayload(value: unknown): value is GraphResponse {
  if (!value || typeof value !== "object") return false;
  const graph = value as Partial<GraphResponse>;
  return Boolean(
    graph.batch?.slug &&
    graph.selectedTopVoiceAudience?.id &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.edges) &&
    Array.isArray(graph.evidence) &&
    Array.isArray(graph.leaderboard)
  );
}

function normalizeInitialPlatforms(platforms: Platform[] | undefined): Platform[] {
  if (!platforms?.length) {
    return [];
  }

  const allowed = new Set(platformOptions);
  return [...new Set(platforms.filter((platform) => allowed.has(platform)))];
}

function normalizeInitialTopics(topics: PostTopic[] | undefined): PostTopic[] {
  return normalizePostTopics(topics ?? []);
}

function normalizeInitialVerticals(verticals: CompanyVertical[] | undefined): CompanyVertical[] {
  return normalizeCompanyVerticals(verticals ?? [], COMPANY_VERTICALS.length);
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

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function queryTopics(params: URLSearchParams): PostTopic[] {
  return normalizePostTopics(queryList(params, "topics"));
}

function queryVerticals(params: URLSearchParams): CompanyVertical[] {
  return normalizeCompanyVerticals(
    queryList(params, "verticals").filter(isCompanyVertical),
    COMPANY_VERTICALS.length
  );
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
      (filters.topics?.length ?? 0) > 0 ||
      (filters.verticals?.length ?? 0) > 0 ||
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
  initialDashboardSnapshot = null,
  initialGraph,
  initialBatchSlug: initialBatchSlugProp,
  initialTopVoiceAudience: initialTopVoiceAudienceProp,
  initialFilters,
  initialSurface = "map",
  manualRefreshEnabled = true
}: DashboardProps = {}) {
  const preparedInitialGraph = useMemo(
    () => initialGraph ? enrichGraphTaxonomies(initialGraph) : undefined,
    [initialGraph]
  );
  const [surface, setSurface] = useState<DashboardSurface>(initialSurface);
  const [batchSlug, setBatchSlug] = useState(() => initialBatchSlug(preparedInitialGraph, initialBatchSlugProp));
  const [topVoiceAudience, setTopVoiceAudience] = useState<TopVoiceAudienceId>(() =>
    initialTopVoiceAudience(preparedInitialGraph, initialTopVoiceAudienceProp)
  );
  const [graph, setGraph] = useState<GraphResponse | null>(preparedInitialGraph ?? null);
  const [filterMetadataGraph, setFilterMetadataGraph] = useState<GraphResponse | null>(preparedInitialGraph ?? null);
  const [rankedPostsSidecarState, setRankedPostsSidecarState] = useState<{
    batchSlug: string;
    audienceId: TopVoiceAudienceId;
    generatedAt: string;
    scope: NonNullable<ReturnType<typeof rankedPostsSidecarScopeForGraph>>;
  } | null>(null);
  const [mapMetadataGraph, setMapMetadataGraph] = useState<GraphResponse | null>(() =>
    (preparedInitialGraph?.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE) === DEFAULT_TOP_VOICE_AUDIENCE
      ? preparedInitialGraph ?? null
      : null
  );
  const [mapBaselineRetry, setMapBaselineRetry] = useState<{ batchSlug: string; attempt: number } | null>(null);
  const graphCacheRef = useRef<Map<string, CachedGraphEntry>>(
    new Map(
      preparedInitialGraph
        ? [
            [
              graphCacheKey(preparedInitialGraph.batch.slug, preparedInitialGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE),
              { graph: preparedInitialGraph, source: "api" }
            ]
          ]
        : []
    )
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => initialSelectedNodeId(preparedInitialGraph));
  const [detailPaneView, setDetailPaneView] = useState<"company" | "insiders">(() =>
    initialTopVoiceAudience(preparedInitialGraph, initialTopVoiceAudienceProp) === "insiders" ? "insiders" : "company"
  );
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>(() => initialSelectedPlatforms(initialFilters));
  const [selectedTopics, setSelectedTopics] = useState<PostTopic[]>(() => normalizeInitialTopics(initialFilters?.topics));
  const [selectedVerticals, setSelectedVerticals] = useState<CompanyVertical[]>(() => normalizeInitialVerticals(initialFilters?.verticals));
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>(() => normalizeInitialList(initialFilters?.industries));
  const [selectedGroupPartners, setSelectedGroupPartners] = useState<string[]>(() => normalizeInitialList(initialFilters?.groupPartners));
  const [selectedInsiderIds, setSelectedInsiderIds] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(initialFilters?.minScore ?? 0);
  const [minScoreDraft, setMinScoreDraft] = useState(initialFilters?.minScore ?? 0);
  const [graphFocusRevision, setGraphFocusRevision] = useState(0);
  const [focusQuery, setFocusQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [openFilterMenu, setOpenFilterMenu] = useState<FilterMenuId | null>(null);
  const [highlightedFounderId, setHighlightedFounderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!preparedInitialGraph);
  const [scopeTransitioning, setScopeTransitioning] = useState(false);
  const [actionLoading, setActionLoading] = useState<"ingest" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [ycPartners, setYcPartners] = useState<YcPartnersResponse | null>(null);
  const [ycPartnersLoading, setYcPartnersLoading] = useState(true);
  const [ycPartnersError, setYcPartnersError] = useState<string | null>(null);
  const [urlStateHydrated, setUrlStateHydrated] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filterBandRef = useRef<HTMLElement | null>(null);
  const dashboardGridRef = useRef<HTMLElement | null>(null);
  const insidersPanelRef = useRef<InsidersPanelHandle | null>(null);
  const graphRequestIdRef = useRef(0);
  const scopeTransitionTimerRef = useRef<number | null>(null);
  const graphFetchSequenceRef = useRef(0);
  const latestGraphFetchIdRef = useRef<Map<string, number>>(new Map());
  const graphInFlightRef = useRef<Map<string, InFlightGraphRequest>>(new Map());
  const lastResumeRevalidationAtRef = useRef<Map<string, number>>(new Map());
  const actionRequestIdRef = useRef(0);
  const activeActionAbortRef = useRef<AbortController | null>(null);
  const ycPartnersRequestIdRef = useRef(0);
  const ycPartnersAbortRef = useRef<AbortController | null>(null);
  const selectionRef = useRef({ batchSlug, topVoiceAudience, insiderIds: selectedInsiderIds });
  const insiderConfigurationVersionRef = useRef<number | null>(
    preparedInitialGraph?.insiderConfigurationVersion ?? null
  );
  const insiderAuthUserIdRef = useRef<string | null | undefined>(undefined);
  const initialGraphHydratedRef = useRef(Boolean(preparedInitialGraph));
  const lastSubmittedQueryRef = useRef("");
  const currentFilters = useMemo<ClientGraphFilters>(
    () => ({
      platforms: selectedPlatforms,
      topics: selectedTopics,
      verticals: selectedVerticals,
      industries: selectedIndustries,
      groupPartners: selectedGroupPartners,
      minScore
    }),
    [minScore, selectedGroupPartners, selectedIndustries, selectedPlatforms, selectedTopics, selectedVerticals]
  );
  const currentFiltersRef = useRef(currentFilters);

  useEffect(() => {
    currentFiltersRef.current = currentFilters;
  }, [currentFilters]);

  const loadYcPartners = useCallback(async () => {
    const requestId = ycPartnersRequestIdRef.current + 1;
    ycPartnersRequestIdRef.current = requestId;
    ycPartnersAbortRef.current?.abort();
    const controller = new AbortController();
    ycPartnersAbortRef.current = controller;
    setYcPartnersLoading(true);
    setYcPartnersError(null);

    try {
      const payload = await fetchYcPartnersPayload(batchSlug, controller.signal);
      if (controller.signal.aborted || requestId !== ycPartnersRequestIdRef.current) return;
      setYcPartners(payload);
    } catch (caught) {
      if (controller.signal.aborted || requestId !== ycPartnersRequestIdRef.current) return;
      setYcPartnersError(
        caught instanceof Error ? caught.message : "YC partner favorites are temporarily unavailable."
      );
    } finally {
      if (!controller.signal.aborted && requestId === ycPartnersRequestIdRef.current) {
        setYcPartnersLoading(false);
      }
    }
  }, [batchSlug]);

  useEffect(() => {
    if (surface !== "map") return undefined;
    let disposed = false;
    let timeoutId: number | null = null;

    const scheduleRevalidation = () => {
      if (disposed) return;
      timeoutId = window.setTimeout(() => {
        void loadYcPartners().finally(scheduleRevalidation);
      }, YC_PARTNERS_REVALIDATION_INTERVAL_MS);
    };
    const initialLoadTimeoutId = window.setTimeout(() => {
      void loadYcPartners().finally(scheduleRevalidation);
    }, YC_PARTNERS_INITIAL_LOAD_DELAY_MS);

    return () => {
      disposed = true;
      window.clearTimeout(initialLoadTimeoutId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      ycPartnersAbortRef.current?.abort();
    };
  }, [batchSlug, loadYcPartners, graph?.generatedAt, surface]);

  useEffect(() => {
    selectionRef.current = { batchSlug, topVoiceAudience, insiderIds: selectedInsiderIds };
  }, [batchSlug, selectedInsiderIds, topVoiceAudience]);

  /* URL hydration must finish in the mount effect before controls can synchronously
     write route state; deferring it lets the first user action race the hydration. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("mode")) {
      setSurface(params.get("mode") === "top100" ? "top100" : "map");
    }
    if (params.has("topics")) {
      setSelectedTopics(queryTopics(params));
    }
    if (params.has("verticals")) {
      setSelectedVerticals(queryVerticals(params));
    }
    if (params.has("industries")) {
      setSelectedIndustries(queryList(params, "industries"));
    }
    if (params.has("groupPartners")) {
      setSelectedGroupPartners(queryList(params, "groupPartners"));
    }
    if (params.has("insiderIds")) {
      setSelectedInsiderIds(queryList(params, "insiderIds"));
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
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const rememberGraph = useCallback((payload: GraphResponse, source: GraphPayloadSource = "api") => {
    graphCacheRef.current.set(
      graphCacheKey(
        payload.batch.slug,
        payload.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE,
        payload.selectedInsiderIds ?? []
      ),
      { graph: payload, source }
    );
    if (
      (payload.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE) === DEFAULT_TOP_VOICE_AUDIENCE &&
      selectionRef.current.batchSlug === payload.batch.slug
    ) {
      setMapMetadataGraph(payload);
    }
  }, []);

  const showCachedGraph = useCallback((
    targetBatchSlug: string,
    targetTopVoiceAudience: TopVoiceAudienceId,
    targetInsiderIds: string[] = []
  ) => {
    const cachedEntry = graphCacheRef.current.get(
      graphCacheKey(targetBatchSlug, targetTopVoiceAudience, targetInsiderIds)
    );
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

  const abortGraphRequestsExcept = useCallback((keysToKeep: readonly string[]) => {
    const retainedKeys = new Set(keysToKeep);
    for (const [key, request] of graphInFlightRef.current) {
      if (retainedKeys.has(key)) {
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
    const targetInsiderIds = targetTopVoiceAudience === "insiders" ? selectedInsiderIds : [];
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

    abortGraphRequestsExcept([
      graphCacheKey(targetBatchSlug, targetTopVoiceAudience, targetInsiderIds),
      graphCacheKey(targetBatchSlug, DEFAULT_TOP_VOICE_AUDIENCE)
    ]);
    selectionRef.current = {
      batchSlug: targetBatchSlug,
      topVoiceAudience: targetTopVoiceAudience,
      insiderIds: targetInsiderIds
    };
    if (currentSelection.batchSlug !== targetBatchSlug) {
      const nextFilters = {
        ...currentFiltersRef.current,
        topics: [],
        verticals: [],
        industries: [],
        groupPartners: []
      };
      currentFiltersRef.current = nextFilters;
      setSelectedTopics([]);
      setSelectedVerticals([]);
      setSelectedIndustries([]);
      setSelectedGroupPartners([]);
    }
    setOpenFilterMenu(null);
    setHighlightedFounderId(null);

    actionRequestIdRef.current += 1;
    activeActionAbortRef.current?.abort();
    activeActionAbortRef.current = null;
    setActionLoading(null);
    setRefreshError(null);
    setRefreshNotice(null);

    if (!showCachedGraph(targetBatchSlug, targetTopVoiceAudience, targetInsiderIds)) {
      graphRequestIdRef.current += 1;
      setLoading(true);
      setError(null);
    }

    setBatchSlug(targetBatchSlug);
    setTopVoiceAudience(targetTopVoiceAudience);
  }, [abortGraphRequestsExcept, selectedInsiderIds, showCachedGraph]);

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

  const fetchGraph = useCallback(async (options: FetchGraphOptions = {}) => {
    const background = options.background === true;
    const activeInsiderIds = topVoiceAudience === "insiders"
      ? options.insiderIds ?? selectedInsiderIds
      : [];
    const key = graphCacheKey(batchSlug, topVoiceAudience, activeInsiderIds);
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
    if (activeInsiderIds.length) {
      params.set("insiderIds", activeInsiderIds.join(","));
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
      staticSnapshotUrl:
        options.unfiltered &&
        activeInsiderIds.length === 0 &&
        !(topVoiceAudience === "insiders" && insiderConfigurationVersionRef.current !== null)
          ? staticGraphSnapshotUrl(batchSlug, topVoiceAudience)
          : null,
      apiUrl: `/api/graph?${params.toString()}`,
      attempts: 3,
      forceApi: options.forceApi === true
    });
    try {
      const result = await request.promise;
      if (!isCurrentGraphRequest(request)) {
        if (options.propagateError) {
          throw new Error("Personalized score refresh was interrupted. Please retry.");
        }
        return;
      }
      const payload = result.graph;
      if (topVoiceAudience === "insiders") {
        const minimumConfigurationVersion = insiderConfigurationVersionRef.current;
        const payloadConfigurationVersion =
          typeof payload.insiderConfigurationVersion === "number" &&
          Number.isInteger(payload.insiderConfigurationVersion)
            ? payload.insiderConfigurationVersion
            : null;
        if (
          minimumConfigurationVersion !== null &&
          (payloadConfigurationVersion === null ||
            payloadConfigurationVersion < minimumConfigurationVersion)
        ) {
          throw new Error(
            "The graph service returned stale Insider scores. Please retry."
          );
        }
        if (payloadConfigurationVersion !== null) {
          insiderConfigurationVersionRef.current = payloadConfigurationVersion;
        }
      }
      if (options.unfiltered) {
        rememberGraph(payload, result.source);
      }
      const selected = selectionRef.current;
      const matchesCurrentSelection =
        graphMatchesSelection(payload, selected.batchSlug, selected.topVoiceAudience) &&
        sameValues(payload.selectedInsiderIds ?? [], selected.insiderIds);
      if ((!background && requestId !== graphRequestIdRef.current) || !matchesCurrentSelection) {
        if (options.propagateError) {
          throw new Error("Personalized score refresh was interrupted. Please retry.");
        }
        return;
      }
      if (options.unfiltered) {
        setFilterMetadataGraph(payload);
      }
      setGraph(options.unfiltered ? applyClientGraphFilters(payload, currentFiltersRef.current) : payload);
      if (options.unfiltered) {
        void hydrateGraphTopicFacets(
          payload,
          selected.batchSlug,
          selected.topVoiceAudience,
          request.controller.signal
        ).then((hydrated) => {
          if (hydrated === payload || !isCurrentGraphRequest(request)) return;
          const latest = selectionRef.current;
          if (
            !graphMatchesSelection(hydrated, latest.batchSlug, latest.topVoiceAudience) ||
            !sameValues(hydrated.selectedInsiderIds ?? [], latest.insiderIds)
          ) return;
          rememberGraph(hydrated, result.source);
          setFilterMetadataGraph(hydrated);
          setGraph(applyClientGraphFilters(hydrated, currentFiltersRef.current));
        }).catch((caught) => {
          if (!isAbortError(caught)) {
            // Topic facets are an enhancement over the already usable graph;
            // a missing snapshot must not turn a successful graph load into an
            // error state.
          }
        });
      }
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error("Graph request failed");
      if (!background && requestId !== graphRequestIdRef.current) {
        if (options.propagateError) throw failure;
        return;
      }
      if (!isCurrentGraphRequest(request) || isAbortError(caught) || request.controller.signal.aborted) {
        if (options.propagateError) throw failure;
        return;
      }
      if (!background) {
        setError(failure.message);
      }
      if (options.propagateError) throw failure;
    } finally {
      if (!background && requestId === graphRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [batchSlug, getOrStartGraphRequest, isCurrentGraphRequest, rememberGraph, selectedInsiderIds, topVoiceAudience]);

  const fetchMapBaseline = useCallback(async (targetBatchSlug: string) => {
    const cachedEntry = graphCacheRef.current.get(graphCacheKey(targetBatchSlug, DEFAULT_TOP_VOICE_AUDIENCE));
    if (graphMatchesSelection(cachedEntry?.graph, targetBatchSlug, DEFAULT_TOP_VOICE_AUDIENCE)) {
      setMapMetadataGraph(cachedEntry.graph);
      setMapBaselineRetry((current) => current?.batchSlug === targetBatchSlug ? null : current);
      return;
    }

    const request = getOrStartGraphRequest({
      key: graphCacheKey(targetBatchSlug, DEFAULT_TOP_VOICE_AUDIENCE),
      batchSlug: targetBatchSlug,
      topVoiceAudience: DEFAULT_TOP_VOICE_AUDIENCE,
      staticSnapshotUrl: staticGraphSnapshotUrl(targetBatchSlug, DEFAULT_TOP_VOICE_AUDIENCE),
      apiUrl: `/api/graph?batch=${encodeURIComponent(targetBatchSlug)}`,
      attempts: 3,
      forceApi: false
    });

    try {
      const result = await request.promise;
      if (!isCurrentGraphRequest(request)) return;
      rememberGraph(result.graph, result.source);
      if (selectionRef.current.batchSlug === targetBatchSlug) {
        setMapMetadataGraph(result.graph);
        setMapBaselineRetry((current) => current?.batchSlug === targetBatchSlug ? null : current);
      }
    } catch (caught) {
      if (!isAbortError(caught) && !request.controller.signal.aborted) {
        if (selectionRef.current.batchSlug === targetBatchSlug) {
          setMapBaselineRetry((current) => ({
            batchSlug: targetBatchSlug,
            attempt: current?.batchSlug === targetBatchSlug ? current.attempt + 1 : 1
          }));
        }
      }
    }
  }, [getOrStartGraphRequest, isCurrentGraphRequest, rememberGraph]);

  const refreshPersonalizedInsiders = useCallback(async (expectedConfigurationVersion?: number) => {
    const selection = selectionRef.current;
    if (selection.topVoiceAudience !== "insiders") {
      return;
    }
    if (
      expectedConfigurationVersion !== undefined &&
      (!Number.isInteger(expectedConfigurationVersion) || expectedConfigurationVersion < 0)
    ) {
      throw new Error("The saved Insider configuration version was invalid.");
    }
    if (expectedConfigurationVersion !== undefined) {
      insiderConfigurationVersionRef.current = expectedConfigurationVersion;
    }

    for (const key of [...graphCacheRef.current.keys()]) {
      if (key.includes("::insiders::")) graphCacheRef.current.delete(key);
    }
    invalidateGraphRequests();

    const targetSelection = selection;

    const requestId = graphRequestIdRef.current + 1;
    graphRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const response = await insiderApiFetch("/api/insiders/recompute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          batchSlug: targetSelection.batchSlug,
          insiderIds: targetSelection.insiderIds
        })
      });
      if (!response.ok) {
        throw await graphResponseError(response);
      }
      const payload = await response.json() as InsiderRecomputeResponse;
      if (!isGraphResponsePayload(payload.graph)) {
        throw new Error("The personalized score refresh returned an invalid graph.");
      }
      const graph = enrichGraphTaxonomies(payload.graph);
      const responseConfigurationVersion =
        typeof payload.configurationVersion === "number" &&
        Number.isInteger(payload.configurationVersion)
          ? payload.configurationVersion
          : null;
      const graphConfigurationVersion =
        typeof graph.insiderConfigurationVersion === "number" &&
        Number.isInteger(graph.insiderConfigurationVersion)
          ? graph.insiderConfigurationVersion
          : null;
      const minimumConfigurationVersion =
        expectedConfigurationVersion ?? insiderConfigurationVersionRef.current;
      if (
        responseConfigurationVersion === null ||
        graphConfigurationVersion === null ||
        responseConfigurationVersion !== graphConfigurationVersion ||
        (minimumConfigurationVersion !== null &&
          graphConfigurationVersion < minimumConfigurationVersion)
      ) {
        throw new Error(
          "The personalized score refresh returned a stale Insider configuration. Please retry."
        );
      }
      if (
        !graphMatchesSelection(graph, targetSelection.batchSlug, targetSelection.topVoiceAudience) ||
        !graphMatchesInsiderSelection(graph, targetSelection.topVoiceAudience, targetSelection.insiderIds)
      ) {
        throw new Error("The personalized score refresh returned a graph for a different selection.");
      }
      const latestSelection = selectionRef.current;
      if (
        requestId !== graphRequestIdRef.current ||
        latestSelection.batchSlug !== targetSelection.batchSlug ||
        latestSelection.topVoiceAudience !== targetSelection.topVoiceAudience ||
        !sameValues(latestSelection.insiderIds, targetSelection.insiderIds)
      ) {
        throw new Error("Personalized score refresh was interrupted. Please retry.");
      }
      rememberGraph(graph, "api");
      insiderConfigurationVersionRef.current = graphConfigurationVersion;
      setFilterMetadataGraph(graph);
      setGraph(applyClientGraphFilters(graph, currentFiltersRef.current));
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error("Scores could not be recomputed.");
      if (requestId === graphRequestIdRef.current) {
        setError(failure.message);
      }
      throw failure;
    } finally {
      if (requestId === graphRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [invalidateGraphRequests, rememberGraph]);

  useEffect(() => subscribeToInsiderAuth(({ userId }) => {
    const previousUserId = insiderAuthUserIdRef.current;
    insiderAuthUserIdRef.current = userId;
    if (previousUserId === undefined || previousUserId === userId) {
      return;
    }

    insiderConfigurationVersionRef.current = null;
    for (const key of [...graphCacheRef.current.keys()]) {
      if (key.includes("::insiders::")) graphCacheRef.current.delete(key);
    }
    graphRequestIdRef.current += 1;

    const selection = selectionRef.current;
    if (selection.topVoiceAudience !== "insiders") {
      return;
    }

    invalidateGraphRequests();
    actionRequestIdRef.current += 1;
    activeActionAbortRef.current?.abort();
    activeActionAbortRef.current = null;
    setActionLoading(null);
    setRefreshError(null);
    setRefreshNotice(null);
    setFilterMetadataGraph((current) =>
      current?.selectedTopVoiceAudience?.id === "insiders" ? null : current
    );
    setGraph((current) =>
      current?.selectedTopVoiceAudience?.id === "insiders" ? null : current
    );
    setError(null);
    setLoading(true);
    void fetchGraph({ forceApi: true, unfiltered: true }).catch(() => undefined);
  }, { emitInitial: true }), [fetchGraph, invalidateGraphRequests]);

  useEffect(() => {
    if (surface !== "map") return undefined;
    if (topVoiceAudience !== "insiders") return undefined;
    let cancelled = false;
    void insiderAccessToken().then((accessToken) => {
      if (!cancelled && accessToken) {
        void refreshPersonalizedInsiders().catch(() => undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshPersonalizedInsiders, surface, topVoiceAudience]);

  useEffect(() => {
    if (surface !== "map") return undefined;
    if (graphMatchesSelection(mapMetadataGraph, batchSlug, DEFAULT_TOP_VOICE_AUDIENCE)) {
      return undefined;
    }
    const retryAttempt = mapBaselineRetry?.batchSlug === batchSlug ? mapBaselineRetry.attempt : 0;
    if (retryAttempt > MAP_BASELINE_RETRY_DELAYS_MS.length) {
      return undefined;
    }
    const retryDelay = retryAttempt === 0 ? 0 : MAP_BASELINE_RETRY_DELAYS_MS[retryAttempt - 1];
    const timeoutId = window.setTimeout(() => {
      void fetchMapBaseline(batchSlug);
    }, retryDelay);
    return () => window.clearTimeout(timeoutId);
  }, [batchSlug, fetchMapBaseline, mapBaselineRetry, mapMetadataGraph, surface]);

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
    if (surface !== "map" || typeof window === "undefined") {
      return undefined;
    }

    let timeoutId: number | null = null;
    const scheduleDailyRefresh = () => {
      timeoutId = window.setTimeout(() => {
        invalidateGraphRequests();
        graphCacheRef.current.clear();
        setMapMetadataGraph(null);
        setMapBaselineRetry(null);
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
  }, [fetchGraph, invalidateGraphRequests, surface]);

  useEffect(() => {
    if (surface !== "map") return undefined;
    const activeGraphKey = graphCacheKey(
      batchSlug,
      topVoiceAudience,
      topVoiceAudience === "insiders" ? selectedInsiderIds : []
    );
    const cachedEntry = graphCacheRef.current.get(activeGraphKey);
    const cachedGraph =
      graphMatchesSelection(filterMetadataGraph, batchSlug, topVoiceAudience) &&
      graphMatchesInsiderSelection(filterMetadataGraph, topVoiceAudience, selectedInsiderIds)
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
        }, graphNeedsImmediateMomentumRevalidation(cachedGraph)
          ? 0
          : BACKGROUND_REVALIDATION_DELAY_MS);
        return () => window.clearTimeout(timeoutId);
      }

      if (
        initialGraphHydratedRef.current &&
        preparedInitialGraph &&
        batchSlug === preparedInitialGraph.batch.slug &&
        topVoiceAudience === (preparedInitialGraph.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE)
      ) {
        initialGraphHydratedRef.current = false;
        const timeoutId = window.setTimeout(() => {
          void fetchGraph({ background: true, forceApi: true, unfiltered: true });
        }, graphNeedsImmediateMomentumRevalidation(cachedGraph)
          ? 0
          : BACKGROUND_REVALIDATION_DELAY_MS);
        return () => window.clearTimeout(timeoutId);
      }
      return;
    }

    initialGraphHydratedRef.current = false;
    void fetchGraph({ unfiltered: true });
  }, [batchSlug, currentFilters, fetchGraph, filterMetadataGraph, preparedInitialGraph, selectedInsiderIds, surface, topVoiceAudience]);

  useEffect(() => {
    if (surface !== "map" || typeof window === "undefined") {
      return undefined;
    }

    const revalidateOnResume = () => {
      if (document.visibilityState === "hidden") {
        return;
      }

      const activeGraphKey = graphCacheKey(
        batchSlug,
        topVoiceAudience,
        topVoiceAudience === "insiders" ? selectedInsiderIds : []
      );
      const now = Date.now();
      const lastRefreshAt = lastResumeRevalidationAtRef.current.get(activeGraphKey);
      if (lastRefreshAt !== undefined && now - lastRefreshAt < RESUME_REVALIDATION_COOLDOWN_MS) {
        recordResumeRevalidationAt(lastResumeRevalidationAtRef.current, activeGraphKey, lastRefreshAt);
        return;
      }
      if (graphInFlightRef.current.has(activeGraphKey)) {
        return;
      }

      recordResumeRevalidationAt(lastResumeRevalidationAtRef.current, activeGraphKey, now);
      void fetchGraph({ background: true, forceApi: true, unfiltered: true });
    };

    window.addEventListener("focus", revalidateOnResume);
    document.addEventListener("visibilitychange", revalidateOnResume);
    return () => {
      window.removeEventListener("focus", revalidateOnResume);
      document.removeEventListener("visibilitychange", revalidateOnResume);
    };
  }, [batchSlug, fetchGraph, selectedInsiderIds, surface, topVoiceAudience]);

  const settledGraph =
    graphMatchesSelection(graph, batchSlug, topVoiceAudience) &&
    graphMatchesInsiderSelection(graph, topVoiceAudience, selectedInsiderIds)
      ? graph
      : null;
  const graphBusy = loading || scopeTransitioning;
  const graphScopeMismatch = graph !== null && settledGraph === null;
  const scopedFilterMetadataGraph =
    graphMatchesSelection(filterMetadataGraph, batchSlug, topVoiceAudience) &&
    graphMatchesInsiderSelection(filterMetadataGraph, topVoiceAudience, selectedInsiderIds)
    ? filterMetadataGraph
    : null;
  const scopedMapMetadataGraph = graphMatchesSelection(mapMetadataGraph, batchSlug, DEFAULT_TOP_VOICE_AUDIENCE)
    ? mapMetadataGraph
    : null;
  const filterCatalogGraph = scopedMapMetadataGraph ?? scopedFilterMetadataGraph;
  const mapGraph = useMemo(
    () => {
      const personalizedSource = scopedFilterMetadataGraph ?? graph;
      const source =
        topVoiceAudience === "insiders" &&
        insiderConfigurationVersionRef.current !== null &&
        scopedMapMetadataGraph &&
        personalizedSource
          ? overlayPersonalizedGraphOnBaseline(scopedMapMetadataGraph, personalizedSource)
          : scopedMapMetadataGraph ?? personalizedSource;
      return source
        ? applyClientGraphFilters(source, {
            platforms: [],
            topics: [],
            verticals: [],
            industries: [],
            groupPartners: [],
            minScore
          })
        : null;
    }, [graph, minScore, scopedFilterMetadataGraph, scopedMapMetadataGraph, topVoiceAudience]
  );
  const fallbackGraphActive = graphScopeMismatch && !graphBusy && Boolean(mapGraph);
  const interactiveGraph = settledGraph ?? (fallbackGraphActive ? mapGraph : null);
  const scopeSpecificFiltersDisabled = !settledGraph || !scopedFilterMetadataGraph;
  const rankedPostsTargetBatchSlug = settledGraph?.batch.slug ?? null;
  const rankedPostsTargetGeneratedAt = settledGraph?.generatedAt ?? null;
  const rankedPostsTargetAudienceId = settledGraph?.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE;
  const rankedPostsSidecarTarget = useMemo<RankedPostsGraphTarget | null>(() => {
    if (!rankedPostsTargetBatchSlug || !rankedPostsTargetGeneratedAt) return null;
    return {
      batch: { slug: rankedPostsTargetBatchSlug },
      generatedAt: rankedPostsTargetGeneratedAt,
      selectedTopVoiceAudience: {
        id: rankedPostsTargetAudienceId
      }
    };
  }, [
    rankedPostsTargetAudienceId,
    rankedPostsTargetBatchSlug,
    rankedPostsTargetGeneratedAt
  ]);
  const bundledRankedPostsSidecarScope = useMemo(
    () => rankedPostsSidecarTarget
      ? rankedPostsSidecarScopeForGraph(rankedPostsSidecarTarget)
      : null,
    [rankedPostsSidecarTarget]
  );

  useEffect(() => {
    if (surface !== "map" || !rankedPostsSidecarTarget || bundledRankedPostsSidecarScope) return undefined;

    let cancelled = false;
    const controller = new AbortController();
    void loadRankedPostsSidecarForGraph(rankedPostsSidecarTarget, { signal: controller.signal })
      .then((scope) => {
        if (cancelled) return;
        setRankedPostsSidecarState({
          batchSlug: rankedPostsSidecarTarget.batch.slug,
          audienceId: rankedPostsSidecarTarget.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE,
          generatedAt: rankedPostsSidecarTarget.generatedAt,
          scope
        });
      })
      .catch(() => {
        if (!cancelled) setRankedPostsSidecarState(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [bundledRankedPostsSidecarScope, rankedPostsSidecarTarget, surface]);

  const activeRankedPostsSidecarScope =
    bundledRankedPostsSidecarScope ?? (rankedPostsSidecarState && rankedPostsSidecarTarget &&
    rankedPostsSidecarState.batchSlug === rankedPostsSidecarTarget.batch.slug &&
    rankedPostsSidecarState.audienceId === (rankedPostsSidecarTarget.selectedTopVoiceAudience?.id ?? DEFAULT_TOP_VOICE_AUDIENCE) &&
    rankedPostsSidecarState.generatedAt === rankedPostsSidecarTarget.generatedAt
      ? rankedPostsSidecarState.scope
      : null);

  const mapFocus = useMemo(() => {
    const active = Boolean(
      selectedPlatforms.length ||
      selectedIndustries.length ||
      selectedVerticals.length ||
      topVoiceAudience !== DEFAULT_TOP_VOICE_AUDIENCE ||
      selectedGroupPartners.length ||
      selectedTopics.length
    );
    const companyNodeIds = (interactiveGraph?.nodes ?? [])
      .filter((node) => node.entityType === "company")
      .map((node) => node.id)
      .sort();
    const signature = [
      `platforms:${[...selectedPlatforms].sort().join("|")}`,
      `industries:${[...selectedIndustries].sort().join("|")}`,
      `verticals:${[...selectedVerticals].sort().join("|")}`,
      `topVoices:${topVoiceAudience}`,
      `groupPartners:${[...selectedGroupPartners].sort().join("|")}`,
      `topics:${[...selectedTopics].sort().join("|")}`,
      `companies:${companyNodeIds.join("|")}`
    ].join(";");
    return { active, companyNodeIds, signature };
  }, [interactiveGraph, selectedGroupPartners, selectedIndustries, selectedPlatforms, selectedTopics, selectedVerticals, topVoiceAudience]);

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
    setUrlParameter(url, "mode", surface === "top100" ? "top100" : null);
    setUrlParameter(url, "batch", batchSlug === DEFAULT_BATCH_SLUG ? null : batchSlug);
    setUrlParameter(url, "topVoices", topVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE ? null : topVoiceAudience);
    setUrlParameter(url, "platforms", selectedPlatforms.length ? selectedPlatforms.join(",") : null);
    setUrlParameter(url, "topics", selectedTopics.length ? selectedTopics.join(",") : null);
    setUrlParameter(url, "verticals", selectedVerticals.length ? selectedVerticals.join(",") : null);
    setUrlParameter(url, "industries", selectedIndustries.length ? selectedIndustries.join(",") : null);
    setUrlParameter(url, "groupPartners", selectedGroupPartners.length ? selectedGroupPartners.join(",") : null);
    setUrlParameter(
      url,
      "insiderIds",
      topVoiceAudience === "insiders" && selectedInsiderIds.length
        ? selectedInsiderIds.join(",")
        : null
    );
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
    selectedInsiderIds,
    selectedPlatforms,
    selectedTopics,
    selectedVerticals,
    surface,
    topVoiceAudience,
    urlStateHydrated
  ]);

  const selectedNode = useMemo(
    () => interactiveGraph ? mapGraph?.nodes.find((node) => node.id === activeSelectedNodeId) ?? null : null,
    [activeSelectedNodeId, interactiveGraph, mapGraph]
  );

  const selectedEvidence = useMemo(() => {
    if (!interactiveGraph || !selectedNode) {
      return [];
    }
    return selectedNodeEvidence(interactiveGraph, selectedNode).slice(0, TOP_POSTS_LIMIT);
  }, [interactiveGraph, selectedNode]);

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
    if (!interactiveGraph || !selectedNode) {
      return [];
    }
    return [];
  }, [interactiveGraph, selectedNode]);

  const selectNode = useCallback((nodeId: string, source: "graph" | "leaderboard" = "graph") => {
    const node = mapGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return;
    }
    const select = () => {
      setDetailPaneView("company");
      setSelectedNodeId(nodeId);
      setHighlightedFounderId(null);
      setGraphFocusRevision((current) => current + 1);
      trackAnalyticsEvent("graph_node_opened", {
        node_type: node.entityType,
        source
      });
    };
    if (detailPaneView === "insiders") insidersPanelRef.current?.requestLeave(select);
    else select();
  }, [detailPaneView, mapGraph]);

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
    const select = () => {
      submitSearchTelemetry();
      trackAnalyticsEvent("result_opened", {
        result_type: result.kind,
        position: Math.max(0, searchResults.findIndex((candidate) => candidate === result)) + 1
      });
      trackAnalyticsEvent("graph_node_opened", {
        node_type: node.entityType,
        source: "search"
      });
      setDetailPaneView("company");
      setSelectedNodeId(result.companyNodeId);
      setHighlightedFounderId(result.kind === "founder" ? result.id : null);
      setSearchOpen(false);
      setGraphFocusRevision((current) => current + 1);
    };
    if (detailPaneView === "insiders") insidersPanelRef.current?.requestLeave(select);
    else select();
  }, [detailPaneView, mapGraph, searchResults, submitSearchTelemetry]);

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

  const batches = filterCatalogGraph?.batches ?? graph?.batches ?? defaultBatches;
  const topVoiceAudiences = filterCatalogGraph?.topVoiceAudiences ?? graph?.topVoiceAudiences ?? defaultTopVoiceAudiences;
  const industryOptions = useMemo(() => {
    const byIndustry = new Map<string, { name: string; count: number; color: string }>();

    for (const node of filterCatalogGraph?.nodes ?? []) {
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
  }, [filterCatalogGraph]);

  const groupPartnerOptions = useMemo(() => {
    const byPartner = new Map<string, { name: string; count: number }>();

    for (const node of filterCatalogGraph?.nodes ?? []) {
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
  }, [batchSlug, filterCatalogGraph]);

  const platformDropdownOptions = useMemo<DropdownOption<Platform>[]>(
    () => platformOptions.map((platform) => ({ value: platform, label: formatPlatform(platform), platform })),
    []
  );

  const topicCounts = useMemo(
    () => scopedFilterMetadataGraph
      ? topicPostFacetCounts(scopedFilterMetadataGraph, currentFilters)
      : new Map<PostTopic, number>(),
    [currentFilters, scopedFilterMetadataGraph]
  );
  const verticalCounts = useMemo(
    () => companyVerticalCounts(filterCatalogGraph?.nodes ?? []),
    [filterCatalogGraph]
  );
  const topicDropdownOptions = useMemo<DropdownOption<PostTopic>[]>(
    () => POST_TOPIC_TAXONOMY.map((topic) => {
      const count = topicCounts.get(topic.slug) ?? 0;
      return {
        value: topic.slug,
        label: topic.label,
        count,
        disabled: count === 0 && !selectedTopics.includes(topic.slug),
        searchText: `${topic.slug} ${topic.aliases.join(" ")}`
      };
    }),
    [selectedTopics, topicCounts]
  );
  const verticalDropdownOptions = useMemo<DropdownOption<CompanyVertical>[]>(
    () => COMPANY_VERTICALS.map((vertical) => {
      const count = verticalCounts.get(vertical.slug) ?? 0;
      return {
        value: vertical.slug,
        label: vertical.label,
        count,
        disabled: count === 0 && !selectedVerticals.includes(vertical.slug)
      };
    }),
    [selectedVerticals, verticalCounts]
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
      const accessToken = await insiderAccessToken();
      const payload = await fetchWithTimeout<SuccessfulRefreshResponse>(
        "/api/graph/refresh",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
          },
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
      const refreshedGraph = enrichGraphTaxonomies(payload.graph);
      const activeFilters = hasClientGraphFilters(currentFiltersRef.current);
      invalidateGraphRequests();
      graphCacheRef.current.clear();
      setMapMetadataGraph(null);
      setMapBaselineRetry(null);
      rememberGraph(refreshedGraph);
      setFilterMetadataGraph(refreshedGraph);
      setGraph(applyClientGraphFilters(refreshedGraph, currentFiltersRef.current));
      if (activeFilters) void fetchGraph({ background: true, forceApi: true, unfiltered: true });
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

  function toggleTopic(topic: PostTopic) {
    const removing = selectedTopics.includes(topic);
    const next = normalizePostTopics(
      removing ? selectedTopics.filter((item) => item !== topic) : [...selectedTopics, topic]
    );
    setSelectedTopics(next);
    trackFilterChange("topic", removing ? "removed" : "added", next.length);
  }

  function toggleVertical(vertical: CompanyVertical) {
    const removing = selectedVerticals.includes(vertical);
    const next = normalizeCompanyVerticals(
      removing ? selectedVerticals.filter((item) => item !== vertical) : [...selectedVerticals, vertical],
      COMPANY_VERTICALS.length
    );
    setSelectedVerticals(next);
    trackFilterChange("vertical", removing ? "removed" : "added", next.length);
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

  function clearFilter(filter: "platform" | "topic" | "vertical" | "industry" | "group_partner") {
    const selectedCount = filter === "platform"
      ? selectedPlatforms.length
      : filter === "topic"
        ? selectedTopics.length
        : filter === "vertical"
          ? selectedVerticals.length
      : filter === "industry"
        ? selectedIndustries.length
        : selectedGroupPartners.length;
    if (selectedCount > 0) {
      trackFilterChange(filter, "cleared", 0);
    }
    if (filter === "platform") setSelectedPlatforms([]);
    if (filter === "topic") setSelectedTopics([]);
    if (filter === "vertical") setSelectedVerticals([]);
    if (filter === "industry") setSelectedIndustries([]);
    if (filter === "group_partner") setSelectedGroupPartners([]);
  }

  function shareEventContext() {
    return {
      included_filters: hasClientGraphFilters(currentFilters),
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
  const brandTitle = networkMapTitle(batchSlug);
  const loadingMapLabel = isA16zSpeedrunBatch ? "a16z" : "YC";

  useEffect(() => {
    document.title = brandTitle;
  }, [brandTitle]);

  return (
    <main className={`dashboard${isA16zSpeedrunBatch ? " dashboard-a16z" : ""}${surface === "top100" ? " dashboard-top100" : ""}`}>
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

        {surface === "map" && <div className="focus-search">
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
        </div>}

        <div className="control-strip">
          <div className="control-cluster control-cluster-selectors">
            <label className="batch-control">
              <span className="sr-only">Batch</span>
              <select
                value={surface === "top100" ? "__dashboard" : batchSlug}
                onChange={(event) => {
                  const nextBatchSlug = event.target.value;
                  if (nextBatchSlug === "__dashboard") {
                    setSurface("top100");
                    setOpenFilterMenu(null);
                    setSearchOpen(false);
                    return;
                  }
                  const changeBatch = () => {
                    setSurface("map");
                    if (nextBatchSlug !== batchSlug) {
                      trackFilterChange("batch", "set", 1);
                    }
                    transitionGraphScope(nextBatchSlug, topVoiceAudience);
                  };
                  if (detailPaneView === "insiders") insidersPanelRef.current?.requestLeave(changeBatch);
                  else changeBatch();
                }}
              >
                <option value="__dashboard">Top 100</option>
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

          {surface === "map" && manualRefreshEnabled && (
            <div className="control-cluster control-cluster-actions">
              <button
                type="button"
                onClick={() => void runDemoAction("refresh")}
                disabled={!!actionLoading}
                title="Regenerate report from the latest source data"
                aria-label="Regenerate report (full source refresh)"
              >
                <RefreshCw size={16} className={actionLoading === "refresh" ? "spin" : ""} />
                {actionLoading === "refresh" ? "Regenerating" : "Regenerate report"}
              </button>
            </div>
          )}
        </div>
      </header>

      {surface === "map" && <section className="filter-band" ref={filterBandRef}>
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
          id="verticals"
          icon={<Layers3 size={15} />}
          title="Vertical"
          allLabel="All verticals"
          selectedValues={selectedVerticals}
          options={verticalDropdownOptions}
          isOpen={openFilterMenu === "verticals"}
          disabled={scopeSpecificFiltersDisabled}
          searchable
          emptyLabel="No matching verticals"
          onOpenChange={(open) => setOpenFilterMenu(open ? "verticals" : null)}
          onToggle={toggleVertical}
          onClear={() => clearFilter("vertical")}
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
            const changeAudience = () => {
              if (nextTopVoiceAudience !== topVoiceAudience) {
                trackFilterChange("top_voices", nextTopVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE ? "cleared" : "set", nextTopVoiceAudience === DEFAULT_TOP_VOICE_AUDIENCE ? 0 : 1);
              }
              transitionGraphScope(batchSlug, nextTopVoiceAudience);
              setDetailPaneView(nextTopVoiceAudience === "insiders" ? "insiders" : "company");
              setOpenFilterMenu(null);
            };
            if (detailPaneView === "insiders" && nextTopVoiceAudience !== "insiders") {
              insidersPanelRef.current?.requestLeave(changeAudience);
            } else {
              changeAudience();
            }
          }}
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

        <FilterDropdown
          id="topics"
          icon={<Tags size={15} />}
          title="Topics"
          allLabel="All topics"
          selectedValues={selectedTopics}
          options={topicDropdownOptions}
          groups={TOPIC_FILTER_GROUPS}
          isOpen={openFilterMenu === "topics"}
          disabled={scopeSpecificFiltersDisabled}
          searchable
          stickyControls
          emptyLabel="No matching topics"
          onOpenChange={(open) => setOpenFilterMenu(open ? "topics" : null)}
          onToggle={toggleTopic}
          onClear={() => clearFilter("topic")}
        />

        <div className="score-filter">
          <span className="score-filter-label">Min score</span>
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
      </section>}

      {surface === "map" && ((error && graph) || refreshError || refreshNotice) && (
        <section className="status-line" aria-live="polite">
          {error && graph && <span className="error-text">{error}</span>}
          {error && fallbackGraphActive && (
            <span className="refresh-notice-text">
              Showing the standard company graph while the selected audience is unavailable.
            </span>
          )}
          {error && graph && !graphBusy && (
            <button type="button" onClick={() => void fetchGraph({ forceApi: true, unfiltered: true })}>
              <RefreshCw size={15} aria-hidden="true" />
              Retry selected graph
            </button>
          )}
          {refreshError && <span className="error-text">{refreshError}</span>}
          {refreshNotice && <span className="refresh-notice-text">{refreshNotice}</span>}
        </section>
      )}

      {surface === "map" && graphScopeMismatch && graphBusy && (
        <div className="sr-only" role="status">
          Loading the selected graph. The previous graph remains visible, but its controls are unavailable.
        </div>
      )}
      <div
        role="region"
        aria-busy={surface === "map" ? graphBusy : undefined}
        aria-label={surface === "top100" ? "Top 100 technology stories" : "Network map results"}
      >
        <section
          className="dashboard-grid"
          ref={dashboardGridRef}
          inert={surface === "map" && graphScopeMismatch && graphBusy}
        >
          {surface === "top100" ? (
            <TopStoriesDashboard snapshot={initialDashboardSnapshot} variant="network-map" />
          ) : <>
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
                focus={mapFocus}
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
                  <button type="button" onClick={() => void fetchGraph({ forceApi: true, unfiltered: true })}>
                    <RefreshCw size={15} aria-hidden="true" />
                    Retry selected graph
                  </button>
                )}
              </div>
            )}
            {scopeTransitioning && graph && (
              <div className="graph-transition-overlay" role="status">
                <div>
                  <RefreshCw size={24} className="spin" aria-hidden="true" />
                  <strong>Loading {loadingMapLabel} map...</strong>
                </div>
              </div>
            )}
            {graphBusy && !scopeTransitioning && graph && (
              <div className="overlay-status" role="status">
                <RefreshCw size={14} className="spin" aria-hidden="true" />
                Refreshing graph
              </div>
            )}
          </div>
          {detailPaneView === "insiders" ? (
            <InsidersPanel
              ref={insidersPanelRef}
              onClose={() => setDetailPaneView("company")}
              onSaved={refreshPersonalizedInsiders}
            />
          ) : (
            <NodePanel
              node={selectedNode}
              relatedNodes={relatedNodes}
              evidence={selectedEvidence}
              highlightedFounderId={highlightedFounderId}
            />
          )}
          {interactiveGraph && (
            <InsightsTabs
              graph={interactiveGraph}
              statsGraph={scopedFilterMetadataGraph ?? interactiveGraph}
              onSelectNode={selectRankedNode}
              rankedPostsSidecarScope={activeRankedPostsSidecarScope}
              ycPartners={ycPartners}
              ycPartnersLoading={ycPartnersLoading}
              ycPartnersError={ycPartnersError}
              onRetryYcPartners={() => void loadYcPartners()}
            />
          )}
          </>}
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
  groups?: readonly DropdownOptionGroup<T>[];
  isOpen: boolean;
  disabled?: boolean;
  searchable?: boolean;
  stickyControls?: boolean;
  emptyLabel?: string;
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
  groups,
  isOpen,
  disabled = false,
  searchable = false,
  stickyControls = false,
  emptyLabel = `No matching ${title.toLowerCase()}s`,
  onOpenChange,
  onToggle,
  onClear
}: FilterDropdownProps<T>) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
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
  const visibleOptions = searchable && searchQuery.trim()
    ? options.filter((option) =>
        `${option.label} ${option.description ?? ""} ${option.searchText ?? ""}`.toLowerCase().includes(searchQuery.trim().toLowerCase())
      )
    : options;
  const visibleOptionByValue = new Map(visibleOptions.map((option) => [option.value, option]));
  const groupedValues = new Set(groups?.flatMap((group) => [...group.values]) ?? []);
  const visibleGroups = (groups ?? [])
    .map((group) => ({
      ...group,
      options: group.values
        .map((value) => visibleOptionByValue.get(value))
        .filter((option): option is DropdownOption<T> => Boolean(option))
    }))
    .filter((group) => group.options.length > 0);
  const ungroupedOptions = groups
    ? visibleOptions.filter((option) => !groupedValues.has(option.value))
    : visibleOptions;
  const orderedVisibleOptions = groups
    ? [...visibleGroups.flatMap((group) => group.options), ...ungroupedOptions]
    : visibleOptions;
  const visibleOptionIndex = new Map(
    orderedVisibleOptions.map((option, index) => [option.value, index + 1])
  );
  const entries: Array<{ option?: DropdownOption<T>; disabled: boolean }> = [
    { disabled: false },
    ...orderedVisibleOptions.map((option) => ({ option, disabled: option.disabled === true }))
  ];

  useEffect(() => {
    if (!isOpen) return;
    if (pendingFocusIndexRef.current !== null) {
      const focusIndex = pendingFocusIndexRef.current;
      pendingFocusIndexRef.current = null;
      optionRefs.current[focusIndex]?.focus();
    }
  }, [isOpen, entries.length]);

  function enabledIndex(start: number, direction: 1 | -1): number {
    for (let offset = 0; offset < entries.length; offset += 1) {
      const index = (start + offset * direction + entries.length) % entries.length;
      if (!entries[index]?.disabled) return index;
    }
    return 0;
  }

  function focusEntry(start: number, direction: 1 | -1 = 1) {
    optionRefs.current[enabledIndex(start, direction)]?.focus();
  }

  function openAndFocus(index: number) {
    if (isOpen) {
      focusEntry(index, index < 0 ? -1 : 1);
      return;
    }
    pendingFocusIndexRef.current = enabledIndex(
      index < 0 ? entries.length - 1 : index,
      index < 0 ? -1 : 1
    );
    setSearchQuery("");
    optionRefs.current = [];
    onOpenChange(true);
  }

  function restoreFocus() {
    setSearchQuery("");
    optionRefs.current = [];
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  function toggleOpen() {
    if (isOpen) {
      setSearchQuery("");
      optionRefs.current = [];
    }
    onOpenChange(!isOpen);
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Home") {
      event.preventDefault();
      openAndFocus(0);
    } else if (event.key === "ArrowUp" || event.key === "End") {
      event.preventDefault();
      openAndFocus(-1);
    } else if (!isOpen && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openAndFocus(0);
    }
  }

  function handleEntryKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusEntry(index + 1, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusEntry(index - 1, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusEntry(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusEntry(entries.length - 1, -1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      restoreFocus();
    } else if (event.key === "Tab") {
      setSearchQuery("");
      optionRefs.current = [];
      onOpenChange(false);
    }
  }

  function renderOption(option: DropdownOption<T>) {
    const selected = selectedValues.includes(option.value);
    const index = visibleOptionIndex.get(option.value) ?? 0;
    return (
      <button
        ref={(element) => {
          optionRefs.current[index] = element;
        }}
        type="button"
        role="menuitemcheckbox"
        aria-checked={selected}
        aria-disabled={option.disabled || undefined}
        disabled={option.disabled}
        className={`filter-menu-option ${selected ? "selected" : ""} ${option.disabled ? "disabled" : ""}`}
        data-filter-value={option.value}
        key={option.value}
        onClick={() => onToggle(option.value)}
        onKeyDown={(event) => handleEntryKeyDown(event, index)}
      >
        <span className="filter-check" aria-hidden="true">
          {selected && <Check size={15} />}
        </span>
        {option.platform && <PlatformLogo platform={option.platform} />}
        {option.color && <span className="filter-swatch" style={{ backgroundColor: option.color }} />}
        <span className="filter-option-copy">
          <span className="filter-option-label">{option.label}</span>
          {option.description && <small>{option.description}</small>}
        </span>
        {typeof option.count === "number" && <em>({option.count})</em>}
      </button>
    );
  }

  const allOption = (
    <button
      ref={(element) => {
        optionRefs.current[0] = element;
      }}
      type="button"
      role="menuitemcheckbox"
      aria-checked={selectedValues.length === 0}
      aria-label={allLabel}
      className={`filter-menu-option filter-menu-all ${selectedValues.length === 0 ? "selected" : ""}`}
      onClick={onClear}
      onKeyDown={(event) => handleEntryKeyDown(event, 0)}
    >
      <span className="filter-check" aria-hidden="true">
        {selectedValues.length === 0 && <Check size={15} />}
      </span>
      <span className="filter-option-label">{allLabel}</span>
      {selectedValues.length > 0 && <strong aria-hidden="true">Clear</strong>}
    </button>
  );

  return (
    <div className={`filter-dropdown filter-dropdown-${id} ${isOpen ? "open" : ""}`}>
      <span className="filter-dropdown-label">
        {icon}
        {title}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-dropdown-trigger ${selectedValues.length ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        disabled={disabled}
        onClick={toggleOpen}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{buttonLabel}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="filter-dropdown-menu" id={menuId} role="menu" aria-label={`${title} filter`}>
          {(searchable || stickyControls) && (
            <div className={`filter-menu-sticky ${stickyControls ? "with-controls" : ""}`} role="none">
              {searchable && (
                <label className="filter-menu-search">
                  <Search size={14} aria-hidden="true" />
                  <span className="sr-only">Search {title}</span>
                  <input
                    type="search"
                    value={searchQuery}
                    aria-label={`Search ${title}`}
                    autoComplete="off"
                    placeholder={`Search ${title.toLowerCase()}`}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusEntry(0);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        restoreFocus();
                      } else if (event.key === "Tab") {
                        setSearchQuery("");
                        optionRefs.current = [];
                        onOpenChange(false);
                      }
                    }}
                  />
                </label>
              )}
              {stickyControls && allOption}
            </div>
          )}
          {!stickyControls && allOption}
          {visibleGroups.map((group) => {
            const headingId = `${menuId}-${group.id}`;
            return (
              <div className="filter-menu-group" role="group" aria-labelledby={headingId} key={group.id}>
                <div className="filter-menu-group-label" id={headingId}>
                  <span>{group.label}</span>
                  <em>{group.options.length}</em>
                </div>
                {group.options.map(renderOption)}
              </div>
            );
          })}
          {ungroupedOptions.map(renderOption)}
          {visibleOptions.length === 0 && <p className="filter-menu-empty" role="status" aria-live="polite">{emptyLabel}</p>}
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
