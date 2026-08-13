import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { runOpenCli as executeOpenCli } from "./lib/opencli-runtime.mjs";
import {
  linkedinPostIdFromUrl
} from "./lib/social-native-identity.mjs";
import {
  linkedinAdapterSupportsAccountUrl,
  linkedinCircuitStateTransition,
  linkedinCollectionAttemptState,
  linkedinFailureKind,
  mergeOwnedLinkedInPosts,
  linkedinPostExclusionReason,
  prioritizeLinkedInTargets
} from "./lib/logged-in-linkedin-collection.mjs";
import { readRequiredCanonicalJson } from "./lib/canonical-json.mjs";
import { finalizeLoggedInEvidenceContent } from "./lib/logged-in-evidence-content-dedupe.mjs";
import {
  mergeOwnedXTweetObservations,
  mergeOwnedXTweets,
  prioritizeXTargets,
  xCircuitStateTransition,
  xCollectionAttemptState,
  xFailureKind,
  xTimelinePageState,
  xTweetIngestionDecision,
  xTweetPublicationDate
} from "./lib/logged-in-x-collection.mjs";
import {
  canonicalInstagramPostUrl,
  instagramAdapterProfileIdentityDecision,
  instagramBrowserProfileIdentityDecision,
  instagramCircuitDecision,
  instagramCollectionAttemptState,
  instagramEvidenceProvenance,
  instagramFailureKind,
  instagramPublicationDate,
  normalizeInstagramDetailObservation,
  instagramPostIdFromUrl,
  instagramRecencyDecision,
  instagramTargetIsVerifiedForIngestion,
  mergeVerifiedSocialAccountCandidates,
  prioritizeInstagramTargets
} from "./lib/logged-in-instagram-collection.mjs";
import {
  buildLegacyPublicEvidenceBatchResolver,
  loadAutonomousCatalogs
} from "./lib/autonomous-ingestion-plan.mjs";
import {
  reconcileCheckpointOwnerCollisions
} from "./lib/logged-in-owner-collision-reconciliation.mjs";
import {
  DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS,
  collectionTargetShouldRun,
  partitionCollectionTargetsByOwnerAmbiguity,
  selectRunnableCollectionTargets
} from "./lib/logged-in-social-target-selection.mjs";
import {
  withOpenCliBrowserSession
} from "./lib/opencli-browser-session.mjs";
import {
  canonicalCheckpointPayloads,
  checkpointCanonicalRows
} from "./lib/logged-in-checkpoint-union.mjs";

if (booleanArg("--help") || booleanArg("-h")) {
  await writeStdout(`${usage()}\n`);
  process.exit(0);
}

const root = process.cwd();
const batchConfig = resolveBatchConfig(stringArg("--batch") ?? stringArg("--batch-slug") ?? "S26");
const ycSnapshotPath = batchConfig.snapshotPath;
const outputOverride = stringArg("--output");
const checkpointOverride = stringArg("--checkpoint");
const shardCountArg = numberArg("--shard-count");
const shardIndexArg = numberArg("--shard-index");
const isolatedShard = Boolean(
  outputOverride ||
  checkpointOverride ||
  shardCountArg !== null ||
  shardIndexArg !== null
);
const outputPath = outputOverride
  ? approvedShardPath(outputOverride, "--output")
  : join(root, "src", "lib", "social", "logged-in-evidence-current.json");
const checkpointPath = checkpointOverride
  ? approvedShardPath(checkpointOverride, "--checkpoint")
  : join(
      root,
      "work",
      batchConfig.slug === "S26"
        ? "logged-in-social-checkpoint.json"
        : `logged-in-social-checkpoint-${batchConfig.slug.toLowerCase()}.json`
    );
const checkpointPaths = isolatedShard
  ? [checkpointPath]
  : [
      join(root, "work", "logged-in-social-checkpoint.json"),
      join(root, "work", "logged-in-social-checkpoint-s2026.json"),
      join(root, "work", "logged-in-social-checkpoint-a16zsr006.json")
    ];
const shardCount = Math.max(1, Math.floor(shardCountArg ?? 1));
const shardIndex = Math.floor(shardIndexArg ?? 0);
if (shardIndex < 0 || shardIndex >= shardCount) {
  throw new Error(`--shard-index must be between 0 and ${shardCount - 1}; received ${shardIndex}.`);
}
if (isolatedShard && (!outputOverride || !checkpointOverride)) {
  throw new Error("Isolated shard mode requires both --output and --checkpoint under /private/tmp/returner-fund-shards/x-linkedin.");
}
const verifiedSocialOverridesPath = join(root, "src", "lib", "social", "verified-social-overrides.json");
const priorityEvidencePaths = [
  join(root, "src", "lib", "social", "public-evidence-current.json"),
  join(root, "src", "lib", "social", "targeted-evidence-current.json"),
  join(root, "src", "lib", "social", "a16z-speedrun-006-social-evidence.json")
];
const now = new Date().toISOString();
const targetLimit = numberArg("--max-targets") ?? Number.POSITIVE_INFINITY;
const postLimit = numberArg("--limit") ?? 30;
// Opening every individual /reel/ URL is substantially more likely to trip
// an Instagram account/session restriction than reading the already-visible
// profile grid. Keep the resilient grid/profile path as the default and make
// detail navigation an explicit, bounded operator opt-in.
const instagramFetchDetails =
  booleanArg("--instagram-details") && !booleanArg("--skip-instagram-details");
const scrollPasses = Math.max(0, Math.min(numberArg("--scrolls") ?? 8, 30));
const workers = Math.max(1, Math.min(numberArg("--workers") ?? 2, 8));
const perTargetTimeoutMs = numberArg("--timeout-ms") ?? 75_000;
const delayMs = numberArg("--delay-ms") ?? 1_500;
const force = booleanArg("--force");
const platformFilter = new Set((stringArg("--platforms") ?? "instagram,x").split(",").map((item) => item.trim()).filter(Boolean));
const entityFilter = stringArg("--entities") ?? "all"; // all | company | founder
const companyFilter = stringArg("--company")?.toLowerCase();
const includeRetweets = booleanArg("--include-retweets");
const allowXAdapterFallback = booleanArg("--allow-x-adapter-fallback");
const instagramSiteSession = resolveInstagramSiteSession(
  stringArg("--instagram-site-session") ?? "ephemeral"
);
const xCollectionMode = resolveXCollectionMode(
  stringArg("--x-mode") ?? (allowXAdapterFallback ? "hybrid" : "adapter")
);
const maxConsecutiveXFailures = Math.max(
  1,
  Math.floor(numberArg("--max-consecutive-x-failures") ?? 8)
);
const finalizeOnly = booleanArg("--finalize-only");
const retryEmpty = booleanArg("--retry-empty");
const allowLinkedIn = platformFilter.has("linkedin") && booleanArg("--allow-linkedin");
const linkedinCollectionMode = resolveLinkedInCollectionMode(
  stringArg("--linkedin-mode") ?? "hybrid"
);
const maxConsecutiveLinkedInFailures = Math.max(
  1,
  Math.floor(numberArg("--max-consecutive-linkedin-failures") ?? 5)
);
const maxConsecutiveInstagramFailures = Math.max(
  1,
  Math.floor(numberArg("--max-consecutive-instagram-failures") ?? 3)
);
const freshForHours = Math.max(
  0,
  numberArg("--fresh-for-hours") ?? DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS
);
const planOnly = booleanArg("--plan");
const openCliFormatArgs = ["-f", "json", "--site-session", "persistent"];
const instagramOpenCliFormatArgs = ["-f", "json", "--site-session", instagramSiteSession];
const instagramTractionCutoffMs = Date.parse("2025-01-01T00:00:00.000Z");
let writeSequence = 0;
let checkpointWriteChain = Promise.resolve();
let consecutiveXCollectionFailures = 0;
let xCircuitOpen = false;
let xCircuitReason = null;
let consecutiveLinkedInCollectionFailures = 0;
let linkedinCircuitOpen = false;
let linkedinCircuitReason = null;
let consecutiveInstagramCollectionFailures = 0;
let instagramCircuitOpen = false;
let instagramCircuitReason = null;

const ycSnapshot = normalizeCollectorSnapshot(
  JSON.parse(await readFile(ycSnapshotPath, "utf8")),
  batchConfig
);
const verifiedSocialOverrides = await readRequiredCanonicalJson(
  verifiedSocialOverridesPath,
  "Verified social overrides"
);
const resolveLegacyLoggedInEvidenceBatch = buildLegacyPublicEvidenceBatchResolver(
  await loadAutonomousCatalogs(root)
);
const targetCompanies = ycSnapshot.companies.filter(
  (company) =>
    !companyFilter ||
    company.name.toLowerCase().includes(companyFilter) ||
    company.slug.toLowerCase() === companyFilter
);
const completeTargetPartition = partitionCollectionTargetsByOwnerAmbiguity(
  collectTargets(targetCompanies)
);
const checkpointEntries = await Promise.all(
  checkpointPaths.map(async (path) => ({
    path,
    payload: await readJson(
      path,
      { attempts: {}, evidence: [], failures: [], needsReview: [] }
    )
  }))
);
const rawCheckpoint =
  checkpointEntries.find((entry) => entry.path === checkpointPath)?.payload ??
  { attempts: {}, evidence: [], failures: [], needsReview: [] };
const {
  snapshot: checkpoint,
  summary: ownerCollisionReconciliationSummary
} = reconcileCheckpointOwnerCollisions(
  rawCheckpoint,
  completeTargetPartition.collisions,
  { observedAt: now }
);
const checkpointPayloads = canonicalCheckpointPayloads(checkpointEntries, {
  activePath: checkpointPath,
  activeCheckpoint: checkpoint
});
const currentOutput = await readJson(outputPath, { evidence: [], failures: [], needsReview: [] });
const attemptMap = new Map(Object.entries(checkpoint.attempts ?? {}));
const initialContentDedupe = finalizeLoggedInEvidenceContent(
  dedupeById([
    ...(currentOutput.evidence ?? []),
    ...checkpointCanonicalRows(checkpointPayloads, "evidence")
  ]),
  {
    defaultBatchSlug: batchConfig.slug,
    resolveBatchSlug: resolveLegacyLoggedInEvidenceBatch,
    existingNeedsReview: [
      ...(currentOutput.needsReview ?? []),
      ...checkpointCanonicalRows(checkpointPayloads, "needsReview")
    ],
    existingAttributionReconciliationLedger: [
      ...(currentOutput.attributionReconciliationLedger ?? []),
      ...checkpointCanonicalRows(
        checkpointPayloads,
        "attributionReconciliationLedger"
      )
    ]
  }
);
const evidence = initialContentDedupe.evidence;
const exclusions = dedupeById([
  ...(currentOutput.exclusions ?? []),
  ...checkpointCanonicalRows(checkpointPayloads, "exclusions")
]);
const priorityEvidence = [
  ...evidence,
  ...(await Promise.all(
    priorityEvidencePaths.map((path) =>
      readJson(path, { evidence: [] })
    )
  )).flatMap((payload) => payload.evidence ?? [])
];
const failures = dedupeById([
  ...(currentOutput.failures ?? []),
  ...checkpointCanonicalRows(checkpointPayloads, "failures")
]);
const needsReview = dedupeById([
  ...initialContentDedupe.needsReview
]);
const attributionReconciliationLedger = initialContentDedupe.attributionReconciliationLedger;

const targetPartition = finalizeOnly
  ? { ...completeTargetPartition, targets: [] }
  : completeTargetPartition;
const allTargets = targetPartition.targets;
addItems(
  targetPartition.collisions.map(ownerCollisionReviewItem),
  needsReview
);
restoreRetryableXFailures(allTargets);
const prioritizedTargets = prioritizeInstagramTargets(
  prioritizeLinkedInTargets(
    prioritizeXTargets(allTargets, {
      evidence: priorityEvidence,
      attempts: attemptMap,
      attemptKey: attemptKeyFor
    }),
    {
      evidence: priorityEvidence,
      attempts: attemptMap,
      attemptKey: attemptKeyFor
    }
  ),
  {
    evidence: priorityEvidence,
    attempts: attemptMap,
    attemptKey: attemptKeyFor
  },
);
const shardedPrioritizedTargets = isolatedShard
  ? prioritizedTargets.filter((_, index) => index % shardCount === shardIndex)
  : prioritizedTargets;
const runnableTargets = selectRunnableCollectionTargets(shardedPrioritizedTargets, {
  attempts: attemptMap,
  attemptKey: attemptKeyFor,
  force,
  retryEmpty,
  freshForHours,
  now,
  limit: targetLimit
});
// The plan is a canonical account map and must not shrink as checkpoints
// complete. Only runtime execution uses the bounded runnable subset.
const targets = planOnly
  ? shardedPrioritizedTargets
  : runnableTargets;
const proofTargets = finalizeOnly && isolatedShard
  ? completeTargetPartition.targets.filter((target) => attemptMap.has(attemptKeyFor(target)))
  : targets;
console.log(`Logged-in social targets: ${targets.length} (${workers} workers, up to ${postLimit} posts each, ${scrollPasses} scroll passes).`);

