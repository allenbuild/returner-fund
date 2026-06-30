import type { GraphNode } from "./types";

export type GraphSearchResultKind = "company" | "founder";

export interface GraphSearchResult {
  kind: GraphSearchResultKind;
  id: string;
  companyNodeId: string;
  label: string;
  subtitle: string;
  rank: number;
  companyScore: number;
  score: number;
}

export function graphNodeMatchesSearchQuery(node: GraphNode, rawQuery: string): boolean {
  return searchGraphNodes([node], rawQuery, 1).length > 0;
}

export function searchGraphNodes(nodes: GraphNode[], rawQuery: string, limit = 12): GraphSearchResult[] {
  const query = normalizeSearchText(rawQuery);
  if (!query) return [];

  const results: GraphSearchResult[] = [];
  const rankByCompanyNodeId = rankCompanyNodes(nodes);

  for (const node of nodes) {
    const rank = rankByCompanyNodeId.get(node.id) ?? 0;
    const companyScore = matchScore(query, [node.label]);
    if (companyScore > 0) {
      results.push({
        kind: "company",
        id: node.id,
        companyNodeId: node.id,
        label: node.label,
        subtitle: formatRankScore(rank, node.score),
        rank,
        companyScore: node.score,
        score: companyScore + node.score / 500
      });
    }

    for (const founder of node.founders) {
      const founderScore = matchScore(query, [founder.name]);
      if (founderScore <= 0) continue;
      results.push({
        kind: "founder",
        id: founder.id,
        companyNodeId: node.id,
        label: founder.name,
        subtitle: `${node.label} ${formatRankScore(rank, node.score)}`,
        rank,
        companyScore: node.score,
        score: founderScore + node.score / 650
      });
    }
  }

  return results
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function rankCompanyNodes(nodes: GraphNode[]): Map<string, number> {
  return new Map(
    nodes
      .filter((node) => node.entityType === "company")
      .map((node, index) => ({ node, index }))
      .sort((left, right) => right.node.score - left.node.score || left.index - right.index)
      .map(({ node }, index) => [node.id, index + 1])
  );
}

function formatRankScore(rank: number, score: number): string {
  const rankText = rank > 0 ? `#${rank}` : "#-";
  return `${rankText}, Score: ${Math.round(score)}`;
}

function matchScore(query: string, values: string[]): number {
  let best = 0;
  for (const value of values) {
    const normalized = normalizeSearchText(value);
    if (!normalized) continue;
    if (normalized === query) best = Math.max(best, 100);
    else if (normalized.startsWith(query)) best = Math.max(best, 82);
    else if (normalized.includes(query)) best = Math.max(best, 64);
    else {
      const tokens = query.split(" ");
      const tokenMatches = tokens.filter((token) => normalized.includes(token)).length;
      if (tokenMatches === tokens.length) best = Math.max(best, 48 + tokenMatches);
    }
    best = Math.max(best, fuzzyMatchScore(query, normalized));
  }
  return best;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fuzzyMatchScore(query: string, normalized: string): number {
  if (query.length < 3 || normalized.length < 3) return 0;

  const compactScore = stringSimilarity(query.replace(/\s+/g, ""), normalized.replace(/\s+/g, ""));
  if (compactScore >= 0.85) {
    return 86 + Math.round(compactScore * 10);
  }
  if (compactScore >= 0.78) {
    return 66 + Math.round(compactScore * 18);
  }

  const queryTokens = query.split(" ").filter((token) => token.length >= 3);
  const valueTokens = normalized.split(" ").filter((token) => token.length >= 3);
  if (!queryTokens.length || !valueTokens.length) return 0;

  const tokenScores = queryTokens.map((queryToken) =>
    Math.max(...valueTokens.map((valueToken) => stringSimilarity(queryToken, valueToken)))
  );
  const average = tokenScores.reduce((total, score) => total + score, 0) / tokenScores.length;
  const everyTokenClose = tokenScores.every((score, index) => {
    const tokenLength = queryTokens[index]?.length ?? 0;
    return score >= (tokenLength <= 5 ? 0.58 : 0.68);
  });

  return everyTokenClose && average >= 0.68 ? 42 + Math.round(average * 24) : 0;
}

function stringSimilarity(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 1;
  const distance = levenshteinDistance(left, right);
  return Math.max(0, 1 - distance / maxLength);
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    for (let index = 0; index <= right.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? 0;
}
