import * as cheerio from "cheerio";
import dns from "node:dns";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Agent, request as undiciRequest } from "undici";
import {
  linkedinAccountSlugFromUrl,
  linkedinNativeAuthorSlugFromPayload,
  linkedinNativeAuthorSlugFromUrl,
  linkedinPostIdFromUrl
} from "./lib/social-native-identity.mjs";
import { readRequiredCanonicalJson } from "./lib/canonical-json.mjs";
import {
  readPublicEvidenceArtifact,
  writePublicEvidenceArtifactPairAtomic
} from "./lib/public-evidence-artifact.mjs";
import {
  extractLinkedInParentPostMetrics,
  isLinkedInPublicReaderPayload
} from "./lib/linkedin-parent-metrics.mjs";
import {
  extractLinkedInPublicPostReceipt,
  extractLinkedInPublicProfileSurface
} from "./lib/linkedin-public-jsonld.mjs";
import {
  instagramEvidenceMetrics,
  instagramNativeFeedRequest,
  instagramPublicProfileRequest,
  mergeInstagramNativeFeedPages,
  overlayInstagramNativeFeedMetrics,
  parseInstagramNativeFeedResponse,
  parseInstagramPublicProfileResponse
} from "./lib/instagram-public-profile.mjs";
import { extractXPublicProfileReceipt } from "./lib/x-public-profile-html.mjs";
import {
  assessPublicEvidenceAttribution,
  assessLinkedInPrimaryPostBody,
  containsExactTokenSequence,
  extractLinkedInPrimaryPostText,
  hasDistinctiveCatalogPhrase,
  isCollisionProneCompanyName,
  isListOrRoundupAttributionContext,
  organizationQualifiedBatchMarker,
  organizationQualifiedBatchMarkerCount,
  PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
  publicEvidenceAttributionText
} from "./lib/public-evidence-attribution.mjs";
import { dedupePublicNeedsReviewItems } from "./lib/public-review-dedupe.mjs";
import { preferUniqueSameCompanyFounder } from "./lib/native-owner-resolution.mjs";
import {
  canonicalSocialAccountUrl,
  retiredSocialAccountKey,
  socialAccountIdentityKey
} from "./lib/social-account-url.mjs";
import {
  extractEmbeddedYouTubeIds,
  extractProductHuntLinks,
  fetchRecentXPostsForTargets,
  searchExaSourceCandidates,
  xUsernameFromUrl
} from "./lib/credentialed-source-discovery.mjs";
import {
  AUTONOMOUS_PROCESS_BUDGETS,
  isAutonomousProviderBlocker,
  isAutonomousCollectorFailureRetryable,
  prioritizeAutonomousCompaniesByCoverage,
  resolveVerifiedCompanyOverride
} from "./lib/autonomous-ingestion-plan.mjs";
import {
  PublicSearchUnavailableError,
  createPublicSearchCircuit
} from "./lib/public-search-circuit.mjs";
import {
  createLinkedInPublicCircuit,
  linkedinPublicBlockerFromError
} from "./lib/linkedin-public-circuit.mjs";
import {
  collectHackerNewsRecentWindow,
  instagramRecentWindowObservation,
  persistRecentWindowProof
} from "./lib/recent-window-proof-instrumentation.mjs";
import {
  HISTORICAL_BACKFILL_LIMITS,
  matchesHnCompanyStory
} from "./lib/historical-backfill.mjs";
import {
  parseYouTubeFeed,
  parseYouTubePublicPage,
  youtubeChannelIdFromAccountUrl,
  youtubeFeedUrl
} from "./lib/historical-depth-sources.mjs";
import {
  completeAutonomousCollectorProvenance,
  readAutonomousCollectorLaunchProvenance
} from "./lib/autonomous-collector-provenance.mjs";
import { redactTokenLikeStrings } from "./lib/public-token-redaction.mjs";
import { validatedRepositoryDataRoot } from "./lib/validated-repository-data-root.mjs";

const root = validatedRepositoryDataRoot(
  stringArg("--catalog-root") ?? process.env.AUTONOMOUS_CATALOG_ROOT,
  { fallbackRoot: process.cwd(), label: "public collector catalog root" }
);
const autonomousLaunchProvenance = readAutonomousCollectorLaunchProvenance();
const batchConfig = resolveBatchConfig(stringArg("--batch") ?? stringArg("--batch-slug") ?? "S26");
const batchSnapshotPath = batchConfig.snapshotPath;
const outputPath = resolvePathArg(
  stringArg("--output") ?? join(root, "src", "lib", "social", "public-evidence-current.json")
);
const checkpointPath = resolvePathArg(
  stringArg("--checkpoint") ?? join(root, "work", `public-traction-checkpoint-${batchConfig.slug.toLowerCase()}.json`)
);
const recentProofJournalDir = stringArg("--recent-proof-journal-dir")
  ? resolvePathArg(stringArg("--recent-proof-journal-dir"))
  : null;
const now = new Date().toISOString();
const recentCoverageCutoff = optionalCanonicalTimestampArg(
  stringArg("--recent-coverage-cutoff"),
  "--recent-coverage-cutoff"
);
const companyLimit = numberArg("--max-companies") ?? Number.POSITIVE_INFINITY;
const companyFilter = stringArg("--company")?.toLowerCase();
const companyShardCount = Math.max(1, Math.floor(numberArg("--company-shard-count") ?? 1));
const companyShardIndex = Math.floor(numberArg("--company-shard-index") ?? 0);
if (companyShardIndex < 0 || companyShardIndex >= companyShardCount) {
  throw new Error(
    `--company-shard-index must be between 0 and ${companyShardCount - 1}; received ${companyShardIndex}.`
  );
}
const socialMode = stringArg("--social") ?? "company"; // company | all | none
const platformInput = stringArg("--platforms") ?? stringArg("--platform") ?? "";
const platformFilter = new Set(
  platformInput
    .split(",")
    .map((item) => normalizePlatformArg(item.trim()))
    .filter(Boolean)
);
const requestDelayMs = numberArg("--delay-ms") ?? 450;
const DEFAULT_PUBLIC_FETCH_TIMEOUT_MS = 20_000;
const publicFetchTimeoutMs = Math.max(
  25,
  Math.min(
    DEFAULT_PUBLIC_FETCH_TIMEOUT_MS,
    Math.floor(numberArg("--public-fetch-timeout-ms") ?? DEFAULT_PUBLIC_FETCH_TIMEOUT_MS)
  )
);
const PUBLIC_SEARCH_TIMEOUT_MS = 8_000;
const PUBLIC_SEARCH_MAX_ENCODED_BODY_BYTES = 2 * 1024 * 1024;
const PUBLIC_SEARCH_MAX_DECODED_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_REDIRECTS = 5;
const PUBLIC_DESTINATION_BLOCK_LIST = createPublicDestinationBlockList();
const PUBLIC_IPV6_GLOBAL_UNICAST_ALLOW_LIST = createPublicIpv6GlobalUnicastAllowList();
const MAX_PUBLIC_TASK_WORKERS = 16;
const workerCount = Math.max(
  1,
  Math.min(MAX_PUBLIC_TASK_WORKERS, Math.floor(numberArg("--workers") ?? 8))
);
const MAX_X_WORKERS = 8;
const xWorkerCount = Math.max(
  1,
  Math.min(MAX_X_WORKERS, Math.floor(numberArg("--x-workers") ?? 2))
);
const MAX_LINKEDIN_WORKERS = 4;
const linkedinWorkerCount = Math.max(
  1,
  Math.min(MAX_LINKEDIN_WORKERS, Math.floor(numberArg("--linkedin-workers") ?? 1))
);
const MAX_INSTAGRAM_WORKERS = 8;
const instagramWorkerCount = Math.max(
  1,
  Math.min(MAX_INSTAGRAM_WORKERS, Math.floor(numberArg("--instagram-workers") ?? 2))
);
const MAX_INSTAGRAM_NATIVE_FEED_PAGES = 50;
const MAX_INSTAGRAM_NATIVE_FEED_ITEMS = 500;
const instagramNativeFeedMaxPages = Math.max(
  1,
  Math.min(
    MAX_INSTAGRAM_NATIVE_FEED_PAGES,
    Math.floor(numberArg("--instagram-native-feed-max-pages") ?? MAX_INSTAGRAM_NATIVE_FEED_PAGES)
  )
);
const instagramNativeFeedMaxItems = Math.max(
  1,
  Math.min(
    MAX_INSTAGRAM_NATIVE_FEED_ITEMS,
    Math.floor(numberArg("--instagram-native-feed-max-items") ?? MAX_INSTAGRAM_NATIVE_FEED_ITEMS)
  )
);
const MAX_CHECKPOINT_EVERY = 500;
const checkpointEvery = Math.max(
  1,
  Math.min(
    MAX_CHECKPOINT_EVERY,
    Math.floor(numberArg("--checkpoint-every") ?? 25)
  )
);
const forceRefresh = hasArg("--force");
const prioritySeed = stringArg("--priority-seed") ?? now.slice(0, 10);
const freshForHours = Math.max(0, numberArg("--fresh-for-hours") ?? 12);
const mappedAccountsOnly = hasArg("--mapped-only");
const discoverMissingSocial =
  !mappedAccountsOnly &&
  (hasArg("--discover-missing-social") || platformFilter.size > 0);
const discoveryAttemptsPath = resolvePathArg(
  stringArg("--discovery-attempts") ??
    join(root, "outputs", `discovery-attempts-${batchConfig.slug.toLowerCase()}.json`)
);
const sourceDiscoveryPathsPath = resolvePathArg(
  stringArg("--source-discovery-paths") ??
    join(root, "outputs", `source-discovery-paths-${batchConfig.slug.toLowerCase()}.json`)
);
const verifiedSocialOverridesPath = join(root, "src", "lib", "social", "verified-social-overrides.json");
const canonicalPublicEvidencePath = join(root, "src", "lib", "social", "public-evidence-current.json");
const planOnly = hasArg("--plan");
const PUBLIC_ATTRIBUTION_VERSION = PUBLIC_EVIDENCE_ATTRIBUTION_VERSION;
const xBearerToken = cleanEnv(process.env.X_BEARER_TOKEN);
const exaApiKey = cleanEnv(process.env.EXA_API_KEY);
const publicSearchCircuit = createPublicSearchCircuit({
  // Search is a discovery fallback, so a short bounded probe is preferable to
  // multiplying a 20-second outage across every unmapped owner.
  transport: fetchPublicSearchBoundedTransport,
  timeoutMs: PUBLIC_SEARCH_TIMEOUT_MS,
  maxEncodedBodyBytes: PUBLIC_SEARCH_MAX_ENCODED_BODY_BYTES,
  maxDecodedBodyBytes: PUBLIC_SEARCH_MAX_DECODED_BODY_BYTES,
  failureThreshold: 2,
  cooldownMs: 15 * 60_000
});
const linkedinPublicCircuit = createLinkedInPublicCircuit({
  // Keep the lane anonymous and serial. The first probe gets enough time for a
  // healthy public response; a second degraded probe is shorter, then every
  // remaining mapped target receives the same exact cooldown blocker without
  // another network timeout.
  directTimeoutMs: 8_000,
  directDegradedTimeoutMs: 5_000,
  readerTimeoutMs: 10_000,
  readerDegradedTimeoutMs: 6_000,
  fetch: fetchLinkedInBoundedResponse,
  failureThreshold: 2,
  cooldownMs: 15 * 60_000
});

if (hasArg("--help") || hasArg("-h")) {
  await writeStdout(`${usage()}\n`);
  process.exit(0);
}
if (recentProofJournalDir && !recentCoverageCutoff) {
  throw new Error("--recent-proof-journal-dir requires --recent-coverage-cutoff.");
}
if (recentCoverageCutoff && recentCoverageCutoff > now) {
  throw new Error("--recent-coverage-cutoff cannot be later than collector startup.");
}

const verifiedSocialOverrides = await readRequiredCanonicalJson(
  verifiedSocialOverridesPath,
  "Verified social overrides"
);
const summerCompanyAliasLedger = await readRequiredCanonicalJson(
  join(root, "src", "lib", "yc", "summer-2026-company-aliases.json"),
  "YC Summer 2026 company alias ledger"
);
const normalizedBatchSnapshot = normalizeBatchSnapshot(
  JSON.parse(await readFile(batchSnapshotPath, "utf8")),
  batchConfig
);
const batchSnapshot = {
  ...normalizedBatchSnapshot,
  companies: mergeVerifiedSocialOverrides(normalizedBatchSnapshot.companies, verifiedSocialOverrides)
};
const currentGraph = await readJson(batchConfig.graphPath, { evidence: [] });
const companySlugByEntityId = new Map(
  batchSnapshot.companies.flatMap((company) => [
    [companyId(company), company.slug],
    ...(company.founders ?? []).map((founder) => [
      entityIdFor(company, founder, "founder"),
      company.slug
    ])
  ])
);
const canonicalCompanyCatalog = await loadCanonicalCompanyCatalog(batchSnapshot, batchConfig);
const currentBatchContext = batchContextFromSnapshot(batchSnapshot);
const currentCanonicalArtifact = outputPath === canonicalPublicEvidencePath
  ? await readPublicEvidenceArtifact(canonicalPublicEvidencePath, { rootDir: root })
  : null;
const currentOutput = currentCanonicalArtifact?.snapshot ??
  await readJson(outputPath, { evidence: [], needsReview: [], failures: [] });
const previousCanonicalArtifact = outputPath === canonicalPublicEvidencePath
  ? null
  : await readPublicEvidenceArtifact(canonicalPublicEvidencePath, { rootDir: root });
const previousMergedOutput = previousCanonicalArtifact?.snapshot ?? null;
const currentDiscoveryAttempts = await readJson(discoveryAttemptsPath, []);
const currentSourceDiscoveryPaths = await readJson(sourceDiscoveryPathsPath, []);
const checkpoint = await readJson(checkpointPath, {
  attempts: {},
  evidence: [],
  needsReview: [],
  failures: [],
  discoveryAttempts: [],
  sourceDiscoveryPaths: []
});
const attemptMap = new Map(
  [
    ...Object.entries(currentOutput.attempts ?? {})
      .filter(([, attempt]) => attempt?.batchSlug === batchConfig.slug)
      .map(([key, attempt]) => [
        attempt.attemptKey ?? stripStoredAttemptBatchPrefix(key, batchConfig.slug),
        attempt
      ]),
    ...Object.entries(checkpoint.attempts ?? {})
  ]
    .filter(([, attempt]) => !isObsoleteInternalFailure(attempt))
    .map(([key, attempt]) => [key, withAttemptBatchScope(attempt)])
);
const evidence = dedupeById([...(currentOutput.evidence ?? []), ...(checkpoint.evidence ?? [])]);
const needsReview = dedupeById([...(currentOutput.needsReview ?? []), ...(checkpoint.needsReview ?? [])]);
const failures = dedupeFailures([...(currentOutput.failures ?? []), ...(checkpoint.failures ?? [])]);
const discoveryAttempts = dedupeDiscoveryAttempts([
  ...batchScopedRows(previousMergedOutput?.discoveryAttempts, normalizedBatchSnapshot, batchConfig.slug),
  ...batchScopedRows(currentOutput.discoveryAttempts, normalizedBatchSnapshot, batchConfig.slug),
  ...(currentDiscoveryAttempts ?? []),
  ...(checkpoint.discoveryAttempts ?? [])
]);
const sourceDiscoveryPaths = dedupeById([
  ...batchScopedRows(previousMergedOutput?.sourceDiscoveryPaths, normalizedBatchSnapshot, batchConfig.slug),
  ...batchScopedRows(currentOutput.sourceDiscoveryPaths, normalizedBatchSnapshot, batchConfig.slug),
  ...(currentSourceDiscoveryPaths ?? []),
  ...(checkpoint.sourceDiscoveryPaths ?? [])
]);
const companyBySlug = new Map(canonicalCompanyCatalog.map((company) => [company.slug, company]));
const currentBatchNativeOwnerIndex = buildNativeOwnerIndex(batchSnapshot.companies);
const officialLaunchPageCache = new Map();
let exaFailureCount = 0;
let checkpointWriteChain = Promise.resolve();
let checkpointCompletionsSinceWrite = 0;
const platformCooldowns = new Map();
let redditPublicRunBlocker = null;
// Every lane retains its own conservative platform cap, while this shared
// process-wide guard prevents those lane pools from multiplying into an
// unbounded number of simultaneous collector tasks.
const publicTaskConcurrencyGuard = createConcurrencyGuard(workerCount);
const INGEST_METRIC_WEIGHTS = {
  github: { stars: 1.5, forks: 4, watchers: 2, issues: 0.5, open_issues: 0.5 },
  x: { views: 0.02, likes: 1, replies: 3, comments: 3, reposts: 4, shares: 4, quotes: 4 },
  linkedin: { views: 0.02, likes: 1, reactions: 1, comments: 3, reposts: 4, shares: 4 },
  instagram: { views: 0.02, likes: 1, comments: 3, shares: 4, reposts: 4, saves: 4 },
  product_hunt: { upvotes: 2, comments: 3 },
  youtube: { views: 0.02, likes: 1, comments: 3 },
  hacker_news: { upvotes: 2, comments: 3 },
  reddit: { upvotes: 2, comments: 3 },
  bilibili: { views: 0.02, likes: 1, comments: 3, shares: 4 }
};
const COMMON_DESCRIPTOR_TOKENS = new Set([
  "about",
  "after",
  "again",
  "agent",
  "agents",
  "based",
  "build",
  "building",
  "company",
  "customer",
  "customers",
  "data",
  "every",
  "founder",
  "founders",
  "helps",
  "platform",
  "product",
  "software",
  "startup",
  "their",
  "through",
  "using",
  "where",
  "which",
  "with",
  "world"
]);
const ATTRIBUTION_DESCRIPTOR_STOP_WORDS = new Set([
  "about", "agent", "agents", "and", "are", "build", "building", "built", "companies",
  "company", "for", "from", "into", "its", "our", "platform", "product", "products",
  "that", "the", "their", "they", "this", "through", "using", "with", "your"
]);
const DISCOVERABLE_SOCIAL_PLATFORMS = Object.freeze(["x", "linkedin", "instagram"]);
const PUBLIC_COLLECTION_PLATFORMS = Object.freeze([
  "x",
  "linkedin",
  "instagram",
  "product_hunt",
  "youtube",
  "web",
  "rss",
  "hacker_news",
  "reddit"
]);
const MAPPED_ACCOUNT_PLATFORMS = Object.freeze([
  ...DISCOVERABLE_SOCIAL_PLATFORMS,
  "youtube",
  "product_hunt",
  "reddit",
  "hacker_news",
  "rss",
  "web"
]);
const COMPANY_SCOPED_ACCOUNT_UNSUPPORTED_PLATFORMS = new Set([
  "reddit",
  "hacker_news",
  "rss",
  "web"
]);

function attemptedPlatformsForRun() {
  return platformFilter.size > 0
    ? PUBLIC_COLLECTION_PLATFORMS.filter((platform) => platformFilter.has(platform))
    : [...PUBLIC_COLLECTION_PLATFORMS];
}

function usage() {
  return [
    "Usage: node scripts/fetch-public-traction.mjs [options]",
    "",
    "Options:",
    "  --batch=S26|S2026|A16ZSR006",
    "  --platforms=x,linkedin,instagram,product_hunt,youtube,web,rss,hacker_news,reddit",
    "  --social=company|all|none",
    "  --company=NAME_OR_SLUG",
    "  --max-companies=N",
    "  --company-shard-count=N",
    "  --company-shard-index=N",
    `  --workers=N              Global task cap (1-${MAX_PUBLIC_TASK_WORKERS})`,
    `  --x-workers=N            X lane cap (1-${MAX_X_WORKERS})`,
    `  --linkedin-workers=N     LinkedIn lane cap (1-${MAX_LINKEDIN_WORKERS})`,
    `  --instagram-workers=N    Instagram lane cap (1-${MAX_INSTAGRAM_WORKERS})`,
    `  --instagram-native-feed-max-pages=N  Native feed depth (1-${MAX_INSTAGRAM_NATIVE_FEED_PAGES}; default exhaustive/capped)`,
    `  --instagram-native-feed-max-items=N  Native feed item cap (1-${MAX_INSTAGRAM_NATIVE_FEED_ITEMS})`,
    `  --checkpoint-every=N     Persist after N task completions (1-${MAX_CHECKPOINT_EVERY}; default 25)`,
    "  --delay-ms=N",
    `  --public-fetch-timeout-ms=N  Website/feed deadline (25-${DEFAULT_PUBLIC_FETCH_TIMEOUT_MS}ms)`,
    "  --fresh-for-hours=N",
    "  --discover-missing-social",
    "  --mapped-only             Skip every URL-less social discovery task",
    "  --force",
    "  --catalog-root=ABSOLUTE_PATH  Read every mutable catalog from this repository root",
    "  --output=PATH",
    "  --checkpoint=PATH",
    "  --discovery-attempts=PATH",
    "  --source-discovery-paths=PATH",
    "  --recent-proof-journal-dir=PATH  Persist only provably exhaustive native request journals",
    "  --recent-coverage-cutoff=ISO      Immutable recent-window end pinned before requests",
    "  --plan                    Print the read-only target plan and exit",
    "  --help, -h"
  ].join("\n");
}
// Keep explicit attribution demotions independently from the mutable evidence
// arrays. Successful replacement collection removes prior platform rows, but
// must never erase a target-specific durable retirement directive.
const carriedAttributionReconciliationReviews = normalizeEvidenceForStorage(evidence).needsReview
  .filter((row) => row.attributionReconciliationDirective);

const coverageCompanies = batchSnapshot.companies.map((company) => ({
  ...company,
  sourceKey: companyId(company),
  founders: (company.founders ?? []).map((founder) => ({
    ...founder,
    sourceKey: entityIdFor(company, founder, "founder")
  }))
}));
const prioritizedCompanies = prioritizeAutonomousCompaniesByCoverage(
  coverageCompanies,
  currentGraph.evidence,
  { batchSlug: batchConfig.slug, prioritySeed }
)
  .filter(
    (company) =>
      !companyFilter ||
      company.slug.toLowerCase() === companyFilter ||
      company.name.toLowerCase() === companyFilter ||
      company.name.toLowerCase().includes(companyFilter)
  );
const companies = prioritizedCompanies
  .filter((_, index) => index % companyShardCount === companyShardIndex)
  .slice(0, companyLimit);

if (planOnly) {
  const socialTargets = publicSocialCollectionTargets(companies);
  const planPayload = JSON.stringify({
    batchSlug: batchConfig.slug,
    snapshotPath: batchSnapshotPath,
    checkpointPath,
    companyShardCount,
    companyShardIndex,
    companyCount: companies.length,
    founderCount: companies.reduce((count, company) => count + (company.founders?.length ?? 0), 0),
    taskConcurrencyCap: workerCount,
    laneConcurrency: {
      x: Math.max(1, Math.min(workerCount, platformConcurrency("x"))),
      linkedin: Math.max(1, Math.min(workerCount, platformConcurrency("linkedin"))),
      instagram: Math.max(1, Math.min(workerCount, platformConcurrency("instagram")))
    },
    socialCoverage: publicSocialCoverage(companies, socialTargets),
    socialTargets
  }, null, 2);
  await writeStdout(`${planPayload}\n`);
  process.exit(0);
}

const xRecentCollection = await fetchRecentXPostsForTargets({
  targets: publicSocialCollectionTargets(companies).filter((target) => target.platform === "x"),
  bearerToken: xBearerToken
});
if (xRecentCollection.errors.length) {
  console.warn(
    `Credentialed X recent search completed with ${xRecentCollection.errors.length} partial failure(s); ` +
    "public-reader fallback remains enabled."
  );
}

const taskPlan = companies.flatMap(buildCompanyTasks);
await runTaskPlan(taskPlan, workerCount);
const normalizedOutputEvidence = normalizeEvidenceForStorage(evidence);
const collectorCompletedAt = new Date().toISOString();
const autonomousAttempt = completeAutonomousCollectorProvenance(
  autonomousLaunchProvenance,
  {
    kind: "public",
    batchSlug: batchConfig.slug,
    shardIndex: companyShardIndex,
    shardCount: companyShardCount,
    fetchedAt: now,
    completedAt: collectorCompletedAt
  }
);

const payload = {
  source: {
    label: "Public unauthenticated platform/page ingestion",
    batchSlug: batchConfig.slug,
    batchLabel: batchConfig.label,
    fetchedAt: now,
    companyShardCount,
    companyShardIndex,
    ...(autonomousAttempt ? { autonomousAttempt } : {}),
    ...(recentCoverageCutoff ? { recentCoverageCutoff } : {}),
    companiesAttemptedThisRun: companies.length,
    checkpointFlushOnly: taskPlan.length === 0,
    checkpointCompanyCount: new Set([
      ...evidence.map((item) => item.companySlug).filter(Boolean),
      ...needsReview.map((item) => item.companySlug).filter(Boolean),
      ...failures.map((item) => item.companySlug).filter(Boolean)
    ]).size,
    taskCountThisRun: taskPlan.length,
    checkpointAttemptCount: attemptMap.size,
    workerCount,
    taskConcurrencyCap: workerCount,
    laneConcurrency: {
      x: Math.max(1, Math.min(workerCount, platformConcurrency("x"))),
      linkedin: Math.max(1, Math.min(workerCount, platformConcurrency("linkedin"))),
      instagram: Math.max(1, Math.min(workerCount, platformConcurrency("instagram")))
    },
    forcedRefresh: forceRefresh,
    credentialedDiscovery: {
      x: {
        configured: xRecentCollection.configured,
        handlesRequested: xRecentCollection.handlesRequested,
        requestCount: xRecentCollection.requestCount,
        successfulRequestCount: xRecentCollection.successfulRequestCount,
        errorCount: xRecentCollection.errors.length
      },
      exa: { configured: Boolean(exaApiKey), errorCount: exaFailureCount }
    },
    platformsAttempted: attemptedPlatformsForRun(),
    notes: [
      "Read-only public requests only.",
      "No account login, cookies, browser sessions, or mutations.",
      "Official X recent-search and Exa web-search APIs are used only when their workflow credentials are configured.",
      "Mapped Instagram accounts first use the anonymous web_profile_info endpoint with credentials omitted; any incomplete profile response is recorded as truncated rather than complete.",
      "Blocked platforms are logged per company and do not fail the batch.",
      "Batch profile text is not used as traction evidence.",
      ...(taskPlan.length === 0
        ? ["This write flushed the existing checkpoint to the app snapshot without making network requests."]
        : [])
    ]
  },
  attempts: Object.fromEntries(
    [...attemptMap.entries()].filter(([, attempt]) => !isObsoleteInternalFailure(attempt))
  ),
  evidence: normalizedOutputEvidence.evidence,
  needsReview: normalizeNeedsReviewItems([
    ...needsReview,
    ...carriedAttributionReconciliationReviews,
    ...normalizedOutputEvidence.needsReview
  ]),
  failures: dedupeFailures(failures),
  discoveryAttempts: dedupeDiscoveryAttempts(discoveryAttempts),
  sourceDiscoveryPaths: dedupeById(sourceDiscoveryPaths)
};

await writeJson(outputPath, payload);
await writeJson(discoveryAttemptsPath, dedupeDiscoveryAttempts(discoveryAttempts));
await writeJson(sourceDiscoveryPathsPath, dedupeById(sourceDiscoveryPaths));
await writeCheckpoint({ force: true });
console.log(
  `Wrote ${payload.evidence.length} evidence items, ${payload.needsReview.length} review candidates, ${payload.failures.length} failures, ${dedupeById(discoveryAttempts).length} discovery attempts.`
);

function buildCompanyTasks(company) {
  const hasMappedYouTube = socialAccountUrls(company, "youtube").length > 0;
  const hasMappedProductHunt = socialAccountUrls(company, "product_hunt").length > 0;
  const tasks = [
    connectorTask("website", company.slug, company, () => ingestWebsite(company)),
    connectorTask("rss", company.slug, company, () => ingestRss(company)),
    connectorTask("hacker_news", company.slug, company, () => ingestHackerNews(company)),
    hasMappedYouTube && socialMode !== "none"
      ? null
      : connectorTask("youtube", company.slug, company, () => ingestYouTube(company)),
    hasMappedProductHunt && socialMode !== "none"
      ? null
      : connectorTask("product_hunt", company.slug, company, () => ingestProductHunt(company)),
    connectorTask("news_web", company.slug, company, () => ingestNewsWeb(company)),
    connectorTask("reddit", company.slug, company, () => ingestReddit(company))
  ];

  if (socialMode !== "none") {
    tasks.push(...socialTasksForEntity(company, company, "company"));
    if (socialMode === "all") {
      for (const founder of company.founders ?? []) {
        tasks.push(...socialTasksForEntity(company, founder, "founder"));
      }
    }
  }

  return tasks.filter(Boolean);
}

function publicSocialCollectionTargets(targetCompanies) {
  const targets = [];
  for (const company of targetCompanies) {
    const entities = socialMode === "all"
      ? [[company, "company"], ...(company.founders ?? []).map((founder) => [founder, "founder"])]
      : socialMode === "company"
        ? [[company, "company"]]
        : [];
    for (const [entity, entityType] of entities) {
      for (const platform of MAPPED_ACCOUNT_PLATFORMS) {
        if (!platformAllowed(platform)) continue;
        for (const accountUrl of socialAccountUrls(entity, platform)) {
          targets.push({
            companySlug: company.slug,
            companyName: company.name,
            entityType,
            entityId: entityIdFor(company, entity, entityType),
            entityName: entityName(entity, entityType),
            platform,
            accountUrl
          });
        }
      }
    }
  }
  return targets;
}

function publicSocialCoverage(targetCompanies, plannedTargets) {
  const targetsByIdentity = new Map();
  for (const target of plannedTargets) {
    const key = `${target.entityId}:${target.platform}`;
    targetsByIdentity.set(key, [...(targetsByIdentity.get(key) ?? []), target]);
  }
  const coverage = [];
  for (const company of targetCompanies) {
    const entities = socialMode === "all"
      ? [[company, "company"], ...(company.founders ?? []).map((founder) => [founder, "founder"])]
      : socialMode === "company"
        ? [[company, "company"]]
        : [];
    for (const [entity, entityType] of entities) {
      const entityId = entityIdFor(company, entity, entityType);
      for (const platform of MAPPED_ACCOUNT_PLATFORMS) {
        const targets = targetsByIdentity.get(`${entityId}:${platform}`) ?? [];
        const rows = targets.length ? targets : [null];
        for (const target of rows) coverage.push({
          batchSlug: batchConfig.slug,
          companySlug: company.slug,
          companyName: company.name,
          entityType,
          entityId,
          entityName: entityName(entity, entityType),
          platform,
          accountUrl: target?.accountUrl ?? null,
          status: !platformAllowed(platform)
            ? "platform_filtered"
            : target
              ? "mapped_target"
              : DISCOVERABLE_SOCIAL_PLATFORMS.includes(platform) && discoverMissingSocial
                ? "discovery_target"
                : entityType === "company"
                  ? "generic_search_target"
                  : "not_applicable"
        });
      }
    }
  }
  return coverage;
}

function connectorTask(platform, key, company, fn) {
  if (!platformAllowed(platform)) return null;
  const normalizedPlatform = normalizePlatformArg(platform);
  return {
    lane: normalizedPlatform,
    company,
    label: `${normalizedPlatform}:${company.slug}`,
    terminalIdentity: {
      attemptKey: `${platform}:${key}`,
      platform: normalizedPlatform,
      companySlug: company.slug,
      entityType: "company",
      entityId: companyId(company),
      name: company.name,
      accountUrl: null
    },
    run: () => attempt(platform, key, company, fn)
  };
}

function socialTasksForEntity(company, entity, entityType) {
  return MAPPED_ACCOUNT_PLATFORMS.flatMap((platform) => {
    if (!platformAllowed(platform)) return [];
    const accountUrls = socialAccountUrls(entity, platform);
    if (!accountUrls.length && mappedAccountsOnly) return [];
    if (!accountUrls.length && !DISCOVERABLE_SOCIAL_PLATFORMS.includes(platform)) return [];
    // Exactly one URL-less task preserves recurring discovery for unmapped owners.
    return (accountUrls.length ? accountUrls : [null]).map((accountUrl) => {
      const entityId = entityIdFor(company, entity, entityType);
      return {
        lane: platform,
        company,
        label: `${platform}:${company.slug}:${entityType}:${entity.id ?? entity.slug}:${accountUrl ?? "discovery"}`,
        terminalIdentity: {
          attemptKey: accountUrl
            ? `${platform}:${entityType}:${entityId}:${accountUrl}`
            : `${platform}:${entityType}:${entityId}:missing-url`,
          platform,
          companySlug: company.slug,
          entityType,
          entityId,
          name: entityName(entity, entityType),
          accountUrl
        },
        run: () => attemptSocialProfile(company, entity, entityType, platform, accountUrl)
      };
    });
  });
}

async function runTaskPlan(tasks, maxWorkers) {
  const grouped = new Map();
  for (const task of tasks) {
    grouped.set(task.lane, [...(grouped.get(task.lane) ?? []), task]);
  }

  const lanes = [...grouped.entries()].map(([lane, laneTasks]) =>
    runLane(lane, laneTasks, Math.min(maxWorkers, platformConcurrency(lane)))
  );
  await Promise.all(lanes);
}

async function runLane(lane, tasks, limit) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async (_, workerIndex) => {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      await publicTaskConcurrencyGuard(async () => {
        console.log(`[${lane}/worker-${workerIndex + 1}] ${task.label}`);
        const cooldown = platformCooldowns.get(lane);
        if (cooldown && cooldown.until > Date.now()) {
          const message = `Platform cooldown active until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`;
          const identity = task.terminalIdentity;
          failures.push(identity
            ? {
                ...failure(
                  lane,
                  task.company,
                  identity.accountUrl,
                  message,
                  identity.entityType,
                  identity.name,
                  identity.entityId
                ),
                accountUrl: identity.accountUrl,
                attemptKey: identity.attemptKey
              }
            : {
                ...failure(lane, task.company, null, message),
                attemptKey: identity?.attemptKey ?? null
              });
          if (identity) {
            const recentWindowFields = recentWindowTerminalFields(
              lane,
              "platform_cooldown_active"
            );
            attemptMap.set(identity.attemptKey, socialAttemptRecord({
              attemptKey: identity.attemptKey,
              status: "failed",
              checkedAt: now,
              error: message,
              ...recentWindowFields,
              retryable: Object.keys(recentWindowFields).length === 0 &&
                retryableCollectorFailure(message),
              outcomeStatus: "blocked_or_empty",
              outcomeReason: "collector_checked_blocked_or_empty"
            }, identity));
          }
          await writeCheckpoint();
          return;
        }
        await task.run();
      });
    }
  });
  await Promise.all(workers);
}

