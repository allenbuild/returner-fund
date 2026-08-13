import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  runOpenCli as executeOpenCli,
  sanitizeOpenCliDiagnostic
} from "./lib/opencli-runtime.mjs";
import {
  linkedinPostIdFromUrl
} from "./lib/social-native-identity.mjs";
import {
  createLinkedInInteractionPacer,
  createSupabaseLinkedInGlobalLeaseProvider,
  linkedinCircuitStateTransition,
  linkedinCollectionAttemptState,
  linkedinExecutionPolicy,
  linkedinBrowserSessionCleanupFailed,
  finalizeLinkedInInteractionPacing,
  linkedinFailureKind,
  linkedinFailureRequiresImmediateAbort,
  linkedinSafetySignal,
  limitLinkedInTargetsPerInvocation,
  mergeOwnedLinkedInPosts,
  prioritizeLinkedInTargets,
  runLinkedInSerialLane,
  withLinkedInAccountLock
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
  appendInstagramAttemptEvidence,
  canonicalInstagramPostUrl,
  compactLoggedInStoredRows,
  LOGGED_IN_STORED_RAW_TEXT_LIMIT,
  instagramAdapterProfileIdentityDecision,
  instagramBrowserProfileIdentityDecision,
  instagramCircuitDecision,
  instagramCollectionAttemptState,
  instagramDetailUrlsNeedingEnrichment,
  instagramDeepScrollPaginationDecision,
  instagramEvidenceProvenance,
  instagramFailureKind,
  instagramGridOnlyOwnershipDecision,
  instagramPublicationDate,
  normalizeInstagramDetailObservation,
  instagramPostIdFromUrl,
  instagramRecencyDecision,
  instagramShouldRetryTransientBrowserFailure,
  instagramTargetIsVerifiedForIngestion,
  mergeInstagramGridPassObservations,
  mergeVerifiedSocialAccountCandidates,
  normalizeInstagramDeepScrollPagination,
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
  LINKEDIN_CHILD_SAFETY_STOP_EXIT_CODE,
  collectionTargetShouldRun,
  linkedinChildSafetyStopDecision,
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
import { canonicalSocialAccountUrl } from "./lib/social-account-url.mjs";

if (booleanArg("--help") || booleanArg("-h")) {
  await writeStdout(`${usage()}\n`);
  process.exit(0);
}

const root = process.cwd();
const batchConfig = resolveBatchConfig(stringArg("--batch") ?? stringArg("--batch-slug") ?? "S26");
const ycSnapshotPath = batchConfig.snapshotPath;
const isolatedOutputPath = stringArg("--output-path");
const isolatedCheckpointPath = stringArg("--checkpoint-path");
const outputPath = isolatedOutputPath
  ? resolvePath(root, isolatedOutputPath)
  : join(root, "src", "lib", "social", "logged-in-evidence-current.json");
const checkpointPath = isolatedCheckpointPath
  ? resolvePath(root, isolatedCheckpointPath)
  : join(
      root,
      "work",
      batchConfig.slug === "S26"
        ? "logged-in-social-checkpoint.json"
        : `logged-in-social-checkpoint-${batchConfig.slug.toLowerCase()}.json`
    );
const checkpointPaths = [
  ...(isolatedCheckpointPath ? [checkpointPath] : []),
  join(root, "work", "logged-in-social-checkpoint.json"),
  join(root, "work", "logged-in-social-checkpoint-s2026.json"),
  join(root, "work", "logged-in-social-checkpoint-a16zsr006.json")
].filter((path, index, paths) => paths.indexOf(path) === index);
const verifiedSocialOverridesPath = join(root, "src", "lib", "social", "verified-social-overrides.json");
const priorityEvidencePaths = [
  join(root, "src", "lib", "social", "public-evidence-current.json"),
  join(root, "src", "lib", "social", "targeted-evidence-current.json"),
  join(root, "src", "lib", "social", "a16z-speedrun-006-social-evidence.json"),
  // Autonomous collectors write to isolated campaign outputs. Include the
  // published authenticated corpus when prioritizing those isolated runs so
  // the five-target LinkedIn safety lane advances through untouched accounts
  // instead of repeatedly selecting the same zero-checkpoint targets.
  join(root, "src", "lib", "social", "logged-in-evidence-current.json")
];
const collectionNowMs = Date.now();
const now = new Date(collectionNowMs).toISOString();
const targetLimit = numberArg("--max-targets") ?? Number.POSITIVE_INFINITY;
const postLimit = numberArg("--limit") ?? 30;
const instagramFetchDetails = !booleanArg("--skip-instagram-details");
const scrollPasses = Math.max(0, Math.min(numberArg("--scrolls") ?? 8, 30));
const workers = Math.max(1, Math.min(numberArg("--workers") ?? 2, 8));
const perTargetTimeoutMs = numberArg("--timeout-ms") ?? 75_000;
const delayMs = numberArg("--delay-ms") ?? 1_500;
const force = booleanArg("--force");
const platformFilter = new Set((stringArg("--platforms") ?? "instagram,x").split(",").map((item) => item.trim()).filter(Boolean));
const terminalCompletedPlatforms = platformSetArg(
  "--terminal-completed-platforms"
);
const entityFilter = stringArg("--entities") ?? "all"; // all | company | founder
const companyFilter = stringArg("--company")?.toLowerCase();
const includeRetweets = booleanArg("--include-retweets");
const allowXAdapterFallback = booleanArg("--allow-x-adapter-fallback");
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
  stringArg("--linkedin-mode") ?? "browser"
);
const requestedLinkedInTargetCap = nonnegativeIntegerArg("--linkedin-max-targets");
const linkedinExecution = linkedinExecutionPolicy({
  requestedWorkers: workers,
  requestedDelayMs: delayMs,
  requestedTargetCap: requestedLinkedInTargetCap ?? undefined
});
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
const instagramTractionCutoffMs = Date.parse("2025-01-01T00:00:00.000Z");
let writeSequence = 0;
let checkpointWriteChain = Promise.resolve();
let consecutiveXCollectionFailures = 0;
let xCircuitOpen = false;
let xCircuitReason = null;
let consecutiveLinkedInCollectionFailures = 0;
let linkedinCircuitOpen = false;
let linkedinCircuitReason = null;
let linkedinChildSafetyStop = null;
let consecutiveInstagramCollectionFailures = 0;
let instagramCircuitOpen = false;
let instagramCircuitReason = null;
let cachedLinkedInGlobalLockConfiguration = null;

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
const checkpointEntries = [];
for (const path of checkpointPaths) {
  checkpointEntries.push({
    path,
    payload: compactStoredPayload(
      await readJson(
        path,
        { attempts: {}, evidence: [], failures: [], needsReview: [] }
      )
    )
  });
}
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
const currentOutput = compactStoredPayload(
  await readJson(outputPath, { evidence: [], failures: [], needsReview: [] })
);
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
const priorityEvidence = [...evidence];
for (const path of priorityEvidencePaths) {
  const priorityPayload = compactStoredPayload(
    await readJson(path, { evidence: [] })
  );
  for (const row of priorityPayload.evidence ?? []) priorityEvidence.push(row);
}
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
const eligibleRunnableTargets = selectRunnableCollectionTargets(prioritizedTargets, {
  attempts: attemptMap,
  attemptKey: attemptKeyFor,
  force,
  retryEmpty,
  terminalCompletedPlatforms,
  freshForHours,
  now,
  limit: Number.POSITIVE_INFINITY
});
const globallyBoundedRunnableTargets = Number.isFinite(Number(targetLimit))
  ? eligibleRunnableTargets.slice(
      0,
      Math.max(0, Math.floor(Number(targetLimit)))
    )
  : eligibleRunnableTargets;