if (planOnly) {
  const coverage = socialTargetCoverage(targetCompanies, prioritizedTargets);
  const planPayload = JSON.stringify({
    batchSlug: batchConfig.slug,
    snapshotPath: ycSnapshotPath,
    checkpointPath,
    catalogCompanyCount: ycSnapshot.companies.length,
    companyCount: new Set(coverage.filter((row) => row.entityType === "company").map((row) => row.entityId)).size,
    founderCount: new Set(coverage.filter((row) => row.entityType === "founder").map((row) => row.entityId)).size,
    coverage,
    xCollectionMode,
    linkedinCollectionMode,
    quarantinedTargetCount: targetPartition.quarantinedTargets.length,
    ownerCollisionReconciliationSummary,
    ownerAccountCollisions: targetPartition.collisions.map((collision) => ({
      batchSlug: collision.batchSlug,
      platform: collision.platform,
      accountIdentity: collision.accountIdentity,
      entityIds: collision.entityIds,
      targets: collision.targets.map((target) => ({
        companySlug: target.companySlug,
        companyName: target.companyName,
        entityType: target.entityType,
        entityId: target.entityId,
        entityName: target.name,
        platform: target.platform,
        accountUrl: target.url,
        checkpointKey: attemptKeyFor(target)
      }))
    })),
    runnableTargetCount: runnableTargets.length,
    runnableTargets: runnableTargets.map((target) => ({
      batchSlug: target.batchSlug,
      companySlug: target.companySlug,
      companyName: target.companyName,
      entityType: target.entityType,
      entityId: target.entityId,
      entityName: target.name,
      platform: target.platform,
      accountUrl: target.url,
      activityUrl: target.platform === "linkedin" ? linkedInActivityUrl(target.url) : target.url,
      checkpointKey: attemptKeyFor(target)
    })),
    targets: targets.map((target) => ({
      batchSlug: target.batchSlug,
      companySlug: target.companySlug,
      companyName: target.companyName,
      entityType: target.entityType,
      entityId: target.entityId,
      entityName: target.name,
      platform: target.platform,
      accountUrl: target.url,
      activityUrl: target.platform === "linkedin" ? linkedInActivityUrl(target.url) : target.url,
      checkpointKey: attemptKeyFor(target)
    }))
  }, null, 2);
  await writeStdout(`${planPayload}\n`);
  process.exit(0);
}

await runWorkerPool(targets, workers, async (target, workerIndex) => {
  if (target.platform === "x" && xCircuitOpen) return;
  if (target.platform === "linkedin" && linkedinCircuitOpen) return;
  if (target.platform === "instagram" && instagramCircuitOpen) return;

  const attemptKey = attemptKeyFor(target);
  if (
    !collectionTargetShouldRun(target, {
      attempts: attemptMap,
      attemptKey: attemptKeyFor,
      force,
      retryEmpty,
      freshForHours,
      now
    })
  ) return;

  try {
    const result =
      target.platform === "linkedin"
        ? await fetchLinkedInPosts(target, workerIndex)
        : target.platform === "instagram"
          ? await fetchInstagramPosts(target, workerIndex)
          : await fetchXTweets(target, workerIndex);
    // A forced refresh must never turn a rate-limit, challenge, timeout, or
    // legitimate empty read into data loss. Replace the prior target rows
    // only after a non-empty collection has completed successfully.
    const replaceTargetEvidence =
      force && !result.collectionFailed && result.evidence.length > 0;
    if (replaceTargetEvidence) removeTargetEvidence(target);
    removeTargetFailures(target);
    addItems(result.evidence, evidence);
    addItems(result.failures, failures);
    addItems(result.exclusions, exclusions);
    addItems(result.needsReview, needsReview);
    const attemptStatus = result.collectionFailed ? "failed" : "done";
    attemptMap.set(
      attemptKey,
      attemptStatus === "failed"
        ? {
            status: "failed",
            checkedAt: now,
            count: 0,
            error: result.failures.map((item) => item.message).join(" | ")
          }
        : { status: "done", checkedAt: now, count: result.evidence.length }
    );
    if (target.platform === "x") {
      updateXCircuitState(result, target);
    } else if (target.platform === "linkedin") {
      updateLinkedInCircuitState(result, target);
    } else if (target.platform === "instagram") {
      updateInstagramCircuitState(result, target);
    }
    const log = attemptStatus === "failed" ? console.warn : console.log;
    log(`${target.platform} ${target.companyName} / ${target.name}: ${result.evidence.length} posts (${attemptStatus})`);
  } catch (error) {
    const message = errorMessage(error);
    failures.push(failure(target, message));
    attemptMap.set(attemptKey, { status: "failed", checkedAt: now, error: message });
    if (target.platform === "instagram") {
      const classifiedFailure = instagramFailureKind(message);
      updateInstagramCircuitState(
        {
          collectionFailed: true,
          failureKind:
            classifiedFailure === "other" || classifiedFailure === "empty"
              ? "command_or_profile"
              : classifiedFailure,
          failures: [{ message }]
        },
        target
      );
    } else if (target.platform === "x") {
      updateXCircuitState(
        {
          collectionFailed: true,
          failures: [{ message }]
        },
        target
      );
    }
    console.warn(`${target.platform} ${target.companyName} / ${target.name}: ${message}`);
  }

  await writeCheckpoint();
  await delay(delayMs);
});

if (xCircuitOpen) {
  console.warn(
    `X collection circuit opened after repeated authenticated-session failures. ` +
    `Remaining targets were left untouched and retryable. ${xCircuitReason}`
  );
}
if (linkedinCircuitOpen) {
  console.warn(
    `LinkedIn collection circuit opened after authenticated-read failures. ` +
    `Remaining LinkedIn targets were left untouched and retryable. ${linkedinCircuitReason}`
  );
}
if (instagramCircuitOpen) {
  console.warn(
    `Instagram collection circuit opened after authenticated-read failures. ` +
    `Remaining Instagram targets were left untouched and retryable. ${instagramCircuitReason}`
  );
}

const payloadFailures = dedupeById(failures).filter((item) => !isObsoleteToolFailure(item.message));
const contentDedupe = finalizeLoggedInEvidenceContent(dedupeById(evidence), {
  defaultBatchSlug: batchConfig.slug,
  resolveBatchSlug: resolveLegacyLoggedInEvidenceBatch,
  existingNeedsReview: needsReview,
  existingAttributionReconciliationLedger: attributionReconciliationLedger
});
const payload = {
  source: {
    label: "Opt-in browser social post ingestion",
    batchSlug: batchConfig.slug,
    fetchedAt: now,
    targetCount: proofTargets.length,
    isolatedShard,
    shardIndex,
    shardCount,
    fetchedCount: proofTargets.filter((target) => attemptMap.get(attemptKeyFor(target))?.status === "done").length,
    failedCount: proofTargets.filter((target) => attemptMap.get(attemptKeyFor(target))?.status === "failed").length,
    notes: [
      "Read-only browser automation through an explicitly selected OpenCLI site session; Instagram defaults to an ephemeral session and persistent authentication is opt-in.",
      "No likes, follows, comments, messages, saves, stars, subscriptions, profile edits, or other mutations are performed.",
      `Instagram profile grids and X profile timelines are treated as opt-in read-only sources when explicitly targeted. Instagram adapter calls use one ${instagramSiteSession} site session by default; they stop on auth/challenge/rate-limit responses rather than rotating sessions.`,
      `X ingestion mode: ${xCollectionMode}. Browser, adapter, and hybrid modes are read-only; hybrid prefers the authenticated adapter and uses the DOM only to fill incomplete results.`,
      `LinkedIn ingestion mode: ${linkedinCollectionMode}. Personal /in/ profiles may use the authenticated adapter; company /company/ pages always retain DOM collection support.`,
      "Logged-in LinkedIn activity scraping is disabled unless both --platforms=linkedin and --allow-linkedin are passed. Auth and rate-limit failures open a circuit so untouched targets remain retryable.",
      "Instagram login, challenge, and rate-limit failures open a circuit immediately; repeated command or profile failures open it after three consecutive failed targets. Legitimate empty native timelines remain completed empty checks.",
      `Checkpoint owner-collision reconciliation: ${ownerCollisionReconciliationSummary.reattributedCount} stale company rows reattributed, ${ownerCollisionReconciliationSummary.quarantinedCount} quarantined.`,
      "Each target is checkpointed independently; blocked or timed-out profiles are logged and do not stop the batch."
    ]
  },
  evidence: sanitizeStoredRows(contentDedupe.evidence).sort((a, b) => b.contributionScore - a.contributionScore),
  exclusions: sanitizeStoredRows(dedupeById(exclusions)),
  failures: sanitizeStoredRows(payloadFailures),
  needsReview: sanitizeStoredRows(contentDedupe.needsReview),
  attributionReconciliationLedger: contentDedupe.attributionReconciliationLedger,
  terminalProof: buildTerminalProof(proofTargets, attemptMap, {
    xCircuitOpen,
    xCircuitReason,
    linkedinCircuitOpen,
    linkedinCircuitReason
  }),
  externalBlockers: buildExternalBlockers(payloadFailures)
};

await writeJson(outputPath, payload);
await writeCheckpoint();
console.log(`Wrote ${payload.evidence.length} logged-in post evidence items, ${payload.failures.length} failures.`);

function normalizeCollectorSnapshot(snapshot, config) {
  if (Array.isArray(snapshot?.companies)) return snapshot;
  if (!Array.isArray(snapshot?.nodes)) {
    throw new Error(`${config.snapshotPath} does not contain companies or graph nodes.`);
  }

  return {
    source: {
      label: `${config.label} graph collector catalog`,
      fetchedAt: snapshot.generatedAt ?? null
    },
    companies: snapshot.nodes
      .filter((node) => node?.entityType === "company" && node.entityId && node.label)
      .map((node) => ({
        id: node.entityId,
        entityId: node.entityId,
        objectID: node.entityId,
        slug: collectorCompanySlug(node),
        name: node.label,
        batch: config.label,
        ycProfileUrl: node.sourceUrl ?? node.ycProfileUrl ?? null,
        websiteUrl: node.websiteUrl ?? null,
        socialLinks: socialLinksFromGraphAccounts(node.socialAccounts),
        socialAccounts: socialAccountsFromGraphAccounts(node.socialAccounts),
        founders: (node.founders ?? []).map((founder) => ({
          id: founder.id,
          entityId: founder.id,
          name: founder.name,
          ycProfileUrl: founder.ycProfileUrl ?? null,
          socialLinks: socialLinksFromGraphAccounts(founder.socialAccounts),
          socialAccounts: socialAccountsFromGraphAccounts(founder.socialAccounts)
        }))
      }))
  };
}

function collectorCompanySlug(node) {
  try {
    const parts = new URL(node.sourceUrl ?? node.ycProfileUrl).pathname.split("/").filter(Boolean);
    const companiesIndex = parts.indexOf("companies");
    if (companiesIndex >= 0 && parts[companiesIndex + 1]) return parts[companiesIndex + 1];
  } catch {
    // Fall back to the graph entity ID.
  }
  return String(node.entityId).replace(/^a16z-speedrun-006-/, "");
}

function socialLinksFromGraphAccounts(accounts) {
  const links = {};
  for (const account of accounts ?? []) {
    if (account?.review_state && account.review_state !== "verified") continue;
    const platform = account?.platform === "twitter" ? "x" : account?.platform;
    if (["x", "linkedin", "instagram"].includes(platform) && account?.url && !links[platform]) {
      links[platform] = account.url;
    }
  }
  return links;
}

function socialAccountsFromGraphAccounts(accounts) {
  return (accounts ?? [])
    .filter((account) => !account?.review_state || account.review_state === "verified")
    .map((account) => ({
      ...account,
      platform: socialPlatformForUrl(account?.platform, account?.url),
      url: account?.url
    }))
    .filter((account) => ["x", "linkedin", "instagram"].includes(account.platform) && account.url);
}

function collectTargets(companies) {
  const targets = [];

  for (const company of companies) {
    if (companyFilter && !company.name.toLowerCase().includes(companyFilter) && company.slug !== companyFilter) {
      continue;
    }
    if (entityFilter !== "founder") {
      const companyOverride = verifiedSocialOverrides[company.slug] ?? {};
      const companyAccounts = verifiedOwnerSocialAccounts(
        company,
        companyOverride.companySocialLinks ?? companyOverride.company,
        companyOverride
      );
      for (const account of companyAccounts) {
        if (!platformFilter.has(account.platform)) continue;
        if (account.platform === "linkedin" && !allowLinkedIn) continue;
        const instagramTargetVerified =
          account.platform !== "instagram" ||
          instagramTargetIsVerifiedForIngestion({
            account,
            override: companyOverride,
            matchReason:
              account.matchReason ??
              companyOverride.matchReason ??
              company.matchReason
          });
        if (!instagramTargetVerified) continue;
        targets.push(targetFor(
          company,
          { ...company, matchReason: companyOverride.matchReason ?? company.matchReason },
          "company",
          account.platform,
          account.url,
          { instagramTargetVerified }
        ));
      }
    }

    if (entityFilter !== "company") {
      for (const founder of company.founders ?? []) {
        const verifiedFounder = (verifiedSocialOverrides[company.slug]?.founders ?? []).find(
          (candidate) => String(candidate.id) === String(founder.id) || slugify(candidate.name) === slugify(founder.name)
        );
        const founderAccounts = verifiedOwnerSocialAccounts(
          founder,
          verifiedFounder?.socialLinks,
          verifiedFounder
        );
        const targetFounder = verifiedFounder
          ? {
              ...founder,
              ...verifiedFounder,
              id: founder.id,
              ...(founder.entityId ? { entityId: founder.entityId } : {}),
              socialLinks: Object.fromEntries(founderAccounts.map((account) => [account.platform, account.url])),
              socialAccounts: founderAccounts
            }
          : founder;
        for (const account of founderAccounts) {
          if (!platformFilter.has(account.platform)) continue;
          if (account.platform === "linkedin" && !allowLinkedIn) continue;
          const instagramTargetVerified =
            account.platform !== "instagram" ||
            instagramTargetIsVerifiedForIngestion({
              account,
              override: verifiedFounder,
              matchReason:
                account.matchReason ??
                verifiedFounder?.matchReason ??
                founder.matchReason
            });
          if (!instagramTargetVerified) continue;
          targets.push(targetFor(
            company,
            verifiedFounder ? targetFounder : founder,
            "founder",
            account.platform,
            account.url,
            { instagramTargetVerified }
          ));
        }
      }
    }

    targets.push(...manualTargetsForCompany(company));
  }

  return dedupeTargets(targets.filter((target) => target.url));
}

