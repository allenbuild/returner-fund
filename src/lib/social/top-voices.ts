import type {
  DemoGraphDataset,
  EvidenceItem,
  FounderRecord,
  Platform,
  TopVoiceAudienceId,
  TopVoiceAudienceSummary,
  TopVoiceMember,
  TopVoiceSet
} from "@/lib/graph/types";

const SEED_TIMESTAMP = "2026-07-09T00:00:00.000Z";
const DEFAULT_BATCH_CIRCLE_BATCH_SLUG = "P26";

export const TOP_VOICE_OFF_SUMMARY: TopVoiceAudienceSummary = {
  id: "off",
  displayName: "Off / Everyone",
  description: "All available network traction signals.",
  helperText: "Showing all available network traction signals.",
  scoreLabel: "Traction score",
  scoreDescription: "Scored from all available GitHub and social evidence.",
  active: true,
  memberCount: 0
};

const ycPartnerSeeds = [
  member("garry-tan", "Garry Tan", {
    aliases: ["garrytan"],
    handles: { x: ["garrytan"], linkedin: ["garrytan"] }
  }),
  member("harj-taggar", "Harj Taggar", {
    handles: { x: ["harjtaggar"], linkedin: ["harjtaggar"] }
  }),
  member("jared-friedman", "Jared Friedman", {
    aliases: ["snowmaker"],
    handles: { x: ["snowmaker"], linkedin: ["jaredfriedman"] }
  }),
  member("aaron-epstein", "Aaron Epstein", {
    handles: { linkedin: ["aaron-epstein"] }
  }),
  member("diana-hu", "Diana Hu", {
    handles: { linkedin: ["dianajhu"] }
  }),
  member("gustaf-alstromer", "Gustaf Alstromer", {
    aliases: ["Gustaf Alstromer", "Gustaf Alströmer"],
    handles: { x: ["gustaf"], linkedin: ["gustafalstromer"] }
  }),
  member("nicolas-dessaigne", "Nicolas Dessaigne", {
    handles: { x: ["dessaigne"], linkedin: ["dessaigne"] }
  }),
  member("tom-blomfield", "Tom Blomfield", {
    handles: { x: ["t_blom"], linkedin: ["tomblomfield"] }
  }),
  member("brad-flora", "Brad Flora", {
    handles: { x: ["bradflora"], linkedin: ["bradflora"] }
  }),
  member("pete-koomen", "Pete Koomen", {
    handles: { x: ["pkoomen"], linkedin: ["petekoomen"] }
  }),
  member("ankit-gupta", "Ankit Gupta", {
    handles: { linkedin: ["guptaankit"] }
  }),
  member("tyler-bosmeny", "Tyler Bosmeny", {
    handles: { x: ["bosmeny"], linkedin: ["tylerbosmeny"] }
  }),
  member("david-lieb", "David Lieb", {
    aliases: ["Dave Lieb"],
    handles: { x: ["dflieb"], linkedin: ["davidlieb"] }
  }),
  member("andrew-miklas", "Andrew Miklas", {
    handles: { linkedin: ["andrewmiklas"] }
  }),
  member("harshita-arora", "Harshita Arora", {
    handles: { x: ["harshitaarora"], linkedin: ["harshitaapps"] }
  }),
  member("jon-xu", "Jon Xu", {
    handles: { linkedin: ["jonxu"] }
  }),
  member("grey-baker", "Grey Baker", {
    handles: { x: ["greybaker"], linkedin: ["greybaker"] }
  }),
  member("chris-golda", "Chris Golda", {
    handles: { linkedin: ["chris-golda"] }
  })
];

