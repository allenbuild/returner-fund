import { momentumSort } from "./benchmarks";
import { enrichEvidenceThumbnail } from "./evidence-thumbnails";
import { getNodeRadius } from "./score-radius";
import { canonicalPostKey, dedupeEvidenceForScoring } from "./dedupe";
import { aggregateBalancedTractionScore, normalizeEvidenceScores } from "./traction-scoring";
import { TRACTION_SCORING_CONFIG } from "./traction-scoring-config";
import type {
  CompanyRecord,
  EvidenceItem,
  GraphNode,
  GraphResponse,
  Platform,
  ScoreCalibration,
  SocialAccountSummary,
  TopVoiceAudienceId
} from "./types";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";
import { calibrateBatchCompanyScores } from "@/lib/scoring/batch-calibration";
import {
  benchmarkCompanyScoresWithPublishedGlobalFactor,
  benchmarkGlobalCompanyScores
} from "@/lib/scoring/global-score-benchmark";

export interface LiveEvidenceOverlayResult {
  graph: GraphResponse;
  visibleEvidence: EvidenceItem[];
  hiddenEvidence: Array<{
    sourceUrl: string;
    companyName: string;
    platform: Platform;
    reason: string;
  }>;
}

interface LiveEvidenceOverlayOptions {
  selectedPlatforms?: Platform[];
  topVoices?: TopVoiceAudienceId;
  /** Full current-company population across every supported batch. */
  calibrationCohort?: CompanyRecord[];
}

export function overlayLiveEvidenceOnGraph(
  graph: GraphResponse,
  records: LiveEvidenceRecord[],
  options: LiveEvidenceOverlayOptions = {}
): LiveEvidenceOverlayResult {
  if (!records.length) {
    return { graph, visibleEvidence: [], hiddenEvidence: [] };
  }

  const selectedPlatforms = options.selectedPlatforms ?? graph.scoringContext?.selectedPlatforms ?? [];
  const topVoiceAudience = options.topVoices ?? graph.selectedTopVoiceAudience.id;
  const hiddenEvidence: LiveEvidenceOverlayResult["hiddenEvidence"] = [];
  const companyIdByEntityId = companyOwnershipMap(graph);
  const socialAccountIdByIdentity = materializedSocialAccountIds(graph);
  const liveEvidence: EvidenceItem[] = [];

  for (const record of records) {
    if (topVoiceAudience !== "off") {
      hiddenEvidence.push(hidden(record, `hidden_by_top_voice_filter:${topVoiceAudience}`));
      continue;
    }
    if (selectedPlatforms.length && !selectedPlatforms.includes(record.platform)) {
      hiddenEvidence.push(hidden(record, "hidden_by_platform_filter"));
      continue;
    }

    const companyId = companyIdForEntity(companyIdByEntityId, record.entityId);
    if (!companyId) {
      hiddenEvidence.push(hidden(record, `hidden_by_batch:${graph.batch.slug}`));
      continue;
    }

    const item = liveEvidenceRecordToEvidenceItem(record);
    liveEvidence.push({
      ...item,
      attachedCompanyId: companyId,
      socialAccountId: resolveMaterializedSocialAccountId(item, socialAccountIdByIdentity)
    });
  }

  if (!liveEvidence.length) {
    return {
      graph,
      visibleEvidence: [],
      hiddenEvidence: hiddenEvidence.sort(compareHiddenEvidence)
    };
  }

  const companyIdForEvidence = (item: EvidenceItem) =>
    companyIdForEntity(companyIdByEntityId, item.entityId) ?? item.attachedCompanyId;
  const replayedEvidence = replayedLiveEvidence(graph.evidence, liveEvidence, companyIdForEvidence);
  if (replayedEvidence) {
    return {
      graph,
      visibleEvidence: replayedEvidence,
      hiddenEvidence: hiddenEvidence.sort(compareHiddenEvidence)
    };
  }

  const merged = mergeLiveEvidenceItems(graph.evidence, liveEvidence, companyIdForEvidence);
  const evidence = [...merged.evidence].sort(compareEvidence);
  const nextGraph = rebuildGraphScoreSurfaces(
    graph,
    evidence,
    companyIdByEntityId,
    liveEvidence,
    selectedPlatforms,
    options.calibrationCohort
  );

  return {
    graph: nextGraph,
    visibleEvidence: [...merged.liveEvidence].sort(compareEvidence),
    hiddenEvidence: hiddenEvidence.sort(compareHiddenEvidence)
  };
}

