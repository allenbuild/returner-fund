import { createHash } from "node:crypto";
import type { TimelineCategory } from "./contracts";
import type { TimelineFieldConflict } from "./domain";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it",
  "of", "on", "or", "our", "the", "their", "this", "to", "we", "with",
]);

export interface TimelineMergeIdentity {
  id?: string;
  companyId: string;
  category: TimelineCategory;
  eventDate: string;
  title: string;
  sourceIds?: readonly string[];
  sourceUrls?: readonly string[];
  namedEntities?: readonly string[];
}

export interface TimelineFieldClaim {
  field: string;
  value: string;
  sourceId: string;
  sourceQualityTier: 1 | 2 | 3;
}

export function buildTimelineMergeKey(input: TimelineMergeIdentity): string {
  const signature = materialSignature(input.title);
  const entityTokens = (input.namedEntities ?? []).map(normalizePhrase).filter(Boolean).sort();
  const titleTokens = normalizedTitleTokens(input.title).slice(0, 12);
  const payload = [
    input.companyId,
    input.category,
    input.eventDate,
    signature.round ?? "",
    signature.amount ?? "",
    signature.version ?? "",
    signature.milestone ?? "",
    ...entityTokens,
    ...titleTokens,
  ].join("|");
  return `${input.category}-${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

export function shouldMergeTimelineEvents(left: TimelineMergeIdentity, right: TimelineMergeIdentity): boolean {
  if (left.companyId !== right.companyId || !compatibleCategories(left.category, right.category)) return false;
  if (left.id && right.id && left.id === right.id) return true;
  if ((left.sourceIds ?? []).some((sourceId) => (right.sourceIds ?? []).includes(sourceId))) return true;
  if (shareCanonicalSourceUrl(left.sourceUrls, right.sourceUrls)) return true;

  const leftSignature = materialSignature(left.title);
  const rightSignature = materialSignature(right.title);
  for (const field of ["round", "amount", "version", "milestone", "namedCounterparty"] as const) {
    if (leftSignature[field] && rightSignature[field] && leftSignature[field] !== rightSignature[field]) return false;
  }

  const leftEntities = eventIdentityKeys(left);
  const rightEntities = eventIdentityKeys(right);
  const sharedEntity = [...leftEntities].some((entity) => rightEntities.has(entity));
  // Named products, capabilities, rounds and counterparties are hard event
  // boundaries. Company/action words alone must not merge Autosuggest with
  // AraBrowser, a base product with Backend Branching, or a launch with a
  // later feature release.
  if (leftEntities.size && rightEntities.size && !sharedEntity) return false;

  const dayDistance = Math.abs(Date.parse(`${left.eventDate}T00:00:00Z`) - Date.parse(`${right.eventDate}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(dayDistance)) return false;

  // Launch HN/Product Hunt/YC pages and launch videos can follow the original
  // company announcement by weeks. Merge those late syndications only when a
  // strong root-product or named-product identity agrees. A bounded window
  // avoids folding a later relaunch into an old event indefinitely.
  if (dayDistance > 14) {
    return dayDistance <= 120
      && left.category === "product_launch"
      && right.category === "product_launch"
      && sharedEntity
      && (isLaunchSyndicationTitle(left.title) || isLaunchSyndicationTitle(right.title));
  }
  if (dayDistance > 3 && !["product_launch", "funding", "accelerator"].includes(left.category)) return false;

  if (sharedEntity) return true;

  const leftTokens = new Set(normalizedTitleTokens(left.title));
  const rightTokens = new Set(normalizedTitleTokens(right.title));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return dayDistance <= 3 && union > 0 && intersection / union >= 0.7;
}

function isLaunchSyndicationTitle(value: string): boolean {
  return /\b(?:launched on (?:product hunt|hacker news|y combinator)|launched a new product|announced its public launch|published its launch video|became publicly available|was introduced)\b/i.test(value);
}

export function clusterTimelineEvents<T extends TimelineMergeIdentity>(events: readonly T[]): T[][] {
  const ordered = [...events].sort((left, right) =>
    left.eventDate.localeCompare(right.eventDate) || left.category.localeCompare(right.category)
    || left.title.localeCompare(right.title) || (left.id ?? "").localeCompare(right.id ?? "")
  );
  const clusters: T[][] = [];
  for (const event of ordered) {
    // Complete-link admission prevents transitive bridges: A may match a
    // generic launch source and B may match that source, but A and B must also
    // describe the same event before all three can share one public card.
    const cluster = clusters.find((items) => items.every((item) => shouldMergeTimelineEvents(item, event)));
    if (cluster) cluster.push(event);
    else clusters.push([event]);
  }
  return clusters;
}

