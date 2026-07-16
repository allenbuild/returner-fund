import type {
  EvidenceItem,
  Platform,
  TopVoiceAudienceId,
  TopVoiceAudienceSummary,
  TopVoiceMember,
  TopVoiceSet
} from "@/lib/graph/types";

const SEED_TIMESTAMP = "2026-07-09T00:00:00.000Z";

export const TOP_VOICE_OFF_SUMMARY: TopVoiceAudienceSummary = {
  id: "off",
  displayName: "All voices",
  description: "All available network traction signals.",
  helperText: "Showing all available network traction signals.",
  scoreLabel: "Traction score",
  scoreDescription: "Scored from all available GitHub and social evidence.",
  active: true,
  memberCount: 0
};

interface MemberOptions {
  aliases?: string[];
  handles?: Partial<Record<Platform, string[]>>;
  category?: string;
  weight?: number;
  source?: string;
  notes?: string;
}

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
    handles: { x: ["aaron_epstein"], linkedin: ["aaron-epstein"] }
  }),
  member("diana-hu", "Diana Hu", {
    handles: { linkedin: ["dianajhu"] }
  }),
  member("gustaf-alstromer", "Gustaf Alströmer", {
    aliases: ["Gustaf Alstromer"],
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
    handles: { x: ["agupta"], linkedin: ["guptaankit"] }
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
    handles: { x: ["greybaker"], linkedin: ["greybaker", "greysteil"] }
  }),
  member("chris-golda", "Chris Golda", {
    handles: { linkedin: ["chris-golda"] }
  })
];

