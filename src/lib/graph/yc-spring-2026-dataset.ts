import ycSummer2026Snapshot from "@/lib/yc/summer-2026-companies.json";
import ycSpring2026Snapshot from "@/lib/yc/spring-2026-companies.json";
import githubTractionSnapshot from "@/lib/social/github-traction-summer-2026.json";
import springGithubTractionSnapshot from "@/lib/social/github-traction.json";
import verifiedSocialOverridesJson from "@/lib/social/verified-social-overrides.json";
import ycPartnerVerbatimText from "@/lib/social/yc-partner-verbatim-text.json";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { calibrateBatchCompanyScores } from "@/lib/scoring/batch-calibration";
import { benchmarkGlobalCompanyScores } from "@/lib/scoring/global-score-benchmark";
import { a16zSpeedrun006GraphDataset } from "./a16z-speedrun-006-dataset";
import { githubRepositoryEvidenceTimestamps } from "./github-repository-timestamps";
import type {
  BusinessModel,
  CompanyRecord,
  DemoGraphDataset,
  EvidenceItem,
  EvidenceMetrics,
  FounderRecord,
  NeedsReviewItem,
  Platform,
  SocialAccountSummary
} from "./types";
import {
  aggregateBalancedTractionScore,
  computeEvidenceRawEngagement,
  normalizeEvidenceScores
} from "./traction-scoring";
import {
  canonicalPostKey,
  contextEvidenceContentUrl,
  dedupeEvidenceForScoring,
  dedupeEvidenceItems,
  hasEvidenceIdentityConflict,
  nativeEvidenceIdentityFromUrl
} from "./dedupe";
import { evidenceDisplayText } from "./evidence-display";
import { enrichEvidenceThumbnail } from "./evidence-thumbnails";
import {
  exactNativePublicationDateFromVerifiedReceipt,
  nativeLinkStatusFromVerifiedReceipt
} from "./native-link-attestation";
import { originalEvidenceText } from "./verbatim-evidence-text";
import { reconcilePublishedCompanyScores } from "./published-score-reconciliation";
import {
  applyAttributionGuard,
  buildAttributionContext,
  type AttributionContext,
  type AttributionCompanyProfile,
  type AttributionSocialLink
} from "./evidence-attribution";
import { isKnownTopVoiceAccountUrl, isKnownTopVoiceNativeIdentity } from "@/lib/social/top-voices";
import {
  reconcileLegacySummerEvidenceEntity,
  reconcileLegacySummerGithubAccount
} from "./summer-company-rename-reconciliation";
import {
  assertRawEvidenceTemporalPreflight,
  normalizeEvidenceTemporalSemantics
} from "./static-graph-snapshot-contract.mjs";

interface RawSnapshot {
  source: {
    directoryUrl: string;
    fetchedAt: string;
    expectedCompanyCount: number;
    observedCompanyCount: number;
  };
  companies: RawCompany[];
}

// These evidence snapshots are intentionally loaded as data at runtime rather
// than compiled as JSON modules. The largest file is roughly 90 MB; asking
// Vite/webpack to turn it into a JavaScript AST multiplies memory use by orders
// of magnitude and previously exhausted both local test runs and Vercel builds.
// Next's output-file tracing explicitly includes these files for every route
// that imports the full graph dataset.
type GraphRuntimeProjectionPath =
  | "generated-runtime/graph/public-evidence-current.json.gz"
  | "generated-runtime/graph/logged-in-evidence-current.json.gz"
  | "generated-runtime/graph/targeted-evidence-current.json.gz"
  | "generated-runtime/graph/volume-evidence-current.json.gz";

const publicEvidenceSnapshot: unknown = readRuntimeJson(
  "generated-runtime/graph/public-evidence-current.json.gz",
);
const loggedInEvidenceSnapshot: unknown = readRuntimeJson(
  "generated-runtime/graph/logged-in-evidence-current.json.gz",
);
const targetedEvidenceSnapshot: unknown = readRuntimeJson(
  "generated-runtime/graph/targeted-evidence-current.json.gz",
);
const volumeEvidenceSnapshot: unknown = readRuntimeJson(
  "generated-runtime/graph/volume-evidence-current.json.gz",
);

function readRuntimeJson(relativePath: GraphRuntimeProjectionPath): unknown {
  const runtimePath = resolveRuntimeDataPath(relativePath);
  // These exact files are declared in outputFileTracingIncludes. Ignoring the
  // resolved argument here prevents Turbopack from treating it as a repo-wide
  // filesystem glob while preserving cwd-independent local/test resolution.
  return JSON.parse(gunzipSync(readFileSync(/* turbopackIgnore: true */ runtimePath)).toString("utf8"));
}

function resolveRuntimeDataPath(relativePath: GraphRuntimeProjectionPath): string {
  for (const root of [process.cwd(), process.env.INIT_CWD, process.env.PWD]) {
    if (!root) continue;
    const runtimePath = join(/* turbopackIgnore: true */ root, relativePath);
    if (existsSync(/* turbopackIgnore: true */ runtimePath)) return runtimePath;
  }
  return join(/* turbopackIgnore: true */ process.cwd(), relativePath);
}

interface RawCompany {
  id: string;
  slug: string;
  name: string;
  ycProfileUrl: string;
  websiteUrl: string | null;
  tagline: string;
  description: string;
  industry: string;
  subindustry: string;
  industries: string[];
  tags: string[];
  teamSize: number | null;
  groupPartner: string | null;
  socialLinks: RawSocialLinks;
  founders: RawFounder[];
  sourceUrls: string[];
}

interface RawFounder {
  id: string;
  name: string;
  title: string | null;
  bio: string | null;
  ycProfileUrl: string;
  socialLinks: RawSocialLinks;
}

type RawSocialLinks = Partial<
  Record<"github" | "linkedin" | "x" | "instagram" | "tiktok" | "bluesky", string>
>;

type RetirableSocialPlatform = keyof RawSocialLinks | "youtube" | "product_hunt";

interface RetiredSocialAccount {
  url: string;
  rejectedAt?: string;
  reason?: string;
  source?: string;
  platform?: RetirableSocialPlatform;
}

interface SocialAccountRetirements {
  rejectedGithub?: RetiredSocialAccount[];
  rejectedLinkedin?: RetiredSocialAccount[];
  rejectedX?: RetiredSocialAccount[];
  rejectedInstagram?: RetiredSocialAccount[];
  rejectedYoutube?: RetiredSocialAccount[];
  rejectedProductHunt?: RetiredSocialAccount[];
  retiredAccounts?: RetiredSocialAccount[];
}

interface VerifiedFounderOverride extends SocialAccountRetirements {
  id: string;
  name: string;
  ycProfileUrl?: string | null;
  sourceUrl: string;
  socialLinks: RawSocialLinks;
  matchReason: string;
}

interface VerifiedSocialOverride extends SocialAccountRetirements {
  companySocialLinks?: RawSocialLinks;
  founders?: VerifiedFounderOverride[];
}

interface GithubSnapshot {
  source: {
    fetchedAt: string;
    targetCount: number;
    fetchedCount: number;
  };
  accounts: GithubAccount[];
}

interface GithubAccount {
  entityType: "company" | "founder";
  entityId: string;
  companySlug?: string;
  companyName: string;
  name: string;
  sourceUrl?: string;
  githubUrl: string;
  discoverySource?: string;
  matchReason?: string;
  login: string;
  fetched: boolean;
  account?: {
    htmlUrl: string;
    followers: number;
    publicRepos: number;
  };
  aggregate?: {
    repoCount: number;
    totalStars: number;
    totalForks: number;
    totalWatchers: number;
    profileScore: number;
  };
  repos?: GithubRepo[];
}

interface GithubRepo {
  id?: number;
  name: string;
  fullName: string;
  description: string;
  htmlUrl: string;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  language: string | null;
  pushedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  score: number;
}

interface PublicEvidenceSnapshot {
  source: {
    fetchedAt: string;
  };
  evidence: PublicEvidenceRecord[];
  needsReview: PublicNeedsReviewRecord[];
}

interface PublicEvidenceRecord {
  id: string;
  batchSlug?: string;
  batch_slug?: string;
  entityType: "company" | "founder";
  entityId: string;
  companyName: string;
  platform: Platform;
  title: string;
  sourceUrl: string;
  platformPostId?: string | null;
  authorName?: string | null;
  authorHandle?: string | null;
  text: string;
  originalText?: string | null;
  thumbnailUrl?: string | null;
  thumbnailSource?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: string[];
  media_urls?: string[];
  media_posters?: string[];
  accountUrl?: string | null;
  linkStatus?: "verified" | "invalid" | "unchecked" | "blocked" | null;
  linkCheckedAt?: string | null;
  linkFailureReason?: string | null;
  rawVisibleText: string;
  postedAt: string | null;
  publishedAtPrecision?: EvidenceItem["publishedAtPrecision"];
  platformObjectId?: string | null;
  metrics: EvidenceMetrics;
  contributionScore: number;
  tractionStatus?: EvidenceItem["tractionStatus"];
  tractionLimitations?: string[];
  review_state: "verified" | "needs_review" | "rejected";
  attributionVersion?: number;
  attributionProvenance?: string;
  attributionStatus?: string;
  attributionMode?: string;
  attributionSignals?: string[];
  nativeAuthorResolution?: {
    status?: string;
    author?: {
      platform?: Platform;
      key?: string;
    };
    owner?: {
      batchSlug?: string;
      entityType?: "company" | "founder";
      entityId?: string;
    };
  };
  matchReason: string;
  first_seen_at: string;
  last_checked_at: string;
  last_updated_at: string;
}

interface LinkedInCommentReference {
  commentId: string;
  parentPostId: string | null;
  commentUrn: string | null;
}

type LinkedInActivityPolicy =
  | { kind: "not_comment" }
  | { kind: "native_comment"; reference: LinkedInCommentReference; contextUrl: string }
  | { kind: "unlocated_comment" }
  | {
      kind: "mislabelled_parent_comment";
      sourceAuthorHandle: string | null;
      claimedAuthorHandle: string | null;
    };

interface PublicNeedsReviewRecord {
  id: string;
  batchSlug?: string;
  batch_slug?: string;
  entityType: "company" | "founder";
  entityId: string;
  entityName: string;
  platform: Platform;
  candidateUrl: string;
  review_state: "needs_review";
  matchReason: string;
}

export const YC_SUMMER_2026_BATCH_SLUG = "S26";
export const YC_SUMMER_2026_BATCH_LABEL = "YC Summer 2026 (S26)";
export const YC_SPRING_2026_BATCH_SLUG = "S2026";
export const YC_SPRING_2026_BATCH_LABEL = "YC Spring 2026 (P26)";

const SUMMER_COMPANY_SLUG_RENAMES = [
  {
    from: "blueprints",
    to: "hoplite",
    fromName: "Blueprints",
    toName: "Hoplite",
    historicalSocialLinks: { github: "https://github.com/CarbonCopyInc" }
  },
  {
    from: "bylaw",
    to: "definite",
    fromName: "Bylaw",
    toName: "Definite",
    historicalSocialLinks: {
      github: "https://github.com/UseBylaw",
      linkedin: "https://www.linkedin.com/company/usebylaw",
      x: "https://x.com/UseBylaw"
    }
  },
  {
    from: "litmus-build",
    to: "litmus-hiring",
    fromName: "Litmus Build",
    toName: "Litmus",
    historicalSocialLinks: {
      linkedin: "https://www.linkedin.com/company/litmus-build",
      x: "https://x.com/UseLitmus"
    }
  },
  {
    from: "perceptron-ml",
    to: "notyfi",
    fromName: "Perceptron ML",
    toName: "Notyfi",
    historicalSocialLinks: {
      linkedin: "https://linkedin.com/company/perceptron-yc",
      x: "https://x.com/PerceptronML"
    }
  }
] as const;

const GENERIC_SOCIAL_IDENTITIES = new Set([
  "about",
  "admin",
  "all",
  "company",
  "dashboard",
  "feed",
  "home",
  "in",
  "login",
  "posts",
  "recent-activity",
  "search",
  "settings",
  "signup"
]);

