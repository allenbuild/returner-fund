import {
  DASHBOARD_MAX_NEWS_PER_PUBLISHER,
  DASHBOARD_MAX_SOCIAL_PER_PLATFORM,
  DASHBOARD_MIN_SOCIAL_VIEWS,
  DASHBOARD_NEWS_TARGET_SHARE,
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_TOP_LIMIT,
  DASHBOARD_VIEWS,
  DASHBOARD_WINDOW_MS,
  dashboardTop100ContentKind,
  type DashboardCandidate,
  type DashboardPipelineOptions,
  type DashboardPipelineResult,
  type DashboardRankSnapshot,
  type DashboardScoreBreakdown,
  type DashboardStory,
  type DashboardStorySource,
  type DashboardTop100ContentKind,
  type DashboardTopic,
  type DashboardTrendStatus,
  type DashboardView,
  type DashboardViewRanking
} from "./contracts";
import { clusterDashboardCandidates, dedupePhysicalSources, type DashboardStoryCluster } from "./clustering";
import {
  aggregateMetrics,
  canonicalDashboardUrl,
  compactSentence,
  compactWhitespace,
  dashboardPlatformForCandidate,
  engagementMass,
  normalizeTopicList,
  safeDate,
  stableHash
} from "./normalization";
import {
  isIndependentEditorialOrResearchSource,
  platformNormalizedSignificance,
  scoreDashboardStory
} from "./scoring";

type UnrankedDashboardStory = Omit<DashboardStory, "rank" | "previousRank" | "rankDelta" | "trendStatus" | "viewRankings">;

export interface DashboardTop100SurfacingScore {
  total: number;
  formula: "viral-reach-v1" | "news-coverage-v1";
  reach: number;
  velocity: number;
  engagement: number;
  freshness: number;
  newsAttention: number;
  sourceCoverage: number;
  completeness: number;
  reasons: string[];
}

/**
 * The only expensive dashboard work belongs in the hourly job. This pure
 * function has no fetches, database reads, embeddings, or LLM calls, so its
 * output can be persisted as one small public snapshot and reproduced in tests.
 */
export function buildDashboardSnapshot(
  candidates: readonly DashboardCandidate[],
  options: DashboardPipelineOptions = {}
): DashboardPipelineResult {
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - DASHBOARD_WINDOW_MS);
  const uniqueCandidates = dedupePhysicalSources(candidates);
  const windowCandidates = uniqueCandidates.filter((candidate) => isDashboardCandidateEligible(candidate, now));
  const eligibleCandidates = windowCandidates.filter((candidate) => dashboardTop100Eligibility(candidate, now).eligible);
  const platformSignificance = platformNormalizedSignificance(eligibleCandidates);
  const priorRanks = new Map((options.priorRankSnapshots ?? []).map((snapshot) => [rankSnapshotKey(snapshot.stableKey, snapshot.view), snapshot]));
  const priorStories = new Map((options.priorStories ?? []).map((story) => [story.stableKey, story]));
  const clusters = clusterDashboardCandidates(windowCandidates);
  const rankableClusters = clusters.flatMap((cluster): DashboardStoryCluster[] => {
    if (!isClusterRankable(cluster)) return [];
    const qualifiedCandidates = cluster.candidates.filter((candidate) =>
      dashboardTop100Eligibility(candidate, now).eligible
    );
    // Broad in-window candidates may establish cluster identity/corroboration,
    // but no unqualified row is allowed into scoring or the published sources.
    return qualifiedCandidates.length ? [{ ...cluster, candidates: qualifiedCandidates }] : [];
  });
  const scored = rankableClusters.map((cluster) => buildStory(cluster, now, platformSignificance, priorStories.get(cluster.stableKey)));
  const limit = Math.max(0, Math.min(DASHBOARD_TOP_LIMIT, Math.trunc(options.limit ?? DASHBOARD_TOP_LIMIT)));
  const rankedStories = rankStoriesForViews(scored, limit, priorRanks);
  const hottestStories = rankedStories.filter((story) => Boolean(story.viewRankings.hottest));
  const rankSnapshots = rankedStories.flatMap((story): DashboardRankSnapshot[] =>
    DASHBOARD_VIEWS.flatMap((view) => {
      const ranking = story.viewRankings[view];
      return ranking ? [{
        stableKey: story.stableKey,
        view,
        rank: ranking.rank,
        trendScore: story.trendScore,
        capturedAt: now.toISOString()
      }] : [];
    })
  );
  const diagnostics = buildDiagnostics(candidates, uniqueCandidates, eligibleCandidates, clusters, rankedStories, priorRanks);
  const snapshot: DashboardPipelineResult["snapshot"] = {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    updatedAt: latestUpdatedAt(rankedStories) ?? now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    todayInTech: groundedTodayInTech(hottestStories),
    stories: rankedStories,
    availableFilters: {
      topics: uniqueSorted(rankedStories.flatMap((story) => story.topics)),
      platforms: uniqueSorted(rankedStories.flatMap((story) => story.platforms))
    },
    status: {
      candidateCount: candidates.length,
      eligibleCandidateCount: eligibleCandidates.length,
      storyCount: rankedStories.length,
      viewStoryCounts: Object.fromEntries(
        DASHBOARD_VIEWS.map((view) => [view, rankedStories.filter((story) => Boolean(story.viewRankings[view])).length])
      ) as Record<DashboardView, number>,
      partialPlatformFailures: [...new Set(options.platformFailures ?? [])].sort()
    }
  };

  return { snapshot, rankSnapshots, diagnostics };
}

