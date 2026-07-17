import type { GraphResponse, TopVoiceAudienceId } from "./types";

export interface GraphResponseCacheScope {
  batchSlug: string;
  topVoices: TopVoiceAudienceId;
}

export interface GraphResponseCacheScopeSelector {
  batchSlug: string;
  topVoices?: TopVoiceAudienceId;
}

interface GetOrBuildGraphResponseOptions {
  cacheKey: string;
  ttlMs: number;
  scope: GraphResponseCacheScope;
  build: () => GraphResponse | Promise<GraphResponse>;
}

interface CachedGraphResponse {
  createdAt: number;
  graph: GraphResponse;
  scope: GraphResponseCacheScope | null;
}

interface InFlightGraphResponse {
  invalidated: boolean;
  promise: Promise<GraphResponse>;
  scope: GraphResponseCacheScope;
}

const GRAPH_RESPONSE_CACHE_LIMIT = 64;
const GLOBAL_CACHE_KEY = "__returnerFundGraphResponseCache";
const GLOBAL_IN_FLIGHT_KEY = "__returnerFundGraphResponseInFlight";

declare global {
  var __returnerFundGraphResponseCache: Map<string, CachedGraphResponse> | undefined;
  var __returnerFundGraphResponseInFlight: Map<string, InFlightGraphResponse> | undefined;
}

function cacheStore(): Map<string, CachedGraphResponse> {
  globalThis[GLOBAL_CACHE_KEY] ??= new Map<string, CachedGraphResponse>();
  return globalThis[GLOBAL_CACHE_KEY];
}

function inFlightStore(): Map<string, InFlightGraphResponse> {
  globalThis[GLOBAL_IN_FLIGHT_KEY] ??= new Map<string, InFlightGraphResponse>();
  return globalThis[GLOBAL_IN_FLIGHT_KEY];
}

export function getCachedGraphResponse(
  cacheKey: string,
  ttlMs: number,
  scope?: GraphResponseCacheScope
): GraphResponse | null {
  const store = cacheStore();
  const identity = scopedIdentity(cacheKey, scope);
  const cached = store.get(identity);
  if (!cached || Date.now() - cached.createdAt >= ttlMs) {
    if (cached) {
      store.delete(identity);
    }
    return null;
  }

  return cached.graph;
}

export function setCachedGraphResponse(
  cacheKey: string,
  graph: GraphResponse,
  scope?: GraphResponseCacheScope
): void {
  setCachedGraphResponseForScope(cacheKey, graph, scope ? copyScope(scope) : null);
}

export function getOrBuildCachedGraphResponse({
  cacheKey,
  ttlMs,
  scope,
  build
}: GetOrBuildGraphResponseOptions): Promise<GraphResponse> {
  const requestScope = copyScope(scope);
  const cached = getCachedGraphResponse(cacheKey, ttlMs, requestScope);
  if (cached) {
    return Promise.resolve(cached);
  }

  const identity = scopedIdentity(cacheKey, requestScope);
  const flights = inFlightStore();
  const existing = flights.get(identity);
  if (existing) {
    return existing.promise;
  }

  const flight: InFlightGraphResponse = {
    invalidated: false,
    promise: Promise.resolve()
      .then(build)
      .then((graph) => {
        if (!flight.invalidated && flights.get(identity) === flight) {
          setCachedGraphResponseForScope(cacheKey, graph, requestScope);
        }
        return graph;
      })
      .finally(() => {
        if (flights.get(identity) === flight) {
          flights.delete(identity);
        }
      }),
    scope: requestScope
  };
  flights.set(identity, flight);
  return flight.promise;
}

export function clearGraphResponseCache(scope?: GraphResponseCacheScopeSelector): void {
  const cached = cacheStore();
  const flights = inFlightStore();

  if (!scope) {
    cached.clear();
    for (const flight of flights.values()) {
      flight.invalidated = true;
    }
    flights.clear();
    return;
  }

  for (const [identity, entry] of cached) {
    if (matchesScope(entry.scope, scope)) {
      cached.delete(identity);
    }
  }
  for (const [identity, flight] of flights) {
    if (matchesScope(flight.scope, scope)) {
      flight.invalidated = true;
      flights.delete(identity);
    }
  }
}

function setCachedGraphResponseForScope(
  cacheKey: string,
  graph: GraphResponse,
  scope: GraphResponseCacheScope | null
): void {
  const store = cacheStore();
  const identity = scopedIdentity(cacheKey, scope ?? undefined);
  store.delete(identity);
  store.set(identity, { createdAt: Date.now(), graph, scope });
  if (store.size > GRAPH_RESPONSE_CACHE_LIMIT) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }
}

function scopedIdentity(cacheKey: string, scope?: GraphResponseCacheScope): string {
  return JSON.stringify([scope?.batchSlug ?? null, scope?.topVoices ?? null, cacheKey]);
}

function copyScope(scope: GraphResponseCacheScope): GraphResponseCacheScope {
  return {
    batchSlug: scope.batchSlug,
    topVoices: scope.topVoices
  };
}

function matchesScope(
  cachedScope: GraphResponseCacheScope | null | undefined,
  selector: GraphResponseCacheScopeSelector
): boolean {
  return Boolean(
    cachedScope &&
      cachedScope.batchSlug === selector.batchSlug &&
      (selector.topVoices === undefined || cachedScope.topVoices === selector.topVoices)
  );
}