export function liveEvidenceRecordToEvidenceItem(record: LiveEvidenceRecord): EvidenceItem {
  const rawAuthor = readRawAuthor(record.rawVisibleText);
  const postedAt = record.postedAt && parseTimestamp(record.postedAt) !== null ? record.postedAt : "";

  return enrichEvidenceThumbnail({
    id: record.id,
    entityType: record.entityType,
    entityId: record.entityId,
    platform: record.platform,
    authorName: rawAuthor.name ?? record.companyName,
    authorHandle: rawAuthor.handle,
    postedAt,
    publishedAtPrecision: postedAt ? "exact" : "unknown",
    observedAt: record.last_checked_at,
    metricsCheckedAt: record.last_checked_at,
    title: record.title,
    text: record.text || record.title,
    mediaType: liveEvidenceMediaType(record),
    mediaUrl: record.mediaUrl ?? null,
    mediaUrls: record.mediaUrls ?? record.media_urls ?? [],
    thumbnailUrl: record.thumbnailUrl ?? null,
    thumbnailSource: record.thumbnailSource ?? null,
    linkStatus: record.linkStatus ?? null,
    linkCheckedAt: record.linkCheckedAt ?? null,
    linkFailureReason: record.linkFailureReason ?? null,
    metrics: record.metrics ?? {},
    contributionScore: record.contributionScore,
    sourceUrl: record.sourceUrl,
    platformPostId: record.platformPostId ?? null,
    rawVisibleText: record.rawVisibleText,
    first_seen_at: record.first_seen_at,
    last_checked_at: record.last_checked_at,
    last_updated_at: record.last_updated_at,
    why: record.matchReason,
    attachedCompanyId: record.entityType === "company" ? record.entityId : companyIdFromName(record.companyName),
    attachedCompanyName: record.companyName,
    socialAccountId: null,
    accountUrl: rawAuthor.url,
    matchReason: record.matchReason,
    review_state: record.review_state
  });
}

function materializedSocialAccountIds(graph: GraphResponse): Map<string, string> {
  const accountIdByIdentity = new Map<string, string>();

  for (const node of graph.nodes) {
    addMaterializedSocialAccounts(
      accountIdByIdentity,
      node.entityType,
      node.entityId,
      node.socialAccounts
    );
    for (const founder of node.founders) {
      addMaterializedSocialAccounts(accountIdByIdentity, "founder", founder.id, founder.socialAccounts);
    }
  }

  return accountIdByIdentity;
}

function addMaterializedSocialAccounts(
  accountIdByIdentity: Map<string, string>,
  entityType: EvidenceItem["entityType"],
  entityId: string,
  accounts: SocialAccountSummary[]
): void {
  for (const account of accounts) {
    const key = socialAccountIdentityKey(entityType, entityId, account.platform, account.url);
    if (key) {
      accountIdByIdentity.set(key, account.id);
    }
  }
}

function resolveMaterializedSocialAccountId(
  item: EvidenceItem,
  accountIdByIdentity: Map<string, string>
): string | null {
  const key = socialAccountIdentityKey(item.entityType, item.entityId, item.platform, evidenceAccountUrl(item));
  return key ? accountIdByIdentity.get(key) ?? null : null;
}

function evidenceAccountUrl(item: EvidenceItem): string | null {
  if (item.accountUrl) {
    return item.accountUrl;
  }

  return item.platform === "github" || item.platform === "x" || item.platform === "tiktok" || item.platform === "bluesky"
    ? item.sourceUrl
    : null;
}

function socialAccountIdentityKey(
  entityType: EvidenceItem["entityType"],
  entityId: string,
  platform: Platform,
  rawUrl: string | null | undefined
): string | null {
  const canonicalUrl = canonicalSocialAccountUrl(platform, rawUrl);
  return canonicalUrl ? `${entityType}\u0000${entityId}\u0000${platform}\u0000${canonicalUrl}` : null;
}