export function detectTimelineFieldConflicts(claims: readonly TimelineFieldClaim[]): TimelineFieldConflict[] {
  const byField = new Map<string, TimelineFieldClaim[]>();
  for (const claim of claims) byField.set(claim.field, [...(byField.get(claim.field) ?? []), claim]);
  const conflicts: TimelineFieldConflict[] = [];
  for (const [field, fieldClaims] of [...byField.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const distinct = new Map<string, TimelineFieldClaim[]>();
    for (const claim of fieldClaims) {
      const normalized = normalizeClaimValue(claim.value);
      distinct.set(normalized, [...(distinct.get(normalized) ?? []), claim]);
    }
    if (distinct.size <= 1) continue;
    const selected = [...fieldClaims].sort((left, right) =>
      left.sourceQualityTier - right.sourceQualityTier || left.sourceId.localeCompare(right.sourceId)
    )[0] ?? null;
    conflicts.push({
      field,
      selectedValue: selected?.value ?? null,
      claims: fieldClaims.map((claim) => ({
        value: claim.value,
        sourceId: claim.sourceId,
        sourceQualityTier: claim.sourceQualityTier,
      })),
      description: `Sources disagree on ${field.replaceAll("_", " ")}.`,
    });
  }
  return conflicts;
}

function materialSignature(title: string) {
  const normalized = normalizePhrase(title);
  return {
    round: normalized.match(/\b(pre seed|seed|series [a-z]|growth)\b/)?.[1] ?? null,
    amount: normalized.match(/(?:\$|usd )\s*([\d.]+\s*(?:k|m|b|million|billion)?)/)?.[1]?.replaceAll(" ", "") ?? null,
    version: normalized.match(/\b(?:v|version )([0-9]+(?:\.[0-9]+)+)\b/)?.[1] ?? null,
    milestone: normalized.match(/\b([\d.]+\s*(?:k|m|b|million|billion)?\s*(?:arr|mrr|users|customers|downloads|stars))\b/)?.[1]?.replaceAll(" ", "") ?? null,
    namedCounterparty: normalized.match(/\b(?:with|by|for) ([a-z][a-z0-9 &.-]{2,48})/)?.[1]?.trim() ?? null,
  };
}

function compatibleCategories(left: TimelineCategory, right: TimelineCategory) {
  if (left === right) return true;
  return (left === "open_source" && right === "github") || (left === "github" && right === "open_source");
}

function eventIdentityKeys(input: TimelineMergeIdentity): Set<string> {
  const keys = new Set((input.namedEntities ?? []).map(normalizePhrase).filter(Boolean));
  const derived = titleEventIdentity(input.title);
  if (derived) keys.add(derived);
  return keys;
}

function titleEventIdentity(title: string): string | null {
  const normalized = normalizePhrase(title);
  if (!normalized) return null;
  if (isLaunchSyndicationTitle(title)) return "root-product";

  const action = normalized.match(/^(.+?)\s+(?:released|launched|introduced|shipped|added|enabled)\s+(.+)$/);
  if (!action) return null;
  const company = action[1]!.trim();
  let subject = action[2]!
    .replace(/\s+on\s+(?:product hunt|hacker news|y combinator)$/, "")
    .replace(/^(?:we\s+)?(?:just\s+)?(?:released|launched|introduced|shipped)\s+/, "")
    .replace(/\s+(?:launch|launch video)$/, "")
    .trim();
  if (!subject || subject === company) return "root-product";
  if (subject.startsWith(`${company} `)) subject = subject.slice(company.length + 1).trim();
  return subject && subject !== company ? `subject:${subject}` : "root-product";
}

function shareCanonicalSourceUrl(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left?.length || !right?.length) return false;
  const rightUrls = new Set(right.map(canonicalSourceIdentity).filter(Boolean));
  return left.some((url) => {
    const identity = canonicalSourceIdentity(url);
    return Boolean(identity && rightUrls.has(identity));
  });
}

function canonicalSourceIdentity(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/^twitter\.com$/, "x.com");
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${hostname}${pathname}`;
  } catch {
    return null;
  }
}

function normalizedTitleTokens(value: string): string[] {
  return [...new Set(normalizePhrase(value).split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token)))].sort();
}

function normalizePhrase(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/,(?=\d)/g, "")
    .replace(/[^a-z0-9$%.]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeClaimValue(value: string): string {
  return normalizePhrase(value).replace(/,/g, "");
}
