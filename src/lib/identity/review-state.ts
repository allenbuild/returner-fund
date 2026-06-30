import type { EntityRef, Platform, ProfileCandidate, ReviewReason, ReviewState } from "@/types/domain";
import type {
  IdentityCandidate,
  IdentityReviewOptions,
  IdentityReviewResult,
  IdentityEntity,
  IdentitySignalContribution
} from "./types";

export interface CandidateInput {
  platform: Platform;
  handle: string | null;
  url: string;
  accountId?: string | null;
  discoveredFromUrl?: string | null;
  review_state?: ReviewState;
  signals: {
    exactCompanyName?: boolean;
    exactFounderName?: boolean;
    linkedFromOfficialWebsite?: boolean;
    bioMentionsCompany?: boolean;
    bioMentionsYC?: boolean;
    domainMatch?: boolean;
    founderRoleMatch?: boolean;
    batchContextMatch?: boolean;
    verifiedAccount?: boolean;
    recentActivity?: boolean;
  };
  evidence?: Record<string, unknown>;
}

const SIGNAL_WEIGHTS: Record<keyof CandidateInput["signals"], number> = {
  exactCompanyName: 0.16,
  exactFounderName: 0.16,
  linkedFromOfficialWebsite: 0.22,
  bioMentionsCompany: 0.12,
  bioMentionsYC: 0.08,
  domainMatch: 0.12,
  founderRoleMatch: 0.08,
  batchContextMatch: 0.04,
  verifiedAccount: 0.06,
  recentActivity: 0.04
};

export function scoreProfileCandidate(entity: EntityRef, input: CandidateInput): ProfileCandidate {
  const reasons: ReviewReason[] = Object.keys(SIGNAL_WEIGHTS).map((signal) => {
    const key = signal as keyof CandidateInput["signals"];
    const matched = Boolean(input.signals[key]);
    return {
      signal,
      matched,
      explanation: matched
        ? `${signal} matched for ${entity.name}.`
        : `${signal} was not available or did not match.`
    };
  });
  const review_state = input.review_state ?? reviewStateFromSignals(input.signals);
  return {
    platform: input.platform,
    handle: input.handle,
    url: input.url,
    accountId: input.accountId ?? null,
    review_state,
    reasons,
    discoveredFromUrl: input.discoveredFromUrl,
    evidence: {
      entity,
      matchedSignals: reasons.filter((reason) => reason.matched).map((reason) => reason.signal),
      reviewRule: "Verified only when official-site, exact-identity, or same-domain signals make the profile unambiguous.",
      ...(input.evidence ?? {})
    }
  };
}

export function explainCandidate(candidate: ProfileCandidate): string {
  const matched = candidate.reasons
    .filter((reason) => reason.matched)
    .map((reason) => reason.signal)
    .join(", ");
  const missing = candidate.reasons
    .filter((reason) => !reason.matched)
    .slice(0, 3)
    .map((reason) => reason.signal)
    .join(", ");
  return `Review state ${candidate.review_state}. Matched: ${
    matched || "none"
  }. Missing/weak: ${missing || "none"}.`;
}

const IDENTITY_SIGNAL_WEIGHTS = {
  exact_company_name: "strong",
  exact_founder_name: "strong",
  found_on_official_site: "strong",
  bio_mentions_company: "supporting",
  bio_mentions_yc: "supporting",
  website_domain_match: "strong",
  founder_role_match: "supporting",
  batch_context_match: "supporting",
  verified_account: "supporting",
  recent_activity: "supporting"
} as const;

export type ScoredIdentityCandidate = IdentityCandidate & IdentityReviewResult;

export function scoreIdentityCandidate(
  entity: IdentityEntity,
  candidate: IdentityCandidate,
  options: IdentityReviewOptions = {}
): ScoredIdentityCandidate {
  const contributions = identityContributions(entity, candidate, options);
  const matchedSignals = contributions.filter((contribution) => contribution.matched).map((contribution) => contribution.signal);
  const review_state = resolveReviewState(candidate.review_state ?? null, contributions);
  const limitations =
    review_state === "needs_review"
      ? ["Candidate is plausible but lacks an unambiguous verified-profile rule; keep it in needs_review."]
      : review_state === "rejected"
        ? ["Candidate was explicitly rejected and must not feed canonical scoring."]
        : [];

  return {
    ...candidate,
    review_state,
    canonical: review_state === "verified",
    reasons: contributions
      .filter((contribution) => contribution.matched)
      .map((contribution) => contribution.reason),
    explanationJson: {
      entity,
      candidate,
      policy:
        "Only verified, official-site, exact-name plus domain, or exact-name plus YC/company context matches are canonical.",
      contributions,
      matchedSignals,
      limitations
    }
  };
}

export function rankIdentityCandidates(
  entity: IdentityEntity,
  candidates: IdentityCandidate[],
  options: IdentityReviewOptions = {}
): ScoredIdentityCandidate[] {
  return candidates
    .map((candidate) => scoreIdentityCandidate(entity, candidate, options))
    .sort((a, b) => rankCandidate(b) - rankCandidate(a) || a.url.localeCompare(b.url));
}

