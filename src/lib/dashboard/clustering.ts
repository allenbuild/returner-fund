import type { DashboardCandidate } from "./contracts";
import { canonicalDashboardUrl, compactWhitespace, stableHash } from "./normalization";

export interface DashboardStoryCluster {
  /** Persistable identity; adding a new cross-platform source does not replace it. */
  stableKey: string;
  candidates: DashboardCandidate[];
}

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "around", "back", "been", "being", "but", "can", "could", "for", "from", "have", "into", "its", "just", "more", "new", "our", "out", "that", "the", "their", "this", "today", "with", "will", "you", "your"
]);
const MAX_TOKEN_INDEX_BUCKET = 80;
const MIN_PAIR_TOKEN_OVERLAP = 2;
const TEMPORAL_PROXIMITY_MS = 30 * 60 * 60 * 1_000;

/**
 * Clusters physical sources into real-world stories. Matching is deliberately
 * conservative: canonical destination/explicit entity links win; text
 * similarity is only a fallback with an entity or rare-token corroborator.
 */
export function clusterDashboardCandidates(candidates: readonly DashboardCandidate[]): DashboardStoryCluster[] {
  const unique = dedupePhysicalSources(candidates);
  if (!unique.length) return [];

  const union = new UnionFind(unique.length);
  const exactIndex = new Map<string, number>();
  const entityIndex = new Map<string, number[]>();
  const tokenIndex = new Map<string, number[]>();
  const tokenSets = unique.map(candidateTokens);

  for (let index = 0; index < unique.length; index += 1) {
    const candidate = unique[index];
    for (const key of exactClusterKeys(candidate)) {
      const previous = exactIndex.get(key);
      if (previous === undefined) exactIndex.set(key, index);
      else if (temporallyClose(candidate, unique[previous])) union.merge(index, previous);
    }
    for (const entity of candidateEntityKeys(candidate)) {
      const entries = entityIndex.get(entity) ?? [];
      entries.push(index);
      entityIndex.set(entity, entries);
    }
    for (const token of tokenSets[index]) {
      const entries = tokenIndex.get(token) ?? [];
      if (entries.length < MAX_TOKEN_INDEX_BUCKET) entries.push(index);
      tokenIndex.set(token, entries);
    }
  }

  // Same explicit entity is a useful guardrail only with a strong title/text
  // match. This prevents two announcements from one company being merged just
  // because they happened on the same day.
  for (const indexes of entityIndex.values()) {
    if (indexes.length > MAX_TOKEN_INDEX_BUCKET) continue;
    for (let left = 0; left < indexes.length; left += 1) {
      for (let right = left + 1; right < indexes.length; right += 1) {
        maybeMerge(unique, tokenSets, union, indexes[left], indexes[right], true);
      }
    }
  }

  // Cross-platform independent coverage frequently does not know the same
  // Returner entity. Compare only candidates with two or more uncommon terms,
  // then require very high lexical overlap before merging.
  const pairTokenCounts = new Map<string, number>();
  for (const indexes of tokenIndex.values()) {
    if (indexes.length < 2 || indexes.length > MAX_TOKEN_INDEX_BUCKET) continue;
    for (let left = 0; left < indexes.length; left += 1) {
      for (let right = left + 1; right < indexes.length; right += 1) {
        const first = Math.min(indexes[left], indexes[right]);
        const second = Math.max(indexes[left], indexes[right]);
        const key = `${first}:${second}`;
        pairTokenCounts.set(key, (pairTokenCounts.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [pair, overlap] of pairTokenCounts) {
    if (overlap < MIN_PAIR_TOKEN_OVERLAP) continue;
    const [left, right] = pair.split(":").map(Number);
    maybeMerge(unique, tokenSets, union, left, right, false);
  }

  const grouped = new Map<number, DashboardCandidate[]>();
  unique.forEach((candidate, index) => {
    const root = union.find(index);
    const group = grouped.get(root) ?? [];
    group.push(candidate);
    grouped.set(root, group);
  });

  return [...grouped.values()]
    .map((group) => ({
      stableKey: storyStableKey(group),
      candidates: [...group].sort(compareCandidate)
    }))
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey));
}

/** Removes exact copies before story scoring, preserving the newest metric reading. */
export function dedupePhysicalSources(candidates: readonly DashboardCandidate[]): DashboardCandidate[] {
  const selected = new Map<string, DashboardCandidate>();
  for (const candidate of candidates) {
    const key = physicalSourceKey(candidate);
    const current = selected.get(key);
    if (!current || compareCandidate(candidate, current) < 0) selected.set(key, candidate);
  }
  return [...selected.values()].sort(compareCandidate);
}

function maybeMerge(
  candidates: DashboardCandidate[],
  tokenSets: Set<string>[],
  union: UnionFind,
  leftIndex: number,
  rightIndex: number,
  sharesEntity: boolean
): void {
  const left = candidates[leftIndex];
  const right = candidates[rightIndex];
  if (!temporallyClose(left, right)) return;
  if (samePhysicalDestination(left, right)) {
    union.merge(leftIndex, rightIndex);
    return;
  }

  const similarity = jaccard(tokenSets[leftIndex], tokenSets[rightIndex]);
  const samePlatform = left.platform === right.platform;
  if (sharesEntity) {
    if (similarity >= 0.52 && hasSpecificSharedToken(tokenSets[leftIndex], tokenSets[rightIndex])) {
      union.merge(leftIndex, rightIndex);
    }
    return;
  }

  // Without a supplied entity link, an article and a discussion can still be
  // the same event, but only with unusually close language and platform
  // diversity. This is intentionally not a broad semantic merge.
  if (!samePlatform && similarity >= 0.72 && hasSpecificSharedToken(tokenSets[leftIndex], tokenSets[rightIndex])) {
    union.merge(leftIndex, rightIndex);
  }
}

function physicalSourceKey(candidate: DashboardCandidate): string {
  return `${candidate.platform}:${candidate.canonicalKey.trim().toLowerCase() || canonicalDashboardUrl(candidate.url) || candidate.id}`;
}

function exactClusterKeys(candidate: DashboardCandidate): string[] {
  const urls = [candidate.destinationUrl, ...(candidate.linkedUrls ?? [])]
    .map(canonicalDashboardUrl)
    .filter((value): value is string => Boolean(value));
  // A physical source URL is deliberately excluded here. Sources on the same
  // platform with different native URLs should need corroboration to merge.
  const storyKey = compactWhitespace(candidate.storyKey).toLowerCase();
  return [...new Set([
    ...urls.map((url) => `destination:${url}`),
    ...(storyKey ? [`story:${storyKey}`] : [])
  ])];
}

function candidateEntityKeys(candidate: DashboardCandidate): string[] {
  const values = [
    ...(candidate.entityKeys ?? []),
    candidate.trackedEntity?.companyId ? `company:${candidate.trackedEntity.companyId}` : null,
    candidate.trackedEntity?.founderId ? `founder:${candidate.trackedEntity.founderId}` : null
  ];
  return [...new Set(values
    .map((value) => compactWhitespace(value).toLowerCase())
    .filter((value) => value.length >= 3))];
}

function candidateTokens(candidate: DashboardCandidate): Set<string> {
  const title = compactWhitespace(candidate.title);
  const text = compactWhitespace(candidate.text).slice(0, 700);
  const entity = candidate.entityLabel ?? candidate.trackedEntity?.name ?? "";
  return new Set(tokenize(`${title} ${entity} ${text}`));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9][^a-z0-9]+|[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token))
    .slice(0, 100);
}

