import githubTractionSnapshot from "@/lib/social/github-traction-a16z-speedrun-006.json";
import seededAttributionReconciliationSnapshot from "@/lib/social/a16z-speedrun-006-attribution-reconciliation.json";
import seededSocialEvidenceSnapshot from "@/lib/social/a16z-speedrun-006-social-evidence.json";
import publicEvidenceSnapshot from "@/lib/social/public-evidence-current.json";
import speedrunSocialAccountSnapshot from "@/lib/social/a16z-speedrun-006-social-accounts.json";
import { calibrateBatchCompanyScores } from "@/lib/scoring/batch-calibration";

import {
  dedupeEvidenceForScoring,
  dedupeEvidenceItems,
  nativeEvidenceIdentityFromUrl
} from "./dedupe";
import { enrichEvidenceThumbnail } from "./evidence-thumbnails";
import { aggregateBalancedTractionScore, normalizeEvidenceScores } from "./traction-scoring";
import type {
  BusinessModel,
  CompanyRecord,
  DemoGraphDataset,
  EvidenceItem,
  EvidenceMetrics,
  FounderRecord,
  Platform,
  SocialAccountSummary
} from "./types";

export const A16Z_SPEEDRUN_006_BATCH_SLUG = "A16ZSR006";
export const A16Z_SPEEDRUN_006_BATCH_LABEL = "a16z speedrun 006";

const SPEEDRUN_SOURCE_URL = "https://speedrun.a16z.com/";
const SPEEDRUN_NATIVE_EVIDENCE_PLATFORMS = new Set<Platform>([
  "github",
  "linkedin",
  "instagram",
  "x",
  "youtube",
  "reddit",
  "product_hunt",
  "hacker_news",
  "bilibili",
  "tiktok",
  "bluesky"
]);
const ACCEPTED_GITHUB_LOGINS = new Set([
  "amdahlco",
  "belong-dev",
  "grove-tax",
  "modaic-ai",
  "panorama-dev",
  "taxnova-ai"
]);
const REJECTED_GITHUB_LOGINS = new Set(["amdahl-ai", "antihero-studios"]);
const REJECTED_GITHUB_REPOS = new Set([
  "antihero-studios/antihero-messaging-services",
  "antihero-studios/antihero-repos-services",
  "antihero-studios/cloud-functions",
  "botallen/repository.botallen",
  "mirrormirrorai-shengkai/amplify-next-template",
  "oasiz-/m32script",
  "oasiz/mirc_auth",
  "trymeridian/.github",
  "usecascadeio/.github"
]);
const PUBLIC_SOCIAL_EVIDENCE_ATTACHMENTS: PublicSocialEvidenceAttachment[] = [
  {
    sourceUrl: "https://linkedin.com/posts/shankarl_organizationalmemory-ai-sentra-activity-7422333778263560194-AO0q",
    companySlug: "sentra",
    companyName: "Sentra",
    matchReason: "Public LinkedIn post explicitly names Sentra and a16z speedrun."
  }
];
const FOUNDER_SLUG_OVERRIDES = new Map<string, string>([
  ["oasis/Stefano Fantini Delmanto", "stefano-delmanto"],
  ["prior-foundry/Johne Kamphorst", "jonne-kamphorst"],
  ["sun/Matt Gunhan Ertosun", "matt-gunhan-ertosun-phd"]
]);

interface SpeedrunCompanyProfile {
  name: string;
  websiteUrl: string;
  tagline: string;
  location: string;
  employeeCount: number;
  tags: string[];
  founders: string[];
}

interface GithubTractionSnapshot {
  source: {
    fetchedAt: string;
  };
  accounts: GithubTractionAccount[];
}

interface GithubTractionAccount {
  entityType: "company" | "founder";
  entityId: string;
  companySlug?: string;
  companyName: string;
  name?: string;
  sourceUrl?: string;
  githubUrl: string;
  discoverySource?: string;
  matchReason?: string;
  login: string;
  repo?: string | null;
  fetched: boolean;
  account?: {
    login?: string;
    name?: string | null;
    htmlUrl?: string;
    followers?: number;
    publicRepos?: number;
  };
  aggregate?: {
    repoCount?: number;
    totalStars?: number;
    totalForks?: number;
    totalWatchers?: number;
    profileScore?: number;
    maxRepoScore?: number;
  };
  repos?: GithubRepo[];
}

interface GithubRepo {
  id?: number;
  name?: string;
  fullName: string;
  description?: string | null;
  htmlUrl: string;
  stars?: number;
  forks?: number;
  watchers?: number;
  openIssues?: number;
  language?: string | null;
  pushedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  score?: number;
}

interface PublicEvidenceSnapshot {
  source: {
    fetchedAt: string;
  };
  evidence: PublicEvidenceRecord[];
}

type PublicEvidenceRecord = Omit<EvidenceItem, "postedAt"> & {
  postedAt?: string | null;
  batchSlug?: string;
  batch_slug?: string;
  companySlug?: string;
  companyName?: string;
  attributionVersion?: number;
  attributionStatus?: string;
};

interface PublicSocialEvidenceAttachment {
  sourceUrl: string;
  companySlug: string;
  companyName: string;
  matchReason: string;
}

interface SeededSocialEvidenceSnapshot {
  source: {
    generatedAt: string;
  };
  evidence: SeededSocialEvidenceRecord[];
}

interface SeededAttributionReconciliationSnapshot {
  schemaVersion: number;
  attributionReconciliationLedger: SeededAttributionReconciliationDirective[];
}

interface SeededAttributionReconciliationDirective {
  platform: Platform;
  sourceUrl: string;
  platformPostId: string;
  disposition: "quarantined";
  reason: string;
  staleAttribution: {
    batchSlug: string;
    entityType: "company";
    entityId: string;
    attributionType: "subject";
  };
}

interface SeededSocialEvidenceRecord {
  companySlug: string;
  companyName: string;
  entityType: "company" | "founder";
  founderName?: string;
  platform: Platform;
  sourceUrl: string;
  platformPostId?: string | null;
  accountUrl?: string | null;
  authorName: string;
  authorHandle?: string | null;
  postedAt: string;
  title: string;
  text: string;
  mediaType: EvidenceItem["mediaType"];
  mediaUrl?: string | null;
  mediaUrls?: string[];
  thumbnailUrl?: string | null;
  thumbnailSource?: string | null;
  metrics: EvidenceMetrics;
  rawVisibleText?: string;
  matchReason: string;
  why: string;
  review_state?: "verified" | "needs_review" | "rejected";
}

export interface A16zSpeedrun006EvidenceItem extends EvidenceItem {
  targetFounderId?: string;
}

interface SeededSocialEvidenceAttribution {
  entityType: "company" | "founder";
  entityId: string;
  targetFounderId?: string;
}

interface CanonicalSeededGithubRepository {
  sourceUrl: string;
  platformPostId: string;
  sourceCommitId: string;
  metrics: EvidenceMetrics;
}

interface SpeedrunSocialAccountSnapshot {
  source: {
    fetchedAt?: string;
    generatedAt?: string;
  };
  companies: SpeedrunSocialAccountCompany[];
}

interface SpeedrunSocialAccountCompany {
  companyName: string;
  companySlug?: string;
  accounts?: SpeedrunSocialAccountRecord[];
  founders?: SpeedrunSocialAccountFounder[];
}

interface SpeedrunSocialAccountFounder {
  name: string;
  founderSlug?: string;
  accounts?: SpeedrunSocialAccountRecord[];
}

interface SpeedrunSocialAccountRecord {
  platform: Platform;
  url: string;
  handle?: string | null;
  verifiedFrom?: string;
  evidenceUrl?: string;
  matchReason?: string;
  review_state?: "verified" | "needs_review" | "rejected";
}

