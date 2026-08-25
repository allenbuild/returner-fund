"use client";

import {
  ChevronDown,
  Clock3,
  Eye,
  ExternalLink,
  Sparkles
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { PlatformLogo, formatPlatform } from "@/components/PlatformLogo";
import {
  DASHBOARD_PLATFORMS,
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_MIN_SOCIAL_VIEWS,
  DASHBOARD_SOURCE_KINDS,
  DASHBOARD_SOURCE_DETAIL_LIMIT,
  DASHBOARD_TOP_LIMIT,
  DASHBOARD_TOPICS,
  DASHBOARD_TREND_STATUSES,
  DASHBOARD_VIEWS,
  DASHBOARD_WINDOW_MS,
  dashboardTop100ContentKind,
  type DashboardMetrics,
  type DashboardPublicFeedSnapshot,
  type DashboardStoryCard,
  type DashboardTop100ContentKind,
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
  status?: unknown;
};

interface TopStoriesDashboardProps {
  snapshot: DashboardPublicFeedSnapshot | null | undefined;
  /** Renders inside the existing YC Network Map canvas and detail-panel shell. */
  variant?: "standalone" | "network-map";
}

const knownPlatforms = new Set<string>(PLATFORM_VALUES);
const DASHBOARD_RECOVERY_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
const DASHBOARD_RECOVERY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

/**
 * A deliberately single-purpose public index. The worker owns discovery and
 * scoring; this client only lays out the published Top 100 snapshot and never
 * implies audience metrics when a publisher has not supplied them.
 */
export function TopStoriesDashboard({ snapshot, variant = "standalone" }: TopStoriesDashboardProps) {
  const [now, setNow] = useState<number | null>(null);
  const [recoveredSnapshot, setRecoveredSnapshot] = useState<DashboardPublicFeedSnapshot | null>(null);
  const [selectedStableKey, setSelectedStableKey] = useState<string | null>(null);
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
  const selectedStory = stories.find(({ story }) => story.stableKey === selectedStableKey) ?? stories[0] ?? null;

  if (variant === "network-map") {
    return (
      <NetworkMapTopStories
        now={now}
        selectedStory={selectedStory}
        setSelectedStableKey={setSelectedStableKey}
        snapshotExtras={snapshotExtras}
        stories={stories}
      />
    );
  }

  return (
    <section className={styles.dashboard}>
      <div className={styles.shell}>
        <section className={styles.ranking} aria-label="Top 100 technology stories">
          <Top100Brief storyCount={stories.length} />
          {stories.length > 0 ? (
            <ol className={styles.storyGrid} aria-label="Top 100 technology stories">
              {stories.map(({ story, ranking }) => (
                <StoryCard key={story.id} now={now} ranking={ranking} story={story} />
              ))}
            </ol>
          ) : (
            <TopStoriesEmptyState status={snapshotExtras?.status} />
          )}
        </section>
      </div>
    </section>
  );
}

function NetworkMapTopStories({
  now,
  selectedStory,
  setSelectedStableKey,
  snapshotExtras,
  stories
}: {
  now: number | null;
  selectedStory: RankedDashboardStory | null;
  setSelectedStableKey: (stableKey: string) => void;
  snapshotExtras: DashboardSnapshotExtras | null | undefined;
  stories: RankedDashboardStory[];
}) {
  return (
    <>
      <div className="graph-column">
        <section className={styles.mapCanvas} aria-label="Top 100 technology stories">
          <Top100Brief compact storyCount={stories.length} />
          {stories.length > 0 ? (
            <ol className={styles.mapStoryGrid} aria-label="Top 100 technology stories">
              {stories.map(({ story, ranking }) => (
                <StoryCard
                  key={story.id}
                  now={now}
                  onSelect={() => setSelectedStableKey(story.stableKey)}
                  ranking={ranking}
                  selected={selectedStory?.story.stableKey === story.stableKey}
                  story={story}
                />
              ))}
            </ol>
          ) : (
            <TopStoriesEmptyState status={snapshotExtras?.status} />
          )}
        </section>
      </div>
      <TopStoryDetailPanel now={now} selectedStory={selectedStory} />
    </>
  );
}

function Top100Brief({ compact = false, storyCount }: { compact?: boolean; storyCount: number }) {
  return (
    <div className={`${styles.brief}${compact ? ` ${styles.briefCompact}` : ""}`}>
      <header className={styles.briefHeader}>
        <div>
          <span className={styles.briefKicker}>Live internet brief</span>
          <h1>Top 100 from the last 72 hours</h1>
          <p>
            Only verified, precisely dated social posts and videos with at least one million native views qualify.
            News and research use a separate coverage score because publisher views are rarely public.
          </p>
        </div>
        <div className={styles.briefResultCount} aria-label={`${storyCount} qualifying results`}>
          <strong>{storyCount}</strong>
          <span>qualified</span>
        </div>
      </header>
      <div className={styles.briefBadges} aria-label="Top 100 eligibility">
        <span><Clock3 size={14} aria-hidden="true" /> Rolling 72 hours</span>
        <span><Eye size={14} aria-hidden="true" /> {formatMetric(DASHBOARD_MIN_SOCIAL_VIEWS)}+ views</span>
      </div>
      <details className={styles.methodology}>
        <summary>Exactly how stories are surfaced</summary>
        <div className={styles.methodologyGrid}>
          <section>
            <strong>1. Hard gates</strong>
            <p>Published in the rolling 72-hour window, verified attribution, a valid public source, and a deduplicated physical item. Social and video also require 1,000,000+ native views.</p>
          </section>
          <section>
            <strong>2. Viral score · 100 points</strong>
            <p>Reach: 25 points at 1M views, log-scaled to 50 at 100M+. Velocity: 0 at 1K views/hour or less, log-scaled to 25 at 1M/hour. Engagement: linear to 15 at 10%+. Freshness: linear from 10 to 0 over 72 hours.</p>
          </section>
          <section>
            <strong>3. News score · 100 points</strong>
            <p>Visible discussion: log-scaled from 0 to 45 at 100K actions. Distinct-source coverage: 0 with one source, linear to 25 at five+. Freshness: 20 to 0 over 72 hours. Completeness: 2.5 each for title, byline, image, and direct URL. Publisher traffic is never invented.</p>
          </section>
          <section>
            <strong>4. Breadth rules</strong>
            <p>The first pass reserves 30 news slots and 70 viral slots, capped at three per news publisher and 30 social posts per platform. Unused capacity backfills with the next highest qualified item.</p>
          </section>
        </div>
        <p className={styles.coverageNote}>Coverage spans collected public social, video, RSS, research, and open-web sources. Private, paywalled, login-only, blocked, or unindexed pages are not claimed as covered.</p>
      </details>
    </div>
  );
}

function TopStoriesEmptyState({ status }: { status: unknown }) {
  const unavailable = snapshotAvailability(status) !== null;
  return (
    <div className={styles.emptyState} role="status">
      <Sparkles size={24} aria-hidden="true" />
      <strong>{unavailable ? "Loading articles…" : "No items clear the strict 72-hour surfacing gates yet."}</strong>
      <span>{dashboardStatusMessage(status)}</span>
    </div>
  );
}

function StoryCard({
  now,
  onSelect,
  ranking,
  selected = false,
  story
}: {
  now: number | null;
  onSelect?: () => void;
  ranking: DashboardViewRanking;
  selected?: boolean;
  story: DashboardStoryCard;
}) {
  const primarySource = sourcePresentation(story.primarySource);
  const primaryPlatform = primarySource.platform ?? story.platforms.find(Boolean) ?? null;
  const sourceLabel = primarySource.publisher ?? (primaryPlatform ? displayPlatform(primaryPlatform) : "Technology");
  const metrics = visibleEngagementMetrics(primarySource.metrics, 3);
  const contentKind = story.primarySource ? dashboardTop100ContentKind(story.primarySource) : null;
  const selectable = Boolean(onSelect);

  return (
    <li>
      <article className={styles.storyCard}>
        {selectable ? (
          <button
            aria-label={`Show ${story.title}`}
            aria-pressed={selected}
            className={styles.storyCardButton}
            onClick={onSelect}
            type="button"
          >
            <StoryCardContent
              contentKind={contentKind}
              metrics={metrics}
              now={now}
              primaryPlatform={primaryPlatform}
              ranking={ranking}
              sourceLabel={sourceLabel}
              story={story}
            />
          </button>
        ) : (
          <StoryCardContent
            contentKind={contentKind}
            metrics={metrics}
            now={now}
            primaryPlatform={primaryPlatform}
            primarySourceUrl={primarySource.url}
            ranking={ranking}
            sourceLabel={sourceLabel}
            story={story}
          />
        )}
      </article>
    </li>
  );
}

function StoryCardContent({
  contentKind,
  metrics,
  now,
  primaryPlatform,
  primarySourceUrl,
  ranking,
  sourceLabel,
  story
}: {
  contentKind: DashboardTop100ContentKind | null;
  metrics: VisibleEngagementMetric[];
  now: number | null;
  primaryPlatform: string | null;
  primarySourceUrl?: string | null;
  ranking: DashboardViewRanking;
  sourceLabel: string;
  story: DashboardStoryCard;
}) {
  return (
    <>
      <div className={styles.media}>
        <span className={styles.rank} aria-label={`Item ${ranking.rank}`}>#{ranking.rank}</span>
        <span className={styles.score} aria-label={`Surfacing score ${story.trendScore} out of 100`}>{story.trendScore}<small>/100</small></span>
        <StoryThumbnail linkToSource={Boolean(primarySourceUrl)} sourceUrl={primarySourceUrl ?? null} story={story} />
      </div>
      <div className={styles.storyBody}>
        <div className={styles.sourceLine}>
          {primaryPlatform && isKnownPlatform(primaryPlatform) && (
            <PlatformLogo decorative platform={primaryPlatform as Platform} />
          )}
          <span>{sourceLabel}</span>
          {contentKind && (
            <span className={`${styles.contentBadge} ${contentKind === "news_article" ? styles.contentNews : styles.contentViral}`}>
              {contentKind === "news_article" ? "News" : "1M+ viral"}
            </span>
          )}
          {story.universe === "returner" && story.labels.slice(0, 1).map((label) => (
            <span className={styles.returnerLabel} key={label}>{label}</span>
          ))}
        </div>

        <h3 className={styles.storyTitle}>
          {primarySourceUrl ? (
            <a href={primarySourceUrl} target="_blank" rel="noreferrer">
              {story.title}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          ) : story.title}
        </h3>

        <div className={styles.metadata}>
          {story.publishedAt && <time dateTime={story.publishedAt}>{displayRelativeDate(story.publishedAt, now)}</time>}
          <EngagementMetrics metrics={metrics} />
        </div>
      </div>
    </>
  );
}

function TopStoryDetailPanel({
  now,
  selectedStory
}: {
  now: number | null;
  selectedStory: RankedDashboardStory | null;
}) {
  if (!selectedStory) {
    return (
      <aside aria-label="Article details" className={`node-panel ${styles.storyDetailPanel}`}>
        <TopStoriesEmptyState status={null} />
      </aside>
    );
  }

  const { ranking, story } = selectedStory;
  const primarySource = sourcePresentation(story.primarySource);
  const primaryPlatform = primarySource.platform ?? story.platforms.find(Boolean) ?? null;
  const sourceLabel = primarySource.publisher ?? (primaryPlatform ? displayPlatform(primaryPlatform) : "Technology");
  const metrics = visibleEngagementMetrics(primarySource.metrics);

  return (
    <aside aria-label="Article details" className={`node-panel ${styles.storyDetailPanel}`}>
      <header className={styles.detailHeader}>
        <div className={styles.sourceLine}>
          {primaryPlatform && isKnownPlatform(primaryPlatform) && (
            <PlatformLogo decorative platform={primaryPlatform as Platform} />
          )}
          <span>{sourceLabel}</span>
        </div>
        <span className={styles.detailRank} aria-label={`Item ${ranking.rank}`}>#{ranking.rank}</span>
      </header>
      <h2>{story.title}</h2>
      <StoryThumbnail linkToSource sourceUrl={primarySource.url} story={story} />
      <p className={styles.detailSummary}>{story.summary}</p>
      <div className={styles.detailMetadata}>
        {story.publishedAt && <time dateTime={story.publishedAt}>{displayRelativeDate(story.publishedAt, now)}</time>}
        <span>{story.sourceCount} {story.sourceCount === 1 ? "source" : "sources"}</span>
      </div>
      <EngagementMetrics detail metrics={metrics} />
      {primarySource.url && (
        <a className={styles.articleLink} href={primarySource.url} rel="noreferrer" target="_blank">
          Open article <ExternalLink size={14} aria-hidden="true" />
        </a>
      )}
      {story.sourceCount > 0 && (
        <StorySources now={now} sourceCount={story.sourceCount} stableKey={story.stableKey} />
      )}
    </aside>
  );
}

function StoryThumbnail({
  linkToSource = true,
  sourceUrl,
  story
}: {
  linkToSource?: boolean;
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

  return sourceUrl && linkToSource ? (
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
    value.primarySource !== null &&
    isDashboardStoryPrimarySource(value.primarySource) &&
    isQualifiedTop100PrimarySource(value.primarySource);
}

function isDashboardStoryPrimarySource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return boundedString(value.id, 320) &&
    isHttpUrl(value.url) &&
    nullableBoundedString(value.title, 500) &&
    nullableBoundedString(value.publisher, 300) &&
    typeof value.platform === "string" &&
    (DASHBOARD_PLATFORMS as readonly string[]).includes(value.platform) &&
    typeof value.sourceKind === "string" &&
    (DASHBOARD_SOURCE_KINDS as readonly string[]).includes(value.sourceKind) &&
    validTimestamp(value.publishedAt) &&
    isMetrics(value.metrics);
}

function isQualifiedTop100PrimarySource(value: unknown): boolean {
  if (!isRecord(value) || typeof value.platform !== "string" || typeof value.sourceKind !== "string") return false;
  const contentKind = dashboardTop100ContentKind({
    platform: value.platform as (typeof DASHBOARD_PLATFORMS)[number],
    sourceKind: value.sourceKind as (typeof DASHBOARD_SOURCE_KINDS)[number]
  });
  if (contentKind === "news_article") return true;
  if (contentKind !== "viral_post" || !isRecord(value.metrics)) return false;
  const views = value.metrics.views;
  return typeof views === "number" && Number.isFinite(views) && views >= DASHBOARD_MIN_SOCIAL_VIEWS;
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
  metrics: DashboardMetrics;
} {
  const record = source && typeof source === "object" ? source as Record<string, unknown> : {};
  return {
    id: stringValue(record.id),
    title: stringValue(record.title) ?? stringValue(record.name),
    url: validUrl(record.url) ?? validUrl(record.sourceUrl),
    publisher: stringValue(record.publisher) ?? stringValue(record.author) ?? stringValue(record.authorName),
    platform: stringValue(record.platform),
    publishedAt: validDateString(record.publishedAt) ?? validDateString(record.postedAt),
    metrics: safeMetrics(record.metrics)
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

function safeMetrics(value: unknown): DashboardMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, metric]) =>
    typeof metric === "number" && Number.isFinite(metric) && metric > 0 ? [[key, metric]] : []
  ));
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