function resolveReviewState(
  explicitState: ReviewState | null,
  contributions: IdentitySignalContribution[]
): ReviewState {
  if (explicitState === "rejected") {
    return "rejected";
  }

  if (explicitState === "verified") {
    return "verified";
  }

  if (isVerifiedByRule(contributions)) {
    return "verified";
  }

  return "needs_review";
}

function identityContributions(
  entity: IdentityEntity,
  candidate: IdentityCandidate,
  options: IdentityReviewOptions
): IdentitySignalContribution[] {
  const bio = candidate.bio ?? "";
  const companyName = entity.companyName ?? (entity.type === "company" ? entity.name : null);

  const matches: Record<keyof typeof IDENTITY_SIGNAL_WEIGHTS, boolean> = {
    exact_company_name:
      entity.type === "company" &&
      (normalizedEquals(candidate.displayName, entity.name) || normalizedEquals(candidate.handle, entity.name)),
    exact_founder_name:
      entity.type === "founder" &&
      (normalizedEquals(candidate.displayName, entity.name) || normalizedEquals(candidate.handle, entity.name)),
    found_on_official_site: candidate.foundOnOfficialSite === true,
    bio_mentions_company: Boolean(companyName && normalizedIncludes(bio, companyName)),
    bio_mentions_yc: /\bYC\b|Y\s*Combinator/i.test(bio),
    website_domain_match: sameDomain(entity.websiteUrl, candidate.websiteUrl),
    founder_role_match: entity.type === "founder" && /\bfounder\b|\bco-founder\b/i.test(bio),
    batch_context_match: Boolean(entity.batchSlug && normalizedIncludes(bio, entity.batchSlug)),
    verified_account: candidate.verified === true,
    recent_activity: hasRecentActivity(candidate.recentActivityAt, options.now)
  };

  return Object.entries(IDENTITY_SIGNAL_WEIGHTS).map(([signal, category]) => {
    const key = signal as keyof typeof IDENTITY_SIGNAL_WEIGHTS;
    const matched = matches[key];
    return {
      signal,
      category,
      matched,
      reason: matched ? `${signal} matched.` : `${signal} did not match or was unavailable.`
    };
  });
}

function reviewStateFromSignals(signals: CandidateInput["signals"]): ReviewState {
  if (
    signals.linkedFromOfficialWebsite ||
    (signals.exactCompanyName && signals.domainMatch) ||
    (signals.exactFounderName && signals.founderRoleMatch && signals.bioMentionsCompany)
  ) {
    return "verified";
  }

  return "needs_review";
}

function isVerifiedByRule(contributions: IdentitySignalContribution[]): boolean {
  const matched = new Set(
    contributions.filter((contribution) => contribution.matched).map((contribution) => contribution.signal)
  );

  return (
    matched.has("found_on_official_site") ||
    (matched.has("exact_company_name") && matched.has("website_domain_match")) ||
    (matched.has("exact_founder_name") &&
      matched.has("founder_role_match") &&
      (matched.has("bio_mentions_company") || matched.has("website_domain_match"))) ||
    (matched.has("exact_founder_name") && matched.has("bio_mentions_yc") && matched.has("batch_context_match"))
  );
}

function rankCandidate(candidate: ScoredIdentityCandidate): number {
  const stateRank: Record<ReviewState, number> = {
    verified: 3,
    needs_review: 2,
    rejected: 1
  };
  const matchedSignals = candidate.explanationJson.matchedSignals.length;
  const officialSiteBonus = candidate.explanationJson.matchedSignals.includes("found_on_official_site") ? 4 : 0;

  return stateRank[candidate.review_state] * 100 + officialSiteBonus + matchedSignals;
}

function normalizedEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeIdentityText(left);
  const normalizedRight = normalizeIdentityText(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function normalizedIncludes(text: string | null | undefined, expected: string | null | undefined): boolean {
  const normalizedText = normalizeIdentityText(text);
  const normalizedExpected = normalizeIdentityText(expected);
  return Boolean(normalizedText && normalizedExpected && normalizedText.includes(normalizedExpected));
}

function normalizeIdentityText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameDomain(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftDomain = hostname(left);
  const rightDomain = hostname(right);
  return Boolean(leftDomain && rightDomain && leftDomain === rightDomain);
}

function hostname(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hasRecentActivity(activityAt: string | Date | null | undefined, nowInput: string | Date | undefined): boolean {
  if (!activityAt) {
    return false;
  }

  const activity = new Date(activityAt).getTime();
  const now = nowInput ? new Date(nowInput).getTime() : Date.now();
  if (!Number.isFinite(activity) || !Number.isFinite(now)) {
    return false;
  }

  const ageDays = (now - activity) / (1000 * 60 * 60 * 24);
  return ageDays >= 0 && ageDays <= 90;
}