const speedrun006Profiles: SpeedrunCompanyProfile[] = [
  {
    name: "Acceler8",
    websiteUrl: "https://useacceler8.com",
    tagline: "AI for Workforce Intelligence & Planning (2x founder who raised $80M, F500 customers)",
    location: "San Francisco, California",
    employeeCount: 15,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Chinmay Chauhan", "Trisha Pathak"]
  },
  {
    name: "Advocate",
    websiteUrl: "https://advocatewellbeing.com",
    tagline:
      "The AI-native system for easy & reimbursable care coordination. ex Garner Health, McKinsey team. 7 live facilities, $7M projected revenue",
    location: "New York, New York",
    employeeCount: 4,
    tags: ["AI", "Healthcare", "Enterprise SaaS"],
    founders: ["Andrew Baran"]
  },
  {
    name: "Alike",
    websiteUrl: "https://alike.work",
    tagline: "The Agent Collaboration Layer for Enterprises",
    location: "San Francisco, California",
    employeeCount: 4,
    tags: ["AI", "Deep Tech", "Enterprise SaaS"],
    founders: ["Addi Haran Diman", "Max Van Kleek", "Danial Hussain"]
  },
  {
    name: "Amdahl",
    websiteUrl: "https://amdahl.ai",
    tagline: "AI Context layer for all Enterprise GTM work (ex-Databricks, Coinbase team, $4m pipeline)",
    location: "San Francisco, California",
    employeeCount: 5,
    tags: ["Adtech / Marketing Tech", "Enterprise SaaS", "Infra"],
    founders: ["Annette Sung", "Robert Khoury", "Arya Soltanieh"]
  },
  {
    name: "Antihero Studios",
    websiteUrl: "https://antiherostudios.com/",
    tagline: 'Creating "Games Worth Sharing". Our team were leads on 8 different $1B/year games',
    location: "Barcelona, Spain",
    employeeCount: 10,
    tags: ["Gaming"],
    founders: ["Brice Laville Saint Martin", "Andre Parodi", "Frank Yu Yan"]
  },
  {
    name: "August",
    websiteUrl: "https://tryaugust.com",
    tagline: "AI autonomous bankers",
    location: "Tel Aviv, Israel",
    employeeCount: 3,
    tags: ["AI", "Fintech", "Enterprise SaaS"],
    founders: ["Bar Ittah", "Tom Tankilevitch"]
  },
  {
    name: "Auto",
    websiteUrl: "https://auto.inc",
    tagline: "AI camera that turns photos into personal apps. Ex-Snapchat founders with multiple previous exits.",
    location: "Los Angeles, California",
    employeeCount: 3,
    tags: ["AI"],
    founders: ["Dave Evans", "Sam Hare"]
  },
  {
    name: "Belong",
    websiteUrl: "https://belongrewards.com/",
    tagline: "Financial infrastructure of fandom. Ex-Spotify Global Head of Music + Avicii's manager.",
    location: "New York, New York",
    employeeCount: 9,
    tags: ["Consumer", "Fintech", "Commerce / Marketplaces"],
    founders: ["Nick Holmsten", "Ash Pournouri"]
  },
  {
    name: "Bilrost",
    websiteUrl: "https://bilrost.ai/",
    tagline: "Automated infrastructure for modern commercial lenders.",
    location: "Oakland, California",
    employeeCount: 5,
    tags: ["AI", "Fintech", "Enterprise SaaS"],
    founders: ["Silvia Chen", "Peter Hsu"]
  },
  {
    name: "Bota",
    websiteUrl: "https://bota.dev",
    tagline: "Bridging AI agents and the real world: $0 -> $710K cARR in 5 weeks",
    location: "Mountain View, California",
    employeeCount: 4,
    tags: ["AI", "Dev Tools & DevOps", "Enterprise SaaS"],
    founders: ["Ruming Zhen", "Qi Zhang"]
  },
  {
    name: "Cascade",
    websiteUrl: "https://usecascade.ai/",
    tagline: "AI for construction wins.",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Hannia Zia", "Joana Ferreira"]
  },
  {
    name: "Cedar",
    websiteUrl: "https://getcedar.ai",
    tagline: "Killing LinkedIn with Agents, from the founding team of HootSuite. $2.5M contracted rev",
    location: "San Francisco, California",
    employeeCount: 4,
    tags: ["AI", "Consumer", "Enterprise SaaS"],
    founders: ["Greg Gunn", "Beier Cai"]
  },
  {
    name: "Clair Health",
    websiteUrl: "https://wearclair.com",
    tagline: "We're building the first continuous hormone monitor.",
    location: "Mountain View, California",
    employeeCount: 7,
    tags: ["Healthcare", "Deep Tech"],
    founders: ["Jenny Duan"]
  },
  {
    name: "Coalition Systems",
    websiteUrl: "https://coalition.systems",
    tagline: "AI coordination software for allied defense.",
    location: "San Francisco, California",
    employeeCount: 4,
    tags: ["Gov Tech / Defense", "Deep Tech", "Infra"],
    founders: ["Vijay Pathak", "Freddie Wollen"]
  },
  {
    name: "Concorda",
    websiteUrl: "https://concordahq.com",
    tagline: "AI operating system for trial lawyers; Harvard CS + lawyer founders; $210K ARR in 3 months.",
    location: "San Francisco, California",
    employeeCount: 3,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Samuel Oh", "Ke Ma"]
  },
  {
    name: "Crebit",
    websiteUrl: "https://crebitpay.com",
    tagline: "Rate-locking for stablecoin FX. $2M/mo processing, 100% MoM. Stanford & MIT, ex-Amazon/NASA.",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["Fintech"],
    founders: ["Jensen Coonradt", "Simmi Sen"]
  },
  {
    name: "Emanate",
    websiteUrl: "https://emanate.ai/",
    tagline: "The First AI Revenue Engine Built for the Physical Economy.",
    location: "San Francisco, California",
    employeeCount: 7,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Kiara Nirghin"]
  },
  {
    name: "Grove Tax",
    websiteUrl: "https://grove.tax/",
    tagline: "AI Workforce for Tax Firms from ex Airbnb, Intuit team",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["AI", "Fintech", "Enterprise SaaS"],
    founders: ["Uday Nandam", "Gaurav Mathur"]
  },
  {
    name: "Hammock",
    websiteUrl: "https://usehammock.co",
    tagline:
      "The only HSA/FSA agent that saves you money. 2x founder ($50M ARR, $50M raised) and VP of Product @ Weight Watchers",
    location: "Brooklyn, New York",
    employeeCount: 3,
    tags: ["AI", "Fintech", "Healthcare"],
    founders: ["Jesse Rose", "Will Dennis"]
  },
  {
    name: "Heavi",
    websiteUrl: "https://heaviai.com",
    tagline: "AI workforce for heavy vehicle mechanics. Two 2x founders who raised $200M and $75M prev",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["AI", "Commerce / Marketplaces", "Enterprise SaaS"],
    founders: ["Sanjay Dasari", "Michael Holkesvik"]
  },
  {
    name: "Hotbox",
    websiteUrl: "https://hotbox.app",
    tagline: "Predictive intelligence for social commerce, $450k ARR",
    location: "San Francisco, California",
    employeeCount: 3,
    tags: ["AI", "Adtech / Marketing Tech", "Consumer"],
    founders: ["Harpriya Bagri"]
  },
  {
    name: "Idilio",
    websiteUrl: "https://idilio.tv/en",
    tagline: "The future of serialized storytelling. $0->$32K/mo since Jan with ~1 day ROAS breakeven",
    location: "Bogota, Colombia",
    employeeCount: 9,
    tags: ["AI", "Consumer", "Media / Entertainment / Creator Economy"],
    founders: ["Gabriela Tafur", "Esteban Ramirez"]
  },
  {
    name: "Kaaro",
    websiteUrl: "https://kaaro.ai",
    tagline: "AI Agents for Railways. ex Toma (a16z), Waterloo, UBC",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Sai Surisetti", "Gautham Venkateshwaran"]
  },
  {
    name: "Loops AI",
    websiteUrl: "https://loopsai.com",
    tagline: "The commerce intelligence layer for e-commerce brands that sell more with AI",
    location: "San Francisco, California",
    employeeCount: 12,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Ari Nazir", "Ilker Zorluoglu", "Yusuf Bahadir", "Hakan Bas"]
  },
  {
    name: "Meridian",
    websiteUrl: "https://trymeridian.dev/",
    tagline: "Ex. OpenAI, Palantir, Sandia Labs building the AI operating system for consulting firms",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["Enterprise SaaS", "AI", "Infra"],
    founders: ["Kashyap Nathan", "Chris Farrington"]
  },
  {
    name: "Miraka",
    websiteUrl: "https://miraka.ai",
    tagline: "The AI-Powered Cardiac Care Team",
    location: "New York, New York",
    employeeCount: 3,
    tags: ["Healthcare", "AI"],
    founders: ["Nolan Abeyta", "Kazuo Nakamura", "Jesse Abeyta"]
  },
  {
    name: "Mirror Mirror AI",
    websiteUrl: "https://mirrormirrorai.com/",
    tagline: "The marketplace for licensing likeness for content & usage",
    location: "San Francisco, California",
    employeeCount: 8,
    tags: ["AI", "Commerce / Marketplaces"],
    founders: ["Yusan Lin"]
  },
  {
    name: "Modaic",
    websiteUrl: "https://modaic.dev",
    tagline: "Verification & alignment infra for AI decisions. MIT / BU team, design partnerships with Accenture, Dropbox, and Vercel.",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["Infra", "AI"],
    founders: ["Farouk Adeleke", "Tyrin-Ian Todd"]
  },
  {
    name: "Modern Industrials",
    websiteUrl: "https://modernindustrials.com",
    tagline: "The AI Workforce for Building Materials Distribution. Built by lifelong friends from xAI, Google, and McKinsey.",
    location: "New York, New York",
    employeeCount: 4,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Austin Mao", "Vatsal Bhargava", "Ankit Bhargava"]
  },
  {
    name: "Oasis",
    websiteUrl: "https://joinoasis.com",
    tagline: "The AI-Native Organization built by Ex-Palantir FDEs",
    location: "New York, New York",
    employeeCount: 5,
    tags: ["Media / Entertainment / Creator Economy", "Infra", "Enterprise SaaS"],
    founders: ["Stefano Fantini Delmanto", "Naveen Sharma"]
  },
  {
    name: "Oasiz",
    websiteUrl: "https://oasiz.ai/",
    tagline:
      "TikTok for AI-native software. 350K+ plays, 10M organic TikTok views, Atari partnership. Ex-Stanford/Google/Tesla, prev #1 App Store.",
    location: "San Francisco, California",
    employeeCount: 4,
    tags: ["AI", "Consumer", "B2C"],
    founders: ["Abel Dagne", "Jonathan Dinh"]
  },
  {
    name: "Omi Health",
    websiteUrl: "https://joinomi.com",
    tagline: "Function Health for Pets.",
    location: "New York, New York",
    employeeCount: 2,
    tags: ["Healthcare", "AI", "B2C"],
    founders: ["Sindu Chaparala", "Jakob Spiess"]
  },
  {
    name: "Panorama",
    websiteUrl: "https://withpanorama.com",
    tagline: "Enterprise AI workflow enablement built by an ex-Cash App, Lyft, Google, and MIT PhD team",
    location: "San Francisco, California",
    employeeCount: 4,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["Jingwei Hao", "Jaclyn Lunger"]
  },
  {
    name: "PartyHat",
    websiteUrl: "https://getpartyhat.com",
    tagline: "Disrupting consumer cybersecurity -- founded by prev cyber and gaming co execs",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["AI", "B2C"],
    founders: ["Jarret Cuisinier", "Vijay Myneni"]
  },
  {
    name: "PayPath",
    websiteUrl: "https://paypath.ai",
    tagline: "The AI Operating System Powering Modern Debt.",
    location: "NYC, New York",
    employeeCount: 3,
    tags: ["AI", "Fintech", "Enterprise SaaS"],
    founders: ["Dean Glas", "Matthew Lippl", "Matthew Angelini"]
  },
  {
    name: "PicPet",
    websiteUrl: "https://picpet.app/",
    tagline: "Social messaging platform where friendships feed virtual pets. >240K DAU and >45% D90 bounded retention",
    location: "San Francisco, California",
    employeeCount: 6,
    tags: ["Consumer"],
    founders: ["Jimmy Huang"]
  },
  {
    name: "Piper-ai",
    websiteUrl: "https://piper-ai.com",
    tagline: "The AI workforce for construction.",
    location: "San Francisco, California",
    employeeCount: 7,
    tags: ["Enterprise SaaS", "AI"],
    founders: ["Ido Gedanken", "Erez Tepper", "Roi Menzin"]
  },
  {
    name: "Pluvo",
    websiteUrl: "https://pluvo.io/",
    tagline: "Context Infrastructure for Enterprise Finance | The new operating model for understanding the why behind every number.",
    location: "San Francisco, California",
    employeeCount: 14,
    tags: ["AI", "Enterprise SaaS", "Infra"],
    founders: ["Alexandre Labreche", "Andrew Ingram", "Seb Fallenbuchl", "Vanessa Galarneau"]
  },
  {
    name: "Prior Foundry",
    websiteUrl: "https://priorfoundry.com",
    tagline: "Test policies before they launch.",
    location: "San Francisco, California",
    employeeCount: 3,
    tags: ["AI"],
    founders: ["Shirin Abrishami Kashani", "Keshav Sivakumar", "Johne Kamphorst"]
  },
  {
    name: "Quanto",
    websiteUrl: "https://tryquanto.com",
    tagline: "AI Workforce for Accounting Firms to Grow Revenue and Margins",
    location: "San Francisco, California",
    employeeCount: 6,
    tags: ["AI", "Fintech"],
    founders: ["Anderson Petergeorge", "Kajanth Nithiyananthan"]
  },
  {
    name: "Quinn",
    websiteUrl: "https://meetquinn.ai",
    tagline: "Building for the 2.7B frontline workforce with no modern training infrastructure",
    location: "New York, New York",
    employeeCount: 10,
    tags: ["Enterprise SaaS", "AI"],
    founders: ["Ben Anderson", "Arlen Marmel"]
  },
  {
    name: "Quo Labs",
    websiteUrl: "https://withsam.com",
    tagline: "AI caretaker for seniors",
    location: "San Francisco, California",
    employeeCount: 3,
    tags: ["AI", "Healthcare", "B2C", "Robotics"],
    founders: ["Audrey Lo", "Jenny Wen"]
  },
  {
    name: "SafeWorld",
    websiteUrl: "https://safeworld.ai",
    tagline: "Making robots safe",
    location: "Palo Alto, California",
    employeeCount: 6,
    tags: ["AI", "Infra", "Robotics"],
    founders: ["Kyle Wong", "Simo Rachidi", "Ding Zhao"]
  },
  {
    name: "Sellara",
    websiteUrl: "https://sellara.io",
    tagline: "Applied AI Research Lab for Financial Institutions | Founded by ex-Citi, YC founders",
    location: "NYC, New York",
    employeeCount: 4,
    tags: ["Fintech", "Infra", "Enterprise SaaS"],
    founders: ["Charles-Andre Jolly", "Ahmad Roumie", "Spencer Secord"]
  },
  {
    name: "Sentra",
    websiteUrl: "https://sentra.app/",
    tagline: "The foundational memory for Enterprise General Intelligence.",
    location: "San Francisco, California",
    employeeCount: 12,
    tags: ["AI", "Enterprise SaaS", "Infra"],
    founders: ["Ashwin Gopinath", "Andrey Starenky"]
  },
  {
    name: "Simula",
    websiteUrl: "https://simula.ad",
    tagline: "Living AI native ad infrastructure, integrating into AI platforms with 6M+ DAUs",
    location: "San Francisco, California",
    employeeCount: 5,
    tags: ["AI", "Adtech / Marketing Tech", "Enterprise SaaS"],
    founders: ["Yizhen Zhen"]
  },
  {
    name: "Sirius Technology",
    websiteUrl: "https://thesirius.ai/",
    tagline: "AI Retention Platform for Subscription Companies. $3M ARR",
    location: "San Francisco, California",
    employeeCount: 15,
    tags: ["AI", "Enterprise SaaS", "Infra"],
    founders: ["Azamat K", "Benazir Toleubekova"]
  },
  {
    name: "Smart Bricks",
    websiteUrl: "https://smart-bricks.com",
    tagline: "Applied AI Lab for Real Estate. $12M annualized revenue run-rate.",
    location: "San Francisco, California",
    employeeCount: 20,
    tags: ["AI", "Infra", "Fintech"],
    founders: ["Mohamed Mohamed"]
  },
  {
    name: "snag",
    websiteUrl: "https://snagsublets.com/",
    tagline: "AI sublet marketplace for GenZ. $6.5M in requests/mo, 40% MoM. Repeat founders, backed by GC",
    location: "New York, New York",
    employeeCount: 4,
    tags: ["Commerce / Marketplaces", "B2C"],
    founders: ["Selin Sonmez", "Niko Georgantas"]
  },
  {
    name: "Snapp Stats",
    websiteUrl: "https://trysnapp.ai",
    tagline: "24/7 AI Agent for Sports. From sports content to action, instantly. Built by the founder of Caviar",
    location: "San Francisco, California",
    employeeCount: 6,
    tags: ["AI", "B2C", "Enterprise SaaS"],
    founders: ["Shawn Tsao", "Andrew Tamura", "Min Park", "Alex Marshall"]
  },
  {
    name: "Sparta",
    websiteUrl: "https://usesparta.co",
    tagline: "Adaptive data transfer optimization for high-performance infrastructure, Berkeley CS founders.",
    location: "San Francisco, California",
    employeeCount: 3,
    tags: ["AI", "Deep Tech", "Infra"],
    founders: ["Arya Kanna", "Saad Asad", "Lalith Posam"]
  },
  {
    name: "Straia",
    websiteUrl: "https://straia.io",
    tagline: "The agentic AI platform for higher education ($4.5M cARR in 4 weeks)",
    location: "San Francisco, California",
    employeeCount: 6,
    tags: ["AI", "Edtech", "Enterprise SaaS"],
    founders: ["Ryan Lau", "Alan Chan", "Gautam Narasimhan", "Nikki Dansey"]
  },
  {
    name: "SUN",
    websiteUrl: "https://sunapp.ai",
    tagline: "Personalized AI audio. Harvard CS, Stanford AI PhD, ex-Amazon Podcasts founding engineer.",
    location: "Palo Alto, California",
    employeeCount: 3,
    tags: ["AI", "B2C"],
    founders: ["Artin Bogdanov", "Matt Gunhan Ertosun"]
  },
  {
    name: "Syncere",
    websiteUrl: "https://syncere.com",
    tagline: "Robot lamps that do your chores.",
    location: "Palo Alto, California",
    employeeCount: 8,
    tags: ["Robotics"],
    founders: ["Aaron Tan", "Angus Fung"]
  },
  {
    name: "Taxnova",
    websiteUrl: "https://taxnova.ai",
    tagline: "AI infrastructure to run R&D tax claims and CapEx",
    location: "San Francisco, California",
    employeeCount: 5,
    tags: ["AI", "Enterprise SaaS"],
    founders: ["George Nichkov", "Maria Malykh"]
  },
  {
    name: "Thirdbrain Labs",
    websiteUrl: "https://thirdbrainlabs.ai",
    tagline: "Unlocking the next one billion specialized models",
    location: "San Francisco, California",
    employeeCount: 2,
    tags: ["Robotics", "Infra", "Enterprise SaaS"],
    founders: ["Margaret Zhang", "David Huang"]
  },
  {
    name: "VariantNow",
    websiteUrl: "https://variantnow.com",
    tagline: "AI Infrastructure for the Adaptive Web. $600K ARR in 3 months",
    location: "Tel Aviv-Yafo, Israel",
    employeeCount: 6,
    tags: ["AI", "Enterprise SaaS", "Adtech / Marketing Tech"],
    founders: ["Elad Nissenberg", "Ben Segal"]
  },
  {
    name: "Vereda",
    websiteUrl: "https://vereda.ia.br",
    tagline: "The AI procurement agent for agriculture. 800k acres, representing $8M in potential revenue, in 45 days.",
    location: "Rio Verde, Brazil",
    employeeCount: 6,
    tags: ["AI", "Commerce / Marketplaces", "Fintech"],
    founders: ["Joao Souza", "Pedro Galindo"]
  },
  {
    name: "ZeroDrift",
    websiteUrl: "https://zerodrift.ai",
    tagline: "ZeroDrift makes every message compliant before it's sent. 2x founder (raised $50M). $150K ARR, 50%+ MoM",
    location: "New York, New York",
    employeeCount: 6,
    tags: ["AI", "Infra", "Fintech"],
    founders: ["Kumesh Aroomoogan"]
  }
];