const snapshot = ycSummer2026Snapshot as RawSnapshot;
const springSnapshot = ycSpring2026Snapshot as RawSnapshot;
const githubSnapshot = githubTractionSnapshot as GithubSnapshot;
const springGithubSnapshot = springGithubTractionSnapshot as GithubSnapshot;
const githubRepositoriesByIdentity = buildGithubRepositoryIndex([
  githubSnapshot,
  springGithubSnapshot
]);
const publicSnapshot = publicEvidenceSnapshot as PublicEvidenceSnapshot;
const loggedInSnapshot = loggedInEvidenceSnapshot as PublicEvidenceSnapshot;
const targetedSnapshot = targetedEvidenceSnapshot as PublicEvidenceSnapshot;
const volumeSnapshot = volumeEvidenceSnapshot as PublicEvidenceSnapshot;
assertRawEvidenceTemporalPreflight(publicSnapshot.evidence, {
  sourceObservedAt: publicSnapshot.source.fetchedAt,
  sourceLabel: "public evidence"
});
assertRawEvidenceTemporalPreflight(loggedInSnapshot.evidence, {
  sourceObservedAt: loggedInSnapshot.source.fetchedAt,
  sourceLabel: "logged-in evidence"
});
assertRawEvidenceTemporalPreflight(targetedSnapshot.evidence, {
  sourceObservedAt: targetedSnapshot.source.fetchedAt,
  sourceLabel: "targeted evidence"
});
assertRawEvidenceTemporalPreflight(volumeSnapshot.evidence, {
  sourceObservedAt: volumeSnapshot.source.fetchedAt,
  sourceLabel: "volume evidence"
});
const verifiedSocialOverrides = verifiedSocialOverridesJson as Record<string, VerifiedSocialOverride>;
const companyIdByEntityId = buildCompanyIdByEntityId([
  ...snapshot.companies,
  ...springSnapshot.companies
]);
const summerCompanyById = new Map(snapshot.companies.map((company) => [companyId(company), company]));
const springCompanyById = new Map(springSnapshot.companies.map((company) => [companyId(company), company]));
const summerVerifiedFounderAliases = buildVerifiedFounderAliases(snapshot.companies);
const springVerifiedFounderAliases = buildVerifiedFounderAliases(springSnapshot.companies);
const attributionContext = buildAttributionContext(snapshot.companies.map(attributionCompanyProfile));
const knownCompanyIds = new Set(snapshot.companies.map(companyId));
const knownFounderIds = new Set(snapshot.companies.flatMap((company) => [
  ...company.founders.map((founder) => founderId(company, founder)),
  ...manualFounderOverrides(company).map((founder) => manualFounderId(company, founder))
]));
const knownEntityIds = new Set([...knownCompanyIds, ...knownFounderIds]);
const springKnownCompanyIds = new Set(springSnapshot.companies.map(companyId));
const springKnownFounderIds = new Set(springSnapshot.companies.flatMap((company) => [
  ...company.founders.map((founder) => founderId(company, founder)),
  ...manualFounderOverrides(company).map((founder) => manualFounderId(company, founder))
]));
const springKnownEntityIds = new Set([...springKnownCompanyIds, ...springKnownFounderIds]);
const crossBatchEntityIds = new Set(
  [...knownEntityIds].filter((entityId) => springKnownEntityIds.has(entityId))
);
const officialGithubUrlsByEntityId = buildOfficialSummerGithubUrlsByEntityId();
const allowedLoggedInPlatforms = new Set(["instagram", "x", "linkedin", "tiktok", "bluesky"]);
const allowedLoggedInEvidence = loggedInSnapshot.evidence.filter((item) =>
  allowedLoggedInPlatforms.has(item.platform)
);
const allowedLoggedInNeedsReview = loggedInSnapshot.needsReview.filter((item) =>
  allowedLoggedInPlatforms.has(item.platform)
);
const summerLoggedInEvidenceCounts = countEvidenceByPlatform(
  allowedLoggedInEvidence.filter((item) => scopedEvidenceToBatch(item, YC_SUMMER_2026_BATCH_SLUG))
);
const rawPublicEvidenceItems = [
  ...publicSnapshot.evidence,
  ...allowedLoggedInEvidence,
  ...targetedSnapshot.evidence,
  ...volumeSnapshot.evidence
]
  .map(canonicalizeRenamedSummerEntity)
  .map((item) => canonicalizeVerifiedFounderEntity(item, summerVerifiedFounderAliases))
  .filter(isKnownSummerEvidenceRecord)
  .filter((item) => item.review_state === "verified")
  .filter(isAcceptedPublicEvidence)
  .map((item) => publicEvidenceItemWithAttributionGuard(item, attributionContext, summerCompanyById));
const rawGithubEvidenceItems = githubSnapshot.accounts
  .map(reconcileLegacySummerGithubAccount)
  .map((account) => canonicalizeVerifiedFounderEntity(account, summerVerifiedFounderAliases))
  .filter(isKnownSummerGithubAccount)
  .flatMap(githubEvidence)
  .map((item) => applyAttributionGuard(item, attributionContext));
const unresolvedAllEvidenceItems = normalizeEvidenceScores(
  canonicalizeBatchEvidence(dedupeBatchEvidence([...rawGithubEvidenceItems, ...rawPublicEvidenceItems]))
    .map((item) => normalizeEvidenceTemporalSemantics(item))
);
const officialSocialLinkCounts = countOfficialSocialLinks(snapshot.companies);
const summerEvidenceCounts = countEvidenceByPlatform(unresolvedAllEvidenceItems);
const evidenceByEntityId = groupEvidenceByEntity(unresolvedAllEvidenceItems);
const publicNeedsReviewItems = [
  ...publicSnapshot.needsReview,
  ...allowedLoggedInNeedsReview,
  ...targetedSnapshot.needsReview
]
  .map(canonicalizeRenamedSummerEntity)
  .map((item) => canonicalizeVerifiedFounderEntity(item, summerVerifiedFounderAliases))
  .filter(isKnownSummerNeedsReviewRecord)
  .map(publicNeedsReviewItem);
const companyRecords = calibrateBatchCompanyScores(snapshot.companies.map(companyRecord));
const founderRecordList = snapshot.companies.flatMap(founderRecords);
const allEvidenceItems = resolveEvidenceSocialAccountIds(
  unresolvedAllEvidenceItems,
  companyRecords,
  founderRecordList
);

const rawYcSummer2026GraphDataset: DemoGraphDataset = {
  mode: "official_snapshot",
  batches: [
    {
      slug: YC_SUMMER_2026_BATCH_SLUG,
      label: YC_SUMMER_2026_BATCH_LABEL,
      companyCountExpected: snapshot.source.expectedCompanyCount,
      companyCountObserved: snapshot.source.observedCompanyCount
    }
  ],
  companies: companyRecords,
  founders: founderRecordList,
  evidence: allEvidenceItems,
  needsReview: publicNeedsReviewItems,
  platformStatus: [
    {
      platform: "web",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "disabled",
      authMethod: "Not counted",
      notes: "YC/web metadata is used only for names and official links. It contributes 0 traction score."
    },
    {
      platform: "github",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: rawGithubEvidenceItems.length > 0 ? "working" : "needs_config",
      authMethod: "Read-only public GitHub API",
      notes: `Measured ${rawGithubEvidenceItems.length} Summer 2026 GitHub evidence rows from public API data. Old Spring 2026 account snapshots are ignored unless the account matches a Summer company or founder official YC link.`
    },
    {
      platform: "x",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "public_only",
      authMethod: "Official YC profile links and verified public evidence only",
      notes: `Found ${officialSocialLinkCounts.x.company} company and ${officialSocialLinkCounts.x.founder} founder X URLs on official Summer 2026 YC profiles, but ${summerEvidenceCounts.x ?? 0} scored Summer X post rows are currently available. Anonymous public reads were blocked, and Spring/P26 evidence is filtered out.`
    },
    {
      platform: "linkedin",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: summerEvidenceCounts.linkedin ? "working" : "public_only",
      authMethod: summerLoggedInEvidenceCounts.linkedin
        ? "Read-only authenticated browser session plus verified public evidence"
        : "Public unauthenticated profile and post discovery only",
      notes: `Found ${officialSocialLinkCounts.linkedin.company} company and ${officialSocialLinkCounts.linkedin.founder} founder LinkedIn URLs on official Summer 2026 YC profiles. ${summerEvidenceCounts.linkedin ?? 0} scored Summer LinkedIn post rows are currently available; ${summerLoggedInEvidenceCounts.linkedin ?? 0} came from the opt-in authenticated browser snapshot, and prior Spring rows remain excluded.`
    },
    {
      platform: "instagram",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: summerEvidenceCounts.instagram ? "working" : "public_only",
      authMethod: summerLoggedInEvidenceCounts.instagram
        ? "Read-only authenticated browser session plus verified public evidence"
        : "Official YC profile links and verified public evidence only",
      notes:
        `Found ${officialSocialLinkCounts.instagram.company} company and ${officialSocialLinkCounts.instagram.founder} founder Instagram URLs on official Summer 2026 YC profiles. ${summerEvidenceCounts.instagram ?? 0} scored Summer Instagram post rows are currently available; ${summerLoggedInEvidenceCounts.instagram ?? 0} came from the opt-in authenticated browser snapshot. Spring demo/profile snapshots are filtered out.`
    },
    {
      platform: "rss",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "working",
      authMethod: "Public feed fetch",
      notes: "Public RSS/Atom feeds are discovered from company websites and fetched read-only."
    },
    {
      platform: "youtube",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "working",
      authMethod: "Public YouTube search/metadata pages",
      notes: `Public YouTube results are attempted without login. ${summerEvidenceCounts.youtube ?? 0} verified Summer 2026 YouTube row currently scores.`
    },
    {
      platform: "product_hunt",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "public_only",
      authMethod: "Public Product Hunt pages/search through Reader fallback",
      notes: "Product Hunt is attempted publicly. Unclear matches are sent to needs_review; blocks are logged."
    },
    {
      platform: "reddit",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "public_only",
      authMethod: "Unauthenticated public Reddit pages/JSON where accessible",
      notes: "Reddit often blocks unauthenticated scraping from this network; failures are logged per company."
    },
    {
      platform: "hacker_news",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "working",
      authMethod: "Public Hacker News Algolia API",
      notes: "HN stories are matched conservatively and scored with public points/comments."
    },
    {
      platform: "bilibili",
      batchSlugs: [YC_SUMMER_2026_BATCH_SLUG],
      status: "needs_config",
      authMethod: "Public search and explicit subtitle setup",
      notes: "Not used by the YC snapshot unless a public Bilibili URL is discovered."
    }
  ]
};

const springDataset = buildSpring2026GraphDataset();
const rawGlobalCompanyPopulation = [
  ...rawYcSummer2026GraphDataset.companies,
  ...springDataset.companies,
  ...a16zSpeedrun006GraphDataset.companies
];
const globallyPublishedEvidence = dedupeEvidenceItems(
  [
    ...rawYcSummer2026GraphDataset.evidence,
    ...springDataset.evidence,
    ...a16zSpeedrun006GraphDataset.evidence
  ].filter((item) => !hasCrossBatchEntityAmbiguity(item))
);
const reconciledGlobalCompanyPopulation = reconcilePublishedCompanyScores(
  rawGlobalCompanyPopulation,
  globallyPublishedEvidence
);
const calibratedGlobalCompanyPopulation = calibrateBatchCompanyScores(
  reconciledGlobalCompanyPopulation,
  reconciledGlobalCompanyPopulation
);
const globallyBenchmarkedCompanies = benchmarkGlobalCompanyScores(
  calibratedGlobalCompanyPopulation,
  calibratedGlobalCompanyPopulation
);

export const ycSummer2026GraphDataset: DemoGraphDataset = {
  ...rawYcSummer2026GraphDataset,
  companies: globallyBenchmarkedCompanies.filter(
    (company) => company.batchSlug === YC_SUMMER_2026_BATCH_SLUG
  )
};

export const yc2026GraphDataset: DemoGraphDataset = {
  mode: "official_snapshot",
  batches: [
    ...springDataset.batches,
    ...ycSummer2026GraphDataset.batches,
    ...a16zSpeedrun006GraphDataset.batches
  ],
  companies: globallyBenchmarkedCompanies,
  founders: [
    ...ycSummer2026GraphDataset.founders,
    ...springDataset.founders,
    ...a16zSpeedrun006GraphDataset.founders
  ],
  evidence: globallyPublishedEvidence,
  needsReview: [
    ...(ycSummer2026GraphDataset.needsReview ?? []),
    ...(springDataset.needsReview ?? []),
    ...(a16zSpeedrun006GraphDataset.needsReview ?? [])
  ].filter((item) => !hasCrossBatchEntityAmbiguity(item)),
  platformStatus: [
    ...springDataset.platformStatus,
    ...ycSummer2026GraphDataset.platformStatus,
    ...a16zSpeedrun006GraphDataset.platformStatus
  ]
};

export const ycSpring2026GraphDataset = yc2026GraphDataset;

function buildSpring2026GraphDataset(): DemoGraphDataset {
  const springAttributionContext = buildAttributionContext(springSnapshot.companies.map(attributionCompanyProfile));
  const springPublicEvidenceItems = [
    ...publicSnapshot.evidence,
    ...allowedLoggedInEvidence,
    ...targetedSnapshot.evidence,
    ...volumeSnapshot.evidence
  ]
    .map((item) => canonicalizeVerifiedFounderEntity(item, springVerifiedFounderAliases))
    .filter((item) => springKnownEntityIds.has(item.entityId))
    .filter((item) => evidenceMatchesBatchScope(
      item,
      YC_SPRING_2026_BATCH_SLUG,
      !hasSummerBatchContext(evidenceBatchText(item))
    ))
    .filter((item) => item.review_state === "verified")
    .filter((item) => springPublicEvidenceAccepted(item))
    .map((item) => publicEvidenceItemWithAttributionGuard(item, springAttributionContext, springCompanyById));
  const springGithubEvidenceItems = springGithubSnapshot.accounts
    .map((account) => canonicalizeVerifiedFounderEntity(account, springVerifiedFounderAliases))
    .filter((account) => springKnownEntityIds.has(account.entityId))
    .flatMap((account) => githubEvidenceForSnapshot(account, springGithubSnapshot))
    .map((item) => applyAttributionGuard(item, springAttributionContext));
  const unresolvedSpringEvidenceItems = normalizeEvidenceScores(
    canonicalizeBatchEvidence(dedupeBatchEvidence([...springGithubEvidenceItems, ...springPublicEvidenceItems]))
      .map((item) => normalizeEvidenceTemporalSemantics(item))
  );
  const springEvidenceByEntityId = groupEvidenceByEntity(unresolvedSpringEvidenceItems);
  const springCompanies = calibrateBatchCompanyScores(
    springSnapshot.companies.map((raw) =>
      companyRecordForBatch(raw, {
        batchSlug: YC_SPRING_2026_BATCH_SLUG,
        evidenceByEntityId: springEvidenceByEntityId
      })
    )
  );
  const springFounders = springSnapshot.companies.flatMap((raw) =>
    founderRecordsForBatch(raw, {
      batchSlug: YC_SPRING_2026_BATCH_SLUG,
      evidenceByEntityId: springEvidenceByEntityId
    })
  );
  const springEvidenceItems = resolveEvidenceSocialAccountIds(
    unresolvedSpringEvidenceItems,
    springCompanies,
    springFounders
  );
  const springNeedsReviewItems = [
    ...publicSnapshot.needsReview,
    ...allowedLoggedInNeedsReview,
    ...targetedSnapshot.needsReview
  ]
    .map((item) => canonicalizeVerifiedFounderEntity(item, springVerifiedFounderAliases))
    .filter((item) => springKnownEntityIds.has(item.entityId))
    .filter((item) => evidenceMatchesBatchScope(
      item,
      YC_SPRING_2026_BATCH_SLUG,
      !hasSummerBatchContext(`${item.entityName} ${item.matchReason}`)
    ))
    .map(publicNeedsReviewItem);
  const springPlatformStatus = spring2026PlatformStatus({
    companies: springSnapshot.companies,
    evidence: unresolvedSpringEvidenceItems,
    githubEvidenceCount: springGithubEvidenceItems.length
  });

  return {
    mode: "official_snapshot",
    batches: [
      {
        slug: YC_SPRING_2026_BATCH_SLUG,
        label: YC_SPRING_2026_BATCH_LABEL,
        companyCountExpected: springSnapshot.source.expectedCompanyCount,
        companyCountObserved: springSnapshot.source.observedCompanyCount
      }
    ],
    companies: springCompanies,
    founders: springFounders,
    evidence: springEvidenceItems,
    needsReview: springNeedsReviewItems,
    platformStatus: springPlatformStatus
  };
}

