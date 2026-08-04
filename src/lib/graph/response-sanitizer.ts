import type { EvidenceItem, GraphResponse } from "./types";

interface SanitizeGraphOptions {
  includeRaw?: boolean;
  includeNonScoring?: boolean;
  compactIds?: boolean;
  includeWhy?: boolean;
  maxEvidence?: number;
}

export const PUBLIC_GRAPH_EVIDENCE_LIMIT = 5_000;

export function sanitizeGraphResponse(
  graph: GraphResponse,
  options: SanitizeGraphOptions = {}
): GraphResponse {
  if (options.includeRaw) {
    return graph;
  }

  const compactIds = options.compactIds ?? (!options.includeRaw && !options.includeNonScoring);
  const includeWhy = options.includeWhy ?? Boolean(options.includeRaw);
  const eligibleEvidence = graph.evidence.filter(
    (item) => options.includeNonScoring || item.contributionScore > 0 || item.tractionStatus === "unscored"
  );
  const rawEvidence = limitPublicEvidence(
    eligibleEvidence,
    options.maxEvidence ?? PUBLIC_GRAPH_EVIDENCE_LIMIT
  );
  const evidenceIdByOriginalId = new Map(
    rawEvidence.map((item, index) => [item.id, compactIds ? `ev-${index.toString(36)}` : item.id])
  );
  const evidence = rawEvidence.map((item) =>
    sanitizeEvidenceItem(item, evidenceIdByOriginalId.get(item.id), { includeWhy })
  );
  const evidenceByOriginalId = new Map<string, EvidenceItem>();
  rawEvidence.forEach((item, index) => {
    const sanitized = evidence[index];
    if (sanitized) {
      evidenceByOriginalId.set(item.id, sanitized);
    }
  });

  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      evidenceIds: compactEvidenceIds(node.evidenceIds, evidenceIdByOriginalId),
      topVoiceConnections: compactTopVoiceConnectionEvidenceIds(node.topVoiceConnections, evidenceIdByOriginalId),
      founders: node.founders.map((founder) => ({
        ...founder,
        evidenceIds: compactEvidenceIds(founder.evidenceIds, evidenceIdByOriginalId)
      }))
    })),
    evidence,
    leaderboard: graph.leaderboard.map((row) => ({
      ...row,
      topVoiceConnections: compactTopVoiceConnectionEvidenceIds(row.topVoiceConnections, evidenceIdByOriginalId),
      biggestContribution: row.biggestContribution
        ? evidenceByOriginalId.get(row.biggestContribution.id) ??
          sanitizeEvidenceItem(row.biggestContribution, evidenceIdByOriginalId.get(row.biggestContribution.id), {
            includeWhy
          })
        : null
    }))
  };
}

function limitPublicEvidence(evidence: EvidenceItem[], maxEvidence: number): EvidenceItem[] {
  if (!Number.isFinite(maxEvidence) || maxEvidence <= 0 || evidence.length <= maxEvidence) {
    return evidence;
  }
  return [...evidence]
    .sort(
      (left, right) =>
        right.contributionScore - left.contributionScore ||
        String(right.postedAt ?? "").localeCompare(String(left.postedAt ?? "")) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, Math.floor(maxEvidence));
}

function compactTopVoiceConnectionEvidenceIds<
  T extends { topEvidenceId: string | null }[] | undefined
>(connections: T, evidenceIdByOriginalId: Map<string, string>): T {
  if (!connections) {
    return connections;
  }
  return connections.map((connection) => ({
    ...connection,
    topEvidenceId: connection.topEvidenceId ? evidenceIdByOriginalId.get(connection.topEvidenceId) ?? null : null
  })) as T;
}

function compactEvidenceIds(ids: string[], evidenceIdByOriginalId: Map<string, string>): string[] {
  return ids.flatMap((id) => {
    const compactId = evidenceIdByOriginalId.get(id);
    return compactId ? [compactId] : [];
  });
}

function sanitizeEvidenceItem(
  item: EvidenceItem,
  id = item.id,
  options: { includeWhy: boolean } = { includeWhy: false }
): EvidenceItem {
  const {
    rawVisibleText: _rawVisibleText,
    matchReason: _matchReason,
    topicClassification: _topicClassification,
    why,
    ...safeItem
  } = item;
  const publicationProvenance = item.platform === "github"
    ? githubPublicationProvenance(_rawVisibleText)
    : undefined;
  const publishedAtPrecision = item.platform === "github" && publicationProvenance?.createdAt === null
    ? "unknown"
    : item.publishedAtPrecision;
  return {
    ...safeItem,
    id,
    publishedAtPrecision,
    ...(publicationProvenance ? { publicationProvenance } : {}),
    why: options.includeWhy ? why : ""
  };
}

function githubPublicationProvenance(rawVisibleText?: string): EvidenceItem["publicationProvenance"] {
  if (typeof rawVisibleText !== "string" || !rawVisibleText.trim().startsWith("{")) {
    return undefined;
  }

  try {
    const raw = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const candidates = [
      raw.repositoryTimestamps,
      (raw.repo as Record<string, unknown> | undefined)?.repositoryTimestamps,
      raw.repo,
      raw.repository,
      (raw.canonicalRepository as Record<string, unknown> | undefined)?.repositoryTimestamps,
      raw.canonicalRepository
    ];
    const timestamps = candidates.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
    );
    if (!timestamps) return undefined;

    const timestamp = (value: unknown): string | null =>
      typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
    const createdAt = timestamp(timestamps.createdAt ?? timestamps.created_at ?? timestamps.repositoryCreatedAt);
    const updatedAt = timestamp(timestamps.updatedAt ?? timestamps.updated_at);
    const pushedAt = timestamp(timestamps.pushedAt ?? timestamps.pushed_at);
    const observedAt = timestamp(timestamps.observedAt ?? timestamps.observed_at);
    if (createdAt === null && updatedAt === null && pushedAt === null && observedAt === null) {
      return undefined;
    }
    return { kind: "github_repository", createdAt, updatedAt, pushedAt, observedAt };
  } catch {
    return undefined;
  }
}
