import { z } from "zod";
import type { Json, JsonObject } from "@/types/database";
import { PLATFORM_VALUES, type Platform, type TopVoiceMember } from "@/lib/graph/types";
import { defaultInsiderMembers } from "./top-voices";

export const INSIDER_WEIGHT_MIN = 1;
export const INSIDER_WEIGHT_MAX = 5;
export const MAX_ADDED_INSIDERS = 200;

const handleSchema = z.string().trim().min(1).max(100).transform(normalizeHandle);
const handlesSchema = z.partialRecord(
  z.enum(PLATFORM_VALUES),
  z.array(handleSchema).max(12)
);

export const addedInsiderSchema = z.object({
  personId: z.string().trim().min(3).max(160).regex(/^[a-z0-9][a-z0-9:._-]*$/i),
  displayName: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20),
  handles: handlesSchema,
  category: z.literal("insider").default("insider"),
  weight: z.number().int().min(INSIDER_WEIGHT_MIN).max(INSIDER_WEIGHT_MAX),
  active: z.boolean().default(true),
  source: z.literal("user-added").default("user-added"),
  notes: z.string().trim().max(500).optional()
}).strict();

export const insiderConfigurationInputSchema = z.object({
  expectedVersion: z.number().int().min(0),
  excludedDefaultIds: z.array(z.string().trim().min(1).max(160)).max(58),
  weightOverrides: z.record(
    z.string().trim().min(1).max(160),
    z.number().int().min(INSIDER_WEIGHT_MIN).max(INSIDER_WEIGHT_MAX)
  ),
  addedInsiders: z.array(addedInsiderSchema).max(MAX_ADDED_INSIDERS)
}).strict();

export type AddedInsider = z.infer<typeof addedInsiderSchema>;
export interface InsiderConfigurationInput {
  expectedVersion: number;
  excludedDefaultIds: string[];
  weightOverrides: Record<string, number>;
  addedInsiders: TopVoiceMember[];
}