const githubSnapshot = githubTractionSnapshot as unknown as GithubTractionSnapshot;
const publicSnapshot = publicEvidenceSnapshot as unknown as PublicEvidenceSnapshot;
const seededSocialSnapshot = seededSocialEvidenceSnapshot as unknown as SeededSocialEvidenceSnapshot;
const seededAttributionReconciliation =
  seededAttributionReconciliationSnapshot as SeededAttributionReconciliationSnapshot;
const socialAccountSnapshot = speedrunSocialAccountSnapshot as unknown as SpeedrunSocialAccountSnapshot;
const speedrunProfileSlugs = new Set(speedrun006Profiles.map((profile) => slugify(profile.name)));
const speedrunSocialAccountsByEntityId = groupSocialAccountsByEntity();
const speedrunEvidenceItems = resolveEvidenceSocialAccountIds(
  buildSpeedrunEvidenceItems(),
  speedrunSocialAccountsByEntityId
);
const speedrunEvidenceByEntityId = groupEvidenceByEntity(speedrunEvidenceItems);
const speedrunCompanyRecords = calibrateBatchCompanyScores(speedrun006Profiles.map(toCompanyRecord));
const speedrunFounderRecords = speedrun006Profiles.flatMap(toFounderRecords);

export const a16zSpeedrun006GraphDataset: DemoGraphDataset & { evidence: A16zSpeedrun006EvidenceItem[] } = {
  mode: "official_snapshot",
  batches: [
    {
      slug: A16Z_SPEEDRUN_006_BATCH_SLUG,
      label: A16Z_SPEEDRUN_006_BATCH_LABEL,
      companyCountExpected: 59,
      companyCountObserved: speedrun006Profiles.length
    }
  ],
  companies: speedrunCompanyRecords,
  founders: speedrunFounderRecords,
  evidence: speedrunEvidenceItems,
  needsReview: [],
  platformStatus: []
};

