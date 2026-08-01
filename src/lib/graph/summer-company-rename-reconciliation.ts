import aliasLedgerJson from "@/lib/yc/summer-2026-company-aliases.json";

type LegacyPlatform = "github" | "instagram" | "linkedin" | "x" | "youtube";

interface AliasFounder {
  founderId: string;
  name: string;
  toName?: string;
  accounts: Partial<Record<LegacyPlatform, string[]>>;
}

interface AliasEntry {
  companyId: string;
  fromSlug: string;
  fromName: string;
  toSlug: string;
  toName: string;
  companyAccounts: Partial<Record<LegacyPlatform, string[]>>;
  founders: AliasFounder[];
}

interface AliasLedger {
  version: number;
  aliases: AliasEntry[];
}

export interface LegacySummerEvidenceRow {
  id?: string;
  batchSlug?: string;
  batch_slug?: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  attachedCompanyId?: string | null;
  companySlug?: string;
  companyName?: string;
  platform?: string;
  sourceUrl?: string;
  candidateUrl?: string;
  platformPostId?: string | null;
  postId?: string | null;
  accountUrl?: string | null;
  authorHandle?: string | null;
  authorName?: string | null;
  title?: string;
  text?: string;
  rawVisibleText?: string;
  githubUrl?: string;
}

export type LegacySummerEvidenceDecision<T> =
  | { status: "not_legacy"; row: T }
  | { status: "remapped"; row: T; alias: AliasEntry; physicalId: string }
  | {
      status: "quarantined";
      row: T;
      alias: AliasEntry;
      reason:
        | "batch_scope_mismatch"
        | "embedded_linkedin_body_mismatch"
        | "legacy_entity_identity_mismatch"
        | "missing_stable_native_physical_id"
        | "owner_account_lineage_mismatch"
        | "synthetic_linkedin_profile_fragment"
        | "unsupported_platform";
    };

export const SUMMER_COMPANY_ALIAS_LEDGER = aliasLedgerJson as AliasLedger;

/**
 * Reconciles a historical company name only when the evidence itself proves
 * both a native physical post and an immutable catalog owner. A rename string
 * match alone is intentionally insufficient.
 */
export function reconcileLegacySummerEvidenceEntity<
  T extends LegacySummerEvidenceRow
>(row: T): LegacySummerEvidenceDecision<T> {
  const alias = legacyAliasForRow(row);
  if (!alias) return { status: "not_legacy", row };

  const batchSlug = clean(row.batchSlug ?? row.batch_slug);
  if (batchSlug && batchSlug.toUpperCase() !== "S26") {
    return { status: "quarantined", row, alias, reason: "batch_scope_mismatch" };
  }

  const owner = legacyOwner(row, alias);
  if (!owner) {
    return { status: "quarantined", row, alias, reason: "legacy_entity_identity_mismatch" };
  }

  const platform = normalizedPlatform(row);
  if (!platform) {
    return { status: "quarantined", row, alias, reason: "unsupported_platform" };
  }

  const sourceUrl = clean(row.sourceUrl ?? row.candidateUrl);
  if (platform === "linkedin" && isSyntheticLinkedInProfileFragment(sourceUrl)) {
    return { status: "quarantined", row, alias, reason: "synthetic_linkedin_profile_fragment" };
  }

  const physicalId = stablePhysicalId(row, platform);
  if (!physicalId) {
    return { status: "quarantined", row, alias, reason: "missing_stable_native_physical_id" };
  }

  if (platform === "linkedin" && hasEmbeddedLinkedInBodyMismatch(row)) {
    return { status: "quarantined", row, alias, reason: "embedded_linkedin_body_mismatch" };
  }

  if (!rowMatchesOwnerLineage(row, platform, owner)) {
    return { status: "quarantined", row, alias, reason: "owner_account_lineage_mismatch" };
  }

  return {
    status: "remapped",
    row: remapLegacyEntity(row, alias, owner),
    alias,
    physicalId
  };
}

/**
 * GitHub account snapshots are account-level inputs that are expanded into
 * physical repository evidence later. They use the same immutable alias
 * ledger but require an exact historical organization URL.
 */
export function reconcileLegacySummerGithubAccount<
  T extends LegacySummerEvidenceRow
>(row: T): T {
  const alias = legacyAliasForRow(row);
  if (!alias) return row;
  const owner = legacyOwner(row, alias);
  if (!owner || normalizedPlatform(row) !== "github") return row;
  if (!rowMatchesOwnerLineage(row, "github", owner)) return row;
  return remapLegacyEntity(row, alias, owner);
}