function createConcurrencyGuard(limit) {
  let active = 0;
  const waiters = [];
  const acquire = () => new Promise((resolve) => {
    if (active < limit) {
      active += 1;
      resolve();
      return;
    }
    waiters.push(resolve);
  });
  const release = () => {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  };
  return async (operation) => {
    await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function platformConcurrency(lane) {
  if (lane === "instagram") return instagramWorkerCount;
  if (lane === "x") return xWorkerCount;
  if (lane === "linkedin") return linkedinWorkerCount;
  if (lane === "reddit") return 2;
  if (lane === "product_hunt") return 2;
  if (lane === "youtube") return 3;
  if (lane === "rss") return 4;
  if (lane === "hacker_news") return 4;
  return 5;
}

async function attempt(platform, key, company, fn) {
  if (!platformAllowed(platform)) return;
  const normalizedPlatform = normalizePlatformArg(platform);
  const attemptKey = `${platform}:${key}`;
  if (!forceRefresh && isFreshCompletedAttempt(attemptMap.get(attemptKey))) return;

  try {
    const result = await fn();
    const recentProof = await finalizeRecentWindowAttempt(result, {
      attemptKey,
      platform: normalizedPlatform,
      entityType: "company",
      entityId: companyId(company)
    });
    if (hasValidatedReplacement(result)) {
      removeCompanyPlatformRows(company, normalizedPlatform);
    }
    addItems(result?.evidence ?? [], evidence);
    addItems(result?.needsReview ?? [], needsReview);
    addItems(
      (result?.failures ?? []).map((row) => ({ ...row, attemptKey })),
      failures
    );
    addItems(result?.sourceDiscoveryPaths ?? [], sourceDiscoveryPaths);
    const attemptSummary = summarizeConnectorResult(result);
    const providerBlocker = (result?.failures ?? [])
      .find((row) => isAutonomousProviderBlocker(row?.blocker, {
        platform: row?.platform ?? normalizedPlatform
      }))?.blocker ?? null;
    const outcomeStatus = recentProof?.recentWindowProof
      ? "completed"
      : providerBlocker
        ? "blocked_or_empty"
        : collectorOutcomeStatus(attemptSummary);
    const retryable = recentProof?.recentWindowProof
      ? false
      : retryableCollectorFailure(attemptSummary.failureReason);
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        platform: normalizedPlatform,
        query: result?.query ?? defaultQueryFor(company, normalizedPlatform),
        source: result?.source ?? "public_connector",
        resultCount: attemptSummary.resultCount,
        usefulResultCount: attemptSummary.usefulResultCount,
        selectedUrl: selectedResultUrl(result),
        status: attemptSummary.status,
        failureReason: attemptSummary.failureReason
      })
    );
    attemptMap.set(attemptKey, socialAttemptRecord({
      attemptKey,
      status: "done",
      ...(recentProof?.startedAt ? { startedAt: recentProof.startedAt } : {}),
      checkedAt: recentProof?.checkedAt ?? now,
      ...(!recentProof?.recentWindowProof && attemptSummary.failureReason
        ? { error: attemptSummary.failureReason }
        : {}),
      ...(recentProof?.recentWindowProof
        ? { recentWindowProof: recentProof.recentWindowProof }
        : recentProof?.blocker
          ? { recentWindowProofBlocker: recentProof.blocker }
          : {}),
      ...(recentProof?.coverageCutoff
        ? { recentWindowCoverageCutoff: recentProof.coverageCutoff }
        : {}),
      ...(result?.coverageReceipt ? { coverageReceipt: result.coverageReceipt } : {}),
      ...(providerBlocker ? { blocker: providerBlocker } : {}),
      retryable: providerBlocker ? !providerBlocker.retryAt : retryable,
      outcomeStatus,
      outcomeReason: recentProof?.recentWindowProof
        ? "collector_native_recent_window_exhausted"
        : providerBlocker
          ? "collector_provider_blocked"
          : collectorOutcomeReason(attemptSummary)
    }, {
      platform: normalizedPlatform,
      companySlug: company.slug,
      entityType: "company",
      entityId: companyId(company),
      name: company.name,
      accountUrl: null
    }));
  } catch (error) {
    recordPlatformCooldownIfNeeded(normalizedPlatform, error);
    const message = errorMessage(error);
    const publicSearchBlocked = error instanceof PublicSearchUnavailableError;
    const blocker = publicSearchBlocked ? publicSearchBlockerFromError(error) : null;
    const recentWindowFields = recentWindowTerminalFields(
      normalizedPlatform,
      `native_recent_window_request_failed:${message}`
    );
    failures.push({
      ...failure(normalizedPlatform, company, null, message),
      attemptKey,
      ...(blocker ? { retryable: false, blocker } : {})
    });
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        platform: normalizedPlatform,
        query: defaultQueryFor(company, normalizedPlatform),
        source: "public_connector",
        resultCount: 0,
        usefulResultCount: 0,
        selectedUrl: null,
        status: "failed",
        failureReason: message,
        blocker
      })
    );
    attemptMap.set(attemptKey, socialAttemptRecord({
      attemptKey,
      status: "failed",
      checkedAt: now,
      error: message,
      ...(blocker ? { blocker } : {}),
      ...recentWindowFields,
      retryable: publicSearchBlocked ? false : retryableCollectorFailure(message),
      outcomeStatus: publicSearchBlocked || expectedAccessOrEmptyMessage(message)
        ? "blocked_or_empty"
        : "failed",
      outcomeReason: publicSearchBlocked || expectedAccessOrEmptyMessage(message)
        ? "collector_checked_blocked_or_empty"
        : "collector_reported_failure"
    }, {
      platform: normalizedPlatform,
      companySlug: company.slug,
      entityType: "company",
      entityId: companyId(company),
      name: company.name,
      accountUrl: null
    }));
  }

  await writeCheckpoint();
  await delay(requestDelayMs);
}

function summarizeConnectorResult(result) {
  const evidenceRows = result?.evidence ?? [];
  const reviewRows = result?.needsReview ?? [];
  const failureRows = result?.failures ?? [];
  const usefulResultCount = evidenceRows.filter((item) => item.contributionScore > 0 || item.review_state === "verified").length;
  const resultCount = evidenceRows.length + reviewRows.length;

  if (result?.verifiedEmpty === true) {
    return {
      resultCount,
      usefulResultCount,
      status: "success",
      failureReason: null,
      verifiedEmpty: true
    };
  }

  if (usefulResultCount > 0) {
    return {
      resultCount,
      usefulResultCount,
      status: failureRows.length || reviewRows.length ? "partial_success" : "success",
      failureReason: failureRows[0]?.message ?? reviewRows[0]?.matchReason ?? null
    };
  }

  if (reviewRows.length > 0) {
    return {
      resultCount,
      usefulResultCount,
      status: "needs_review",
      failureReason: reviewRows[0]?.matchReason ?? "Only review candidates were found."
    };
  }

  if (failureRows.length > 0) {
    return {
      resultCount,
      usefulResultCount,
      status: "failed",
      failureReason: failureRows[0]?.message ?? "Connector returned failures only."
    };
  }

  return {
    resultCount,
    usefulResultCount,
    status: "skipped",
    failureReason: "Connector returned no evidence, review candidates, or failures."
  };
}

function hasValidatedReplacement(result) {
  return result?.mergeOnly !== true && (result?.evidence?.length ?? 0) > 0;
}

async function attemptSocialProfile(company, entity, entityType, platform, accountUrl) {
  const rawUrl = accountUrl ?? null;
  const canonicalMappedUrl = rawUrl ? canonicalSocialAccountUrl(platform, rawUrl) : null;
  const url = canonicalMappedUrl ?? rawUrl;
  const entityId = entityIdFor(company, entity, entityType);
  const name = entityName(entity, entityType);
  const key = url
    ? `${platform}:${entityType}:${entityId}:${url}`
    : `${platform}:${entityType}:${entityId}:missing-url`;
  if (!url && !forceRefresh && isFreshCompletedAttempt(attemptMap.get(key))) return;

  if (url && (!canonicalMappedUrl || !mappedAccountUrlMatchesPlatform(url, platform, company))) {
    const mappingMessage = `Invalid URL mapping: ${platform} account URL host did not match the declared platform.`;
    failures.push({
      ...failure(platform, company, url, mappingMessage, entityType, name, entityId),
      attemptKey: key,
      retryable: false
    });
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        entityType,
        entityId,
        entityName: name,
        platform,
        query: `${name} ${company.name} ${platform}`,
        source: "canonical_account_mapping",
        resultCount: 0,
        usefulResultCount: 0,
        selectedUrl: url,
        status: "failed",
        failureReason: mappingMessage
      })
    );
    attemptMap.set(key, socialAttemptRecord({
      attemptKey: key,
      status: "failed",
      checkedAt: now,
      error: mappingMessage,
      retryable: false,
      outcomeStatus: "failed",
      outcomeReason: "collector_invalid_account_mapping"
    }, { platform, companySlug: company.slug, entityType, entityId, name, accountUrl: url }));
    await writeCheckpoint();
    return;
  }

  if (url && !forceRefresh && isFreshCompletedAttempt(attemptMap.get(key))) return;

  if (url && COMPANY_SCOPED_ACCOUNT_UNSUPPORTED_PLATFORMS.has(platform)) {
    attemptMap.set(key, socialAttemptRecord({
      attemptKey: key,
      status: "done",
      checkedAt: now,
      attempted: false,
      retryable: false,
      outcomeStatus: "blocked_or_empty",
      outcomeReason: "collector_scope_unsupported"
    }, { platform, companySlug: company.slug, entityType, entityId, name, accountUrl: url }));
    await writeCheckpoint();
    return;
  }

  if (!url) {
    const discoveredPathCandidates = discoveredSocialCandidatesFromPaths(
      company,
      platform,
      entity,
      entityType
    );
    const searchCandidates = discoverMissingSocial
      ? await discoverSocialCandidates(company, platform, entityType === "founder" ? entity : null)
      : [];
    const publicSearchBlocker = searchCandidates.publicSearchBlocker ?? null;
    let terminalProviderBlocker = publicSearchBlocker;
    const candidates = dedupeSocialCandidates([...discoveredPathCandidates, ...searchCandidates], platform);
    if (candidates.length) {
      const postCandidates = selectPublicSocialCandidates(
        candidates.filter((candidate) => isSocialPostUrl(candidate.url, platform)),
        platform,
        2
      );
      const verifiedPostResults = await verifyPublicSocialPostCandidates(company, platform, postCandidates);
      const verificationFailures = verifiedPostResults.flatMap((result) => result.failures ?? []);
      const verificationBlocker = verificationFailures
        .find((row) => isAutonomousProviderBlocker(row?.blocker, {
          platform: row?.platform ?? platform
        }))?.blocker ?? null;
      terminalProviderBlocker = publicSearchBlocker ?? verificationBlocker;
      const rawVerifiedPosts = verifiedPostResults.flatMap((result) => result.evidence ?? []);
      const attributedPosts = attributePostEvidenceToEntity(
        company,
        entity,
        entityType,
        platform,
        rawVerifiedPosts
      );
      const verifiedPosts = attributedPosts.evidence;
      const verifiedPostUrls = new Set(verifiedPosts.map((item) => item.sourceUrl));
      const reviewItems = [
        ...verifiedPostResults.flatMap((result) => result.needsReview ?? []),
        ...attributedPosts.needsReview,
        ...candidates
          .filter((candidate) => !verifiedPostUrls.has(candidate.url) && !postCandidates.some((postCandidate) => postCandidate.url === candidate.url))
          .map((candidate) =>
            reviewCandidate(
              company,
              platform,
              candidate.url,
              `Public search discovered this ${platform} candidate; profile/post verification is required before scoring.`,
              entityType,
              entityId,
              name
            )
          )
      ];
      addItems(verifiedPosts, evidence);
      addItems(reviewItems, needsReview);
      addItems(
        verificationFailures.map((row) => ({
          ...row,
          entityType,
          entityId,
          entityName: name,
          attemptKey: key
        })),
        failures
      );
      if (publicSearchBlocker) {
        failures.push({
          ...failure(
            platform,
            company,
            null,
            `Public account discovery was partially blocked: ${publicSearchBlocker.message}`,
            entityType,
            name,
            entityId
          ),
          attemptKey: key,
          retryable: false,
          blocker: publicSearchBlocker
        });
      }
      addItems(
        candidates.map((candidate) =>
          sourceDiscoveryPath({
            company,
            sourceUrl: candidate.searchUrl,
            discoveredUrl: candidate.url,
            discoveredPlatform: platform,
            discoveredEntityType: entityType,
            discoveredEntityId: entityId,
            discoveredEntityName: name,
            matchReason: verifiedPostUrls.has(candidate.url)
              ? `Verified post-level public evidence from search query "${candidate.query}".`
              : `Found from public search query "${candidate.query}".`,
            reviewState: verifiedPostUrls.has(candidate.url) ? "verified" : "needs_review"
          })
        ),
        sourceDiscoveryPaths
      );
      discoveryAttempts.push(
        discoveryAttempt({
          company,
          entityType,
          entityId,
          entityName: name,
          platform,
          query: candidates[0].query,
          source: "public_search_missing_social",
          resultCount: candidates.length,
          usefulResultCount: verifiedPosts.length,
          selectedUrl: verifiedPosts[0]?.sourceUrl ?? candidates[0].url,
          status: verifiedPosts.length ? "partial_success" : "needs_review",
          failureReason: terminalProviderBlocker?.message ??
            (verifiedPosts.length ? null : "No batch-linked URL; public search candidates require review."),
          blocker: terminalProviderBlocker
        })
      );
    } else {
      const missingMessage = publicSearchBlocker
        ? `No mapped public ${platform} URL for ${entityType} ${name}; public discovery was blocked: ${publicSearchBlocker.message}`
        : `No mapped public ${platform} URL for ${entityType} ${name}; public discovery returned no candidates.`;
      failures.push({
        ...failure(platform, company, null, missingMessage, entityType, name, entityId),
        attemptKey: key,
        ...(publicSearchBlocker ? { retryable: false, blocker: publicSearchBlocker } : {})
      });
      discoveryAttempts.push(
        discoveryAttempt({
          company,
          entityType,
          entityId,
          entityName: name,
          platform,
          query: `${name} ${company.name} ${platform}`,
          source: discoverMissingSocial ? "public_search_missing_social" : "catalog_social_links",
          resultCount: 0,
          usefulResultCount: 0,
          selectedUrl: null,
          status: "failed",
          failureReason: missingMessage,
          blocker: publicSearchBlocker
        })
      );
    }
    attemptMap.set(key, socialAttemptRecord({
      attemptKey: key,
      status: "done",
      checkedAt: now,
      count: candidates.length,
      error: terminalProviderBlocker?.message,
      ...(terminalProviderBlocker ? { blocker: terminalProviderBlocker } : {}),
      ...recentWindowTerminalFields(
        platform,
        candidates.length
          ? "native_account_mapping_requires_review"
          : "native_account_mapping_missing_or_unverifiable"
      ),
      // The provider outage is terminal for this bounded run. The exact
      // retry-at timestamp remains in the blocker so the next scheduled run
      // can retry without making this campaign replay every shard.
      retryable: terminalProviderBlocker ? !terminalProviderBlocker.retryAt : false,
      outcomeStatus: candidates.length ? "needs_review" : "blocked_or_empty",
      outcomeReason: candidates.length ? "collector_needs_review" : "collector_checked_blocked_or_empty"
    }, { platform, companySlug: company.slug, entityType, entityId, name, accountUrl: null }));
    await writeCheckpoint();
    await delay(requestDelayMs);
    return;
  }

  try {
    const result = annotateSocialResultAccount(
      await ingestMappedAccount(company, entity, entityType, platform, url),
      url
    );
    const recentProof = await finalizeRecentWindowAttempt(result, {
      attemptKey: key,
      platform,
      entityType,
      entityId
    });
    if (hasValidatedReplacement(result)) {
      removeEntityPlatformRows(company, entityId, entityType, platform, url);
    }
    addItems(result.evidence, evidence);
    addItems(result.needsReview, needsReview);
    const attributedFailures = (result.failures ?? []).map((row) => ({
      ...row,
      attemptKey: key
    }));
    addItems(attributedFailures, failures);
    addItems(result.sourceDiscoveryPaths ?? [], sourceDiscoveryPaths);
    const attemptSummary = summarizeConnectorResult(result);
    const providerBlocker = attributedFailures
      .find((row) => isAutonomousProviderBlocker(row?.blocker, {
        platform: row?.platform ?? platform
      }))?.blocker ?? null;
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        entityType,
        entityId,
        entityName: name,
        platform,
        query: `${name} ${company.name} ${platform}`,
        source: "yc_profile_social_links",
        resultCount: attemptSummary.resultCount,
        usefulResultCount: attemptSummary.usefulResultCount,
        selectedUrl: selectedResultUrl(result) ?? url,
        status: attemptSummary.status,
        failureReason: attemptSummary.failureReason,
        blocker: providerBlocker
      })
    );
    const outcomeStatus = recentProof?.recentWindowProof
      ? "completed"
      : providerBlocker
        ? "blocked_or_empty"
        : collectorOutcomeStatus(attemptSummary);
    const failureReason = String(attemptSummary.failureReason ?? "").trim();
    attemptMap.set(key, socialAttemptRecord({
      attemptKey: key,
      status: "done",
      ...(recentProof?.startedAt ? { startedAt: recentProof.startedAt } : {}),
      checkedAt: recentProof?.checkedAt ?? now,
      error: recentProof?.recentWindowProof ? undefined : failureReason || undefined,
      ...(providerBlocker ? { blocker: providerBlocker } : {}),
      ...(recentProof?.recentWindowProof
        ? { recentWindowProof: recentProof.recentWindowProof }
        : recentProof?.blocker
          ? { recentWindowProofBlocker: recentProof.blocker }
          : {}),
      ...(recentProof?.coverageCutoff
        ? { recentWindowCoverageCutoff: recentProof.coverageCutoff }
        : {}),
      ...(result?.coverageReceipt ? { coverageReceipt: result.coverageReceipt } : {}),
      retryable: recentProof?.recentWindowProof
        ? false
        : providerBlocker
        ? !providerBlocker.retryAt
        : retryableCollectorFailure(failureReason),
      outcomeStatus,
      outcomeReason: recentProof?.recentWindowProof
        ? "collector_native_recent_window_exhausted"
        : providerBlocker
          ? "collector_provider_blocked"
          : collectorOutcomeReason(attemptSummary)
    }, { platform, companySlug: company.slug, entityType, entityId, name, accountUrl: url }));
  } catch (error) {
    recordPlatformCooldownIfNeeded(platform, error);
    const providerBlocker = linkedinPublicBlockerFromError(error);
    const retryable = providerBlocker
      ? !providerBlocker.retryAt
      : error?.platformCooldownUntil
        ? false
        : retryableCollectorFailure(errorMessage(error));
    const recentWindowFields = recentWindowTerminalFields(
      platform,
      `native_recent_window_request_failed:${errorMessage(error)}`
    );
    failures.push({
      ...failure(platform, company, url, errorMessage(error), entityType, name, entityId),
      accountUrl: url,
      attemptKey: key,
      ...(providerBlocker ? { retryable, blocker: providerBlocker } : {})
    });
    discoveryAttempts.push(
      discoveryAttempt({
        company,
        entityType,
        entityId,
        entityName: name,
        platform,
        query: `${name} ${company.name} ${platform}`,
        source: "yc_profile_social_links",
        resultCount: 0,
        usefulResultCount: 0,
        selectedUrl: url,
        status: "failed",
        failureReason: errorMessage(error),
        blocker: providerBlocker
      })
    );
    const message = errorMessage(error);
    attemptMap.set(key, socialAttemptRecord({
      attemptKey: key,
      status: "failed",
      checkedAt: now,
      error: message,
      ...(providerBlocker ? { blocker: providerBlocker } : {}),
      ...recentWindowFields,
      retryable,
      outcomeStatus: providerBlocker || expectedAccessOrEmptyMessage(message) ? "blocked_or_empty" : "failed",
      outcomeReason: providerBlocker || expectedAccessOrEmptyMessage(message)
        ? "collector_checked_blocked_or_empty"
        : "collector_reported_failure"
    }, { platform, companySlug: company.slug, entityType, entityId, name, accountUrl: url }));
  }

  await writeCheckpoint();
  await delay(requestDelayMs);
}

async function ingestMappedAccount(company, entity, entityType, platform, url) {
  if (platform === "youtube") {
    return ingestMappedYouTubeAccount(company, entity, entityType, url);
  }
  if (platform === "product_hunt") {
    return ingestMappedProductHuntAccount(company, entity, entityType, url);
  }
  return ingestSocialProfile(company, entity, entityType, platform, url);
}

function annotateSocialResultAccount(result, accountUrl) {
  const annotate = (row) => ({ ...row, accountUrl });
  return {
    ...result,
    evidence: (result?.evidence ?? []).map(annotate),
    needsReview: (result?.needsReview ?? []).map(annotate),
    failures: (result?.failures ?? []).map(annotate)
  };
}

async function finalizeRecentWindowAttempt(result, {
  attemptKey,
  platform,
  entityType,
  entityId
}) {
  const observation = result?.recentWindowObservation;
  if (!recentWindowProofLane(platform) || !recentProofJournalDir) return null;
  if (!observation) {
    return {
      recentWindowProof: null,
      blocker: "native_recent_window_observation_missing",
      startedAt: null,
      checkedAt: null,
      coverageCutoff: recentCoverageCutoff
    };
  }
  if (observation.coveredThrough !== recentCoverageCutoff) {
    return {
      recentWindowProof: null,
      blocker: "native_recent_window_cutoff_mismatch",
      startedAt: observation.startedAt ?? null,
      checkedAt: observation.checkedAt ?? null,
      coverageCutoff: recentCoverageCutoff
    };
  }
  if (!recentProofJournalDir) {
    return {
      recentWindowProof: null,
      blocker: observation.complete
        ? "recent_window_journal_not_configured"
        : observation.blocker ?? "native_recent_window_unverifiable",
      startedAt: observation.startedAt ?? null,
      checkedAt: observation.checkedAt ?? null,
      coverageCutoff: recentCoverageCutoff
    };
  }
  const proof = await persistRecentWindowProof({
    observation,
    attemptKey,
    pairKey: `${batchConfig.slug}:${entityType}:${entityId}:${platform}`,
    journalDirectory: recentProofJournalDir,
    descriptorRoot: dirname(outputPath)
  });
  return { ...proof, coverageCutoff: recentCoverageCutoff };
}

function recentWindowProofLane(platform) {
  return ["instagram", "hacker_news"].includes(normalizePlatformArg(platform));
}

function recentWindowTerminalFields(platform, blocker) {
  if (!recentProofJournalDir || !recentCoverageCutoff || !recentWindowProofLane(platform)) {
    return {};
  }
  return {
    recentWindowCoverageCutoff: recentCoverageCutoff,
    recentWindowProofBlocker: String(blocker ?? "native_recent_window_unverifiable")
  };
}

function socialAttemptRecord(attempt, { platform, companySlug, entityType, entityId, name, accountUrl }) {
  const resolvedCompanySlug = companySlug ?? companySlugByEntityId.get(entityId);
  return {
    ...attempt,
    attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
    batchSlug: batchConfig.slug,
    platform,
    ...(resolvedCompanySlug ? { companySlug: resolvedCompanySlug } : {}),
    entityType,
    entityId,
    entityName: name,
    accountUrl
  };
}

function withAttemptBatchScope(attempt) {
  if (
    !attempt ||
    typeof attempt !== "object" ||
    Array.isArray(attempt) ||
    !attempt.platform ||
    !attempt.entityType ||
    !attempt.entityId
  ) {
    return attempt;
  }
  const companySlug = attempt.companySlug ?? companySlugByEntityId.get(attempt.entityId);
  if (attempt.batchSlug && (!companySlug || attempt.companySlug === companySlug)) {
    return attempt;
  }
  return {
    ...attempt,
    batchSlug: attempt.batchSlug ?? batchConfig.slug,
    ...(companySlug ? { companySlug } : {})
  };
}

function collectorOutcomeStatus(summary) {
  if (["success", "partial_success"].includes(summary.status)) return "completed";
  if (summary.status === "needs_review") return "needs_review";
  if (summary.status === "failed" && !expectedAccessOrEmptyMessage(summary.failureReason)) return "failed";
  return "blocked_or_empty";
}

function collectorOutcomeReason(summary) {
  const status = collectorOutcomeStatus(summary);
  if (summary.verifiedEmpty === true) return "collector_verified_native_account_empty_public_window";
  if (status === "completed") return "collector_evidence_collected";
  if (status === "needs_review") return "collector_needs_review";
  if (status === "failed") return "collector_reported_failure";
  return "collector_checked_blocked_or_empty";
}

function expectedAccessOrEmptyMessage(value) {
  const message = String(value ?? "").toLowerCase();
  if (/(?:\b404\b|http[_ -]?404|not found|invalid (?:url|mapping|host|identity)|dead (?:url|mapping|account)|wrong host|host did not match|unsupported .*url)/i.test(message)) {
    return false;
  }
  return /(?:no\b[^.\n]{0,100}\b(?:matches?|posts?|videos?|content|results?|items?|candidates?|evidence|mentions?|links?)\b|empty|login|log in|sign in|signup|join (?:linkedin|x)|access (?:blocked|denied)|\bblocked\b|rate.?limit|\b429\b|captcha|robots|authentication required|http[_ -]?(?:401|403|408|425|429|5\d\d)|\b(?:unauthori[sz]ed|forbidden|timeout|timed out|temporar(?:y|ily)|unavailable|network|transport)\b|fetch failed|operation was aborted|aborterror|\betimedout\b|\beconn[a-z]*\b|socket (?:hang up|closed)|circuit is open)/i.test(message);
}

function retryableCollectorFailure(value) {
  const message = String(value ?? "").trim();
  if (
    /(?:login|log in|sign in|signup|join (?:linkedin|x)|captcha|robots|authentication required|access[- ]gated)/i.test(message)
  ) {
    return false;
  }
  return isAutonomousCollectorFailureRetryable(message);
}

function discoveredSocialCandidatesFromPaths(company, platform, entity = company, entityType = "company") {
  const targetEntityId = entityIdFor(company, entity, entityType);
  const founderLinkedInSlug = entityType === "founder" && platform === "linkedin"
    ? linkedInProfileSlug(entity.socialLinks?.linkedin)
    : null;
  return sourceDiscoveryPaths
    .filter((item) => item.company_slug === company.slug)
    .filter((item) => item.discovered_platform === platform)
    .filter((item) => {
      const discoveredEntityType = item.discovered_entity_type ?? "company";
      if (discoveredEntityType === entityType) {
        if (entityType === "company") return true;
        if (item.discovered_entity_id) return item.discovered_entity_id === targetEntityId;
        return slugify(item.discovered_entity_name ?? "") === slugify(entity.name ?? "");
      }

      // A company-profile pass may expose a founder-authored native LinkedIn post before
      // the founder profile pass runs. Reuse it only when the URL itself proves the exact
      // verified founder author slug; company association or name similarity is insufficient.
      return Boolean(
        founderLinkedInSlug &&
        discoveredEntityType === "company" &&
        linkedInNativePostAuthorSlug(item.discovered_url) === founderLinkedInSlug
      );
    })
    .filter((item) => urlMatchesPlatform(item.discovered_url, platform))
    .map((item) => ({
      query: `${entityName(entity, entityType)} ${company.name} ${platform} from discovered public source path`,
      searchUrl: item.source_url,
      title: item.discovered_entity_name || company.name,
      snippet: item.match_reason,
      url: canonicalProfileUrl(item.discovered_url, platform)
    }));
}

async function ingestWebsite(company) {
  if (!company.websiteUrl) {
    return { failures: [failure("web", company, null, "No company website URL.")] };
  }

  const page = await fetchReadable(company.websiteUrl, { readerFallback: true });
  if (isBlocked(page.text)) {
    return { failures: [failure("web", company, company.websiteUrl, "Website returned a block/login/CAPTCHA page.")] };
  }

  const discoveredSocial = discoverSocialLinks(company, page.html, company.websiteUrl);

  return {
    evidence: [
      evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "web",
        sourceUrl: company.websiteUrl,
        title: page.title || company.name,
        text: firstUsefulText(page.text),
        rawVisibleText: page.text,
        metrics: {},
        contributionScore: 0,
        review_state: "verified",
        matchReason: "Official company website from the batch profile. Stored as context only; not scored as traction."
      })
    ],
    needsReview: discoveredSocial.map((item) =>
      reviewCandidate(
        company,
        item.platform,
        item.url,
        `Discovered from official company website; queued for public profile/post verification before scoring.`
      )
    ),
    sourceDiscoveryPaths: discoveredSocial.map((item) =>
      sourceDiscoveryPath({
        company,
        sourceUrl: company.websiteUrl,
        discoveredUrl: item.url,
        discoveredPlatform: item.platform,
        discoveredEntityType: "company",
        discoveredEntityName: company.name,
        matchReason: "Found as an outbound social/profile link on the official public company website.",
        reviewState: "needs_review"
      })
    )
  };
}

async function ingestRss(company) {
  if (!company.websiteUrl) {
    return { failures: [failure("rss", company, null, "No company website URL for feed discovery.")] };
  }

  const homepage = await fetchReadable(company.websiteUrl, { readerFallback: false }).catch(() => null);
  const feedUrls = discoverFeedUrls(company.websiteUrl, homepage?.html ?? "");
  if (!feedUrls.length) {
    return { failures: [failure("rss", company, company.websiteUrl, "No RSS/Atom feed discovered on public homepage.")] };
  }

  const feedEvidence = [];
  const feedFailures = [];
  for (const feedUrl of feedUrls.slice(0, 2)) {
    try {
      const { text: xml } = await fetchPublicBoundedText(feedUrl, {
        accept: "application/atom+xml,application/rss+xml,application/xml,text/xml",
        maxResponseBytes: HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
        maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
      });
      const items = parseFeedItems(xml);
      for (const item of items) {
        feedEvidence.push(
          evidenceItem({
            company,
            entityType: "company",
            entityId: companyId(company),
            platform: "rss",
            sourceUrl: item.link || feedUrl,
            title: item.title || company.name,
            text: item.description || item.title || company.name,
            rawVisibleText: item.raw,
            postedAt: item.publishedAt,
            metrics: {},
            contributionScore: 0,
            review_state: "verified",
            matchReason: "Public RSS/Atom item from the company website. Stored as public content context; not scored without public engagement metrics."
          })
        );
      }
    } catch (error) {
      feedFailures.push(failure("rss", company, feedUrl, errorMessage(error)));
    }
  }

  return { evidence: feedEvidence, failures: feedFailures };
}

async function ingestHackerNews(company) {
  const officialDomain = hostFromUrl(company.websiteUrl);
  if (recentProofJournalDir && officialDomain) {
    const target = {
      entityName: company.name,
      officialDomain
    };
    const recent = await collectHackerNewsRecentWindow({
      target,
      checkedThrough: recentCoverageCutoff
    });
    const hits = recent.hits.filter((hit) => matchesHnCompanyStory(hit, target));
    return {
      evidence: hits.map((hit) => {
        const nativeUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
        return evidenceItem({
          company,
          entityType: "company",
          entityId: companyId(company),
          platform: "hacker_news",
          sourceUrl: nativeUrl,
          submittedUrl: hit.url ?? null,
          platformPostId: String(hit.objectID),
          title: hit.title || company.name,
          text: hit.title || company.name,
          rawVisibleText: JSON.stringify(hit),
          postedAt: hit.created_at,
          metrics: {
            upvotes: numberOrNull(hit.points),
            comments: numberOrNull(hit.num_comments)
          },
          contributionScore: scoreMetrics("hacker_news", {
            upvotes: numberOrNull(hit.points),
            comments: numberOrNull(hit.num_comments)
          }),
          review_state: "verified",
          matchReason:
            "Exact company-name plus official-domain match in an exhaustively paged, date-bounded Hacker News Algolia result window."
        });
      }),
      failures: recent.observation.complete
        ? []
        : [failure(
            "hacker_news",
            company,
            null,
            `Recent Hacker News window remained incomplete: ${recent.observation.blocker}.`
          )],
      source: "hacker_news_algolia_recent_window",
      recentWindowObservation: recent.observation,
      mergeOnly: true
    };
  }

  const query = encodeURIComponent(`"${company.name}"`);
  const url = `https://hn.algolia.com/api/v1/search?query=${query}&tags=story&hitsPerPage=5`;
  const { text } = await fetchPublicBoundedText(url, { accept: "application/json" });
  const data = parsePublicJson(text, url);
  const hits = (data.hits ?? []).filter((hit) =>
    isStrongPublicMatch(company, `${hit.title ?? ""} ${hit.url ?? ""}`, hit.url ?? "") &&
    isCurrentBatchHackerNewsHit(`${hit.title ?? ""} ${hit.url ?? ""}`)
  );

  if (!hits.length) {
    return { failures: [failure("hacker_news", company, url, "No verified public Hacker News matches.")] };
  }

  return {
    evidence: hits.map((hit) => {
      const nativeUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      return evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "hacker_news",
        sourceUrl: nativeUrl,
        submittedUrl: hit.url ?? null,
        platformPostId: String(hit.objectID),
        title: hit.title || company.name,
        text: hit.title || company.name,
        rawVisibleText: JSON.stringify(hit),
        postedAt: hit.created_at,
        metrics: {
          upvotes: numberOrNull(hit.points),
          comments: numberOrNull(hit.num_comments)
        },
        contributionScore: scoreMetrics("hacker_news", {
          upvotes: numberOrNull(hit.points),
          comments: numberOrNull(hit.num_comments)
        }),
        review_state: "verified",
        matchReason: "Exact company-name match in public Hacker News Algolia result."
      });
    })
  };
}