const runnableTargets = limitLinkedInTargetsPerInvocation(
  globallyBoundedRunnableTargets,
  linkedinExecution.targetCap
);
const remainingLinkedInTargetCount = eligibleRunnableTargets.filter(
  (target) => target.platform === "linkedin"
).length;
const selectedLinkedInTargetCount = runnableTargets.filter(
  (target) => target.platform === "linkedin"
).length;
// The plan is a canonical account map and must not shrink as checkpoints
// complete. Only runtime execution uses the bounded runnable subset.
const targets = planOnly ? prioritizedTargets : runnableTargets;
console.log(`Logged-in social targets: ${targets.length} (${workers} workers, up to ${postLimit} posts each, ${scrollPasses} scroll passes).`);
const linkedinTargets = targets.filter((target) => target.platform === "linkedin");
const otherTargets = targets.filter((target) => target.platform !== "linkedin");
if (prioritizedTargets.some((target) => target.platform === "linkedin")) {
  console.log(
    `LinkedIn safety lane: ${linkedinExecution.workers} worker, serial, ` +
    `maximum ${linkedinExecution.targetCap} targets this invocation ` +
    `(hard cap ${linkedinExecution.maximumTargetCap}), minimum ` +
    `${linkedinExecution.delayMs}ms between targets with persistent host-local handoff pacing.`
  );
}

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
    linkedinExecution: {
      requestedWorkers: linkedinExecution.requestedWorkers,
      workers: linkedinExecution.workers,
      delayMs: linkedinExecution.delayMs,
      requestedTargetCap: linkedinExecution.requestedTargetCap,
      targetCap: linkedinExecution.targetCap,
      maximumTargetCap: linkedinExecution.maximumTargetCap,
      remainingTargetCount: remainingLinkedInTargetCount,
      selectedForThisInvocationCount: selectedLinkedInTargetCount,
      runnableTargetCount: selectedLinkedInTargetCount,
      serial: true,
      persistentHostPacing: true
    },
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
    remainingTargetCount: eligibleRunnableTargets.length,
    selectedForThisInvocationCount: runnableTargets.length,
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

async function collectTarget(target, workerIndex, collectionGuard = null) {
  collectionGuard?.assertHealthy?.();
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

  let terminalSafetyError = null;
  try {
    const result =
      target.platform === "linkedin"
        ? await fetchLinkedInPosts(target, workerIndex, collectionGuard)
        : target.platform === "instagram"
          ? await fetchInstagramPosts(target, workerIndex)
          : await fetchXTweets(target, workerIndex);
    collectionGuard?.assertHealthy?.();
    removeTargetFailures(target);
    if (target.platform === "instagram") {
      appendInstagramAttemptEvidence(evidence, result.evidence);
    } else {
      addItems(result.evidence, evidence);
    }
    addItems(result.failures, failures);
    addItems(result.needsReview, needsReview);
    const instagramPaginationIncomplete =
      target.platform === "instagram" &&
      result.instagramPagination?.exhausted !== true;
    const attemptStatus = result.collectionFailed
      ? "failed"
      : instagramPaginationIncomplete
        ? "partial"
        : "done";
    attemptMap.set(
      attemptKey,
      attemptStatus === "failed"
        ? {
            status: "failed",
            checkedAt: now,
            count: 0,
            error: result.failures.map((item) => item.message).join(" | "),
            ...(result.instagramPagination
              ? { instagramPagination: result.instagramPagination }
              : {})
          }
        : {
            status: attemptStatus,
            checkedAt: now,
            count: result.evidence.length,
            ...(result.instagramPagination
              ? { instagramPagination: result.instagramPagination }
              : {})
          }
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
    } else if (target.platform === "linkedin") {
      updateLinkedInCircuitState(
        {
          collectionFailed: true,
          failures: [{ message }]
        },
        target
      );
    }
    console.warn(`${target.platform} ${target.companyName} / ${target.name}: ${message}`);
    if (target.platform === "linkedin" && linkedinBrowserSessionCleanupFailed(error)) {
      terminalSafetyError = error;
    }
  }

  try {
    await writeCheckpoint();
  } catch (checkpointError) {
    if (!terminalSafetyError) throw checkpointError;
    if (typeof terminalSafetyError === "object" && terminalSafetyError !== null) {
      try {
        Object.defineProperty(terminalSafetyError, "checkpointFailure", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: checkpointError
        });
      } catch {
        // Preserve the browser cleanup failure as the account-safety signal.
      }
    }
    throw terminalSafetyError;
  }
  if (terminalSafetyError) throw terminalSafetyError;
}

await runWorkerPool(otherTargets, workers, async (target, workerIndex) => {
  await collectTarget(target, workerIndex);
  await delay(delayMs);
});

if (linkedinTargets.length > 0) {
  const globalLock = requiredLinkedInGlobalLockConfiguration();
  await withLinkedInAccountLock(
    ({ signal, assertHealthy }) =>
      runLinkedInSerialLane(linkedinTargets, (target, workerIndex) => {
        assertHealthy();
        return collectTarget(target, workerIndex, { signal, assertHealthy });
      }, {
        delayMs: linkedinExecution.delayMs,
        sleep: delay,
        shouldAbort: () => linkedinCircuitOpen || signal.aborted,
        targetCap: linkedinExecution.targetCap
      }),
    globalLock
  );
}

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
const instagramCoverageTargets = completeTargetPartition.targets.filter(
  (target) => target.platform === "instagram"
);
const instagramCoverage = {
  status: "non_exhaustive",
  mechanism: "opencli-first-page-plus-complete-bounded-authenticated-browser-window",
  adapterPagination: "unavailable",
  reason:
    "OpenCLI instagram/user discards max_id/page_info metadata and browser scroll state has no trustworthy resume cursor or end-of-profile proof; each fresh invocation processes its complete bounded adapter plus DOM window while coverage remains explicitly non-exhaustive.",
  accountCount: instagramCoverageTargets.length,
  exhaustedAccountCount: 0
};
const payload = {
  source: {
    label: "Opt-in logged-in browser social post ingestion",
    batchSlug: batchConfig.slug,
    fetchedAt: now,
    targetCount: targets.length,
    fetchedCount: targets.filter((target) => attemptMap.get(attemptKeyFor(target))?.status === "done").length,
    failedCount: targets.filter((target) => attemptMap.get(attemptKeyFor(target))?.status === "failed").length,
    notes: [
      "Read-only browser automation through the user's authenticated OpenCLI browser session.",
      "No likes, follows, comments, messages, saves, stars, subscriptions, profile edits, or other mutations are performed.",
      "Instagram profile grids and X profile timelines are treated as opt-in authenticated/read-only sources when explicitly targeted.",
      `X ingestion mode: ${xCollectionMode}. Browser, adapter, and hybrid modes are read-only; hybrid prefers the authenticated adapter and uses the DOM only to fill incomplete results.`,
      `LinkedIn ingestion mode: ${linkedinCollectionMode}. Authenticated browser DOM collection is the only supported mode so interaction pacing remains locally auditable.`,
      `Instagram authenticated history coverage status: ${instagramCoverage.status}. OpenCLI exposes no reliable cursor and generic browser stalls are not an exhaustion proof; each fresh run processes one complete bounded adapter plus DOM window, persists every admitted native post, and records only bounded recent-ID/detail-fairness metadata.`,
      `Logged-in LinkedIn activity scraping is disabled unless both --platforms=linkedin and --allow-linkedin are passed. It uses one account-global locked serial worker, a hard cap of ${linkedinExecution.maximumTargetCap} targets per invocation, persistent host-local pacing with at least ${linkedinExecution.delayMs}ms between completed target attempts, keeps the durable account lease for the same final cooldown before release, and places the durable lease in a one-year manual-recovery quarantine when authenticated browser cleanup cannot be proven.`,
      "LinkedIn challenge, checkpoint, account-warning, authentication, and HTTP 429 signals abort the LinkedIn lane immediately so untouched targets remain retryable.",
      "Instagram login, challenge, and rate-limit failures open a circuit immediately; repeated command or profile failures open it after three consecutive failed targets. Legitimate empty native timelines remain completed empty checks.",
      `Checkpoint owner-collision reconciliation: ${ownerCollisionReconciliationSummary.reattributedCount} stale company rows reattributed, ${ownerCollisionReconciliationSummary.quarantinedCount} quarantined.`,
      "Each target is checkpointed independently; blocked or timed-out profiles are logged and do not stop the batch."
    ],
    coverage: {
      instagram: instagramCoverage
    }
  },
  evidence: sanitizeStoredRows(contentDedupe.evidence).sort((a, b) => b.contributionScore - a.contributionScore),
  failures: sanitizeStoredRows(payloadFailures),
  needsReview: sanitizeStoredRows(contentDedupe.needsReview),
  attributionReconciliationLedger: contentDedupe.attributionReconciliationLedger
};