function spring2026PlatformStatus({
  companies,
  evidence,
  githubEvidenceCount
}: {
  companies: RawCompany[];
  evidence: EvidenceItem[];
  githubEvidenceCount: number;
}): DemoGraphDataset["platformStatus"] {
  const officialLinks = countOfficialSocialLinks(companies);
  const evidenceCounts = countEvidenceByPlatform(evidence);
  const loggedInEvidenceCounts = countEvidenceByPlatform(
    allowedLoggedInEvidence.filter((item) => scopedEvidenceToBatch(item, YC_SPRING_2026_BATCH_SLUG))
  );
  const batchSlugs = [YC_SPRING_2026_BATCH_SLUG];

  return [
    {
      platform: "web",
      batchSlugs,
      status: "disabled",
      authMethod: "Not counted",
      notes: "YC/web metadata is used only for names and official links. It contributes 0 traction score."
    },
    {
      platform: "github",
      batchSlugs,
      status: githubEvidenceCount > 0 ? "working" : "needs_config",
      authMethod: "Read-only public GitHub API",
      notes: `Measured ${githubEvidenceCount} Spring 2026 GitHub evidence rows from official YC-linked public accounts.`
    },
    {
      platform: "x",
      batchSlugs,
      status: evidenceCounts.x ? "working" : "public_only",
      authMethod: "Official YC profile links and verified public evidence only",
      notes: `Found ${officialLinks.x.company} company and ${officialLinks.x.founder} founder X URLs on official Spring 2026 YC profiles. ${evidenceCounts.x ?? 0} scored Spring X post rows are currently available.`
    },
    {
      platform: "linkedin",
      batchSlugs,
      status: evidenceCounts.linkedin ? "working" : "public_only",
      authMethod: loggedInEvidenceCounts.linkedin
        ? "Read-only authenticated browser session plus verified public evidence"
        : "Public unauthenticated profile and post discovery only",
      notes: `Found ${officialLinks.linkedin.company} company and ${officialLinks.linkedin.founder} founder LinkedIn URLs on official Spring 2026 YC profiles. ${evidenceCounts.linkedin ?? 0} scored Spring LinkedIn post rows are currently available; ${loggedInEvidenceCounts.linkedin ?? 0} came from the opt-in authenticated browser snapshot.`
    },
    {
      platform: "instagram",
      batchSlugs,
      status: evidenceCounts.instagram ? "working" : "public_only",
      authMethod: loggedInEvidenceCounts.instagram
        ? "Read-only authenticated browser session plus verified public evidence"
        : "Official YC profile links and verified public evidence only",
      notes: `Found ${officialLinks.instagram.company} company and ${officialLinks.instagram.founder} founder Instagram URLs on official Spring 2026 YC profiles. ${evidenceCounts.instagram ?? 0} scored Spring Instagram post rows are currently available; ${loggedInEvidenceCounts.instagram ?? 0} came from the opt-in authenticated browser snapshot.`
    },
    {
      platform: "rss",
      batchSlugs,
      status: "working",
      authMethod: "Public feed fetch",
      notes: "Public RSS/Atom feeds are discovered from company websites and fetched read-only."
    },
    {
      platform: "youtube",
      batchSlugs,
      status: "working",
      authMethod: "Public YouTube search/metadata pages",
      notes: `Public YouTube results are attempted without login. ${evidenceCounts.youtube ?? 0} verified Spring 2026 YouTube rows currently score.`
    },
    {
      platform: "product_hunt",
      batchSlugs,
      status: "public_only",
      authMethod: "Public Product Hunt pages/search through Reader fallback",
      notes: "Product Hunt is attempted publicly. Unclear matches are sent to needs_review; blocks are logged."
    },
    {
      platform: "reddit",
      batchSlugs,
      status: "public_only",
      authMethod: "Unauthenticated public Reddit pages/JSON where accessible",
      notes: "Reddit often blocks unauthenticated scraping from this network; failures are logged per company."
    },
    {
      platform: "hacker_news",
      batchSlugs,
      status: "working",
      authMethod: "Public Hacker News Algolia API",
      notes: "HN stories are matched conservatively and scored with public points/comments."
    },
    {
      platform: "bilibili",
      batchSlugs,
      status: "needs_config",
      authMethod: "Public search and explicit subtitle setup",
      notes: "Not used by the YC snapshot unless a public Bilibili URL is discovered."
    }
  ];
}

function countOfficialSocialLinks(companies: RawCompany[]) {
  const result: Record<keyof RawSocialLinks, { company: number; founder: number }> = {
    github: { company: 0, founder: 0 },
    linkedin: { company: 0, founder: 0 },
    x: { company: 0, founder: 0 },
    instagram: { company: 0, founder: 0 },
    tiktok: { company: 0, founder: 0 },
    bluesky: { company: 0, founder: 0 }
  };

  for (const company of companies) {
    for (const platform of Object.keys(result) as Array<keyof RawSocialLinks>) {
      if (company.socialLinks?.[platform]) {
        result[platform].company += 1;
      }
      for (const founder of company.founders ?? []) {
        if (founder.socialLinks?.[platform]) {
          result[platform].founder += 1;
        }
      }
    }
  }

  return result;
}

function countEvidenceByPlatform(items: Array<{ platform: Platform }>): Partial<Record<Platform, number>> {
  const result: Partial<Record<Platform, number>> = {};
  for (const item of items) {
    result[item.platform] = (result[item.platform] ?? 0) + 1;
  }
  return result;
}

function scopedEvidenceToBatch(
  item: { batchSlug?: string; batch_slug?: string },
  batchSlug: string
): boolean {
  return String(item.batchSlug ?? item.batch_slug ?? "").trim().toUpperCase() === batchSlug.toUpperCase();
}

function springPublicEvidenceAccepted(item: PublicEvidenceRecord): boolean {
  if (item.linkStatus === "invalid") {
    return false;
  }

  if (item.platform !== "hacker_news") {
    return true;
  }

  return acceptedNativeHackerNewsEvidence(
    item,
    YC_SPRING_2026_BATCH_SLUG,
    hasSpringBatchContext(evidenceBatchText(item))
  );
}

function companyRecord(raw: RawCompany): CompanyRecord {
  return companyRecordForBatch(raw, {
    batchSlug: YC_SUMMER_2026_BATCH_SLUG,
    evidenceByEntityId
  });
}

function companyRecordForBatch(
  raw: RawCompany,
  options: { batchSlug: string; evidenceByEntityId: Map<string, EvidenceItem[]> }
): CompanyRecord {
  const manualFounders = manualFounderOverrides(raw);
  const founderAccountKeys = new Set(
    [...raw.founders, ...(verifiedSocialOverrides[raw.slug]?.founders ?? [])].flatMap((founder) =>
      (Object.entries(founder.socialLinks) as [keyof RawSocialLinks, string][])
        .filter(([, url]) => Boolean(url))
        .map(([platform, url]) => socialAccountKey(platform, url))
    )
  );
  const entityIds = [
    companyId(raw),
    ...raw.founders.map((founder) => founderId(raw, founder)),
    ...manualFounders.map((founder) => manualFounderId(raw, founder))
  ];
  const entityEvidence = entityIds.flatMap((entityId) => options.evidenceByEntityId.get(entityId) ?? []);
  const scoreBreakdown = aggregateBalancedTractionScore(dedupeEvidenceForScoring(entityEvidence));
  const companyOverride = verifiedSocialOverrides[raw.slug];
  const verifiedCompanyLinks = companyOverride?.companySocialLinks ?? {};
  const retiredCompanyAccountKeys = retiredSocialAccountKeys(companyOverride);
  const socialAccounts = dedupeSocialAccounts([
    ...socialAccountsFor(socialLinksWithoutOverrides(raw.socialLinks, verifiedCompanyLinks), {
      entityType: "company",
      entityId: companyId(raw),
      discoveredFromUrl: raw.ycProfileUrl,
      matchReason: "Linked from the official public YC company profile."
    }),
    ...socialAccountsFor(verifiedCompanyLinks, {
      entityType: "company",
      entityId: companyId(raw),
      discoveredFromUrl: raw.websiteUrl ?? raw.ycProfileUrl,
      matchReason: `Verified social override for ${raw.name}; profile links back to the official company identity.`
    })
  ])
    .filter((account) => !retiredCompanyAccountKeys.has(socialAccountKey(account.platform, account.url)))
    .filter((account) => !founderAccountKeys.has(socialAccountKey(account.platform, account.url)));

  return {
    id: companyId(raw),
    batchSlug: options.batchSlug,
    name: raw.name,
    ycProfileUrl: raw.ycProfileUrl,
    websiteUrl: raw.websiteUrl ?? raw.ycProfileUrl,
    tagline: raw.tagline,
    description: raw.description,
    groupPartner: raw.groupPartner,
    primaryIndustry: primaryIndustry(raw),
    businessModel: businessModel(raw),
    review_state: "verified",
    sourceUrl: raw.ycProfileUrl,
    industries: industryTags(raw),
    founderIds: [
      ...raw.founders.map((founder) => founderId(raw, founder)),
      ...manualFounders.map((founder) => manualFounderId(raw, founder))
    ],
    socialAccounts,
    totalScore: scoreBreakdown.totalScore,
    previousScore: scoreBreakdown.totalScore,
    platformScores: scoreBreakdown.platformScores,
    scoreBreakdown
  };
}

function founderRecords(raw: RawCompany): FounderRecord[] {
  return founderRecordsForBatch(raw, {
    batchSlug: YC_SUMMER_2026_BATCH_SLUG,
    evidenceByEntityId
  });
}

function founderRecordsForBatch(
  raw: RawCompany,
  options: { batchSlug: string; evidenceByEntityId: Map<string, EvidenceItem[]> }
): FounderRecord[] {
  const parentIndustry = primaryIndustry(raw);
  const parentBusinessModel = businessModel(raw);

  const ycFounderRecords = raw.founders.map((founder) => {
    const entityEvidence = options.evidenceByEntityId.get(founderId(raw, founder)) ?? [];
    const scoreBreakdown = aggregateBalancedTractionScore(dedupeEvidenceForScoring(entityEvidence));
    const verifiedOverride = matchingVerifiedFounderOverride(raw, founder.name);
    const retiredFounderAccountKeys = retiredSocialAccountKeys(verifiedOverride);
    const socialAccounts = dedupeSocialAccounts([
      ...socialAccountsFor(socialLinksWithoutOverrides(founder.socialLinks, verifiedOverride?.socialLinks ?? {}), {
        entityType: "founder",
        entityId: founderId(raw, founder),
        discoveredFromUrl: raw.ycProfileUrl,
        matchReason: "Linked from the founder block on the official public YC company profile."
      }),
      ...socialAccountsFor(verifiedOverride?.socialLinks ?? {}, {
        entityType: "founder",
        entityId: founderId(raw, founder),
        discoveredFromUrl: verifiedOverride?.sourceUrl ?? raw.ycProfileUrl,
        matchReason: verifiedOverride?.matchReason ?? "Verified founder social override."
      })
    ]).filter(
      (account) => !retiredFounderAccountKeys.has(socialAccountKey(account.platform, account.url))
    );

    return {
      id: founderId(raw, founder),
      batchSlug: options.batchSlug,
      name: founder.name,
      ycProfileUrl: founder.ycProfileUrl,
      personalWebsiteUrl: null,
      primaryIndustry: parentIndustry,
      businessModel: parentBusinessModel,
      review_state: "verified" as const,
      sourceUrl: raw.ycProfileUrl,
      companyIds: [companyId(raw)],
      socialAccounts,
      totalScore: scoreBreakdown.totalScore,
      previousScore: scoreBreakdown.totalScore,
      platformScores: scoreBreakdown.platformScores,
      scoreBreakdown
    };
  });

  const manualRecords = manualFounderOverrides(raw).map((founder) => {
    const entityEvidence = options.evidenceByEntityId.get(manualFounderId(raw, founder)) ?? [];
    const scoreBreakdown = aggregateBalancedTractionScore(dedupeEvidenceForScoring(entityEvidence));
    const retiredFounderAccountKeys = retiredSocialAccountKeys(founder);
    const socialAccounts = socialAccountsFor(founder.socialLinks, {
      entityType: "founder",
      entityId: manualFounderId(raw, founder),
      discoveredFromUrl: founder.sourceUrl,
      matchReason: founder.matchReason
    }).filter(
      (account) => !retiredFounderAccountKeys.has(socialAccountKey(account.platform, account.url))
    );

    return {
      id: manualFounderId(raw, founder),
      batchSlug: options.batchSlug,
      name: founder.name,
      ycProfileUrl: founder.ycProfileUrl ?? raw.ycProfileUrl,
      personalWebsiteUrl: null,
      primaryIndustry: parentIndustry,
      businessModel: parentBusinessModel,
      review_state: "verified" as const,
      sourceUrl: founder.sourceUrl,
      companyIds: [companyId(raw)],
      socialAccounts,
      totalScore: scoreBreakdown.totalScore,
      previousScore: scoreBreakdown.totalScore,
      platformScores: scoreBreakdown.platformScores,
      scoreBreakdown
    };
  });

  return [...ycFounderRecords, ...manualRecords];
}

