import type { EvidenceItem, Platform, ReviewState } from "./types";

export interface AttributionSocialLink {
  platform: Platform;
  url: string;
}

export interface AttributionFounderProfile {
  id: string;
  name: string;
  socialLinks: AttributionSocialLink[];
}

export interface AttributionCompanyProfile {
  id: string;
  name: string;
  slug: string;
  websiteUrl?: string | null;
  socialLinks: AttributionSocialLink[];
  founders: AttributionFounderProfile[];
}

export interface AttributionContext {
  companiesById: Map<string, AttributionCompanyProfile>;
  companyIdByEntityId: Map<string, string>;
  allCompanies: AttributionCompanyProfile[];
}

export interface AttributionAuditResult {
  reviewState: ReviewState;
  scoreMultiplier: number;
  risk: "low" | "medium" | "high";
  reasons: string[];
  conflictingCompanyNames: string[];
}

interface EntitySignals {
  company: AttributionCompanyProfile;
  names: string[];
  domains: string[];
  handlesByPlatform: Partial<Record<Platform, Set<string>>>;
}

const POST_PLATFORMS_REQUIRING_ENTITY_SIGNAL = new Set<Platform>([
  "product_hunt",
  "youtube",
  "hacker_news",
  "reddit",
  "linkedin"
]);

const SOCIAL_HOSTS = ["x.com", "twitter.com", "instagram.com", "linkedin.com", "youtube.com", "youtu.be"];

const GENERIC_SINGLE_WORD_NAMES = new Set([
  "aice",
  "arden",
  "bloom",
  "chert",
  "cohesion",
  "dispatch",
  "drafted",
  "flow",
  "flowscope",
  "frame",
  "hedge",
  "hub",
  "hyper",
  "jo",
  "modern",
  "pentagon",
  "pluto",
  "primitive",
  "replicas",
  "result",
  "runtime",
  "stage",
  "standout",
  "superset",
  "thomas",
  "walter"
]);

export function buildAttributionContext(companies: AttributionCompanyProfile[]): AttributionContext {
  const companiesById = new Map(companies.map((company) => [company.id, company]));
  const companyIdByEntityId = new Map<string, string>();

  for (const company of companies) {
    companyIdByEntityId.set(company.id, company.id);
    for (const founder of company.founders) {
      companyIdByEntityId.set(founder.id, company.id);
    }
  }

  return {
    companiesById,
    companyIdByEntityId,
    allCompanies: companies
  };
}