await writeJson(outputPath, payload);
await writeCheckpoint();
console.log(`Wrote ${payload.evidence.length} logged-in post evidence items, ${payload.failures.length} failures.`);
if (linkedinChildSafetyStop) {
  const safetyDiagnostic = redactTokenLikeStrings(
    linkedinChildSafetyStop.diagnostic
  ).slice(0, 2_048);
  console.error(
    `LINKEDIN_CHILD_SAFETY_STOP exit=${LINKEDIN_CHILD_SAFETY_STOP_EXIT_CODE} ` +
    `kind=${linkedinChildSafetyStop.failureKind} ` +
    `target=${linkedinChildSafetyStop.targetName}: ${safetyDiagnostic}`
  );
  // Set an exit code instead of exiting abruptly so all proven browser,
  // durable-lease, stdout/stderr, and atomic-file cleanup can finish normally.
  process.exitCode = LINKEDIN_CHILD_SAFETY_STOP_EXIT_CODE;
}

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

  // Keep the authenticated collector on the same canonical account surface as
  // the public planner. Malformed catalog placeholders must never become a
  // browser navigation target (for example a LinkedIn vanity containing `~`).
  return dedupeTargets(targets.filter(
    (target) => target.url && canonicalSocialAccountUrl(target.platform, target.url)
  ));
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
    .filter((account) => urlMatchesPlatform(account.url, account.platform));
  return mergeVerifiedSocialAccountCandidates(candidates.filter(
    (account) => !retiredKeys.has(`${account.platform}:${normalizeComparableUrl(account.url)}`)
  ));
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
        if (url && platformFilter.has(platform) && urlMatchesPlatform(url, platform)) {
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

async function fetchLinkedInPosts(target, workerIndex, collectionGuard = null) {
  collectionGuard?.assertHealthy?.();
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

  const postGroups = [];
  const sourceFailures = [];
  let attemptedSourceCount = 0;
  let completedSourceCount = 0;

  if (linkedinCollectionMode === "browser") {
    attemptedSourceCount += 1;
    try {
      const browserPosts = await fetchLinkedInPostsFromBrowser(
        target,
        workerIndex,
        activityUrl,
        collectionGuard
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
      if (linkedinBrowserSessionCleanupFailed(error)) throw error;
      const message = errorMessage(error);
      const failureKind = linkedinFailureKind(message);
      if (failureKind === "empty") {
        completedSourceCount += 1;
      } else {
        sourceFailures.push(
          failure(target, `LinkedIn browser DOM extractor failed: ${message}`, activityUrl)
        );
        if (linkedinFailureRequiresImmediateAbort(failureKind)) {
          return linkedinFailedCollection(sourceFailures);
        }
      }
    }
  }

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
    needsReview: [],
    collectionFailed: attemptState.collectionFailed
  };
}

async function fetchLinkedInPostsFromBrowser(
  target,
  workerIndex,
  activityUrl,
  collectionGuard = null
) {
  const session =
    `yc-li-${workerIndex}-${slugify(target.entityId || target.name)}-${Date.now()}`;
  return withOpenCliBrowserSession({
    session,
    runOpenCli,
    operation: async () => {
      const interactionPacer = createLinkedInInteractionPacer({ sleep: delay });
      const interact = async (args, options, { optional = false, label } = {}) => {
        collectionGuard?.assertHealthy?.();
        await interactionPacer.beforeInteraction();
        let operationError = null;
        let operationMustAbort = false;
        try {
          const raw = await runOpenCli(args, {
            ...options,
            signal: collectionGuard?.signal
          });
          collectionGuard?.assertHealthy?.();
          assertLinkedInSafetyClear(raw, label ?? args.slice(2).join(" "));
          return raw;
        } catch (error) {
          operationError = error;
          operationMustAbort =
            linkedinFailureRequiresImmediateAbort(errorMessage(error)) || !optional;
          if (operationMustAbort) {
            throw error;
          }
          return null;
        } finally {
          finalizeLinkedInInteractionPacing(interactionPacer, {
            operationError,
            operationMustAbort
          });
        }
      };
      const probeSafety = () =>
        interact(
          ["browser", session, "eval", linkedInSafetyProbeJs()],
          { timeoutMs: 12_000 },
          { label: "browser safety probe" }
        );

      await interact(
        ["browser", session, "open", activityUrl],
        { timeoutMs: perTargetTimeoutMs },
        { label: "browser navigation" }
      );
      await interact(
        ["browser", session, "wait", "time", "5"],
        { timeoutMs: 12_000 },
        { label: "initial browser wait" }
      );
      await probeSafety();
      for (let index = 0; index < scrollPasses; index += 1) {
        await interact(
          ["browser", session, "scroll", "down", "--amount", "1200"],
          { timeoutMs: 12_000 },
          { optional: true, label: "browser scroll" }
        );
        await probeSafety();
      }
      const raw = await interact(
        ["browser", session, "eval", linkedInExtractJs()],
        { timeoutMs: perTargetTimeoutMs },
        { label: "browser DOM extraction" }
      );
      const safetyProbe = await probeSafety();
      const posts = parseJsonOutput(raw);
      // The post-extraction probe is a hard boundary: an empty result behind
      // a login wall is an authentication failure, never a completed empty
      // timeline that can be checkpointed.
      if (posts.length === 0) {
        assertLinkedInSafetyClear(safetyProbe, "empty browser DOM extraction");
      }
      return posts;
    }
  });
}

function linkedinFailedCollection(sourceFailures) {
  return {
    evidence: [],
    failures: sourceFailures,
    needsReview: [],
    collectionFailed: true
  };
}

function assertLinkedInSafetyClear(value, context) {
  const signal = linkedinSafetySignal(value);
  if (!signal) return;
  throw new Error(`LinkedIn safety stop (${signal}) during ${context}.`);
}

async function fetchInstagramPosts(target, workerIndex) {
  if (!urlMatchesPlatform(target.url, "instagram")) {
    return { evidence: [], failures: [failure(target, "Instagram URL host did not match instagram.com.")], needsReview: [] };
  }

  const handle = instagramHandleFromUrl(target.url);
  if (!handle) {
    return { evidence: [], failures: [failure(target, "Could not parse Instagram username.")], needsReview: [] };
  }

  const priorInstagramPagination = normalizeInstagramDeepScrollPagination(
    attemptMap.get(attemptKeyFor(target))?.instagramPagination,
    { handle }
  );
  const existingInstagramPostIds = new Set();
  for (const row of evidence) {
    if (
      row?.platform !== "instagram" ||
      row?.batchSlug !== target.batchSlug ||
      row?.entityId !== target.entityId
    ) {
      continue;
    }
    const postId = instagramPostIdFromUrl(row?.sourceUrl);
    if (postId) existingInstagramPostIds.add(postId);
  }

  const adapterFailures = [];
  let profileAdapterCompleted = false;
  let timelineAdapterCompleted = false;
  let browserGridCompleted = false;
  // OpenCLI's persistent Instagram site session is not safe for overlapping
  // adapter/browser commands. Keep the existing account worker pool, but
  // serialize this target's three read paths to avoid self-inflicted detach
  // failures when profile, timeline, and browser-grid reads start together.
  let profileRaw = "[]";
  try {
    profileRaw = await runInstagramAdapterWithRetry([
      "instagram",
      "profile",
      handle,
      ...openCliFormatArgs
    ]);
    profileAdapterCompleted = true;
  } catch (error) {
    adapterFailures.push(
      failure(target, `Instagram profile adapter failed: ${errorMessage(error)}`)
    );
  }

  let postsRaw = "[]";
  try {
    postsRaw = await runInstagramAdapterWithRetry([
      "instagram",
      "user",
      handle,
      "--limit",
      String(postLimit),
      ...openCliFormatArgs
    ]);
    timelineAdapterCompleted = true;
  } catch (error) {
    adapterFailures.push(
      failure(target, `Instagram user adapter failed: ${errorMessage(error)}`)
    );
  }

  let gridUrls = [];
  let gridCollection = null;
  try {
    const gridResult = await fetchInstagramGridUrls(handle, workerIndex);
    gridUrls = gridResult.items;
    gridCollection = gridResult;
    browserGridCompleted = true;
  } catch (error) {
    adapterFailures.push(
      failure(target, `Instagram browser grid extractor failed: ${errorMessage(error)}`)
    );
  }

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
  const adapterProfileIdentityOk =
    profileAdapterCompleted && profileIdentity.ok;
  const profileIdentityOk =
    adapterProfileIdentityOk || browserGridCompleted;
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
      instagramPagination: priorInstagramPagination,
      collectionFailed: attemptState.collectionFailed,
      failureKind: attemptState.failureKind
    };
  }
  const detailCandidateUrls = instagramFetchDetails
    ? instagramDetailUrlsNeedingEnrichment({
        adapterPosts: posts,
        gridItems: gridUrls,
        now: collectionNowMs,
        limit: Number.POSITIVE_INFINITY,
        existingPostIds: existingInstagramPostIds
      })
    : [];
  const detailWindowOffset = detailCandidateUrls.length > 0
    ? priorInstagramPagination.detailWindowOffset % detailCandidateUrls.length
    : 0;
  const detailCount = Math.min(
    Math.max(0, Math.floor(postLimit)),
    detailCandidateUrls.length
  );
  const detailUrls = Array.from(
    { length: detailCount },
    (_, index) =>
      detailCandidateUrls[(detailWindowOffset + index) % detailCandidateUrls.length]
  );
  const nextDetailWindowOffset = detailCandidateUrls.length > 0
    ? (detailWindowOffset + detailUrls.length) % detailCandidateUrls.length
    : 0;
  const detailItems = detailUrls.length
    ? await fetchInstagramPostDetails(handle, detailUrls, workerIndex).catch((error) => {
        adapterFailures.push(
          failure(
            target,
            `Instagram browser detail extractor failed: ${errorMessage(error)}`
          )
        );
        return [];
      })
    : [];
  let rejectedAdapterIdentityCount = 0;
  let rejectedAdapterOwnershipCount = 0;
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
    // Adapter rows are owned only by the exact adapter profile response. A
    // browser grid observation cannot substitute for native adapter ownership.
    if (!adapterProfileIdentityOk) {
      rejectedAdapterOwnershipCount += 1;
      return [];
    }
    const publication =
      instagramPublicationDate(post, collectionNowMs).postedAt ??
      instagramPublicationDate(gridItem, collectionNowMs).postedAt ??
      instagramPublicationDate(detail, collectionNowMs).postedAt;
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
      postedAt: publication,
      metrics,
      mediaUrls: detail?.mediaUrls ?? gridItem?.mediaUrls ?? [],
      contributionScore: scoreMetrics("instagram", metrics),
      matchReason:
        target.matchReason ??
        `Opt-in read-only Instagram profile scrape for @${handle}; metrics came from visible post grid/profile/detail data.`
    })];
  });
  const seenPostIds = new Set(adapterEvidence.map((item) => item.platformPostId).filter(Boolean));
  const gridOwnershipFailures = [];
  const gridOwnershipNeedsReview = [];
  const gridEvidence = gridUrls.flatMap((gridUrl) => {
      const sourceUrl = canonicalInstagramPostUrl(gridUrl.href);
      const postId = instagramPostIdFromUrl(sourceUrl);
      if (!sourceUrl || !postId || seenPostIds.has(postId)) return [];
      const detail = detailItems.find(
        (item) => instagramPostIdFromUrl(item?.url) === postId
      );
      const ownership = instagramGridOnlyOwnershipDecision({
        requestedHandle: handle,
        gridItem: gridUrl,
        detail
      });
      if (!ownership.ok) {
        gridOwnershipFailures.push(
          failure(
            target,
            `Instagram grid-only native post quarantined: ${ownership.reason}.`,
            sourceUrl
          )
        );
        gridOwnershipNeedsReview.push(
          instagramGridOwnershipReviewItem({
            target,
            sourceUrl,
            postId,
            gridItem: gridUrl,
            detail,
            reason: ownership.reason
          })
        );
        return [];
      }
      seenPostIds.add(postId);
      const metrics = {
        likes: maxMetric(detail?.likes, gridUrl.likes),
        comments: maxMetric(detail?.comments, gridUrl.comments),
        views: maxMetric(detail?.views, gridUrl.views)
      };
      const caption = bestInstagramCaption(gridUrl.caption, detail?.caption);
      return [socialEvidenceItem({
        target,
        sourceUrl,
        platformPostId: postId,
        title: caption || `${handle} Instagram post`,
        text: caption || `${handle} Instagram post`,
        rawVisibleText: JSON.stringify({ profile, gridUrl, detail }),
        postedAt:
          instagramPublicationDate(detail, collectionNowMs).postedAt ??
          instagramPublicationDate(gridUrl, collectionNowMs).postedAt,
        metrics,
        mediaUrls: detail?.mediaUrls ?? gridUrl.mediaUrls ?? [],
        contributionScore: scoreMetrics("instagram", metrics),
        matchReason:
          target.matchReason ??
          `Opt-in read-only Instagram grid/detail scrape for @${handle}; adapter did not return this visible grid item.`
      })];
    });
  const scoredCandidates = dedupeById([...adapterEvidence, ...gridEvidence])
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
  const malformedGridIdentityCount = Math.max(
    0,
    Number(gridCollection?.malformedItemCount ?? 0)
  );
  const malformedNativeIdentityCount =
    rejectedAdapterIdentityCount + malformedGridIdentityCount;
  const nativeIdentityFailures = malformedNativeIdentityCount
    ? [
        failure(
          target,
          `Rejected ${malformedNativeIdentityCount} Instagram native row(s) with missing, malformed, or contradictory post/reel/tv identity (${rejectedAdapterIdentityCount} adapter, ${malformedGridIdentityCount} grid).`
        )
      ]
    : [];
  const adapterOwnershipFailures = rejectedAdapterOwnershipCount
    ? [
        failure(
          target,
          `Rejected ${rejectedAdapterOwnershipCount} Instagram adapter row(s) because the adapter profile did not prove the exact requested handle.`
        )
      ]
    : [];
  const paginationDecision = gridCollection
    ? instagramDeepScrollPaginationDecision({
        identityOk: profileIdentityOk,
        candidateItems: gridUrls,
        persistedObservedPostIds: existingInstagramPostIds,
        priorState: priorInstagramPagination,
        malformedItemCount: malformedNativeIdentityCount,
        nextDetailWindowOffset
      })
    : {
        ...priorInstagramPagination,
        advance: false,
        exhausted: false,
        status: "non_exhaustive",
        reason: "browser_grid_not_completed",
        newPostIds: [],
        previouslyObservedPostIds: []
      };
  const instagramPagination = {
    version: priorInstagramPagination.version,
    mode: priorInstagramPagination.mode,
    handle,
    observedPostIds: paginationDecision.observedPostIds,
    recentObservedPostIds:
      paginationDecision.recentObservedPostIds ?? paginationDecision.observedPostIds,
    detailWindowOffset: paginationDecision.detailWindowOffset,
    exhausted: false,
    status: "non_exhaustive",
    decisionStatus: paginationDecision.status,
    reason: paginationDecision.reason,
    windowItemCount: gridUrls.length,
    completedPassCount: gridCollection?.completedPassCount ?? 0,
    stallReason: gridCollection?.stallReason ?? "browser_grid_not_completed",
    newPostCount: paginationDecision.newPostIds.length,
    malformedItemCount: malformedNativeIdentityCount
  };
  const targetFailures = [
    ...adapterFailures,
    ...nativeIdentityFailures,
    ...adapterOwnershipFailures,
    ...gridOwnershipFailures,
    ...recencyFailures
  ];
  if (!evidenceItems.length) {
    const emptyFailure = failure(
      target,
      "No scored recent Instagram posts found with adapter or browser grid/detail extractor."
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
      needsReview: gridOwnershipNeedsReview,
      instagramPagination,
      collectionFailed: attemptState.collectionFailed,
      failureKind: attemptState.failureKind
    };
  }

  const attemptState = instagramCollectionAttemptState({
    evidenceCount: evidenceItems.length,
    completedTimelineSourceCount:
      Number(timelineAdapterCompleted) + Number(browserGridCompleted),
    profileIdentityOk,
    failureMessages: targetFailures.map((item) => item.message)
  });
  return {
    evidence: evidenceItems,
    failures: targetFailures,
    needsReview: gridOwnershipNeedsReview,
    instagramPagination,
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
  const attemptState = xCollectionAttemptState({
    tweetCount: tweets.length,
    attemptedSourceCount,
    completedSourceCount,
    failedSourceCount: failures.length
  });
  if (!tweets.length) {
    return {
      evidence: [],
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

  const childSafetyStop = linkedinChildSafetyStopDecision(failureKind);
  if (childSafetyStop.terminal) {
    linkedinChildSafetyStop ??= {
      ...childSafetyStop,
      targetName: target.name,
      diagnostic: messages || "LinkedIn authenticated account-safety signal"
    };
  }

  linkedinCircuitOpen = true;
  linkedinCircuitReason =
    `${decision.reason ?? failureKind} after ${target.name}: ${messages || "unknown LinkedIn read failure"}`;
}

function updateInstagramCircuitState(result, target) {
  if (!result.collectionFailed) {
    consecutiveInstagramCollectionFailures = 0;
    return;
  }

  const messages = (result.failures ?? [])
    .map((item) => item?.message)
    .filter(Boolean)
    .join(" | ");
  const classifiedFailure = result.failureKind ?? instagramFailureKind(messages);
  if (classifiedFailure === "progress") return;
  consecutiveInstagramCollectionFailures += 1;
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

async function fetchInstagramGridUrls(
  handle,
  workerIndex
) {
  return withInstagramBrowserSessionRetry(
    `yc-ig-${workerIndex}-${slugify(handle)}`,
    async (session) => {
      await runOpenCli(["browser", session, "open", `https://www.instagram.com/${handle}/`], { timeoutMs: perTargetTimeoutMs });
      await runOpenCli(["browser", session, "wait", "time", "4"], { timeoutMs: 10_000 });
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
      const maximumBoundedWindowItems = 10_000;
      let malformedItemCount = 0;
      let completedPassCount = 0;
      let previousScrollGeometry = null;
      let stallReason = "scroll_budget_reached";

      for (let index = 0; index <= scrollPasses; index += 1) {
        const raw = await runOpenCli(
          ["browser", session, "eval", instagramGridExtractJs()],
          { timeoutMs: perTargetTimeoutMs }
        );
        const extractedItems = parseJsonOutput(raw);
        const overflow = extractedItems.find(
          (item) => item?.gridOverflow === true
        );
        if (overflow) {
          throw new Error(
            `Instagram profile grid exceeded the fail-closed ${overflow.anchorLimit}-anchor extraction limit at anchor ${overflow.scannedAnchorCount}.`
          );
        }
        const merged = mergeInstagramGridPassObservations({
          observedByUrl: byUrl,
          items: extractedItems,
          malformedItemCount
        });
        malformedItemCount = merged.malformedItemCount;
        completedPassCount += 1;
        if (byUrl.size > maximumBoundedWindowItems) {
          throw new Error(
            `Instagram bounded grid window exceeded its fail-closed ${maximumBoundedWindowItems}-item limit.`
          );
        }
        if (index === scrollPasses) break;
        const scrollRaw = await runOpenCli(
          ["browser", session, "eval", instagramProfileScrollJs(index)],
          { timeoutMs: 10_000 }
        );
        const scroll = parseJsonOutput(scrollRaw)[0] ?? null;
        if (!instagramScrollGeometryIsValid(scroll)) {
          throw new Error(
            "Instagram browser scroll returned invalid geometry; bounded window was not checkpointed."
          );
        }
        const progressed = instagramScrollGeometryProgressed(
          scroll,
          previousScrollGeometry
        );
        if (!progressed) {
          // A lazy-load or geometry stall is not an end-of-profile proof.
          stallReason = "untrusted_geometry_stall";
          break;
        }
        previousScrollGeometry = scroll;
        await runOpenCli(
          ["browser", session, "wait", "time", "1.5"],
          { timeoutMs: 8_000 }
        );
      }
      return {
        // Every canonical item observed in every successful pass is returned.
        // No scroll cursor is persisted because OpenCLI exposes none that can
        // be resumed safely across invocations.
        items: [...byUrl.values()],
        malformedItemCount,
        completedPassCount,
        coverageStatus: "non_exhaustive",
        stallReason
      };
    }
  );
}

function instagramScrollGeometryIsValid(value) {
  return Boolean(
    value &&
    [value.beforeY, value.y, value.body, value.doc].every((field) =>
      Number.isFinite(Number(field))
    ) &&
    Number(value.y) >= 0 &&
    Number(value.body) >= 0 &&
    Number(value.doc) >= 0
  );
}

function instagramScrollGeometryProgressed(value, previous = null) {
  if (!instagramScrollGeometryIsValid(value)) return false;
  if (Number(value.y) > Number(value.beforeY)) return true;
  if (!instagramScrollGeometryIsValid(previous)) return false;
  return Boolean(
    Number(value.y) > Number(previous.y) ||
    Number(value.body) > Number(previous.body) ||
    Number(value.doc) > Number(previous.doc)
  );
}

async function fetchInstagramPostDetails(handle, detailUrls, workerIndex) {
  if (!Array.isArray(detailUrls) || detailUrls.length === 0) return [];
  return withInstagramBrowserSessionRetry(
    `yc-ig-detail-${workerIndex}-${slugify(handle)}`,
    async (session) => {
      const details = [];
      const urls = detailUrls
        .map((item) => canonicalInstagramPostUrl(item))
        .filter(Boolean)
        .slice(0, postLimit);

      for (const url of urls) {
        await runOpenCli(
          ["browser", session, "open", url],
          { timeoutMs: perTargetTimeoutMs }
        );

        let parsed = null;
        let publication = { postedAt: null, publishedAtPrecision: "unknown" };
        for (let detailAttempt = 0; detailAttempt < 3; detailAttempt += 1) {
          await delay(detailAttempt === 0 ? 4_000 : 2_000);
          const raw = await runOpenCli(
            ["browser", session, "eval", instagramPostDetailExtractJs()],
            { timeoutMs: perTargetTimeoutMs }
          );
          const extracted = parseJsonOutput(raw)[0] ?? parseJsonOutput(raw);
          const candidate = normalizeInstagramDetailObservation(extracted);
          if (canonicalInstagramPostUrl(candidate?.url) !== url) continue;
          parsed = candidate;
          publication = instagramPublicationDate(parsed, collectionNowMs);
          if (publication.postedAt) break;
        }
        if (parsed?.url || parsed?.description || parsed?.caption) {
          details.push({
            url,
            caption: parsed.caption ?? null,
            rawText: parsed.text ?? parsed.description ?? "",
            description: parsed.description ?? null,
            authorHandle: parsed.authorHandle ?? null,
            authorUrl: parsed.authorUrl ?? null,
            authorProof: parsed.authorProof ?? null,
            postedAt: publication.postedAt,
            likes: numberOrNull(parsed.likes),
            comments: numberOrNull(parsed.comments),
            views: numberOrNull(parsed.views),
            mediaUrls: parsed.mediaUrls ?? []
          });
        }
        await delay(Math.min(delayMs, 1200));
      }

      return details;
    }
  );
}

async function runInstagramAdapterWithRetry(args) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runOpenCli(args, { timeoutMs: perTargetTimeoutMs });
    } catch (error) {
      lastError = error;
      if (
        attempt === 1 ||
        !instagramShouldRetryTransientBrowserFailure(errorMessage(error))
      ) {
        throw error;
      }
      await delay(1_500);
    }
  }
  throw lastError;
}

