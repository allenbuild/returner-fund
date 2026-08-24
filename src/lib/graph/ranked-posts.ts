import {
  canonicalEvidenceUrl,
  canonicalPostKey,
  contextEvidenceContentUrl,
  dedupeEvidenceForScoring
} from "./dedupe";
import {
  credibleNativePublicationDate,
  isCrediblyPublishedToday,
  isCrediblyPublishedWithinWindow
} from "./native-publication-date";
import { scoringEligibility } from "./traction-scoring";
import {
  rankedPostsSidecarScope,
  type RankedPostsSidecarScope
} from "./ranked-posts-sidecar";
import type { PostTopic } from "./post-topics";
import type { EvidenceItem, GraphNode, GraphResponse, Platform } from "./types";

export const RANKED_POSTS_LIMIT = 100;
export const RANKED_POSTS_MONTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const RANKED_POSTS_RECENT_WINDOW_MS = 72 * 60 * 60 * 1_000;
export const RANKED_POSTS_MIN_VIEWS = 1_000_000;
export const RANKED_POSTS_NEWS_SHARE = 0.3;
export const RANKED_POSTS_MAX_NEWS_PER_PUBLISHER = 3;
export const RANKED_POSTS_MAX_SOCIAL_PER_PLATFORM = 30;

export type RankedPostsPeriod = "three_days" | "today" | "month" | "all_time";
export type RankedPostSourceKind = "company" | "founder" | "top_voice";
export type RankedPostContentKind = "viral_post" | "news_article";

export interface RankedPostScoreBreakdown {
  total: number;
  formula: "viral-reach-v1" | "news-coverage-v1" | "legacy-traction";
  reach: number;
  velocity: number;
  engagement: number;
  freshness: number;
  newsAttention: number;
  sourceCoverage: number;
  completeness: number;
  reasons: string[];
}

export interface RankedPost {
  rank: number;
  evidence: EvidenceItem;
  companyId: string;
  companyName: string;
  sourceKind: RankedPostSourceKind;
  contentKind: RankedPostContentKind;
  score: RankedPostScoreBreakdown;
  canonicalPostKey: string;
}

export interface SelectRankedPostsOptions {
  period: RankedPostsPeriod;
  now?: Date;
  limit?: number;
  /** Explicit facet scope for non-dashboard callers. The dashboard's filtered
   * graph is detected conservatively from its published-preview coverage. */
  platforms?: readonly Platform[];
  topics?: readonly PostTopic[];
  /** Test and offline override; production callers use the generated sidecar. */
  sidecarScope?: RankedPostsSidecarScope | null;
}

type RankedPostCandidate = Omit<RankedPost, "rank">;

export interface RankedPostEligibility {
  eligible: boolean;
  reason:
    | "eligible"
    | "outside_72_hour_window"
    | "missing_precise_publication_date"
    | "below_one_million_views"
    | "not_verified"
    | "invalid_link"
    | "not_rankable"
    | "missing_article_content";
}

/**
 * Selects ranked posts from an already visibility-filtered graph. This function
 * never calculates or mutates evidence or company scores.
 */
