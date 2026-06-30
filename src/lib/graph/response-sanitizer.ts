import type { EvidenceItem, GraphResponse } from "./types";

interface SanitizeGraphOptions {
  includeRaw?: boolean;
  includeNonScoring?: boolean;
  compactIds?: boolean;
  includeWhy?: boolean;
}

export function sanitizeGraphResponse(
  graph: GraphResponse,
  options: SanitizeGraphOptions = {}
): GraphResponse {
  if (options.includeRaw) {
    return graph;
  }

  const compactIds = options.compactIds ?? (!options.includeRaw && !options.includeNonScoring);
  const includeWhy = options.includeWhy ?? Boolean(options.includeRaw);
  const rawEvidence = graph.evidence.filter((item) => options.includeNonScoring || item.contributionScore > 0);
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
      founders: node.founders.map((founder) => ({
        ...founder,
        evidenceIds: compactEvidenceIds(founder.evidenceIds, evidenceIdByOriginalId)
      }))
    })),
    evidence,
    leaderboard: graph.leaderboard.map((row) => ({
      ...row,
      biggestContribution: row.biggestContribution
        ? evidenceByOriginalId.get(row.biggestContribution.id) ??
          sanitizeEvidenceItem(row.biggestContribution, evidenceIdByOriginalId.get(row.biggestContribution.id), {
            includeWhy
          })
        : null
    }))
  };
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
    why,
    ...safeItem
  } = item;
  return {
    ...safeItem,
    id,
    why: options.includeWhy ? why : ""
  };
}
