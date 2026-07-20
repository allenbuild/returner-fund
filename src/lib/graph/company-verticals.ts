import { COMPANY_VERTICAL_OVERRIDE_VALUES } from "./company-vertical-overrides";

/**
 * Canonical company vertical taxonomy.
 *
 * Keep slugs and ordering stable: they are suitable for persisted filters and
 * transport. Bump the version when a rule, alias, or taxonomy entry changes.
 */
export const COMPANY_VERTICAL_TAXONOMY_VERSION = "2026-07-20.v1" as const;
export const MAX_INFERRED_COMPANY_VERTICALS = 5 as const;

interface CompanyVerticalDefinitionShape {
  slug: string;
  label: string;
  order: number;
  description: string;
  aliases: readonly string[];
  keywords: readonly string[];
}

export const COMPANY_VERTICALS = [
  {
    slug: "ai-agents",
    label: "AI Agents",
    order: 1,
    description: "Autonomous or semi-autonomous software agents that complete multi-step work.",
    aliases: ["agentic ai", "ai agent", "ai agents"],
    keywords: ["agentic workflow", "autonomous software agent", "multi-agent system", "digital worker"]
  },
  {
    slug: "ai-infrastructure",
    label: "AI Infrastructure",
    order: 2,
    description: "Infrastructure for training, serving, evaluating, or operating AI models.",
    aliases: ["ml infrastructure", "machine learning infrastructure", "model infrastructure"],
    keywords: ["model serving", "model inference", "inference infrastructure", "gpu cloud", "llm infrastructure"]
  },
  {
    slug: "developer-tools",
    label: "Developer Tools",
    order: 3,
    description: "Products that help software teams build, test, deploy, or operate software.",
    aliases: ["developer tooling", "dev tools", "devtools"],
    keywords: ["software development kit", "developer platform", "code editor", "continuous integration", "api platform"]
  },
  {
    slug: "cybersecurity",
    label: "Cybersecurity",
    order: 4,
    description: "Products that protect applications, identities, networks, data, or infrastructure.",
    aliases: ["cyber security", "information security", "infosec"],
    keywords: ["application security", "cloud security", "identity security", "threat detection", "security operations"]
  },
  {
    slug: "cloud-infrastructure",
    label: "Cloud Infrastructure",
    order: 5,
    description: "Cloud compute, storage, networking, orchestration, and operational infrastructure.",
    aliases: ["cloud infra", "cloud platform"],
    keywords: ["cloud computing", "cloud orchestration", "kubernetes infrastructure", "serverless infrastructure", "cloud networking"]
  },
  {
    slug: "data-infrastructure",
    label: "Data Infrastructure",
    order: 6,
    description: "Infrastructure for storing, moving, processing, governing, or querying data.",
    aliases: ["data infra", "data platform"],
    keywords: ["data warehouse", "data lake", "data pipeline", "database infrastructure", "stream processing"]
  },
  {
    slug: "open-source",
    label: "Open Source",
    order: 7,
    description: "Companies whose product or go-to-market is centered on open-source software.",
    aliases: ["open source software", "oss"],
    keywords: ["open source project", "open source platform", "source available"]
  },
  {
    slug: "robotics",
    label: "Robotics",
    order: 8,
    description: "Physical robots and the software, controls, or services that power them.",
    aliases: ["robotic systems", "robotics software"],
    keywords: ["robot", "robots", "humanoid robot", "robot fleet", "robot manipulation"]
  },
  {
    slug: "computer-vision",
    label: "Computer Vision",
    order: 9,
    description: "Systems that understand or generate information from images and video.",
    aliases: ["vision ai", "visual ai", "machine vision"],
    keywords: ["image recognition", "video understanding", "visual inspection", "image segmentation"]
  },
  {
    slug: "voice-ai",
    label: "Voice AI",
    order: 10,
    description: "AI products centered on spoken conversation, speech recognition, or voice generation.",
    aliases: ["speech ai", "conversational voice ai"],
    keywords: ["speech recognition", "voice agent", "voice assistant", "text to speech", "speech synthesis"]
  },
  {
    slug: "fintech",
    label: "Fintech",
    order: 11,
    description: "Technology products for financial services, financial operations, or investing.",
    aliases: ["financial technology", "financial services technology"],
    keywords: ["financial platform", "wealth management software", "investment platform", "financial operations"]
  },
  {
    slug: "payments",
    label: "Payments",
    order: 12,
    description: "Products that move, accept, orchestrate, or reconcile payments.",
    aliases: ["payment technology", "payment infrastructure"],
    keywords: ["payment processing", "merchant acquiring", "checkout infrastructure", "cross border payments"]
  },
  {
    slug: "banking",
    label: "Banking",
    order: 13,
    description: "Banking products and infrastructure for banks, businesses, or consumers.",
    aliases: ["banking technology", "digital banking", "neobank"],
    keywords: ["banking infrastructure", "core banking", "business banking", "treasury management"]
  },
  {
    slug: "lending",
    label: "Lending",
    order: 14,
    description: "Credit, underwriting, loan origination, and lending infrastructure.",
    aliases: ["credit technology", "loan technology"],
    keywords: ["loan origination", "credit underwriting", "business loans", "consumer lending", "mortgage lending"]
  },
  {
    slug: "insurance",
    label: "Insurance",
    order: 15,
    description: "Insurance products and technology for underwriting, claims, or distribution.",
    aliases: ["insurtech", "insurance technology"],
    keywords: ["insurance underwriting", "claims processing", "insurance carrier", "insurance brokerage"]
  },
  {
    slug: "crypto",
    label: "Crypto",
    order: 16,
    description: "Blockchain, cryptocurrency, stablecoin, and decentralized protocol products.",
    aliases: ["cryptocurrency", "web3", "blockchain"],
    keywords: ["stablecoin", "digital assets", "onchain", "decentralized finance", "smart contract"]
  },
  {
    slug: "healthcare",
    label: "Healthcare",
    order: 17,
    description: "Products for healthcare delivery, administration, providers, patients, or payers.",
    aliases: ["health tech", "healthtech", "digital health"],
    keywords: ["healthcare provider", "patient care", "health system", "care delivery", "health plan"]
  },
  {
    slug: "clinical-ai",
    label: "Clinical AI",
    order: 18,
    description: "AI systems that directly support clinical workflows, documentation, or decisions.",
    aliases: ["medical ai", "healthcare ai"],
    keywords: ["ai for clinicians", "ai for doctors", "clinical documentation", "medical scribe", "clinical decision support"]
  },
  {
    slug: "medical-devices",
    label: "Medical Devices",
    order: 19,
    description: "Regulated or purpose-built physical devices used in diagnosis, monitoring, or treatment.",
    aliases: ["medical device", "medtech"],
    keywords: ["diagnostic device", "patient monitor", "surgical device", "wearable medical device"]
  },
  {
    slug: "biotech",
    label: "Biotech",
    order: 20,
    description: "Biology-based platforms, products, and therapeutics businesses.",
    aliases: ["biotechnology", "biological technology"],
    keywords: ["biologics", "cell therapy", "gene therapy", "protein engineering", "antibody engineering"]
  },
  {
    slug: "drug-discovery",
    label: "Drug Discovery",
    order: 21,
    description: "Platforms and programs for discovering, designing, or validating new medicines.",
    aliases: ["drug development", "therapeutic discovery"],
    keywords: ["drug candidate", "small molecule discovery", "therapeutics platform", "preclinical drug", "molecular discovery"]
  },
  {
    slug: "synthetic-biology",
    label: "Synthetic Biology",
    order: 22,
    description: "Engineering organisms, cells, or biological systems for useful functions.",
    aliases: ["synbio", "engineered biology"],
    keywords: ["engineered organism", "metabolic engineering", "cell programming", "precision fermentation"]
  },
  {
    slug: "manufacturing",
    label: "Manufacturing",
    order: 23,
    description: "Products, services, and production systems for making physical goods.",
    aliases: ["manufacturing technology", "factory technology"],
    keywords: ["factory floor", "production line", "contract manufacturing", "advanced manufacturing"]
  },
  {
    slug: "industrial-automation",
    label: "Industrial Automation",
    order: 24,
    description: "Automation, controls, and software for industrial equipment and processes.",
    aliases: ["factory automation", "industrial controls"],
    keywords: ["process automation", "plc", "scada", "machine automation", "factory control"]
  },
  {
    slug: "supply-chain",
    label: "Supply Chain",
    order: 25,
    description: "Planning, procurement, inventory, and coordination across supply networks.",
    aliases: ["supply chain technology", "supply chain software"],
    keywords: ["inventory planning", "procurement software", "supplier management", "demand planning"]
  },
  {
    slug: "logistics",
    label: "Logistics",
    order: 26,
    description: "Technology for freight, warehousing, fulfillment, and delivery operations.",
    aliases: ["logistics technology", "logistics software"],
    keywords: ["freight", "warehouse operations", "last mile delivery", "fleet management", "fulfillment network"]
  },
  {
    slug: "construction",
    label: "Construction",
    order: 27,
    description: "Technology and services for designing, building, and operating construction projects.",
    aliases: ["construction technology", "contech"],
    keywords: ["construction site", "general contractor", "building contractor", "jobsite"]
  },
  {
    slug: "real-estate",
    label: "Real Estate",
    order: 28,
    description: "Technology for property transactions, ownership, management, and operations.",
    aliases: ["realty", "proptech", "property technology"],
    keywords: ["property management", "commercial property", "residential property", "real estate transaction"]
  },
  {
    slug: "climate",
    label: "Climate",
    order: 29,
    description: "Products that measure, mitigate, or adapt to climate change and emissions.",
    aliases: ["climate tech", "climatetech"],
    keywords: ["carbon removal", "carbon accounting", "decarbonization", "greenhouse gas", "climate resilience"]
  },
  {
    slug: "energy",
    label: "Energy",
    order: 30,
    description: "Technology for producing, storing, distributing, or managing energy.",
    aliases: ["energy technology", "clean energy"],
    keywords: ["energy storage", "electric grid", "renewable energy", "battery technology", "power generation"]
  },
  {
    slug: "agriculture",
    label: "Agriculture",
    order: 31,
    description: "Technology for farming, crops, livestock, and agricultural operations.",
    aliases: ["agtech", "agricultural technology"],
    keywords: ["farm management", "crop production", "precision agriculture", "livestock technology"]
  },
  {
    slug: "food-tech",
    label: "Food Tech",
    order: 32,
    description: "Technology for food production, formulation, processing, and distribution.",
    aliases: ["food technology", "foodtech"],
    keywords: ["food production", "alternative protein", "food processing", "food manufacturing"]
  },
  {
    slug: "defense",
    label: "Defense",
    order: 33,
    description: "Products purpose-built for military, national security, or defense customers.",
    aliases: ["defence", "defense technology", "defense tech"],
    keywords: ["national security", "military technology", "department of defense", "counter drone", "warfighter"]
  },
  {
    slug: "aerospace",
    label: "Aerospace",
    order: 34,
    description: "Aircraft, aviation systems, propulsion, and aerospace components or software.",
    aliases: ["aviation", "aeronautics"],
    keywords: ["aircraft", "flight systems", "air mobility", "aerospace engineering", "unmanned aircraft"]
  },
  {
    slug: "space",
    label: "Space",
    order: 35,
    description: "Spacecraft, satellites, launch, orbital infrastructure, and space services.",
    aliases: ["space technology", "space tech"],
    keywords: ["satellite", "satellites", "spacecraft", "orbital", "lunar", "launch vehicle"]
  },
  {
    slug: "government",
    label: "Government",
    order: 36,
    description: "Products and services built for public-sector agencies and government operations.",
    aliases: ["govtech", "government technology", "public sector technology"],
    keywords: ["government agency", "public sector", "municipal government", "civic technology"]
  },
  {
    slug: "education",
    label: "Education",
    order: 37,
    description: "Products for teaching, learning, schools, training, and educational administration.",
    aliases: ["edtech", "education technology"],
    keywords: ["learning platform", "classroom software", "school administration", "student learning", "online learning"]
  },
  {
    slug: "legal",
    label: "Legal",
    order: 38,
    description: "Products for legal work, legal services, courts, compliance, and law firms.",
    aliases: ["legaltech", "legal technology"],
    keywords: ["law firm", "legal workflow", "legal research", "contract law", "trial lawyer"]
  },
  {
    slug: "hr",
    label: "HR",
    order: 39,
    description: "Human resources products for people operations, recruiting, benefits, and talent.",
    aliases: ["human resources", "hr tech", "people operations"],
    keywords: ["recruiting software", "talent management", "employee benefits", "workforce management"]
  },
  {
    slug: "sales",
    label: "Sales",
    order: 40,
    description: "Products for prospecting, selling, revenue operations, and sales teams.",
    aliases: ["sales technology", "sales tech"],
    keywords: ["sales enablement", "sales automation", "revenue operations", "prospecting software", "crm"]
  },
  {
    slug: "marketing",
    label: "Marketing",
    order: 41,
    description: "Products for marketing, advertising, brand, growth, and audience acquisition.",
    aliases: ["martech", "marketing technology", "adtech"],
    keywords: ["marketing automation", "advertising platform", "customer acquisition", "brand marketing"]
  },
  {
    slug: "customer-support",
    label: "Customer Support",
    order: 42,
    description: "Products for customer service, success, contact centers, and support operations.",
    aliases: ["customer service", "support software"],
    keywords: ["help desk", "contact center", "customer success", "support ticket", "customer experience"]
  },
  {
    slug: "accounting",
    label: "Accounting",
    order: 43,
    description: "Products for accounting, tax, audit, bookkeeping, and financial close workflows.",
    aliases: ["accounting technology", "accounting software"],
    keywords: ["bookkeeping", "tax preparation", "financial close", "accounts payable", "audit software"]
  },
  {
    slug: "e-commerce",
    label: "E-commerce",
    order: 44,
    description: "Online commerce products, merchants, storefronts, and commerce enablement.",
    aliases: ["ecommerce", "online commerce"],
    keywords: ["online store", "commerce platform", "direct to consumer", "online retail", "shopping cart"]
  },
  {
    slug: "marketplaces",
    label: "Marketplaces",
    order: 45,
    description: "Platforms that connect distinct groups of buyers, sellers, providers, or participants.",
    aliases: ["marketplace", "two sided marketplace"],
    keywords: ["buyer and seller", "service marketplace", "marketplace platform", "matching buyers"]
  },
  {
    slug: "consumer-social",
    label: "Consumer Social",
    order: 46,
    description: "Consumer products centered on social connection, communication, or shared content.",
    aliases: ["social networking", "social media"],
    keywords: ["social app", "social network", "consumer community", "friends online"]
  },
  {
    slug: "gaming",
    label: "Gaming",
    order: 47,
    description: "Video games, game studios, game platforms, and gaming infrastructure.",
    aliases: ["video games", "game technology"],
    keywords: ["game studio", "gaming platform", "game developer", "multiplayer game"]
  },
  {
    slug: "creator-economy",
    label: "Creator Economy",
    order: 48,
    description: "Products that help creators make, distribute, manage, or monetize their work.",
    aliases: ["creator tools", "creator platform"],
    keywords: ["content creator", "creator monetization", "influencer platform", "creator business"]
  },
  {
    slug: "travel",
    label: "Travel",
    order: 49,
    description: "Products for trips, lodging, tourism, transportation booking, and travel operations.",
    aliases: ["travel technology", "travel tech"],
    keywords: ["trip planning", "hotel booking", "tourism", "vacation rental", "travel booking"]
  },
  {
    slug: "hardware",
    label: "Hardware",
    order: 50,
    description: "Businesses whose core product includes purpose-built physical computing hardware.",
    aliases: ["hardware technology", "physical hardware"],
    keywords: ["hardware device", "electronic device", "semiconductor", "computer hardware", "sensor hardware"]
  }
] as const satisfies readonly CompanyVerticalDefinitionShape[];