function githubEvidence(account: GithubAccount): EvidenceItem[] {
  return githubEvidenceForSnapshot(account, githubSnapshot);
}

function githubEvidenceForSnapshot(account: GithubAccount, sourceSnapshot: GithubSnapshot): EvidenceItem[] {
  if (!account.fetched || !account.aggregate) {
    return [];
  }
  const accountUrl = account.account?.htmlUrl ?? account.githubUrl;
  const matchReason = account.matchReason ?? "GitHub account verified from a YC-linked or official company source.";
  const repoItems: EvidenceItem[] = (account.repos ?? []).map((repo) => {
    const timestamps = githubRepositoryEvidenceTimestamps(repo, sourceSnapshot.source.fetchedAt);
    const metrics: EvidenceMetrics = {
      stars: repo.stars,
      forks: repo.forks,
      watchers: repo.watchers,
      issues: repo.openIssues
    };
    return {
      id: `evidence-github-repo-${account.entityId}-${slugify(repo.fullName)}`,
      entityType: account.entityType,
      entityId: account.entityId,
      platform: "github" as const,
      authorName: repo.fullName,
      authorHandle: account.login,
      postedAt: timestamps.postedAt,
      publishedAtPrecision: timestamps.publishedAtPrecision,
      observedAt: sourceSnapshot.source.fetchedAt,
      metricsCheckedAt: sourceSnapshot.source.fetchedAt,
      text: `${repo.fullName}: ${repo.description || "GitHub repository"}${repo.language ? ` (${repo.language})` : ""}.`,
      mediaType: "repo" as const,
      metrics,
      contributionScore: computeEvidenceRawEngagement("github", metrics),
      sourceUrl: repo.htmlUrl,
      platformPostId: repo.fullName,
      platformObjectId: repo.id == null ? null : String(repo.id),
      rawVisibleText: JSON.stringify({ repositoryTimestamps: timestamps.provenance }),
      first_seen_at: sourceSnapshot.source.fetchedAt,
      last_checked_at: sourceSnapshot.source.fetchedAt,
      last_updated_at: timestamps.lastUpdatedAt,
      why: "Repository traction measured from public GitHub stars, forks, watchers, and open issues.",
      attachedCompanyId: attachedCompanyIdForGithub(account),
      attachedCompanyName: account.companyName,
      socialAccountId: null,
      accountUrl,
      matchReason,
      review_state: "verified" as const
    };
  });
  const hasRepoLevelEvidence = repoItems.length > 0;

  const profile: EvidenceItem = {
    id: githubProfileEvidenceId(account, sourceSnapshot),
    entityType: account.entityType,
    entityId: account.entityId,
    platform: "github",
    authorName: account.name,
    authorHandle: account.login,
    postedAt: sourceSnapshot.source.fetchedAt,
    publishedAtPrecision: "unknown",
    observedAt: sourceSnapshot.source.fetchedAt,
    metricsCheckedAt: sourceSnapshot.source.fetchedAt,
    text: `${account.name} GitHub profile: ${account.aggregate.totalStars} stars, ${account.aggregate.totalForks} forks, ${account.aggregate.repoCount} public repositories tracked from the YC-linked GitHub account.`,
    mediaType: "repo",
    metrics: {
      stars: account.aggregate.totalStars,
      forks: account.aggregate.totalForks,
      watchers: account.aggregate.totalWatchers
    },
    contributionScore: hasRepoLevelEvidence ? 0 : account.aggregate.profileScore,
    sourceUrl: accountUrl,
    first_seen_at: sourceSnapshot.source.fetchedAt,
    last_checked_at: sourceSnapshot.source.fetchedAt,
    last_updated_at: sourceSnapshot.source.fetchedAt,
    why: hasRepoLevelEvidence
      ? "Stored as account context only. Repo-level GitHub evidence exists, so the profile aggregate is not scored to avoid double-counting stars and forks."
      : "Measured from the read-only public GitHub API. No YC/web metadata is counted in this score.",
    attachedCompanyId: attachedCompanyIdForGithub(account),
    attachedCompanyName: account.companyName,
    socialAccountId: null,
    accountUrl,
    matchReason,
    review_state: "verified"
  };

  return [profile, ...repoItems]
    .map(enrichEvidenceThumbnail)
    .sort((a, b) => b.contributionScore - a.contributionScore)
    .slice(0, 20);
}

function publicationTimestampPrecision(value: string): EvidenceItem["publishedAtPrecision"] {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? "day" : "exact";
}

function sourcePublicationTimestampPrecision(
  item: Pick<PublicEvidenceRecord, "platform" | "postedAt" | "publishedAtPrecision" | "rawVisibleText">
): EvidenceItem["publishedAtPrecision"] {
  const value: unknown = item.publishedAtPrecision;
  if (value !== undefined && value !== null) {
    return value === "exact" || value === "day" ? value : "unknown";
  }
  if (item.platform === "x" && hasRelativeXPublicationLabel(item.rawVisibleText)) {
    return "unknown";
  }
  return item.postedAt ? publicationTimestampPrecision(item.postedAt) : "unknown";
}

function hasRelativeXPublicationLabel(rawVisibleText: string): boolean {
  try {
    const parsed = JSON.parse(rawVisibleText) as {
      created_at?: unknown;
      post?: { created_at?: unknown };
    };
    const value = parsed.created_at ?? parsed.post?.created_at;
    return /^(\d+)\s*(m|h|d|minutes?|hours?|days?)\s*(?:ago)?$/i.test(String(value ?? "").trim());
  } catch {
    return false;
  }
}

function publicEvidenceItem(item: PublicEvidenceRecord): EvidenceItem {
  const isRetweet = item.platform === "x" && /"is_retweet"\s*:\s*true/i.test(item.rawVisibleText ?? "");
  const isProfileContext = isProfileOnlySocialEvidence(item);
  const isLinkedInActivityFragment = isLinkedInProfileActivityFragment(item);
  const linkedInActivity = classifyLinkedInActivity(item);
  const isLinkedInCommentContext = linkedInActivity.kind !== "not_comment";
  const contributionScore =
    item.platform === "web" ||
    item.platform === "rss" ||
    isRetweet ||
    isProfileContext ||
    isLinkedInCommentContext
      ? 0
      : item.contributionScore;
  const nativeAuthor = nativeAuthorFromRawVisibleText(item.rawVisibleText);
  const mediaUrls = [
    ...(item.mediaUrls ?? []),
    ...(item.media_posters ?? []),
    ...(item.media_urls ?? [])
  ].filter(Boolean);
  const displayTitle = evidenceDisplayText(item, item.companyName);
  const verbatimText = ycPartnerVerbatimText[item.sourceUrl as keyof typeof ycPartnerVerbatimText];
  const originalText = verbatimText || originalEvidenceText({
    platform: item.platform,
    title: displayTitle,
    text: item.text,
    originalText: item.originalText,
    rawVisibleText: item.rawVisibleText,
    attributionProvenance: item.attributionProvenance
  });
  const observedAt = item.first_seen_at ?? item.last_checked_at ?? publicSnapshot.source.fetchedAt;
  const githubRepository = resolveGithubRepository(item);
  const githubTimestamps = githubRepository
    ? githubRepositoryEvidenceTimestamps(githubRepository, observedAt)
    : null;
  const nativeGithubTimestamps =
    item.platform === "github" && githubTimestamps?.publishedAtPrecision !== "unknown"
      ? githubTimestamps
      : null;
  const nativePublication = exactNativePublicationDateFromVerifiedReceipt(item);
  const rawAuthorHandle = nativeAuthor.handle ?? item.authorHandle ?? null;
  const authorHandle = item.platform === "linkedin"
    ? linkedInProfileHandle(rawAuthorHandle ?? undefined) ?? rawAuthorHandle
    : rawAuthorHandle;
  const sourceUrl = contextEvidenceContentUrl(item.platform, item.platformPostId) ?? item.sourceUrl;
  const receiptLinkStatus = nativeLinkStatusFromVerifiedReceipt(
    nativePublication ? { ...item, ...nativePublication } : item
  );
  const nativeLinkStatus = receiptLinkStatus === "invalid" || receiptLinkStatus === "blocked"
    ? receiptLinkStatus
    : isVerifiedOfficialYcCompanyPageYouTubeEmbed(item)
      ? "verified"
      : receiptLinkStatus;

  return enrichEvidenceThumbnail({
    id: item.id,
    batchSlug: String(item.batchSlug ?? item.batch_slug ?? "").trim() || undefined,
    entityType: item.entityType,
    entityId: item.entityId,
    platform: item.platform,
    authorName: nativeAuthor.name ?? item.authorName ?? item.title ?? item.companyName,
    authorHandle,
    postedAt: nativeGithubTimestamps
      ? nativeGithubTimestamps.postedAt
      : nativePublication?.postedAt ?? item.postedAt ?? item.last_updated_at ?? publicSnapshot.source.fetchedAt,
    publishedAtPrecision: item.platform === "github"
      ? nativeGithubTimestamps
        ? nativeGithubTimestamps.publishedAtPrecision
        : "unknown"
      : nativePublication
        ? nativePublication.publishedAtPrecision
        : item.postedAt
          ? sourcePublicationTimestampPrecision(item)
          : "unknown",
    observedAt,
    metricsCheckedAt: item.last_checked_at ?? item.last_updated_at ?? publicSnapshot.source.fetchedAt,
    title: displayTitle,
    text: verbatimText || item.text || displayTitle,
    ...(originalText ? { originalText } : {}),
    ...(item.attributionProvenance ? { attributionProvenance: item.attributionProvenance } : {}),
    mediaType: mediaTypeForPlatform(item.platform),
    mediaUrl: item.mediaUrl ?? null,
    mediaUrls,
    thumbnailUrl: item.thumbnailUrl ?? null,
    thumbnailSource: item.thumbnailSource ?? null,
    linkStatus: isLinkedInCommentContext ? "unchecked" : nativeLinkStatus,
    linkCheckedAt: isLinkedInCommentContext ? null : item.linkCheckedAt ?? null,
    linkFailureReason: item.linkFailureReason ?? null,
    metrics: item.metrics ?? {},
    contributionScore,
    tractionStatus: item.tractionStatus,
    tractionLimitations: item.tractionLimitations,
    sourceUrl: linkedInActivity.kind === "native_comment" ? linkedInActivity.contextUrl : sourceUrl,
    platformPostId:
      linkedInActivity.kind === "native_comment"
        ? linkedInActivity.reference.commentId
        : isLinkedInCommentContext
          ? null
          : item.platformPostId ?? platformPostIdFromUrl(item.platform, item.sourceUrl),
    platformObjectId:
      item.platformObjectId ?? (githubRepository?.id == null ? null : String(githubRepository.id)),
    rawVisibleText: githubTimestamps
      ? githubRawVisibleText(item.rawVisibleText, githubTimestamps.provenance)
      : item.rawVisibleText,
    first_seen_at: item.first_seen_at,
    last_checked_at: item.last_checked_at,
    last_updated_at: githubTimestamps?.lastUpdatedAt ?? item.last_updated_at,
    why: isRetweet
      ? "Stored as context only. Retweets are not counted as original post traction."
      : linkedInActivity.kind === "native_comment"
        ? `Stored as context only: contextual Top Voice attention. Native LinkedIn comments are not original posts and never contribute to regular company or founder traction scores. Direct comment locator: ${item.sourceUrl}`
        : linkedInActivity.kind === "mislabelled_parent_comment"
          ? `Rejected as traction and retained as context only. The row assigns a comment by ${linkedInActivity.claimedAuthorHandle ?? "an unresolved author"} to a parent post owned by ${linkedInActivity.sourceAuthorHandle ?? "another account"} without a stable comment identity. Parent-post IDs and metrics are never attributed as comment or company traction.`
          : linkedInActivity.kind === "unlocated_comment"
            ? "Stored as context only. This LinkedIn comment claim has no separate stable native comment identity, so its parent-post URL, ID, and metrics are never treated as original post traction."
            : isProfileContext
              ? isLinkedInActivityFragment
                ? "Stored as context only. LinkedIn profile activity fragments lack a stable native post identity and are not counted as post-level traction."
                : "Stored as context only. Profile pages are not counted as post-level traction."
              : item.matchReason,
    attachedCompanyId: attachedCompanyIdForPublicEvidence(item),
    attachedCompanyName: item.companyName,
    socialAccountId: null,
    accountUrl: item.accountUrl ?? null,
    matchReason: item.matchReason,
    review_state:
      linkedInActivity.kind === "mislabelled_parent_comment"
        ? "rejected"
        : linkedInActivity.kind === "unlocated_comment"
          ? "needs_review"
          : item.review_state
  });
}