async function ingestYouTube(company) {
  const officialLaunchResults = await ingestOfficialEmbeddedYouTube(company);
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${company.name} ${currentBatchContext.label}`)}`;
  const { text: html } = await fetchPublicBoundedText(url);
  const candidates = parseYouTubeResults(html)
    .filter((item) => isPotentialCompanyMention(company, `${item.title} ${item.description}`))
    .slice(0, 12);
  const enrichedResults = await Promise.all(candidates.map(enrichYouTubeNativeChannel));
  const assessedResults = enrichedResults.map((video) => ({
    video,
    attribution: publicEvidenceAttributionAssessment(company, {
      platform: "youtube",
      sourceUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      title: video.title,
      text: video.description,
      rawVisibleText: video.raw,
      youtubeChannelId: video.youtubeChannelId,
      youtubeChannelUrl: video.youtubeChannelUrl,
      youtubeChannelName: video.youtubeChannelName
    })
  }));

  if (!assessedResults.length && !officialLaunchResults.evidence.length && !officialLaunchResults.needsReview.length) {
    return { failures: [failure("youtube", company, url, "No verified public YouTube result match.")] };
  }

  const verifiedResults = assessedResults
    .filter(({ video, attribution }) => attribution.verified && (video.youtubeChannelId || video.youtubeChannelUrl))
    .slice(0, 3);
  const needsReviewItems = assessedResults
    .filter(({ video, attribution }) => !attribution.verified || (!video.youtubeChannelId && !video.youtubeChannelUrl))
    .map(({ video, attribution }) => ({
      ...reviewCandidate(
        company,
        "youtube",
        `https://www.youtube.com/watch?v=${video.videoId}`,
        !attribution.verified
          ? `Semantic YouTube attribution rejected: ${attribution.reason}.`
          : "Native YouTube video candidate lacked a persisted native channel ID or URL; attribution was not accepted."
      ),
      title: sanitizePublicText(video.title),
      text: truncatePublicText(video.description || video.title, 600),
      rawVisibleText: truncatePublicText(video.raw, 6000),
      platformPostId: video.videoId,
      metrics: removeNullish({ views: video.views }),
      youtubeChannelId: video.youtubeChannelId ?? null,
      youtubeChannelUrl: video.youtubeChannelUrl ?? null,
      youtubeChannelName: video.youtubeChannelName ?? null,
      attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
      attributionStatus: "needs_review",
      attributionSignals: attribution.signals,
      attributionDescriptorMatches: attribution.descriptorMatches,
      semanticAttributionReason: attribution.reason
    }));

  return {
    evidence: [
      ...officialLaunchResults.evidence,
      ...verifiedResults.map(({ video, attribution }) => {
      return evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "youtube",
        sourceUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        text: video.description || video.title,
        rawVisibleText: video.raw,
        metrics: {
          views: video.views
        },
        contributionScore: scoreMetrics("youtube", { views: video.views }),
        review_state: "verified",
        matchReason: `Public YouTube search result passed semantic attribution (${attribution.reason}) with persisted native channel identity.`,
        youtubeChannelId: video.youtubeChannelId,
        youtubeChannelUrl: video.youtubeChannelUrl,
        youtubeChannelName: video.youtubeChannelName,
        attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
        attributionStatus: "verified",
        attributionSignals: attribution.signals,
        attributionDescriptorMatches: attribution.descriptorMatches
      });
      })
    ],
    needsReview: [...officialLaunchResults.needsReview, ...needsReviewItems],
    sourceDiscoveryPaths: officialLaunchResults.sourceDiscoveryPaths
  };
}

async function ingestOfficialEmbeddedYouTube(company) {
  const launchPage = await readOfficialLaunchPage(company);
  if (!launchPage) return { evidence: [], needsReview: [], sourceDiscoveryPaths: [] };
  const videoIds = extractEmbeddedYouTubeIds(`${launchPage.html}\n${launchPage.text}`).slice(0, 5);
  const evidenceRows = [];
  const reviewRows = [];
  const paths = [];

  for (const videoId of videoIds) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const [channel, watchMetadata] = await Promise.all([
      enrichYouTubeNativeChannel({
      videoId,
      title: `${company.name} launch video`,
      description: `Embedded in the official ${company.name} YC company page.`,
      views: null,
      raw: launchPage.text
      }),
      fetchYouTubeWatchMetadata(videoId)
    ]);
    const metrics = removeNullish({
      views: watchMetadata?.views,
      likes: watchMetadata?.likes,
      comments: watchMetadata?.comments
    });
    const hasPositiveMetrics = Object.values(metrics).some((value) => Number(value) > 0);
    const youtubeChannelId = watchMetadata?.youtubeChannelId ?? channel.youtubeChannelId;
    const youtubeChannelUrl = watchMetadata?.youtubeChannelUrl ?? channel.youtubeChannelUrl;
    const youtubeChannelName = watchMetadata?.youtubeChannelName ?? channel.youtubeChannelName;
    const hasNativeChannel = Boolean(youtubeChannelId || youtubeChannelUrl);
    paths.push(sourceDiscoveryPath({
      company,
      sourceUrl: company.ycProfileUrl,
      discoveredUrl: videoUrl,
      discoveredPlatform: "youtube",
      discoveredEntityType: "company",
      discoveredEntityId: companyId(company),
      discoveredEntityName: company.name,
      matchReason: `Official YC company page embedded native YouTube video ${videoId}.`,
      reviewState: hasPositiveMetrics && hasNativeChannel ? "verified" : "needs_review"
    }));
    if (!hasPositiveMetrics || !hasNativeChannel) {
      reviewRows.push({
        ...reviewCandidate(
          company,
          "youtube",
          videoUrl,
          !hasNativeChannel
            ? "Official YC company page embedded this video, but the native YouTube channel identity was unavailable."
            : "Official YC company page embedded this video, but positive native metrics were not publicly visible."
        ),
        platformPostId: videoId,
        youtubeChannelId: youtubeChannelId ?? null,
        youtubeChannelUrl: youtubeChannelUrl ?? null,
        youtubeChannelName: youtubeChannelName ?? null
      });
      continue;
    }
    evidenceRows.push(evidenceItem({
      company,
      entityType: "company",
      entityId: companyId(company),
      platform: "youtube",
      sourceUrl: videoUrl,
      platformPostId: videoId,
      title: watchMetadata?.title || channel.title || `${company.name} launch video`,
      text: watchMetadata?.description || `Embedded in the official ${company.name} YC company page.`,
      rawVisibleText: watchMetadata?.raw ?? launchPage.text,
      postedAt: watchMetadata?.postedAt ?? null,
      metrics,
      contributionScore: scoreMetrics("youtube", metrics),
      review_state: "verified",
      youtubeChannelId,
      youtubeChannelUrl,
      youtubeChannelName,
      attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
      attributionStatus: "verified",
      attributionProvenance: "official_yc_company_page_embed_v1",
      matchReason: "Native YouTube video was embedded in the exact official YC company page and exposed positive public metrics plus native channel identity."
    }));
  }

  return { evidence: evidenceRows, needsReview: reviewRows, sourceDiscoveryPaths: paths };
}

async function fetchYouTubeWatchMetadata(videoId) {
  try {
    const { response, text: html } = await fetchPublicBoundedText(
      `https://www.youtube.com/watch?v=${videoId}`
    );
    if (!response.ok) return null;
    const detailsStart = html.indexOf('"videoDetails":{');
    const details = detailsStart >= 0 ? html.slice(detailsStart, detailsStart + 120_000) : html;
    const youtubeChannelId = jsonStringField(details, "channelId");
    const youtubeChannelName = jsonStringField(details, "author") ?? jsonStringField(html, "ownerChannelName");
    return {
      title: jsonStringField(details, "title"),
      description: jsonStringField(details, "shortDescription"),
      postedAt: jsonStringField(html, "publishDate") ?? jsonStringField(html, "uploadDate"),
      views: numberOrNull(jsonStringField(details, "viewCount") ?? jsonNumberField(details, "viewCount")),
      likes: numberOrNull(jsonStringField(html, "likeCount") ?? jsonNumberField(html, "likeCount")),
      comments: numberOrNull(jsonStringField(html, "commentCount") ?? jsonNumberField(html, "commentCount")),
      youtubeChannelId,
      youtubeChannelUrl: youtubeChannelId
        ? `https://www.youtube.com/channel/${youtubeChannelId}`
        : null,
      youtubeChannelName,
      raw: cleanText(details.slice(0, 8_000))
    };
  } catch {
    return null;
  }
}

function jsonStringField(value, field) {
  const match = String(value ?? "").match(new RegExp(`"${field}":"((?:\\\\.|[^"\\\\])*)"`));
  return match ? decodeJsonText(match[1]) : null;
}

function jsonNumberField(value, field) {
  return String(value ?? "").match(new RegExp(`"${field}":(\\d+)`))?.[1] ?? null;
}

function isPotentialCompanyMention(company, text) {
  if (isCompanyMatch(company, text)) return true;
  const compactCompany = String(company?.name ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const compactText = String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return compactCompany.length >= 3 && compactText.includes(compactCompany);
}

async function enrichYouTubeNativeChannel(video) {
  if (video.youtubeChannelId || video.youtubeChannelUrl) return video;
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
    const { text } = await fetchPublicBoundedText(oEmbedUrl, { accept: "application/json" });
    const payload = parsePublicJson(text, oEmbedUrl);
    return {
      ...video,
      youtubeChannelName: cleanText(payload.author_name ?? "") || null,
      youtubeChannelUrl: canonicalYouTubeChannelUrl(payload.author_url),
      raw: cleanText(`${video.raw} ${payload.author_name ?? ""} ${payload.author_url ?? ""}`)
    };
  } catch {
    return video;
  }
}

function canonicalYouTubeChannelUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname.replace(/^www\./, "").toLowerCase() !== "youtube.com") return null;
    url.hostname = "youtube.com";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

async function ingestMappedYouTubeAccount(company, entity, entityType, accountUrl) {
  const canonicalAccountUrl = canonicalProfileUrl(accountUrl, "youtube").replace(/\/$/, "");
  const videosUrl = `${canonicalAccountUrl}/videos`;
  const { text: html } = await fetchPublicBoundedText(videosUrl);
  const pageObservation = parseYouTubePublicPage(html);
  const mappedChannelId = youtubeChannelIdFromAccountUrl(canonicalAccountUrl);
  if (mappedChannelId && pageObservation.channelId && mappedChannelId !== pageObservation.channelId) {
    return {
      failures: [failure(
        "youtube",
        company,
        accountUrl,
        `Mapped YouTube channel ${mappedChannelId} resolved to ${pageObservation.channelId}; refusing cross-channel evidence.`,
        entityType,
        entityName(entity, entityType),
        entityIdFor(company, entity, entityType)
      )]
    };
  }
  const pageVideos = parseYouTubeResults(html);
  const channelId = mappedChannelId ?? pageObservation.channelId ??
    pageVideos.find((video) => video.youtubeChannelId)?.youtubeChannelId ?? null;
  const entityId = entityIdFor(company, entity, entityType);
  const name = entityName(entity, entityType);
  let feed = null;
  let feedFailure = null;
  if (channelId) {
    const feedSourceUrl = youtubeFeedUrl(channelId);
    try {
      const { response: feedResponse, text: feedBody } = await fetchPublicBoundedText(feedSourceUrl, {
        accept: "application/atom+xml,application/xml,text/xml"
      });
      if (!feedResponse.ok) {
        throw new Error(`Official YouTube Atom feed returned HTTP ${feedResponse.status}.`);
      }
      feed = parseYouTubeFeed(feedBody, {
        target: {
          accountUrl: canonicalAccountUrl,
          accountId: channelId,
          batchSlug: batchConfig.slug,
          entityType,
          entityId,
          entityName: name,
          companyId: companyId(company),
          companyName: company.name
        },
        discoveredAt: new Date(now)
      });
    } catch (error) {
      feedFailure = failure(
        "youtube",
        company,
        feedSourceUrl,
        `Official YouTube Atom feed could not be exhausted: ${errorMessage(error)}`,
        entityType,
        name,
        entityId
      );
    }
  }

  const videosById = new Map();
  for (const video of feed?.evidence ?? []) {
    videosById.set(video.nativeId, {
      videoId: video.nativeId,
      title: video.title,
      description: video.text,
      postedAt: video.publishedAt,
      views: video.metrics?.views ?? null,
      youtubeChannelId: channelId,
      youtubeChannelUrl: channelId ? `https://youtube.com/channel/${channelId}` : canonicalAccountUrl,
      raw: JSON.stringify(video),
      discoveryMethod: video.discoveryMethod
    });
  }
  for (const video of pageVideos) {
    const prior = videosById.get(video.videoId);
    videosById.set(video.videoId, {
      ...prior,
      ...video,
      postedAt: prior?.postedAt ?? null,
      views: Number(video.views) > 0 ? video.views : prior?.views ?? video.views,
      raw: cleanText(`${prior?.raw ?? ""} ${video.raw ?? ""}`),
      discoveryMethod: prior?.discoveryMethod ?? "youtube_verified_channel_videos_page"
    });
  }
  const videos = [...videosById.values()];
  if (!videos.length) {
    return {
      failures: [
        ...(feedFailure ? [feedFailure] : []),
        failure(
          "youtube",
          company,
          accountUrl,
          "No visible native YouTube videos were exposed on the mapped account or its official Atom feed.",
          entityType,
          name,
          entityId
        )
      ]
    };
  }
  const evidence = [];
  const needsReview = [];
  for (const video of videos) {
    if (!(Number(video.views) > 0)) {
      needsReview.push({
        ...reviewCandidate(
          company,
          "youtube",
          `https://www.youtube.com/watch?v=${video.videoId}`,
          `Verified mapped YouTube video for ${name} had no positive public view metric.`,
          entityType,
          entityId,
          name
        ),
        platformPostId: video.videoId,
        postedAt: video.postedAt ?? null,
        youtubeChannelId: channelId,
        youtubeChannelUrl: video.youtubeChannelUrl ?? canonicalAccountUrl
      });
      continue;
    }
    evidence.push(evidenceItem({
      company,
      entityType,
      entityId,
      platform: "youtube",
      sourceUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      platformPostId: video.videoId,
      title: video.title,
      text: video.description || video.title,
      rawVisibleText: video.raw,
      postedAt: video.postedAt ?? null,
      metrics: { views: video.views },
      contributionScore: scoreMetrics("youtube", { views: video.views }),
      review_state: "verified",
      youtubeChannelId: channelId,
      youtubeChannelUrl: video.youtubeChannelUrl ?? canonicalAccountUrl,
      attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
      attributionStatus: "verified",
      attributionProvenance: video.discoveryMethod,
      matchReason: `Native video enumerated from the verified mapped YouTube account for ${name}.`
    }));
  }
  return {
    evidence,
    needsReview,
    failures: feedFailure ? [feedFailure] : []
  };
}

async function ingestMappedProductHuntAccount(company, entity, entityType, accountUrl) {
  const result = await verifyProductHuntLink(company, { url: accountUrl, text: company.name });
  const entityId = entityIdFor(company, entity, entityType);
  const name = entityName(entity, entityType);
  if (result.evidence) {
    return {
      evidence: [{
        ...result.evidence,
        entityType,
        entityId,
        entityName: name,
        matchReason: `${result.evidence.matchReason} Verified mapped account owner: ${name}.`
      }]
    };
  }
  const reason = result.needsReview?.reason ??
    "The verified mapped Product Hunt URL did not expose enough public page detail for native scoring.";
  return {
    needsReview: [reviewCandidate(
      company,
      "product_hunt",
      accountUrl,
      reason,
      entityType,
      entityId,
      name
    )]
  };
}