const insiderOnlySeeds = [
  insider("paul-graham", "Paul Graham", {
    aliases: ["pg"],
    handles: { x: ["paulg", "pg"] }
  }),
  insider("jessica-livingston", "Jessica Livingston"),
  insider("michael-seibel", "Michael Seibel", {
    handles: { x: ["mwseibel"], linkedin: ["michaelseibel"] }
  }),
  insider("sam-altman", "Sam Altman", {
    aliases: ["sama"],
    handles: { x: ["sama"], linkedin: ["samaltman"] }
  }),
  insider("brian-chesky", "Brian Chesky", {
    handles: { x: ["bchesky"], linkedin: ["brianchesky"] }
  }),
  insider("patrick-collison", "Patrick Collison", {
    handles: { x: ["patrickc"], linkedin: ["patrickcollison"] }
  }),
  insider("john-collison", "John Collison", {
    handles: { x: ["collision"], linkedin: ["johncollison"] }
  }),
  insider("brian-armstrong", "Brian Armstrong", {
    handles: { x: ["brian_armstrong"], linkedin: ["barmstrong"] }
  }),
  insider("drew-houston", "Drew Houston", {
    handles: { x: ["drewhouston"], linkedin: ["drewhouston"] }
  }),
  insider("steve-huffman", "Steve Huffman", {
    aliases: ["spez"],
    handles: { x: ["spez"], linkedin: ["stevehuffman"] }
  }),
  insider("justin-kan", "Justin Kan", {
    handles: { x: ["justinkan"], linkedin: ["justinkan"] }
  }),
  insider("emmett-shear", "Emmett Shear", {
    handles: { x: ["eshear"], linkedin: ["emmettshear"] }
  }),
  insider("alexis-ohanian", "Alexis Ohanian", {
    handles: { x: ["alexisohanian"], linkedin: ["alexisohanian"] }
  }),
  insider("guillermo-rauch", "Guillermo Rauch", {
    handles: { x: ["rauchg"], github: ["rauchg"], linkedin: ["rauchg"] }
  }),
  insider("dylan-field", "Dylan Field", {
    handles: { x: ["zoink"], linkedin: ["dylanfield"] }
  }),
  insider("aravind-srinivas", "Aravind Srinivas", {
    handles: { x: ["aravsrinivas"], linkedin: ["aravind-srinivas"] }
  }),
  insider("alex-wang", "Alex Wang", {
    handles: { x: ["alexandr_wang"], linkedin: ["alexwang"] }
  }),
  insider("palmer-luckey", "Palmer Luckey", {
    handles: { x: ["palmerluckey"], linkedin: ["palmerluckey"] }
  }),
  insider("parker-conrad", "Parker Conrad", {
    handles: { x: ["parkerconrad"], linkedin: ["parkerconrad"] }
  }),
  insider("aaron-levie", "Aaron Levie", {
    handles: { x: ["levie"], linkedin: ["aaronlevie"] }
  }),
  insider("eric-migicovsky", "Eric Migicovsky", {
    handles: { x: ["ericmigi"], linkedin: ["ericmigicovsky"] }
  }),
  insider("tony-xu", "Tony Xu", {
    handles: { x: ["t_xu"], linkedin: ["tonyxu"] }
  }),
  insider("apoorva-mehta", "Apoorva Mehta", {
    handles: { x: ["apoorva_mehta"], linkedin: ["apoorvamehta"] }
  }),
  insider("max-mullen", "Max Mullen", {
    handles: { x: ["maxmullen"], linkedin: ["maxmullen"] }
  }),
  insider("henrique-dubugras", "Henrique Dubugras", {
    handles: { x: ["hdubugras"], linkedin: ["henriquedubugras"] }
  }),
  insider("pedro-franceschi", "Pedro Franceschi", {
    handles: { x: ["pedroh96"], linkedin: ["pedrofranceschi"] }
  }),
  insider("mathilde-collin", "Mathilde Collin", {
    handles: { x: ["collinmathilde"], linkedin: ["mathildecollin"] }
  }),
  insider("rahul-vohra", "Rahul Vohra", {
    handles: { x: ["rahulvohra"], linkedin: ["rahulvohra"] }
  }),
  insider("spenser-skates", "Spenser Skates", {
    handles: { x: ["spenserskates"], linkedin: ["spenserskates"] }
  }),
  insider("suhail-doshi", "Suhail Doshi", {
    handles: { x: ["suhail"], linkedin: ["suhaildoshi"] }
  }),
  insider("taro-fukuyama", "Taro Fukuyama", {
    handles: { linkedin: ["tarof"] }
  }),
  insider("dalton-caldwell", "Dalton Caldwell", {
    handles: { x: ["daltonc"], linkedin: ["daltoncaldwell"] }
  }),
  insider("qasar-younis", "Qasar Younis", {
    handles: { x: ["qasar"], linkedin: ["qasaryounis"] }
  }),
  insider("ali-rowghani", "Ali Rowghani", {
    handles: { x: ["rowghani"], linkedin: ["alirowghani"] }
  }),
  insider("anu-hariharan", "Anu Hariharan", {
    handles: { x: ["anuhariharan"], linkedin: ["anuhariharan"] }
  }),
  insider("elad-gil", "Elad Gil", {
    handles: { x: ["eladgil"], linkedin: ["eladgil"] }
  }),
  insider("nat-friedman", "Nat Friedman", {
    handles: { x: ["natfriedman"], github: ["nat"], linkedin: ["natfriedman"] }
  }),
  insider("daniel-gross", "Daniel Gross", {
    handles: { x: ["danielgross"], linkedin: ["danielgross"] }
  }),
  insider("david-sacks", "David Sacks", {
    handles: { x: ["davidsacks"], linkedin: ["davidsacks"] }
  }),
  insider("marc-andreessen", "Marc Andreessen", {
    aliases: ["pmarca"],
    handles: { x: ["pmarca"], linkedin: ["marcandreessen"] }
  }),
  insider("ben-horowitz", "Ben Horowitz", {
    handles: { x: ["bhorowitz"], linkedin: ["benhorowitz"] }
  }),
  insider("naval-ravikant", "Naval Ravikant", {
    aliases: ["naval"],
    handles: { x: ["naval"], linkedin: ["naval"] }
  }),
  insider("keith-rabois", "Keith Rabois", {
    handles: { x: ["rabois"], linkedin: ["keithrabois"] }
  }),
  insider("sarah-guo", "Sarah Guo", {
    handles: { x: ["saranormous"], linkedin: ["sarahguo"] }
  }),
  insider("andrew-chen", "Andrew Chen", {
    handles: { x: ["andrewchen"], linkedin: ["andrewchen"] }
  }),
  insider("lachy-groom", "Lachy Groom", {
    handles: { x: ["lachygroom"], linkedin: ["lachygroom"] }
  }),
  insider("semil-shah", "Semil Shah", {
    handles: { x: ["semil"], linkedin: ["semilshah"] }
  }),
  insider("delian-asparouhov", "Delian Asparouhov", {
    handles: { x: ["zebulgar"], linkedin: ["delianasparouhov"] }
  }),
  insider("trae-stephens", "Trae Stephens", {
    handles: { x: ["traestephens"], linkedin: ["trae-stephens"] }
  }),
  insider("lenny-rachitsky", "Lenny Rachitsky", {
    handles: { x: ["lennyrachitsky"], linkedin: ["lennyrachitsky"] }
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
    id: "insiders",
    displayName: "Insiders",
    description: "Curated high-signal insiders.",
    members: insiderOnlySeeds,
    defaultWeight: 1,
    active: true,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP
  }
];

export function normalizeTopVoiceAudienceId(value: string | null | undefined): TopVoiceAudienceId {
  if (value === "yc_partners" || value === "insiders") {
    return value;
  }
  return "off";
}

export function resolveTopVoiceAudience(value: string | null | undefined): { summary: TopVoiceAudienceSummary; members: TopVoiceMember[] } {
  const id = normalizeTopVoiceAudienceId(value);
  if (id === "off") {
    return { summary: TOP_VOICE_OFF_SUMMARY, members: [] };
  }

  const set = builtInTopVoiceSets.find((candidate) => candidate.id === id);
  if (!set || !set.active) {
    return { summary: TOP_VOICE_OFF_SUMMARY, members: [] };
  }

  const members = dedupeMembers(set.members).filter((candidate) => candidate.active);

  return {
    summary: summaryFor(set, members.length),
    members
  };
}

export function topVoiceAudienceSummaries(): TopVoiceAudienceSummary[] {
  return [
    TOP_VOICE_OFF_SUMMARY,
    ...builtInTopVoiceSets
      .filter((set) => set.active)
      .map((set) => summaryFor(set, dedupeMembers(set.members).length))
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

  const identity = evidenceNativeIdentityCandidates(item);
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

export function isKnownTopVoiceAccountUrl(platform: Platform, rawUrl: string | null | undefined): boolean {
  const candidateHandle = normalizeHandle(handleFromUrl(platform, rawUrl));
  if (!candidateHandle) {
    return false;
  }

  return builtInTopVoiceSets
    .filter((set) => set.active)
    .flatMap((set) => set.members)
    .some((voice) => (voice.handles[platform] ?? []).some((handle) => normalizeHandle(handle) === candidateHandle));
}

export function isKnownTopVoiceNativeIdentity(platform: Platform, rawVisibleText: string | undefined): boolean {
  const raw = rawNativeIdentityCandidates(rawVisibleText);
  if (!raw.hasNativeIdentity) {
    return false;
  }

  const identity: EvidenceIdentityCandidates = {
    handles: raw.handles.map(normalizeHandle).filter(Boolean),
    names: raw.names.map(normalizeName).filter(Boolean)
  };

  return builtInTopVoiceSets
    .filter((set) => set.active)
    .flatMap((set) => set.members)
    .some((voice) => Boolean(topVoiceMatchReason(voice, identity, platform)));
}

function summaryFor(set: TopVoiceSet, memberCount: number): TopVoiceAudienceSummary {
  const helperText: Record<TopVoiceSet["id"], string> = {
    yc_partners: "Showing attention from current YC partners only.",
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
  options: MemberOptions = {}
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

function insider(personId: string, displayName: string, options: MemberOptions = {}): TopVoiceMember {
  return member(personId, displayName, {
    category: "insider",
    ...options
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

function evidenceNativeIdentityCandidates(item: EvidenceItem): EvidenceIdentityCandidates {
  const raw = rawNativeIdentityCandidates(item.rawVisibleText);
  if (raw.hasNativeIdentity) {
    return {
      handles: raw.handles.map(normalizeHandle).filter(Boolean),
      names: raw.names.map(normalizeName).filter(Boolean)
    };
  }

  return {
    handles: dedupeStrings([
      item.authorHandle,
      ...raw.handles
    ].filter((value): value is string => Boolean(value))).map(normalizeHandle).filter(Boolean),
    names: dedupeStrings([
      item.authorName,
      ...raw.names
    ].filter((value): value is string => Boolean(value))).map(normalizeName).filter(Boolean)
  };
}

function rawNativeIdentityCandidates(rawVisibleText: string | undefined): { handles: string[]; names: string[]; hasNativeIdentity: boolean } {
  if (!rawVisibleText) {
    return { handles: [], names: [], hasNativeIdentity: false };
  }

  const rawText = rawVisibleText.trim();
  if (!rawText.startsWith("{")) {
    return { handles: [], names: [], hasNativeIdentity: false };
  }

  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const profile = objectValue(parsed.profile);
    const post = objectValue(parsed.post);
    const nativeAuthorRecord = post ?? parsed;
    const profileUrl = stringValue(profile?.url);
    const nativeHandles = authorHandlesFrom(nativeAuthorRecord);
    const nativeNames = authorNamesFrom(nativeAuthorRecord);
    const fallbackProfileHandles = post ? [] : [
      stringValue(profile?.username),
      stringValue(profile?.handle),
      profileUrl ? handleFromAnyUrl(profileUrl) : null
    ];
    const fallbackProfileNames = post ? [] : [
      stringValue(profile?.name),
      stringValue(profile?.displayName)
    ];
    const handles = dedupeStrings([
      ...nativeHandles,
      ...fallbackProfileHandles
    ].filter((value): value is string => Boolean(value)));
    const names = dedupeStrings([
      ...nativeNames,
      ...fallbackProfileNames
    ].filter((value): value is string => Boolean(value)));

    return {
      handles,
      names,
      hasNativeIdentity: Boolean(handles.length || names.length)
    };
  } catch {
    return { handles: [], names: [], hasNativeIdentity: false };
  }
}

function authorHandlesFrom(record: Record<string, unknown> | null): string[] {
  if (!record) {
    return [];
  }
  return [
    stringValue(record.authorHandle),
    stringValue(record.handle),
    stringValue(record.username),
    stringValue(record.screenName),
    handleLikeValue(record.author)
  ].filter((value): value is string => Boolean(value));
}

function authorNamesFrom(record: Record<string, unknown> | null): string[] {
  if (!record) {
    return [];
  }
  return [
    stringValue(record.authorName),
    stringValue(record.name),
    stringValue(record.displayName),
    nameLikeValue(record.author)
  ].filter((value): value is string => Boolean(value));
}

function handleLikeValue(value: unknown): string | null {
  const raw = stringValue(value);
  return raw?.startsWith("@") ? raw : null;
}

function nameLikeValue(value: unknown): string | null {
  const raw = stringValue(value);
  return raw && !raw.startsWith("@") ? raw : null;
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

    if (platform === "x" && isPlatformHost(hostname, ["x.com", "twitter.com"]) && parts[0] && !["i", "home", "search"].includes(parts[0])) {
      return parts[0];
    }
    if (platform === "instagram" && isPlatformHost(hostname, ["instagram.com"]) && parts[0] && !["p", "reel", "tv", "explore"].includes(parts[0])) {
      return parts[0];
    }
    if (platform === "linkedin" && isPlatformHost(hostname, ["linkedin.com"])) {
      const markerIndex = parts.findIndex((part) => ["in", "company"].includes(part.toLowerCase()));
      if (markerIndex >= 0 && parts[markerIndex + 1]) {
        return parts[markerIndex + 1];
      }
      const postIndex = parts.findIndex((part) => part.toLowerCase() === "posts");
      if (postIndex >= 0 && parts[postIndex + 1]) {
        return parts[postIndex + 1].split("_")[0] ?? null;
      }
    }
    if (platform === "github" && isPlatformHost(hostname, ["github.com"]) && parts[0]) {
      return parts[0];
    }
    if (platform === "youtube" && isPlatformHost(hostname, ["youtube.com"])) {
      const handle = parts.find((part) => part.startsWith("@"));
      return handle ? handle.slice(1) : null;
    }
  } catch {
    return null;
  }

  return null;
}

function isPlatformHost(hostname: string, roots: string[]): boolean {
  return roots.some((root) => hostname === root || hostname.endsWith(`.${root}`));
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