const insiderOnlySeeds = [
  member("paul-graham", "Paul Graham", {
    aliases: ["pg"],
    handles: { x: ["paulg", "pg"] },
    category: "yc_alum"
  }),
  member("jessica-livingston", "Jessica Livingston", { category: "yc_alum" }),
  member("michael-seibel", "Michael Seibel", {
    handles: { x: ["mwseibel"], linkedin: ["michaelseibel"] },
    category: "yc_alum"
  }),
  member("sam-altman", "Sam Altman", {
    aliases: ["sama"],
    handles: { x: ["sama"], linkedin: ["samaltman"] },
    category: "yc_alum"
  }),
  member("brian-chesky", "Brian Chesky", {
    handles: { x: ["bchesky"], linkedin: ["brianchesky"] },
    category: "yc_adjacent_founder"
  }),
  member("taro-fukuyama", "Taro Fukuyama", { category: "yc_adjacent_founder" }),
  member("patrick-collison", "Patrick Collison", {
    handles: { x: ["patrickc"], linkedin: ["patrickcollison"] },
    category: "yc_adjacent_founder"
  }),
  member("john-collison", "John Collison", {
    handles: { x: ["collision"], linkedin: ["johncollison"] },
    category: "yc_adjacent_founder"
  }),
  member("guillermo-rauch", "Guillermo Rauch", {
    handles: { x: ["rauchg"], github: ["rauchg"], linkedin: ["rauchg"] },
    category: "operator"
  }),
  member("dylan-field", "Dylan Field", {
    handles: { x: ["zoink"], linkedin: ["dylanfield"] },
    category: "yc_adjacent_founder"
  }),
  member("aravind-srinivas", "Aravind Srinivas", {
    handles: { x: ["aravsrinivas"], linkedin: ["aravind-srinivas"] },
    category: "yc_adjacent_founder"
  }),
  member("alex-wang", "Alex Wang", {
    handles: { x: ["alexandr_wang"], linkedin: ["alexwang"] },
    category: "yc_adjacent_founder"
  }),
  member("palmer-luckey", "Palmer Luckey", {
    handles: { x: ["palmerluckey"], linkedin: ["palmerluckey"] },
    category: "operator"
  }),
  member("elad-gil", "Elad Gil", {
    handles: { x: ["eladgil"], linkedin: ["eladgil"] },
    category: "investor"
  }),
  member("nat-friedman", "Nat Friedman", {
    handles: { x: ["natfriedman"], github: ["nat"], linkedin: ["natfriedman"] },
    category: "operator"
  }),
  member("daniel-gross", "Daniel Gross", {
    handles: { x: ["danielgross"], linkedin: ["danielgross"] },
    category: "investor"
  }),
  member("david-sacks", "David Sacks", {
    handles: { x: ["davidsacks"], linkedin: ["davidsacks"] },
    category: "investor"
  }),
  member("marc-andreessen", "Marc Andreessen", {
    aliases: ["pmarca"],
    handles: { x: ["pmarca"], linkedin: ["marcandreessen"] },
    category: "investor"
  }),
  member("ben-horowitz", "Ben Horowitz", {
    handles: { x: ["bhorowitz"], linkedin: ["benhorowitz"] },
    category: "investor"
  }),
  member("ali-rowghani", "Ali Rowghani", {
    handles: { x: ["rowghani"], linkedin: ["alirowghani"] },
    category: "operator"
  }),
  member("andrew-chen", "Andrew Chen", {
    handles: { x: ["andrewchen"], linkedin: ["andrewchen"] },
    category: "investor"
  }),
  member("sarah-guo", "Sarah Guo", {
    handles: { x: ["saranormous"], linkedin: ["sarahguo"] },
    category: "investor"
  }),
  member("naval-ravikant", "Naval Ravikant", {
    aliases: ["naval"],
    handles: { x: ["naval"], linkedin: ["naval"] },
    category: "investor"
  }),
  member("keith-rabois", "Keith Rabois", {
    handles: { x: ["rabois"], linkedin: ["keithrabois"] },
    category: "investor"
  }),
  member("aaron-levie", "Aaron Levie", {
    handles: { x: ["levie"], linkedin: ["aaronlevie"] },
    category: "operator"
  }),
  member("eric-migicovsky", "Eric Migicovsky", {
    handles: { x: ["ericmigi"], linkedin: ["ericmigicovsky"] },
    category: "yc_adjacent_founder"
  }),
  member("parker-conrad", "Parker Conrad", {
    handles: { x: ["parkerconrad"], linkedin: ["parkerconrad"] },
    category: "yc_adjacent_founder"
  }),
  member("henrique-dubugras", "Henrique Dubugras", {
    handles: { x: ["hdubugras"], linkedin: ["henriquedubugras"] },
    category: "yc_adjacent_founder"
  }),
  member("pedro-franceschi", "Pedro Franceschi", {
    handles: { x: ["pedroh96"], linkedin: ["pedrofranceschi"] },
    category: "yc_adjacent_founder"
  }),
  member("tony-xu", "Tony Xu", {
    handles: { x: ["t_xu"], linkedin: ["tonyxu"] },
    category: "yc_adjacent_founder"
  }),
  member("emmett-shear", "Emmett Shear", {
    handles: { x: ["eshear"], linkedin: ["emmettshear"] },
    category: "yc_adjacent_founder"
  })
];

