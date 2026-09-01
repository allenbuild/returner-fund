import type { GraphResponse } from "./types";

export function initialSelectedNodeId(graph: GraphResponse | undefined): string | null {
  if (!graph) return null;

  const companyIdsWithRetainedEvidence = new Set(
    graph.nodes
      .filter((node) => node.entityType === "company" && node.evidenceIds.length > 0)
      .map((node) => node.entityId)
  );
  const selectedCompanyId =
    graph.leaderboard.find((row) => companyIdsWithRetainedEvidence.has(row.companyId))?.companyId ??
    graph.leaderboard[0]?.companyId;

  return selectedCompanyId ? `company:${selectedCompanyId}` : graph.nodes[0]?.id ?? null;
}