export function selectRankedPosts(
  graph: GraphResponse,
  options: SelectRankedPostsOptions
): RankedPost[] {
  const now = options.now ?? new Date();
  const limit = Math.max(0, Math.min(RANKED_POSTS_LIMIT, Math.trunc(options.limit ?? RANKED_POSTS_LIMIT)));
  const companyNodes = graph.nodes.filter(isCompanyNode);
  const companiesById = new Map(companyNodes.map((node) => [node.entityId, node]));
  const companyByFounderId = founderCompanyIndex(companyNodes);
  const previewEvidence = rankableEvidence(graph.evidence);
  const scope = options.sidecarScope === undefined
    ? rankedPostsSidecarScope(graph.batch.slug, graph.selectedTopVoiceAudience.id)
    : options.sidecarScope;
  const sidecarEvidence = scope && sidecarMatchesGraphPreview(
    graph,
    scope,
    previewEvidence,
    companiesById,
    companyByFounderId
  )
    ? scope.evidence
    : [];
  const selectedPlatforms = new Set(options.platforms ?? []);
  const selectedTopics = new Set(options.topics ?? []);
  const mergedEvidence = [...graph.evidence, ...sidecarEvidence];
  const eligibleEvidence = (options.period === "three_days"
    ? recentFeedEvidence(mergedEvidence)
    : rankableEvidence(mergedEvidence))
    .filter((evidence) => selectedPlatforms.size === 0 || selectedPlatforms.has(evidence.platform))
    .filter((evidence) =>
      selectedTopics.size === 0 || (evidence.topics ?? []).some((topic) => selectedTopics.has(topic))
    );
  const candidates: RankedPostCandidate[] = [];
  const recentCompanyCoverage = recentSourceCoverageByCompany(eligibleEvidence, now);

  for (const evidence of eligibleEvidence) {
    if (
      options.period === "three_days" &&
      !rankedPostEligibility(evidence, now).eligible
    ) {
      continue;
    }
    if (
      options.period === "today" &&
      !isCrediblyPublishedToday(evidence, now)
    ) {
      continue;
    }
    if (
      options.period === "month" &&
      !isCrediblyPublishedWithinWindow(evidence, now, RANKED_POSTS_MONTH_WINDOW_MS)
    ) {
      continue;
    }

    const companyId = evidenceCompanyId(evidence, companiesById, companyByFounderId);
    if (!companyId) continue;
    const company = companiesById.get(companyId);
    if (!company) continue;

    const physicalPostKey = canonicalPostKey(evidence);
    const contentKind = rankedPostContentKind(evidence);
    const candidate: RankedPostCandidate = {
      evidence,
      companyId,
      companyName: company.label,
      sourceKind: evidence.topVoice
        ? "top_voice"
        : evidence.entityType === "founder"
          ? "founder"
          : "company",
      contentKind,
      score: options.period === "three_days"
        ? rankedPostSurfacingScore(
            evidence,
            now,
            recentCompanyCoverage.get(companyId) ?? 1
          )
        : legacyRankedPostScore(evidence),
      canonicalPostKey: physicalPostKey
    };
    candidates.push(candidate);
  }

  const sortedCandidates = candidates.sort(compareRankedPostCandidates);
  const rankedCandidates = options.period === "three_days"
    ? selectDiverseRecentCandidates(sortedCandidates, limit)
    : sortedCandidates.slice(0, limit);
  let tiedRank = 0;
  let previousScore: number | null = null;

  return rankedCandidates.map((candidate, index) => {
    const score = candidate.score.total;
    if (options.period === "three_days" || previousScore === null || score !== previousScore) {
      tiedRank = index + 1;
    }
    previousScore = score;
    return { ...candidate, rank: tiedRank };
  });
}

/**
 * The product-facing Top 100 contract. Social posts and videos must expose at
 * least one million native views. News is admitted through a separate,
 * explicitly labeled path because publishers rarely expose comparable views.
 */
export function rankedPostEligibility(item: EvidenceItem, now: Date): RankedPostEligibility {
  const publication = credibleNativePublicationDate(item);
  if (!publication) return { eligible: false, reason: "missing_precise_publication_date" };
  if (!isCrediblyPublishedWithinWindow(item, now, RANKED_POSTS_RECENT_WINDOW_MS)) {
    return { eligible: false, reason: "outside_72_hour_window" };
  }
  if (item.review_state !== "verified") return { eligible: false, reason: "not_verified" };
  if (item.linkStatus === "invalid" || item.linkStatus === "blocked") {
    return { eligible: false, reason: "invalid_link" };
  }

  if (rankedPostContentKind(item) === "news_article") {
    if (!rankedPostDestinationUrl(item) || !(item.title?.trim() || item.text.trim())) {
      return { eligible: false, reason: "missing_article_content" };
    }
    return { eligible: true, reason: "eligible" };
  }

  if (!scoringEligibility(item).eligible) return { eligible: false, reason: "not_rankable" };
  if (finiteNumber(item.metrics.views) < RANKED_POSTS_MIN_VIEWS) {
    return { eligible: false, reason: "below_one_million_views" };
  }
  return { eligible: true, reason: "eligible" };
}