export const builtInTopVoiceSets: TopVoiceSet[] = [
  {
    id: "yc_partners",
    displayName: "YC Partners",
    description: "Current YC partners and YC leadership.",
    members: ycPartnerSeeds,
    defaultWeight: 1,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP
  },
  {
    id: "yc_batch_circle",
    displayName: "YC Batch Circle",
    description: "YC partners plus current batch founders.",
    members: ycPartnerSeeds.map((seed) => ({ ...seed, weight: 2 })),
    defaultWeight: 1,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP
  },
  {
    id: "insiders",
    displayName: "Insiders",
    description: "Curated high-signal insiders.",
    members: dedupeMembers([...ycPartnerSeeds, ...insiderOnlySeeds]),
    defaultWeight: 1,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP
  }
];

export function normalizeTopVoiceAudienceId(value: string | null | undefined): TopVoiceAudienceId {
  if (value === "yc_partners" || value === "yc_batch_circle" || value === "insiders") {
    return value;
  }
  return "off";
}

export function resolveTopVoiceAudience(
  value: string | null | undefined,
  options: { dataset?: DemoGraphDataset; batchSlug?: string } = {}
): { summary: TopVoiceAudienceSummary; members: TopVoiceMember[] } {
  const id = normalizeTopVoiceAudienceId(value);
  if (id === "off") {
    return { summary: TOP_VOICE_OFF_SUMMARY, members: [] };
  }

  const set = builtInTopVoiceSets.find((candidate) => candidate.id === id);
  if (!set || !set.active) {
    return { summary: TOP_VOICE_OFF_SUMMARY, members: [] };
  }

  const dynamicMembers = id === "yc_batch_circle"
    ? batchFounderMembers(options.dataset, options.batchSlug)
    : [];
  const members = dedupeMembers([...set.members, ...dynamicMembers]).filter((candidate) => candidate.active);

  return {
    summary: summaryFor(set, members.length),
    members
  };
}

export function topVoiceAudienceSummaries(
  options: { dataset?: DemoGraphDataset; batchSlug?: string } = {}
): TopVoiceAudienceSummary[] {
  return [
    TOP_VOICE_OFF_SUMMARY,
    ...builtInTopVoiceSets
      .filter((set) => set.active)
      .map((set) => {
        const dynamicMembers =
          set.id === "yc_batch_circle" ? batchFounderMembers(options.dataset, options.batchSlug) : [];
        return summaryFor(set, dedupeMembers([...set.members, ...dynamicMembers]).length);
      })
  ];
}

export function matchEvidenceToTopVoice(
  item: EvidenceItem,
  audienceId: TopVoiceAudienceId,
  members: TopVoiceMember[]
): { member: TopVoiceMember; matchedBy: string } | null {
  if (audienceId === "off" || item.contributionScore <= 0) {
    return null;
  }

  const identity = evidenceIdentityCandidates(item);
  for (const voice of members) {
    if (!voice.active) {
      continue;
    }
    const match = topVoiceMatchReason(voice, identity, item.platform);
    if (match) {
      return { member: voice, matchedBy: match };
    }
  }

  return null;
}

export function topVoiceNodeId(memberId: string): string {
  return `top-voice:${memberId}`;
}

function summaryFor(set: TopVoiceSet, memberCount: number): TopVoiceAudienceSummary {
  const helperText: Record<TopVoiceSet["id"], string> = {
    yc_partners: "Showing attention from current YC partners only.",
    yc_batch_circle: "Showing YC partners at 2x weight plus P26 founders at 1x weight.",
    insiders: "Showing curated high-signal insiders only."
  };

  return {
    id: set.id,
    displayName: set.displayName,
    description: set.description,
    helperText: helperText[set.id],
    scoreLabel: "Top Voices score",
    scoreDescription: set.description,
    active: set.active,
    memberCount
  };
}

