import { canonicalEvidenceUrl, canonicalPostKey, dedupeEvidenceForScoring } from "./dedupe";
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

export type RankedPostsPeriod = "today" | "month" | "all_time";
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
  /** Explicit facet scope for non-dashboard callers. The dashboard's filtered
   * graph is detected conservatively from its published-preview coverage. */
  platforms?: readonly Platform[];
  topics?: readonly PostTopic[];
  /** Test and offline override; production callers use the generated sidecar. */
  sidecarScope?: RankedPostsSidecarScope | null;
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
  const eligibleEvidence = rankableEvidence([...graph.evidence, ...sidecarEvidence])
    .filter((evidence) => selectedPlatforms.size === 0 || selectedPlatforms.has(evidence.platform))
    .filter((evidence) =>
      selectedTopics.size === 0 || (evidence.topics ?? []).some((topic) => selectedTopics.has(topic))
    );
  const candidates: RankedPostCandidate[] = [];

  for (const evidence of eligibleEvidence) {
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

  const rankedCandidates = candidates
    .sort(compareRankedPostCandidates)
    .slice(0, limit);
  let tiedRank = 0;
  let previousScore: number | null = null;

  return rankedCandidates.map((candidate, index) => {
    const score = rankedPostScore(candidate.evidence);
    if (previousScore === null || score !== previousScore) {
      tiedRank = index + 1;
    }
    previousScore = score;
    return { ...candidate, rank: tiedRank };
  });
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