async function ingestProductHunt(company) {
  const url = `https://www.producthunt.com/search?q=${encodeURIComponent(company.name)}`;
  const page = await fetchReader(url).catch(() => null);
  const publicSearchBlocked = !page || isBlocked(page.text);
  const searchPageLinks = (publicSearchBlocked
    ? []
    : [
        ...extractHtmlLinks(page.html, page.url),
        ...extractMarkdownLinks(page.text),
        ...extractProductHuntLinks(page.text).map((link) => ({ text: "", url: link }))
      ])
    .filter((link) => link.url.includes("producthunt.com"))
    .filter((link) => /\/(products|posts)\//.test(link.url))
    .filter((link) => !/\/reviews\b|\/products\/lovable\b/i.test(link.url));
  const officialLaunchPage = await readOfficialLaunchPage(company);
  const officialLaunchLinks = extractProductHuntLinks(
    `${officialLaunchPage?.html ?? ""}\n${officialLaunchPage?.text ?? ""}`
  ).map((link) => ({ text: `${company.name} official YC launch page`, url: link }));
  const exactSlugCandidates = [
    {
      text: `${company.name} exact Product Hunt launch slug`,
      url: `https://www.producthunt.com/products/${company.slug}/launches/${company.slug}`
    },
    {
      text: `${company.name} exact Product Hunt product slug`,
      url: `https://www.producthunt.com/products/${company.slug}`
    }
  ];
  const webSearchLinks = await searchProductHuntLinks(company);
  const links = dedupeProductHuntLinks([
    ...officialLaunchLinks,
    ...exactSlugCandidates,
    ...searchPageLinks,
    ...webSearchLinks
  ])
    .filter((link) => productHuntCandidateMatches(company, link))
    .slice(0, 5);
  const verified = [];
  const reviewCandidates = [];

  for (const link of links) {
    const result = await verifyProductHuntLink(company, link);
    if (result.evidence) verified.push(result.evidence);
    if (result.needsReview) reviewCandidates.push(result.needsReview);
    if (verified.length >= 3) break;
  }

  if (!verified.length) {
    const candidate = reviewCandidates[0] ?? links[0];
    return candidate
      ? {
          needsReview: [
            reviewCandidate(
              company,
              "product_hunt",
              candidate.url,
              candidate.reason
                ? `Product Hunt public result needs review: ${candidate.reason}.`
                : "Product Hunt public result did not clearly match both the company name and official domain."
            )
          ]
        }
      : { failures: [failure("product_hunt", company, url, "No public Product Hunt result links found.")] };
  }

  return {
    evidence: verified
  };
}

async function readOfficialLaunchPage(company) {
  const profileUrl = company?.ycProfileUrl;
  if (!profileUrl || !/\/\/www\.ycombinator\.com\/companies\//i.test(profileUrl)) return null;
  if (!officialLaunchPageCache.has(profileUrl)) {
    officialLaunchPageCache.set(
      profileUrl,
      fetchReadable(profileUrl, { readerFallback: true }).catch((error) => {
        console.warn(`Official YC launch-page discovery failed for ${company.slug}: ${errorMessage(error)}`);
        return null;
      })
    );
  }
  return officialLaunchPageCache.get(profileUrl);
}

async function searchProductHuntLinks(company) {
  const queries = [
    `site:producthunt.com/products "${company.name}"`,
    `site:producthunt.com/posts "${company.name}"`
  ];
  const links = [];

  for (const query of queries) {
    const { response, text: html } = await fetchPublicSearchText(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    );
    if (response.status >= 400) continue;
    const $ = cheerio.load(html);
    $(".result")
      .toArray()
      .slice(0, 5)
      .forEach((node) => {
        const item = $(node);
        const title = cleanText(item.find(".result__title").text());
        const sourceUrl = normalizeSearchUrl(item.find(".result__a").attr("href") ?? "");
        if (/producthunt\.com\/(products|posts)\//i.test(sourceUrl)) {
          links.push({ text: title, url: sourceUrl });
        }
      });
  }

  if (exaApiKey) {
    try {
      const exaLinks = await searchExaSourceCandidates({
        query: `${company.name} ${company.websiteUrl ?? ""} Product Hunt launch`,
        platform: "product_hunt",
        apiKey: exaApiKey,
        numResults: 8
      });
      links.push(...exaLinks.map((candidate) => ({
        text: cleanText(`${candidate.title} ${candidate.snippet}`),
        url: candidate.url
      })));
    } catch (error) {
      exaFailureCount += 1;
      console.warn(`Exa Product Hunt discovery failed for ${company.slug}: ${errorMessage(error)}`);
    }
  }

  return links;
}

async function discoverSocialCandidates(company, platform, entity = null) {
  const queries = socialDiscoveryQueries(company, platform, entity);
  const candidates = [];
  const publicSearchFailures = [];

  const maxQueries = platform === "instagram" || platform === "x" ? 8 : 5;
  for (const query of queries.slice(0, maxQueries)) {
    try {
      const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const { response, text: html } = await fetchPublicSearchText(searchUrl);
      if (response.status >= 400) continue;
      const $ = cheerio.load(html);
      selectPublicSocialCandidates($(".result").toArray(), platform, 8)
        .forEach((node) => {
          const item = $(node);
          const title = cleanText(item.find(".result__title").text());
          const snippet = cleanText(item.find(".result__snippet").text());
          const url = normalizeSearchUrl(item.find(".result__a").attr("href") ?? "");
          if (!urlMatchesPlatform(url, platform)) return;
          if (!isCompanyMatch(company, `${title} ${snippet} ${url}`)) return;
          candidates.push({
            query,
            searchUrl,
            title,
            snippet,
            url: canonicalProfileUrl(url, platform)
          });
        });
    } catch (error) {
      if (!(error instanceof PublicSearchUnavailableError)) throw error;
      const blocker = publicSearchBlockerFromError(error);
      publicSearchFailures.push(blocker);
      if (blocker.retryAt) break;
    }
  }

  if (exaApiKey && ["linkedin", "x"].includes(platform)) {
    const name = entityName(entity ?? company, entity ? "founder" : "company");
    const mappedAccountUrl = entity?.socialLinks?.[platform] ?? company?.socialLinks?.[platform] ?? null;
    const mappedAccountAlias = platform === "x"
      ? xUsernameFromUrl(mappedAccountUrl)
      : socialProfileNameAlias(mappedAccountUrl, platform);
    const query = [
      name,
      company.name,
      mappedAccountAlias,
      currentBatchContext.label,
      platform === "linkedin" ? "LinkedIn native post" : "X post"
    ].filter(Boolean).join(" ");
    try {
      const exaCandidates = await searchExaSourceCandidates({
        query,
        platform,
        apiKey: exaApiKey,
        numResults: 8
      });
      for (const candidate of exaCandidates) {
        const url = canonicalProfileUrl(candidate.url, platform);
        if (!urlMatchesPlatform(url, platform)) continue;
        if (!isCompanyMatch(company, `${candidate.title} ${candidate.snippet} ${url}`)) continue;
        candidates.push({ ...candidate, url });
      }
    } catch (error) {
      exaFailureCount += 1;
      console.warn(`Exa ${platform} discovery failed for ${company.slug}: ${errorMessage(error)}`);
    }
  }

  const selected = selectPublicSocialCandidates(firstSocialCandidatePerUrl(
    candidates.filter((candidate) => !isLowValueSocialUrl(candidate.url, platform))
  ), platform, 5);
  if (publicSearchFailures.length > 0) {
    Object.defineProperty(selected, "publicSearchBlocker", {
      configurable: false,
      enumerable: false,
      value: publicSearchFailures.at(-1),
      writable: false
    });
  }
  return selected;
}

function dedupeSocialCandidates(candidates, platform = null) {
  return selectPublicSocialCandidates(firstSocialCandidatePerUrl(
    candidates
      .filter((candidate) => candidate?.url)
      .filter((candidate) => !isLowValueSocialUrl(candidate.url, platformFromUrl(candidate.url)))
  ), platform, 8);
}

function selectPublicSocialCandidates(candidates, platform, limit) {
  // LinkedIn's public reader/search responses are already bounded by the finite
  // response body and query count. Process every native URL they expose instead
  // of silently discarding later posts; retain the legacy caps for other lanes.
  return platform === "linkedin" ? candidates : candidates.slice(0, limit);
}

async function verifyPublicSocialPostCandidates(company, platform, candidates) {
  const results = [];
  for (let index = 0; index < candidates.length; index += 1) {
    results.push(await verifyPublicSocialPostCandidate(company, platform, candidates[index]));
    if (platform === "linkedin" && requestDelayMs > 0 && index < candidates.length - 1) {
      await delay(requestDelayMs);
    }
  }
  return results;
}

function firstSocialCandidatePerUrl(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function socialDiscoveryQueries(company, platform, entity = null) {
  const platformLabel =
    platform === "x" ? "X" : platform === "instagram" ? "Instagram" : platform === "linkedin" ? "LinkedIn" : platform;
  const site =
    platform === "x"
      ? "site:x.com OR site:twitter.com"
      : platform === "instagram"
        ? "site:instagram.com"
        : "site:linkedin.com/company OR site:linkedin.com/in";
  const batchQueries = currentBatchContext.searchAliases.map(
    (alias) => `"${company.name}" "${alias}" ${platformLabel}`
  );
  const baseQueries = [
    `"${company.name}" "${currentBatchContext.organization}" ${platformLabel}`,
    ...batchQueries,
    `"${company.name}" ${site}`,
    `"${company.name}" "startup" ${platformLabel}`
  ];

  const entityQueries = socialEntityQueries(company, platform, entity, platformLabel);

  if (platform === "instagram") {
    return [
      ...entityQueries,
      ...baseQueries,
      `"${company.name}" site:instagram.com/reel`,
      `"${company.name}" site:instagram.com/p`,
      `"${company.name}" "Instagram photos and videos"`
    ];
  }

  if (platform === "x") {
    return [
      ...entityQueries,
      ...baseQueries,
      `"${company.name}" site:x.com status`,
      `"${company.name}" site:twitter.com status`,
      `"${company.name}" "${currentBatchContext.organization}" "x.com" status`
    ];
  }

  return [...entityQueries, ...baseQueries];
}

function socialEntityQueries(company, platform, entity, platformLabel) {
  const entityNameValue = String(entity?.name ?? "").trim();
  if (!entityNameValue || entityNameValue.toLowerCase() === company.name.toLowerCase()) {
    return [];
  }

  const entityNames = [...new Set([
    entityNameValue,
    socialProfileNameAlias(entity?.socialLinks?.[platform], platform)
  ].filter(Boolean))];
  const queries = [];
  for (const entityName of entityNames) {
    if (platform === "linkedin") {
      queries.push(`"${entityName}" "${company.name}" site:linkedin.com/posts`);
    }
    queries.push(`"${entityName}" "${company.name}" ${platformLabel}`);
    queries.push(
      `"${entityName}" "${company.name}" site:${platform === "x" ? "x.com" : platform === "instagram" ? "instagram.com" : "linkedin.com"}`
    );
    if (platform === "x") {
      queries.push(`"${entityName}" "${company.name}" site:x.com status`);
    }
    if (platform === "instagram") {
      queries.push(`"${entityName}" "${company.name}" site:instagram.com/reel`);
      queries.push(`"${entityName}" "${company.name}" site:instagram.com/p`);
    }
  }

  return [...new Set(queries)];
}

function socialProfileNameAlias(rawUrl, platform) {
  if (!rawUrl || platform !== "linkedin") return null;
  try {
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() !== "in" || !parts[1]) return null;
    const words = decodeURIComponent(parts[1])
      .split(/[-_]+/)
      .filter((word) => /^[a-z]+$/i.test(word));
    return words.length >= 2 ? words.join(" ") : null;
  } catch {
    return null;
  }
}

function isLowValueSocialUrl(url, platform) {
  if (platform === "instagram") return /\/(p|reel|tv)\/[^/]+\/(?:liked_by|comments)\/?$/i.test(url);
  if (platform === "x") return /\/(intent|share|search)(\/|$)/i.test(url);
  if (platform === "linkedin") return /\/shareArticle\b|\/jobs\b|\/learning\b/i.test(url);
  return false;
}

function dedupeProductHuntLinks(links) {
  return [
    ...new Map(
      links
        .map((link) => ({ ...link, url: normalizeSearchUrl(link.url).replace(/[?#].*$/, "") }))
        .filter((link) => /^https:\/\/www\.producthunt\.com\/(products|posts)\//i.test(link.url))
        .filter((link) => !/\/(?:reviews|alternatives)\b|\/products\/lovable\b/i.test(link.url))
        .map((link) => [link.url, link])
    ).values()
  ];
}

async function verifyProductHuntLink(company, link) {
  const page = await fetchReader(link.url).catch(() => null);
  if (!page || isBlocked(page.text)) return { needsReview: link };

  const verification = productHuntVerification(company, link, page);
  const verified = verification.verified;
  if (!verified) {
    if (/title did not match company name/i.test(verification.reason ?? "")) {
      return {};
    }

    return {
      needsReview: {
        ...link,
        reason: verification.reason
      }
    };
  }

  const metrics = {
    upvotes: parseNearbyMetric(page.text, "upvotes", /(\d[\d,]*)\s+upvotes?/i),
    comments: parseNearbyMetric(page.text, "comments", /(\d[\d,]*)\s+comments?/i)
  };

  return {
    evidence: evidenceItem({
      company,
      entityType: "company",
      entityId: companyId(company),
      platform: "product_hunt",
      sourceUrl: link.url,
      title: page.title || link.text || company.name,
      text: firstUsefulText(page.text) || page.title || link.text || company.name,
      rawVisibleText: page.text,
      metrics,
      contributionScore: scoreMetrics("product_hunt", metrics),
      review_state: "verified",
      matchReason: `Verified public Product Hunt page: ${verification.reason}.`
    })
  };
}

function productHuntVerification(company, link, page) {
  const title = page.title || link.text || "";
  const combined = `${title} ${page.text}`;
  const titleMatches = productHuntTitleMatches(company, title);
  if (!titleMatches) {
    return { verified: false, reason: "title did not match company name" };
  }

  if (companyDomainMentioned(company, combined)) {
    return { verified: true, reason: "title matched and official company domain appeared on the Product Hunt page" };
  }

  if (productHuntSlugMatchesCompany(company, link.url)) {
    return { verified: true, reason: "title matched and Product Hunt slug matched the company name" };
  }

  if (founderNameMentioned(company, combined)) {
    return { verified: true, reason: "title matched and a batch-listed founder name appeared on the Product Hunt page" };
  }

  const tokenMatches = companyDescriptorTokenMatches(company, combined);
  if (tokenMatches >= 3) {
    return { verified: true, reason: `title matched and ${tokenMatches} company descriptor tokens appeared on the Product Hunt page` };
  }

  return { verified: false, reason: "title matched, but no official domain, founder, slug, or descriptor corroboration appeared" };
}

function productHuntTitleMatches(company, title) {
  const normalizedTitle = cleanText(title)
    .toLowerCase()
    .replace(/\s*\|\s*product hunt.*$/i, "");
  const normalizedName = company.name.toLowerCase();
  if (normalizedName.length <= 3) {
    return new RegExp(`(^|\\W)${escapeRegExp(normalizedName)}(\\W|$)`, "i").test(normalizedTitle);
  }
  return normalizedTitle.includes(normalizedName);
}

function productHuntSlugMatchesCompany(company, rawUrl) {
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    const lastSegment = path.split("/").filter(Boolean).at(-1) ?? "";
    const companySlug = slugify(company.name);
    const ycSlug = slugify(company.slug ?? "");
    if (!lastSegment || companySlug.length < 4) return false;
    return lastSegment === companySlug || lastSegment === ycSlug;
  } catch {
    return false;
  }
}

function companyDescriptorTokenMatches(company, text) {
  const lower = cleanText(text).toLowerCase();
  const tokens = new Set(
    `${company.tagline ?? ""} ${company.description ?? ""} ${(company.industries ?? []).join(" ")}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5)
      .filter((token) => !COMMON_DESCRIPTOR_TOKENS.has(token))
  );
  return [...tokens].filter((token) => lower.includes(token)).length;
}

function productHuntCandidateMatches(company, link) {
  const haystack = cleanText(`${link.text ?? ""} ${link.url ?? ""}`).toLowerCase();
  const normalizedName = company.name.toLowerCase();
  const slugTokens = new Set([
    ...slugify(company.name).split("-"),
    ...slugify(company.slug ?? "").split("-")
  ].filter((token) => token.length >= 3));

  if (normalizedName.length <= 3) {
    return new RegExp(`(^|\\W)${escapeRegExp(normalizedName)}(\\W|$)`, "i").test(haystack);
  }

  if (haystack.includes(normalizedName) || haystack.includes(slugify(company.name))) {
    return true;
  }

  const matchedTokens = [...slugTokens].filter((token) => haystack.includes(token)).length;
  return matchedTokens >= Math.min(2, slugTokens.size);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ingestNewsWeb(company) {
  const query = `"${company.name}" ${currentBatchContext.organization} (news OR launch OR funding OR review)`;
  const url = `https://duckduckgo.com/html/?df=w&q=${encodeURIComponent(query)}`;
  const { text: html } = await fetchPublicSearchText(url);
  const $ = cheerio.load(html);
  const duckDuckGoResults = $(".result")
    .toArray()
    .map((node) => {
      const item = $(node);
      return {
        title: cleanText(item.find(".result__title").text()),
        sourceUrl: item.find(".result__a").attr("href") ?? "",
        snippet: cleanText(item.find(".result__snippet").text()),
        publishedDate: null,
        discoveryProvider: "duckduckgo"
      };
    })
    .map((item) => ({ ...item, sourceUrl: normalizeSearchUrl(item.sourceUrl) }));
  const exaResults = await searchExaSourceCandidates({
    query,
    platform: "web",
    apiKey: exaApiKey,
    numResults: 8
  }).catch(() => []);
  const candidates = dedupeNewsCandidates([
    ...exaResults.map((item) => ({ ...item, sourceUrl: normalizeSearchUrl(String(item.url ?? "")) })),
    ...duckDuckGoResults
  ])
    .filter((item) => item.sourceUrl && isCompanyMatch(company, `${item.title} ${item.snippet}`))
    .filter((item) => isThirdPartyMention(company, item.sourceUrl))
    .slice(0, 8);
  const enriched = await Promise.all(candidates.map((item, index) =>
    index < 3 ? enrichNewsCandidate(item) : Promise.resolve(newsCandidateWithSearchMetadata(item))
  ));
  const results = enriched.filter(Boolean);

  if (!results.length) {
    return { failures: [failure("web", company, url, "No verified public web/news mention found.")] };
  }

  return {
    evidence: results.map((item) =>
      evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "web",
        sourceUrl: item.sourceUrl,
        platformPostId: item.sourceUrl,
        title: item.title,
        text: item.snippet || item.title,
        rawVisibleText: `${item.title}\n${item.snippet}`,
        authorName: item.authorName,
        postedAt: item.publication.postedAt,
        publishedAtPrecision: item.publication.publishedAtPrecision,
        mediaType: "link",
        thumbnailUrl: item.thumbnailUrl,
        linkStatus: item.linkStatus,
        metrics: {},
        contributionScore: 0,
        review_state: "verified",
        matchReason: `Public web/news result with exact company-name match from ${item.discoveryProvider}. ` +
          `${item.publication.publishedAtPrecision === "unknown" ? "No auditable publication date was exposed; excluded from the 72-hour brief." : "The publisher exposed an auditable publication date."} ` +
          "Stored as context only because no public engagement metrics were available."
      })
    )
  };
}

function dedupeNewsCandidates(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (!item.sourceUrl) continue;
    const key = normalizeSearchUrl(item.sourceUrl);
    if (!key || byUrl.has(key)) continue;
    byUrl.set(key, { ...item, sourceUrl: key });
  }
  return [...byUrl.values()];
}

async function enrichNewsCandidate(item) {
  const searchOnly = newsCandidateWithSearchMetadata(item);
  try {
    const page = await fetchReadable(item.sourceUrl);
    const metadata = newsPageMetadata(page.html);
    return {
      ...searchOnly,
      title: metadata.title || item.title,
      snippet: metadata.description || item.snippet,
      authorName: metadata.authorName,
      thumbnailUrl: metadata.thumbnailUrl,
      publication: metadata.publication.publishedAtPrecision === "unknown"
        ? searchOnly.publication
        : metadata.publication,
      linkStatus: "verified"
    };
  } catch {
    return searchOnly;
  }
}

function newsCandidateWithSearchMetadata(item) {
  return {
    ...item,
    authorName: null,
    thumbnailUrl: null,
    publication: normalizeNewsPublicationDate(item.publishedDate),
    linkStatus: "unchecked"
  };
}

function newsPageMetadata(html) {
  const $ = cheerio.load(html);
  const jsonLd = $("script[type='application/ld+json']")
    .toArray()
    .flatMap((element) => parsedJsonLdNodes($(element).text()));
  const firstJsonLdValue = (key) => jsonLd.map((node) => node?.[key]).find(Boolean) ?? null;
  const rawPublication = firstNonEmpty([
    $("meta[property='article:published_time']").attr("content"),
    $("meta[name='date']").attr("content"),
    $("meta[name='pubdate']").attr("content"),
    $("time[datetime]").first().attr("datetime"),
    firstJsonLdValue("datePublished")
  ]);
  const jsonLdAuthor = firstJsonLdValue("author");
  const jsonLdImage = firstJsonLdValue("image");
  return {
    title: cleanText(firstNonEmpty([
      $("meta[property='og:title']").attr("content"),
      firstJsonLdValue("headline"),
      $("title").first().text(),
      $("h1").first().text()
    ])),
    description: cleanText(firstNonEmpty([
      $("meta[property='og:description']").attr("content"),
      $("meta[name='description']").attr("content"),
      firstJsonLdValue("description")
    ])),
    authorName: cleanText(
      typeof jsonLdAuthor === "string"
        ? jsonLdAuthor
        : Array.isArray(jsonLdAuthor)
          ? jsonLdAuthor.map((author) => author?.name).filter(Boolean).join(", ")
          : jsonLdAuthor?.name ?? $("meta[name='author']").attr("content") ?? ""
    ) || null,
    thumbnailUrl: firstImageUrl(
      $("meta[property='og:image']").attr("content") ?? jsonLdImage
    ),
    publication: normalizeNewsPublicationDate(rawPublication)
  };
}

function parsedJsonLdNodes(value) {
  try {
    const parsed = JSON.parse(value);
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    return roots.flatMap((root) => Array.isArray(root?.["@graph"]) ? root["@graph"] : [root]);
  } catch {
    return [];
  }
}

function normalizeNewsPublicationDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { postedAt: null, publishedAtPrecision: "unknown" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const timestamp = Date.parse(`${raw}T12:00:00.000Z`);
    return Number.isFinite(timestamp)
      ? { postedAt: raw, publishedAtPrecision: "day" }
      : { postedAt: null, publishedAtPrecision: "unknown" };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    const timestamp = Date.parse(raw);
    return Number.isFinite(timestamp)
      ? { postedAt: new Date(timestamp).toISOString(), publishedAtPrecision: "exact" }
      : { postedAt: null, publishedAtPrecision: "unknown" };
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || /\d{1,2}:\d{2}/.test(raw)) {
    return { postedAt: null, publishedAtPrecision: "unknown" };
  }
  return { postedAt: new Date(timestamp).toISOString().slice(0, 10), publishedAtPrecision: "day" };
}

function firstNonEmpty(values) {
  return values.map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
}

function firstImageUrl(value) {
  const candidate = Array.isArray(value)
    ? value[0]
    : typeof value === "object" && value
      ? value.url ?? value.contentUrl
      : value;
  try {
    const url = new URL(String(candidate ?? ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function ingestReddit(company) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(`${company.name} ${currentBatchContext.organization}`)}&limit=5&raw_json=1`;
  if (redditPublicRunBlocker) {
    return redditProviderBlockedResult(company, url, redditPublicRunBlocker);
  }
  try {
    const { response, text } = await fetchPublicBoundedText(url, { accept: "application/json" });
    if (!response.ok) {
      const accessMessage = [401, 403, 429].includes(response.status)
        ? "Reddit public access blocked"
        : "Reddit public search JSON failed";
      if ([401, 403, 429].includes(response.status)) {
        const message = `${accessMessage}: HTTP ${response.status}.`;
        redditPublicRunBlocker ??= redditPublicBlocker(response.status, message);
        return redditProviderBlockedResult(company, url, redditPublicRunBlocker);
      }
      throw new Error(`${accessMessage}: HTTP ${response.status}.`);
    }
    const data = parsePublicJson(text, url);
    const posts = (data.data?.children ?? [])
      .map((child) => child.data)
      .filter((post) => isCompanyMatch(company, `${post.title ?? ""} ${post.selftext ?? ""}`))
      .slice(0, 3);

    if (!posts.length) {
      return { failures: [failure("reddit", company, url, "No verified public Reddit matches.")] };
    }

    return {
      evidence: posts.map((post) =>
        evidenceItem({
          company,
          entityType: "company",
          entityId: companyId(company),
          platform: "reddit",
          sourceUrl: `https://www.reddit.com${post.permalink}`,
          title: post.title,
          text: post.selftext || post.title,
          rawVisibleText: JSON.stringify(post),
          postedAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
          metrics: {
            upvotes: numberOrNull(post.ups),
            comments: numberOrNull(post.num_comments)
          },
          contributionScore: scoreMetrics("reddit", {
            upvotes: numberOrNull(post.ups),
            comments: numberOrNull(post.num_comments)
          }),
          review_state: "verified",
          matchReason: "Exact company-name match in public Reddit search JSON."
        })
      )
    };
  } catch (error) {
    const page = await fetchReader(
      `https://www.reddit.com/search/?q=${encodeURIComponent(`${company.name} ${currentBatchContext.organization}`)}`
    ).catch(() => null);
    return {
      failures: [
        failure(
          "reddit",
          company,
          url,
          page && isBlocked(page.text) ? "Reddit public access blocked by network security/login wall." : errorMessage(error)
        )
      ]
    };
  }
}

async function ingestSocialProfile(company, entity, entityType, platform, url) {
  let directXFailures = [];
  let directXCoverageReceipt = null;
  if (platform === "x") {
    const apiEvidence = xApiEvidenceForAccount(company, entity, entityType, url);
    const publicProfileResult = await ingestXPublicProfile(
      company,
      entity,
      entityType,
      url
    );
    directXFailures = publicProfileResult?.failures ?? [];
    directXCoverageReceipt = publicProfileResult?.coverageReceipt ?? null;
    const mergedEvidence = mergeXNativeEvidence(
      publicProfileResult?.evidence ?? [],
      apiEvidence
    );
    if (mergedEvidence.length || publicProfileResult?.receipt?.verified === true) {
      const publicProfileVerified = publicProfileResult?.receipt?.verified === true;
      return {
        ...(publicProfileResult ?? {}),
        evidence: mergedEvidence,
        failures: directXFailures,
        needsReview: publicProfileResult?.needsReview ?? [],
        source: publicProfileVerified && apiEvidence.length
          ? "x_public_profile_schema_org+x_recent_search_api"
          : publicProfileVerified
            ? publicProfileResult.source
            : "x_recent_search_api",
        mergeOnly: true
      };
    }
  }

  if (platform === "instagram") {
    const publicProfileResult = await ingestInstagramPublicProfile(
      company,
      entity,
      entityType,
      url
    );
    if (publicProfileResult) return publicProfileResult;
  }

  let linkedInPublicSurface = null;
  let linkedInPublicSurfaceError = null;
  if (platform === "linkedin") {
    try {
      linkedInPublicSurface = await fetchLinkedInPublicProfileSurface(url);
    } catch (error) {
      linkedInPublicSurfaceError = error;
    }
  }
  if (linkedInPublicSurfaceError) {
    const providerBlocker = linkedinPublicBlockerFromError(linkedInPublicSurfaceError);
    const fallback = discoverMissingSocial
      ? await discoverAndVerifyPublicSocialPosts(
          company,
          platform,
          url,
          "Batch-linked LinkedIn profile retrieval failed, so public post-search fallback was attempted.",
          entity,
          entityType
        )
      : { evidence: [], needsReview: [], failures: [], sourceDiscoveryPaths: [] };
    const profileFailure = {
      ...failure(
        platform,
        company,
        url,
        providerBlocker
          ? `LinkedIn public profile verification was blocked: ${providerBlocker.message}`
          : `LinkedIn public profile request failed: ${errorMessage(linkedInPublicSurfaceError)}`,
        entityType,
        entityName(entity, entityType),
        entityIdFor(company, entity, entityType)
      ),
      ...(providerBlocker
        ? { retryable: !providerBlocker.retryAt, blocker: providerBlocker }
        : { retryable: true })
    };
    return {
      evidence: fallback.evidence,
      needsReview: fallback.needsReview,
      failures: [profileFailure, ...(fallback.failures ?? [])],
      sourceDiscoveryPaths: fallback.sourceDiscoveryPaths,
      mergeOnly: true
    };
  }
  let page;
  try {
    page = linkedInPublicSurface?.verified
      ? {
          html: "",
          title: linkedInPublicSurface.title,
          text: cleanText([
            linkedInPublicSurface.title,
            linkedInPublicSurface.description,
            ...linkedInPublicSurface.postCandidates.map((candidate) => candidate.url)
          ].filter(Boolean).join("\n"))
        }
      : platform === "x" && directXCoverageReceipt
        ? await fetchXPublicReaderFallback(url)
        : platform === "linkedin" && linkedInPublicSurface?.readablePage
          ? linkedInPublicSurface.readablePage
        : await fetchReader(url);
  } catch (error) {
    if (platform !== "x" || !directXCoverageReceipt) throw error;
    const readerMessage = `X public-reader fallback failed: ${errorMessage(error)}`;
    const verificationNeedsReview = /(?:identity_mismatch|no_exact_owner_social_media_postings|x_public_profile_http_404)/.test(
      directXCoverageReceipt.reason ?? ""
    );
    return {
      evidence: [],
      needsReview: verificationNeedsReview
        ? [reviewCandidate(
            company,
            "x",
            url,
            `${directXFailures[0]?.message ?? "Anonymous X profile verification failed."} ${readerMessage}`,
            entityType,
            entityIdFor(company, entity, entityType),
            entityName(entity, entityType)
          )]
        : [],
      failures: [
        ...directXFailures,
        failure(
          "x",
          company,
          url,
          readerMessage,
          entityType,
          entityName(entity, entityType),
          entityIdFor(company, entity, entityType)
        )
      ],
      coverageReceipt: directXCoverageReceipt,
      source: "x_public_profile_schema_org+x_public_reader_fallback",
      mergeOnly: true
    };
  }
  if (isBlocked(page.text, { platform, url })) {
    const fallback = discoverMissingSocial
      ? await discoverAndVerifyPublicSocialPosts(
          company,
          platform,
          url,
          `Batch-linked ${platform} profile was blocked/login-walled, so public post-search fallback was attempted.`,
          entity,
          entityType
        )
      : { evidence: [], needsReview: [], failures: [], sourceDiscoveryPaths: [] };
    return {
      evidence: fallback.evidence,
      needsReview: fallback.needsReview,
      failures: [
        ...directXFailures,
        failure(
          platform,
          company,
          url,
          "Public page blocked or login-walled.",
          entityType,
          entityName(entity, entityType),
          entityIdFor(company, entity, entityType)
        ),
        ...(fallback.failures ?? [])
      ],
      sourceDiscoveryPaths: fallback.sourceDiscoveryPaths,
      ...(directXCoverageReceipt ? { coverageReceipt: directXCoverageReceipt } : {}),
      mergeOnly: true
    };
  }

  const name = entityName(entity, entityType);
  const linkedInProfileAlias = socialProfileNameAlias(url, platform);
  const visibleProfileIdentity = cleanText(`${page.title}\n${page.text}`).toLowerCase();
  const verified =
    linkedInPublicSurface?.verified === true ||
    isCompanyMatch({ name, websiteUrl: company.websiteUrl }, page.text) ||
    page.title.toLowerCase().includes(name.toLowerCase()) ||
    Boolean(
      linkedInProfileAlias &&
      visibleProfileIdentity.includes(linkedInProfileAlias.toLowerCase())
    );
  const metrics = platform === "linkedin" && linkedInPublicSurface?.followers != null
    ? { followers: linkedInPublicSurface.followers }
    : metricsFromPublicProfile(platform, page.text, page.title);

  if (!verified) {
    return {
      evidence: [],
      failures: directXFailures,
      needsReview: [
        reviewCandidate(
          company,
          platform,
          url,
          `Public ${platform} page was readable but did not clearly match ${name}.`,
          entityType,
          entityIdFor(company, entity, entityType),
          name
        )
      ],
      ...(directXCoverageReceipt ? { coverageReceipt: directXCoverageReceipt } : {})
    };
  }

  const directLinkedInCandidates = linkedInPublicSurface?.verified
    ? linkedInPublicSurface.postCandidates.map((candidate) => ({
        query: `${company.name} LinkedIn public profile native posts`,
        searchUrl: url,
        title: candidate.title || company.name,
        snippet: linkedInPublicSurface.description,
        url: candidate.url,
        accountUrl: url,
        source: "linkedin_public_profile_html"
      }))
    : [];
  const profilePostCandidates = selectPublicSocialCandidates(
    dedupeSocialCandidates([
      ...directLinkedInCandidates,
      ...extractSocialPostCandidates(page.text, platform, company)
    ], platform),
    platform,
    3
  );
  const postResults = await verifyPublicSocialPostCandidates(company, platform, profilePostCandidates);
  const postEvidence = postResults.flatMap((result) => result.evidence ?? []);
  const attributedPosts = attributePostEvidenceToEntity(company, entity, entityType, platform, postEvidence);
  const zeroPostFallback =
    platform === "linkedin" && attributedPosts.evidence.length === 0 && discoverMissingSocial
      ? await discoverAndVerifyPublicSocialPosts(
          company,
          platform,
          url,
          "Batch-linked LinkedIn profile was readable but exposed no verified native posts, so public post-search fallback was attempted.",
          entity,
          entityType
        )
      : { evidence: [], needsReview: [], failures: [], sourceDiscoveryPaths: [] };
  const postNeedsReview = [
    ...postResults.flatMap((result) => result.needsReview ?? []),
    ...attributedPosts.needsReview,
    ...zeroPostFallback.needsReview
  ];
  const directXVerificationNeedsReview =
    platform === "x" &&
    directXCoverageReceipt?.verified === false &&
    /(?:identity_mismatch|no_exact_owner_social_media_postings|x_public_profile_http_404)/.test(
      directXCoverageReceipt.reason ?? ""
    )
      ? [reviewCandidate(
          company,
          "x",
          url,
          directXFailures[0]?.message ??
            "Anonymous X profile did not expose an exact native owner post.",
          entityType,
          entityIdFor(company, entity, entityType),
          entityName(entity, entityType)
        )]
      : [];

  return {
    evidence: [
      ...(platform === "x" && directXCoverageReceipt?.verified === false
        ? []
        : [evidenceItem({
            company,
            entityType,
            entityId: entityIdFor(company, entity, entityType),
            platform,
            sourceUrl: url,
            title: page.title || name,
            text: socialProfileSummary(platform, page.text, page.title || name),
            rawVisibleText: page.text,
            metrics,
            contributionScore: 0,
            review_state: "verified",
            matchReason: `Verified public ${platform} profile readable without login. Stored as identity context only; profile followers are not counted as post traction.`
          })]),
      ...attributedPosts.evidence,
      ...zeroPostFallback.evidence
    ],
    needsReview: [...postNeedsReview, ...directXVerificationNeedsReview],
    failures: [
      ...directXFailures,
      ...postResults.flatMap((result) => result.failures ?? []),
      ...(zeroPostFallback.failures ?? [])
    ],
    sourceDiscoveryPaths: zeroPostFallback.sourceDiscoveryPaths,
    ...(directXCoverageReceipt ? { coverageReceipt: directXCoverageReceipt } : {}),
    // Public social surfaces and search responses are bounded windows, not
    // authoritative full-history snapshots. Always merge so a shallow refresh
    // cannot delete previously recovered native posts.
    mergeOnly: true
  };
}

async function ingestXPublicProfile(company, entity, entityType, accountUrl) {
  const handle = xUsernameFromUrl(accountUrl);
  if (!handle) return null;

  let response;
  let html;
  try {
    ({ response, text: html } = await fetchPublicBoundedText(accountUrl, {
      maxResponseBytes: HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
      maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
    }));
  } catch (error) {
    return xPublicProfileFailureResult(
      company,
      entity,
      entityType,
      accountUrl,
      `Anonymous X public profile request failed: ${errorMessage(error)}`,
      { reason: "x_public_profile_request_failed", handle }
    );
  }
  if (!response.ok) {
    if ([403, 429].includes(response.status)) {
      const cooldownMs = response.status === 429 ? 30 * 60_000 : 10 * 60_000;
      const cooldownError = new Error(
        `Anonymous X public profile returned HTTP ${response.status}.`
      );
      cooldownError.platformCooldownUntil = Date.now() + cooldownMs;
      cooldownError.platformCooldownReason = `x_public_profile_http_${response.status}`;
      recordPlatformCooldownIfNeeded("x", cooldownError);
    }
    return xPublicProfileFailureResult(
      company,
      entity,
      entityType,
      accountUrl,
      `Anonymous X public profile returned HTTP ${response.status}.`,
      { reason: `x_public_profile_http_${response.status}`, handle }
    );
  }

  const receipt = extractXPublicProfileReceipt({
    html,
    accountUrl,
    requestedHandle: handle,
    fetchedAt: new Date().toISOString(),
    limit: 100
  });
  if (!receipt.verified) {
    return xPublicProfileFailureResult(
      company,
      entity,
      entityType,
      accountUrl,
      `Anonymous X public profile verification failed: ${receipt.reason}.`,
      receipt
    );
  }

  const entityId = entityIdFor(company, entity, entityType);
  const name = entityName(entity, entityType);
  const receiptSummary = {
    source: "x_public_profile_schema_org_v1",
    accountUrl: receipt.accountUrl,
    handle: receipt.handle,
    fetchedAt: receipt.fetchedAt,
    surfacePostCount: receipt.surfacePostCount,
    exactOwnerPostCount: receipt.exactOwnerPostCount,
    returnedPostCount: receipt.returnedPostCount,
    rejectedPostCount: receipt.rejectedPostCount,
    truncated: receipt.truncated,
    parserCapTruncated: receipt.truncated,
    sourceWindow: "first_server_rendered_profile_page",
    sourceExhausted: false
  };
  const evidence = receipt.posts.map((post) => {
    const nativePostedAt = exactEvidenceTimestamp(post.postedAt);
    const metrics = removeNullish(post.metrics ?? {});
    const postReceipt = {
      id: post.id,
      url: post.url,
      authorHandle: post.authorHandle,
      authorName: post.authorName,
      text: post.text,
      postedAt: nativePostedAt,
      metrics,
      mediaUrlCount: Array.isArray(post.mediaUrls) ? post.mediaUrls.length : 0,
      quotedPostUrl: post.quotedPostUrl,
      isQuote: post.isQuote
    };
    return evidenceItem({
      company,
      entityType,
      entityId,
      platform: "x",
      sourceUrl: post.url,
      platformPostId: post.id,
      authorHandle: post.authorHandle,
      title: firstUsefulText(post.text) ?? `${name} on X`,
      text: post.text,
      rawVisibleText: JSON.stringify({ receipt: receiptSummary, post: postReceipt }),
      postedAt: nativePostedAt,
      publishedAtPrecision: nativePostedAt ? "exact" : "unknown",
      metrics,
      mediaUrls: post.mediaUrls,
      contributionScore: scoreMetrics("x", metrics),
      review_state: "verified",
      attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
      attributionStatus: "verified",
      attributionProvenance: "x_public_profile_schema_org_exact_owner_v1",
      matchReason:
        `Anonymous server-rendered X profile Schema.org data exposed this native post on the exact mapped @${receipt.handle} profile; ` +
        `native author=@${post.authorHandle}, native status URL owner=@${post.urlHandle}. ` +
        `The first public profile page exposed ${receipt.surfacePostCount} post surfaces, retained ${receipt.exactOwnerPostCount} exact-owner posts, ` +
        `rejected ${receipt.rejectedPostCount} foreign or invalid nested posts, and returned ${receipt.returnedPostCount}; truncated=${receipt.truncated}.` +
        " This is one bounded server-rendered profile page, not proof of historical exhaustion." +
        (post.isQuote ? ` The exact-owner wrapper quotes ${post.quotedPostUrl}.` : "")
    });
  });

  return {
    evidence,
    needsReview: [],
    failures: [],
    source: "x_public_profile_schema_org",
    mergeOnly: true,
    receipt: { ...receiptSummary, verified: true },
    coverageReceipt: {
      ...receiptSummary,
      verified: true,
      outcome: "collected_exact_owner_posts"
    }
  };
}

function xPublicProfileFailureResult(
  company,
  entity,
  entityType,
  accountUrl,
  message,
  receipt = {}
) {
  return {
    evidence: [],
    needsReview: [],
    failures: [failure(
      "x",
      company,
      accountUrl,
      message,
      entityType,
      entityName(entity, entityType),
      entityIdFor(company, entity, entityType)
    )],
    source: "x_public_profile_schema_org",
    mergeOnly: true,
    receipt: {
      verified: false,
      accountUrl,
      handle: xUsernameFromUrl(accountUrl),
      fetchedAt: new Date().toISOString(),
      sourceWindow: "first_server_rendered_profile_page",
      sourceExhausted: false,
      ...receipt
    },
    coverageReceipt: {
      verified: false,
      accountUrl,
      handle: xUsernameFromUrl(accountUrl),
      sourceWindow: "first_server_rendered_profile_page",
      sourceExhausted: false,
      reason: receipt.reason ?? "x_public_profile_failure",
      blocker: message
    }
  };
}

function mergeXNativeEvidence(publicProfileEvidence, apiEvidence) {
  const byNativeIdentity = new Map();
  for (const item of [...publicProfileEvidence, ...apiEvidence]) {
    const nativeIdentity = item.platformPostId
      ? `post:${item.platformPostId}`
      : `url:${canonicalProfileUrl(item.sourceUrl, "x")}`;
    const existing = byNativeIdentity.get(nativeIdentity);
    if (!existing) {
      byNativeIdentity.set(nativeIdentity, item);
      continue;
    }

    const metrics = mergeMetricMaximums(existing.metrics, item.metrics);
    const metricReceipt = xNativeMetricReceipt([existing, item], metrics);
    const bothNativeSources = new Set([
      existing.attributionProvenance,
      item.attributionProvenance
    ]).has("x_public_profile_schema_org_exact_owner_v1") &&
      new Set([
        existing.attributionProvenance,
        item.attributionProvenance
      ]).has("x_recent_search_exact_mapped_author_v1");
    const exactPostedAt = [existing, item]
      .filter((candidate) => candidate.publishedAtPrecision === "exact")
      .map((candidate) => exactEvidenceTimestamp(candidate.postedAt))
      .find(Boolean) ?? null;
    const postedAt = exactPostedAt ??
      validEvidenceTimestamp(existing.postedAt) ??
      validEvidenceTimestamp(item.postedAt);
    const publishedAtPrecision = exactPostedAt
      ? "exact"
      : existing.publishedAtPrecision ?? item.publishedAtPrecision ?? "unknown";
    byNativeIdentity.set(nativeIdentity, {
      ...existing,
      metrics,
      contributionScore: scoreMetrics("x", metrics),
      postedAt,
      publishedAtPrecision,
      rawVisibleText: xReconciledRawVisibleText(existing, metricReceipt),
      xMetricReceipt: metricReceipt,
      ...(bothNativeSources
        ? {
            attributionProvenance: "x_public_profile_schema_org+x_recent_search_exact_owner_v1",
            matchReason: `${existing.matchReason} The credentialed X recent-search result independently matched the same native post ID; per-metric maxima were retained.`
          }
        : {}),
      ...(metricReceipt.timestampConflict
        ? {
            contributionScore: 0,
            review_state: "needs_review",
            attributionStatus: "needs_review",
            matchReason: `${existing.matchReason} Conflicting exact native timestamps were observed for the same X post ID; queued for review.`
          }
        : {})
    });
  }
  return [...byNativeIdentity.values()].sort(
    (left, right) => Date.parse(right.postedAt ?? 0) - Date.parse(left.postedAt ?? 0)
  );
}

function mergeMetricMaximums(left = {}, right = {}) {
  const merged = {};
  for (const metric of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const values = [left[metric], right[metric]]
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length) merged[metric] = Math.max(...values);
  }
  return merged;
}

function validEvidenceTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function exactEvidenceTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())
  ) {
    return null;
  }
  return validEvidenceTimestamp(value);
}

function xNativeMetricReceipt(candidates, mergedMetrics) {
  const timestamps = [...new Set(
    candidates.flatMap((item) => [
      item.postedAt,
      ...(item.xMetricReceipt?.observedTimestamps ?? [])
    ]).map(validEvidenceTimestamp).filter(Boolean)
  )].sort();
  const bySource = new Map();
  const sourceObservations = candidates.flatMap((item) => [
    {
      source: item.attributionProvenance,
      checkedAt: item.last_checked_at ?? item.checkedAt,
      postedAt: item.postedAt,
      metrics: item.metrics
    },
    ...(item.xMetricReceipt?.observations ?? [])
  ]);
  for (const item of sourceObservations) {
    const source = String(item.source ?? "unknown_x_native_source");
    const current = bySource.get(source);
    const observation = {
      source,
      checkedAt: validEvidenceTimestamp(item.checkedAt),
      postedAt: validEvidenceTimestamp(item.postedAt),
      metrics: removeNullish(item.metrics ?? {})
    };
    if (!current) {
      bySource.set(source, observation);
      continue;
    }
    bySource.set(source, {
      source,
      checkedAt: latestIsoTimestamp(current.checkedAt, observation.checkedAt),
      postedAt: current.postedAt ?? observation.postedAt,
      metrics: mergeMetricMaximums(current.metrics, observation.metrics)
    });
  }
  return {
    source: "x_native_metric_reconciliation_v1",
    nativePostId: String(candidates[0]?.platformPostId ?? ""),
    mergedMetrics,
    timestampConflict: timestamps.length > 1,
    observedTimestamps: timestamps,
    observations: [...bySource.values()]
      .sort((left, right) => String(left.source).localeCompare(String(right.source)))
      .slice(0, 12)
  };
}

function xReconciledRawVisibleText(primary, metricReceipt) {
  return JSON.stringify({
    source: "x_native_evidence_reconciled_v1",
    primary: {
      id: primary.platformPostId ?? platformPostIdFromUrl("x", primary.sourceUrl),
      sourceUrl: primary.sourceUrl,
      authorHandle: primary.authorHandle,
      title: primary.title,
      text: primary.text,
      postedAt: primary.postedAt,
      attributionProvenance: primary.attributionProvenance
    },
    metricReceipt
  });
}

function latestIsoTimestamp(...values) {
  const timestamps = values
    .map(validEvidenceTimestamp)
    .filter(Boolean)
    .sort();
  return timestamps.at(-1) ?? null;
}

async function ingestInstagramPublicProfile(company, entity, entityType, accountUrl) {
  const request = instagramPublicProfileRequest({ accountUrl });
  const requestedAt = new Date().toISOString();
  let response = null;
  let payloadText = "";
  let profileRequestError = null;
  try {
    ({ response, text: payloadText } = await fetchPublicBoundedText(request.url, {
      headers: request.options.headers,
      redirect: "error",
      maxResponseBytes: HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
      maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
    }));
  } catch (error) {
    profileRequestError = error;
  }
  const completedAt = new Date().toISOString();

  if (response && !response.ok && [401, 403, 429].includes(response.status)) {
    const cooldownMs = response.status === 429 ? 30 * 60_000 : 10 * 60_000;
    const error = new Error(
      `Instagram public profile endpoint returned HTTP ${response.status}.`
    );
    error.platformCooldownUntil = Date.now() + cooldownMs;
    error.platformCooldownReason = `instagram_web_profile_info_http_${response.status}`;
    throw error;
  }

  let profileReceipt = null;
  let profileFailureMessage = null;
  if (!profileRequestError && response?.ok) {
    profileReceipt = parseInstagramPublicProfileResponse({
      payload: payloadText,
      requestedUsername: request.username,
      fetchedAt: completedAt
    });
  } else if (profileRequestError) {
    profileFailureMessage =
      `Instagram public profile request failed: ${errorMessage(profileRequestError)}`;
  } else if (response) {
    profileFailureMessage =
      `Instagram public profile endpoint returned HTTP ${response.status}.`;
  }

  if (profileReceipt && !profileReceipt.verified) {
    if (/_(?:auth_required|challenge|rate_limited)$/.test(profileReceipt.reason ?? "")) {
      const error = new Error(`Instagram public profile endpoint failed: ${profileReceipt.reason}.`);
      error.platformCooldownUntil = Date.now() + 30 * 60_000;
      error.platformCooldownReason = profileReceipt.reason;
      throw error;
    }
    profileFailureMessage =
      `Instagram public profile verification failed: ${profileReceipt.reason}.`;
  }

  let nativeFeedReceipt = null;
  let nativeFeedFailure = null;
  try {
    nativeFeedReceipt = await fetchInstagramNativeFeedMetricReceipt(accountUrl);
  } catch (error) {
    if (profileReceipt?.verified !== true) {
      if (error?.platformCooldownUntil) throw error;
      return null;
    }
    nativeFeedFailure = error;
    recordPlatformCooldownIfNeeded("instagram", error);
  }

  // A non-auth web_profile_info failure is not terminal: Instagram's exact
  // anonymous native feed can remain healthy when that separate asset is
  // unavailable. Only the feed's exact username receipt authorizes fallback.
  const nativeFeedOnly =
    profileReceipt?.verified !== true && nativeFeedReceipt?.verified === true;
  if (profileReceipt?.verified !== true && !nativeFeedOnly) return null;

  const receipt = nativeFeedOnly
    ? instagramProfileReceiptFromNativeFeed(nativeFeedReceipt)
    : overlayInstagramNativeFeedMetrics(profileReceipt, nativeFeedReceipt);

  const collectionFailures = [];
  const profileFallbackDiagnostic = nativeFeedOnly && profileFailureMessage
    ? profileFailureMessage
    : null;
  if (nativeFeedFailure) {
    collectionFailures.push(failure(
      "instagram",
      company,
      accountUrl,
      `Instagram native-feed enrichment failed; verified profile rows were preserved: ${errorMessage(nativeFeedFailure)}`,
      entityType,
      entityName(entity, entityType),
      entityIdFor(company, entity, entityType)
    ));
  }
  if (nativeFeedReceipt?.paginationFailureMessage) {
    collectionFailures.push(failure(
      "instagram",
      company,
      accountUrl,
      `Instagram native-feed pagination was interrupted after verified rows; partial rows were preserved: ${nativeFeedReceipt.paginationFailureMessage}`,
      entityType,
      entityName(entity, entityType),
      entityIdFor(company, entity, entityType)
    ));
  }

  const entityId = entityIdFor(company, entity, entityType);
  const name = entityName(entity, entityType);
  const receiptSummary = {
    source: nativeFeedOnly
      ? "instagram_anonymous_native_feed_standalone_v1"
      : receipt.nativeFeedOverlayCount > 0 || receipt.nativeFeedAddedPostCount > 0
        ? "instagram_public_web_profile_info_with_native_feed_metrics_v1"
        : "instagram_public_web_profile_info_v1",
    username: receipt.username,
    accountUrl: receipt.accountUrl,
    fetchedAt: receipt.fetchedAt,
    totalCount: receipt.totalCount,
    receivedEdgeCount: receipt.receivedEdgeCount,
    processedEdgeCount: receipt.processedEdgeCount,
    duplicateEdgeCount: receipt.duplicateEdgeCount,
    truncated: receipt.truncated,
    hasNextPage: receipt.pageInfo?.hasNextPage === true,
    ...(profileFallbackDiagnostic ? { profileFallbackDiagnostic } : {}),
    ...(receipt.nativeFeedReceipt
      ? { nativeFeed: receipt.nativeFeedReceipt }
      : {})
  };
  const rowRecords = receipt.posts.map((post) => {
    // Both verified Instagram parsers derive this value from the native epoch
    // field and emit canonical ISO. Keep invalid or absent values fail-closed;
    // never infer an exact publication instant from display text.
    const nativePostedAt = exactEvidenceTimestamp(post.postedAt);
    const postReceipt = {
      shortcode: post.shortcode,
      url: post.url,
      mediaType: post.mediaType,
      authorUsername: post.authorUsername,
      coauthorUsernames: post.coauthorUsernames,
      profileRole: post.profileRole,
      caption: post.caption,
      postedAt: nativePostedAt,
      metrics: post.metrics,
      ...(post.nativeFeedMetrics
        ? {
            nativeFeedMetrics: post.nativeFeedMetrics,
            nativeFeedMetricSource: post.nativeFeedMetricSource,
            nativeFeedOnly: post.nativeFeedOnly === true
          }
        : {}),
      mediaUrlCount: Array.isArray(post.mediaUrls) ? post.mediaUrls.length : 0
    };
    const metrics = removeNullish(instagramEvidenceMetrics(post));
    const caption = cleanText(post.caption) || `${name} Instagram ${post.mediaType}`;
    const accepted = post.profileRole === "primary";
    const roleDisposition = accepted
      ? "Exact primary author matches the mapped profile."
      : post.profileRole === "coauthor"
        ? "The mapped profile is a declared coauthor, not the native primary author; queued for review and excluded from scored evidence."
        : "The post appeared on the profile surface without native owner or coauthor proof; queued for review and excluded from scored evidence.";
    const row = evidenceItem({
      company,
      entityType,
      entityId,
      platform: "instagram",
      sourceUrl: post.url,
      platformPostId: post.shortcode,
      authorHandle: post.authorUsername,
      title: caption,
      text: caption,
      // Media URLs remain available in the evidence row, but excluding them
      // from the embedded receipt keeps carousel provenance valid JSON after
      // the canonical 6 KB raw-text cap.
      rawVisibleText: JSON.stringify({ receipt: receiptSummary, post: postReceipt }),
      postedAt: nativePostedAt,
      publishedAtPrecision: nativePostedAt ? "exact" : "unknown",
      metrics,
      mediaUrls: post.mediaUrls,
      contributionScore: accepted ? scoreMetrics("instagram", metrics) : 0,
      review_state: accepted ? "verified" : "needs_review",
      attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
      attributionStatus: accepted ? "verified" : "needs_review",
      attributionProvenance: post.nativeFeedOnly
        ? "instagram_anonymous_native_feed_native_owner_v1"
        : "instagram_public_web_profile_info_native_owner_v1",
      matchReason: post.nativeFeedOnly
        ? `Anonymous Instagram native feed exposed this post on the exact mapped @${receipt.username} profile; native primary author=@${post.authorUsername}, profileRole=${post.profileRole}. The feed recovered ${receipt.nativeFeedReceipt?.uniqueItemCount ?? 0} unique posts across ${receipt.nativeFeedReceipt?.pageCount ?? 0} page(s); sourceExhausted=${receipt.nativeFeedReceipt?.sourceExhausted === true}. ${roleDisposition}`
        :
          `Anonymous Instagram web_profile_info exposed this post on the exact mapped @${receipt.username} profile; ` +
          `native primary author=@${post.authorUsername}, profileRole=${post.profileRole}. ` +
          `The endpoint returned ${receipt.receivedEdgeCount}/${receipt.totalCount} post rows; truncated=${receipt.truncated}.` +
          (post.nativeFeedMetrics
            ? " Exact anonymous native-feed identity matched this shortcode and supplied its current native metrics."
            : "") +
          ` ${roleDisposition}`
    });
    return {
      accepted,
      row: accepted ? row : { ...row, candidateUrl: row.sourceUrl }
    };
  });
  const recentWindowObservation = recentCoverageCutoff && !nativeFeedOnly
    ? instagramRecentWindowObservation({
        requestUrl: request.url,
        requestedAt,
        completedAt,
        coverageCutoff: recentCoverageCutoff,
        responseBody: payloadText,
        receipt
      })
    : null;
  const nativeFeedVerifiedEmpty =
    nativeFeedOnly &&
    nativeFeedReceipt?.verified === true &&
    nativeFeedReceipt?.sourceExhausted === true &&
    Number(nativeFeedReceipt?.uniqueItemCount ?? nativeFeedReceipt?.posts?.length ?? 0) === 0;
  const nativeFeedEmptyCoverageReceipt = nativeFeedVerifiedEmpty
    ? {
        source: "instagram_anonymous_native_feed_standalone_v1",
        verified: true,
        verifiedEmpty: true,
        username: receipt.username,
        accountUrl: receipt.accountUrl,
        fetchedAt: receipt.fetchedAt,
        sourceExhausted: true,
        uniqueItemCount: 0,
        pageCount: nativeFeedReceipt.pageCount ?? 0,
        outcome: "verified_empty_exact_native_feed"
      }
    : null;

  return {
    evidence: rowRecords.filter((item) => item.accepted).map((item) => item.row),
    needsReview: rowRecords.filter((item) => !item.accepted).map((item) => item.row),
    failures: collectionFailures,
    source: nativeFeedOnly
      ? "instagram_anonymous_native_feed"
      : "instagram_public_web_profile_info",
    mergeOnly: true,
    receipt: receiptSummary,
    ...(nativeFeedVerifiedEmpty ? { verifiedEmpty: true } : {}),
    ...(nativeFeedEmptyCoverageReceipt
      ? { coverageReceipt: nativeFeedEmptyCoverageReceipt }
      : {}),
    ...(recentWindowObservation ? { recentWindowObservation } : {})
  };
}