function member(
  personId: string,
  displayName: string,
  options: {
    aliases?: string[];
    handles?: Partial<Record<Platform, string[]>>;
    category?: string;
    weight?: number;
    source?: string;
    notes?: string;
  } = {}
): TopVoiceMember {
  return {
    personId,
    displayName,
    aliases: dedupeStrings([displayName, ...(options.aliases ?? [])]),
    handles: normalizeHandles(options.handles ?? {}),
    category: options.category ?? "yc_partner",
    weight: options.weight ?? 1,
    active: true,
    source: options.source ?? "top-voices-seed",
    notes: options.notes
  };
}

function batchFounderMembers(dataset: DemoGraphDataset | undefined, batchSlug: string | undefined): TopVoiceMember[] {
  if (!dataset) {
    return [];
  }

  const selectedBatchSlug =
    batchSlug && dataset.batches.some((batch) => batch.slug === batchSlug)
      ? batchSlug
      : dataset.batches.some((batch) => batch.slug === DEFAULT_BATCH_CIRCLE_BATCH_SLUG)
        ? DEFAULT_BATCH_CIRCLE_BATCH_SLUG
        : batchSlug;

  if (!selectedBatchSlug) {
    return [];
  }

  return dataset.founders
    .filter((founder) => founder.batchSlug === selectedBatchSlug)
    .map(founderMember);
}

function founderMember(founder: FounderRecord): TopVoiceMember {
  const handles: Partial<Record<Platform, string[]>> = {};
  for (const account of founder.socialAccounts) {
    const values = [
      account.handle ?? null,
      handleFromUrl(account.platform, account.url)
    ].filter((value): value is string => Boolean(value));
    if (values.length) {
      handles[account.platform] = dedupeStrings([...(handles[account.platform] ?? []), ...values]);
    }
  }

  return member(founder.id, founder.name, {
    handles,
    category: "batch_founder",
    weight: 1,
    source: founder.ycProfileUrl,
    notes: `Resolved from ${founder.batchSlug} founder records.`
  });
}

function topVoiceMatchReason(
  member: TopVoiceMember,
  identity: EvidenceIdentityCandidates,
  platform: Platform
): string | null {
  const memberHandles = new Set([
    ...Object.values(member.handles).flat().map(normalizeHandle),
    ...member.aliases.map(normalizeHandle)
  ].filter(Boolean));
  const platformHandles = new Set((member.handles[platform] ?? []).map(normalizeHandle).filter(Boolean));

  for (const handle of identity.handles) {
    if (platformHandles.has(handle)) {
      return `platform handle ${handle}`;
    }
    if (memberHandles.has(handle)) {
      return `handle ${handle}`;
    }
  }

  const names = member.aliases.map(normalizeName).filter(Boolean);
  for (const name of identity.names) {
    if (names.includes(name)) {
      return `name ${name}`;
    }
    if (names.some((alias) => name.startsWith(`${alias} `) && /(post|profile|activity|reel|video|thread)/i.test(name))) {
      return `name prefix ${name}`;
    }
  }

  return null;
}

interface EvidenceIdentityCandidates {
  handles: string[];
  names: string[];
}

function evidenceIdentityCandidates(item: EvidenceItem): EvidenceIdentityCandidates {
  const raw = rawIdentityCandidates(item.rawVisibleText);
  return {
    handles: dedupeStrings([
      item.authorHandle,
      handleFromUrl(item.platform, item.sourceUrl),
      item.accountUrl ? handleFromUrl(item.platform, item.accountUrl) : null,
      ...raw.handles
    ].filter((value): value is string => Boolean(value))).map(normalizeHandle).filter(Boolean),
    names: dedupeStrings([
      item.authorName,
      item.title,
      ...raw.names
    ].filter((value): value is string => Boolean(value))).map(normalizeName).filter(Boolean)
  };
}