export interface UserInsiderConfiguration {
  version: number;
  excludedDefaultIds: string[];
  weightOverrides: Record<string, number>;
  addedInsiders: TopVoiceMember[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface InsiderConfigurationResponse {
  authenticated: boolean;
  configuration: UserInsiderConfiguration;
  defaultMembers: TopVoiceMember[];
  effectiveMembers: TopVoiceMember[];
  defaultsCount: number;
}

export function emptyInsiderConfiguration(): UserInsiderConfiguration {
  return {
    version: 0,
    excludedDefaultIds: [],
    weightOverrides: {},
    addedInsiders: [],
    createdAt: null,
    updatedAt: null
  };
}

export function parseInsiderConfigurationRow(row: {
  version: number;
  excluded_default_ids: string[];
  weight_overrides: Json;
  added_insiders: Json;
  created_at: string;
  updated_at: string;
} | null): UserInsiderConfiguration {
  if (!row) return emptyInsiderConfiguration();
  const parsed = validateInsiderConfiguration({
    expectedVersion: row.version,
    excludedDefaultIds: row.excluded_default_ids,
    weightOverrides: row.weight_overrides,
    addedInsiders: row.added_insiders
  });
  return {
    version: row.version,
    excludedDefaultIds: parsed.excludedDefaultIds,
    weightOverrides: parsed.weightOverrides,
    addedInsiders: parsed.addedInsiders,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function validateInsiderConfiguration(value: unknown): InsiderConfigurationInput {
  const parsed = insiderConfigurationInputSchema.parse(value);
  const defaults = defaultInsiderMembers();
  const defaultIds = new Set(defaults.map((member) => member.personId));
  const excludedDefaultIds = unique(parsed.excludedDefaultIds);
  const unknownExclusions = excludedDefaultIds.filter((personId) => !defaultIds.has(personId));
  if (unknownExclusions.length) {
    throw new Error(`Unknown default insider: ${unknownExclusions[0]}`);
  }
  for (const personId of Object.keys(parsed.weightOverrides)) {
    if (!defaultIds.has(personId)) {
      throw new Error(`Weight override does not reference a default insider: ${personId}`);
    }
  }

  const defaultIdentityToId = new Map(
    defaults.flatMap((member) =>
      [member.displayName, ...member.aliases].map((name) => [normalizeInsiderName(name), member.personId] as const)
    )
  );
  const weightOverrides = { ...parsed.weightOverrides };
  const addedInsiders = parsed.addedInsiders
    .map(normalizeAddedInsider)
    .filter((member) => {
      const canonicalDefaultId = [member.displayName, ...member.aliases]
        .map(normalizeInsiderName)
        .map((name) => defaultIdentityToId.get(name))
        .find(Boolean);
      if (!canonicalDefaultId) return true;
      if (member.active) {
        weightOverrides[canonicalDefaultId] = member.weight;
      }
      return false;
    });
  const allMembers = [...defaults, ...addedInsiders];
  const personIds = new Set<string>();
  const identities = new Map<string, string>();
  const names = new Map<string, string>();
  for (const member of allMembers) {
    if (personIds.has(member.personId)) {
      throw new Error(`Duplicate insider identity: ${member.personId}`);
    }
    personIds.add(member.personId);
    for (const name of [member.displayName, ...member.aliases]) {
      const key = normalizeInsiderName(name);
      const existing = names.get(key);
      if (existing && existing !== member.personId) {
        throw new Error(`Duplicate insider name: ${name}`);
      }
      names.set(key, member.personId);
    }
    for (const [platform, handles] of Object.entries(member.handles) as [Platform, string[]][]) {
      for (const handle of handles) {
        const key = `${platform}:${normalizeHandle(handle)}`;
        const existing = identities.get(key);
        if (existing && existing !== member.personId) {
          throw new Error(`Duplicate ${platform} handle: ${handle}`);
        }
        identities.set(key, member.personId);
      }
    }
  }

  return {
    expectedVersion: parsed.expectedVersion,
    excludedDefaultIds,
    weightOverrides: Object.fromEntries(Object.entries(weightOverrides).filter(([personId, weight]) => {
      const defaultWeight = defaults.find((member) => member.personId === personId)?.weight;
      return defaultWeight !== weight;
    })),
    addedInsiders
  };
}

export function effectiveInsiderMembers(
  configuration: Pick<UserInsiderConfiguration, "excludedDefaultIds" | "weightOverrides" | "addedInsiders">
): TopVoiceMember[] {
  const excluded = new Set(configuration.excludedDefaultIds);
  const defaults = defaultInsiderMembers()
    .filter((member) => !excluded.has(member.personId))
    .map((member) => ({
      ...member,
      weight: configuration.weightOverrides[member.personId] ?? member.weight
    }));
  return [
    ...defaults,
    ...configuration.addedInsiders.map(normalizeAddedInsider).filter((member) => member.active)
  ];
}

export function configurationResponse(
  configuration: UserInsiderConfiguration,
  authenticated: boolean
): InsiderConfigurationResponse {
  return {
    authenticated,
    configuration,
    defaultMembers: defaultInsiderMembers(),
    effectiveMembers: effectiveInsiderMembers(configuration),
    defaultsCount: defaultInsiderMembers().length
  };
}

export function addedInsidersAsJson(members: TopVoiceMember[]): Json {
  return members.map((member) => ({
    ...member,
    handles: member.handles as JsonObject
  })) as Json;
}

export function createAddedInsider(input: {
  displayName: string;
  handles: Partial<Record<Platform, string[]>>;
  weight?: number;
}): TopVoiceMember {
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error("Name is required.");
  const handles = normalizeHandles(input.handles);
  const primary = (Object.entries(handles) as [Platform, string[]][])
    .find(([, values]) => values.length > 0);
  const personId = primary
    ? `user:${primary[0]}:${primary[1][0]}`.toLowerCase()
    : `user:name:${normalizeInsiderName(displayName).replace(/\s+/g, "-")}`;
  return normalizeAddedInsider(addedInsiderSchema.parse({
    personId,
    displayName,
    aliases: [displayName],
    handles,
    category: "insider",
    weight: input.weight ?? 1,
    active: true,
    source: "user-added"
  }));
}

function normalizeAddedInsider(member: AddedInsider | TopVoiceMember): TopVoiceMember {
  return {
    personId: member.personId.trim(),
    displayName: member.displayName.trim(),
    aliases: unique([member.displayName, ...member.aliases].map((value) => value.trim()).filter(Boolean)),
    handles: normalizeHandles(member.handles),
    category: "insider",
    weight: member.weight,
    active: member.active,
    source: "user-added",
    ...(member.notes ? { notes: member.notes.trim() } : {})
  };
}

function normalizeHandles(handles: Partial<Record<Platform, string[]>>): Partial<Record<Platform, string[]>> {
  return Object.fromEntries(
    Object.entries(handles)
      .map(([platform, values]) => [platform, unique((values ?? []).map(normalizeHandle).filter(Boolean))])
      .filter(([, values]) => values.length > 0)
  ) as Partial<Record<Platform, string[]>>;
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function normalizeInsiderName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