async function withInstagramBrowserSessionRetry(sessionPrefix, operation) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = `${sessionPrefix}-${Date.now()}-${attempt}`;
    try {
      return await withOpenCliBrowserSession({
        session,
        runOpenCli,
        operation: () => operation(session)
      });
    } catch (error) {
      lastError = error;
      if (
        attempt === 1 ||
        !instagramShouldRetryTransientBrowserFailure(errorMessage(error))
      ) {
        throw error;
      }
      await delay(1_500);
    }
  }
  throw lastError;
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
    title: sanitizePublicText(input.title).slice(0, 512),
    sourceUrl: input.sourceUrl,
    platformPostId: input.platformPostId ?? null,
    accountUrl: input.accountUrl ?? input.target.url,
    text: sanitizePublicText(textValue).slice(0, 900),
    rawVisibleText: rawVisibleText.slice(0, LOGGED_IN_STORED_RAW_TEXT_LIMIT),
    postedAt: input.postedAt ?? null,
    publishedAtPrecision: input.publishedAtPrecision ?? (input.postedAt ? "exact" : "unknown"),
    metrics,
    mediaUrls: input.mediaUrls ?? [],
    contributionScore: input.contributionScore ?? scoreMetrics(input.target.platform, metrics),
    review_state: "verified",
    matchReason: input.matchReason
      ? sanitizePublicText(input.matchReason).slice(0, 1_024)
      : null,
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