export function auditEvidenceAttribution(
  item: EvidenceItem,
  context: AttributionContext
): AttributionAuditResult {
  const companyId = item.attachedCompanyId ?? context.companyIdByEntityId.get(item.entityId) ?? item.entityId;
  const company = context.companiesById.get(companyId);
  const reasons: string[] = [];

  if (!company) {
    return {
      reviewState: "needs_review",
      scoreMultiplier: 0,
      risk: "high",
      reasons: ["Attached company could not be resolved from the current YC company registry."],
      conflictingCompanyNames: []
    };
  }

  if (item.platform === "web" || item.platform === "rss") {
    return {
      reviewState: item.review_state ?? "verified",
      scoreMultiplier: 1,
      risk: "low",
      reasons: ["Context-only web/RSS evidence is already non-scoring."],
      conflictingCompanyNames: []
    };
  }

  if (item.platform === "github") {
    return auditGithubEvidence(item, context, company);
  }

  const visibleText = visibleEvidenceText(item);
  const identityText = identityEvidenceText(item);
  const signals = entitySignals(company);
  const hasVerifiedSnapshotCompanyNameSignal = hasVerifiedSnapshotCompanyNameSignalForCompany(item, company, visibleText);
  const hasValidatedTopVoiceTargetSignal = hasValidatedTopVoiceTargetSignalForCompany(item, company, visibleText);
  const hasVisibleOwnSignal =
    hasEntitySignal(visibleText, signals, item.platform) ||
    hasBatchListCompanySignal(visibleText, company) ||
    hasVerifiedSnapshotCompanyNameSignal ||
    hasValidatedTopVoiceTargetSignal ||
    sourceUrlMatchesOwnDomain(item, signals);
  const hasOwnSignal = hasVisibleOwnSignal || hasEntitySignal(identityText, signals, item.platform);
  const hasVerifiedAccountSignal = hasVerifiedAccountSignalForCompany(item, signals);
  const conflictingCompanies = conflictingCompanyMatches(visibleText, context, company);
  const hasStrongConflict = conflictingCompanies.length > 0 && !hasVisibleOwnSignal;
  const hasClearOffTopicVisibleContext = hasClearOffTopicContext(visibleText);
  const isRetweet = item.platform === "x" && /"is_retweet"\s*:\s*true/i.test(item.rawVisibleText ?? "");
  const isQuoteContext = item.platform === "x" && /\bQuote\b/i.test(visibleText) && !hasVisibleOwnSignal;
  const isProfileContext = item.contributionScore <= 0 && /profile|identity context|context only/i.test(item.why ?? item.matchReason ?? "");

  if (hasVerifiedAccountSignal) {
    reasons.push("Evidence came from a verified company or founder account for this company.");
  }
  if (hasOwnSignal) {
    reasons.push("Visible text, URL, author, or domain includes the target company/founder identity.");
  }
  if (isRetweet) {
    reasons.push("Retweet/repost context is non-scoring by policy.");
  }
  if (isProfileContext) {
    reasons.push("Profile/context row is non-scoring by policy.");
  }

  if (isRetweet || isProfileContext) {
    return {
      reviewState: item.review_state ?? "verified",
      scoreMultiplier: 0,
      risk: "low",
      reasons,
      conflictingCompanyNames: conflictingCompanies
    };
  }

  if (item.platform === "instagram" && !hasVerifiedAccountSignal) {
    return {
      reviewState: "needs_review",
      scoreMultiplier: 0,
      risk: "high",
      reasons: [
        ...reasons,
        "Instagram posts only score when the post author/profile handle matches a verified company or founder Instagram account."
      ],
      conflictingCompanyNames: conflictingCompanies
    };
  }

  if (isQuoteContext) {
    return {
      reviewState: "needs_review",
      scoreMultiplier: 0,
      risk: "high",
      reasons: [
        ...reasons,
        "X quote/repost-like evidence lacks a visible target-company signal, so it is context only until reviewed."
      ],
      conflictingCompanyNames: conflictingCompanies
    };
  }

  if (hasStrongConflict) {
    return {
      reviewState: "needs_review",
      scoreMultiplier: 0,
      risk: "high",
      reasons: [
        ...reasons,
        `Visible text matched another YC company without a target-company signal: ${conflictingCompanies.join(", ")}.`
      ],
      conflictingCompanyNames: conflictingCompanies
    };
  }

  if (hasVerifiedAccountSignal && hasClearOffTopicVisibleContext && !hasVisibleOwnSignal) {
    return {
      reviewState: "needs_review",
      scoreMultiplier: 0,
      risk: "medium",
      reasons: [
        ...reasons,
        "First-party social post contains clear off-topic context without a visible target-company signal, so it is held for review instead of scoring."
      ],
      conflictingCompanyNames: conflictingCompanies
    };
  }

  if (hasVerifiedAccountSignal || hasOwnSignal || isRetweet || isProfileContext) {
    return {
      reviewState: item.review_state ?? "verified",
      scoreMultiplier: 1,
      risk: "low",
      reasons: conflictingCompanies.length
        ? [...reasons, `Also mentions peer company while preserving a visible target-company signal: ${conflictingCompanies.join(", ")}.`]
        : reasons,
      conflictingCompanyNames: conflictingCompanies
    };
  }

  if (POST_PLATFORMS_REQUIRING_ENTITY_SIGNAL.has(item.platform)) {
    return {
      reviewState: "needs_review",
      scoreMultiplier: 0,
      risk: "high",
      reasons: [
        `Scored ${item.platform} evidence lacks a visible company, founder, domain, or verified-account signal.`
      ],
      conflictingCompanyNames: conflictingCompanies
    };
  }

  return {
    reviewState: "needs_review",
    scoreMultiplier: 0,
    risk: "medium",
    reasons: ["Attribution is weak: no visible company/founder/domain signal and no verified account match."],
    conflictingCompanyNames: conflictingCompanies
  };
}

export function applyAttributionGuard<T extends EvidenceItem>(
  item: T,
  context: AttributionContext
): T {
  const audit = auditEvidenceAttribution(item, context);
  if (audit.scoreMultiplier > 0 && audit.reviewState === (item.review_state ?? "verified")) {
    return {
      ...item,
      matchReason: appendAttributionReason(item.matchReason, audit),
      why: appendAttributionReason(item.why, audit)
    };
  }

  return {
    ...item,
    contributionScore: Math.round(item.contributionScore * audit.scoreMultiplier),
    review_state: audit.reviewState,
    matchReason: appendAttributionReason(item.matchReason, audit),
    why: appendAttributionReason(item.why, audit)
  };
}

