import {
  PLATFORM_REGISTRY,
  type PlatformRegistryEntry,
  type RepresentedPlatform
} from "@/lib/ingestion/platform-registry";
import type { EntityType, ReviewState } from "@/types/domain";

export const ACCOUNT_INVENTORY_STATUSES = [
  "ready",
  "missing_account",
  "not_applicable",
  "disabled"
] as const;

export const ACCOUNT_INVENTORY_TERMINAL_STATUSES = [
  "missing_account",
  "not_applicable",
  "disabled"
] as const satisfies readonly AccountInventoryStatus[];

export type AccountInventoryStatus = (typeof ACCOUNT_INVENTORY_STATUSES)[number];
export type TerminalAccountInventoryStatus = (typeof ACCOUNT_INVENTORY_TERMINAL_STATUSES)[number];

export interface AccountInventoryAccountInput {
  id?: string | null;
  entityType?: EntityType;
  entityId?: string;
  platform: RepresentedPlatform;
  url?: string | null;
  handle?: string | null;
  review_state?: ReviewState;
  enabled?: boolean;
}

export interface AccountInventoryCompanyInput {
  id: string;
  name?: string | null;
  websiteUrl?: string | null;
  rssUrl?: string | null;
  socialAccounts?: readonly AccountInventoryAccountInput[];
}

export interface AccountInventoryFounderInput {
  id: string;
  name?: string | null;
  personalWebsiteUrl?: string | null;
  rssUrl?: string | null;
  linkedinUrl?: string | null;
  xUrl?: string | null;
  instagramUrl?: string | null;
  socialAccounts?: readonly AccountInventoryAccountInput[];
}

export interface BuildAccountInventoryInput {
  companies: readonly AccountInventoryCompanyInput[];
  founders: readonly AccountInventoryFounderInput[];
  accounts?: readonly AccountInventoryAccountInput[];
  disabledPlatforms?: readonly RepresentedPlatform[];
}

export interface InventoryAccount {
  id: string | null;
  url: string | null;
  handle: string | null;
  review_state: ReviewState | null;
  enabled: boolean;
  origin: "declared" | "derived";
}

export interface AccountInventoryEntry {
  key: string;
  entityType: EntityType;
  entityId: string;
  entityName: string | null;
  platform: RepresentedPlatform;
  sourceRole: PlatformRegistryEntry["sourceRole"];
  nativeTractionEligible: boolean;
  status: AccountInventoryStatus;
  terminal: boolean;
  accounts: readonly InventoryAccount[];
  collector: PlatformRegistryEntry["collector"];
  statusReason: string;
}

interface InventoryEntity {
  type: EntityType;
  id: string;
  name: string | null;
  declaredAccounts: readonly AccountInventoryAccountInput[];
  derivedAccounts: readonly DerivedAccount[];
}

interface DerivedAccount {
  platform: RepresentedPlatform;
  id: string;
  url: string;
}

export function buildAccountInventory(input: BuildAccountInventoryInput): AccountInventoryEntry[] {
  const entities = normalizeEntities(input);
  const globalAccounts = groupGlobalAccounts(input.accounts ?? [], entities);
  const disabledPlatforms = new Set(input.disabledPlatforms ?? []);

  return entities.flatMap((entity) =>
    PLATFORM_REGISTRY.map((definition) => {
      const accounts = accountsForPair(entity, definition.platform, globalAccounts);
      const status = resolveStatus(entity.type, definition, accounts, disabledPlatforms);

      return {
        key: `${entity.type}:${entity.id}:${definition.platform}`,
        entityType: entity.type,
        entityId: entity.id,
        entityName: entity.name,
        platform: definition.platform,
        sourceRole: definition.sourceRole,
        nativeTractionEligible: definition.nativeTractionEligible,
        status,
        terminal: isTerminalAccountInventoryStatus(status),
        accounts,
        collector: definition.collector,
        statusReason: statusReason(status, definition)
      };
    })
  );
}

export function isTerminalAccountInventoryStatus(value: string): value is TerminalAccountInventoryStatus {
  return (ACCOUNT_INVENTORY_TERMINAL_STATUSES as readonly string[]).includes(value);
}

function normalizeEntities(input: BuildAccountInventoryInput): InventoryEntity[] {
  const entities: InventoryEntity[] = [
    ...input.companies.map((company) => ({
      type: "company" as const,
      id: requiredId(company.id, "company"),
      name: clean(company.name),
      declaredAccounts: company.socialAccounts ?? [],
      derivedAccounts: derivedCompanyAccounts(company)
    })),
    ...input.founders.map((founder) => ({
      type: "founder" as const,
      id: requiredId(founder.id, "founder"),
      name: clean(founder.name),
      declaredAccounts: founder.socialAccounts ?? [],
      derivedAccounts: derivedFounderAccounts(founder)
    }))
  ].sort(compareEntities);

  for (let index = 1; index < entities.length; index += 1) {
    const previous = entities[index - 1]!;
    const current = entities[index]!;
    if (previous.type === current.type && previous.id === current.id) {
      throw new Error(`Duplicate inventory entity: ${current.type}:${current.id}`);
    }
  }

  return entities;
}