function verifiedOwnerSocialAccounts(owner = {}, positiveLinks = {}, ownerOverride = {}) {
  const retiredKeys = new Set(
    retiredOwnerSocialAccounts(ownerOverride)
      .map(({ platform, url }) => {
        const normalizedPlatform = socialPlatformForUrl(platform, url);
        return `${normalizedPlatform}:${normalizeComparableUrl(url)}`;
      })
  );
  const candidates = [
    ...(owner.socialAccounts ?? []).map((account) => ({
      ...account,
      platform: socialPlatformForUrl(account?.platform, account?.url),
      url: account?.url
    })),
    ...Object.entries(owner.socialLinks ?? {}).map(([platform, url]) => ({
      platform: socialPlatformForUrl(platform, url),
      url
    })),
    ...Object.entries(positiveLinks ?? {}).map(([platform, url]) => ({
      platform: socialPlatformForUrl(platform, url),
      url
    }))
  ]
    .filter((account) => ["x", "linkedin", "instagram"].includes(account.platform) && account.url)
    .filter((account) => !retiredKeys.has(`${account.platform}:${normalizeComparableUrl(account.url)}`));
  return mergeVerifiedSocialAccountCandidates(candidates);
}

function retiredOwnerSocialAccounts(ownerOverride) {
  const records = [];
  for (const [key, value] of Object.entries(ownerOverride ?? {})) {
    const match = key.match(/^rejected([A-Z].*)$/);
    if (!match || !Array.isArray(value)) continue;
    const platform = normalizePlatform(
      match[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    );
    for (const record of value) if (record?.url) records.push({ ...record, platform });
  }
  for (const record of ownerOverride?.retiredAccounts ?? []) {
    if (record?.platform && record?.url) records.push(record);
  }
  return records;
}

function normalizePlatform(value) {
  const platform = String(value ?? "").toLowerCase();
  return platform === "twitter" ? "x" : platform;
}

function socialPlatformForUrl(declaredPlatform, url) {
  for (const platform of ["x", "linkedin", "instagram"]) {
    if (urlMatchesPlatform(url, platform)) return platform;
  }
  return normalizePlatform(declaredPlatform);
}

function socialTargetCoverage(companies, plannedTargets) {
  const targetsByIdentity = new Map();
  for (const target of plannedTargets) {
    const key = `${target.entityId}:${target.platform}`;
    targetsByIdentity.set(key, [...(targetsByIdentity.get(key) ?? []), target]);
  }
  const coverage = [];
  const entityIdentities = new Set();

  for (const company of companies) {
    const entities = [];
    if (entityFilter !== "founder") entities.push([company, "company"]);
    if (entityFilter !== "company") {
      entities.push(...(company.founders ?? []).map((founder) => [founder, "founder"]));
    }
    for (const [entity, entityType] of entities) {
      const entityId = collectorEntityId(company, entity, entityType);
      entityIdentities.add(entityId);
      for (const platform of ["x", "linkedin", "instagram"]) {
        const targets = targetsByIdentity.get(`${entityId}:${platform}`) ?? [];
        for (const target of targets.length ? targets : [null]) {
          coverage.push({
            batchSlug: batchConfig.slug,
            companySlug: company.slug,
            companyName: company.name,
            entityType,
            entityId,
            entityName: entityType === "company" ? company.name : entity.name,
            platform,
            accountUrl: target?.url ?? null,
            status: !platformFilter.has(platform)
              ? "platform_filtered"
              : platform === "linkedin" && !allowLinkedIn
                ? "linkedin_opt_in_required"
                : target
                  ? "mapped_target"
                  : "no_verified_account"
          });
        }
      }
    }
  }

  for (const target of plannedTargets) {
    if (entityIdentities.has(target.entityId)) continue;
    for (const platform of ["x", "linkedin", "instagram"]) {
      const matchingTargets = targetsByIdentity.get(`${target.entityId}:${platform}`) ?? [];
      for (const matchingTarget of matchingTargets.length ? matchingTargets : [null]) {
        coverage.push({
          batchSlug: batchConfig.slug,
          companySlug: target.companySlug,
          companyName: target.companyName,
          entityType: target.entityType,
          entityId: target.entityId,
          entityName: target.name,
          platform,
          accountUrl: matchingTarget?.url ?? null,
          status: matchingTarget ? "mapped_target" : "no_verified_account"
        });
      }
    }
    entityIdentities.add(target.entityId);
  }

  return coverage;
}

function targetFor(
  company,
  entity,
  entityType,
  platform,
  url,
  { instagramTargetVerified = false } = {}
) {
  return {
    platform,
    url,
    batchSlug: batchConfig.slug,
    batch: company.batch,
    companySlug: company.slug,
    companyName: company.name,
    companyWebsiteUrl: company.websiteUrl,
    entityType,
    entityId: collectorEntityId(company, entity, entityType),
    name: entityType === "company" ? company.name : entity.name,
    matchReason: entity.matchReason ?? null,
    instagramTargetVerified:
      platform === "instagram" ? instagramTargetVerified === true : undefined
  };
}

function manualTargetsForCompany(company) {
  const override = verifiedSocialOverrides[company.slug];
  if (!override) return [];

  const targets = [];
  if (entityFilter !== "founder") {
    for (const [platform, url] of Object.entries(override.companySocialLinks ?? override.company ?? {})) {
      if (platformFilter.has(platform)) {
        if (platform === "linkedin" && !allowLinkedIn) continue;
        if (
          platform === "instagram" &&
          !instagramTargetIsVerifiedForIngestion({
            override,
            matchReason: override.matchReason
          })
        ) {
          continue;
        }
        targets.push(
          targetFor(
            company,
            {
              ...company,
              matchReason:
                override.matchReason ??
                `Verified social override for ${company.name}; profile links back to the official company identity.`
            },
            "company",
            platform,
            url,
            { instagramTargetVerified: platform === "instagram" }
          )
        );
      }
    }
  }

  if (entityFilter !== "company") {
    for (const founderOverride of override.founders ?? []) {
      const catalogFounder = (company.founders ?? []).find(
        (candidate) =>
          String(candidate.id) === String(founderOverride.id) ||
          slugify(candidate.name) === slugify(founderOverride.name)
      );
      const founder = catalogFounder
        ? {
            ...catalogFounder,
            ...founderOverride,
            id: catalogFounder.id,
            ...(catalogFounder.entityId ? { entityId: catalogFounder.entityId } : {}),
            socialLinks: {
              ...(catalogFounder.socialLinks ?? {}),
              ...(founderOverride.socialLinks ?? {})
            }
          }
        : founderOverride;
      for (const platform of ["instagram", "x", "linkedin"]) {
        const url = founder.socialLinks?.[platform] ?? founder[platform];
        if (url && platformFilter.has(platform)) {
          if (platform === "linkedin" && !allowLinkedIn) continue;
          if (
            platform === "instagram" &&
            !instagramTargetIsVerifiedForIngestion({
              override: founderOverride,
              matchReason: founder.matchReason
            })
          ) {
            continue;
          }
          targets.push(
            targetFor(
              company,
              founder,
              "founder",
              platform,
              url,
              { instagramTargetVerified: platform === "instagram" }
            )
          );
        }
      }
    }
  }

  return targets;
}

function dedupeTargets(targets) {
  return [
    ...new Map(
      targets.map((target) => [
        `${target.platform}:${target.entityId}:${normalizeComparableUrl(target.url)}`,
        target
      ])
    ).values()
  ];
}

async function fetchLinkedInPosts(target, workerIndex) {
  if (!urlMatchesPlatform(target.url, "linkedin")) {
    return {
      evidence: [],
      failures: [failure(target, "LinkedIn URL host did not match linkedin.com.")],
      needsReview: [],
      collectionFailed: true
    };
  }

  const activityUrl = linkedInActivityUrl(target.url);
  if (!activityUrl) {
    return {
      evidence: [],
      failures: [failure(target, "Unsupported LinkedIn URL shape.")],
      needsReview: [],
      collectionFailed: true
    };
  }

  const adapterSupported = linkedinAdapterSupportsAccountUrl(target.url);
  const postGroups = [];
  const sourceFailures = [];
  let attemptedSourceCount = 0;
  let completedSourceCount = 0;

  if (
    adapterSupported &&
    (linkedinCollectionMode === "adapter" || linkedinCollectionMode === "hybrid")
  ) {
    attemptedSourceCount += 1;
    try {
      const adapterPosts = await fetchLinkedInPostsFromAdapter(target);
      postGroups.push(adapterPosts);
      const attributableAdapterPosts = mergeOwnedLinkedInPosts(
        [adapterPosts],
        {
          accountUrl: target.url,
          targetName: target.name,
          limit: postLimit
        }
      );
      if (!adapterPosts.length || attributableAdapterPosts.length) {
        completedSourceCount += 1;
      }
    } catch (error) {
      const message = errorMessage(error);
      if (linkedinFailureKind(message) === "empty") {
        completedSourceCount += 1;
      } else {
        sourceFailures.push(
          failure(target, `LinkedIn adapter failed: ${message}`, target.url)
        );
      }
    }
  }

  // OpenCLI's LinkedIn adapter only accepts /in/ profiles. Keep the DOM path
  // for every /company/ page even when adapter mode is requested.
  if (
    linkedinCollectionMode === "browser" ||
    linkedinCollectionMode === "hybrid" ||
    !adapterSupported
  ) {
    attemptedSourceCount += 1;
    try {
      const browserPosts = await fetchLinkedInPostsFromBrowser(
        target,
        workerIndex,
        activityUrl
      );
      postGroups.push(browserPosts);
      const attributableBrowserPosts = mergeOwnedLinkedInPosts(
        [browserPosts],
        {
          accountUrl: target.url,
          targetName: target.name,
          limit: postLimit
        }
      );
      if (!browserPosts.length || attributableBrowserPosts.length) {
        completedSourceCount += 1;
      }
    } catch (error) {
      const message = errorMessage(error);
      if (linkedinFailureKind(message) === "empty") {
        completedSourceCount += 1;
      } else {
        sourceFailures.push(
          failure(target, `LinkedIn browser DOM extractor failed: ${message}`, activityUrl)
        );
      }
    }
  }

  const linkedinExclusions = postGroups
    .flat()
    .map((post) => {
      const reason = linkedinPostExclusionReason(post, {
        accountUrl: target.url,
        targetName: target.name
      });
      return reason
        ? exclusion(target, reason, post?.url ?? activityUrl, {
            nativePostId: linkedinPostIdFromUrl(post?.url)
          })
        : null;
    })
    .filter(Boolean);
  const posts = mergeOwnedLinkedInPosts(
    postGroups,
    {
      accountUrl: target.url,
      targetName: target.name,
      limit: postLimit
    }
  );
  const attemptState = linkedinCollectionAttemptState({
    postCount: posts.length,
    attemptedSourceCount,
    completedSourceCount,
    failedSourceCount: sourceFailures.length
  });
  if (!posts.length) {
    return {
      evidence: [],
      exclusions: linkedinExclusions,
      failures: sourceFailures.length
        ? sourceFailures
        : [failure(
            target,
            `No attributable original LinkedIn posts were visible in ${linkedinCollectionMode} mode.`,
            activityUrl
          )],
      needsReview: [],
      collectionFailed: attemptState.collectionFailed
    };
  }

  return {
    evidence: posts.map((post) =>
      socialEvidenceItem({
        target,
        sourceUrl: post.url,
        platformPostId: linkedinPostIdFromUrl(post.url),
        accountUrl: target.url,
        title: `${target.name} LinkedIn post`,
        text: post.body || post.rawText || `${target.name} LinkedIn post`,
        rawVisibleText: post.rawText || post.body || "",
        postedAt: parseDateOrNull(post.postedAt),
        metrics: {
          likes: numberOrNull(post.reactions),
          comments: numberOrNull(post.comments),
          reposts: numberOrNull(post.reposts),
          views: numberOrNull(post.impressions)
        },
        mediaUrls: post.mediaUrls ?? [],
        contributionScore: scoreMetrics("linkedin", {
          likes: numberOrNull(post.reactions),
          comments: numberOrNull(post.comments),
          reposts: numberOrNull(post.reposts),
          views: numberOrNull(post.impressions)
        }),
        matchReason:
          `Opt-in authenticated read-only LinkedIn ${linkedinCollectionMode} collection from ` +
          `${target.entityType} URL; the native activity ID and author identity were both verified.`
      })
    ),
    failures: sourceFailures,
    exclusions: linkedinExclusions,
    needsReview: [],
    collectionFailed: attemptState.collectionFailed
  };
}

async function fetchLinkedInPostsFromAdapter(target) {
  const raw = await runOpenCli(
    [
      "linkedin",
      "posts",
      "--profile-url",
      target.url,
      "--limit",
      String(postLimit),
      "-f",
      "json",
      "--site-session",
      "ephemeral",
      "--keep-tab",
      "false"
    ],
    { timeoutMs: Math.min(perTargetTimeoutMs, 45_000) }
  );
  return parseJsonOutput(raw);
}

async function fetchLinkedInPostsFromBrowser(target, workerIndex, activityUrl) {
  const session =
    `yc-li-${workerIndex}-${slugify(target.entityId || target.name)}-${Date.now()}`;
  return withOpenCliBrowserSession({
    session,
    runOpenCli,
    operation: async () => {
      await runOpenCli(["browser", session, "open", activityUrl], {
        timeoutMs: perTargetTimeoutMs
      });
      await runOpenCli(["browser", session, "wait", "time", "5"], {
        timeoutMs: 12_000
      });
      for (let index = 0; index < scrollPasses; index += 1) {
        await runOpenCli(["browser", session, "scroll", "down", "--amount", "1200"], {
          timeoutMs: 12_000
        }).catch(() => null);
        await runOpenCli(["browser", session, "wait", "time", "2"], {
          timeoutMs: 8_000
        }).catch(() => null);
      }
      const raw = await runOpenCli(
        ["browser", session, "eval", linkedInExtractJs()],
        { timeoutMs: perTargetTimeoutMs }
      );
      return parseJsonOutput(raw);
    }
  });
}

async function fetchInstagramPosts(target, workerIndex) {
  if (!urlMatchesPlatform(target.url, "instagram")) {
    return { evidence: [], failures: [failure(target, "Instagram URL host did not match instagram.com.")], needsReview: [] };
  }

  const handle = instagramHandleFromUrl(target.url);
  if (!handle) {
    return { evidence: [], failures: [failure(target, "Could not parse Instagram username.")], needsReview: [] };
  }

  const adapterFailures = [];
  let profileAdapterCompleted = false;
  let timelineAdapterCompleted = false;
  let browserGridCompleted = false;
  const [profileRaw, postsRaw, gridUrls] = await Promise.all([
    runOpenCli(
      ["instagram", "profile", handle, ...instagramOpenCliFormatArgs],
      { timeoutMs: perTargetTimeoutMs }
    )
      .then((raw) => {
        profileAdapterCompleted = true;
        return raw;
      })
      .catch((error) => {
        adapterFailures.push(failure(target, `Instagram profile adapter failed: ${errorMessage(error)}`));
        return "[]";
      }),
    runOpenCli(["instagram", "user", handle, "--limit", String(postLimit), ...instagramOpenCliFormatArgs], {
      timeoutMs: perTargetTimeoutMs
    })
      .then((raw) => {
        timelineAdapterCompleted = true;
        return raw;
      })
      .catch((error) => {
        adapterFailures.push(failure(target, `Instagram user adapter failed: ${errorMessage(error)}`));
        return "[]";
      }),
    fetchInstagramGridUrls(handle, workerIndex, postLimit)
      .then((items) => {
        browserGridCompleted = true;
        return items;
      })
      .catch((error) => {
        adapterFailures.push(failure(target, `Instagram browser grid extractor failed: ${errorMessage(error)}`));
        return [];
      })
  ]);

  const profile = parseJsonOutput(profileRaw)[0] ?? null;
  const posts = parseJsonOutput(postsRaw).slice(0, postLimit);
  const profileIdentity = instagramAdapterProfileIdentityDecision({
    requestedHandle: handle,
    profile,
    targetVerified: target.instagramTargetVerified === true
  });
  // A completed grid read already passed the browser's exact-profile identity
  // gate inside fetchInstagramGridUrls. Do not turn that independently proven,
  // legitimately empty profile into a retryable failure just because the
  // redundant profile adapter was unavailable.
  const profileIdentityOk =
    (profileAdapterCompleted && profileIdentity.ok) || browserGridCompleted;
  if (!profileIdentityOk) {
    const identityFailure = failure(
      target,
      `Instagram profile identity was not proven for @${handle}: ${profileIdentity.reason}.`
    );
    const targetFailures = [...adapterFailures, identityFailure];
    const attemptState = instagramCollectionAttemptState({
      evidenceCount: 0,
      completedTimelineSourceCount:
        Number(timelineAdapterCompleted) + Number(browserGridCompleted),
      profileIdentityOk: false,
      failureMessages: targetFailures.map((item) => item.message)
    });
    return {
      evidence: [],
      failures: targetFailures,
      needsReview: [],
      collectionFailed: attemptState.collectionFailed,
      failureKind: attemptState.failureKind
    };
  }
  const detailItems = instagramFetchDetails
    ? await fetchInstagramPostDetails(handle, gridUrls, workerIndex).catch(() => [])
    : [];
  const detailUnavailable = instagramFetchDetails && detailItems.length < gridUrls.length;
  let rejectedAdapterIdentityCount = 0;
  const adapterEvidence = posts.flatMap((post) => {
    const provenance = instagramEvidenceProvenance({
      post,
      gridItems: gridUrls,
      detailItems
    });
    if (!provenance) {
      rejectedAdapterIdentityCount += 1;
      return [];
    }
    const {
      sourceUrl,
      platformPostId,
      gridItem,
      detail
    } = provenance;
    const metrics = {
      likes: maxMetric(post.likes, detail?.likes, gridItem?.likes),
      comments: maxMetric(post.comments, detail?.comments, gridItem?.comments),
      views: maxMetric(post.views, detail?.views, gridItem?.views)
    };
    const caption = bestInstagramCaption(post.caption, gridItem?.caption, detail?.caption);
    return [socialEvidenceItem({
      target,
      sourceUrl,
      platformPostId,
      title: caption || `${handle} Instagram ${post.type ?? "post"}`,
      text: caption || `${handle} Instagram ${post.type ?? "post"}`,
      rawVisibleText: JSON.stringify({ profile, post, gridItem, detail }),
      postedAt:
        instagramPublicationDate(post, Date.parse(now)).postedAt ??
        instagramPublicationDate(detail, Date.parse(now)).postedAt,
      metrics,
      mediaUrls: detail?.mediaUrls ?? gridItem?.mediaUrls ?? [],
      contributionScore: scoreMetrics("instagram", metrics),
      matchReason:
        target.matchReason ??
        `Opt-in read-only Instagram profile scrape for @${handle}; metrics came from visible post grid/profile` +
        `${instagramFetchDetails ? "/detail" : ""} data.`
    })];
  });
  const seenPostIds = new Set(adapterEvidence.map((item) => item.platformPostId).filter(Boolean));
  const gridEvidence = gridUrls
    .filter((gridUrl) => {
      const sourceUrl = canonicalInstagramPostUrl(gridUrl.href);
      const postId = instagramPostIdFromUrl(sourceUrl);
      return sourceUrl && postId && !seenPostIds.has(postId);
    })
    .map((gridUrl) => {
      const sourceUrl = canonicalInstagramPostUrl(gridUrl.href);
      const postId = instagramPostIdFromUrl(sourceUrl);
      const detail = detailItems.find(
        (item) => instagramPostIdFromUrl(item?.url) === postId
      );
      const metrics = {
        likes: maxMetric(detail?.likes, gridUrl.likes),
        comments: maxMetric(detail?.comments, gridUrl.comments),
        views: maxMetric(detail?.views, gridUrl.views)
      };
      const caption = bestInstagramCaption(gridUrl.caption, detail?.caption);
      return socialEvidenceItem({
        target,
        sourceUrl,
        platformPostId: postId,
        title: caption || `${handle} Instagram post`,
        text: caption || `${handle} Instagram post`,
        rawVisibleText: JSON.stringify({ profile, gridUrl, detail }),
        postedAt: detail?.postedAt ?? null,
        metrics,
        mediaUrls: detail?.mediaUrls ?? gridUrl.mediaUrls ?? [],
        contributionScore: scoreMetrics("instagram", metrics),
        matchReason:
          target.matchReason ??
          `Opt-in read-only Instagram grid${instagramFetchDetails ? "/detail" : ""} scrape for @${handle}; ` +
          "adapter did not return this visible grid item."
      });
    });
  const allObservedCandidates = dedupeById([...adapterEvidence, ...gridEvidence]);
  const scoredCandidates = allObservedCandidates
    .filter(hasScoredTraction);
  const recencyFailures = [];
  const evidenceItems = scoredCandidates.filter((item) => {
    const decision = instagramRecencyDecision(
      item.postedAt,
      instagramTractionCutoffMs
    );
    if (decision.eligible) return true;
    if (
      decision.reason === "missing_publication_date" ||
      decision.reason === "invalid_publication_date"
    ) {
      recencyFailures.push(
        failure(
          target,
          `Instagram native post omitted because recency could not be proven: ${decision.reason}.`,
          item.sourceUrl
        )
      );
    }
    return false;
  });
  const retainedUrls = new Set(evidenceItems.map((item) => normalizeComparableUrl(item.sourceUrl)));
  const assumedUrlEvidence = allObservedCandidates
    .filter((item) => !retainedUrls.has(normalizeComparableUrl(item.sourceUrl)))
    .map((item) => ({
      ...item,
      contributionScore: 0,
      tractionStatus: "unscored",
      linkStatus: "unchecked",
      linkFailureReason: detailUnavailable
        ? "Instagram detail request was rate-limited or unavailable; native URL was observed in the authenticated profile grid and is retained as assumed functional."
        : instagramFetchDetails
          ? "Instagram native URL was observed in the authenticated profile grid; detail enrichment returned no additional readable fields."
          : "Instagram native URL was observed in the authenticated profile grid; detail navigation was intentionally skipped.",
      matchReason:
        `${item.matchReason} Native URL retained as assumed functional evidence; detail-page enrichment is optional and does not determine existence.`
    }));
  const nativeIdentityFailures = rejectedAdapterIdentityCount
    ? [
        failure(
          target,
          `Rejected ${rejectedAdapterIdentityCount} Instagram adapter row(s) without an independently proven native post/reel/tv shortcode.`
        )
      ]
    : [];
  const targetFailures = [
    ...adapterFailures,
    ...nativeIdentityFailures,
    ...recencyFailures
  ];
  if (!evidenceItems.length && !assumedUrlEvidence.length) {
    const emptyFailure = failure(
      target,
      `No scored recent Instagram posts found with adapter or browser grid${instagramFetchDetails ? "/detail" : ""} extractor.`
    );
    const failuresWithEmpty = [...targetFailures, emptyFailure];
    const attemptState = instagramCollectionAttemptState({
      evidenceCount: 0,
      completedTimelineSourceCount:
        Number(timelineAdapterCompleted) + Number(browserGridCompleted),
      profileIdentityOk,
      failureMessages: failuresWithEmpty.map((item) => item.message)
    });
    return {
      evidence: [],
      failures: failuresWithEmpty,
      needsReview: [],
      collectionFailed: attemptState.collectionFailed,
      failureKind: attemptState.failureKind
    };
  }

  const attemptState = instagramCollectionAttemptState({
    evidenceCount: evidenceItems.length + assumedUrlEvidence.length,
    completedTimelineSourceCount:
      Number(timelineAdapterCompleted) + Number(browserGridCompleted),
    profileIdentityOk,
    failureMessages: targetFailures.map((item) => item.message)
  });
  return {
    evidence: [...evidenceItems, ...assumedUrlEvidence],
    failures: targetFailures,
    needsReview: [],
    collectionFailed: attemptState.collectionFailed,
    failureKind: attemptState.failureKind
  };
}

async function fetchXTweets(target, workerIndex) {
  if (!urlMatchesPlatform(target.url, "x")) {
    return { evidence: [], failures: [failure(target, "X/Twitter URL host did not match x.com or twitter.com.")], needsReview: [] };
  }

  const handle = xHandleFromUrl(target.url);
  if (!handle) {
    return { evidence: [], failures: [failure(target, "Could not parse X/Twitter handle.")], needsReview: [] };
  }

  const failures = [];
  let attemptedSourceCount = 0;
  let completedSourceCount = 0;
  let adapterTweets = [];
  let browserTweets = [];
  let eligibleAdapterTweetCount = 0;

  if (xCollectionMode !== "browser") {
    attemptedSourceCount += 1;
    try {
      adapterTweets = await fetchXTweetsFromAdapter(handle);
      eligibleAdapterTweetCount = mergeOwnedXTweets(
        [adapterTweets],
        { handle, includeRetweets, limit: postLimit }
      ).length;
      if (!adapterTweets.length || eligibleAdapterTweetCount) {
        completedSourceCount += 1;
      }
    } catch (error) {
      failures.push(failure(target, `X authenticated adapter failed: ${errorMessage(error)}`));
    }
  }
  if (
    xCollectionMode === "browser" ||
    (xCollectionMode === "hybrid" && eligibleAdapterTweetCount < postLimit)
  ) {
    attemptedSourceCount += 1;
    try {
      browserTweets = await fetchXTweetsFromBrowser(handle, workerIndex);
      const eligibleBrowserTweetCount = mergeOwnedXTweets(
        [browserTweets],
        { handle, includeRetweets, limit: postLimit }
      ).length;
      if (!browserTweets.length || eligibleBrowserTweetCount) {
        completedSourceCount += 1;
      }
    } catch (error) {
      failures.push(failure(target, `X browser DOM extractor failed: ${errorMessage(error)}`));
    }
  }

  const tweets = mergeOwnedXTweets(
    [adapterTweets, browserTweets],
    { handle, includeRetweets, limit: postLimit }
  );
  const xEligibilityFailures = mergeOwnedXTweetObservations(
    [adapterTweets, browserTweets],
    { handle }
  ).flatMap((tweet) => {
    const decision = xTweetIngestionDecision(tweet, {
      handle,
      includeRetweets
    });
    return decision.eligible
      ? []
      : [
        failure(
          target,
          `X native post ${tweet.id} omitted: ${decision.reason}.`,
          tweet.url
        )
      ];
  });
  const xExclusions = mergeOwnedXTweetObservations(
    [adapterTweets, browserTweets],
    { handle }
  ).flatMap((tweet) => {
    const decision = xTweetIngestionDecision(tweet, {
      handle,
      includeRetweets
    });
    return decision.eligible
      ? []
      : [exclusion(target, decision.reason, tweet.url, { nativePostId: tweet.id })];
  });
  const attemptState = xCollectionAttemptState({
    tweetCount: tweets.length,
    attemptedSourceCount,
    completedSourceCount,
    failedSourceCount: failures.length
  });
  if (!tweets.length) {
    return {
      evidence: [],
      exclusions: xExclusions,
      failures: [
        ...failures,
        ...xEligibilityFailures,
        failure(
          target,
          `No scored recent original X posts found in ${xCollectionMode} mode.`
        )
      ],
      needsReview: [],
      collectionFailed: attemptState.collectionFailed
    };
  }

  return {
    evidence: tweets.map((tweet) => {
      const publication = xTweetPublicationDate(tweet.created_at);
      return socialEvidenceItem({
        target,
        sourceUrl: tweet.url || `https://x.com/${handle}`,
        platformPostId: tweet.id ?? null,
        title: descriptiveXTitle(tweet.text, tweet.author || target.name),
        text: tweet.text || "",
        rawVisibleText: JSON.stringify(tweet),
        postedAt: publication.postedAt,
        publishedAtPrecision: publication.publishedAtPrecision,
        metrics: {
          likes: numberOrNull(tweet.likes),
          reposts: numberOrNull(tweet.retweets),
          comments: numberOrNull(tweet.replies),
          views: numberOrNull(tweet.views)
        },
        mediaUrls: [...new Set([...(tweet.media_urls ?? []), ...(tweet.media_posters ?? [])].filter(Boolean))],
        contributionScore: scoreMetrics("x", {
          likes: numberOrNull(tweet.likes),
          reposts: numberOrNull(tweet.retweets),
          comments: numberOrNull(tweet.replies),
          views: numberOrNull(tweet.views)
        }),
        matchReason:
          target.matchReason ??
          `Opt-in authenticated read-only X ${xCollectionMode} timeline collection for @${handle}; native author and status URL were both verified against the mapped account.`
      });
    }),
    failures: [
      ...failures,
      ...xEligibilityFailures
    ],
    exclusions: xExclusions,
    needsReview: [],
    collectionFailed: attemptState.collectionFailed
  };
}

async function fetchXTweetsFromAdapter(handle, limit = postLimit) {
  const raw = await runOpenCli(
    ["twitter", "tweets", handle, "--limit", String(limit), "--top-by-engagement", String(limit), ...openCliFormatArgs],
    { timeoutMs: Math.min(perTargetTimeoutMs, 35_000) }
  );
  return parseJsonOutput(raw);
}

function updateXCircuitState(result, target) {
  const messages = (result.failures ?? [])
    .map((item) => item?.message)
    .filter(Boolean)
    .join(" | ");
  const failureKind = xFailureKind(messages);
  const decision = xCircuitStateTransition({
    previousConsecutiveFailures: consecutiveXCollectionFailures,
    collectionFailed: result.collectionFailed,
    maxConsecutiveFailures: maxConsecutiveXFailures,
    failureKind
  });
  consecutiveXCollectionFailures = decision.consecutiveFailures;
  if (!decision.open || xCircuitOpen) return;

  xCircuitOpen = true;
  xCircuitReason =
    `${decision.reason ?? failureKind} after ${target.name}: ` +
    `${messages || "unknown X authenticated-read failure"}`;
}

function updateLinkedInCircuitState(result, target) {
  const messages = result.failures
    .map((item) => item?.message)
    .filter(Boolean)
    .join(" | ");
  const failureKind = linkedinFailureKind(messages);
  const decision = linkedinCircuitStateTransition({
    previousConsecutiveFailures: consecutiveLinkedInCollectionFailures,
    collectionFailed: result.collectionFailed,
    maxConsecutiveFailures: maxConsecutiveLinkedInFailures,
    failureKind
  });
  consecutiveLinkedInCollectionFailures = decision.consecutiveFailures;
  if (!decision.open) return;

  linkedinCircuitOpen = true;
  linkedinCircuitReason =
    `${decision.reason ?? failureKind} after ${target.name}: ${messages || "unknown LinkedIn read failure"}`;
}

function updateInstagramCircuitState(result, target) {
  if (!result.collectionFailed) {
    consecutiveInstagramCollectionFailures = 0;
    return;
  }

  consecutiveInstagramCollectionFailures += 1;
  const messages = (result.failures ?? [])
    .map((item) => item?.message)
    .filter(Boolean)
    .join(" | ");
  const classifiedFailure = result.failureKind ?? instagramFailureKind(messages);
  const failureKind =
    classifiedFailure === "other" || classifiedFailure === "empty"
      ? "command_or_profile"
      : classifiedFailure;
  const decision = instagramCircuitDecision({
    consecutiveFailures: consecutiveInstagramCollectionFailures,
    maxConsecutiveFailures: maxConsecutiveInstagramFailures,
    failureKind
  });
  if (!decision.open) return;

  instagramCircuitOpen = true;
  instagramCircuitReason =
    `${decision.reason ?? failureKind} after ${target.name}: ` +
    `${messages || "unknown Instagram authenticated-read failure"}`;
}

async function fetchInstagramGridUrls(handle, workerIndex, desiredCount) {
  const session = `yc-ig-${workerIndex}-${slugify(handle)}-${Date.now()}`;
  return withOpenCliBrowserSession({
    session,
    runOpenCli,
    operation: async () => {
      await runOpenCli(["browser", session, "open", `https://www.instagram.com/${handle}/`], { timeoutMs: perTargetTimeoutMs });
      await runOpenCli(["browser", session, "wait", "time", "4"], { timeoutMs: 10_000 }).catch(() => null);
      const identityRaw = await runOpenCli(
        ["browser", session, "eval", instagramBrowserProfileIdentityExtractJs()],
        { timeoutMs: perTargetTimeoutMs }
      );
      const identity = parseJsonOutput(identityRaw)[0] ?? null;
      const identityDecision = instagramBrowserProfileIdentityDecision({
        requestedHandle: handle,
        ...(identity ?? {})
      });
      if (!identityDecision.ok) {
        throw new Error(
          `Instagram browser profile identity was not proven for @${handle}: ${identityDecision.reason}.`
        );
      }
      const byUrl = new Map();
      for (let index = 0; index <= scrollPasses && byUrl.size < desiredCount; index += 1) {
        const raw = await runOpenCli(["browser", session, "eval", instagramGridExtractJs()], { timeoutMs: perTargetTimeoutMs });
        for (const item of parseJsonOutput(raw)) {
          if (item?.href) byUrl.set(item.href, item);
        }
        if (byUrl.size >= desiredCount || index === scrollPasses) break;
        await runOpenCli(["browser", session, "scroll", "down", "--amount", "1100"], { timeoutMs: 10_000 }).catch(() => null);
        await runOpenCli(["browser", session, "eval", instagramProfileScrollJs(index)], { timeoutMs: 10_000 }).catch(() => null);
        await runOpenCli(["browser", session, "wait", "time", "1.5"], { timeoutMs: 8_000 }).catch(() => null);
      }
      return [...byUrl.values()].slice(0, desiredCount);
    }
  });
}

async function fetchInstagramPostDetails(handle, gridUrls, workerIndex) {
  const session = `yc-ig-detail-${workerIndex}-${slugify(handle)}-${Date.now()}`;
  return withOpenCliBrowserSession({
    session,
    runOpenCli,
    operation: async () => {
      const details = [];
      const urls = gridUrls
        .map((item) => canonicalInstagramPostUrl(item.href))
        .filter(Boolean)
        .slice(0, postLimit);

      const profileUrl = `https://www.instagram.com/${handle}/`;
      await runOpenCli(["browser", session, "open", profileUrl], { timeoutMs: perTargetTimeoutMs });
      await runOpenCli(["browser", session, "wait", "time", "4"], { timeoutMs: 10_000 }).catch(() => null);

      for (const url of urls) {
        const postId = instagramPostIdFromUrl(url);
        let clicked = false;
        for (let attempt = 0; attempt <= scrollPasses && !clicked; attempt += 1) {
          // Use OpenCLI's real browser click primitive on the exact anchor
          // currently rendered in the profile grid. This keeps navigation in
          // Instagram's normal profile -> post flow instead of opening a
          // direct /p/ or /reel/ URL that is more likely to return HTTP 429.
          await runOpenCli(
            ["browser", session, "click", instagramGridPostSelector(url)],
            { timeoutMs: perTargetTimeoutMs }
          )
            .then(() => { clicked = true; })
            .catch(() => undefined);
          if (clicked) break;
          await runOpenCli(
            ["browser", session, "scroll", "down", "--amount", "1100"],
            { timeoutMs: 10_000 }
          ).catch(() => null);
          await runOpenCli(["browser", session, "wait", "time", "1.5"], { timeoutMs: 8_000 }).catch(() => null);
        }

        if (!clicked) {
          continue;
        }

        await runOpenCli(["browser", session, "wait", "time", "2.5"], { timeoutMs: 8_000 }).catch(() => null);
        const raw = await runOpenCli(["browser", session, "eval", instagramPostDetailExtractJs()], {
          timeoutMs: perTargetTimeoutMs
        }).catch(() => "[]");
        const extracted = parseJsonOutput(raw)[0] ?? parseJsonOutput(raw);
        const parsed = normalizeInstagramDetailObservation(extracted);
        if (postId && instagramPostIdFromUrl(parsed?.url) !== postId) {
          await runOpenCli(["browser", session, "back"], { timeoutMs: 10_000 }).catch(() => null);
          await runOpenCli(["browser", session, "wait", "time", "1.5"], { timeoutMs: 8_000 }).catch(() => null);
          continue;
        }
        // Profile-level meta descriptions can look like post metadata (for
        // example, `... on Instagram: "..."`). Prefer the date, caption, and
        // metrics extracted from the clicked post body before applying the
        // compatibility normalizer's meta fallback.
        const collectionNowMs = Date.parse(now);
        const extractedPublication = instagramPublicationDate(extracted, collectionNowMs);
        const publication = extractedPublication.postedAt
          ? extractedPublication
          : instagramPublicationDate(parsed, collectionNowMs);
        if (parsed?.url || parsed?.description || parsed?.caption) {
          details.push({
            url,
            caption: extracted.caption ?? parsed.caption ?? null,
            rawText: extracted.text ?? parsed.text ?? parsed.description ?? "",
            description: parsed.description ?? null,
            postedAt: publication.postedAt,
            likes: maxMetric(extracted.likes, parsed.likes),
            comments: maxMetric(extracted.comments, parsed.comments),
            views: maxMetric(extracted.views, parsed.views),
            mediaUrls: parsed.mediaUrls ?? []
          });
        }
        await runOpenCli(["browser", session, "back"], { timeoutMs: 10_000 }).catch(() => null);
        await runOpenCli(["browser", session, "wait", "time", "1.5"], { timeoutMs: 8_000 }).catch(() => null);
        await delay(Math.min(delayMs, 1200));
      }

      return details;
    }
  });
}

function instagramGridPostSelector(url) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/$/, "");
  return `a[href*="${path}/"]`;
}