function toCompanyRecord(profile: SpeedrunCompanyProfile): CompanyRecord {
  const companySlug = slugify(profile.name);
  const companyId = companyIdFromSlug(companySlug);
  const relatedEntityIds = [companyId, ...profile.founders.map((name) => founderId(companySlug, name))];
  const companyEvidence = relatedEntityIds.flatMap((entityId) => speedrunEvidenceByEntityId.get(entityId) ?? []);
  const scoreBreakdown = aggregateBalancedTractionScore(dedupeEvidenceForScoring(companyEvidence));
  const socialAccounts = dedupeSocialAccounts(speedrunSocialAccountsByEntityId.get(companyId) ?? []);
  const description = [
    profile.tagline,
    `Speedrun 006 profile: ${profile.employeeCount} employees; located in ${profile.location}; tags: ${profile.tags.join(", ")}.`
  ].join("\n\n");

  return {
    id: companyId,
    batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG,
    name: profile.name,
    ycProfileUrl: speedrunCompanyUrl(companySlug),
    websiteUrl: profile.websiteUrl,
    tagline: profile.tagline,
    description,
    groupPartner: "a16z speedrun",
    primaryIndustry: primaryIndustry(profile.tags),
    businessModel: businessModel(profile.tags),
    review_state: "verified",
    sourceUrl: speedrunCompanyUrl(companySlug),
    industries: profile.tags.map(normalizeIndustryTag),
    founderIds: profile.founders.map((name) => founderId(companySlug, name)),
    socialAccounts,
    totalScore: scoreBreakdown.totalScore,
    previousScore: scoreBreakdown.totalScore,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown
  };
}

function toFounderRecords(profile: SpeedrunCompanyProfile): FounderRecord[] {
  const companySlug = slugify(profile.name);
  const companyId = companyIdFromSlug(companySlug);
  const industry = primaryIndustry(profile.tags);
  const model = businessModel(profile.tags);

  return profile.founders.map((name) => {
    const entityId = founderId(companySlug, name);
    const founderEvidence = speedrunEvidenceByEntityId.get(entityId) ?? [];
    const scoreBreakdown = aggregateBalancedTractionScore(dedupeEvidenceForScoring(founderEvidence));
    const socialAccounts = dedupeSocialAccounts(speedrunSocialAccountsByEntityId.get(entityId) ?? []);

    return {
      id: entityId,
      batchSlug: A16Z_SPEEDRUN_006_BATCH_SLUG,
      name,
      ycProfileUrl: speedrunFounderUrl(companySlug, name),
      personalWebsiteUrl: null,
      primaryIndustry: industry,
      businessModel: model,
      review_state: "verified" as const,
      sourceUrl: speedrunFounderUrl(companySlug, name),
      companyIds: [companyId],
      socialAccounts,
      totalScore: scoreBreakdown.totalScore,
      previousScore: scoreBreakdown.totalScore,
      platformScores: scoreBreakdown.platformScores,
      scoreBreakdown
    };
  });
}

function primaryIndustry(tags: string[]): string {
  if (hasTag(tags, "Healthcare")) return "healthcare";
  if (hasTag(tags, "Fintech")) return "fintech";
  if (hasTag(tags, "Robotics")) return "robotics";
  if (
    hasTag(tags, "Gaming") ||
    hasTag(tags, "Consumer") ||
    hasTag(tags, "B2C") ||
    hasTag(tags, "Media / Entertainment / Creator Economy")
  ) {
    return "consumer";
  }
  if (hasTag(tags, "Commerce / Marketplaces")) return "commerce / marketplaces";
  if (hasTag(tags, "Gov Tech / Defense")) return "government";
  if (hasTag(tags, "Adtech / Marketing Tech")) return "adtech / marketing tech";
  if (hasTag(tags, "Infra") || hasTag(tags, "Deep Tech") || hasTag(tags, "Dev Tools & DevOps")) return "infra";
  return "b2b";
}