function legacyAliasForRow(row: LegacySummerEvidenceRow): AliasEntry | null {
  const slug = clean(row.companySlug).toLowerCase();
  const name = clean(row.companyName);
  const entityId = clean(row.entityId);
  return (
    SUMMER_COMPANY_ALIAS_LEDGER.aliases.find(
      (candidate) => {
        const slugChanged = candidate.fromSlug !== candidate.toSlug;
        const matchesLegacySlug =
          slug === candidate.fromSlug ||
          entityId === `company-${candidate.fromSlug}` ||
          entityId.startsWith(`founder-${candidate.fromSlug}-`);
        const matchesFormerName =
          name === candidate.fromName &&
          (!slug || slug === candidate.fromSlug) &&
          (!entityId ||
            entityId === `company-${candidate.fromSlug}` ||
            entityId.startsWith(`founder-${candidate.fromSlug}-`));
        // A name-only change retains the live slug/entity ID, so matching on
        // that mutable slug alone would incorrectly classify current rows as
        // legacy forever. Require the former name for those transitions.
        return (slugChanged && matchesLegacySlug) || matchesFormerName;
      }
    ) ?? null
  );
}

function legacyOwner(
  row: LegacySummerEvidenceRow,
  alias: AliasEntry
): { kind: "company"; accounts: AliasEntry["companyAccounts"] } | {
  kind: "founder";
  founder: AliasFounder;
  accounts: AliasFounder["accounts"];
} | null {
  const entityType = clean(row.entityType);
  const entityId = clean(row.entityId);
  if (entityType === "company" && entityId === `company-${alias.fromSlug}`) {
    return { kind: "company", accounts: alias.companyAccounts };
  }
  if (entityType !== "founder") return null;

  const founder = alias.founders.find(
    (candidate) =>
      entityId === `founder-${alias.fromSlug}-${slugify(candidate.name)}-${candidate.founderId}`
  );
  return founder ? { kind: "founder", founder, accounts: founder.accounts } : null;
}

function normalizedPlatform(row: LegacySummerEvidenceRow): LegacyPlatform | null {
  const explicit = clean(row.platform).toLowerCase();
  if (["github", "instagram", "linkedin", "x", "youtube"].includes(explicit)) {
    return explicit as LegacyPlatform;
  }
  if (row.githubUrl) return "github";
  return null;
}

function stablePhysicalId(
  row: LegacySummerEvidenceRow,
  platform: LegacyPlatform
): string | null {
  const sourceUrl = clean(row.sourceUrl ?? row.candidateUrl);
  const explicitId = clean(row.platformPostId ?? row.postId);
  if (platform === "x") {
    const urlId = sourceUrl.match(/\/status\/(\d+)(?:[/?#]|$)/i)?.[1] ?? "";
    return urlId && (!explicitId || explicitId === urlId) ? `x:${urlId}` : null;
  }
  if (platform === "linkedin") {
    const activityId =
      sourceUrl.match(/urn:li:activity:(\d+)/i)?.[1] ??
      sourceUrl.match(/activity-(\d+)/i)?.[1] ??
      "";
    return activityId && (!explicitId || explicitId === activityId)
      ? `linkedin:${activityId}`
      : null;
  }
  if (platform === "instagram") {
    const shortcode = sourceUrl.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1] ?? "";
    return shortcode && (!explicitId || explicitId === shortcode)
      ? `instagram:${shortcode}`
      : null;
  }
  if (platform === "youtube") {
    const videoId =
      sourceUrl.match(/[?&]v=([A-Za-z0-9_-]{6,})/)?.[1] ??
      sourceUrl.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/)?.[1] ??
      "";
    return videoId && (!explicitId || explicitId === videoId) ? `youtube:${videoId}` : null;
  }
  return null;
}

function isSyntheticLinkedInProfileFragment(sourceUrl: string): boolean {
  return /linkedin\.com\/in\/[^/?#]+\/recent-activity\/all\/?#post-\d+(?:$|[/?#])/i.test(
    sourceUrl
  );
}

function hasEmbeddedLinkedInBodyMismatch(row: LegacySummerEvidenceRow): boolean {
  const raw = clean(row.rawVisibleText);
  const text = clean(row.text);
  if (!raw || !text) return false;

  // Two independently rendered public-visibility headers mean the captured
  // body belongs to a nested/embedded post rather than the outer founder card.
  const publicHeaderCount =
    raw.match(/Visible to anyone on or off LinkedIn\s+Follow/gi)?.length ?? 0;
  if (publicHeaderCount < 2) return false;

  const normalizedRaw = normalizedText(raw);
  const bodyPrefix = normalizedText(text).slice(0, 80);
  if (!bodyPrefix) return true;
  const bodyIndex = normalizedRaw.indexOf(bodyPrefix);
  if (bodyIndex < 0) return true;
  const prefix = normalizedRaw.slice(0, bodyIndex);
  return (prefix.match(/visible to anyone on or off linkedin follow/g)?.length ?? 0) >= 2;
}

function rowMatchesOwnerLineage(
  row: LegacySummerEvidenceRow,
  platform: LegacyPlatform,
  owner: { accounts: Partial<Record<LegacyPlatform, string[]>> } & (
    | { kind: "company" }
    | { kind: "founder"; founder: AliasFounder }
  )
): boolean {
  const expected = new Set(
    (owner.accounts[platform] ?? []).map((url) => canonicalAccountIdentity(platform, url))
  );
  if (expected.size === 0) return false;

  const candidates = [
    row.accountUrl,
    row.githubUrl,
    row.authorHandle,
    accountUrlFromSource(platform, clean(row.sourceUrl ?? row.candidateUrl))
  ]
    .map((value) => canonicalAccountIdentity(platform, clean(value)))
    .filter(Boolean);

  if (candidates.some((candidate) => expected.has(candidate))) return true;

  // Stable LinkedIn activity permalinks omit the profile. In that case the
  // outer visible card must identify the exact immutable founder.
  if (platform === "linkedin" && owner.kind === "founder") {
    const raw = normalizedText(clean(row.rawVisibleText));
    const founderName = normalizedText(owner.founder.name);
    return raw.startsWith(`feed post number 1 ${founderName} `);
  }

  return false;
}

function accountUrlFromSource(platform: LegacyPlatform, sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (platform === "x" && parts[0]) return `https://x.com/${parts[0]}`;
    if (platform === "github" && parts[0]) return `https://github.com/${parts[0]}`;
    if (platform === "linkedin" && ["in", "company"].includes(parts[0]) && parts[1]) {
      return `https://www.linkedin.com/${parts[0]}/${parts[1]}`;
    }
  } catch {
    return "";
  }
  return "";
}