export type CompanyVertical = (typeof COMPANY_VERTICALS)[number]["slug"];
export type CompanyVerticalDefinition = (typeof COMPANY_VERTICALS)[number];

export const COMPANY_VERTICAL_OVERRIDES: Readonly<Record<string, readonly CompanyVertical[]>> =
  COMPANY_VERTICAL_OVERRIDE_VALUES;

export type CompanyVerticalClassificationSource = "curated" | "override" | "inferred" | "unclassified";

export interface CompanyVerticalMetadata {
  companyId: string;
  batchSlug?: string | null;
  primaryIndustry?: string | null;
  industries?: readonly string[] | null;
  tagline?: string | null;
  description?: string | null;
  businessModel?: string | null;
  tags?: readonly string[] | null;
  categories?: readonly string[] | null;
  /** Explicit, reviewed values on the company record. These take highest precedence. */
  curatedVerticals?: readonly CompanyVertical[] | null;
}

export type CompanyVerticalInferenceField =
  | "primaryIndustry"
  | "industries"
  | "businessModel"
  | "tags"
  | "categories"
  | "tagline"
  | "description";

export interface CompanyVerticalExplanation {
  vertical: CompanyVertical;
  label: string;
  score: number | null;
  matchedFields: CompanyVerticalInferenceField[];
  matchedTerms: string[];
  reason: string;
}