export function rankedPostContentKind(item: EvidenceItem): RankedPostContentKind {
  return item.platform === "web" || item.platform === "rss" ? "news_article" : "viral_post";
}

export function rankedPostDestinationUrl(item: EvidenceItem): string | null {
  const contextualUrl = contextEvidenceContentUrl(item.platform, item.platformPostId);
  const destination = contextualUrl ?? canonicalEvidenceUrl(item.sourceUrl);
  return /^https?:\/\//i.test(destination) ? destination : null;
}

export function rankedPostSurfacingScore(
  item: EvidenceItem,
  now: Date,
  companySourceCoverage = 1
): RankedPostScoreBreakdown {
  const publication = credibleNativePublicationDate(item);
  const ageHours = publication
    ? clamp((now.getTime() - publication.timestamp) / (60 * 60 * 1_000), 0, 72)
    : 72;
  const freshnessRatio = clamp(1 - ageHours / 72, 0, 1);

  if (rankedPostContentKind(item) === "news_article") {
    const interactions = visibleInteractions(item);
    const newsAttention = roundScore(45 * clamp(Math.log10(interactions + 1) / 5, 0, 1));
    const sourceCoverage = roundScore(25 * clamp((companySourceCoverage - 1) / 4, 0, 1));
    const freshness = roundScore(20 * freshnessRatio);
    const completeness = roundScore(10 * articleCompleteness(item));
    const total = roundScore(newsAttention + sourceCoverage + freshness + completeness);
    return {
      total,
      formula: "news-coverage-v1",
      reach: 0,
      velocity: 0,
      engagement: 0,
      freshness,
      newsAttention,
      sourceCoverage,
      completeness,
      reasons: [
        `Published within the rolling 72-hour window`,
        `${companySourceCoverage} distinct public source${companySourceCoverage === 1 ? "" : "s"} covered this company`,
        interactions > 0 ? `${formatInteger(interactions)} visible discussion actions` : "Publisher views are not inferred"
      ]
    };
  }

  const views = finiteNumber(item.metrics.views);
  const interactions = visibleInteractions(item);
  const reach = roundScore(25 + 25 * clamp(Math.log10(Math.max(1, views / RANKED_POSTS_MIN_VIEWS)) / 2, 0, 1));
  const viewsPerHour = views / Math.max(1, ageHours);
  const velocity = roundScore(25 * clamp(Math.log10(Math.max(1, viewsPerHour / 1_000)) / 3, 0, 1));
  const engagementRate = views > 0 ? interactions / views : 0;
  const engagement = roundScore(15 * clamp(engagementRate / 0.1, 0, 1));
  const freshness = roundScore(10 * freshnessRatio);
  const total = roundScore(reach + velocity + engagement + freshness);

  return {
    total,
    formula: "viral-reach-v1",
    reach,
    velocity,
    engagement,
    freshness,
    newsAttention: 0,
    sourceCoverage: 0,
    completeness: 0,
    reasons: [
      `${formatInteger(views)} verified native views`,
      `${formatInteger(Math.round(viewsPerHour))} views/hour since publication`,
      `${(engagementRate * 100).toFixed(2)}% visible engagement rate`
    ]
  };
}

/** The single rankability contract shared by the UI and the sidecar builder. */
export function rankableEvidence(evidence: readonly EvidenceItem[]): EvidenceItem[] {
  return dedupeEvidenceForScoring(
    evidence.filter(
      (item) =>
        item.contributionScore > 0 &&
        item.tractionStatus !== "unscored" &&
        scoringEligibility(item).eligible
    )
  );
}

export function compareRankedPostEvidence(left: EvidenceItem, right: EvidenceItem): number {
  return (
    rankedPostScore(right) - rankedPostScore(left) ||
    finiteNumber(right.rawEngagement) - finiteNumber(left.rawEngagement) ||
    publicationSortValue(right) - publicationSortValue(left) ||
    canonicalEvidenceUrl(left.sourceUrl).localeCompare(canonicalEvidenceUrl(right.sourceUrl)) ||
    left.id.localeCompare(right.id)
  );
}

