import { evidenceDisplayText } from "@/lib/graph/evidence-display";
import {
  isPublishedGraphBatchSlug,
  loadPublishedGraphSnapshot,
  type PublishedGraphBatchSlug,
} from "@/lib/graph/published-graph-snapshot";
import { selectRankedPosts } from "@/lib/graph/ranked-posts";
import {
  rankedPostsSidecarScope,
  type RankedPostsSidecarScope,
} from "@/lib/graph/ranked-posts-sidecar";
import type { GraphNode, GraphResponse } from "@/lib/graph/types";
import { percentileRank } from "@/lib/scoring/percentiles";
import { siteUrl, slugify } from "@/lib/seo/site";

export const RETURNER_FUND_COMPANY_SCHEMA_VERSION = "returner-fund-company-v1" as const;
export const RETURNER_FUND_POST_LIMIT_DEFAULT = 5;
export const RETURNER_FUND_POST_LIMIT_MAX = 20;

export interface ReturnerFundCompanyResponse {
  schemaVersion: typeof RETURNER_FUND_COMPANY_SCHEMA_VERSION;
  company: {
    id: string;
    slug: string;
    name: string;
    batchSlug: string;
    batchLabel: string;
    ycProfileUrl: string;
    websiteUrl: string | null;
    returnerFundUrl: string;
  };
  returnerFund: {
    score: number;
    scale: { min: 0; max: 100 };
    absoluteScore: number | null;
    topPlatform: string | null;
    platformScores: GraphNode["platformScores"];
    cohort: {
      rank: number;
      size: number;
      derivedPercentile: number;
      percentileMethod: "tie_aware_midrank_all_published_companies";
    };
    model: {
      id: string | null;
      version: string | null;
      name: string | null;
    };
    confidence: {
      level: string;
      value: number;
      scoredEvidenceCount: number;
    } | null;
    explanation: string | null;
    evidenceAsOf: string | null;
    generatedAt: string;
  };
  postsReturned: number;
  totalEligiblePosts: number;
  postsTruncated: boolean;
  postsComplete: true;
  bestPosts: Array<{
    rank: number;
    id: string;
    canonicalPostKey: string;
    platform: string;
    sourceKind: "company" | "founder" | "top_voice";
    title: string;
    excerpt: string;
    url: string;
    authorName: string;
    authorHandle: string | null;
    publishedAt: string;
    score: number;
    metrics: Record<string, number | undefined>;
    topics: string[];
  }>;
}

export type ReturnerFundCompanyLookupResult =
  | { status: "found"; response: ReturnerFundCompanyResponse }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: Array<{ id: string; slug: string; name: string }> }
  | { status: "unavailable"; reason: "ranked_posts_out_of_sync" };

interface ReturnerFundCompanyDependencies {
  loadGraph: (input: {
    batchSlug: PublishedGraphBatchSlug;
    audienceId: "off";
  }) => Promise<GraphResponse>;
  loadSidecarScope: (graph: GraphResponse) => RankedPostsSidecarScope | null;
}

const defaultDependencies: ReturnerFundCompanyDependencies = {
  loadGraph: loadPublishedGraphSnapshot,
  loadSidecarScope: (graph) => {
    const scope = rankedPostsSidecarScope(graph.batch.slug, "off");
    return scope?.previewGeneratedAt === graph.generatedAt ? scope : null;
  },
};

export async function lookupReturnerFundCompany(
  input: { companyReference: string; batchSlug: PublishedGraphBatchSlug; limit: number },
  dependencies: ReturnerFundCompanyDependencies = defaultDependencies
): Promise<ReturnerFundCompanyLookupResult> {
  if (!isPublishedGraphBatchSlug(input.batchSlug)) return { status: "not_found" };

  const graph = await dependencies.loadGraph({ batchSlug: input.batchSlug, audienceId: "off" });
  const matches = graph.nodes
    .filter((node) => node.entityType === "company")
    .filter((node) => companyMatchesReference(node, input.companyReference));

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      matches: matches.map((node) => ({ id: node.entityId, slug: companySlug(node), name: node.label })),
    };
  }

  const sidecarScope = dependencies.loadSidecarScope(graph);
  if (!sidecarScope) {
    return { status: "unavailable", reason: "ranked_posts_out_of_sync" };
  }

  return {
    status: "found",
    response: buildCompanyResponse(
      graph,
      matches[0]!,
      Math.max(1, Math.min(RETURNER_FUND_POST_LIMIT_MAX, Math.trunc(input.limit))),
      sidecarScope
    ),
  };
}