function businessModel(tags: string[]): BusinessModel {
  if (hasTag(tags, "Fintech")) return "fintech";
  if (hasTag(tags, "Healthcare")) return "healthcare";
  if (hasTag(tags, "Commerce / Marketplaces")) return "marketplace";
  if (hasTag(tags, "Robotics")) return "hardware";
  if (hasTag(tags, "Dev Tools & DevOps") || hasTag(tags, "Infra") || hasTag(tags, "Deep Tech")) {
    return "developer_tools";
  }
  if (
    hasTag(tags, "Consumer") ||
    hasTag(tags, "B2C") ||
    hasTag(tags, "Gaming") ||
    hasTag(tags, "Media / Entertainment / Creator Economy")
  ) {
    return "consumer";
  }
  return "b2b";
}

function hasTag(tags: string[], target: string): boolean {
  return tags.some((tag) => tag.toLowerCase() === target.toLowerCase());
}

function normalizeIndustryTag(tag: string): string {
  return tag.toLowerCase();
}

function companyIdFromSlug(slug: string): string {
  return `a16z-speedrun-006-${slug}`;
}

function founderId(companySlug: string, name: string): string {
  return `${companyIdFromSlug(companySlug)}-founder-${slugify(name)}`;
}

function speedrunCompanyUrl(companySlug: string): string {
  return `${SPEEDRUN_SOURCE_URL}companies/${companySlug}`;
}

function speedrunFounderUrl(companySlug: string, name: string): string {
  return `${speedrunCompanyUrl(companySlug)}/${FOUNDER_SLUG_OVERRIDES.get(`${companySlug}/${name}`) ?? slugify(name)}`;
}

function buildSpeedrunEvidenceItems(): A16zSpeedrun006EvidenceItem[] {
  const githubEvidence = githubSnapshot.accounts.filter(isHighConfidenceGithubAccount).flatMap(githubEvidenceForAccount);
  const publicEvidence = [
    ...publicSnapshot.evidence.flatMap(publicEvidenceItemFromCanonicalAttribution),
    ...PUBLIC_SOCIAL_EVIDENCE_ATTACHMENTS.flatMap(publicEvidenceItemFromAttachment)
  ];
  const seededSocialEvidence = sanitizedSeededSocialEvidence().flatMap(seededSocialEvidenceItem);

  return normalizeEvidenceScores(
    dedupeEvidenceItems([...githubEvidence, ...publicEvidence, ...seededSocialEvidence])
      .filter(isNativeSpeedrunEvidenceItem)
      .map(enrichEvidenceThumbnail)
  );
}

function sanitizedSeededSocialEvidence(): SeededSocialEvidenceRecord[] {
  if (seededAttributionReconciliation.schemaVersion !== 1) {
    throw new Error("Unsupported A16Z seeded attribution reconciliation schema.");
  }
  const excludedRows = new Set<SeededSocialEvidenceRecord>();
  for (const directive of seededAttributionReconciliation.attributionReconciliationLedger) {
    if (
      directive.disposition !== "quarantined" ||
      directive.staleAttribution.batchSlug !== A16Z_SPEEDRUN_006_BATCH_SLUG ||
      directive.staleAttribution.entityType !== "company" ||
      directive.staleAttribution.attributionType !== "subject" ||
      !directive.reason
    ) {
      throw new Error("Invalid A16Z seeded attribution reconciliation directive.");
    }
    const matches = seededSocialSnapshot.evidence.filter((seed) =>
      seed.platform === directive.platform &&
      (seed.platformPostId ?? platformPostIdFromUrl(seed.sourceUrl)) === directive.platformPostId &&
      seed.entityType === directive.staleAttribution.entityType &&
      companyIdFromSlug(slugify(seed.companySlug)) === directive.staleAttribution.entityId &&
      canonicalEvidenceUrl(seed.sourceUrl) === canonicalEvidenceUrl(directive.sourceUrl)
    );
    if (matches.length !== 1) {
      throw new Error(
        `A16Z seeded attribution reconciliation for ${directive.platform}:${directive.platformPostId} ` +
        `resolved ${matches.length} rows; expected exactly one.`
      );
    }
    excludedRows.add(matches[0]);
  }
  return seededSocialSnapshot.evidence.filter((seed) => !excludedRows.has(seed));
}

function canonicalEvidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

function isHighConfidenceGithubAccount(account: GithubTractionAccount): boolean {
  const companySlug = account.companySlug ? slugify(account.companySlug) : null;
  const login = account.login.toLowerCase();
  const repoKey = githubRepoKey(account.githubUrl);
  const repoKeys = (account.repos ?? []).map((repo) => githubRepoKey(repo.fullName));

  return Boolean(
    account.fetched &&
      companySlug &&
      speedrunProfileSlugs.has(companySlug) &&
      ACCEPTED_GITHUB_LOGINS.has(login) &&
      !REJECTED_GITHUB_LOGINS.has(login) &&
      !REJECTED_GITHUB_REPOS.has(repoKey) &&
      repoKeys.every((key) => !REJECTED_GITHUB_REPOS.has(key))
  );
}

function githubEvidenceForAccount(account: GithubTractionAccount): EvidenceItem[] {
  const companySlug = slugify(account.companySlug ?? "");
  const companyId = companyIdFromSlug(companySlug);
  const fetchedAt = githubSnapshot.source.fetchedAt;

  return (account.repos ?? [])
    .filter((repo) => !REJECTED_GITHUB_REPOS.has(githubRepoKey(repo.fullName)))
    .map((repo) => {
      const metrics: EvidenceMetrics = {
        stars: repo.stars ?? 0,
        forks: repo.forks ?? 0,
        watchers: repo.watchers ?? repo.stars ?? 0,
        open_issues: repo.openIssues ?? 0,
        followers: account.account?.followers ?? 0
      };
      const rawEngagement = githubRawEngagement(metrics);
      const handle = account.account?.login ?? account.login;
      const repoName = repo.fullName;
      const description = repo.description?.trim() || "GitHub repository.";
      const accountUrl = account.account?.htmlUrl ?? `https://github.com/${handle}`;
      const publishedAt = repo.pushedAt ?? repo.updatedAt ?? repo.createdAt ?? fetchedAt;
      const hasRepositoryTimestamp = Boolean(repo.pushedAt ?? repo.updatedAt ?? repo.createdAt);

      return {
        id: `github-a16z-${companySlug}-${slugify(repoName)}`,
        entityType: "company" as const,
        entityId: companyId,
        platform: "github" as const,
        authorName: account.account?.name ?? account.companyName,
        authorHandle: handle,
        postedAt: publishedAt,
        publishedAtPrecision: hasRepositoryTimestamp ? publicationTimestampPrecision(publishedAt) : "unknown",
        observedAt: fetchedAt,
        metricsCheckedAt: fetchedAt,
        title: `${repoName}: ${description}`,
        text: `${repoName}: ${description}`,
        mediaType: "repo" as const,
        mediaUrl: repo.htmlUrl,
        metrics,
        contributionScore: rawEngagement > 0 ? Math.max(repo.score ?? 1, 1) : 0,
        rawEngagement,
        sourceUrl: repo.htmlUrl,
        platformPostId: repoName,
        platformObjectId: repo.id == null ? null : String(repo.id),
        rawVisibleText: JSON.stringify({ repo }),
        first_seen_at: fetchedAt,
        last_checked_at: fetchedAt,
        last_updated_at: fetchedAt,
        why: `Verified public GitHub repository for ${account.companyName}.`,
        attachedCompanyId: companyId,
        attachedCompanyName: account.companyName,
        socialAccountId: null,
        accountUrl,
        matchReason: account.matchReason ?? "Matched to public GitHub organization.",
        review_state: "verified" as const
      };
    });
}

function publicEvidenceItemFromAttachment(attachment: PublicSocialEvidenceAttachment): EvidenceItem[] {
  const source = publicSnapshot.evidence.find((item) => item.sourceUrl === attachment.sourceUrl);
  return source ? publicEvidenceItemFromSource(source, attachment) : [];
}

function publicEvidenceItemFromCanonicalAttribution(source: PublicEvidenceRecord): EvidenceItem[] {
  const explicitBatchSlug = String(source.batchSlug ?? source.batch_slug ?? "").trim().toUpperCase();
  if (
    explicitBatchSlug !== A16Z_SPEEDRUN_006_BATCH_SLUG ||
    source.review_state !== "verified" ||
    Number(source.attributionVersion ?? 0) < 3 ||
    source.attributionStatus !== "verified" ||
    source.entityType !== "company" ||
    source.linkStatus === "invalid" ||
    source.linkStatus === "blocked"
  ) {
    return [];
  }

  const companySlug = slugify(source.companySlug ?? "");
  const profile = speedrun006Profiles.find((candidate) => slugify(candidate.name) === companySlug);
  const nativePostId = nativeEvidenceIdentityFromUrl(source.platform, source.sourceUrl);
  if (
    !profile ||
    !nativePostId ||
    (source.platformPostId && source.platformPostId.toLowerCase() !== nativePostId.toLowerCase())
  ) {
    return [];
  }

  return publicEvidenceItemFromSource(source, {
    sourceUrl: source.sourceUrl,
    companySlug,
    companyName: profile.name,
    matchReason: source.matchReason ?? "Verified canonical public attribution for a16z speedrun 006."
  });
}

