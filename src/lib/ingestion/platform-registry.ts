import type { EntityType, Platform } from "@/types/domain";

export const REPRESENTED_PLATFORMS = [
  "github",
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "rss",
  "web",
  "reddit",
  "hacker_news",
  "bilibili",
  "tiktok",
  "bluesky"
] as const satisfies readonly Platform[];

export type RepresentedPlatform = (typeof REPRESENTED_PLATFORMS)[number];
export type PlatformSourceRole = "native_traction" | "contextual" | "native_unscored";
export type PlatformAuthMode = "none" | "optional" | "required" | "unavailable";
export type CollectorAvailability = "available" | "partial" | "manual_only" | "disabled";
export type CollectorMode = "connector" | "standalone_script" | "live_refresh" | "manual" | "none";
export type AccountModel =
  | "profile"
  | "repository"
  | "launch"
  | "channel"
  | "feed"
  | "website"
  | "community_identity";

export interface PlatformAuthCapability {
  mode: PlatformAuthMode;
  environmentVariables: readonly string[];
  notes: string;
}

export interface PlatformCollectorCapability {
  availability: CollectorAvailability;
  modes: readonly CollectorMode[];
  supportsAccountDiscovery: boolean;
  supportsEvidenceCollection: boolean;
  supportsMetricCollection: boolean;
  notes: string;
}

export interface PlatformRegistryEntry {
  platform: RepresentedPlatform;
  sourceRole: PlatformSourceRole;
  nativeTractionEligible: boolean;
  appliesTo: readonly EntityType[];
  accountModel: AccountModel;
  auth: PlatformAuthCapability;
  collector: PlatformCollectorCapability;
}

const BOTH_ENTITY_TYPES = ["company", "founder"] as const satisfies readonly EntityType[];
const COMPANY_ONLY = ["company"] as const satisfies readonly EntityType[];

export const PLATFORM_REGISTRY = [
  platform({
    platform: "github",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "repository",
    auth: optionalAuth(["GITHUB_TOKEN"], "Public reads work without auth; a token raises API limits."),
    collector: collector("available", ["standalone_script"], true, true, true, "The repository has a real public GitHub collection script.")
  }),
  platform({
    platform: "x",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "profile",
    auth: optionalAuth([], "Public reads are implemented; authenticated collection is an optional separate path."),
    collector: collector("available", ["standalone_script", "live_refresh"], true, true, true, "Public batch collection and the live refresh path are implemented.")
  }),
  platform({
    platform: "linkedin",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "profile",
    auth: requiredAuth("Approved access or explicit manual review is required; browser automation is not a default capability."),
    collector: collector("manual_only", ["manual"], false, false, false, "Historical rows exist, but there is no generally active safe collector.")
  }),
  platform({
    platform: "instagram",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "profile",
    auth: optionalAuth([], "Public attempts are supported; the logged-in collector is opt-in."),
    collector: collector("partial", ["standalone_script"], true, true, true, "Broad public and opt-in logged-in scripts exist, but access can be blocked.")
  }),
  platform({
    platform: "product_hunt",
    sourceRole: "native_traction",
    appliesTo: COMPANY_ONLY,
    accountModel: "launch",
    auth: noAuth("Public Product Hunt pages and search only."),
    collector: collector("available", ["connector", "standalone_script"], true, true, true, "Public discovery, launch collection, and launch metrics are implemented.")
  }),
  platform({
    platform: "youtube",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "channel",
    auth: noAuth("Public channel and video metadata only."),
    collector: collector("available", ["standalone_script"], true, true, true, "The broad public script implements YouTube collection; the connector class is metadata-only.")
  }),
  platform({
    platform: "rss",
    sourceRole: "contextual",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "feed",
    auth: noAuth("Public RSS or Atom feeds only."),
    collector: collector("available", ["standalone_script"], true, true, false, "Feed items provide context and do not enter native traction scoring.")
  }),
  platform({
    platform: "web",
    sourceRole: "contextual",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "website",
    auth: noAuth("Public webpages only."),
    collector: collector("available", ["connector", "standalone_script"], true, true, false, "Official sites and public pages provide context, not native traction.")
  }),
  platform({
    platform: "reddit",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "community_identity",
    auth: noAuth("Public Reddit pages only."),
    collector: collector("available", ["standalone_script"], true, true, true, "The broad public script implements Reddit collection.")
  }),
  platform({
    platform: "hacker_news",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "community_identity",
    auth: noAuth("Public Hacker News pages and APIs only."),
    collector: collector("available", ["standalone_script"], true, true, true, "The broad public script implements Hacker News collection.")
  }),
  platform({
    platform: "bilibili",
    sourceRole: "native_traction",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "channel",
    auth: unavailableAuth("No autonomous Bilibili collector is wired in this repository."),
    collector: collector("manual_only", ["manual"], false, false, false, "Stored native evidence can be scored, but current collection is manual/static.")
  }),
  platform({
    platform: "tiktok",
    sourceRole: "native_unscored",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "profile",
    auth: unavailableAuth("Future collection requires an approved official access path."),
    collector: collector("disabled", ["none"], false, false, false, "Native evidence is forward-compatible but unscored and collection is disabled.")
  }),
  platform({
    platform: "bluesky",
    sourceRole: "native_unscored",
    appliesTo: BOTH_ENTITY_TYPES,
    accountModel: "profile",
    auth: unavailableAuth("Public AT Protocol reads are not wired into ingestion."),
    collector: collector("disabled", ["none"], false, false, false, "Native evidence is forward-compatible but unscored and collection is disabled.")
  })
] as const satisfies readonly PlatformRegistryEntry[];

