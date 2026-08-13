import {
  isTopicFacetSnapshot,
  TOPIC_FACET_SNAPSHOT_VERSION,
  type TopicFacetSnapshot
} from "./topic-facets";

export const TOPIC_FACET_BATCHES = ["S2026", "S26", "A16ZSR006"] as const;
export type TopicFacetBatchSlug = typeof TOPIC_FACET_BATCHES[number];

const TOPIC_FACET_ENDPOINT = "/api/topic-facets";
const TOPIC_FACET_MAX_BYTES = 8 * 1024 * 1024;
const TOPIC_FACET_MAX_ROWS = 100_000;
const TOPIC_FACET_TIMEOUT_MS = 12_000;

// This is deliberately an in-flight-only map. A completed response is never
// retained, so a publish cannot be hidden by a process-local stale snapshot.
const inFlight = new Map<TopicFacetBatchSlug, Promise<TopicFacetSnapshot>>();

export function isTopicFacetBatchSlug(value: string): value is TopicFacetBatchSlug {
  return (TOPIC_FACET_BATCHES as readonly string[]).includes(value);
}

export function topicFacetApiUrl(batchSlug: TopicFacetBatchSlug): string {
  // The unique request token is defense in depth for intermediaries that do
  // not honor no-store. The route itself also sends explicit no-store headers.
  return `${TOPIC_FACET_ENDPOINT}/${encodeURIComponent(batchSlug)}?v=${encodeURIComponent(
    TOPIC_FACET_SNAPSHOT_VERSION
  )}&refresh=${Date.now().toString(36)}`;
}

export function isCurrentTopicFacetSnapshot(
  value: unknown,
  batchSlug: TopicFacetBatchSlug
): value is TopicFacetSnapshot {
  if (!isTopicFacetSnapshot(value)) return false;
  if (value.batchSlug !== batchSlug) return false;
  if (
    value.rows.length > TOPIC_FACET_MAX_ROWS ||
    !Number.isInteger(value.rowCount) ||
    value.rowCount !== value.rows.length
  ) {
    return false;
  }
  return true;
}

export async function loadCurrentTopicFacetSnapshot(
  batchSlug: TopicFacetBatchSlug,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<TopicFacetSnapshot> {
  // A caller-owned signal cannot be shared: an obsolete graph request may
  // abort its own hydration while a newer same-batch graph is still active.
  // Requests without a signal retain the lightweight in-flight dedupe used by
  // non-React callers and tests.
  if (options.signal) {
    return fetchTopicFacetSnapshot(batchSlug, options);
  }

  const existing = inFlight.get(batchSlug);
  if (existing) return existing;

  const request = fetchTopicFacetSnapshot(batchSlug, options).finally(() => {
    if (inFlight.get(batchSlug) === request) inFlight.delete(batchSlug);
  });
  inFlight.set(batchSlug, request);
  return request;
}

/**
 * There is no completed-response cache to invalidate. This only clears
 * requests that have already settled and is useful for isolated test setups.
 */
export function clearTopicFacetSnapshotLoaderState(): void {
  inFlight.clear();
}

async function fetchTopicFacetSnapshot(
  batchSlug: TopicFacetBatchSlug,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<TopicFacetSnapshot> {
  if (options.signal?.aborted) throw abortError();

  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeoutId = setTimeout(() => controller.abort(), TOPIC_FACET_TIMEOUT_MS);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(topicFacetApiUrl(batchSlug), {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Topic-Facets-Version": TOPIC_FACET_SNAPSHOT_VERSION
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Topic facet snapshot request failed (${response.status}).`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > TOPIC_FACET_MAX_BYTES) {
      throw new Error("Topic facet snapshot response exceeded the size limit.");
    }

    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > TOPIC_FACET_MAX_BYTES) {
      throw new Error("Topic facet snapshot response exceeded the size limit.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error("Topic facet snapshot response was not valid JSON.", { cause: error });
    }
    if (!isCurrentTopicFacetSnapshot(parsed, batchSlug)) {
      throw new Error("Topic facet snapshot response failed batch, version, or shape validation.");
    }
    return parsed;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abort);
  }
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export { TOPIC_FACET_MAX_BYTES, TOPIC_FACET_MAX_ROWS };