async function fetchXTweetsFromBrowser(handle, workerIndex) {
  const session = `yc-x-${workerIndex}-${slugify(handle)}-${Date.now()}`;
  return withOpenCliBrowserSession({
    session,
    runOpenCli,
    operation: async () => {
      await runOpenCli(["browser", session, "open", `https://x.com/${handle}`], {
        timeoutMs: perTargetTimeoutMs
      });
      await runOpenCli(["browser", session, "wait", "time", "5"], {
        timeoutMs: 12_000
      }).catch(() => null);
      const byId = new Map();
      for (let index = 0; index <= scrollPasses && byId.size < postLimit; index += 1) {
        const raw = await runOpenCli(
          ["browser", session, "eval", xTimelineExtractJs()],
          { timeoutMs: perTargetTimeoutMs }
        );
        for (const item of parseJsonOutput(raw)) {
          if (item?.id) byId.set(item.id, item);
        }
        if (byId.size >= postLimit || index === scrollPasses) break;
        await runOpenCli(
          ["browser", session, "scroll", "down", "--amount", "900"],
          { timeoutMs: 10_000 }
        ).catch(() => null);
        await runOpenCli(["browser", session, "wait", "time", "2"], {
          timeoutMs: 8_000
        }).catch(() => null);
      }
      const tweets = [...byId.values()].slice(0, postLimit);
      if (!tweets.length) {
        const bodyText = await runOpenCli(
          ["browser", session, "eval", "document.body?.innerText?.slice(0, 5000) ?? ''"],
          { timeoutMs: 10_000 }
        ).catch(() => "");
        if (xTimelinePageState(bodyText, 0) === "failed") {
          const pageFailureKind = xFailureKind(bodyText);
          throw new Error(
            `X timeline DOM did not expose any attributable posts for @${handle}; ` +
            `X_TIMELINE_FAILURE:${pageFailureKind}.`
          );
        }
      }
      return tweets;
    }
  });
}

function linkedInActivityUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "in" && parts[1]) {
      return `https://www.linkedin.com/in/${parts[1]}/recent-activity/all/`;
    }
    if (parts[0] === "company" && parts[1]) {
      return `https://www.linkedin.com/company/${parts[1]}/posts/`;
    }
  } catch {
    return null;
  }
  return null;
}

function xHandleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const [handle] = parsed.pathname.split("/").filter(Boolean);
    return handle?.replace(/^@/, "") ?? null;
  } catch {
    return null;
  }
}

function instagramHandleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const [handle] = parsed.pathname.split("/").filter(Boolean);
    return handle?.replace(/^@/, "") ?? null;
  } catch {
    return null;
  }
}

function socialEvidenceItem(input) {
  const metrics = removeNullish(input.metrics ?? {});
  const textValue =
    input.target.platform === "linkedin" ? cleanLinkedInPostText(input.text, input.target.name) : input.text;
  const rawVisibleText = sanitizePublicText(input.rawVisibleText || textValue);
  return {
    id: stableId(`${input.target.platform}:${input.target.entityId}:${input.sourceUrl}:${input.text}`),
    entityType: input.target.entityType,
    entityId: input.target.entityId,
    batch: input.target.batch,
    batchSlug: input.target.batchSlug,
    companySlug: input.target.companySlug,
    companyName: input.target.companyName,
    platform: input.target.platform,
    title: sanitizePublicText(input.title),
    sourceUrl: input.sourceUrl,
    platformPostId: input.platformPostId ?? null,
    accountUrl: input.accountUrl ?? input.target.url,
    text: sanitizePublicText(textValue).slice(0, 900),
    rawVisibleText: rawVisibleText.slice(0, 8000),
    postedAt: input.postedAt ?? null,
    publishedAtPrecision: input.publishedAtPrecision ?? (input.postedAt ? "exact" : "unknown"),
    metrics,
    mediaUrls: input.mediaUrls ?? [],
    contributionScore: input.contributionScore ?? scoreMetrics(input.target.platform, metrics),
    tractionStatus: input.tractionStatus,
    linkStatus: input.linkStatus ?? null,
    linkCheckedAt: input.linkCheckedAt ?? null,
    linkFailureReason: input.linkFailureReason ?? null,
    review_state: "verified",
    matchReason: input.matchReason,
    first_seen_at: now,
    last_checked_at: now,
    last_updated_at: input.postedAt ?? now
  };
}

