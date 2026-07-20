import { canonicalEvidenceUrl, canonicalPostKey, dedupeEvidenceForScoring } from "./dedupe";
import { scoringEligibility } from "./traction-scoring";
import type { EvidenceItem, GraphNode, GraphResponse } from "./types";
import { isCurrentCentralDay } from "../time/central-day";

export const RANKED_POSTS_LIMIT = 50;

export type RankedPostsPeriod = "today" | "all_time";
export type RankedPostSourceKind = "company" | "founder" | "top_voice";

export interface RankedPost {
  rank: number;
  evidence: EvidenceItem;
  companyId: string;
  companyName: string;
  sourceKind: RankedPostSourceKind;
  canonicalPostKey: string;
}

export interface SelectRankedPostsOptions {
  period: RankedPostsPeriod;
  now?: Date;
  limit?: number;
}

type RankedPostCandidate = Omit<RankedPost, "rank">;

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
  const eligibleEvidence = dedupeEvidenceForScoring(
    graph.evidence.filter(
      (evidence) =>
        evidence.contributionScore > 0 &&
        evidence.tractionStatus !== "unscored" &&
        scoringEligibility(evidence).eligible
    )
  );
  const candidates: RankedPostCandidate[] = [];

  for (const evidence of eligibleEvidence) {

    const publishedAt = publicationTimestamp(evidence.postedAt);
    if (
      options.period === "today" &&
      (evidence.publishedAtPrecision === "unknown" ||
        publishedAt === null ||
        !isCurrentCentralDay(new Date(publishedAt), now))
    ) {
      continue;
    }

    const companyId = evidenceCompanyId(evidence, companiesById, companyByFounderId);
    if (!companyId) continue;
    const company = companiesById.get(companyId);
    if (!company) continue;

    const physicalPostKey = canonicalPostKey(evidence);
    const candidate: RankedPostCandidate = {
      evidence,
      companyId,
      companyName: company.label,
      sourceKind: evidence.topVoice
        ? "top_voice"
        : evidence.entityType === "founder"
          ? "founder"
          : "company",
      canonicalPostKey: physicalPostKey
    };
    candidates.push(candidate);
  }

  return candidates
    .sort(compareRankedPostCandidates)
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function compareRankedPostEvidence(left: EvidenceItem, right: EvidenceItem): number {
  return (
    rankedPostScore(right) - rankedPostScore(left) ||
    finiteNumber(right.rawEngagement) - finiteNumber(left.rawEngagement) ||
    publicationSortValue(right.postedAt) - publicationSortValue(left.postedAt) ||
    canonicalEvidenceUrl(left.sourceUrl).localeCompare(canonicalEvidenceUrl(right.sourceUrl)) ||
    left.id.localeCompare(right.id)
  );
}

function compareRankedPostCandidates(left: RankedPostCandidate, right: RankedPostCandidate): number {
  return (
    compareRankedPostEvidence(left.evidence, right.evidence) ||
    left.companyId.localeCompare(right.companyId) ||
    left.sourceKind.localeCompare(right.sourceKind)
  );
}

function rankedPostScore(item: EvidenceItem): number {
  return Number.isFinite(item.normalizedScore)
    ? Number(item.normalizedScore)
    : finiteNumber(item.contributionScore);
}

function finiteNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function publicationTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function publicationSortValue(value: string | null | undefined): number {
  return publicationTimestamp(value) ?? Number.NEGATIVE_INFINITY;
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

function isCompanyNode(node: GraphNode): boolean {
  return node.entityType === "company";
}
