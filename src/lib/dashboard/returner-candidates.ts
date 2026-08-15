import { canonicalPostKey, contextEvidenceContentUrl } from "@/lib/graph/dedupe";
import { evidenceDisplayText } from "@/lib/graph/evidence-display";
import type { EvidenceItem, GraphNode, GraphResponse } from "@/lib/graph/types";
import type { DashboardCandidate, DashboardMetrics, DashboardSourceKind, DashboardTopic } from "./contracts";
import { canonicalDashboardUrl, compactWhitespace } from "./normalization";

/**
 * Adapts existing published Returner evidence into the global candidate shape.
 * It preserves graph evidence as the source of truth and does not create a
 * second Post/Evidence record for the dashboard.
 */
export function dashboardCandidatesFromGraph(graph: GraphResponse): DashboardCandidate[] {
  const companyById = new Map(graph.nodes
    .filter((node) => node.entityType === "company")
    .map((node) => [node.entityId, node]));
  const founderCompany = founderCompanyIndex(graph.nodes);
  const candidates = graph.evidence.map((evidence) => dashboardCandidateFromEvidence(evidence, graph, companyById, founderCompany));
  // The graph contains a bounded historical corpus for many verified accounts.
  // Derive a source-local baseline from earlier observations only; this is
  // worker-side input enrichment, not a score borrowed from the legacy graph.
  return withHistoricalAccountBaselines(candidates);
}

function dashboardCandidateFromEvidence(
  evidence: EvidenceItem,
  graph: GraphResponse,
  companyById: Map<string, GraphNode>,
  founderCompany: Map<string, GraphNode>
): DashboardCandidate {
  const owner = evidenceCompany(evidence, companyById, founderCompany);
  const destinationUrl = sourceDestinationUrl(evidence);
  const title = compactWhitespace(evidence.title) || evidenceDisplayText(evidence);
  const independent = ["hacker_news", "reddit", "web", "rss"].includes(evidence.platform) && !isClearlyOwnedEvidence(evidence);
  const articleLike = evidence.platform === "web" || evidence.platform === "rss";
  const sourceKind = sourceKindForEvidence(evidence, articleLike);
  return {
    id: `returner:${graph.batch.slug}:${evidence.id}`,
    canonicalKey: canonicalPostKey(evidence),
    platform: evidence.platform,
    sourceKind,
    url: evidence.sourceUrl,
    destinationUrl,
    linkedUrls: destinationUrl ? [destinationUrl] : [],
    title,
    summary: firstEvidenceSentence(evidence.text, title),
    text: evidence.text,
    authorName: evidence.authorName,
    authorHandle: evidence.authorHandle,
    publishedAt: evidence.postedAt,
    observedAt: evidence.metricsCheckedAt ?? evidence.observedAt ?? evidence.last_checked_at ?? null,
    metrics: evidence.metrics,
    followerCount: finiteFollowerCount(evidence.metrics.followers),
    entityKeys: [
      owner ? `company:${owner.entityId}` : null,
      evidence.entityType === "founder" ? `founder:${evidence.entityId}` : null,
      destinationUrl ? `destination:${destinationUrl}` : null
    ].filter((value): value is string => Boolean(value)),
    entityLabel: owner?.label ?? evidence.attachedCompanyName ?? evidence.authorName,
    trackedEntity: owner
      ? {
        companyId: owner.entityId,
        name: owner.label,
        cohortLabel: graph.batch.label,
        batchSlug: graph.batch.slug
      }
      : null,
    topics: mapGraphTopics(evidence.topics ?? [], sourceKind),
    thumbnailUrl: evidence.thumbnailUrl ?? evidence.mediaUrl ?? null,
    thumbnailAlt: title,
    mediaUrl: evidence.mediaUrl ?? null,
    independentlyReported: independent,
    contentFingerprint: evidence.platformObjectId ?? evidence.platformPostId ?? evidence.id
  };
}

function withHistoricalAccountBaselines(candidates: readonly DashboardCandidate[]): DashboardCandidate[] {
  const historyByAccount = new Map<string, DashboardCandidate[]>();
  for (const candidate of candidates) {
    const key = dashboardAccountKey(candidate);
    if (!key) continue;
    const entries = historyByAccount.get(key) ?? [];
    entries.push(candidate);
    historyByAccount.set(key, entries);
  }

  return candidates.map((candidate) => {
    const accountKey = dashboardAccountKey(candidate);
    const publishedAt = new Date(candidate.publishedAt).getTime();
    if (!accountKey || !Number.isFinite(publishedAt)) return candidate;
    const history = (historyByAccount.get(accountKey) ?? [])
      .filter((prior) => {
        const priorTimestamp = new Date(prior.publishedAt).getTime();
        return Number.isFinite(priorTimestamp) && priorTimestamp < publishedAt;
      })
      .sort((left, right) => new Date(left.publishedAt).getTime() - new Date(right.publishedAt).getTime())
      .slice(-40);
    const accountBaseline = medianMetrics(history.map((prior) => prior.metrics ?? {}));
    return accountBaseline ? { ...candidate, accountBaseline } : candidate;
  });
}

