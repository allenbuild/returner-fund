import {
  DASHBOARD_SCHEMA_VERSION,
  DASHBOARD_TOP_LIMIT,
  DASHBOARD_VIEWS,
  DASHBOARD_WINDOW_MS,
  type DashboardCandidate,
  type DashboardPipelineOptions,
  type DashboardPipelineResult,
  type DashboardRankSnapshot,
  type DashboardScoreBreakdown,
  type DashboardStory,
  type DashboardStorySource,
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
  const eligibleCandidates = uniqueCandidates.filter((candidate) => isDashboardCandidateEligible(candidate, now));
  const platformSignificance = platformNormalizedSignificance(eligibleCandidates);
  const priorRanks = new Map((options.priorRankSnapshots ?? []).map((snapshot) => [rankSnapshotKey(snapshot.stableKey, snapshot.view), snapshot]));
  const priorStories = new Map((options.priorStories ?? []).map((story) => [story.stableKey, story]));
  const clusters = clusterDashboardCandidates(eligibleCandidates);
  const rankableClusters = clusters.filter(isClusterRankable);
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
  const candidates = [...cluster.candidates].sort((left, right) => compareCandidatesForStory(left, right, platformSignificance));
  const score = scoreDashboardStory(candidates, { now, absoluteSignificance: platformSignificance });
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
    thumbnailUrl: thumbnail?.thumbnailUrl ?? null,
    thumbnailAlt: thumbnail?.thumbnailAlt ?? title,
    universe: tracked.length ? "returner" : "industry",
    labels,
    topics,
    platforms,
    publishedAt,
    updatedAt,
    trendScore: score.trendScore,
    breakingScore: score.breakingScore,
    emergingScore: score.emergingScore,
    score: scoreBreakdown(score),
    sourceCount: sources.length,
    independentSourceCount,
    engagement,
    sources
  };
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
  const canonicalStories = rankableStories.slice(0, limit);
  const canonicalKeys = new Set(canonicalStories.map((story) => story.stableKey));
  const rankingsByStory = new Map<string, Partial<Record<DashboardView, DashboardViewRanking>>>();
  const storiesByKey = new Map(canonicalStories.map((story) => [story.stableKey, story]));
  const canonicalHottestRanks = new Map(
    canonicalStories
      .map((story, index) => [story.stableKey, index + 1])
  );

  for (const view of DASHBOARD_VIEWS) {
    const ranking = [...rankableStories]
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
    url: candidate.url,
    destinationUrl: canonicalDashboardUrl(candidate.destinationUrl),
    title: compactWhitespace(candidate.title) || null,
    // `compactSentence` may append terminal punctuation after truncation, so
    // reserve one character for the strict 300-character artifact contract.
    summary: compactSentence(candidate.summary ?? candidate.text, 299),
    authorName: compactWhitespace(candidate.authorName) || null,
    publisher: compactWhitespace(candidate.publisher) || null,
    publishedAt: candidate.publishedAt,
    metrics: aggregateMetrics([candidate.metrics ?? {}]),
    thumbnailUrl: candidate.thumbnailUrl ?? null,
    thumbnailAlt: candidate.thumbnailAlt ?? candidate.title ?? null,
    trackedEntity: candidate.trackedEntity ?? null,
    signals
  };
}

function selectThumbnail(candidates: readonly DashboardCandidate[]): DashboardCandidate | null {
  const candidatesWithImages = candidates.filter((candidate) => Boolean(candidate.thumbnailUrl));
  if (!candidatesWithImages.length) return null;
  return [...candidatesWithImages].sort((left, right) => thumbnailPriority(right) - thumbnailPriority(left) || left.id.localeCompare(right.id))[0];
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
  return scoreForView(right, view) - scoreForView(left, view) ||
    right.trendScore - left.trendScore ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.stableKey.localeCompare(right.stableKey);
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
  platformSignificance: ReadonlyMap<string, number>
): number {
  return primarySourcePriority(right) - primarySourcePriority(left) ||
    (platformSignificance.get(right.id) ?? 0) - (platformSignificance.get(left.id) ?? 0) ||
    new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime() ||
    left.id.localeCompare(right.id);
}

function primarySourcePriority(candidate: DashboardCandidate): number {
  // Papers and independent reporting provide the clearest story anchor. An
  // HN submission still stays in the clustered source list and contributes
  // real multi-platform corroboration, but cannot displace that primary.
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
