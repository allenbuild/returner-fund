import type { EvidenceItem } from "./types";
import { normalizeMetricsForScoring } from "../scoring/traction-config";

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|igshid$|mc_|ref$|ref_src$|s$|t$)/i;
const OBJECT_ID = /^[A-Za-z0-9_-]+$/;
const REDDIT_ID = /^[A-Za-z0-9]+$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const BLUESKY_RECORD_KEY = /^[A-Za-z0-9._~:-]{1,512}$/;
const GITHUB_RESERVED_OWNERS = new Set([
  "collections",
  "codespaces",
  "enterprise",
  "events",
  "explore",
  "features",
  "gist",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "search",
  "settings",
  "signup",
  "sponsors",
  "topics",
  "users"
]);

export function canonicalEvidenceKey(item: EvidenceItem): string {
  const entityPart = normalizeKeyPart(item.entityId);
  return `${entityPart}:${canonicalPostKey(item)}`;
}

/** Physical post identity without entity attribution. Use this for scoring rollups. */
export function canonicalPostKey(item: EvidenceItem): string {
  const identities = evidenceIdentities(item);
  if (identities.conflict && !hasActivityFragmentLocator(item)) {
    return `${item.platform}:conflict:${identities.urlId}:${identities.explicitId}`;
  }

  // GitHub repository IDs are immutable across owner/name transfers. Prefer
  // that native object identity when present, while retaining the URL/explicit
  // ID conflict gate above so a malformed row cannot bypass quarantine.
  const githubRepositoryId = item.platform === "github"
    ? String(item.platformObjectId ?? "").trim()
    : "";
  if (/^\d+$/.test(githubRepositoryId)) {
    return `github:repository-object:${githubRepositoryId}`;
  }

  const nativeId = identities.urlId ?? identities.explicitId;
  if (nativeId) {
    return `${item.platform}:post:${nativeId}`;
  }

  const canonicalUrl = canonicalEvidenceUrl(item.sourceUrl);
  if (canonicalUrl) {
    return `${item.platform}:url:${canonicalUrl}`;
  }

  const accountPart = item.canonicalAccountId ?? item.socialAccountId ?? item.authorHandle ?? item.authorName;
  return `${item.platform}:fallback:${normalizeKeyPart(accountPart)}:${fallbackEvidenceKey(item)}`;
}

export function canonicalEvidenceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com") {
      url.hostname = "x.com";
    }

    if (url.hostname === "x.com") {
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
      if (match) {
        url.pathname = `/${match[1].toLowerCase()}/status/${match[2]}`;
        url.search = "";
      }
    }

    if (url.hostname === "instagram.com") {
      const match = url.pathname.match(/^\/(p|reel|tv)\/([^/]+)/i);
      if (match) {
        url.pathname = `/${match[1].toLowerCase()}/${match[2]}`;
        url.search = "";
      }
    }

    if (url.hostname.endsWith("linkedin.com")) {
      url.search = "";
      url.pathname = url.pathname.replace(/\/$/, "");
    }

    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

export function dedupeEvidenceItems<T extends EvidenceItem>(items: T[]): T[] {
  return dedupeEvidenceByAliases(items, (item) => [
    canonicalEvidenceKey(item),
    ...githubUrlAliases(item, normalizeKeyPart(item.entityId)),
  ]);
}

export function dedupeEvidenceForScoring<T extends EvidenceItem>(items: T[]): T[] {
  return dedupeEvidenceByAliases(
    items.filter((item) => !hasEvidenceIdentityConflict(item)),
    (item) => [canonicalPostKey(item), ...githubUrlAliases(item)],
  );
}

/**
 * A current GitHub observation can identify a repository by both its immutable
 * object ID and its owner/name URL, while an older snapshot may only have the
 * URL. Treat both as aliases for the same physical row. The union step also
 * preserves object-ID dedupe across repository renames and transfers.
 */
