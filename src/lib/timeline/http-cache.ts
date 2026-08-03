export interface TimelineHttpCacheScope {
  companyId?: string;
  eventId?: string;
}

interface TimelineHttpCacheEntry<T> {
  value: T;
  createdAt: number;
  scope: TimelineHttpCacheScope;
}

interface TimelineHttpCacheFlight<T> {
  promise: Promise<T>;
  invalidated: boolean;
  scope: TimelineHttpCacheScope;
}

const CACHE_ENTRY_LIMIT = 128;
const DEFAULT_TTL_MS = 30_000;
const CACHE_SYMBOL = Symbol.for("returner.timeline.http-cache.v1");
const FLIGHT_SYMBOL = Symbol.for("returner.timeline.http-cache-flights.v1");

export type TimelineHttpCacheStatus = "hit" | "miss" | "coalesced";

export interface TimelineHttpCacheResult<T> {
  value: T;
  status: TimelineHttpCacheStatus;
}

type TimelineGlobal = typeof globalThis & {
  [CACHE_SYMBOL]?: Map<string, TimelineHttpCacheEntry<unknown>>;
  [FLIGHT_SYMBOL]?: Map<string, TimelineHttpCacheFlight<unknown>>;
};

export async function getOrBuildTimelineHttpValue<T>(input: {
  key: string;
  scope: TimelineHttpCacheScope;
  build: () => Promise<T>;
  ttlMs?: number;
}): Promise<T> {
  return (await getOrBuildTimelineHttpResult(input)).value;
}

export async function getOrBuildTimelineHttpResult<T>(input: {
  key: string;
  scope: TimelineHttpCacheScope;
  build: () => Promise<T>;
  ttlMs?: number;
}): Promise<TimelineHttpCacheResult<T>> {
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const cache = cacheStore();
  const cached = cache.get(input.key) as TimelineHttpCacheEntry<T> | undefined;
  if (cached && Date.now() - cached.createdAt < ttlMs) {
    cache.delete(input.key);
    cache.set(input.key, cached);
    return { value: cached.value, status: "hit" };
  }
  if (cached) cache.delete(input.key);

  const flights = flightStore();
  const existing = flights.get(input.key) as TimelineHttpCacheFlight<T> | undefined;
  if (existing) return { value: await existing.promise, status: "coalesced" };

  const flight: TimelineHttpCacheFlight<T> = {
    invalidated: false,
    scope: { ...input.scope },
    promise: Promise.resolve()
      .then(input.build)
      .then((value) => {
        if (!flight.invalidated && flights.get(input.key) === flight) {
          remember(input.key, value, input.scope);
        }
        return value;
      })
      .finally(() => {
        if (flights.get(input.key) === flight) flights.delete(input.key);
      }),
  };
  flights.set(input.key, flight as TimelineHttpCacheFlight<unknown>);
  return { value: await flight.promise, status: "miss" };
}

/**
 * Clears process-local response data after publication or review actions. The
 * database/artifact invalidation record remains the durable cross-instance
 * signal; this helper prevents stale reads in the serverless instance that
 * handled the mutation.
 */
export function invalidateTimelineHttpCache(
  selector: TimelineHttpCacheScope = {},
): void {
  const cache = cacheStore();
  const flights = flightStore();
  for (const [key, entry] of cache) {
    if (matchesScope(entry.scope, selector)) cache.delete(key);
  }
  for (const [key, flight] of flights) {
    if (!matchesScope(flight.scope, selector)) continue;
    flight.invalidated = true;
    flights.delete(key);
  }
}

export function clearTimelineHttpCacheForTests(): void {
  cacheStore().clear();
  flightStore().clear();
}

function remember<T>(key: string, value: T, scope: TimelineHttpCacheScope): void {
  const cache = cacheStore();
  cache.delete(key);
  cache.set(key, { value, createdAt: Date.now(), scope: { ...scope } });
  while (cache.size > CACHE_ENTRY_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function matchesScope(scope: TimelineHttpCacheScope, selector: TimelineHttpCacheScope): boolean {
  return (
    (selector.companyId === undefined || selector.companyId === scope.companyId) &&
    (selector.eventId === undefined || selector.eventId === scope.eventId)
  );
}

function cacheStore(): Map<string, TimelineHttpCacheEntry<unknown>> {
  const target = globalThis as TimelineGlobal;
  return target[CACHE_SYMBOL] ??= new Map();
}

function flightStore(): Map<string, TimelineHttpCacheFlight<unknown>> {
  const target = globalThis as TimelineGlobal;
  return target[FLIGHT_SYMBOL] ??= new Map();
}
