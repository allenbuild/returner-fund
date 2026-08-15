"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock3,
  ExternalLink,
  Minus,
  Sparkles
} from "lucide-react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { PlatformLogo, formatPlatform } from "@/components/PlatformLogo";
import {
  DASHBOARD_SOURCE_DETAIL_LIMIT,
  DASHBOARD_TOP_LIMIT,
  type DashboardPublicFeedSnapshot,
  type DashboardStoryCard,
  type DashboardView,
  type DashboardViewRanking
} from "@/lib/dashboard/contracts";
import { PLATFORM_VALUES, type Platform } from "@/lib/graph/types";
import { safeDashboardThumbnailUrl } from "@/lib/dashboard/thumbnail-policy";
import styles from "./TopStoriesDashboard.module.css";

type UniverseFilter = "everything" | "returner" | "industry";

type RankedDashboardStory = {
  story: DashboardStoryCard;
  ranking: DashboardViewRanking;
};

type DashboardSnapshotExtras = {
  overview?: unknown;
  todayInTech?: unknown;
  availableFilters?: Partial<Record<"topics" | "platforms", unknown>>;
  updatedAt?: string | null;
  generatedAt?: string | null;
  status?: unknown;
};

interface TopStoriesDashboardProps {
  snapshot: DashboardPublicFeedSnapshot | null | undefined;
}

const knownPlatforms = new Set<string>(PLATFORM_VALUES);

const viewOptions: Array<{ value: DashboardView; label: string; description: string }> = [
  { value: "hottest", label: "Hottest", description: "Best overall Trend Score" },
  { value: "breaking", label: "Breaking", description: "Strongest short-term velocity" },
  { value: "emerging", label: "Emerging", description: "Unusually fast relative acceleration" }
];

/**
 * Public, precomputed technology discovery feed. All filtering happens over
 * one immutable snapshot: it never fetches, enriches, or recalculates scores
 * in the browser.
 */