function buildGithubRepositoryIndex(snapshots: GithubSnapshot[]): Map<string, GithubRepo> {
  const repositories = new Map<string, GithubRepo>();

  for (const snapshot of snapshots) {
    for (const account of snapshot.accounts ?? []) {
      for (const repository of account.repos ?? []) {
        const identity = githubRepositoryIdentity(repository.htmlUrl, repository.fullName);
        if (!identity) continue;
        const existing = repositories.get(identity);
        repositories.set(
          identity,
          existing ? mergeIndexedGithubRepository(existing, repository) : repository
        );
      }
    }
  }

  return repositories;
}

function mergeIndexedGithubRepository(left: GithubRepo, right: GithubRepo): GithubRepo {
  const leftActivity = Math.max(Date.parse(left.updatedAt ?? "") || 0, Date.parse(left.pushedAt ?? "") || 0);
  const rightActivity = Math.max(Date.parse(right.updatedAt ?? "") || 0, Date.parse(right.pushedAt ?? "") || 0);
  const base = rightActivity >= leftActivity ? right : left;
  return {
    ...base,
    createdAt: indexedTimestamp("earliest", left.createdAt, right.createdAt) ?? undefined,
    updatedAt: indexedTimestamp("latest", left.updatedAt, right.updatedAt) ?? undefined,
    pushedAt: indexedTimestamp("latest", left.pushedAt, right.pushedAt) ?? undefined
  };
}

function indexedTimestamp(
  direction: "earliest" | "latest",
  ...values: Array<string | null | undefined>
): string | null {
  const timestamps = values.filter(
    (value): value is string => Boolean(value && Number.isFinite(Date.parse(value)))
  );
  timestamps.sort((left, right) =>
    direction === "earliest" ? Date.parse(left) - Date.parse(right) : Date.parse(right) - Date.parse(left)
  );
  return timestamps[0] ?? null;
}

function githubRawVisibleText(
  rawVisibleText: string | undefined,
  repositoryTimestamps: ReturnType<typeof githubRepositoryEvidenceTimestamps>["provenance"]
): string {
  if (rawVisibleText?.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawVisibleText) as unknown;
      if (isUnknownRecord(parsed)) {
        return JSON.stringify({ ...parsed, repositoryTimestamps });
      }
    } catch {
      // Preserve malformed or plain-text source evidence below.
    }
  }

  return JSON.stringify({
    repositoryTimestamps,
    ...(rawVisibleText ? { sourceEvidence: rawVisibleText } : {})
  });
}

function resolveGithubRepository(item: PublicEvidenceRecord): GithubRepo | null {
  if (item.platform !== "github") return null;
  const identity = githubRepositoryIdentity(item.sourceUrl, item.platformPostId);
  if (!identity) return null;

  const embeddedRepository = githubRepositoryFromRawVisibleText(item.rawVisibleText, identity);
  if (embeddedRepository?.createdAt) return embeddedRepository;

  const canonicalRepository = githubRepositoriesByIdentity.get(identity);
  return canonicalRepository?.createdAt ? canonicalRepository : embeddedRepository ?? canonicalRepository ?? null;
}