function instagramGridOwnershipReviewItem({
  target,
  sourceUrl,
  postId,
  gridItem,
  detail,
  reason
}) {
  return {
    id: stableId(
      `instagram-grid-ownership:${target.batchSlug}:${target.entityId}:${postId}`
    ),
    platform: "instagram",
    batch: target.batch,
    batchSlug: target.batchSlug,
    companySlug: target.companySlug,
    companyName: target.companyName,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.name,
    accountUrl: target.url,
    sourceUrl,
    platformPostId: postId,
    review_state: "needs_review",
    quarantineReasons: [reason],
    matchReason:
      "Grid-only Instagram evidence was not attributed because exact native detail-author ownership was not proven.",
    ownershipProbe: {
      profileGridProven: gridItem?.profileGridProven === true,
      profileHandle: gridItem?.profileHandle ?? null,
      detailAuthorHandle: detail?.authorHandle ?? null,
      detailAuthorUrl: detail?.authorUrl ?? null,
      detailAuthorProof: detail?.authorProof ?? null
    },
    checkedAt: now
  };
}

async function runOpenCli(args, options = {}) {
  try {
    return await executeOpenCli(args, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? perTargetTimeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      signal: options.signal
    });
  } catch (error) {
    const stdout = sanitizeOpenCliDiagnostic(error?.stdout);
    const stderr = sanitizeOpenCliDiagnostic(error?.stderr);
    const message = sanitizeOpenCliDiagnostic(
      error instanceof Error ? error.message : String(error)
    );
    throw new Error(
      cleanText(`${stdout}\n${stderr}\n${message}`) || "OpenCLI command failed."
    );
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
  const snapshot = compactStoredPayload({
    attempts: Object.fromEntries(attemptMap),
    evidence: sanitizeStoredRows(contentDedupe.evidence),
    failures: sanitizeStoredRows(dedupeById(failures)),
    needsReview: sanitizeStoredRows(contentDedupe.needsReview),
    attributionReconciliationLedger: contentDedupe.attributionReconciliationLedger
  });
  checkpointWriteChain = checkpointWriteChain.then(() => writeJson(checkpointPath, snapshot));
  await checkpointWriteChain;
}

