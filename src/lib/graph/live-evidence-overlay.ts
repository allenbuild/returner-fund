import { enrichEvidenceThumbnail } from "./evidence-thumbnails";
import { normalizeEvidenceScores } from "./traction-scoring";
import type { EvidenceItem, GraphResponse, Platform, TopVoiceAudienceId } from "./types";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

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
}

export function overlayLiveEvidenceOnGraph(
  graph: GraphResponse,
  records: LiveEvidenceRecord[],
  options: LiveEvidenceOverlayOptions = {}
): LiveEvidenceOverlayResult {
  if (!records.length) {
    return { graph, visibleEvidence: [], hiddenEvidence: [] };
  }

  const selectedPlatforms = options.selectedPlatforms ?? [];
  const topVoiceAudience = options.topVoices ?? graph.selectedTopVoiceAudience.id;
  const hiddenEvidence: LiveEvidenceOverlayResult["hiddenEvidence"] = [];
  const visibleEvidence: EvidenceItem[] = [];
  let nextGraph = graph;

  for (const record of records) {
    if (topVoiceAudience !== "off") {
      hiddenEvidence.push(hidden(record, `hidden_by_top_voice_filter:${topVoiceAudience}`));
      continue;
    }
    if (selectedPlatforms.length && !selectedPlatforms.includes(record.platform)) {
      hiddenEvidence.push(hidden(record, "hidden_by_platform_filter"));
      continue;
    }

    const node = nextGraph.nodes.find((candidate) => candidate.entityId === record.entityId || candidate.entityId === record.entityId.replace(/^founder:/, ""));
    const companyNode =
      record.entityType === "company"
        ? nextGraph.nodes.find((candidate) => candidate.entityType === "company" && candidate.entityId === record.entityId)
        : nextGraph.nodes.find(
            (candidate) =>
              candidate.entityType === "company" &&
              candidate.founders.some((founder) => founder.id === record.entityId)
          );
    if (!node && !companyNode) {
      hiddenEvidence.push(hidden(record, `hidden_by_batch:${graph.batch.slug}`));
      continue;
    }

    const evidence = scoreLiveEvidence(liveEvidenceRecordToEvidenceItem(record), nextGraph.evidence);
    nextGraph = attachEvidence(nextGraph, evidence);
    visibleEvidence.push(evidence);
  }

  return {
    graph: nextGraph,
    visibleEvidence,
    hiddenEvidence
  };
}

export function liveEvidenceRecordToEvidenceItem(record: LiveEvidenceRecord): EvidenceItem {
  const rawAuthor = readRawAuthor(record.rawVisibleText);
  const socialAccountId = `${record.platform}:${record.entityType}:${record.entityId}`;

  return enrichEvidenceThumbnail({
    id: record.id,
    entityType: record.entityType,
    entityId: record.entityId,
    platform: record.platform,
    authorName: rawAuthor.name ?? record.companyName,
    authorHandle: rawAuthor.handle,
    postedAt: record.postedAt ?? record.last_updated_at,
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
    socialAccountId,
    accountUrl: rawAuthor.url ?? record.sourceUrl,
    matchReason: record.matchReason,
    review_state: record.review_state
  });
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
  const existingComparableEvidence = existingEvidence.filter((item) => item.id !== candidate.id && !samePost(item, candidate));
  const scoredPlatformRows = normalizeEvidenceScores([
    ...existingComparableEvidence.filter((item) => item.platform === candidate.platform),
    {
      ...candidate,
      contributionScore: Math.max(candidate.contributionScore, 1)
    }
  ]);
  return scoredPlatformRows.find((item) => item.id === candidate.id) ?? candidate;
}

