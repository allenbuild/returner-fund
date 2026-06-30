import type {
  AccountMetrics,
  ConnectorLimitations,
  EntityRef,
  FetchPostsOptions,
  NormalizedPost,
  Platform,
  PostMetrics,
  ProfileCandidate,
  ReviewReason,
  ReviewState,
  SocialConnector,
  SocialProfile
} from "@/types/domain";

export const READ_ONLY_SAFETY_RULES = [
  "Read-only connector: discovery, reading, and metrics normalization only.",
  "Never like, follow, comment, DM, post, subscribe, star, fork, vote, or mutate external accounts.",
  "Do not bypass CAPTCHAs, paywalls, login walls, private accounts, or technical restrictions."
];

export abstract class ReadOnlyConnector implements SocialConnector {
  abstract platform: Platform;
  protected abstract limitations: ConnectorLimitations;

  async discoverProfiles(_entity: EntityRef): Promise<ProfileCandidate[]> {
    return [];
  }

  async fetchRecentPosts(_profile: SocialProfile, _options: FetchPostsOptions): Promise<NormalizedPost[]> {
    return [];
  }

  async fetchMetrics(post: NormalizedPost): Promise<PostMetrics> {
    return emptyPostMetrics({ postId: post.id ?? post.platformPostId, url: post.url });
  }

  normalizePost(rawPost: unknown): NormalizedPost {
    if (isNormalizedPost(rawPost)) {
      return rawPost;
    }
    throw new Error(`${this.platform} connector cannot normalize unknown post shape yet.`);
  }

  getPermalink(rawPost: unknown): string | null {
    if (typeof rawPost === "object" && rawPost && "url" in rawPost && typeof rawPost.url === "string") {
      return rawPost.url;
    }
    return null;
  }

  async getAccountMetrics(_profile: SocialProfile): Promise<AccountMetrics> {
    return emptyAccountMetrics();
  }

  explainLimitations(): ConnectorLimitations {
    return readOnlyLimitations(this.limitations);
  }
}

export function readOnlyLimitations(
  input: Pick<ConnectorLimitations, "platform"> & Partial<ConnectorLimitations>
): ConnectorLimitations {
  const authentication =
    input.authentication ??
    (input.requiresAuth ? "Requires explicit user-provided credentials." : "Public unauthenticated access only.");

  return {
    platform: input.platform,
    status: input.status ?? (input.requiresAuth ? "needs_api_key" : "ready"),
    requiresAuth: input.requiresAuth ?? authentication.toLowerCase().includes("requires"),
    supportsMutation: false,
    supportsProfileDiscovery: input.supportsProfileDiscovery ?? true,
    supportsRecentPosts: input.supportsRecentPosts ?? false,
    supportsMetrics: input.supportsMetrics ?? false,
    authentication,
    rateLimits: input.rateLimits ?? [],
    missingCapabilities: input.missingCapabilities ?? [],
    safetyRules: [...READ_ONLY_SAFETY_RULES, ...(input.safetyRules ?? [])],
    notes: input.notes ?? [authentication, ...(input.missingCapabilities ?? [])]
  };
}

export function emptyAccountMetrics(raw: Record<string, unknown> = {}): AccountMetrics {
  return {
    followerCount: null,
    followingCount: null,
    verified: false,
    raw
  };
}

export function emptyPostMetrics(raw: Record<string, unknown> = {}): PostMetrics {
  return {
    postId: String(raw.postId ?? raw.platformPostId ?? raw.url ?? "unknown"),
    collectedAt: new Date().toISOString(),
    likes: null,
    comments: null,
    shares: null,
    reposts: null,
    views: null,
    saves: null,
    upvotes: null,
    stars: null,
    forks: null,
    watchers: null,
    issues: null,
    subscribers: null,
    raw
  };
}

export function normalizeLimit(value: number | undefined, fallback = 10, max = 50): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {}
): Promise<string> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      "User-Agent": "YCNetworkIntelligence/0.1 read-only research dashboard",
      Accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function inferHandleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const handle = parsed.pathname.split("/").filter(Boolean)[0];
    return handle ? handle.replace(/^@/, "") : null;
  } catch {
    return null;
  }
}

export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function stringField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function clampMatchScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(0.99, score));
}

interface ProfileCandidateFromUrlInput {
  platform: Platform;
  url: string;
  handle?: string | null;
  accountId?: string | null;
  review_state: ReviewState;
  matchScore?: number;
  reasons?: Array<Partial<ReviewReason> & { code?: string; label?: string; sourceUrl?: string }>;
  discoveredFromUrl?: string | null;
  evidence?: Record<string, unknown>;
}

export function profileCandidateFromUrl(input: ProfileCandidateFromUrlInput): ProfileCandidate {
  return {
    platform: input.platform,
    handle: input.handle ?? inferHandleFromUrl(input.url),
    url: input.url,
    accountId: input.accountId ?? null,
    review_state: input.review_state,
    reasons: (input.reasons ?? []).map((reason) => ({
      signal: reason.signal ?? reason.code ?? "public_url_candidate",
      weight: reason.weight ?? clampMatchScore(input.matchScore ?? 0),
      matched: reason.matched ?? input.review_state === "verified",
      explanation: reason.explanation ?? reason.label ?? "Public URL candidate discovered by connector.",
      code: reason.code,
      label: reason.label,
      sourceUrl: reason.sourceUrl
    })),
    discoveredFromUrl: input.discoveredFromUrl ?? null,
    evidence: {
      matchScore: clampMatchScore(input.matchScore ?? 0),
      ...(input.evidence ?? {})
    }
  };
}

function isNormalizedPost(value: unknown): value is NormalizedPost {
  return Boolean(
    typeof value === "object" &&
      value &&
      "platform" in value &&
      "platformPostId" in value &&
      "url" in value
  );
}