function dedupeEvidenceByAliases<T extends EvidenceItem>(
  items: T[],
  aliasesForItem: (item: T) => string[],
): T[] {
  const parents = items.map((_, index) => index);
  const githubObjectIds = items.map((item) => {
    const objectId = immutableGithubRepositoryObjectId(item);
    return new Set(objectId ? [objectId] : []);
  });
  const aliasOwners = new Map<string, number>();

  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };

  const union = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;

    const combinedObjectIds = new Set([
      ...githubObjectIds[leftRoot],
      ...githubObjectIds[rightRoot],
    ]);
    // Two different immutable IDs at the same owner/name can represent a
    // deleted-and-recreated repository (or corrupt input). Never let a
    // URL-only bridge collapse that conflict silently.
    if (combinedObjectIds.size > 1) return false;

    parents[rightRoot] = leftRoot;
    githubObjectIds[leftRoot] = combinedObjectIds;
    return true;
  };

  items.forEach((item, index) => {
    for (const alias of new Set(aliasesForItem(item).filter(Boolean))) {
      const existing = aliasOwners.get(alias);
      if (existing === undefined) aliasOwners.set(alias, index);
      else union(existing, index);
    }
  });

  const groups = new Map<number, { firstIndex: number; preferred: T }>();
  items.forEach((item, index) => {
    const root = find(index);
    const existing = groups.get(root);
    if (!existing) {
      groups.set(root, { firstIndex: index, preferred: item });
    } else if (shouldReplaceEvidence(existing.preferred, item)) {
      existing.preferred = item;
    }
  });

  return [...groups.values()]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((group) => group.preferred);
}

function immutableGithubRepositoryObjectId(item: EvidenceItem): string | null {
  if (item.platform !== "github") return null;
  const objectId = String(item.platformObjectId ?? "").trim();
  return /^\d+$/.test(objectId) ? objectId : null;
}

function githubUrlAliases(item: EvidenceItem, entityPrefix?: string): string[] {
  if (item.platform !== "github" || hasEvidenceIdentityConflict(item)) return [];
  const nativeId = nativeEvidenceIdentityFromUrl("github", item.sourceUrl);
  if (!nativeId) return [];
  const physicalAlias = `github:post:${nativeId}`;
  return [entityPrefix === undefined ? physicalAlias : `${entityPrefix}:${physicalAlias}`];
}