function canonicalSocialAccountUrl(platform: Platform, rawUrl: string | null | undefined): string | null {
  if (!rawUrl?.trim()) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean).map(decodeUrlPathSegment);

    if (platform === "github" && host === "github.com") {
      const handle = parts[0]?.toLowerCase() === "orgs" ? parts[1] : parts[0];
      return handle ? `https://github.com/${handle.toLowerCase().replace(/\.git$/i, "")}` : null;
    }

    if (platform === "x" && (host === "x.com" || host === "twitter.com")) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? `https://x.com/${handle.toLowerCase()}` : null;
    }

    if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      const markerIndex = parts.findIndex((part) => ["company", "in", "school"].includes(part.toLowerCase()));
      const namespace = markerIndex >= 0 ? parts[markerIndex]?.toLowerCase() : null;
      const handle = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      return namespace && handle ? `https://linkedin.com/${namespace}/${handle.toLowerCase()}` : null;
    }

    if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? `https://instagram.com/${handle.toLowerCase()}` : null;
    }

    if (platform === "tiktok" && (host === "tiktok.com" || host.endsWith(".tiktok.com"))) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? `https://tiktok.com/@${handle.toLowerCase()}` : null;
    }

    if (platform === "bluesky" && host === "bsky.app") {
      const handle = parts[0]?.toLowerCase() === "profile" ? parts[1] : null;
      return handle ? `https://bsky.app/profile/${handle.toLowerCase()}` : null;
    }

    if (platform === "youtube" && host === "youtube.com") {
      if (parts[0]?.startsWith("@")) return `https://youtube.com/@${parts[0].slice(1).toLowerCase()}`;
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      return namespace && handle && ["channel", "c", "user"].includes(namespace)
        ? `https://youtube.com/${namespace}/${handle.toLowerCase()}`
        : null;
    }

    if (platform === "reddit" && (host === "reddit.com" || host.endsWith(".reddit.com"))) {
      const namespace = parts[0]?.toLowerCase();
      const handle = namespace === "r" || namespace === "u" || namespace === "user" ? parts[1] : parts[0];
      const pathNamespace = namespace === "r" || namespace === "u" || namespace === "user" ? namespace : "user";
      return handle ? `https://reddit.com/${pathNamespace}/${handle.toLowerCase()}` : null;
    }

    if (platform === "product_hunt" && host === "producthunt.com") {
      if (parts[0]?.startsWith("@")) return `https://producthunt.com/@${parts[0].slice(1).toLowerCase()}`;
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      return namespace && handle && ["products", "posts"].includes(namespace)
        ? `https://producthunt.com/${namespace}/${handle.toLowerCase()}`
        : null;
    }

    if (platform === "hacker_news" && host === "news.ycombinator.com") {
      const handle = url.searchParams.get("id");
      return handle ? `https://news.ycombinator.com/user?id=${handle.toLowerCase()}` : null;
    }

    if (platform === "bilibili" && host === "space.bilibili.com") {
      return parts[0] ? `https://space.bilibili.com/${parts[0]}` : null;
    }
  } catch {
    return null;
  }

  return null;
}

function decodeUrlPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function liveEvidenceMediaType(record: LiveEvidenceRecord): EvidenceItem["mediaType"] {
  const urls = [
    record.mediaUrl,
    record.thumbnailUrl,
    ...(record.mediaUrls ?? []),
    ...(record.media_urls ?? []),
    ...(record.media_posters ?? [])
  ].filter((url): url is string => Boolean(url));

  if (!urls.length) {
    return "text";
  }
  if (urls.some(isVideoMediaUrl)) {
    return "video";
  }
  if (urls.some(isImageMediaUrl)) {
    return "image";
  }
  return "unknown";
}

function isVideoMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.includes("video.twimg.com") || /\.(mp4|mov|webm|m3u8)$/i.test(url.pathname);
  } catch {
    return /\.(mp4|mov|webm|m3u8)(?:$|\?)/i.test(rawUrl);
  }
}

function isImageMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.includes("pbs.twimg.com") || /\.(jpe?g|png|webp|gif)$/i.test(url.pathname);
  } catch {
    return /\.(jpe?g|png|webp|gif)(?:$|\?)/i.test(rawUrl);
  }
}

export function scoreLiveEvidence(candidate: EvidenceItem, existingEvidence: EvidenceItem[]): EvidenceItem {
  return mergeLiveEvidenceItems(existingEvidence, [candidate]).liveEvidence[0] ?? candidate;
}

type EvidenceCompanyResolver = (item: EvidenceItem) => string | undefined;

