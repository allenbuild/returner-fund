import { validateStaticGraphSnapshotContract } from "./static-graph-snapshot-contract.mjs";
import { readRuntimeGraphSnapshotFile } from "./runtime-graph-snapshot-file";
import type { GraphResponse, TopVoiceAudienceId } from "./types";

export const PUBLISHED_GRAPH_BATCH_FILES = {
  S2026: "s2026",
  S26: "s26",
  A16ZSR006: "a16zsr006"
} as const;

export type PublishedGraphBatchSlug = keyof typeof PUBLISHED_GRAPH_BATCH_FILES;

const GRAPH_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;
const GRAPH_SNAPSHOT_FETCH_TIMEOUT_MS = 12_000;
const GRAPH_SNAPSHOT_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const GRAPH_SNAPSHOT_CACHE_TTL_MS = 60_000;
const GRAPH_AUDIENCE_SUFFIX = {
  off: "",
  yc_partners: "-yc-partners",
  insiders: "-insiders"
} as const satisfies Record<TopVoiceAudienceId, string>;

interface CachedPublishedGraph {
  graph: GraphResponse;
  bytes: number;
  cachedAt: number;
}

const publishedGraphCache = new Map<string, CachedPublishedGraph>();
const publishedGraphInFlight = new Map<string, Promise<GraphResponse>>();
let publishedGraphCacheBytes = 0;

export function isPublishedGraphBatchSlug(value: string): value is PublishedGraphBatchSlug {
  return Object.hasOwn(PUBLISHED_GRAPH_BATCH_FILES, value);
}

export function publishedGraphSnapshotFilename(
  batchSlug: PublishedGraphBatchSlug,
  audienceId: TopVoiceAudienceId
): string {
  return `${PUBLISHED_GRAPH_BATCH_FILES[batchSlug]}${GRAPH_AUDIENCE_SUFFIX[audienceId]}.json`;
}

export async function loadPublishedGraphSnapshot(input: {
  batchSlug: PublishedGraphBatchSlug;
  audienceId: TopVoiceAudienceId;
  fetchImpl?: typeof fetch;
}): Promise<GraphResponse> {
  const filename = publishedGraphSnapshotFilename(input.batchSlug, input.audienceId);
  const cached = publishedGraphCache.get(filename);
  if (cached && Date.now() - cached.cachedAt < GRAPH_SNAPSHOT_CACHE_TTL_MS) {
    publishedGraphCache.delete(filename);
    publishedGraphCache.set(filename, cached);
    return cached.graph;
  }
  if (cached) {
    publishedGraphCache.delete(filename);
    publishedGraphCacheBytes -= cached.bytes;
  }

  const existingFlight = publishedGraphInFlight.get(filename);
  if (existingFlight) return existingFlight;
  const flight = loadAndValidatePublishedGraph(input, filename).finally(() => {
    if (publishedGraphInFlight.get(filename) === flight) {
      publishedGraphInFlight.delete(filename);
    }
  });
  publishedGraphInFlight.set(filename, flight);
  return flight;
}

async function loadAndValidatePublishedGraph(
  input: {
    batchSlug: PublishedGraphBatchSlug;
    audienceId: TopVoiceAudienceId;
    fetchImpl?: typeof fetch;
  },
  filename: string
): Promise<GraphResponse> {
  let raw: string;
  try {
    raw = await readRuntimeGraphSnapshotFile(filename);
  } catch (fileError) {
    raw = await fetchPublishedGraphSnapshot(filename, fileError, input.fetchImpl ?? fetch);
  }

  if (Buffer.byteLength(raw) > GRAPH_SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `Published graph snapshot ${filename} exceeded the ${GRAPH_SNAPSHOT_MAX_BYTES}-byte limit.`
    );
  }

  let graph: GraphResponse;
  try {
    graph = JSON.parse(raw) as GraphResponse;
  } catch (error) {
    throw new Error(`Published graph snapshot ${filename} contained invalid JSON.`, {
      cause: error
    });
  }

  const validation = validateStaticGraphSnapshotContract(graph);
  if (!validation.ok) {
    const summary = validation.issues
      .slice(0, 3)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Published graph snapshot ${filename} failed the canonical contract${summary ? `: ${summary}` : "."}`
    );
  }
  if (
    graph.batch.slug !== input.batchSlug ||
    graph.selectedTopVoiceAudience.id !== input.audienceId
  ) {
    throw new Error(`Published graph snapshot ${filename} did not match the requested graph scope.`);
  }

  rememberPublishedGraph(filename, graph, Buffer.byteLength(raw));
  return graph;
}

export function clearPublishedGraphSnapshotCache(): void {
  publishedGraphCache.clear();
  publishedGraphInFlight.clear();
  publishedGraphCacheBytes = 0;
}

function rememberPublishedGraph(filename: string, graph: GraphResponse, bytes: number): void {
  if (bytes > GRAPH_SNAPSHOT_CACHE_MAX_BYTES) return;
  const existing = publishedGraphCache.get(filename);
  if (existing) {
    publishedGraphCache.delete(filename);
    publishedGraphCacheBytes -= existing.bytes;
  }
  publishedGraphCache.set(filename, { graph, bytes, cachedAt: Date.now() });
  publishedGraphCacheBytes += bytes;
  while (publishedGraphCacheBytes > GRAPH_SNAPSHOT_CACHE_MAX_BYTES) {
    const oldestFilename = publishedGraphCache.keys().next().value;
    if (oldestFilename === undefined) break;
    const oldest = publishedGraphCache.get(oldestFilename);
    publishedGraphCache.delete(oldestFilename);
    publishedGraphCacheBytes -= oldest?.bytes ?? 0;
  }
}

async function fetchPublishedGraphSnapshot(
  filename: string,
  fileError: unknown,
  fetchImpl: typeof fetch
): Promise<string> {
  const snapshotUrl = new URL(`/graph/${filename}`, trustedDeploymentOrigin());
  let response: Response;
  try {
    response = await fetchImpl(snapshotUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(GRAPH_SNAPSHOT_FETCH_TIMEOUT_MS)
    });
  } catch (fetchError) {
    throw new AggregateError(
      [fileError, fetchError],
      `Published graph snapshot ${filename} was unavailable from disk and CDN.`
    );
  }
  if (!response.ok) {
    throw new AggregateError(
      [fileError, new Error(`HTTP ${response.status} from ${snapshotUrl.pathname}`)],
      `Published graph snapshot ${filename} could not be loaded.`
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > GRAPH_SNAPSHOT_MAX_BYTES) {
    throw new Error(
      `Published graph snapshot ${filename} exceeded the ${GRAPH_SNAPSHOT_MAX_BYTES}-byte limit.`
    );
  }
  return readBoundedResponseText(response, filename);
}

async function readBoundedResponseText(
  response: Response,
  filename: string
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > GRAPH_SNAPSHOT_MAX_BYTES) {
        await reader.cancel("Published graph snapshot exceeded its byte limit.");
        throw new Error(
          `Published graph snapshot ${filename} exceeded the ${GRAPH_SNAPSHOT_MAX_BYTES}-byte limit.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function trustedDeploymentOrigin(): URL {
  const vercelHost = process.env.VERCEL_URL?.trim();
  if (vercelHost) {
    try {
      return new URL(
        vercelHost.startsWith("http://") || vercelHost.startsWith("https://")
          ? vercelHost
          : `https://${vercelHost}`
      );
    } catch {
      // Fall through to the configured public origin.
    }
  }
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // Fall through to the canonical production origin.
    }
  }
  return new URL("https://www.returner.fund");
}