function buildCompanyResponse(
  graph: GraphResponse,
  company: GraphNode,
  limit: number,
  sidecarScope: RankedPostsSidecarScope
): ReturnerFundCompanyResponse {
  const companyNodes = graph.nodes.filter((node) => node.entityType === "company");
  const scoreBreakdown = company.scoreBreakdown;
  const graphForCompany: GraphResponse = { ...graph, nodes: [company] };
  const bestPosts = selectRankedPosts(graphForCompany, {
    period: "all_time",
    limit,
    sidecarScope,
  });
  const totalEligiblePosts = sidecarScope.fullRankableByCompany[company.entityId] ?? bestPosts.length;
  const cohortRank = 1 + companyNodes.filter((node) => node.score > company.score).length;
  const derivedCohortPercentile = percentileRank(
    companyNodes.map((node) => node.score),
    company.score
  );
  const slug = companySlug(company);

  return {
    schemaVersion: RETURNER_FUND_COMPANY_SCHEMA_VERSION,
    company: {
      id: company.entityId,
      slug,
      name: company.label,
      batchSlug: graph.batch.slug,
      batchLabel: graph.batch.label,
      ycProfileUrl: company.ycProfileUrl,
      websiteUrl: company.websiteUrl,
      returnerFundUrl: siteUrl(`/companies/${encodeURIComponent(slug)}`),
    },
    returnerFund: {
      score: company.score,
      scale: { min: 0, max: 100 },
      absoluteScore: scoreBreakdown?.absoluteScore ?? null,
      topPlatform: company.topPlatform,
      platformScores: company.platformScores,
      cohort: {
        rank: cohortRank,
        size: companyNodes.length,
        derivedPercentile: round(derivedCohortPercentile * 100, 2),
        percentileMethod: "tie_aware_midrank_all_published_companies",
      },
      model: {
        id: scoreBreakdown?.modelId ?? graph.scoringContext?.modelId ?? null,
        version: scoreBreakdown?.modelVersion ?? graph.scoringContext?.modelVersion ?? null,
        name: scoreBreakdown?.modelName ?? graph.scoringContext?.modelName ?? null,
      },
      confidence: scoreBreakdown?.confidence
        ? {
            level: scoreBreakdown.confidence.level,
            value: scoreBreakdown.confidence.value,
            scoredEvidenceCount: scoreBreakdown.confidence.scoredEvidenceCount,
          }
        : null,
      explanation: scoreBreakdown?.explanation ?? null,
      evidenceAsOf: scoreBreakdown?.evidenceAsOf ?? graph.scoringContext?.evidenceAsOf ?? null,
      generatedAt: graph.generatedAt,
    },
    postsReturned: bestPosts.length,
    totalEligiblePosts,
    postsTruncated: bestPosts.length < totalEligiblePosts,
    postsComplete: true,
    bestPosts: bestPosts.map((post) => {
      const founder = post.sourceKind === "founder"
        ? company.founders.find((candidate) => candidate.id === post.evidence.entityId)
        : null;
      const authorName = post.sourceKind === "top_voice"
        ? post.evidence.topVoice?.displayName ?? post.evidence.authorName
        : founder?.name ?? company.label;
      return {
        rank: post.rank,
        id: post.evidence.id,
        canonicalPostKey: post.canonicalPostKey,
        platform: post.evidence.platform,
        sourceKind: post.sourceKind,
        title: compactText(evidenceDisplayText(post.evidence, post.evidence.sourceUrl), 240),
        excerpt: compactText(post.evidence.text, 1_000),
        url: post.evidence.sourceUrl,
        authorName,
        authorHandle: post.evidence.authorHandle,
        publishedAt: post.evidence.postedAt,
        score: rankedEvidenceScore(post.evidence),
        metrics: post.evidence.metrics,
        topics: post.evidence.topics ?? [],
      };
    }),
  };
}

function companyMatchesReference(company: GraphNode, rawReference: string): boolean {
  const reference = rawReference.trim().toLowerCase();
  if (!reference) return false;
  return company.entityId.toLowerCase() === reference ||
    companySlug(company).toLowerCase() === reference ||
    slugify(company.label) === reference;
}

function companySlug(company: GraphNode): string {
  try {
    const pathname = new URL(company.ycProfileUrl).pathname;
    const match = pathname.match(/^\/companies\/([^/]+)\/?$/i);
    if (match?.[1]) return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    // Fall through to the stable graph identity.
  }
  return company.entityId.replace(/^company-/, "") || slugify(company.label);
}

function rankedEvidenceScore(evidence: { normalizedScore?: number; contributionScore: number }): number {
  const value = Number.isFinite(evidence.normalizedScore)
    ? Number(evidence.normalizedScore)
    : evidence.contributionScore;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