export interface CompanyVerticalClassification {
  taxonomyVersion: typeof COMPANY_VERTICAL_TAXONOMY_VERSION;
  source: CompanyVerticalClassificationSource;
  verticals: CompanyVertical[];
  unclassified: boolean;
  explanations: CompanyVerticalExplanation[];
}

interface WeightedMetadataValue {
  field: CompanyVerticalInferenceField;
  normalizedValue: string;
  exactWeight: number;
  phraseWeight: number;
}

interface InferenceMatch {
  field: CompanyVerticalInferenceField;
  term: string;
  score: number;
}

interface InferenceCandidate {
  vertical: CompanyVertical;
  score: number;
  matches: InferenceMatch[];
}

// Deliberately absent from COMPANY_VERTICALS and from transport output.
const INTERNAL_UNCLASSIFIED_VERTICAL = "__unclassified__" as const;
const MIN_INFERENCE_SCORE = 30;

const verticalSlugSet: ReadonlySet<string> = new Set(COMPANY_VERTICALS.map(({ slug }) => slug));
const verticalOrder = new Map<CompanyVertical, number>(
  COMPANY_VERTICALS.map(({ slug, order }) => [slug, order])
);

export function isCompanyVertical(value: string): value is CompanyVertical {
  return verticalSlugSet.has(value);
}