interface CanonicalEvidenceCandidate {
  item: EvidenceItem;
  source: "existing" | "live";
  signature: string;
}

interface CanonicalEvidenceGroup {
  key: string;
  existingOrder: number | null;
  candidates: CanonicalEvidenceCandidate[];
}

export function mergeLiveEvidenceItems(
  existingEvidence: EvidenceItem[],
  liveEvidence: EvidenceItem[],
  companyIdForEvidence: EvidenceCompanyResolver = defaultCompanyIdForEvidence
): { evidence: EvidenceItem[]; liveEvidence: EvidenceItem[] } {
  const groups = new Map<string, CanonicalEvidenceGroup>();

  existingEvidence.forEach((item, index) => {
    addCanonicalCandidate(groups, item, "existing", index, companyIdForEvidence);
  });
  liveEvidence.forEach((item) => {
    addCanonicalCandidate(groups, item, "live", null, companyIdForEvidence);
  });

  const orderedGroups = [...groups.values()].sort((left, right) => {
    if (left.existingOrder !== null || right.existingOrder !== null) {
      if (left.existingOrder === null) return 1;
      if (right.existingOrder === null) return -1;
      return left.existingOrder - right.existingOrder;
    }
    return left.key.localeCompare(right.key);
  });
  const mergedEvidence = orderedGroups.map(resolveCanonicalGroup);
  const scoredEvidence = normalizeEvidenceScores(mergedEvidence);
  const visibleLiveEvidence = scoredEvidence.filter((_, index) =>
    orderedGroups[index].candidates.some((candidate) => candidate.source === "live")
  );

  return { evidence: scoredEvidence, liveEvidence: visibleLiveEvidence };
}

export function canonicalLiveEvidenceKey(
  item: EvidenceItem,
  companyIdForEvidence: EvidenceCompanyResolver = defaultCompanyIdForEvidence
): string {
  const companyId = companyIdForEvidence(item) ?? defaultCompanyIdForEvidence(item);
  return `${normalizeIdentityPart(companyId)}:${canonicalPostKey(item)}`;
}

function addCanonicalCandidate(
  groups: Map<string, CanonicalEvidenceGroup>,
  item: EvidenceItem,
  source: CanonicalEvidenceCandidate["source"],
  existingOrder: number | null,
  companyIdForEvidence: EvidenceCompanyResolver
): void {
  const key = canonicalLiveEvidenceKey(item, companyIdForEvidence);
  const group = groups.get(key) ?? { key, existingOrder, candidates: [] };
  if (existingOrder !== null) {
    group.existingOrder = group.existingOrder === null ? existingOrder : Math.min(group.existingOrder, existingOrder);
  }
  group.candidates.push({ item, source, signature: stableSerialize(item) });
  groups.set(key, group);
}

function resolveCanonicalGroup(group: CanonicalEvidenceGroup): EvidenceItem {
  const winner = group.candidates.reduce((best, candidate) =>
    compareCanonicalCandidates(candidate, best) > 0 ? candidate : best
  );
  const existingId = group.candidates
    .filter((candidate) => candidate.source === "existing")
    .map((candidate) => candidate.item.id)
    .sort()[0];
  const firstSeen = earliestTimestamp(group.candidates.map((candidate) => candidate.item.first_seen_at));

  return {
    ...winner.item,
    id: existingId ?? winner.item.id,
    contributionScore: winner.item.contributionScore,
    ...(firstSeen ? { first_seen_at: firstSeen } : {})
  };
}

function compareCanonicalCandidates(left: CanonicalEvidenceCandidate, right: CanonicalEvidenceCandidate): number {
  const freshness = compareEvidenceFreshness(left.item, right.item);
  if (freshness !== 0) {
    return freshness;
  }
  if (left.source !== right.source) {
    return left.source === "live" ? 1 : -1;
  }
  return left.signature.localeCompare(right.signature);
}

function compareEvidenceFreshness(left: EvidenceItem, right: EvidenceItem): number {
  const leftFreshness = evidenceFreshness(left);
  const rightFreshness = evidenceFreshness(right);
  return leftFreshness.tier - rightFreshness.tier || leftFreshness.timestamp - rightFreshness.timestamp;
}