export function TopStoriesDashboard({ snapshot }: TopStoriesDashboardProps) {
  const [universe, setUniverse] = useState<UniverseFilter>("everything");
  const [topic, setTopic] = useState<string>("all");
  const [platform, setPlatform] = useState<string>("all");
  const [view, setView] = useState<DashboardView>("hottest");
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const refreshNow = () => setNow(Date.now());
    refreshNow();
    const interval = window.setInterval(refreshNow, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const stories = safeStories(snapshot);
  const snapshotExtras = snapshot as DashboardSnapshotExtras | null | undefined;
  const overview = stringValues(snapshotExtras?.todayInTech ?? snapshotExtras?.overview);
  const topics = filterValues(snapshotExtras?.availableFilters?.topics, stories, "topics");
  const platforms = filterValues(snapshotExtras?.availableFilters?.platforms, stories, "platforms");
  const freshness = dashboardFreshness(snapshot, snapshotExtras, now);

  const filteredStories = storiesForView(stories, view)
    .filter(({ story }) => {
      if (universe !== "everything" && story.universe !== universe) return false;
      if (topic !== "all" && !stringValues(story.topics).includes(topic)) return false;
      if (platform !== "all" && !stringValues(story.platforms).includes(platform)) return false;
      return true;
    });

  const topTen = filteredStories.filter(({ ranking }) => ranking.rank <= 10);
  const remainingStories = filteredStories.filter(({ ranking }) => ranking.rank > 10);
  const hasActiveFilters = universe !== "everything" || topic !== "all" || platform !== "all";

  return (
    <main className={styles.dashboard}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brandRow}>
            <a className={styles.brand} href="/dashboard" aria-label="Returner Dashboard">
              <span aria-hidden="true">R</span>
              Returner
            </a>
            <span className={styles.brandDivider} aria-hidden="true" />
            <span className={styles.sectionName}>Dashboard</span>
          </div>
          <div className={styles.headerCopy}>
            <div>
              <p className={styles.eyebrow}>Technology discovery</p>
              <h1>Top 100 Today</h1>
              <p>The 100 most important things happening in tech right now.</p>
            </div>
            <time className={styles.freshness} dateTime={freshness.dateTime ?? undefined} aria-live="polite">
              <Clock3 size={15} aria-hidden="true" />
              {freshness.label}
            </time>
          </div>
        </header>

        {overview.length > 0 && (
          <section className={styles.overview} aria-labelledby="today-in-tech">
            <div className={styles.overviewHeading}>
              <Sparkles size={16} aria-hidden="true" />
              <h2 id="today-in-tech">Today in Tech</h2>
            </div>
            <ul>
              {overview.slice(0, 10).map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        )}

        <section className={styles.controls} aria-label="Dashboard filters">
          <div className={styles.viewControls} role="group" aria-label="Trend view">
            {viewOptions.map((option) => (
              <button
                aria-pressed={view === option.value}
                className={view === option.value ? styles.activeView : undefined}
                key={option.value}
                onClick={() => setView(option.value)}
                title={option.description}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>

          <FilterGroup label="Universe">
            <FilterButton active={universe === "everything"} onClick={() => setUniverse("everything")}>Everything</FilterButton>
            <FilterButton active={universe === "returner"} onClick={() => setUniverse("returner")}>Returner</FilterButton>
            <FilterButton active={universe === "industry"} onClick={() => setUniverse("industry")}>Industry</FilterButton>
          </FilterGroup>

          {topics.length > 0 && (
            <FilterGroup label="Topic" scrollable>
              <FilterButton active={topic === "all"} onClick={() => setTopic("all")}>All</FilterButton>
              {topics.map((value) => (
                <FilterButton active={topic === value} key={value} onClick={() => setTopic(value)}>
                  {displayTopic(value)}
                </FilterButton>
              ))}
            </FilterGroup>
          )}

          {platforms.length > 0 && (
            <FilterGroup label="Platform" scrollable>
              <FilterButton active={platform === "all"} onClick={() => setPlatform("all")}>All</FilterButton>
              {platforms.map((value) => (
                <FilterButton active={platform === value} key={value} onClick={() => setPlatform(value)}>
                  {displayPlatform(value)}
                </FilterButton>
              ))}
            </FilterGroup>
          )}
        </section>

        <section className={styles.ranking} aria-label="Top technology stories">
          {topTen.length > 0 && (
            <StorySection
              heading="Top 10 Today"
              now={now}
              stories={topTen}
              topTen
            />
          )}

          {remainingStories.length > 0 && (
            <StorySection
              heading={topTen.length > 0 ? "Top 100 Today" : "Top stories today"}
              now={now}
              stories={remainingStories}
            />
          )}

          {!filteredStories.length && (
            <div className={styles.emptyState} role="status">
              <strong>{stories.length ? "No stories match these filters." : "The dashboard is being prepared."}</strong>
              <span>
                {stories.length
                  ? "Try broadening a filter to return to the unified ranking."
                  : dashboardStatusMessage(snapshotExtras?.status)}
              </span>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setUniverse("everything");
                    setTopic("all");
                    setPlatform("all");
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function FilterGroup({
  children,
  label,
  scrollable = false
}: {
  children: React.ReactNode;
  label: string;
  scrollable?: boolean;
}) {
  return (
    <div className={`${styles.filterGroup}${scrollable ? ` ${styles.scrollableFilterGroup}` : ""}`}>
      <span>{label}</span>
      <div role="group" aria-label={`${label} filter`}>
        {children}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={active ? styles.activeFilter : undefined}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function StorySection({
  heading,
  now,
  stories,
  topTen = false
}: {
  heading: string;
  now: number | null;
  stories: RankedDashboardStory[];
  topTen?: boolean;
}) {
  return (
    <section className={topTen ? styles.topTenSection : styles.storySection} aria-labelledby={sectionId(heading)}>
      <header>
        <h2 id={sectionId(heading)}>{heading}</h2>
        <span>{stories.length} {stories.length === 1 ? "story" : "stories"}</span>
      </header>
      <ol className={styles.storyList} start={stories[0]?.ranking.rank}>
        {stories.map(({ story, ranking }) => (
          <StoryRow key={story.id} story={story} ranking={ranking} emphasized={topTen} now={now} />
        ))}
      </ol>
    </section>
  );
}

function StoryRow({
  story,
  ranking,
  emphasized,
  now
}: {
  story: DashboardStoryCard;
  ranking: DashboardViewRanking;
  emphasized: boolean;
  now: number | null;
}) {
  const primarySource = sourcePresentation(story.primarySource);
  const status = ranking.trendStatus;
  const rankDelta = ranking.rankDelta;
  const engagementSummary = compactEngagement(story.engagement);

  return (
    <li value={ranking.rank}>
      <article className={`${styles.story}${emphasized ? ` ${styles.emphasizedStory}` : ""}`}>
        <div className={styles.rank} aria-label={`Rank ${ranking.rank}`}>#{ranking.rank}</div>
        <StoryThumbnail key={`${story.id}:${story.thumbnailUrl ?? ""}`} story={story} />
        <div className={styles.storyBody}>
          <div className={styles.storyTitleRow}>
            <h3>
              {primarySource.url ? (
                <a href={primarySource.url} target="_blank" rel="noreferrer">
                  {story.title}
                  <ExternalLink size={14} aria-label="Open primary source" />
                </a>
              ) : story.title}
            </h3>
            {status && <span className={`${styles.status} ${statusClass(status)}`}>{displayStatus(status)}</span>}
          </div>
          <p className={styles.summary}>{story.summary}</p>
          <div className={styles.metadata}>
            {story.platforms.length > 0 && <PlatformList platforms={story.platforms} />}
            {primarySource.publisher && <span>{primarySource.publisher}</span>}
            {story.universe === "returner" && story.labels.slice(0, 2).map((label) => <span className={styles.returnerLabel} key={label}>{label}</span>)}
            {story.publishedAt && <time dateTime={story.publishedAt}>{displayRelativeDate(story.publishedAt, now)}</time>}
            {engagementSummary && <span>{engagementSummary}</span>}
            <span>{story.sourceCount} {story.sourceCount === 1 ? "source" : "sources"}</span>
            <strong>Trend {displayTrendScore(story.trendScore)}</strong>
            <RankMovement delta={rankDelta} />
          </div>
          {story.sourceCount > 0 && <StorySources now={now} stableKey={story.stableKey} sourceCount={story.sourceCount} />}
        </div>
      </article>
    </li>
  );
}

function StoryThumbnail({ story }: { story: DashboardStoryCard }) {
  const thumbnailUrl = safeDashboardThumbnailUrl(story.thumbnailUrl);
  const thumbnailAlt = stringValue(story.thumbnailAlt) ?? `${story.title} thumbnail`;
  const [imageFailed, setImageFailed] = useState(false);

  const fallbackPlatform = story.platforms.find(isKnownPlatform);
  return (
    <div className={styles.thumbnail}>
      {thumbnailUrl && !imageFailed ? (
        <Image
          alt={thumbnailAlt}
          className={styles.thumbnailImage}
          fill
          loading="lazy"
          onError={() => setImageFailed(true)}
          quality={75}
          sizes="(max-width: 760px) 112px, 178px"
          src={thumbnailUrl}
        />
      ) : (
        <span className={styles.thumbnailFallback} aria-label={thumbnailAlt}>
          {fallbackPlatform ? <PlatformLogo platform={fallbackPlatform} decorative /> : <Sparkles size={25} aria-hidden="true" />}
          <span>{fallbackPlatform ? displayPlatform(fallbackPlatform) : "Technology"}</span>
        </span>
      )}
    </div>
  );
}

function PlatformList({ platforms }: { platforms: readonly string[] }) {
  const visiblePlatforms = platforms.slice(0, 3);
  return (
    <span className={styles.platforms} aria-label={`Sources: ${platforms.map(displayPlatform).join(", ")}`}>
      {visiblePlatforms.map((platform) => (
        isKnownPlatform(platform)
          ? <PlatformLogo key={platform} platform={platform} />
          : <span className={styles.platformText} key={platform}>{displayPlatform(platform)}</span>
      ))}
      {platforms.length > visiblePlatforms.length && <span>+{platforms.length - visiblePlatforms.length}</span>}
    </span>
  );
}

function RankMovement({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  if (delta > 0) {
    return <span className={styles.rising} aria-label={`Up ${delta} ranks`}><ArrowUp size={13} aria-hidden="true" />{delta}</span>;
  }
  if (delta < 0) {
    return <span className={styles.falling} aria-label={`Down ${Math.abs(delta)} ranks`}><ArrowDown size={13} aria-hidden="true" />{Math.abs(delta)}</span>;
  }
  return <span className={styles.stable} aria-label="Rank unchanged"><Minus size={13} aria-hidden="true" />Stable</span>;
}

function StorySources({
  now,
  stableKey,
  sourceCount
}: {
  now: number | null;
  stableKey: string;
  sourceCount: number;
}) {
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [sources, setSources] = useState<unknown[]>([]);
  const [truncated, setTruncated] = useState(false);

  const loadSources = async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/dashboard/stories/${encodeURIComponent(stableKey)}/sources`, {
        headers: { Accept: "application/json" }
      });
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
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      {state === "loading" && <p role="status">Loading sources…</p>}
      {state === "error" && <p role="status">Source details are temporarily unavailable.</p>}
      {state === "loaded" && (
        <>
          <ol>
            {sources.map((source, index) => {
              const presentation = sourcePresentation(source);
              const label = presentation.title || presentation.publisher || `Source ${index + 1}`;
              const detail = [presentation.platform && displayPlatform(presentation.platform), presentation.publisher, presentation.publishedAt && displayRelativeDate(presentation.publishedAt, now)]
                .filter((part): part is string => Boolean(part))
                .join(" · ");
              return (
                <li key={presentation.id ?? `${label}:${index}`}>
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
          {truncated && <p>Showing the first {DASHBOARD_SOURCE_DETAIL_LIMIT} of {sourceCount} sources.</p>}
        </>
      )}
    </details>
  );
}

function safeStories(snapshot: DashboardPublicFeedSnapshot | null | undefined): DashboardStoryCard[] {
  return snapshot && Array.isArray(snapshot.stories) ? snapshot.stories : [];
}

function filterValues(
  configured: unknown,
  stories: readonly DashboardStoryCard[],
  field: "topics" | "platforms"
): string[] {
  const values = stringValues(configured);
  const fallback = stories.flatMap((story) => stringValues(story[field]));
  return [...new Set((values.length ? values : fallback).filter(Boolean))].sort((left, right) => displayFilterValue(left).localeCompare(displayFilterValue(right)));
}

function storiesForView(stories: readonly DashboardStoryCard[], view: DashboardView): RankedDashboardStory[] {
  return stories
    .flatMap((story) => {
      const ranking = story.viewRankings[view];
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

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
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
  if (platform === "web") return "News";
  if (platform === "hacker_news") return "Hacker News";
  if (platform === "product_hunt") return "Product Hunt";
  if (isKnownPlatform(platform)) return formatPlatform(platform);
  return displayFilterValue(platform);
}

function displayTopic(topic: string): string {
  const labels: Record<string, string> = {
    ai: "AI",
    open_source: "Open Source",
    "open-source": "Open Source",
    startups: "Startups",
    robotics: "Robotics",
    research: "Research",
    funding: "Funding",
    launches: "Launches",
    biotech: "Biotech"
  };
  return labels[topic] ?? displayFilterValue(topic);
}

function displayFilterValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayStatus(status: string): string {
  const labels: Record<string, string> = {
    new: "New",
    rising_fast: "Rising Fast",
    "rising-fast": "Rising Fast",
    rising: "Rising",
    stable: "Stable",
    cooling: "Cooling"
  };
  return labels[status] ?? displayFilterValue(status);
}

function statusClass(status: string): string {
  const normalized = status.replace(/_/g, "-").toLowerCase();
  if (normalized === "rising-fast" || normalized === "rising") return styles.risingStatus;
  if (normalized === "cooling") return styles.coolingStatus;
  if (normalized === "new") return styles.newStatus;
  return styles.stableStatus;
}

function displayTrendScore(value: number): string {
  return Number.isFinite(value) ? String(Math.max(0, Math.min(100, Math.round(value)))) : "—";
}

function displayRelativeDate(value: string, now: number | null): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Date unavailable";
  if (now === null) {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }).format(new Date(timestamp));
  }
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }).format(new Date(timestamp));
}

function dashboardFreshness(
  snapshot: DashboardPublicFeedSnapshot | null | undefined,
  extras: DashboardSnapshotExtras | null | undefined,
  now: number | null
): { dateTime: string | null; label: string } {
  const generatedAt = validDateString(extras?.generatedAt);
  const availability = snapshotAvailability(extras?.status);

  // `updatedAt` belongs to the most recently changed source, whereas this
  // label describes the published ranking. A request-time safe empty state
  // has a fresh synthetic timestamp, so it must never appear as a fresh run.
  if (!snapshot || !generatedAt || safeStories(snapshot).length === 0 || availability) {
    return {
      dateTime: null,
      label: availability === "stale" ? "Latest ranking is stale" : "Latest ranking unavailable"
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

function freshnessLabel(value: string, now: number | null): string {
  if (!value || now === null) return "Updated recently";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Updated recently";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
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
  return `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)} ${metric[1]}`;
}

function dashboardStatusMessage(status: unknown): string {
  const record = status && typeof status === "object" ? status as Record<string, unknown> : null;
  const failures = stringValues(record?.partialPlatformFailures);
  if (failures.length) return "The latest ranking is available with partial source coverage while a platform refresh recovers.";
  if (finiteNumber(record?.eligibleCandidateCount) === 0) return "No eligible stories were available in the latest rolling 24-hour window.";
  return "A precomputed rolling 24-hour ranking will appear after the next successful refresh.";
}

function sectionId(heading: string): string {
  return `dashboard-${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