function dashboardAccountKey(candidate: DashboardCandidate): string | null {
  const handle = compactWhitespace(candidate.authorHandle).toLowerCase();
  if (!handle) return null;
  return `${candidate.platform}:${handle}`;
}

function medianMetrics(metricsRows: readonly DashboardMetrics[]): DashboardMetrics | null {
  if (metricsRows.length < 3) return null;
  const valuesByMetric = new Map<string, number[]>();
  for (const metrics of metricsRows) {
    for (const [metric, value] of Object.entries(metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      const values = valuesByMetric.get(metric) ?? [];
      values.push(value);
      valuesByMetric.set(metric, values);
    }
  }
  const baseline: DashboardMetrics = {};
  for (const [metric, values] of valuesByMetric) {
    // Require enough readings for this actual metric. Missing metrics do not
    // get silently converted into a misleading account expectation.
    if (values.length < 3) continue;
    values.sort((left, right) => left - right);
    const middle = Math.floor(values.length / 2);
    baseline[metric] = values.length % 2 === 0
      ? (values[middle - 1] + values[middle]) / 2
      : values[middle];
  }
  return Object.keys(baseline).length ? baseline : null;
}

function finiteFollowerCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function founderCompanyIndex(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  const result = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.entityType !== "company") continue;
    for (const founder of node.founders) {
      if (!result.has(founder.id)) result.set(founder.id, node);
    }
  }
  return result;
}

function evidenceCompany(
  evidence: EvidenceItem,
  companies: Map<string, GraphNode>,
  founders: Map<string, GraphNode>
): GraphNode | null {
  if (evidence.attachedCompanyId && companies.has(evidence.attachedCompanyId)) return companies.get(evidence.attachedCompanyId)!;
  if (evidence.entityType === "company" && companies.has(evidence.entityId)) return companies.get(evidence.entityId)!;
  return founders.get(evidence.entityId) ?? null;
}

function sourceKindForEvidence(evidence: EvidenceItem, articleLike: boolean): DashboardSourceKind {
  if (evidence.mediaType === "video") return "video";
  if (evidence.mediaType === "repo") return "repository";
  if (evidence.mediaType === "launch") return "launch";
  if (articleLike) return "article";
  if (evidence.platform === "hacker_news" || evidence.platform === "reddit") return "discussion";
  return "post";
}

function sourceDestinationUrl(evidence: EvidenceItem): string | null {
  const contextual = contextEvidenceContentUrl(evidence.platform, evidence.platformPostId);
  if (contextual) return canonicalDashboardUrl(contextual);
  // HN evidence sometimes preserves the submitted destination in raw JSON; it
  // is intentionally not parsed on the request path, but a published adapter
  // can safely use its canonical native content field when available.
  if (evidence.platform === "web" || evidence.platform === "rss") {
    return canonicalDashboardUrl(evidence.platformPostId) ?? canonicalDashboardUrl(evidence.sourceUrl);
  }
  return null;
}

function firstEvidenceSentence(text: string | null | undefined, title: string): string | null {
  const normalized = compactWhitespace(text);
  if (!normalized || normalized === title) return null;
  const sentence = normalized.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? normalized;
  return sentence.length > 300 ? `${sentence.slice(0, 297).replace(/\s+\S*$/, "")}…` : sentence;
}

function isClearlyOwnedEvidence(evidence: EvidenceItem): boolean {
  return evidence.entityType === "company" || Boolean(evidence.attachedCompanyId) || evidence.entityType === "founder";
}

function mapGraphTopics(topics: readonly string[], kind: DashboardSourceKind): DashboardTopic[] {
  const mapped = new Set<DashboardTopic>();
  for (const topic of topics) {
    if (topic === "fundraising-financing") mapped.add("funding");
    if (topic === "product-launch") mapped.add("launches");
    if (topic === "research-benchmark-technical-insight") mapped.add("research");
    if (topic === "accelerator-program" || topic === "company-vision-founder-perspective") mapped.add("startups");
  }
  if (kind === "repository" || /open[- ]source/i.test(topics.join(" "))) mapped.add("open_source");
  if (kind === "video") return [...mapped];
  return [...mapped];
}