function publicEvidenceItemFromSource(
  source: PublicEvidenceRecord,
  attachment: PublicSocialEvidenceAttachment
): EvidenceItem[] {
  if (!SPEEDRUN_NATIVE_EVIDENCE_PLATFORMS.has(source.platform)) return [];

  const companyId = companyIdFromSlug(attachment.companySlug);
  const normalizedAccount = normalizeNativeAccountRoot(source.platform, source.accountUrl ?? null);
  const accountUrl = normalizedAccount?.url ?? null;
  const handle = source.authorHandle ?? normalizedAccount?.handle ?? handleFromUrl(accountUrl);
  const isLinkedInActivityFragment = isLinkedInProfileActivityFragmentUrl(source.platform, source.sourceUrl);

  return [
    {
      ...source,
      id: `${source.platform}-a16z-${attachment.companySlug}-${slugify(source.platformPostId ?? source.sourceUrl)}`,
      entityType: "company",
      entityId: companyId,
      postedAt: source.postedAt ?? publicSnapshot.source.fetchedAt,
      publishedAtPrecision: source.postedAt
        ? source.publishedAtPrecision ?? publicationTimestampPrecision(source.postedAt)
        : "unknown",
      observedAt: source.observedAt ?? source.first_seen_at ?? publicSnapshot.source.fetchedAt,
      metricsCheckedAt: source.metricsCheckedAt ?? source.last_checked_at ?? publicSnapshot.source.fetchedAt,
      authorHandle: handle,
      contributionScore: isLinkedInActivityFragment ? 0 : source.contributionScore ?? 1,
      first_seen_at: source.first_seen_at ?? publicSnapshot.source.fetchedAt,
      last_checked_at: source.last_checked_at ?? publicSnapshot.source.fetchedAt,
      last_updated_at: source.last_updated_at ?? publicSnapshot.source.fetchedAt,
      why: isLinkedInActivityFragment
        ? "Stored as context only. LinkedIn profile activity fragments lack a stable native post identity and are not counted as post-level traction."
        : `${source.why ?? source.matchReason ?? "Verified public native evidence."} Reattached to ${attachment.companyName} from explicit a16z speedrun attribution.`,
      attachedCompanyId: companyId,
      attachedCompanyName: attachment.companyName,
      socialAccountId: null,
      accountUrl,
      matchReason: attachment.matchReason,
      review_state: "verified"
    }
  ];
}

function seededSocialEvidenceItem(seed: SeededSocialEvidenceRecord): A16zSpeedrun006EvidenceItem[] {
  if (!SPEEDRUN_NATIVE_EVIDENCE_PLATFORMS.has(seed.platform)) return [];

  const companySlug = slugify(seed.companySlug);
  if (!speedrunProfileSlugs.has(companySlug)) return [];

  const normalizedSeed = normalizeSeededGithubRepository(seed);
  const companyId = companyIdFromSlug(companySlug);
  const normalizedAccount = normalizeNativeAccountRoot(normalizedSeed.platform, normalizedSeed.accountUrl ?? null);
  const accountUrl = normalizedAccount?.url ?? null;
  const handle = normalizedSeed.authorHandle ?? normalizedAccount?.handle ?? handleFromUrl(accountUrl);
  const attribution = seededSocialEvidenceAttribution(normalizedSeed, companySlug, companyId, accountUrl, handle);
  const isLinkedInActivityFragment = isLinkedInProfileActivityFragmentUrl(
    normalizedSeed.platform,
    normalizedSeed.sourceUrl
  );

  return [
    {
      id: `${normalizedSeed.platform}-a16z-seed-${companySlug}-${slugify(normalizedSeed.sourceUrl)}`,
      entityType: attribution.entityType,
      entityId: attribution.entityId,
      platform: normalizedSeed.platform,
      authorName: normalizedSeed.authorName,
      authorHandle: handle,
      postedAt: normalizedSeed.postedAt,
      publishedAtPrecision: publicationTimestampPrecision(normalizedSeed.postedAt),
      observedAt: seededSocialSnapshot.source.generatedAt,
      metricsCheckedAt: seededSocialSnapshot.source.generatedAt,
      title: normalizedSeed.title,
      text: normalizedSeed.text,
      mediaType: normalizedSeed.mediaType,
      mediaUrl: normalizedSeed.mediaUrl ?? null,
      mediaUrls: normalizedSeed.mediaUrls ?? [],
      thumbnailUrl: normalizedSeed.thumbnailUrl ?? null,
      thumbnailSource: normalizedSeed.thumbnailSource ?? null,
      metrics: normalizedSeed.metrics,
      contributionScore: isLinkedInActivityFragment ? 0 : 1,
      sourceUrl: normalizedSeed.sourceUrl,
      platformPostId:
        normalizedSeed.platformPostId ?? platformPostIdFromUrl(normalizedSeed.sourceUrl),
      rawVisibleText: normalizedSeed.rawVisibleText ?? JSON.stringify({
        title: normalizedSeed.title,
        metrics: normalizedSeed.metrics,
        seededFrom: "a16z-speedrun-006-social-evidence"
      }),
      first_seen_at: seededSocialSnapshot.source.generatedAt,
      last_checked_at: seededSocialSnapshot.source.generatedAt,
      last_updated_at: seededSocialSnapshot.source.generatedAt,
      why: isLinkedInActivityFragment
        ? "Stored as context only. LinkedIn profile activity fragments lack a stable native post identity and are not counted as post-level traction."
        : normalizedSeed.why,
      attachedCompanyId: companyId,
      attachedCompanyName: normalizedSeed.companyName,
      ...(attribution.targetFounderId ? { targetFounderId: attribution.targetFounderId } : {}),
      socialAccountId: null,
      accountUrl,
      matchReason: normalizedSeed.matchReason,
      review_state: normalizedSeed.review_state ?? "verified"
    }
  ];
}

function normalizeSeededGithubRepository(seed: SeededSocialEvidenceRecord): SeededSocialEvidenceRecord {
  const repository = canonicalSeededGithubRepository(seed);
  if (!repository) return seed;

  return {
    ...seed,
    sourceUrl: repository.sourceUrl,
    platformPostId: repository.platformPostId,
    mediaUrl: repository.sourceUrl,
    metrics: repository.metrics,
    rawVisibleText: JSON.stringify({
      canonicalRepository: {
        sourceUrl: repository.sourceUrl,
        platformPostId: repository.platformPostId,
        metrics: repository.metrics
      },
      sourceProvenance: {
        kind: "github_commit",
        sourceUrl: seed.sourceUrl,
        platformPostId: seed.platformPostId ?? repository.sourceCommitId,
        rawVisibleText: parseRawVisibleText(seed.rawVisibleText)
      }
    }),
    why: `Verified GitHub repository activity for ${repository.platformPostId}; canonicalized from audited source commit ${seed.sourceUrl}. ${seed.why}`
  };
}

function canonicalSeededGithubRepository(
  seed: SeededSocialEvidenceRecord
): CanonicalSeededGithubRepository | null {
  if (
    seed.platform !== "github" ||
    seed.mediaType !== "repo" ||
    (seed.review_state ?? "verified") !== "verified"
  ) {
    return null;
  }

  try {
    const url = new URL(seed.sourceUrl);
    if (url.hostname.replace(/^www\./i, "").toLowerCase() !== "github.com") return null;

    const [owner, repo, objectKind, sourceCommitId, ...rest] = url.pathname.split("/").filter(Boolean);
    if (
      rest.length > 0 ||
      objectKind?.toLowerCase() !== "commit" ||
      !/^[a-f0-9]{7,64}$/i.test(sourceCommitId ?? "")
    ) {
      return null;
    }

    const sourceUrl = `https://github.com/${owner}/${repo}`;
    const platformPostId = nativeEvidenceIdentityFromUrl("github", sourceUrl);
    const metrics = canonicalGithubRepositoryMetrics(seed.metrics);
    if (!platformPostId || Object.keys(metrics).length === 0) return null;

    return {
      sourceUrl,
      platformPostId,
      sourceCommitId,
      metrics
    };
  } catch {
    return null;
  }
}

function canonicalGithubRepositoryMetrics(metrics: EvidenceMetrics): EvidenceMetrics {
  const canonicalMetrics: EvidenceMetrics = {
    stars: visibleGithubMetric(metrics.stars),
    forks: visibleGithubMetric(metrics.forks),
    watchers: visibleGithubMetric(metrics.watchers),
    issues: maximumVisibleGithubMetric(metrics.issues, metrics.open_issues, metrics.openIssues),
    recent_commits_30d: visibleGithubMetric(metrics.recent_commits_30d)
  };

  return Object.fromEntries(
    Object.entries(canonicalMetrics).filter((entry): entry is [string, number] => entry[1] !== undefined)
  );
}

