import ycSummer2026Snapshot from "@/lib/yc/summer-2026-companies.json";
import ycSpring2026Snapshot from "@/lib/yc/spring-2026-companies.json";
import githubTractionSnapshot from "@/lib/social/github-traction-summer-2026.json";
import springGithubTractionSnapshot from "@/lib/social/github-traction.json";
import publicEvidenceSnapshot from "@/lib/social/public-evidence-current.json";
import loggedInEvidenceSnapshot from "@/lib/social/logged-in-evidence-current.json";
import targetedEvidenceSnapshot from "@/lib/social/targeted-evidence-current.json";
import verifiedSocialOverridesJson from "@/lib/social/verified-social-overrides.json";
import { a16zSpeedrun006GraphDataset } from "./a16z-speedrun-006-dataset";
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
  normalizeEvidenceScores
} from "./traction-scoring";
import { dedupeEvidenceItems } from "./dedupe";
import { enrichEvidenceThumbnail } from "./evidence-thumbnails";
import {
  applyAttributionGuard,
  buildAttributionContext,
  type AttributionCompanyProfile,
  type AttributionSocialLink
} from "./evidence-attribution";
import { isKnownTopVoiceAccountUrl } from "@/lib/social/top-voices";

interface RawSnapshot {
  source: {
    directoryUrl: string;
    fetchedAt: string;
    expectedCompanyCount: number;
    observedCompanyCount: number;
  };
  companies: RawCompany[];
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

type RawSocialLinks = Partial<Record<"github" | "linkedin" | "x" | "instagram", string>>;

interface VerifiedFounderOverride {
  id: string;
  name: string;
  ycProfileUrl?: string | null;
  sourceUrl: string;
  socialLinks: RawSocialLinks;
  matchReason: string;
}

interface VerifiedSocialOverride {
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
  name: string;
  fullName: string;
  description: string;
  htmlUrl: string;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  language: string | null;
  pushedAt: string;
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
  entityType: "company" | "founder";
  entityId: string;
  companyName: string;
  platform: Platform;
  title: string;
  sourceUrl: string;
  platformPostId?: string | null;
  text: string;
  thumbnailUrl?: string | null;
  thumbnailSource?: string | null;
  mediaUrl?: string | null;
  mediaUrls?: string[];
  media_urls?: string[];
  media_posters?: string[];
  linkStatus?: "verified" | "invalid" | "unchecked" | "blocked" | null;
  linkCheckedAt?: string | null;
  linkFailureReason?: string | null;
  rawVisibleText: string;
  postedAt: string | null;
  metrics: EvidenceMetrics;
  contributionScore: number;
  review_state: "verified" | "needs_review" | "rejected";
  matchReason: string;
  first_seen_at: string;
  last_checked_at: string;
  last_updated_at: string;
}

interface PublicNeedsReviewRecord {
  id: string;
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

const snapshot = ycSummer2026Snapshot as RawSnapshot;
const springSnapshot = ycSpring2026Snapshot as RawSnapshot;
const githubSnapshot = githubTractionSnapshot as GithubSnapshot;
const springGithubSnapshot = springGithubTractionSnapshot as GithubSnapshot;
const publicSnapshot = publicEvidenceSnapshot as PublicEvidenceSnapshot;
const loggedInSnapshot = loggedInEvidenceSnapshot as PublicEvidenceSnapshot;
const targetedSnapshot = targetedEvidenceSnapshot as PublicEvidenceSnapshot;
const verifiedSocialOverrides = verifiedSocialOverridesJson as Record<string, VerifiedSocialOverride>;
const attributionContext = buildAttributionContext(snapshot.companies.map(attributionCompanyProfile));
const knownCompanyIds = new Set(snapshot.companies.map(companyId));
const knownFounderIds = new Set(snapshot.companies.flatMap((company) => [
  ...company.founders.map((founder) => founderId(company, founder)),
  ...manualFounderOverrides(company).map((founder) => manualFounderId(company, founder))
]));
const knownEntityIds = new Set([...knownCompanyIds, ...knownFounderIds]);
const officialGithubUrlsByEntityId = new Map(
  snapshot.companies.flatMap((company) => [
    company.socialLinks.github ? [companyId(company), canonicalAccountUrl(company.socialLinks.github)] : null,
    ...company.founders.map((founder) =>
      founder.socialLinks.github ? [founderId(company, founder), canonicalAccountUrl(founder.socialLinks.github)] : null
    )
  ].filter((entry): entry is [string, string] => Boolean(entry)))
);
const allowedLoggedInPlatforms = new Set(["instagram", "x", "linkedin"]);
const allowedLoggedInEvidence = loggedInSnapshot.evidence.filter((item) =>
  allowedLoggedInPlatforms.has(item.platform)
);
const allowedLoggedInNeedsReview = loggedInSnapshot.needsReview.filter((item) =>
  allowedLoggedInPlatforms.has(item.platform)
);
const rawPublicEvidenceItems = [...publicSnapshot.evidence, ...allowedLoggedInEvidence, ...targetedSnapshot.evidence]
  .filter((item) => item.review_state === "verified")
  .filter(isKnownSummerEvidenceRecord)
  .filter(isAcceptedPublicEvidence)
  .map(publicEvidenceItem)
  .map((item) => applyAttributionGuard(item, attributionContext));
const rawGithubEvidenceItems = githubSnapshot.accounts
  .filter(isKnownSummerGithubAccount)
  .flatMap(githubEvidence)
  .map((item) => applyAttributionGuard(item, attributionContext));
const allEvidenceItems = normalizeEvidenceScores(dedupeEvidenceItems([...rawGithubEvidenceItems, ...rawPublicEvidenceItems]));
const officialSocialLinkCounts = countOfficialSocialLinks(snapshot.companies);
const summerEvidenceCounts = countEvidenceByPlatform(allEvidenceItems);
const evidenceByEntityId = groupEvidenceByEntity(allEvidenceItems);
const publicNeedsReviewItems = [
  ...publicSnapshot.needsReview,
  ...allowedLoggedInNeedsReview,
  ...targetedSnapshot.needsReview
].filter(isKnownSummerNeedsReviewRecord).map(publicNeedsReviewItem);
const companyRecords = calibrateCompanyScores(snapshot.companies.map(companyRecord));
const founderRecordList = snapshot.companies.flatMap(founderRecords);

export const ycSummer2026GraphDataset: DemoGraphDataset = {
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
      status: "disabled",
      authMethod: "Not counted",
      notes: "YC/web metadata is used only for names and official links. It contributes 0 traction score."
    },
    {
      platform: "github",
      status: rawGithubEvidenceItems.length > 0 ? "working" : "needs_config",
      authMethod: "Read-only public GitHub API",
      notes: `Measured ${rawGithubEvidenceItems.length} Summer 2026 GitHub evidence rows from public API data. Old Spring 2026 account snapshots are ignored unless the account matches a Summer company or founder official YC link.`
    },
    {
      platform: "x",
      status: "public_only",
      authMethod: "Official YC profile links and verified public evidence only",
      notes: `Found ${officialSocialLinkCounts.x.company} company and ${officialSocialLinkCounts.x.founder} founder X URLs on official Summer 2026 YC profiles, but ${summerEvidenceCounts.x ?? 0} scored Summer X post rows are currently available. Anonymous public reads were blocked, and Spring/P26 evidence is filtered out.`
    },
    {
      platform: "linkedin",
      status: summerEvidenceCounts.linkedin ? "working" : "public_only",
      authMethod: "Opt-in authenticated browser session plus public profile discovery",
      notes: `Found ${officialSocialLinkCounts.linkedin.company} company and ${officialSocialLinkCounts.linkedin.founder} founder LinkedIn URLs on official Summer 2026 YC profiles. ${summerEvidenceCounts.linkedin ?? 0} scored Summer LinkedIn post rows are currently available; prior Spring rows remain excluded.`
    },
    {
      platform: "instagram",
      status: "public_only",
      authMethod: "Official YC profile links and verified public evidence only",
      notes:
        `Found ${officialSocialLinkCounts.instagram.company} company and ${officialSocialLinkCounts.instagram.founder} founder Instagram URLs on official Summer 2026 YC profiles, so Instagram needs discovery/verified overrides before posts can be fetched. Spring demo/profile snapshots are filtered out.`
    },
    {
      platform: "rss",
      status: "working",
      authMethod: "Public feed fetch",
      notes: "Public RSS/Atom feeds are discovered from company websites and fetched read-only."
    },
    {
      platform: "youtube",
      status: "working",
      authMethod: "Public YouTube search/metadata pages",
      notes: `Public YouTube results are attempted without login. ${summerEvidenceCounts.youtube ?? 0} verified Summer 2026 YouTube row currently scores.`
    },
    {
      platform: "product_hunt",
      status: "public_only",
      authMethod: "Public Product Hunt pages/search through Reader fallback",
      notes: "Product Hunt is attempted publicly. Unclear matches are sent to needs_review; blocks are logged."
    },
    {
      platform: "reddit",
      status: "public_only",
      authMethod: "Unauthenticated public Reddit pages/JSON where accessible",
      notes: "Reddit often blocks unauthenticated scraping from this network; failures are logged per company."
    },
    {
      platform: "hacker_news",
      status: "working",
      authMethod: "Public Hacker News Algolia API",
      notes: "HN stories are matched conservatively and scored with public points/comments."
    },
    {
      platform: "bilibili",
      status: "needs_config",
      authMethod: "Public search and explicit subtitle setup",
      notes: "Not used by the YC snapshot unless a public Bilibili URL is discovered."
    }
  ]
};

