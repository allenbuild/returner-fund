import type {
  CompanyTimelineEventDetailArtifact,
  PublishedTimelineEvent,
  PublicTimelineCoverage,
  TimelineCategory,
  TimelineCompanyRef,
  TimelineMonthGroup,
} from "@/lib/timeline/contracts";

export interface TimelineFiltersState {
  from: string | null;
  to: string | null;
  categories: TimelineCategory[];
}

export interface CompanyTimelinePage {
  company: TimelineCompanyRef;
  events: PublishedTimelineEvent[];
  groups: TimelineMonthGroup[];
  coverage: PublicTimelineCoverage;
  nextCursor: string | null;
}

const timelinePageCache = new Map<string, Promise<CompanyTimelinePage>>();
const timelineDetailCache = new Map<string, Promise<CompanyTimelineEventDetailArtifact>>();

export function companyTimelineUrl(
  slug: string,
  filters: TimelineFiltersState,
  cursor: string | null = null,
): string {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.categories.length) params.set("categories", filters.categories.join(","));
  if (cursor) params.set("cursor", cursor);
  // The public API remains bounded at 100 events and the generated artifact
  // itself is capped at 100 KB. Loading the bounded maximum keeps the sticky
  // date navigation and visible result count complete for normal company
  // histories while preserving cursor pagination for larger histories.
  params.set("limit", "100");
  return `/api/companies/${encodeURIComponent(slug)}/timeline?${params.toString()}`;
}

export function loadCompanyTimeline(
  slug: string,
  filters: TimelineFiltersState,
  options: { cursor?: string | null; signal?: AbortSignal; useCache?: boolean } = {},
): Promise<CompanyTimelinePage> {
  const cursor = options.cursor ?? null;
  const url = companyTimelineUrl(slug, filters, cursor);
  const canReadCache = options.useCache !== false && cursor === null;
  const canWriteCache = canReadCache && !options.signal;
  const cached = canReadCache ? timelinePageCache.get(url) : null;
  if (cached) return cached;

  const request = fetch(url, {
    headers: { accept: "application/json" },
    signal: options.signal,
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(response.status === 404
        ? "No published timeline is available for this company yet."
        : `Timeline request failed with ${response.status}.`);
    }
    return timelinePageFromUnknown(await response.json());
  });

  if (canWriteCache) {
    timelinePageCache.set(url, request);
    void request.catch(() => timelinePageCache.delete(url));
  }
  return request;
}

export function prefetchCompanyTimeline(slug: string): Promise<CompanyTimelinePage> {
  return loadCompanyTimeline(slug, { from: null, to: null, categories: [] });
}

export function loadTimelineEventDetail(
  eventId: string,
  signal?: AbortSignal,
): Promise<CompanyTimelineEventDetailArtifact> {
  const url = `/api/timeline/events/${encodeURIComponent(eventId)}`;
  if (!signal) {
    const cached = timelineDetailCache.get(url);
    if (cached) return cached;
  }

  const request = fetch(url, {
    headers: { accept: "application/json" },
    signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Event evidence request failed with ${response.status}.`);
    return eventDetailFromUnknown(await response.json());
  });
  if (!signal) {
    timelineDetailCache.set(url, request);
    void request.catch(() => timelineDetailCache.delete(url));
  }
  return request;
}

export function clearTimelineClientCache(): void {
  timelinePageCache.clear();
  timelineDetailCache.clear();
}

function timelinePageFromUnknown(value: unknown): CompanyTimelinePage {
  const record = objectRecord(value);
  const company = objectRecord(record.company);
  if (
    typeof company.id !== "string" ||
    typeof company.slug !== "string" ||
    typeof company.name !== "string" ||
    !Array.isArray(record.events) ||
    !Array.isArray(record.groups)
  ) {
    throw new Error("Timeline response was malformed.");
  }
  const coverage = objectRecord(record.coverage);
  if (typeof coverage.status !== "string" || typeof coverage.publishedEventCount !== "number") {
    throw new Error("Timeline coverage response was malformed.");
  }
  return {
    company: company as unknown as TimelineCompanyRef,
    events: record.events as PublishedTimelineEvent[],
    groups: record.groups as TimelineMonthGroup[],
    coverage: coverage as unknown as PublicTimelineCoverage,
    nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
  };
}

function eventDetailFromUnknown(value: unknown): CompanyTimelineEventDetailArtifact {
  const record = objectRecord(value);
  const event = objectRecord(record.event);
  if (
    typeof event.id !== "string" ||
    !Array.isArray(event.evidence) ||
    !Array.isArray(event.posts)
  ) {
    throw new Error("Event evidence response was malformed.");
  }
  return value as CompanyTimelineEventDetailArtifact;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Timeline response was malformed.");
  }
  return value as Record<string, unknown>;
}