function evidenceFreshness(item: EvidenceItem): { tier: number; timestamp: number } {
  const observedAt = latestTimestamp([
    item.metricsCheckedAt,
    item.observedAt,
    item.last_checked_at,
    item.linkCheckedAt,
    item.last_updated_at,
    item.first_seen_at
  ]);
  if (observedAt !== null) {
    return { tier: 2, timestamp: observedAt };
  }

  const postedAt = parseTimestamp(item.postedAt);
  return postedAt === null ? { tier: 0, timestamp: 0 } : { tier: 1, timestamp: postedAt };
}

function rebuildGraphScoreSurfaces(
  graph: GraphResponse,
  evidence: EvidenceItem[],
  companyIdByEntityId: Map<string, string>,
  liveEvidence: EvidenceItem[],
  selectedPlatforms: Platform[],
  calibrationCohort?: CompanyRecord[]
): GraphResponse {
  const evidenceByCompanyId = new Map<string, EvidenceItem[]>();
  for (const item of evidence) {
    const companyId = companyIdForEntity(companyIdByEntityId, item.entityId) ?? item.attachedCompanyId;
    if (companyId) {
      evidenceByCompanyId.set(companyId, [...(evidenceByCompanyId.get(companyId) ?? []), item]);
    }
  }

  const absoluteCompanies = graph.nodes
    .filter((node) => node.entityType === "company")
    .map((node) => {
      const companyEvidence = evidenceByCompanyId.get(node.entityId) ?? [];
      const scoreBreakdown = aggregateBalancedTractionScore(dedupeEvidenceForScoring(companyEvidence));
      return companyRecordForCalibration(node, scoreBreakdown);
    });
  const publishedBenchmark = publishedGlobalCalibration(graph);
  const scoreScope = overlayScoreScope(graph, selectedPlatforms);
  const scoredCompanies = scoreScope === "all_platforms" && calibrationCohort
    ? benchmarkGlobalCompanyScores(absoluteCompanies, calibrationCohort)
    : publishedBenchmark
      ? benchmarkCompanyScoresWithPublishedGlobalFactor(
          absoluteCompanies,
          publishedBenchmark
        )
      : calibrationCohort
        ? benchmarkGlobalCompanyScores(absoluteCompanies, calibrationCohort)
        : calibrateBatchCompanyScores(absoluteCompanies, absoluteCompanies);
  const scoredCompanyById = new Map(scoredCompanies.map((company) => [company.id, company]));

  const scoredNodes = graph.nodes.map((node) => {
    if (node.entityType !== "company") {
      return node;
    }

    const companyEvidence = evidenceByCompanyId.get(node.entityId) ?? [];
    const scoredCompany = scoredCompanyById.get(node.entityId);
    if (!scoredCompany?.scoreBreakdown) {
      return node;
    }
    const score = scoredCompany.totalScore;
    const scoreBreakdown = scoredCompany.scoreBreakdown;
    const founders = node.founders.map((founder) => {
      const founderEvidence = companyEvidence.filter(
        (item) => item.entityType === "founder" && item.entityId === founder.id
      );
      return {
        ...founder,
        evidenceIds: founderEvidence.map((item) => item.id),
        platformScores: aggregateBalancedTractionScore(dedupeEvidenceForScoring(founderEvidence)).platformScores
      };
    });

    return {
      ...node,
      score,
      previousScore: node.score,
      scoreDelta: Math.round(score - node.score),
      topPlatform: scoreBreakdown.weightedPlatforms[0]?.platform ?? topPlatformFor(scoreBreakdown.platformScores),
      platformScores: scoreBreakdown.platformScores,
      scoreBreakdown,
      evidenceIds: companyEvidence.map((item) => item.id),
      founders
    };
  });
  const peerScores = scoredNodes
    .filter((node) => node.entityType === "company")
    .map((node) => node.score);
  const nodes = scoredNodes.map((node) =>
    node.entityType === "company"
      ? { ...node, radius: getNodeRadius(node.score, peerScores, "company") }
      : node
  );
  const nodeByCompanyId = new Map(
    nodes
      .filter((node) => node.entityType === "company")
      .map((node) => [node.entityId, node] as const)
  );
  const leaderboardOrder = new Map(graph.leaderboard.map((row, index) => [row.companyId, index]));
  const sortedLeaderboard = graph.leaderboard
    .map((row) => {
      const node = nodeByCompanyId.get(row.companyId);
      if (!node) {
        return row;
      }
      const biggestContribution = (evidenceByCompanyId.get(row.companyId) ?? [])
        .filter((item) => item.contributionScore > 0)
        .sort(compareEvidence)[0] ?? null;
      return {
        ...row,
        score: node.score,
        topPlatform: node.topPlatform,
        biggestContribution
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (leaderboardOrder.get(left.companyId) ?? Number.MAX_SAFE_INTEGER) -
          (leaderboardOrder.get(right.companyId) ?? Number.MAX_SAFE_INTEGER) ||
        left.companyId.localeCompare(right.companyId)
    );
  let tiedRank = 0;
  let previousScore: number | null = null;
  const leaderboard = sortedLeaderboard.map((row, index) => {
    if (previousScore === null || row.score !== previousScore) {
      tiedRank = index + 1;
    }
    previousScore = row.score;
    return { ...row, rank: tiedRank };
  });
  const generatedAt = overlayGeneratedAt(graph.generatedAt, liveEvidence);
  const fastestGaining = rebuildFastestGaining(graph.fastestGaining, leaderboard);

  return {
    ...graph,
    evidence,
    nodes,
    leaderboard,
    fastestGaining,
    generatedAt,
    scoringContext: overlayScoringContext({
      graph,
      nodes,
      evidence,
      selectedPlatforms,
      responseBuiltAt: generatedAt
    })
  };
}

function companyRecordForCalibration(
  node: GraphNode,
  scoreBreakdown: ReturnType<typeof aggregateBalancedTractionScore>
): CompanyRecord {
  return {
    id: node.entityId,
    batchSlug: node.batchSlug,
    name: node.label,
    ycProfileUrl: node.ycProfileUrl,
    websiteUrl: node.websiteUrl ?? "",
    tagline: node.tagline ?? "",
    description: node.description ?? "",
    groupPartner: node.groupPartner,
    primaryIndustry: node.primaryIndustry,
    businessModel: node.businessModel,
    review_state: node.review_state,
    sourceUrl: node.sourceUrl,
    industries: node.industries,
    founderIds: node.relatedEntityIds,
    socialAccounts: node.socialAccounts,
    totalScore: scoreBreakdown.totalScore,
    previousScore: node.score,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown,
    topVoiceScore: node.topVoiceScore,
    topVoiceConnectionCount: node.topVoiceConnectionCount,
    topVoiceConnections: node.topVoiceConnections,
    selectedTopVoiceAudience: node.selectedTopVoiceAudience
  };
}

function publishedGlobalCalibration(graph: GraphResponse): ScoreCalibration | null {
  const calibrations = graph.nodes
    .map((node) => node.scoreBreakdown?.calibration)
    .filter((calibration): calibration is ScoreCalibration =>
      calibration?.method === "global_best_ratio"
    );
  if (calibrations.length === 0) return null;

  const benchmarkSignatures = new Set(calibrations.map((calibration) => JSON.stringify({
    method: calibration.method,
    cohortSize: calibration.cohortSize,
    percentile: calibration.percentile,
    benchmarkScore: calibration.benchmarkScore,
    scaleFactor: calibration.scaleFactor,
    benchmarkScope: calibration.benchmarkScope,
    benchmarkPopulation: calibration.benchmarkPopulation
  })));
  if (benchmarkSignatures.size !== 1) {
    throw new Error("Graph nodes disagree on the published global company benchmark.");
  }
  return calibrations[0] ?? null;
}

function rebuildFastestGaining(
  previousRows: GraphResponse["fastestGaining"],
  leaderboard: GraphResponse["leaderboard"]
): GraphResponse["fastestGaining"] {
  const previousByCompanyId = new Map(previousRows.map((row) => [row.companyId, row]));
  const compareMomentum = momentumSort("dod");

  return leaderboard
    .map((row) => {
      const previous = previousByCompanyId.get(row.companyId);
      return {
        rank: 0,
        companyId: row.companyId,
        companyName: row.companyName,
        dod: recomputeMomentum(previous?.dod, row.score, row.rank),
        wow: recomputeMomentum(previous?.wow, row.score, row.rank)
      };
    })
    .sort((left, right) => compareMomentum(left, right) || left.companyId.localeCompare(right.companyId))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function recomputeMomentum(
  previous: GraphResponse["fastestGaining"][number]["dod"] | undefined,
  currentScore: number,
  currentRank: number
): GraphResponse["fastestGaining"][number]["dod"] {
  const baselineScore = previous?.baselineScore ?? null;
  const baselineRank = previous?.baselineRank ?? null;
  const scoreDelta = baselineScore === null ? 0 : round(currentScore - baselineScore, 1);

  return {
    scoreDelta,
    percentDelta: baselineScore === null
      ? 0
      : round((scoreDelta / Math.max(baselineScore, 1)) * 100, 1),
    rankDelta: baselineRank === null ? 0 : baselineRank - currentRank,
    currentScore,
    currentRank,
    baselineScore,
    baselineRank,
    benchmarkedAt: previous?.benchmarkedAt ?? null
  };
}

function overlayScoringContext(input: {
  graph: GraphResponse;
  nodes: GraphResponse["nodes"];
  evidence: EvidenceItem[];
  selectedPlatforms: Platform[];
  responseBuiltAt: string;
}): NonNullable<GraphResponse["scoringContext"]> {
  return {
    modelId: TRACTION_SCORING_CONFIG.modelId,
    modelVersion: TRACTION_SCORING_CONFIG.version,
    modelName: TRACTION_SCORING_CONFIG.name,
    scoreScope: overlayScoreScope(input.graph, input.selectedPlatforms),
    selectedPlatforms: [...input.selectedPlatforms],
    responseBuiltAt: input.responseBuiltAt,
    evidenceAsOf: latestScoringEvidenceAsOf(input.nodes, input.evidence)
  };
}

function overlayScoreScope(
  graph: GraphResponse,
  selectedPlatforms: Platform[]
): NonNullable<GraphResponse["scoringContext"]>["scoreScope"] {
  if (
    graph.selectedTopVoiceAudience.id !== "off" ||
    graph.scoringContext?.scoreScope === "top_voice"
  ) {
    return "top_voice";
  }
  if (
    selectedPlatforms.length > 0 ||
    graph.scoringContext?.scoreScope === "selected_platforms"
  ) {
    return "selected_platforms";
  }
  return "all_platforms";
}

function latestScoringEvidenceAsOf(
  nodes: GraphResponse["nodes"],
  evidence: EvidenceItem[]
): string | null {
  const timestamps = [
    ...nodes.map((node) => node.scoreBreakdown?.evidenceAsOf),
    ...evidence
      .filter(
        (item) =>
          item.contributionScore > 0 &&
          (TRACTION_SCORING_CONFIG.platformWeights[item.platform] ?? 0) > 0
      )
      .flatMap((item) => [
        item.metricsCheckedAt,
        item.last_checked_at,
        item.last_updated_at,
        item.observedAt,
        item.first_seen_at
      ])
  ];
  const latestTime = Math.max(
    0,
    ...timestamps.map((value) => {
      const time = value ? Date.parse(value) : Number.NaN;
      return Number.isFinite(time) ? time : 0;
    })
  );

  return latestTime > 0 ? new Date(latestTime).toISOString() : null;
}

function replayedLiveEvidence(
  existingEvidence: EvidenceItem[],
  liveEvidence: EvidenceItem[],
  companyIdForEvidence: EvidenceCompanyResolver
): EvidenceItem[] | null {
  const existingByCanonicalKey = new Map<string, EvidenceItem[]>();
  for (const item of existingEvidence) {
    const key = canonicalLiveEvidenceKey(item, companyIdForEvidence);
    existingByCanonicalKey.set(key, [...(existingByCanonicalKey.get(key) ?? []), item]);
  }

  const replayedByCanonicalKey = new Map<string, EvidenceItem>();
  for (const candidate of liveEvidence) {
    const key = canonicalLiveEvidenceKey(candidate, companyIdForEvidence);
    const signature = replayObservationSignature(candidate);
    const existing = existingByCanonicalKey.get(key)?.find(
      (item) => replayObservationSignature(item) === signature
    );
    if (!existing) {
      return null;
    }
    replayedByCanonicalKey.set(key, existing);
  }

  return [...replayedByCanonicalKey.values()].sort(compareEvidence);
}

/**
 * Identifies an already-applied native observation without allowing a sparse
 * replay payload to replace richer canonical presentation metadata.
 *
 * Metadata corrections still apply when they arrive with a newer observation
 * timestamp. Exact same-freshness metric replays are idempotent.
 */
function replayObservationSignature(item: EvidenceItem): string {
  return stableSerialize({
    entityType: item.entityType,
    entityId: item.entityId,
    platform: item.platform,
    postedAt: item.postedAt,
    publishedAtPrecision: item.publishedAtPrecision === "unknown" ? "unknown" : "known",
    observedAt: item.observedAt ?? null,
    metricsCheckedAt: item.metricsCheckedAt ?? null,
    metrics: item.metrics,
    firstSeenAt: item.first_seen_at ?? null,
    lastCheckedAt: item.last_checked_at ?? null,
    lastUpdatedAt: item.last_updated_at ?? null,
    reviewState: item.review_state ?? "verified",
    scoreEnabled: item.contributionScore > 0
  });
}

function companyOwnershipMap(graph: GraphResponse): Map<string, string> {
  const companyIdByEntityId = new Map<string, string>();
  for (const node of graph.nodes.filter((candidate) => candidate.entityType === "company")) {
    companyIdByEntityId.set(node.entityId, node.entityId);
    for (const founder of node.founders) {
      companyIdByEntityId.set(founder.id, node.entityId);
      companyIdByEntityId.set(founder.id.replace(/^founder:/, ""), node.entityId);
    }
  }
  return companyIdByEntityId;
}

function companyIdForEntity(companyIdByEntityId: Map<string, string>, entityId: string): string | undefined {
  return companyIdByEntityId.get(entityId) ?? companyIdByEntityId.get(entityId.replace(/^founder:/, ""));
}

function defaultCompanyIdForEvidence(item: EvidenceItem): string {
  return item.attachedCompanyId ?? item.entityId;
}

function compareEvidence(left: EvidenceItem, right: EvidenceItem): number {
  return (
    right.contributionScore - left.contributionScore ||
    canonicalPostKey(left).localeCompare(canonicalPostKey(right)) ||
    left.entityId.localeCompare(right.entityId) ||
    left.id.localeCompare(right.id)
  );
}

function compareHiddenEvidence(
  left: LiveEvidenceOverlayResult["hiddenEvidence"][number],
  right: LiveEvidenceOverlayResult["hiddenEvidence"][number]
): number {
  return (
    left.sourceUrl.localeCompare(right.sourceUrl) ||
    left.companyName.localeCompare(right.companyName) ||
    left.platform.localeCompare(right.platform) ||
    left.reason.localeCompare(right.reason)
  );
}

function overlayGeneratedAt(currentGeneratedAt: string, liveEvidence: EvidenceItem[]): string {
  const current = parseTimestamp(currentGeneratedAt) ?? 0;
  const latestLive = liveEvidence.reduce((latest, item) => {
    const freshness = evidenceFreshness(item);
    return Math.max(latest, freshness.timestamp);
  }, 0);
  const generatedAt = Math.max(current, latestLive);
  return generatedAt > 0 ? new Date(generatedAt).toISOString() : currentGeneratedAt;
}

function latestTimestamp(values: Array<string | null | undefined>): number | null {
  const timestamps = values
    .map(parseTimestamp)
    .filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function earliestTimestamp(values: Array<string | null | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value) && parseTimestamp(value) !== null)
    .sort((left, right) => (parseTimestamp(left) ?? 0) - (parseTimestamp(right) ?? 0) || left.localeCompare(right))[0];
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase();
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hidden(record: LiveEvidenceRecord, reason: string): LiveEvidenceOverlayResult["hiddenEvidence"][number] {
  return {
    sourceUrl: record.sourceUrl,
    companyName: record.companyName,
    platform: record.platform,
    reason
  };
}

function readRawAuthor(rawVisibleText: string): { handle: string | null; name: string | null; url: string | null } {
  try {
    const parsed = JSON.parse(rawVisibleText) as {
      post?: { author?: { screen_name?: string; name?: string; url?: string } };
    };
    return {
      handle: normalizeHandle(parsed.post?.author?.screen_name),
      name: parsed.post?.author?.name ?? null,
      url: parsed.post?.author?.url ?? null
    };
  } catch {
    return { handle: null, name: null, url: null };
  }
}

function topPlatformFor(platformScores: Partial<Record<Platform, number>>): Platform | null {
  const entries = Object.entries(platformScores) as [Platform, number][];
  return entries.length
    ? entries.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]
    : null;
}

function companyIdFromName(companyName: string): string {
  return `company-${companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function normalizeHandle(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}