function compareRankedPostCandidates(left: RankedPostCandidate, right: RankedPostCandidate): number {
  return (
    right.score.total - left.score.total ||
    finiteNumber(right.evidence.metrics.views) - finiteNumber(left.evidence.metrics.views) ||
    compareRankedPostEvidence(left.evidence, right.evidence) ||
    left.companyId.localeCompare(right.companyId) ||
    left.sourceKind.localeCompare(right.sourceKind)
  );
}

function recentFeedEvidence(evidence: EvidenceItem[]): EvidenceItem[] {
  return dedupeEvidenceForScoring(
    evidence.filter((item) =>
      rankedPostContentKind(item) === "news_article" ||
      (
        item.contributionScore > 0 &&
        item.tractionStatus !== "unscored" &&
        scoringEligibility(item).eligible
      )
    )
  );
}

function legacyRankedPostScore(item: EvidenceItem): RankedPostScoreBreakdown {
  return {
    total: rankedPostScore(item),
    formula: "legacy-traction",
    reach: 0,
    velocity: 0,
    engagement: 0,
    freshness: 0,
    newsAttention: 0,
    sourceCoverage: 0,
    completeness: 0,
    reasons: []
  };
}

function selectDiverseRecentCandidates(
  sortedCandidates: RankedPostCandidate[],
  limit: number
): RankedPostCandidate[] {
  if (limit <= 0) return [];
  const news = sortedCandidates.filter((candidate) => candidate.contentKind === "news_article");
  const viral = sortedCandidates.filter((candidate) => candidate.contentKind === "viral_post");
  const newsTarget = Math.min(news.length, Math.ceil(limit * RANKED_POSTS_NEWS_SHARE));
  const viralTarget = Math.min(viral.length, limit - newsTarget);
  const selected = [
    ...takeWithCap(news, newsTarget, (candidate) => publisherDomain(candidate.evidence), RANKED_POSTS_MAX_NEWS_PER_PUBLISHER),
    ...takeWithCap(viral, viralTarget, (candidate) => candidate.evidence.platform, RANKED_POSTS_MAX_SOCIAL_PER_PLATFORM)
  ];
  const selectedKeys = new Set(selected.map((candidate) => candidate.canonicalPostKey));
  for (const candidate of sortedCandidates) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(candidate.canonicalPostKey)) continue;
    selected.push(candidate);
    selectedKeys.add(candidate.canonicalPostKey);
  }
  return selected.sort(compareRankedPostCandidates);
}