function auditGithubEvidence(
  item: EvidenceItem,
  context: AttributionContext,
  company: AttributionCompanyProfile
): AttributionAuditResult {
  const signals = entitySignals(company);
  const evidenceText = `${visibleEvidenceText(item)} ${identityEvidenceText(item)}`;
  const ownGithubSignal = hasEntitySignal(evidenceText, signals, "github");
  const verifiedAccount = hasVerifiedAccountSignalForCompany(item, signals);

  if (verifiedAccount || ownGithubSignal) {
    return {
      reviewState: item.review_state ?? "verified",
      scoreMultiplier: 1,
      risk: "low",
      reasons: ["GitHub evidence is linked to a target company/founder account, name, handle, or domain."],
      conflictingCompanyNames: []
    };
  }

  return {
    reviewState: "needs_review",
    scoreMultiplier: 0,
    risk: "high",
    reasons: ["GitHub evidence could not be tied to the target company/founder account, name, handle, or domain."],
    conflictingCompanyNames: []
  };
}

function appendAttributionReason(existing: string | undefined, audit: AttributionAuditResult): string {
  const prefix = existing?.trim() ? existing.trim() : "";
  const guardText = `Attribution guard: ${audit.risk} risk; ${audit.reasons.join(" ")}`;
  return prefix.includes("Attribution guard:")
    ? prefix
    : [prefix, guardText].filter(Boolean).join(" ");
}

function hasVerifiedAccountSignalForCompany(item: EvidenceItem, signals: EntitySignals): boolean {
  const handle = normalizeHandle(item.authorHandle ?? item.authorName);
  const accountHandle = handleFromUrl(item.accountUrl);
  const sourceHandle = handleFromUrl(item.sourceUrl);
  const rawAuthorHandle = nativeAuthorHandleFromRawVisibleText(item.rawVisibleText);
  const rawInstagramHandle =
    item.platform === "instagram" ? instagramProfileHandleFromRawVisibleText(item.rawVisibleText) : "";
  const platformHandles = signals.handlesByPlatform[item.platform] ?? new Set<string>();
  const authorBackedHandles = [handle, accountHandle, rawAuthorHandle, rawInstagramHandle].filter(Boolean);
  const candidateHandles = authorBackedHandles.length ? authorBackedHandles : [sourceHandle];

  return candidateHandles
    .some((candidate) => platformHandles.has(candidate));
}

function nativeAuthorHandleFromRawVisibleText(rawVisibleText: string | undefined): string {
  const raw = String(rawVisibleText ?? "");
  if (!raw.trim().startsWith("{")) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeHandle(
      parsed?.post?.author?.screen_name ??
        parsed?.post?.author?.username ??
        parsed?.post?.authorHandle ??
        parsed?.post?.handle ??
        parsed?.author?.screen_name ??
        parsed?.author?.username ??
        parsed?.authorHandle ??
        parsed?.handle ??
        parsed?.username
    );
  } catch {
    return "";
  }
}