const springDataset = buildSpring2026GraphDataset();

export const yc2026GraphDataset: DemoGraphDataset = {
  mode: "official_snapshot",
  batches: [
    ...springDataset.batches,
    ...ycSummer2026GraphDataset.batches,
    ...a16zSpeedrun006GraphDataset.batches
  ],
  companies: [
    ...ycSummer2026GraphDataset.companies,
    ...springDataset.companies,
    ...a16zSpeedrun006GraphDataset.companies
  ],
  founders: [
    ...ycSummer2026GraphDataset.founders,
    ...springDataset.founders,
    ...a16zSpeedrun006GraphDataset.founders
  ],
  evidence: [
    ...ycSummer2026GraphDataset.evidence,
    ...springDataset.evidence,
    ...a16zSpeedrun006GraphDataset.evidence
  ],
  needsReview: [
    ...(ycSummer2026GraphDataset.needsReview ?? []),
    ...(springDataset.needsReview ?? []),
    ...(a16zSpeedrun006GraphDataset.needsReview ?? [])
  ],
  platformStatus: [
    ...ycSummer2026GraphDataset.platformStatus,
    ...a16zSpeedrun006GraphDataset.platformStatus
  ]
};

export const ycSpring2026GraphDataset = yc2026GraphDataset;

function buildSpring2026GraphDataset(): DemoGraphDataset {
  const springAttributionContext = buildAttributionContext(springSnapshot.companies.map(attributionCompanyProfile));
  const springKnownCompanyIds = new Set(springSnapshot.companies.map(companyId));
  const springKnownFounderIds = new Set(springSnapshot.companies.flatMap((company) => [
    ...company.founders.map((founder) => founderId(company, founder)),
    ...manualFounderOverrides(company).map((founder) => manualFounderId(company, founder))
  ]));
  const springKnownEntityIds = new Set([...springKnownCompanyIds, ...springKnownFounderIds]);
  const springPublicEvidenceItems = [...publicSnapshot.evidence, ...allowedLoggedInEvidence, ...targetedSnapshot.evidence]
    .filter((item) => item.review_state === "verified")
    .filter((item) => springKnownEntityIds.has(item.entityId))
    .filter((item) => !hasSummerBatchContext(evidenceBatchText(item)))
    .filter((item) => springPublicEvidenceAccepted(item))
    .map(publicEvidenceItem)
    .map((item) => applyAttributionGuard(item, springAttributionContext));
  const springGithubEvidenceItems = springGithubSnapshot.accounts
    .filter((account) => springKnownEntityIds.has(account.entityId))
    .flatMap((account) => githubEvidenceForSnapshot(account, springGithubSnapshot))
    .map((item) => applyAttributionGuard(item, springAttributionContext));
  const springEvidenceItems = normalizeEvidenceScores(
    dedupeEvidenceItems([...springGithubEvidenceItems, ...springPublicEvidenceItems])
  );
  const springEvidenceByEntityId = groupEvidenceByEntity(springEvidenceItems);
  const springCompanies = calibrateCompanyScores(
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
  const springNeedsReviewItems = [
    ...publicSnapshot.needsReview,
    ...allowedLoggedInNeedsReview,
    ...targetedSnapshot.needsReview
  ]
    .filter((item) => springKnownEntityIds.has(item.entityId))
    .filter((item) => !hasSummerBatchContext(`${item.entityName} ${item.matchReason}`))
    .map(publicNeedsReviewItem);

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
    platformStatus: ycSummer2026GraphDataset.platformStatus
  };
}