/** Returns a platform-native object ID only when both host and path grammar are valid. */
export function nativeEvidenceIdentityFromUrl(
  platform: EvidenceItem["platform"],
  rawUrl: string
): string | null {
  try {
    const url = new URL(rawUrl);
    const host = normalizedHost(url);
    const path = normalizedPath(url);

    if (platform === "x") {
      if (!hostIs(host, "x.com", "twitter.com", "mobile.twitter.com")) return null;
      return (
        path.match(
          /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)(?:\/(?:photo|video)\/\d+)?$/i
        )?.[1] ?? null
      );
    }

    if (platform === "tiktok") {
      if (!hostIs(host, "tiktok.com", "m.tiktok.com")) return null;
      return path.match(/^\/@[A-Za-z0-9._-]+\/video\/(\d+)$/i)?.[1] ?? null;
    }

    if (platform === "bluesky") {
      if (host !== "bsky.app") return null;
      const match = path.match(/^\/profile\/([^/]+)\/post\/([^/]+)$/i);
      return match ? blueskyPostIdentity(match[1], match[2]) : null;
    }

    if (platform === "instagram") {
      if (!hostIs(host, "instagram.com", "m.instagram.com")) return null;
      return path.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
    }

    if (platform === "linkedin") {
      if (!hostIsDomainOrSubdomain(host, "linkedin.com")) return null;
      const feedId = path.match(/^\/feed\/update\/urn:li:activity:(\d+)$/i)?.[1];
      if (feedId) return feedId;
      const postSegment = path.match(/^\/posts\/([^/]+)$/i)?.[1];
      return postSegment?.match(/activity[-:](\d+)/i)?.[1] ?? null;
    }

    if (platform === "youtube") {
      if (host === "youtu.be") {
        return path.match(/^\/([A-Za-z0-9_-]+)$/)?.[1] ?? null;
      }
      if (!hostIs(host, "youtube.com", "m.youtube.com")) return null;
      if (path === "/watch") {
        return validObjectId(url.searchParams.get("v"));
      }
      return path.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
    }

    if (platform === "reddit") {
      if (host === "redd.it") {
        return path.match(/^\/([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? null;
      }
      if (!hostIs(host, "reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "m.reddit.com")) {
        return null;
      }
      return redditPostIdFromPath(path);
    }

    if (platform === "hacker_news") {
      if (host !== "news.ycombinator.com" || path !== "/item") return null;
      const id = url.searchParams.get("id");
      return id && /^\d+$/.test(id) ? id : null;
    }

    if (platform === "bilibili") {
      if (!hostIs(host, "bilibili.com", "m.bilibili.com")) return null;
      return path.match(/^\/video\/([A-Za-z0-9]+)$/i)?.[1] ?? null;
    }

    if (platform === "github") {
      if (host !== "github.com") return null;
      const parts = path.split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      const [owner, repo] = parts;
      if (
        !GITHUB_OWNER.test(owner) ||
        !GITHUB_REPO.test(repo) ||
        repo === "." ||
        repo === ".." ||
        GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())
      ) {
        return null;
      }
      return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    }

    if (platform === "product_hunt") {
      if (host !== "producthunt.com") return null;
      const direct = path.match(/^\/(posts)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i);
      if (direct) return `${direct[1].toLowerCase()}/${direct[2].toLowerCase()}`;
      const forum = path.match(
        /^\/(p)\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/([A-Za-z0-9][A-Za-z0-9_-]*))?$/i
      );
      if (forum) return [forum[1], forum[2], forum[3]].filter(Boolean).join("/").toLowerCase();
      const launch = path.match(
        /^\/(products)\/([A-Za-z0-9][A-Za-z0-9_-]*)\/(launches)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/i
      );
      return launch ? launch.slice(1).join("/").toLowerCase() : null;
    }

    return null;
  } catch {
    return null;
  }
}

export function hasEvidenceIdentityConflict(item: EvidenceItem): boolean {
  return evidenceIdentities(item).conflict;
}

function evidenceIdentities(item: EvidenceItem): {
  urlId: string | null;
  explicitId: string | null;
  conflict: boolean;
} {
  const urlId = nativeEvidenceIdentityFromUrl(item.platform, item.sourceUrl);
  const explicitId = platformPostIdIdentity(item.platform, item.platformPostId);
  return {
    urlId,
    explicitId,
    conflict: Boolean(urlId && explicitId && !identitiesMatch(item.platform, urlId, explicitId))
  };
}

function platformPostIdIdentity(
  platform: EvidenceItem["platform"],
  rawValue: string | null | undefined
): string | null {
  const value = rawValue?.trim();
  if (!value) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    return nativeEvidenceIdentityFromUrl(platform, value) ?? value;
  }
  if (platform === "x") return value.match(/(?:^|\/)status\/(\d+)/i)?.[1] ?? value;
  if (platform === "tiktok") return value.match(/(?:^|\/)video\/(\d+)/i)?.[1] ?? value;
  if (platform === "bluesky") {
    const atUri = value.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/i);
    if (atUri) return blueskyPostIdentity(atUri[1], atUri[2]);
    const webPath = value.match(/^(?:profile\/)?([^/]+)\/post\/([^/]+)$/i);
    if (webPath) return blueskyPostIdentity(webPath[1], webPath[2]);
    return BLUESKY_RECORD_KEY.test(value) ? value : null;
  }
  if (platform === "instagram") {
    return value.match(/^(?:\/)?(?:p|reel|tv)[/:]([A-Za-z0-9_-]+)/i)?.[1] ??
      validObjectId(value) ??
      value;
  }
  if (platform === "linkedin") return value.match(/activity[-:](\d+)/i)?.[1] ?? value;
  if (platform === "youtube") {
    return value.match(/^(?:shorts|live)\/([A-Za-z0-9_-]+)$/i)?.[1] ?? validObjectId(value) ?? value;
  }
  if (platform === "reddit") {
    const id = value.match(/(?:^|\/)comments\/([A-Za-z0-9]+)/i)?.[1] ?? value.replace(/^t3_/i, "");
    return REDDIT_ID.test(id) ? id.toLowerCase() : value;
  }
  if (platform === "hacker_news") return value;
  if (platform === "bilibili") {
    return value.match(/(?:^|\/)video\/([A-Za-z0-9]+)/i)?.[1] ?? value;
  }
  if (platform === "github") {
    const parts = value.replace(/^\/+|\/+$/g, "").split("/");
    return parts.length === 2 && GITHUB_OWNER.test(parts[0]) && GITHUB_REPO.test(parts[1])
      ? `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
      : value.toLowerCase();
  }
  if (platform === "product_hunt") {
    const normalized = value.replace(/^\/+|\/+$/g, "").toLowerCase();
    return /^(?:posts\/[a-z0-9][a-z0-9_-]*|p\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?|products\/[a-z0-9][a-z0-9_-]*\/launches\/[a-z0-9][a-z0-9_-]*)$/.test(
      normalized
    ) ||
      /^[a-z0-9][a-z0-9_-]*$/.test(normalized)
      ? normalized
      : `invalid:${normalized}`;
  }
  return null;
}

function fallbackEvidenceKey(item: EvidenceItem): string {
  return `${item.authorName}:${item.text}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function shouldReplaceEvidence(existing: EvidenceItem, candidate: EvidenceItem): boolean {
  const existingCandidatePriority = scoringCandidatePriority(existing);
  const candidatePriority = scoringCandidatePriority(candidate);
  if (candidatePriority !== existingCandidatePriority) {
    return candidatePriority > existingCandidatePriority;
  }

  const existingIsParent = isNativeParentObservation(existing);
  const candidateIsParent = isNativeParentObservation(candidate);
  if (candidateIsParent !== existingIsParent) {
    return candidateIsParent;
  }

  const existingIdentityAgreement = hasExplicitUrlIdentityAgreement(existing);
  const candidateIdentityAgreement = hasExplicitUrlIdentityAgreement(candidate);
  if (candidateIdentityAgreement !== existingIdentityAgreement) {
    return candidateIdentityAgreement;
  }

  const existingMetricCompleteness = metricCompleteness(existing);
  const candidateMetricCompleteness = metricCompleteness(candidate);
  if (candidateMetricCompleteness !== existingMetricCompleteness) {
    return candidateMetricCompleteness > existingMetricCompleteness;
  }

  const existingFreshness = evidenceFreshness(existing);
  const candidateFreshness = evidenceFreshness(candidate);

  if (candidateFreshness !== existingFreshness) {
    return candidateFreshness > existingFreshness;
  }

  const existingRank = evidenceRank(existing);
  const candidateRank = evidenceRank(candidate);
  return candidateRank !== existingRank
    ? candidateRank > existingRank
    : candidate.id.localeCompare(existing.id) < 0;
}

function scoringCandidatePriority(item: EvidenceItem): number {
  if (hasEvidenceIdentityConflict(item)) return 0;
  if (item.review_state !== "verified") return 0;
  if (item.linkStatus === "invalid" || item.linkStatus === "blocked") return 0;
  if (!Number.isFinite(item.contributionScore) || item.contributionScore <= 0) return 0;
  return nativeEvidenceIdentityFromUrl(item.platform, item.sourceUrl) ? 1 : 0;
}

function isNativeParentObservation(item: EvidenceItem): boolean {
  if (hasActivityFragmentLocator(item)) {
    return false;
  }

  return !hasEvidenceIdentityConflict(item);
}

function hasExplicitUrlIdentityAgreement(item: EvidenceItem): boolean {
  const explicitId = platformPostIdIdentity(item.platform, item.platformPostId);
  const urlId = nativeEvidenceIdentityFromUrl(item.platform, item.sourceUrl);
  return Boolean(explicitId && urlId && identitiesMatch(item.platform, urlId, explicitId));
}

function hasActivityFragmentLocator(item: EvidenceItem): boolean {
  try {
    const url = new URL(item.sourceUrl);
    const queryKeys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    if (queryKeys.some((key) => key.includes("comment") || key.includes("reply") || key === "lc")) {
      return true;
    }

    if (item.platform === "linkedin" && /\/recent-activity\//i.test(url.pathname) && /^#post-/i.test(url.hash)) {
      return true;
    }

    if (item.platform === "reddit") {
      const parts = url.pathname.split("/").filter(Boolean);
      const commentsIndex = parts.findIndex((part) => part.toLowerCase() === "comments");
      if (commentsIndex >= 0 && parts.length > commentsIndex + 3) {
        return true;
      }
    }

    return /^#(?:comment|reply)-/i.test(url.hash);
  } catch {
    return false;
  }
}

function metricCompleteness(item: EvidenceItem): number {
  return Object.values(normalizeMetricsForScoring(item.platform, item.metrics)).filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0
  ).length;
}