/** Rolling-window eligibility deliberately does not use a calendar-day boundary. */
export function isDashboardCandidateEligible(candidate: Pick<DashboardCandidate, "publishedAt">, now = new Date()): boolean {
  const publishedAt = safeDate(candidate.publishedAt);
  if (!publishedAt) return false;
  const timestamp = publishedAt.getTime();
  return timestamp >= now.getTime() - DASHBOARD_WINDOW_MS && timestamp <= now.getTime();
}

const TOP100_SOCIAL_PLATFORMS = new Set<DashboardCandidate["platform"]>([
  "x", "instagram", "linkedin", "youtube", "tiktok", "bluesky"
]);
const HIGH_CONFIDENCE_SOCIAL_TOPICS = new Set<DashboardTopic>([
  "launches", "research", "funding", "open_source", "ai", "robotics", "biotech"
]);
// This intentionally avoids lifestyle/general-business language. A verified
// company post still needs a concrete technology cue unless its normalized
// topic is already a high-confidence product, research, funding, or launch.
const TECHNOLOGY_SOCIAL_SIGNAL = /\b(?:ai|artificial intelligence|machine learning|llm|model|agent|software|api|database|developer|code|coding|open[ -]?source|cloud|computer|robot(?:ics)?|automation|compute|inference|gpu|chip|hardware|voice|speech|screen|browser|security|biotech|healthtech|medical|healthcare|infrastructure|infra|saas|fintech|payments?|operating system|engineering|terminal|vision|simulat(?:ion|e)|autonom(?:ous|y)|drone|energy|nuclear|manufactur(?:ing)?|scientific|research|benchmark|dictation|language model|machine vision|digital twin|mri)\b/i;
const NON_TECH_SOCIAL_SIGNAL = /\b(?:novelas?|telenovelas?|romance|amor|mafia|futbol(?:ista)?|football|super bowl|nfl|nba|mlb|nhl|soccer|golf|pickleball|world cup|sports?(?: betting)?|fantasy(?: football)?|episode|episodio|trailer|celebrity|gossip|fashion|outfit|birthday|wedding|altar|plants?|dogs?|pets?)\b/i;

export type DashboardTop100EligibilityReason =
  | "eligible"
  | "outside_72_hour_window"
  | "missing_precise_publication_date"
  | "unverified_source"
  | "invalid_link"
  | "missing_article_content"
  | "below_one_million_views"
  | "unsupported_content";

export interface DashboardTop100Eligibility {
  eligible: boolean;
  reason: DashboardTop100EligibilityReason;
  contentKind: DashboardTop100ContentKind | null;
}

/** The hard-gate contract for the public Top 100, separate from Ranked Posts. */
export function dashboardTop100Eligibility(
  candidate: DashboardCandidate,
  now = new Date()
): DashboardTop100Eligibility {
  const contentKind = dashboardTop100ContentKind(candidate);
  const publishedAt = safeDate(candidate.publishedAt);
  if (!publishedAt || candidate.publicationPrecision !== "exact") {
    return { eligible: false, reason: "missing_precise_publication_date", contentKind };
  }
  if (!isDashboardCandidateEligible(candidate, now)) {
    return { eligible: false, reason: "outside_72_hour_window", contentKind };
  }
  if (candidate.sourceVerified !== true) {
    return { eligible: false, reason: "unverified_source", contentKind };
  }
  if (candidate.sourceLinkStatus !== "verified" || !canonicalDashboardUrl(candidate.url)) {
    return { eligible: false, reason: "invalid_link", contentKind };
  }

  if (contentKind === "news_article") {
    if (!compactWhitespace([candidate.title, candidate.summary, candidate.text].filter(Boolean).join(" "))) {
      return { eligible: false, reason: "missing_article_content", contentKind };
    }
    return { eligible: true, reason: "eligible", contentKind };
  }

  if (contentKind === "viral_post") {
    if (!isMeasuredVerifiedTechnologySocialCandidate(candidate)) {
      return { eligible: false, reason: "unverified_source", contentKind };
    }
    if (metricValue(candidate.metrics?.views) < DASHBOARD_MIN_SOCIAL_VIEWS) {
      return { eligible: false, reason: "below_one_million_views", contentKind };
    }
    return { eligible: true, reason: "eligible", contentKind };
  }

  return { eligible: false, reason: "unsupported_content", contentKind: null };
}

function isMeasuredVerifiedTechnologySocialCandidate(
  candidate: Pick<
    DashboardCandidate,
    "platform" | "metrics" | "topics" | "title" | "summary" | "text" | "socialBackfillEligible"
  >
): boolean {
  return Boolean(
    candidate.socialBackfillEligible &&
    TOP100_SOCIAL_PLATFORMS.has(candidate.platform) &&
    engagementMass(candidate.metrics) > 0 &&
    hasTechnologySocialContent(candidate, candidate.topics)
  );
}

function metricValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A stable content key lets a worker avoid regenerating summaries for unchanged stories. */
export function dashboardStoryInputFingerprint(candidates: readonly DashboardCandidate[]): string {
  const values = candidates
    .map((candidate) => [
      candidate.canonicalKey,
      candidate.contentFingerprint ?? "",
      compactWhitespace(candidate.title),
      compactWhitespace(candidate.summary),
      compactWhitespace(candidate.text).slice(0, 1_000),
      canonicalDashboardUrl(candidate.destinationUrl) ?? ""
    ].join("\u001f"))
    .sort();
  return `dsh-${stableHash(values.join("\u001e"))}`;
}

/**
 * Excludes publication clocks so the hourly worker does not create a commit
 * merely because the same ranked universe was recomputed. It includes source
 * metrics, order, summaries, and status failure labels, which are material to
 * visitors and cache invalidation.
 */
export function dashboardSnapshotMaterialDescriptor(snapshot: DashboardPipelineResult["snapshot"]): string {
  return JSON.stringify({
    todayInTech: snapshot.todayInTech,
    status: {
      candidateCount: snapshot.status.candidateCount,
      eligibleCandidateCount: snapshot.status.eligibleCandidateCount,
      storyCount: snapshot.status.storyCount,
      viewStoryCounts: snapshot.status.viewStoryCounts,
      partialPlatformFailures: [...snapshot.status.partialPlatformFailures].sort()
    },
    stories: snapshot.stories.map((story) => ({
      stableKey: story.stableKey,
      rank: story.rank,
      previousRank: story.previousRank,
      rankDelta: story.rankDelta,
      trendStatus: story.trendStatus,
      viewRankings: story.viewRankings,
      title: story.title,
      summary: story.summary,
      summaryFingerprint: story.summaryFingerprint,
      thumbnailUrl: story.thumbnailUrl,
      universe: story.universe,
      topics: story.topics,
      platforms: story.platforms,
      trendScore: story.trendScore,
      breakingScore: story.breakingScore,
      emergingScore: story.emergingScore,
      sources: story.sources.map((source) => ({
        canonicalKey: source.canonicalKey,
        metrics: source.metrics,
        publishedAt: source.publishedAt
      }))
    }))
  });
}

function buildStory(
  cluster: DashboardStoryCluster,
  now: Date,
  platformSignificance: ReadonlyMap<string, number>,
  priorStory: DashboardStory | undefined
): UnrankedDashboardStory {
  const candidates = [...cluster.candidates].sort((left, right) =>
    compareCandidatesForStory(left, right, platformSignificance, now)
  );
  const score = scoreDashboardStory(candidates, { now, absoluteSignificance: platformSignificance });
  const surfacingScore = dashboardTop100SurfacingScore(candidates, now);
  const primary = candidates[0];
  const summaryFingerprint = dashboardStoryInputFingerprint(candidates);
  const title = storyTitle(primary, candidates);
  const cachedSummary = priorStory?.summaryFingerprint === summaryFingerprint
    ? validDashboardSummary(priorStory.summary)
    : null;
  const summary = cachedSummary ?? groundedStorySummary(candidates, title);
  const sources = candidates.map((candidate) => toStorySource(candidate, score));
  const thumbnail = selectThumbnail(candidates);
  const topics = storyTopics(candidates);
  const tracked = candidates
    .map((candidate) => candidate.trackedEntity)
    .filter((value): value is NonNullable<DashboardCandidate["trackedEntity"]> => Boolean(value));
  const labels = uniqueSorted(tracked.map((entity) => entity.cohortLabel).filter(Boolean));
  const platforms = uniqueSorted(sources.map((source) => source.platform));
  const publishedAt = candidates
    .map((candidate) => safeDate(candidate.publishedAt))
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0]?.toISOString() ?? now.toISOString();
  const updatedAt = candidates
    .map((candidate) => safeDate(candidate.observedAt ?? candidate.publishedAt))
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0]?.toISOString() ?? publishedAt;
  const engagement = aggregateMetrics(candidates.map((candidate) => candidate.metrics ?? {}));
  const independentSourceCount = candidates.filter((candidate) => candidate.independentlyReported === true).length;

  return {
    id: cluster.stableKey,
    stableKey: cluster.stableKey,
    title,
    summary,
    summaryFingerprint,
    // The source corpus can contain local recovery assets and arbitrarily
    // long social captions. Keep only a valid remote image reference in this
    // snapshot; the compact public feed applies its stricter reviewed-host
    // policy and falls back to the platform treatment when needed.
    thumbnailUrl: canonicalDashboardUrl(thumbnail?.thumbnailUrl),
    thumbnailAlt: boundedDashboardText(thumbnail?.thumbnailAlt, 240) ?? title,
    universe: tracked.length ? "returner" : "industry",
    labels,
    topics,
    platforms,
    publishedAt,
    updatedAt,
    trendScore: surfacingScore.total,
    breakingScore: score.breakingScore,
    emergingScore: score.emergingScore,
    score: scoreBreakdown(score),
    sourceCount: sources.length,
    independentSourceCount,
    engagement,
    sources
  };
}