function instagramProfileReceiptFromNativeFeed(feedReceipt) {
  const observedPostCount =
    feedReceipt.uniqueItemCount ?? feedReceipt.posts?.length ?? 0;
  return {
    ...overlayInstagramNativeFeedMetrics({
      verified: true,
      reason: "instagram_anonymous_native_feed_standalone_profile_verified",
      username: feedReceipt.username,
      accountUrl: feedReceipt.accountUrl,
      fetchedAt: feedReceipt.fetchedAt,
      totalCount: observedPostCount,
      pageInfo: {
        hasNextPage: feedReceipt.sourceExhausted !== true,
        endCursor: feedReceipt.nextMaxId ?? null
      },
      receivedEdgeCount: 0,
      processedEdgeCount: 0,
      duplicateEdgeCount: 0,
      truncated: feedReceipt.truncated === true,
      posts: []
    }, feedReceipt),
    nativeFeedOnlyProfile: true
  };
}

async function fetchInstagramNativeFeedMetricReceipt(accountUrl) {
  const pages = [];
  const seenCursors = new Set();
  const seenShortcodes = new Set();
  let maxId = null;
  const partialReceipt = (reason, message) => ({
    ...mergeInstagramNativeFeedPages(pages, {
      maxItems: instagramNativeFeedMaxItems,
      interruptionReason: reason
    }),
    paginationFailureMessage: message
  });

  for (let pageIndex = 0; pageIndex < instagramNativeFeedMaxPages; pageIndex += 1) {
    const request = instagramNativeFeedRequest({ accountUrl, maxId });
    let response;
    let payloadText;
    try {
      ({ response, text: payloadText } = await fetchPublicBoundedText(request.url, {
        headers: request.options.headers,
        redirect: "error",
        maxResponseBytes: HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
        maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
      }));
    } catch (error) {
      if (pages.length > 0) {
        return partialReceipt(
          "request_failed",
          `page ${pageIndex + 1} request failed: ${errorMessage(error)}`
        );
      }
      throw error;
    }
    const completedAt = new Date().toISOString();

    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) {
        const cooldownMs = response.status === 429 ? 30 * 60_000 : 10 * 60_000;
        const error = new Error(
          `Instagram anonymous native feed returned HTTP ${response.status}.`
        );
        error.platformCooldownUntil = Date.now() + cooldownMs;
        error.platformCooldownReason = `instagram_native_feed_http_${response.status}`;
        if (pages.length > 0) {
          recordPlatformCooldownIfNeeded("instagram", error);
          return partialReceipt(
            `http_${response.status}`,
            `page ${pageIndex + 1} returned HTTP ${response.status}`
          );
        }
        throw error;
      }
      if (pages.length === 0) return null;
      return partialReceipt(
        `http_${response.status}`,
        `page ${pageIndex + 1} returned HTTP ${response.status}`
      );
    }

    const receipt = parseInstagramNativeFeedResponse({
      payload: payloadText,
      requestedUsername: request.username,
      fetchedAt: completedAt
    });
    if (!receipt.verified) {
      if (/_(?:auth_required|challenge|rate_limited)$/.test(receipt.reason ?? "")) {
        const error = new Error(
          `Instagram anonymous native feed failed: ${receipt.reason}.`
        );
        error.platformCooldownUntil = Date.now() + 30 * 60_000;
        error.platformCooldownReason = receipt.reason;
        if (pages.length > 0) {
          recordPlatformCooldownIfNeeded("instagram", error);
          return partialReceipt(
            receipt.reason,
            `page ${pageIndex + 1} failed verification: ${receipt.reason}`
          );
        }
        throw error;
      }
      if (pages.length === 0) return null;
      return partialReceipt(
        receipt.reason,
        `page ${pageIndex + 1} failed verification: ${receipt.reason}`
      );
    }
    pages.push(receipt);
    for (const post of receipt.posts) seenShortcodes.add(post.shortcode);

    if (!receipt.moreAvailable || seenShortcodes.size >= instagramNativeFeedMaxItems) {
      break;
    }
    const nextMaxId = receipt.nextMaxId;
    if (!nextMaxId || seenCursors.has(nextMaxId)) {
      return partialReceipt(
        "cursor_missing_or_repeated",
        `page ${pageIndex + 1} repeated or omitted its cursor`
      );
    }
    seenCursors.add(nextMaxId);
    maxId = nextMaxId;
    await delay(Math.max(requestDelayMs, 450));
  }

  const lastPage = pages.at(-1);
  return mergeInstagramNativeFeedPages(pages, {
    maxItems: instagramNativeFeedMaxItems,
    pageLimitReached:
      pages.length >= instagramNativeFeedMaxPages &&
      lastPage?.moreAvailable === true
  });
}

function xApiEvidenceForAccount(company, entity, entityType, accountUrl) {
  const handle = xUsernameFromUrl(accountUrl);
  if (!handle) return [];
  return (xRecentCollection.postsByHandle.get(handle) ?? [])
    .map((post) => {
      const publicMetrics = post?.public_metrics ?? {};
      const metrics = removeNullish({
        views: numberOrNull(publicMetrics.impression_count),
        likes: numberOrNull(publicMetrics.like_count),
        replies: numberOrNull(publicMetrics.reply_count),
        reposts: numberOrNull(publicMetrics.retweet_count),
        quotes: numberOrNull(publicMetrics.quote_count)
      });
      if (!Object.values(metrics).some((value) => Number(value) > 0)) return null;
      const authorHandle = String(post?.author?.username ?? handle);
      const sourceUrl = `https://x.com/${authorHandle}/status/${post.id}`;
      const nativePostedAt = exactEvidenceTimestamp(post.created_at);
      return evidenceItem({
        company,
        entityType,
        entityId: entityIdFor(company, entity, entityType),
        platform: "x",
        sourceUrl,
        platformPostId: String(post.id),
        authorHandle,
        title: firstUsefulText(post.text) ?? `${entityName(entity, entityType)} on X`,
        text: post.text ?? "",
        rawVisibleText: JSON.stringify(post),
        postedAt: nativePostedAt,
        publishedAtPrecision: nativePostedAt ? "exact" : "unknown",
        metrics,
        contributionScore: scoreMetrics("x", metrics),
        review_state: "verified",
        attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
        attributionStatus: "verified",
        attributionProvenance: "x_recent_search_exact_mapped_author_v1",
        matchReason: `Official X recent-search result was authored by the exact mapped @${handle} account.`
      });
    })
    .filter(Boolean);
}

async function discoverAndVerifyPublicSocialPosts(company, platform, sourceUrl, matchReasonPrefix, entity = company, entityType = "company") {
  const pathCandidates = discoveredSocialCandidatesFromPaths(company, platform, entity, entityType);
  const searchCandidates = await discoverSocialCandidates(
    company,
    platform,
    entityType === "founder" ? entity : null
  );
  const candidates = dedupeSocialCandidates([...pathCandidates, ...searchCandidates], platform);
  const postCandidates = selectPublicSocialCandidates(
    candidates.filter((candidate) => isSocialPostUrl(candidate.url, platform)),
    platform,
    3
  );
  const postResults = await verifyPublicSocialPostCandidates(company, platform, postCandidates);
  const postEvidence = postResults.flatMap((result) => result.evidence ?? []);
  const attributedPosts = attributePostEvidenceToEntity(company, entity, entityType, platform, postEvidence);
  const verifiedPostUrls = new Set(attributedPosts.evidence.map((item) => item.sourceUrl));
  const postNeedsReview = postResults.flatMap((result) => result.needsReview ?? []);
  const reviewItems = [
    ...postNeedsReview,
    ...attributedPosts.needsReview,
    ...candidates
      .filter((candidate) => !postCandidates.some((postCandidate) => postCandidate.url === candidate.url))
      .slice(0, 3)
      .map((candidate) =>
        reviewCandidate(
          company,
          platform,
          candidate.url,
          `${matchReasonPrefix} Candidate needs review because it is not a verified public post URL.`
        )
      )
  ];

  return {
    evidence: attributedPosts.evidence,
    needsReview: reviewItems,
    failures: [
      ...postResults.flatMap((result) => result.failures ?? []),
      ...(searchCandidates.publicSearchBlocker
        ? [{
          ...failure(
            platform,
            company,
            sourceUrl,
            `Public post discovery was ${candidates.length ? "partially " : ""}blocked: ` +
              searchCandidates.publicSearchBlocker.message,
            entityType,
            entityName(entity, entityType),
            entityIdFor(company, entity, entityType)
          ),
          retryable: false,
          blocker: searchCandidates.publicSearchBlocker
        }]
        : [])
    ],
    sourceDiscoveryPaths: candidates.map((candidate) =>
      sourceDiscoveryPath({
        company,
        sourceUrl: sourceUrl ?? candidate.searchUrl,
        discoveredUrl: candidate.url,
        discoveredPlatform: platform,
        discoveredEntityType: entityType,
        discoveredEntityId: entityIdFor(company, entity, entityType),
        discoveredEntityName: entityName(entity, entityType),
        matchReason: verifiedPostUrls.has(candidate.url)
          ? `${matchReasonPrefix} Verified post-level evidence from public search query "${candidate.query}".`
          : `${matchReasonPrefix} Found candidate from public search query "${candidate.query}".`,
        reviewState: verifiedPostUrls.has(candidate.url) ? "verified" : "needs_review"
      })
    )
  };
}

function attributePostEvidenceToEntity(company, entity, entityType, platform, items) {
  const attributed = [];
  const needsReviewItems = [];
  const targetEntityId = entityIdFor(company, entity, entityType);

  for (const item of items) {
    if (entityType === "founder" && platform === "linkedin") {
      const authorValidation = linkedInFounderAuthorValidation(entity, item);
      if (!authorValidation.verified) {
        needsReviewItems.push(
          reviewCandidate(
            company,
            platform,
            item.sourceUrl,
            `LinkedIn native post was not attributed to ${entity.name}: ${authorValidation.reason}. Exact verified founder author identity is required before founder remapping.`,
            entityType,
            targetEntityId,
            entity.name
          )
        );
        continue;
      }
      attributed.push({
        ...item,
        id: stableId(`${item.platform}:${targetEntityId}:${item.sourceUrl}:${item.title}`),
        entityType,
        entityId: targetEntityId,
        authorHandle: authorValidation.authorSlug,
        matchReason: `${item.matchReason} Native LinkedIn author matched the founder's verified profile slug.`
      });
      continue;
    }

    attributed.push(
      entityType === "founder"
        ? {
            ...item,
            id: stableId(`${item.platform}:${targetEntityId}:${item.sourceUrl}:${item.title}`),
            entityType,
            entityId: targetEntityId
          }
        : item
    );
  }

  return { evidence: attributed, needsReview: needsReviewItems };
}