function countOfficialSocialLinks(companies: RawCompany[]) {
  const result: Record<keyof RawSocialLinks, { company: number; founder: number }> = {
    github: { company: 0, founder: 0 },
    linkedin: { company: 0, founder: 0 },
    x: { company: 0, founder: 0 },
    instagram: { company: 0, founder: 0 }
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

function countEvidenceByPlatform(items: EvidenceItem[]): Partial<Record<Platform, number>> {
  const result: Partial<Record<Platform, number>> = {};
  for (const item of items) {
    result[item.platform] = (result[item.platform] ?? 0) + 1;
  }
  return result;
}

function springPublicEvidenceAccepted(item: PublicEvidenceRecord): boolean {
  if (item.linkStatus === "invalid") {
    return false;
  }

  if (item.platform !== "hacker_news") {
    return true;
  }

  return hasSpringBatchContext(evidenceBatchText(item));
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
  const entityIds = [
    companyId(raw),
    ...raw.founders.map((founder) => founderId(raw, founder)),
    ...manualFounders.map((founder) => manualFounderId(raw, founder))
  ];
  const entityEvidence = entityIds.flatMap((entityId) => options.evidenceByEntityId.get(entityId) ?? []);
  const scoreBreakdown = aggregateBalancedTractionScore(entityEvidence);
  const socialAccounts = dedupeSocialAccounts([
    ...socialAccountsFor(raw.socialLinks, {
      entityPrefix: `company-${raw.slug}`,
      discoveredFromUrl: raw.ycProfileUrl,
      matchReason: "Linked from the official public YC company profile."
    }),
    ...socialAccountsFor(verifiedSocialOverrides[raw.slug]?.companySocialLinks ?? {}, {
      entityPrefix: `company-${raw.slug}-verified-override`,
      discoveredFromUrl: raw.websiteUrl ?? raw.ycProfileUrl,
      matchReason: `Verified social override for ${raw.name}; profile links back to the official company identity.`
    })
  ]);

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

function calibrateCompanyScores(companies: CompanyRecord[]): CompanyRecord[] {
  const rows = companies.map((company) => {
    const confidenceFactor = evidenceDepthConfidenceFactor(company);
    const confidenceAdjustedScore = company.totalScore * confidenceFactor;

    return {
      company,
      confidenceFactor,
      confidenceAdjustedScore
    };
  });
  const positiveScores = rows.map((row) => row.confidenceAdjustedScore).filter((score) => score > 0);
  const min = Math.min(...positiveScores);
  const max = Math.max(...positiveScores);

  if (!positiveScores.length || min === max) {
    return companies;
  }

  return rows.map(({ company, confidenceFactor, confidenceAdjustedScore }) => {
    const spreadScore =
      confidenceAdjustedScore <= 0
        ? 0
        : Math.round(Math.pow((confidenceAdjustedScore - min) / (max - min), 1.18) * 100);
    const scoredEvidenceCount = scoredEvidenceCountFor(company);
    const calibratedScore = confidenceAdjustedScore <= 0 ? 0 : Math.round(spreadScore * confidenceFactor);

    return {
      ...company,
      totalScore: calibratedScore,
      previousScore: calibratedScore,
      scoreBreakdown: company.scoreBreakdown
        ? {
            ...company.scoreBreakdown,
            totalScore: calibratedScore,
            explanation: `${company.scoreBreakdown.explanation} Evidence-depth factor ${round(
              confidenceFactor,
              3
            )} from ${scoredEvidenceCount} scored rows. Batch calibration expands peer-relative traction across the full range, then applies the evidence-depth adjustment to ${calibratedScore}/100.`
          }
        : company.scoreBreakdown
    };
  });
}

function evidenceDepthConfidenceFactor(company: CompanyRecord): number {
  const scoredEvidenceCount = scoredEvidenceCountFor(company);
  if (scoredEvidenceCount <= 0) {
    return 0;
  }

  const depth = Math.min(1, Math.sqrt(scoredEvidenceCount / 5));
  return 0.72 + 0.28 * depth;
}

function scoredEvidenceCountFor(company: CompanyRecord): number {
  return company.scoreBreakdown?.weightedPlatforms.reduce((sum, platform) => sum + platform.evidenceCount, 0) ?? 0;
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
    const scoreBreakdown = aggregateBalancedTractionScore(entityEvidence);
    const socialAccounts = socialAccountsFor(founder.socialLinks, {
      entityPrefix: `founder-${raw.slug}-${founder.id}`,
      discoveredFromUrl: raw.ycProfileUrl,
      matchReason: "Linked from the founder block on the official public YC company profile."
    });

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
    const scoreBreakdown = aggregateBalancedTractionScore(entityEvidence);
    const socialAccounts = socialAccountsFor(founder.socialLinks, {
      entityPrefix: `founder-${raw.slug}-${founder.id}`,
      discoveredFromUrl: founder.sourceUrl,
      matchReason: founder.matchReason
    });

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
  const socialAccountId = `github:${account.entityId}:${account.login}`;
  const matchReason = account.matchReason ?? "GitHub account verified from a YC-linked or official company source.";
  const repoItems: EvidenceItem[] = (account.repos ?? []).map((repo) => ({
    id: `evidence-github-repo-${account.entityId}-${slugify(repo.fullName)}`,
    entityType: account.entityType,
    entityId: account.entityId,
    platform: "github" as const,
    authorName: repo.fullName,
    authorHandle: account.login,
    postedAt: repo.pushedAt ?? sourceSnapshot.source.fetchedAt,
    text: `${repo.fullName}: ${repo.description || "GitHub repository"}${repo.language ? ` (${repo.language})` : ""}.`,
    mediaType: "repo" as const,
    metrics: {
      stars: repo.stars,
      forks: repo.forks,
      watchers: repo.watchers,
      issues: repo.openIssues,
      recent_commits_30d: isRecentGithubPushForSnapshot(repo.pushedAt, sourceSnapshot.source.fetchedAt) ? 1 : 0
    },
    contributionScore: repo.score,
    sourceUrl: repo.htmlUrl,
    first_seen_at: sourceSnapshot.source.fetchedAt,
    last_checked_at: sourceSnapshot.source.fetchedAt,
    last_updated_at: repo.pushedAt ?? sourceSnapshot.source.fetchedAt,
    why: "Repository traction measured from public GitHub stars, forks, watchers, open issues, and recent push activity.",
    attachedCompanyId: attachedCompanyIdForGithub(account),
    attachedCompanyName: account.companyName,
    socialAccountId,
    accountUrl,
    matchReason,
    review_state: "verified" as const
  }));
  const hasRepoLevelEvidence = repoItems.length > 0;

  const profile: EvidenceItem = {
    id: `evidence-github-profile-${account.entityId}`,
    entityType: account.entityType,
    entityId: account.entityId,
    platform: "github",
    authorName: account.name,
    authorHandle: account.login,
    postedAt: sourceSnapshot.source.fetchedAt,
    text: `${account.name} GitHub profile: ${account.aggregate.totalStars} stars, ${account.aggregate.totalForks} forks, ${account.aggregate.repoCount} public repositories tracked from the YC-linked GitHub account.`,
    mediaType: "repo",
    metrics: {
      stars: account.aggregate.totalStars,
      forks: account.aggregate.totalForks,
      watchers: account.aggregate.totalWatchers,
      recent_commits_30d: recentGithubRepoCountForSnapshot(account.repos ?? [], sourceSnapshot.source.fetchedAt)
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
    socialAccountId,
    accountUrl,
    matchReason,
    review_state: "verified"
  };

  return [profile, ...repoItems]
    .map(enrichEvidenceThumbnail)
    .sort((a, b) => b.contributionScore - a.contributionScore)
    .slice(0, 20);
}

function recentGithubRepoCount(repos: GithubRepo[]): number {
  return recentGithubRepoCountForSnapshot(repos, githubSnapshot.source.fetchedAt);
}

function isRecentGithubPush(pushedAt: string | null | undefined): boolean {
  return isRecentGithubPushForSnapshot(pushedAt, githubSnapshot.source.fetchedAt);
}

function recentGithubRepoCountForSnapshot(repos: GithubRepo[], checkedAt: string): number {
  return repos.filter((repo) => isRecentGithubPushForSnapshot(repo.pushedAt, checkedAt)).length;
}

function isRecentGithubPushForSnapshot(pushedAt: string | null | undefined, checkedAt: string): boolean {
  const pushed = parseDate(pushedAt);
  const checked = parseDate(checkedAt) ?? new Date();

  if (!pushed) {
    return false;
  }

  const ageDays = Math.max(0, (checked.getTime() - pushed.getTime()) / 86_400_000);
  return ageDays <= 30;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function publicEvidenceItem(item: PublicEvidenceRecord): EvidenceItem {
  const isRetweet = item.platform === "x" && /"is_retweet"\s*:\s*true/i.test(item.rawVisibleText ?? "");
  const isProfileContext = isProfileOnlySocialEvidence(item);
  const contributionScore =
    item.platform === "web" || item.platform === "rss" || isRetweet || isProfileContext ? 0 : item.contributionScore;
  const socialAccountId = `${item.platform}:${item.entityType}:${item.entityId}`;
  const mediaUrls = [
    ...(item.mediaUrls ?? []),
    ...(item.media_posters ?? []),
    ...(item.media_urls ?? [])
  ].filter(Boolean);

  return enrichEvidenceThumbnail({
    id: item.id,
    entityType: item.entityType,
    entityId: item.entityId,
    platform: item.platform,
    authorName: item.title || item.companyName,
    authorHandle: null,
    postedAt: item.postedAt ?? item.last_updated_at ?? publicSnapshot.source.fetchedAt,
    title: item.title,
    text: item.text || item.title,
    mediaType: mediaTypeForPlatform(item.platform),
    mediaUrl: item.mediaUrl ?? null,
    mediaUrls,
    thumbnailUrl: item.thumbnailUrl ?? null,
    thumbnailSource: item.thumbnailSource ?? null,
    linkStatus: item.linkStatus ?? null,
    linkCheckedAt: item.linkCheckedAt ?? null,
    linkFailureReason: item.linkFailureReason ?? null,
    metrics: item.metrics ?? {},
    contributionScore,
    sourceUrl: item.sourceUrl,
    platformPostId: item.platformPostId ?? platformPostIdFromUrl(item.platform, item.sourceUrl),
    rawVisibleText: item.rawVisibleText,
    first_seen_at: item.first_seen_at,
    last_checked_at: item.last_checked_at,
    last_updated_at: item.last_updated_at,
    why: isRetweet
      ? "Stored as context only. Retweets are not counted as original post traction."
      : isProfileContext
        ? "Stored as context only. Profile pages are not counted as post-level traction."
        : item.matchReason,
    attachedCompanyId: item.entityType === "company" ? item.entityId : companyIdFromEvidenceName(item.companyName),
    attachedCompanyName: item.companyName,
    socialAccountId,
    accountUrl: null,
    matchReason: item.matchReason,
    review_state: item.review_state
  });
}

function platformPostIdFromUrl(platform: Platform, rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/$/, "");

    if (platform === "x") {
      return path.match(/\/status\/(\d+)/i)?.[1] ?? null;
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
  if (!["linkedin", "x", "instagram"].includes(item.platform)) {
    return false;
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
      return !/\/feed\/update\/|\/posts\/|\/recent-activity\/all\/#post-/.test(pathAndHash);
    }
  } catch {
    return true;
  }

  return false;
}

function isKnownSummerEvidenceRecord(item: PublicEvidenceRecord): boolean {
  return knownEntityIds.has(item.entityId) && !hasStaleSpringBatchContext(evidenceBatchText(item));
}

function isKnownSummerNeedsReviewRecord(item: PublicNeedsReviewRecord): boolean {
  return knownEntityIds.has(item.entityId) && !hasStaleSpringBatchContext(`${item.entityName} ${item.matchReason}`);
}

function isKnownSummerGithubAccount(account: GithubAccount): boolean {
  const officialGithubUrl = officialGithubUrlsByEntityId.get(account.entityId);
  return Boolean(officialGithubUrl && canonicalAccountUrl(account.githubUrl) === officialGithubUrl);
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
  return /\b(?:Spring\s+2026|YC\s*S2026|YCS2026|S2026)\b/i.test(value);
}

function isAcceptedPublicEvidence(item: PublicEvidenceRecord): boolean {
  if (item.linkStatus === "invalid") {
    return false;
  }

  if (item.platform === "linkedin") {
    return (
      isLoggedInLinkedInActivityEvidence(item) ||
      linkedInPostAuthorMatchesKnownEntity(item) ||
      isKnownTopVoiceAccountUrl(item.platform, item.sourceUrl)
    );
  }

  if (item.platform !== "hacker_news") {
    return true;
  }

  return hasSummerBatchContext(evidenceBatchText(item));
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
  const authorHandle = linkedInAuthorHandleFromPostUrl(item.sourceUrl);
  if (!authorHandle) {
    return false;
  }

  const company =
    snapshot.companies.find((candidate) => companyId(candidate) === item.entityId || candidate.name === item.companyName) ??
    snapshot.companies.find((candidate) => companyId(candidate) === companyIdFromEvidenceName(item.companyName));
  if (!company) {
    return false;
  }

  const knownHandles = new Set<string>();
  const companyHandle = linkedInProfileHandle(company.socialLinks?.linkedin);
  if (companyHandle) knownHandles.add(companyHandle);
  for (const founder of company.founders ?? []) {
    const founderHandle = linkedInProfileHandle(founder.socialLinks?.linkedin);
    if (founderHandle) knownHandles.add(founderHandle);
  }

  return knownHandles.has(authorHandle);
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
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((part) => ["in", "company"].includes(part.toLowerCase()));
    if (markerIndex >= 0 && parts[markerIndex + 1]) {
      return normalizeHandle(parts[markerIndex + 1]);
    }
  } catch {
    return null;
  }

  return null;
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
      ...attributionSocialLinks(verifiedSocialOverrides[raw.slug]?.companySocialLinks ?? {})
    ],
    founders: [
      ...raw.founders.map((founder) => ({
        id: founderId(raw, founder),
        name: founder.name,
        socialLinks: attributionSocialLinks(founder.socialLinks)
      })),
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
    .map(([platform, url]) => ({ platform, url }));
}

function groupEvidenceByEntity(items: EvidenceItem[]): Map<string, EvidenceItem[]> {
  const grouped = new Map<string, EvidenceItem[]>();
  for (const item of items) {
    grouped.set(item.entityId, [...(grouped.get(item.entityId) ?? []), item]);
  }
  return grouped;
}

function mediaTypeForPlatform(platform: Platform): EvidenceItem["mediaType"] {
  if (platform === "github") return "repo";
  if (platform === "youtube") return "video";
  if (platform === "product_hunt") return "launch";
  return "link";
}

function socialAccountsFor(
  links: RawSocialLinks,
  options: { entityPrefix: string; discoveredFromUrl: string; matchReason: string }
): SocialAccountSummary[] {
  return (Object.entries(links) as [keyof RawSocialLinks, string][])
    .filter(([, url]) => Boolean(url))
    .filter(([platform, url]) => urlMatchesPlatform(url, platform))
    .map(([platform, url]) => ({
      id: `acct-${options.entityPrefix}-${platform}`,
      platform,
      handle: handleFromUrl(url),
      url,
      review_state: "verified",
      discoveredFromUrl: options.discoveredFromUrl,
      matchReason: options.matchReason
    }));
}

function manualFounderOverrides(raw: RawCompany): VerifiedFounderOverride[] {
  return verifiedSocialOverrides[raw.slug]?.founders ?? [];
}

function manualFounderId(company: RawCompany, founder: VerifiedFounderOverride): string {
  return `founder-${company.slug}-${slugify(founder.name)}-${founder.id}`;
}

function dedupeSocialAccounts(accounts: SocialAccountSummary[]): SocialAccountSummary[] {
  return [
    ...new Map(
      accounts.map((account) => [
        `${account.platform}:${canonicalAccountUrl(account.url)}`,
        account
      ])
    ).values()
  ];
}

function canonicalAccountUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && parts[0]?.toLowerCase() === "orgs" && parts[1]) {
      url.pathname = `/${parts.slice(1).join("/")}`;
    } else {
      url.pathname = url.pathname.replace(/\/$/, "");
    }
    return url.toString().toLowerCase();
  } catch {
    return rawUrl.toLowerCase();
  }
}

function urlMatchesPlatform(url: string, platform: keyof RawSocialLinks): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (platform === "x") return host === "x.com" || host === "twitter.com";
    if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
    if (platform === "github") return host === "github.com";
    if (platform === "instagram") return host === "instagram.com";
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

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function handleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1]?.replace(/^@/, "") || parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