function attachEvidence(graph: GraphResponse, evidence: EvidenceItem): GraphResponse {
  const existingMatches = graph.evidence.filter((item) => item.id === evidence.id || samePost(item, evidence));
  const graphEvidence = mergeSamePostEvidence(existingMatches, evidence);
  const evidenceList = [
    ...graph.evidence.filter((item) => !(item.id === evidence.id || samePost(item, evidence))),
    graphEvidence
  ].sort((left, right) => right.contributionScore - left.contributionScore);
  const nodes = graph.nodes.map((node) => {
    const isCompanyMatch =
      graphEvidence.entityType === "company" && node.entityType === "company" && node.entityId === graphEvidence.entityId;
    const founderIndex = node.founders.findIndex((founder) => founder.id === graphEvidence.entityId);
    if (!isCompanyMatch && founderIndex === -1) {
      return node;
    }
    const platformScore = Math.max(node.platformScores[graphEvidence.platform] ?? 0, graphEvidence.contributionScore);
    const platformScores = {
      ...node.platformScores,
      [graphEvidence.platform]: Math.round(platformScore)
    };
    const topPlatform = topPlatformFor(platformScores);
    const score = Math.max(node.score, Math.round(graphEvidence.contributionScore * 0.85));
    const evidenceIds = [...new Set([...node.evidenceIds, graphEvidence.id])];
    const founders = node.founders.map((founder, index) =>
      index === founderIndex
        ? {
            ...founder,
            evidenceIds: [...new Set([...founder.evidenceIds, graphEvidence.id])],
            platformScores: {
              ...founder.platformScores,
              [graphEvidence.platform]: Math.max(
                founder.platformScores[graphEvidence.platform] ?? 0,
                graphEvidence.contributionScore
              )
            }
          }
        : founder
    );

    return {
      ...node,
      score,
      scoreDelta: Math.round(score - node.previousScore),
      topPlatform,
      platformScores,
      evidenceIds,
      founders
    };
  });

  const leaderboard = graph.leaderboard
    .map((row) => {
      const node = nodes.find((candidate) => candidate.entityType === "company" && candidate.entityId === row.companyId);
      const belongsToRow =
        row.companyId === graphEvidence.attachedCompanyId ||
        node?.founders.some((founder) => founder.id === graphEvidence.entityId);
      if (!belongsToRow || !node) {
        return row;
      }
      const biggestContribution =
        !row.biggestContribution ||
        samePost(row.biggestContribution, graphEvidence) ||
        graphEvidence.contributionScore > row.biggestContribution.contributionScore
          ? graphEvidence
          : row.biggestContribution;
      return {
        ...row,
        score: node.score,
        topPlatform: node.topPlatform,
        biggestContribution
      };
    })
    .sort((left, right) => right.score - left.score || left.companyName.localeCompare(right.companyName))
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    ...graph,
    evidence: evidenceList,
    nodes,
    leaderboard,
    generatedAt: new Date().toISOString()
  };
}

function samePost(left: EvidenceItem, right: EvidenceItem): boolean {
  return Boolean(
    left.platform === right.platform &&
      left.platformPostId &&
      right.platformPostId &&
      left.platformPostId === right.platformPostId &&
      (left.entityId === right.entityId || left.attachedCompanyId === right.attachedCompanyId)
  );
}

function mergeSamePostEvidence(existingMatches: EvidenceItem[], evidence: EvidenceItem): EvidenceItem {
  if (!existingMatches.length) {
    return evidence;
  }
  const freshestExisting = [...existingMatches].sort((left, right) => evidenceFreshness(right) - evidenceFreshness(left))[0];
  const freshest = evidenceFreshness(evidence) >= evidenceFreshness(freshestExisting) ? evidence : freshestExisting;
  const preservedId = freshestExisting.id;
  const firstSeen = freshestExisting.first_seen_at ?? evidence.first_seen_at;
  return {
    ...freshestExisting,
    ...freshest,
    id: preservedId,
    first_seen_at: firstSeen
  };
}

function evidenceFreshness(item: EvidenceItem): number {
  return Math.max(
    Date.parse(item.last_checked_at ?? ""),
    Date.parse(item.linkCheckedAt ?? ""),
    Date.parse(item.last_updated_at ?? ""),
    Date.parse(item.postedAt ?? ""),
    Date.parse(item.first_seen_at ?? ""),
    0
  );
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
  return entries.length ? entries.sort((left, right) => right[1] - left[1])[0][0] : null;
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