function cleanLinkedInPostText(text, authorName) {
  let value = cleanText(text)
    .replace(/^Feed post number\s+\d+\s+/i, "")
    .replace(/\bVisible to anyone on or off LinkedIn\b/gi, "")
    .replace(/\bOpen reactions menu\b/gi, "")
    .replace(/\b(Like|Comment|Repost|Send)\b\s*$/gi, "")
    .trim();
  const relativeTime = value.match(/\b(?:\d+\s+(?:week|month|year|day|hour)s?\s+ago|\d+[wdhmy]|1yr|2yr|3yr)\s*•?\s*/i);
  if (relativeTime && relativeTime.index !== undefined && relativeTime.index < 360) {
    value = value.slice(relativeTime.index + relativeTime[0].length).trim();
  }
  if (authorName) {
    const escaped = escapeRegExp(authorName);
    value = value.replace(new RegExp(`^(?:${escaped}\\s*){1,4}`, "i"), "").trim();
  }
  return value || text;
}

function failure(target, message, sourceUrl = target.url) {
  return {
    id: stableId(`failure:${target.platform}:${target.entityId}:${sourceUrl}:${message}`),
    platform: target.platform,
    companySlug: target.companySlug,
    companyName: target.companyName,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.name,
    batch: target.batch,
    batchSlug: target.batchSlug,
    accountUrl: target.url,
    sourceUrl,
    message,
    checkedAt: now
  };
}

async function runOpenCli(args, options = {}) {
  try {
    return await executeOpenCli(args, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? perTargetTimeoutMs,
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    throw new Error(cleanText(`${stdout}\n${stderr}\n${error.message}`));
  }
}

function parseJsonOutput(raw) {
  const value = String(raw ?? "").trim();
  const start = Math.min(
    ...[value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0)
  );
  if (!Number.isFinite(start)) return [];
  return JSON.parse(value.slice(start));
}

async function runWorkerPool(items, concurrency, fn) {
  let nextIndex = 0;
  const runners = Array.from({ length: concurrency }, async (_, workerIndex) => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await fn(item, workerIndex);
    }
  });
  await Promise.all(runners);
}

function scoreMetrics(platform, metrics) {
  const likes = metrics.likes ?? 0;
  const comments = metrics.comments ?? 0;
  const shares = metrics.shares ?? metrics.reposts ?? 0;
  const views = metrics.views ?? 0;
  const upvotes = metrics.upvotes ?? 0;
  if (![likes, comments, shares, views, upvotes].some((value) => value > 0)) {
    return 0;
  }
  const viewWeight = platform === "x" || platform === "linkedin" ? 0.06 : platform === "instagram" ? 0.05 : 0.02;
  const commentWeight = platform === "x" || platform === "linkedin" ? 5.5 : platform === "instagram" ? 5 : 3;
  const shareWeight = platform === "x" || platform === "linkedin" ? 8 : 4;
  const likeWeight = platform === "x" || platform === "linkedin" ? 1.5 : platform === "instagram" ? 1.1 : 1;
  const raw = likes * likeWeight + comments * commentWeight + shares * shareWeight + upvotes * 2.5 + views * viewWeight;
  const platformBoost = platform === "linkedin" || platform === "x" ? 1.1 : 1;
  const saturationPoint = platform === "linkedin" || platform === "x" ? 160_000 : 120_000;
  return Math.max(1, Math.min(100, Math.round((Math.log1p(raw * platformBoost) / Math.log1p(saturationPoint)) * 100)));
}

function parseCompactNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  const match = cleaned.match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return parseCompactNumber(value);
}

function maxMetric(...values) {
  const parsed = values.map(numberOrNull).filter((value) => Number.isFinite(value) && value > 0);
  return parsed.length ? Math.max(...parsed) : null;
}

function hasScoredTraction(item) {
  return Number(item?.contributionScore ?? 0) > 0 && Object.values(item?.metrics ?? {}).some((value) => Number(value) > 0);
}

function bestInstagramCaption(...values) {
  return (
    values
      .map((value) => cleanText(value))
      .find((value) => value && !isGenericInstagramAlt(value)) ?? ""
  );
}

function isGenericInstagramAlt(value) {
  return (
    /\bprofile picture\b/i.test(value) ||
    /^user avatar$/i.test(value) ||
    /^photo by @?[a-z0-9_.]+ on [a-z]+ \d{1,2}, \d{4}\.?$/i.test(value)
  );
}

function parseDateOrNull(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function urlMatchesPlatform(url, platform) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (platform === "x") return host === "x.com" || host === "twitter.com";
    if (platform === "linkedin") return host === "linkedin.com" || host.endsWith(".linkedin.com");
    if (platform === "instagram") return host === "instagram.com" || host.endsWith(".instagram.com");
    return true;
  } catch {
    return false;
  }
}

function normalizeComparableUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString().toLowerCase();
  } catch {
    return String(url ?? "").toLowerCase();
  }
}

async function writeCheckpoint() {
  const contentDedupe = finalizeLoggedInEvidenceContent(dedupeById(evidence), {
    defaultBatchSlug: batchConfig.slug,
    resolveBatchSlug: resolveLegacyLoggedInEvidenceBatch,
    existingNeedsReview: needsReview,
    existingAttributionReconciliationLedger: attributionReconciliationLedger
  });
  const snapshot = {
    attempts: Object.fromEntries(attemptMap),
    evidence: sanitizeStoredRows(contentDedupe.evidence),
    exclusions: sanitizeStoredRows(dedupeById(exclusions)),
    failures: sanitizeStoredRows(dedupeById(failures)),
    needsReview: sanitizeStoredRows(contentDedupe.needsReview),
    attributionReconciliationLedger: contentDedupe.attributionReconciliationLedger
  };
  checkpointWriteChain = checkpointWriteChain.catch(() => undefined).then(() => writeJson(checkpointPath, snapshot));
  await checkpointWriteChain;
}

function sanitizeStoredRows(rows) {
  return rows;
}

function exclusion(target, reason, sourceUrl = target.url, details = {}) {
  return {
    id: stableId(`exclusion:${target.platform}:${target.entityId}:${sourceUrl}:${reason}`),
    kind: "native_authorship_exclusion",
    platform: target.platform,
    companySlug: target.companySlug,
    companyName: target.companyName,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.name,
    batch: target.batch,
    batchSlug: target.batchSlug,
    accountUrl: target.url,
    sourceUrl,
    reason,
    ...details
  };
}

function buildTerminalProof(targets, attempts, circuit) {
  const rows = targets.map((target) => {
    const key = attemptKeyFor(target);
    const attempt = attempts.get(key);
    return {
      checkpointKey: key,
      platform: target.platform,
      entityId: target.entityId,
      status: attempt?.status ?? "untouched",
      checkedAt: attempt?.checkedAt ?? null,
      count: Number.isFinite(Number(attempt?.count)) ? Number(attempt.count) : 0
    };
  });
  const untouchedCount = rows.filter((row) => row.status === "untouched").length;
  return {
    schemaVersion: "x-linkedin-shard-terminal-proof.v1",
    status: untouchedCount || circuit.xCircuitOpen || circuit.linkedinCircuitOpen
      ? "partial_resumable"
      : "complete",
    targetCount: rows.length,
    checkpointedTargetCount: rows.length - untouchedCount,
    untouchedTargetCount: untouchedCount,
    terminalTargetCount: rows.filter((row) => row.status === "done" || row.status === "failed").length,
    circuits: {
      x: { open: Boolean(circuit.xCircuitOpen), reason: circuit.xCircuitReason ?? null },
      linkedin: { open: Boolean(circuit.linkedinCircuitOpen), reason: circuit.linkedinCircuitReason ?? null }
    },
    targets: rows
  };
}

function buildExternalBlockers(rows) {
  return dedupeById(rows.flatMap((row) => {
    const message = String(row?.message ?? "");
    const kind = /\b(?:log in|login|sign in|unauthenticated|not authenticated|authentication|session expired|checkpoint)\b/i.test(message)
      ? "authentication_or_login_wall"
      : /\b(?:429|rate limit|too many requests|quota|slow down)\b/i.test(message)
        ? "rate_limit"
        : /\b(?:timed? out|timeout|ECONN|ENOTFOUND|transport|socket|connection|browser (?:closed|crashed|disconnected|unavailable))\b/i.test(message)
          ? "transport_or_browser"
          : /\badapter failed\b|\bbrowser DOM extractor failed\b|\bcommand failed\b/i.test(message)
            ? "collector_command_failure"
          : null;
    if (!kind) return [];
    return [{
      id: stableId(`blocker:${row.id}:${kind}`),
      kind,
      platform: row.platform,
      entityId: row.entityId,
      entityName: row.entityName,
      sourceUrl: row.sourceUrl,
      message,
      retryable: true,
      terminal: false
    }];
  }));
}