function sanitizeStoredRows(rows) {
  return compactLoggedInStoredRows(rows);
}

function compactStoredPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  for (const field of [
    "evidence",
    "failures",
    "needsReview",
    "attributionReconciliationLedger"
  ]) {
    if (Array.isArray(payload[field])) sanitizeStoredRows(payload[field]);
  }
  if (payload.attempts && typeof payload.attempts === "object") {
    // Reuse the same in-place compactor for nested attempt error diagnostics.
    compactLoggedInStoredRows([payload.attempts]);
  }
  return payload;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Logged-in social JSON artifact could not be read safely: ${path}`, {
      cause: error
    });
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
  // Redact per string while JSON is produced so a 40k-row payload does not
  // require both an unredacted and redacted full-document string in memory.
  return JSON.stringify(value, (_field, nested) =>
    typeof nested === "string" ? redactTokenLikeStrings(nested) : nested
  );
}

function redactTokenLikeStrings(value) {
  return sanitizeOpenCliDiagnostic(value);
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

function removeTargetFailures(target) {
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const item = failures[index];
    if (
      item.batchSlug === target.batchSlug &&
      item.platform === target.platform &&
      item.entityType === target.entityType &&
      item.entityId === target.entityId
    ) {
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

function nonnegativeIntegerArg(name) {
  const raw = stringArg(name);
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe nonnegative integer.`);
  }
  return parsed;
}