/** Auditable 100-point score used only by the strict Top 100 surface. */
export function dashboardTop100SurfacingScore(
  candidates: readonly DashboardCandidate[],
  now: Date
): DashboardTop100SurfacingScore {
  const viralAnchor = candidates.find((candidate) =>
    dashboardTop100Eligibility(candidate, now).eligible && dashboardTop100ContentKind(candidate) === "viral_post"
  );
  if (viralAnchor) {
    const publishedAt = safeDate(viralAnchor.publishedAt);
    const ageHours = publishedAt
      ? clampScore((now.getTime() - publishedAt.getTime()) / (60 * 60 * 1_000), 0, 72)
      : 72;
    const freshnessRatio = clampScore(1 - ageHours / 72, 0, 1);
    const views = metricValue(viralAnchor.metrics?.views);
    const interactions = visibleDiscussionActions(viralAnchor.metrics);
    const reach = roundTop100Score(25 + 25 * clampScore(
      Math.log10(Math.max(1, views / DASHBOARD_MIN_SOCIAL_VIEWS)) / 2,
      0,
      1
    ));
    const viewsPerHour = views / Math.max(1, ageHours);
    const velocity = roundTop100Score(25 * clampScore(
      Math.log10(Math.max(1, viewsPerHour / 1_000)) / 3,
      0,
      1
    ));
    const engagementRate = views > 0 ? interactions / views : 0;
    const engagement = roundTop100Score(15 * clampScore(engagementRate / 0.1, 0, 1));
    const freshness = roundTop100Score(10 * freshnessRatio);
    return {
      total: roundTop100Score(reach + velocity + engagement + freshness),
      formula: "viral-reach-v1",
      reach,
      velocity,
      engagement,
      freshness,
      newsAttention: 0,
      sourceCoverage: 0,
      completeness: 0,
      reasons: [
        `${formatTop100Integer(views)} verified native views`,
        `${formatTop100Integer(Math.round(viewsPerHour))} views/hour since publication`,
        `${(engagementRate * 100).toFixed(2)}% visible engagement rate`
      ]
    };
  }

  const news = candidates.filter((candidate) =>
    dashboardTop100Eligibility(candidate, now).eligible &&
    dashboardTop100ContentKind(candidate) === "news_article"
  );
  const anchor = news[0];
  const latestPublication = news
    .map((candidate) => safeDate(candidate.publishedAt))
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  const ageHours = latestPublication
    ? clampScore((now.getTime() - latestPublication.getTime()) / (60 * 60 * 1_000), 0, 72)
    : 72;
  const interactions = news.reduce((sum, candidate) => sum + visibleDiscussionActions(candidate.metrics), 0);
  const sourceCount = new Set(news.map(candidatePublisherDomain)).size;
  const newsAttention = roundTop100Score(45 * clampScore(Math.log10(interactions + 1) / 5, 0, 1));
  const sourceCoverage = roundTop100Score(25 * clampScore((sourceCount - 1) / 4, 0, 1));
  const freshness = roundTop100Score(20 * clampScore(1 - ageHours / 72, 0, 1));
  const completeness = roundTop100Score(10 * articleCompleteness(anchor));
  return {
    total: roundTop100Score(newsAttention + sourceCoverage + freshness + completeness),
    formula: "news-coverage-v1",
    reach: 0,
    velocity: 0,
    engagement: 0,
    freshness,
    newsAttention,
    sourceCoverage,
    completeness,
    reasons: [
      "Published within the rolling 72-hour window",
      `${sourceCount} distinct public source${sourceCount === 1 ? "" : "s"} cover this story`,
      interactions > 0
        ? `${formatTop100Integer(interactions)} visible discussion actions`
        : "Publisher views are not inferred"
    ]
  };
}

function visibleDiscussionActions(metrics: DashboardCandidate["metrics"]): number {
  return [
    metrics?.likes,
    metrics?.reactions,
    metrics?.comments,
    metrics?.replies,
    metrics?.reposts,
    metrics?.shares,
    metrics?.quotes,
    metrics?.upvotes
  ].reduce<number>((sum, value) => sum + metricValue(value), 0);
}

function articleCompleteness(candidate: DashboardCandidate | undefined): number {
  if (!candidate) return 0;
  const signals = [
    Boolean(compactWhitespace(candidate.title)),
    Boolean(compactWhitespace(candidate.authorName ?? candidate.publisher)),
    Boolean(canonicalDashboardUrl(candidate.thumbnailUrl ?? candidate.mediaUrl)),
    Boolean(canonicalDashboardUrl(candidate.url))
  ];
  return signals.filter(Boolean).length / signals.length;
}