function linkedInFounderAuthorValidation(founder, item) {
  const profileSlug = linkedInProfileSlug(founder?.socialLinks?.linkedin);
  if (!profileSlug) {
    return {
      verified: false,
      authorSlug: null,
      reason: "the requested founder has no verified LinkedIn profile slug"
    };
  }

  const nativeAuthorSlug = linkedInNativePostAuthorSlug(item?.sourceUrl);
  if (nativeAuthorSlug) {
    return nativeAuthorSlug === profileSlug
      ? { verified: true, authorSlug: nativeAuthorSlug, reason: "native post author slug matched" }
      : {
          verified: false,
          authorSlug: nativeAuthorSlug,
          reason: `native post author slug "${nativeAuthorSlug}" did not match verified profile slug "${profileSlug}"`
        };
  }

  const visibleText = String(item?.rawVisibleText ?? "").slice(0, 2_000);
  const visibleProfileSlugs = new Set(
    [...visibleText.matchAll(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/in\/([^/?#)\s]+)/gi)]
      .map((match) => normalizeLinkedInSlug(match[1]))
      .filter(Boolean)
  );
  if (visibleProfileSlugs.has(profileSlug)) {
    return { verified: true, authorSlug: profileSlug, reason: "visible post author profile link matched" };
  }

  return {
    verified: false,
    authorSlug: null,
    reason: `native post did not expose the verified profile slug "${profileSlug}" as its author`
  };
}

function linkedInProfileSlug(rawUrl) {
  try {
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    return parts[0]?.toLowerCase() === "in" ? linkedinAccountSlugFromUrl(rawUrl) : null;
  } catch {
    return null;
  }
}

function linkedInNativePostAuthorSlug(rawUrl) {
  return linkedinNativeAuthorSlugFromUrl(rawUrl);
}

function normalizeLinkedInSlug(value) {
  return String(value ?? "").trim().replace(/^@/, "").replace(/\/$/, "").toLowerCase() || null;
}

async function verifyPublicSocialPostCandidate(company, platform, candidate) {
  if (platform === "linkedin") {
    const direct = await verifyLinkedInPublicJsonLdCandidate(company, candidate).catch(() => null);
    if (direct) return direct;
  }

  try {
    const page = await fetchReader(candidate.url);
    const combined = `${candidate.title} ${candidate.snippet} ${page.title} ${page.text}`;
    if (isBlocked(page.text, { platform, url: candidate.url })) {
      const fallback = evidenceFromSearchSnippet(company, platform, candidate, "Reader page was blocked or login-walled");
      if (fallback) {
        return { evidence: [fallback] };
      }
      return {
        needsReview: [
          reviewCandidate(
            company,
            platform,
            candidate.url,
            `Public ${platform} post candidate was blocked or login-walled during verification.`
          )
        ]
      };
    }

    const linkedInBody = platform === "linkedin"
      ? assessLinkedInPrimaryPostBody({
          sourceUrl: candidate.url,
          platformPostId: platformPostIdFromUrl(platform, candidate.url),
          rawVisibleText: page.text
        })
      : null;
    if (linkedInBody && !linkedInBody.verified) {
      const fallback = evidenceFromSearchSnippet(
        company,
        platform,
        candidate,
        `Primary reader body was unavailable (${linkedInBody.reason})`
      );
      if (fallback) return { evidence: [fallback] };
      return {
        needsReview: [
          reviewCandidate(
            company,
            platform,
            candidate.url,
            `Public ${platform} post primary body was unavailable and the independent native search snippet did not pass strict attribution (${linkedInBody.reason}).`
          )
        ]
      };
    }
    const safeCandidateText = platform === "linkedin"
      ? linkedInBody.text
      : combined;
    const candidateAttribution = {
      entityType: "company",
      entityId: companyId(company),
      companySlug: company.slug,
      platform,
      sourceUrl: candidate.url,
      // A complete primary body takes precedence over search-result author and
      // AI-summary chrome. The display title is restored only after semantic
      // verification succeeds.
      title: platform === "linkedin" ? "" : page.title || candidate.title || company.name,
      text: linkedInBody?.text ?? safeCandidateText,
      rawVisibleText: page.text
    };
    candidateAttribution.nativeAuthorResolution = resolveCurrentBatchNativeOwner(candidateAttribution);
    const semanticAttribution = platform === "linkedin"
      ? publicEvidenceAttributionAssessment(company, candidateAttribution)
      : null;
    const strongMatch = semanticAttribution
      ? semanticAttribution.verified
      : isStrongPublicMatch(company, combined, candidate.url);

    if (!strongMatch) {
      const fallback = evidenceFromSearchSnippet(company, platform, candidate, "Reader page did not expose enough matching context");
      if (fallback) {
        return { evidence: [fallback] };
      }
      return {
        needsReview: [
          reviewCandidate(
            company,
            platform,
            candidate.url,
            `Public ${platform} post candidate did not pass semantic attribution: ${semanticAttribution?.reason ?? "company identity anchors were insufficient"}` +
              `${linkedInBody ? `; ${linkedInBody.reason}` : ""}.`
          )
        ]
      };
    }

    const metrics = metricsFromPublicPost(platform, page.text, {
      linkedinReader: platform === "linkedin",
      linkedinPostId: platform === "linkedin"
        ? platformPostIdFromUrl(platform, candidate.url)
        : null
    });
    return {
      evidence: [
        evidenceItem({
          company,
          entityType: "company",
          entityId: companyId(company),
          platform,
          sourceUrl: canonicalProfileUrl(candidate.url, platform),
          title: page.title || candidate.title || company.name,
          text: linkedInBody?.text ??
            firstUsefulText(platform === "linkedin" ? safeCandidateText : page.text) ??
            candidate.snippet ?? candidate.title ?? company.name,
          rawVisibleText: page.text,
          attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
          attributionStatus: "verified",
          attributionProvenance: platform === "linkedin"
            ? "verified_linkedin_primary_body_v3"
            : "verified_public_reader_v3",
          attributionSignals: semanticAttribution?.signals,
          attributionDescriptorMatches: semanticAttribution?.descriptorMatches,
          linkedinPrimaryPostBodyStatus: linkedInBody?.verified ? "verified" : "unavailable",
          linkedinPrimaryPostBodyReason: linkedInBody?.reason,
          postedAt: parsePublicPostDate(page.text),
          metrics,
          contributionScore: scoreMetrics(platform, metrics),
          review_state: "verified",
          matchReason: `Verified public ${platform} post candidate from search results; semantic company attribution passed` +
            `${semanticAttribution ? ` (${semanticAttribution.reason})` : ""}` +
            `${linkedInBody ? `; ${linkedInBody.reason}` : ""}.`
        })
      ]
    };
  } catch (error) {
    const providerBlocker = linkedinPublicBlockerFromError(error);
    const providerFailure = providerBlocker
      ? {
          ...failure(
            platform,
            company,
            candidate.url,
            `Public ${platform} post verification was blocked: ${providerBlocker.message}`
          ),
          retryable: !providerBlocker.retryAt,
          blocker: providerBlocker
        }
      : null;
    const fallback = evidenceFromSearchSnippet(
      company,
      platform,
      candidate,
      `Reader verification failed: ${errorMessage(error)}`
    );
    if (fallback) {
      return {
        evidence: [fallback],
        ...(providerFailure ? { failures: [providerFailure] } : {})
      };
    }
    return {
      needsReview: [
        reviewCandidate(
          company,
          platform,
          candidate.url,
          `Public ${platform} post candidate verification failed: ${errorMessage(error)}.`
        )
      ],
      ...(providerFailure ? { failures: [providerFailure] } : {})
    };
  }
}

async function verifyLinkedInPublicJsonLdCandidate(company, candidate) {
  const nativeAuthorSlug = linkedinNativeAuthorSlugFromUrl(candidate.url);
  const expectedAccountUrl = candidate.accountUrl ??
    (nativeAuthorSlug ? `https://www.linkedin.com/company/${nativeAuthorSlug}` : null);
  if (!expectedAccountUrl) return null;

  const direct = await fetchLinkedInPublicPostReceipt(candidate.url, expectedAccountUrl);
  if (!direct?.verified) return null;

  const receipt = direct.receipt;
  const rawVisibleText = JSON.stringify(receipt);
  const linkedInBody = assessLinkedInPrimaryPostBody({
    sourceUrl: candidate.url,
    accountUrl: expectedAccountUrl,
    platformPostId: receipt.post.id,
    rawVisibleText
  });
  if (!linkedInBody.verified) return null;

  const canonicalSourceUrl = canonicalProfileUrl(receipt.post.url, "linkedin");
  const candidateAttribution = {
    entityType: "company",
    entityId: companyId(company),
    companySlug: company.slug,
    platform: "linkedin",
    sourceUrl: canonicalSourceUrl,
    accountUrl: expectedAccountUrl,
    title: "",
    text: linkedInBody.text,
    rawVisibleText
  };
  candidateAttribution.nativeAuthorResolution = resolveCurrentBatchNativeOwner(candidateAttribution);
  const semanticAttribution = publicEvidenceAttributionAssessment(company, candidateAttribution);
  if (!semanticAttribution.verified) {
    return {
      needsReview: [
        reviewCandidate(
          company,
          "linkedin",
          canonicalSourceUrl,
          `Public LinkedIn JSON-LD matched the exact activity and author, but semantic company attribution failed (${semanticAttribution.reason}).`
        )
      ]
    };
  }

  const metrics = metricsFromPublicPost("linkedin", rawVisibleText, {
    linkedinReader: true,
    linkedinPostId: receipt.post.id
  });
  return {
    evidence: [
      evidenceItem({
        company,
        entityType: "company",
        entityId: companyId(company),
        platform: "linkedin",
        sourceUrl: canonicalSourceUrl,
        authorHandle: receipt.post.author.url,
        title: receipt.post.headline || candidate.title || company.name,
        text: linkedInBody.text,
        rawVisibleText,
        attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
        attributionStatus: "verified",
        attributionProvenance: "verified_linkedin_public_jsonld_v1",
        attributionSignals: semanticAttribution.signals,
        attributionDescriptorMatches: semanticAttribution.descriptorMatches,
        linkedinPrimaryPostBodyStatus: "verified",
        linkedinPrimaryPostBodyReason: linkedInBody.reason,
        postedAt: receipt.post.datePublished,
        metrics,
        contributionScore: scoreMetrics("linkedin", metrics),
        review_state: "verified",
        matchReason: `Verified exact LinkedIn activity ID, mapped native author, bounded primary JSON-LD body, and parent engagement counters; semantic attribution passed (${semanticAttribution.reason}).`
      })
    ]
  };
}

function evidenceFromSearchSnippet(company, platform, candidate, reason) {
  const snippetText = cleanText(`${candidate.title ?? ""} ${candidate.snippet ?? ""}`);
  if (!snippetText) return null;
  const metrics = metricsFromPublicPost(platform, snippetText);
  if (!Object.values(metrics).some((value) => Number(value) > 0)) return null;
  const candidateAttribution = {
    entityType: "company",
    entityId: companyId(company),
    companySlug: company.slug,
    platform,
    sourceUrl: candidate.url,
    title: candidate.title || "",
    text: candidate.snippet || "",
    rawVisibleText: ""
  };
  candidateAttribution.nativeAuthorResolution = resolveCurrentBatchNativeOwner(candidateAttribution);
  const semanticAttribution = publicEvidenceAttributionAssessment(company, candidateAttribution);
  if (!semanticAttribution.verified) return null;

  return evidenceItem({
    company,
    entityType: "company",
    entityId: companyId(company),
    platform,
    sourceUrl: canonicalProfileUrl(candidate.url, platform),
    title: candidate.title || company.name,
    text: firstUsefulText(snippetText) || candidate.title || company.name,
    rawVisibleText: snippetText,
    attributionVersion: PUBLIC_ATTRIBUTION_VERSION,
    attributionStatus: "verified",
    attributionProvenance: "strict_native_search_snippet_v3",
    attributionSignals: semanticAttribution.signals,
    attributionDescriptorMatches: semanticAttribution.descriptorMatches,
    postedAt: parsePublicPostDate(snippetText),
    metrics,
    contributionScore: scoreMetrics(platform, metrics),
    review_state: "verified",
    matchReason: `Verified public ${platform} post candidate from search-result visible text only; ${reason}.`
  });
}

function isStrongSearchSnippetPostMatch(company, text) {
  const normalizedName = cleanText(company.name).toLowerCase();
  const hasSpecificCompanyName = normalizedName.length >= 6 && isCompanyMatch(company, text);
  if (hasSpecificCompanyName) return true;
  if (companyDomainMentioned(company, text)) return true;
  const hasFounderMatch = founderNameMentioned(company, text);
  const hasStartupContext =
    currentBatchContext.contextPattern.test(text) ||
    /\b(startup|founder|co[- ]?founder|launch|product|app|AI|open[- ]?source)\b/i.test(text);
  return hasFounderMatch && hasStartupContext;
}

function evidenceItem(input) {
  return {
    id: stableId(`${input.platform}:${input.entityId}:${input.sourceUrl}:${input.title}`),
    batchSlug: batchConfig.slug,
    entityType: input.entityType,
    entityId: input.entityId,
    companySlug: input.company.slug,
    companyName: input.company.name,
    platform: input.platform,
    title: sanitizePublicText(input.title),
    sourceUrl: input.sourceUrl,
    ...(input.authorName ? { authorName: sanitizePublicText(input.authorName) } : {}),
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    ...(input.thumbnailUrl ? { thumbnailUrl: input.thumbnailUrl } : {}),
    ...(input.linkStatus ? { linkStatus: input.linkStatus } : {}),
    ...(input.submittedUrl ? { submittedUrl: input.submittedUrl } : {}),
    ...(input.authorHandle ? { authorHandle: input.authorHandle } : {}),
    ...(input.youtubeChannelId ? { youtubeChannelId: input.youtubeChannelId } : {}),
    ...(input.youtubeChannelUrl ? { youtubeChannelUrl: input.youtubeChannelUrl } : {}),
    ...(input.youtubeChannelName ? { youtubeChannelName: input.youtubeChannelName } : {}),
    ...(input.attributionVersion ? { attributionVersion: input.attributionVersion } : {}),
    ...(input.attributionStatus ? { attributionStatus: input.attributionStatus } : {}),
    ...(input.attributionProvenance ? { attributionProvenance: input.attributionProvenance } : {}),
    ...(input.attributionSignals ? { attributionSignals: input.attributionSignals } : {}),
    ...(input.attributionDescriptorMatches ? { attributionDescriptorMatches: input.attributionDescriptorMatches } : {}),
    ...(input.linkedinPrimaryPostBodyStatus
      ? { linkedinPrimaryPostBodyStatus: input.linkedinPrimaryPostBodyStatus }
      : {}),
    ...(input.linkedinPrimaryPostBodyReason
      ? { linkedinPrimaryPostBodyReason: input.linkedinPrimaryPostBodyReason }
      : {}),
    platformPostId: input.platformPostId ?? platformPostIdFromUrl(input.platform, input.sourceUrl),
    text: truncatePublicText(input.text, 600),
    // Keep the complete native body for downstream conviction scoring. The
    // display `text` field remains bounded, while originalText never falls
    // back to title, matchReason, or any attribution summary.
    ...(preserveOriginalBodyText(input.text) ? { originalText: preserveOriginalBodyText(input.text) } : {}),
    rawVisibleText: truncatePublicText(input.rawVisibleText, 6000),
    ...(Array.isArray(input.mediaUrls) && input.mediaUrls.length
      ? { mediaUrls: input.mediaUrls.slice(0, 4) }
      : {}),
    postedAt: input.postedAt ?? null,
    publishedAtPrecision: input.publishedAtPrecision ?? "unknown",
    metrics: removeNullish(input.metrics ?? {}),
    contributionScore: input.contributionScore ?? 0,
    review_state: input.review_state,
    matchReason: input.matchReason,
    first_seen_at: now,
    last_checked_at: now,
    last_updated_at: input.postedAt ?? now
  };
}

function reviewCandidate(company, platform, url, reason, entityType = "company", entityId = companyId(company), entityNameValue = company.name) {
  return {
    id: stableId(`review:${platform}:${entityId}:${url}`),
    entityType,
    entityId,
    entityName: entityNameValue,
    companySlug: company.slug,
    companyName: company.name,
    platform,
    candidateUrl: url,
    review_state: "needs_review",
    matchReason: reason,
    first_seen_at: now,
    last_checked_at: now,
    last_updated_at: now
  };
}

function discoveryAttempt({
  company,
  entityType = "company",
  entityId = companyId(company),
  entityName = company.name,
  platform,
  query,
  source,
  resultCount,
  usefulResultCount,
  selectedUrl,
  status,
  failureReason = null,
  blocker = null
}) {
  return {
    id: stableId(`discovery:${batchConfig.slug}:${entityId}:${platform}:${source}:${query}:${selectedUrl ?? "none"}:${status}`),
    entityType,
    entityId,
    entityName,
    batch_slug: batchConfig.slug,
    company_id: companyId(company),
    company_slug: company.slug,
    company_name: company.name,
    platform,
    query,
    source,
    result_count: resultCount,
    useful_result_count: usefulResultCount,
    selected_url: selectedUrl,
    status,
    failure_reason: failureReason,
    ...(blocker ? { blocker } : {}),
    created_at: now
  };
}

function sourceDiscoveryPath({
  company,
  sourceUrl,
  discoveredUrl,
  discoveredPlatform,
  discoveredEntityType,
  discoveredEntityId,
  discoveredEntityName,
  matchReason,
  reviewState
}) {
  return {
    id: stableId(`path:${batchConfig.slug}:${discoveredEntityId ?? companyId(company)}:${sourceUrl}:${discoveredUrl}`),
    company_id: companyId(company),
    batch_slug: batchConfig.slug,
    company_slug: company.slug,
    company_name: company.name,
    source_url: sourceUrl,
    discovered_url: discoveredUrl,
    discovered_platform: discoveredPlatform,
    discovered_entity_type: discoveredEntityType,
    discovered_entity_id: discoveredEntityId ?? companyId(company),
    discovered_entity_name: discoveredEntityName,
    match_reason: matchReason,
    review_state: reviewState,
    created_at: now
  };
}

function failure(
  platform,
  company,
  url,
  message,
  entityType = "company",
  entityNameValue = company.name,
  entityIdValue = companyId(company)
) {
  return {
    id: stableId(`failure:${platform}:${company.slug}:${entityType}:${entityIdValue}:${url ?? "none"}:${message}`),
    platform,
    companySlug: company.slug,
    companyName: company.name,
    entityType,
    entityId: entityIdValue,
    entityName: entityNameValue,
    sourceUrl: url ?? null,
    accountUrl: url ?? null,
    message,
    checkedAt: now
  };
}

function selectedResultUrl(result) {
  return result?.evidence?.[0]?.sourceUrl ?? result?.needsReview?.[0]?.candidateUrl ?? result?.failures?.[0]?.sourceUrl ?? null;
}

function defaultQueryFor(company, platform) {
  if (platform === "product_hunt") return `${company.name} Product Hunt`;
  if (platform === "youtube") return `${company.name} ${currentBatchContext.label} YouTube`;
  if (platform === "hacker_news") return `"${company.name}" ${currentBatchContext.label}`;
  if (platform === "reddit") return `${company.name} ${currentBatchContext.organization} reddit`;
  if (platform === "rss") return `${company.name} blog RSS`;
  if (platform === "web") return `${company.name} ${currentBatchContext.label}`;
  return `${company.name} ${platform}`;
}

function platformAllowed(platform) {
  return !platformFilter.size || platformFilter.has(normalizePlatformArg(platform));
}

function normalizePlatformArg(platform) {
  if (!platform) return "";
  if (platform === "website" || platform === "news_web" || platform === "web_news" || platform === "news") {
    return "web";
  }
  if (platform === "twitter") return "x";
  if (platform === "producthunt") return "product_hunt";
  if (platform === "hn") return "hacker_news";
  return platform;
}

async function fetchReadable(url) {
  const { text: html } = await fetchPublicBoundedText(url, {
    maxResponseBytes: HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
    maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
  });
  return htmlToReadable(url, html);
}

async function fetchLinkedInPublicProfileSurface(profileUrl) {
  const { response, text: html } = await fetchLinkedInPublicText(
    profileUrl,
    "linkedin_public_html"
  );
  throwIfPlatformCooldown(response, html);
  if (!response.ok) {
    throw new Error(`LinkedIn public profile returned HTTP ${response.status}.`);
  }
  return {
    ...extractLinkedInPublicProfileSurface({ html, profileUrl }),
    readablePage: htmlToReadable(profileUrl, html)
  };
}

async function fetchLinkedInPublicPostReceipt(postUrl, expectedAccountUrl) {
  const { response, text: html } = await fetchLinkedInPublicText(
    postUrl,
    "linkedin_public_html"
  );
  throwIfPlatformCooldown(response, html);
  if (!response.ok) {
    throw new Error(`LinkedIn public post returned HTTP ${response.status}.`);
  }
  return extractLinkedInPublicPostReceipt({ html, postUrl, expectedAccountUrl });
}

async function fetchReader(url) {
  // Do not forward an attacker-controlled hostname to a remote reader. A
  // public-first/private-second DNS answer could otherwise pass local
  // validation and then be resolved independently by that service. Direct
  // retrieval keeps DNS validation, address pinning, redirects, and the body
  // deadline in one operation under this process's control.
  const { response, text } = await fetchPublicBoundedText(url, {
    maxResponseBytes: HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
    maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
  });
  throwIfPlatformCooldown(response, text);
  if (!response.ok) throw new Error(`Direct public page returned HTTP ${response.status}.`);
  return htmlToReadable(url, text);
}

async function fetchXPublicReaderFallback(url) {
  const cooldown = platformCooldowns.get("x_reader");
  if (cooldown && cooldown.until > Date.now()) {
    throw new Error(
      `X public-reader fallback cooldown active until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`
    );
  }
  try {
    return await fetchReader(url);
  } catch (error) {
    recordPlatformCooldownIfNeeded("x_reader", error);
    throw error;
  }
}

async function fetchPublicSearchText(url, options = {}) {
  let searchUrl;
  try {
    searchUrl = new URL(String(url));
  } catch {
    throw new Error("fetchPublic is restricted to the bounded DuckDuckGo public-search circuit.");
  }
  if (!isDuckDuckGoPublicSearchUrl(searchUrl)) {
    throw new Error("fetchPublic is restricted to the bounded DuckDuckGo public-search circuit.");
  }
  return publicSearchCircuit.fetchText(searchUrl, { headers: publicRequestHeaders(options) });
}

function fetchPublicSearchBoundedTransport(input, options = {}) {
  return fetchPublicBoundedText(input, options);
}

async function fetchPublicBoundedText(url, {
  maxResponseBytes = HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
  maxDecodedBytes = HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes,
  timeoutMs = publicFetchTimeoutMs,
  signal: parentSignal,
  cancelErrorBody = false,
  registerTeardown,
  ...options
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > DEFAULT_PUBLIC_FETCH_TIMEOUT_MS) {
    throw new RangeError(
      `Public fetch timeout must be an integer between 25 and ${DEFAULT_PUBLIC_FETCH_TIMEOUT_MS}ms.`
    );
  }
  const controller = new AbortController();
  const timeoutError = new Error(
    `Public fetch timed out after ${timeoutMs}ms before the bounded response body completed.`
  );
  timeoutError.name = "AbortError";
  timeoutError.code = "public_fetch_timeout";
  let activeDispatcher = null;
  let activeResponse = null;
  let rejectTimeout;
  let rejectParentAbort;
  let onParentAbort;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
    void cancelPublicBody(activeResponse?.body, timeoutError);
    activeDispatcher?.destroy?.(timeoutError).catch?.(() => {});
    rejectTimeout(timeoutError);
  }, timeoutMs);
  const parentAbortPromise = parentSignal
    ? new Promise((_, reject) => {
        rejectParentAbort = reject;
      })
    : new Promise(() => {});
  if (parentSignal) {
    onParentAbort = () => {
      const reason = parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new Error("Public fetch aborted by caller.");
      controller.abort(reason);
      void cancelPublicBody(activeResponse?.body, reason);
      activeDispatcher?.destroy?.(reason).catch?.(() => {});
      rejectParentAbort(reason);
    };
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const request = async () => {
    let currentUrl = url;
    for (let redirectCount = 0; ; redirectCount += 1) {
      const destination = await resolvePublicDestination(currentUrl);
      if (controller.signal.aborted) throw timeoutError;
      const dispatcher = createPinnedPublicDispatcher(destination);
      activeDispatcher = dispatcher;
      let response;
      let bodyIsEncoded = false;
      try {
        const result = await requestPublicDestination(destination, {
          signal: controller.signal,
          headers: publicRequestHeaders(options),
          dispatcher,
          timeoutMs
        });
        response = result.response;
        bodyIsEncoded = result.bodyIsEncoded;
      } catch (error) {
        await closePublicDispatcher(dispatcher, error);
        if (activeDispatcher === dispatcher) activeDispatcher = null;
        throw publicDestinationCause(error) ?? error;
      }
      activeResponse = response;

      if (isRedirectResponse(response)) {
        const location = response.headers.get("location");
        await cancelPublicBody(response.body);
        activeResponse = null;
        await closePublicDispatcher(dispatcher);
        if (activeDispatcher === dispatcher) activeDispatcher = null;
        if (options.redirect === "error") {
          throw new Error(`Public fetch refused HTTP ${response.status} redirect.`);
        }
        if (!location) {
          throw new Error(`Public redirect returned HTTP ${response.status} without a Location header.`);
        }
        if (redirectCount >= MAX_PUBLIC_REDIRECTS) {
          throw new Error(`Public fetch exceeded the ${MAX_PUBLIC_REDIRECTS}-redirect limit.`);
        }
        currentUrl = new URL(location, destination.url).toString();
        continue;
      }

      try {
        if (cancelErrorBody && response.status >= 400) {
          await cancelPublicBody(response.body);
          return { response, text: "" };
        }
        const text = await readBoundedResponseText(response, {
          maxResponseBytes,
          maxDecodedBytes,
          signal: controller.signal,
          bodyIsEncoded
        });
        return { response, text };
      } catch (error) {
        await cancelPublicBody(response.body, error);
        throw error;
      } finally {
        activeResponse = null;
        await closePublicDispatcher(dispatcher);
        if (activeDispatcher === dispatcher) activeDispatcher = null;
      }
    }
  };

  try {
    const requestPromise = request();
    registerTeardown?.(requestPromise);
    // Promise.race installs a rejection handler, and this explicit sink keeps
    // late DNS/body/dispatcher settlement handled even after the deadline has
    // already won and the caller has moved on.
    requestPromise.catch(() => {});
    return await Promise.race([requestPromise, timeoutPromise, parentAbortPromise]);
  } finally {
    // The timer remains live through DNS, redirects, headers, and the complete
    // bounded body read. A headers-only timeout would still permit a stalled
    // response stream to hang an ingestion worker indefinitely.
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function requestPublicDestination(destination, { signal, headers, dispatcher, timeoutMs }) {
  const fetchImplementation = injectedPublicFetchImplementation();
  if (fetchImplementation) {
    return {
      response: await fetchImplementation(destination.url, {
        signal,
        headers,
        redirect: "manual",
        dispatcher
      }),
      // WHATWG fetch implementations may transparently decompress while
      // retaining Content-Encoding. The bounded reader accounts for that
      // injected-test shape separately from the production raw transport.
      bodyIsEncoded: false
    };
  }

  const requestImplementation = typeof globalThis.__RETURNER_PUBLIC_RAW_REQUEST__ === "function"
    ? globalThis.__RETURNER_PUBLIC_RAW_REQUEST__
    : undiciRequest;
  const result = await requestImplementation(destination.url, {
    method: "GET",
    signal,
    headers,
    dispatcher,
    maxRedirections: 0,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  return {
    response: rawPublicResponse(result, destination.url),
    // Undici request() exposes the encoded wire entity. Counting this stream
    // before decoding is the only way to enforce both independent limits.
    bodyIsEncoded: true
  };
}

function injectedPublicFetchImplementation() {
  const candidate = globalThis.fetch;
  if (typeof candidate !== "function") return null;
  const source = Function.prototype.toString.call(candidate);
  const nodeBuiltin = source.includes("lazyUndici") ||
    source.includes("internal/deps/undici/undici");
  return nodeBuiltin ? null : candidate;
}

function rawPublicResponse(result, url) {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(result?.headers ?? {})) {
    if (rawValue == null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) headers.append(name, String(value));
  }
  const status = Number(result?.statusCode);
  return {
    body: result?.body ?? null,
    headers,
    ok: status >= 200 && status < 300,
    status,
    url
  };
}

async function readBoundedResponseText(response, {
  maxResponseBytes = HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
  maxDecodedBytes = HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes,
  signal,
  bodyIsEncoded = false
} = {}) {
  assertPositivePublicBodyLimit(maxResponseBytes, "maxResponseBytes");
  assertPositivePublicBodyLimit(maxDecodedBytes, "maxDecodedBytes");

  const contentEncoding = String(response.headers?.get?.("content-encoding") ?? "")
    .trim()
    .toLowerCase();
  const declaredLengthHeader = response.headers?.get?.("content-length");
  const declaredLength = declaredLengthHeader == null ? Number.NaN : Number(declaredLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    const error = publicBodyLimitError(
      `Response declared ${declaredLength} bytes, above the ${maxResponseBytes}-byte limit.`
    );
    await cancelPublicBody(response.body, error);
    throw error;
  }

  const chunks = [];
  let observed = 0;
  let prefix = Buffer.alloc(0);
  const body = response.body;
  if (!body) return "";

  const appendChunk = (value) => {
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    observed += chunk.length;
    if (prefix.length < 2) prefix = Buffer.concat([prefix, chunk]).subarray(0, 2);

    const rawGzip = prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
    const encodedDelivery = bodyIsEncoded &&
      (Boolean(contentEncoding && contentEncoding !== "identity") || rawGzip);
    const deliveredLimit = bodyIsEncoded
      ? encodedDelivery
        ? maxResponseBytes
        : Math.min(maxResponseBytes, maxDecodedBytes)
      : rawGzip
        ? maxResponseBytes
        : contentEncoding && contentEncoding !== "identity"
          ? maxDecodedBytes
          : Math.min(maxResponseBytes, maxDecodedBytes);
    if (observed > deliveredLimit) {
      const phase = bodyIsEncoded || rawGzip || !contentEncoding || contentEncoding === "identity"
        ? "encoded"
        : "decoded";
      throw publicBodyLimitError(
        `Response exceeded the ${deliveredLimit}-byte ${phase} body limit.`
      );
    }
  };

  const abortBody = () => {
    void cancelPublicBody(body, signal?.reason);
  };
  if (signal?.aborted) abortBody();
  else signal?.addEventListener("abort", abortBody, { once: true });
  try {
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      const abortReader = () => {
        void reader.cancel(signal?.reason).catch(() => {});
      };
      if (signal?.aborted) abortReader();
      else signal?.addEventListener("abort", abortReader, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          appendChunk(value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortReader);
        reader.releaseLock?.();
      }
    } else if (typeof body[Symbol.asyncIterator] === "function") {
      for await (const chunk of body) appendChunk(chunk);
    } else {
      throw new TypeError("Public response body does not expose a bounded streaming reader.");
    }

    return decodeBoundedPublicBody(Buffer.concat(chunks, observed), {
      contentEncoding,
      maxResponseBytes,
      maxDecodedBytes,
      bodyIsEncoded
    }).toString("utf8");
  } catch (error) {
    await cancelPublicBody(body, error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortBody);
  }
}

function decodeBoundedPublicBody(bytes, {
  contentEncoding,
  maxResponseBytes,
  maxDecodedBytes,
  bodyIsEncoded = false
}) {
  const rawGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const encodings = String(contentEncoding ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "identity");
  if (bodyIsEncoded && encodings.some((value) => value !== "gzip" && value !== "x-gzip")) {
    throw new Error(`Unsupported encoded public response: ${encodings.join(", ")}.`);
  }
  if (bodyIsEncoded && encodings.length > 0 && !rawGzip) {
    throw new Error("Encoded public response declared gzip but did not contain a gzip entity.");
  }
  if (rawGzip) {
    if (bytes.length > maxResponseBytes) {
      throw publicBodyLimitError(
        `Response exceeded the ${maxResponseBytes}-byte encoded body limit.`
      );
    }
    let decoded;
    try {
      decoded = gunzipSync(bytes, { maxOutputLength: maxDecodedBytes + 1 });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") {
        throw publicBodyLimitError(
          `Gzip response exceeded the ${maxDecodedBytes}-byte decoded body limit.`
        );
      }
      throw error;
    }
    if (decoded.length > maxDecodedBytes) {
      throw publicBodyLimitError(
        `Gzip response exceeded the ${maxDecodedBytes}-byte decoded body limit.`
      );
    }
    return decoded;
  }

  // Undici's fetch implementation transparently decompresses encoded bodies
  // while retaining Content-Encoding/Content-Length. In that case the bytes
  // delivered here are decoded bytes; Content-Length above guarded the encoded
  // wire size when present, and this check guards expansion independently.
  const autoDecoded = contentEncoding && contentEncoding !== "identity";
  const deliveredLimit = autoDecoded
    ? maxDecodedBytes
    : Math.min(maxResponseBytes, maxDecodedBytes);
  if (bytes.length > deliveredLimit) {
    throw publicBodyLimitError(
      `Response exceeded the ${deliveredLimit}-byte ${autoDecoded ? "decoded" : "encoded"} body limit.`
    );
  }
  return bytes;
}

function publicBodyLimitError(message) {
  const error = new Error(message);
  error.code = "public_body_limit";
  return error;
}

async function cancelPublicBody(body, reason) {
  if (!body) return;
  try {
    if (typeof body.cancel === "function") {
      await body.cancel(reason);
      return;
    }
    if (typeof body.destroy === "function") {
      body.on?.("error", () => {});
      body.destroy(reason instanceof Error ? reason : undefined);
      return;
    }
    if (typeof body.return === "function") await body.return();
  } catch {
    // Cancellation is best-effort; the pinned dispatcher is destroyed/closed
    // by the owning request operation immediately afterward.
  }
}

function assertPositivePublicBodyLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function parsePublicJson(text, url) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Public JSON response from ${new URL(url).origin} was invalid: ${errorMessage(error)}`);
  }
}

function createPublicDestinationBlockList() {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.31.196.0", 24],
    ["192.52.193.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["192.175.48.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3]
  ]) {
    blockList.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::", 96],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["2620:4f:8000::", 48],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fec0::", 10],
    ["fe80::", 10],
    ["ff00::", 8]
  ]) {
    blockList.addSubnet(network, prefix, "ipv6");
  }
  return blockList;
}

function createPublicIpv6GlobalUnicastAllowList() {
  const allowList = new BlockList();
  // IANA's currently allocated global-unicast delegations. The IANA protocol
  // assignment block is represented only by its globally reachable
  // exceptions; every unallocated/reserved range therefore fails closed.
  for (const [network, prefix] of [
    ["2001:1::1", 128],
    ["2001:1::2", 128],
    ["2001:1::3", 128],
    ["2001:3::", 32],
    ["2001:4:112::", 48],
    ["2001:20::", 28],
    ["2001:30::", 28],
    ["2001:200::", 23],
    ["2001:400::", 23],
    ["2001:600::", 23],
    ["2001:800::", 22],
    ["2001:c00::", 23],
    ["2001:e00::", 23],
    ["2001:1200::", 23],
    ["2001:1400::", 22],
    ["2001:1800::", 23],
    ["2001:1a00::", 23],
    ["2001:1c00::", 22],
    ["2001:2000::", 19],
    ["2001:4000::", 23],
    ["2001:4200::", 23],
    ["2001:4400::", 23],
    ["2001:4600::", 23],
    ["2001:4800::", 23],
    ["2001:4a00::", 23],
    ["2001:4c00::", 23],
    ["2001:5000::", 20],
    ["2001:8000::", 19],
    ["2001:a000::", 20],
    ["2001:b000::", 20],
    ["2003::", 18],
    ["2400::", 12],
    ["2410::", 12],
    ["2600::", 12],
    ["2610::", 23],
    ["2620::", 23],
    ["2630::", 12],
    ["2800::", 12],
    ["2a00::", 12],
    ["2a10::", 12],
    ["2c00::", 12]
  ]) {
    allowList.addSubnet(network, prefix, "ipv6");
  }
  return allowList;
}

async function resolvePublicDestination(input, { resolveDns = false } = {}) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw publicDestinationError("URL is malformed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw publicDestinationError(`protocol ${url.protocol || "unknown"} is not allowed`);
  }
  if (url.username || url.password) {
    throw publicDestinationError("embedded URL credentials are not allowed");
  }
  if (url.port) {
    throw publicDestinationError(`non-default port ${url.port} is not allowed`);
  }

  const hostname = normalizePublicHostname(url.hostname);
  if (!hostname || isInternalHostname(hostname)) {
    throw publicDestinationError(`hostname ${hostname || "unknown"} is local or internal`);
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : resolveDns
      ? await lookupPublicAddresses(hostname)
      : null;
  if (addresses) assertPublicResolvedAddresses(hostname, addresses);

  return {
    url: url.toString(),
    hostname,
    addresses: addresses ? dedupeResolvedAddresses(addresses) : null
  };
}

function publicDestinationError(reason) {
  const error = new Error(`Public destination rejected: ${reason}.`);
  error.code = "public_destination_rejected";
  return error;
}

function publicDestinationCause(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current.code === "public_destination_rejected") return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}

function normalizePublicHostname(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function isInternalHostname(hostname) {
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    hostname === "internal" ||
    hostname.endsWith(".internal");
}

function lookupPublicAddresses(hostname) {
  return new Promise((resolveLookup, rejectLookup) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectLookup(publicDestinationError(
        `hostname ${hostname} did not resolve within ${publicFetchTimeoutMs}ms`
      ));
    }, publicFetchTimeoutMs);
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        rejectLookup(publicDestinationError(`hostname ${hostname} could not be resolved`));
        return;
      }
      resolveLookup(Array.isArray(addresses) ? addresses : []);
    });
  });
}

function assertPublicResolvedAddresses(hostname, addresses) {
  if (addresses.length === 0) {
    throw publicDestinationError(`hostname ${hostname} did not resolve to a public address`);
  }
  for (const entry of addresses) {
    if (!isGloballyRoutableAddress(entry.address, entry.family)) {
      throw publicDestinationError(`hostname ${hostname} resolved to non-public address ${entry.address}`);
    }
  }
}

function dedupeResolvedAddresses(addresses) {
  return [...new Map(addresses.map((entry) => [
    `${entry.family}:${entry.address}`,
    { address: entry.address, family: Number(entry.family) }
  ])).values()];
}

function isGloballyRoutableAddress(address, familyHint) {
  const normalized = normalizePublicHostname(address);
  const family = Number(familyHint) || isIP(normalized);
  if (family !== 4 && family !== 6) return false;
  // Reject every IPv4-mapped IPv6 spelling. Native DNS A records remain
  // supported, while mapped literals cannot bypass the IPv4 special-use list.
  if (family === 6 && /^::ffff:/i.test(normalized)) return false;
  if (family === 6 && !PUBLIC_IPV6_GLOBAL_UNICAST_ALLOW_LIST.check(normalized, "ipv6")) {
    return false;
  }
  return !PUBLIC_DESTINATION_BLOCK_LIST.check(
    normalized,
    family === 4 ? "ipv4" : "ipv6"
  );
}

function createPinnedPublicDispatcher(destination) {
  let cursor = 0;
  let pinnedAddressesPromise = null;
  // Resolve once per URL hop, validate the complete answer set, then reuse only
  // those addresses for every connection attempt. The socket never performs a
  // second unvalidated DNS lookup, closing the DNS-rebinding window.
  const pinnedAddresses = () => {
    if (!pinnedAddressesPromise) {
      pinnedAddressesPromise = destination.addresses
        ? Promise.resolve(destination.addresses)
        : lookupPublicAddresses(destination.hostname).then((addresses) => {
            assertPublicResolvedAddresses(destination.hostname, addresses);
            return dedupeResolvedAddresses(addresses);
          });
      pinnedAddressesPromise.catch(() => {});
    }
    return pinnedAddressesPromise;
  };
  return new Agent({
    connect: {
      lookup(requestedHostname, lookupOptions, callback) {
        if (normalizePublicHostname(requestedHostname) !== destination.hostname) {
          const error = new Error("Pinned public dispatcher refused a hostname change.");
          error.code = "ENOTFOUND";
          callback(error);
          return;
        }
        pinnedAddresses().then((addresses) => {
          const requestedFamily = Number(
            typeof lookupOptions === "number" ? lookupOptions : lookupOptions?.family
          );
          const candidates = addresses.filter(
            (entry) => !requestedFamily || entry.family === requestedFamily
          );
          if (candidates.length === 0) {
            const error = new Error(`No pinned public address supports family ${requestedFamily || "any"}.`);
            error.code = "ENOTFOUND";
            callback(error);
            return;
          }
          if (typeof lookupOptions === "object" && lookupOptions?.all) {
            callback(null, candidates);
            return;
          }
          const selected = candidates[cursor % candidates.length];
          cursor += 1;
          callback(null, selected.address, selected.family);
        }, callback);
      }
    }
  });
}

async function closePublicDispatcher(dispatcher, error = null) {
  if (!dispatcher) return;
  if (error) {
    await dispatcher.destroy(error).catch(() => {});
    return;
  }
  await dispatcher.close().catch(() => {});
}

function isRedirectResponse(response) {
  return [301, 302, 303, 307, 308].includes(response.status);
}

function fetchLinkedInPublicText(url, provider, options = {}) {
  return linkedinPublicCircuit.fetchText(url, {
    headers: anonymousLinkedInRequestHeaders(options),
    provider
  });
}

async function fetchLinkedInBoundedResponse(input, options = {}) {
  const { response, text } = await fetchPublicBoundedText(input, {
    headers: options.headers,
    signal: options.signal,
    registerTeardown: options.registerTeardown,
    cancelErrorBody: true,
    maxResponseBytes: 5 * 1024 * 1024,
    maxDecodedBytes: 5 * 1024 * 1024
  });
  const body = [204, 205, 304].includes(response.status)
    ? null
    : new Response(text).body;
  return {
    body,
    headers: response.headers,
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    url: response.url
  };
}

function publicRequestHeaders(options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has("user-agent")) {
    headers.set("User-Agent", "ReturnerNetworkIntelligence/0.2 read-only public ingestion");
  }
  headers.set("Accept-Encoding", "identity");
  if (!headers.has("accept")) {
    headers.set(
      "Accept",
      options.accept ?? "text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.8"
    );
  }
  return Object.fromEntries(headers.entries());
}

function anonymousLinkedInRequestHeaders(options = {}) {
  const headers = new Headers(publicRequestHeaders(options));
  for (const name of [
    "authorization",
    "cookie",
    "csrf-token",
    "proxy-authorization",
    "x-csrf-token",
    "x-li-at",
    "x-linkedin-auth-token"
  ]) {
    headers.delete(name);
  }
  return Object.fromEntries(headers.entries());
}

function isDuckDuckGoPublicSearchUrl(input) {
  try {
    const url = input instanceof URL ? input : new URL(String(input));
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      /(^|\.)duckduckgo\.com$/i.test(url.hostname) &&
      url.pathname.startsWith("/html");
  } catch {
    return false;
  }
}

function throwIfPlatformCooldown(response, text) {
  if (response.status !== 451 && !/SecurityCompromiseError|anonymous access .* blocked until/i.test(text)) {
    return;
  }

  const untilText = (text.match(/blocked until ([^"]+?) due to/i) ?? [])[1];
  const until = untilText ? new Date(untilText).valueOf() : Date.now() + 30 * 60_000;
  const error = new Error(`Platform cooldown from reader: HTTP ${response.status}; blocked until ${new Date(until).toISOString()}.`);
  error.platformCooldownUntil = Number.isFinite(until) ? until : Date.now() + 30 * 60_000;
  error.platformCooldownReason = truncatePublicText(text, 260);
  throw error;
}

function recordPlatformCooldownIfNeeded(platform, error) {
  if (!error?.platformCooldownUntil) {
    return;
  }

  platformCooldowns.set(normalizePlatformArg(platform), {
    until: error.platformCooldownUntil,
    reason: error.platformCooldownReason ?? errorMessage(error)
  });
}

function htmlToReadable(url, html) {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,canvas").remove();
  const title = cleanText($("title").first().text() || $("h1").first().text());
  const text = cleanText($("body").text());
  return { html, title, text, url };
}

function discoverFeedUrls(baseUrl, html) {
  const urls = new Set();
  if (html) {
    const $ = cheerio.load(html);
    $("link[type*='rss'],link[type*='atom'],a[href*='rss'],a[href*='feed'],a[href*='atom']").each((_, el) => {
      const href = $(el).attr("href");
      if (href) urls.add(new URL(href, baseUrl).toString());
    });
  }
  for (const path of ["/feed", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/blog/rss.xml"]) {
    urls.add(new URL(path, baseUrl).toString());
  }
  return [...urls].slice(0, 6);
}

function discoverSocialLinks(company, html, baseUrl) {
  if (!html || !baseUrl) return [];
  const $ = cheerio.load(html);
  const links = new Map();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = safeAbsoluteUrl(href, baseUrl);
    if (!absolute) return;
    const platform = platformFromUrl(absolute);
    if (!platform) return;
    links.set(canonicalProfileUrl(absolute, platform), { platform, url: canonicalProfileUrl(absolute, platform) });
  });

  return [...links.values()]
    .filter((item) => {
      if (item.platform === "x") return !/\/intent\/|\/share\b/i.test(item.url);
      if (item.platform === "linkedin") return !/\/shareArticle\b/i.test(item.url);
      return true;
    })
    .slice(0, 12);
}

function platformFromUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") return "x";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) return "youtube";
    if (host === "producthunt.com" || host.endsWith(".producthunt.com")) return "product_hunt";
    if (host === "reddit.com" || host.endsWith(".reddit.com")) return "reddit";
  } catch {
    return null;
  }
  return null;
}

function canonicalProfileUrl(rawUrl, platform) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    if (platform === "x" && (url.hostname === "twitter.com" || url.hostname === "mobile.twitter.com")) {
      url.hostname = "x.com";
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function platformPostIdFromUrl(platform, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/$/, "");
    if (platform === "x") return path.match(/\/status\/(\d+)/i)?.[1] ?? null;
    if (platform === "instagram") return path.match(/^\/(?:p|reel|tv)\/([^/]+)/i)?.[1] ?? null;
    if (platform === "linkedin") return linkedinPostIdFromUrl(rawUrl);
    if (platform === "youtube") return url.searchParams.get("v") ?? path.match(/\/shorts\/([^/]+)/i)?.[1] ?? null;
    if (platform === "product_hunt") {
      const launch = path.match(/^\/products\/([^/]+)\/launches\/([^/]+)$/i);
      if (launch) return `products/${launch[1].toLowerCase()}/launches/${launch[2].toLowerCase()}`;
      return path.match(/\/posts\/([^/]+)/i)?.[1] ?? path.match(/\/products\/([^/]+)/i)?.[1] ?? null;
    }
    if (platform === "reddit") return path.match(/\/comments\/([^/]+)/i)?.[1] ?? null;
    if (platform === "hacker_news") return url.searchParams.get("id");
  } catch {
    return null;
  }
  return null;
}

function safeAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseFeedItems(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = $("item, entry").toArray();
  return items.map((node) => {
    const item = $(node);
    const link = item.find("link").first().attr("href") || item.find("link").first().text();
    const title = cleanText(item.find("title").first().text());
    const description = cleanText(item.find("description, summary, content").first().text());
    const publishedAt = cleanText(item.find("pubDate, published, updated").first().text());
    return {
      title,
      description,
      link,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      raw: cleanText(item.text())
    };
  });
}

function parseYouTubeResults(html) {
  const results = [];
  const seen = new Set();
  const regex = /"videoId":"([^"]+)".{0,500}?"title":\{"runs":\[\{"text":"([^"]+)"/g;
  let match;
  while ((match = regex.exec(html))) {
    const videoId = match[1];
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    const windowText = html.slice(match.index, match.index + 2500);
    const viewsText = (windowText.match(/"viewCountText":\{"simpleText":"([^"]+)"/) ?? [])[1] ?? "";
    const description = (windowText.match(/"descriptionSnippet":\{"runs":\[\{"text":"([^"]+)"/) ?? [])[1] ?? "";
    const youtubeChannelName = decodeJsonText(
      (windowText.match(/"ownerText":\{"runs":\[\{"text":"([^"]+)"/) ?? [])[1] ?? ""
    ) || null;
    const youtubeChannelId =
      (windowText.match(/"browseEndpoint":\{"browseId":"(UC[\w-]+)"/) ?? [])[1] ?? null;
    const channelBaseUrl = decodeJsonText(
      (windowText.match(/"canonicalBaseUrl":"([^"]+)"/) ?? [])[1] ?? ""
    );
    const youtubeChannelUrl = canonicalYouTubeChannelUrl(
      channelBaseUrl
        ? `https://www.youtube.com${channelBaseUrl}`
        : youtubeChannelId
          ? `https://www.youtube.com/channel/${youtubeChannelId}`
          : null
    );
    results.push({
      videoId,
      title: decodeJsonText(match[2]),
      description: decodeJsonText(description),
      views: parseCompactNumber(viewsText),
      youtubeChannelName,
      youtubeChannelId,
      youtubeChannelUrl,
      raw: cleanText(`${decodeJsonText(match[2])} ${decodeJsonText(description)} ${viewsText} ${youtubeChannelName ?? ""} ${youtubeChannelUrl ?? ""}`)
    });
  }
  return results;
}

function extractMarkdownLinks(text) {
  const links = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = regex.exec(text))) {
    links.push({ text: cleanText(match[1]), url: match[2] });
  }
  return links;
}

function extractHtmlLinks(html, baseUrl) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const links = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      links.push({
        text: cleanText($(element).text()),
        url: new URL(href, baseUrl).toString()
      });
    } catch {
      // Ignore malformed or non-URL href values.
    }
  });
  return links;
}

function extractSocialPostCandidates(text, platform, company) {
  const markdownLinks = extractMarkdownLinks(text);
  const rawLinks = [...String(text).matchAll(/https?:\/\/[^\s)"'>]+/g)].map((match) => ({
    text: "",
    url: match[0]
  }));

  return [
    ...new Map(
      [...markdownLinks, ...rawLinks]
        .map((link) => ({
          query: `${company.name} ${platform} public profile post links`,
          searchUrl: link.url,
          title: link.text || company.name,
          snippet: "",
          url: canonicalProfileUrl(link.url, platform)
        }))
        .filter((candidate) => urlMatchesPlatform(candidate.url, platform))
        .filter((candidate) => isSocialPostUrl(candidate.url, platform))
        .map((candidate) => [candidate.url, candidate])
    ).values()
  ];
}

function lineAround(text, needle) {
  if (!needle) return "";
  return text
    .split(/\n+/)
    .map(cleanText)
    .find((line) => line.toLowerCase().includes(needle.toLowerCase())) ?? "";
}

function metricsFromPublicProfile(platform, text, title = "") {
  if (platform === "x") {
    return {
      likes: null,
      comments: null,
      views: null,
      reposts: null,
      followers: parseXFollowers(text, title)
    };
  }
  if (platform === "linkedin") {
    return {
      followers: parseLinkedInFollowers(text, title)
    };
  }
  if (platform === "instagram") {
    return {
      followers: parseNearbyMetric(text, "followers", /([\d,.]+[KMB]?)\s+followers/i)
    };
  }
  return {};
}

function metricsFromPublicPost(platform, text, { linkedinReader = false, linkedinPostId = null } = {}) {
  if (platform === "x") {
    return removeNullish({
      views: parseNearbyMetric(text, "Views", /([\d,.]+[KMB]?)\s+Views?/i),
      likes: parseNearbyMetric(text, "Likes", /([\d,.]+[KMB]?)\s+Likes?/i),
      replies: parseNearbyMetric(text, "Replies", /([\d,.]+[KMB]?)\s+Replies?/i),
      comments: parseNearbyMetric(text, "Replies", /([\d,.]+[KMB]?)\s+Replies?/i),
      reposts: parseNearbyMetric(text, "Reposts", /([\d,.]+[KMB]?)\s+(?:Reposts?|Retweets?)/i),
      quotes: parseNearbyMetric(text, "Quotes", /([\d,.]+[KMB]?)\s+Quotes?/i)
    });
  }
  if (platform === "instagram") {
    return removeNullish({
      views: parseNearbyMetric(text, "views", /([\d,.]+[KMB]?)\s+views?/i),
      likes: parseNearbyMetric(text, "likes", /([\d,.]+[KMB]?)\s+likes?/i),
      comments: parseNearbyMetric(text, "comments", /([\d,.]+[KMB]?)\s+comments?/i)
    });
  }
  if (platform === "linkedin") {
    if (linkedinReader) {
      const receipt = extractLinkedInParentPostMetrics({
        rawVisibleText: text,
        expectedPostId: linkedinPostId
      });
      return receipt.status === "verified" ? receipt.metrics : {};
    }
    // Search-result snippets can surface a comment teaser and its counters.
    // Without the native reader's bounded parent footer, no LinkedIn metric is
    // accepted as post-level evidence.
    return {};
  }
  return {};
}

function sanitizeStoredPostMetrics(
  platform,
  metrics,
  rawVisibleText,
  sourceUrl = null,
  suppliedParentReceipt = null
) {
  if (platform !== "linkedin") return metrics;

  const sanitized = { ...metrics };
  const expectedPostId = platformPostIdFromUrl("linkedin", sourceUrl);
  const parentReceipt = suppliedParentReceipt ?? extractLinkedInParentPostMetrics({
    rawVisibleText,
    expectedPostId
  });
  if (parentReceipt.status === "verified" || isLinkedInPublicReaderPayload(rawVisibleText)) {
    // LinkedIn's public reader renders the parent's reaction aggregate as an
    // unlabeled image-stack link immediately before its labelled comment
    // count. Only a structurally verified parent action-bar footer may repair
    // these fields; comment replies below it may each contain `1 Reaction`.
    for (const metric of ["views", "likes", "reactions", "comments", "reposts", "shares"]) {
      delete sanitized[metric];
    }
    if (parentReceipt.status === "verified") Object.assign(sanitized, parentReceipt.metrics);
  }
  const comments = Number(sanitized.comments);
  if (
    Number.isFinite(comments) &&
    comments >= 1_000 &&
    !hasExplicitVisibleMetric(rawVisibleText, comments, "comments?")
  ) {
    delete sanitized.comments;
  }
  return sanitized;
}

function hasExplicitVisibleMetric(text, value, labelPattern) {
  if (typeof text !== "string" || !text.trim() || !Number.isFinite(value)) return false;
  const forms = new Set([
    String(value),
    Number(value).toLocaleString("en-US"),
    compactMetricValue(value)
  ]);
  return [...forms].some((form) =>
    new RegExp(`${escapeRegExp(form)}\\s+${labelPattern}`, "i").test(text)
  );
}

function compactMetricValue(value) {
  if (value >= 1_000_000_000) return `${trimMetricDecimal(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimMetricDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimMetricDecimal(value / 1_000)}K`;
  return String(value);
}

function trimMetricDecimal(value) {
  return value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1).replace(/\.0$/, "");
}

function scoreMetrics(platform, metrics) {
  if (platform === "instagram") {
    const likes = Number(metrics?.likes ?? 0);
    const comments = Number(metrics?.comments ?? 0);
    const shares = Number(metrics?.shares ?? metrics?.reposts ?? 0);
    const views = Number(metrics?.views ?? 0);
    const raw =
      (Number.isFinite(likes) ? likes * 1.1 : 0) +
      (Number.isFinite(comments) ? comments * 5 : 0) +
      (Number.isFinite(shares) ? shares * 4 : 0) +
      (Number.isFinite(views) ? views * 0.05 : 0);
    if (raw <= 0) return 0;
    return Math.max(
      1,
      Math.min(100, Math.round((Math.log1p(raw) / Math.log1p(120_000)) * 100))
    );
  }

  const weights = INGEST_METRIC_WEIGHTS[platform] ?? INGEST_METRIC_WEIGHTS.x;
  const raw = Object.entries(metrics ?? {}).reduce((sum, [metric, rawValue]) => {
    const value = Number(rawValue);
    return Number.isFinite(value) ? sum + value * (weights[metric] ?? 0) : sum;
  }, 0);

  if (raw <= 0) {
    return 0;
  }

  const platformFloor = platform === "web" || platform === "rss" ? 0 : 1;
  return Math.max(platformFloor, Math.min(100, Math.round(Math.log1p(raw) * 18)));
}