export function getCompanyVerticalDefinition(vertical: CompanyVertical): CompanyVerticalDefinition {
  const definition = COMPANY_VERTICALS.find(({ slug }) => slug === vertical);
  if (!definition) {
    throw new Error(`Unknown company vertical: ${vertical}`);
  }
  return definition;
}

/** Sorts, deduplicates, and bounds canonical values without accepting aliases. */
export function normalizeCompanyVerticals(
  values: readonly CompanyVertical[],
  maximum: number = MAX_INFERRED_COMPANY_VERTICALS
): CompanyVertical[] {
  const unique = new Set(values);
  return COMPANY_VERTICALS
    .filter(({ slug }) => unique.has(slug))
    .slice(0, Math.max(0, maximum))
    .map(({ slug }) => slug);
}

export function companyVerticalOverrideKey(batchSlug: string, companyId: string): string {
  return `${batchSlug.trim()}:${companyId.trim()}`;
}

/**
 * Infers zero to five verticals exclusively from trusted company metadata.
 * Traction, score, engagement, and evidence fields are intentionally not part
 * of the input contract. Array order and duplicate metadata do not affect the
 * result.
 */
export function inferCompanyVerticals(metadata: CompanyVerticalMetadata): CompanyVerticalClassification {
  const curated = metadata.curatedVerticals
    ? normalizeCompanyVerticals(metadata.curatedVerticals)
    : [];
  if (curated.length > 0) {
    return classificationForExplicitValues(curated, "curated", "Explicit reviewed company metadata.");
  }

  const override = findCompanyVerticalOverride(metadata);
  if (override.length > 0) {
    return classificationForExplicitValues(override, "override", "Curated company override.");
  }

  const values = weightedMetadataValues(metadata);
  const candidates = COMPANY_VERTICALS
    .map((definition): InferenceCandidate => {
      const terms = uniqueNormalizedTerms([definition.label, ...definition.aliases, ...definition.keywords]);
      const matches = values.flatMap((value) => matchesForValue(value, terms));
      return {
        vertical: definition.slug,
        score: matches.reduce((sum, match) => sum + match.score, 0),
        matches
      };
    })
    .filter(({ score }) => score >= MIN_INFERENCE_SCORE)
    .sort(compareInferenceCandidates)
    .slice(0, MAX_INFERRED_COMPANY_VERTICALS);

  const internalValues: Array<CompanyVertical | typeof INTERNAL_UNCLASSIFIED_VERTICAL> =
    candidates.length > 0
      ? candidates.map(({ vertical }) => vertical)
      : [INTERNAL_UNCLASSIFIED_VERTICAL];

  if (internalValues[0] === INTERNAL_UNCLASSIFIED_VERTICAL) {
    return {
      taxonomyVersion: COMPANY_VERTICAL_TAXONOMY_VERSION,
      source: "unclassified",
      verticals: [],
      unclassified: true,
      explanations: []
    };
  }

  return {
    taxonomyVersion: COMPANY_VERTICAL_TAXONOMY_VERSION,
    source: "inferred",
    verticals: candidates.map(({ vertical }) => vertical),
    unclassified: false,
    explanations: candidates.map(explanationForCandidate)
  };
}