function candidatePublisherDomain(candidate: DashboardCandidate): string {
  try {
    return new URL(candidate.url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return candidate.platform;
  }
}

function clampScore(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundTop100Score(value: number): number {
  return Math.round(clampScore(value, 0, 100) * 10) / 10;
}

function formatTop100Integer(value: number): string {
  return Math.round(Math.max(0, value)).toLocaleString("en-US");
}

function scoreBreakdown(score: ReturnType<typeof scoreDashboardStory>): DashboardScoreBreakdown {
  return {
    relativeVirality: score.relativeVirality,
    velocity: score.velocity,
    freshness: score.freshness,
    crossPlatformConfirmation: score.crossPlatformConfirmation,
    sourceQuality: score.sourceQuality,
    absoluteSignificance: score.absoluteSignificance
  };
}

function withViewRank(
  story: UnrankedDashboardStory,
  rank: number,
  prior: DashboardRankSnapshot | undefined
): DashboardViewRanking {
  const previousRank = prior?.rank ?? null;
  const rankDelta = previousRank === null ? null : previousRank - rank;
  return {
    rank,
    previousRank,
    rankDelta,
    trendStatus: trendStatus(rankDelta, previousRank, story.score.velocity, prior?.trendScore, story.trendScore)
  };
}

const HACKER_NEWS_ONLY_MAX_SHARE = 0.01;

/**
 * The public artifact is one canonical Top 100, ordered by the overall trend
 * score. Historic per-view positions are retained only as metadata on those
 * same canonical stories; they never expand the visitor-facing list into a
 * separate union of Hottest, Breaking, and Emerging results.
 *
 * Hacker News is valuable corroboration when it accompanies a primary source,
 * but a stream of HN-only submissions is not a representative internet-wide
 * news feed. Limit HN-only stories to one percent of the canonical capacity,
 * before any view is ranked, so the cap applies to the entire persisted feed.
 */
function rankStoriesForViews(
  stories: readonly UnrankedDashboardStory[],
  limit: number,
  priorRanks: ReadonlyMap<string, DashboardRankSnapshot>
): DashboardStory[] {
  const orderedByHottest = [...stories]
    .sort((left, right) => compareUnrankedStoriesForView(left, right, "hottest"));
  const rankableStories = applyHackerNewsOnlyCap(orderedByHottest, limit);
  const canonicalStories = selectDiverseTop100Stories(rankableStories, limit);
  const canonicalKeys = new Set(canonicalStories.map((story) => story.stableKey));
  const rankingsByStory = new Map<string, Partial<Record<DashboardView, DashboardViewRanking>>>();
  const storiesByKey = new Map(canonicalStories.map((story) => [story.stableKey, story]));
  const canonicalHottestRanks = new Map(
    canonicalStories
      .map((story, index) => [story.stableKey, index + 1])
  );

  for (const view of DASHBOARD_VIEWS) {
    const ranking = [...canonicalStories]
      .sort((left, right) => compareUnrankedStoriesForView(left, right, view))
      .slice(0, limit);
    for (const [index, story] of ranking.entries()) {
      // Only the consolidated Top 100 is published. Retain a compatible
      // per-view rank when this canonical story also qualifies for that view,
      // but never pull a Breaking/Emerging-only story into the public list.
      if (!canonicalKeys.has(story.stableKey)) continue;
      const current = rankingsByStory.get(story.stableKey) ?? {};
      current[view] = withViewRank(story, index + 1, priorRanks.get(rankSnapshotKey(story.stableKey, view)));
      rankingsByStory.set(story.stableKey, current);
    }
  }

  return [...rankingsByStory.entries()]
    .map(([stableKey, viewRankings]) => {
      const story = storiesByKey.get(stableKey);
      const hottest = viewRankings.hottest;
      const canonicalRank = canonicalHottestRanks.get(stableKey);
      if (!story || !canonicalRank) return null;
      // A Breaking/Emerging-only story has a truthful overall Hottest
      // position, while the view map drives the selectable public position.
      const canonicalPrior = priorRanks.get(rankSnapshotKey(stableKey, "hottest"));
      const canonicalPreviousRank = canonicalPrior?.rank ?? null;
      const canonicalRankDelta = canonicalPreviousRank === null ? null : canonicalPreviousRank - canonicalRank;
      return {
        ...story,
        rank: canonicalRank,
        previousRank: canonicalPreviousRank,
        rankDelta: canonicalRankDelta,
        trendStatus: hottest?.trendStatus ?? trendStatus(
          canonicalRankDelta,
          canonicalPreviousRank,
          story.score.velocity,
          canonicalPrior?.trendScore,
          story.trendScore
        ),
        viewRankings
      } satisfies DashboardStory;
    })
    .filter((story): story is DashboardStory => story !== null)
    .sort((left, right) => left.rank - right.rank || left.stableKey.localeCompare(right.stableKey));
}

function selectDiverseTop100Stories(
  orderedStories: readonly UnrankedDashboardStory[],
  limit: number
): UnrankedDashboardStory[] {
  if (limit <= 0) return [];
  const news = orderedStories.filter((story) => dashboardStoryContentKind(story) === "news_article");
  const viral = orderedStories.filter((story) => dashboardStoryContentKind(story) === "viral_post");
  const newsTarget = Math.min(news.length, Math.ceil(limit * DASHBOARD_NEWS_TARGET_SHARE));
  const viralTarget = Math.min(viral.length, limit - newsTarget);
  const selected = [
    ...takeStoriesWithCap(news, newsTarget, storyPublisherDomain, DASHBOARD_MAX_NEWS_PER_PUBLISHER),
    ...takeStoriesWithCap(viral, viralTarget, storySocialPlatform, DASHBOARD_MAX_SOCIAL_PER_PLATFORM)
  ];
  const selectedKeys = new Set(selected.map((story) => story.stableKey));
  for (const story of orderedStories) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(story.stableKey)) continue;
    selected.push(story);
    selectedKeys.add(story.stableKey);
  }
  return selected.sort((left, right) => compareUnrankedStoriesForView(left, right, "hottest"));
}

