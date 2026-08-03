"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublishedTimelineEvent } from "@/lib/timeline/contracts";
import { loadCompanyTimeline, type TimelineFiltersState } from "./client";
import { TimelineEventCard } from "./TimelineEventCard";
import { TimelineFilters } from "./TimelineFilters";
import styles from "./CompanyTimeline.module.css";

interface CompanyTimelineProps {
  companySlug: string;
  companyName: string;
}

interface EventMonth {
  month: string;
  year: number;
  events: PublishedTimelineEvent[];
}

const EMPTY_FILTERS: TimelineFiltersState = { from: null, to: null, categories: [] };

export function CompanyTimeline({ companySlug, companyName }: CompanyTimelineProps) {
  const [filters, setFilters] = useState<TimelineFiltersState>(EMPTY_FILTERS);
  const [urlHydrated, setUrlHydrated] = useState(false);
  const [events, setEvents] = useState<PublishedTimelineEvent[]>([]);
  const [resultCount, setResultCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [coverageStatus, setCoverageStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const requestSequenceRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const measuredSwitchRef = useRef<number | null>(null);

  useEffect(() => {
    const syncFromUrl = () => {
      const nextFilters = readTimelineFilters(window.location.search);
      setFilters(nextFilters);
      if (new URLSearchParams(window.location.search).has("timelineCategories")) {
        writeTimelineFilters(nextFilters);
      }
      setUrlHydrated(true);
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => () => requestAbortRef.current?.abort(), []);

  useEffect(() => {
    if (loading || !events.length) return;
    const measuredWindow = window as Window & {
      __returnerTimelineSwitchAt?: number;
      __returnerTimelineSwitchSequence?: number;
    };
    const sequence = measuredWindow.__returnerTimelineSwitchSequence;
    const startedAt = measuredWindow.__returnerTimelineSwitchAt;
    if (sequence === undefined || startedAt === undefined || measuredSwitchRef.current === sequence) return;
    measuredSwitchRef.current = sequence;
    const frame = window.requestAnimationFrame(() => {
      const durationMs = Math.max(0, window.performance.now() - startedAt);
      shellRef.current?.setAttribute("data-timeline-render-latency-ms", durationMs.toFixed(2));
      window.performance.mark?.("returner:timeline-visible");
      try {
        window.performance.measure?.(
          "returner:timeline-click-to-visible",
          "returner:timeline-switch",
          "returner:timeline-visible",
        );
      } catch {
        // The DOM data attribute below remains available if a browser clears
        // User Timing marks between the click and the committed render.
      }
      window.dispatchEvent(new CustomEvent("returner:timeline-render", {
        detail: { companySlug, durationMs, eventCount: events.length },
      }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [companySlug, events.length, loading]);

  const fetchFirstPage = useCallback(async () => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestId = ++requestSequenceRef.current;
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    try {
      const page = await loadCompanyTimeline(companySlug, filters, { signal: controller.signal });
      if (requestSequenceRef.current !== requestId || controller.signal.aborted) return;
      const sortedEvents = uniqueNewestFirst(page.events);
      setEvents(sortedEvents);
      setResultCount(page.groups.reduce(
        (total, group) => total + group.months.reduce((yearTotal, month) => yearTotal + month.count, 0),
        0,
      ));
      setNextCursor(page.nextCursor);
      setCoverageStatus(page.coverage.status);
    } catch (caught) {
      if (requestSequenceRef.current !== requestId || controller.signal.aborted) return;
      setEvents([]);
      setResultCount(0);
      setNextCursor(null);
      setError(caught instanceof Error ? caught.message : "Company timeline could not be loaded.");
    } finally {
      if (requestSequenceRef.current === requestId && !controller.signal.aborted) setLoading(false);
    }
  }, [companySlug, filters]);

  useEffect(() => {
    if (!urlHydrated) return;
    const handle = window.setTimeout(() => void fetchFirstPage(), 0);
    return () => window.clearTimeout(handle);
  }, [fetchFirstPage, urlHydrated]);

  const eventMonths = useMemo(() => groupEventsByMonth(events), [events]);

  function changeFilters(nextFilters: TimelineFiltersState) {
    // Cancel an in-flight older-page request immediately. Waiting for the
    // effect that loads the new first page leaves a window where stale events
    // can be appended under the newly selected filters.
    requestAbortRef.current?.abort();
    requestSequenceRef.current += 1;
    setLoadingMore(false);
    setFilters(nextFilters);
    writeTimelineFilters(nextFilters);
  }

  async function loadOlderEvents() {
    if (!nextCursor || loadingMore) return;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestId = ++requestSequenceRef.current;
    const requestedCursor = nextCursor;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await loadCompanyTimeline(companySlug, filters, {
        cursor: requestedCursor,
        signal: controller.signal,
        useCache: false,
      });
      if (requestSequenceRef.current !== requestId || controller.signal.aborted) return;
      setEvents((current) => uniqueNewestFirst([...current, ...page.events]));
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (requestSequenceRef.current !== requestId || controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Older timeline events could not be loaded.");
    } finally {
      if (requestSequenceRef.current === requestId && !controller.signal.aborted) setLoadingMore(false);
    }
  }

  return (
    <div className={styles.timeline} ref={shellRef} aria-busy={loading}>
      <TimelineFilters filters={filters} resultCount={resultCount} loading={loading} onChange={changeFilters} />

      {loading && !events.length ? <TimelineSkeleton /> : null}
      {error && !events.length ? (
        <div className={styles.stateCard} role="alert">
          <strong>Timeline unavailable</strong>
          <p>{error}</p>
          <button type="button" onClick={() => void fetchFirstPage()}>
            <RefreshCw size={16} aria-hidden="true" /> Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && !events.length ? (
        <div className={styles.stateCard}>
          <strong>No timeline events found</strong>
          <p>
            {filters.from || filters.to
              ? "No published events match the selected date range."
              : `No directly evidenced events are published for ${companyName} yet.`}
          </p>
          {(filters.from || filters.to) ? (
            <button type="button" onClick={() => changeFilters(EMPTY_FILTERS)}>Clear filters</button>
          ) : null}
        </div>
      ) : null}

      {events.length ? (
        <div className={styles.eventColumn}>
          {eventMonths.map((group, groupIndex) => {
            const priorYear = eventMonths[groupIndex - 1]?.year;
            return (
              <section
                className={styles.monthSection}
                data-timeline-month={group.month}
                id={`timeline-${group.month}`}
                key={group.month}
                aria-labelledby={`timeline-heading-${group.month}`}
              >
                {priorYear !== group.year ? <h3 className={styles.yearHeading}>{group.year}</h3> : null}
                <h4 className={styles.monthHeading} id={`timeline-heading-${group.month}`}>
                  {formatMonthHeading(group.month)}
                </h4>
                <ol className={styles.eventList}>
                  {group.events.map((event) => (
                    <li key={event.id}>
                      <span className={styles.timelineMarker} aria-hidden="true" />
                      <TimelineEventCard event={event} />
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}

          {error ? <p className={styles.inlineError} role="alert">{error}</p> : null}
          {nextCursor ? (
            <button
              type="button"
              className={styles.loadMoreButton}
              disabled={loadingMore}
              onClick={() => void loadOlderEvents()}
            >
              {loadingMore ? <LoaderCircle className={styles.spinner} size={17} aria-hidden="true" /> : null}
              {loadingMore ? "Loading older events…" : "Show older events"}
            </button>
          ) : null}
          {coverageStatus && coverageStatus !== "complete" ? (
            <p className={styles.coverageNote}>Historical source coverage is still being expanded.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-label="Loading company timeline">
      <span />
      <span />
      <span />
    </div>
  );
}

function readTimelineFilters(search: string): TimelineFiltersState {
  const params = new URLSearchParams(search);
  return {
    from: validIsoDay(params.get("timelineFrom")),
    to: validIsoDay(params.get("timelineTo")),
    categories: [],
  };
}

function writeTimelineFilters(filters: TimelineFiltersState) {
  const url = new URL(window.location.href);
  setParameter(url, "timelineFrom", filters.from);
  setParameter(url, "timelineTo", filters.to);
  url.searchParams.delete("timelineCategories");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(window.history.state, "", next);
}

function setParameter(url: URL, key: string, value: string | null) {
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
}

function validIsoDay(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function uniqueNewestFirst(events: PublishedTimelineEvent[]): PublishedTimelineEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((left, right) => right.eventDate.localeCompare(left.eventDate) || left.id.localeCompare(right.id));
}

function groupEventsByMonth(events: PublishedTimelineEvent[]): EventMonth[] {
  const groups = new Map<string, PublishedTimelineEvent[]>();
  for (const event of events) {
    const month = event.eventDate.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), event]);
  }
  return [...groups.entries()].map(([month, monthEvents]) => ({
    month,
    year: Number(month.slice(0, 4)),
    events: monthEvents,
  }));
}

function formatMonthHeading(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}