function parseXFollowers(text, title) {
  const handle = (title.match(/\(@([^)]+)\)/) ?? [])[1];
  if (handle) {
    const handleIndex = profileHandleIndex(text, handle);
    if (handleIndex >= 0) {
      const windowText = text.slice(handleIndex, handleIndex + 1400);
      const value = (windowText.match(/\[([\d,.]+[KMB]?)\s+Followers\]/i) ?? windowText.match(/([\d,.]+[KMB]?)\s+Followers/i) ?? [])[1];
      return value ? parseCompactNumber(value) : null;
    }
  }
  return parseNearbyMetric(text, "Followers", /\[([\d,.]+[KMB]?)\s+Followers\]/i);
}

function parseLinkedInFollowers(text, title) {
  const profileName = title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  const nameIndex = profileName ? text.toLowerCase().indexOf(`# ${profileName.toLowerCase()}`) : -1;
  const scoped = nameIndex >= 0 ? text.slice(nameIndex, nameIndex + 1000) : "";
  const value =
    (scoped.match(/###\s+[^#\[]*?\s+([\d,.]+[KMB]?)\s+followers\b/i) ??
      scoped.match(/\b([\d,.]+[KMB]?)\s+followers\b/i) ??
      [])[1];
  return value ? parseCompactNumber(value) : null;
}

function parseNearbyMetric(text, needle, regex) {
  const around = needle ? lineAround(text, needle) || text : text;
  const value = (around.match(regex) ?? text.match(regex) ?? [])[1];
  return value ? parseCompactNumber(value) : null;
}

function parseCompactNumber(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  const match = cleaned.match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function parsePublicPostDate(text) {
  const value =
    (text.match(/\b(?:Posted|Published|Date)\s*:?\s*([A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4})\b/) ?? [])[1] ??
    (text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ?? [])[1];
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function profileHandleIndex(text, handle) {
  const lower = text.toLowerCase();
  const marker = `@${handle.toLowerCase()}`;
  const first = lower.indexOf(marker);
  if (first < 0) return -1;
  const second = lower.indexOf(marker, first + marker.length);
  return second >= 0 ? second : first;
}

function isCompanyMatch(company, text) {
  const lower = cleanText(text).toLowerCase();
  if (containsExactTokenSequence(lower, company.name)) return true;
  const slugPhrase = String(company.slug ?? "").replace(/[-_]+/g, " ");
  if (slugPhrase && slugPhrase !== String(company.name ?? "").toLowerCase() && containsExactTokenSequence(lower, slugPhrase)) {
    return true;
  }
  const host = hostFromUrl(company.websiteUrl);
  return Boolean(host && lower.includes(host));
}

function isStrongPublicMatch(company, text, sourceUrl) {
  return publicEvidenceAttributionAssessment(company, { text, sourceUrl }).verified;
}

function publicEvidenceAttributionAssessment(company, item) {
  const text = publicEvidenceAttributionText(item);
  const signals = [];
  if (
    [item?.sourceUrl, item?.submittedUrl].filter(Boolean).some((url) => isCompanyDomain(company, url)) ||
    companyDomainMentioned(company, text)
  ) {
    signals.push("company_domain");
  }
  if (hasDistinctiveCatalogPhrase(company, text)) signals.push("catalog_distinctive_phrase");
  if (isListOrRoundupAttributionContext(batchConfig.slug, text)) {
    signals.push("batch_list_only");
  }
  // Native search-result titles append the author after a pipe.  Keep that
  // exact full-name signal only as corroboration; the shared assessment still
  // requires an exact company mention in cleaned subject text.
  const rosterFounderMatches = matchingRosterFounderNames(company, `${text}\n${item?.title ?? ""}`);
  if (rosterFounderMatches.length > 0) {
    signals.push("roster_founder");
  }
  if (rosterFounderMatches.length >= 2) signals.push("multiple_roster_founders");
  if (
    (item?.entityType ?? "company") === "founder" &&
    assignedFounderNameMentioned(item, company, item?.nativeAuthorResolution)
  ) {
    signals.push("founder_subject_exact_identity");
  }
  if (mappedAccountMatchesEntity(company, item)) signals.push("mapped_official_account");
  if (
    item?.nativeAuthorResolution?.status === "matched" &&
    item.nativeAuthorResolution.owner?.entityType === (item.entityType ?? "company") &&
    item.nativeAuthorResolution.owner?.entityId === item.entityId
  ) {
    signals.push("unique_native_author");
  }
  if (
    item?.nativeAuthorResolution?.status === "matched" &&
    item.nativeAuthorResolution.owner?.companySlug === company.slug &&
    containsExactTokenSequence(text, company.name)
  ) {
    signals.push("same_company_native_author_subject");
  }
  const channelName = String(item?.youtubeChannelName ?? "");
  if (
    channelName &&
    companyBrandMatchesNativeChannel(company.name, channelName) &&
    (!isCollisionProneCompanyName(company.name) ||
      organizationQualifiedBatchMarker(batchConfig.slug, `${text}\n${channelName}`))
  ) {
    signals.push("native_channel_brand");
  }
  if (
    channelName &&
    (company.founders ?? []).some((founder) => {
      const name = String(founder.name ?? "").trim();
      return name.split(/\s+/).filter(Boolean).length >= 2 && containsExactTokenSequence(channelName, name);
    })
  ) {
    signals.push("native_channel_roster_founder");
  }
  return assessPublicEvidenceAttribution({
    batchSlug: batchConfig.slug,
    companyName: company.name,
    text,
    signals,
    descriptorMatches: matchingCompanyDescriptorTerms(company, text)
  });
}

function companyBrandMatchesNativeChannel(companyName, channelName) {
  if (containsExactTokenSequence(channelName, companyName)) return true;
  const tokens = String(companyName ?? "").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const genericSuffixes = new Set(["ai", "app", "inc", "labs", "technologies", "technology"]);
  if (tokens.length < 2 || !genericSuffixes.has(tokens.at(-1).toLowerCase())) return false;
  return containsExactTokenSequence(channelName, tokens.slice(0, -1).join(" "));
}

function isCurrentBatchHackerNewsHit(text) {
  return currentBatchContext.contextPattern.test(text);
}

function isCompanyDomain(company, sourceUrl) {
  try {
    if (!company.websiteUrl) return false;
    const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase();
    const companyHost = new URL(company.websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
    return sourceHost === companyHost || sourceHost.endsWith(`.${companyHost}`);
  } catch {
    return false;
  }
}

function companyDomainMentioned(company, text) {
  try {
    if (!company.websiteUrl) return false;
    const host = new URL(company.websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
    const lower = cleanText(text).toLowerCase();
    return lower.includes(host);
  } catch {
    return false;
  }
}

function founderNameMentioned(company, text) {
  return matchingRosterFounderNames(company, text).length > 0;
}

function matchingRosterFounderNames(company, text) {
  return (company.founders ?? []).filter((founder) => {
    const name = String(founder.name ?? "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
    if (!name) return false;
    const parts = name.split(/\s+/).filter(Boolean);
    return parts.length >= 2 && containsExactTokenSequence(text, name);
  }).map((founder) => founder.name);
}

function mappedAccountMatchesEntity(company, item) {
  const platform = normalizePlatformArg(item?.platform);
  const accountUrls = [item?.accountUrl, item?.youtubeChannelUrl].filter(Boolean);
  if (!platform || accountUrls.length === 0) return false;
  let owner = company;
  if ((item.entityType ?? "company") === "founder") {
    owner = (company.founders ?? []).find(
      (founder) => entityIdFor(company, founder, "founder") === item.entityId
    );
  }
  if (!owner) return false;
  const targetKeys = new Set(accountUrls.map((url) => socialAccountKey(platform, url)).filter(Boolean));
  return socialAccountUrls(owner, platform).some((url) => targetKeys.has(socialAccountKey(platform, url)));
}

function matchingCompanyDescriptorTerms(company, text) {
  const candidateTokens = new Set(attributionTokens(text));
  const companyTokens = new Set(attributionTokens(company.name));
  return [...new Set(attributionTokens(`${company.tagline ?? ""} ${company.description ?? ""}`))]
    .filter((token) => !companyTokens.has(token))
    .filter((token) => !ATTRIBUTION_DESCRIPTOR_STOP_WORDS.has(token))
    .filter((token) => candidateTokens.has(token));
}

function attributionTokens(value) {
  return String(value ?? "").toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length >= 2) ?? [];
}

function companyId(company) {
  const catalogId = String(company.entityId ?? company.id ?? "");
  return /^a16z-speedrun-006-/i.test(catalogId) ? catalogId : `company-${company.slug}`;
}

function entityIdFor(company, entity, entityType) {
  if (entityType === "company") return companyId(company);
  const catalogId = String(entity.entityId ?? entity.id ?? "");
  return /^a16z-speedrun-006-.+-founder-/i.test(catalogId)
    ? catalogId
    : `founder-${company.slug}-${slugify(entity.name)}-${entity.id}`;
}

function entityName(entity, entityType) {
  return entityType === "company" ? entity.name : entity.name;
}

function firstUsefulText(text) {
  const lines = cleanText(text)
    .split(/(?<=\.)\s+|\n+/)
    .map(cleanText)
    .filter((line) => line.length > 24 && !/^(title|url source|markdown content):/i.test(line));
  return lines[0] ?? cleanText(text).slice(0, 300);
}

function socialProfileSummary(platform, text, title) {
  const compact = cleanText(text);
  if (platform === "x") {
    const handle = (title.match(/\(@([^)]+)\)/) ?? [])[1];
    if (handle) {
      const handleIndex = profileHandleIndex(compact, handle);
      if (handleIndex >= 0) {
        const profileWindow = compact.slice(handleIndex + handle.length + 1, handleIndex + 800);
        const beforeJoined = profileWindow.split(/\s+Joined\s+/i)[0];
        const withoutLinks = stripMarkdownLinks(beforeJoined)
          .replace(/\b\d[\d,]*\s+posts?\b/i, "")
          .replace(/\s+/g, " ")
          .trim();
        if (withoutLinks.length > 12) return withoutLinks;
      }
    }
  }

  if (platform === "linkedin") {
    const summary = (compact.match(/####\s+(.+?)(?:\s+\[|\s+###|\s*$)/) ?? [])[1];
    if (summary && !/^(follow|sign in|join linkedin)$/i.test(summary.trim())) {
      return stripMarkdownLinks(summary).trim();
    }
  }

  const fallback = firstUsefulText(compact);
  return isGenericProfileText(fallback) ? title : fallback;
}

function stripMarkdownLinks(value) {
  return cleanText(value)
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
}

function isGenericProfileText(value) {
  return /don't miss what's happening|skip to main content|agree & join linkedin|log in|sign up/i.test(value);
}

function isSocialPostUrl(url, platform) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (platform === "x") return /\/status\/\d+/i.test(path);
    if (platform === "instagram") return /^\/(p|reel|tv)\/[^/]+/i.test(path);
    if (platform === "linkedin") return /\/feed\/update\/urn:li:activity:|\/posts\//i.test(path);
    return false;
  } catch {
    return false;
  }
}

function isBlocked(text, { platform = null, url = null } = {}) {
  const value = String(text ?? "");
  if (/captcha|blocked by network security|target url returned error 403|forbidden|access denied|temporarily blocked|unusual traffic|enable javascript to continue|SecurityCompromiseError|anonymous access .* blocked until/i.test(value)) {
    return true;
  }
  if (platform === "linkedin" && /linkedin profile unavailable|this linkedin profile is unavailable|profile not found/i.test(value)) {
    return true;
  }

  const loginChromeVisible = /to continue, log in|sign up\s*\|\s*linkedin|agree\s*&\s*join|join linkedin/i.test(value);
  if (!loginChromeVisible) return false;
  if (platform !== "linkedin") return true;

  // LinkedIn appends guest sign-up chrome to otherwise complete public pages.
  // Treat it as a hard wall only when the exact requested native payload is
  // absent; the post body and metrics still pass independent strict gates.
  if (linkedinPostIdFromUrl(url) && isLinkedInPublicReaderPayload(value)) return false;
  const expectedProfileSlug = linkedinAccountSlugFromUrl(url);
  if (expectedProfileSlug) {
    const exposesExactNativePost = [...value.matchAll(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/posts\/[^\s)"'<>]+/gi)]
      .some((match) => linkedinNativeAuthorSlugFromUrl(match[0]) === expectedProfileSlug);
    if (exposesExactNativePost) return false;
  }
  return true;
}

function isThirdPartyMention(company, sourceUrl) {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase();
    const companyHost = company.websiteUrl ? new URL(company.websiteUrl).hostname.replace(/^www\./, "").toLowerCase() : "";
    if (companyHost && host === companyHost) return false;
    if (host.endsWith("ycombinator.com") || host.endsWith("workatastartup.com")) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeSearchUrl(url) {
  if (url.startsWith("//")) {
    url = `https:${url}`;
  }
  try {
    const parsed = new URL(url);
    const duckTarget = parsed.searchParams.get("uddg");
    return duckTarget ? decodeURIComponent(duckTarget) : parsed.toString();
  } catch {
    return url;
  }
}

function urlMatchesPlatform(url, platform) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (platform === "x") return host === "x.com" || host === "twitter.com";
    if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
    if (platform === "instagram") return host === "instagram.com" || host.endsWith(".instagram.com");
    if (platform === "youtube") return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
    if (platform === "product_hunt") return host === "producthunt.com" || host.endsWith(".producthunt.com");
    if (platform === "reddit") return host === "reddit.com" || host.endsWith(".reddit.com");
    if (platform === "hacker_news") return host === "news.ycombinator.com";
    if (platform === "rss" || platform === "web") return Boolean(host);
    return false;
  } catch {
    return false;
  }
}

function mappedAccountUrlMatchesPlatform(url, platform, company) {
  if (!urlMatchesPlatform(url, platform)) return false;
  if (platform !== "rss" && platform !== "web") return true;
  try {
    const mappedHost = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const officialHost = new URL(company?.websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
    return mappedHost === officialHost || mappedHost.endsWith(`.${officialHost}`);
  } catch {
    return false;
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\\u0026/g, "&").replace(/\s+/g, " ").trim();
}

function sanitizePublicText(value) {
  return redactTokenLikeStrings(cleanText(value));
}

function truncatePublicText(value, maxCodeUnits) {
  const text = sanitizePublicText(value);
  let end = Math.min(text.length, maxCodeUnits);
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  return replaceUnpairedUtf16Surrogates(text.slice(0, end));
}

function preserveOriginalBodyText(value) {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  return replaceUnpairedUtf16Surrogates(text).slice(0, 25_000);
}

function replaceUnpairedUtf16Surrogates(value) {
  const text = String(value ?? "");
  let output = "";
  let segmentStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      if (isLowSurrogate(text.charCodeAt(index + 1))) {
        index += 1;
        continue;
      }
    } else if (!isLowSurrogate(codeUnit)) {
      continue;
    }
    output += `${text.slice(segmentStart, index)}\uFFFD`;
    segmentStart = index + 1;
  }
  return segmentStart === 0 ? text : output + text.slice(segmentStart);
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}

function decodeJsonText(value) {
  try {
    return JSON.parse(`"${String(value).replace(/"/g, '\\"')}"`);
  } catch {
    return cleanText(value);
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function removeNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function stableId(value) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeIdentifier(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function hostFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function removeCompanyPlatformRows(company, platform) {
  removeMatching(evidence, (item) => item.companySlug === company.slug && normalizePlatformArg(item.platform) === platform);
  removeMatching(needsReview, (item) => item.companySlug === company.slug && normalizePlatformArg(item.platform) === platform);
  removeMatching(failures, (item) => item.companySlug === company.slug && normalizePlatformArg(item.platform) === platform);
  removeMatching(
    discoveryAttempts,
    (item) => item.company_slug === company.slug && normalizePlatformArg(item.platform) === platform
  );
  removeMatching(
    sourceDiscoveryPaths,
    (item) => item.company_slug === company.slug && normalizePlatformArg(item.discovered_platform) === platform
  );
}

function removeEntityPlatformRows(company, entityId, entityType, platform, profileUrl) {
  const matchesEntity = (item) =>
    item.companySlug === company.slug &&
    normalizePlatformArg(item.platform ?? item.discovered_platform) === platform &&
    item.entityType === entityType &&
    item.entityId === entityId &&
    (!item.accountUrl || socialAccountKey(platform, item.accountUrl) === socialAccountKey(platform, profileUrl));

  removeMatching(evidence, matchesEntity);
  removeMatching(needsReview, matchesEntity);
  removeMatching(
    failures,
    (item) =>
      item.companySlug === company.slug &&
      normalizePlatformArg(item.platform) === platform &&
      item.entityType === entityType &&
      item.entityId === entityId &&
      (item.accountUrl
        ? socialAccountKey(platform, item.accountUrl) === socialAccountKey(platform, profileUrl)
        : item.sourceUrl === profileUrl)
  );
}

function removeMatching(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      items.splice(index, 1);
    }
  }
}

function batchContextFromSnapshot(snapshot) {
  const sourceText = cleanText(
    `${snapshot?.source?.label ?? ""} ${snapshot?.source?.directoryUrl ?? ""} ${snapshot?.source?.algoliaFilter ?? ""}`
  );
  const decodedSourceText = decodeURIComponent(sourceText);
  const isA16zSpeedrun006 = /a16z\s+Speedrun\s+006|A16ZSR006/i.test(decodedSourceText);
  const isSummer2026 = /\bSummer\s+2026\b/i.test(decodedSourceText) || /\bS26\b/i.test(decodedSourceText);
  const isSpring2026 = /\bSpring\s+2026\b/i.test(decodedSourceText) || /\bS2026\b|\bP26\b/i.test(decodedSourceText);
  const searchAliases = isA16zSpeedrun006
    ? ["a16z Speedrun 006", "a16z Speedrun", "Speedrun 006"]
    : isSummer2026
      ? ["YC Summer 2026", "Summer 2026", "YC S26"]
      : isSpring2026
        ? ["YC Spring 2026", "Spring 2026", "YC S2026", "YC P26"]
        : ["Y Combinator"];
  const contextAliases = isA16zSpeedrun006
    ? ["a16z Speedrun 006", "a16z Speedrun", "Speedrun 006", "A16ZSR006", "a16z"]
    : isSummer2026
      ? ["YC Summer 2026", "Summer 2026", "YC S26", "S26"]
      : isSpring2026
        ? ["YC Spring 2026", "Spring 2026", "YC S2026", "S2026", "YC P26", "P26"]
        : ["Y Combinator"];

  return {
    label: searchAliases[0],
    organization: isA16zSpeedrun006 ? "a16z" : "Y Combinator",
    searchAliases,
    contextPattern: aliasPattern(contextAliases)
  };
}

function normalizeBatchSnapshot(snapshot, config) {
  if (Array.isArray(snapshot?.companies)) {
    return {
      ...snapshot,
      companies: snapshot.companies.map((company) => ({
        ...normalizeSnapshotOwnerLinks(company),
        founders: (company.founders ?? []).map(normalizeSnapshotOwnerLinks)
      }))
    };
  }
  if (!Array.isArray(snapshot?.nodes)) {
    throw new Error(`${config.snapshotPath} does not contain companies or graph nodes.`);
  }

  const companies = snapshot.nodes
    .filter((node) => node?.entityType === "company" && node.entityId && node.label)
    .map((node) => ({
      id: node.entityId,
      objectID: node.entityId,
      slug: batchCompanySlug(node),
      name: node.label,
      batch: config.label,
      ycProfileUrl: node.sourceUrl ?? node.ycProfileUrl ?? null,
      websiteUrl: node.websiteUrl ?? null,
      tagline: node.tagline ?? "",
      description: node.description ?? "",
      industry: node.primaryIndustry ?? null,
      industries: node.industries ?? [],
      tags: node.industries ?? [],
      groupPartner: node.groupPartner ?? null,
      socialLinks: socialLinksFromAccounts(node.socialAccounts),
      socialAccounts: socialAccountsFromAccounts(node.socialAccounts),
      founders: (node.founders ?? []).map((founder) => ({
        id: founder.id,
        slug: founder.id,
        name: founder.name,
        ycProfileUrl: founder.ycProfileUrl ?? null,
        websiteUrl: founder.websiteUrl ?? null,
        socialLinks: socialLinksFromAccounts(founder.socialAccounts),
        socialAccounts: socialAccountsFromAccounts(founder.socialAccounts)
      })),
      sourceUrls: [node.sourceUrl ?? node.ycProfileUrl, node.websiteUrl].filter(Boolean)
    }));

  return {
    source: {
      label: `${config.label} public graph catalog`,
      directoryUrl: "https://speedrun.a16z.com/",
      batchSlug: config.slug,
      fetchedAt: snapshot.generatedAt ?? null
    },
    companies
  };
}

function normalizeSnapshotOwnerLinks(owner) {
  const accounts = [];
  const links = {};
  for (const [declaredPlatform, url] of Object.entries(owner?.socialLinks ?? {})) {
    if (typeof url !== "string" || !url.trim()) continue;
    const platform = platformFromUrl(url) ?? normalizePlatformArg(declaredPlatform);
    const canonicalUrl = canonicalSocialAccountUrl(platform, url);
    if (!canonicalUrl) continue;
    accounts.push({ platform, url: canonicalUrl });
    if (!links[platform]) links[platform] = canonicalUrl;
  }
  return {
    ...owner,
    socialLinks: links,
    socialAccounts: mergeVerifiedOwnerSocialAccounts(owner?.socialAccounts, {}, links, {})
  };
}

function mergeVerifiedSocialOverrides(companies, overrides) {
  return companies.map((company) => {
    const override = resolveVerifiedCompanyOverride(
      overrides,
      company.slug,
      legacySummerCompanyAliases(company)
    );
    if (!override) return company;

    const overrideCompanyLinks = override.companySocialLinks ?? override.company ?? {};
    const unmatchedOverrideFounders = [...(override.founders ?? [])];
    const founders = (company.founders ?? []).map((founder) => {
      const overrideIndex = unmatchedOverrideFounders.findIndex(
        (candidate) =>
          String(candidate.id ?? "") === String(founder.id ?? "") ||
          slugify(candidate.name ?? "") === slugify(founder.name ?? "")
      );
      if (overrideIndex < 0) return founder;
      const [founderOverride] = unmatchedOverrideFounders.splice(overrideIndex, 1);
      return {
        ...founder,
        ...founderOverride,
        id: founder.id,
        ...(founder.entityId ? { entityId: founder.entityId } : {}),
        socialLinks: mergeVerifiedOwnerSocialLinks(
          founder.socialLinks,
          founderOverride.socialLinks,
          founderOverride
        ),
        socialAccounts: mergeVerifiedOwnerSocialAccounts(
          founder.socialAccounts,
          founder.socialLinks,
          founderOverride.socialLinks,
          founderOverride
        )
      };
    });

    for (const founderOverride of unmatchedOverrideFounders) {
      if (!founderOverride?.id || !founderOverride?.name) continue;
      founders.push({
        ...founderOverride,
        socialLinks: mergeVerifiedOwnerSocialLinks({}, founderOverride.socialLinks, founderOverride),
        socialAccounts: mergeVerifiedOwnerSocialAccounts(
          [],
          {},
          founderOverride.socialLinks,
          founderOverride
        )
      });
    }

    return {
      ...company,
      ...(override.matchReason ? { matchReason: override.matchReason } : {}),
      socialLinks: mergeVerifiedOwnerSocialLinks(company.socialLinks, overrideCompanyLinks, override),
      socialAccounts: mergeVerifiedOwnerSocialAccounts(
        company.socialAccounts,
        company.socialLinks,
        overrideCompanyLinks,
        override
      ),
      founders
    };
  });
}

function legacySummerCompanyAliases(company) {
  const companyId = String(company?.id ?? company?.objectID ?? "").trim();
  if (!companyId) return [];
  return (summerCompanyAliasLedger?.aliases ?? [])
    .filter((entry) => String(entry?.companyId ?? "") === companyId)
    .flatMap((entry) => [
      entry?.fromSlug,
      entry?.fromName,
      entry?.fromSlug ? `company-${entry.fromSlug}` : null
    ])
    .filter(Boolean);
}

function mergeVerifiedOwnerSocialLinks(baseLinks = {}, positiveLinks = {}, ownerOverride = {}) {
  const retiredKeys = new Set(
    retiredOwnerSocialAccounts(ownerOverride)
      .map(({ platform, url }) => retiredSocialAccountKey(platform, url))
  );
  const overridePrimaryLinks = {};
  for (const { platform, url } of verifiedPositiveSocialLinkEntries(positiveLinks)) {
    if (!overridePrimaryLinks[platform]) overridePrimaryLinks[platform] = url;
  }
  return {
    ...Object.fromEntries(
      Object.entries(baseLinks ?? {}).filter(([platform, url]) =>
        !retiredKeys.has(retiredSocialAccountKey(platform, url))
      )
    ),
    ...overridePrimaryLinks
  };
}

function mergeVerifiedOwnerSocialAccounts(baseAccounts = [], baseLinks = {}, positiveLinks = {}, ownerOverride = {}) {
  const retiredKeys = new Set(
    retiredOwnerSocialAccounts(ownerOverride)
      .map(({ platform, url }) => retiredSocialAccountKey(platform, url))
  );
  const baseAccountRows = [
    ...(baseAccounts ?? []),
    ...Object.entries(baseLinks ?? {}).map(([platform, url]) => ({ platform, url }))
  ];
  const byIdentity = new Map();
  for (const account of baseAccountRows) {
    const platform = normalizePlatformArg(account?.platform);
    const key = socialAccountKey(platform, account?.url);
    if (!key || retiredKeys.has(retiredSocialAccountKey(platform, account?.url))) continue;
    const canonicalUrl = canonicalSocialAccountUrl(platform, account?.url);
    byIdentity.set(key, { ...account, platform, url: canonicalUrl });
  }
  for (const { platform, url } of verifiedPositiveSocialLinkEntries(positiveLinks)) {
    const key = socialAccountKey(platform, url);
    const canonicalUrl = canonicalSocialAccountUrl(platform, url);
    if (!key || !canonicalUrl) continue;
    byIdentity.set(key, { platform, url: canonicalUrl });
  }
  return [...byIdentity.values()];
}

function verifiedPositiveSocialLinkEntries(positiveLinks = {}) {
  const entries = [];
  for (const [rawPlatform, rawValue] of Object.entries(positiveLinks ?? {})) {
    const platform = normalizePlatformArg(rawPlatform);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const url of values) {
      if (typeof url === "string" && url.trim()) entries.push({ platform, url });
    }
  }
  return entries;
}

function retiredOwnerSocialAccounts(ownerOverride) {
  const records = [];
  for (const [key, value] of Object.entries(ownerOverride ?? {})) {
    const match = key.match(/^rejected([A-Z].*)$/);
    if (!match || !Array.isArray(value)) continue;
    const platform = normalizePlatformArg(
      match[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    );
    for (const record of value) if (record?.url) records.push({ ...record, platform });
  }
  for (const record of ownerOverride?.retiredAccounts ?? []) {
    if (record?.platform && record?.url) records.push(record);
  }
  return records;
}

async function loadCanonicalCompanyCatalog(currentSnapshot, currentConfig) {
  const descriptors = [
    {
      slug: "S2026",
      label: "YC Spring 2026 (P26)",
      snapshotPath: join(root, "src", "lib", "yc", "spring-2026-companies.json")
    },
    {
      slug: "S26",
      label: "YC Summer 2026 (S26)",
      snapshotPath: join(root, "src", "lib", "yc", "summer-2026-companies.json")
    },
    {
      slug: "A16ZSR006",
      label: "a16z Speedrun 006",
      snapshotPath: join(root, "public", "graph", "a16zsr006.json")
    }
  ];
  const companies = [];

  for (const descriptor of descriptors) {
    if (descriptor.slug === currentConfig.slug) continue;
    const snapshot = await readJson(descriptor.snapshotPath, null);
    if (!snapshot) continue;
    companies.push(
      ...mergeVerifiedSocialOverrides(
        normalizeBatchSnapshot(snapshot, descriptor).companies,
        verifiedSocialOverrides
      )
    );
  }

  // Current-batch records win when two cohorts reuse a company slug.
  companies.push(...currentSnapshot.companies);
  return [...new Map(companies.map((company) => [company.slug, company])).values()];
}

function batchCompanySlug(node) {
  try {
    const parts = new URL(node.sourceUrl ?? node.ycProfileUrl).pathname.split("/").filter(Boolean);
    const companiesIndex = parts.indexOf("companies");
    if (companiesIndex >= 0 && parts[companiesIndex + 1]) return parts[companiesIndex + 1];
  } catch {
    // Fall back to the stable graph entity ID below.
  }
  return String(node.entityId).replace(/^a16z-speedrun-006-/, "");
}

function socialLinksFromAccounts(accounts) {
  const links = {};
  for (const account of accounts ?? []) {
    if (account?.review_state && account.review_state !== "verified") continue;
    const platform = normalizePlatformArg(account?.platform);
    if (platform && account?.url && !links[platform]) links[platform] = account.url;
  }
  return links;
}

function socialAccountsFromAccounts(accounts) {
  return (accounts ?? [])
    .filter((account) => !account?.review_state || account.review_state === "verified")
    .filter((account) => normalizePlatformArg(account?.platform) && account?.url)
    .map((account) => ({
      ...account,
      platform: normalizePlatformArg(account.platform),
      url: account.url
    }));
}

function socialAccountUrls(entity, platform) {
  const urls = [
    ...(entity?.socialAccounts ?? [])
      .filter((account) => normalizePlatformArg(account?.platform) === platform)
      .map((account) => account.url),
    entity?.socialLinks?.[platform]
  ].filter(Boolean).flatMap((url) => {
    const canonicalUrl = canonicalSocialAccountUrl(platform, url);
    return canonicalUrl ? [canonicalUrl] : [];
  });
  return [...new Map(urls.map((url) => [socialAccountKey(platform, url), url])).values()];
}

function socialAccountKey(platform, url) {
  if (!platform || typeof url !== "string" || !url.trim()) return null;
  return socialAccountIdentityKey(normalizePlatformArg(platform), url);
}

function buildNativeOwnerIndex(companies) {
  const index = new Map();
  const addOwner = (company, entity, entityType) => {
    const owner = {
      company,
      batchSlug: batchConfig.slug,
      companySlug: company.slug,
      companyName: company.name,
      entityType,
      entityId: entityIdFor(company, entity, entityType),
      entityName: entityName(entity, entityType)
    };
    for (const platform of ["x", "linkedin", "instagram"]) {
      for (const url of socialAccountUrls(entity, platform)) {
        const identity = nativeAccountIdentity(platform, url);
        if (!identity) continue;
        const key = `${platform}:${identity}`;
        index.set(key, [...(index.get(key) ?? []), owner]);
      }
    }
  };
  for (const company of companies ?? []) {
    addOwner(company, company, "company");
    for (const founder of company.founders ?? []) addOwner(company, founder, "founder");
  }
  return index;
}

function resolveCurrentBatchNativeOwner(item) {
  const platform = normalizePlatformArg(item?.platform);
  if (!["x", "linkedin", "instagram"].includes(platform)) {
    return { status: "unavailable", reason: "platform_has_no_roster_native_author_resolution" };
  }
  const identity = nativePostAuthorIdentity(item, platform);
  if (!identity) {
    return { status: "unavailable", reason: "native_author_identity_unavailable" };
  }
  let candidates = [...new Map(
    (currentBatchNativeOwnerIndex.get(`${platform}:${identity}`) ?? []).map((owner) => [
      `${owner.entityType}:${owner.entityId}`,
      owner
    ])
  ).values()];
  candidates = preferUniqueSameCompanyFounder(candidates);
  if (candidates.length === 0) {
    return { status: "unmatched", reason: "native_author_not_in_current_batch_roster", author: { platform, key: identity } };
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      reason: "native_author_maps_to_multiple_current_batch_owners",
      author: { platform, key: identity },
      candidates: candidates.map(({ company, ...owner }) => owner)
    };
  }
  return {
    status: "matched",
    reason: "native_author_maps_to_unique_current_batch_owner",
    author: { platform, key: identity },
    owner: candidates[0]
  };
}

function nativeAccountIdentity(platform, rawUrl) {
  if (platform === "linkedin") return linkedinAccountSlugFromUrl(rawUrl);
  return normalizeSocialHandle(socialProfileHandleFromUrl(rawUrl, platform)) || null;
}

function nativePostAuthorIdentity(item, platform) {
  if (platform === "linkedin") {
    return [
      linkedinNativeAuthorSlugFromUrl(item?.sourceUrl),
      linkedinNativeAuthorSlugFromPayload(item?.rawVisibleText),
      linkedinAccountSlugFromUrl(item?.authorHandle),
      normalizeSocialHandle(item?.authorHandle),
      item?.accountUrl ? linkedinAccountSlugFromUrl(item.accountUrl) : null
    ].find(Boolean) ?? null;
  }
  if (platform === "x") {
    return normalizeSocialHandle(socialProfileHandleFromUrl(item?.sourceUrl, "x") ?? item?.authorHandle) ||
      (item?.accountUrl ? nativeAccountIdentity(platform, item.accountUrl) : null);
  }
  return normalizeSocialHandle(item?.authorHandle) ||
    (item?.accountUrl ? nativeAccountIdentity(platform, item.accountUrl) : null);
}

function applyCurrentBatchNativeOwner(item, resolution) {
  if (resolution?.status !== "matched") return { ...item, nativeAuthorResolution: resolution };
  const { company, ...owner } = resolution.owner;
  const changed =
    String(item.entityType ?? "company") !== owner.entityType ||
    String(item.entityId ?? "") !== owner.entityId ||
    String(item.companySlug ?? "") !== owner.companySlug;
  return {
    ...item,
    id: item.id,
    ...(changed ? { sourceEvidenceId: item.sourceEvidenceId ?? item.id ?? null } : {}),
    entityType: owner.entityType,
    entityId: owner.entityId,
    entityName: owner.entityName,
    companySlug: owner.companySlug,
    companyName: owner.companyName,
    attributionVersion: Math.max(PUBLIC_ATTRIBUTION_VERSION, Number(item.attributionVersion ?? 0)),
    attributionStatus: "verified_native_author",
    attributionMode: "account_owner",
    attributionSignals: [...new Set([...(item.attributionSignals ?? []), "unique_native_author"])].sort(),
    nativeAuthorResolution: {
      status: "matched",
      author: resolution.author,
      owner,
      changed
    },
    ...(changed
      ? {
          matchReason: `${item.matchReason ?? "Public evidence candidate."} Exact native author reassigned this physical post to ${owner.entityType} ${owner.entityName}.`
        }
      : {})
  };
}

function aliasPattern(aliases) {
  const pattern = aliases
    .map((alias) => escapeRegExp(alias).replace(/\s+/g, "\\s+"))
    .join("|");
  return new RegExp(`\\b(?:${pattern})\\b`, "i");
}

function addItems(items, target) {
  for (const item of items) {
    target.push(item);
  }
}

function dedupeById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function dedupeFailures(items) {
  const bySemanticIdentity = new Map();
  for (const item of items.filter((candidate) => !isObsoleteInternalFailure(candidate))) {
    const key = failureSemanticIdentity(item);
    const previous = bySemanticIdentity.get(key);
    if (!previous || checkedAtMillis(item) >= checkedAtMillis(previous)) {
      bySemanticIdentity.set(key, item);
    }
  }
  return [...bySemanticIdentity.values()].sort(
    (a, b) =>
      String(a.platform ?? "").localeCompare(String(b.platform ?? "")) ||
      String(a.companyName ?? "").localeCompare(String(b.companyName ?? "")) ||
      String(a.entityId ?? "").localeCompare(String(b.entityId ?? ""))
  );
}

function failureSemanticIdentity(item) {
  const platform = normalizePlatformArg(item?.platform);
  const rawAccountUrl = item?.accountUrl ?? item?.sourceUrl ?? "";
  const accountIdentity = rawAccountUrl
    ? socialAccountKey(platform, rawAccountUrl) ?? String(rawAccountUrl).trim().toLowerCase()
    : "";
  return JSON.stringify([
    platform,
    item?.companySlug ?? "",
    item?.entityType ?? "company",
    item?.entityId ?? "",
    accountIdentity,
    item?.blocker
      ? `provider-blocker:${item.blocker.provider ?? "unknown"}:${item.blocker.code ?? "unknown"}`
      : item?.message ?? item?.failure_reason ?? item?.error ?? ""
  ]);
}

function checkedAtMillis(item) {
  const value = Date.parse(item?.checkedAt ?? item?.last_checked_at ?? "");
  return Number.isFinite(value) ? value : 0;
}

function dedupeDiscoveryAttempts(items) {
  return dedupeById(items).filter((item) => !isObsoleteInternalFailure(item));
}

function normalizeNeedsReviewItems(items) {
  return dedupePublicNeedsReviewItems(items, { isUseful: isUsefulNeedsReviewItem });
}

function isUsefulNeedsReviewItem(item) {
  if (item.platform !== "product_hunt") return true;

  const company = companyBySlug.get(item.companySlug);
  const candidateUrl = item.candidateUrl ?? item.sourceUrl ?? "";
  if (!company || !candidateUrl) return false;

  try {
    const parsed = new URL(candidateUrl);
    const isProductHuntProduct = /^\/(products|posts)\//i.test(parsed.pathname);
    if (!isProductHuntProduct) return false;
  } catch {
    return false;
  }

  return productHuntCandidateMatches(company, { text: item.title ?? "", url: candidateUrl });
}

function isObsoleteInternalFailure(item) {
  return /Cannot access 'INGEST_METRIC_WEIGHTS' before initialization/i.test(
    item?.message ?? item?.failure_reason ?? item?.error ?? ""
  );
}

function normalizeStoredEvidence(item) {
  // A batch collector is authoritative only for its selected cohort. Preserve
  // already-published rows from other cohorts byte-for-byte instead of
  // revalidating them against the current batch's owner index and semantic
  // context, which can otherwise demote valid cross-batch evidence.
  if (item.batchSlug && item.batchSlug !== batchConfig.slug) return item;

  const platform = normalizePlatformArg(item.platform);
  const staleAttribution = {
    batchSlug: item.batchSlug ?? batchConfig.slug,
    entityType: item.entityType ?? "company",
    entityId: item.entityId,
    companySlug: item.companySlug,
    companyName: item.companyName
  };
  const nativeAuthorResolution = resolveCurrentBatchNativeOwner({ ...item, platform });
  const originalCompany = companyBySlug.get(item.companySlug);
  const attributionMode = publicAttributionMode(item);
  const originalSubjectVerified = currentSubjectAttributionVerified(
    { ...item, platform },
    originalCompany,
    nativeAuthorResolution
  );
  const mayRepairFounderSubject = originalCompany &&
    attributionMode === "subject" &&
    (item?.entityType ?? "company") === "founder" &&
    !originalSubjectVerified;
  const companySubjectResolution = mayRepairFounderSubject
    ? resolveCurrentBatchCompanySubject(item, originalCompany, platform, nativeAuthorResolution)
    : null;
  const companySubjectCandidate = companySubjectResolution?.row ?? null;
  const shouldReassignToCompanySubject = Boolean(companySubjectCandidate);
  const shouldReassignToNativeOwner =
    nativeAuthorResolution.status === "matched" &&
    !shouldReassignToCompanySubject &&
    (
      attributionMode !== "subject" ||
      !originalSubjectVerified
    );
  let normalized = shouldReassignToNativeOwner
    ? applyCurrentBatchNativeOwner({ ...item, platform }, nativeAuthorResolution)
    : shouldReassignToCompanySubject
      ? {
          ...companySubjectCandidate,
          attributionMode: "subject",
          previousAttribution: staleAttribution,
          matchReason: `${item.matchReason ?? "Verified public evidence."} ` +
            `Assigned founder was not established by the primary post; unique exact company evidence reassigned this physical post to company ${companySubjectResolution.company.name}.`
        }
      : { ...item, platform, nativeAuthorResolution };
  const resolvedAttributionMode = shouldReassignToNativeOwner
    ? "account_owner"
    : shouldReassignToCompanySubject
      ? "subject"
      : attributionMode;
  const company = companyBySlug.get(normalized.companySlug);

  if (platform === "hacker_news") {
    const metadata = parseRawJson(item.rawVisibleText);
    const nativeId = String(
      platformPostIdFromUrl("hacker_news", item.sourceUrl) ?? item.platformPostId ?? metadata?.objectID ?? ""
    );
    const submittedUrl = item.submittedUrl ?? metadata?.url ?? (!isNativeContentUrl("hacker_news", item.sourceUrl) ? item.sourceUrl : null);
    if (/^\d+$/.test(nativeId)) {
      normalized = {
        ...normalized,
        sourceUrl: `https://news.ycombinator.com/item?id=${nativeId}`,
        platformPostId: nativeId,
        ...(submittedUrl ? { submittedUrl } : {})
      };
    } else {
      return null;
    }
  }

  if (platform === "linkedin") {
    normalized = {
      ...normalized,
      sourceUrl: canonicalProfileUrl(item.sourceUrl, platform),
      platformPostId: platformPostIdFromUrl(platform, item.sourceUrl)
    };
  }

  if (["x", "linkedin", "instagram"].includes(platform)) {
    const isPostEvidence =
      /verified public .* (post|tweet|status|activity)/i.test(item.matchReason ?? "") ||
      /\/status\/\d+|\/feed\/update\/urn:li:activity:|\/posts\/|\/(p|reel|tv)\//i.test(item.sourceUrl ?? "");
    const metrics = isPostEvidence ? removeNullish(item.metrics ?? {}) : removeNullish(metricsFromPublicProfile(item.platform, item.rawVisibleText, item.title));
    normalized = {
      ...normalized,
      text: isPostEvidence ? item.text : socialProfileSummary(item.platform, item.rawVisibleText, item.title).slice(0, 600),
      metrics,
      authorHandle: socialPostAuthorHandle(normalized),
      matchReason: isPostEvidence
        ? normalized.matchReason
        : `Public ${platform} profile stored as identity context only. Profile followers are not counted as post traction.`
    };
  }
  if (item.platform === "product_hunt") {
    const verification = company
      ? productHuntVerification(
          company,
          { text: item.title, url: item.sourceUrl },
          { title: item.title, text: item.rawVisibleText }
        )
      : { verified: false };
    if (!company || !verification.verified) {
      normalized = {
        ...normalized,
        matchReason: `${item.matchReason ?? "Public Product Hunt candidate."} Canonical write rejected product attribution.`
      };
    } else {
      normalized = {
        ...normalized,
        matchReason: `Verified public Product Hunt page: ${verification.reason}.`
      };
    }
  }

  const linkedInParentMetricReceipt = platform === "linkedin"
    ? extractLinkedInParentPostMetrics({
        rawVisibleText: normalized.rawVisibleText,
        expectedPostId: platformPostIdFromUrl(platform, normalized.sourceUrl)
      })
    : null;
  const persistLinkedInParentMetricReceipt = platform === "linkedin" && (
    isLinkedInPublicReaderPayload(normalized.rawVisibleText) ||
    linkedInParentMetricReceipt?.source === "structured_native_receipt"
  );
  const metrics = sanitizeStoredPostMetrics(
    platform,
    removeNullish(normalized.metrics ?? {}),
    normalized.rawVisibleText,
    normalized.sourceUrl,
    linkedInParentMetricReceipt
  );
  const nativeContent = isNativeContentUrl(platform, normalized.sourceUrl);
  const hasMetric = hasPositiveSupportedMetric(platform, metrics);
  const exactAuthor = publicAttributionOwnershipValid(
    normalized,
    company,
    resolvedAttributionMode
  );
  const productHuntAttribution = platform === "product_hunt" && company
    ? productHuntVerification(
        company,
        { text: normalized.title, url: normalized.sourceUrl },
        { title: normalized.title, text: normalized.rawVisibleText }
      )
    : null;
  const semanticAttribution = productHuntAttribution?.verified
    ? {
        verified: true,
        reason: `verified_product_hunt_native_page:${productHuntAttribution.reason}`,
        signals: ["product_hunt_native_page"],
        descriptorMatches: []
      }
    : company
      ? publicEvidenceAttributionAssessment(company, normalized)
    : { verified: false, reason: "canonical_company_attribution_unresolved", signals: [], descriptorMatches: [] };
  const youtubeReceiptValid = !isGenericSearchYouTube(normalized) || (
    Number(normalized.attributionVersion ?? 0) >= PUBLIC_ATTRIBUTION_VERSION &&
    Boolean(normalized.youtubeChannelId || normalized.youtubeChannelUrl)
  );
  const eligible = nativeContent && hasMetric && exactAuthor && semanticAttribution.verified && youtubeReceiptValid;
  const attributionDemotion =
    item.review_state === "verified" &&
    nativeContent &&
    hasMetric &&
    (
      !exactAuthor ||
      semanticAttributionCertainRejection(semanticAttribution)
    );
  const reason = !nativeContent
    ? "Canonical write classified this URL as profile, search, context, or unsupported content."
    : !hasMetric
      ? "Canonical write found no positive supported visible traction metric."
      : !exactAuthor
        ? "Canonical write could not match the native post author to a mapped company or founder account."
        : !youtubeReceiptValid
          ? "Canonical write rejected a generic-search YouTube row without attribution receipt v2 and persisted native channel identity."
          : !semanticAttribution.verified
            ? `Canonical write rejected semantic company attribution: ${semanticAttribution.reason}.`
            : null;

  return {
    ...normalized,
    batchSlug: item.batchSlug ?? batchConfig.slug,
    metrics,
    ...(persistLinkedInParentMetricReceipt
      ? {
          linkedinParentMetricReceipt: {
            status: linkedInParentMetricReceipt.status,
            source: linkedInParentMetricReceipt.source,
            reason: linkedInParentMetricReceipt.reason
          }
        }
      : {}),
    attributionVersion: Math.max(Number(normalized.attributionVersion ?? 0), PUBLIC_ATTRIBUTION_VERSION),
    attributionStatus: eligible ? "verified" : "needs_review",
    attributionMode: resolvedAttributionMode,
    attributionSignals: semanticAttribution.signals,
    attributionDescriptorMatches: semanticAttribution.descriptorMatches,
    contributionScore: eligible ? scoreMetrics(platform, metrics) : 0,
    review_state: eligible ? "verified" : "needs_review",
    ...(attributionDemotion
      ? {
          attributionReconciliationDirective: {
            platform,
            sourceUrl: normalized.sourceUrl,
            platformPostId: normalized.platformPostId ?? platformPostIdFromUrl(platform, normalized.sourceUrl),
            disposition: "quarantined",
            reason: semanticAttributionCertainRejection(semanticAttribution)
              ? `semantic_attribution:${semanticAttribution.reason}`
              : !exactAuthor
                ? "native_author_attribution_unresolved"
                : "generic_youtube_missing_attribution_v2_native_channel_receipt",
            staleAttribution
          }
        }
      : {}),
    matchReason: reason ? `${normalized.matchReason ?? "Public evidence candidate."} ${reason}` : normalized.matchReason
  };
}

function nativeAuthorMatchesCanonicalAttribution(item) {
  const resolution = item?.nativeAuthorResolution;
  if (resolution?.status === "ambiguous") return false;
  if (resolution?.status === "matched") {
    return resolution.owner?.entityType === (item.entityType ?? "company") &&
      resolution.owner?.entityId === item.entityId &&
      resolution.owner?.companySlug === item.companySlug;
  }
  return false;
}

function publicAttributionMode(item) {
  const explicit = String(item?.attributionMode ?? item?.attributionType ?? "").trim().toLowerCase();
  if (["author", "account_owner", "owner"].includes(explicit)) return "account_owner";
  if (explicit === "subject") return "subject";
  return item?.accountUrl ? "account_owner" : "subject";
}

function currentSubjectAttributionVerified(item, company, nativeAuthorResolution) {
  if (!company) return false;
  if ((item?.entityType ?? "company") === "founder") {
    if (nativeAuthorResolution?.status === "matched" &&
      nativeAuthorResolution.owner?.entityType === "founder" &&
      nativeAuthorResolution.owner?.entityId === item.entityId) {
      return true;
    }
    return assignedFounderNameMentioned(item, company, nativeAuthorResolution);
  }
  if (
    nativeAuthorResolution?.status === "matched" &&
    nativeAuthorResolution.owner?.companySlug === company.slug &&
    containsExactTokenSequence(publicEvidenceAttributionText(item), company.name)
  ) {
    return true;
  }
  return publicEvidenceAttributionAssessment(company, item).verified;
}

function resolveCurrentBatchCompanySubject(item, originalCompany, platform, nativeAuthorResolution) {
  const rowFor = (company) => ({
    ...item,
    platform,
    entityType: "company",
    entityId: companyId(company),
    companySlug: company.slug,
    companyName: company.name,
    nativeAuthorResolution
  });
  const currentRow = rowFor(originalCompany);
  const currentAssessment = publicEvidenceAttributionAssessment(originalCompany, currentRow);
  if (currentAssessment.verified) {
    return { row: currentRow, company: originalCompany, assessment: currentAssessment };
  }

  const matches = [];
  const seen = new Set();
  for (const candidateCompany of canonicalCompanyCatalog) {
    const candidateId = companyId(candidateCompany);
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    const candidateRow = rowFor(candidateCompany);
    const assessment = publicEvidenceAttributionAssessment(candidateCompany, candidateRow);
    if (
      assessment.verified &&
      assessment.companySubjectNameMatch &&
      assessment.expectedBatch &&
      !assessment.signals.includes("batch_list_only")
    ) {
      matches.push({ row: candidateRow, company: candidateCompany, assessment });
    }
  }
  return matches.length === 1 && matches[0].assessment.signals.includes("roster_founder")
    ? matches[0]
    : null;
}

function publicAttributionOwnershipValid(item, company, attributionMode) {
  const platform = normalizePlatformArg(item?.platform);
  if (!["x", "linkedin", "instagram"].includes(platform)) return true;
  if (attributionMode === "account_owner") {
    return nativeAuthorMatchesCanonicalAttribution(item) ||
      (item?.nativeAuthorResolution?.status === "unavailable" && mappedAccountMatchesEntity(company, item));
  }
  if ((item?.entityType ?? "company") === "founder") {
    return nativeAuthorMatchesCanonicalAttribution(item) ||
      assignedFounderNameMentioned(item, company, item?.nativeAuthorResolution);
  }
  // Company-subject evidence may be authored by a third party; exact semantic
  // company attribution is enforced independently below.
  return true;
}

function assignedFounderNameMentioned(item, company, nativeAuthorResolution = item?.nativeAuthorResolution) {
  const founder = (company?.founders ?? []).find(
    (candidate) => entityIdFor(company, candidate, "founder") === item?.entityId
  );
  const name = String(founder?.name ?? "").trim();
  if (name.split(/\s+/).filter(Boolean).length < 2) return false;
  if (containsExactTokenSequence(publicEvidenceAttributionText(item), name)) return true;
  return String(nativeAuthorResolution?.author?.key ?? "").toLowerCase() === slugify(name);
}

function semanticAttributionCertainRejection(assessment) {
  if (assessment?.verified) return false;
  if (assessment?.reason === "company_name_token_boundary_mismatch") return true;
  if (assessment?.reason === "collision_prone_name_without_independent_anchor") {
    // A matching organization-qualified cohort + launch may become verifiable
    // once its native channel receipt is refreshed (for example Walter P26).
    return !assessment.expectedBatch;
  }
  return false;
}

function isGenericSearchYouTube(item) {
  if (normalizePlatformArg(item?.platform) !== "youtube") return false;
  return !item?.accountUrl && /(?:public\s+youtube\s+search|generic[_ -]?search|youtube\s+search\s+result)/i.test(
    String(item?.matchReason ?? "")
  );
}

function normalizeEvidenceForStorage(items) {
  const normalizedCandidates = [];
  const normalizationReview = [];
  for (const item of dedupeById(items)) {
    const normalized = normalizeStoredEvidence(item);
    if (normalized) {
      normalizedCandidates.push(normalized);
      continue;
    }
    normalizationReview.push({
      id: stableId(`review:normalization:${item.platform}:${item.entityId}:${item.sourceUrl}`),
      entityType: item.entityType,
      entityId: item.entityId,
      entityName: item.companyName,
      companySlug: item.companySlug,
      companyName: item.companyName,
      platform: item.platform,
      candidateUrl: item.sourceUrl,
      submittedUrl: item.submittedUrl ?? item.sourceUrl,
      review_state: "needs_review",
      matchReason: "Canonical write could not recover a native Hacker News item ID; submitted destination retained for manual review.",
      first_seen_at: item.first_seen_at ?? now,
      last_checked_at: now,
      last_updated_at: item.last_updated_at ?? now
    });
  }

  const normalizedEvidence = [];
  const candidatesByOwnerNativeIdentity = new Map();
  for (const item of normalizedCandidates) {
    const identity = `${item.entityType ?? "company"}:${item.entityId}:${nativeEvidenceIdentity(item)}`;
    candidatesByOwnerNativeIdentity.set(
      identity,
      [...(candidatesByOwnerNativeIdentity.get(identity) ?? []), item]
    );
  }

  for (const candidates of candidatesByOwnerNativeIdentity.values()) {
    const selectedCandidate = candidates.every(
      (item) => item.platform === "x" && isNativeContentUrl("x", item.sourceUrl)
    )
      ? reconcileNormalizedXNativeCandidates(candidates)
      : [...candidates].sort(
          (left, right) =>
            Number(right.contributionScore > 0) - Number(left.contributionScore > 0) ||
            String(left.id).localeCompare(String(right.id))
        )[0];
    appendNormalizedEvidenceCandidate(
      selectedCandidate,
      normalizedEvidence,
      normalizationReview
    );
  }
  return { evidence: normalizedEvidence, needsReview: normalizationReview };
}

function reconcileNormalizedXNativeCandidates(candidates) {
  const preferred = [...candidates].sort(
    (left, right) =>
      Number(isExactXSchemaEvidence(right)) - Number(isExactXSchemaEvidence(left)) ||
      checkedAtMillis(right) - checkedAtMillis(left) ||
      Number(right.contributionScore > 0) - Number(left.contributionScore > 0) ||
      String(left.id).localeCompare(String(right.id))
  )[0];
  const metrics = candidates.reduce(
    (merged, item) => mergeMetricMaximums(merged, item.metrics),
    {}
  );
  const metricReceipt = xNativeMetricReceipt(candidates, metrics);
  const firstSeenAt = earliestIsoTimestamp(
    ...candidates.map((item) => item.first_seen_at)
  );
  const lastCheckedAt = latestIsoTimestamp(
    ...candidates.map((item) => item.last_checked_at ?? item.checkedAt)
  );
  const conflictReason = metricReceipt.timestampConflict
    ? " Conflicting exact native timestamps were observed for the same X post ID; queued for review."
    : "";

  return {
    ...preferred,
    metrics,
    contributionScore: metricReceipt.timestampConflict ? 0 : scoreMetrics("x", metrics),
    review_state: metricReceipt.timestampConflict ? "needs_review" : preferred.review_state,
    attributionStatus: metricReceipt.timestampConflict ? "needs_review" : preferred.attributionStatus,
    rawVisibleText: xReconciledRawVisibleText(preferred, metricReceipt),
    xMetricReceipt: metricReceipt,
    ...(firstSeenAt ? { first_seen_at: firstSeenAt } : {}),
    ...(lastCheckedAt ? { last_checked_at: lastCheckedAt } : {}),
    matchReason:
      `${preferred.matchReason ?? "Verified native X evidence."} ` +
      `Canonical write reconciled ${candidates.length} same-owner observations by native X post ID and retained per-metric maxima.` +
      conflictReason
  };
}

function isExactXSchemaEvidence(item) {
  return String(item?.attributionProvenance ?? "")
    .includes("x_public_profile_schema_org");
}

function earliestIsoTimestamp(...values) {
  const timestamps = values
    .map(validEvidenceTimestamp)
    .filter(Boolean)
    .sort();
  return timestamps[0] ?? null;
}

function appendNormalizedEvidenceCandidate(item, normalizedEvidence, normalizationReview) {
  if (item.review_state === "needs_review" || Number(item.contributionScore ?? 0) <= 0) {
    normalizationReview.push({
      ...item,
      candidateUrl: item.candidateUrl ?? item.sourceUrl,
      contributionScore: 0,
      review_state: "needs_review"
    });
    return;
  }
  normalizedEvidence.push(item);
}

function nativeEvidenceIdentity(item) {
  const platform = normalizePlatformArg(item.platform);
  const nativeId = String(item.platformPostId ?? platformPostIdFromUrl(platform, item.sourceUrl) ?? "").trim();
  if (nativeId) return `${platform}:${nativeId.toLowerCase()}`;
  return `${platform}:url:${canonicalProfileUrl(item.sourceUrl, platform).toLowerCase()}`;
}

function parseRawJson(value) {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return null;
  }
}

function hasPositiveSupportedMetric(platform, metrics) {
  const weights = INGEST_METRIC_WEIGHTS[platform];
  if (!weights) return false;
  return Object.keys(weights).some((metric) => Number(metrics?.[metric]) > 0);
}

function isNativeContentUrl(platform, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const path = url.pathname.replace(/\/$/, "");
    if (platform === "x") return ["x.com", "twitter.com", "mobile.twitter.com"].includes(host) && /\/[^/]+\/status\/\d+$/i.test(path);
    if (platform === "instagram") return (host === "instagram.com" || host.endsWith(".instagram.com")) && /^\/(?:p|reel|tv)\/[^/]+$/i.test(path);
    if (platform === "linkedin") {
      return (host === "linkedin.com" || host.endsWith(".linkedin.com")) &&
        (/\/feed\/update\/urn:li:activity:\d+$/i.test(path) || /\/posts\/[^/]*?activity-\d+(?:-[^/]*)?$/i.test(path));
    }
    if (platform === "youtube") return (host === "youtube.com" || host.endsWith(".youtube.com")) &&
      ((path === "/watch" && /^[\w-]{6,}$/.test(url.searchParams.get("v") ?? "")) || /^\/shorts\/[\w-]{6,}$/i.test(path));
    if (platform === "product_hunt") return (host === "producthunt.com" || host.endsWith(".producthunt.com")) &&
      (/^\/(?:posts|products)\/[^/]+$/i.test(path) || /^\/products\/[^/]+\/launches\/[^/]+$/i.test(path));
    if (platform === "hacker_news") return host === "news.ycombinator.com" && path === "/item" && /^\d+$/.test(url.searchParams.get("id") ?? "");
    if (platform === "reddit") return (host === "reddit.com" || host.endsWith(".reddit.com")) && /\/comments\/[^/]+/i.test(path);
    if (platform === "github") return host === "github.com" && path.split("/").filter(Boolean).length === 2;
    if (platform === "bilibili") return host.endsWith("bilibili.com") && /\/video\/[^/]+/i.test(path);
  } catch {
    return false;
  }
  return false;
}

function exactAuthorMatchesCompany(item, company) {
  if (!company) return false;
  const authorHandle = normalizeSocialHandle(socialPostAuthorHandle(item));
  if (!authorHandle) return false;
  return knownCompanySocialHandles(company, item.platform).has(authorHandle);
}

function exactLinkedInFounderAuthorMatches(item, company) {
  if (!company) return false;
  const founder = (company.founders ?? []).find(
    (candidate) => entityIdFor(company, candidate, "founder") === item.entityId
  );
  return founder ? linkedInFounderAuthorValidation(founder, item).verified : false;
}

function knownCompanySocialHandles(company, platform) {
  const urls = [
    company.socialLinks?.[platform],
    ...(company.founders ?? []).map((founder) => founder.socialLinks?.[platform])
  ].filter(Boolean);
  return new Set(urls.map((url) => normalizeSocialHandle(socialProfileHandleFromUrl(url, platform))).filter(Boolean));
}

function socialPostAuthorHandle(item) {
  if (item.authorHandle) return item.authorHandle;
  if (item.platform === "x") return socialProfileHandleFromUrl(item.sourceUrl, "x");
  if (item.platform === "linkedin") {
    return linkedInNativePostAuthorSlug(item.sourceUrl) ??
      linkedinNativeAuthorSlugFromPayload(item.rawVisibleText);
  }
  if (item.platform === "instagram") {
    const raw = String(item.rawVisibleText ?? "");
    return (
      raw.match(/Never miss a post from\s+([\w.]+)/i)?.[1] ??
      raw.match(/\[([\w.]+)\]\(https?:\/\/(?:www\.)?instagram\.com\/\1\/?\)/i)?.[1] ??
      null
    );
  }
  return null;
}

function socialProfileHandleFromUrl(rawUrl, platform) {
  try {
    const path = new URL(rawUrl).pathname.split("/").filter(Boolean);
    if (platform === "x") return path[0] ?? null;
    if (platform === "instagram" && !["p", "reel", "tv"].includes(path[0]?.toLowerCase())) return path[0] ?? null;
  } catch {
    return null;
  }
  return null;
}

function normalizeSocialHandle(value) {
  return String(value ?? "").replace(/^@/, "").trim().toLowerCase();
}

async function writeCheckpoint({ force = false } = {}) {
  checkpointCompletionsSinceWrite += 1;
  if (!force && checkpointCompletionsSinceWrite < checkpointEvery) return;
  checkpointCompletionsSinceWrite = 0;

  // Serialize one snapshot at a time and coalesce routine task completions.
  // The canonical evidence set can be tens of megabytes, so cloning and
  // stringifying it after every account creates avoidable peak heap pressure.
  checkpointWriteChain = checkpointWriteChain.then(async () => {
    const normalizedCheckpointEvidence = normalizeEvidenceForStorage(evidence);
    const checkpointPayload = {
      attempts: Object.fromEntries(
        [...attemptMap.entries()].filter(([, attempt]) => !isObsoleteInternalFailure(attempt))
      ),
      evidence: normalizedCheckpointEvidence.evidence,
      needsReview: normalizeNeedsReviewItems([
        ...needsReview,
        ...carriedAttributionReconciliationReviews,
        ...normalizedCheckpointEvidence.needsReview
      ]),
      failures: dedupeFailures(failures),
      discoveryAttempts: dedupeDiscoveryAttempts(discoveryAttempts),
      sourceDiscoveryPaths: dedupeById(sourceDiscoveryPaths)
    };
    await writeJson(checkpointPath, checkpointPayload);
  });
  await checkpointWriteChain;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function batchScopedRows(rows, _snapshot, batchSlug) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => {
    const rowBatch = row?.batch_slug ?? row?.batchSlug;
    return Boolean(rowBatch) && rowBatch === batchSlug;
  });
}

async function writeJson(path, value) {
  const compactPublicEvidence = resolve(path) === resolve(canonicalPublicEvidencePath);
  if (compactPublicEvidence) {
    const sanitized = JSON.parse(serializeJson(value, { compact: true }));
    await writePublicEvidenceArtifactPairAtomic({
      rootDir: root,
      canonicalPath: path,
      snapshot: sanitized,
      expectedCanonicalSha256: currentCanonicalArtifact?.canonicalSha256,
      expectedLedgerSha256: currentCanonicalArtifact?.ledgerSha256 ?? null,
      expectedReviewLedgerSha256:
        currentCanonicalArtifact?.reviewLedgerSha256 ?? null,
      renameImpl: renameWithRetries
    });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = `${serializeJson(value)}\n`;
  await writeFile(tempPath, body);
  await renameWithRetries(tempPath, path);
}

async function renameWithRetries(source, destination) {
  for (let attemptIndex = 0; attemptIndex < 8; attemptIndex += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!["EPERM", "UNKNOWN"].includes(error?.code) || attemptIndex === 7) {
        throw error;
      }
      await delay(250 + attemptIndex * 250);
    }
  }
}