function platformSetArg(name) {
  const raw = stringArg(name);
  if (!raw) return new Set();
  const platforms = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value === "twitter" ? "x" : value);
  const invalid = platforms.filter(
    (value) => !["instagram", "linkedin", "x"].includes(value)
  );
  if (invalid.length > 0) {
    throw new Error(`${name} contains unsupported platform(s): ${invalid.join(", ")}.`);
  }
  return new Set(platforms);
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
    "  --linkedin-max-targets=N   LinkedIn-only cap (default/hard maximum: 5; lower values only)",
    "  --workers=N",
    "  --limit=N",
    "  --scrolls=N",
    "  --output-path=PATH          Isolate the evidence output path",
    "  --checkpoint-path=PATH      Isolate the active checkpoint path",
    "  --timeout-ms=N",
    "  --delay-ms=N              LinkedIn enforces a 30000ms minimum between targets",
    "  --allow-linkedin",
    "  --linkedin-mode=browser   Authenticated DOM mode; adapter modes are disabled for auditable pacing",
    "  --x-mode=browser|adapter|hybrid",
    "  --allow-x-adapter-fallback",
    "  --include-retweets",
    "  --skip-instagram-details",
    "  --max-consecutive-x-failures=N",
    "  --max-consecutive-linkedin-failures=N",
    "  --max-consecutive-instagram-failures=N",
    `  --fresh-for-hours=N        Re-run completed targets after N hours (default: ${DEFAULT_LOGGED_IN_SOCIAL_FRESH_FOR_HOURS})`,
    "  --terminal-completed-platforms=linkedin  Keep successful done attempts terminal for listed platforms",
    "  --retry-empty",
    "  --force",
    "  --plan                     Print the read-only target plan and exit",
    "  --finalize-only             Rebuild evidence from checkpoints without collection",
    "  --help, -h",
    "",
    "Authenticated LinkedIn requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,",
    "and an explicit LINKEDIN_GLOBAL_LOCK_NAMESPACE for the durable cross-host account lease."
  ].join("\n");
}

function requiredLinkedInGlobalLockConfiguration() {
  if (cachedLinkedInGlobalLockConfiguration) {
    return cachedLinkedInGlobalLockConfiguration;
  }
  const supabaseUrl = cleanEnvironmentValue(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = cleanEnvironmentValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const globalLockNamespace = cleanEnvironmentValue(
    process.env.LINKEDIN_GLOBAL_LOCK_NAMESPACE
  );
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "LinkedIn safety stop (account_safety): authenticated collection requires the configured durable Supabase global-lock backend."
    );
  }
  if (!globalLockNamespace) {
    throw new Error(
      "LinkedIn safety stop (account_safety): authenticated collection requires an explicit stable LINKEDIN_GLOBAL_LOCK_NAMESPACE."
    );
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      headers: { "X-Client-Info": "returner-authenticated-linkedin-lock" }
    }
  });
  cachedLinkedInGlobalLockConfiguration = Object.freeze({
    globalLeaseProvider: createSupabaseLinkedInGlobalLeaseProvider(client),
    globalLockNamespace
  });
  return cachedLinkedInGlobalLockConfiguration;
}

function cleanEnvironmentValue(value) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

function resolveXCollectionMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (["browser", "adapter", "hybrid"].includes(mode)) return mode;
  throw new Error(`Unsupported --x-mode=${value}. Supported modes: browser, adapter, hybrid.`);
}

function resolveLinkedInCollectionMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "browser") return mode;
  throw new Error(
    `Unsupported --linkedin-mode=${value}. Only browser mode is supported so pacing remains auditable.`
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
  const detailKeys = [
    "primaryError",
    "cause",
    "sessionCleanupFailure",
    "interactionPacingFailure",
    "suppressedInteractionFailure",
    "checkpointFailure",
    "targetPacingFailure",
    "globalLeaseHeartbeatFailure",
    "globalLeaseQuarantineFailure",
    "globalLeaseCleanupFailure"
  ];
  const queue = [error?.primaryError ?? error, error];
  const seen = new Set();
  const messages = [];
  while (queue.length && seen.size < 24) {
    const current = queue.shift();
    if ((typeof current !== "object" && typeof current !== "function") || current === null) {
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);
    if (typeof current.message === "string" && current.message.trim()) {
      const message = sanitizeOpenCliDiagnostic(redactTokenLikeStrings(current.message));
      if (message && !messages.includes(message)) messages.push(message);
    }
    for (const key of detailKeys) {
      const nested = current[key];
      if ((typeof nested === "object" || typeof nested === "function") && nested !== null) {
        queue.push(nested);
      }
    }
  }
  return messages.join(" | ") || sanitizeOpenCliDiagnostic(String(error));
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
  const main = document.querySelector("main");
  const profileParts = location.pathname.split("/").filter(Boolean);
  const profileHandle =
    profileParts.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(profileParts[0])
      ? profileParts[0].toLowerCase()
      : null;
  if (!main || !profileHandle) {
    return [{
      malformedIdentity: true,
      nativeAnchor: true,
      reason: "exact_profile_main_missing"
    }];
  }
  const nativePath = (value) => {
    try {
      const url = new URL(value, location.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      return (
        /^(?:www\\.)?instagram\\.com$/i.test(url.hostname) &&
        parts.length === 2 &&
        /^(?:reel|p|tv)$/i.test(parts[0]) &&
        /^[A-Za-z0-9_-]+$/.test(parts[1])
      );
    } catch {
      return false;
    }
  };
  const anchorWalker = (root) =>
    document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        return node.tagName === "A" && node.hasAttribute("href")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    });
  const anchorLimit = 10000;
  const links = [];
  const mountedAnchorWalker = anchorWalker(main);
  let scannedAnchorCount = 0;
  for (
    let anchor = mountedAnchorWalker.nextNode();
    anchor;
    anchor = mountedAnchorWalker.nextNode()
  ) {
    scannedAnchorCount += 1;
    if (scannedAnchorCount > anchorLimit) {
      return [{
        gridOverflow: true,
        reason: "profile_grid_anchor_limit_exceeded",
        anchorLimit,
        scannedAnchorCount
      }];
    }
    if (/\\/(?:reel|p|tv)\\//i.test(anchor.href || "")) links.push(anchor);
  }
  // Cache a native-post descendant count (capped at two) for each ancestor.
  // This proves grid/suggested-region structure without rescanning the mounted
  // DOM after the single globally bounded anchor walk above.
  const nativeAnchorDescendantCounts = new WeakMap();
  for (const anchor of links) {
    if (!nativePath(anchor.href)) continue;
    for (let node = anchor.parentElement; node && node !== main; node = node.parentElement) {
      const prior = nativeAnchorDescendantCounts.get(node) || 0;
      if (prior < 2) nativeAnchorDescendantCounts.set(node, prior + 1);
    }
  }
  const regionContainsNativeAnchor = (root) =>
    (nativeAnchorDescendantCounts.get(root) || 0) > 0;
  const regionHasMultipleNativeAnchors = (root) =>
    (nativeAnchorDescendantCounts.get(root) || 0) >= 2;
  const suggestedRegionRoots = new Set();
  for (const heading of main.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, [role="heading"]'
  )) {
    if (!/suggested|recommended|people you may know/i.test(heading.textContent || "")) {
      continue;
    }
    // Keep walking beyond the first anchor-owning section: Instagram can put
    // the heading and one tile in a nested section, then render the remaining
    // suggested tiles as a sibling grid in the same tab panel. Prefer that tab
    // panel as the exclusion boundary; without one, retain the outermost
    // anchor-owning semantic region reached before main.
    let tabPanelRegion = null;
    let semanticRegion = null;
    let nearestNativeRegion = null;
    let nearestMultiTileRegion = null;
    for (
      let region = heading.parentElement;
      region && region !== main;
      region = region.parentElement
    ) {
      if (!regionContainsNativeAnchor(region)) continue;
      nearestNativeRegion ??= region;
      if (!nearestMultiTileRegion && regionHasMultipleNativeAnchors(region)) {
        nearestMultiTileRegion = region;
      }
      const role = (region.getAttribute?.("role") || "").toLowerCase();
      if (role === "tabpanel") {
        tabPanelRegion = region;
        break;
      }
      if (
        region.tagName === "SECTION" ||
        role === "region" ||
        role === "list"
      ) {
        semanticRegion = region;
      }
    }
    const suggestedRegion =
      tabPanelRegion ??
      semanticRegion ??
      nearestMultiTileRegion ??
      nearestNativeRegion;
    if (suggestedRegion) suggestedRegionRoots.add(suggestedRegion);
  }
  const regionIsExcluded = (anchor) => {
    if (anchor.closest('aside, [role="dialog"], article')) return true;
    for (const region of suggestedRegionRoots) {
      if (region.contains(anchor)) return true;
    }
    for (let node = anchor.parentElement; node && node !== main; node = node.parentElement) {
      const label = node.getAttribute?.("aria-label") || "";
      if (/suggested|recommended|people you may know/i.test(label)) {
        return true;
      }
    }
    return false;
  };
  const containerCache = new WeakMap();
  const provenGridContainer = (anchor) => {
    if (regionIsExcluded(anchor)) return null;
    for (let node = anchor.parentElement; node && node !== main; node = node.parentElement) {
      if (containerCache.has(node)) {
        const cached = containerCache.get(node);
        if (cached) return cached;
        continue;
      }
      const role = node.getAttribute?.("role") || "";
      const display = getComputedStyle(node).display;
      if (
        role === "tabpanel" ||
        display === "grid" ||
        regionHasMultipleNativeAnchors(node)
      ) {
        containerCache.set(node, node);
        return node;
      }
      containerCache.set(node, null);
    }
    return null;
  };
  const seen = new Set();
  return links
    .map((anchor) => {
      const gridContainer = provenGridContainer(anchor);
      if (!gridContainer) return { unrelated: true };
      try {
        const href = anchor.href;
        const url = new URL(href, location.origin);
        const parts = url.pathname.split("/").filter(Boolean);
        if (
          !/^(?:www\\.)?instagram\\.com$/i.test(url.hostname) ||
          parts.length !== 2 ||
          !/^(?:reel|p|tv)$/i.test(parts[0]) ||
          !/^[A-Za-z0-9_-]+$/.test(parts[1] || "")
        ) {
          return {
            malformedIdentity: true,
            nativeAnchor: true,
            rawHref: href
          };
        }
        const canonical = "https://www.instagram.com/" + parts[0].toLowerCase() + "/" + parts[1] + "/";
        if (seen.has(canonical)) {
          return { duplicateIdentity: true, href: canonical };
        }
        seen.add(canonical);
        const images = Array.from(anchor.querySelectorAll("img[src]"));
        const captions = images.map((img) => img.alt).filter(Boolean);
        const labels = Array.from(anchor.querySelectorAll("[aria-label]")).map((node) => node.getAttribute("aria-label")).filter(Boolean);
        const timeNode =
          anchor.querySelector("time[datetime]") ??
          anchor.closest("li")?.querySelector("time[datetime]") ??
          null;
        const metrics = overlayMetric(anchor, labels, canonical);
        return {
          href: canonical,
          rawHref: href,
          platformPostId: parts[1],
          profileGridProven: true,
          profileHandle,
          gridContainerProof:
            gridContainer.getAttribute?.("role") === "tabpanel"
              ? "profile_tabpanel"
              : getComputedStyle(gridContainer).display === "grid"
                ? "profile_css_grid"
                : "profile_multi_tile_container",
          caption: captions[0] || "",
          mediaUrls: images.map((img) => img.src).filter(Boolean).slice(0, 2),
          labels,
          rawText: metrics.rawText,
          postedAt: timeNode?.getAttribute("datetime") ?? null,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments
        };
      } catch {
        return {
          malformedIdentity: true,
          nativeAnchor: true,
          rawHref: String(anchor.getAttribute("href") || "").slice(0, 500)
        };
      }
    });
})()`;
}

function instagramProfileScrollJs(index) {
  const amount = 1600 + index * 600;
  return `(() => {
  const beforeY = window.scrollY;
  window.scrollBy(0, ${amount});
  document.documentElement.scrollTop = Math.max(document.documentElement.scrollTop, window.scrollY);
  document.body.scrollTop = Math.max(document.body.scrollTop || 0, window.scrollY);
  return { beforeY, y: window.scrollY, body: document.body.scrollHeight, doc: document.documentElement.scrollHeight };
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
  // Native taken_at often precedes the shortcode by several kilobytes in
  // Instagram's embedded page payload. Keep the search anchored to the exact
  // shortcode while covering the complete neighboring media object.
  const mediaBlob = mediaIndex >= 0
    ? html.slice(Math.max(0, mediaIndex - 30000), mediaIndex + 60000)
    : "";
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
  const nativeAuthor = (() => {
    const postSurface = document.querySelector("main article");
    if (!postSurface) return null;
    const header = postSurface.querySelector("header");
    if (!header) return null;
    for (const anchor of header.querySelectorAll("a[href]")) {
      try {
        const url = new URL(anchor.href, location.origin);
        const parts = url.pathname.split("/").filter(Boolean);
        if (
          /^(?:www\\.)?instagram\\.com$/i.test(url.hostname) &&
          parts.length === 1 &&
          /^[A-Za-z0-9._]{1,30}$/.test(parts[0])
        ) {
          return {
            handle: parts[0].toLowerCase(),
            url: "https://www.instagram.com/" + parts[0].toLowerCase() + "/",
            proof: "native_post_header_profile_link"
          };
        }
      } catch {
        // Keep probing other header links; absence fails closed in the caller.
      }
    }
    return null;
  })();
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]') || "";
  const text = document.body?.innerText || "";
  const semanticDate = document.querySelector('time[datetime]')?.getAttribute("datetime") || null;
  const metricText = description || text;
  const likes = parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+likes?/i) || [])[1]) ?? jsonNumber("like_count");
  const comments = parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+comments?/i) || [])[1]) ?? jsonNumber("comment_count");
  const views =
    parseNumber((metricText.match(/([0-9,.]+\\s*[KMB]?)\\s+(?:views?|plays?)/i) || [])[1]) ??
    jsonNumber("view_count") ??
    jsonNumber("play_count") ??
    jsonNumber("video_view_count");
  const dateLabel = (description.match(/\\bon\\s+([^:]+):\\s*"/i) || [])[1] || null;
  const takenAt = jsonNumber("taken_at");
  const caption =
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
    authorHandle: nativeAuthor?.handle ?? null,
    authorUrl: nativeAuthor?.url ?? null,
    authorProof: nativeAuthor?.proof ?? null,
    taken_at: takenAt,
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

function linkedInSafetyProbeJs() {
  return `(() => [{
    currentUrl: location.href,
    title: document.title || "",
    visibleText: String(document.body?.innerText || "").slice(0, 8000)
  }])()`;
}