function instagramProfileHandleFromRawVisibleText(rawVisibleText: string | undefined): string {
  const raw = String(rawVisibleText ?? "");
  try {
    const parsed = JSON.parse(raw);
    const profileUrl = parsed?.profile?.url;
    const profileUsername = parsed?.profile?.username;
    const rawHref = parsed?.gridUrl?.rawHref ?? parsed?.gridUrl?.href;
    return (
      handleFromUrl(profileUrl) ||
      normalizeHandle(profileUsername) ||
      normalizeHandle(String(rawHref ?? "").match(/instagram\.com\/([^/]+)\/(?:p|reel|tv)\//i)?.[1])
    );
  } catch {
    return (
      normalizeHandle(raw.match(/instagram\.com\/([^/]+)\/(?:p|reel|tv)\//i)?.[1]) ||
      normalizeHandle(raw.match(/"url"\s*:\s*"https?:\/\/(?:www\.)?instagram\.com\/([^"/]+)/i)?.[1])
    );
  }
}

function hasEntitySignal(text: string, signals: EntitySignals, platform: Platform): boolean {
  const normalized = normalizeText(text);
  const platformHandles = signals.handlesByPlatform[platform] ?? new Set<string>();

  return (
    signals.names.some((name) => hasPhrase(normalized, name)) ||
    signals.domains.some((domain) => domain && normalized.includes(domain)) ||
    [...platformHandles].some((handle) => handle && hasHandleSignal(normalized, handle))
  );
}

function hasBatchListCompanySignal(text: string, company: AttributionCompanyProfile): boolean {
  const normalized = normalizeText(text);
  const companyName = normalizeText(company.name);
  if (!companyName || !hasPhrase(normalized, companyName)) {
    return false;
  }

  return /\b(?:yc|y combinator|spring batch|demo day|p26)\b/.test(normalized);
}

function hasVerifiedSnapshotCompanyNameSignalForCompany(
  item: EvidenceItem,
  company: AttributionCompanyProfile,
  text: string
): boolean {
  if ((item.review_state ?? "verified") !== "verified" || !item.sourceUrl || !item.platformPostId) {
    return false;
  }

  const raw = item.rawVisibleText ?? "";
  if (!/"source"\s*:\s*"known_(?:spring_)?snapshot_entity_id"/i.test(raw)) {
    return false;
  }

  const normalized = normalizeText(text);
  const exactNames = [
    company.name,
    company.slug.replace(/-/g, " "),
    compactText(company.name),
    compactText(company.slug)
  ]
    .map(normalizeText)
    .filter(Boolean);

  return [...new Set(exactNames)].some((name) => hasPhrase(normalized, name));
}

function hasValidatedTopVoiceTargetSignalForCompany(
  item: EvidenceItem,
  company: AttributionCompanyProfile,
  text: string
): boolean {
  if ((item.review_state ?? "verified") !== "verified" || !item.sourceUrl || !item.platformPostId) {
    return false;
  }

  const raw = item.rawVisibleText ?? "";
  if (!/"topVoiceAudience"\s*:\s*"(?:yc_partners|insiders)"/i.test(raw)) {
    return false;
  }
  if (!/"status"\s*:\s*"accepted"/i.test(raw)) {
    return false;
  }

  const normalized = normalizeText(text);
  const targetNames = validatedTopVoiceTargetNames(raw, company)
    .map(normalizeText)
    .filter(Boolean);

  return [...new Set(targetNames)].some((name) => hasPhrase(normalized, name));
}

function validatedTopVoiceTargetNames(
  rawVisibleText: string,
  company: AttributionCompanyProfile
): string[] {
  try {
    const parsed = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const target = recordValue(parsed.target);
    return [
      typeof target?.companyName === "string" ? target.companyName : null,
      typeof target?.companySlug === "string" ? target.companySlug.replace(/-/g, " ") : null,
      company.name,
      company.slug.replace(/-/g, " ")
    ].filter((value): value is string => Boolean(value));
  } catch {
    return [company.name, company.slug.replace(/-/g, " ")];
  }
}

function conflictingCompanyMatches(
  text: string,
  context: AttributionContext,
  ownCompany: AttributionCompanyProfile
): string[] {
  const normalized = normalizeText(text);
  const matches: string[] = [];

  for (const company of context.allCompanies) {
    if (company.id === ownCompany.id) continue;
    const signals = entitySignals(company);
    if (
      distinctiveConflictNames(company).some((name) => hasPhrase(normalized, name)) ||
      signals.domains.some((domain) => domain && normalized.includes(domain)) ||
      hasVisibleHandleSignal(text, signals)
    ) {
      matches.push(company.name);
    }
  }

  return [...new Set(matches)].slice(0, 8);
}

function entitySignals(company: AttributionCompanyProfile): EntitySignals {
  const handlesByPlatform: Partial<Record<Platform, Set<string>>> = {};
  const socialLinks = [...company.socialLinks, ...company.founders.flatMap((founder) => founder.socialLinks)];

  for (const link of socialLinks) {
    const handle = handleFromUrl(link.url);
    if (!handle) continue;
    handlesByPlatform[link.platform] ??= new Set<string>();
    handlesByPlatform[link.platform]?.add(handle);
  }

  return {
    company,
    names: [...new Set([...distinctiveCompanyNames(company), ...company.founders.map((founder) => normalizeText(founder.name))])],
    domains: [...new Set([company.websiteUrl, ...company.socialLinks.map((link) => link.url)].map(domainFromUrl).filter(Boolean))],
    handlesByPlatform
  };
}

function distinctiveCompanyNames(company: AttributionCompanyProfile): string[] {
  const normalizedName = normalizeText(company.name);
  const slugName = normalizeText(company.slug.replace(/-/g, " "));
  const compactName = compactText(company.name);
  const compactSlug = compactText(company.slug);
  const names = [normalizedName, slugName, compactName, compactSlug].filter(Boolean);

  return [...new Set(names)].filter((name) => {
    const tokenCount = name.split(" ").filter(Boolean).length;
    return tokenCount > 1 || (name.length >= 5 && !GENERIC_SINGLE_WORD_NAMES.has(name));
  });
}

function distinctiveConflictNames(company: AttributionCompanyProfile): string[] {
  return distinctiveCompanyNames(company).filter((name) => {
    const tokenCount = name.split(" ").filter(Boolean).length;
    return tokenCount > 1 || !GENERIC_SINGLE_WORD_NAMES.has(name);
  });
}

function visibleEvidenceText(item: EvidenceItem): string {
  return [
    item.title,
    item.text,
    extractVisibleBodyText(item.rawVisibleText)
  ]
    .filter(Boolean)
    .join(" ");
}

function identityEvidenceText(item: EvidenceItem): string {
  return [
    item.authorName,
    item.authorHandle,
    item.matchReason,
    item.why
  ]
    .filter(Boolean)
    .join(" ");
}

function extractVisibleBodyText(rawVisibleText: string | undefined): string {
  if (!rawVisibleText) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawVisibleText);
    const post = recordValue(parsed.post);
    const detail = recordValue(parsed.detail);
    const quotedPost = recordValue(parsed.quotedPost);
    const quote = recordValue(post?.quote);
    const rawText = recordValue(post?.raw_text);
    return [
      parsed.text,
      parsed.caption,
      parsed.title,
      parsed.story_text,
      parsed.description,
      parsed.full_text,
      post?.rawText,
      post?.text,
      post?.caption,
      post?.quote_text,
      rawText?.text,
      quote?.rawText,
      quote?.text,
      quote?.authorName,
      quote?.authorHandle,
      quote?.authorDescription,
      quote?.authorWebsite,
      detail?.rawText,
      detail?.text,
      detail?.caption,
      quotedPost?.rawText,
      quotedPost?.text
    ]
      .filter(Boolean)
      .join(" ");
  } catch {
    return rawVisibleText;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function sourceUrlMatchesOwnDomain(item: EvidenceItem, signals: EntitySignals): boolean {
  const domain = domainFromUrl(item.sourceUrl);
  if (!domain || SOCIAL_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`))) {
    return false;
  }

  return signals.domains.some((ownDomain) => ownDomain && (domain === ownDomain || domain.endsWith(`.${ownDomain}`)));
}

function hasVisibleHandleSignal(rawText: string, signals: EntitySignals): boolean {
  const handles = Object.values(signals.handlesByPlatform).flatMap((set) => [...(set ?? [])]);
  const normalizedRaw = String(rawText ?? "").toLowerCase();

  return handles.some((handle) => {
    if (!handle || handle.length < 4) return false;
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      new RegExp(`(^|[^a-z0-9])@${escaped}([^a-z0-9]|$)`, "i").test(normalizedRaw) ||
      new RegExp(`(?:x|twitter|instagram|linkedin|github)\\.com/${escaped}(?:[/\"'\\s?#]|$)`, "i").test(normalizedRaw)
    );
  });
}

function hasClearOffTopicContext(text: string): boolean {
  const normalized = normalizeText(text);
  return /\b(3 idiots|algorithm wants|barista|coffee shop|gym|hoop|marina theater|milk|movie|movies|restaurant|subtitles|theater|theatre|vacation|wedding)\b/i.test(
    normalized
  );
}

function hasPhrase(normalizedText: string, normalizedPhrase: string): boolean {
  if (!normalizedPhrase) return false;
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedText);
}

function hasHandleSignal(normalizedText: string, normalizedHandle: string): boolean {
  const handle = normalizeText(normalizedHandle);
  if (!handle || handle.length < 4) {
    return false;
  }
  return hasPhrase(normalizedText, handle);
}

function domainFromUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function handleFromUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    if (isPlatformHost(hostname, ["github.com"])) return normalizeHandle(parts[0]);
    if (isPlatformHost(hostname, ["instagram.com"])) return normalizeHandle(parts[0]);
    if (isPlatformHost(hostname, ["x.com", "twitter.com"])) return normalizeHandle(parts[0]);
    if (isPlatformHost(hostname, ["linkedin.com"])) return normalizeHandle(parts.at(-1));
  } catch {
    return "";
  }

  return "";
}

function isPlatformHost(hostname: string, roots: string[]): boolean {
  return roots.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

function normalizeHandle(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