function writeStdout(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => error ? reject(error) : resolve());
  });
}

function serializeJson(value, { compact = false } = {}) {
  return redactTokenLikeStrings(
    JSON.stringify(withWellFormedJsonStrings(value), null, compact ? undefined : 2)
  );
}

function withWellFormedJsonStrings(value) {
  if (typeof value === "string") return replaceUnpairedUtf16Surrogates(value);
  if (Array.isArray(value)) return value.map(withWellFormedJsonStrings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      replaceUnpairedUtf16Surrogates(key),
      withWellFormedJsonStrings(item)
    ])
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArg(name) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
}

function optionalCanonicalTimestampArg(value, label) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  const canonical = new Date(parsed).toISOString();
  if (canonical !== value) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  return canonical;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function isFreshCompletedAttempt(attempt) {
  if (!attempt?.checkedAt) return false;
  if (
    attempt.batchSlug !== batchConfig.slug ||
    !attempt.platform ||
    !["company", "founder"].includes(attempt.entityType) ||
    !attempt.entityId ||
    !String(attempt.outcomeReason ?? "").trim()
  ) {
    return false;
  }
  if (
    recentProofJournalDir &&
    ["instagram", "hacker_news"].includes(attempt.platform) &&
    (
      attempt.recentWindowCoverageCutoff !== recentCoverageCutoff ||
      (
        !attempt.recentWindowProof &&
        !String(attempt.recentWindowProofBlocker ?? "").trim()
      ) ||
      (
        attempt.recentWindowProof &&
        attempt.recentWindowProof.coveredThrough !== recentCoverageCutoff
      )
    )
  ) {
    // A legacy terminal row proves only that a shallow request happened. Force
    // one instrumented replay so the row gains either the exact native proof
    // or a versioned blocker; current blocked/capped rows then retain ordinary
    // freshness and do not hammer a public endpoint during process recovery.
    return false;
  }
  if (isAutonomousProviderBlocker(attempt.blocker, { platform: attempt.platform })) {
    const blockerRetryAt = Date.parse(attempt.blocker.retryAt ?? "");
    // A provider block is terminal only while an explicit live cooldown is in
    // force. Missing, malformed, or expired retry metadata must re-probe on
    // the next scheduled run instead of preserving a stale false failure.
    return Number.isFinite(blockerRetryAt) && Date.now() < blockerRetryAt;
  }
  const error = String(attempt.error ?? "").trim();
  const retryable =
    typeof attempt.retryable === "boolean"
      ? attempt.retryable
      : attempt.status === "failed" || attempt.outcomeStatus === "failed"
        ? error
          ? retryableCollectorFailure(error)
          : true
        : false;
  if (retryable) return false;
  const terminalOutcome =
    ["completed", "needs_review", "blocked_or_empty"].includes(attempt.outcomeStatus) ||
    (attempt.outcomeStatus === "failed" && Boolean(error));
  if (!terminalOutcome) return false;
  const staleAttributionVersion = Number(attempt.attributionVersion ?? 0) < PUBLIC_ATTRIBUTION_VERSION;
  if (attempt.platform === "linkedin" && staleAttributionVersion) {
    return false;
  }
  if (attempt.platform === "youtube" && !attempt.accountUrl && staleAttributionVersion) {
    return false;
  }
  const checkedAt = Date.parse(attempt.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  return Date.now() - checkedAt < freshForHours * 60 * 60 * 1000;
}

function stripStoredAttemptBatchPrefix(key, batchSlug) {
  const prefix = `${batchSlug}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function resolvePathArg(value) {
  return resolve(root, value);
}

function resolveBatchConfig(value) {
  const normalized = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");

  if (["S26", "YCS26", "YCSUMMER2026", "SUMMER2026"].includes(normalized)) {
    return {
      slug: "S26",
      label: "YC Summer 2026 (S26)",
      snapshotPath: join(root, "src", "lib", "yc", "summer-2026-companies.json"),
      graphPath: join(root, "public", "graph", "s26.json")
    };
  }

  if (["S2026", "P26", "YCS2026", "YCP26", "YCSPRING2026", "SPRING2026"].includes(normalized)) {
    return {
      slug: "S2026",
      label: "YC Spring 2026 (P26)",
      snapshotPath: join(root, "src", "lib", "yc", "spring-2026-companies.json"),
      graphPath: join(root, "public", "graph", "s2026.json")
    };
  }

  if (["A16ZSR006", "A16ZSPEEDRUN006", "SPEEDRUN006"].includes(normalized)) {
    return {
      slug: "A16ZSR006",
      label: "a16z Speedrun 006",
      snapshotPath: join(root, "public", "graph", "a16zsr006.json"),
      graphPath: join(root, "public", "graph", "a16zsr006.json")
    };
  }

  throw new Error(`Unsupported --batch=${value}. Supported batches: S26, S2026, A16ZSR006.`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function publicSearchBlockerFromError(error) {
  if (!(error instanceof PublicSearchUnavailableError)) {
    throw new TypeError("Only a typed public-search circuit failure can become a provider blocker.");
  }
  return Object.freeze({
    provider: error.provider,
    code: error.code,
    retryAt: error?.retryAt ?? null,
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
    message: errorMessage(error)
  });
}

function redditPublicBlocker(httpStatus, message) {
  return Object.freeze({
    provider: "reddit_public_json",
    code: "reddit_public_access_blocked",
    retryAt: new Date(Date.parse(now) + AUTONOMOUS_PROCESS_BUDGETS.collectionPhaseMs).toISOString(),
    httpStatus,
    message
  });
}

function redditProviderBlockedResult(company, url, blocker) {
  return {
    failures: [{
      ...failure("reddit", company, url, blocker.message),
      accountUrl: null,
      retryable: false,
      blocker
    }]
  };
}

function cleanEnv(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