function approvedShardPath(value, flag) {
  const approvedRoot = "/private/tmp/returner-fund-shards/x-linkedin";
  const candidate = resolve(value);
  const rel = relative(approvedRoot, candidate);
  if (!rel || rel.startsWith("..") || rel.startsWith("/") || resolve(approvedRoot, rel) !== candidate) {
    throw new Error(`${flag} must resolve under ${approvedRoot}; received ${value}.`);
  }
  return candidate;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${++writeSequence}.tmp`;
  await writeFile(tempPath, `${serializeJson(value)}\n`);
  await rename(tempPath, path);
}

function writeStdout(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => error ? reject(error) : resolve());
  });
}

function serializeJson(value) {
  return redactTokenLikeStrings(JSON.stringify(value, null, 2));
}

function redactTokenLikeStrings(value) {
  return String(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "[redacted-public-token]")
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[redacted-public-token]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-public-token]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, "[redacted-public-token]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted-public-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [redacted-public-token]")
    .replace(/\bJSESSIONID=\"[^\"]+\"/gi, "JSESSIONID=\"[redacted-cookie]\"")
    .replace(/\bli_at=[A-Za-z0-9%._/-]{16,}/gi, "li_at=[redacted-cookie]")
    .replace(/\b[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._/-]{16,}/g, (match) => {
      const key = match.split("=")[0];
      return `${key}=[redacted-public-param]`;
    });
}

function cleanText(value) {
  return String(value ?? "").replace(/\\u0026/g, "&").replace(/\s+/g, " ").trim();
}

function descriptiveXTitle(text, fallbackName) {
  const compact = cleanText(text);
  if (!compact) return `${fallbackName} X post`;
  const firstSentence = compact.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? compact;
  return firstSentence.length > 140 ? `${firstSentence.slice(0, 137).trimEnd()}...` : firstSentence;
}

function sanitizePublicText(value) {
  return redactTokenLikeStrings(cleanText(value));
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
    .replace(/sk-/g, "s-k-")
    .slice(0, 180);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function companyId(company) {
  const catalogId = String(company.entityId ?? company.id ?? "");
  return /^a16z-speedrun-006-/i.test(catalogId) ? catalogId : `company-${company.slug}`;
}

function collectorEntityId(company, entity, entityType) {
  if (entityType === "company") return companyId(company);
  const catalogId = String(entity.entityId ?? entity.id ?? "");
  return /^a16z-speedrun-006-.+-founder-/i.test(catalogId)
    ? catalogId
    : `founder-${company.slug}-${slugify(entity.name)}-${entity.id}`;
}

function ownerCollisionReviewItem(collision) {
  const targets = collision.targets.map((target) => ({
    companySlug: target.companySlug,
    companyName: target.companyName,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.name,
    accountUrl: target.url,
    checkpointKey: attemptKeyFor(target)
  }));
  const reviewTarget =
    collision.targets.find(
      (target) => target.entityType === "company" && target.entityId
    ) ??
    collision.targets.find((target) => target.entityId) ??
    collision.targets[0];
  return {
    id: stableId([
      "native-account-owner-collision",
      collision.batchSlug,
      collision.platform,
      collision.accountIdentity,
      ...collision.entityIds
    ].join(":")),
    batchSlug: collision.batchSlug,
    entityType: reviewTarget?.entityType ?? "company",
    entityId:
      reviewTarget?.entityId ??
      `unresolved-native-owner-${stableId(collision.accountIdentity)}`,
    entityName:
      reviewTarget?.name ??
      reviewTarget?.companyName ??
      collision.accountIdentity,
    companySlug: reviewTarget?.companySlug ?? null,
    companyName: reviewTarget?.companyName ?? null,
    platform: collision.platform,
    candidateUrl: reviewTarget?.url ?? null,
    review_state: "needs_review",
    quarantineReasons: ["ambiguous_native_account_owner_mapping"],
    matchReason:
      "Collection target quarantined before ingestion because one native account is mapped to multiple canonical owners.",
    nativeAccountOwnerCollision: {
      accountIdentity: collision.accountIdentity,
      entityIds: collision.entityIds,
      targets
    }
  };
}

function addItems(items = [], target) {
  for (const item of items) target.push(item);
}

function removeTargetEvidence(target) {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index];
    if (item.platform === target.platform && item.entityId === target.entityId) {
      evidence.splice(index, 1);
    }
  }
}

function removeTargetFailures(target) {
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const item = failures[index];
    if (item.platform === target.platform && item.entityType === target.entityType && item.entityName === target.name) {
      failures.splice(index, 1);
    }
  }
}

function restoreRetryableXFailures(plannedTargets) {
  for (const target of plannedTargets) {
    if (target.platform !== "x") continue;
    const key = attemptKeyFor(target);
    const attempt = attemptMap.get(key);
    if (attempt?.status !== "done" || attempt.count !== 0) continue;
    const transientFailure = failures.find((item) =>
      item.platform === "x" &&
      item.companySlug === target.companySlug &&
      item.entityType === target.entityType &&
      (item.entityId ? item.entityId === target.entityId : item.entityName === target.name) &&
      /X authenticated adapter failed|X browser DOM extractor failed/i.test(item.message ?? "")
    );
    if (!transientFailure) continue;
    attemptMap.set(key, {
      ...attempt,
      status: "failed",
      error: transientFailure.message
    });
  }
}

function dedupeById(items) {
  const byId = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    byId.set(item.id, mergeEvidenceLikeRows(byId.get(item.id), item));
  }
  return [...byId.values()];
}

function mergeEvidenceLikeRows(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming };
  for (const field of [
    "thumbnailUrl",
    "thumbnailSource",
    "mediaUrl",
    "mediaUrls",
    "linkStatus",
    "linkCheckedAt",
    "linkFailureReason"
  ]) {
    if (isEmptyValue(incoming[field]) && !isEmptyValue(existing[field])) {
      merged[field] = existing[field];
    }
  }
  return merged;
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function attemptKeyFor(target) {
  return `${target.batchSlug}:${target.platform}:${target.entityId}:${target.url}`;
}

function isObsoleteToolFailure(message) {
  return /spawn opencli ENOENT|powershell\.exe|LINKEDIN_EXTRACT_JS|Unexpected token '\)'/i.test(message ?? "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function booleanArg(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "Usage: node scripts/fetch-logged-in-social-traction.mjs [options]",
    "",
    "Options:",
    "  --batch=S26|S2026|A16ZSR006",
    "  --batch-slug=S26|S2026|A16ZSR006",
    "  --platforms=x,linkedin,instagram",
    "  --entities=all|company|founder",
    "  --company=NAME",
    "  --max-targets=N",
    "  --shard-count=N             Isolated deterministic target shard count",
    "  --shard-index=N             Isolated deterministic target shard index",
    "  --output=PATH               Isolated output; must be under /private/tmp/returner-fund-shards/x-linkedin",
    "  --checkpoint=PATH           Isolated checkpoint; must be under /private/tmp/returner-fund-shards/x-linkedin",
    "  --workers=N",
    "  --limit=N",
    "  --scrolls=N",
    "  --timeout-ms=N",
    "  --delay-ms=N",
    "  --allow-linkedin",
    "  --linkedin-mode=browser|adapter|hybrid",
    "  --x-mode=browser|adapter|hybrid",
    "  --allow-x-adapter-fallback",
    "  --include-retweets",
    "  --instagram-details          Explicitly open individual Instagram post/reel URLs (off by default)",
    "  --skip-instagram-details     Compatibility override; keep individual post/reel detail opens disabled",
    "  --instagram-site-session=ephemeral|persistent  Instagram adapter session (default: ephemeral)",
    "  --max-consecutive-x-failures=N",
    "  --max-consecutive-linkedin-failures=N",
    "  --max-consecutive-instagram-failures=N",
    `  --fresh-for-hours=N        Re-run completed targets after N hours (default: ${DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS})`,
    "  --retry-empty",
    "  --force",
    "  --plan                     Print the read-only target plan and exit",
    "  --finalize-only             Rebuild evidence from checkpoints without collection",
    "  --help, -h"
  ].join("\n");
}

function resolveXCollectionMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (["browser", "adapter", "hybrid"].includes(mode)) return mode;
  throw new Error(`Unsupported --x-mode=${value}. Supported modes: browser, adapter, hybrid.`);
}

function resolveInstagramSiteSession(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (["ephemeral", "persistent"].includes(mode)) return mode;
  throw new Error(
    `Unsupported --instagram-site-session=${value}. Supported modes: ephemeral, persistent.`
  );
}

function resolveLinkedInCollectionMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (["browser", "adapter", "hybrid"].includes(mode)) return mode;
  throw new Error(
    `Unsupported --linkedin-mode=${value}. Supported modes: browser, adapter, hybrid.`
  );
}

function resolveBatchConfig(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (["S26", "YCS26", "SUMMER2026", "YCSUMMER2026"].includes(normalized)) {
    return {
      slug: "S26",
      label: "YC Summer 2026 (S26)",
      snapshotPath: join(root, "src", "lib", "yc", "summer-2026-companies.json")
    };
  }
  if (["S2026", "P26", "YCS2026", "YCP26", "SPRING2026", "YCSPRING2026"].includes(normalized)) {
    return {
      slug: "S2026",
      label: "YC Spring 2026 (P26)",
      snapshotPath: join(root, "src", "lib", "yc", "spring-2026-companies.json")
    };
  }
  if (["A16ZSR006", "A16ZSPEEDRUN006", "SPEEDRUN006"].includes(normalized)) {
    return {
      slug: "A16ZSR006",
      label: "a16z Speedrun 006",
      snapshotPath: join(root, "public", "graph", "a16zsr006.json")
    };
  }
  throw new Error(`Unsupported --batch=${value}. Supported batches: S26, S2026, A16ZSR006.`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function instagramBrowserProfileIdentityExtractJs() {
  return `(() => {
  const bodyText = document.body?.innerText ?? "";
  const canonicalUrl =
    document.querySelector('link[rel="canonical"]')?.href ??
    document.querySelector('meta[property="og:url"]')?.content ??
    null;
  const identityTexts = [
    document.querySelector('meta[property="og:title"]')?.content,
    ...Array.from(
      document.querySelectorAll(
        "main header h1, main header h2, main header a, header h1, header h2"
      )
    ).map((node) => node.textContent)
  ].filter(Boolean);
  const visibleHandles = [];
  for (const text of identityTexts) {
    const value = String(text).trim();
    if (/^@?[A-Za-z0-9._]+$/.test(value)) {
      visibleHandles.push(value.replace(/^@/, ""));
    }
    for (const match of value.matchAll(/@([A-Za-z0-9._]+)/g)) {
      visibleHandles.push(match[1]);
    }
  }
  return [{
    currentUrl: location.href,
    canonicalUrl,
    visibleHandles: [...new Set(visibleHandles)],
    loginWall: /log in|sign up to see|create an account/i.test(bodyText.slice(0, 5000)),
    challenge:
      /challenge|confirm it'?s you|suspicious login|security code/i.test(
        location.pathname + " " + bodyText.slice(0, 5000)
      )
  }];
})()`;
}

function instagramGridExtractJs() {
  return `(() => {
  const parseNumber = (value) => {
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const metricFromText = (value, word) => {
    const match = String(value || "").match(new RegExp("([0-9,.]+\\\\s*[KMB]?)\\\\s+" + word, "i"));
    return match ? parseNumber(match[1]) : null;
  };
  const overlayMetric = (anchor, labels, href) => {
    const labelText = labels.join(" ");
    const rawText = anchor.innerText || anchor.textContent || "";
    const explicitViews = metricFromText(labelText + " " + rawText, "views?|plays?");
    const explicitLikes = metricFromText(labelText + " " + rawText, "likes?");
    const explicitComments = metricFromText(labelText + " " + rawText, "comments?");
    const compactLines = rawText
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter((line) => /^[0-9,.]+\\s*[KMB]?$/i.test(line));
    const firstCompact = compactLines.map(parseNumber).find((value) => value && value > 0) || null;
    const isVideo = /\\/(?:reel|tv)\\//i.test(href) || /reel|video|play/i.test(labelText + " " + rawText);
    return {
      rawText: rawText.slice(0, 500),
      views: explicitViews ?? (isVideo ? firstCompact : null),
      likes: explicitLikes ?? (!isVideo ? firstCompact : null),
      comments: explicitComments
    };
  };
  const links = Array.from(document.querySelectorAll("a"))
    .filter((anchor) => /\\/(?:[^/]+\\/)?(?:reel|p|tv)\\//i.test(anchor.href || ""));
  const seen = new Set();
  return links
    .map((anchor) => {
      try {
        const href = anchor.href;
        const url = new URL(href, location.origin);
        const parts = url.pathname.split("/").filter(Boolean);
        const postIndex = parts.findIndex((part) => /^(reel|p|tv)$/i.test(part));
        if (postIndex < 0 || !parts[postIndex + 1]) return null;
        const canonical = "https://www.instagram.com/" + parts[postIndex].toLowerCase() + "/" + parts[postIndex + 1] + "/";
        if (seen.has(canonical)) return null;
        seen.add(canonical);
        const images = Array.from(anchor.querySelectorAll("img[src]"));
        const captions = images.map((img) => img.alt).filter(Boolean);
        const labels = Array.from(anchor.querySelectorAll("[aria-label]")).map((node) => node.getAttribute("aria-label")).filter(Boolean);
        const metrics = overlayMetric(anchor, labels, canonical);
        return {
          href: canonical,
          rawHref: href,
          platformPostId: parts[postIndex + 1],
          caption: captions[0] || "",
          mediaUrls: images.map((img) => img.src).filter(Boolean).slice(0, 2),
          labels,
          rawText: metrics.rawText,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 60);
})()`;
}

function instagramProfileScrollJs(index) {
  const amount = 1600 + index * 600;
  return `(() => {
  window.scrollBy(0, ${amount});
  document.documentElement.scrollTop = Math.max(document.documentElement.scrollTop, window.scrollY);
  document.body.scrollTop = Math.max(document.body.scrollTop || 0, window.scrollY);
  return { y: window.scrollY, body: document.body.scrollHeight, doc: document.documentElement.scrollHeight };
})()`;
}

function instagramPostDetailExtractJs() {
  return `(() => {
  const parseNumber = (value) => {
    if (value === null || /^null$/i.test(String(value))) return null;
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const shortcode = location.pathname.split("/").filter(Boolean).pop() || "";
  const html = document.documentElement.innerHTML || "";
  const mediaIndex = shortcode ? html.indexOf('"code":"' + shortcode + '"') : -1;
  const mediaBlob = mediaIndex >= 0 ? html.slice(Math.max(0, mediaIndex - 1000), mediaIndex + 12000) : "";
  const jsonNumber = (key) => {
    const match = mediaBlob.match(new RegExp('"' + key + '"\\\\s*:\\\\s*(null|[0-9]+)', "i"));
    return match ? parseNumber(match[1]) : null;
  };
  const jsonString = (key) => {
    const match = mediaBlob.match(new RegExp('"' + key + '"\\\\s*:\\\\s*"([\\\\s\\\\S]*?)"', "i"));
    return match ? match[1].replace(/\\\\n/g, "\\n").replace(/\\\\u0026/g, "&") : null;
  };
  const meta = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
  const usefulImageSrc = (img) => {
    const src = img?.src || "";
    const alt = img?.alt || "";
    if (!src) return null;
    if (/profile picture|^user avatar$/i.test(alt)) return null;
    if(/\\/t51\\.[0-9-]+-19\\//i.test(src) || /profile_images|profile-displayphoto|_normal\\./i.test(src)) return null;
    return src;
  };
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]') || "";
  const text = document.body?.innerText || "";
  const semanticDate = document.querySelector('time[datetime]')?.getAttribute("datetime") || null;
  const metricText = [text, description].filter(Boolean).join(" ");
  const preferVisibleMetric = (visible, ...fallbacks) => {
    const candidates = [visible, ...fallbacks];
    return candidates.find((value) => Number.isFinite(value) && value > 0) ??
      candidates.find((value) => value !== null && value !== undefined) ??
      null;
  };
  const likes = preferVisibleMetric(
    parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+likes?/i) || [])[1]),
    jsonNumber("like_count")
  );
  const comments = preferVisibleMetric(
    parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+comments?/i) || [])[1]),
    jsonNumber("comment_count")
  );
  const views = preferVisibleMetric(
    parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+(?:views?|plays?)/i) || [])[1]),
    jsonNumber("view_count"),
    jsonNumber("play_count"),
    jsonNumber("video_view_count")
  );
  const lines = text.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
  const metricLineIndex = lines.findIndex((line) =>
    /(?:likes?|comments?|views?|plays?)|be the first to like/i.test(line)
  );
  const namedDateLineIndex = lines.findIndex((line, index) =>
    index > Math.max(metricLineIndex, 0) &&
    /^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+[0-9]{1,2}(?:,\\s*[0-9]{4})?$/i.test(line)
  );
  const relativeDateLineIndex = lines.findIndex((line, index) =>
    index > Math.max(metricLineIndex, 0) &&
    /^[0-9]+\\s*[wdhmy]$/i.test(line)
  );
  const dateLineIndex = namedDateLineIndex >= 0 ? namedDateLineIndex : relativeDateLineIndex;
  const captionLines = lines
    .slice(Math.max(metricLineIndex + 1, 0), dateLineIndex > 0 ? dateLineIndex : lines.length)
    .filter((line) => !/^(?:original audio|follow|post|clip|•|[A-Za-z0-9._-]+)$/i.test(line));
  const dateFromText = dateLineIndex >= 0 ? lines[dateLineIndex] : null;
  const namedDate = dateFromText && /[A-Za-z]/.test(dateFromText) && !/,\\s*[0-9]{4}$/.test(dateFromText)
    ? dateFromText + ", " + new Date().getUTCFullYear()
    : dateFromText;
  const dateLabel = semanticDate || namedDate || (description.match(/\\bon\\s+([^:]+):\\s*"/i) || [])[1] || null;
  const takenAt = jsonNumber("taken_at");
  const caption =
    captionLines.join("\\n") ||
    (description.match(/:\\s*"([\\s\\S]*?)"\\.?\\s*$/) || [])[1] ||
    jsonString("text") ||
    Array.from(document.querySelectorAll('img[alt]')).map((img) => img.alt).find((alt) => alt && !/profile picture|^user avatar$/i.test(alt)) ||
    "";
  const mediaUrls = [
    meta('meta[property="og:image"]'),
    meta('meta[name="twitter:image"]'),
    ...Array.from(document.querySelectorAll("img[src]")).map(usefulImageSrc)
  ].filter(Boolean);
  return {
    url: location.href,
    description,
    text: text.slice(0, 3000),
    caption,
    dateLabel: semanticDate || dateLabel || (takenAt ? new Date(takenAt * 1000).toISOString() : null),
    likes,
    comments,
    views,
    mediaUrls: Array.from(new Set(mediaUrls)).slice(0, 4)
  };
})()`;
}

function xTimelineExtractJs() {
  return `(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const parseNumber = (value) => {
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const metricFromLabels = (labels, word) => {
    for (const label of labels) {
      const match = label.match(new RegExp("([0-9,.]+\\\\s*[KMB]?)\\\\s+" + word, "i"));
      if (match) return parseNumber(match[1]);
    }
    return null;
  };
  const metricFallbackFromLines = (lines, metricIndex) => {
    const compact = lines
      .filter((line) => /^[0-9,.]+\\s*[KMB]?$/i.test(line))
      .map(parseNumber)
      .filter((value) => value !== null);
    if (compact.length < 4) return null;
    return compact.slice(-4)[metricIndex] ?? null;
  };
  const bodyFromLines = (lines, handle) => {
    const marker = lines.findIndex((line) => line === "·");
    const start = marker >= 0 ? marker + 2 : Math.min(lines.findIndex((line) => /^@/.test(line)) + 3, lines.length);
    const content = [];
    for (const line of lines.slice(Math.max(0, start))) {
      if (/^\\d+[,.]?[0-9]*\\s*[KMB]?$/.test(line)) break;
      if (/^\\d+:\\d{2}$/.test(line)) continue;
      if (/^Show this thread$/i.test(line)) continue;
      content.push(line);
    }
    return content.join("\\n").trim();
  };
  const seen = new Set();
  return Array.from(document.querySelectorAll("article"))
    .map((article, index) => {
      const labels = Array.from(article.querySelectorAll("[aria-label]"))
        .map((node) => node.getAttribute("aria-label") || "")
        .filter(Boolean);
      const links = Array.from(article.querySelectorAll("a"))
        .map((anchor) => anchor.href)
        .filter((href) => /\\/status\\/\\d+/.test(href || ""));
      const statusUrl = links.find((href) => !/\\/analytics$|\\/photo\\//.test(href)) || links[0] || null;
      if (!statusUrl) return null;
      const url = new URL(statusUrl);
      const match = url.pathname.match(/\\/([^/]+)\\/status\\/(\\d+)/);
      if (!match) return null;
      const id = match[2];
      if (seen.has(id)) return null;
      seen.add(id);

      const rawText = article.innerText || "";
      const lines = rawText.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const authorHandle = match[1];
      const isRetweet = /reposted$/i.test(lines[0] || "") || /\\breposted\\b/i.test(lines.slice(0, 2).join(" "));
      const author = lines.find((line) => /^@/.test(line))?.replace(/^@/, "") || authorHandle;
      const dateLabel = labels.find((label) => /\\b(?:ago|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\\d+h|\\d+m|\\d+d)\\b/i.test(label));
      return {
        id,
        author: authorHandle,
        name: lines[0] || authorHandle,
        text: bodyFromLines(lines, author),
        rawText,
        likes: metricFromLabels(labels, "likes?") ?? metricFallbackFromLines(lines, 2),
        retweets: metricFromLabels(labels, "reposts?|retweets?") ?? metricFallbackFromLines(lines, 1),
        replies: metricFromLabels(labels, "replies?") ?? metricFallbackFromLines(lines, 0),
        views: metricFromLabels(labels, "views?") ?? metricFallbackFromLines(lines, 3),
        is_retweet: isRetweet,
        created_at: dateLabel || lines.find((line) => /^\\d+[mhd]$|^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b/i.test(line)) || null,
        url: "https://x.com/" + authorHandle + "/status/" + id,
        has_media: /Embedded video|Image|Play Video/i.test(labels.join(" ")),
        media_urls: Array.from(article.querySelectorAll("img[src]")).map((img) => img.src).filter((src) => /twimg\\.com/i.test(src)).slice(0, 4)
      };
    })
    .filter((tweet) => tweet && clean(tweet.text).length > 0)
    .slice(0, 40);
})()`;
}

function linkedInExtractJs() {
  return `(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const parseNumber = (value) => {
    const match = String(value || "").replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*([KMB])?/i);
    if (!match) return null;
    const suffix = (match[2] || "").toUpperCase();
    const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : suffix === "B" ? 1000000000 : 1;
    return Math.round(Number(match[1]) * mult);
  };
  const absolute = (href) => {
    if (!href) return null;
    try { return new URL(href, location.origin).toString(); } catch { return href || null; }
  };
  const nativePostUrl = (card) => {
    // Prefer the activity identity attached to the outer card itself. A
    // nested reshare can contain an embedded original-post permalink; scanning
    // descendant anchors first incorrectly assigns that parent's ID and body
    // to every outer profile that commented on it.
    const rootValues = [
      card.getAttribute?.("data-urn"),
      card.getAttribute?.("data-id"),
      card.getAttribute?.("data-activity-urn")
    ];
    const rootActivityId = rootValues
      .join(" ")
      .match(/urn:li:activity:(\d{10,})/i)?.[1];
    if (rootActivityId) {
      return "https://www.linkedin.com/feed/update/urn:li:activity:" + rootActivityId + "/";
    }
    const href = Array.from(card.querySelectorAll("a[href]"))
      .map((link) => absolute(link.getAttribute("href")))
      .find((value) => /\\/feed\\/update\\/urn:li:activity:\\d+|\\/posts\\/[^?#]*activity-\\d+/i.test(value || ""));
    if (href) {
      try {
        const parsed = new URL(href);
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch { return href; }
    }
    const urnNodes = Array.from(card.querySelectorAll("[data-urn], [data-id], [data-activity-urn]"));
    for (const node of urnNodes) {
      const values = [node.getAttribute?.("data-urn"), node.getAttribute?.("data-id"), node.getAttribute?.("data-activity-urn")];
      const activityId = values.join(" ").match(/urn:li:activity:(\d{10,})/i)?.[1];
      if (activityId) return "https://www.linkedin.com/feed/update/urn:li:activity:" + activityId + "/";
    }
    return null;
  };
  const metricFrom = (card, word) => {
    const buttons = Array.from(card.querySelectorAll("button[aria-label], a[aria-label]"));
    for (const button of buttons) {
      const label = button.getAttribute("aria-label") || "";
      if (new RegExp(word, "i").test(label)) return parseNumber(label);
    }
    const text = card.innerText || "";
    const match = text.match(new RegExp("([0-9,.]+\\\\s*[KMB]?)\\\\s+" + word, "i"));
    return match ? parseNumber(match[1]) : null;
  };
  const bodyFrom = (text) => {
    const lines = String(text || "")
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(Feed post number|Loaded \\d+|Follow|Like|Comment|Repost|Send|Open reactions menu)$/i.test(line))
      .filter((line) => !/^\\d+[wdhmy]\\s*•?$/.test(line))
      .filter((line) => !/^(\\d+[,.]?[0-9]*\\s*)?(reactions?|comments?|reposts?)$/i.test(line))
      .filter((line) => !/Visible to anyone on or off LinkedIn/i.test(line));
    const timeIndex = lines.findIndex((line) => /ago\\s*•|ago$|Edited\\s*•/i.test(line));
    const content = lines.slice(Math.max(0, timeIndex + 1)).join("\\n").trim() || lines.slice(3).join("\\n").trim();
    return content.replace(/\\n{3,}/g, "\\n\\n").slice(0, 4000);
  };
  const bestBodyFromCard = (card, rawText) => {
    const selector = [
      ".update-components-text",
      ".feed-shared-update-v2__description",
      ".feed-shared-inline-show-more-text",
      ".update-components-update-v2__commentary",
      "[data-test-id='main-feed-activity-card__commentary']"
    ].join(",");
    const candidates = Array.from(card.querySelectorAll(selector))
      .map((node) => clean(node.innerText))
      .filter((value) => value.length > 24)
      .filter((value) => !/^(Feed post number|Premium|Verified|Builder|Follow)$/i.test(value));
    const best = candidates.sort((a, b) => b.length - a.length)[0];
    return best || bodyFrom(rawText);
  };
  const commentaryFromCard = (card) => clean(
    card.querySelector(
      ".update-components-update-v2__commentary, [data-test-id='main-feed-activity-card__commentary']"
    )?.innerText || ""
  );
  const exactCards = Array.from(document.querySelectorAll(".scaffold-finite-scroll__content > ul > li, ul.display-flex.flex-wrap.list-style-none.justify-center > li"))
    .filter((card) => /Feed post number|Visible to anyone|reactions?|comments?|reposts?/i.test(card.innerText || ""));
  const linkCards = Array.from(document.querySelectorAll("a[href*='/feed/update/urn:li:activity:'], a[href*='/posts/'][href*='activity-']"))
    .map((link) => {
      let card = link.closest("li") || link.closest("article") || link.closest(".relative.artdeco-card") || link.parentElement;
      for (let depth = 0; depth < 4 && card && !/reactions?|comments?|reposts?|Feed post number/i.test(card.innerText || ""); depth += 1) {
        card = card.parentElement;
      }
      return { link, card };
    })
    .filter((item) => item.card);
  const metricCards = Array.from(document.querySelectorAll("li"))
    .filter((card) => /Feed post number|Visible to anyone|reactions?|comments?|reposts?/i.test(card.innerText || ""));
  const fallbackCards = [...new Set([...linkCards.map((item) => item.card), ...metricCards])]
    .filter((card) => clean(card.innerText).length > 80)
    .filter((card, index, list) => !list.some((other, otherIndex) => otherIndex !== index && other.contains(card) && clean(other.innerText).length < clean(card.innerText).length * 1.8))
    .slice(0, 40);
  const cards = (exactCards.length ? exactCards : fallbackCards).slice(0, 40);
  const seen = new Set();
  return cards.map((card, index) => {
    const updateUrl = nativePostUrl(card);
    const rawText = card.innerText || "";
    const body = bestBodyFromCard(card, rawText);
    const key = updateUrl || body.slice(0, 120) || String(index);
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      rank: index + 1,
      url: updateUrl,
      commentary: commentaryFromCard(card),
      authorUrls: [...new Set(
        Array.from(card.querySelectorAll("a[href*='/in/'], a[href*='/company/']"))
          .map((link) => absolute(link.getAttribute("href")))
          .filter((value) => /linkedin\\.com\\/(?:in|company)\\/[^/?#]+/i.test(value || ""))
      )],
      body,
      rawText,
      reactions: metricFrom(card, "reactions?"),
      comments: metricFrom(card, "comments?"),
      reposts: metricFrom(card, "reposts?"),
      impressions: metricFrom(card, "impressions?"),
      mediaUrls: Array.from(card.querySelectorAll("img[src]")).map((img) => img.src).filter((src) => /media\\.licdn\\.com/i.test(src)).slice(0, 4)
    };
  }).filter((post) => post && post.url && clean(post.body).length > 20);
})()`;
}