function takeWithCap(
  candidates: RankedPostCandidate[],
  target: number,
  keyForCandidate: (candidate: RankedPostCandidate) => string,
  cap: number
): RankedPostCandidate[] {
  const selected: RankedPostCandidate[] = [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (selected.length >= target) break;
    const key = keyForCandidate(candidate);
    if ((counts.get(key) ?? 0) >= cap) continue;
    selected.push(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (selected.length < target) {
    const selectedKeys = new Set(selected.map((candidate) => candidate.canonicalPostKey));
    for (const candidate of candidates) {
      if (selected.length >= target) break;
      if (!selectedKeys.has(candidate.canonicalPostKey)) selected.push(candidate);
    }
  }
  return selected;
}

function recentSourceCoverageByCompany(evidence: EvidenceItem[], now: Date): Map<string, number> {
  const domainsByCompany = new Map<string, Set<string>>();
  for (const item of evidence) {
    if (!isCrediblyPublishedWithinWindow(item, now, RANKED_POSTS_RECENT_WINDOW_MS)) continue;
    const companyId = item.attachedCompanyId ?? (item.entityType === "company" ? item.entityId : null);
    if (!companyId) continue;
    const sources = domainsByCompany.get(companyId) ?? new Set<string>();
    sources.add(publisherDomain(item));
    domainsByCompany.set(companyId, sources);
  }
  return new Map([...domainsByCompany].map(([companyId, sources]) => [companyId, sources.size]));
}

function publisherDomain(item: EvidenceItem): string {
  const destination = rankedPostDestinationUrl(item) ?? item.sourceUrl;
  try {
    return new URL(destination).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return item.platform;
  }
}

function visibleInteractions(item: EvidenceItem): number {
  const metrics = item.metrics;
  return [
    metrics.likes,
    metrics.comments,
    metrics.replies,
    metrics.reposts ?? metrics.shares,
    metrics.quotes,
    metrics.saves,
    metrics.upvotes
  ].reduce<number>((sum, value) => sum + finiteNumber(value), 0);
}

function articleCompleteness(item: EvidenceItem): number {
  const signals = [
    Boolean(item.title?.trim()),
    Boolean(item.authorName?.trim()),
    Boolean(item.thumbnailUrl || item.mediaUrl || item.mediaUrls?.length),
    Boolean(rankedPostDestinationUrl(item))
  ];
  return signals.filter(Boolean).length / signals.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundScore(value: number): number {
  return Math.round(clamp(value, 0, 100) * 10) / 10;
}

function formatInteger(value: number): string {
  return Math.round(Math.max(0, value)).toLocaleString("en-US");
}

function rankedPostScore(item: EvidenceItem): number {
  return Number.isFinite(item.normalizedScore)
    ? Number(item.normalizedScore)
    : finiteNumber(item.contributionScore);
}

function finiteNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function publicationSortValue(
  evidence: Pick<EvidenceItem, "postedAt" | "publishedAtPrecision">
): number {
  return credibleNativePublicationDate(evidence)?.timestamp ?? Number.NEGATIVE_INFINITY;
}

function founderCompanyIndex(companyNodes: GraphNode[]): Map<string, string> {
  const pairs = companyNodes
    .flatMap((node) => node.founders.map((founder) => [founder.id, node.entityId] as const))
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  const result = new Map<string, string>();
  for (const [founderId, companyId] of pairs) {
    if (!result.has(founderId)) result.set(founderId, companyId);
  }
  return result;
}

function evidenceCompanyId(
  evidence: EvidenceItem,
  companiesById: Map<string, GraphNode>,
  companyByFounderId: Map<string, string>
): string | null {
  if (evidence.attachedCompanyId && companiesById.has(evidence.attachedCompanyId)) {
    return evidence.attachedCompanyId;
  }
  if (evidence.entityType === "company" && companiesById.has(evidence.entityId)) {
    return evidence.entityId;
  }
  return companyByFounderId.get(evidence.entityId) ?? null;
}

function sidecarMatchesGraphPreview(
  graph: GraphResponse,
  scope: RankedPostsSidecarScope,
  previewEvidence: EvidenceItem[],
  companiesById: Map<string, GraphNode>,
  companyByFounderId: Map<string, string>
): boolean {
  if (scope.previewGeneratedAt !== graph.generatedAt) return false;
  if (
    graph.selectedTopVoiceAudience.id === "insiders" &&
    (graph.insiderConfigurationVersion !== undefined || (graph.selectedInsiderIds?.length ?? 0) > 0)
  ) {
    return false;
  }

  const actualCounts = new Map<string, number>();
  for (const evidence of previewEvidence) {
    const companyId = evidenceCompanyId(evidence, companiesById, companyByFounderId);
    if (!companyId) continue;
    actualCounts.set(companyId, (actualCounts.get(companyId) ?? 0) + 1);
  }

  // Company, score, industry, and search filters retain every preview post for
  // each surviving company. Platform/topic filters remove preview posts; fail
  // closed there unless the caller supplies the explicit facet scope above.
  for (const companyId of companiesById.keys()) {
    if ((actualCounts.get(companyId) ?? 0) !== (scope.previewRankableByCompany[companyId] ?? 0)) {
      return false;
    }
  }
  return true;
}

function isCompanyNode(node: GraphNode): boolean {
  return node.entityType === "company";
}