function groupGlobalAccounts(
  accounts: readonly AccountInventoryAccountInput[],
  entities: readonly InventoryEntity[]
): ReadonlyMap<string, readonly InventoryAccount[]> {
  const entityKeys = new Set(entities.map((entity) => `${entity.type}:${entity.id}`));
  const grouped = new Map<string, InventoryAccount[]>();

  for (const account of accounts) {
    if (!account.entityType || !account.entityId) {
      throw new Error("Global inventory accounts require entityType and entityId.");
    }
    const entityId = requiredId(account.entityId, account.entityType);
    const entityKey = `${account.entityType}:${entityId}`;
    if (!entityKeys.has(entityKey)) {
      throw new Error(`Inventory account references unknown entity: ${entityKey}`);
    }
    const pairKey = `${entityKey}:${account.platform}`;
    const existing = grouped.get(pairKey) ?? [];
    existing.push(normalizeAccount(account, "declared"));
    grouped.set(pairKey, existing);
  }

  for (const values of grouped.values()) values.sort(compareAccounts);
  return grouped;
}

function accountsForPair(
  entity: InventoryEntity,
  platformId: RepresentedPlatform,
  globalAccounts: ReadonlyMap<string, readonly InventoryAccount[]>
): readonly InventoryAccount[] {
  const embedded = entity.declaredAccounts
    .filter((account) => account.platform === platformId)
    .map((account) => normalizeAccount(account, "declared"));
  const derived = entity.derivedAccounts
    .filter((account) => account.platform === platformId)
    .map((account) => normalizeAccount(account, "derived"));
  const global = globalAccounts.get(`${entity.type}:${entity.id}:${platformId}`) ?? [];
  return [...embedded, ...derived, ...global].sort(compareAccounts);
}

function resolveStatus(
  entityType: EntityType,
  definition: PlatformRegistryEntry,
  accounts: readonly InventoryAccount[],
  disabledPlatforms: ReadonlySet<RepresentedPlatform>
): AccountInventoryStatus {
  if (!definition.appliesTo.includes(entityType)) return "not_applicable";
  if (definition.collector.availability === "disabled" || disabledPlatforms.has(definition.platform)) {
    return "disabled";
  }
  if (accounts.some((account) => account.enabled)) return "ready";
  if (accounts.length > 0) return "disabled";
  return "missing_account";
}

function statusReason(status: AccountInventoryStatus, definition: PlatformRegistryEntry): string {
  switch (status) {
    case "ready":
      return "At least one enabled account or source endpoint is present.";
    case "missing_account":
      return "The platform applies to this entity, but no account or source endpoint is present.";
    case "not_applicable":
      return "The platform does not apply to this entity type.";
    case "disabled":
      return definition.collector.availability === "disabled"
        ? "Collection is disabled for this represented platform."
        : "Collection or all declared accounts are disabled for this inventory build.";
  }
}

function derivedCompanyAccounts(company: AccountInventoryCompanyInput): DerivedAccount[] {
  return compactDerived([
    derived("company", company.id, "web", company.websiteUrl),
    derived("company", company.id, "rss", company.rssUrl)
  ]);
}

function derivedFounderAccounts(founder: AccountInventoryFounderInput): DerivedAccount[] {
  return compactDerived([
    derived("founder", founder.id, "web", founder.personalWebsiteUrl),
    derived("founder", founder.id, "rss", founder.rssUrl),
    derived("founder", founder.id, "linkedin", founder.linkedinUrl),
    derived("founder", founder.id, "x", founder.xUrl),
    derived("founder", founder.id, "instagram", founder.instagramUrl)
  ]);
}

function derived(
  entityType: EntityType,
  entityId: string,
  platformId: RepresentedPlatform,
  rawUrl: string | null | undefined
): DerivedAccount | null {
  const url = clean(rawUrl);
  if (!url) return null;
  return {
    platform: platformId,
    id: `derived:${entityType}:${entityId.trim()}:${platformId}`,
    url
  };
}

function compactDerived(values: readonly (DerivedAccount | null)[]): DerivedAccount[] {
  return values.filter((value): value is DerivedAccount => value !== null);
}

function normalizeAccount(
  account: AccountInventoryAccountInput | DerivedAccount,
  origin: InventoryAccount["origin"]
): InventoryAccount {
  return {
    id: clean(account.id),
    url: clean(account.url),
    handle: "handle" in account ? clean(account.handle) : null,
    review_state: "review_state" in account ? account.review_state ?? null : null,
    enabled: "enabled" in account ? account.enabled !== false : true,
    origin
  };
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Inventory ${label} id must not be empty.`);
  return normalized;
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function compareEntities(left: InventoryEntity, right: InventoryEntity): number {
  return left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
}

function compareAccounts(left: InventoryAccount, right: InventoryAccount): number {
  return accountSortKey(left).localeCompare(accountSortKey(right));
}

function accountSortKey(account: InventoryAccount): string {
  return [
    account.id ?? "",
    account.url ?? "",
    account.handle ?? "",
    account.review_state ?? "",
    account.enabled ? "1" : "0",
    account.origin
  ].join("\u0000");
}