function classificationForExplicitValues(
  verticals: readonly CompanyVertical[],
  source: "curated" | "override",
  reason: string
): CompanyVerticalClassification {
  const normalized = normalizeCompanyVerticals(verticals);
  return {
    taxonomyVersion: COMPANY_VERTICAL_TAXONOMY_VERSION,
    source,
    verticals: normalized,
    unclassified: false,
    explanations: normalized.map((vertical) => ({
      vertical,
      label: getCompanyVerticalDefinition(vertical).label,
      score: null,
      matchedFields: [],
      matchedTerms: [],
      reason
    }))
  };
}

function findCompanyVerticalOverride(metadata: CompanyVerticalMetadata): CompanyVertical[] {
  const batchKey = metadata.batchSlug
    ? companyVerticalOverrideKey(metadata.batchSlug, metadata.companyId)
    : null;
  const entries: Readonly<Record<string, readonly CompanyVertical[]>> = COMPANY_VERTICAL_OVERRIDES;
  const values = (batchKey ? entries[batchKey] : undefined) ?? entries[metadata.companyId] ?? [];
  return normalizeCompanyVerticals(values);
}

function weightedMetadataValues(metadata: CompanyVerticalMetadata): WeightedMetadataValue[] {
  return [
    ...fieldValues("primaryIndustry", [metadata.primaryIndustry], 120, 60),
    ...fieldValues("industries", metadata.industries, 110, 50),
    ...fieldValues("businessModel", [metadata.businessModel], 105, 45),
    ...fieldValues("tags", metadata.tags, 90, 40),
    ...fieldValues("categories", metadata.categories, 90, 40),
    ...fieldValues("tagline", [metadata.tagline], 70, 32),
    ...fieldValues("description", [metadata.description], 45, 18)
  ];
}