function evidenceFreshness(item: EvidenceItem): number {
  const ingestedAt = (item as EvidenceItem & { ingestedAt?: string | null }).ingestedAt;
  return Math.max(
    parseDateMs(item.metricsCheckedAt),
    parseDateMs(item.observedAt),
    parseDateMs(ingestedAt),
    parseDateMs(item.last_checked_at),
    parseDateMs(item.last_updated_at),
    parseDateMs(item.first_seen_at)
  );
}

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^www\./i, "").toLowerCase();
}

function normalizedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, "") || "/";
}

function hostIs(host: string, ...allowed: string[]): boolean {
  return allowed.includes(host);
}

function hostIsDomainOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function validObjectId(value: string | null): string | null {
  return value && OBJECT_ID.test(value) ? value : null;
}

function redditPostIdFromPath(path: string): string | null {
  const match = path.match(
    /^\/(?:r\/[A-Za-z0-9_]+\/)?comments\/([A-Za-z0-9]+)(?:\/[A-Za-z0-9_%.-]+)?(?:\/[A-Za-z0-9]+)?$/i
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function identitiesMatch(platform: EvidenceItem["platform"], urlId: string, explicitId: string): boolean {
  if (urlId === explicitId) return true;
  if (platform === "bluesky") return urlId.endsWith(`/post/${explicitId}`);
  if (platform !== "product_hunt") return false;

  const aliases = new Set([urlId.replace(/\//g, "-")]);
  const launch = urlId.match(/^products\/([^/]+)\/launches\/([^/]+)$/);
  if (launch) aliases.add(`${launch[1]}-${launch[2]}`);
  const direct = urlId.match(/^posts\/([^/]+)$/);
  if (direct) aliases.add(direct[1]);
  const forum = urlId.match(/^p\/([^/]+)$/);
  if (forum) aliases.add(forum[1]);
  return aliases.has(explicitId);
}

function blueskyPostIdentity(actor: string, recordKey: string): string | null {
  if (!actor || !BLUESKY_RECORD_KEY.test(recordKey)) return null;
  return `${actor.toLowerCase()}/post/${recordKey}`;
}

function parseDateMs(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function evidenceRank(item: EvidenceItem): number {
  const metricTotal = Object.values(normalizeMetricsForScoring(item.platform, item.metrics)).reduce<number>(
    (sum, value) => saturatingAdd(sum, typeof value === "number" && Number.isFinite(value) ? value : 0),
    0
  );
  const contributionScore = Number.isFinite(item.contributionScore) ? item.contributionScore : 0;
  return saturatingAdd(contributionScore * 1_000_000, metricTotal);
}

function saturatingAdd(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function normalizeKeyPart(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