function rawIdentityCandidates(rawVisibleText: string | undefined): { handles: string[]; names: string[] } {
  if (!rawVisibleText || !rawVisibleText.trim().startsWith("{")) {
    return { handles: [], names: [] };
  }

  try {
    const parsed = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const profile = objectValue(parsed.profile);
    const post = objectValue(parsed.post);
    const detail = objectValue(parsed.detail);
    const profileUrl = stringValue(profile?.url);
    return {
      handles: dedupeStrings([
        stringValue(profile?.username),
        stringValue(profile?.handle),
        profileUrl ? handleFromAnyUrl(profileUrl) : null,
        stringValue(post?.author),
        stringValue(post?.authorHandle),
        stringValue(detail?.author),
        stringValue(detail?.authorHandle)
      ].filter((value): value is string => Boolean(value))),
      names: dedupeStrings([
        stringValue(profile?.name),
        stringValue(profile?.displayName),
        stringValue(post?.authorName),
        stringValue(detail?.authorName)
      ].filter((value): value is string => Boolean(value)))
    };
  } catch {
    return { handles: [], names: [] };
  }
}

function handleFromAnyUrl(rawUrl: string): string | null {
  for (const platform of ["x", "instagram", "linkedin", "github", "youtube"] satisfies Platform[]) {
    const handle = handleFromUrl(platform, rawUrl);
    if (handle) {
      return handle;
    }
  }
  return null;
}

function handleFromUrl(platform: Platform, rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if ((platform === "x" || hostname === "x.com" || hostname === "twitter.com") && parts[0] && !["i", "home", "search"].includes(parts[0])) {
      return parts[0];
    }
    if ((platform === "instagram" || hostname === "instagram.com") && parts[0] && !["p", "reel", "tv", "explore"].includes(parts[0])) {
      return parts[0];
    }
    if (platform === "linkedin" || hostname.endsWith("linkedin.com")) {
      const markerIndex = parts.findIndex((part) => ["in", "company"].includes(part.toLowerCase()));
      if (markerIndex >= 0 && parts[markerIndex + 1]) {
        return parts[markerIndex + 1];
      }
      const postIndex = parts.findIndex((part) => part.toLowerCase() === "posts");
      if (postIndex >= 0 && parts[postIndex + 1]) {
        return parts[postIndex + 1].split("_")[0] ?? null;
      }
    }
    if ((platform === "github" || hostname === "github.com") && parts[0]) {
      return parts[0];
    }
    if (platform === "youtube" || hostname.endsWith("youtube.com")) {
      const handle = parts.find((part) => part.startsWith("@"));
      return handle ? handle.slice(1) : null;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeHandles(handles: Partial<Record<Platform, string[]>>): Partial<Record<Platform, string[]>> {
  return Object.fromEntries(
    Object.entries(handles).map(([platform, values]) => [
      platform,
      dedupeStrings((values ?? []).map(normalizeHandle).filter(Boolean))
    ])
  ) as Partial<Record<Platform, string[]>>;
}

function dedupeMembers(members: TopVoiceMember[]): TopVoiceMember[] {
  const byId = new Map<string, TopVoiceMember>();
  for (const candidate of members) {
    const existing = byId.get(candidate.personId);
    if (!existing) {
      byId.set(candidate.personId, candidate);
      continue;
    }
    byId.set(candidate.personId, {
      ...existing,
      aliases: dedupeStrings([...existing.aliases, ...candidate.aliases]),
      handles: mergeHandles(existing.handles, candidate.handles),
      weight: Math.max(existing.weight, candidate.weight),
      active: existing.active || candidate.active
    });
  }
  return [...byId.values()];
}

function mergeHandles(
  left: Partial<Record<Platform, string[]>>,
  right: Partial<Record<Platform, string[]>>
): Partial<Record<Platform, string[]>> {
  const merged: Partial<Record<Platform, string[]>> = { ...left };
  for (const [platform, values] of Object.entries(right) as [Platform, string[]][]) {
    merged[platform] = dedupeStrings([...(merged[platform] ?? []), ...values]);
  }
  return merged;
}

function normalizeHandle(value: string | null | undefined): string {
  return normalizeName(value).replace(/^@/, "").replace(/\s+/g, "");
}

function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