function fieldValues(
  field: CompanyVerticalInferenceField,
  rawValues: readonly (string | null | undefined)[] | null | undefined,
  exactWeight: number,
  phraseWeight: number
): WeightedMetadataValue[] {
  const values = new Set(
    (rawValues ?? [])
      .map((value) => normalizeText(value ?? ""))
      .filter((value) => value.length > 0)
  );
  return [...values]
    .sort((left, right) => left.localeCompare(right))
    .map((normalizedValue) => ({ field, normalizedValue, exactWeight, phraseWeight }));
}

function uniqueNormalizedTerms(rawTerms: readonly string[]): string[] {
  return [...new Set(rawTerms.map(normalizeText).filter((term) => term.length > 0))];
}

function matchesForValue(value: WeightedMetadataValue, terms: readonly string[]): InferenceMatch[] {
  const matches: InferenceMatch[] = [];
  for (const term of terms) {
    if (value.normalizedValue === term) {
      matches.push({ field: value.field, term, score: value.exactWeight });
    } else if (containsPhrase(value.normalizedValue, term)) {
      matches.push({ field: value.field, term, score: value.phraseWeight });
    }
  }
  return matches;
}

function containsPhrase(value: string, phrase: string): boolean {
  return ` ${value} `.includes(` ${phrase} `);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compareInferenceCandidates(left: InferenceCandidate, right: InferenceCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  return (verticalOrder.get(left.vertical) ?? Number.MAX_SAFE_INTEGER)
    - (verticalOrder.get(right.vertical) ?? Number.MAX_SAFE_INTEGER);
}

function explanationForCandidate(candidate: InferenceCandidate): CompanyVerticalExplanation {
  const matchedFields = [...new Set(candidate.matches.map(({ field }) => field))].sort(compareFields);
  const matchedTerms = [...new Set(candidate.matches.map(({ term }) => term))].sort((left, right) =>
    left.localeCompare(right)
  );
  const label = getCompanyVerticalDefinition(candidate.vertical).label;
  return {
    vertical: candidate.vertical,
    label,
    score: candidate.score,
    matchedFields,
    matchedTerms,
    reason: `${label} matched ${matchedTerms.join(", ")} in ${matchedFields.join(", ")}.`
  };
}

function compareFields(left: CompanyVerticalInferenceField, right: CompanyVerticalInferenceField): number {
  const fieldOrder: readonly CompanyVerticalInferenceField[] = [
    "primaryIndustry",
    "industries",
    "businessModel",
    "tags",
    "categories",
    "tagline",
    "description"
  ];
  return fieldOrder.indexOf(left) - fieldOrder.indexOf(right);
}
