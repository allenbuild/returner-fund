import type { GraphResponse } from "./types";

interface CachedGraphResponse {
  createdAt: number;
  graph: GraphResponse;
}

const GRAPH_RESPONSE_CACHE_LIMIT = 64;
const GLOBAL_CACHE_KEY = "__returnerFundGraphResponseCache";

declare global {
  // eslint-disable-next-line no-var
  var __returnerFundGraphResponseCache: Map<string, CachedGraphResponse> | undefined;
}

function cacheStore(): Map<string, CachedGraphResponse> {
  globalThis[GLOBAL_CACHE_KEY] ??= new Map<string, CachedGraphResponse>();
  return globalThis[GLOBAL_CACHE_KEY];
}

export function getCachedGraphResponse(cacheKey: string, ttlMs: number): GraphResponse | null {
  const cached = cacheStore().get(cacheKey);
  if (!cached || Date.now() - cached.createdAt >= ttlMs) {
    return null;
  }

  return cached.graph;
}

export function setCachedGraphResponse(cacheKey: string, graph: GraphResponse): void {
  const store = cacheStore();
  store.set(cacheKey, { createdAt: Date.now(), graph });
  if (store.size > GRAPH_RESPONSE_CACHE_LIMIT) {
    const oldestKey = store.keys().next().value;
    if (oldestKey) {
      store.delete(oldestKey);
    }
  }
}

export function clearGraphResponseCache(): void {
  cacheStore().clear();
}