function githubRepositoryIdentity(sourceUrl: string | null | undefined, platformPostId?: string | null): string | null {
  const urlIdentity = sourceUrl ? nativeEvidenceIdentityFromUrl("github", sourceUrl) : null;
  if (urlIdentity) return urlIdentity.toLowerCase();

  const candidate = String(platformPostId ?? "").trim().replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

function githubRepositoryFromRawVisibleText(
  rawVisibleText: string | undefined,
  expectedIdentity: string
): GithubRepo | null {
  if (!rawVisibleText?.trim().startsWith("{")) return null;

  try {
    const parsed = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const records = [
      { value: parsed.repository, requireNativeIdentity: false },
      { value: parsed.repo, requireNativeIdentity: false },
      { value: parsed.post, requireNativeIdentity: true }
    ].filter((candidate): candidate is { value: Record<string, unknown>; requireNativeIdentity: boolean } =>
      isUnknownRecord(candidate.value)
    );
    for (const { value: record, requireNativeIdentity } of records) {
      const recordUrl = stringRecordValue(record, "url") ?? stringRecordValue(record, "htmlUrl");
      const fullName = stringRecordValue(record, "fullName") ?? stringRecordValue(record, "full_name");
      const identity = githubRepositoryIdentity(recordUrl, fullName);
      if ((requireNativeIdentity && !identity) || (identity && identity !== expectedIdentity)) continue;

      const createdAt = timestampRecordValue(record, "createdAt", "created_at");
      const updatedAt = timestampRecordValue(record, "updatedAt", "updated_at");
      const pushedAt = timestampRecordValue(record, "pushedAt", "pushed_at");
      if (!createdAt && !updatedAt && !pushedAt) continue;

      const [owner, repoName] = expectedIdentity.split("/");
      const id = finiteRecordNumber(record, "id");
      return {
        ...(id == null ? {} : { id }),
        name: repoName,
        fullName: fullName ?? expectedIdentity,
        description: stringRecordValue(record, "description") ?? "",
        htmlUrl: recordUrl ?? `https://github.com/${owner}/${repoName}`,
        stars: 0,
        forks: 0,
        watchers: 0,
        openIssues: 0,
        language: null,
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(pushedAt ? { pushedAt } : {}),
        score: 0
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timestampRecordValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = stringRecordValue(record, key);
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

function publicEvidenceItemWithAttributionGuard(
  item: PublicEvidenceRecord,
  context: AttributionContext,
  companiesById: Map<string, RawCompany>
): EvidenceItem {
  const normalizedItem = normalizePublicEvidenceRawVisibleText(item);
  const evidence = publicEvidenceItem(normalizedItem);
  const company = companiesById.get(normalizedItem.entityId);

  if (
    shouldTrustCanonicalAttributionReceiptAtGraphBoundary(normalizedItem) ||
    (company && linkedInNativeCompanyAuthorMatchesKnownEntity(normalizedItem, company))
  ) {
    return evidence;
  }

  return applyAttributionGuard(evidence, context);
}

function normalizePublicEvidenceRawVisibleText(item: PublicEvidenceRecord): PublicEvidenceRecord {
  const value: unknown = item.rawVisibleText;
  if (typeof value === "string") return item;

  let rawVisibleText = "";
  if (value !== null && value !== undefined) {
    try {
      rawVisibleText = JSON.stringify(value) ?? "";
    } catch {
      // Public evidence is loaded from JSON, so this is defensive only. An
      // unserializable receipt must not crash graph publication or become
      // trusted author text.
      rawVisibleText = "";
    }
  }
  return { ...item, rawVisibleText };
}

function attachedCompanyIdForPublicEvidence(item: PublicEvidenceRecord): string {
  if (item.entityType === "company") {
    return item.entityId;
  }

  return companyIdForEvidenceEntityId(item.entityId) ?? companyIdFromEvidenceName(item.companyName);
}

function companyIdForEvidenceEntityId(entityId: string): string | null {
  return companyIdByEntityId.get(entityId) ?? null;
}

function nativeAuthorFromRawVisibleText(rawVisibleText: string | undefined): { name: string | null; handle: string | null } {
  if (!rawVisibleText?.trim().startsWith("{")) {
    return { name: null, handle: null };
  }

  try {
    const parsed = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const post = parsed.post && typeof parsed.post === "object" ? parsed.post as Record<string, unknown> : null;
    const profile = parsed.profile && typeof parsed.profile === "object" ? parsed.profile as Record<string, unknown> : null;
    return {
      name: stringRecordValue(post, "authorName") ?? stringRecordValue(post, "name") ?? stringRecordValue(profile, "name"),
      handle: stringRecordValue(post, "authorHandle") ?? stringRecordValue(post, "username") ?? stringRecordValue(profile, "username")
    };
  } catch {
    return { name: null, handle: null };
  }
}

function stringRecordValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function platformPostIdFromUrl(platform: Platform, rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/$/, "");

    if (platform === "x") {
      return path.match(/\/status\/(\d+)/i)?.[1] ?? null;
    }
    if (platform === "tiktok") {
      return path.match(/^\/@[A-Za-z0-9._-]+\/video\/(\d+)/i)?.[1] ?? null;
    }
    if (platform === "bluesky") {
      const match = path.match(/^\/profile\/([^/]+)\/post\/([^/]+)/i);
      return match ? `${match[1].toLowerCase()}/post/${match[2]}` : null;
    }
    if (platform === "instagram") {
      return path.match(/^\/(?:p|reel|tv)\/([^/]+)/i)?.[1] ?? null;
    }
    if (platform === "linkedin") {
      return (
        path.match(/\/feed\/update\/urn:li:activity:(\d+)/i)?.[1] ??
        path.match(/\/posts\/([^/]+)/i)?.[1] ??
        null
      );
    }
    if (platform === "youtube") {
      return url.searchParams.get("v") ?? path.match(/\/shorts\/([^/]+)/i)?.[1] ?? null;
    }
    if (platform === "product_hunt") {
      return path.match(/\/posts\/([^/]+)/i)?.[1] ?? path.match(/\/products\/([^/]+)/i)?.[1] ?? null;
    }
    if (platform === "reddit") {
      return path.match(/\/comments\/([^/]+)/i)?.[1] ?? null;
    }
    if (platform === "hacker_news") {
      return url.searchParams.get("id");
    }
  } catch {
    return null;
  }

  return null;
}

function isProfileOnlySocialEvidence(item: PublicEvidenceRecord): boolean {
  if (!["linkedin", "x", "instagram", "tiktok", "bluesky"].includes(item.platform)) {
    return false;
  }

  if (isLinkedInProfileActivityFragment(item)) {
    return true;
  }

  if (item.platformPostId) {
    return false;
  }

  try {
    const url = new URL(item.sourceUrl);
    const pathAndHash = `${url.pathname}${url.hash}`.toLowerCase();
    if (item.platform === "x") {
      return !/\/status\/\d+/.test(pathAndHash);
    }
    if (item.platform === "instagram") {
      return !(/^\/(p|reel|tv)\//.test(pathAndHash) || /#post-\d+/.test(pathAndHash));
    }
    if (item.platform === "linkedin") {
      return !/\/feed\/update\/|\/posts\//.test(pathAndHash);
    }
    if (item.platform === "tiktok") {
      return !/\/@[a-z0-9._-]+\/video\/\d+/i.test(pathAndHash);
    }
    if (item.platform === "bluesky") {
      return !/^\/profile\/[^/]+\/post\/[^/]+/i.test(pathAndHash);
    }
  } catch {
    return true;
  }

  return false;
}

function isLinkedInProfileActivityFragment(item: PublicEvidenceRecord): boolean {
  if (item.platform !== "linkedin") {
    return false;
  }

  try {
    const url = new URL(item.sourceUrl);
    return /\/recent-activity\//i.test(url.pathname) && /^#post-/i.test(url.hash);
  } catch {
    return false;
  }
}

function classifyLinkedInActivity(item: PublicEvidenceRecord): LinkedInActivityPolicy {
  if (item.platform !== "linkedin") {
    return { kind: "not_comment" };
  }

  const reference = linkedInCommentReference(item);
  if (reference && (!item.platformPostId || item.platformPostId === reference.commentId)) {
    return {
      kind: "native_comment",
      reference,
      contextUrl: canonicalLinkedInCommentContextUrl(item, reference) ?? item.sourceUrl
    };
  }

  if (!reference && !hasExplicitLinkedInCommentClaim(item)) {
    return { kind: "not_comment" };
  }

  const sourceAuthorHandle = linkedInAuthorHandleFromPostUrl(item.sourceUrl);
  const claimedAuthorHandle =
    normalizeHandle(nativeAuthorFromRawVisibleText(item.rawVisibleText).handle ?? undefined) || null;
  if (reference || (sourceAuthorHandle && claimedAuthorHandle && sourceAuthorHandle !== claimedAuthorHandle)) {
    return {
      kind: "mislabelled_parent_comment",
      sourceAuthorHandle,
      claimedAuthorHandle
    };
  }

  return { kind: "unlocated_comment" };
}

function linkedInCommentReference(item: PublicEvidenceRecord): LinkedInCommentReference | null {
  if (item.platform !== "linkedin") {
    return null;
  }

  try {
    const sourceUrl = new URL(item.sourceUrl);
    const sourceHost = sourceUrl.hostname.replace(/^www\./i, "").toLowerCase();
    if (sourceHost !== "linkedin.com" && !sourceHost.endsWith(".linkedin.com")) {
      return null;
    }

    const raw = rawVisibleTextRecord(item.rawVisibleText);
    const post = recordFromUnknown(raw?.post);
    const verification = recordFromUnknown(raw?.verification);
    const verificationReason = recordFromUnknown(verification?.reason);
    const commentUrns = [
      ...[...sourceUrl.searchParams.entries()]
        .filter(([key]) => key.toLowerCase().includes("comment"))
        .map(([, value]) => value),
      stringRecordValue(post, "commentUrn"),
      stringRecordValue(verificationReason, "commentUrn"),
      stringRecordValue(raw, "commentUrn")
    ].filter((value): value is string => Boolean(value));

    for (const commentUrn of commentUrns) {
      const reference = parseLinkedInCommentUrn(commentUrn);
      if (reference) {
        return reference;
      }
    }

    const activityCommentId = /\/recent-activity\/comments\/?$/i.test(sourceUrl.pathname)
      ? sourceUrl.hash.match(/^#post-(\d+)$/i)?.[1]
      : null;
    return activityCommentId
      ? { commentId: activityCommentId, parentPostId: null, commentUrn: null }
      : null;
  } catch {
    return null;
  }
}

function parseLinkedInCommentUrn(value: string): LinkedInCommentReference | null {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // URLSearchParams may already have decoded a value containing a literal percent sign.
  }

  const match = decoded.match(
    /urn:li:comment:\(\s*urn:li:(?:activity|ugcPost|share):(\d+)\s*,\s*(\d+)\s*\)/i
  );
  return match
    ? { parentPostId: match[1], commentId: match[2], commentUrn: decoded }
    : null;
}

function canonicalLinkedInCommentContextUrl(
  item: PublicEvidenceRecord,
  reference: LinkedInCommentReference
): string | null {
  const nativeAuthor = nativeAuthorFromRawVisibleText(item.rawVisibleText);
  const rawProfileUrl =
    item.accountUrl ??
    (nativeAuthor.handle
      ? `https://www.linkedin.com/in/${encodeURIComponent(nativeAuthor.handle)}`
      : null);
  if (!rawProfileUrl) {
    return null;
  }

  try {
    const profileUrl = new URL(rawProfileUrl);
    const profileHost = profileUrl.hostname.replace(/^www\./i, "").toLowerCase();
    const profileHandle = handleFromUrl(profileUrl.toString());
    if (
      (profileHost !== "linkedin.com" && !profileHost.endsWith(".linkedin.com")) ||
      !profileHandle ||
      !/\/in\//i.test(profileUrl.pathname)
    ) {
      return null;
    }

    profileUrl.search = "";
    profileUrl.pathname = `/in/${encodeURIComponent(profileHandle)}/recent-activity/comments/`;
    profileUrl.hash = `post-${reference.commentId}`;
    return profileUrl.toString();
  } catch {
    return null;
  }
}

export function hasExplicitLinkedInCommentClaim(
  item: Pick<PublicEvidenceRecord, "title" | "matchReason">
): boolean {
  // Comment classification must come from explicit adjudication metadata or a
  // stable native comment locator. Ordinary post prose such as "2 comments on
  // this activity" is not evidence that the row itself is a comment.
  const adjudicationText = [item.title, item.matchReason].filter(Boolean).join(" ");
  return /\b(?:linkedin|native)\s+comment\b|\bcomment-level\b|\bdirect\s+comment\s+(?:permalink|locator)\b/i.test(
    adjudicationText
  );
}

function rawVisibleTextRecord(rawVisibleText: string | undefined): Record<string, unknown> | null {
  if (!rawVisibleText?.trim().startsWith("{")) {
    return null;
  }

  try {
    return recordFromUnknown(JSON.parse(rawVisibleText));
  } catch {
    return null;
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isKnownSummerEvidenceRecord(item: PublicEvidenceRecord): boolean {
  return knownEntityIds.has(item.entityId) && evidenceMatchesBatchScope(
    item,
    YC_SUMMER_2026_BATCH_SLUG,
    !hasStaleSpringBatchContext(evidenceBatchText(item))
  );
}

function canonicalizeRenamedSummerEntity<
  T extends { entityId: string; companySlug?: string; companyName?: string; entityName?: string }
>(item: T): T {
  // A display-name match cannot prove that old evidence belongs to the renamed
  // company. The explicit alias ledger requires immutable founder/company IDs,
  // exact account lineage, and a native physical post before remapping. A
  // quarantined row deliberately retains its stale ID and is filtered out by
  // the known-entity gate below.
  const decision = reconcileLegacySummerEvidenceEntity(item);
  return decision.status === "remapped" ? decision.row : item;
}

function isKnownSummerNeedsReviewRecord(item: PublicNeedsReviewRecord): boolean {
  return knownEntityIds.has(item.entityId) && evidenceMatchesBatchScope(
    item,
    YC_SUMMER_2026_BATCH_SLUG,
    !hasStaleSpringBatchContext(`${item.entityName} ${item.matchReason}`)
  );
}

export function evidenceMatchesBatchScope(
  item: { entityId?: string; batchSlug?: string; batch_slug?: string },
  expectedBatchSlug: string,
  legacyMatch: boolean
): boolean {
  const explicitBatchSlug = String(item.batchSlug ?? item.batch_slug ?? "").trim();
  if (explicitBatchSlug) {
    return explicitBatchSlug.toUpperCase() === expectedBatchSlug.toUpperCase();
  }
  if (item.entityId && crossBatchEntityIds.has(item.entityId)) {
    return false;
  }
  return legacyMatch;
}

function hasCrossBatchEntityAmbiguity(
  item: { entityId: string; attachedCompanyId?: string | null; batchSlug?: string }
): boolean {
  if (String(item.batchSlug ?? "").trim()) {
    return false;
  }

  return (
    crossBatchEntityIds.has(item.entityId) ||
    Boolean(item.attachedCompanyId && crossBatchEntityIds.has(item.attachedCompanyId))
  );
}

function isKnownSummerGithubAccount(account: GithubAccount): boolean {
  const officialGithubUrls = officialGithubUrlsByEntityId.get(account.entityId);
  return Boolean(officialGithubUrls?.has(canonicalAccountUrl(account.githubUrl)));
}

function buildOfficialSummerGithubUrlsByEntityId(): Map<string, Set<string>> {
  const urlsByEntityId = new Map<string, Set<string>>();
  const add = (entityId: string, rawUrl: string | undefined) => {
    if (!rawUrl) return;
    const canonicalUrl = canonicalAccountUrl(rawUrl);
    urlsByEntityId.set(entityId, new Set([...(urlsByEntityId.get(entityId) ?? []), canonicalUrl]));
  };

  for (const company of snapshot.companies) {
    add(companyId(company), company.socialLinks.github);
    add(companyId(company), historicalSocialLinksForSummerCompany(company.slug).github);
    for (const founder of company.founders) {
      add(founderId(company, founder), founder.socialLinks.github);
    }
  }

  return urlsByEntityId;
}

function historicalSocialLinksForSummerCompany(slug: string): RawSocialLinks {
  const rename = SUMMER_COMPANY_SLUG_RENAMES.find((candidate) => candidate.to === slug);
  return rename?.historicalSocialLinks ?? {};
}

function evidenceBatchText(item: PublicEvidenceRecord): string {
  return `${item.title} ${item.text} ${item.rawVisibleText} ${item.matchReason}`;
}

function hasStaleSpringBatchContext(value: string): boolean {
  return /\b(?:Spring\s+2026|YC\s*P26|YCP26|P26)\b/i.test(value);
}

function hasSummerBatchContext(value: string): boolean {
  return /\b(?:Summer\s+2026|YC\s*S26|YCS26|S26)\b/i.test(value);
}

function hasSpringBatchContext(value: string): boolean {
  return /\b(?:Spring\s+2026|YC\s*S2026|YCS2026|S2026|YC\s*P26|YCP26|P26)\b/i.test(value);
}

function isAcceptedPublicEvidence(item: PublicEvidenceRecord): boolean {
  if (item.linkStatus === "invalid") {
    return false;
  }

  if (item.platform === "linkedin") {
    return hasVerifiedSemanticAttributionReceipt(item) || isAcceptedLinkedInEvidenceWithoutSemanticReceipt(item);
  }

  if (item.platform !== "hacker_news") {
    return true;
  }

  return acceptedNativeHackerNewsEvidence(
    item,
    YC_SUMMER_2026_BATCH_SLUG,
    hasSummerBatchContext(evidenceBatchText(item))
  );
}

function acceptedNativeHackerNewsEvidence(
  item: PublicEvidenceRecord,
  expectedBatchSlug: string,
  legacyContextMatch: boolean
): boolean {
  if (!isNativeHackerNewsItemUrl(item.sourceUrl)) {
    return false;
  }

  const explicitBatchSlug = String(item.batchSlug ?? item.batch_slug ?? "").trim();
  return explicitBatchSlug
    ? explicitBatchSlug.toUpperCase() === expectedBatchSlug.toUpperCase()
    : legacyContextMatch;
}

function hasVerifiedSemanticAttributionReceipt(item: PublicEvidenceRecord): boolean {
  return (
    item.review_state === "verified" &&
    Number(item.attributionVersion ?? 0) >= 3 &&
    item.attributionStatus === "verified" &&
    (item.attributionSignals?.length ?? 0) > 0
  );
}

function shouldTrustCanonicalAttributionReceiptAtGraphBoundary(item: PublicEvidenceRecord): boolean {
  if (isVerifiedOfficialYcCompanyPageYouTubeEmbed(item)) {
    return true;
  }

  if (!hasVerifiedSemanticAttributionReceipt(item)) {
    return false;
  }

  if (item.platform === "linkedin") {
    const explicitBatchSlug = String(item.batchSlug ?? item.batch_slug ?? "").trim().toUpperCase();
    return (
      explicitBatchSlug === YC_SUMMER_2026_BATCH_SLUG &&
      !isAcceptedLinkedInEvidenceWithoutSemanticReceipt(item)
    );
  }

  if (item.platform === "hacker_news") {
    const explicitBatchSlug = String(item.batchSlug ?? item.batch_slug ?? "").trim().toUpperCase();
    if (explicitBatchSlug === YC_SPRING_2026_BATCH_SLUG) {
      return !hasSpringBatchContext(evidenceBatchText(item));
    }
    if (explicitBatchSlug === YC_SUMMER_2026_BATCH_SLUG) {
      return !hasSummerBatchContext(evidenceBatchText(item));
    }
  }

  return false;
}

export function isVerifiedOfficialYcCompanyPageYouTubeEmbed(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }

  const evidence = item as Partial<PublicEvidenceRecord>;
  if (
    evidence.platform !== "youtube" ||
    evidence.entityType !== "company" ||
    evidence.review_state !== "verified" ||
    evidence.attributionStatus !== "verified"
  ) {
    return false;
  }

  const explicitBatchSlug = String(evidence.batchSlug ?? evidence.batch_slug ?? "").trim().toUpperCase();
  const catalog =
    explicitBatchSlug === YC_SUMMER_2026_BATCH_SLUG
      ? snapshot.companies
      : explicitBatchSlug === YC_SPRING_2026_BATCH_SLUG
        ? springSnapshot.companies
        : null;
  if (!catalog) {
    return false;
  }

  const catalogCompany = catalog.find((company) => companyId(company) === evidence.entityId);
  const receipt = rawVisibleTextRecord(evidence.rawVisibleText);
  const receiptCompany = recordFromUnknown(receipt?.company);
  const receiptPost = recordFromUnknown(receipt?.post);
  const receiptMetrics = recordFromUnknown(receipt?.metrics);
  const receiptSource = stringRecordValue(receipt, "source");
  const isAutomatedReceipt =
    receiptSource === "official_yc_company_page_embed_v1" &&
    (evidence.attributionSignals?.length ?? 0) > 0;
  const isManualAdjudicationReceipt =
    receiptSource === "manual_official_yc_embed_adjudication_v1" &&
    evidence.attributionProvenance === receiptSource &&
    evidence.attributionMode === "subject" &&
    stringRecordValue(receipt, "verification") === evidence.matchReason;
  if (
    !catalogCompany ||
    (!isAutomatedReceipt && !isManualAdjudicationReceipt) ||
    stringRecordValue(receiptCompany, "entityId") !== evidence.entityId ||
    stringRecordValue(receiptCompany, "slug") !== catalogCompany.slug ||
    stringRecordValue(receiptCompany, "name") !== catalogCompany.name ||
    evidence.companyName !== catalogCompany.name ||
    stringRecordValue(receipt, "officialYcProfileUrl") !== catalogCompany.ycProfileUrl
  ) {
    return false;
  }

  const canonicalPostId = String(evidence.platformPostId ?? "").trim();
  const receiptPostId = stringRecordValue(receiptPost, "platformPostId");
  const nativeUrlPostId = nativeYouTubeVideoId(evidence.sourceUrl);
  if (
    !canonicalPostId ||
    receiptPostId !== canonicalPostId ||
    nativeUrlPostId !== canonicalPostId ||
    stringRecordValue(receiptPost, "publishedAt") !== evidence.postedAt
  ) {
    return false;
  }

  const receiptViews = finiteRecordNumber(receiptMetrics, "views");
  const receiptLikes = finiteRecordNumber(receiptMetrics, "likes");
  const receiptComments = finiteRecordNumber(receiptMetrics, "comments");
  return (
    receiptViews !== null &&
    receiptViews > 0 &&
    receiptViews === Number(evidence.metrics?.views) &&
    receiptLikes === Number(evidence.metrics?.likes ?? 0) &&
    receiptComments === Number(evidence.metrics?.comments ?? 0)
  );
}

function nativeYouTubeVideoId(rawUrl: string | null | undefined): string | null {
  try {
    const url = new URL(rawUrl ?? "");
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (host === "youtu.be") {
      return path.match(/^\/([A-Za-z0-9_-]+)$/)?.[1] ?? null;
    }
    if (host !== "youtube.com" && host !== "m.youtube.com") {
      return null;
    }
    if (path === "/watch") {
      return url.searchParams.get("v");
    }
    return path.match(/^\/shorts\/([A-Za-z0-9_-]+)$/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function finiteRecordNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAcceptedLinkedInEvidenceWithoutSemanticReceipt(item: PublicEvidenceRecord): boolean {
  return (
    isLoggedInLinkedInActivityEvidence(item) ||
    linkedInPostAuthorMatchesKnownEntity(item) ||
    isKnownTopVoiceAccountUrl(item.platform, item.sourceUrl) ||
    isKnownTopVoiceNativeIdentity(item.platform, item.rawVisibleText)
  );
}

function isNativeHackerNewsItemUrl(rawUrl: string | null | undefined): boolean {
  try {
    const url = new URL(rawUrl ?? "");
    return url.hostname === "news.ycombinator.com" && url.pathname === "/item" && Boolean(url.searchParams.get("id"));
  } catch {
    return false;
  }
}

function isLoggedInLinkedInActivityEvidence(item: PublicEvidenceRecord): boolean {
  if (!knownEntityIds.has(item.entityId)) {
    return false;
  }

  if (!item.matchReason?.includes("Opt-in logged-in LinkedIn activity-page original post scrape")) {
    return false;
  }

  try {
    const url = new URL(item.sourceUrl);
    return url.hostname.endsWith("linkedin.com") && url.pathname.includes("/recent-activity/all/");
  } catch {
    return false;
  }
}

function linkedInPostAuthorMatchesKnownEntity(item: PublicEvidenceRecord): boolean {
  const company = snapshot.companies.find((candidate) =>
    companyId(candidate) === item.entityId ||
    candidate.founders.some((founder) => founderId(candidate, founder) === item.entityId) ||
    manualFounderOverrides(candidate).some((founder) => manualFounderId(candidate, founder) === item.entityId)
  );
  if (!company) {
    return false;
  }

  const companyProfile = attributionCompanyProfile(company);
  const knownHandles = new Set(
    [
      ...companyProfile.socialLinks,
      ...companyProfile.founders.flatMap((founder) => founder.socialLinks)
    ]
      .filter((link) => link.platform === "linkedin")
      .map((link) => linkedInProfileHandle(link.url))
      .filter((handle): handle is string => Boolean(handle))
  );
  const nativeAuthor = nativeAuthorFromRawVisibleText(item.rawVisibleText);
  const candidateHandles = [
    linkedInAuthorHandleFromPostUrl(item.sourceUrl),
    linkedInProfileHandle(item.accountUrl ?? undefined),
    normalizeHandle(item.authorHandle ?? undefined),
    normalizeHandle(nativeAuthor.handle ?? undefined)
  ].filter((handle): handle is string => Boolean(handle));

  if (candidateHandles.some((handle) => knownHandles.has(handle))) {
    return true;
  }

  return linkedInNativeAuthorMatchesKnownEntity(item, company);
}

function linkedInNativeAuthorMatchesKnownEntity(item: PublicEvidenceRecord, company: RawCompany): boolean {
  if (linkedInNativeCompanyAuthorMatchesKnownEntity(item, company)) {
    return true;
  }

  const nativeAuthor = nativeAuthorFromRawVisibleText(item.rawVisibleText);
  const authorName = normalizeSearchText(nativeAuthor.name ?? item.authorName ?? "");
  if (!authorName) {
    return false;
  }

  const knownNames = new Set([
    normalizeSearchText(company.name),
    ...company.founders.map((founder) => normalizeSearchText(founder.name)),
    ...manualFounderOverrides(company).map((founder) => normalizeSearchText(founder.name))
  ]);
  if (!knownNames.has(authorName)) {
    return false;
  }

  return linkedinEvidenceMentionsCompanyOrFounder(item, company);
}

function linkedInNativeCompanyAuthorMatchesKnownEntity(
  item: PublicEvidenceRecord,
  company: RawCompany
): boolean {
  if (
    item.platform !== "linkedin" ||
    item.entityType !== "company" ||
    item.entityId !== companyId(company)
  ) {
    return false;
  }

  const nativePostId = nativeEvidenceIdentityFromUrl("linkedin", item.sourceUrl);
  if (!nativePostId || (item.platformPostId && item.platformPostId !== nativePostId)) {
    return false;
  }

  const nativeAuthor = nativeAuthorFromRawVisibleText(item.rawVisibleText);
  const authorName = normalizeSearchText(nativeAuthor.name ?? item.authorName ?? "");
  if (!authorName || authorName !== normalizeSearchText(company.name)) {
    return false;
  }

  const sourceAuthorHandle = linkedInAuthorHandleFromPostUrl(item.sourceUrl);
  const declaredAuthorHandle = normalizeHandle(item.authorHandle ?? nativeAuthor.handle ?? undefined);
  return !sourceAuthorHandle || !declaredAuthorHandle || sourceAuthorHandle === declaredAuthorHandle;
}

function linkedinEvidenceMentionsCompanyOrFounder(item: PublicEvidenceRecord, company: RawCompany): boolean {
  const haystack = normalizeSearchText([
    item.title,
    item.text,
    visibleLinkedInRawText(item.rawVisibleText)
  ].filter(Boolean).join(" "));
  if (!haystack) {
    return false;
  }

  const terms = [
    company.name,
    company.websiteUrl ? domainToken(company.websiteUrl) : null,
    ...Object.values(company.socialLinks ?? {}).map(handleFromUrl),
    ...company.founders.map((founder) => founder.name),
    ...company.founders.flatMap((founder) => Object.values(founder.socialLinks ?? {}).map(handleFromUrl)),
    ...manualFounderOverrides(company).map((founder) => founder.name),
    ...manualFounderOverrides(company).flatMap((founder) => Object.values(founder.socialLinks ?? {}).map(handleFromUrl))
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSearchText)
    .filter((term) => term.length >= 4);

  return [...new Set(terms)].some((term) => containsSearchTerm(haystack, term));
}

function visibleLinkedInRawText(rawVisibleText: string | undefined): string {
  if (!rawVisibleText) {
    return "";
  }
  if (!rawVisibleText.trim().startsWith("{")) {
    return rawVisibleText;
  }
  try {
    const parsed = JSON.parse(rawVisibleText) as Record<string, unknown>;
    const post = parsed.post && typeof parsed.post === "object" ? parsed.post as Record<string, unknown> : null;
    const detail = parsed.detail && typeof parsed.detail === "object" ? parsed.detail as Record<string, unknown> : null;
    return [
      typeof parsed.rawText === "string" ? parsed.rawText : null,
      typeof parsed.text === "string" ? parsed.text : null,
      typeof post?.rawText === "string" ? post.rawText : null,
      typeof post?.text === "string" ? post.text : null,
      typeof detail?.rawText === "string" ? detail.rawText : null,
      typeof detail?.text === "string" ? detail.text : null,
      typeof detail?.title === "string" ? detail.title : null
    ].filter(Boolean).join(" ");
  } catch {
    return rawVisibleText;
  }
}

function linkedInAuthorHandleFromPostUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const postIndex = parts.findIndex((part) => part.toLowerCase() === "posts");
    if (postIndex >= 0 && parts[postIndex + 1]) {
      return normalizeHandle(parts[postIndex + 1].split("_")[0]);
    }
  } catch {
    return null;
  }

  return null;
}

function linkedInProfileHandle(rawUrl: string | undefined): string | null {
  const handle = rawUrl ? handleFromUrl(rawUrl) : null;
  return handle ? normalizeHandle(handle) : null;
}

function normalizeHandle(value: string | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+$/, "");
}

function publicNeedsReviewItem(item: PublicNeedsReviewRecord): NeedsReviewItem {
  return {
    id: item.id,
    batchSlug: String(item.batchSlug ?? item.batch_slug ?? "").trim() || undefined,
    entityType: item.entityType,
    entityId: item.entityId,
    entityName: item.entityName,
    platform: item.platform,
    candidateUrl: item.candidateUrl,
    review_state: item.review_state,
    matchReason: item.matchReason
  };
}

function attributionCompanyProfile(raw: RawCompany): AttributionCompanyProfile {
  const manualFounders = manualFounderOverrides(raw);

  return {
    id: companyId(raw),
    name: raw.name,
    slug: raw.slug,
    websiteUrl: raw.websiteUrl,
    socialLinks: [
      ...attributionSocialLinks(raw.socialLinks),
      ...attributionSocialLinks(historicalSocialLinksForSummerCompany(raw.slug)),
      ...attributionSocialLinks(verifiedSocialOverrides[raw.slug]?.companySocialLinks ?? {})
    ],
    founders: [
      ...raw.founders.map((founder) => {
        const verifiedOverride = matchingVerifiedFounderOverride(raw, founder.name);
        return {
          id: founderId(raw, founder),
          name: founder.name,
          socialLinks: attributionSocialLinks({
            ...founder.socialLinks,
            ...(verifiedOverride?.socialLinks ?? {})
          })
        };
      }),
      ...manualFounders.map((founder) => ({
        id: manualFounderId(raw, founder),
        name: founder.name,
        socialLinks: attributionSocialLinks(founder.socialLinks)
      }))
    ]
  };
}

function attributionSocialLinks(links: RawSocialLinks): AttributionSocialLink[] {
  return (Object.entries(links) as [keyof RawSocialLinks, string][])
    .filter(([, url]) => Boolean(url))
    .filter(([platform, url]) => urlMatchesPlatform(url, platform))
    .filter(([, url]) => Boolean(handleFromUrl(url)))
    .map(([platform, url]) => ({ platform, url }));
}

function groupEvidenceByEntity(items: EvidenceItem[]): Map<string, EvidenceItem[]> {
  const grouped = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    grouped.set(item.entityId, [...(grouped.get(item.entityId) ?? []), item]);
  }
  return grouped;
}

function resolveEvidenceSocialAccountIds(
  items: EvidenceItem[],
  companies: CompanyRecord[],
  founders: FounderRecord[]
): EvidenceItem[] {
  const accountIdByIdentity = new Map<string, string>();

  for (const company of companies) {
    addMaterializedSocialAccounts(accountIdByIdentity, "company", company.id, company.socialAccounts);
  }
  for (const founder of founders) {
    addMaterializedSocialAccounts(accountIdByIdentity, "founder", founder.id, founder.socialAccounts);
  }

  return items.map((item) => {
    const key = socialAccountIdentityKey(
      item.entityType,
      item.entityId,
      item.platform,
      evidenceAccountUrl(item)
    );
    return {
      ...item,
      socialAccountId: key ? accountIdByIdentity.get(key) ?? null : null
    };
  });
}

function evidenceAccountUrl(item: EvidenceItem): string | null {
  if (item.accountUrl) {
    return item.accountUrl;
  }

  return canDeriveAccountUrlFromSource(item.platform) ? item.sourceUrl : null;
}

function canDeriveAccountUrlFromSource(platform: Platform): boolean {
  return platform === "github" || platform === "x" || platform === "tiktok" || platform === "bluesky";
}

function addMaterializedSocialAccounts(
  accountIdByIdentity: Map<string, string>,
  entityType: EvidenceItem["entityType"],
  entityId: string,
  accounts: SocialAccountSummary[]
): void {
  for (const account of accounts) {
    const key = socialAccountIdentityKey(entityType, entityId, account.platform, account.url);
    if (key) {
      accountIdByIdentity.set(key, account.id);
    }
  }
}

function socialAccountIdentityKey(
  entityType: EvidenceItem["entityType"],
  entityId: string,
  platform: Platform,
  rawUrl: string | null | undefined
): string | null {
  if (!rawUrl?.trim()) {
    return null;
  }

  return `${entityType}\u0000${entityId}\u0000${platform}\u0000${canonicalAccountUrl(rawUrl)}`;
}

function materializedSocialAccountId(
  entityType: EvidenceItem["entityType"],
  entityId: string,
  platform: Platform,
  rawUrl: string
): string {
  return `acct:${entityType}:${entityId}:${platform}:${encodeURIComponent(canonicalAccountUrl(rawUrl))}`;
}

function canonicalizeBatchEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const groups = new Map<string, EvidenceItem[]>();

  for (const item of items) {
    const companyScope = item.attachedCompanyId ?? (item.entityType === "company" ? item.entityId : null);
    const ownerScope = companyScope ?? `${item.entityType}:${item.entityId}`;
    const evidenceScope = hasEvidenceIdentityConflict(item)
      ? `context:${item.id}`
      : canonicalPostKey(item);
    const key = `${ownerScope}:${evidenceScope}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.values()].map(canonicalEvidenceObservation);
}

function dedupeBatchEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const physicalItems = items.filter((item) => !hasEvidenceIdentityConflict(item));
  const contextItems = items.filter(hasEvidenceIdentityConflict);
  const relativeXPostKeys = new Set(
    physicalItems
      .filter((item) => item.platform === "x" && hasRelativeXPublicationLabel(item.rawVisibleText ?? ""))
      .map(canonicalPostKey)
  );
  const dedupedPhysicalItems = dedupeEvidenceItems(physicalItems).map((item) => {
    return relativeXPostKeys.has(canonicalPostKey(item))
      ? { ...item, publishedAtPrecision: "unknown" as const }
      : item;
  });
  return [...dedupedPhysicalItems, ...contextItems];
}

function canonicalEvidenceObservation(items: EvidenceItem[]): EvidenceItem {
  if (items.length === 1) {
    return items[0];
  }

  const verifiedItems = items.filter((item) => item.review_state === "verified");
  const candidates = verifiedItems.length ? verifiedItems : items;
  const payload = strongestEvidenceObservation(candidates);
  const founderItems = candidates.filter(
    (item) => item.entityType === "founder" && Boolean(item.attachedCompanyId)
  );
  const founderAttribution = founderItems.length
    ? strongestEvidenceObservation(founderItems)
    : null;
  const matchReason = mergeEvidenceProvenance(candidates.map((item) => item.matchReason));
  const why = mergeEvidenceProvenance(candidates.map((item) => item.why)) ?? payload.why;
  const canonical = {
    ...payload,
    // Keep one real observation intact. Per-field maxima can synthesize a
    // metric snapshot that never existed and can resurrect stale corrections.
    metrics: payload.metrics,
    // If any same-post X observation came from a relative display label, keep
    // publication precision conservative even when another observation has a
    // materialized timestamp. Relative UI text is not evidence of an exact
    // historical publication time.
    publishedAtPrecision: hasRelativeXObservation(candidates)
      ? "unknown"
      : payload.publishedAtPrecision,
    matchReason,
    why
  };

  if (!founderAttribution) {
    return canonical;
  }

  return {
    ...canonical,
    id: founderAttribution.id,
    entityType: "founder",
    entityId: founderAttribution.entityId,
    attachedCompanyId: founderAttribution.attachedCompanyId,
    attachedCompanyName: founderAttribution.attachedCompanyName ?? canonical.attachedCompanyName,
    socialAccountId: founderAttribution.socialAccountId ?? canonical.socialAccountId,
    canonicalAccountId: founderAttribution.canonicalAccountId ?? canonical.canonicalAccountId,
    accountUrl: founderAttribution.accountUrl ?? canonical.accountUrl,
    thumbnailUrl: founderAttribution.thumbnailUrl ?? canonical.thumbnailUrl,
    thumbnailSource: founderAttribution.thumbnailSource ?? canonical.thumbnailSource
  };
}

function hasRelativeXObservation(items: EvidenceItem[]): boolean {
  return items.some((item) => item.platform === "x" && hasRelativeXPublicationLabel(item.rawVisibleText ?? ""));
}

function strongestEvidenceObservation(items: EvidenceItem[]): EvidenceItem {
  return dedupeEvidenceForScoring(items)[0] ?? items[0];
}

function mergeEvidenceProvenance(values: Array<string | null | undefined>): string | undefined {
  const unique = [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))
    )
  ];
  return unique.length ? unique.join(" ") : undefined;
}

function githubProfileEvidenceId(account: GithubAccount, sourceSnapshot: GithubSnapshot): string {
  const fetchedAccountLogins = new Set(
    sourceSnapshot.accounts
      .filter((candidate) => candidate.entityId === account.entityId && candidate.fetched && candidate.aggregate)
      .map((candidate) => candidate.login.toLowerCase())
  );
  const loginSuffix = fetchedAccountLogins.size > 1 ? `-${slugify(account.login)}` : "";
  return `evidence-github-profile-${account.entityId}${loginSuffix}`;
}

function mediaTypeForPlatform(platform: Platform): EvidenceItem["mediaType"] {
  if (platform === "github") return "repo";
  if (platform === "youtube" || platform === "tiktok") return "video";
  if (platform === "product_hunt") return "launch";
  return "link";
}

function socialAccountsFor(
  links: RawSocialLinks,
  options: {
    entityType: EvidenceItem["entityType"];
    entityId: string;
    discoveredFromUrl: string;
    matchReason: string;
  }
): SocialAccountSummary[] {
  return (Object.entries(links) as [keyof RawSocialLinks, string][])
    .filter(([, url]) => Boolean(url))
    .filter(([platform, url]) => urlMatchesPlatform(url, platform))
    .map(([platform, url]) => {
      const handle = handleFromUrl(url);
      return {
        id: materializedSocialAccountId(options.entityType, options.entityId, platform, url),
        platform,
        handle,
        url,
        review_state: handle ? "verified" : "rejected",
        discoveredFromUrl: options.discoveredFromUrl,
        matchReason: handle
          ? options.matchReason
          : `${options.matchReason} Rejected because the URL has no non-generic account identity.`
      };
    });
}

function manualFounderOverrides(raw: RawCompany): VerifiedFounderOverride[] {
  const rosterFounderNames = new Set(raw.founders.map((founder) => slugify(founder.name)));
  return (verifiedSocialOverrides[raw.slug]?.founders ?? []).filter(
    (founder) => !rosterFounderNames.has(slugify(founder.name))
  );
}

function matchingVerifiedFounderOverride(
  raw: RawCompany,
  founderName: string
): VerifiedFounderOverride | undefined {
  const canonicalName = slugify(founderName);
  return (verifiedSocialOverrides[raw.slug]?.founders ?? []).find(
    (founder) => slugify(founder.name) === canonicalName
  );
}

function buildVerifiedFounderAliases(companies: RawCompany[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const company of companies) {
    const rosterFounderByName = new Map(
      company.founders.map((founder) => [slugify(founder.name), founder])
    );
    for (const founderOverride of verifiedSocialOverrides[company.slug]?.founders ?? []) {
      const rosterFounder = rosterFounderByName.get(slugify(founderOverride.name));
      if (rosterFounder) {
        aliases.set(
          manualFounderId(company, founderOverride),
          founderId(company, rosterFounder)
        );
      }
    }
  }
  return aliases;
}

function canonicalizeVerifiedFounderEntity<T extends { entityId: string }>(
  row: T,
  aliases: Map<string, string>
): T {
  const canonicalEntityId = aliases.get(row.entityId);
  return canonicalEntityId ? { ...row, entityId: canonicalEntityId } : row;
}

function manualFounderId(company: RawCompany, founder: VerifiedFounderOverride): string {
  return `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
}

function dedupeSocialAccounts(accounts: SocialAccountSummary[]): SocialAccountSummary[] {
  return [
    ...new Map(
      accounts.map((account) => [
        socialAccountKey(account.platform, account.url),
        account
      ])
    ).values()
  ];
}

function socialLinksWithoutOverrides(base: RawSocialLinks, overrides: RawSocialLinks): RawSocialLinks {
  return Object.fromEntries(
    Object.entries(base).filter(([platform]) => !overrides[platform as keyof RawSocialLinks])
  ) as RawSocialLinks;
}

function retiredSocialAccountKeys(
  override:
    | (SocialAccountRetirements & {
        companySocialLinks?: RawSocialLinks;
        socialLinks?: RawSocialLinks;
      })
    | null
    | undefined
): Set<string> {
  const records: Array<{ platform: RetirableSocialPlatform; url: string }> = [];
  const rejectedByPlatform: Array<[
    keyof SocialAccountRetirements,
    RetirableSocialPlatform
  ]> = [
    ["rejectedGithub", "github"],
    ["rejectedLinkedin", "linkedin"],
    ["rejectedX", "x"],
    ["rejectedInstagram", "instagram"],
    ["rejectedYoutube", "youtube"],
    ["rejectedProductHunt", "product_hunt"]
  ];

  for (const [field, platform] of rejectedByPlatform) {
    for (const record of override?.[field] ?? []) {
      if (record?.url) records.push({ platform, url: record.url });
    }
  }
  for (const record of override?.retiredAccounts ?? []) {
    if (record?.platform && record.url) {
      records.push({ platform: record.platform, url: record.url });
    }
  }

  const retiredKeys = new Set(records.map(({ platform, url }) => socialAccountKey(platform, url)));

  // A rejected URL can be a nested surface of the verified replacement
  // (for example `/company/acme/posts`). Both URLs intentionally collapse to
  // the same owner identity, so the explicit replacement must remain active.
  for (const links of [override?.companySocialLinks, override?.socialLinks]) {
    for (const [platform, url] of Object.entries(links ?? {})) {
      if (url) retiredKeys.delete(socialAccountKey(platform, url));
    }
  }

  return retiredKeys;
}

function socialAccountKey(platform: string, rawUrl: string): string {
  return `${platform}:${canonicalAccountUrl(rawUrl)}`;
}

function canonicalAccountUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.search = "";
    url.protocol = "https:";
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeUrlPathSegment(part));
    const host = url.hostname;

    if (host === "github.com") {
      const handle = parts[0]?.toLowerCase() === "orgs" ? parts[1] : parts[0];
      if (handle) return `https://github.com/${handle.toLowerCase().replace(/\.git$/i, "")}`;
    }

    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      const markerIndex = parts.findIndex((part) => ["company", "in", "school"].includes(part.toLowerCase()));
      const namespace = markerIndex >= 0 ? parts[markerIndex]?.toLowerCase() : null;
      const handle = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      if (namespace && handle) return `https://linkedin.com/${namespace}/${handle.toLowerCase()}`;
    }

    if (host === "x.com" || host === "twitter.com") {
      const handle = parts[0]?.replace(/^@/, "");
      if (handle) return `https://x.com/${handle.toLowerCase()}`;
    }

    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      const handle = parts[0]?.replace(/^@/, "");
      if (handle) return `https://instagram.com/${handle.toLowerCase()}`;
    }

    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      const handle = parts[0]?.replace(/^@/, "");
      if (handle) return `https://tiktok.com/@${handle.toLowerCase()}`;
    }

    if (host === "bsky.app") {
      const handle = parts[0]?.toLowerCase() === "profile" ? parts[1] : null;
      if (handle) return `https://bsky.app/profile/${handle.toLowerCase()}`;
    }

    if (host === "youtube.com") {
      if (parts[0]?.startsWith("@")) {
        const handle = parts[0].slice(1);
        if (handle) return `https://youtube.com/@${handle.toLowerCase()}`;
      }
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      if (namespace && handle && ["channel", "c", "user"].includes(namespace)) {
        return `https://youtube.com/${namespace}/${handle.toLowerCase()}`;
      }
    }

    if (host === "reddit.com" || host.endsWith(".reddit.com")) {
      const namespace = parts[0]?.toLowerCase();
      const handle = ["r", "u", "user"].includes(namespace ?? "") ? parts[1] : parts[0];
      const pathNamespace = ["r", "u", "user"].includes(namespace ?? "") ? namespace : "user";
      if (handle) return `https://reddit.com/${pathNamespace}/${handle.toLowerCase()}`;
    }

    if (host === "producthunt.com") {
      if (parts[0]?.startsWith("@")) {
        const handle = parts[0].slice(1);
        if (handle) return `https://producthunt.com/@${handle.toLowerCase()}`;
      }
      const namespace = parts[0]?.toLowerCase();
      const handle = parts[1];
      if (namespace && handle && ["products", "posts"].includes(namespace)) {
        return `https://producthunt.com/${namespace}/${handle.toLowerCase()}`;
      }
    }

    url.pathname = `/${parts.join("/")}`.replace(/\/$/, "");
    return url.toString();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function urlMatchesPlatform(url: string, platform: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (platform === "x") return host === "x.com" || host === "twitter.com";
    if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
    if (platform === "github") return host === "github.com";
    if (platform === "instagram") return host === "instagram.com";
    if (platform === "tiktok") return host === "tiktok.com" || host === "m.tiktok.com";
    if (platform === "bluesky") return host === "bsky.app";
    if (platform === "youtube") return host === "youtube.com";
    if (platform === "reddit") return host === "reddit.com" || host.endsWith(".reddit.com");
    if (platform === "product_hunt") return host === "producthunt.com";
    return true;
  } catch {
    return false;
  }
}

