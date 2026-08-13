import { POST_TOPIC_SLUGS } from "./post-topics";
import { PLATFORM_VALUES } from "./types";
import type { GraphResponse, TopicFacetRow, TopVoiceAudienceId } from "./types";

export const TOPIC_FACET_SNAPSHOT_VERSION = "2026-08-09-full-corpus-topics" as const;

export interface TopicFacetSnapshot {
  version: typeof TOPIC_FACET_SNAPSHOT_VERSION;
  batchSlug: string;
  rowCount?: number;
  rows: TopicFacetRow[];
}

export function topicFacetSnapshotUrl(batchSlug: string): string | null {
  const filename = {
    S2026: "s2026",
    S26: "s26",
    A16ZSR006: "a16zsr006"
  }[batchSlug];
  return filename
    ? `/topic-facets/${filename}.json?v=${TOPIC_FACET_SNAPSHOT_VERSION}`
    : null;
}

export function topicFacetRowsForAudience(
  snapshot: TopicFacetSnapshot,
  audienceId: TopVoiceAudienceId
): TopicFacetRow[] {
  return snapshot.rows.filter((row) => row.audienceId === audienceId);
}

export function isTopicFacetSnapshot(value: unknown): value is TopicFacetSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<TopicFacetSnapshot>;
  return snapshot.version === TOPIC_FACET_SNAPSHOT_VERSION &&
    typeof snapshot.batchSlug === "string" &&
    Array.isArray(snapshot.rows) &&
    snapshot.rows.every(isTopicFacetRow);
}

export function withTopicFacetRows(
  graph: GraphResponse,
  rows: TopicFacetRow[]
): GraphResponse {
  return { ...graph, topicFacetRows: rows };
}

function isTopicFacetRow(value: unknown): value is TopicFacetRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TopicFacetRow>;
  return typeof row.topic === "string" && POST_TOPIC_SLUGS.includes(row.topic as typeof POST_TOPIC_SLUGS[number]) &&
    typeof row.postKey === "string" && row.postKey.length > 0 &&
    typeof row.platform === "string" && PLATFORM_VALUES.includes(row.platform as typeof PLATFORM_VALUES[number]) &&
    typeof row.companyId === "string" && row.companyId.length > 0 &&
    typeof row.contributionScore === "number" && Number.isFinite(row.contributionScore) &&
    (row.audienceId === "off" || row.audienceId === "yc_partners" || row.audienceId === "insiders");
}
