import generatedSnapshot from "./ranked-posts-sidecar.generated.json";
import type { EvidenceItem, TopVoiceAudienceId } from "./types";

export const RANKED_POSTS_SIDECAR_VERSION = "ranked-posts-full-corpus-v1" as const;

export interface RankedPostsSidecarScope {
  previewGeneratedAt: string;
  sourceEvidenceCount: number;
  previewEvidenceCount: number;
  fullRankableCount: number;
  previewRankableCount: number;
  overflowRankableCount: number;
  fullRankableDigest: string;
  representedRankableDigest: string;
  previewRankableByCompany: Record<string, number>;
  fullRankableByCompany: Record<string, number>;
  evidence: EvidenceItem[];
}

export interface RankedPostsSidecarSnapshot {
  version: typeof RANKED_POSTS_SIDECAR_VERSION;
  generatedAt: string;
  batches: Record<string, Partial<Record<TopVoiceAudienceId, RankedPostsSidecarScope>>>;
}

export const rankedPostsSidecarSnapshot = generatedSnapshot as unknown as RankedPostsSidecarSnapshot;

export function rankedPostsSidecarScope(
  batchSlug: string,
  audienceId: TopVoiceAudienceId,
  snapshot: RankedPostsSidecarSnapshot = rankedPostsSidecarSnapshot
): RankedPostsSidecarScope | null {
  if (snapshot.version !== RANKED_POSTS_SIDECAR_VERSION) return null;
  return snapshot.batches[batchSlug]?.[audienceId] ?? null;
}