function primaryIndustry(raw: RawCompany): string {
  const value = raw.industry || raw.industries[0] || "B2B";
  return value.toLowerCase();
}

function businessModel(raw: RawCompany): BusinessModel {
  const text = [...raw.industries, raw.industry, raw.subindustry, ...raw.tags, raw.tagline, raw.description]
    .join(" ")
    .toLowerCase();

  if (text.includes("github") || text.includes("open source")) return "open_source";
  if (text.includes("marketplace")) return "marketplace";
  if (text.includes("api")) return "api";
  if (text.includes("developer") || text.includes("infrastructure") || text.includes("devtool")) {
    return "developer_tools";
  }
  if (text.includes("hardware") || text.includes("robot") || text.includes("device") || text.includes("sensor")) {
    return "hardware";
  }
  if (text.includes("fintech") || text.includes("payment") || text.includes("bank")) return "fintech";
  if (text.includes("healthcare") || text.includes("medical") || text.includes("diagnostic")) return "healthcare";
  if (text.includes("industrial") || text.includes("manufacturing") || text.includes("defense")) return "industrial";
  if (text.includes("consumer")) return "consumer";
  if (text.includes("agency") || text.includes("service")) return "services";
  return "b2b";
}

function industryTags(raw: RawCompany): string[] {
  const subindustryParts = raw.subindustry
    .split("->")
    .map((part) => part.trim())
    .filter(Boolean);
  const values = [raw.industry, ...raw.industries, ...subindustryParts, ...raw.tags]
    .map((value) => value.toLowerCase().trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function buildCompanyIdByEntityId(companies: RawCompany[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const company of companies) {
    const companyIdValue = companyId(company);
    result.set(companyIdValue, companyIdValue);
    for (const founder of company.founders ?? []) {
      result.set(founderId(company, founder), companyIdValue);
    }
    for (const founder of manualFounderOverrides(company)) {
      result.set(manualFounderId(company, founder), companyIdValue);
    }
  }
  return result;
}

function companyId(raw: RawCompany): string {
  return `company-${raw.slug}`;
}

function attachedCompanyIdForGithub(account: GithubAccount): string {
  if (account.entityType === "company") {
    return account.entityId;
  }

  return account.companySlug ? `company-${account.companySlug}` : companyIdFromEvidenceName(account.companyName);
}

function companyIdFromEvidenceName(companyName: string): string {
  const matchingCompany = snapshot.companies.find((company) => company.name === companyName);
  return matchingCompany ? companyId(matchingCompany) : `company-${slugify(companyName)}`;
}

function founderId(company: RawCompany, founder: RawFounder): string {
  return `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function handleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeUrlPathSegment(part));
    let identity: string | undefined;

    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      const markerIndex = parts.findIndex((part) => ["company", "in"].includes(part.toLowerCase()));
      identity = markerIndex >= 0 ? parts[markerIndex + 1] : undefined;
    } else if (host === "github.com" && parts[0]?.toLowerCase() === "orgs") {
      identity = parts[1];
    } else {
      identity = parts.at(-1);
    }

    const handle = identity?.replace(/^@/, "").trim();
    if (
      !handle ||
      !/^[A-Za-z0-9._-]+$/.test(handle) ||
      GENERIC_SOCIAL_IDENTITIES.has(handle.toLowerCase())
    ) {
      return null;
    }

    return handle;
  } catch {
    return null;
  }
}

function decodeUrlPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function domainToken(rawUrl: string): string | null {
  try {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, "");
    return hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

function containsSearchTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^| )${escaped}($| )`).test(haystack);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