function samePhysicalDestination(left: DashboardCandidate, right: DashboardCandidate): boolean {
  const leftUrls = new Set(exactClusterKeys(left));
  return exactClusterKeys(right).some((key) => leftUrls.has(key));
}

function temporallyClose(left: DashboardCandidate, right: DashboardCandidate): boolean {
  const leftTime = new Date(left.publishedAt).getTime();
  const rightTime = new Date(right.publishedAt).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= TEMPORAL_PROXIMITY_MS;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

function hasSpecificSharedToken(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) {
    if (right.has(token) && token.length >= 6) return true;
  }
  return false;
}

function storyStableKey(candidates: DashboardCandidate[]): string {
  // A cluster grows as independent coverage arrives. Its durable identity must
  // therefore come from one canonical event anchor, rather than a sorted union
  // of every source's URLs, adapter keys, and tokens. Otherwise a later
  // corroborating article whose URL or adapter key happens to sort first would
  // make the persisted story look new on the next hourly run.
  //
  // Use the earliest source that established the event, preferring an
  // explicitly first-party source only on an equal timestamp. A later
  // independent report is corroboration, not a new identity. The final
  // physical-source tie-breaker makes this deterministic for equal timestamps
  // and input permutations.
  const anchor = [...candidates].sort(compareIdentityAnchors)[0];
  if (!anchor) return `story-${stableHash("unknown")}`;

  const trustedStoryKey = exactClusterKeys(anchor)
    .filter((key) => key.startsWith("story:"))[0];
  if (trustedStoryKey) return `story-${stableHash(trustedStoryKey)}`;

  const destination = exactClusterKeys(anchor)
    .filter((key) => key.startsWith("destination:"))
    .sort()[0];
  if (destination) return `story-${stableHash(destination)}`;

  // Include the anchor's physical identity as a collision guard. Entity and
  // language make the key interpretable and stable across source adapters;
  // the immutable platform-scoped key prevents two different same-company
  // announcements with very similar wording from sharing a story row.
  const entities = candidateEntityKeys(anchor).sort();
  const terms = [...candidateTokens(anchor)]
    .sort()
    .slice(0, 12)
    .join("-");
  const anchorKey = physicalSourceKey(anchor);
  return `story-${stableHash(`${entities.join("|")}:${terms}:${anchorKey}`)}`;
}

function compareIdentityAnchors(left: DashboardCandidate, right: DashboardCandidate): number {
  const leftPriority = identityAnchorPriority(left);
  const rightPriority = identityAnchorPriority(right);
  const leftPublishedAt = new Date(left.publishedAt).getTime();
  const rightPublishedAt = new Date(right.publishedAt).getTime();
  return (
    validTimestamp(leftPublishedAt) - validTimestamp(rightPublishedAt) ||
    leftPriority - rightPriority ||
    physicalSourceKey(left).localeCompare(physicalSourceKey(right))
  );
}

function identityAnchorPriority(candidate: DashboardCandidate): number {
  // Explicitly first-party distribution is normally the source that named the
  // event. A repository/release/launch is also a stronger event anchor than a
  // discussion or third-party coverage when that flag is unavailable.
  if (candidate.independentlyReported === false) return 0;
  if (candidate.sourceKind === "repository" || candidate.sourceKind === "release" || candidate.sourceKind === "launch") return 1;
  return 2;
}

function validTimestamp(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareCandidate(left: DashboardCandidate, right: DashboardCandidate): number {
  const leftObserved = new Date(left.observedAt ?? left.publishedAt).getTime();
  const rightObserved = new Date(right.observedAt ?? right.publishedAt).getTime();
  return (
    rightObserved - leftObserved ||
    new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime() ||
    physicalSourceKey(left).localeCompare(physicalSourceKey(right))
  );
}

class UnionFind {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parents[value];
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents[value] = root;
    return root;
  }

  merge(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    // Stable root selection makes repeated hourly runs deterministic.
    this.parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  }
}