type VisibleEngagementMetric = {
  key: string;
  label: string;
  value: number;
};

function visibleEngagementMetrics(metrics: DashboardMetrics, limit?: number): VisibleEngagementMetric[] {
  const groups: Array<Array<{ key: string; label: string }>> = [
    [{ key: "views", label: "views" }],
    [{ key: "likes", label: "likes" }],
    [{ key: "reactions", label: "reactions" }],
    [{ key: "reposts", label: "reposts" }, { key: "shares", label: "shares" }],
    [{ key: "comments", label: "comments" }, { key: "replies", label: "replies" }],
    [{ key: "quotes", label: "quotes" }],
    [{ key: "saves", label: "saves" }, { key: "bookmarks", label: "bookmarks" }],
    [{ key: "upvotes", label: "upvotes" }],
    [{ key: "stars", label: "stars" }],
    [{ key: "forks", label: "forks" }],
    [{ key: "downloads", label: "downloads" }]
  ];
  const visible = groups.flatMap((group) => {
    const metric = group.find(({ key }) => finiteNumber(metrics[key]) !== null && finiteNumber(metrics[key])! > 0);
    if (!metric) return [];
    const value = finiteNumber(metrics[metric.key]);
    return value === null ? [] : [{ ...metric, value }];
  });
  return typeof limit === "number" ? visible.slice(0, limit) : visible;
}

function EngagementMetrics({ detail = false, metrics }: { detail?: boolean; metrics: VisibleEngagementMetric[] }) {
  if (!metrics.length) return null;
  return (
    <span className={detail ? styles.detailMetrics : styles.metricRail} aria-label="Observed source engagement">
      {metrics.map((metric) => (
        <span className={styles.metricChip} key={metric.key}>
          {formatMetric(metric.value)} {metric.label}
        </span>
      ))}
    </span>
  );
}

function formatMetric(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function dashboardStatusMessage(status: unknown): string {
  const record = status && typeof status === "object" ? status as Record<string, unknown> : null;
  const failures = stringValues(record?.partialPlatformFailures);
  if (failures.length) return "Waiting for the next published update.";
  if (finiteNumber(record?.eligibleCandidateCount) === 0) {
    return "Older or lower-reach items are deliberately not used as filler. The next collection pass will add newly qualified social posts, videos, and articles.";
  }
  return "No qualified stories are available yet.";
}