function visibleGithubMetric(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function maximumVisibleGithubMetric(...values: Array<number | undefined>): number | undefined {
  const visibleValues = values.flatMap((value) => {
    const visibleValue = visibleGithubMetric(value);
    return visibleValue === undefined ? [] : [visibleValue];
  });
  return visibleValues.length > 0 ? Math.max(...visibleValues) : undefined;
}

function parseRawVisibleText(value: string | undefined): unknown {
  if (!value) return null;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function seededSocialEvidenceAttribution(
  seed: SeededSocialEvidenceRecord,
  companySlug: string,
  companyId: string,
  accountUrl: string | null,
  handle: string | null
): SeededSocialEvidenceAttribution {
  const companyAttribution: SeededSocialEvidenceAttribution = {
    entityType: "company",
    entityId: companyId
  };
  if (seed.entityType !== "founder") {
    return companyAttribution;
  }

  const profile = speedrun006Profiles.find((candidate) => slugify(candidate.name) === companySlug);
  const profileFounderNames = profile?.founders ?? [];
  const targetFounderName = seed.founderName
    ? profileFounderNames.find((name) => slugify(name) === slugify(seed.founderName ?? ""))
    : null;
  const targetFounderId = targetFounderName ? founderId(companySlug, targetFounderName) : undefined;

  const snapshotCompany = socialAccountSnapshot.companies.find((company) => {
    const slug = slugify(company.companySlug ?? company.companyName);
    return slug === companySlug;
  });
  const normalizedHandle = normalizeEvidenceHandle(handle);
  const normalizedAccountUrl = normalizeNativeAccountRoot(seed.platform, accountUrl)?.url ?? null;
  const matchedFounder = snapshotCompany?.founders?.find((founder) =>
    (founder.accounts ?? []).some((account) => {
      if (account.platform !== seed.platform) return false;
      const normalizedRecordAccount = normalizeNativeAccountRoot(account.platform, account.url);
      const normalizedRecordUrl = normalizedRecordAccount?.url ?? null;
      const normalizedRecordHandle = normalizeEvidenceHandle(account.handle ?? normalizedRecordAccount?.handle ?? handleFromUrl(account.url));

      return (
        (normalizedAccountUrl && normalizedRecordUrl === normalizedAccountUrl) ||
        (normalizedHandle && normalizedRecordHandle === normalizedHandle)
      );
    })
  );

  if (matchedFounder && profileFounderNames.some((name) => slugify(name) === slugify(matchedFounder.name))) {
    const ownerName = profileFounderNames.find((name) => slugify(name) === slugify(matchedFounder.name));
    return {
      entityType: "founder",
      entityId: founderId(companySlug, ownerName ?? matchedFounder.name),
      ...(targetFounderId ? { targetFounderId } : {})
    };
  }

  const authorFounderName = profileFounderNames.find((name) => slugify(name) === slugify(seed.authorName));
  if (authorFounderName) {
    return {
      entityType: "founder",
      entityId: founderId(companySlug, authorFounderName),
      ...(targetFounderId ? { targetFounderId } : {})
    };
  }

  return {
    ...companyAttribution,
    ...(targetFounderId ? { targetFounderId } : {})
  };
}

function normalizeEvidenceHandle(value: string | null | undefined): string | null {
  const normalized = value?.replace(/^@/, "").trim().toLowerCase() ?? "";
  return normalized || null;
}

function groupEvidenceByEntity(items: EvidenceItem[]): Map<string, EvidenceItem[]> {
  const grouped = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    grouped.set(item.entityId, [...(grouped.get(item.entityId) ?? []), item]);
  }
  return grouped;
}

function resolveEvidenceSocialAccountIds(
  items: A16zSpeedrun006EvidenceItem[],
  accountsByEntityId: Map<string, SocialAccountSummary[]>
): A16zSpeedrun006EvidenceItem[] {
  return items.map((item) => {
    const canonicalAccountUrl = canonicalNativeAccountUrl(item.platform, evidenceAccountUrl(item));
    const account = canonicalAccountUrl
      ? (accountsByEntityId.get(item.entityId) ?? []).find(
          (candidate) =>
            candidate.platform === item.platform &&
            canonicalNativeAccountUrl(candidate.platform, candidate.url) === canonicalAccountUrl
        )
      : undefined;

    return {
      ...item,
      socialAccountId: account?.id ?? null
    };
  });
}

function evidenceAccountUrl(item: EvidenceItem): string | null {
  if (item.accountUrl) {
    return item.accountUrl;
  }

  return item.platform === "github" || item.platform === "x" || item.platform === "tiktok" || item.platform === "bluesky"
    ? item.sourceUrl
    : null;
}

function groupSocialAccountsByEntity(): Map<string, SocialAccountSummary[]> {
  const grouped = new Map<string, SocialAccountSummary[]>();

  for (const company of socialAccountSnapshot.companies ?? []) {
    const companySlug = slugify(company.companySlug ?? company.companyName);
    if (!speedrunProfileSlugs.has(companySlug)) continue;

    addSocialAccounts(grouped, "company", companyIdFromSlug(companySlug), company.accounts ?? []);

    for (const founder of company.founders ?? []) {
      addSocialAccounts(grouped, "founder", founderId(companySlug, founder.name), founder.accounts ?? []);
    }
  }

  for (const [entityId, accounts] of grouped) {
    grouped.set(entityId, dedupeSocialAccounts(accounts));
  }

  return grouped;
}

function addSocialAccounts(
  grouped: Map<string, SocialAccountSummary[]>,
  entityType: EvidenceItem["entityType"],
  entityId: string,
  records: SpeedrunSocialAccountRecord[]
): void {
  for (const record of records) {
    const account = socialAccountFromSnapshot(record, entityType, entityId);
    if (!account) continue;
    grouped.set(entityId, [...(grouped.get(entityId) ?? []), account]);
  }
}

function socialAccountFromSnapshot(
  record: SpeedrunSocialAccountRecord,
  entityType: EvidenceItem["entityType"],
  entityId: string
): SocialAccountSummary | null {
  if (!SPEEDRUN_NATIVE_EVIDENCE_PLATFORMS.has(record.platform)) return null;
  if ((record.review_state ?? "verified") !== "verified") return null;

  const normalizedAccount = normalizeNativeAccountRoot(record.platform, record.url);
  if (!normalizedAccount) return null;

  return {
    id: socialAccountId(entityType, entityId, record.platform, normalizedAccount.url),
    platform: record.platform,
    handle: record.handle ?? normalizedAccount.handle,
    url: normalizedAccount.url,
    review_state: record.review_state ?? "verified",
    discoveredFromUrl: record.evidenceUrl ?? record.verifiedFrom ?? null,
    matchReason: record.matchReason ?? `Verified ${record.platform} account for a16z speedrun 006.`
  };
}

function isNativeSpeedrunEvidenceItem(item: EvidenceItem): boolean {
  const media = item as EvidenceItem & { mediaUrl?: string | null; mediaUrls?: string[] | null };
  return (
    SPEEDRUN_NATIVE_EVIDENCE_PLATFORMS.has(item.platform) &&
    isAllowedNativeEvidenceUrl(item.platform, item.sourceUrl) &&
    (!item.accountUrl || isAllowedNativeEvidenceUrl(item.platform, item.accountUrl)) &&
    !isA16zProfileUrl(media.mediaUrl) &&
    !(media.mediaUrls ?? []).some(isA16zProfileUrl)
  );
}

function isAllowedNativeEvidenceUrl(platform: Platform, rawUrl: string | null | undefined): boolean {
  const host = normalizedHost(rawUrl);
  if (!host || isA16zProfileUrl(rawUrl)) return false;

  if (platform === "github") return host === "github.com";
  if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
  if (platform === "x") return host === "x.com" || host === "twitter.com";
  if (platform === "instagram") return host === "instagram.com" || host.endsWith(".instagram.com");
  if (platform === "youtube") return host === "youtube.com" || host === "youtu.be";
  if (platform === "reddit") return host === "reddit.com" || host.endsWith(".reddit.com");
  if (platform === "product_hunt") return host === "producthunt.com";
  if (platform === "hacker_news") return host === "news.ycombinator.com";
  if (platform === "bilibili") return host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv";
  if (platform === "tiktok") return host === "tiktok.com" || host.endsWith(".tiktok.com");
  if (platform === "bluesky") return host === "bsky.app";
  return false;
}

function normalizeNativeAccountRoot(
  platform: Platform,
  rawUrl: string | null | undefined
): { url: string; handle: string | null } | null {
  if (!rawUrl || isA16zProfileUrl(rawUrl)) return null;

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if (platform === "github" && host === "github.com") {
      const handle = (parts[0]?.toLowerCase() === "orgs" ? parts[1] : parts[0])?.replace(/\.git$/i, "");
      return handle ? { url: `https://github.com/${handle}`, handle } : null;
    }

    if (platform === "linkedin" && (host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      if (!["company", "in", "school"].includes(namespace ?? "") || !handle) return null;
      return { url: `https://www.linkedin.com/${namespace}/${handle}`, handle };
    }

    if (platform === "x" && (host === "x.com" || host === "twitter.com")) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? { url: `https://x.com/${handle}`, handle } : null;
    }

    if (platform === "instagram" && (host === "instagram.com" || host.endsWith(".instagram.com"))) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? { url: `https://www.instagram.com/${handle}`, handle } : null;
    }

    if (platform === "tiktok" && (host === "tiktok.com" || host.endsWith(".tiktok.com"))) {
      const handle = parts[0]?.replace(/^@/, "");
      return handle ? { url: `https://www.tiktok.com/@${handle}`, handle } : null;
    }

    if (platform === "bluesky" && host === "bsky.app") {
      const handle = parts[0]?.toLowerCase() === "profile" ? parts[1] : null;
      return handle ? { url: `https://bsky.app/profile/${handle}`, handle } : null;
    }

    if (platform === "youtube" && (host === "youtube.com" || host === "youtu.be")) {
      if (host === "youtu.be") return null;
      if (parts[0]?.startsWith("@")) {
        const handle = parts[0].slice(1);
        return handle ? { url: `https://www.youtube.com/@${handle}`, handle } : null;
      }
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      if (!["channel", "c", "user"].includes(namespace ?? "") || !handle) return null;
      return { url: `https://www.youtube.com/${namespace}/${handle}`, handle };
    }

    if (platform === "reddit" && (host === "reddit.com" || host.endsWith(".reddit.com"))) {
      const namespace = parts[0]?.toLowerCase();
      const handle = namespace === "r" || namespace === "user" || namespace === "u" ? parts[1] : parts[0];
      if (!handle) return null;
      const pathNamespace = namespace === "r" || namespace === "user" || namespace === "u" ? namespace : "user";
      return { url: `https://www.reddit.com/${pathNamespace}/${handle}`, handle };
    }

    if (platform === "product_hunt" && host === "producthunt.com") {
      if (parts[0]?.startsWith("@")) {
        const handle = parts[0].slice(1);
        return handle ? { url: `https://www.producthunt.com/@${handle}`, handle } : null;
      }
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      if (!["products", "posts"].includes(namespace ?? "") || !handle) return null;
      return { url: `https://www.producthunt.com/${namespace}/${handle}`, handle };
    }

    if (platform === "hacker_news" && host === "news.ycombinator.com") {
      const handle = url.searchParams.get("id");
      return handle ? { url: `https://news.ycombinator.com/user?id=${handle}`, handle } : null;
    }

    if (platform === "bilibili") {
      if (host === "space.bilibili.com") {
        const handle = parts[0];
        return handle ? { url: `https://space.bilibili.com/${handle}`, handle } : null;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

function canonicalNativeAccountUrl(
  platform: Platform,
  rawUrl: string | null | undefined
): string | null {
  return normalizeNativeAccountRoot(platform, rawUrl)?.url.toLowerCase() ?? null;
}

function normalizedHost(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function isA16zProfileUrl(rawUrl: string | null | undefined): boolean {
  const host = normalizedHost(rawUrl);
  return Boolean(host && (host === "a16z.com" || host === "speedrun.a16z.com" || host.endsWith(".a16z.com")));
}

function dedupeSocialAccounts(accounts: SocialAccountSummary[]): SocialAccountSummary[] {
  const seen = new Set<string>();
  const deduped: SocialAccountSummary[] = [];

  for (const account of accounts) {
    const key = canonicalAccountUrl(account);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(account);
  }

  return deduped;
}

function canonicalAccountUrl(account: SocialAccountSummary): string {
  return `${account.platform}:${account.url.replace(/\/$/, "").toLowerCase()}`;
}

function handleFromUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    if (url.hostname.includes("github.com")) return parts[0];
    if (url.hostname.includes("linkedin.com")) {
      return parts[0] === "in" || parts[0] === "company" ? (parts[1] ?? null) : parts[0];
    }
    if (
      url.hostname.includes("x.com") ||
      url.hostname.includes("twitter.com") ||
      url.hostname.includes("instagram.com") ||
      url.hostname.includes("tiktok.com")
    ) {
      return parts[0];
    }
    if (url.hostname === "bsky.app") return parts[0] === "profile" ? parts[1] ?? null : parts[0];
    if (url.hostname.includes("youtube.com")) {
      return parts[0]?.startsWith("@") ? parts[0].slice(1) : parts[1] ?? parts[0];
    }
    if (url.hostname.includes("reddit.com")) {
      return parts[0] === "r" || parts[0] === "user" || parts[0] === "u" ? parts[1] ?? null : parts[0];
    }
    if (url.hostname.includes("producthunt.com")) {
      return parts[0]?.startsWith("@") ? parts[0].slice(1) : parts[1] ?? parts[0];
    }
    if (url.hostname.includes("news.ycombinator.com")) return url.searchParams.get("id") ?? parts[0];
    if (url.hostname.includes("bilibili.com")) return parts[0] === "video" || parts[0] === "space" ? parts[1] ?? null : parts[0];
    return parts[0];
  } catch {
    return null;
  }
}

function platformPostIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const activityMatch = url.pathname.match(/activity-(\d+)/);
    if (activityMatch) return activityMatch[1];
    const instagramMatch = url.pathname.match(/\/(?:p|reel|tv)\/([^/]+)/);
    if (instagramMatch) return instagramMatch[1];
    const tiktokMatch = url.pathname.match(/\/@[A-Za-z0-9._-]+\/video\/(\d+)/);
    if (tiktokMatch) return tiktokMatch[1];
    const blueskyMatch = url.pathname.match(/^\/profile\/([^/]+)\/post\/([^/]+)/);
    if (blueskyMatch) return `${blueskyMatch[1].toLowerCase()}/post/${blueskyMatch[2]}`;
    if (url.hostname.includes("youtube.com") && url.searchParams.get("v")) return url.searchParams.get("v");
    const redditCommentMatch = url.pathname.match(/\/comments\/([^/]+)\/[^/]+\/([^/]+)/);
    if (redditCommentMatch) return `${redditCommentMatch[1]}-${redditCommentMatch[2]}`;
    const redditMatch = url.pathname.match(/\/comments\/([^/]+)/);
    if (redditMatch) return redditMatch[1];
    if (url.hostname.includes("producthunt.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "products" && parts[2] === "launches") return `${parts[1]}-${parts[3]}`;
      if (parts[0] === "p" && parts[1] && parts[2]) return `${parts[1]}-${parts[2]}`;
      return parts.at(-1) ?? null;
    }
    if (url.hostname.includes("news.ycombinator.com") && url.searchParams.get("id")) return url.searchParams.get("id");
    const bilibiliMatch = url.pathname.match(/\/video\/([^/?]+)/);
    if (bilibiliMatch) return bilibiliMatch[1];
    return url.pathname.split("/").filter(Boolean).pop() ?? rawUrl;
  } catch {
    return rawUrl || null;
  }
}

function isLinkedInProfileActivityFragmentUrl(platform: Platform, rawUrl: string): boolean {
  if (platform !== "linkedin") return false;

  try {
    const url = new URL(rawUrl);
    return /\/recent-activity\//i.test(url.pathname) && /^#post-/i.test(url.hash);
  } catch {
    return false;
  }
}

function publicationTimestampPrecision(value: string): EvidenceItem["publishedAtPrecision"] {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? "day" : "exact";
}

function githubRepoKey(value: string): string {
  if (!value) return "";

  try {
    const url = new URL(value);
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    return `${owner ?? ""}/${(repo ?? "").replace(/\.git$/i, "")}`.toLowerCase();
  } catch {
    return value
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/$/, "")
      .toLowerCase();
  }
}

function githubRawEngagement(metrics: EvidenceMetrics): number {
  return (metrics.stars ?? 0) + (metrics.watchers ?? 0) * 0.35 + (metrics.forks ?? 0) * 2 + (metrics.followers ?? 0) * 0.1;
}

function socialAccountId(
  entityType: EvidenceItem["entityType"],
  entityId: string,
  platform: Platform,
  url: string
): string {
  const canonicalUrl = canonicalNativeAccountUrl(platform, url) ?? url.trim();
  return `acct:${entityType}:${entityId}:${platform}:${encodeURIComponent(canonicalUrl)}`;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