export const PLATFORM_REGISTRY_BY_ID: Readonly<Record<RepresentedPlatform, PlatformRegistryEntry>> =
  Object.freeze(
    Object.fromEntries(PLATFORM_REGISTRY.map((entry) => [entry.platform, entry])) as Record<
      RepresentedPlatform,
      PlatformRegistryEntry
    >
  );

export const NATIVE_TRACTION_PLATFORMS = PLATFORM_REGISTRY
  .filter((entry) => entry.nativeTractionEligible)
  .map((entry) => entry.platform);

export const CONTEXTUAL_PLATFORMS = PLATFORM_REGISTRY
  .filter((entry) => entry.sourceRole === "contextual")
  .map((entry) => entry.platform);

export function isRepresentedPlatform(value: string): value is RepresentedPlatform {
  return Object.prototype.hasOwnProperty.call(PLATFORM_REGISTRY_BY_ID, value);
}

export function getPlatformRegistryEntry(platformId: RepresentedPlatform): PlatformRegistryEntry {
  return PLATFORM_REGISTRY_BY_ID[platformId];
}

function platform(
  input: Omit<PlatformRegistryEntry, "nativeTractionEligible">
): PlatformRegistryEntry {
  return {
    ...input,
    nativeTractionEligible: input.sourceRole === "native_traction"
  };
}

function collector(
  availability: CollectorAvailability,
  modes: readonly CollectorMode[],
  supportsAccountDiscovery: boolean,
  supportsEvidenceCollection: boolean,
  supportsMetricCollection: boolean,
  notes: string
): PlatformCollectorCapability {
  return {
    availability,
    modes,
    supportsAccountDiscovery,
    supportsEvidenceCollection,
    supportsMetricCollection,
    notes
  };
}

function noAuth(notes: string): PlatformAuthCapability {
  return { mode: "none", environmentVariables: [], notes };
}

function optionalAuth(environmentVariables: readonly string[], notes: string): PlatformAuthCapability {
  return { mode: "optional", environmentVariables, notes };
}

function requiredAuth(notes: string): PlatformAuthCapability {
  return { mode: "required", environmentVariables: [], notes };
}

function unavailableAuth(notes: string): PlatformAuthCapability {
  return { mode: "unavailable", environmentVariables: [], notes };
}