function canonicalAccountIdentity(platform: LegacyPlatform, value: string): string {
  if (!value) return "";
  const handle = value.startsWith("@") ? value.slice(1) : "";
  if (handle) return `${platform}:${handle.toLowerCase()}`;
  try {
    const parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (platform === "x") return parts[0] ? `x:${parts[0].toLowerCase()}` : "";
    if (platform === "github") return parts[0] ? `github:${parts[0].toLowerCase()}` : "";
    if (platform === "linkedin" && ["in", "company"].includes(parts[0]) && parts[1]) {
      return `linkedin:${parts[0]}:${parts[1].toLowerCase()}`;
    }
    if (platform === "instagram") {
      return parts[0] ? `instagram:${parts[0].toLowerCase()}` : "";
    }
    if (platform === "youtube") {
      return parts[0] ? `youtube:${parts[0].toLowerCase()}` : "";
    }
  } catch {
    return "";
  }
  return "";
}

function remapLegacyEntity<
  T extends LegacySummerEvidenceRow
>(
  row: T,
  alias: AliasEntry,
  owner: ReturnType<typeof legacyOwner> & {}
): T {
  const terminal = terminalAlias(alias);
  const founderName =
    owner.kind === "founder"
      ? terminalFounderName(alias, owner.founder.founderId, owner.founder.name)
      : "";
  const entityId =
    owner.kind === "company"
      ? `company-${terminal.toSlug}`
      : `founder-${terminal.toSlug}-${slugify(founderName)}-${owner.founder.founderId}`;
  return {
    ...row,
    entityId,
    companySlug: terminal.toSlug,
    companyName: terminal.toName,
    ...(row.entityName === alias.fromName ? { entityName: terminal.toName } : {}),
    ...(row.attachedCompanyId === `company-${alias.fromSlug}`
      ? { attachedCompanyId: `company-${terminal.toSlug}` }
      : {})
  };
}

function terminalAlias(initial: AliasEntry): AliasEntry {
  let current = initial;
  const seen = new Set<string>();
  while (true) {
    const state = `${current.companyId}\u0000${current.toSlug}\u0000${current.toName}`;
    if (seen.has(state)) return current;
    seen.add(state);
    const next = SUMMER_COMPANY_ALIAS_LEDGER.aliases.find(
      (candidate) =>
        candidate.companyId === current.companyId &&
        candidate.fromSlug === current.toSlug &&
        candidate.fromName === current.toName
    );
    if (!next) return current;
    current = next;
  }
}

function terminalFounderName(initial: AliasEntry, founderId: string, initialName: string): string {
  let name = initialName;
  let current = initial;
  const seen = new Set<string>();
  while (true) {
    const founder = current.founders.find((candidate) => candidate.founderId === founderId);
    if (founder?.toName) name = founder.toName;
    const state = `${current.companyId}\u0000${current.toSlug}\u0000${current.toName}`;
    if (seen.has(state)) return name;
    seen.add(state);
    const next = SUMMER_COMPANY_ALIAS_LEDGER.aliases.find(
      (candidate) =>
        candidate.companyId === current.companyId &&
        candidate.fromSlug === current.toSlug &&
        candidate.fromName === current.toName
    );
    if (!next) return name;
    current = next;
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
