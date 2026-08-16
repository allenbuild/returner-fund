"use client";

import {
  ChevronDown,
  Clock3,
  ExternalLink,
  Sparkles
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { PlatformLogo, formatPlatform } from "@/components/PlatformLogo";
import {
  DASHBOARD_PLATFORMS,
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_SOURCE_DETAIL_LIMIT,
  DASHBOARD_TOP_LIMIT,
  DASHBOARD_TOPICS,
  DASHBOARD_TREND_STATUSES,
  DASHBOARD_VIEWS,
  DASHBOARD_WINDOW_MS,
  type DashboardPublicFeedSnapshot,
  type DashboardStoryCard,
  type DashboardViewRanking
} from "@/lib/dashboard/contracts";
import { PLATFORM_VALUES, type Platform } from "@/lib/graph/types";
import { safeDashboardThumbnailUrl } from "@/lib/dashboard/thumbnail-policy";
import styles from "./TopStoriesDashboard.module.css";

type RankedDashboardStory = {
  story: DashboardStoryCard;
  ranking: DashboardViewRanking;
};

type DashboardSnapshotExtras = {
  generatedAt?: string | null;
  status?: unknown;
};

interface TopStoriesDashboardProps {
  snapshot: DashboardPublicFeedSnapshot | null | undefined;
}

const knownPlatforms = new Set<string>(PLATFORM_VALUES);
const DASHBOARD_CURRENT_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const DASHBOARD_RECOVERY_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
const DASHBOARD_RECOVERY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

/**
 * A deliberately single-purpose public index. The worker owns discovery and
 * scoring; this client only lays out the published Top 100 snapshot and never
 * implies audience metrics when a publisher has not supplied them.
 */
export function TopStoriesDashboard({ snapshot }: TopStoriesDashboardProps) {
  const [now, setNow] = useState<number | null>(null);
  const [recoveredSnapshot, setRecoveredSnapshot] = useState<DashboardPublicFeedSnapshot | null>(null);
  const recoveryAttempted = useRef(false);

  useEffect(() => {
    const refreshNow = () => setNow(Date.now());
    refreshNow();
    const interval = window.setInterval(refreshNow, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!needsSnapshotRecovery(snapshot) || recoveryAttempted.current) return;
    recoveryAttempted.current = true;

    let active = true;
    const controller = new AbortController();

    void fetch("/api/dashboard", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        if (active && isCurrentPublishedFeedSnapshot(payload)) setRecoveredSnapshot(payload);
      })
      .catch(() => {
        // The SSR empty state remains visible if the one client recovery
        // request cannot reach the already-published public feed.
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [snapshot]);

  const displayedSnapshot = needsSnapshotRecovery(snapshot) ? recoveredSnapshot ?? snapshot : snapshot;
  const stories = consolidatedStories(safeStories(displayedSnapshot));
  const snapshotExtras = displayedSnapshot as DashboardSnapshotExtras | null | undefined;
  const freshness = dashboardFreshness(displayedSnapshot, snapshotExtras, now);

  return (
    <section className={styles.dashboard}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.headerCopy}>
            <div>
              <p className={styles.eyebrow}>Technology discovery</p>
              <h1>Top 100 in Tech</h1>
              <p>A single 24-hour index of direct-source technology reporting, research, and releases.</p>
            </div>
            <time className={styles.freshness} dateTime={freshness.dateTime ?? undefined} aria-live="polite">
              <Clock3 size={16} aria-hidden="true" />
              {freshness.label}
            </time>
          </div>
        </header>

        <section className={styles.ranking} aria-label="Top 100 technology stories">
          <div className={styles.rankingHeader}>
            {stories.length > 0 && (
              <p className={styles.storyCount} id="dashboard-top-100">
                {stories.length} {stories.length === 1 ? "story" : "stories"}
              </p>
            )}
          </div>

          {stories.length > 0 ? (
            <ol className={styles.storyGrid} aria-label="Top 100 technology stories">
              {stories.map(({ story, ranking }) => (
                <StoryCard key={story.id} now={now} ranking={ranking} story={story} />
              ))}
            </ol>
          ) : (
            <div className={styles.emptyState} role="status">
              <Sparkles size={24} aria-hidden="true" />
              <strong>The Top 100 is being prepared.</strong>
              <span>{dashboardStatusMessage(snapshotExtras?.status)}</span>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function StoryCard({
  now,
  ranking,
  story
}: {
  now: number | null;
  ranking: DashboardViewRanking;
  story: DashboardStoryCard;
}) {
  const primarySource = sourcePresentation(story.primarySource);
  const primaryPlatform = primarySource.platform ?? story.platforms.find(Boolean) ?? null;
  const sourceLabel = primarySource.publisher ?? (primaryPlatform ? displayPlatform(primaryPlatform) : "Technology");
  const engagementSummary = compactEngagement(story.engagement);

  return (
    <li>
      <article className={styles.storyCard}>
        <div className={styles.media}>
          <span className={styles.rank} aria-label={"Item " + ranking.rank}>#{ranking.rank}</span>
          <StoryThumbnail sourceUrl={primarySource.url} story={story} />
        </div>
        <div className={styles.storyBody}>
          <div className={styles.sourceLine}>
            {primaryPlatform && isKnownPlatform(primaryPlatform) && (
              <PlatformLogo decorative platform={primaryPlatform} />
            )}
            <span>{sourceLabel}</span>
            {story.universe === "returner" && story.labels.slice(0, 1).map((label) => (
              <span className={styles.returnerLabel} key={label}>{label}</span>
            ))}
          </div>

          <h3 className={styles.storyTitle}>
            {primarySource.url ? (
              <a href={primarySource.url} target="_blank" rel="noreferrer">
                {story.title}
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            ) : story.title}
          </h3>
          <p className={styles.summary}>{story.summary}</p>

          <div className={styles.metadata}>
            {story.publishedAt && <time dateTime={story.publishedAt}>{displayRelativeDate(story.publishedAt, now)}</time>}
            {engagementSummary && <span>{engagementSummary}</span>}
            <span>{story.sourceCount} {story.sourceCount === 1 ? "source" : "sources"}</span>
          </div>

          {story.sourceCount > 0 && (
            <StorySources now={now} sourceCount={story.sourceCount} stableKey={story.stableKey} />
          )}
        </div>
      </article>
    </li>
  );
}

function StoryThumbnail({
  sourceUrl,
  story
}: {
  sourceUrl: string | null;
  story: DashboardStoryCard;
}) {
  const thumbnailUrl = safeDashboardThumbnailUrl(story.thumbnailUrl);
  const thumbnailAlt = stringValue(story.thumbnailAlt) ?? story.title + " thumbnail";
  const [imageFailed, setImageFailed] = useState(false);
  const fallbackPlatform = story.platforms.find(isKnownPlatform);
  const fallbackLabel = fallbackPlatform
    ? displayPlatform(fallbackPlatform)
    : story.platforms[0]
      ? displayPlatform(story.platforms[0])
      : "Technology";

  const media = (
    <span className={styles.thumbnail}>
      {thumbnailUrl && !imageFailed ? (
        <Image
          alt={thumbnailAlt}
          className={styles.thumbnailImage}
          fill
          loading="lazy"
          onError={() => setImageFailed(true)}
          quality={75}
          sizes="(max-width: 600px) 100vw, (max-width: 960px) 50vw, (max-width: 1280px) 33vw, 25vw"
          src={thumbnailUrl}
        />
      ) : (
        <span className={styles.thumbnailFallback} aria-label={thumbnailAlt}>
          {fallbackPlatform ? <PlatformLogo decorative platform={fallbackPlatform} /> : <Sparkles size={28} aria-hidden="true" />}
          <span>{fallbackLabel}</span>
        </span>
      )}
    </span>
  );

  return sourceUrl ? (
    <a
      aria-label={"Open " + story.title}
      className={styles.thumbnailLink}
      href={sourceUrl}
      rel="noreferrer"
      target="_blank"
    >
      {media}
    </a>
  ) : media;
}

function StorySources({
  now,
  sourceCount,
  stableKey
}: {
  now: number | null;
  sourceCount: number;
  stableKey: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [sources, setSources] = useState<unknown[]>([]);
  const [truncated, setTruncated] = useState(false);

  const loadSources = async () => {
    setState("loading");
    try {
      const response = await fetch(
        "/api/dashboard/stories/" + encodeURIComponent(stableKey) + "/sources",
        { headers: { Accept: "application/json" } }
      );
      if (!response.ok) throw new Error("source_detail_request_failed");
      const payload: unknown = await response.json();
      const detail = sourceDetailPayload(payload, stableKey);
      if (!detail) throw new Error("invalid_source_detail_payload");
      setSources(detail.sources);
      setTruncated(detail.truncated);
      setState("loaded");
    } catch {
      setState("error");
    }
  };

  return (
    <details
      className={styles.sources}
      onToggle={(event) => {
        if (event.currentTarget.open && state === "idle") void loadSources();
      }}
    >
      <summary>
        <span>View {sourceCount} underlying {sourceCount === 1 ? "source" : "sources"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      {state === "loading" && <p role="status">Loading sources…</p>}
      {state === "error" && <p role="status">Source details are temporarily unavailable.</p>}
      {state === "loaded" && (
        <>
          <ol>
            {sources.map((source, index) => {
              const presentation = sourcePresentation(source);
              const label = presentation.title || presentation.publisher || "Source " + (index + 1);
              const detail = [
                presentation.platform && displayPlatform(presentation.platform),
                presentation.publisher,
                presentation.publishedAt && displayRelativeDate(presentation.publishedAt, now)
              ]
                .filter((part): part is string => Boolean(part))
                .join(" · ");
              return (
                <li key={presentation.id ?? label + ":" + index}>
                  {presentation.url ? (
                    <a href={presentation.url} target="_blank" rel="noreferrer">
                      <span>{label}</span>
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  ) : <span>{label}</span>}
                  {detail && <small>{detail}</small>}
                </li>
              );
            })}
          </ol>
          {truncated && <p className={styles.sourceFootnote}>Showing the first {DASHBOARD_SOURCE_DETAIL_LIMIT} of {sourceCount} sources.</p>}
        </>
      )}
    </details>
  );
}

function safeStories(snapshot: DashboardPublicFeedSnapshot | null | undefined): DashboardStoryCard[] {
  return snapshot && Array.isArray(snapshot.stories) ? snapshot.stories : [];
}

function hasPublishedStories(snapshot: DashboardPublicFeedSnapshot | null | undefined): snapshot is DashboardPublicFeedSnapshot {
  return safeStories(snapshot).length > 0;
}

function needsSnapshotRecovery(snapshot: DashboardPublicFeedSnapshot | null | undefined): boolean {
  if (!hasPublishedStories(snapshot)) return true;
  return snapshotAvailability((snapshot as DashboardSnapshotExtras).status) === "unavailable";
}

/**
 * The server store is deliberately server-only, so recovery validates the
 * compact public contract locally before it replaces the SSR snapshot. This
 * mirrors the public feed structural and freshness invariants instead of
 * trusting an arbitrary nonempty JSON response.
 */
function isCurrentPublishedFeedSnapshot(value: unknown): value is DashboardPublicFeedSnapshot {
  if (!isDashboardPublicFeedSnapshot(value)) return false;
  const snapshot = value as DashboardPublicFeedSnapshot;
  if (snapshot.status.partialPlatformFailures.includes("snapshot_unavailable")) {
    return false;
  }

  const now = Date.now();
  const generatedAt = new Date(snapshot.generatedAt).getTime();
  const windowEnd = new Date(snapshot.windowEnd).getTime();
  if (!Number.isFinite(now) || generatedAt !== windowEnd) return false;

  const age = now - windowEnd;
  return age >= -DASHBOARD_RECOVERY_MAX_FUTURE_SKEW_MS && age <= DASHBOARD_RECOVERY_MAX_AGE_MS;
}

function isDashboardPublicFeedSnapshot(value: unknown): value is DashboardPublicFeedSnapshot {
  if (!isRecord(value) || value.schemaVersion !== DASHBOARD_SCHEMA_VERSION) return false;
  if (!boundedString(value.sourceSnapshotFingerprint, 128)) return false;
  if (!validTimestamp(value.generatedAt) || !validTimestamp(value.updatedAt) || !validTimestamp(value.windowStart) || !validTimestamp(value.windowEnd)) {
    return false;
  }
  const windowStart = value.windowStart as string;
  const windowEnd = value.windowEnd as string;
  if (new Date(windowEnd).getTime() - new Date(windowStart).getTime() !== DASHBOARD_WINDOW_MS) return false;
  if (!isMaxLengthStringArray(value.todayInTech, 600)) return false;
  if (
    !Array.isArray(value.stories) ||
    value.stories.length === 0 ||
    value.stories.length > DASHBOARD_VIEWS.length * DASHBOARD_TOP_LIMIT ||
    !value.stories.every(isDashboardStoryCard)
  ) return false;
  if (
    !isRecord(value.availableFilters) ||
    !isAllowedStringArray(value.availableFilters.topics, DASHBOARD_TOPICS) ||
    !isAllowedStringArray(value.availableFilters.platforms, DASHBOARD_PLATFORMS)
  ) return false;
  if (!isRecord(value.status) || !isDashboardStatus(value.status)) return false;

  const stories = value.stories as DashboardStoryCard[];
  const status = value.status as DashboardPublicFeedSnapshot["status"];
  if (status.storyCount !== stories.length) return false;

  return DASHBOARD_VIEWS.every((view) => {
    const ranks = stories.flatMap((story) => story.viewRankings[view] ? [story.viewRankings[view]!.rank] : []);
    return status.viewStoryCounts[view] === ranks.length && new Set(ranks).size === ranks.length;
  });
}

function isDashboardStoryCard(value: unknown): value is DashboardStoryCard {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, "sources") ||
    Object.hasOwn(value, "summaryFingerprint") ||
    Object.hasOwn(value, "score") ||
    Object.hasOwn(value, "breakingScore") ||
    Object.hasOwn(value, "emergingScore")
  ) return false;

  return boundedString(value.id, 320) &&
    boundedString(value.stableKey, 320) &&
    positiveInteger(value.rank) &&
    boundedString(value.title, 240) &&
    boundedString(value.summary, 1_000) &&
    (value.universe === "returner" || value.universe === "industry") &&
    isBoundedStringArray(value.labels, 48, 120) &&
    isAllowedStringArray(value.topics, DASHBOARD_TOPICS) &&
    isAllowedStringArray(value.platforms, DASHBOARD_PLATFORMS) &&
    validTimestamp(value.publishedAt) &&
    validTimestamp(value.updatedAt) &&
    finiteScore(value.trendScore) &&
    isViewRankings(value.viewRankings) &&
    nonNegativeInteger(value.sourceCount) &&
    nonNegativeInteger(value.independentSourceCount) &&
    value.independentSourceCount <= value.sourceCount &&
    isMetrics(value.engagement) &&
    (value.thumbnailUrl === null || isHttpUrl(value.thumbnailUrl)) &&
    nullableBoundedString(value.thumbnailAlt, 240) &&
    (value.primarySource === null || isDashboardStoryPrimarySource(value.primarySource));
}

function isDashboardStoryPrimarySource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return boundedString(value.id, 320) &&
    isHttpUrl(value.url) &&
    nullableBoundedString(value.title, 500) &&
    nullableBoundedString(value.publisher, 300) &&
    typeof value.platform === "string" &&
    (DASHBOARD_PLATFORMS as readonly string[]).includes(value.platform) &&
    validTimestamp(value.publishedAt);
}

function isDashboardStatus(value: Record<string, unknown>): boolean {
  if (
    !nonNegativeInteger(value.candidateCount) ||
    !nonNegativeInteger(value.eligibleCandidateCount) ||
    !nonNegativeInteger(value.storyCount) ||
    !isViewStoryCounts(value.viewStoryCounts) ||
    !Array.isArray(value.partialPlatformFailures) ||
    !value.partialPlatformFailures.every((failure) => boundedString(failure, 160))
  ) return false;
  return true;
}

function isViewStoryCounts(value: unknown): boolean {
  return isRecord(value) && DASHBOARD_VIEWS.every((view) => nonNegativeInteger(value[view]));
}

function isViewRankings(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([view, ranking]) =>
    (DASHBOARD_VIEWS as readonly string[]).includes(view) &&
    isRecord(ranking) &&
    positiveInteger(ranking.rank) &&
    ranking.rank <= DASHBOARD_TOP_LIMIT &&
    (ranking.previousRank === null || (positiveInteger(ranking.previousRank) && ranking.previousRank <= DASHBOARD_TOP_LIMIT)) &&
    (ranking.rankDelta === null || Number.isInteger(ranking.rankDelta)) &&
    typeof ranking.trendStatus === "string" &&
    (DASHBOARD_TREND_STATUSES as readonly string[]).includes(ranking.trendStatus)
  );
}

function isMetrics(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((metric) =>
    metric === null || (typeof metric === "number" && Number.isFinite(metric) && metric >= 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function finiteScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function nullableBoundedString(value: unknown, maxLength: number): boolean {
  return value === null || boundedString(value, maxLength);
}

function isBoundedStringArray(value: unknown, maximumItems: number, maximumLength: number): boolean {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => boundedString(item, maximumLength));
}

function isMaxLengthStringArray(value: unknown, maximumLength: number): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= maximumLength);
}

function isAllowedStringArray(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.length <= allowed.length && value.every((item) =>
    typeof item === "string" && allowed.includes(item)
  );
}

function isHttpUrl(value: unknown): boolean {
  if (!boundedString(value, 2_000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function consolidatedStories(stories: readonly DashboardStoryCard[]): RankedDashboardStory[] {
  return stories
    .flatMap((story) => {
      const ranking = story.viewRankings.hottest;
      return ranking ? [{ story, ranking }] : [];
    })
    .sort((left, right) => left.ranking.rank - right.ranking.rank || left.story.id.localeCompare(right.story.id))
    .slice(0, DASHBOARD_TOP_LIMIT);
}

function sourcePresentation(source: unknown): {
  id: string | null;
  title: string | null;
  url: string | null;
  publisher: string | null;
  platform: string | null;
  publishedAt: string | null;
} {
  const record = source && typeof source === "object" ? source as Record<string, unknown> : {};
  return {
    id: stringValue(record.id),
    title: stringValue(record.title) ?? stringValue(record.name),
    url: validUrl(record.url) ?? validUrl(record.sourceUrl),
    publisher: stringValue(record.publisher) ?? stringValue(record.author) ?? stringValue(record.authorName),
    platform: stringValue(record.platform),
    publishedAt: validDateString(record.publishedAt) ?? validDateString(record.postedAt)
  };
}

function sourceDetailPayload(
  value: unknown,
  stableKey: string
): { sources: unknown[]; truncated: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.stableKey !== stableKey || !Array.isArray(record.sources) || record.sources.length > DASHBOARD_SOURCE_DETAIL_LIMIT) {
    return null;
  }
  if (typeof record.sourceCount !== "number" || !Number.isInteger(record.sourceCount) || record.sourceCount < record.sources.length) {
    return null;
  }
  if (typeof record.truncated !== "boolean") return null;
  return { sources: record.sources, truncated: record.truncated };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validDateString(value: unknown): string | null {
  const result = stringValue(value);
  return result && Number.isFinite(new Date(result).getTime()) ? result : null;
}

function validUrl(value: unknown): string | null {
  const result = stringValue(value);
  if (!result) return null;
  try {
    const url = new URL(result);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isKnownPlatform(platform: string): platform is Platform {
  return knownPlatforms.has(platform);
}

function displayPlatform(platform: string): string {
  if (platform === "web" || platform === "news") return "News";
  if (platform === "research") return "Research";
  if (platform === "hacker_news") return "Hacker News";
  if (platform === "product_hunt") return "Product Hunt";
  if (isKnownPlatform(platform)) return formatPlatform(platform);
  return displayFilterValue(platform);
}

function displayFilterValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayRelativeDate(value: string, now: number | null): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Date unavailable";
  if (now === null) {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }).format(new Date(timestamp));
  }
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }).format(new Date(timestamp));
}

function dashboardFreshness(
  snapshot: DashboardPublicFeedSnapshot | null | undefined,
  extras: DashboardSnapshotExtras | null | undefined,
  now: number | null
): { dateTime: string | null; label: string } {
  const generatedAt = validDateString(extras?.generatedAt);
  const availability = snapshotAvailability(extras?.status);

  if (!snapshot || !generatedAt || safeStories(snapshot).length === 0 || availability === "unavailable") {
    return {
      dateTime: null,
      label: availability === "stale" ? "Latest index is stale" : "Latest index unavailable"
    };
  }

  const age = now === null ? null : now - new Date(generatedAt).getTime();
  if (availability === "stale" || (age !== null && Number.isFinite(age) && age > DASHBOARD_CURRENT_MAX_AGE_MS)) {
    return {
      dateTime: generatedAt,
      label: now === null ? "Showing last published index" : "Showing last published index · " + freshnessLabel(generatedAt, now)
    };
  }

  return { dateTime: generatedAt, label: freshnessLabel(generatedAt, now) };
}

function snapshotAvailability(status: unknown): "stale" | "unavailable" | null {
  const record = status && typeof status === "object" ? status as Record<string, unknown> : null;
  const failures = stringValues(record?.partialPlatformFailures);
  if (failures.includes("snapshot_stale")) return "stale";
  if (failures.includes("snapshot_unavailable")) return "unavailable";
  return null;
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

function freshnessLabel(value: string, now: number | null): string {
  if (!value || now === null) return "Updated recently";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Updated recently";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return "Updated " + minutes + " min ago";
  const hours = Math.floor(minutes / 60);
  return "Updated " + hours + "h ago";
}

function compactEngagement(metrics: Record<string, number | null | undefined>): string | null {
  const candidates: Array<[string, string]> = [
    ["views", "views"],
    ["likes", "likes"],
    ["reactions", "reactions"],
    ["upvotes", "upvotes"],
    ["stars", "stars"]
  ];
  const metric = candidates.find(([key]) => finiteNumber(metrics[key]) !== null && finiteNumber(metrics[key])! > 0);
  if (!metric) return null;
  const value = finiteNumber(metrics[metric[0]])!;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value) + " " + metric[1];
}

function dashboardStatusMessage(status: unknown): string {
  const record = status && typeof status === "object" ? status as Record<string, unknown> : null;
  const failures = stringValues(record?.partialPlatformFailures);
  if (failures.length) return "The latest index is available with partial source coverage while a refresh recovers.";
  if (finiteNumber(record?.eligibleCandidateCount) === 0) return "No eligible stories were available in the latest rolling 24-hour window.";
  return "A precomputed 24-hour technology index will appear after the next successful refresh.";
}