function takeStoriesWithCap(
  stories: readonly UnrankedDashboardStory[],
  target: number,
  keyForStory: (story: UnrankedDashboardStory) => string,
  cap: number
): UnrankedDashboardStory[] {
  const selected: UnrankedDashboardStory[] = [];
  const counts = new Map<string, number>();
  for (const story of stories) {
    if (selected.length >= target) break;
    const key = keyForStory(story);
    if ((counts.get(key) ?? 0) >= cap) continue;
    selected.push(story);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (selected.length < target) {
    const selectedKeys = new Set(selected.map((story) => story.stableKey));
    for (const story of stories) {
      if (selected.length >= target) break;
      if (selectedKeys.has(story.stableKey)) continue;
      selected.push(story);
      selectedKeys.add(story.stableKey);
    }
  }
  return selected;
}

function dashboardStoryContentKind(
  story: Pick<UnrankedDashboardStory, "sources">
): "viral_post" | "news_article" {
  const primary = story.sources[0];
  return primary && dashboardTop100ContentKind(primary) === "viral_post"
    ? "viral_post"
    : "news_article";
}

function storyPublisherDomain(story: UnrankedDashboardStory): string {
  const source = story.sources[0];
  if (!source) return "unknown";
  try {
    return new URL(source.url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return source.platform;
  }
}

function storySocialPlatform(story: UnrankedDashboardStory): string {
  return story.sources[0]?.nativePlatform ?? "unknown";
}

function applyHackerNewsOnlyCap(
  stories: readonly UnrankedDashboardStory[],
  limit: number
): UnrankedDashboardStory[] {
  const maxHackerNewsOnlyStories = Math.floor(limit * HACKER_NEWS_ONLY_MAX_SHARE);
  let includedHackerNewsOnlyStories = 0;
  return stories.filter((story) => {
    if (!isHackerNewsOnlyStory(story)) return true;
    if (includedHackerNewsOnlyStories >= maxHackerNewsOnlyStories) return false;
    includedHackerNewsOnlyStories += 1;
    return true;
  });
}

function isHackerNewsOnlyStory(story: Pick<UnrankedDashboardStory, "sources">): boolean {
  return story.sources.length > 0 && story.sources.every((source) => source.platform === "hacker_news");
}

function trendStatus(
  rankDelta: number | null,
  previousRank: number | null,
  velocity: number,
  priorScore: number | undefined,
  score: number
): DashboardTrendStatus {
  if (previousRank === null) return "new";
  if (rankDelta !== null && rankDelta >= 8 && velocity >= 35) return "rising_fast";
  if (rankDelta !== null && rankDelta >= 1) return "rising";
  if ((rankDelta !== null && rankDelta <= -4) || (priorScore !== undefined && score + 8 < priorScore)) return "cooling";
  return "stable";
}

function storyTitle(primary: DashboardCandidate | undefined, candidates: readonly DashboardCandidate[]): string {
  const options = [
    primary?.title,
    ...candidates.map((candidate) => candidate.title),
    primary?.summary,
    primary?.text,
    primary?.entityLabel,
    primary?.trackedEntity?.name
  ];
  for (const option of options) {
    const title = compactHeadline(option, 160);
    if (title.length >= 3) return title;
  }
  return "Technology development";
}

/**
 * Headlines are not prose sentences: abbreviations such as "U.S." and
 * product versions such as "v2.0" must not make us discard the rest of the
 * publisher's title. Summaries still use `compactSentence`; this helper only
 * preserves a bounded display headline.
 */
function compactHeadline(value: string | null | undefined, maxLength: number): string {
  const normalized = compactWhitespace(value)
    .replace(/([!?]){2,}/g, "$1")
    .replace(/\s+([,.;:!?])/g, "$1");
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized.replace(/[.!?]+$/, "");
  const limit = Math.max(1, maxLength - 1);
  const visible = normalized.slice(0, limit);
  const lastWordBoundary = visible.lastIndexOf(" ");
  const truncated = (lastWordBoundary > Math.floor(limit * 0.55)
    ? visible.slice(0, lastWordBoundary)
    : visible
  ).replace(/[\s,;:.!?]+$/, "");
  return `${truncated}…`;
}

function groundedStorySummary(candidates: readonly DashboardCandidate[], title: string): string {
  const titleComparable = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const options = candidates.flatMap((candidate) => [candidate.summary, candidate.text, candidate.title]);
  for (const option of options) {
    const sentence = compactSentence(option, 300);
    if (!sentence) continue;
    const comparable = sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (comparable && comparable !== titleComparable) return ensureDashboardSummary(sentence, title);
  }
  // This fallback intentionally does not invent importance, functionality, or
  // metrics when the adapter supplied only a title.
  return ensureDashboardSummary(`${title.replace(/[.!?]+$/, "")}.`, title);
}

function validDashboardSummary(value: string | null | undefined): string | null {
  const summary = compactSentence(value, 1_000);
  return summary && summary.length >= 8 ? summary : null;
}

function ensureDashboardSummary(value: string, title: string): string {
  const summary = validDashboardSummary(value);
  if (summary) return summary;
  // A terse source title (for example, a repository named "Foo") still needs
  // a valid persisted generated-summary receipt. This sentence only attributes
  // the supplied title to its source; it adds no claims, metrics, or context.
  return `A source reports: ${title.replace(/[.!?]+$/, "")}.`;
}

function toStorySource(candidate: DashboardCandidate, score: ReturnType<typeof scoreDashboardStory>): DashboardStorySource {
  const signals: string[] = [];
  if (candidate.metricHistory && candidate.metricHistory.length >= 2) signals.push("Observed engagement velocity");
  if (candidate.accountBaseline || candidate.followerCount) signals.push("Relative source performance");
  if (candidate.independentlyReported) signals.push("Independent confirmation");
  if (score.absoluteSignificance >= 75) signals.push("High platform-relative attention");
  return {
    id: candidate.id,
    canonicalKey: candidate.canonicalKey,
    platform: dashboardPlatformForCandidate(candidate),
    nativePlatform: candidate.platform,
    sourceKind: candidate.sourceKind,
    verificationState: candidate.sourceVerified === true ? "verified" : "unverified",
    url: candidate.url,
    destinationUrl: canonicalDashboardUrl(candidate.destinationUrl),
    title: boundedDashboardText(candidate.title, 500),
    // `compactSentence` may append terminal punctuation after truncation, so
    // reserve one character for the strict 300-character artifact contract.
    summary: compactSentence(candidate.summary ?? candidate.text, 299),
    authorName: boundedDashboardText(candidate.authorName, 300),
    publisher: boundedDashboardText(candidate.publisher, 300),
    publishedAt: candidate.publishedAt,
    metrics: aggregateMetrics([candidate.metrics ?? {}]),
    thumbnailUrl: canonicalDashboardUrl(candidate.thumbnailUrl),
    thumbnailAlt: boundedDashboardText(candidate.thumbnailAlt ?? candidate.title, 240),
    trackedEntity: candidate.trackedEntity ?? null,
    signals
  };
}

function selectThumbnail(candidates: readonly DashboardCandidate[]): DashboardCandidate | null {
  const candidatesWithImages = candidates.filter((candidate) =>
    Boolean(canonicalDashboardUrl(candidate.thumbnailUrl))
  );
  if (!candidatesWithImages.length) return null;
  return [...candidatesWithImages].sort((left, right) => thumbnailPriority(right) - thumbnailPriority(left) || left.id.localeCompare(right.id))[0];
}

/**
 * Captions from social evidence are source text, not UI copy. Bound them at
 * the projection boundary so a valid high-engagement post cannot make the
 * complete snapshot fail its public persistence contract.
 */
function boundedDashboardText(value: string | null | undefined, maximumLength: number): string | null {
  const normalized = compactWhitespace(value);
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function thumbnailPriority(candidate: DashboardCandidate): number {
  const sourceBonus: Record<DashboardCandidate["sourceKind"], number> = {
    video: 70,
    launch: 60,
    release: 58,
    article: 50,
    paper: 45,
    repository: 42,
    post: 38,
    thread: 32,
    discussion: 30,
    other: 20
  };
  return sourceBonus[candidate.sourceKind] + Math.min(20, Math.log10(engagementMass(candidate.metrics) + 1) * 5);
}

function storyTopics(candidates: readonly DashboardCandidate[]): DashboardTopic[] {
  const explicit = candidates.flatMap((candidate) => candidate.topics ?? []);
  if (explicit.length) return normalizeTopicList(explicit);
  const text = candidates
    .map((candidate) => `${candidate.title ?? ""} ${candidate.summary ?? ""} ${candidate.text ?? ""} ${candidate.sourceKind}`)
    .join(" ")
    .toLowerCase();
  const topics = new Set<DashboardTopic>();
  if (/\b(?:ai|artificial intelligence|llm|model|inference|agent|machine learning)\b/.test(text)) topics.add("ai");
  if (/\b(?:robot|robotics|autonomous vehicle|vla)\b/.test(text)) topics.add("robotics");
  if (/\b(?:paper|research|arxiv|study|benchmark)\b/.test(text)) topics.add("research");
  if (/\b(?:raised|funding|seed round|series [a-z])\b/.test(text)) topics.add("funding");
  if (/\b(?:launch|release|shipping|available now|introduc)\b/.test(text)) topics.add("launches");
  if (/\b(?:github|open.source|repository|repo)\b/.test(text)) topics.add("open_source");
  if (/\b(?:biotech|biology|drug|genomic|protein|clinical)\b/.test(text)) topics.add("biotech");
  if (/\b(?:startup|founder|y combinator|accelerator)\b/.test(text)) topics.add("startups");
  return topics.size ? [...topics].sort() : ["other"];
}

function compareUnrankedStoriesForView(
  left: UnrankedDashboardStory,
  right: UnrankedDashboardStory,
  view: DashboardView
): number {
  if (view === "hottest") {
    const socialPreference = Number(hasPreferredMeasuredSocialStory(right)) - Number(hasPreferredMeasuredSocialStory(left));
    if (socialPreference) return socialPreference;
  }
  return scoreForView(right, view) - scoreForView(left, view) ||
    right.trendScore - left.trendScore ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.stableKey.localeCompare(right.stableKey);
}

function hasPreferredMeasuredSocialStory(story: Pick<UnrankedDashboardStory, "sources" | "topics">): boolean {
  return story.sources.some((source) =>
    source.trackedEntity !== null &&
    TOP100_SOCIAL_PLATFORMS.has(source.nativePlatform) &&
    engagementMass(source.metrics) > 0 &&
    hasTechnologySocialContent(source, story.topics)
  );
}

function hasHighConfidenceSocialTopic(topics: readonly DashboardTopic[] | null | undefined): boolean {
  return (topics ?? []).some((topic) => HIGH_CONFIDENCE_SOCIAL_TOPICS.has(topic));
}

function hasTechnologySocialContent(
  candidate: Pick<DashboardCandidate, "title" | "summary" | "text"> | Pick<DashboardStorySource, "title" | "summary">,
  topics: readonly DashboardTopic[] | null | undefined
): boolean {
  const content = [
    candidate.title ?? "",
    candidate.summary ?? "",
    "text" in candidate ? candidate.text ?? "" : ""
  ].join(" ");
  return !NON_TECH_SOCIAL_SIGNAL.test(content) &&
    (hasHighConfidenceSocialTopic(topics) || TECHNOLOGY_SOCIAL_SIGNAL.test(content));
}

function scoreForView(story: UnrankedDashboardStory, view: DashboardView): number {
  if (view === "breaking") return story.breakingScore;
  if (view === "emerging") return story.emergingScore;
  return story.trendScore;
}

/**
 * An arXiv/RSS record alone is publication metadata, not evidence of a trend.
 * Keep it available to cluster with HN, Reddit, video, repository, or news
 * coverage, but do not let an unobserved paper take a public rank by itself.
 */
function isClusterRankable(cluster: DashboardStoryCluster): boolean {
  return cluster.candidates.some((candidate) =>
    candidate.sourceKind !== "paper" ||
    candidate.independentlyReported === true ||
    engagementMass(candidate.metrics) > 0
  );
}

function rankSnapshotKey(stableKey: string, view: DashboardView | undefined): string {
  // Historic single-list artifacts predate view ranks and represent Hottest.
  return `${view ?? "hottest"}:${stableKey}`;
}

function compareCandidatesForStory(
  left: DashboardCandidate,
  right: DashboardCandidate,
  platformSignificance: ReadonlyMap<string, number>,
  now: Date
): number {
  return top100AnchorPriority(right, now) - top100AnchorPriority(left, now) ||
    primarySourcePriority(right) - primarySourcePriority(left) ||
    (platformSignificance.get(right.id) ?? 0) - (platformSignificance.get(left.id) ?? 0) ||
    new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime() ||
    left.id.localeCompare(right.id);
}

function top100AnchorPriority(candidate: DashboardCandidate, now: Date): number {
  const eligibility = dashboardTop100Eligibility(candidate, now);
  if (!eligibility.eligible) return 0;
  return eligibility.contentKind === "viral_post" ? 2 : 1;
}

function primarySourcePriority(candidate: DashboardCandidate): number {
  // A qualified million-view native post remains the card anchor so visible
  // counters and the outbound link always describe the same physical source.
  if (isMeasuredVerifiedTechnologySocialCandidate(candidate)) return 6;
  // Papers and independent reporting provide the clearest story anchor for
  // every other story. An HN submission still stays in the clustered source
  // list and contributes real multi-platform corroboration, but cannot
  // displace that primary.
  if (candidate.sourceKind === "paper") return 5;
  if (isIndependentEditorialOrResearchSource(candidate)) return 4;
  if (candidate.sourceKind === "article" && (candidate.platform === "web" || candidate.platform === "rss")) return 3;
  if (candidate.platform === "hacker_news") return 0;
  return candidate.independentlyReported === true ? 2 : 1;
}

function groundedTodayInTech(stories: readonly DashboardStory[]): string[] {
  // Do not synthesize cross-story claims. Each bullet is a concise, factual
  // headline from a ranked story and therefore traceable to its sources.
  return stories.slice(0, 8).map((story) => `${story.title.replace(/[.!?]+$/, "")}.`);
}

function buildDiagnostics(
  candidates: readonly DashboardCandidate[],
  unique: readonly DashboardCandidate[],
  eligible: readonly DashboardCandidate[],
  clusters: readonly DashboardStoryCluster[],
  stories: readonly DashboardStory[],
  priorRanks: ReadonlyMap<string, DashboardRankSnapshot>
): DashboardPipelineResult["diagnostics"] {
  const platformDistribution = countBy(eligible, (candidate) => dashboardPlatformForCandidate(candidate));
  const topicDistribution = countBy(stories.flatMap((story) => story.topics), (topic) => topic);
  const universeDistribution = {
    returner: stories.filter((story) => story.universe === "returner").length,
    industry: stories.filter((story) => story.universe === "industry").length
  };
  return {
    candidateCount: candidates.length,
    eligibleCandidateCount: eligible.length,
    duplicateSourcesRemoved: Math.max(0, candidates.length - unique.length),
    clusterCount: clusters.length,
    newStoryCount: stories.filter((story) => !priorRanks.has(rankSnapshotKey(story.stableKey, "hottest"))).length,
    updatedStoryCount: stories.filter((story) => priorRanks.has(rankSnapshotKey(story.stableKey, "hottest"))).length,
    platformDistribution,
    topicDistribution,
    universeDistribution
  };
}

function countBy<T>(items: readonly T[], keyFor: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function latestUpdatedAt(stories: readonly DashboardStory[]): string | null {
  return stories.map((story) => story.updatedAt).sort().at(-1) ?? null;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}
