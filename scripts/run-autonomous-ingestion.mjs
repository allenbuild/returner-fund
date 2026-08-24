import { createClient } from "@supabase/supabase-js";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTONOMOUS_BATCHES,
  AUTONOMOUS_PROCESS_BUDGETS,
  autonomousMappedTerminalFailureBudget,
  autonomousCollectorRetryableFailures,
  buildAutonomousPublicNativeAuthorResolver,
  buildCanonicalTargetedAttributionResolver,
  buildLegacyPublicEvidenceBatchResolver,
  buildAutonomousTaskPlan,
  buildGithubAuthoritativeQuarantineLedger,
  classifyAutonomousCollectorTaskOutcome,
  countSuccessfulAutonomousCollectorRows,
  indexAutonomousCollectorTaskOutcomes,
  isAutonomousCollectorTaskForRun,
  loadAutonomousCatalogs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  partitionAutonomousTaskInventory,
  reconcileGithubTractionSnapshots,
  summarizeAutonomousCollectorTerminalTaskCoverage,
  summarizeTaskCoverage,
  validateAutonomousCollectorMatrix,
  validateAutonomousCollectorReferentialIntegrity,
  validateAutonomousCollectorSnapshot,
  validateAutonomousTerminalCoverage,
  validateMappedAutonomousCoverage
} from "./lib/autonomous-ingestion-plan.mjs";
import { readRequiredCanonicalJson } from "./lib/canonical-json.mjs";
import { validateSupabaseConfiguration } from "./lib/supabase-configuration.mjs";
import {
  PUBLIC_EVIDENCE_LEGACY_MAX_BYTES,
  PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES,
  PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
  PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES,
  PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH,
  hydratePublicEvidenceArtifactWithLoader,
  readPublicEvidenceArtifact,
  writePublicEvidenceArtifactPairAtomic
} from "./lib/public-evidence-artifact.mjs";
import {
  mergeIngestionSourceDeltaHistory,
  summarizeIngestionSourceDelta
} from "./lib/ingestion-source-delta.mjs";
import { resumeValidatedSnapshotOrRun } from "./lib/autonomous-ingestion-resume.mjs";
import {
  AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  createAutonomousCollectionBudget,
  createAutonomousCollectionDrainBudget,
  createAutonomousRunnerBudget
} from "./lib/autonomous-ingestion-budget.mjs";
import { selectPublishedAutonomousIngestionReceipt } from "./lib/autonomous-ingestion-receipt-policy.mjs";
import {
  CENTRAL_TIME_ZONE,
  INGESTION_CENTRAL_SLOTS,
  centralDateTimeParts,
  latestEligibleCentralSlot
} from "./lib/ingestion-schedule.mjs";
import { mergeTargetedEvidenceSnapshots } from "./lib/targeted-evidence-merge.mjs";
import { archiveAcceptedPublicSnapshot } from "./lib/archive-public-ingestion.mjs";
import { openLosslessPostArchive } from "./lib/lossless-post-archive.mjs";
import { sanitizeRunnerFailureMessage } from "./lib/runner-failure-sanitizer.mjs";
import { importEvidenceSnapshots } from "./lib/durable-evidence-import.mjs";
import {
  assertReplaySafePublicationChanges,
  assertSafeInertPublicationBaseChanges,
  isProtectedSourcePolicyPath,
  isValidatedPublicationRetryReuseSafePath
} from "./lib/autonomous-publication-trust.mjs";
import { isVerifiedYouTubeNativeMetriclessEvidence } from "./lib/youtube-native-promotion.mjs";
import { comparePublicationSemantics } from "./lib/publication-semantic-diff.mjs";
import { buildVerifiedFirstPartyContextEvidenceValidator } from "./lib/first-party-authored-post-promotion.mjs";
import {
  finalizeLoggedInEvidenceContent,
  mergeLoggedInEvidenceRows
} from "./lib/logged-in-evidence-content-dedupe.mjs";
import { isTimelineCoverageMigrationUnavailable } from "./lib/timeline-migration-availability.mjs";

let root;
const pinnedSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let sourceCommit;
let publicationRoot = null;
let publicationWorktreeParent = null;
let publicationBaseCommit = null;
let publicationReceiptSha256 = null;
let preverifiedPublicationBaseCommit = null;
let args;
let idempotencyKey;
let workerId;
let runStartedAt;
let runnerBudget;
let workRoot;
let collectorRoot;
let publicOutputs;
let githubOutputs;
let loggedInOutputs;
let loggedInCheckpointOutputs;
let discoveryAttemptOutputs;
let sourceDiscoveryPathOutputs;
let publishedDiscoveryAttemptsPath;
let publishedSourceDiscoveryPathsPath;
let publishedCohortAuditPath;
let publishedSourceDeltaPath;
let publishedSourceDeltaHistoryPath;
let publishedGithubQuarantinePath;
let topVoiceOutput;
let losslessPublicArchiveRoot;
let catalogs;
let resolvePublicNativeAuthor;
let resolveCanonicalTargetedAttribution;
let resolveLegacyPublicEvidenceBatch;
let plannedTasks;
let plannedTaskByCheckpointKey;
let plannedCoverage;
const HISTORICAL_ATTRIBUTION_READ_ATTEMPTS = 3;
const HISTORICAL_ATTRIBUTION_READ_BATCH_SIZE = 100;
const INGESTION_TASK_READ_PAGE_SIZE = 1_000;
const INGESTION_TASK_READ_MIN_PAGE_SIZE = 125;
const INGESTION_TASK_READ_MAX_ATTEMPTS = 4;
const INGESTION_TASK_READ_SUCCESS_PAGES_BEFORE_GROWTH = 2;
// Structured Git output is parsed as a complete NUL-delimited record stream.
// Never silently tail-truncate it: a partial first path can be misclassified
// as an unsafe absolute path during publication recovery.
const STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT = 64 * 1024 * 1024;
const PUBLIC_COLLECTOR_SHARDS = Object.freeze({
  S2026: 4,
  S26: 2,
  A16ZSR006: 1
});
const PUBLIC_SHARD_PROCESS_CONCURRENCY = 2;
const PUBLIC_COLLECTOR_TASK_CONCURRENCY = 8;
const PUBLIC_SOCIAL_LANE_CONCURRENCY = 1;
const LINKEDIN_REPLAY_MAX_CHUNKS = 7;
const LINKEDIN_REPLAY_TARGET_CAP = 5;
const LINKEDIN_REPLAY_RESERVE_MS = 15 * 60_000;
const LINKEDIN_REPLAY_PLAN_TIMEOUT_MS = 2 * 60_000;
const runWithPublicShardProcessSlot = createConcurrencyGuard(PUBLIC_SHARD_PROCESS_CONCURRENCY);
// GitHub has a separate two-process lane. Each process uses four ordinary
// collector workers, so the initial request fan-out is capped at eight while
// seven shards still finish within the 120-minute collection phase.
const GITHUB_SHARD_PROCESS_CONCURRENCY = 2;
const GITHUB_COLLECTOR_TASK_CONCURRENCY = 4;
const runWithGithubShardProcessSlot = createConcurrencyGuard(GITHUB_SHARD_PROCESS_CONCURRENCY);
const GITHUB_COLLECTOR_SHARDS = Object.freeze({
  S2026: 4,
  S26: 2,
  A16ZSR006: 1
});
let url;
let serviceKey;
let supabaseConfiguration;
let durableStorageConfigured = false;
let discoveryCredentialGaps = [];
let supabase = null;
let runtimeLock = null;
let run = null;
let heartbeatTimer = null;
let heartbeatInFlight = null;
let heartbeatDrainPromise = null;
let heartbeatSchedulingStopped = false;
let heartbeatAbortController = null;
let hardFailure = null;
let heartbeatFailure = null;
let collectionBudget = null;
let collectionDrainBudget = null;
let latestCollectionCoverage = null;
let latestTerminalFailureBudget = null;
let latestPublishedCommit = null;
let latestTimelineBuildReceipt = null;
let pendingRunnerOutcome = null;
let terminationSignal = null;
let cancellationDeadlineTimer = null;
let cancellationEmergencyTimer = null;
let cancellationEmergencyPromise = null;
let runtimeLockReleasePromise = null;
let canceledRunRecordPromise = null;
let runnerOutcomeWritePromise = null;
let publicationPushCandidate = null;
let publicationCancellationResolutionPromise = null;
let publicationSignalAdoptionClosed = false;
let publicationWorktreeCleanupPromise = null;
let runFinalizationPromise = null;
let finalizedRunStatus = null;
let successfulRunnerOutcomeCandidate = null;
let completedOutcomeVerifiedByThisExecution = false;
let lifecycleOperationTimeoutOverrideMs = null;
let executionCompletionNonce = null;
let candidateMetadata = null;
let authenticatedSocial = null;
const activeChildProcesses = new Set();
const HEARTBEAT_DRAIN_TIMEOUT_MS = 10_000;
const CANCELLATION_CLEANUP_TIMEOUT_MS = 15_000;
const COMMAND_FAILURE_TAIL_MAX_LENGTH = 4_096;
const LIFECYCLE_OPERATION_TIMEOUT_MS = 15_000;
const SUPABASE_BULK_OPERATION_TIMEOUT_MS = 5 * 60_000;
const COMMAND_EVENT_TIMEOUT_MS = 2_000;
const PROCESS_KILL_WATCHDOG_MS = 1_000;
const CANCELLATION_REMOTE_VERIFY_TIMEOUT_MS = 10_000;
// Emergency cleanup may need to terminate a process tree, reconcile one remote
// push, finalize a run, release/reconcile the global lock, and drain an
// abort-insensitive heartbeat. Keep the force-exit watchdog beyond that entire
// bounded sequence (and comfortably inside the workflow's six-minute headroom).
const CANCELLATION_EMERGENCY_TIMEOUT_MS = 150_000;
const CHILD_HARD_SETTLE = Symbol("autonomous-ingestion-child-hard-settle");
const CHILD_ROOT_START_IDENTITY = Symbol("autonomous-ingestion-child-root-start-identity");
const CHILD_DESCENDANT_PIDS = Symbol("autonomous-ingestion-child-descendants");
const CHILD_DESCENDANT_SAMPLER = Symbol("autonomous-ingestion-child-descendant-sampler");
const CHILD_PROCESS_LEDGER = Symbol("autonomous-ingestion-child-process-ledger");
const CHILD_TREE_DRAIN_PROMISE = Symbol("autonomous-ingestion-child-tree-drain-promise");
const CHILD_TREE_DRAIN_RESOLVE = Symbol("autonomous-ingestion-child-tree-drain-resolve");
const COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS = 60_000;
const COLLECTOR_SNAPSHOT_FILE_SKEW_MS = 2_000;
const COLLECTOR_RESUME_MAX_AGE_MS = 12 * 60 * 60_000;
const PROCESS_DESCENDANT_SAMPLE_MS = 250;
const PROCESS_NORMAL_EXIT_DRAIN_MS = 500;
const CHILD_PROCESS_LEDGER_MAX_ENTRIES = 4_096;
const FULL_CORPUS_NODE_HEAP_MB = 3_072;
const DEFAULT_NODE_CHILD_HEAP_MB = 1_536;
// Collector shards can overlap across the public and GitHub lanes. Keep each
// Node collector bounded independently so the aggregate request fan-out cannot
// exhaust the runner while preserving the full-corpus budget for serial builds.
const COLLECTOR_NODE_HEAP_MB = 768;
const GIT_PUSH_RETRYABLE_EXIT_CODES = new Set([128, 129, 130, 137, 143]);
// One initial publication plus two exact-base rebuilds tolerates a second
// concurrent main advance without allowing an unbounded push race. Every
// command remains additionally constrained by the runner's existing deadline.
const MAX_PUBLICATION_PUSH_ATTEMPTS = 3;
const PUBLICATION_SEMANTIC_IGNORED_PATHS = Object.freeze([
  "outputs/ingestion-source-delta-current.json",
  "outputs/ingestion-source-delta-history.json"
]);

const SAFE_CHILD_ENV_KEYS = Object.freeze([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "GITHUB_ACTIONS"
]);
const CHILD_ENV_CATEGORY_KEYS = Object.freeze({
  runtime: [],
  public_collector: ["X_BEARER_TOKEN", "EXA_API_KEY", "SCORING_DATA_ROOT"],
  github_collector: ["GITHUB_TOKEN"],
  authenticated_social: [
    "HOME",
    "OPENCLI_BIN",
    "OPENCLI_CONFIG_DIR",
    "OPENCLI_HOME",
    "OPENCLI_PROFILE",
    "BROWSER_PROFILE_PATH",
    "CHROME_USER_DATA_DIR",
    "RETURNER_LINKEDIN_VIEWER_PROFILE",
    "RETURNER_INSTAGRAM_VIEWER_HANDLE",
    "LINKEDIN_GLOBAL_LOCK_NAMESPACE",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
  ],
  durable_timeline: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SCORING_DATA_ROOT"],
  publication_data: ["SCORING_DATA_ROOT"],
  benchmark: [
    "BENCHMARK_NOW",
    "BENCHMARK_WINDOW_START",
    "GRAPH_API_BASE_URL",
    "GRAPH_API_PORT",
    "INGESTION_RUN_ID",
    "SCORING_DATA_ROOT"
  ],
  timeline_backfill: [
    "TIMELINE_REQUIRE_DATABASE",
    "SCORING_DATA_ROOT"
  ],
  publication_push: [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_KEY_1",
    "GIT_CONFIG_VALUE_1",
    "GIT_CONFIG_KEY_2",
    "GIT_CONFIG_VALUE_2",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_TERMINAL_PROMPT"
  ],
  test_fixture: ["LIFECYCLE_FIXTURE_MARKER"]
});
const PRIVILEGED_CHILD_ENV_KEYS = Object.freeze([
  "SUPABASE_SERVICE_ROLE_KEY",
  "X_BEARER_TOKEN",
  "EXA_API_KEY",
  "GITHUB_TOKEN",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "GRAPH_DIAGNOSTICS_SECRET",
  "GRAPH_PUBLICATION_BUILD_TOKEN",
  "GIT_CONFIG_VALUE_0"
]);

installTerminationSignalHandlers();

try {
root = resolve(process.cwd());
args = parseArgs(process.argv.slice(2));
idempotencyKey = args.idempotencyKey ?? process.env.INGESTION_IDEMPOTENCY_KEY;
workerId = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.pid}:${randomUUID()}`;
executionCompletionNonce = randomUUID();
runStartedAt = new Date();
runnerBudget = createAutonomousRunnerBudget({
  phaseMs: AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  startedAt: runStartedAt.getTime()
});
if (!idempotencyKey) {
  throw new Error("--idempotency-key or INGESTION_IDEMPOTENCY_KEY is required.");
}
const lifecycleContractFixture = cleanEnv(
  process.env.AUTONOMOUS_INGESTION_LIFECYCLE_TEST_FIXTURE
);
if (lifecycleContractFixture) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Lifecycle contract fixtures are available only when NODE_ENV=test.");
  }
  const fixtureExitCode = await runLifecycleContractFixture(lifecycleContractFixture);
  process.exit(fixtureExitCode);
}
if (
  args.recoveryDebt &&
  (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "schedule")
) {
  throw new Error("Recovery debt bypass requires a resolver-authorized GitHub schedule event.");
}
await verifyPinnedSourceExecutionBoundary({ verifyPolicyCleanliness: !args.plan });
candidateMetadata = validateCandidateMetadata({
  trigger: args.candidateTrigger,
  scheduledAt: args.scheduledAt,
  slotKey: idempotencyKey,
  recoveryDebt: args.recoveryDebt,
  required: process.env.GITHUB_ACTIONS === "true" && !args.skipPublish
});
if (args.authenticatedSocialReplay && candidateMetadata?.trigger !== "manual-replay") {
  throw new Error("Authenticated social historical replay is available only for an explicit manual replay.");
}
assertCandidateFreshForPublication("runner start");
workRoot = join(root, "work", "autonomous-ingestion", safePathSegment(idempotencyKey));
collectorRoot = args.authenticatedSocialReplay
  ? authenticatedSocialReplayRoot()
  : args.campaignKey
    ? join(root, "work", "autonomous-ingestion-campaigns", safePathSegment(args.campaignKey))
    : workRoot;
publicOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `public-${batch.slug.toLowerCase()}.json`)])
);
githubOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `github-${batch.slug.toLowerCase()}.json`)])
);
loggedInOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `logged-in-${batch.slug.toLowerCase()}.json`)])
);
loggedInCheckpointOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `logged-in-checkpoint-${batch.slug.toLowerCase()}.json`)])
);
discoveryAttemptOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `discovery-attempts-${batch.slug.toLowerCase()}.json`)])
);
sourceDiscoveryPathOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `source-discovery-paths-${batch.slug.toLowerCase()}.json`)])
);
configurePublicationArtifactPaths(root);
topVoiceOutput = join(collectorRoot, "top-voice-refresh.json");
losslessPublicArchiveRoot = join(collectorRoot, "lossless-public-post-archive");
url = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
supabaseConfiguration = validateSupabaseConfiguration(url, serviceKey);
durableStorageConfigured = supabaseConfiguration.valid;
discoveryCredentialGaps = [
  !cleanEnv(process.env.X_BEARER_TOKEN) ? "X_BEARER_TOKEN" : null,
  !cleanEnv(process.env.EXA_API_KEY) ? "EXA_API_KEY" : null,
  ...supabaseConfiguration.blockers
].filter(Boolean);
supabase = durableStorageConfigured
  ? createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { "X-Client-Info": "returner-autonomous-ingestion" } }
    })
  : null;

let commitBackedReplay = null;
if (!args.plan && !args.skipPublish && !durableStorageConfigured && process.env.GITHUB_ACTIONS === "true") {
  commitBackedReplay = await readCommitBackedReplayReceipt();
}
if (commitBackedReplay) {
  const { receipt, classification, publishedCommit } = commitBackedReplay;
  console.log(
    `Ingestion ${idempotencyKey} already has a validated publication receipt in main; ` +
    `the file-backed replay is a no-op (${classification.receiptStatus}).`
  );
  await writeRunnerOutcome({
    status: "already_completed",
    publicationStatus: "already_completed",
    collectionHealth: receipt.collectionHealth,
    collectionHealthReasons: receipt.collectionHealthReasons,
    providerBlocked: receipt.providerBlocked,
    providerBlockedByReason: receipt.providerBlockedByReason,
    mappedProviderBlocked: receipt.mappedProviderBlocked,
    mappedProviderBlockedByReason: receipt.mappedProviderBlockedByReason,
    mappedScopeUnsupported: receipt.mappedScopeUnsupported,
    ...replayCoverageOutcome(receipt),
    mappedFailed: receipt.mappedFailures,
    newPhysicalSources: receipt.newPhysicalSources,
    dailyNewPhysicalSources: receipt.dailyNewPhysicalSources,
    dailySourceHealth: receipt.dailySourceHealth,
    publishedCommit
  });
  process.exit(0);
}
if (!args.plan && !args.skipPublish) {
  preverifiedPublicationBaseCommit = await resolveVerifiedCurrentPublicationCommit({
    labelPrefix: "initial publication base",
    allowInertCodeDrift: true
  });
}

await Promise.all([
  mkdir(workRoot, { recursive: true }),
  mkdir(collectorRoot, { recursive: true })
]);
  // The mutable catalog refresh performs network I/O and rewrites the source
  // inventory. Claim the account-global coordinator lock first, then read the
  // idempotent run while holding that lock. This second state read closes the
  // claim/read TOCTOU window and lets a durable completed replay return before
  // any mutable refresh can fail or race another coordinator.
  if (!args.plan && durableStorageConfigured) {
    runtimeLock = await claimRuntimeLock();
    if (!runtimeLock) {
      throw new Error("Another ingestion coordinator owns the non-expired autonomous-ingestion lease.");
    }
    run = await getOrCreateRun();
  }
  if (run?.status === "completed") {
    console.log(`Ingestion ${idempotencyKey} already completed as run ${run.id}; replay is a no-op.`);
    const repositoryBackedReplay = await readCommitBackedReplayReceipt();
    if (!repositoryBackedReplay) {
      throw new Error(
        `Completed ingestion ${idempotencyKey} lacks an exact repository-backed publication receipt.`
      );
    }
    const priorSourceDelta = repositoryBackedReplay.receipt;
    latestPublishedCommit = repositoryBackedReplay.publishedCommit;
    pendingRunnerOutcome = {
      status: "already_completed",
      publicationStatus: "already_completed",
      collectionHealth: priorSourceDelta.collectionHealth,
      collectionHealthReasons: priorSourceDelta.collectionHealthReasons,
      providerBlocked: priorSourceDelta.providerBlocked,
      providerBlockedByReason: priorSourceDelta.providerBlockedByReason,
      mappedProviderBlocked: priorSourceDelta.mappedProviderBlocked,
      mappedProviderBlockedByReason: priorSourceDelta.mappedProviderBlockedByReason,
      mappedScopeUnsupported: priorSourceDelta.mappedScopeUnsupported,
      ...replayCoverageOutcome(priorSourceDelta),
      mappedFailed: priorSourceDelta.mappedFailures,
      newPhysicalSources: priorSourceDelta.newPhysicalSources,
      dailyNewPhysicalSources: priorSourceDelta.dailyNewPhysicalSources,
      dailySourceHealth: priorSourceDelta.dailySourceHealth,
      publishedCommit: repositoryBackedReplay.publishedCommit
    };
    successfulRunnerOutcomeCandidate = pendingRunnerOutcome;
    completedOutcomeVerifiedByThisExecution = true;
    process.exitCode = 0;
  } else {
    if (!args.plan && !args.skipPublish) {
      await ensurePublicationWorktree();
    }
    if (!args.plan && !args.skipNetwork && !args.authenticatedSocialReplay) {
      await refreshMutableYcCatalog();
    }
    catalogs = await loadAutonomousCatalogs(publicationArtifactRoot());
    resolvePublicNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
    resolveCanonicalTargetedAttribution = buildCanonicalTargetedAttributionResolver(catalogs);
    resolveLegacyPublicEvidenceBatch = buildLegacyPublicEvidenceBatchResolver(catalogs);
    plannedTasks = buildAutonomousTaskPlan(catalogs, { runKey: idempotencyKey });
    plannedTaskByCheckpointKey = new Map(
      plannedTasks.map((task) => [task.checkpointKey, task])
    );
    plannedCoverage = summarizeTaskCoverage(plannedTasks);

    if (args.plan) {
      console.log(JSON.stringify({
        idempotencyKey,
        batches: catalogSummary(catalogs),
        coverage: plannedCoverage,
        concurrency: {
          publicShardProcesses: PUBLIC_SHARD_PROCESS_CONCURRENCY,
          publicTasksPerProcess: PUBLIC_COLLECTOR_TASK_CONCURRENCY,
          publicTasksAcrossProcesses:
            PUBLIC_SHARD_PROCESS_CONCURRENCY * PUBLIC_COLLECTOR_TASK_CONCURRENCY,
          publicSocialLanePerProcess: PUBLIC_SOCIAL_LANE_CONCURRENCY,
          publicSocialLaneAcrossProcesses:
            PUBLIC_SHARD_PROCESS_CONCURRENCY * PUBLIC_SOCIAL_LANE_CONCURRENCY,
          githubShardProcesses: GITHUB_SHARD_PROCESS_CONCURRENCY,
          githubTasksPerProcess: GITHUB_COLLECTOR_TASK_CONCURRENCY,
          githubInitialRequestsAcrossProcesses:
            GITHUB_SHARD_PROCESS_CONCURRENCY * GITHUB_COLLECTOR_TASK_CONCURRENCY
        }
      }, null, 2));
      process.exit(0);
    }

    if (!durableStorageConfigured) {
      console.warn(
        `Durable Supabase import skipped because required production configuration is unusable (${supabaseConfiguration.blockers.join(", ")}). ` +
        "File-backed collection and publication will continue, and the workflow receipt will report degraded collection health."
      );
    }
    if (durableStorageConfigured) startHeartbeatScheduling();
    await event("run.started", "info", "Autonomous ingestion run started.", {
      workerId,
      durability: durableStorageConfigured ? "supabase" : "file_backed",
      plannedCoverage,
      catalogs: catalogSummary(catalogs)
    });

    const catalogState = durableStorageConfigured ? await syncCatalogs(catalogs) : null;
    if (catalogState) {
      await enqueueTasks(plannedTasks, catalogState);
      const taskInventoryReconciliation = await cancelSupersededRunTasks();
      await event("inventory.completed", "info", "Canonical entity/account inventory and task plan persisted.", {
        companies: catalogState.companyByBatchSourceKey.size,
        founders: catalogState.founderByBatchSourceKey.size,
        accounts: catalogState.accountBySourceKey.size,
        ownerAccounts: catalogState.ownerAccountCount,
        retiredOwnerAccounts: catalogState.retiredOwnerAccounts,
        tasks: plannedTasks.length,
        ...taskInventoryReconciliation
      });
    } else {
      await event(
        "inventory.skipped",
        "warning",
        "Durable inventory and task persistence were skipped; collection is using the validated file catalog.",
        { reason: "supabase_not_configured" }
      );
    }

    if (!args.skipNetwork) {
      collectionBudget = createAutonomousCollectionBudget({
        phaseMs: AUTONOMOUS_PROCESS_BUDGETS.collectionPhaseMs
      });
      collectionDrainBudget = createAutonomousCollectionDrainBudget({
        collectionDeadlineAt: collectionBudget.deadlineAt,
        drainHeadroomMs: AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs,
        runnerDeadlineAt: runnerBudget.deadlineAt
      });
    }
    let collectionResults = [];
    let topVoiceRefresh = null;
    if (!args.skipNetwork && args.authenticatedSocialReplay) {
      await event(
        "collection.started",
        "info",
        "Authenticated social historical replay started with bounded platform-specific parallelism.",
        {
          historicalReplay: true,
          instagramWorkers: 2,
          linkedinWorkers: 1,
          linkedinTargetCapPerChunk: LINKEDIN_REPLAY_TARGET_CAP,
          linkedinMaxChunks: LINKEDIN_REPLAY_MAX_CHUNKS,
          linkedinReserveMs: LINKEDIN_REPLAY_RESERVE_MS,
          linkedinDrainHeadroomMs: AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs
        }
      );
      authenticatedSocial = await runAuthenticatedCollectors({ historicalReplay: true });
      await event(
        "collection.finished",
        "info",
        "Authenticated social historical replay reached a terminal state.",
        { results: [], authenticatedSocial, historicalReplay: true }
      );
    } else if (!args.skipNetwork) {
      [collectionResults, topVoiceRefresh] = await runFailFastBranches([
        () => runCollectors(),
        () => resumeTopVoiceRefresh()
      ]);
    }
    assertLeaseHealthy();
    if (!args.skipNetwork && !args.authenticatedSocialReplay) {
      validateAutonomousCollectorMatrix(collectionResults);
    }
    if ((args.skipNetwork || args.authenticatedSocialReplay) && run) {
      await terminalizeQueuedTasks(run.id, "skipped", "network_collection_explicitly_skipped");
    } else if (catalogState) {
      await reconcileCollectorTasks(collectionResults, catalogState);
    }

    // A collector that exhausted retries may still have a fully validated
    // snapshot containing thousands of exact task outcomes and evidence rows.
    // Publish that recovered snapshot; result.ok only describes the process
    // conclusion and must not discard durable collection output.
    const publishableCollectorResults = collectionResults.filter((result) => result.snapshotAvailable);
    const publicSnapshots = (await readAvailableSnapshots(
      publishableCollectorResults.filter((result) => result.kind === "public")
    )).map(withSnapshotBatchProvenance);
    const credentialedDiscoveryFailures = publicSnapshots.flatMap((snapshot) => {
      const credentialed = snapshot?.source?.credentialedDiscovery;
      return [
        ...(Number(credentialed?.x?.errorCount ?? 0) > 0
          ? [`X_RECENT_SEARCH_ERRORS:${credentialed.x.errorCount}`]
          : []),
        ...(Number(credentialed?.exa?.errorCount ?? 0) > 0
          ? [`EXA_SEARCH_ERRORS:${credentialed.exa.errorCount}`]
          : [])
      ];
    });
    const collectionCredentialGaps = args.authenticatedSocialReplay
      ? []
      : [...new Set([
          ...discoveryCredentialGaps,
          ...credentialedDiscoveryFailures
        ])];
    const githubSnapshots = await readAvailableSnapshots(
      publishableCollectorResults.filter((result) => result.kind === "github")
    );
    const collectionCoverage = await summarizeCollectionCoverage(
      plannedTasks,
      collectionResults,
      { skipNetwork: args.skipNetwork || args.authenticatedSocialReplay }
    );
    const terminalFailureBudget = autonomousMappedTerminalFailureBudget(
      collectionCoverage.mappedExpected
    );
    latestCollectionCoverage = collectionCoverage;
    latestTerminalFailureBudget = terminalFailureBudget;
    if (args.authenticatedSocialReplay) {
      assertAuthenticatedReplayCanPublish(authenticatedSocial);
    } else {
      assertSuccessfulCollection(collectionResults, collectionCoverage);
    }
    await recordCollectionCoverage(collectionCoverage, terminalFailureBudget);
    validateMappedAutonomousCoverage(collectionCoverage, {
      maxTerminalFailures: args.skipPublish
        ? Number.POSITIVE_INFINITY
        : terminalFailureBudget
    });
    if (!args.authenticatedSocialReplay) {
      assertSuccessfulTopVoiceRefresh(topVoiceRefresh);
    }
    const publicationRunId = run?.id ?? `file:${idempotencyKey}`;
    if (!args.skipPublish) await synchronizePublicationBase();
    const publicationBaseline = await readPublicationEvidenceBaseline();
    const sourceDeltaHistory = await readJson(publishedSourceDeltaHistoryPath, []);
    const loggedInEvidenceSnapshots = await readLoggedInEvidenceSnapshots();
    const publicationInputs = {
      publicSnapshots,
      githubSnapshots,
      loggedInEvidenceSnapshots,
      publicResults: publishableCollectorResults.filter((result) => result.kind === "public"),
      topVoiceRefresh,
      catalogState,
      collectionCoverage,
      credentialGaps: collectionCredentialGaps
    };
    publicationInputs.loggedInEvidenceSnapshot = await prepareMergedLoggedInEvidenceSnapshot(
      loggedInEvidenceSnapshots
    );
    await writeJsonAtomic(
      join(publicationArtifactRoot(), "src/lib/social/logged-in-evidence-current.json"),
      publicationInputs.loggedInEvidenceSnapshot
    );
    // One sanitized publication plan is computed after synchronizing the base.
    // This exact plan drives both durable persistence and the file publication,
    // so raw collector rows can never reach Supabase ahead of semantic merge.
    publicationInputs.sanitizedTargetedSnapshot = await prepareSanitizedTargetedSnapshot(topVoiceRefresh);
    const contentIdentityReferenceRows = await readCanonicalContentIdentityReferenceRows(
      publicationInputs.sanitizedTargetedSnapshot
    );
    publicationInputs.loggedInAttributionReconciliationLedger =
      await readCanonicalLoggedInAttributionReconciliationLedger();
    publicationInputs.seededAttributionReconciliationLedger =
      await readCanonicalSeededAttributionReconciliationLedger();
    publicationInputs.sanitizedPublicSnapshot = await prepareSanitizedPublicSnapshot(
      publicSnapshots,
      { contentIdentityReferenceRows }
    );
    const losslessPublicArchive = await openLosslessPostArchive(losslessPublicArchiveRoot);
    const losslessArchiveReceipt = publicationInputs.sanitizedPublicSnapshot
      ? await archiveAcceptedPublicSnapshot({
          archive: losslessPublicArchive,
          snapshot: publicationInputs.sanitizedPublicSnapshot,
          checkpointScope: `autonomous-public-ingestion:${idempotencyKey}`
        })
      : { archived: 0, skippedWithoutNativeId: 0, checkpointsAdvanced: 0 };
    await event(
      "evidence.lossless_archive_completed",
      "info",
      "Accepted native public posts were written to the lossless archive before its checkpoints advanced.",
      { archiveRoot: losslessPublicArchiveRoot, ...losslessArchiveReceipt }
    );
    const sanitizedEvidenceSnapshots = [
      publicationInputs.sanitizedPublicSnapshot,
      publicationInputs.sanitizedTargetedSnapshot,
      publicationInputs.loggedInEvidenceSnapshot
    ].filter(Boolean);
    const durableImport = await importDurableEvidence({
      publicSnapshots: sanitizedEvidenceSnapshots,
      githubSnapshots,
      catalogState,
      attributionReconciliationLedger: combineAttributionReconciliationLedgers(
        publicationInputs.sanitizedPublicSnapshot?.attributionReconciliationLedger,
        publicationInputs.sanitizedTargetedSnapshot?.attributionReconciliationLedger,
        publicationInputs.loggedInAttributionReconciliationLedger,
        publicationInputs.seededAttributionReconciliationLedger
      )
    });
    assertDurableAttributionCompleteness(durableImport);
    if (durableImport.status === "completed") {
      await event(
        "evidence.imported",
        "info",
        "Collected evidence was validated and imported into durable storage.",
        durableImport
      );
    } else {
      await event(
        "evidence.import_skipped",
        "warning",
        "Durable evidence import was skipped; collected snapshots remain file-backed.",
        durableImport
      );
    }
    assertLeaseHealthy();

    const prePublishCoverage = catalogState
      ? await persistCoverage(catalogState, durableImport)
      : { ...collectionCoverage, stageCounters: durableImport };
    validateAutonomousTerminalCoverage(prePublishCoverage, {
      expectedTaskCount: plannedTasks.length
    });

    assertLeaseHealthy();
    // Publication state must be read only after base synchronization. Reading it before
    // synchronizePublicationBase() can overwrite evidence or discovery rows
    // that another completed ingestion pushed while these collectors ran.
    await mergePublicationInputs(publicationInputs);
    publicationInputs.sourceDelta = {
      ...summarizeIngestionSourceDelta({
        idempotencyKey,
        beforeSnapshots: publicationBaseline,
        afterSnapshots: await readPublicationEvidenceBaseline(),
        previousHistory: sourceDeltaHistory,
        mappedFailures: collectionCoverage.mappedFailed,
        collectionCoverage,
        credentialGaps: collectionCredentialGaps
      }),
      ...publicationCandidateReceiptFields(),
      ...(args.authenticatedSocialReplay
        ? { authenticatedSocialReplay: authenticatedSocial?.linkedinReplay ?? null }
        : {}),
      mappedExpected: collectionCoverage.mappedExpected,
      mappedNonTerminal: collectionCoverage.mappedNonTerminal,
      terminalFailureBudget: terminalFailureBudget
    };
    await writeSourceDeltaReceipt(publicationInputs.sourceDelta, sourceDeltaHistory);

    let publicationReceipt = { status: "skipped", publishedCommit: null, receiptSha256: null };
    if (!args.skipPublish) {
      // Freeze the exact invalidation set represented by this build. Admin
      // edits that arrive after this claim remain pending for the next build
      // instead of being incorrectly consumed by the publication below.
      const timelineInvalidationClaim = await claimTimelineArtifactInvalidationsForBuild();
      await buildAndValidatePublication(publicationRunId, catalogState);
      publicationReceipt = await publishRepositoryArtifacts(publicationRunId, publicationInputs);
      latestPublishedCommit = publicationReceipt.publishedCommit ?? null;
      if (run) {
        await persistArtifactManifest(run.id, publicationReceipt);
      } else {
        await event(
          "artifact_manifest.persistence_skipped",
          "warning",
          "Published artifact manifest passed file validation but durable manifest persistence was skipped.",
          {
            reason: "supabase_not_configured",
            publicationRunId,
            publishedCommit: publicationReceipt.publishedCommit
          }
        );
      }
      await completePublishedTimelineInvalidations(
        publicationReceipt,
        timelineInvalidationClaim,
        latestTimelineBuildReceipt
      );
    }

    if (!args.skipPublish && publicationInputs.sourceDelta.dailySourceHealth === "stale_day") {
      await event(
        "publication.daily_source_stale",
        "warning",
        "Both Central ingestion slots completed without a new physical source; the verified publication remains successful.",
        publicationInputs.sourceDelta
      );
      console.warn(
        `Daily source freshness warning for ${publicationInputs.sourceDelta.centralDay}: ` +
        "both Central slots found zero new physical sources after verified publication."
      );
    }

    const finalCoverage = catalogState
      ? await persistCoverage(catalogState, durableImport)
      : prePublishCoverage;
    successfulRunnerOutcomeCandidate = {
      status: "refreshed",
      publicationStatus: publicationReceipt.status,
      collectionHealth: publicationInputs.sourceDelta.collectionHealth,
      collectionHealthReasons: publicationInputs.sourceDelta.collectionHealthReasons,
      providerBlocked: publicationInputs.sourceDelta.providerBlocked,
      providerBlockedByReason: publicationInputs.sourceDelta.providerBlockedByReason,
      mappedProviderBlocked: publicationInputs.sourceDelta.mappedProviderBlocked,
      mappedProviderBlockedByReason: publicationInputs.sourceDelta.mappedProviderBlockedByReason,
      mappedScopeUnsupported: publicationInputs.sourceDelta.mappedScopeUnsupported,
      mappedExpected: publicationInputs.sourceDelta.mappedExpected,
      mappedFailed: publicationInputs.sourceDelta.mappedFailures,
      mappedNonTerminal: publicationInputs.sourceDelta.mappedNonTerminal,
      terminalFailureBudget: publicationInputs.sourceDelta.terminalFailureBudget,
      newPhysicalSources: publicationInputs.sourceDelta.newPhysicalSources,
      dailyNewPhysicalSources: publicationInputs.sourceDelta.dailyNewPhysicalSources,
      dailySourceHealth: publicationInputs.sourceDelta.dailySourceHealth,
      ...(args.authenticatedSocialReplay
        ? { authenticatedSocialReplay: publicationInputs.sourceDelta.authenticatedSocialReplay }
        : {}),
      publishedCommit: publicationReceipt.publishedCommit,
      publicationReceiptSha256: publicationReceipt.receiptSha256
    };
    await stopHeartbeatAndDrain();
    assertLeaseHealthy();
    if (run) {
      const completionStats = bindCompletionProvenance({
        ...finalCoverage,
        stageCounters: durableImport,
        finishedAt: new Date().toISOString()
      }, {
        publicationStatus: publicationReceipt.status,
        publishedCommit: publicationReceipt.publishedCommit,
        receipt: publicationInputs.sourceDelta
      });
      await completeRun("completed", completionStats);
      await event(
        "run.completed",
        "info",
        "Autonomous ingestion completed with every task terminal.",
        finalCoverage
      ).catch((error) => {
        console.warn(
          `Completed-run telemetry was not persisted and did not change the durable outcome: ` +
          sanitizeRunnerDiagnosticText(errorMessage(error))
        );
      });
    } else {
      await event(
        "run.completed",
        "info",
        "File-backed autonomous ingestion completed; durable database completion was not recorded.",
        { ...finalCoverage, topVoiceRefresh }
      );
    }
    console.log(JSON.stringify({
      runId: run?.id ?? null,
      publicationRunId: run?.id ?? `file:${idempotencyKey}`,
      status: "completed",
      coverage: finalCoverage,
      durableImport,
      sourceDelta: publicationInputs.sourceDelta,
      authenticatedSocial,
      publicationReceipt,
      topVoiceRefresh
    }, null, 2));
    pendingRunnerOutcome = successfulRunnerOutcomeCandidate;
  }
} catch (error) {
  await stopHeartbeatAndDrain();
  await terminateActiveChildProcesses();
  if (terminationSignal) {
    hardFailure ??= error;
    const message = cancellationMessage(terminationSignal);
    console.error(sanitizeRunnerDiagnosticText(message));
    pendingRunnerOutcome = canceledRunnerOutcome(terminationSignal);
    process.exitCode = signalExitCode(terminationSignal);
  } else {
    hardFailure = error;
    const failure = sanitizedRunnerFailure(error);
    console.error(failure.message);
    pendingRunnerOutcome = failedRunnerOutcome(failure.message);
    if (run?.id) {
      await event("run.failed", "error", failure.message, { stack: failure.stack }).catch(() => {});
      await completeRun("failed", {
        error: failure.message,
        stack: failure.stack,
        failedAt: new Date().toISOString()
      }).catch(() => {});
    }
    process.exitCode = 1;
  }
} finally {
  await stopHeartbeatAndDrain();
  await terminateActiveChildProcesses();
  if (terminationSignal) {
    await waitForRunFinalization();
    if (completedFinalizationWon()) {
      hardFailure = null;
      pendingRunnerOutcome = successfulRunnerOutcomeCandidate ?? pendingRunnerOutcome;
      process.exitCode = 0;
    } else {
      await resolveAmbiguousPublicationAfterCancellation();
      pendingRunnerOutcome = canceledRunnerOutcome(terminationSignal);
      await writeRunnerOutcomeOnce(pendingRunnerOutcome).catch((error) => {
        const failure = sanitizedRunnerFailure(error);
        console.error(`Failed to write canceled autonomous runner outcome: ${failure.message}`);
      });
      await recordCanceledRun(terminationSignal).catch((error) => {
        const failure = sanitizedRunnerFailure(error);
        console.error(`Failed to record canceled ingestion run: ${failure.message}`);
      });
    }
  }
  if (runtimeLock) {
    try {
      await releaseRuntimeLockOnce();
    } catch (error) {
      const failure = sanitizedRunnerFailure(error);
      console.error(`Failed to release ingestion lease: ${failure.message}`);
      if (!hardFailure) {
        hardFailure = error;
        pendingRunnerOutcome = failedRunnerOutcome(
          `Failed to release ingestion lease: ${failure.message}`
        );
        if (run?.id) {
          await event(
            "run.cleanup_failed",
            "error",
            "Autonomous ingestion completed its main work but failed to release the runtime lock.",
            { error: failure.message, stack: failure.stack, publishedCommit: latestPublishedCommit }
          ).catch(() => {});
        }
        process.exitCode = 1;
      }
    }
  }
  await cleanupPublicationWorktree().catch((error) => {
    const failure = sanitizedRunnerFailure(error);
    console.error(`Failed to clean publication worktree: ${failure.message}`);
    if (!hardFailure) {
      hardFailure = error;
      pendingRunnerOutcome = failedRunnerOutcome(
        `Failed to clean publication worktree: ${failure.message}`
      );
      process.exitCode = 1;
    }
  });
  await finalizePublicationSignalAdoptionWindow();
  if (pendingRunnerOutcome) {
    await writeRunnerOutcomeOnce(pendingRunnerOutcome).catch((error) => {
      const failure = sanitizedRunnerFailure(error);
      console.error(`Failed to write autonomous runner outcome: ${failure.message}`);
      process.exitCode = 1;
    });
  }
  clearCancellationDeadline();
}

function installTerminationSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (terminationSignal) {
        signalActiveChildProcesses("SIGKILL");
        beginEmergencyCancellationCleanup();
        return;
      }
      terminationSignal = signal;
      hardFailure ??= new Error(cancellationMessage(signal));
      pendingRunnerOutcome = canceledRunnerOutcome(signal);
      process.exitCode = signalExitCode(signal);
      stopHeartbeatScheduling();
      signalActiveChildProcesses("SIGTERM");
      void beginPublicationCancellationResolution();
      scheduleCancellationDeadline();
    });
  }
}

function scheduleCancellationDeadline() {
  if (cancellationDeadlineTimer || !terminationSignal) return;
  cancellationDeadlineTimer = setTimeout(
    beginEmergencyCancellationCleanup,
    CANCELLATION_CLEANUP_TIMEOUT_MS
  );
}

function beginEmergencyCancellationCleanup() {
  if (cancellationEmergencyPromise || !terminationSignal) return cancellationEmergencyPromise;
  stopHeartbeatScheduling();
  heartbeatAbortController?.abort(new Error("Emergency cancellation cleanup started."));
  signalActiveChildProcesses("SIGKILL");
  cancellationEmergencyTimer = setTimeout(
    () => process.exit(effectiveTerminationExitCode()),
    CANCELLATION_EMERGENCY_TIMEOUT_MS
  );
  cancellationEmergencyPromise = emergencyCancellationCleanup().finally(() => {
    if (cancellationEmergencyTimer) clearTimeout(cancellationEmergencyTimer);
    process.exit(effectiveTerminationExitCode());
  });
  return cancellationEmergencyPromise;
}

async function emergencyCancellationCleanup() {
  // Terminate children and release durable ownership before waiting on a
  // transport that may ignore AbortSignal. The heartbeat was already stopped
  // and aborted by beginEmergencyCancellationCleanup (or immediately below for
  // direct fixture calls), so any late renewal is fenced by the exact lease
  // token and cannot recreate a released row.
  stopHeartbeatScheduling();
  heartbeatAbortController?.abort(new Error("Emergency cancellation cleanup started."));
  await terminateActiveChildProcesses();
  await cleanupPublicationWorktree().catch(() => {});
  await waitForRunFinalization();
  if (completedFinalizationWon()) {
    hardFailure = null;
    pendingRunnerOutcome = successfulRunnerOutcomeCandidate ?? pendingRunnerOutcome;
    process.exitCode = 0;
  } else {
    await resolveAmbiguousPublicationAfterCancellation();
    pendingRunnerOutcome = canceledRunnerOutcome(terminationSignal);
    try {
      await recordCanceledRun(terminationSignal);
    } catch (error) {
      const failure = sanitizedRunnerFailure(error);
      hardFailure = error;
      pendingRunnerOutcome = failedRunnerOutcome(
        `Failed to record canceled ingestion run: ${failure.message}`
      );
      process.exitCode = 1;
    }
  }
  try {
    await releaseRuntimeLockOnce();
  } catch (error) {
    const failure = sanitizedRunnerFailure(error);
    hardFailure = error;
    pendingRunnerOutcome = failedRunnerOutcome(
      `Failed to release ingestion lease: ${failure.message}`
    );
    process.exitCode = 1;
  }
  try {
    await writeRunnerOutcomeOnce(pendingRunnerOutcome);
  } catch (error) {
    const failure = sanitizedRunnerFailure(error);
    console.error(`Failed to write emergency autonomous runner outcome: ${failure.message}`);
    process.exitCode = 1;
  }
  await stopHeartbeatAndDrain();
}

function clearCancellationDeadline() {
  if (cancellationDeadlineTimer) clearTimeout(cancellationDeadlineTimer);
  if (cancellationEmergencyTimer) clearTimeout(cancellationEmergencyTimer);
  cancellationDeadlineTimer = null;
  cancellationEmergencyTimer = null;
}

function effectiveTerminationExitCode() {
  if (completedFinalizationWon() && !hardFailure && process.exitCode !== 1) return 0;
  if (process.exitCode === 1) return 1;
  return signalExitCode(terminationSignal);
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function cancellationMessage(signal) {
  return `Autonomous ingestion canceled by ${signal ?? "termination signal"}.`;
}

async function waitForRunFinalization() {
  if (runFinalizationPromise) await runFinalizationPromise.catch(() => {});
  return finalizedRunStatus;
}

function completedFinalizationWon() {
  return completedOutcomeVerifiedByThisExecution && (
    finalizedRunStatus === "completed" ||
    successfulRunnerOutcomeCandidate?.status === "already_completed"
  );
}

function canceledRunnerOutcome(signal) {
  return {
    status: "canceled",
    failureMessage: cancellationMessage(signal),
    providerBlocked: latestCollectionCoverage?.providerBlocked,
    providerBlockedByReason: latestCollectionCoverage?.providerBlockedByReason,
    mappedProviderBlocked: latestCollectionCoverage?.mappedProviderBlocked,
    mappedProviderBlockedByReason: latestCollectionCoverage?.mappedProviderBlockedByReason,
    mappedScopeUnsupported: latestCollectionCoverage?.mappedScopeUnsupported,
    mappedExpected: latestCollectionCoverage?.mappedExpected,
    mappedFailed: latestCollectionCoverage?.mappedFailed,
    mappedNonTerminal: latestCollectionCoverage?.mappedNonTerminal,
    terminalFailureBudget: latestTerminalFailureBudget,
    publishedCommit: latestPublishedCommit
  };
}

async function recordCanceledRun(signal) {
  if (canceledRunRecordPromise) return canceledRunRecordPromise;
  if (!run?.id || completedFinalizationWon()) return finalizedRunStatus;
  const message = cancellationMessage(signal);
  canceledRunRecordPromise = (async () => {
    const finalStatus = await completeRun("canceled", {
      error: message,
      signal,
      canceledAt: new Date().toISOString(),
      publishedCommit: latestPublishedCommit
    });
    if (finalStatus !== "canceled") return finalStatus;
    await event("run.canceled", "warning", message, {
      signal,
      canceledAt: new Date().toISOString(),
      publishedCommit: latestPublishedCommit
    }).catch(() => {});
    return finalStatus;
  })();
  return canceledRunRecordPromise;
}

function trackChildProcess(child, { ledgerPath = null, ledgerRunId = null } = {}) {
  child[CHILD_DESCENDANT_PIDS] = new Set();
  child[CHILD_ROOT_START_IDENTITY] = processStartIdentity(child.pid);
  child[CHILD_PROCESS_LEDGER] = {
    path: ledgerPath,
    runId: ledgerRunId,
    identities: new Map()
  };
  child[CHILD_TREE_DRAIN_PROMISE] = new Promise((resolveDrain) => {
    child[CHILD_TREE_DRAIN_RESOLVE] = resolveDrain;
  });
  activeChildProcesses.add(child);
  if (process.platform !== "win32") {
    child[CHILD_DESCENDANT_SAMPLER] = setInterval(
      () => rememberProcessDescendants(child),
      PROCESS_DESCENDANT_SAMPLE_MS
    );
    child[CHILD_DESCENDANT_SAMPLER].unref?.();
  }
  return child;
}

function disposeTrackedChildProcess(child, reason = null) {
  if (!child) return;
  const hardSettle = child[CHILD_HARD_SETTLE];
  const descendantSampler = child[CHILD_DESCENDANT_SAMPLER];
  if (descendantSampler) clearInterval(descendantSampler);
  rememberLedgerDescendants(child);
  delete child[CHILD_HARD_SETTLE];
  delete child[CHILD_DESCENDANT_SAMPLER];
  delete child[CHILD_ROOT_START_IDENTITY];
  delete child[CHILD_DESCENDANT_PIDS];
  const ledger = child[CHILD_PROCESS_LEDGER];
  delete child[CHILD_PROCESS_LEDGER];
  if (reason && typeof hardSettle === "function") hardSettle(reason);
  activeChildProcesses.delete(child);
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream || stream.destroyed) continue;
    try {
      stream.destroy();
    } catch {}
  }
  try {
    child.unref?.();
  } catch {}
  child[CHILD_TREE_DRAIN_RESOLVE]?.();
  delete child[CHILD_TREE_DRAIN_RESOLVE];
  delete child[CHILD_TREE_DRAIN_PROMISE];
  if (ledger?.path) void unlink(ledger.path).catch(() => {});
}

function signalChildProcessGroup(child, signal, readStartIdentity = processStartIdentity) {
  if (!child || !activeChildProcesses.has(child)) return;
  if (process.platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    const expectedStartIdentity = child[CHILD_ROOT_START_IDENTITY];
    if (!expectedStartIdentity || readStartIdentity(child.pid) !== expectedStartIdentity) return;
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {}
}

function snapshotProcessDescendants(rootPid) {
  if (process.platform === "win32" || !Number.isInteger(rootPid) || rootPid <= 0) return [];
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 1_000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0 || result.error) return [];
  const childrenByParent = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants = [];
  const visit = (parentPid, depth) => {
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      descendants.push({ pid, depth });
      visit(pid, depth + 1);
    }
  };
  visit(rootPid, 1);
  return descendants.sort((left, right) => right.depth - left.depth || right.pid - left.pid);
}

function rememberProcessDescendants(child) {
  const remembered = child?.[CHILD_DESCENDANT_PIDS];
  if (!(remembered instanceof Set)) return [];
  const descendants = snapshotProcessDescendants(child.pid);
  for (const { pid } of descendants) remembered.add(pid);
  return descendants;
}

function linuxProcessStartIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    // Fields after the command name begin at proc(5) field 3. starttime is
    // field 22, therefore index 19 in this suffix.
    const startTicks = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(startTicks ?? "")
      ? `linux-proc-start:${startTicks}`
      : null;
  } catch {
    return null;
  }
}

function portableProcessStartIdentity(pid) {
  if (process.platform === "win32") return null;
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 500,
    stdio: ["ignore", "pipe", "ignore"],
    env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" }
  });
  if (result.status !== 0 || result.error) return null;
  const startedAt = result.stdout.trim().replace(/\s+/g, " ");
  return startedAt ? `ps-lstart:${startedAt}` : null;
}

function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return linuxProcessStartIdentity(pid) ?? portableProcessStartIdentity(pid);
}

function snapshotProcessStartIdentities(pids) {
  const requested = new Set(
    [...pids]
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .slice(0, CHILD_PROCESS_LEDGER_MAX_ENTRIES)
  );
  const identities = new Map();
  for (const pid of requested) {
    const identity = linuxProcessStartIdentity(pid);
    if (identity) identities.set(pid, identity);
  }
  const unresolved = new Set([...requested].filter((pid) => !identities.has(pid)));
  if (process.platform === "win32" || unresolved.size === 0) return identities;
  const result = spawnSync("/bin/ps", ["-axo", "pid=,lstart="], {
    encoding: "utf8",
    timeout: 500,
    stdio: ["ignore", "pipe", "ignore"],
    env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" }
  });
  if (result.status !== 0 || result.error) return identities;
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!unresolved.has(pid)) continue;
    const startedAt = match[2].trim().replace(/\s+/g, " ");
    if (startedAt) identities.set(pid, `ps-lstart:${startedAt}`);
  }
  return identities;
}

function rememberLedgerDescendants(child) {
  const remembered = child?.[CHILD_DESCENDANT_PIDS];
  const ledger = child?.[CHILD_PROCESS_LEDGER];
  if (!(remembered instanceof Set) || !ledger?.path || !ledger.runId) return [];
  let source = "";
  try {
    source = readFileSync(ledger.path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not read child-process ledger: ${sanitizeRunnerDiagnosticText(errorMessage(error))}`);
    }
    return [];
  }
  const recordedIdentities = new Map();
  for (const line of source.split("\n")) {
    const [runId, rawPid, startIdentity, ...unexpected] = line.trim().split("\t");
    const pid = Number(rawPid);
    if (
      runId !== ledger.runId ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      pid === process.pid ||
      !startIdentity ||
      unexpected.length > 0
    ) continue;
    if (
      !recordedIdentities.has(pid) &&
      recordedIdentities.size >= CHILD_PROCESS_LEDGER_MAX_ENTRIES
    ) continue;
    const identities = recordedIdentities.get(pid) ?? new Set();
    identities.add(startIdentity);
    recordedIdentities.set(pid, identities);
  }
  const validEntries = [];
  const validIdentities = new Map();
  const observedIdentities = snapshotProcessStartIdentities(recordedIdentities.keys());
  for (const [pid, identities] of recordedIdentities) {
    const observedIdentity = observedIdentities.get(pid);
    if (!observedIdentity || !identities.has(observedIdentity)) continue;
    remembered.add(pid);
    validIdentities.set(pid, observedIdentity);
    validEntries.push({ pid, startIdentity: observedIdentity });
  }
  // Drop exited and identity-mismatched entries from the in-memory recovery
  // index. The append-only file may still be written by live descendants, so
  // rewriting it here would create a lost-update race.
  ledger.identities = validIdentities;
  return validEntries;
}

function processHasChildLedgerMarker(pid, ledgerPath) {
  if (process.platform === "win32" || !ledgerPath || !Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 1_000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.includes(`RETURNER_CHILD_PROCESS_LEDGER=${ledgerPath}`);
}

function signalPid(pid, signal, expectedStartIdentity = null, readStartIdentity = processStartIdentity) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (expectedStartIdentity) {
    const observedStartIdentity = readStartIdentity(pid);
    if (observedStartIdentity !== expectedStartIdentity) return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.warn(`Could not signal descendant ${pid}: ${sanitizeRunnerDiagnosticText(errorMessage(error))}`);
    }
    return error?.code !== "ESRCH";
  }
}

function isNodeExecutable(command) {
  const normalized = resolve(String(command));
  return normalized === resolve(process.execPath) || /^node(?:\.exe)?$/i.test(basename(String(command)));
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGroupExists(groupId) {
  if (process.platform === "win32" || !Number.isInteger(groupId) || groupId <= 0) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function trackedDescendantsRemain(child) {
  const ledgerIdentities = new Map(
    rememberLedgerDescendants(child).map(({ pid, startIdentity }) => [pid, startIdentity])
  );
  const ledgerPath = child?.[CHILD_PROCESS_LEDGER]?.path;
  return processGroupExists(child?.pid) || [...(child?.[CHILD_DESCENDANT_PIDS] ?? [])].some((pid) =>
    processExists(pid) && (
      ledgerIdentities.has(pid) ||
      processHasChildLedgerMarker(pid, ledgerPath) ||
      snapshotProcessDescendants(child?.pid).some((entry) => entry.pid === pid)
    )
  );
}

async function drainChildProcessTreeAfterRootClose(child) {
  rememberProcessDescendants(child);
  rememberLedgerDescendants(child);
  if (!trackedDescendantsRemain(child)) return;
  signalChildProcessTree(child, "SIGTERM");
  const deadline = Date.now() + PROCESS_NORMAL_EXIT_DRAIN_MS;
  while (trackedDescendantsRemain(child) && Date.now() < deadline) {
    await delay(25);
  }
  if (!trackedDescendantsRemain(child)) return;
  signalChildProcessTree(child, "SIGKILL");
  const killDeadline = Date.now() + PROCESS_KILL_WATCHDOG_MS;
  while (trackedDescendantsRemain(child) && Date.now() < killDeadline) {
    await delay(25);
  }
  if (trackedDescendantsRemain(child)) {
    throw new Error("A subprocess descendant survived normal root-process exit cleanup.");
  }
}

function signalChildProcessTree(child, signal, { readStartIdentity = processStartIdentity } = {}) {
  if (!child || !activeChildProcesses.has(child)) return;
  // Snapshot descendants while the root still owns them. This catches a child
  // that created a fresh process group; after the root is reaped that process
  // would be reparented and no longer discoverable from the original PID.
  const descendants = rememberProcessDescendants(child);
  const descendantPids = new Set(descendants.map(({ pid }) => pid));
  const ledgerIdentities = new Map(
    rememberLedgerDescendants(child).map(({ pid, startIdentity }) => [pid, startIdentity])
  );
  for (const { pid } of descendants) {
    const expectedStartIdentity = readStartIdentity(pid);
    if (expectedStartIdentity) signalPid(pid, signal, expectedStartIdentity, readStartIdentity);
  }
  const ledgerPath = child[CHILD_PROCESS_LEDGER]?.path;
  for (const pid of child[CHILD_DESCENDANT_PIDS] ?? []) {
    if (descendantPids.has(pid)) continue;
    const expectedStartIdentity = ledgerIdentities.get(pid);
    if (expectedStartIdentity) {
      // Re-read the live start identity immediately before every kill(2). If
      // the PID exited or was reused after the ledger snapshot, fail closed and
      // prune it from the in-memory recovery index.
      if (readStartIdentity(pid) !== expectedStartIdentity) {
        child[CHILD_DESCENDANT_PIDS]?.delete(pid);
        child[CHILD_PROCESS_LEDGER]?.identities?.delete(pid);
        continue;
      }
      if (!signalPid(pid, signal, expectedStartIdentity, readStartIdentity)) {
        child[CHILD_DESCENDANT_PIDS]?.delete(pid);
        child[CHILD_PROCESS_LEDGER]?.identities?.delete(pid);
      }
      continue;
    }
    if (processHasChildLedgerMarker(pid, ledgerPath)) {
      const expectedStartIdentity = readStartIdentity(pid);
      if (expectedStartIdentity) signalPid(pid, signal, expectedStartIdentity, readStartIdentity);
    }
  }
  signalChildProcessGroup(child, signal, readStartIdentity);
  if (Number.isInteger(child.pid) && child.pid > 0 && child[CHILD_ROOT_START_IDENTITY]) {
    signalPid(child.pid, signal, child[CHILD_ROOT_START_IDENTITY], readStartIdentity);
  }
}

function signalActiveChildProcesses(signal) {
  for (const child of [...activeChildProcesses]) signalChildProcessTree(child, signal);
}

function waitForTrackedChildClose(child) {
  if (!activeChildProcesses.has(child)) return Promise.resolve();
  return child[CHILD_TREE_DRAIN_PROMISE] ?? Promise.resolve();
}

async function waitForTrackedChildren(children, timeoutMs) {
  if (!children.length) return true;
  let completed = false;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void Promise.all(children.map(waitForTrackedChildClose)).then(() => {
      completed = true;
      clearTimeout(timer);
      resolve();
    });
  });
  return completed;
}

async function terminateActiveChildProcesses() {
  let children = [...activeChildProcesses];
  if (!children.length) return;
  signalActiveChildProcesses("SIGTERM");
  await waitForTrackedChildren(children, AUTONOMOUS_PROCESS_BUDGETS.processKillGraceMs);
  children = [...activeChildProcesses];
  if (!children.length) return;
  signalActiveChildProcesses("SIGKILL");
  await waitForTrackedChildren(
    children,
    PROCESS_KILL_WATCHDOG_MS
  );
  for (const child of children) {
    if (activeChildProcesses.has(child)) {
      disposeTrackedChildProcess(
        child,
        new Error("Tracked subprocess did not close after SIGTERM and SIGKILL cleanup.")
      );
    }
  }
}

async function writeRunnerOutcomeOnce(outcome) {
  if (runnerOutcomeWritePromise) return runnerOutcomeWritePromise;
  const writePromise = writeRunnerOutcome(outcome);
  runnerOutcomeWritePromise = writePromise;
  try {
    return await writePromise;
  } catch (error) {
    if (runnerOutcomeWritePromise === writePromise) runnerOutcomeWritePromise = null;
    throw error;
  }
}

function lifecycleTimeoutMs(requestedMs = LIFECYCLE_OPERATION_TIMEOUT_MS) {
  return lifecycleOperationTimeoutOverrideMs ?? requestedMs;
}

async function withLifecycleDeadline(label, operation, {
  timeoutMs = LIFECYCLE_OPERATION_TIMEOUT_MS,
  signal: externalSignal = null,
  cleanup = false
} = {}) {
  const requestedTimeoutMs = lifecycleTimeoutMs(timeoutMs);
  const effectiveTimeoutMs = cleanup || !runnerBudget
    ? requestedTimeoutMs
    : runnerBudget.timeoutMs(requestedTimeoutMs, label);
  const controller = new AbortController();
  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason ?? new Error(`${label} was canceled.`));
  };
  if (externalSignal?.aborted) abortFromExternalSignal();
  else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  let timer = null;
  const operationPromise = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason;
    return operation(controller.signal);
  });
  // The timeout can win before an underlying client notices abort. Keep a
  // rejection observer attached so late transport settlement is always handled.
  operationPromise.catch(() => {});
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = Object.assign(
        new Error(`${label} timed out after ${effectiveTimeoutMs}ms.`),
        {
          name: "LifecycleOperationTimeoutError",
          code: "LIFECYCLE_OPERATION_TIMEOUT"
        }
      );
      controller.abort(timeoutError);
      reject(timeoutError);
    }, effectiveTimeoutMs);
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

async function runSupabaseOperation(label, createOperation, options = {}) {
  return withLifecycleDeadline(label, (signal) => {
    const operation = createOperation(signal);
    return typeof operation?.abortSignal === "function"
      ? operation.abortSignal(signal)
      : operation;
  }, options);
}

function createAbortBoundSupabaseClient(client, signal) {
  const seen = new WeakMap();
  const wrap = (value) => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
    if (seen.has(value)) return seen.get(value);
    const proxy = new Proxy(value, {
      get(target, property) {
        if (property === "then" && typeof target.then === "function") {
          return (onFulfilled, onRejected) => {
            const bound = typeof target.abortSignal === "function"
              ? target.abortSignal(signal)
              : target;
            return Promise.resolve(bound).then(onFulfilled, onRejected);
          };
        }
        const member = Reflect.get(target, property, target);
        if (typeof member === "function") {
          return (...callArgs) => wrap(Reflect.apply(member, target, callArgs));
        }
        return wrap(member);
      }
    });
    seen.set(value, proxy);
    return proxy;
  };
  return wrap(client);
}

async function claimRuntimeLock() {
  let claimFailure = null;
  try {
    const { data, error } = await runSupabaseOperation(
      "claim ingestion runtime lock",
      () => supabase.rpc("claim_ingestion_runtime_lock", {
        p_lock_key: "autonomous-ingestion",
        p_owner_id: workerId,
        p_lease_duration: "20 minutes",
        p_metadata_json: {
          idempotencyKey,
          startedAt: runStartedAt.toISOString(),
          executionCompletionNonce
        }
      })
    );
    check(error, "claim runtime lock");
    return Array.isArray(data) ? data[0] ?? null : data;
  } catch (error) {
    claimFailure = error;
  }

  try {
    const reconciled = await reconcileAmbiguousRuntimeLockClaim();
    if (reconciled) return reconciled;
  } catch (reconciliationError) {
    throw new Error(
      `${errorMessage(claimFailure)} Runtime-lock claim read-back failed: ` +
      errorMessage(reconciliationError),
      { cause: claimFailure }
    );
  }
  throw claimFailure;
}

async function reconcileAmbiguousRuntimeLockClaim() {
  const { data, error } = await runSupabaseOperation(
    "reconcile ambiguous ingestion runtime lock claim",
    () => supabase
      .from("ingestion_runtime_locks")
      .select("lock_key,owner_id,lease_token,lease_expires_at,metadata_json")
      .eq("lock_key", "autonomous-ingestion")
      .maybeSingle(),
    { cleanup: true }
  );
  check(error, "reconcile ambiguous runtime lock claim");
  if (!data) return null;
  const metadata = data.metadata_json;
  const leaseExpiresAt = Date.parse(data.lease_expires_at ?? "");
  const exactOwner = data.owner_id === workerId &&
    typeof data.lease_token === "string" &&
    data.lease_token.length > 0;
  const exactExecution = metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.idempotencyKey === idempotencyKey &&
    metadata.executionCompletionNonce === executionCompletionNonce &&
    metadata.startedAt === runStartedAt.toISOString();
  if (!exactOwner || !exactExecution || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()) {
    return null;
  }
  return data;
}

async function releaseRuntimeLock(lock = runtimeLock) {
  if (!lock) return;
  let lastFailure = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { data, error } = await runSupabaseOperation(
        `release ingestion runtime lock (attempt ${attempt})`,
        () => supabase.rpc("release_ingestion_runtime_lock", {
          p_lock_key: lock.lock_key,
          p_owner_id: workerId,
          p_lease_token: lock.lease_token
        }),
        { cleanup: true }
      );
      check(error, "release runtime lock");
      if (data === true) return;
      lastFailure = new Error("The runtime-lock release RPC did not confirm deletion.");
    } catch (error) {
      lastFailure = error;
    }

    // A successful DELETE can lose its response. Read back the exact key and
    // ownership tuple before retrying; absence or a different lease proves this
    // execution no longer owns the global lock.
    try {
      if (await runtimeLockIsReleased(lock)) return;
    } catch (error) {
      lastFailure = new Error(
        `${errorMessage(lastFailure)} Runtime-lock read-back failed: ${errorMessage(error)}`,
        { cause: lastFailure }
      );
    }
  }
  throw new Error(
    `Failed to release the ingestion runtime lock after retry and read-back: ${errorMessage(lastFailure)}`,
    { cause: lastFailure }
  );
}

async function runtimeLockIsReleased(lock) {
  const { data, error } = await runSupabaseOperation(
    "reconcile ingestion runtime lock release",
    () => supabase
      .from("ingestion_runtime_locks")
      .select("lock_key,owner_id,lease_token")
      .eq("lock_key", lock.lock_key)
      .maybeSingle(),
    { cleanup: true }
  );
  check(error, "reconcile runtime lock release");
  if (!data) return true;
  return data.owner_id !== workerId || data.lease_token !== lock.lease_token;
}

async function releaseRuntimeLockOnce() {
  if (runtimeLockReleasePromise) return runtimeLockReleasePromise;
  const lock = runtimeLock;
  if (!lock) return;
  const releasePromise = releaseRuntimeLock(lock)
    .then(() => {
      if (
        runtimeLock?.lock_key === lock.lock_key &&
        runtimeLock?.lease_token === lock.lease_token
      ) {
        runtimeLock = null;
      }
    })
    .finally(() => {
      if (runtimeLockReleasePromise === releasePromise) {
        runtimeLockReleasePromise = null;
      }
    });
  runtimeLockReleasePromise = releasePromise;
  return releasePromise;
}

function startHeartbeatScheduling() {
  assertLeaseHealthy();
  if (heartbeatSchedulingStopped || heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void scheduleHeartbeat();
  }, 60_000);
  heartbeatTimer.unref?.();
}

function scheduleHeartbeat() {
  if (heartbeatSchedulingStopped || terminationSignal || heartbeatInFlight) {
    return heartbeatInFlight;
  }
  const abortController = new AbortController();
  heartbeatAbortController = abortController;
  const operation = heartbeat(abortController.signal)
    .catch((error) => {
      if (!(heartbeatSchedulingStopped && abortController.signal.aborted)) {
        failHeartbeat(error);
      }
    })
    .finally(() => {
      if (heartbeatInFlight === operation) heartbeatInFlight = null;
      if (heartbeatAbortController === abortController) heartbeatAbortController = null;
    });
  heartbeatInFlight = operation;
  return operation;
}

function stopHeartbeatScheduling() {
  heartbeatSchedulingStopped = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function stopHeartbeatAndDrain() {
  stopHeartbeatScheduling();
  if (heartbeatDrainPromise) return heartbeatDrainPromise;
  const inFlight = heartbeatInFlight;
  if (!inFlight) return;
  heartbeatAbortController?.abort(new Error("Heartbeat canceled before run finalization."));
  heartbeatDrainPromise = (async () => {
    let timedOut = false;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, HEARTBEAT_DRAIN_TIMEOUT_MS);
      void inFlight.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (timedOut) {
      failHeartbeat(new Error(
        `Ingestion lease heartbeat did not drain within ${HEARTBEAT_DRAIN_TIMEOUT_MS}ms.`
      ));
    }
  })();
  return heartbeatDrainPromise;
}

async function heartbeat(signal = null) {
  const runSnapshot = run?.id && run?.lease_token
    ? { id: run.id, leaseToken: run.lease_token }
    : null;
  const lockSnapshot = runtimeLock?.lock_key && runtimeLock?.lease_token
    ? { lockKey: runtimeLock.lock_key, leaseToken: runtimeLock.lease_token }
    : null;
  if (!runSnapshot || !lockSnapshot) return;
  const now = new Date().toISOString();
  const { error: runError } = await runSupabaseOperation(
    "heartbeat ingestion run",
    () => supabase
      .from("ingestion_runs")
      .update({ heartbeat_at: now, lease_expires_at: new Date(Date.now() + 20 * 60_000).toISOString() })
      .eq("id", runSnapshot.id)
      .eq("lease_token", runSnapshot.leaseToken),
    { signal }
  );
  check(runError, "heartbeat ingestion run");
  const { data, error } = await runSupabaseOperation(
    "heartbeat ingestion runtime lock",
    () => supabase.rpc("renew_ingestion_runtime_lock", {
      p_lock_key: lockSnapshot.lockKey,
      p_owner_id: workerId,
      p_lease_token: lockSnapshot.leaseToken,
      p_lease_duration: "20 minutes"
    }),
    { signal }
  );
  check(error, "heartbeat runtime lock");
  if (data !== true) throw new Error("The ingestion runtime lock expired or was taken by another worker.");
}

function failHeartbeat(error) {
  heartbeatFailure = error instanceof Error ? error : new Error(errorMessage(error));
  console.error(`Heartbeat failure: ${sanitizeRunnerDiagnosticText(errorMessage(heartbeatFailure))}`);
}

function assertLeaseHealthy() {
  if (terminationSignal) throw new Error(cancellationMessage(terminationSignal));
  if (heartbeatFailure) {
    throw new Error(`Ingestion lease heartbeat failed; publication aborted: ${errorMessage(heartbeatFailure)}`);
  }
}

async function getOrCreateRun() {
  const { data: existingData, error: existingError } = await runSupabaseOperation(
    "read idempotent ingestion run",
    () => supabase
      .from("ingestion_runs")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .limit(1)
      .maybeSingle()
  );
  check(existingError, "read idempotent ingestion run");
  const existing = existingData ?? null;
  if (existing?.status === "completed") return existing;
  if (existing) {
    const leaseToken = randomUUID();
    const { data, error } = await runSupabaseOperation(
      "recover idempotent ingestion run lease",
      () => supabase
        .from("ingestion_runs")
        .update({
          status: "running",
          heartbeat_at: runStartedAt.toISOString(),
          lease_owner: workerId,
          lease_token: leaseToken,
          lease_expires_at: new Date(Date.now() + 20 * 60_000).toISOString()
        })
        .eq("id", existing.id)
        .select("*")
        .single()
    );
    check(error, "recover idempotent ingestion run lease");
    return data;
  }
  const leaseToken = randomUUID();
  const payload = {
    idempotency_key: idempotencyKey,
    status: "running",
    started_at: runStartedAt.toISOString(),
    heartbeat_at: runStartedAt.toISOString(),
    lease_owner: workerId,
    lease_token: leaseToken,
    lease_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    stats_json: { phase: "initializing" },
    logs: [`Started autonomous ingestion ${idempotencyKey}.`],
    errors_json: []
  };
  const { data, error } = await runSupabaseOperation(
    "create ingestion run",
    () => supabase.from("ingestion_runs").insert(payload).select("*").single()
  );
  if (error?.code === "23505") {
    const { data: concurrent, error: concurrentError } = await runSupabaseOperation(
      "recover concurrent ingestion run",
      () => supabase
        .from("ingestion_runs")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .limit(1)
        .single()
    );
    check(concurrentError, "recover concurrent ingestion run");
    return concurrent;
  }
  check(error, "create ingestion run");
  return data;
}

async function event(
  eventType,
  severity,
  message,
  payload = {},
  eventKey = null,
  { timeoutMs = LIFECYCLE_OPERATION_TIMEOUT_MS } = {}
) {
  const sanitizedMessage = sanitizeRunnerDiagnosticText(message);
  const sanitizedPayload = sanitizeRunnerDiagnosticValue(payload);
  if (!supabase || !run?.id) {
    console.log(`[${severity}] ${eventType}: ${sanitizedMessage}`);
    return;
  }
  const { error } = await runSupabaseOperation(
    `record ${eventType} event`,
    () => supabase.from("ingestion_run_events").insert({
      ingestion_run_id: run.id,
      event_key: eventKey,
      event_type: eventType,
      severity,
      message: sanitizedMessage,
      payload_json: sanitizedPayload
    }),
    { timeoutMs }
  );
  check(error, `record ${eventType} event`);
}

async function syncCatalogs(allCatalogs) {
  const batchBySlug = new Map();
  const companyBySourceKey = new Map();
  const companyByBatchSourceKey = new Map();
  const founderBySourceKey = new Map();
  const founderByBatchSourceKey = new Map();
  const historicalFounderByBatchSourceKey = new Map();
  const accountBySourceKey = new Map();
  const accountInventory = [];
  const ownerInventory = [];

  for (const catalog of allCatalogs) {
    const { data: batch, error: batchError } = await runSupabaseOperation(
      `upsert batch ${catalog.slug}`,
      () => supabase
        .from("batches")
        .upsert(
          { slug: catalog.slug, label: catalog.label, company_count_expected: catalog.companies.length },
          { onConflict: "slug" }
        )
        .select("id,slug")
        .single()
    );
    check(batchError, `upsert batch ${catalog.slug}`);
    batchBySlug.set(catalog.slug, batch.id);

    const companyRows = catalog.companies.map((company) => ({
      batch_id: batch.id,
      source_key: company.sourceKey,
      yc_profile_url: company.profileUrl,
      name: company.name,
      website_url: company.websiteUrl,
      tagline: company.tagline,
      description: company.description,
      group_partner: company.groupPartner,
      review_state: normalizeReviewState(company.reviewState)
    }));
    const { data: companies, error: companyError } = await runSupabaseOperation(
      `upsert companies for ${catalog.slug}`,
      () => supabase
        .from("companies")
        .upsert(companyRows, { onConflict: "batch_id,source_key" })
        .select("id,source_key")
    );
    check(companyError, `upsert companies for ${catalog.slug}`);
    for (const company of companies ?? []) {
      companyByBatchSourceKey.set(batchCompanyKey(catalog.slug, company.source_key), company.id);
      const canonicalCompanyId = companyBySourceKey.get(company.source_key);
      if (!canonicalCompanyId || String(company.id).localeCompare(String(canonicalCompanyId)) < 0) {
        companyBySourceKey.set(company.source_key, company.id);
      }
    }

    const activeFounderSourceKeys = new Set(catalog.companies.flatMap((company) =>
      company.founders.map((founder) => founder.sourceKey)
    ));
    const historicalFounderSourceKeys = new Set(catalog.companies.flatMap((company) =>
      (company.historicalFounders ?? []).map((founder) => founder.sourceKey)
    ));
    const founderRows = [...new Map(catalog.companies.flatMap((company) =>
      [...company.founders, ...(company.historicalFounders ?? [])].map((founder) => [founder.sourceKey, {
        source_key: founder.sourceKey,
        name: founder.name,
        yc_profile_url: founder.profileUrl,
        personal_website_url: founder.websiteUrl,
        review_state: normalizeReviewState(founder.reviewState)
      }])
    )).values()];
    if (founderRows.length) {
      const { data: founders, error: founderError } = await runSupabaseOperation(
        `upsert founders for ${catalog.slug}`,
        () => supabase
          .from("founders")
          .upsert(founderRows, { onConflict: "source_key" })
          .select("id,source_key")
      );
      check(founderError, `upsert founders for ${catalog.slug}`);
      for (const founder of founders ?? []) {
        founderBySourceKey.set(founder.source_key, founder.id);
        if (activeFounderSourceKeys.has(founder.source_key)) {
          founderByBatchSourceKey.set(batchCompanyKey(catalog.slug, founder.source_key), founder.id);
        }
        if (historicalFounderSourceKeys.has(founder.source_key)) {
          historicalFounderByBatchSourceKey.set(
            batchCompanyKey(catalog.slug, founder.source_key),
            founder.id
          );
        }
      }
    }

    const joins = catalog.companies.flatMap((company) =>
      company.founders.map((founder) => ({
        company_id: companyByBatchSourceKey.get(batchCompanyKey(catalog.slug, company.sourceKey)),
        founder_id: founderBySourceKey.get(founder.sourceKey),
        review_state: "verified",
        source_url: company.profileUrl
      }))
    );
    if (joins.length) {
      const { error } = await runSupabaseOperation(
        `upsert founder relationships for ${catalog.slug}`,
        () => supabase
          .from("company_founders")
          .upsert(joins, { onConflict: "company_id,founder_id" })
      );
      check(error, `upsert founder relationships for ${catalog.slug}`);
    }

    for (const company of catalog.companies) {
      const companyId = companyByBatchSourceKey.get(batchCompanyKey(catalog.slug, company.sourceKey));
      for (const account of company.accounts) {
        accountInventory.push({ account, entityType: "company", entityId: companyId });
        ownerInventory.push({
          account,
          batchSlug: catalog.slug,
          batchId: batch.id,
          entityType: "company",
          entityId: companyId,
          entitySourceKey: company.sourceKey
        });
      }
      for (const founder of company.founders) {
        const founderId = founderByBatchSourceKey.get(batchCompanyKey(catalog.slug, founder.sourceKey));
        for (const account of founder.accounts) {
          accountInventory.push({ account, entityType: "founder", entityId: founderId });
          ownerInventory.push({
            account,
            batchSlug: catalog.slug,
            batchId: batch.id,
            entityType: "founder",
            entityId: founderId,
            entitySourceKey: founder.sourceKey
          });
        }
      }
    }
  }

  const canonicalAccounts = new Map();
  for (const inventory of accountInventory) {
    const identity = socialAccountIdentity(inventory.account);
    if (!canonicalAccounts.has(identity)) {
      canonicalAccounts.set(identity, accountRow(inventory.account, inventory.entityType, inventory.entityId));
    }
  }
  const accountIdByIdentity = new Map();
  await mapWithConcurrency(chunks([...canonicalAccounts.values()], 250), 4, async (accountRows) => {
    if (accountRows.length === 0) return;
    const { data, error } = await runSupabaseOperation(
      "upsert canonical social accounts",
      () => supabase
        .from("social_accounts")
        .upsert(accountRows, { onConflict: "platform,url" })
        .select("id,source_key,platform,url")
    );
    check(error, "upsert canonical social accounts");
    for (const account of data ?? []) {
      accountIdByIdentity.set(socialAccountIdentity(account), account.id);
    }
  });
  for (const inventory of accountInventory) {
    const accountId = accountIdByIdentity.get(socialAccountIdentity(inventory.account));
    if (!accountId) throw new Error(`No durable social account id was returned for ${inventory.account.sourceKey}.`);
    accountBySourceKey.set(inventory.account.sourceKey, accountId);
  }

  const now = new Date().toISOString();
  const ownerRowsByKey = new Map();
  for (const owner of ownerInventory) {
    const ownerKey = socialAccountOwnerKey(owner);
    ownerRowsByKey.set(ownerKey, {
      owner_key: ownerKey,
      social_account_id: accountIdByIdentity.get(socialAccountIdentity(owner.account)),
      batch_id: owner.batchId,
      entity_type: owner.entityType,
      company_id: owner.entityType === "company" ? owner.entityId : null,
      founder_id: owner.entityType === "founder" ? owner.entityId : null,
      owner_source_key: owner.entitySourceKey,
      account_source_key: owner.account.sourceKey,
      platform: owner.account.platform,
      review_state: normalizeReviewState(owner.account.reviewState),
      first_seen_at: now,
      last_seen_at: now,
      last_seen_run_id: run.id,
      retired_at: null,
      retirement_reason: null
    });
  }
  await mapWithConcurrency(chunks([...ownerRowsByKey.values()], 250), 4, async (ownerRows) => {
    if (ownerRows.length === 0) return;
    const { error } = await runSupabaseOperation(
      "upsert batch-scoped social account owners",
      () => supabase
        .from("social_account_owners")
        .upsert(ownerRows, { onConflict: "owner_key" })
    );
    check(error, "upsert batch-scoped social account owners");
  });
  const retiredOwnerAccounts = await retireAbsentSocialAccountOwners(
    new Set(ownerRowsByKey.keys()),
    [...batchBySlug.values()],
    now
  );

  return {
    batchBySlug,
    companyBySourceKey,
    companyByBatchSourceKey,
    founderBySourceKey,
    founderByBatchSourceKey,
    historicalFounderByBatchSourceKey,
    accountBySourceKey,
    ownerAccountCount: ownerRowsByKey.size,
    retiredOwnerAccounts
  };
}

function accountRow(account, entityType, entityId) {
  return {
    source_key: account.sourceKey,
    entity_type: entityType,
    entity_id: entityId,
    platform: account.platform,
    handle: account.handle,
    // Keep the stored URL byte-for-byte compatible with legacy rows and the
    // existing (platform,url) uniqueness constraint. Normalization is used
    // only for in-memory identity matching below.
    url: account.url,
    account_id: account.accountId,
    verified: account.verified,
    review_state: normalizeReviewState(account.reviewState),
    discovered_from_url: account.discoveredFromUrl,
    evidence_json: { matchReason: account.matchReason }
  };
}

async function retireAbsentSocialAccountOwners(activeOwnerKeys, batchIds, retiredAt) {
  const existingOwners = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await runSupabaseOperation(
      "read batch-scoped social account owners for retirement",
      () => supabase
        .from("social_account_owners")
        .select("id,owner_key")
        .in("batch_id", batchIds)
        .order("id", { ascending: true })
        .range(offset, offset + 999)
    );
    check(error, "read batch-scoped social account owners for retirement");
    existingOwners.push(...(data ?? []));
    if ((data?.length ?? 0) < 1_000) break;
  }
  const staleIds = existingOwners
    .filter((owner) => !activeOwnerKeys.has(owner.owner_key))
    .map((owner) => owner.id);
  await mapWithConcurrency(chunks(staleIds, 250), 4, async (ids) => {
    if (ids.length === 0) return;
    const { error } = await runSupabaseOperation(
      "retire absent batch-scoped social account owners",
      () => supabase
        .from("social_account_owners")
        .update({
          review_state: "rejected",
          retired_at: retiredAt,
          retirement_reason: "absent_from_current_batch_owner_inventory"
        })
        .in("id", ids)
    );
    check(error, "retire absent batch-scoped social account owners");
  });
  return staleIds.length;
}

function socialAccountOwnerKey(owner) {
  const identity = [
    owner.batchSlug,
    owner.entityType,
    owner.entitySourceKey,
    owner.account.sourceKey
  ].join("\u0000");
  return `owner:${createHash("sha256").update(identity).digest("hex")}`;
}

function socialAccountIdentity(account) {
  return `${String(account.platform).toLowerCase()}\u0000${canonicalAccountUrl(account.url)}`;
}

function canonicalAccountUrl(value) {
  const raw = String(value ?? "").trim();
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw;
  }
}

async function enqueueTasks(tasks, catalogState) {
  const now = new Date().toISOString();
  const rows = tasks.map((task) => ({
    ingestion_run_id: run.id,
    batch_id: catalogState.batchBySlug.get(task.batchSlug),
    entity_type: task.entityType,
    entity_id:
      task.entityType === "company"
        ? catalogState.companyByBatchSourceKey.get(batchCompanyKey(task.batchSlug, task.entitySourceKey))
        : catalogState.founderByBatchSourceKey.get(batchCompanyKey(task.batchSlug, task.entitySourceKey)),
    company_name: task.companyName,
    platform: task.platform,
    status: task.status,
    checkpoint_key: task.checkpointKey,
    max_attempts: AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts,
    priority: platformPriority(task.platform),
    terminal_at: task.status === "queued" ? null : now,
    terminal_reason: task.terminalReason,
    last_error_json: {},
    rate_limit_ms: platformDelay(task.platform)
  }));
  await mapWithConcurrency(chunks(rows, 250), 4, async (taskRows) => {
    const { error } = await runSupabaseOperation(
      "enqueue account/platform tasks",
      () => supabase
        .from("ingestion_tasks")
        .upsert(taskRows, { onConflict: "checkpoint_key" }),
      { timeoutMs: SUPABASE_BULK_OPERATION_TIMEOUT_MS }
    );
    check(error, "enqueue account/platform tasks");
  });
}

async function cancelSupersededRunTasks() {
  const tasks = await readAllIngestionTaskRows(
    "read task inventory for current-plan reconciliation",
    "id,status,platform,checkpoint_key",
    (query) => query.eq("ingestion_run_id", run.id)
  );
  const { supersededTasks } = partitionAutonomousTaskInventory(tasks, plannedTasks, {
    isSupersededTask: (task) => isAutonomousCollectorTaskForRun(task, { runKey: idempotencyKey })
  });
  const nonTerminalStatuses = ["queued", "running", "retry_scheduled"];
  const supersededNonTerminalTasks = supersededTasks.filter((task) =>
    nonTerminalStatuses.includes(task.status)
  );
  const terminalAt = new Date().toISOString();
  await mapWithConcurrency(chunks(supersededNonTerminalTasks, 250), 4, async (taskRows) => {
    if (taskRows.length === 0) return;
    const { error } = await runSupabaseOperation(
      "cancel superseded same-slot ingestion tasks",
      () => supabase
        .from("ingestion_tasks")
        .update({
          status: "canceled",
          terminal_at: terminalAt,
          terminal_reason: "superseded_by_current_catalog_plan",
          locked_by: null,
          locked_at: null,
          lease_token: null,
          lease_expires_at: null,
          next_attempt_at: null,
          last_failure_kind: null,
          last_error: null,
          last_error_json: {}
        })
        .in("id", taskRows.map((task) => task.id))
        .in("status", nonTerminalStatuses)
    );
    check(error, "cancel superseded same-slot ingestion tasks");
  });
  return {
    supersededTaskCount: supersededTasks.length,
    supersededNonTerminalCanceled: supersededNonTerminalTasks.length
  };
}

async function prepareBatchDiscoveryState() {
  const [publishedAttempts, publishedPaths] = await Promise.all([
    readRequiredCanonicalRows(
      publishedDiscoveryAttemptsPath,
      "Canonical discovery attempts ledger"
    ),
    readRequiredCanonicalRows(
      publishedSourceDiscoveryPathsPath,
      "Canonical source discovery paths ledger"
    )
  ]);
  await Promise.all(AUTONOMOUS_BATCHES.map(async (batch) => {
    const catalog = catalogs.find((candidate) => candidate.slug === batch.slug);
    const companySlugs = new Set((catalog?.companies ?? []).map(plannedCompanySlug));
    const belongsToBatch = (row) => {
      const rowBatch = row?.batch_slug ?? row?.batchSlug;
      if (rowBatch) return rowBatch === batch.slug;
      const slug = row?.company_slug ?? row?.companySlug ?? String(row?.company_id ?? row?.companyId ?? "")
        .replace(/^company-/, "")
        .replace(/^a16z-speedrun-006-/, "");
      return companySlugs.has(slug);
    };
    await Promise.all([
      seedShardLedger(discoveryAttemptOutputs.get(batch.slug), publishedAttempts.filter(belongsToBatch)),
      seedShardLedger(sourceDiscoveryPathOutputs.get(batch.slug), publishedPaths.filter(belongsToBatch))
    ]);
  }));
}

async function prepareSanitizedPublicSnapshot(
  publicSnapshots,
  { baseRef = null, contentIdentityReferenceRows = [] } = {}
) {
  if (publicSnapshots.length === 0) return null;
  const targetRoot = publicationArtifactRoot();
  const publicEvidencePath = "src/lib/social/public-evidence-current.json";
  const basePublicSnapshot = baseRef
    ? await readPublicEvidenceFromGitRef(baseRef, null)
    : null;
  const previousPublicSnapshot = (
    await readPublicEvidenceArtifact(join(targetRoot, publicEvidencePath), { rootDir: targetRoot })
  ).snapshot;
  const firstPartyGraphDocuments = await Promise.all(
    AUTONOMOUS_BATCHES.map((batch) => readRequiredCanonicalJson(
      join(targetRoot, "public", "graph", batch.graphFile),
      `Canonical first-party context graph ${batch.slug}`
    ))
  );
  const allowVerifiedContextEvidence = buildVerifiedFirstPartyContextEvidenceValidator({
    graphDocuments: firstPartyGraphDocuments,
    currentRosterResolver: resolvePublicNativeAuthor,
    observedAt: runStartedAt ?? new Date().toISOString()
  });
  const trustedCanonicalSnapshots = new Set(
    [basePublicSnapshot, previousPublicSnapshot].filter(Boolean)
  );
  return mergePublicEvidenceSnapshots(
    [basePublicSnapshot, previousPublicSnapshot, ...publicSnapshots].filter(Boolean),
    {
      durableStorageConfigured,
      resolveBatchSlug: resolveLegacyPublicEvidenceBatch,
      resolveNativeAuthor: resolvePublicNativeAuthor,
      contentIdentityReferenceRows,
      allowVerifiedMetriclessEvidence: isVerifiedYouTubeNativeMetriclessEvidence,
      allowVerifiedContextEvidence: (row, { snapshot }) =>
        trustedCanonicalSnapshots.has(snapshot) && allowVerifiedContextEvidence(row)
    }
  );
}

async function readLoggedInEvidenceSnapshots() {
  const snapshots = [];
  for (const outputPath of loggedInOutputs.values()) {
    const snapshot = await readJson(outputPath, null);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

async function prepareMergedLoggedInEvidenceSnapshot(
  incomingSnapshots,
  { baseRef = null } = {}
) {
  const targetRoot = publicationArtifactRoot();
  const relativePath = "src/lib/social/logged-in-evidence-current.json";
  const current = await readJson(join(targetRoot, relativePath), {
    evidence: [],
    failures: [],
    needsReview: [],
    attributionReconciliationLedger: []
  });
  const base = baseRef ? await readJsonFromGitRef(baseRef, relativePath, null) : null;
  const snapshots = [base, current, ...(incomingSnapshots ?? [])].filter(Boolean);
  // Only per-cohort collector outputs carry a singular snapshot batch. The
  // canonical base/current artifacts are multi-cohort, so their legacy rows
  // must continue through the catalog resolver rather than inherit one
  // top-level batchSlug.
  const evidenceRows = mergeLoggedInEvidenceRows([base, current], incomingSnapshots ?? []);
  const content = finalizeLoggedInEvidenceContent(
    newestRowsById(evidenceRows),
    {
      defaultBatchSlug: null,
      resolveBatchSlug: resolveLegacyPublicEvidenceBatch,
      existingNeedsReview: newestRowsById(
        snapshots.flatMap((snapshot) => snapshot.needsReview ?? [])
      ),
      existingAttributionReconciliationLedger: combineAttributionReconciliationLedgers(
        ...snapshots.map((snapshot) => snapshot.attributionReconciliationLedger)
      )
    }
  );
  const source = [...snapshots]
    .reverse()
    .find((snapshot) => snapshot?.source && typeof snapshot.source === "object")?.source ?? {};
  const multiCohortSource = { ...source };
  delete multiCohortSource.batchSlug;
  delete multiCohortSource.batch_slug;
  return {
    source: {
      ...multiCohortSource,
      label: "Opt-in logged-in browser social post ingestion",
      runner: "dedicated-self-hosted-mac",
      viewer: {
        linkedinProfile: cleanEnv(process.env.RETURNER_LINKEDIN_VIEWER_PROFILE),
        instagramHandle: cleanEnv(process.env.RETURNER_INSTAGRAM_VIEWER_HANDLE)
      },
      fetchedAt: new Date().toISOString(),
      batchSlugs: AUTONOMOUS_BATCHES.map((batch) => batch.slug)
    },
    evidence: content.evidence,
    failures: newestRowsById(snapshots.flatMap((snapshot) => snapshot.failures ?? [])),
    needsReview: content.needsReview,
    attributionReconciliationLedger: content.attributionReconciliationLedger
  };
}

async function readCanonicalContentIdentityReferenceRows(targetedSnapshot, { baseRef = null } = {}) {
  const targetRoot = publicationArtifactRoot();
  const evidencePaths = [
    "src/lib/social/logged-in-evidence-current.json",
    "src/lib/social/a16z-speedrun-006-social-evidence.json"
  ];
  const githubPaths = [
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json"
  ];
  const currentSnapshots = await Promise.all([
    ...evidencePaths.map((path) => readRequiredCanonicalJson(
      join(targetRoot, path),
      `Canonical content-identity evidence ${path}`
    )),
    ...githubPaths.map((path) => readRequiredCanonicalJson(
      join(targetRoot, path),
      `Canonical content-identity GitHub evidence ${path}`
    ))
  ]);
  const baseSnapshots = baseRef
    ? await Promise.all([...evidencePaths, ...githubPaths].map((path) =>
        readJsonFromGitRef(baseRef, path, null)
      ))
    : [];
  const all = [targetedSnapshot, ...currentSnapshots, ...baseSnapshots].filter(Boolean);
  return all.flatMap((snapshot) => [
    ...(snapshot.evidence ?? []),
    ...canonicalGithubContentIdentityRows(snapshot)
  ]);
}

async function readCanonicalLoggedInAttributionReconciliationLedger({ baseRef = null } = {}) {
  const targetRoot = publicationArtifactRoot();
  const loggedInEvidencePath = "src/lib/social/logged-in-evidence-current.json";
  const current = await readRequiredCanonicalJson(
    join(targetRoot, loggedInEvidencePath),
    "Canonical logged-in attribution reconciliation ledger"
  );
  const base = baseRef ? await readJsonFromGitRef(baseRef, loggedInEvidencePath, null) : null;
  return combineAttributionReconciliationLedgers(
    base?.attributionReconciliationLedger,
    current.attributionReconciliationLedger
  );
}

async function readCanonicalSeededAttributionReconciliationLedger({ baseRef = null } = {}) {
  const targetRoot = publicationArtifactRoot();
  const reconciliationPath = "src/lib/social/a16z-speedrun-006-attribution-reconciliation.json";
  const current = await readRequiredCanonicalJson(
    join(targetRoot, reconciliationPath),
    "Canonical A16Z seeded attribution reconciliation ledger"
  );
  const base = baseRef ? await readJsonFromGitRef(baseRef, reconciliationPath, null) : null;
  return combineAttributionReconciliationLedgers(
    base?.attributionReconciliationLedger,
    current.attributionReconciliationLedger
  );
}

async function readPublicationEvidenceBaseline({ baseRef = null } = {}) {
  const targetRoot = publicationArtifactRoot();
  const evidencePaths = [
    "src/lib/social/public-evidence-current.json",
    "src/lib/social/targeted-evidence-current.json",
    // These immutable, previously verified layers are already visible in the
    // published graph. Include them in the physical-source baseline so a row
    // promoted into the public collector does not masquerade as a new source.
    "src/lib/social/logged-in-evidence-current.json",
    "src/lib/social/a16z-speedrun-006-social-evidence.json"
  ];
  const githubPaths = [
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json"
  ];
  const snapshots = await Promise.all([...evidencePaths, ...githubPaths].map((path) => baseRef
    ? readJsonFromGitRef(baseRef, path, { evidence: [] })
    : readRequiredCanonicalJson(join(targetRoot, path), `Canonical publication baseline ${path}`)
  ));
  return [
    ...snapshots.slice(0, evidencePaths.length),
    ...snapshots.slice(evidencePaths.length).map((snapshot) => ({
      source: snapshot?.source,
      evidence: canonicalGithubContentIdentityRows(snapshot)
    }))
  ];
}

async function readSourceDeltaHistory({ baseRef = null } = {}) {
  if (baseRef) {
    return readJsonFromGitRef(baseRef, "outputs/ingestion-source-delta-history.json", []);
  }
  return readJson(publishedSourceDeltaHistoryPath, []);
}

async function writeSourceDeltaReceipt(receipt, previousHistory) {
  await Promise.all([
    writeJsonAtomic(publishedSourceDeltaPath, receipt),
    writeJsonAtomic(
      publishedSourceDeltaHistoryPath,
      mergeIngestionSourceDeltaHistory(previousHistory, receipt)
    )
  ]);
  console.log(`SOURCE_DELTA_RECEIPT ${JSON.stringify(receipt)}`);
  const githubSummary = cleanEnv(process.env.GITHUB_STEP_SUMMARY);
  if (!githubSummary) return;
  await appendFile(githubSummary, [
    "## New physical source receipt",
    `- Slot: ${receipt.idempotencyKey}`,
    `- New physical sources this slot: ${receipt.newPhysicalSources}`,
    `- New physical sources this Central day: ${receipt.dailyNewPhysicalSources}`,
    `- Daily source health: ${receipt.dailySourceHealth}`,
    `- Collection health: ${receipt.collectionHealth}`,
    `- Collection health reasons: ${receipt.collectionHealthReasons?.join(", ") || "none"}`,
    `- Provider blocked (all tasks): ${receipt.providerBlocked ?? 0}`,
    `- Provider blocked (mapped tasks): ${receipt.mappedProviderBlocked ?? 0}`,
    `- Mapped native-evidence success: ${receipt.mappedSucceeded}/${receipt.mappedExpected}`,
    `- Published physical sources: ${receipt.publishedPhysicalSources}`,
    `- Newest new-source post: ${receipt.newestNewSourcePostedAt ?? "none"}`,
    ""
  ].join("\n"), "utf8");
}

function canonicalGithubContentIdentityRows(snapshot) {
  return (snapshot?.accounts ?? []).flatMap((account) =>
    (account?.repos ?? []).map((repository) => ({
      batchSlug: snapshot?.source?.batchSlug ?? account?.batchSlug ?? null,
      entityType: account?.entityType ?? "company",
      entityId: account?.entityId,
      companySlug: account?.companySlug,
      companyName: account?.companyName,
      platform: "github",
      sourceUrl: repository?.htmlUrl,
      platformPostId: repository?.fullName,
      platformObjectId: repository?.id == null ? null : String(repository.id),
      accountUrl: account?.account?.htmlUrl ?? account?.githubUrl,
      authorHandle: account?.account?.login ?? account?.login,
      text: repository?.description,
      postedAt: repository?.createdAt
    }))
  );
}

async function prepareSanitizedTargetedSnapshot(topVoiceRefresh, { baseRef = null } = {}) {
  const targetRoot = publicationArtifactRoot();
  const targetedEvidencePath = "src/lib/social/targeted-evidence-current.json";
  const [baseTargetedSnapshot, previousTargetedSnapshot] = await Promise.all([
    baseRef ? readJsonFromGitRef(baseRef, targetedEvidencePath, null) : null,
    readRequiredCanonicalJson(join(targetRoot, targetedEvidencePath), "Canonical targeted evidence snapshot")
  ]);
  return mergeTargetedEvidenceSnapshots(
    [baseTargetedSnapshot, previousTargetedSnapshot].filter(Boolean),
    topVoiceRefresh.isolatedEvidence.snapshot,
    {
      resolveBatchSlug: resolveLegacyPublicEvidenceBatch,
      resolveEntityAttribution: resolveCanonicalTargetedAttribution,
      validateEntityAttribution: isCanonicalBatchEntityAttribution
    }
  );
}

function attributionReconciliationTargetKey(entry, attribution) {
  const physicalPostId = entry?.platformPostId ?? entry?.sourceUrl;
  if (
    !entry?.platform ||
    !physicalPostId ||
    !attribution?.batchSlug ||
    !attribution?.entityId
  ) {
    return null;
  }
  return JSON.stringify([
    entry.platform,
    physicalPostId,
    attribution.batchSlug,
    attribution.entityType ?? "company",
    attribution.entityId,
    attribution.attributionType ?? "subject"
  ]);
}

function combineAttributionReconciliationLedgers(...ledgers) {
  const byPhysicalTarget = new Map();
  for (const entry of ledgers.flatMap((ledger) => ledger ?? [])) {
    const staleKey = attributionReconciliationTargetKey(entry, entry?.staleAttribution);
    if (!staleKey) continue;
    const previous = byPhysicalTarget.get(staleKey);
    if (
      previous?.disposition === "reattributed" &&
      entry.disposition === "reattributed"
    ) {
      const previousReplacementKey = attributionReconciliationTargetKey(
        previous,
        previous.replacementAttribution
      );
      const replacementKey = attributionReconciliationTargetKey(
        entry,
        entry.replacementAttribution
      );
      if (previousReplacementKey !== replacementKey) {
        throw new Error(
          `Conflicting attribution reattributions target ${staleKey}: ` +
          `${previousReplacementKey ?? "missing replacement"} versus ${replacementKey ?? "missing replacement"}.`
        );
      }
    }
    if (!previous || (previous.disposition === "quarantined" && entry.disposition === "reattributed")) {
      byPhysicalTarget.set(staleKey, entry);
    }
  }

  const requiredReplacementTargets = new Set(
    [...byPhysicalTarget.values()]
      .filter((entry) => entry.disposition === "reattributed")
      .map((entry) => attributionReconciliationTargetKey(entry, entry.replacementAttribution))
      .filter(Boolean)
  );
  return [...byPhysicalTarget.entries()]
    .filter(([staleKey, entry]) => (
      entry.disposition !== "quarantined" || !requiredReplacementTargets.has(staleKey)
    ))
    .map(([, entry]) => entry);
}

async function mergePublicationInputs(
  {
    publicSnapshots,
    githubSnapshots,
    publicResults,
    topVoiceRefresh,
    loggedInEvidenceSnapshot = null,
    sanitizedPublicSnapshot = null,
    sanitizedTargetedSnapshot = null
  },
  { baseRef = null } = {}
) {
  const targetRoot = publicationArtifactRoot();
  const publicEvidencePath = "src/lib/social/public-evidence-current.json";
  if (publicSnapshots.length > 0) {
    const trustedPublicSnapshot = sanitizedPublicSnapshot ?? (
      baseRef
        ? await prepareSanitizedPublicSnapshot(publicSnapshots, { baseRef })
        : await prepareSanitizedPublicSnapshot(publicSnapshots)
    );
    await writePublicEvidenceArtifactPairAtomic({
      rootDir: targetRoot,
      canonicalPath: join(targetRoot, publicEvidencePath),
      snapshot: trustedPublicSnapshot,
      ledgerRelativePath: PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH,
      reviewLedgerRelativePath: PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH
    });
  }

  const targetedEvidencePath = "src/lib/social/targeted-evidence-current.json";
  const trustedTargetedSnapshot = sanitizedTargetedSnapshot ?? (
    baseRef
      ? await prepareSanitizedTargetedSnapshot(topVoiceRefresh, { baseRef })
      : await prepareSanitizedTargetedSnapshot(topVoiceRefresh)
  );
  await writeJsonAtomic(
    join(targetRoot, targetedEvidencePath),
    trustedTargetedSnapshot
  );

  if (loggedInEvidenceSnapshot) {
    await writeJsonAtomic(
      join(targetRoot, "src/lib/social/logged-in-evidence-current.json"),
      loggedInEvidenceSnapshot
    );
  }

  const [baseAttempts, basePaths] = baseRef
    ? await Promise.all([
        readJsonFromGitRef(baseRef, "outputs/discovery-attempts-current.json", []),
        readJsonFromGitRef(baseRef, "outputs/source-discovery-paths-current.json", [])
      ])
    : [[], []];
  const mergedDiscoveryState = await mergeCollectorDiscoveryState(publicResults, { baseAttempts, basePaths });
  await writeJsonAtomic(publishedDiscoveryAttemptsPath, mergedDiscoveryState.discoveryAttempts);
  await writeJsonAtomic(publishedSourceDiscoveryPathsPath, mergedDiscoveryState.sourceDiscoveryPaths);
  await publishGithubExports(githubSnapshots, { baseRef });
}

async function mergeCollectorDiscoveryState(publicResults, { baseAttempts = [], basePaths = [] } = {}) {
  const [publishedAttempts, publishedPaths] = await Promise.all([
    readRequiredCanonicalRows(
      publishedDiscoveryAttemptsPath,
      "Canonical discovery attempts ledger"
    ),
    readRequiredCanonicalRows(
      publishedSourceDiscoveryPathsPath,
      "Canonical source discovery paths ledger"
    )
  ]);
  const attempts = [baseAttempts, publishedAttempts];
  const paths = [basePaths, publishedPaths];
  for (const result of publicResults) {
    attempts.push(await readJson(discoveryAttemptOutputs.get(result.batchSlug), []));
    paths.push(await readJson(sourceDiscoveryPathOutputs.get(result.batchSlug), []));
  }
  return {
    discoveryAttempts: newestRowsById(attempts.flat()),
    sourceDiscoveryPaths: newestRowsById(paths.flat())
  };
}

async function readPublicEvidenceFromGitRef(ref, fallback) {
  const publicEvidencePath = "src/lib/social/public-evidence-current.json";
  const source = await readTextFromGitRef(ref, publicEvidencePath, null);
  if (source === null) return fallback;
  let canonical;
  try {
    canonical = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid JSON at ${ref}:${publicEvidencePath}: ${errorMessage(error)}`
    );
  }
  return hydratePublicEvidenceArtifactWithLoader(canonical, {
    loadLedger: async (relativePath) => {
      const ledger = await readTextFromGitRef(ref, relativePath, null);
      if (ledger === null) {
        throw new Error(`Missing operational ledger at ${ref}:${relativePath}.`);
      }
      return ledger;
    }
  });
}

async function readJsonFromGitRef(ref, path, fallback) {
  const source = await readTextFromGitRef(ref, path, null);
  if (source === null) return fallback;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON at ${ref}:${path}: ${errorMessage(error)}`);
  }
}

async function readTextFromGitRef(ref, path, fallback) {
  const result = await runCommand("git", ["show", `${ref}:${path}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: `read ${path} from ${ref}`,
    allowedExitCodes: [0, 128],
    quiet: true,
    captureLimit: gitRefCaptureLimit(path),
    requireCompleteOutput: true
  });
  if (result.code !== 0) return fallback;
  return result.stdout;
}

function gitRefCaptureLimit(path) {
  if (path === "src/lib/social/public-evidence-current.json") {
    return PUBLIC_EVIDENCE_LEGACY_MAX_BYTES;
  }
  if (path === PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_PATH) {
    return PUBLIC_EVIDENCE_OPERATIONAL_LEDGER_MAX_BYTES;
  }
  if (path === PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH) {
    return PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES;
  }
  return 50_000_000;
}

function publicationArtifactRoot() {
  return publicationRoot ?? root;
}

function configurePublicationArtifactPaths(targetRoot) {
  publishedDiscoveryAttemptsPath = join(targetRoot, "outputs", "discovery-attempts-current.json");
  publishedSourceDiscoveryPathsPath = join(targetRoot, "outputs", "source-discovery-paths-current.json");
  publishedCohortAuditPath = join(targetRoot, "outputs", "cohort-coverage-current.json");
  publishedSourceDeltaPath = join(targetRoot, "outputs", "ingestion-source-delta-current.json");
  publishedSourceDeltaHistoryPath = join(targetRoot, "outputs", "ingestion-source-delta-history.json");
  publishedGithubQuarantinePath = join(
    targetRoot,
    "src",
    "lib",
    "social",
    "github-traction-quarantine.json"
  );
}

function sourcePath(...segments) {
  return join(pinnedSourceRoot, ...segments);
}

function newestRowsById(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const previous = byId.get(row.id);
    const rowTime = Date.parse(row.last_checked_at ?? row.checkedAt ?? row.created_at ?? 0) || 0;
    const previousTime = Date.parse(
      previous?.last_checked_at ?? previous?.checkedAt ?? previous?.created_at ?? 0
    ) || 0;
    if (!previous || rowTime >= previousTime) byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function plannedCompanySlug(company) {
  try {
    const parts = new URL(company.profileUrl).pathname.split("/").filter(Boolean);
    const companiesIndex = parts.indexOf("companies");
    if (companiesIndex >= 0 && parts[companiesIndex + 1]) return parts[companiesIndex + 1];
  } catch {
    // Fall through to the stable source key.
  }
  return String(company.sourceKey).replace(/^company-/, "").replace(/^a16z-speedrun-006-/, "");
}

function normalizedCatalogAlias(value) {
  return String(value ?? "").trim().toLowerCase() || null;
}

function isCanonicalBatchEntityAttribution(row, batchSlug) {
  const catalog = catalogs.find((candidate) => candidate.slug === batchSlug);
  if (!catalog) return false;
  const entityType = String(row?.entityType ?? row?.entity_type ?? "").toLowerCase();
  const entityId = String(row?.entityId ?? row?.entity_id ?? "");
  const companyName = normalizedCatalogAlias(row?.companyName ?? row?.company_name);
  for (const company of catalog.companies) {
    if (companyName !== normalizedCatalogAlias(company.name)) continue;
    if (entityType === "company" && entityId === company.sourceKey) return true;
    if (entityType === "founder" && company.founders.some((founder) => founder.sourceKey === entityId)) return true;
  }
  return false;
}

function withSnapshotBatchProvenance(snapshot) {
  const batchSlug = snapshot?.source?.batchSlug;
  if (!batchSlug) throw new Error("A public collector snapshot is missing source.batchSlug.");
  const annotate = (rows) => (rows ?? []).map((row) => ({
    ...row,
    batchSlug: row.batchSlug ?? row.batch_slug ?? batchSlug
  }));
  return {
    ...snapshot,
    evidence: annotate(snapshot.evidence),
    needsReview: annotate(snapshot.needsReview),
    failures: annotate(snapshot.failures)
  };
}

async function runFailFastBranches(branchFactories) {
  let firstFailure = null;
  let cancellationPromise = null;
  const branches = branchFactories.map((factory) => Promise.resolve()
    .then(factory)
    .catch(async (error) => {
      if (!firstFailure) firstFailure = error;
      if (!cancellationPromise) {
        cancellationPromise = terminateActiveChildProcesses();
      }
      await cancellationPromise;
      throw error;
    }));
  const settled = await Promise.allSettled(branches);
  if (cancellationPromise) await cancellationPromise;
  if (firstFailure) throw firstFailure;
  return settled.map((result) => result.value);
}

async function runCollectors() {
  await prepareBatchDiscoveryState();
  await event("collection.started", "info", "Public and GitHub collectors started with bounded parallelism.", {
    collectionDeadlineAt: new Date(collectionBudget.deadlineAt).toISOString(),
    collectionPhaseMs: AUTONOMOUS_PROCESS_BUDGETS.collectionPhaseMs,
    publicShardProcessConcurrency: PUBLIC_SHARD_PROCESS_CONCURRENCY,
    publicTaskConcurrencyPerProcess: PUBLIC_COLLECTOR_TASK_CONCURRENCY,
    publicTaskConcurrencyAcrossProcesses:
      PUBLIC_SHARD_PROCESS_CONCURRENCY * PUBLIC_COLLECTOR_TASK_CONCURRENCY,
    publicSocialLaneConcurrencyPerProcess: PUBLIC_SOCIAL_LANE_CONCURRENCY,
    publicSocialLaneConcurrencyAcrossProcesses:
      PUBLIC_SHARD_PROCESS_CONCURRENCY * PUBLIC_SOCIAL_LANE_CONCURRENCY,
    githubShardProcessConcurrency: GITHUB_SHARD_PROCESS_CONCURRENCY,
    githubTaskConcurrencyPerProcess: GITHUB_COLLECTOR_TASK_CONCURRENCY,
    githubInitialRequestConcurrencyAcrossProcesses:
      GITHUB_SHARD_PROCESS_CONCURRENCY * GITHUB_COLLECTOR_TASK_CONCURRENCY
  });
  const githubSearchArg = process.env.GITHUB_TOKEN?.trim() ? "--search" : "--no-search";
  const commands = [
    ...AUTONOMOUS_BATCHES.map(({ slug: batchSlug }) => ({
      kind: "public",
      batchSlug,
      outputPath: publicOutputs.get(batchSlug),
      run: (attemptContext) => runShardedPublicCollector({
        attemptContext,
        batchSlug,
        outputPath: publicOutputs.get(batchSlug),
        shardCount: PUBLIC_COLLECTOR_SHARDS[batchSlug] ?? 1,
        baseArgs: [
          sourcePath("scripts", "fetch-public-traction.mjs"),
          `--batch=${batchSlug}`,
          `--catalog-root=${publicationArtifactRoot()}`,
          "--social=all",
          "--discover-missing-social",
          `--workers=${PUBLIC_COLLECTOR_TASK_CONCURRENCY}`,
          `--x-workers=${PUBLIC_SOCIAL_LANE_CONCURRENCY}`,
          `--linkedin-workers=${PUBLIC_SOCIAL_LANE_CONCURRENCY}`,
          `--instagram-workers=${PUBLIC_SOCIAL_LANE_CONCURRENCY}`,
          "--fresh-for-hours=11",
          `--recent-coverage-cutoff=${runStartedAt.toISOString()}`,
          `--priority-seed=${idempotencyKey}`
        ]
      })
    })),
    ...AUTONOMOUS_BATCHES.map((batch) => {
      const companyCount = catalogs.find((catalog) => catalog.slug === batch.slug)?.companies.length;
      if (!companyCount) throw new Error(`No company catalog is available for GitHub collection in ${batch.slug}.`);
      return {
        kind: "github",
        batchSlug: batch.slug,
        outputPath: githubOutputs.get(batch.slug),
        expectedSourcePath: batch.githubSourcePath,
        run: (attemptContext) => runShardedGithubCollector({
          attemptContext,
          batchSlug: batch.slug,
          outputPath: githubOutputs.get(batch.slug),
          shardCount: GITHUB_COLLECTOR_SHARDS[batch.slug] ?? 1,
          totalCompanyCount: companyCount,
          baseArgs: [
            sourcePath("scripts", "fetch-github-traction.mjs"),
            `--batch=${batch.slug}`,
            `--catalog-root=${publicationArtifactRoot()}`,
            // Official-page and mapped-account fetches are ordinary GitHub/web
            // reads and must cover the full cohort within the process budget.
            // Search API calls use their own single-worker lane because all
            // cohorts share one workflow token and search rate-limit bucket.
            `--workers=${GITHUB_COLLECTOR_TASK_CONCURRENCY}`,
            "--search-workers=1",
            "--website",
            githubSearchArg
          ]
        })
      };
    })
  ];
  for (const command of commands) {
    // Cohorts are admitted together; each GitHub shard remains inside
    // runWithGithubShardProcessSlot, capping the lane at two four-worker
    // processes while this Promise.allSettled waits for every sibling.
    command.promise = runCollectorWithRetries(command);
  }
  const settled = await Promise.allSettled(commands.map((command) => command.promise));
  const authenticatedSocial = await runAuthenticatedCollectors();
  const results = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const result = settled[index];
    const recoveredSnapshot = result.status === "rejected"
      ? await readCollectorSnapshot(command.outputPath, command.kind, {
          ...command,
          requireAttemptBinding: true,
          expectedAttemptId: command.latestAttemptContext?.attemptId ?? null,
          expectedCampaignKey: collectorCampaignKey(),
          expectedExecutionNonce: executionCompletionNonce,
          expectedIdempotencyKey: command.latestAttemptContext?.idempotencyKey ?? null,
          expectedNotBefore: command.latestAttemptContext?.startedAtMs ?? null,
          notBefore: command.latestAttemptContext?.startedAtMs !== undefined
            ? command.latestAttemptContext.startedAtMs - COLLECTOR_SNAPSHOT_FILE_SKEW_MS
            : null,
          notAfter: command.latestAttemptContext?.notAfterMs ?? Date.now() + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS
        })
      : null;
    const recoveredTerminalCoverage = recoveredSnapshot
      ? summarizeAutonomousCollectorTerminalTaskCoverage(recoveredSnapshot, {
          kind: command.kind,
          batchSlug: command.batchSlug,
          tasks: plannedTasks
        })
      : null;
    results.push({
      ...command,
      promise: undefined,
      requireAttemptBinding: true,
      expectedAttemptId: command.latestAttemptContext?.attemptId ?? null,
      expectedCampaignKey: collectorCampaignKey(),
      expectedExecutionNonce: command.latestAttemptContext?.executionNonce ?? null,
      expectedIdempotencyKey: command.latestAttemptContext?.idempotencyKey ?? null,
      expectedNotBefore: command.latestAttemptContext?.startedAtMs ?? null,
      notBefore: command.latestAttemptContext?.startedAtMs !== undefined
        ? command.latestAttemptContext.startedAtMs - COLLECTOR_SNAPSHOT_FILE_SKEW_MS
        : Date.now() - COLLECTOR_RESUME_MAX_AGE_MS,
      notAfter: command.latestAttemptContext?.notAfterMs ?? Date.now() + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS,
      ok: result.status === "fulfilled",
      snapshotAvailable: result.status === "fulfilled" || Boolean(recoveredSnapshot),
      attempts: result.status === "fulfilled"
        ? result.value.attempts
        : AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts,
      successfulRows: result.status === "fulfilled"
        ? result.value.successfulRows
        : recoveredSnapshot
          ? successfulCollectorRowCount(recoveredSnapshot, command.kind)
          : 0,
      retryableFailures: result.status === "fulfilled" ? result.value.retryableFailures : 0,
      exhaustedRetryableFailures: result.status === "fulfilled"
        ? result.value.exhaustedRetryableFailures
        : 0,
      terminalCoverage: result.status === "fulfilled"
        ? result.value.terminalCoverage
        : recoveredTerminalCoverage,
      error: result.status === "rejected" ? errorMessage(result.reason) : null
    });
  }
  await event("collection.finished", "info", "Public, GitHub, and authenticated social collector processes reached terminal states.", {
    results,
    authenticatedSocial
  });
  return results;
}

async function runAuthenticatedCollectors({ historicalReplay = false } = {}) {
  const configured = Boolean(
    cleanEnv(process.env.OPENCLI_BIN) &&
    cleanEnv(process.env.OPENCLI_PROFILE) &&
    cleanEnv(process.env.RETURNER_LINKEDIN_VIEWER_PROFILE) &&
    cleanEnv(process.env.RETURNER_INSTAGRAM_VIEWER_HANDLE)
  );
  if (!configured) {
    await event(
      "authenticated_social.skipped",
      "warning",
      "Authenticated social collection was skipped because the dedicated runner profile is not fully configured.",
      { required: ["OPENCLI_BIN", "OPENCLI_PROFILE", "RETURNER_LINKEDIN_VIEWER_PROFILE", "RETURNER_INSTAGRAM_VIEWER_HANDLE"] }
    );
    const skippedReplayState = reduceLinkedInReplayState(
      createLinkedInReplayState(
        AUTONOMOUS_BATCHES.map((batch) => batch.slug),
        { durableLockConfigured: false }
      ),
      { type: "configuration_skipped", reason: "runner_profile_not_configured" }
    );
    return {
      status: "skipped",
      reason: "runner_profile_not_configured",
      batches: [],
      linkedinReplay: createLinkedInReplayResult({ ...skippedReplayState, status: "skipped" })
    };
  }

  const batches = [];
  const linkedinReady = Boolean(
    cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
    cleanEnv(process.env.LINKEDIN_GLOBAL_LOCK_NAMESPACE)
  );
  let replayState = createLinkedInReplayState(
    AUTONOMOUS_BATCHES.map((batch) => batch.slug),
    { durableLockConfigured: linkedinReady }
  );
  if (!linkedinReady) {
    replayState = reduceLinkedInReplayState(replayState, {
      type: "configuration_skipped",
      reason: "durable_linkedin_lock_not_configured"
    });
  }
  for (const batch of AUTONOMOUS_BATCHES) {
    const outputPath = loggedInOutputs.get(batch.slug);
    const checkpointPath = loggedInCheckpointOutputs.get(batch.slug);
    const commonArgs = [
      sourcePath("scripts", "fetch-logged-in-social-traction.mjs"),
      `--batch=${batch.slug}`,
      "--entities=all",
      "--limit=100",
      "--scrolls=30",
      "--timeout-ms=90000",
      `--output-path=${outputPath}`,
      `--checkpoint-path=${checkpointPath}`
    ];
    const instagramWorkers = historicalReplay ? 2 : 1;
    const instagram = await runAuthenticatedCollectorCommand(
      batch.slug,
      "instagram",
      [
        ...commonArgs,
        `--workers=${instagramWorkers}`,
        "--platforms=instagram",
        "--delay-ms=1800"
      ]
    );

    let linkedin;
    if (!linkedinReady) {
      linkedin = { status: "skipped", reason: "durable_linkedin_lock_not_configured" };
    } else if (replayState.halted) {
      linkedin = {
        status: "skipped",
        reason: replayState.safetyStopped
          ? "linkedin_safety_stop_propagated"
          : replayState.infrastructureStopped
            ? "linkedin_infrastructure_stop_propagated"
            : "linkedin_replay_stopped",
        replayHalted: true
      };
    } else if (!historicalReplay) {
      linkedin = await runAuthenticatedCollectorCommand(
        batch.slug,
        "linkedin",
        [
          ...commonArgs,
          "--workers=1",
          "--platforms=linkedin",
          "--allow-linkedin",
          "--linkedin-mode=browser",
          `--linkedin-max-targets=${LINKEDIN_REPLAY_TARGET_CAP}`,
          "--delay-ms=30000"
        ]
      );
    } else {
      linkedin = await runAuthenticatedLinkedInReplayBatch({
        batch,
        commonArgs,
        replayState
      });
      replayState = linkedin.replayState;
      delete linkedin.replayState;
    }
    if (!linkedinReady) {
      await event(
        "authenticated_social.linkedin_skipped",
        "warning",
        "Authenticated LinkedIn collection was safety-skipped because its durable global account lock is not configured.",
        { batchSlug: batch.slug, required: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LINKEDIN_GLOBAL_LOCK_NAMESPACE"] }
      );
    }
    batches.push({ batchSlug: batch.slug, instagram, linkedin });
  }
  const linkedinReplay = createLinkedInReplayResult({
    ...replayState,
    status: !historicalReplay
      ? "not_applicable"
      : replayState.configurationSkipped
        ? "skipped"
        : replayState.safetyStopped || replayState.infrastructureStopped
          ? "stopped"
          : replayState.chunkBudgetExhausted || replayState.deadlineExhausted
            ? "incomplete"
            : linkedInReplayIsComplete(replayState)
              ? "completed"
              : "incomplete",
    batches
  });
  await event(
    "authenticated_social.linkedin_replay.finished",
    linkedinReplay.safetyStopped || linkedinReplay.infrastructureStopped ? "warning" : "info",
    "Authenticated LinkedIn historical replay finished with bounded sequential chunks.",
    linkedinReplay
  );
  return {
    status: historicalReplay && linkedinReplay.status !== "completed" ? "partial" : "completed",
    historicalReplay,
    batches,
    linkedinReplay
  };
}

function createLinkedInReplayState(batchSlugs = [], { durableLockConfigured = true } = {}) {
  return {
    halted: false,
    chunksAdmitted: 0,
    chunksAttempted: 0,
    chunksCompleted: 0,
    targetCapacityAdmitted: 0,
    remainingByBatch: Object.fromEntries(batchSlugs.map((batchSlug) => [batchSlug, null])),
    durableLockConfigured,
    configurationSkipped: false,
    chunkBudgetExhausted: false,
    deadlineExhausted: false,
    safetyStopped: false,
    infrastructureStopped: false,
    stopBatchSlug: null,
    stopError: null
  };
}

function reduceLinkedInReplayState(state, eventValue) {
  const next = {
    ...state,
    remainingByBatch: { ...(state.remainingByBatch ?? {}) }
  };
  if (eventValue.type === "plan") {
    next.remainingByBatch[eventValue.batchSlug] = eventValue.runnableTargetCount;
    return next;
  }
  if (eventValue.type === "chunk_admitted") {
    next.chunksAdmitted += 1;
    next.chunksAttempted += 1;
    next.targetCapacityAdmitted += LINKEDIN_REPLAY_TARGET_CAP;
    // The plan count was exact immediately before admission, but the child may
    // persist any subset before returning. It is unknown until the next plan.
    next.remainingByBatch[eventValue.batchSlug] = null;
    return next;
  }
  if (eventValue.type === "chunk_completed") {
    next.chunksCompleted += 1;
    return next;
  }
  if (eventValue.type === "configuration_skipped") {
    next.halted = true;
    next.configurationSkipped = true;
    next.durableLockConfigured = false;
    next.stopError = eventValue.reason ?? "durable_linkedin_lock_not_configured";
    return next;
  }
  if (eventValue.type === "chunk_budget_exhausted") {
    next.halted = true;
    next.chunkBudgetExhausted = true;
    next.stopBatchSlug = eventValue.batchSlug;
    return next;
  }
  if (eventValue.type === "deadline_exhausted") {
    next.halted = true;
    next.deadlineExhausted = true;
    next.stopBatchSlug = eventValue.batchSlug;
    return next;
  }
  if (eventValue.type === "safety_stop") {
    next.halted = true;
    next.safetyStopped = true;
    next.stopBatchSlug = eventValue.batchSlug;
    next.stopError = eventValue.error ?? null;
    return next;
  }
  if (eventValue.type === "infrastructure_failure") {
    next.halted = true;
    next.infrastructureStopped = true;
    next.stopBatchSlug = eventValue.batchSlug;
    next.stopError = eventValue.error ?? null;
    return next;
  }
  throw new Error(`Unknown LinkedIn replay state event: ${eventValue.type}`);
}

function linkedInReplayIsComplete(state) {
  const remaining = Object.values(state.remainingByBatch ?? {});
  return state.durableLockConfigured === true &&
    state.configurationSkipped !== true &&
    state.halted !== true &&
    remaining.length > 0 &&
    remaining.every((count) => count === 0);
}

function decideLinkedInReplayAdmission({
  runnableTargetCount,
  admittedChunks,
  remainingMs,
  reserveMs = LINKEDIN_REPLAY_RESERVE_MS,
  drainHeadroomMs = AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs,
  maxChunks = LINKEDIN_REPLAY_MAX_CHUNKS
}) {
  const runnable = Number(runnableTargetCount);
  const chunksAdmitted = Number(admittedChunks);
  const remaining = Number(remainingMs);
  if (!Number.isSafeInteger(runnable) || runnable < 0) {
    throw new RangeError("LinkedIn replay runnableTargetCount must be a nonnegative safe integer.");
  }
  if (!Number.isSafeInteger(chunksAdmitted) || chunksAdmitted < 0) {
    throw new RangeError("LinkedIn replay admittedChunks must be a nonnegative safe integer.");
  }
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new RangeError("LinkedIn replay remainingMs must be a nonnegative finite number.");
  }
  if (runnable === 0) return { action: "advance-batch", runnableTargetCount: 0 };
  if (chunksAdmitted >= maxChunks) {
    return { action: "chunk-budget-exhausted", runnableTargetCount: runnable };
  }
  const requiredReserveMs = Number(reserveMs) + Number(drainHeadroomMs);
  if (!Number.isFinite(requiredReserveMs) || requiredReserveMs < 0) {
    throw new RangeError("LinkedIn replay reserve must be a nonnegative finite number.");
  }
  if (remaining < requiredReserveMs) {
    return {
      action: "deadline-exhausted",
      runnableTargetCount: runnable,
      remainingMs: remaining,
      requiredReserveMs
    };
  }
  return {
    action: "admit-chunk",
    runnableTargetCount: runnable,
    chunkNumber: chunksAdmitted + 1,
    maxChunks,
    targetCap: LINKEDIN_REPLAY_TARGET_CAP,
    requiredReserveMs
  };
}

function createLinkedInReplayResult({ status = "completed", batches = [], ...state }) {
  const remainingByBatch = { ...(state.remainingByBatch ?? {}) };
  const unknownRemainingBatches = Object.entries(remainingByBatch)
    .filter(([, count]) => !Number.isSafeInteger(count) || count < 0)
    .map(([batchSlug]) => batchSlug);
  const knownRemainingTargetCount = Object.values(remainingByBatch)
    .filter((count) => Number.isSafeInteger(count) && count >= 0)
    .reduce((total, count) => total + count, 0);
  const remainingTargetCountKnown = unknownRemainingBatches.length === 0;
  return {
    status,
    maxChunks: LINKEDIN_REPLAY_MAX_CHUNKS,
    targetCapPerChunk: LINKEDIN_REPLAY_TARGET_CAP,
    chunksAdmitted: state.chunksAdmitted ?? 0,
    chunksAttempted: state.chunksAttempted ?? 0,
    chunksCompleted: state.chunksCompleted ?? 0,
    targetCapacityAdmitted: state.targetCapacityAdmitted ?? 0,
    remainingTargetCount: remainingTargetCountKnown ? knownRemainingTargetCount : null,
    remainingTargetCountKnown,
    knownRemainingTargetCount,
    unknownRemainingBatches,
    remainingByBatch,
    durableLockConfigured: state.durableLockConfigured === true,
    configurationSkipped: state.configurationSkipped === true,
    chunkBudgetExhausted: state.chunkBudgetExhausted === true,
    deadlineExhausted: state.deadlineExhausted === true,
    safetyStopped: state.safetyStopped === true,
    infrastructureStopped: state.infrastructureStopped === true,
    stopBatchSlug: state.stopBatchSlug ?? null,
    stopError: state.stopError ?? null,
    batches
  };
}

function parseJsonFromChildStdout(stdout) {
  const source = String(stdout ?? "");
  const objectStart = source.indexOf("{");
  if (objectStart < 0) throw new Error("child stdout did not contain a JSON object");
  return JSON.parse(source.slice(objectStart).trim());
}

function linkedInReplayChildDeadlineAt({
  collectionDeadlineAt,
  reserveMs = LINKEDIN_REPLAY_RESERVE_MS,
  drainHeadroomMs = AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs
}) {
  const deadlineAt = Number(collectionDeadlineAt);
  const reserve = Number(reserveMs);
  const drain = Number(drainHeadroomMs);
  if (!Number.isFinite(deadlineAt)) {
    throw new RangeError("LinkedIn replay collection deadline must be finite.");
  }
  if (!Number.isFinite(reserve) || reserve < 0 || !Number.isFinite(drain) || drain < 0) {
    throw new RangeError("LinkedIn replay reserve and drain headroom must be nonnegative finite values.");
  }
  const childDeadlineAt = deadlineAt - reserve - drain;
  if (!Number.isFinite(childDeadlineAt)) {
    throw new RangeError("LinkedIn replay child deadline must be finite.");
  }
  return childDeadlineAt;
}

async function runAuthenticatedLinkedInReplayBatch({ batch, commonArgs, replayState }) {
  const batchResult = {
    status: "completed",
    chunks: [],
    finalPlan: null
  };
  let state = replayState;
  const linkedinArgs = [
    ...commonArgs,
    "--workers=1",
    "--platforms=linkedin",
    "--allow-linkedin",
    "--linkedin-mode=browser",
    `--linkedin-max-targets=${LINKEDIN_REPLAY_TARGET_CAP}`,
    "--delay-ms=30000",
    "--terminal-completed-platforms=linkedin"
  ];
  const childDeadlineAt = linkedInReplayChildDeadlineAt({
    collectionDeadlineAt: collectionBudget.deadlineAt,
    reserveMs: LINKEDIN_REPLAY_RESERVE_MS,
    drainHeadroomMs: AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs
  });

  while (!state.halted) {
    if (Date.now() >= childDeadlineAt) {
      state = reduceLinkedInReplayState(state, {
        type: "deadline_exhausted",
        batchSlug: batch.slug
      });
      batchResult.status = "deadline_exhausted";
      break;
    }
    const plan = await runAuthenticatedLinkedInPlan(
      batch.slug,
      linkedinArgs,
      { deadlineAt: childDeadlineAt }
    );
    if (plan.status !== "completed") {
      state = reduceLinkedInReplayState(state, {
        type: plan.status === "safety_stopped" ? "safety_stop" : "infrastructure_failure",
        batchSlug: batch.slug,
        error: plan.error ?? plan.reason
      });
      batchResult.status = plan.status;
      batchResult.finalPlan = plan.plan ?? null;
      break;
    }
    state = reduceLinkedInReplayState(state, {
      type: "plan",
      batchSlug: batch.slug,
      runnableTargetCount: plan.runnableTargetCount
    });
    batchResult.finalPlan = plan.plan;
    const admission = decideLinkedInReplayAdmission({
      runnableTargetCount: plan.runnableTargetCount,
      admittedChunks: state.chunksAdmitted,
      remainingMs: collectionBudget.remainingMs(),
      reserveMs: LINKEDIN_REPLAY_RESERVE_MS,
      drainHeadroomMs: AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs,
      maxChunks: LINKEDIN_REPLAY_MAX_CHUNKS
    });
    if (admission.action === "advance-batch") break;
    if (admission.action === "chunk-budget-exhausted") {
      state = reduceLinkedInReplayState(state, {
        type: "chunk_budget_exhausted",
        batchSlug: batch.slug
      });
      batchResult.status = "chunk_budget_exhausted";
      break;
    }
    if (admission.action === "deadline-exhausted") {
      state = reduceLinkedInReplayState(state, {
        type: "deadline_exhausted",
        batchSlug: batch.slug
      });
      batchResult.status = "deadline_exhausted";
      break;
    }

    state = reduceLinkedInReplayState(state, {
      type: "chunk_admitted",
      batchSlug: batch.slug
    });
    const chunkNumber = state.chunksAdmitted;
    const chunk = await runAuthenticatedCollectorCommand(
      batch.slug,
      "linkedin",
      linkedinArgs,
      { deadlineAt: childDeadlineAt }
    );
    await event(
      "authenticated_social.linkedin_chunk",
      chunk.status === "completed" ? "info" : "warning",
      `Authenticated LinkedIn replay chunk ${chunkNumber} finished for ${batch.slug}.`,
      {
        batchSlug: batch.slug,
        chunkNumber,
        status: chunk.status,
        exitCode: chunk.exitCode ?? null,
        targetCap: LINKEDIN_REPLAY_TARGET_CAP,
        maxChunks: LINKEDIN_REPLAY_MAX_CHUNKS,
        safetyStopped: chunk.status === "safety_stopped",
        infrastructureStopped: chunk.status === "failed"
      }
    );
    batchResult.chunks.push({
      chunkNumber,
      status: chunk.status,
      exitCode: chunk.exitCode ?? 0,
      targetCap: LINKEDIN_REPLAY_TARGET_CAP
    });
    state = reduceLinkedInReplayState(state, {
      type: chunk.status === "safety_stopped"
        ? "safety_stop"
        : chunk.status === "failed"
          ? "infrastructure_failure"
          : "chunk_completed",
      batchSlug: batch.slug,
      error: chunk.error,
      exitCode: chunk.exitCode
    });
    if (chunk.status !== "completed") {
      batchResult.status = chunk.status;
      // The plan-only scan is read-only and gives the receipt an exact
      // remaining count after a child has flushed its durable checkpoint.
      const finalPlan = Date.now() < childDeadlineAt
        ? await runAuthenticatedLinkedInPlan(
            batch.slug,
            linkedinArgs,
            { deadlineAt: childDeadlineAt }
          )
        : { status: "deadline_exhausted" };
      if (finalPlan.status === "completed") {
        state = reduceLinkedInReplayState(state, {
          type: "plan",
          batchSlug: batch.slug,
          runnableTargetCount: finalPlan.runnableTargetCount
        });
        batchResult.finalPlan = finalPlan.plan;
      }
      break;
    }
  }
  return { ...batchResult, replayState: state };
}

async function runAuthenticatedLinkedInPlan(batchSlug, linkedinArgs, { deadlineAt } = {}) {
  const result = await runAuthenticatedCollectorCommand(
    batchSlug,
    "linkedin",
    [...linkedinArgs, "--plan"],
    { planOnly: true, deadlineAt }
  );
  if (result.status !== "completed") return result;
  try {
    const plan = parseJsonFromChildStdout(result.stdout);
    const runnableTargetCount = Number(plan?.linkedinExecution?.remainingTargetCount);
    if (!Number.isSafeInteger(runnableTargetCount) || runnableTargetCount < 0) {
      throw new Error("LinkedIn plan-only child returned an invalid runnable target count.");
    }
    return { ...result, plan, runnableTargetCount };
  } catch (error) {
    return {
      status: "failed",
      error: `LinkedIn plan-only result was invalid: ${errorMessage(error)}`
    };
  }
}

async function runAuthenticatedCollectorCommand(
  batchSlug,
  platform,
  args,
  { planOnly = false, deadlineAt = collectionBudget.deadlineAt } = {}
) {
  try {
    const result = await runCommand(process.execPath, [
      ...args,
      ...collectorLaunchProvenanceArgs(createCollectorAttemptContext({
        kind: "authenticated_social",
        batchSlug
      }, 1))
    ], {
      timeoutMs: boundedCollectionTimeoutMs(
        planOnly
          ? LINKEDIN_REPLAY_PLAN_TIMEOUT_MS
          : AUTONOMOUS_PROCESS_BUDGETS.publicCollectorAttemptMs,
        `authenticated ${platform} ${batchSlug}`
      ),
      nodeHeapMb: COLLECTOR_NODE_HEAP_MB,
      deadlineAt,
      label: `authenticated ${platform} ${batchSlug}`,
      envCategory: "authenticated_social",
      env: { HOME: process.env.HOME },
      quiet: planOnly,
      cwd: root
    });
    return { status: "completed", exitCode: result.code, stdout: result.stdout };
  } catch (error) {
    const commandResult = error?.commandResult ?? {};
    const diagnostic = `${commandResult.stderr ?? ""}\n${commandResult.stdout ?? ""}\n${errorMessage(error)}`;
    const safetyStopped = platform === "linkedin" && (
      commandResult.code === 86 || /LINKEDIN_CHILD_SAFETY_STOP/.test(diagnostic)
    );
    const result = {
      status: safetyStopped ? "safety_stopped" : "failed",
      exitCode: Number.isInteger(commandResult.code) ? commandResult.code : null,
      error: errorMessage(error)
    };
    await event(
      safetyStopped ? "authenticated_social.linkedin_safety_stop" : "authenticated_social.failed",
      "warning",
      safetyStopped
        ? `Authenticated LinkedIn safety stop halted replay after ${batchSlug}; durable checkpoint output was retained.`
        : `Authenticated ${platform} collection failed for ${batchSlug}; durable prior evidence remains intact.`,
      { batchSlug, platform, ...result }
    );
    return result;
  }
}

async function runShardedPublicCollector({
  attemptContext,
  batchSlug,
  outputPath,
  shardCount,
  baseArgs
}) {
  const batchKey = batchSlug.toLowerCase();
  const shards = Array.from({ length: shardCount }, (_, shardIndex) => {
    const suffix = `shard-${shardIndex}-of-${shardCount}`;
    return {
      shardIndex,
      outputPath: join(collectorRoot, `public-${batchKey}-${suffix}.json`),
      checkpointPath: join(collectorRoot, `checkpoint-public-${batchKey}-${suffix}.json`),
      discoveryAttemptsPath: join(collectorRoot, `discovery-attempts-${batchKey}-${suffix}.json`),
      sourceDiscoveryPathsPath: join(collectorRoot, `source-discovery-paths-${batchKey}-${suffix}.json`),
      recentProofJournalDir: join(collectorRoot, "recent-window-journals", suffix)
    };
  });
  await Promise.all(shards.map((shard) => removeCollectorAttemptOutput(shard.outputPath)));
  // The batch-level ledgers were seeded from the canonical publication by
  // prepareBatchDiscoveryState(). Give each new shard that same learned state
  // without overwriting a shard's newer retry/resume ledger.
  const [batchDiscoveryAttempts, batchSourceDiscoveryPaths] = await Promise.all([
    readJson(discoveryAttemptOutputs.get(batchSlug), []),
    readJson(sourceDiscoveryPathOutputs.get(batchSlug), [])
  ]);
  await Promise.all(shards.flatMap((shard) => [
    seedShardLedger(shard.discoveryAttemptsPath, batchDiscoveryAttempts),
    seedShardLedger(shard.sourceDiscoveryPathsPath, batchSourceDiscoveryPaths)
  ]));
  // Wait for every shard to stop before retrying the cohort. Promise.all()
  // rejects as soon as one shard fails, which can leave sibling collectors
  // writing the same checkpoint paths while the retry starts.
  const shardResults = await Promise.allSettled(shards.map((shard) =>
    runWithPublicShardProcessSlot(() => runPublicCollectorWithCheckpointRecovery({
      batchSlug,
      shardIndex: shard.shardIndex,
      shardCount,
      outputPath: shard.outputPath,
      checkpointPath: shard.checkpointPath,
      args: [
        ...baseArgs,
        ...collectorLaunchProvenanceArgs(attemptContext),
        `--company-shard-count=${shardCount}`,
        `--company-shard-index=${shard.shardIndex}`,
        `--output=${shard.outputPath}`,
        `--checkpoint=${shard.checkpointPath}`,
        `--discovery-attempts=${shard.discoveryAttemptsPath}`,
        `--source-discovery-paths=${shard.sourceDiscoveryPathsPath}`,
        `--recent-proof-journal-dir=${shard.recentProofJournalDir}`
      ]
    }))
  ));
  const shardFailures = shardResults.flatMap((result, shardIndex) =>
    result.status === "rejected"
      ? [`shard ${shardIndex + 1}/${shardCount}: ${errorMessage(result.reason)}`]
      : []
  );
  if (shardFailures.length > 0) {
    throw new Error(
      `public ${batchSlug} shard collection failed after every sibling stopped: ${shardFailures.join("; ")}`
    );
  }
  const snapshots = await Promise.all(shards.map((shard) =>
    readFreshCollectorShard(shard.outputPath, {
      kind: "public",
      batchSlug,
      shardIndex: shard.shardIndex,
      shardCount,
      attemptContext
    })
  ));
  const recentCoverageCutoffs = new Set(
    snapshots.map((snapshot) => snapshot?.source?.recentCoverageCutoff).filter(Boolean)
  );
  if (recentCoverageCutoffs.size !== 1 ||
      snapshots.some((snapshot) => !snapshot?.source?.recentCoverageCutoff)) {
    throw new Error(
      `public ${batchSlug} shards did not preserve one immutable recent coverage cutoff.`
    );
  }
  const recentCoverageCutoff = [...recentCoverageCutoffs][0];
  const originalShardAttempts = snapshots.map((snapshot) => snapshot.source.autonomousAttempt);
  const aggregateAttempt = latestOriginalCollectorAttempt(originalShardAttempts);
  const merged = mergePublicEvidenceSnapshots(snapshots, {
    fetchedAt: latestCollectorFetchedAt(snapshots),
    durableStorageConfigured,
    allowVerifiedMetriclessEvidence: isVerifiedYouTubeNativeMetriclessEvidence
  });
  merged.source = {
    ...merged.source,
    // mergePublicEvidenceSnapshots() intentionally labels canonical/publication
    // snapshots as a merged export. This file is still the batch collector's
    // validated output, however, and runCollectorWithRetries() re-reads it
    // through the collector snapshot contract. Preserve that contract here so
    // successful sharded public rows are not incorrectly discarded as though
    // every collector had failed.
    label: "Public unauthenticated platform/page ingestion",
    batchSlug,
    shardCount,
    recentCoverageCutoff,
    // Keep one byte-for-byte collector-authored binding as the aggregate
    // identity and retain every original shard binding for provenance. The
    // merger never invents a nonce or rewrites a collector receipt.
    autonomousAttempt: aggregateAttempt,
    shardAttempts: originalShardAttempts
  };
  validateAutonomousCollectorSnapshot(merged, {
    kind: "public",
    batchSlug,
    notBefore: attemptContext.startedAtMs - COLLECTOR_SNAPSHOT_FILE_SKEW_MS,
    notAfter: attemptContext.notAfterMs,
    requireAttemptBinding: true,
    expectedAttemptId: attemptContext.attemptId,
    expectedCampaignKey: attemptContext.campaignKey,
    expectedExecutionNonce: executionCompletionNonce,
    expectedIdempotencyKey: idempotencyKey,
    expectedNotBefore: attemptContext.startedAtMs
  });
  await Promise.all([
    writeJsonAtomic(outputPath, merged),
    writeJsonAtomic(discoveryAttemptOutputs.get(batchSlug), merged.discoveryAttempts ?? []),
    writeJsonAtomic(sourceDiscoveryPathOutputs.get(batchSlug), merged.sourceDiscoveryPaths ?? [])
  ]);
}

async function seedShardLedger(path, canonicalRows) {
  const existing = await readJson(path, null);
  if (Array.isArray(existing)) return;
  await writeJsonAtomic(path, Array.isArray(canonicalRows) ? canonicalRows : []);
}

async function removeCollectorAttemptOutput(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function collectorCampaignKey() {
  return String(args.campaignKey ?? idempotencyKey);
}

function createCollectorAttemptContext(command, attempt) {
  const startedAtMs = Date.now();
  const hardDeadlineAt = Math.min(
    collectionBudget?.deadlineAt ?? runnerBudget.deadlineAt,
    runnerBudget.deadlineAt
  );
  return {
    attemptId: randomUUID(),
    attempt,
    campaignKey: collectorCampaignKey(),
    idempotencyKey,
    executionNonce: executionCompletionNonce,
    kind: command.kind,
    batchSlug: command.batchSlug,
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    notAfterMs: hardDeadlineAt + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS
  };
}

function collectorLaunchProvenanceArgs(attemptContext) {
  return [
    `--autonomous-attempt-nonce=${attemptContext.attemptId}`,
    `--autonomous-campaign-key=${attemptContext.campaignKey}`,
    `--autonomous-idempotency-key=${attemptContext.idempotencyKey}`,
    `--autonomous-run-nonce=${attemptContext.executionNonce}`,
    `--autonomous-not-before=${attemptContext.startedAt}`
  ];
}

function latestOriginalCollectorAttempt(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error("Collector shard provenance is missing.");
  }
  return bindings.reduce((latest, binding) =>
    Date.parse(binding.completedAt) > Date.parse(latest.completedAt) ? binding : latest
  );
}

async function readFreshCollectorShard(
  path,
  { kind, batchSlug, expectedSourcePath = null, shardIndex, shardCount, attemptContext }
) {
  let fileStat;
  let snapshot;
  try {
    [fileStat, snapshot] = await Promise.all([stat(path), readJson(path, null)]);
  } catch (error) {
    throw new Error(`${kind} ${batchSlug} shard ${shardIndex + 1}/${shardCount} is missing: ${errorMessage(error)}`);
  }
  if (!snapshot) {
    throw new Error(`${kind} ${batchSlug} shard ${shardIndex + 1}/${shardCount} did not write a snapshot.`);
  }
  const completedAtMs = fileStat.mtimeMs;
  const observedAtMs = Date.now();
  const notBefore = attemptContext.startedAtMs - COLLECTOR_SNAPSHOT_FILE_SKEW_MS;
  const notAfter = Math.min(
    attemptContext.notAfterMs,
    observedAtMs + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS
  );
  if (completedAtMs < notBefore) {
    throw new Error(`${kind} ${batchSlug} shard ${shardIndex + 1}/${shardCount} is stale.`);
  }
  if (completedAtMs > notAfter) {
    throw new Error(`${kind} ${batchSlug} shard ${shardIndex + 1}/${shardCount} has a future file timestamp.`);
  }
  const sourceShardCount = Number(snapshot?.source?.companyShardCount);
  const sourceShardIndex = Number(snapshot?.source?.companyShardIndex);
  if (sourceShardCount !== shardCount || sourceShardIndex !== shardIndex) {
    throw new Error(
      `${kind} ${batchSlug} shard ${shardIndex + 1}/${shardCount} carries foreign shard provenance.`
    );
  }
  validateAutonomousCollectorSnapshot(snapshot, {
    kind,
    batchSlug,
    expectedSourcePath,
    notBefore,
    notAfter,
    requireAttemptBinding: true,
    expectedAttemptId: attemptContext.attemptId,
    expectedCampaignKey: attemptContext.campaignKey,
    expectedExecutionNonce: attemptContext.executionNonce,
    expectedIdempotencyKey: attemptContext.idempotencyKey,
    expectedNotBefore: attemptContext.startedAtMs
  });
  const binding = snapshot.source.autonomousAttempt;
  if (binding.shardCount !== shardCount || binding.shardIndex !== shardIndex) {
    throw new Error(
      `${kind} ${batchSlug} shard ${shardIndex + 1}/${shardCount} carries a foreign collector-authored attempt shard.`
    );
  }
  return snapshot;
}

function latestCollectorFetchedAt(snapshots) {
  const timestamps = snapshots.map((snapshot) => Date.parse(snapshot.source.fetchedAt));
  const latest = Math.max(...timestamps);
  if (!Number.isFinite(latest)) throw new Error("Collector shard fetchedAt timestamps are invalid.");
  return new Date(latest).toISOString();
}

async function runShardedGithubCollector({
  attemptContext,
  batchSlug,
  outputPath,
  shardCount,
  totalCompanyCount,
  baseArgs
}) {
  const batchKey = batchSlug.toLowerCase();
  const shards = Array.from({ length: shardCount }, (_, shardIndex) => ({
    shardIndex,
    searchBudget: githubShardSearchBudget(totalCompanyCount, shardCount, shardIndex),
    outputPath: join(
      collectorRoot,
      `github-${batchKey}-shard-${shardIndex}-of-${shardCount}.json`
    )
  }));
  await Promise.all(shards.map((shard) => removeCollectorAttemptOutput(shard.outputPath)));
  // The GitHub search lane remains bounded to one worker per shard. Sharding
  // makes full-cohort discovery finish inside the process budget while every
  // output stays isolated, so a timed-out process can never clobber a sibling.
  // Wait for every sibling to stop before a retry begins.
  const shardResults = await Promise.allSettled(shards.map((shard) =>
    runWithGithubShardProcessSlot(() => runCommand(
      process.execPath,
      [
        ...baseArgs,
        ...collectorLaunchProvenanceArgs(attemptContext),
        `--company-shard-count=${shardCount}`,
        `--company-shard-index=${shard.shardIndex}`,
        `--max-searches=${shard.searchBudget}`,
        `--output=${shard.outputPath}`
      ],
      {
        timeoutMs: boundedCollectionTimeoutMs(
          AUTONOMOUS_PROCESS_BUDGETS.githubCollectorAttemptMs,
          `github ${batchSlug} shard ${shard.shardIndex + 1}/${shardCount}`
        ),
        nodeHeapMb: COLLECTOR_NODE_HEAP_MB,
        deadlineAt: collectionBudget.deadlineAt,
        label: `github ${batchSlug} shard ${shard.shardIndex + 1}/${shardCount}`,
        envCategory: "github_collector",
        cwd: root
      }
    ))
  ));
  const shardFailures = shardResults.flatMap((result, shardIndex) =>
    result.status === "rejected"
      ? [`shard ${shardIndex + 1}/${shardCount}: ${errorMessage(result.reason)}`]
      : []
  );
  if (shardFailures.length > 0) {
    throw new Error(
      `github ${batchSlug} shard collection failed after every sibling stopped: ${shardFailures.join("; ")}`
    );
  }
  const snapshots = await Promise.all(shards.map((shard) =>
    readFreshCollectorShard(shard.outputPath, {
      kind: "github",
      batchSlug,
      expectedSourcePath: AUTONOMOUS_BATCHES.find((batch) => batch.slug === batchSlug)?.githubSourcePath,
      shardIndex: shard.shardIndex,
      shardCount,
      attemptContext
    })
  ));
  const mergedFetchedAt = latestCollectorFetchedAt(snapshots);
  const merged = mergeGithubCollectorShards(snapshots, {
    batchSlug,
    shardCount,
    fetchedAt: mergedFetchedAt
  });
  const originalShardAttempts = snapshots.map((snapshot) => snapshot.source.autonomousAttempt);
  merged.source.autonomousAttempt = latestOriginalCollectorAttempt(originalShardAttempts);
  merged.source.shardAttempts = originalShardAttempts;
  validateAutonomousCollectorSnapshot(merged, {
    kind: "github",
    batchSlug,
    expectedSourcePath: AUTONOMOUS_BATCHES.find((batch) => batch.slug === batchSlug)?.githubSourcePath,
    notBefore: attemptContext.startedAtMs - COLLECTOR_SNAPSHOT_FILE_SKEW_MS,
    notAfter: attemptContext.notAfterMs,
    requireAttemptBinding: true,
    expectedAttemptId: attemptContext.attemptId,
    expectedCampaignKey: attemptContext.campaignKey,
    expectedExecutionNonce: executionCompletionNonce,
    expectedIdempotencyKey: idempotencyKey,
    expectedNotBefore: attemptContext.startedAtMs
  });
  await writeJsonAtomic(
    outputPath,
    merged
  );
}

function githubShardSearchBudget(totalCompanyCount, shardCount, shardIndex) {
  if (shardIndex >= totalCompanyCount) return 0;
  const shardCompanyCount = Math.floor(
    (totalCompanyCount - 1 - shardIndex) / shardCount
  ) + 1;
  // GitHub fallback issues at most two review-only queries per company.
  // Allocate the cohort-wide budget across disjoint shards so sharding
  // reduces wall time without multiplying search API traffic.
  return shardCompanyCount * 2;
}

function mergeGithubCollectorShards(
  snapshots,
  { batchSlug, shardCount, fetchedAt }
) {
  const mergedAccounts = snapshots.reduce(
    (merged, snapshot) => mergeGithubTractionSnapshots(merged, snapshot, { fetchedAt }),
    null
  );
  const firstSource = snapshots[0]?.source ?? {};
  const dedupeRows = (rows, keyForRow) => [
    ...new Map(rows.map((row) => [keyForRow(row), row])).values()
  ];
  const sourceChecks = dedupeRows(
    snapshots.flatMap((snapshot) => snapshot?.source?.discovery?.sourceChecks ?? []),
    (row) => JSON.stringify([
      row.entityType,
      row.entityId,
      row.sourceKind,
      row.sourceUrl
    ])
  );
  const searchFailures = dedupeRows(
    snapshots.flatMap((snapshot) => snapshot?.source?.discovery?.searchFailures ?? []),
    (row) => JSON.stringify([row.company, row.query, row.error ?? row.message])
  );
  const activeAccountMappings = dedupeRows(
    snapshots.flatMap((snapshot) => snapshot?.source?.activeAccountMappings ?? []),
    (row) => JSON.stringify([row.entityType, row.entityId, row.url])
  );
  const retiredAccountMappings = dedupeRows(
    snapshots.flatMap((snapshot) => snapshot?.source?.retiredAccountMappings ?? []),
    (row) => JSON.stringify([row.entityType, row.entityId, row.url])
  );
  const notes = [...new Set(
    snapshots.flatMap((snapshot) => snapshot?.source?.notes ?? [])
  )];
  const sumSource = (key) => snapshots.reduce(
    (total, snapshot) => total + Number(snapshot?.source?.[key] ?? 0),
    0
  );
  const sumDiscovery = (key) => snapshots.reduce(
    (total, snapshot) => total + Number(snapshot?.source?.discovery?.[key] ?? 0),
    0
  );
  return {
    ...mergedAccounts,
    source: {
      ...firstSource,
      fetchedAt,
      batchSlug,
      companyCount: sumSource("companyCount"),
      totalCompanyCount: Math.max(
        ...snapshots.map((snapshot) => Number(snapshot?.source?.totalCompanyCount ?? 0))
      ),
      companyShardCount: shardCount,
      targetCount: sumSource("targetCount"),
      fetchedCount: sumSource("fetchedCount"),
      activeAccountMappings,
      retiredAccountMappings,
      discovery: {
        explicitTargetCount: sumDiscovery("explicitTargetCount"),
        discoveredTargetCount: sumDiscovery("discoveredTargetCount"),
        websiteTargets: sumDiscovery("websiteTargets"),
        profileTargets: sumDiscovery("profileTargets"),
        officialSourceChecks: sourceChecks.length,
        sourceChecks,
        searchTargets: sumDiscovery("searchTargets"),
        searchConcurrency: snapshots.reduce(
          (total, snapshot) =>
            total + Number(snapshot?.source?.discovery?.searchConcurrency ?? 0),
          0
        ),
        searchesUsed: sumDiscovery("searchesUsed"),
        searchFailures
      },
      notes
    },
    attempts: Object.assign(
      {},
      ...snapshots.map((snapshot) => snapshot?.attempts ?? {})
    )
  };
}

async function runPublicCollectorWithCheckpointRecovery({
  batchSlug,
  shardIndex,
  shardCount,
  outputPath,
  checkpointPath,
  args
}) {
  try {
    return await runCommand(process.execPath, args, {
      timeoutMs: boundedCollectionTimeoutMs(
        AUTONOMOUS_PROCESS_BUDGETS.publicCollectorAttemptMs,
        `public ${batchSlug} shard ${shardIndex + 1}/${shardCount}`
      ),
      nodeHeapMb: COLLECTOR_NODE_HEAP_MB,
      deadlineAt: collectionBudget.deadlineAt,
      label: `public ${batchSlug} shard ${shardIndex + 1}/${shardCount}`,
      envCategory: "public_collector",
      cwd: root
    });
  } catch (error) {
    if (!/timed out after/i.test(errorMessage(error))) throw error;
    await event(
      "collector.timeout_checkpoint_flush",
      "warning",
      `public ${batchSlug} shard ${shardIndex + 1}/${shardCount} reached its process limit; flushing its durable checkpoint before coverage evaluation.`,
      { batchSlug, shardIndex, shardCount, outputPath, checkpointPath }
    );
    return runCommand(process.execPath, [...args, "--max-companies=0"], {
      timeoutMs: boundedCollectionDrainTimeoutMs(
        AUTONOMOUS_PROCESS_BUDGETS.collectorCheckpointFlushMs,
        `public ${batchSlug} shard ${shardIndex + 1}/${shardCount} checkpoint flush`
      ),
      nodeHeapMb: COLLECTOR_NODE_HEAP_MB,
      deadlineAt: collectionDrainBudget.deadlineAt,
      label: `public ${batchSlug} shard ${shardIndex + 1}/${shardCount} checkpoint flush`,
      envCategory: "public_collector",
      cwd: root
    });
  }
}

async function runTopVoiceCollector() {
  const batchSlug = AUTONOMOUS_BATCHES.map((batch) => batch.slug).join(",");
  const attemptContext = createCollectorAttemptContext(
    { kind: "top_voice", batchSlug },
    1
  );
  await removeCollectorAttemptOutput(topVoiceOutput);
  await event(
    "top_voice_collection.started",
    "info",
    "Insider and YC Partner discovery started alongside the batch collectors.",
    { audiences: ["insiders", "yc_partners"], batches: AUTONOMOUS_BATCHES.map((batch) => batch.slug) }
  );
  await runCommand(
    process.execPath,
    [
      "--experimental-strip-types",
      "--loader",
      sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
      sourcePath("scripts", "run-top-voice-ingestion.mjs"),
      `--output=${topVoiceOutput}`,
      `--root=${publicationArtifactRoot()}`,
      `--batches=${batchSlug}`,
      ...collectorLaunchProvenanceArgs(attemptContext),
      "--audiences=insiders,yc_partners",
      "--x-concurrency=16",
      "--max-posts-per-target=20",
      "--max-top-voice-x-targets=250",
      "--max-network-requests=2500",
      "--deadline-minutes=10"
    ],
    {
      timeoutMs: boundedCollectionTimeoutMs(
        AUTONOMOUS_PROCESS_BUDGETS.topVoiceCollectorMs,
        "Top Voice X discovery"
      ),
      nodeHeapMb: COLLECTOR_NODE_HEAP_MB,
      deadlineAt: collectionBudget.deadlineAt,
      label: "Top Voice X discovery",
      envCategory: "public_collector",
      env: { SCORING_DATA_ROOT: publicationArtifactRoot() },
      cwd: root
    }
  );
  const receipt = await readJson(topVoiceOutput, null);
  assertExactTopVoiceAttemptBinding(receipt?.autonomousAttempt, attemptContext, batchSlug);
  await event(
    "top_voice_collection.finished",
    "info",
    "Insider and YC Partner discovery reached a terminal state.",
    receipt ?? {}
  );
  return receipt;
}

async function resumeTopVoiceRefresh() {
  const result = await resumeValidatedSnapshotOrRun({
    resume: args.resumeSnapshots,
    readSnapshot: () => readJson(topVoiceOutput, null),
    validateSnapshot: (receipt) => {
      assertSuccessfulTopVoiceRefresh(receipt);
      const binding = receipt?.autonomousAttempt;
      if (
        !binding ||
        binding.campaignKey !== collectorCampaignKey() ||
        Date.parse(binding.completedAt) < Date.now() - COLLECTOR_RESUME_MAX_AGE_MS ||
        Date.parse(binding.completedAt) > Date.now() + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS
      ) {
        throw new Error("Top Voice discovery snapshot has stale, future, or foreign collector provenance.");
      }
    },
    runFresh: runTopVoiceCollector
  });
  if (result.resumed) {
    await event(
      "top_voice_collection.snapshot_resumed",
      "info",
      "Top Voice discovery resumed its validated terminal snapshot without repeating network collection.",
      {
        audiences: result.snapshot.audiences.map((audience) => audience.audience),
        evidenceCount: result.snapshot.isolatedEvidence.evidenceCount
      }
    );
  }
  return result.snapshot;
}

function assertExactTopVoiceAttemptBinding(binding, attemptContext, batchSlug) {
  const expected = {
    schemaVersion: 1,
    attemptId: attemptContext.attemptId,
    campaignKey: attemptContext.campaignKey,
    idempotencyKey: attemptContext.idempotencyKey,
    executionNonce: attemptContext.executionNonce,
    kind: "top_voice",
    batchSlug,
    shardIndex: 0,
    shardCount: 1,
    startedAt: attemptContext.startedAt
  };
  for (const [key, value] of Object.entries(expected)) {
    if (binding?.[key] !== value) {
      throw new Error(`Top Voice collector provenance does not match its launch (${key}).`);
    }
  }
  const completedAt = Date.parse(binding.completedAt);
  if (
    !Number.isFinite(completedAt) ||
    completedAt < attemptContext.startedAtMs ||
    completedAt > Math.min(attemptContext.notAfterMs, Date.now() + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS)
  ) {
    throw new Error("Top Voice collector provenance has a stale or future completion timestamp.");
  }
}

async function runCollectorWithRetries(command, maxAttempts = AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts) {
  if (args.resumeSnapshots) {
    let snapshot = null;
    try {
      snapshot = await readCollectorSnapshot(command.outputPath, command.kind, {
        batchSlug: command.batchSlug,
        expectedSourcePath: command.expectedSourcePath,
        notBefore: Date.now() - COLLECTOR_RESUME_MAX_AGE_MS,
        notAfter: Date.now() + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS,
        requireAttemptBinding: true,
        expectedCampaignKey: collectorCampaignKey()
      });
    } catch (error) {
      await event(
        "collector.snapshot_resume_rejected",
        "warning",
        `${command.kind} ${command.batchSlug} rejected an unbound, stale, future, or foreign resume snapshot.`,
        { error: errorMessage(error) }
      );
    }
    if (snapshot) {
      const retryableFailures = retryableFailuresFromSnapshot(snapshot);
      const terminalCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(snapshot, {
        kind: command.kind,
        batchSlug: command.batchSlug,
        tasks: plannedTasks
      });
      if (terminalCoverage.nonTerminal === 0 && retryableFailures.length === 0) {
        await event(
          "collector.snapshot_resumed",
          retryableFailures.length > 0 ? "warning" : "info",
          `${command.kind} ${command.batchSlug} resumed its validated terminal snapshot without repeating network collection.`,
          {
            retryableFailures: retryableFailures.length,
            successfulRows: successfulCollectorRowCount(snapshot, command.kind),
            terminalCoverage
          }
        );
        return {
          attempts: 0,
          retryableFailures: retryableFailures.length,
          exhaustedRetryableFailures: retryableFailures.length,
          successfulRows: successfulCollectorRowCount(snapshot, command.kind),
          terminalCoverage
        };
      }
    }
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let retryReasons = [];
    try {
      const attemptContext = createCollectorAttemptContext(command, attempt);
      command.latestAttemptContext = attemptContext;
      await removeCollectorAttemptOutput(command.outputPath);
      await command.run(attemptContext);
      attemptContext.notAfterMs = Date.now() + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS;
      const snapshot = await readCollectorSnapshot(command.outputPath, command.kind, {
        batchSlug: command.batchSlug,
        expectedSourcePath: command.expectedSourcePath,
        notBefore: attemptContext.startedAtMs - COLLECTOR_SNAPSHOT_FILE_SKEW_MS,
        notAfter: attemptContext.notAfterMs,
        requireAttemptBinding: true,
        expectedAttemptId: attemptContext.attemptId,
        expectedCampaignKey: attemptContext.campaignKey,
        expectedExecutionNonce: attemptContext.executionNonce
      });
      if (!snapshot) throw new Error(`${command.kind} ${command.batchSlug} did not write a collector snapshot.`);
      const retryableFailures = retryableFailuresFromSnapshot(snapshot);
      const terminalCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(snapshot, {
        kind: command.kind,
        batchSlug: command.batchSlug,
        tasks: plannedTasks
      });
      if (retryableFailures.length === 0 && terminalCoverage.nonTerminal === 0) {
        return {
          attempts: attempt,
          retryableFailures: retryableFailures.length,
          exhaustedRetryableFailures: 0,
          successfulRows: successfulCollectorRowCount(snapshot, command.kind),
          terminalCoverage
        };
      }
      retryReasons = [
        ...retryableFailures,
        ...(terminalCoverage.nonTerminal > 0
          ? [`${terminalCoverage.nonTerminal}/${terminalCoverage.expected} planned task(s) lack explicit terminal outcomes.`]
          : [])
      ];
      if (attempt === maxAttempts) {
        if (terminalCoverage.nonTerminal > 0) {
          await event(
            "collector.retry_exhausted",
            "error",
            `${command.kind} ${command.batchSlug} exhausted retries before explicit task coverage was complete.`,
            { attempt, maxAttempts, retryableFailures, terminalCoverage }
          );
          throw new Error(
            `${command.kind} ${command.batchSlug} exhausted retries with ` +
            `${terminalCoverage.nonTerminal}/${terminalCoverage.expected} planned task(s) lacking explicit terminal outcomes.`
          );
        }
        await event(
          "collector.retry_exhausted",
          "warning",
          `${command.kind} ${command.batchSlug} exhausted retryable failures after every planned task reached an explicit terminal outcome.`,
          { attempt, maxAttempts, exhaustedRetryableFailures: retryableFailures, terminalCoverage }
        );
        return {
          attempts: attempt,
          retryableFailures: retryableFailures.length,
          exhaustedRetryableFailures: retryableFailures.length,
          successfulRows: successfulCollectorRowCount(snapshot, command.kind),
          terminalCoverage
        };
      }
      await event("collector.retry_scheduled", "warning", `${command.kind} ${command.batchSlug} requires another attempt.`, {
        attempt,
        maxAttempts,
        retryableFailures,
        terminalCoverage
      });
    } catch (error) {
      lastError = error;
      retryReasons = retryReasons.length ? retryReasons : [errorMessage(error)];
      if (attempt === maxAttempts) throw error;
      await event("collector.retry_scheduled", "warning", `${command.kind} ${command.batchSlug} process failed.`, {
        attempt,
        maxAttempts,
        error: errorMessage(error)
      });
    }
    const rateLimited = retryReasons.some((reason) =>
      /(?:rate.?limit|secondary.?limit|\b403\b|forbidden|\b429\b)/i.test(String(reason))
    );
    const retryDelayMs = rateLimited
      ? AUTONOMOUS_PROCESS_BUDGETS.collectorRateLimitRetryDelayMs
      : Math.min(
          AUTONOMOUS_PROCESS_BUDGETS.collectorRetryDelayMaxMs,
          1_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 1_000)
        );
    await delay(boundedCollectionDelayMs(
      retryDelayMs,
      `${command.kind} ${command.batchSlug} retry backoff`
    ));
  }
  throw lastError ?? new Error(`${command.kind} ${command.batchSlug} exhausted retries.`);
}

function retryableFailuresFromSnapshot(snapshot) {
  return autonomousCollectorRetryableFailures(snapshot);
}

function successfulCollectorRowCount(snapshot, kind) {
  return countSuccessfulAutonomousCollectorRows(snapshot, kind);
}

async function reconcileCollectorTasks(results, catalogState) {
  const updateGroups = new Map();
  for (const result of results) {
    const platforms = result.kind === "github"
      ? ["github"]
      : ["x", "instagram", "linkedin", "youtube", "product_hunt", "reddit", "hacker_news", "rss", "web"];
    const snapshot = await readCollectorSnapshot(result.outputPath, result.kind, result);
    const outcomeIndex = snapshot
      ? indexAutonomousCollectorTaskOutcomes(snapshot, {
          kind: result.kind,
          batchSlug: result.batchSlug
        })
      : null;
    for (const platform of platforms) {
      const tasks = await tasksFor(result.batchSlug, platform, catalogState);
      for (const task of tasks) {
        const plannedTask = plannedTaskByCheckpointKey.get(task.checkpoint_key);
        const outcome = classifyAutonomousCollectorTaskOutcome(outcomeIndex, {
          platform,
          entityType: plannedTask?.entityType ?? task.entity_type,
          entityId: plannedTask?.entitySourceKey ?? task.company_name,
          accountUrl: plannedTask?.account?.url ?? null,
          collectorOk: result.ok,
          collectorError: result.error
        });
        const { status, reason } = outcome;
        if (status === "nonterminal") continue;
        const groupKey = JSON.stringify([status, reason, result.attempts]);
        const group = updateGroups.get(groupKey) ?? { ids: [], status, reason, attempts: result.attempts };
        group.ids.push(task.id);
        updateGroups.set(groupKey, group);
      }
    }
  }
  const updates = [...updateGroups.values()].flatMap((group) =>
    chunks(group.ids, 100).map((ids) => ({ ...group, ids }))
  );
  await mapWithConcurrency(updates, 4, ({ ids, status, reason, attempts }) =>
    finishTasks(ids, status, reason, attempts)
  );
}

async function tasksFor(batchSlug, platform, catalogState) {
  const tasks = await readAllIngestionTaskRows(
    `read ${batchSlug}/${platform} tasks`,
    "id,company_name,entity_type,status,checkpoint_key",
    (query) => query
      .eq("ingestion_run_id", run.id)
      .eq("batch_id", catalogState.batchBySlug.get(batchSlug))
      .eq("platform", platform)
      .eq("status", "queued")
  );
  return tasks.filter((task) => plannedTaskByCheckpointKey.has(task.checkpoint_key));
}

async function readAllIngestionTaskRows(label, columns, configureQuery) {
  const rows = [];
  let lastSeenId = null;
  let pageSize = INGESTION_TASK_READ_PAGE_SIZE;
  let successfulPagesAtCurrentSize = 0;
  for (let pageNumber = 1; ; pageNumber += 1) {
    let pageResult = null;
    for (let attempt = 1; attempt <= INGESTION_TASK_READ_MAX_ATTEMPTS; attempt += 1) {
      try {
        pageResult = await runSupabaseOperation(
          `${label} page ${pageNumber} attempt ${attempt}`,
          () => {
            let query = configureQuery(
              supabase.from("ingestion_tasks").select(columns)
            )
              .order("id", { ascending: true })
              .limit(pageSize);
            if (lastSeenId) query = query.gt("id", lastSeenId);
            return query;
          }
        );
      } catch (error) {
        if (!isRetryableIngestionTaskReadError(error) || attempt === INGESTION_TASK_READ_MAX_ATTEMPTS) {
          throw error;
        }
        pageSize = reducedIngestionTaskReadPageSize(pageSize);
        successfulPagesAtCurrentSize = 0;
        await delay(250 * attempt);
        continue;
      }
      if (!pageResult.error || !isRetryableIngestionTaskReadError(pageResult.error)) break;
      if (attempt === INGESTION_TASK_READ_MAX_ATTEMPTS) break;
      pageSize = reducedIngestionTaskReadPageSize(pageSize);
      successfulPagesAtCurrentSize = 0;
      await delay(250 * attempt);
    }
    check(pageResult?.error, label);
    const pageRows = pageResult?.data ?? [];
    if (pageRows.length === 0) break;
    const nextLastSeenId = pageRows.at(-1)?.id;
    if (typeof nextLastSeenId !== "string" || !nextLastSeenId || nextLastSeenId === lastSeenId) {
      throw new Error(`Failed to ${label}: ingestion task cursor did not advance.`);
    }
    rows.push(...pageRows);
    lastSeenId = nextLastSeenId;
    successfulPagesAtCurrentSize += 1;
    if (
      pageSize < INGESTION_TASK_READ_PAGE_SIZE &&
      successfulPagesAtCurrentSize >= INGESTION_TASK_READ_SUCCESS_PAGES_BEFORE_GROWTH
    ) {
      pageSize = Math.min(INGESTION_TASK_READ_PAGE_SIZE, pageSize * 2);
      successfulPagesAtCurrentSize = 0;
    }
  }
  return rows;
}

function reducedIngestionTaskReadPageSize(pageSize) {
  return Math.max(
    INGESTION_TASK_READ_MIN_PAGE_SIZE,
    Math.floor(pageSize / 2)
  );
}

function isRetryableIngestionTaskReadError(error) {
  const codes = [error?.code, error?.cause?.code]
    .map((value) => String(value ?? ""))
    .filter(Boolean);
  if (terminationSignal || codes.includes("AUTONOMOUS_RUNNER_BUDGET_EXCEEDED")) return false;
  const names = [error?.name, error?.cause?.name]
    .map((value) => String(value ?? ""))
    .filter(Boolean);
  const message = [error?.message, error?.cause?.message]
    .map((value) => String(value ?? ""))
    .filter(Boolean)
    .join(" ");
  const retryableCodes = new Set([
    "57014",
    "LIFECYCLE_OPERATION_TIMEOUT",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT"
  ]);
  return codes.some((code) => retryableCodes.has(code))
    || names.some((name) => name === "AbortError" || name === "TimeoutError")
    || /canceling statement due to statement timeout|statement timeout/i.test(message)
    || /\b(?:connection|connect|request|network|socket|upstream|gateway) timed? out\b/i.test(message)
    || /\b(?:socket hang up|connection reset by peer)\b/i.test(message);
}

async function finishTasks(ids, status, reason, attempts = 1) {
  if (ids.length === 0) return;
  const terminalAt = new Date().toISOString();
  const { error } = await runSupabaseOperation(
    `finish ${ids.length} ingestion tasks`,
    () => supabase
      .from("ingestion_tasks")
      .update({
        status,
        attempts,
        last_attempt_at: terminalAt,
        terminal_at: terminalAt,
        terminal_reason: reason,
        last_failure_kind: status === "failed" ? "collector_failure" : null,
        last_error: status === "failed" ? reason : null,
        last_error_json: status === "failed" ? { reason } : {}
      })
      .in("id", ids)
      .eq("status", "queued")
  );
  check(error, `finish ${ids.length} ingestion tasks`);
}

async function terminalizeQueuedTasks(runId, status, reason) {
  const { error } = await runSupabaseOperation(
    "terminalize skipped network tasks",
    () => supabase
      .from("ingestion_tasks")
      .update({ status, terminal_at: new Date().toISOString(), terminal_reason: reason })
      .eq("ingestion_run_id", runId)
      .eq("status", "queued")
  );
  check(error, "terminalize skipped network tasks");
}

async function importDurableEvidence({
  publicSnapshots,
  githubSnapshots,
  catalogState,
  attributionReconciliationLedger = []
}) {
  if (!durableStorageConfigured) {
    return {
      status: "skipped",
      configured: false,
      reason: "supabase_not_configured",
      received: publicSnapshots.length + githubSnapshots.length
    };
  }
  if (!catalogState || !run?.id) {
    throw new Error("Durable Supabase import is configured but its catalog or run state is unavailable.");
  }
  if (publicSnapshots.length === 0 && githubSnapshots.length === 0) {
    return {
      status: "completed",
      configured: true,
      received: 0,
      rejected: 0,
      duplicates: 0,
      stored: 0,
      readBack: 0,
      attributions: { stored: 0, duplicates: 0, unresolved: 0 },
      metricObservations: { stored: 0, duplicates: 0 },
      rejections: []
    };
  }
  const companyAliasesByBatch = new Map();
  const founderAliasesByBatch = new Map();
  const founderBatchSlugsById = new Map();
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      const companyId = catalogState.companyByBatchSourceKey.get(
        batchCompanyKey(catalog.slug, company.sourceKey)
      );
      for (const alias of [
        company.sourceKey,
        plannedCompanySlug(company),
        company.name,
        company.sourceKey.replace(/^company[:-]/, ""),
        company.sourceKey.replace(/^a16z-speedrun-006[:-]/, ""),
        ...(company.legacyEntityAliases ?? [])
      ]) {
        if (alias) companyAliasesByBatch.set(batchCompanyKey(catalog.slug, alias), companyId);
      }
      for (const founder of [
        ...company.founders,
        ...(company.historicalFounders ?? [])
      ]) {
        const founderKey = batchCompanyKey(catalog.slug, founder.sourceKey);
        const founderId = catalogState.founderByBatchSourceKey.get(founderKey) ??
          catalogState.historicalFounderByBatchSourceKey?.get(founderKey);
        if (!founderId) {
          throw new Error(
            `No durable founder identity was returned for ${catalog.slug}/${founder.sourceKey}.`
          );
        }
        const founderBatches = founderBatchSlugsById.get(founderId) ?? new Set();
        founderBatches.add(catalog.slug);
        founderBatchSlugsById.set(founderId, founderBatches);
        for (const alias of [
          founder.sourceKey,
          founder.name,
          ...(founder.legacyEntityAliases ?? [])
        ]) {
          if (alias) founderAliasesByBatch.set(batchCompanyKey(catalog.slug, alias), founderId);
        }
      }
    }
  }
  // Mutable rosters can remove a founder while canonical evidence still
  // truthfully refers to that historical member. Always hydrate exact durable
  // batch/entity identities; this must not depend on an unrelated active
  // reconciliation directive being present in the current artifact.
  const historicalAttributionCatalog = await readHistoricalAttributionCatalogMaps(catalogState);
  for (const [key, companyId] of historicalAttributionCatalog.companyByBatchEntityId) {
    if (!companyAliasesByBatch.has(key)) companyAliasesByBatch.set(key, companyId);
  }
  for (const [key, founderId] of historicalAttributionCatalog.founderByBatchEntityId) {
    if (!founderAliasesByBatch.has(key)) founderAliasesByBatch.set(key, founderId);
  }
  for (const [founderId, historicalBatches] of historicalAttributionCatalog.founderBatchSlugsById) {
    const batchesForFounder = founderBatchSlugsById.get(founderId) ?? new Set();
    for (const batchSlug of historicalBatches) batchesForFounder.add(batchSlug);
    founderBatchSlugsById.set(founderId, batchesForFounder);
  }
  const result = await runSupabaseOperation(
    "import durable evidence snapshots",
    (signal) => importEvidenceSnapshots({
      client: createAbortBoundSupabaseClient(supabase, signal),
      ingestionRunId: run.id,
      requireCompleteAttribution: true,
      publicSnapshots,
      githubSnapshots,
      attributionReconciliationLedger,
      catalog: {
        batchBySlug: catalogState.batchBySlug,
        companyByBatchEntityId: companyAliasesByBatch,
        companyByBatchSlug: companyAliasesByBatch,
        founderByBatchEntityId: founderAliasesByBatch,
        founderBatchCountById: new Map(
          [...founderBatchSlugsById].map(([founderId, batchSlugs]) => [founderId, batchSlugs.size])
        )
      }
    }),
    { timeoutMs: SUPABASE_BULK_OPERATION_TIMEOUT_MS }
  );
  return { status: "completed", configured: true, ...result };
}

async function readHistoricalAttributionCatalogMaps(catalogState) {
  const batchIdsBySlug = new Map(catalogState.batchBySlug);
  const batchIds = [...new Set(batchIdsBySlug.values())].filter(Boolean);
  const empty = {
    companyByBatchEntityId: new Map(),
    founderByBatchEntityId: new Map(),
    founderBatchSlugsById: new Map()
  };
  if (batchIds.length === 0) return empty;

  const companyRows = await readHistoricalAttributionRows(
    "read historical company identities for attribution reconciliation",
    batchIds,
    (ids) => supabase
      .from("companies")
      .select("id,batch_id,source_key")
      .in("batch_id", ids)
  );
  const companiesById = new Map((companyRows ?? []).map((row) => [row.id, row]));
  const companyByBatchEntityId = new Map();
  const batchSlugById = new Map([...batchIdsBySlug].map(([slug, id]) => [id, slug]));
  for (const company of companyRows ?? []) {
    const batchSlug = batchSlugById.get(company.batch_id);
    if (batchSlug && company.source_key) {
      companyByBatchEntityId.set(`${batchSlug}\u0000${company.source_key}`, company.id);
    }
  }
  if (companiesById.size === 0) return { ...empty, companyByBatchEntityId };

  const relationshipRows = await readHistoricalAttributionRows(
    "read historical founder relationships for attribution reconciliation",
    [...companiesById.keys()],
    (companyIds) => supabase
      .from("company_founders")
      .select("company_id,founder_id")
      .in("company_id", companyIds)
  );
  const founderIds = [...new Set((relationshipRows ?? []).map((row) => row.founder_id).filter(Boolean))];
  if (founderIds.length === 0) {
    return { ...empty, companyByBatchEntityId };
  }

  const founderRows = await readHistoricalAttributionRows(
    "read historical founder identities for attribution reconciliation",
    founderIds,
    (ids) => supabase
      .from("founders")
      .select("id,source_key")
      .in("id", ids)
  );
  const foundersById = new Map((founderRows ?? []).map((row) => [row.id, row]));
  const founderByBatchEntityId = new Map();
  const founderBatchSlugsById = new Map();
  for (const relationship of relationshipRows ?? []) {
    const company = companiesById.get(relationship.company_id);
    const founder = foundersById.get(relationship.founder_id);
    const batchSlug = batchSlugById.get(company?.batch_id);
    if (!batchSlug || !founder?.source_key) continue;
    founderByBatchEntityId.set(`${batchSlug}\u0000${founder.source_key}`, founder.id);
    const batchesForFounder = founderBatchSlugsById.get(founder.id) ?? new Set();
    batchesForFounder.add(batchSlug);
    founderBatchSlugsById.set(founder.id, batchesForFounder);
  }
  return { companyByBatchEntityId, founderByBatchEntityId, founderBatchSlugsById };
}

function runHistoricalAttributionRead(label, createOperation) {
  return runHistoricalAttributionReadWithAttempts(
    label,
    createOperation,
    HISTORICAL_ATTRIBUTION_READ_ATTEMPTS
  );
}

async function readHistoricalAttributionRows(label, values, createOperation) {
  const rows = [];
  const valueChunks = chunks(values, HISTORICAL_ATTRIBUTION_READ_BATCH_SIZE);
  for (const [index, valueChunk] of valueChunks.entries()) {
    const result = await runHistoricalAttributionRead(
      `${label} chunk ${index + 1}/${valueChunks.length}`,
      () => createOperation(valueChunk)
    );
    rows.push(...(result?.data ?? []));
  }
  return rows;
}

function isRetryableHistoricalAttributionReadError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    /network|timed out|timeout|econnreset|econnrefused|enotfound|socket/.test(message)
  );
}

async function runHistoricalAttributionReadWithAttempts(label, createOperation, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runSupabaseOperation(label, createOperation);
      if (!result?.error) return result;
      if (
        !isRetryableHistoricalAttributionReadError(result.error) ||
        attempt === attempts
      ) {
        return result;
      }
      lastError = result.error;
    } catch (error) {
      if (!isRetryableHistoricalAttributionReadError(error) || attempt === attempts) {
        throw error;
      }
      lastError = error;
    }
    const retryDelayMs = 1000 * attempt;
    console.warn(
      `${label} failed on attempt ${attempt}/${attempts}; ` +
      `retrying in ${retryDelayMs}ms: ${sanitizedRunnerFailure(lastError).message}`
    );
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw lastError;
}

function assertDurableAttributionCompleteness(importResult) {
  if (
    importResult.status === "completed" &&
    importResult.configured === true &&
    (importResult.attributions?.unresolved ?? 0) > 0
  ) {
    throw new Error(
      `Durable evidence import has ${importResult.attributions.unresolved} unresolved_attribution row(s); ` +
      "publication is prohibited."
    );
  }
}

async function summarizeCollectionCoverage(tasks, collectionResults, { skipNetwork }) {
  const resultByCollector = new Map(
    collectionResults.map((result) => [`${result.batchSlug}:${result.kind}`, result])
  );
  const outcomeIndexByCollector = new Map();
  for (const result of collectionResults) {
    const snapshot = await readCollectorSnapshot(result.outputPath, result.kind, result);
    outcomeIndexByCollector.set(
      `${result.batchSlug}:${result.kind}`,
      snapshot
        ? indexAutonomousCollectorTaskOutcomes(snapshot, {
            kind: result.kind,
            batchSlug: result.batchSlug,
            explicitTerminalOnly: true
          })
        : null
    );
  }

  const report = {
    expected: tasks.length,
    attempted: 0,
    succeeded: 0,
    needsReview: 0,
    blockedOrEmpty: 0,
    failed: 0,
    skipped: 0,
    nonTerminal: 0,
    mappedExpected: tasks.filter((task) => task.status === "queued" && Boolean(task.account)).length,
    mappedSucceeded: 0,
    mappedNeedsReview: 0,
    mappedBlockedOrEmpty: 0,
    providerBlocked: 0,
    providerBlockedByReason: {},
    mappedProviderBlocked: 0,
    mappedProviderBlockedByReason: {},
    mappedScopeUnsupported: 0,
    mappedFailed: 0,
    mappedNonTerminal: 0,
    mappedFailureSamples: [],
    coveragePercentage: 0,
    generatedAt: new Date().toISOString()
  };
  for (const task of tasks) {
    if (skipNetwork) {
      report.skipped += 1;
      continue;
    }
    if (task.status !== "queued") {
      if (task.status === "needs_review") report.needsReview += 1;
      else if (task.status === "blocked_or_empty") report.blockedOrEmpty += 1;
      else if (task.status === "failed") report.failed += 1;
      else report.skipped += 1;
      continue;
    }
    const kind = task.platform === "github" ? "github" : "public";
    const collectorKey = `${task.batchSlug}:${kind}`;
    const result = resultByCollector.get(collectorKey);
    if (!result) {
      report.nonTerminal += 1;
      if (task.account) report.mappedNonTerminal += 1;
      continue;
    }
    const outcome = classifyAutonomousCollectorTaskOutcome(
      outcomeIndexByCollector.get(collectorKey),
      {
        platform: task.platform,
        entityType: task.entityType,
        entityId: task.entitySourceKey,
        accountUrl: task.account?.url ?? null,
        collectorOk: result.ok,
        collectorError: result.error
      }
    );
    if (outcome.status === "completed") report.succeeded += 1;
    else if (outcome.status === "needs_review") report.needsReview += 1;
    else if (outcome.status === "blocked_or_empty") report.blockedOrEmpty += 1;
    else if (outcome.status === "nonterminal") report.nonTerminal += 1;
    else report.failed += 1;
    if (outcome.providerBlocked === true) {
      report.providerBlocked += 1;
      const reason = outcome.providerBlockerReason ?? "provider_blocked:unknown";
      report.providerBlockedByReason[reason] =
        (report.providerBlockedByReason[reason] ?? 0) + 1;
    }
    if (task.account) {
      if (outcome.status === "completed") report.mappedSucceeded += 1;
      else if (outcome.status === "needs_review") report.mappedNeedsReview += 1;
      else if (outcome.status === "blocked_or_empty") report.mappedBlockedOrEmpty += 1;
      else if (outcome.status === "nonterminal") report.mappedNonTerminal += 1;
      else {
        report.mappedFailed += 1;
        report.mappedFailureSamples.push({
          checkpointKey: task.checkpointKey,
          batchSlug: task.batchSlug,
          platform: task.platform,
          entityType: task.entityType,
          entityId: task.entitySourceKey,
          accountUrl: task.account?.url ?? null,
          reason: outcome.reason
        });
      }
      if (outcome.providerBlocked === true) {
        report.mappedProviderBlocked += 1;
        const reason = outcome.providerBlockerReason ?? "provider_blocked:unknown";
        report.mappedProviderBlockedByReason[reason] =
          (report.mappedProviderBlockedByReason[reason] ?? 0) + 1;
      }
      if (outcome.reason === "collector_scope_unsupported") report.mappedScopeUnsupported += 1;
    }
  }
  report.attempted = report.expected - report.nonTerminal;
  report.coveragePercentage = report.expected
    ? Number((((report.expected - report.nonTerminal) / report.expected) * 100).toFixed(2))
    : 100;
  return report;
}

async function recordCollectionCoverage(
  coverage,
  terminalFailureBudget = autonomousMappedTerminalFailureBudget(coverage?.mappedExpected)
) {
  const degraded = (coverage.mappedFailed ?? 0) > 0 ||
    (coverage.providerBlocked ?? 0) > 0 ||
    (coverage.mappedScopeUnsupported ?? 0) > 0;
  const budgetExceeded = (coverage.mappedFailed ?? 0) > terminalFailureBudget;
  const failedTaskSamples = (coverage.mappedFailureSamples ?? []).slice(0, 20);
  const omittedFailureSamples = Math.max(
    0,
    (coverage.mappedFailureSamples?.length ?? 0) - failedTaskSamples.length
  );
  const summary = {
    mappedExpected: coverage.mappedExpected,
    mappedSucceeded: coverage.mappedSucceeded,
    mappedNeedsReview: coverage.mappedNeedsReview,
    mappedBlockedOrEmpty: coverage.mappedBlockedOrEmpty,
    providerBlocked: coverage.providerBlocked,
    providerBlockedByReason: coverage.providerBlockedByReason,
    mappedProviderBlocked: coverage.mappedProviderBlocked,
    mappedProviderBlockedByReason: coverage.mappedProviderBlockedByReason,
    mappedScopeUnsupported: coverage.mappedScopeUnsupported,
    mappedFailed: coverage.mappedFailed,
    mappedNonTerminal: coverage.mappedNonTerminal,
    terminalFailureBudget,
    status: budgetExceeded ? "failed_budget_exceeded" : degraded ? "degraded" : "complete",
    failedTaskSampleCount: coverage.mappedFailureSamples?.length ?? 0,
    failedTaskSamples,
    omittedFailureSamples
  };
  console.log(`COLLECTION_COVERAGE_RECEIPT ${JSON.stringify(summary)}`);
  if (degraded) {
    console.warn(
      budgetExceeded
        ? `Refusing publication because ${coverage.mappedFailed} explicit terminal mapped failure(s) exceed ` +
          `the budget of ${terminalFailureBudget}.`
        : `Publishing a degraded refresh with ${coverage.mappedFailed} explicit terminal mapped failure(s) ` +
          `within the budget of ${terminalFailureBudget} and ${coverage.providerBlocked ?? 0} ` +
          `provider-blocked task(s) (${coverage.mappedProviderBlocked ?? 0} mapped); ` +
          `${coverage.mappedScopeUnsupported ?? 0} mapped account task(s) ` +
          "are outside the collector's verified scope."
    );
  }
  const githubSummary = cleanEnv(process.env.GITHUB_STEP_SUMMARY);
  if (!githubSummary) return;
  await appendFile(githubSummary, [
    "## Collector coverage",
    `- Status: ${summary.status}`,
    `- Mapped tasks: ${coverage.mappedExpected}`,
    `- Native evidence: ${coverage.mappedSucceeded}`,
    `- Needs review: ${coverage.mappedNeedsReview}`,
    `- Blocked or empty: ${coverage.mappedBlockedOrEmpty}`,
    `- Provider blocked (all tasks): ${coverage.providerBlocked}`,
    ...Object.entries(coverage.providerBlockedByReason ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `- Provider blocker (all tasks): \`${reason}\` — ${count}`),
    `- Provider blocked (mapped tasks): ${coverage.mappedProviderBlocked}`,
    `- Mapped account scope unsupported: ${coverage.mappedScopeUnsupported}`,
    ...Object.entries(coverage.mappedProviderBlockedByReason ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `- Provider blocker (mapped tasks): \`${reason}\` — ${count}`),
    `- Terminal failures: ${coverage.mappedFailed}/${terminalFailureBudget}`,
    `- Nonterminal tasks: ${coverage.mappedNonTerminal}`,
    ...failedTaskSamples.map((sample) =>
      `- Failed task: \`${sample.checkpointKey}\` — ${sample.reason}`
    ),
    ...(omittedFailureSamples > 0
      ? [`- Additional failed-task samples omitted from the summary: ${omittedFailureSamples}`]
      : []),
    ""
  ].join("\n"), "utf8");
}

function assertSuccessfulCollection(collectionResults, coverage) {
  if (collectionResults.length === 0 || !collectionResults.some((result) => result.snapshotAvailable)) {
    throw new Error("No collector completed successfully; publication and run completion are prohibited.");
  }
  if (!collectionResults.some((result) => result.snapshotAvailable && result.successfulRows > 0)) {
    throw new Error("Collector snapshots contained no successful rows; publication and run completion are prohibited.");
  }
  if (coverage.succeeded === 0) {
    throw new Error("Every attempted collection task failed; publication and run completion are prohibited.");
  }
}

function assertAuthenticatedReplayCanPublish(replay) {
  if (!replay?.linkedinReplay || typeof replay.linkedinReplay !== "object") {
    throw new Error("Authenticated replay did not return its bounded LinkedIn replay receipt.");
  }
  const linkedinReplay = replay.linkedinReplay;
  if (
    linkedinReplay.chunksAdmitted > LINKEDIN_REPLAY_MAX_CHUNKS ||
    linkedinReplay.chunksAttempted !== linkedinReplay.chunksAdmitted ||
    linkedinReplay.chunksCompleted > linkedinReplay.chunksAttempted ||
    linkedinReplay.targetCapacityAdmitted !== linkedinReplay.chunksAdmitted * LINKEDIN_REPLAY_TARGET_CAP ||
    linkedinReplay.targetCapacityAdmitted > LINKEDIN_REPLAY_MAX_CHUNKS * LINKEDIN_REPLAY_TARGET_CAP
  ) {
    throw new Error("Authenticated replay exceeded the bounded LinkedIn chunk or target capacity.");
  }
  if (linkedinReplay.configurationSkipped) {
    if (linkedinReplay.status !== "skipped" || linkedinReplay.durableLockConfigured) {
      throw new Error("LinkedIn replay configuration skip was reported as a completed or configured campaign.");
    }
    if (linkedinReplay.remainingTargetCountKnown || linkedinReplay.remainingTargetCount !== null) {
      throw new Error("LinkedIn replay configuration skip must preserve unknown remaining-target state.");
    }
  }
  if (linkedinReplay.status === "completed") {
    if (
      !linkedinReplay.durableLockConfigured ||
      !linkedinReplay.remainingTargetCountKnown ||
      linkedinReplay.remainingTargetCount !== 0
    ) {
      throw new Error("LinkedIn replay cannot claim completion without a durable lock and exact zero remaining targets.");
    }
  }
  if (replay.historicalReplay && replay.status === "completed" && linkedinReplay.status !== "completed") {
    throw new Error("Authenticated historical replay cannot claim completion while LinkedIn is incomplete or skipped.");
  }
}

function assertSuccessfulTopVoiceRefresh(receipt) {
  if (!receipt || receipt.status !== "completed") {
    throw new Error("Top Voice discovery did not complete every requested audience.");
  }
  const audiences = new Map((receipt.audiences ?? []).map((result) => [result.audience, result]));
  if (!audiences.has("insiders") || !audiences.has("yc_partners")) {
    throw new Error("Top Voice discovery did not scan both Insiders and YC Partners.");
  }
  for (const audience of ["insiders", "yc_partners"]) {
    const result = audiences.get(audience);
    if (result?.status !== "completed" || (result.targetsLoaded ?? 0) <= 0 || (result.networkRequests ?? 0) <= 0) {
      throw new Error(`Top Voice discovery did not fully inspect the curated ${audience} audience.`);
    }
  }
  const isolatedEvidence = receipt.isolatedEvidence;
  if (
    !isolatedEvidence
    || typeof isolatedEvidence.path !== "string"
    || !isolatedEvidence.snapshot
    || !Array.isArray(isolatedEvidence.snapshot.evidence)
    || !Array.isArray(isolatedEvidence.snapshot.needsReview)
  ) {
    throw new Error("Top Voice discovery did not expose its isolated row-level evidence artifact.");
  }
  if (isolatedEvidence.evidenceCount !== isolatedEvidence.snapshot.evidence.length) {
    throw new Error("Top Voice isolated evidence receipt count does not match its row-level artifact.");
  }
}

async function persistCoverage(catalogState, stageCounters) {
  const tasks = await readAllIngestionTaskRows(
    "read terminal coverage",
    "id,status,platform,batch_id,terminal_reason,checkpoint_key",
    (query) => query
      .eq("ingestion_run_id", run.id)
  );
  const {
    currentTasks,
    supersededTasks,
    unrelatedTasks,
    missingCheckpointKeys
  } = partitionAutonomousTaskInventory(tasks, plannedTasks, {
    isSupersededTask: (task) => isAutonomousCollectorTaskForRun(task, { runKey: idempotencyKey })
  });
  const terminalStatuses = new Set(["completed", "needs_review", "blocked_or_empty", "skipped", "failed", "canceled", "dead_lettered"]);
  const needsReview = currentTasks.filter((task) => task.status === "needs_review").length;
  const blockedOrEmpty = currentTasks.filter((task) => task.status === "blocked_or_empty").length;
  const skipped = currentTasks.filter((task) => task.status === "skipped").length;
  const mappedCheckpointKeys = new Set(
    plannedTasks
      .filter((task) => task.status === "queued" && Boolean(task.account))
      .map((task) => task.checkpointKey)
  );
  const mappedTasks = currentTasks.filter((task) => mappedCheckpointKeys.has(task.checkpoint_key));
  const report = {
    expected: currentTasks.length,
    attempted: currentTasks.filter((task) => task.status !== "queued").length,
    succeeded: currentTasks.filter((task) => task.status === "completed").length,
    needsReview,
    blockedOrEmpty,
    failed: currentTasks.filter((task) => ["failed", "dead_lettered"].includes(task.status)).length,
    skipped,
    nonTerminal: currentTasks.filter((task) => !terminalStatuses.has(task.status)).length,
    superseded: supersededTasks.length,
    supersededNonTerminal: supersededTasks.filter((task) => !terminalStatuses.has(task.status)).length,
    unrelatedRunTasks: unrelatedTasks.length,
    missingCheckpointKeys,
    mappedExpected: mappedCheckpointKeys.size,
    mappedSucceeded: mappedTasks.filter((task) => task.status === "completed").length,
    mappedNeedsReview: mappedTasks.filter((task) => task.status === "needs_review").length,
    mappedBlockedOrEmpty: mappedTasks.filter((task) => task.status === "blocked_or_empty").length,
    mappedFailed: mappedTasks.filter((task) => ["failed", "dead_lettered"].includes(task.status)).length,
    mappedNonTerminal: mappedTasks.filter((task) => !terminalStatuses.has(task.status)).length,
    coveragePercentage: currentTasks.length
      ? Number((((currentTasks.length - currentTasks.filter((task) => !terminalStatuses.has(task.status)).length) / currentTasks.length) * 100).toFixed(2))
      : 100,
    stageCounters,
    generatedAt: new Date().toISOString()
  };
  const { error: reportError } = await runSupabaseOperation(
    "persist coverage report",
    () => supabase.from("ingestion_coverage_reports").upsert(
      {
        ingestion_run_id: run.id,
        report_key: "overall",
        expected_count: report.expected,
        attempted_count: report.attempted,
        succeeded_count: report.succeeded,
        failed_count: report.failed,
        skipped_count: report.skipped + report.needsReview + report.blockedOrEmpty,
        report_json: report
      },
      { onConflict: "ingestion_run_id,report_key" }
    )
  );
  check(reportError, "persist coverage report");
  return report;
}

async function persistArtifactManifest(runId, publicationReceipt) {
  const publicationStatus = publicationReceipt?.status;
  const claimedCommit = String(publicationReceipt?.publishedCommit ?? "").trim().toLowerCase();
  if (!["published", "no_changes"].includes(publicationStatus)) {
    throw new Error(
      `Artifact manifest persistence requires a verified repository publication, received ${publicationStatus ?? "missing"}.`
    );
  }
  if (!/^[0-9a-f]{40}$/.test(claimedCommit)) {
    throw new Error("Artifact manifest persistence requires an exact full 40-hex publication SHA.");
  }

  const branch = publicationBranch();
  const publishedCommit = await verifyPublicationCommitOnRemote(claimedCommit, {
    branch,
    label: "artifact manifest persistence"
  });
  const manifestPath = "public/graph/manifest.json";
  const content = await readTextFromGitRef(publishedCommit, manifestPath, null);
  if (content === null) {
    throw new Error(`Published commit ${publishedCommit} does not contain ${manifestPath}.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Published commit ${publishedCommit} contains an invalid artifact manifest: ${errorMessage(error)}`
    );
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const receiptSha256 = String(publicationReceipt.receiptSha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(receiptSha256)) {
    throw new Error("Artifact manifest persistence requires the exact publication receipt SHA-256.");
  }
  const { error } = await runSupabaseOperation(
    "persist artifact manifest",
    () => supabase.from("ingestion_artifact_manifests").upsert(
      {
        ingestion_run_id: runId,
        artifact_key: "public-graph-manifest",
        artifact_type: "graph_manifest",
        storage_uri: `repo://${publishedCommit}/${manifestPath}`,
        content_type: "application/json",
        byte_size: Buffer.byteLength(content, "utf8"),
        sha256,
        metadata_json: {
          ...manifest,
          publicationBinding: {
            schemaVersion: 1,
            repository: cleanEnv(process.env.GITHUB_REPOSITORY),
            branch,
            publishedCommit,
            publicationStatus,
            receiptSha256,
            manifestPath,
            manifestSha256: sha256
          }
        }
      },
      { onConflict: "ingestion_run_id,artifact_key" }
    )
  );
  check(error, "persist artifact manifest");
}

async function claimTimelineArtifactInvalidationsForBuild() {
  if (!supabase) return { ids: [], claimedAt: null };
  const claimedAt = new Date().toISOString();
  const { data, error } = await runSupabaseOperation(
    "claim Timeline artifact invalidations for publication build",
    () => supabase
      .from("timeline_artifact_invalidations")
      .update({ status: "processing", processed_at: null, last_error: null })
      .in("status", ["pending", "processing", "failed"])
      .select("id,company_id,invalidated_at")
  );
  if (error && isTimelineMigrationUnavailable(error)) return { ids: [], claimedAt: null };
  check(error, "claim Timeline artifact invalidations for publication build");
  const ids = [...new Set((data ?? []).map((row) => row.id).filter(Boolean))].sort();
  await event(
    "timeline.invalidations.claimed",
    "info",
    "Timeline artifact invalidations were frozen before publication build.",
    { count: ids.length, claimedAt }
  );
  return { ids, claimedAt };
}

async function completePublishedTimelineInvalidations(
  publicationReceipt,
  invalidationClaim,
  timelineBuildReceipt
) {
  if (
    !supabase
    || !["published", "no_changes"].includes(publicationReceipt.status)
    || !invalidationClaim?.ids?.length
  ) return;
  if (timelineBuildReceipt?.status !== "rebuilt") {
    await event(
      "timeline.invalidations.deferred",
      "warning",
      "Timeline artifact invalidations remain open because this publication preserved last-good Timeline artifacts.",
      {
        count: invalidationClaim.ids.length,
        claimedAt: invalidationClaim.claimedAt,
        timelineBuildStatus: timelineBuildReceipt?.status ?? "unknown",
        publishedCommit: publicationReceipt.publishedCommit
      }
    );
    return;
  }
  const processedAt = new Date().toISOString();
  const { data, error } = await runSupabaseOperation(
    "complete published Timeline artifact invalidations",
    () => supabase
      .from("timeline_artifact_invalidations")
      .update({ status: "completed", processed_at: processedAt, last_error: null })
      .eq("status", "processing")
      .in("id", invalidationClaim.ids)
      .select("id,company_id")
  );
  if (error && isTimelineMigrationUnavailable(error)) return;
  check(error, "complete published Timeline artifact invalidations");
  await event(
    "timeline.invalidations.completed",
    "info",
    "Published Timeline artifact invalidations were consumed after remote publication verification.",
    {
      count: data?.length ?? 0,
      claimedCount: invalidationClaim.ids.length,
      claimedAt: invalidationClaim.claimedAt,
      processedAt,
      publishedCommit: publicationReceipt.publishedCommit
    }
  );
}

async function runTimelineDiscoveryBeforeBackfill(catalogState) {
  const targetRoot = publicationArtifactRoot();
  if (!durableStorageConfigured || !supabase || !run?.id) {
    if (args.skipNetwork) {
      await event(
        "timeline.discovery.skipped",
        "warning",
        "File-backed Company Timeline discovery was skipped because network collection is disabled.",
        { reason: "network_collection_explicitly_skipped" }
      );
      return { status: "skipped", reason: "network_collection_explicitly_skipped" };
    }
    try {
      const result = await runCommand(process.execPath, [
        "--experimental-strip-types",
        "--loader",
        sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
        sourcePath("scripts", "discover-company-timeline-public-sources.mjs"),
        `--root=${targetRoot}`,
        `--budget-ms=${AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs}`,
        "--concurrency=2",
        "--max-companies=12",
        "--per-fetch-timeout-ms=6000"
      ], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs + 30_000,
        label: "file-backed Company Timeline public discovery",
        captureLimit: 100_000,
        envCategory: "publication_data",
        env: { SCORING_DATA_ROOT: targetRoot },
        cwd: targetRoot
      });
      const receipt = JSON.parse(result.stdout.trim());
      await event(
        "timeline.discovery.file_backed",
        receipt.status === "budget_exhausted" ? "warning" : "info",
        "Bounded public Company Timeline discovery was cached without production database access.",
        receipt
      );
      return receipt;
    } catch (error) {
      await event(
        "timeline.discovery.file_backed_failed",
        "warning",
        "File-backed Company Timeline discovery failed; the last verified discovery cache will be preserved.",
        { error: error instanceof Error ? error.message : String(error) }
      );
      return { status: "skipped", reason: "file_backed_discovery_failed" };
    }
  }
  if (!catalogState) {
    await event(
      "timeline.discovery.skipped",
      "warning",
      "Durable Company Timeline discovery was skipped because canonical durable inventory is unavailable.",
      { reason: "durable_catalog_not_available" }
    );
    return { status: "skipped", reason: "durable_storage_unavailable" };
  }

  const { error: migrationError } = await runSupabaseOperation(
    "preflight Company Timeline migration",
    () => supabase
      .from("timeline_source_coverage")
      .select("company_id")
      .limit(1)
  );
  if (migrationError && isTimelineCoverageMigrationUnavailable(migrationError)) {
    const receipt = {
      status: "migration_unavailable",
      reason: "timeline_source_coverage_unavailable",
      code: migrationError.code ?? null,
      enqueuedTasks: 0,
      claimedTasks: 0
    };
    await event(
      "timeline.discovery.skipped",
      "warning",
      "Company Timeline coverage migration is not applied; durable Timeline discovery was skipped before task enqueue.",
      receipt
    );
    return receipt;
  }
  check(migrationError, "preflight Company Timeline migration");

  const inventory = await buildCanonicalTimelineIngestionInventory(catalogState);
  const inventoryPath = join(workRoot, "timeline-company-inventory.json");
  await writeJsonAtomic(inventoryPath, inventory);
  const result = await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
    sourcePath("scripts", "run-company-timeline-ingestion.mjs"),
    `--run-id=${run.id}`,
    `--worker-id=${workerId}:timeline`,
    `--inventory=${inventoryPath}`,
    `--budget-ms=${AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs + 30_000,
    label: "durable Company Timeline discovery",
    captureLimit: 100_000,
    envCategory: "durable_timeline",
    env: { SCORING_DATA_ROOT: targetRoot },
    cwd: root
  });
  const receipt = JSON.parse(result.stdout.trim());
  if (
    receipt.status === "migration_unavailable"
    && receipt.reason === "timeline_source_coverage_unavailable"
  ) {
    await event(
      "timeline.discovery.skipped",
      "warning",
      "Company Timeline coverage migration is not applied; the child preflight skipped discovery before task enqueue.",
      receipt
    );
    return receipt;
  }
  if (receipt.adminTaskDrain?.status === "migration_unavailable") {
    await event(
      "timeline.discovery.skipped",
      "warning",
      "Company Timeline admin migration is unavailable; the optional admin drain was skipped while scheduled discovery and artifact regeneration continued.",
      receipt.adminTaskDrain
    );
  }
  await event(
    "timeline.discovery.persisted",
    receipt.deadLetteredTasks ? "warning" : "info",
    "Durable Company Timeline discovery reached terminal coverage.",
    receipt
  );
  return receipt;
}

async function buildCanonicalTimelineIngestionInventory(catalogState) {
  const targetRoot = publicationArtifactRoot();
  const evidenceByCompany = new Map();
  const graphCompanyIds = new Set();
  for (const batch of AUTONOMOUS_BATCHES) {
    const graph = await readRequiredCanonicalJson(
      join(targetRoot, "public", "graph", batch.graphFile),
      `Published ${batch.slug} graph for Timeline inventory`
    );
    for (const node of graph.nodes ?? []) {
      if (node?.entityType === "company" && node.entityId) graphCompanyIds.add(node.entityId);
    }
    for (const evidence of graph.evidence ?? []) {
      const companyId = evidence.attachedCompanyId ?? (evidence.entityType === "company" ? evidence.entityId : null);
      if (!companyId) continue;
      const identity = `${evidence.platform}|${evidence.platformObjectId ?? evidence.platformPostId ?? evidence.id}|${evidence.sourceUrl}`;
      const current = evidenceByCompany.get(companyId) ?? new Map();
      if (!current.has(identity)) current.set(identity, evidence);
      evidenceByCompany.set(companyId, current);
    }
  }

  // A company may appear in more than one cohort (currently one duplicate).
  // Timeline identity is canonical by source key. Use the lexicographically
  // lowest durable UUID, matching the atomic admin RPC, and union aliases and
  // evidence across cohort rows.
  const byCanonicalId = new Map();
  for (const catalog of [...catalogs].sort((left, right) => left.slug.localeCompare(right.slug))) {
    for (const company of [...catalog.companies].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))) {
      const databaseId = catalogState.companyBySourceKey.get(company.sourceKey);
      const batchId = catalogState.batchBySlug.get(catalog.slug) ?? null;
      if (!databaseId) throw new Error(`Timeline inventory could not map ${catalog.slug}/${company.sourceKey} to durable companies.id.`);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
        throw new Error(`Timeline inventory received a non-UUID durable company id for ${catalog.slug}/${company.sourceKey}.`);
      }
      const existing = byCanonicalId.get(company.sourceKey);
      if (existing) {
        existing.aliases = [...new Set([...existing.aliases, company.name])].sort();
        existing.founderNames = [...new Set([...existing.founderNames, ...company.founders.map((founder) => founder.name)])].sort();
        existing.existingEvidence = [...(evidenceByCompany.get(company.sourceKey)?.values() ?? [])]
          .sort((left, right) => left.postedAt.localeCompare(right.postedAt) || left.id.localeCompare(right.id));
        existing.existingEvidenceCount = existing.existingEvidence.length;
        if (!existing.websiteUrl && company.websiteUrl) existing.websiteUrl = company.websiteUrl;
        continue;
      }
      byCanonicalId.set(company.sourceKey, {
        id: company.sourceKey,
        databaseId,
        batchId,
        slug: plannedCompanySlug(company),
        name: company.name,
        aliases: [company.name],
        websiteUrl: company.websiteUrl ?? null,
        profileUrl: company.profileUrl ?? null,
        founderNames: [...new Set(company.founders.map((founder) => founder.name))].sort(),
        existingEvidence: [...(evidenceByCompany.get(company.sourceKey)?.values() ?? [])]
          .sort((left, right) => left.postedAt.localeCompare(right.postedAt) || left.id.localeCompare(right.id)),
        existingEvidenceCount: evidenceByCompany.get(company.sourceKey)?.size ?? 0
      });
    }
  }
  const inventory = [...byCanonicalId.values()].sort((left, right) => left.id.localeCompare(right.id));
  const catalogCompanyIds = new Set(catalogs.flatMap((catalog) => catalog.companies.map((company) => company.sourceKey)));
  if (inventory.length !== catalogCompanyIds.size) {
    throw new Error("Timeline inventory did not retain every canonical company identity.");
  }
  const missingFromDurableInventory = [...graphCompanyIds].filter((id) => !byCanonicalId.has(id));
  const missingFromPublishedGraph = [...catalogCompanyIds].filter((id) => !graphCompanyIds.has(id));
  if (missingFromDurableInventory.length || missingFromPublishedGraph.length) {
    throw new Error(
      `Timeline inventory diverged from published graphs: ` +
      `missing durable=${missingFromDurableInventory.slice(0, 10).join(",") || "none"}; ` +
      `missing graph=${missingFromPublishedGraph.slice(0, 10).join(",") || "none"}.`
    );
  }
  return inventory;
}

function isTimelineMigrationUnavailable(error) {
  return ["42P01", "PGRST205", "PGRST204"].includes(String(error?.code ?? ""))
    || /timeline_source_coverage.*(?:not found|does not exist|schema cache)/i.test(String(error?.message ?? ""));
}

async function preserveLastGoodTimelineArtifacts() {
  const targetRoot = publicationArtifactRoot();
  const status = await runCommand(
    "git",
    [
      "status",
      "--short",
      "--untracked-files=all",
      "--",
      "public/timelines",
      "artifacts/company-timeline"
    ],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "verify preserved last-good Company Timeline artifacts",
      quiet: true,
      cwd: targetRoot
    }
  );
  const changedPaths = status.stdout.trim();
  if (changedPaths) {
    throw new Error(
      "Company Timeline migration is unavailable, but Timeline artifact paths changed before preservation: " +
      changedPaths.split("\n").slice(0, 20).join(", ")
    );
  }

  const anchorResult = await runCommand(
    "git",
    [
      "log",
      "-1",
      "--format=%H",
      "--",
      "public/timelines",
      "artifacts/company-timeline"
    ],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "resolve last-good Company Timeline source commit",
      quiet: true,
      cwd: targetRoot
    }
  );
  const sourceCommit = anchorResult.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("Could not resolve an immutable source commit for the preserved Company Timeline artifacts.");
  }

  const temporaryBase = resolve(cleanEnv(process.env.RUNNER_TEMP) ?? tmpdir());
  await mkdir(temporaryBase, { recursive: true });
  const validationParent = await mkdtemp(join(temporaryBase, "returner-timeline-validation-"));
  const validationRoot = join(validationParent, "checkout");
  let validationWorktreeAdded = false;
  try {
    await runCommand(
      "git",
      ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", validationRoot, sourceCommit],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: "materialize last-good Company Timeline validation source",
        quiet: true,
        cwd: targetRoot
      }
    );
    validationWorktreeAdded = true;
    await runCommand(process.execPath, [
      sourcePath("scripts", "validate-timeline-artifacts.mjs"),
      `--root-dir=${validationRoot}`
    ], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
      label: "validate preserved Company Timeline at its immutable source commit",
      cwd: targetRoot
    });
  } finally {
    if (validationWorktreeAdded) {
      await runCommand(
        "git",
        ["worktree", "remove", "--force", validationRoot],
        {
          timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
          label: "remove last-good Company Timeline validation worktree",
          quiet: true,
          recordEvents: false,
          cancellationCleanup: true,
          cwd: targetRoot
        }
      );
    }
    await rm(validationParent, { recursive: true, force: true });
  }
  return {
    status: "preserved",
    reason: "timeline_source_coverage_unavailable",
    sourceCommit
  };
}

async function buildAndValidatePublication(publicationRunId, catalogState) {
  latestTimelineBuildReceipt = null;
  const targetRoot = publicationArtifactRoot();
  // All code executed in this secret-bearing process is pinned to sourceCommit.
  // Mutable publication-root files are data only. The exact pushed SHA receives
  // its application build in the separate secretless reusable validation job.
  const benchmarkWindowStart = new Date().toISOString();
  await runCommand(process.execPath, [
    sourcePath("scripts", "prepare-graph-runtime-evidence.mjs"),
    `--root=${targetRoot}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "pre-publication compact graph runtime preparation",
    cwd: targetRoot
  });
  await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
    sourcePath("scripts", "update-daily-benchmarks.mjs"),
    `--root=${targetRoot}`,
    "--pinned-source-in-process"
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.benchmarkPublicationMs,
    nodeHeapMb: FULL_CORPUS_NODE_HEAP_MB,
    label: "graph and benchmark publication",
    envCategory: "benchmark",
    env: {
      INGESTION_RUN_ID: publicationRunId,
      BENCHMARK_WINDOW_START: benchmarkWindowStart,
      GRAPH_API_BASE_URL: "",
      SCORING_DATA_ROOT: targetRoot
    },
    cwd: targetRoot
  });
  // Durable scheduled discovery runs against the just-refreshed canonical
  // inventory and must reach terminal source coverage before artifact backfill
  // reads published database events. The run-less admin queue is optional: a
  // missing admin claim RPC is recorded by the child receipt but cannot suppress
  // scheduled discovery or leave Timeline manifests stale against fresh graphs.
  const timelineDiscoveryReceipt = await runTimelineDiscoveryBeforeBackfill(catalogState);
  const preserveLastGoodTimeline =
    timelineDiscoveryReceipt?.status === "migration_unavailable"
    && timelineDiscoveryReceipt?.reason === "timeline_source_coverage_unavailable";
  const timelineDatabaseSnapshotPath = join(workRoot, "timeline-database-snapshot.json");
  let preservedTimelineReceipt = null;
  if (preserveLastGoodTimeline) {
    preservedTimelineReceipt = await preserveLastGoodTimelineArtifacts();
  } else if (durableStorageConfigured) {
    await runCommand(process.execPath, [
      "--experimental-strip-types",
      "--loader",
      sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
      sourcePath("scripts", "backfill-company-timelines.mjs"),
      `--root=${targetRoot}`,
      `--export-database-snapshot=${timelineDatabaseSnapshotPath}`
    ], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.timelineBackfillMs,
      label: "export durable Company Timeline database snapshot",
      envCategory: "durable_timeline",
      env: { SCORING_DATA_ROOT: targetRoot },
      cwd: root
    });
  }
  if (!preserveLastGoodTimeline) {
    const timelineBackfillEnv = durableStorageConfigured
      ? {
          TIMELINE_REQUIRE_DATABASE: "true",
          SCORING_DATA_ROOT: targetRoot
        }
      : {
          TIMELINE_REQUIRE_DATABASE: "false",
          SCORING_DATA_ROOT: targetRoot
        };
    await runCommand(process.execPath, [
      "--experimental-strip-types",
      "--loader",
      sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
      sourcePath("scripts", "backfill-company-timelines.mjs"),
      `--root=${targetRoot}`,
      "--resume",
      ...(durableStorageConfigured
        ? [`--database-snapshot=${timelineDatabaseSnapshotPath}`]
        : [])
    ], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.timelineBackfillMs,
      label: "company timeline backfill",
      envCategory: "timeline_backfill",
      env: timelineBackfillEnv,
      cwd: targetRoot
    });
  }
  if (!preserveLastGoodTimeline) {
    await runCommand(process.execPath, [sourcePath("scripts", "validate-timeline-artifacts.mjs")], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
      label: "company timeline artifact validation",
      cwd: targetRoot
    });
  }
  latestTimelineBuildReceipt = preserveLastGoodTimeline
    ? preservedTimelineReceipt
    : {
        status: "rebuilt",
        reason: "timeline_discovery_and_backfill_completed"
      };
  if (preserveLastGoodTimeline) {
    await event(
      "timeline.artifacts.preserved",
      "warning",
      "Validated last-good Timeline artifacts were preserved while fresh graph and benchmark artifacts continued through publication.",
      latestTimelineBuildReceipt
    );
  }
  await runCommand(process.execPath, [
    sourcePath("scripts", "prepare-graph-runtime-evidence.mjs"),
    `--root=${targetRoot}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "compact graph runtime preparation",
    cwd: targetRoot
  });
  await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
    sourcePath("scripts", "build-topic-facets.mjs"),
    `--root=${targetRoot}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.derivedArtifactMs,
    nodeHeapMb: FULL_CORPUS_NODE_HEAP_MB,
    label: "topic facet regeneration and validation",
    envCategory: "publication_data",
    env: { SCORING_DATA_ROOT: targetRoot },
    cwd: targetRoot
  });
  await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
    sourcePath("scripts", "build-ranked-posts-sidecar.mjs"),
    `--root=${targetRoot}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.derivedArtifactMs,
    nodeHeapMb: FULL_CORPUS_NODE_HEAP_MB,
    label: "Ranked Posts sidecar regeneration and validation",
    envCategory: "publication_data",
    env: { SCORING_DATA_ROOT: targetRoot },
    cwd: targetRoot
  });
  await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    sourcePath("scripts", "lib", "scoring-diagnostics-ts-loader.mjs"),
    sourcePath("scripts", "run-scoring-diagnostics-v4.mjs"),
    `--root=${targetRoot}`,
    `--expected-source-sha=${sourceCommit}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.scoringDiagnosticsMs,
    nodeHeapMb: FULL_CORPUS_NODE_HEAP_MB,
    label: "scoring diagnostics regeneration",
    envCategory: "publication_data",
    env: { SCORING_DATA_ROOT: targetRoot },
    cwd: targetRoot
  });
  await runCommand(process.execPath, [
    sourcePath("scripts", "audit-cohort-coverage.mjs"),
    `--run-dir=${workRoot}`,
    `--output=${publishedCohortAuditPath}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "cohort coverage audit",
    cwd: targetRoot
  });
  await runCommand(process.execPath, [
    sourcePath("scripts", "write-artifact-manifest.mjs"),
    `--ingestion-run-id=${publicationRunId}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactManifestMs,
    label: "artifact manifest",
    cwd: targetRoot
  });
  await runCommand(process.execPath, [sourcePath("scripts", "validate-public-artifacts.mjs")], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "artifact validation",
    cwd: targetRoot
  });
  await runCommand(process.execPath, [sourcePath("scripts", "write-artifact-manifest.mjs"), "--validate"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactManifestMs,
    label: "strict artifact manifest validation",
    cwd: targetRoot
  });
}

async function synchronizePublicationBase() {
  await ensurePublicationWorktree();
  await event("publication.base_synchronized", "info", "Publication base synchronized before artifact generation.", {
    branch: publicationBranch(),
    sourceCommit,
    publicationBaseCommit,
    publicationRoot
  });
}

async function ensurePublicationWorktree() {
  if (publicationRoot) return publicationRoot;
  sourceCommit = await resolveSourceExecutionCommit();
  const baseCommit = process.env.GITHUB_ACTIONS === "true"
    ? preverifiedPublicationBaseCommit ?? await resolveVerifiedCurrentPublicationCommit({
        labelPrefix: "isolated publication base",
        allowInertCodeDrift: true
      })
    : sourceCommit;
  await assertTrustedPublicationBaseCommit(baseCommit, {
    label: "isolated publication base",
    allowInertCodeDrift: true
  });

  const temporaryBase = resolve(cleanEnv(process.env.RUNNER_TEMP) ?? tmpdir());
  await mkdir(temporaryBase, { recursive: true });
  publicationWorktreeParent = await mkdtemp(join(temporaryBase, "returner-publication-"));
  const target = join(publicationWorktreeParent, "checkout");
  try {
    await runCommand(
      "git",
      ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", target, baseCommit],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
        label: "create isolated publication worktree",
        cwd: root
      }
    );
    publicationRoot = target;
    publicationBaseCommit = baseCommit;
    configurePublicationArtifactPaths(publicationRoot);
    await exposePinnedDependenciesToPublicationWorktree();
    return publicationRoot;
  } catch (error) {
    publicationRoot = target;
    await cleanupPublicationWorktree().catch(() => {});
    throw error;
  }
}

async function resolveSourceExecutionCommit() {
  if (sourceCommit) return sourceCommit;
  const resolved = (await runCommand("git", ["rev-parse", "HEAD^{commit}"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "resolve immutable source execution commit",
    cwd: pinnedSourceRoot
  })).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(resolved)) {
    throw new Error("Immutable source execution commit is not a full 40-hex SHA.");
  }
  sourceCommit = resolved.toLowerCase();
  return sourceCommit;
}

async function verifyPinnedSourceExecutionBoundary({
  workingDirectory = root,
  executingCodeRoot = pinnedSourceRoot,
  expectedSourceCommit = cleanEnv(process.env.RETURNER_EXPECTED_SOURCE_SHA ?? process.env.GITHUB_SHA),
  verifyPolicyCleanliness = true
} = {}) {
  const [workingRoot, codeRoot] = await Promise.all([
    realpath(workingDirectory),
    realpath(executingCodeRoot)
  ]);
  if (workingRoot !== codeRoot) {
    throw new Error(
      `Runner source-root mismatch: cwd resolves to ${workingRoot}, but executing code resolves to ${codeRoot}.`
    );
  }
  const repositoryTopLevel = (await runCommand("git", ["rev-parse", "--show-toplevel"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "resolve pinned source repository root",
    quiet: true,
    recordEvents: false,
    cwd: codeRoot
  })).stdout.trim();
  if (await realpath(repositoryTopLevel) !== codeRoot) {
    throw new Error("Pinned runner code is not executing from its exact Git repository root.");
  }

  const immutableSourceCommit = (await runCommand("git", ["rev-parse", "HEAD^{commit}"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "resolve cryptographically pinned source commit",
    quiet: true,
    recordEvents: false,
    cwd: codeRoot
  })).stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(immutableSourceCommit)) {
    throw new Error("Pinned source commit is not a full 40-hex SHA.");
  }
  if (codeRoot === await realpath(pinnedSourceRoot)) sourceCommit = immutableSourceCommit;
  if (expectedSourceCommit) {
    if (!/^[0-9a-f]{40}$/i.test(expectedSourceCommit)) {
      throw new Error("Expected runner source SHA must be a full 40-hex commit SHA.");
    }
    if (expectedSourceCommit.toLowerCase() !== immutableSourceCommit) {
      throw new Error(
        `Runner source SHA mismatch (expected ${expectedSourceCommit.toLowerCase()}, observed ${immutableSourceCommit}).`
      );
    }
  }

  if (verifyPolicyCleanliness) {
    const [trackedDiff, untracked] = await Promise.all([
      runCommand("git", ["diff", "--name-only", "--no-renames", "-z", immutableSourceCommit, "--"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: "verify pinned tracked source policy cleanliness",
        captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
        requireCompleteOutput: true,
        quiet: true,
        recordEvents: false,
        cwd: codeRoot
      }),
      runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: "verify pinned untracked source policy cleanliness",
        captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
        requireCompleteOutput: true,
        quiet: true,
        recordEvents: false,
        cwd: codeRoot
      })
    ]);
    const dirtyPolicyPaths = [...new Set([
      ...parseNulPaths(trackedDiff.stdout),
      ...parseNulPaths(untracked.stdout)
    ].filter(isProtectedSourcePolicyPath))].sort();
    if (dirtyPolicyPaths.length > 0) {
      throw new Error(
        `Pinned source executable/policy files are not byte-bound to ${immutableSourceCommit}: ${dirtyPolicyPaths.join(", ")}`
      );
    }
  }
  await assertNoTrackedSymlinksAtCommit(immutableSourceCommit, {
    label: "pinned source commit",
    repositoryRoot: codeRoot
  });
  return immutableSourceCommit;
}

async function assertTrustedPublicationBaseCommit(commit, { label, allowInertCodeDrift = false }) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit))) {
    throw new Error(`${label} is not a full 40-hex commit SHA.`);
  }
  const immutableSourceCommit = await resolveSourceExecutionCommit();
  const sourceReachable = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", immutableSourceCommit, commit],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: `verify source reachability for ${label}`,
      allowedExitCodes: [0, 1],
      quiet: true,
      recordEvents: false,
      cwd: pinnedSourceRoot
    }
  );
  if (sourceReachable.code !== 0) {
    throw new Error(`${label} ${commit} does not descend from pinned source ${immutableSourceCommit}.`);
  }
  const changed = await runCommand(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", immutableSourceCommit, commit, "--"],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: `inspect data-only drift for ${label}`,
      captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
      requireCompleteOutput: true,
      quiet: true,
      recordEvents: false,
      cwd: pinnedSourceRoot
    }
  );
  const changedPaths = parseNulPaths(changed.stdout);
  if (allowInertCodeDrift) {
    assertSafeInertPublicationBaseChanges(changedPaths, { label });
  } else {
    assertReplaySafePublicationChanges(changedPaths, { label });
  }
  await assertNoTrackedSymlinksAtCommit(commit, { label });
  return commit.toLowerCase();
}

async function assertNoTrackedSymlinksAtCommit(
  commit,
  { label, repositoryRoot = pinnedSourceRoot }
) {
  const tree = await runCommand("git", ["ls-tree", "-r", "-z", "--full-tree", commit], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: `inspect tracked file modes for ${label}`,
    captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
    requireCompleteOutput: true,
    quiet: true,
    recordEvents: false,
    cwd: repositoryRoot
  });
  const unsafeEntries = unsafeTrackedTreeEntries(tree.stdout);
  if (unsafeEntries.length > 0) {
    throw new Error(`${label} contains prohibited tracked symlink/submodule entries: ${unsafeEntries.join(", ")}`);
  }
}

function assertNoTrackedSymlinksAtCommitSync(
  commit,
  { label, repositoryRoot = pinnedSourceRoot }
) {
  const tree = spawnSync(
    "git",
    ["-C", repositoryRoot, "ls-tree", "-r", "-z", "--full-tree", commit],
    {
      encoding: "utf8",
      timeout: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      maxBuffer: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: cleanEnv(process.env.PATH) ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_VALUE_1: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0"
      }
    }
  );
  if (tree.error || tree.status !== 0) {
    throw new Error(
      `Could not inspect tracked file modes for ${label}: ${tree.error?.message ?? tree.stderr?.trim() ?? `git exited ${tree.status}`}`
    );
  }
  const unsafeEntries = unsafeTrackedTreeEntries(tree.stdout);
  if (unsafeEntries.length > 0) {
    throw new Error(`${label} contains prohibited tracked symlink/submodule entries: ${unsafeEntries.join(", ")}`);
  }
}

function unsafeTrackedTreeEntries(treeOutput) {
  return String(treeOutput).split("\0").filter(Boolean).flatMap((entry) => {
    const match = entry.match(/^(\d{6})\s+\S+\s+[0-9a-f]+\t([\s\S]+)$/i);
    if (!match || !["120000", "160000"].includes(match[1])) return [];
    return [`${match[2]} (${match[1]})`];
  });
}

function parseNulPaths(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

async function exposePinnedDependenciesToPublicationWorktree() {
  const sourceNodeModules = sourcePath("node_modules");
  try {
    await stat(sourceNodeModules);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const targetNodeModules = join(publicationRoot, "node_modules");
  try {
    await symlink(
      sourceNodeModules,
      targetNodeModules,
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

async function cleanupPublicationWorktree() {
  if (publicationWorktreeCleanupPromise) return publicationWorktreeCleanupPromise;
  if (!publicationWorktreeParent && !publicationRoot) return;
  const parent = publicationWorktreeParent;
  const target = publicationRoot;
  publicationWorktreeCleanupPromise = (async () => {
    if (target) {
      await runCommand(
        "git",
        ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", target],
        {
          timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
          label: "remove isolated publication worktree",
          allowedExitCodes: [0, 128],
          cancellationCleanup: true,
          cwd: root
        }
      ).catch(() => {});
    }
    if (parent) {
      const parentName = basename(parent);
      if (!parentName.startsWith("returner-publication-")) {
        throw new Error(`Refusing to remove unexpected publication worktree parent ${parent}.`);
      }
      await rm(parent, { recursive: true, force: true });
    }
    await runCommand("git", ["worktree", "prune"], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "prune isolated publication worktree metadata",
      allowedExitCodes: [0, 128],
      cancellationCleanup: true,
      cwd: root
    }).catch(() => {});
    publicationRoot = null;
    publicationWorktreeParent = null;
    configurePublicationArtifactPaths(root);
  })().finally(() => {
    publicationWorktreeCleanupPromise = null;
  });
  return publicationWorktreeCleanupPromise;
}

async function publishGithubExports(snapshots, { baseRef = null } = {}) {
  const targetRoot = publicationArtifactRoot();
  const destinations = new Map([
    ["S2026", join(targetRoot, "src", "lib", "social", "github-traction.json")],
    ["S26", join(targetRoot, "src", "lib", "social", "github-traction-summer-2026.json")],
    ["A16ZSR006", join(targetRoot, "src", "lib", "social", "github-traction-a16z-speedrun-006.json")]
  ]);

  // Read every canonical export before writing any of them. A missing or
  // malformed cohort snapshot must abort the merge without partially replacing
  // another cohort's last-good GitHub state.
  const previousByBatch = new Map(await Promise.all(
    [...destinations].map(async ([batchSlug, destination]) => [
      batchSlug,
      await readRequiredCanonicalJson(
        destination,
        `Canonical GitHub traction snapshot for ${batchSlug}`
      )
    ])
  ));

  const snapshotByBatch = new Map();
  for (const snapshot of snapshots) {
    const batchSlug = snapshot?.source?.batchSlug;
    if (!destinations.has(batchSlug)) {
      throw new Error(`No GitHub publication destination is configured for ${batchSlug ?? "unknown"}.`);
    }
    if (snapshotByBatch.has(batchSlug)) {
      throw new Error(`Duplicate GitHub publication receipt for ${batchSlug}.`);
    }
    snapshotByBatch.set(batchSlug, snapshot);
  }
  const missingBatches = [...destinations.keys()].filter((batchSlug) => !snapshotByBatch.has(batchSlug));
  if (missingBatches.length) {
    throw new Error(`Missing required GitHub publication receipts: ${missingBatches.join(", ")}.`);
  }

  const publications = [];
  for (const snapshot of snapshots) {
    const batchSlug = snapshot.source.batchSlug;
    const destination = destinations.get(batchSlug);
    const relativeDestination = destination.slice(targetRoot.length + 1);
    const base = baseRef ? await readJsonFromGitRef(baseRef, relativeDestination, null) : null;
    const previous = previousByBatch.get(batchSlug);
    const synchronized = base ? mergeGithubTractionSnapshots(base, previous) : previous;
    const reconciliation = reconcileGithubTractionSnapshots(synchronized, snapshot);
    publications.push({ batchSlug, destination, reconciliation });
  }

  // Compute the complete replacement set and its non-scoring quarantine ledger
  // before mutating any canonical export. Whole authoritative receipts replace
  // exactly; partial/failed receipts preserve last-good rows.
  const existingLedger = await readJson(publishedGithubQuarantinePath, null);
  const canonicalSnapshots = publications.map(({ reconciliation }) => reconciliation.snapshot);
  const quarantineLedger = buildGithubAuthoritativeQuarantineLedger({
    reconciliations: publications.map(({ reconciliation }) => reconciliation),
    canonicalSnapshots,
    existingLedger
  });

  for (const { destination, reconciliation } of publications) {
    await writeJsonAtomic(destination, reconciliation.snapshot);
  }
  await writeJsonAtomic(publishedGithubQuarantinePath, quarantineLedger);
}

async function publishRepositoryArtifacts(publicationRunId, publicationInputs) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    await event(
      "publication.skipped",
      "warning",
      "Repository publication was skipped outside GitHub Actions; generated artifacts remain local.",
      {}
    );
    return { status: "skipped", publishedCommit: null };
  }
  await ensurePublicationWorktree();
  assertIsolatedPublicationWorktree();
  await stageRepositoryArtifacts();
  const branch = publicationBranch();

  assertLeaseHealthy();
  // Even an unchanged tree receives a new empty provenance commit. The
  // workflow validates this execution's exact slot/source/run/attempt tuple;
  // reusing an older commit would make a truthful no-change run unverifiable.
  const firstCommit = await commitPublicationArtifacts({
    amend: false,
    allowUnchangedTree: true
  });
  const publicationOutcome = await pushPublicationCandidateWithConcurrentMainRecovery({
    initialCandidate: {
      ...firstCommit,
      publicationBaseCommit,
      proofLabel: "initial publication candidate"
    },
    branch,
    rebuildCandidate: ({ retryBaseCommit, candidate, attempt }) =>
      rebuildPublicationCandidateOnConcurrentBase({
        retryBaseCommit,
        candidate,
        attempt,
        publicationRunId,
        publicationInputs
      })
  });
  const {
    candidate: publishedCandidate,
    publicationTreeChanged,
    attempts: publicationAttempts,
    concurrentMainRetries
  } = publicationOutcome;
  const publishedCommit = publishedCandidate.publishedCommit;
  if (!publishedCommit) {
    throw new Error("Publication push completed without capturing its exact commit SHA.");
  }
  await verifyPublicationCommitOnRemote(publishedCommit, {
    branch,
    label: "published publication"
  });
  const publicationStatus = publicationTreeChanged ? "published" : "no_changes";
  await event(
    publicationTreeChanged ? "publication.completed" : "publication.no_changes",
    "info",
    publicationTreeChanged
      ? "Refreshed artifacts were committed and pushed."
      : "No semantic artifact content changed; an immutable provenance commit was pushed.",
    {
    idempotencyKey,
    publicationRunId,
    branch,
    retriedAfterNonFastForward: concurrentMainRetries > 0,
    publicationAttempts,
    concurrentMainRetries,
    publishedPaths: repositoryArtifactPaths()
    }
  );
  return {
    status: publicationStatus,
    publishedCommit,
    receiptSha256: publicationReceiptSha256
  };
}

async function pushPublicationCandidateWithConcurrentMainRecovery({
  initialCandidate,
  branch,
  rebuildCandidate,
  pushCandidate = pushPublicationCandidateAttempt,
  fetchRetryBase = fetchExactPublicationRetryBase,
  adoptCandidate = adoptReachablePublicationCandidate,
  onRetry = recordPublicationPushRetry
}) {
  let candidate = initialCandidate;
  let attempts = 0;
  let concurrentMainRetries = 0;
  let publicationTreeChanged = false;

  while (attempts < MAX_PUBLICATION_PUSH_ATTEMPTS) {
    attempts += 1;
    assertLeaseHealthy();
    publicationTreeChanged = await verifyAndClassifyPublicationCandidate(candidate);
    publicationReceiptSha256 = candidate.receiptSha256;
    retainPublicationPushCandidate(candidate);

    const pushResult = await pushCandidate(candidate, { attempt: attempts, branch });
    if (pushResult.code === 0) {
      markPublicationCandidatePublished(candidate);
      return {
        candidate,
        publicationTreeChanged,
        attempts,
        concurrentMainRetries,
        adoptedAfterAmbiguousPush: pushResult.reconciledAfterAmbiguousFailure === true
      };
    }

    if (await adoptCandidate(candidate, {
      branch,
      label: `${candidate.proofLabel} post-push reconciliation`
    })) {
      markPublicationCandidatePublished(candidate);
      return {
        candidate,
        publicationTreeChanged,
        attempts,
        concurrentMainRetries,
        adoptedAfterAmbiguousPush: true
      };
    }

    const concurrentMain = isConcurrentMainPushRejection(pushResult);
    const retryableTransportFailure = pushResult.retryableTransportFailure === true;
    if (!concurrentMain && !retryableTransportFailure) {
      throw publicationPushResultError(
        `${candidate.proofLabel} was rejected for a non-concurrent reason; refusing publication retry.`,
        pushResult
      );
    }
    if (attempts >= MAX_PUBLICATION_PUSH_ATTEMPTS) {
      throw publicationPushResultError(
        `Publication did not converge after ${MAX_PUBLICATION_PUSH_ATTEMPTS} bounded push attempts.`,
        pushResult
      );
    }

    await onRetry({
      attempt: attempts,
      nextAttempt: attempts + 1,
      branch,
      candidate,
      pushResult,
      concurrentMain,
      retryableTransportFailure
    });
    assertLeaseHealthy();
    const retryBaseCommit = await fetchRetryBase({
      branch,
      attempt: attempts + 1
    });

    // A failed or lost push response can race a transient reconciliation
    // failure. The exact fetched branch tip is authoritative: adopt the
    // already-proven candidate if it is now reachable before mutating HEAD.
    if (await adoptCandidate(candidate, {
      branch,
      remoteTipCommit: retryBaseCommit,
      label: `${candidate.proofLabel} fetched-tip reconciliation`
    })) {
      markPublicationCandidatePublished(candidate);
      return {
        candidate,
        publicationTreeChanged,
        attempts,
        concurrentMainRetries,
        adoptedAfterAmbiguousPush: true
      };
    }
    if (retryBaseCommit === candidate.publishedCommit) {
      throw new Error(
        `Fetched ${branch} tip equals ${candidate.publishedCommit}, but exact candidate identity verification failed.`
      );
    }

    if (retryBaseCommit === candidate.publicationBaseCommit) {
      if (concurrentMain) {
        throw new Error(
          `Publication reported concurrent ${branch} drift, but the exact fetched tip remained ` +
          `${retryBaseCommit}; refusing an ambiguous rebuild.`
        );
      }
      // A retryable transport failure with an unchanged remote base can safely
      // retry the same already-proven direct-child candidate.
      continue;
    }

    const supersededCandidate = candidate;
    const rebuiltCandidate = await rebuildCandidate({
      retryBaseCommit,
      candidate: supersededCandidate,
      attempt: attempts + 1
    });
    if (rebuiltCandidate.publicationBaseCommit !== retryBaseCommit) {
      throw new Error(
        `Publication retry candidate parent binding ${rebuiltCandidate.publicationBaseCommit ?? "missing"} ` +
        `does not match exact retry base ${retryBaseCommit}.`
      );
    }
    supersedePublicationPushCandidate(supersededCandidate, rebuiltCandidate, {
      provenUnreachableAtRemoteTip: retryBaseCommit
    });
    candidate = rebuiltCandidate;
    concurrentMainRetries += 1;
  }

  throw new Error("Publication retry loop exhausted without a verified candidate.");
}

async function pushPublicationCandidateAttempt(candidate, { attempt, branch }) {
  const firstAttempt = attempt === 1;
  const pushCandidate = {
    ...candidate,
    branch,
    label: firstAttempt ? "first publication push" : `publication retry push ${attempt}`
  };
  return runPublicationPush(pushCandidate, {
    commandLabel: firstAttempt
      ? "push refreshed artifacts"
      : `retry refreshed artifact push ${attempt}`,
    allowedExitCodes: [0, 1],
    retryTransportFailures: true
  });
}

async function fetchExactPublicationRetryBase({ branch, attempt }) {
  await runCommand("git", [
    "-C",
    publicationRoot,
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: `fetch publication retry base for attempt ${attempt}`,
    envCategory: "publication_push",
    env: publicationPushAuthEnvironment(),
    cwd: root
  });
  const retryBaseCommit = (await runCommand(
    "git",
    ["rev-parse", `refs/remotes/origin/${branch}^{commit}`],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: `resolve publication retry base for attempt ${attempt}`,
      cwd: root
    }
  )).stdout.trim().toLowerCase();
  await assertTrustedPublicationBaseCommit(retryBaseCommit, {
    label: `publication retry base for attempt ${attempt}`,
    allowInertCodeDrift: true
  });
  return retryBaseCommit;
}

async function rebuildPublicationCandidateOnConcurrentBase({
  retryBaseCommit,
  candidate,
  attempt,
  publicationRunId,
  publicationInputs
}) {
  const validatedCandidateReuse = await inspectValidatedPublicationCandidateReuse({
    retryBaseCommit,
    candidateCommit: candidate.publishedCommit,
    candidateBaseCommit: candidate.publicationBaseCommit
  });
  await transplantPublicationArtifactsOntoRetryBase({
    retryBaseCommit,
    candidateCommit: candidate.publishedCommit,
    candidateBaseCommit: candidate.publicationBaseCommit
  });
  publicationBaseCommit = retryBaseCommit;

  if (validatedCandidateReuse) {
    // The prior candidate passed the complete artifact/manifest validation
    // suite. Dashboard-only concurrent drift is disjoint from that candidate
    // and is not an ingestion input, so retain the newer dashboard bytes and
    // create a fresh direct child without loading the evidence corpus again.
    await stageRepositoryArtifacts();
    assertLeaseHealthy();
    const retryCommit = await commitPublicationArtifacts({
      amend: false,
      allowUnchangedTree: true
    });
    await assertPublicationCandidateProof(retryCommit.publishedCommit, retryBaseCommit, {
      label: `reused validated publication candidate ${attempt}`
    });
    const retriedDelta = await readGitRawDelta(retryBaseCommit, retryCommit.publishedCommit, {
      label: "verify reused validated publication artifact delta"
    });
    if (JSON.stringify(retriedDelta) !== JSON.stringify(validatedCandidateReuse.candidateDelta)) {
      throw new Error(
        "Reused publication candidate does not exactly preserve the validated path/status/mode/blob delta."
      );
    }
    if (JSON.stringify(retryCommit.provenance) !== JSON.stringify(candidate.provenance)) {
      throw new Error("Reused publication candidate changed immutable receipt provenance.");
    }
    return {
      ...retryCommit,
      publicationBaseCommit: retryBaseCommit,
      proofLabel: `publication retry candidate ${attempt}`
    };
  }

  const rebasedSanitizedTargetedSnapshot = await prepareSanitizedTargetedSnapshot(
    publicationInputs.topVoiceRefresh,
    { baseRef: publicationBaseCommit }
  );
  const rebasedLoggedInEvidenceSnapshot = await prepareMergedLoggedInEvidenceSnapshot(
    publicationInputs.loggedInEvidenceSnapshots,
    { baseRef: publicationBaseCommit }
  );
  await writeJsonAtomic(
    join(publicationArtifactRoot(), "src/lib/social/logged-in-evidence-current.json"),
    rebasedLoggedInEvidenceSnapshot
  );
  const rebasedContentIdentityReferenceRows = await readCanonicalContentIdentityReferenceRows(
    rebasedSanitizedTargetedSnapshot,
    { baseRef: publicationBaseCommit }
  );
  const rebasedLoggedInAttributionReconciliationLedger =
    await readCanonicalLoggedInAttributionReconciliationLedger({ baseRef: publicationBaseCommit });
  const rebasedSeededAttributionReconciliationLedger =
    await readCanonicalSeededAttributionReconciliationLedger({ baseRef: publicationBaseCommit });
  const rebasedSanitizedPublicSnapshot = await prepareSanitizedPublicSnapshot(
    publicationInputs.publicSnapshots,
    {
      baseRef: publicationBaseCommit,
      contentIdentityReferenceRows: rebasedContentIdentityReferenceRows
    }
  );
  const rebasedPublicationInputs = {
    ...publicationInputs,
    loggedInEvidenceSnapshot: rebasedLoggedInEvidenceSnapshot,
    sanitizedPublicSnapshot: rebasedSanitizedPublicSnapshot,
    sanitizedTargetedSnapshot: rebasedSanitizedTargetedSnapshot
  };
  const [rebasedBaseline, rebasedSourceDeltaHistory] = await Promise.all([
    readPublicationEvidenceBaseline({ baseRef: publicationBaseCommit }),
    readSourceDeltaHistory({ baseRef: publicationBaseCommit })
  ]);
  const retryDurableImport = await importDurableEvidence({
    publicSnapshots: [
      rebasedSanitizedPublicSnapshot,
      rebasedSanitizedTargetedSnapshot,
      rebasedLoggedInEvidenceSnapshot
    ].filter(Boolean),
    githubSnapshots: publicationInputs.githubSnapshots,
    catalogState: publicationInputs.catalogState,
    attributionReconciliationLedger: combineAttributionReconciliationLedgers(
      rebasedSanitizedPublicSnapshot?.attributionReconciliationLedger,
      rebasedSanitizedTargetedSnapshot?.attributionReconciliationLedger,
      rebasedLoggedInAttributionReconciliationLedger,
      rebasedSeededAttributionReconciliationLedger
    )
  });
  assertDurableAttributionCompleteness(retryDurableImport);
  await mergePublicationInputs(rebasedPublicationInputs, { baseRef: publicationBaseCommit });
  rebasedPublicationInputs.sourceDelta = {
    ...summarizeIngestionSourceDelta({
      idempotencyKey,
      beforeSnapshots: rebasedBaseline,
      afterSnapshots: await readPublicationEvidenceBaseline(),
      previousHistory: rebasedSourceDeltaHistory,
      mappedFailures: publicationInputs.sourceDelta?.mappedFailures ?? 0,
      collectionCoverage: publicationInputs.collectionCoverage,
      credentialGaps: publicationInputs.credentialGaps
    }),
    ...publicationCandidateReceiptFields(),
    mappedExpected: publicationInputs.collectionCoverage.mappedExpected,
    mappedNonTerminal: publicationInputs.collectionCoverage.mappedNonTerminal,
    terminalFailureBudget: publicationInputs.sourceDelta.terminalFailureBudget
  };
  await writeSourceDeltaReceipt(rebasedPublicationInputs.sourceDelta, rebasedSourceDeltaHistory);
  await buildAndValidatePublication(publicationRunId, publicationInputs.catalogState);
  await stageRepositoryArtifacts();
  assertLeaseHealthy();
  const retryCommit = await commitPublicationArtifacts({
    amend: false,
    allowUnchangedTree: true
  });
  publicationInputs.sourceDelta = rebasedPublicationInputs.sourceDelta;
  return {
    ...retryCommit,
    publicationBaseCommit: retryBaseCommit,
    proofLabel: `publication retry candidate ${attempt}`
  };
}

async function inspectValidatedPublicationCandidateReuse({
  retryBaseCommit,
  candidateCommit,
  candidateBaseCommit
}) {
  const descendsFromCandidateBase = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", candidateBaseCommit, retryBaseCommit],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "verify publication retry base descends from candidate base",
      allowedExitCodes: [0, 1],
      quiet: true,
      recordEvents: false,
      cwd: publicationRoot
    }
  );
  if (descendsFromCandidateBase.code !== 0) return false;

  const [concurrentDelta, candidateDelta] = await Promise.all([
    readGitRawDelta(candidateBaseCommit, retryBaseCommit, {
      label: "inspect concurrent publication retry drift"
    }),
    readGitRawDelta(candidateBaseCommit, candidateCommit, {
      label: "inspect validated publication candidate drift"
    })
  ]);
  const expectedDashboardPaths = new Set([
    "artifacts/dashboard/current.json",
    "public/dashboard/feed.json"
  ]);
  if (
    concurrentDelta.length !== expectedDashboardPaths.size ||
    concurrentDelta.some(({ path, status, oldMode, newMode }) =>
      !expectedDashboardPaths.has(path) ||
      !isValidatedPublicationRetryReuseSafePath(path) ||
      status !== "M" ||
      oldMode !== "100644" ||
      newMode !== "100644"
    ) ||
    candidateDelta.some(({ path }) => isValidatedPublicationRetryReuseSafePath(path))
  ) {
    return null;
  }
  return { candidateDelta };
}

async function readGitRawDelta(baseCommit, targetCommit, { label }) {
  const changed = await runCommand(
    "git",
    ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", baseCommit, targetCommit, "--"],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label,
      captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
      requireCompleteOutput: true,
      quiet: true,
      recordEvents: false,
      cwd: publicationRoot
    }
  );
  return parseGitRawDeltaNul(changed.stdout);
}

async function verifyAndClassifyPublicationCandidate(candidate) {
  await verifyPublicationCandidateIdentity(candidate);
  return classifyPublicationSemantics({
    baseRef: candidate.publicationBaseCommit,
    targetRef: candidate.publishedCommit,
    label: candidate.proofLabel
  });
}

async function verifyPublicationCandidateIdentity(candidate) {
  if (!candidate?.provenance || candidate.receiptSha256 !== candidate.provenance.receiptSha256) {
    throw new Error(`${candidate?.proofLabel ?? "Publication candidate"} has inconsistent receipt provenance.`);
  }
  await assertPublicationCandidateProof(
    candidate.publishedCommit,
    candidate.publicationBaseCommit,
    { label: candidate.proofLabel }
  );
  await verifyPublicationCommitProvenance(candidate.publishedCommit, candidate.provenance);
}

async function adoptReachablePublicationCandidate(candidate, {
  branch,
  remoteTipCommit = null,
  label
}) {
  let reachable = false;
  if (remoteTipCommit !== null) {
    const tip = String(remoteTipCommit).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(tip)) {
      throw new Error(`${label} remote tip is not an exact full 40-hex commit SHA.`);
    }
    const result = await runCommand(
      "git",
      ["merge-base", "--is-ancestor", candidate.publishedCommit, tip],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: `verify ${label} reachability`,
        allowedExitCodes: [0, 1],
        quiet: true,
        recordEvents: false,
        cwd: root
      }
    );
    reachable = result.code === 0;
  } else {
    try {
      await verifyPublicationCommitOnRemote(candidate.publishedCommit, {
        branch,
        label
      });
      reachable = true;
    } catch (error) {
      console.warn(
        `Could not adopt ${candidate.proofLabel} after an ambiguous push: ` +
        sanitizeRunnerDiagnosticText(errorMessage(error))
      );
      return false;
    }
  }
  if (!reachable) return false;
  await verifyPublicationCandidateIdentity(candidate);
  markPublicationCandidatePublished(candidate);
  return true;
}

function markPublicationCandidatePublished(candidate) {
  retainPublicationPushCandidate(candidate);
  latestPublishedCommit = candidate.publishedCommit;
  publicationReceiptSha256 = candidate.receiptSha256;
}

function isConcurrentMainPushRejection(result) {
  const diagnostics = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  return /non-fast-forward/i.test(diagnostics) ||
    /\[rejected\][^\n]*(?:fetch first|stale info)/i.test(diagnostics) ||
    /updates were rejected because the remote contains work/i.test(diagnostics) ||
    /tip of your current branch is behind/i.test(diagnostics);
}

function publicationPushResultError(message, result) {
  return commandExecutionError(message, {
    code: Number.isInteger(result?.code) ? result.code : null,
    signal: result?.signal ?? null,
    timedOut: result?.timedOut === true,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? ""
  });
}

async function recordPublicationPushRetry({
  attempt,
  nextAttempt,
  branch,
  pushResult,
  concurrentMain,
  retryableTransportFailure
}) {
  await event(
    "publication.push_retry",
    "warning",
    "Publication was not confirmed; fetching exact main and preserving the allowlisted artifact delta before a bounded retry.",
    {
      branch,
      attempt,
      nextAttempt,
      maximumAttempts: MAX_PUBLICATION_PUSH_ATTEMPTS,
      concurrentMain,
      retryableTransportFailure,
      stderr: sanitizeRunnerDiagnosticText(pushResult?.stderr ?? "")
    }
  );
}

async function stageRepositoryArtifacts() {
  assertIsolatedPublicationWorktree();
  await runCommand("git", [
    "add", "--",
    ...repositoryArtifactPaths()
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitStageMs,
    label: "stage refreshed artifacts",
    cwd: publicationRoot
  });
}

async function transplantPublicationArtifactsOntoRetryBase({
  retryBaseCommit,
  candidateCommit,
  candidateBaseCommit
}) {
  // The remote tip is a Git base only. It is never used as the executable
  // source of any privileged child process. Resetting first gives us its
  // concurrent code/data tree; restoring the exact first-candidate artifact
  // delta preserves generated additions, replacements, and deletions before
  // the pinned-source semantic merge and rebuild run again.
  await assertNoTrackedSymlinksAtCommit(retryBaseCommit, {
    label: "publication retry base"
  });
  await assertNoTrackedSymlinksAtCommit(candidateCommit, {
    label: "initial publication candidate"
  });
  const changed = await runCommand(
    "git",
    [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      candidateBaseCommit,
      candidateCommit,
      "--",
      ...repositoryArtifactPaths()
    ],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "inspect generated artifact delta for publication retry",
      captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
      requireCompleteOutput: true,
      quiet: true,
      recordEvents: false,
      cwd: root
    }
  );
  const changes = parseGitNameStatusNul(changed.stdout);
  assertReplaySafePublicationChanges(changes.map(({ path }) => path), {
    label: "initial publication candidate"
  });
  await runCommand("git", ["-c", "core.hooksPath=/dev/null", "reset", "--hard", retryBaseCommit], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: "reset publication worktree to concurrent main",
    cwd: publicationRoot
  });
  const deleted = changes.filter(({ status }) => status === "D").map(({ path }) => path);
  if (deleted.length > 0) {
    await runCommand("git", ["-c", "core.hooksPath=/dev/null", "rm", "-f", "--ignore-unmatch", "--", ...deleted], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitStageMs,
      label: "restore generated artifact deletions for publication retry",
      allowedExitCodes: [0],
      cwd: publicationRoot
    });
    await assertPublicationArtifactsDeletedFromRetryWorktree(deleted);
  }
  const restored = changes
    .filter(({ status }) => status !== "D")
    .map(({ path }) => path);
  if (restored.length > 0) {
    await runCommand(
      "git",
      ["-c", "core.hooksPath=/dev/null", "checkout", candidateCommit, "--", ...restored],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitStageMs,
        label: "restore generated artifacts for publication retry",
        cwd: publicationRoot
      }
    );
  }
}

async function assertPublicationArtifactsDeletedFromRetryWorktree(paths) {
  const undeleted = [];
  for (const filePath of paths) {
    const indexed = await runCommand(
      "git",
      ["ls-files", "--stage", "--", filePath],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: `verify deleted artifact index state for ${filePath}`,
        captureLimit: 100_000,
        quiet: true,
        recordEvents: false,
        cwd: publicationRoot
      }
    );
    let existsInWorktree = false;
    try {
      await stat(join(publicationRoot, filePath));
      existsInWorktree = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (indexed.stdout.trim() || existsInWorktree) undeleted.push(filePath);
  }
  if (undeleted.length > 0) {
    throw new Error(
      `Publication retry failed to delete generated artifacts from the index and worktree: ${undeleted.join(", ")}`
    );
  }
}

function parseGitNameStatusNul(value) {
  const tokens = String(value ?? "").split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const path = tokens[index++];
    if (!path || !/^[AMD]$/.test(status)) {
      throw new Error("Git publication artifact delta had an unsupported name-status record.");
    }
    changes.push({ status, path });
  }
  return changes;
}

function parseGitRawDeltaNul(value) {
  const tokens = String(value ?? "").split("\0").filter(Boolean);
  if (tokens.length % 2 !== 0) {
    throw new Error("Git raw publication delta had an incomplete record.");
  }
  const changes = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const header = tokens[index];
    const path = tokens[index + 1];
    const match = header.match(
      /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/
    );
    if (!match || !path) {
      throw new Error("Git raw publication delta had an unsupported record.");
    }
    changes.push({
      path,
      status: match[5],
      oldMode: match[1],
      newMode: match[2],
      oldObject: match[3],
      newObject: match[4]
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function repositoryArtifactPaths() {
  return [
    "src/lib/yc/summer-2026-companies.json",
    "src/lib/yc/summer-2026-company-aliases.json",
    "public/graph",
    "public/timelines",
    "public/topic-facets",
    "public/dashboard/feed.json",
    "src/lib/graph/ranked-posts-sidecar.generated.json",
    "artifacts/company-timeline/coverage.json",
    "artifacts/company-timeline/public-discovery-current.json",
    "artifacts/dashboard/current.json",
    "outputs/benchmarks",
    "outputs/cohort-coverage-current.json",
    "outputs/ingestion-source-delta-current.json",
    "outputs/ingestion-source-delta-history.json",
    "outputs/discovery-attempts-current.json",
    "outputs/source-discovery-paths-current.json",
    "outputs/public-ingestion-operational-ledger-current.json",
    "outputs/public-ingestion-review-ledger-current.json",
    "docs/outputs/scoring-diagnostics-v4-audit.json",
    "docs/outputs/scoring-diagnostics-v4-report.md",
    "src/lib/social/public-evidence-current.json",
    "src/lib/social/targeted-evidence-current.json",
    "src/lib/social/logged-in-evidence-current.json",
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json",
    "src/lib/social/github-traction-quarantine.json"
  ];
}

function assertIsolatedPublicationWorktree() {
  if (!publicationRoot || resolve(publicationRoot) === resolve(root)) {
    throw new Error("Repository publication requires a separate isolated worktree.");
  }
  if (!publicationWorktreeParent || !resolve(publicationRoot).startsWith(`${resolve(publicationWorktreeParent)}/`)) {
    throw new Error("Publication worktree is outside its runner-owned temporary parent.");
  }
}

async function commitPublicationArtifacts({ amend, allowUnchangedTree = false }) {
  assertIsolatedPublicationWorktree();
  const provenance = await publicationCommitProvenance();
  const subject = `Publish autonomous ingestion ${idempotencyKey}`;
  const trailers = publicationCommitTrailers(provenance);
  const commandArgs = [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit"
  ];
  if (amend) commandArgs.push("--amend");
  if (allowUnchangedTree) commandArgs.push("--allow-empty");
  commandArgs.push("-m", subject, "-m", trailers);
  await runCommand("git", commandArgs, {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitCommitMs,
    label: amend ? "amend rebuilt artifacts with immutable provenance" : "commit refreshed artifacts with immutable provenance",
    cwd: publicationRoot
  });
  const publishedCommit = (await runCommand("git", ["rev-parse", "HEAD^{commit}"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "resolve provenance-bound publication commit",
    cwd: publicationRoot
  })).stdout.trim();
  await verifyPublicationCommitProvenance(publishedCommit, provenance);
  return { publishedCommit, receiptSha256: provenance.receiptSha256, provenance };
}

async function assertPublicationCandidateProof(
  candidateCommit,
  publicationBaseCommit,
  { label = "publication candidate" } = {}
) {
  if (!/^[0-9a-f]{40}$/i.test(String(candidateCommit))) {
    throw new Error(`${label} is not a full 40-hex commit SHA.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(String(publicationBaseCommit))) {
    throw new Error(`${label} publication base is not a full 40-hex commit SHA.`);
  }
  const candidate = String(candidateCommit).toLowerCase();
  const expectedParent = String(publicationBaseCommit).toLowerCase();
  const parents = (await runCommand("git", ["show", "-s", "--format=%P", candidate], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: `prove parent identity for ${label}`,
    quiet: true,
    recordEvents: false,
    cwd: publicationRoot
  })).stdout.trim().split(/\s+/).filter(Boolean).map((parent) => parent.toLowerCase());
  if (parents.length !== 1 || parents[0] !== expectedParent) {
    throw new Error(
      `${label} must be a single-parent direct child of ${expectedParent}; observed parents ${parents.join(", ") || "none"}.`
    );
  }
  const changed = await runCommand(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${expectedParent}^{commit}`, candidate, "--"],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: `prove replay-safe artifact delta for ${label}`,
      captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
      requireCompleteOutput: true,
      quiet: true,
      recordEvents: false,
      cwd: publicationRoot
    }
  );
  const changedPaths = parseNulPaths(changed.stdout);
  assertReplaySafePublicationChanges(changedPaths, { label: `${label} parent-to-candidate delta` });
  await assertNoTrackedSymlinksAtCommit(candidate, {
    label: `${label} candidate tree`,
    repositoryRoot: publicationRoot
  });
  return {
    candidateCommit: candidate,
    publicationBaseCommit: expectedParent,
    parentCommit: parents[0],
    changedPaths
  };
}

async function classifyPublicationSemantics({ baseRef, targetRef, label }) {
  const comparison = await comparePublicationSemantics({
    rootDir: publicationRoot,
    baseRef,
    targetRef,
    ignoredPaths: PUBLICATION_SEMANTIC_IGNORED_PATHS
  });
  if (typeof comparison?.changed === "boolean") return comparison.changed;
  throw new Error(`${label} semantic comparison returned an unsupported result.`);
}

async function publicationCommitProvenance() {
  const receiptPath = join(publicationArtifactRoot(), "outputs", "ingestion-source-delta-current.json");
  const receiptBytes = await readFile(receiptPath);
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Publication receipt is not valid JSON: ${errorMessage(error)}`);
  }
  if (receipt?.idempotencyKey !== idempotencyKey) {
    throw new Error(
      `Publication receipt belongs to ${receipt?.idempotencyKey ?? "no slot"}, expected ${idempotencyKey}.`
    );
  }
  const expectedCandidateFields = publicationCandidateReceiptFields({ required: true });
  if (
    receipt?.trigger !== expectedCandidateFields.trigger ||
    receipt?.scheduledAt !== expectedCandidateFields.scheduledAt
  ) {
    throw new Error(
      "Publication receipt trigger/scheduledAt metadata is not bound to the accepted candidate."
    );
  }
  const provenance = {
    slotKey: idempotencyKey,
    sourceSha: await resolveSourceExecutionCommit(),
    runId: cleanEnv(process.env.GITHUB_RUN_ID) ?? String(run?.id ?? `file-${executionCompletionNonce}`),
    runAttempt: cleanEnv(process.env.GITHUB_RUN_ATTEMPT) ?? "local",
    receiptSha256: createHash("sha256").update(receiptBytes).digest("hex")
  };
  for (const [field, value] of Object.entries(provenance)) {
    if (!value || /[\r\n\0]/.test(value)) {
      throw new Error(`Publication provenance ${field} is empty or contains a control line break.`);
    }
  }
  if (!/^[0-9a-f]{40}$/i.test(provenance.sourceSha)) {
    throw new Error("Publication provenance source SHA is not exact.");
  }
  if (!/^[0-9a-f]{64}$/i.test(provenance.receiptSha256)) {
    throw new Error("Publication provenance receipt hash is not exact.");
  }
  return provenance;
}

function publicationCommitTrailers(provenance) {
  return [
    `Returner-Slot-Key: ${provenance.slotKey}`,
    `Returner-Source-SHA: ${provenance.sourceSha}`,
    `Returner-Run-ID: ${provenance.runId}`,
    `Returner-Run-Attempt: ${provenance.runAttempt}`,
    `Returner-Receipt-SHA256: ${provenance.receiptSha256}`
  ].join("\n");
}

async function verifyPublicationCommitProvenance(commit, expected) {
  const message = (await runCommand("git", ["show", "-s", "--format=%B", commit], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "verify publication commit trailers",
    captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
    requireCompleteOutput: true,
    quiet: true,
    cwd: publicationRoot
  })).stdout;
  for (const trailer of publicationCommitTrailers(expected).split("\n")) {
    const count = message.split("\n").filter((line) => line === trailer).length;
    if (count !== 1) {
      throw new Error(`Publication commit ${commit} must contain exactly one ${trailer.split(":")[0]} trailer.`);
    }
  }
  const committedReceipt = await readTextFromGitRef(
    commit,
    "outputs/ingestion-source-delta-current.json",
    null
  );
  if (committedReceipt === null) {
    throw new Error(`Publication commit ${commit} does not contain its source-delta receipt.`);
  }
  const committedHash = createHash("sha256").update(committedReceipt).digest("hex");
  if (committedHash !== expected.receiptSha256) {
    throw new Error(
      `Publication commit ${commit} receipt hash ${committedHash} does not match trailer ${expected.receiptSha256}.`
    );
  }
}

async function refreshMutableYcCatalog() {
  assertLeaseHealthy();
  const timeoutMs = runnerBudget.timeoutMs(
    AUTONOMOUS_PROCESS_BUDGETS.catalogRefreshMs,
    "official mutable YC catalog refresh"
  );
  try {
    await runCommand(process.execPath, [sourcePath("scripts", "fetch-yc-spring-2026.mjs")], {
      timeoutMs,
      label: "official mutable YC catalog refresh",
      cwd: publicationArtifactRoot()
    });
  } catch (error) {
    throw new Error(
      "Official mutable YC catalog refresh failed; refusing to plan against a stale roster. " +
      errorMessage(error),
      { cause: error }
    );
  }
}

function publicationBranch() {
  const branch = String(process.env.INGESTION_PUBLICATION_BRANCH ?? "main").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`Unsafe publication branch: ${branch || "empty"}.`);
  }
  return branch;
}

async function verifyPublicationCommitOnRemote(
  claimedCommit,
  {
    branch = publicationBranch(),
    label = "publication",
    allowDuringCancellation = false,
    timeoutMs = AUTONOMOUS_PROCESS_BUDGETS.gitPushMs
  } = {}
) {
  const publishedCommit = String(claimedCommit ?? "").trim();
  if (!/^[0-9a-f]{40}$/i.test(publishedCommit)) {
    throw new Error(
      `Publication verification failed: ${label} requires an exact full 40-hex commit SHA.`
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Publication verification failed: ${label} requires a positive timeout.`);
  }
  // Fetch and ancestry are one remote-verification operation. Both commands
  // consume the same absolute budget so a slow fetch cannot leave ancestry a
  // fresh full timeout (especially during cancellation cleanup).
  const remoteVerificationDeadlineAt = Date.now() + Math.floor(timeoutMs);
  await runCommand("git", ["fetch", "--prune", "origin", branch], {
    timeoutMs,
    deadlineAt: remoteVerificationDeadlineAt,
    label: `fetch ${label} remote commit`,
    cancellationCleanup: allowDuringCancellation
  });
  const remoteContainsPublication = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", publishedCommit, `origin/${branch}`],
    {
      timeoutMs: Math.min(timeoutMs, AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs),
      deadlineAt: remoteVerificationDeadlineAt,
      label: `verify ${label} commit ancestry`,
      allowedExitCodes: [0, 1],
      cancellationCleanup: allowDuringCancellation
    }
  );
  if (remoteContainsPublication.code !== 0) {
    throw new Error(
      `Publication verification failed: remote ${branch} does not contain ${publishedCommit}.`
    );
  }
  return publishedCommit;
}

async function reconcilePublicationPushCandidate(candidate, context) {
  if (!candidate) return false;
  try {
    latestPublishedCommit = await verifyPublicationCommitOnRemote(candidate.publishedCommit, {
      branch: candidate.branch,
      label: `${candidate.label} ${context}`,
      // Ambiguity reconciliation is cleanup: it must still run after the push
      // command timed out, lost its response, exhausted the main budget, or
      // observed a termination signal. It has its own small absolute bound.
      allowDuringCancellation: true,
      timeoutMs: CANCELLATION_REMOTE_VERIFY_TIMEOUT_MS
    });
    console.warn(
      `Remote reconciliation confirmed ${candidate.label} at ${latestPublishedCommit} after ${context}.`
    );
    return true;
  } catch (error) {
    const failure = sanitizedRunnerFailure(error);
    console.warn(
      `Remote reconciliation could not confirm ${candidate.label} after ${context}: ${failure.message}`
    );
    return false;
  }
}

async function runPublicationPush(candidate, {
  commandLabel,
  allowedExitCodes = [0],
  retryTransportFailures = false
}) {
  assertIsolatedPublicationWorktree();
  retainPublicationPushCandidate(candidate);
  try {
    const result = await runCommand(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        publicationRoot,
        "push",
        "origin",
        `${candidate.publishedCommit}:${candidate.branch}`
      ],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
        label: commandLabel,
        envCategory: "publication_push",
        env: publicationPushAuthEnvironment(),
        allowedExitCodes,
        // This synchronous guard runs after command.started event I/O and every
        // other awaited setup step, directly before spawn().
        preSpawnGuard: () => {
          assertNoTrackedSymlinksAtCommitSync(candidate.publishedCommit, {
            label: `${candidate.label} candidate`,
            repositoryRoot: publicationRoot
          });
          assertCandidateFreshForPublication(candidate.label);
        },
        cwd: root
      }
    );
    if (result.code === 0) {
      latestPublishedCommit = candidate.publishedCommit;
      return result;
    }
    if (await reconcilePublicationPushCandidate(candidate, `exit ${result.code}`)) {
      return { ...result, code: 0, reconciledAfterAmbiguousFailure: true };
    }
    return result;
  } catch (error) {
    if (error?.preSpawnGuardFailed === true) {
      discardUnspawnedPublicationCandidate(candidate);
      throw error;
    }
    if (await reconcilePublicationPushCandidate(candidate, "failure or response loss")) {
      return {
        code: 0,
        signal: null,
        timedOut: /timed out/i.test(errorMessage(error)),
        stdout: "",
        stderr: "",
        reconciledAfterAmbiguousFailure: true
      };
    }
    if (retryTransportFailures && isRetryableGitTransportFailure(error)) {
      const commandResult = error?.commandResult ?? {};
      return {
        code: Number.isInteger(commandResult.code) ? commandResult.code : 128,
        signal: commandResult.signal ?? null,
        timedOut: commandResult.timedOut === true,
        stdout: commandResult.stdout ?? "",
        stderr: commandResult.stderr ?? errorMessage(error),
        retryableTransportFailure: true
      };
    }
    throw error;
  }
}

function isRetryableGitTransportFailure(error) {
  const result = error?.commandResult ?? {};
  const code = Number.isInteger(result.code) ? result.code : null;
  const diagnostics = `${result.stderr ?? ""}\n${result.stdout ?? ""}\n${errorMessage(error)}`;
  if (/authentication failed|permission denied|repository not found|http\s+(?:401|403)|access denied/i.test(diagnostics)) {
    return false;
  }
  if (result.timedOut === true) return true;
  if (code !== null && !GIT_PUSH_RETRYABLE_EXIT_CODES.has(code)) return false;
  return /could not resolve host|connection (?:timed out|reset|refused|closed)|remote end hung up|tls|ssl|rpc failed|http\s+5\d\d|service unavailable|temporary failure|network|unable to access|operation timed out|early eof|unexpected disconnect/i.test(
    diagnostics
  );
}

function publicationPushAuthEnvironment() {
  const authorizationHeader = githubPublicationAuthorizationHeader();
  if (!authorizationHeader) {
    throw new Error("GITHUB_TOKEN is required for repository publication.");
  }
  return {
    // Inject authentication into this git push process only. No credential is
    // persisted in .git/config while publication tree operations or rebuilt repository code runs.
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: authorizationHeader,
    // A repository-controlled pre-push hook must not inherit the scoped header.
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    // Ignore credential helpers from repository, global, and system config.
    // The process-scoped HTTP header above is the sole authentication source.
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function githubPublicationAuthorizationHeader() {
  const token = cleanEnv(process.env.GITHUB_TOKEN);
  return token
    ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
    : null;
}

function retainPublicationPushCandidate(candidate) {
  const publishedCommit = String(candidate?.publishedCommit ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(publishedCommit)) {
    throw new Error("Cannot retain a publication push candidate without an exact full commit SHA.");
  }
  if (
    publicationPushCandidate &&
    publicationPushCandidate.publishedCommit !== publishedCommit
  ) {
    throw new Error(
      `Refusing to replace possibly-landed publication candidate ` +
      `${publicationPushCandidate.publishedCommit} with ${publishedCommit} without an exact supersession proof.`
    );
  }
  publicationPushCandidate = {
    ...publicationPushCandidate,
    ...candidate,
    publishedCommit,
    branch: candidate.branch ?? publicationPushCandidate?.branch ?? publicationBranch(),
    label: candidate.label ?? candidate.proofLabel ?? publicationPushCandidate?.label ?? "publication candidate"
  };
  publicationSignalAdoptionClosed = false;
  return publicationPushCandidate;
}

function supersedePublicationPushCandidate(previousCandidate, nextCandidate, {
  provenUnreachableAtRemoteTip
}) {
  const previousCommit = String(previousCandidate?.publishedCommit ?? "").trim().toLowerCase();
  const nextCommit = String(nextCandidate?.publishedCommit ?? "").trim().toLowerCase();
  const remoteTip = String(provenUnreachableAtRemoteTip ?? "").trim().toLowerCase();
  if (
    !publicationPushCandidate ||
    publicationPushCandidate.publishedCommit !== previousCommit ||
    !/^[0-9a-f]{40}$/.test(nextCommit) ||
    !/^[0-9a-f]{40}$/.test(remoteTip) ||
    String(nextCandidate?.publicationBaseCommit ?? "").trim().toLowerCase() !== remoteTip
  ) {
    throw new Error("Publication candidate supersession is missing its exact unreachable-tip/base proof.");
  }
  publicationPushCandidate = {
    ...nextCandidate,
    publishedCommit: nextCommit,
    branch: publicationPushCandidate.branch,
    label: nextCandidate.label ?? nextCandidate.proofLabel ?? "publication retry candidate"
  };
  return publicationPushCandidate;
}

function discardUnspawnedPublicationCandidate(candidate) {
  const candidateCommit = String(candidate?.publishedCommit ?? "").trim().toLowerCase();
  if (publicationPushCandidate?.publishedCommit === candidateCommit) {
    publicationPushCandidate = null;
  }
}

function beginPublicationCancellationResolution() {
  if (
    !terminationSignal ||
    publicationSignalAdoptionClosed ||
    !publicationPushCandidate
  ) {
    return Promise.resolve(latestPublishedCommit);
  }
  return resolveAmbiguousPublicationAfterCancellation().catch((error) => {
    console.warn(
      `Publication cancellation reconciliation failed unexpectedly: ` +
      sanitizeRunnerDiagnosticText(errorMessage(error))
    );
    return latestPublishedCommit;
  });
}

async function finalizePublicationSignalAdoptionWindow() {
  // No signal callback can interleave between the final condition check and
  // the synchronous close below. If a signal already arrived, await its one
  // memoized exact remote re-check before retiring the retained candidate.
  if (terminationSignal && publicationPushCandidate) {
    await beginPublicationCancellationResolution();
  }
  publicationSignalAdoptionClosed = true;
  publicationPushCandidate = null;
}

async function resolveAmbiguousPublicationAfterCancellation() {
  if (publicationCancellationResolutionPromise) {
    return publicationCancellationResolutionPromise;
  }
  const candidate = publicationPushCandidate;
  if (!terminationSignal || !candidate) return latestPublishedCommit;
  publicationCancellationResolutionPromise = (async () => {
    await reconcilePublicationPushCandidate(
      candidate,
      `interruption by ${terminationSignal}`
    );
    return latestPublishedCommit;
  })();
  return publicationCancellationResolutionPromise;
}

function bindCompletionProvenance(stats, {
  publicationStatus,
  publishedCommit,
  receipt
}) {
  if (!executionCompletionNonce) {
    throw new Error("Execution completion nonce is unavailable.");
  }
  const normalizedCommit = publishedCommit ?? null;
  if (
    ["published", "no_changes", "already_completed"].includes(publicationStatus) &&
    !/^[0-9a-f]{40}$/i.test(normalizedCommit ?? "")
  ) {
    throw new Error("A repository-backed completion requires its exact 40-hex publication SHA.");
  }
  const statsHash = hashCanonicalJson(stats);
  const provenanceCore = {
    schemaVersion: 1,
    executionNonce: executionCompletionNonce,
    idempotencyKey,
    runId: run?.id ?? null,
    publicationStatus,
    publishedCommit: normalizedCommit,
    receiptHash: hashCanonicalJson(receipt),
    receiptFileSha256: publicationReceiptSha256,
    statsHash
  };
  return {
    ...stats,
    completionProvenance: {
      ...provenanceCore,
      fingerprint: hashCanonicalJson(provenanceCore)
    }
  };
}

function completionProvenanceMatches(storedStats, expectedStats) {
  if (!storedStats || typeof storedStats !== "object" || Array.isArray(storedStats)) return false;
  const expected = expectedStats?.completionProvenance;
  const stored = storedStats.completionProvenance;
  if (!expected || !stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  const storedBaseStats = { ...storedStats };
  delete storedBaseStats.completionProvenance;
  const { fingerprint: storedFingerprint, ...storedCore } = stored;
  return canonicalJson(stored) === canonicalJson(expected) &&
    stored.statsHash === hashCanonicalJson(storedBaseStats) &&
    storedFingerprint === hashCanonicalJson(storedCore) &&
    stored.executionNonce === executionCompletionNonce &&
    stored.idempotencyKey === idempotencyKey &&
    String(stored.runId) === String(run?.id ?? "") &&
    stored.publishedCommit === expected.publishedCommit &&
    stored.receiptHash === expected.receiptHash;
}

function hashCanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

async function completeRun(status, stats) {
  if (!run?.id) return null;
  if (status === "completed") assertLeaseHealthy();
  if (runFinalizationPromise) {
    await runFinalizationPromise.catch(() => {});
    if (finalizedRunStatus) return finalizedRunStatus;
    return completeRun(status, stats);
  }
  const finalization = finalizeRunWithClaimedLease(status, stats);
  runFinalizationPromise = finalization;
  try {
    await finalization;
    if (status === "completed") completedOutcomeVerifiedByThisExecution = true;
    finalizedRunStatus = status;
    return finalizedRunStatus;
  } catch (error) {
    if (runFinalizationPromise === finalization) runFinalizationPromise = null;
    throw error;
  }
}

async function finalizeRunWithClaimedLease(status, stats) {
  const runSnapshot = {
    id: run.id,
    leaseOwner: workerId,
    leaseToken: run.lease_token
  };
  if (!runSnapshot.leaseToken) {
    throw new Error(`Cannot mark ingestion run ${status} without its claimed lease token.`);
  }
  if (status === "completed") {
    assertLeaseHealthy();
    if (!completionProvenanceMatches(stats, stats)) {
      throw new Error(
        "Completed ingestion finalization is missing exact execution/publication/receipt provenance."
      );
    }
    let finalizationFailure = null;
    try {
      const { data, error } = await runSupabaseOperation(
        "atomically finalize completed ingestion run",
        () => supabase.rpc("finalize_completed_ingestion_run", {
          p_run_id: runSnapshot.id,
          p_lease_owner: runSnapshot.leaseOwner,
          p_lease_token: runSnapshot.leaseToken,
          p_stats_json: stats
        })
      );
      check(error, "atomically finalize completed ingestion run");
      const finalized = Array.isArray(data) ? data[0] ?? null : data;
      if (finalized) {
        run = finalized;
        return;
      }
      finalizationFailure = new Error(
        "The ingestion run lease was lost before atomic finalization."
      );
    } catch (error) {
      finalizationFailure = error;
    }
    try {
      const reconciled = await reconcileAmbiguousCompletedRun(runSnapshot, stats);
      if (reconciled) {
        run = reconciled;
        return;
      }
    } catch (reconciliationError) {
      throw new Error(
        `${errorMessage(finalizationFailure)} Completion reconciliation failed: ` +
        errorMessage(reconciliationError),
        { cause: finalizationFailure }
      );
    }
    throw finalizationFailure;
  }
  const finishedAt = new Date().toISOString();
  const update = supabase
    .from("ingestion_runs")
    .update({
      status,
      finished_at: finishedAt,
      heartbeat_at: finishedAt,
      lease_expires_at: null,
      lease_owner: null,
      lease_token: null,
      stats_json: stats,
      errors_json: ["failed", "canceled"].includes(status)
        ? [stats.error ?? `unknown ${status} outcome`]
        : []
    })
    .eq("id", runSnapshot.id)
    .eq("lease_owner", runSnapshot.leaseOwner)
    .eq("lease_token", runSnapshot.leaseToken)
    .select("*");
  const { data, error } = await runSupabaseOperation(
    `mark ingestion run ${status} with its claimed lease`,
    () => update.maybeSingle()
  );
  check(error, `mark ingestion run ${status} with its claimed lease`);
  if (!data) throw new Error(`The ingestion run lease was lost before ${status} was recorded.`);
  run = data;
}

async function reconcileAmbiguousCompletedRun(runSnapshot, expectedStats) {
  const { data, error } = await runSupabaseOperation(
    "reconcile ambiguous completed ingestion run",
    () => supabase
      .from("ingestion_runs")
      .select("*")
      .eq("id", runSnapshot.id)
      .maybeSingle()
  );
  check(error, "reconcile ambiguous completed ingestion run");
  if (!data) return null;
  const finishedAt = Date.parse(data.finished_at ?? "");
  const valid = String(data.id) === String(runSnapshot.id) &&
    data.status === "completed" &&
    Number.isFinite(finishedAt) &&
    data.lease_owner === null &&
    data.lease_token === null &&
    data.lease_expires_at === null &&
    completionProvenanceMatches(data.stats_json, expectedStats);
  return valid ? data : null;
}

function buildChildEnvironment(category, overrides = {}, cwd = root) {
  const categoryKeys = CHILD_ENV_CATEGORY_KEYS[category];
  if (!categoryKeys) throw new Error(`Unknown child environment category: ${category}`);
  const allowedKeys = new Set([...SAFE_CHILD_ENV_KEYS, ...categoryKeys]);
  const isolatedHome = join(workRoot ?? root, ".autonomous-child-home");
  const childEnv = {
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    npm_config_cache: join(isolatedHome, ".npm-cache"),
    PWD: cwd,
    INIT_CWD: cwd
  };
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Child environment override ${key} is not allowed for ${category}.`);
    }
    if (value !== undefined && value !== null) childEnv[key] = String(value);
  }
  return childEnv;
}

function assertPublicationCommandCredentialBoundary(command, cwd, childEnvironment) {
  if (!publicationRoot || resolve(cwd) !== resolve(publicationRoot)) return;
  const exposed = PRIVILEGED_CHILD_ENV_KEYS.filter((key) => cleanEnv(childEnvironment[key]));
  if (exposed.length === 0) return;
  throw new Error(
    `Refusing to expose privileged environment ${exposed.join(", ")} to a command in the publication worktree (${command}).`
  );
}

function assertPublicationExecutableBoundary(command, commandArgs, cwd) {
  if (!publicationRoot) return;
  const commandName = basename(String(command)).toLowerCase();
  if (new Set(["npm", "npx", "pnpm", "yarn", "bun"]).has(commandName)) {
    throw new Error(`Package lifecycle command ${commandName} is prohibited in the secret-bearing runner.`);
  }

  const executableCandidates = [];
  if (isAbsolute(String(command)) || String(command).includes("/")) {
    executableCandidates.push(resolve(cwd, String(command)));
  }
  if (isNodeExecutable(command)) {
    for (let index = 0; index < commandArgs.length; index += 1) {
      const argument = String(commandArgs[index]);
      if (argument === "--loader" || argument === "--require" || argument === "-r") {
        const loader = commandArgs[index + 1];
        if (loader) executableCandidates.push(resolve(cwd, String(loader)));
        index += 1;
        continue;
      }
      const inlineLoader = argument.match(/^--(?:loader|require)=(.+)$/);
      if (inlineLoader) {
        executableCandidates.push(resolve(cwd, inlineLoader[1].replace(/^['"]|['"]$/g, "")));
        continue;
      }
      if ([".cjs", ".js", ".mjs", ".node", ".sh", ".ts", ".tsx"].includes(extname(argument))) {
        executableCandidates.push(resolve(cwd, argument));
      }
    }
  }

  for (const candidate of executableCandidates) {
    if (pathIsWithin(publicationRoot, candidate)) {
      throw new Error(
        `Refusing to execute publication-worktree code while the secret-bearing runner exists: ${candidate}`
      );
    }
    if (/[/\\]node_modules[/\\]next[/\\]dist[/\\]bin[/\\]next$/i.test(candidate)) {
      throw new Error("Next application execution is deferred to the secretless exact-SHA validation job.");
    }
  }
}

function pathIsWithin(parent, candidate) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function runCommand(command, commandArgs, {
  timeoutMs,
  // Child environments deliberately strip inherited NODE_OPTIONS. Give every
  // Node child a bounded default so a newly added production path cannot become
  // uncapped by omission; collectors and full-corpus builders override it.
  nodeHeapMb = isNodeExecutable(command) ? DEFAULT_NODE_CHILD_HEAP_MB : null,
  deadlineAt = null,
  label,
  env = {},
  envCategory = "runtime",
  allowedExitCodes = [0],
  onAllowedExit = null,
  quiet = false,
  recordEvents = true,
  preSpawnGuard = null,
  captureLimit = 40_000,
  requireCompleteOutput = false,
  cancellationCleanup = false,
  terminationGraceMs = AUTONOMOUS_PROCESS_BUDGETS.processKillGraceMs,
  hardSettleWatchdogMs = PROCESS_KILL_WATCHDOG_MS,
  cwd = root
}) {
  if (nodeHeapMb !== null && (!Number.isInteger(nodeHeapMb) || nodeHeapMb <= 0)) {
    throw new Error(`${label} nodeHeapMb must be a positive integer.`);
  }
  if (preSpawnGuard !== null && typeof preSpawnGuard !== "function") {
    throw new Error(`${label} preSpawnGuard must be a function.`);
  }
  if (typeof requireCompleteOutput !== "boolean") {
    throw new Error(`${label} requireCompleteOutput must be a boolean.`);
  }
  assertPublicationExecutableBoundary(command, commandArgs, cwd);
  if (!cancellationCleanup) {
    assertLeaseHealthy();
    // Fail before event I/O when the runner is already exhausted, then recalculate
    // after that I/O so the child timeout still ends at the absolute deadline.
    runnerBudget.timeoutMs(timeoutMs, label);
    if (recordEvents) {
      await event("command.started", "info", `${label} started.`, { command, args: commandArgs });
    }
    assertLeaseHealthy();
  }
  const childEnvironment = buildChildEnvironment(envCategory, env, cwd);
  if (nodeHeapMb !== null) {
    childEnvironment.NODE_OPTIONS = [
      childEnvironment.NODE_OPTIONS,
      `--max-old-space-size=${nodeHeapMb}`
    ].filter(Boolean).join(" ");
  }
  assertPublicationCommandCredentialBoundary(command, cwd, childEnvironment);
  const ledgerRunId = randomUUID();
  const ledgerPath = join(
    resolve(cleanEnv(process.env.RUNNER_TEMP) ?? tmpdir()),
    `returner-child-ledger-${process.pid}-${ledgerRunId}.log`
  );
  if (isNodeExecutable(command)) {
    await writeFile(ledgerPath, "", { encoding: "utf8", mode: 0o600 });
    childEnvironment.RETURNER_CHILD_PROCESS_LEDGER = ledgerPath;
    childEnvironment.RETURNER_CHILD_PROCESS_RUN_ID = ledgerRunId;
    childEnvironment.NODE_OPTIONS = [
      childEnvironment.NODE_OPTIONS,
      `--require=${JSON.stringify(sourcePath("scripts", "lib", "child-process-ledger-hook.cjs"))}`
    ].filter(Boolean).join(" ");
  }
  let effectiveTimeoutMs = null;
  return new Promise((resolve, reject) => {
    let child;
    let preSpawnGuardCompleted = preSpawnGuard === null;
    try {
      if (preSpawnGuard) {
        preSpawnGuard();
        preSpawnGuardCompleted = true;
      }
      // This is deliberately the final operation before spawn. Event writes,
      // environment construction, the asynchronous child-ledger write, and
      // the synchronous pre-spawn proof may all consume budget. Never give a
      // child the stale timeout calculated before those setup steps.
      const runnerRemainingMs = cancellationCleanup
        ? timeoutMs
        : runnerBudget.timeoutMs(timeoutMs, label);
      const deadlineRemainingMs = deadlineAt === null
        ? runnerRemainingMs
        : Math.floor(deadlineAt - Date.now());
      if (deadlineRemainingMs <= 0) {
        throw new Error(`${label} did not start before its phase deadline.`);
      }
      effectiveTimeoutMs = Math.min(timeoutMs, runnerRemainingMs, deadlineRemainingMs);
      if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
        throw new Error(`${label} did not retain a positive timeout immediately before spawn.`);
      }
      child = trackChildProcess(spawn(command, commandArgs, {
        cwd,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      }), {
        ledgerPath: isNodeExecutable(command) ? ledgerPath : null,
        ledgerRunId: isNodeExecutable(command) ? ledgerRunId : null
      });
    } catch (error) {
      void unlink(ledgerPath).catch(() => {});
      const executionError = commandExecutionError(
        `${label} could not start: ${errorMessage(error)}`,
        { code: null, signal: null, timedOut: false, stdout: "", stderr: "" },
        error
      );
      if (!preSpawnGuardCompleted) executionError.preSpawnGuardFailed = true;
      reject(executionError);
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let killTimer = null;
    let hardSettleTimer = null;
    let settled = false;
    const clearCommandTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
    };
    const payloadFor = (code = null, signal = null) => ({
      code,
      signal,
      timedOut,
      timeoutMs: effectiveTimeoutMs,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated
    });
    const emitCapturedOutput = () => {
      if (quiet) return;
      const safeStdout = sanitizeRunnerDiagnosticText(stdout, captureLimit);
      const safeStderr = sanitizeRunnerDiagnosticText(stderr, captureLimit);
      if (safeStdout) process.stdout.write(`[${label}] ${safeStdout}\n`);
      if (safeStderr) process.stderr.write(`[${label}] ${safeStderr}\n`);
    };
    const recordCommandEventBestEffort = (eventType, severity, message, payload) => {
      if (!recordEvents || cancellationCleanup || terminationSignal) return;
      const eventPayload = sanitizeRunnerDiagnosticValue({
        ...payload,
        stdout: tail(payload.stdout, 40_000),
        stderr: tail(payload.stderr, 40_000)
      });
      void event(eventType, severity, message, eventPayload, null, {
        timeoutMs: COMMAND_EVENT_TIMEOUT_MS
      }).catch(() => {});
    };
    const rejectHardSettledCommand = (reason) => {
      if (settled) return;
      settled = true;
      clearCommandTimers();
      const payload = payloadFor(null, "SIGKILL");
      emitCapturedOutput();
      disposeTrackedChildProcess(child);
      recordCommandEventBestEffort(
        "command.failed",
        "error",
        `${label} did not close after forced termination.`,
        payload
      );
      reject(commandExecutionError(
        reason instanceof Error
          ? reason.message
          : `${label} did not close after forced termination.`,
        payload
      ));
    };
    child[CHILD_HARD_SETTLE] = rejectHardSettledCommand;
    const timer = setTimeout(() => {
      timedOut = true;
      signalChildProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        signalChildProcessTree(child, "SIGKILL");
        hardSettleTimer = setTimeout(() => {
          rejectHardSettledCommand(new Error(
            `${label} timed out after ${effectiveTimeoutMs}ms and did not close within ` +
            `${hardSettleWatchdogMs}ms after SIGKILL.`
          ));
        }, hardSettleWatchdogMs);
      }, terminationGraceMs);
    }, effectiveTimeoutMs);
    // StringDecoder-backed stream decoding preserves multibyte UTF-8
    // characters that straddle OS pipe chunks. Converting each Buffer chunk
    // independently corrupts large JSON and invalidates byte/hash proofs.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > captureLimit) stdoutTruncated = true;
      stdout = tail(`${stdout}${chunk}`, captureLimit);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > captureLimit) stderrTruncated = true;
      stderr = tail(`${stderr}${chunk}`, captureLimit);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearCommandTimers();
      delete child[CHILD_HARD_SETTLE];
      if (Number.isInteger(child.pid) && child.pid > 0) {
        signalChildProcessTree(child, "SIGKILL");
        hardSettleTimer = setTimeout(
          () => disposeTrackedChildProcess(child),
          hardSettleWatchdogMs
        );
      } else {
        disposeTrackedChildProcess(child);
      }
      reject(commandExecutionError(
        `${label} could not start: ${errorMessage(error)}`,
        { ...payloadFor(null, null), stdout, stderr },
        error
      ));
    });
    child.once("close", (code, signal) => {
      if (settled) {
        clearCommandTimers();
        delete child[CHILD_HARD_SETTLE];
        disposeTrackedChildProcess(child);
        return;
      }
      settled = true;
      clearCommandTimers();
      delete child[CHILD_HARD_SETTLE];
      const payload = payloadFor(code, signal);
      void (async () => {
        try {
          await drainChildProcessTreeAfterRootClose(child);
        } catch (error) {
          disposeTrackedChildProcess(child);
          emitCapturedOutput();
          recordCommandEventBestEffort(
            "command.failed",
            "error",
            `${label} left a surviving subprocess descendant.`,
            payload
          );
          reject(commandExecutionError(
            `${label} left a surviving subprocess descendant: ${errorMessage(error)}`,
            payload,
            error
          ));
          return;
        }
        disposeTrackedChildProcess(child);
        emitCapturedOutput();
        if (requireCompleteOutput && (stdoutTruncated || stderrTruncated)) {
          reject(commandExecutionError(
            `${label} exceeded its complete output capture limit of ${captureLimit} characters; ` +
            "refusing to consume truncated structured output.",
            payload
          ));
          return;
        }
        if (timedOut) {
          recordCommandEventBestEffort(
            "command.failed",
            "error",
            `${label} timed out.`,
            payload
          );
          reject(commandExecutionError(
            `${label} timed out after ${effectiveTimeoutMs}ms with ${code ?? signal ?? "unknown status"}.`,
            payload
          ));
          return;
        }
        if (code !== null && allowedExitCodes.includes(code)) {
          try {
            if (typeof onAllowedExit === "function") onAllowedExit(payload);
            if (!cancellationCleanup) assertLeaseHealthy();
          } catch (error) {
            reject(error);
            return;
          }
          recordCommandEventBestEffort(
            "command.completed",
            "info",
            `${label} completed.`,
            payload
          );
          resolve(payload);
        } else {
          recordCommandEventBestEffort(
            "command.failed",
            "error",
            `${label} failed.`,
            payload
          );
          reject(commandExecutionError(
            `${label} exited with ${code ?? signal ?? "unknown status"}.`,
            payload
          ));
        }
      })();
    });
  });
}

function batchCompanyKey(batchSlug, sourceKey) {
  return `${batchSlug}\u0000${sourceKey}`;
}

async function readAvailableSnapshots(results) {
  const values = [];
  for (const result of results) {
    const value = await readCollectorSnapshot(result.outputPath, result.kind, result);
    if (value) values.push(value);
  }
  return values;
}

async function readCollectorSnapshot(path, kind, validation) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Invalid ${kind} collector snapshot at ${path}: ${errorMessage(error)}`);
  }
  try {
    const snapshot = validateAutonomousCollectorSnapshot(value, {
      kind,
      batchSlug: validation.batchSlug,
      expectedSourcePath: validation.expectedSourcePath,
      notBefore: validation.notBefore ?? null,
      notAfter: validation.notAfter ?? Date.now() + COLLECTOR_SNAPSHOT_FUTURE_SKEW_MS,
      requireAttemptBinding: validation.requireAttemptBinding === true,
      expectedAttemptId: validation.expectedAttemptId ?? null,
      expectedCampaignKey: validation.expectedCampaignKey ?? null,
      expectedExecutionNonce: validation.expectedExecutionNonce ?? null,
      expectedIdempotencyKey: validation.expectedIdempotencyKey ?? null,
      expectedNotBefore: validation.expectedNotBefore ?? null
    });
    return validateAutonomousCollectorReferentialIntegrity(snapshot, {
      kind,
      batchSlug: validation.batchSlug,
      catalog: catalogs.find((catalog) => catalog.slug === validation.batchSlug)
    });
  } catch (error) {
    throw new Error(`Invalid ${kind} collector snapshot at ${path}: ${errorMessage(error)}`);
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function writeRunnerOutcome(outcome) {
  const githubOutput = cleanEnv(process.env.GITHUB_OUTPUT);
  if (!githubOutput) return;
  const normalized = typeof outcome === "string" ? { status: outcome } : outcome;
  const outputs = {
    runner_status: normalized.status,
    publication_status: normalized.publicationStatus ?? "",
    collection_health: normalized.collectionHealth ?? "",
    collection_health_reasons: (normalized.collectionHealthReasons ?? []).join(","),
    provider_blocked: normalized.providerBlocked ?? "",
    provider_blocked_by_reason: JSON.stringify(normalized.providerBlockedByReason ?? {}),
    mapped_provider_blocked: normalized.mappedProviderBlocked ?? "",
    mapped_provider_blocked_by_reason: JSON.stringify(normalized.mappedProviderBlockedByReason ?? {}),
    mapped_scope_unsupported: normalized.mappedScopeUnsupported ?? "",
    failure_message: normalized.failureMessage ?? "",
    mapped_expected: normalized.mappedExpected ?? "",
    mapped_failed: normalized.mappedFailed ?? "",
    mapped_nonterminal: normalized.mappedNonTerminal ?? "",
    terminal_failure_budget: normalized.terminalFailureBudget ?? "",
    new_physical_sources: normalized.newPhysicalSources ?? "",
    daily_new_physical_sources: normalized.dailyNewPhysicalSources ?? "",
    daily_source_health: normalized.dailySourceHealth ?? "",
    authenticated_social_replay: JSON.stringify(normalized.authenticatedSocialReplay ?? null),
    linkedin_remaining_target_count: normalized.authenticatedSocialReplay?.remainingTargetCount ?? "",
    linkedin_remaining_target_count_known: normalized.authenticatedSocialReplay?.remainingTargetCountKnown ?? "",
    linkedin_known_remaining_target_count: normalized.authenticatedSocialReplay?.knownRemainingTargetCount ?? "",
    linkedin_unknown_remaining_batches: (normalized.authenticatedSocialReplay?.unknownRemainingBatches ?? []).join(","),
    linkedin_chunks_admitted: normalized.authenticatedSocialReplay?.chunksAdmitted ?? "",
    linkedin_chunks_attempted: normalized.authenticatedSocialReplay?.chunksAttempted ?? "",
    linkedin_chunks_completed: normalized.authenticatedSocialReplay?.chunksCompleted ?? "",
    linkedin_durable_lock_configured: normalized.authenticatedSocialReplay?.durableLockConfigured ?? "",
    linkedin_configuration_skipped: normalized.authenticatedSocialReplay?.configurationSkipped ?? "",
    linkedin_chunk_budget_exhausted: normalized.authenticatedSocialReplay?.chunkBudgetExhausted ?? "",
    linkedin_deadline_exhausted: normalized.authenticatedSocialReplay?.deadlineExhausted ?? "",
    linkedin_safety_stopped: normalized.authenticatedSocialReplay?.safetyStopped ?? "",
    linkedin_infrastructure_stopped: normalized.authenticatedSocialReplay?.infrastructureStopped ?? "",
    published_commit: normalized.publishedCommit ?? "",
    publication_receipt_sha256: normalized.publicationReceiptSha256 ?? ""
  };
  await appendFile(
    githubOutput,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
}

async function readCommitBackedReplayReceipt() {
  const remoteCommit = await resolvePublicationRemoteTip({
    labelPrefix: "current replay publication"
  });
  const immutableSourceCommit = await resolveSourceExecutionCommit();
  const [remoteCurrentReceipt, remoteHistory] = await Promise.all([
    readJsonFromGitRef(
      remoteCommit,
      "outputs/ingestion-source-delta-current.json",
      null
    ),
    readJsonFromGitRef(
      remoteCommit,
      "outputs/ingestion-source-delta-history.json",
      []
    )
  ]);
  const remoteClaimsReplay = [remoteCurrentReceipt, ...(Array.isArray(remoteHistory) ? remoteHistory : [])]
    .some((receipt) => receipt && typeof receipt === "object" && receipt.idempotencyKey === idempotencyKey);
  const log = await runCommand(
    "git",
    [
      "log",
      "--format=%H%x00%B%x00",
      "--grep=Returner-Slot-Key:",
      "--fixed-strings",
      remoteCommit,
      "--"
    ],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "locate commit-backed replay publication",
      captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT,
      requireCompleteOutput: true,
      quiet: true,
      cwd: root
    }
  );
  const candidates = parsePublicationLogEntries(log.stdout)
    .filter(({ message }) => exactPublicationTrailer(message, "Returner-Slot-Key") === idempotencyKey);
  if (candidates.length === 0) {
    if (remoteClaimsReplay) {
      throw new Error(
        `Replay slot ${idempotencyKey} has repository receipt data but no reachable provenance-bearing publication commit.`
      );
    }
    return null;
  }

  // The newest commit claiming this slot is authoritative. If it is malformed,
  // forged, or no longer a valid data-only descendant, fail closed instead of
  // falling back to an older receipt or mistaking the current code tip for the
  // publication.
  const { commit: publishedCommit, message } = candidates[0];
  const publicationProvenance = validateReplayPublicationTrailers({
    message,
    sourceCommit: immutableSourceCommit
  });
  const committedReceipt = await readTextFromGitRef(
    publishedCommit,
    "outputs/ingestion-source-delta-current.json",
    null
  );
  if (committedReceipt === null) {
    throw new Error(`Replay publication ${publishedCommit} does not contain its source-delta receipt.`);
  }
  const committedReceiptSha256 = createHash("sha256").update(committedReceipt).digest("hex");
  if (committedReceiptSha256 !== publicationProvenance.receiptSha256) {
    throw new Error(
      `Replay publication ${publishedCommit} receipt hash ${committedReceiptSha256} ` +
      `does not match its Returner-Receipt-SHA256 trailer.`
    );
  }
  const remoteContainsPublication = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", publishedCommit, remoteCommit],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "verify replay publication ancestry",
      allowedExitCodes: [0, 1],
      quiet: true,
      recordEvents: false,
      cwd: root
    }
  );
  if (remoteContainsPublication.code !== 0) {
    throw new Error(
      `Replay publication ${publishedCommit} is not an ancestor of current origin/${publicationBranch()}.`
    );
  }
  await assertTrustedPublicationBaseCommit(publishedCommit, {
    label: "commit-backed replay publication"
  });
  const [currentReceipt, history] = await Promise.all([
    readJsonFromGitRef(
      publishedCommit,
      "outputs/ingestion-source-delta-current.json",
      null
    ),
    readJsonFromGitRef(
      publishedCommit,
      "outputs/ingestion-source-delta-history.json",
      []
    )
  ]);
  const selected = selectPublishedAutonomousIngestionReceipt({
    idempotencyKey,
    publishedCommit,
    currentReceipt,
    history
  });
  if (!selected) {
    throw new Error(
      `Replay publication ${publishedCommit} has no exact schema-valid receipt for ${idempotencyKey}.`
    );
  }
  return selected;
}

function parsePublicationLogEntries(output) {
  const fields = String(output ?? "").split("\0");
  const entries = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const commit = fields[index]?.trim();
    const message = fields[index + 1] ?? "";
    if (/^[0-9a-f]{40}$/i.test(commit)) entries.push({ commit: commit.toLowerCase(), message });
  }
  return entries;
}

function exactPublicationTrailer(message, key) {
  const values = String(message ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${key}: `))
    .map((line) => line.slice(key.length + 2));
  if (values.length !== 1 || !values[0] || /[\r\n\0]/.test(values[0])) return null;
  return values[0];
}

function validateReplayPublicationTrailers({ message, sourceCommit }) {
  const slotKey = exactPublicationTrailer(message, "Returner-Slot-Key");
  const sourceSha = exactPublicationTrailer(message, "Returner-Source-SHA");
  const runId = exactPublicationTrailer(message, "Returner-Run-ID");
  const runAttempt = exactPublicationTrailer(message, "Returner-Run-Attempt");
  const receiptSha256 = exactPublicationTrailer(message, "Returner-Receipt-SHA256");
  if (!slotKey || !sourceSha || !runId || !runAttempt || !receiptSha256) {
    throw new Error("Replay publication provenance must contain exactly one complete Returner trailer for every field.");
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceSha) || sourceSha.toLowerCase() !== sourceCommit.toLowerCase()) {
    throw new Error("Replay publication Returner-Source-SHA does not match the dispatch source commit.");
  }
  if (!/^[0-9a-f]{64}$/i.test(receiptSha256)) {
    throw new Error("Replay publication Returner-Receipt-SHA256 is not exact.");
  }
  return { slotKey, sourceSha: sourceSha.toLowerCase(), runId, runAttempt, receiptSha256: receiptSha256.toLowerCase() };
}

async function resolvePublicationRemoteTip({ labelPrefix = "current replay publication" } = {}) {
  const branch = publicationBranch();
  const fetchOptions = {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: `fetch ${labelPrefix} history`,
    cwd: root
  };
  if (cleanEnv(process.env.GITHUB_TOKEN)) {
    fetchOptions.envCategory = "publication_push";
    fetchOptions.env = publicationPushAuthEnvironment();
  }
  await runCommand(
    "git",
    ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    fetchOptions
  );
  const remoteCommit = (await runCommand(
    "git",
    ["rev-parse", `refs/remotes/origin/${branch}^{commit}`],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: `resolve ${labelPrefix} commit`,
      cwd: root
    }
  )).stdout.trim();
  const immutableSourceCommit = await resolveSourceExecutionCommit();
  const sourceReachable = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", immutableSourceCommit, remoteCommit],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: `verify ${labelPrefix} source reachability`,
      allowedExitCodes: [0, 1],
      cwd: root
    }
  );
  if (sourceReachable.code !== 0) {
    throw new Error(
      `Replay publication ${remoteCommit} does not descend from source execution commit ${immutableSourceCommit}.`
    );
  }
  return remoteCommit;
}

async function resolveVerifiedCurrentPublicationCommit({
  labelPrefix = "current replay publication",
  allowInertCodeDrift = false
} = {}) {
  const remoteCommit = await resolvePublicationRemoteTip({ labelPrefix });
  return assertTrustedPublicationBaseCommit(remoteCommit, {
    label: labelPrefix,
    allowInertCodeDrift
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function readRequiredCanonicalRows(path, label) {
  const rows = await readRequiredCanonicalJson(path, label);
  if (!Array.isArray(rows)) {
    throw new Error(`${label} must contain a JSON array at ${path}.`);
  }
  return rows;
}

function check(error, operation) {
  if (error) throw new Error(`Failed to ${operation}: ${error.message ?? String(error)}`);
}

function normalizeReviewState(value) {
  return ["verified", "needs_review", "rejected"].includes(value) ? value : "needs_review";
}

function platformPriority(platform) {
  return ({ github: 90, x: 85, instagram: 80, linkedin: 75, youtube: 70, product_hunt: 65 }[platform] ?? 50);
}

function platformDelay(platform) {
  return ({ linkedin: 2_500, instagram: 2_000, x: 1_500, reddit: 1_000, product_hunt: 1_000 }[platform] ?? 500);
}

function catalogSummary(allCatalogs) {
  return allCatalogs.map((catalog) => ({
    slug: catalog.slug,
    companies: catalog.companies.length,
    founders: catalog.companies.reduce((sum, company) => sum + company.founders.length, 0),
    accounts: catalog.companies.reduce(
      (sum, company) => sum + company.accounts.length + company.founders.reduce((founderSum, founder) => founderSum + founder.accounts.length, 0),
      0
    )
  }));
}

function validateCandidateMetadata({
  trigger,
  scheduledAt,
  slotKey,
  recoveryDebt = false,
  required = false
}) {
  const normalizedTrigger = cleanEnv(trigger);
  const normalizedScheduledAt = cleanEnv(scheduledAt);
  if (typeof recoveryDebt !== "boolean") {
    throw new Error("Candidate recovery debt metadata must be boolean.");
  }
  if (!normalizedTrigger) {
    if (normalizedScheduledAt || recoveryDebt) {
      throw new Error("Candidate scheduled_at or recovery debt requires a candidate trigger.");
    }
    if (required) {
      throw new Error("Accepted GitHub Actions publication requires --candidate-trigger metadata.");
    }
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(slotKey))) {
    throw new Error("Candidate slot key is not a valid stable idempotency key.");
  }
  if (normalizedTrigger === "manual-replay") {
    if (normalizedScheduledAt) {
      throw new Error("Manual replay candidate must not claim scheduled_at metadata.");
    }
    if (recoveryDebt) {
      throw new Error("Manual replay candidate must not claim resolver recovery debt.");
    }
    return Object.freeze({
      trigger: normalizedTrigger,
      slotKey: String(slotKey),
      scheduledAt: null,
      scheduledAtMs: null,
      recoveryDebt: false
    });
  }
  if (normalizedTrigger !== "schedule") {
    throw new Error(`Candidate trigger ${normalizedTrigger} is not recognized.`);
  }
  if (!normalizedScheduledAt) {
    throw new Error("Scheduled candidate requires scheduled_at metadata.");
  }
  const scheduled = parseStrictUtcRfc3339(normalizedScheduledAt);
  const central = centralDateTimeParts(scheduled);
  const centralTime = `${central.hour}:${central.minute}`;
  if (!INGESTION_CENTRAL_SLOTS.includes(centralTime) || central.second !== "00") {
    throw new Error(
      `Scheduled candidate is not a 06:00 or 18:00 ${CENTRAL_TIME_ZONE} slot.`
    );
  }
  const expectedSlotKey =
    `central-${central.year}-${central.month}-${central.day}-${central.hour}${central.minute}`;
  if (slotKey !== expectedSlotKey) {
    throw new Error(
      `Scheduled candidate slot key mismatch (expected ${expectedSlotKey}, observed ${slotKey}).`
    );
  }
  if (!recoveryDebt) {
    throw new Error(
      "Scheduled publication requires resolver-authorized publication-watermark retry metadata."
    );
  }
  return Object.freeze({
    trigger: normalizedTrigger,
    slotKey: String(slotKey),
    scheduledAt: normalizedScheduledAt,
    scheduledAtMs: scheduled.getTime(),
    recoveryDebt
  });
}

function publicationCandidateReceiptFields({ required = false } = {}) {
  if (!candidateMetadata) {
    if (required) {
      throw new Error("Publication requires exact candidate trigger/scheduledAt metadata.");
    }
    return { trigger: null, scheduledAt: null };
  }
  return {
    trigger: candidateMetadata.trigger,
    scheduledAt: candidateMetadata.scheduledAt
  };
}

function parseStrictUtcRfc3339(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) throw new Error("Candidate scheduled_at must be a strict UTC RFC3339 timestamp.");
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const calendarProbe = new Date(0);
  calendarProbe.setUTCFullYear(year, month - 1, day);
  calendarProbe.setUTCHours(hour, minute, second, 0);
  if (
    calendarProbe.getUTCFullYear() !== year ||
    calendarProbe.getUTCMonth() !== month - 1 ||
    calendarProbe.getUTCDate() !== day ||
    calendarProbe.getUTCHours() !== hour ||
    calendarProbe.getUTCMinutes() !== minute ||
    calendarProbe.getUTCSeconds() !== second
  ) {
    throw new Error("Candidate scheduled_at is not a real UTC calendar instant.");
  }
  const scheduled = new Date(value);
  if (!Number.isFinite(scheduled.getTime())) {
    throw new Error("Candidate scheduled_at is not a valid UTC instant.");
  }
  return scheduled;
}

function assertCandidateFreshForPublication(label, nowMs = Date.now()) {
  if (!candidateMetadata || candidateMetadata.trigger === "manual-replay") return;
  if (nowMs < candidateMetadata.scheduledAtMs) {
    throw new Error(`Scheduled candidate is in the future before ${label}.`);
  }
  const latest = latestEligibleCentralSlot(new Date(nowMs));
  if (
    candidateMetadata.slotKey !== latest.slotKey ||
    candidateMetadata.scheduledAt !== latest.scheduledAt.toISOString()
  ) {
    throw new Error(
      `Scheduled candidate ${candidateMetadata.slotKey} was superseded by newest eligible ` +
      `Central slot ${latest.slotKey} before ${label}; publication is prohibited.`
    );
  }
}

function parseArgs(rawArgs) {
  const value = (name) => rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const booleanValue = (name) => {
    const assigned = value(name);
    if (assigned === null) return rawArgs.includes(name);
    if (assigned === "true") return true;
    if (assigned === "false" || assigned === "") return false;
    throw new Error(`${name} must be true or false.`);
  };
  return {
    idempotencyKey: value("--idempotency-key"),
    campaignKey: value("--campaign-key"),
    candidateTrigger: value("--candidate-trigger"),
    scheduledAt: value("--scheduled-at"),
    recoveryDebt: booleanValue("--recovery-debt"),
    plan: rawArgs.includes("--plan"),
    resumeSnapshots: rawArgs.includes("--resume-snapshots"),
    skipNetwork: rawArgs.includes("--skip-network"),
    skipPublish: rawArgs.includes("--skip-publish"),
    authenticatedSocialReplay: booleanValue("--authenticated-social-replay")
  };
}

function cleanEnv(value) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function authenticatedSocialReplayRoot() {
  const openCliHome = cleanEnv(process.env.OPENCLI_HOME);
  if (!openCliHome) {
    throw new Error("Authenticated social historical replay requires OPENCLI_HOME for durable checkpoints.");
  }
  return join(
    resolve(openCliHome),
    "returner-fund-autonomous-replay",
    safePathSegment(args.campaignKey ?? "authenticated-social-history-v1")
  );
}

function safePathSegment(value) {
  const source = String(value);
  const prefix = source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(values[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedCollectionTimeoutMs(requestedMs, label) {
  if (!collectionBudget) {
    throw new Error(`Collection budget is unavailable before ${label}.`);
  }
  return collectionBudget.timeoutMs(requestedMs, label);
}

function boundedCollectionDelayMs(requestedMs, label) {
  if (!collectionBudget) {
    throw new Error(`Collection budget is unavailable before ${label}.`);
  }
  return collectionBudget.delayMs(requestedMs, label);
}

function boundedCollectionDrainTimeoutMs(requestedMs, label) {
  if (!collectionDrainBudget) {
    throw new Error(`Collection drain budget is unavailable before ${label}.`);
  }
  return collectionDrainBudget.timeoutMs(requestedMs, label);
}

function commandFailureMessage(status, { stderr = "", stdout = "" } = {}) {
  const safeStatus = sanitizeRunnerDiagnosticText(status, 1_024);
  const outputTail = [
    stderr ? `stderr: ${tail(stderr, COMMAND_FAILURE_TAIL_MAX_LENGTH)}` : "",
    stdout ? `stdout: ${tail(stdout, COMMAND_FAILURE_TAIL_MAX_LENGTH)}` : ""
  ].filter(Boolean).join(" | ");
  const safeOutputTail = sanitizeRunnerDiagnosticText(
    outputTail,
    COMMAND_FAILURE_TAIL_MAX_LENGTH
  );
  return safeOutputTail ? `${safeStatus} Output tail: ${safeOutputTail}` : safeStatus;
}

function commandExecutionError(status, payload = {}, cause = null) {
  const error = new Error(commandFailureMessage(status, payload), cause ? { cause } : undefined);
  error.commandResult = {
    code: payload.code ?? null,
    signal: payload.signal ?? null,
    timedOut: payload.timedOut === true,
    timeoutMs: payload.timeoutMs ?? null,
    stdout: payload.stdout ?? "",
    stderr: payload.stderr ?? "",
    stdoutTruncated: payload.stdoutTruncated === true,
    stderrTruncated: payload.stderrTruncated === true
  };
  return error;
}

function tail(value, limit) {
  return value.length > limit ? value.slice(-limit) : value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runnerDiagnosticSecrets() {
  const publicationAuthorizationHeader = githubPublicationAuthorizationHeader();
  return [
    serviceKey,
    cleanEnv(process.env.GITHUB_TOKEN),
    publicationAuthorizationHeader,
    publicationAuthorizationHeader?.replace(/^AUTHORIZATION: basic /, ""),
    cleanEnv(process.env.X_BEARER_TOKEN),
    cleanEnv(process.env.EXA_API_KEY)
  ];
}

function sanitizeRunnerDiagnosticText(value, maxLength = 40_000) {
  return sanitizeRunnerFailureMessage(value, {
    secrets: runnerDiagnosticSecrets(),
    maxLength
  });
}

function sanitizeRunnerDiagnosticValue(value, depth = 0) {
  if (typeof value === "string") return sanitizeRunnerDiagnosticText(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (depth >= 8) return "[truncated-diagnostic-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((item) => sanitizeRunnerDiagnosticValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, 1_000).map(([key, item]) => [
      key,
      sanitizeRunnerDiagnosticValue(item, depth + 1)
    ])
  );
}

function sanitizedRunnerFailure(error) {
  const options = {
    secrets: runnerDiagnosticSecrets()
  };
  return {
    message: sanitizeRunnerFailureMessage(errorMessage(error), options),
    stack: error instanceof Error && error.stack
      ? sanitizeRunnerFailureMessage(error.stack, { ...options, maxLength: 8192 })
      : null
  };
}

function replayCoverageOutcome(receipt) {
  const mappedExpected = receipt?.mappedExpected;
  const hasMappedExpected = mappedExpected !== null && mappedExpected !== undefined;
  return {
    mappedExpected,
    mappedNonTerminal: receipt?.mappedNonTerminal,
    terminalFailureBudget: receipt?.terminalFailureBudget ?? (
      hasMappedExpected ? autonomousMappedTerminalFailureBudget(mappedExpected) : undefined
    )
  };
}

function failedRunnerOutcome(failureMessage) {
  return {
    status: "failed",
    failureMessage,
    authenticatedSocialReplay: authenticatedSocial?.linkedinReplay ?? null,
    providerBlocked: latestCollectionCoverage?.providerBlocked,
    providerBlockedByReason: latestCollectionCoverage?.providerBlockedByReason,
    mappedProviderBlocked: latestCollectionCoverage?.mappedProviderBlocked,
    mappedProviderBlockedByReason: latestCollectionCoverage?.mappedProviderBlockedByReason,
    mappedScopeUnsupported: latestCollectionCoverage?.mappedScopeUnsupported,
    mappedExpected: latestCollectionCoverage?.mappedExpected,
    mappedFailed: latestCollectionCoverage?.mappedFailed,
    mappedNonTerminal: latestCollectionCoverage?.mappedNonTerminal,
    terminalFailureBudget: latestTerminalFailureBudget,
    publishedCommit: latestPublishedCommit ?? pendingRunnerOutcome?.publishedCommit ?? null
  };
}

async function runLifecycleContractFixture(fixture) {
  const emit = (value) => {
    console.log(`LIFECYCLE_FIXTURE_RESULT=${JSON.stringify(value)}`);
    return 0;
  };
  if (fixture === "utf8-command-capture") {
    const expected = "prefix🙂suffix";
    const splitInsideEmoji = Buffer.byteLength("prefix", "utf8") + 1;
    const childScript = [
      `const bytes = Buffer.from(${JSON.stringify(expected)}, "utf8");`,
      `process.stdout.write(bytes.subarray(0, ${splitInsideEmoji}));`,
      `process.stderr.write(bytes.subarray(0, ${splitInsideEmoji}));`,
      `setTimeout(() => {`,
      `  process.stdout.write(bytes.subarray(${splitInsideEmoji}));`,
      `  process.stderr.write(bytes.subarray(${splitInsideEmoji}));`,
      `}, 20);`
    ].join("\n");
    const result = await runCommand(process.execPath, ["-e", childScript], {
      timeoutMs: 5_000,
      label: "UTF-8 command capture fixture",
      quiet: true,
      recordEvents: false,
      captureLimit: 1_000,
      requireCompleteOutput: true
    });
    return emit({
      fixture,
      expected,
      stdout: result.stdout,
      stderr: result.stderr,
      expectedBytes: Buffer.byteLength(expected, "utf8"),
      stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8")
    });
  }
  if (fixture === "complete-output-overflow") {
    try {
      await runCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(64))'], {
        timeoutMs: 5_000,
        label: "complete output overflow fixture",
        quiet: true,
        recordEvents: false,
        captureLimit: 16,
        requireCompleteOutput: true
      });
      return emit({ fixture, accepted: true });
    } catch (error) {
      return emit({
        fixture,
        accepted: false,
        error: errorMessage(error),
        stdoutTruncated: error?.commandResult?.stdoutTruncated === true
      });
    }
  }
  if (fixture === "complete-stderr-overflow") {
    try {
      await runCommand(process.execPath, ["-e", 'process.stderr.write("x".repeat(64))'], {
        timeoutMs: 5_000,
        label: "complete stderr overflow fixture",
        quiet: true,
        recordEvents: false,
        captureLimit: 16,
        requireCompleteOutput: true
      });
      return emit({ fixture, accepted: true });
    } catch (error) {
      return emit({
        fixture,
        accepted: false,
        error: errorMessage(error),
        stderrTruncated: error?.commandResult?.stderrTruncated === true
      });
    }
  }
  if (fixture === "candidate-metadata") {
    const previousCandidateMetadata = candidateMetadata;
    try {
      candidateMetadata = validateCandidateMetadata({
        trigger: cleanEnv(process.env.LIFECYCLE_FIXTURE_CANDIDATE_TRIGGER),
        scheduledAt: cleanEnv(process.env.LIFECYCLE_FIXTURE_SCHEDULED_AT),
        slotKey: cleanEnv(process.env.LIFECYCLE_FIXTURE_SLOT_KEY),
        recoveryDebt: process.env.LIFECYCLE_FIXTURE_RECOVERY_DEBT === "true",
        required: true
      });
      const nowMs = Number(process.env.LIFECYCLE_FIXTURE_NOW_MS ?? Date.now());
      assertCandidateFreshForPublication(
        cleanEnv(process.env.LIFECYCLE_FIXTURE_PUSH_LABEL) ?? "fixture publication push",
        nowMs
      );
      return emit({ fixture, accepted: true, candidateMetadata });
    } catch (error) {
      return emit({ fixture, accepted: false, error: errorMessage(error) });
    } finally {
      candidateMetadata = previousCandidateMetadata;
    }
  }
  if (fixture === "source-boundary") {
    const workingDirectory = cleanEnv(process.env.LIFECYCLE_FIXTURE_WORKING_ROOT);
    const executingCodeRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_CODE_ROOT);
    if (!workingDirectory || !executingCodeRoot) {
      throw new Error("Source-boundary fixture requires working and code roots.");
    }
    const previousSourceCommit = sourceCommit;
    sourceCommit = null;
    try {
      const verifiedSourceCommit = await verifyPinnedSourceExecutionBoundary({
        workingDirectory,
        executingCodeRoot,
        expectedSourceCommit: cleanEnv(process.env.LIFECYCLE_FIXTURE_EXPECTED_SOURCE_SHA)
      });
      return emit({ fixture, accepted: true, sourceCommit: verifiedSourceCommit });
    } catch (error) {
      return emit({ fixture, accepted: false, error: errorMessage(error) });
    } finally {
      sourceCommit = previousSourceCommit;
    }
  }

  if (fixture === "publication-base-trust") {
    const candidateCommit = cleanEnv(process.env.LIFECYCLE_FIXTURE_BASE_COMMIT);
    const fixtureSourceCommit = cleanEnv(process.env.LIFECYCLE_FIXTURE_SOURCE_COMMIT);
    if (!candidateCommit || !fixtureSourceCommit) {
      throw new Error("Publication-base trust fixture requires source and candidate commits.");
    }
    const previousSourceCommit = sourceCommit;
    sourceCommit = fixtureSourceCommit.toLowerCase();
    try {
      await assertTrustedPublicationBaseCommit(candidateCommit, {
        label: cleanEnv(process.env.LIFECYCLE_FIXTURE_BASE_LABEL) ?? "fixture publication base",
        allowInertCodeDrift: cleanEnv(process.env.LIFECYCLE_FIXTURE_ALLOW_INERT_CODE_DRIFT) === "true"
      });
      return emit({ fixture, accepted: true, sourceCommit, candidateCommit });
    } catch (error) {
      return emit({ fixture, accepted: false, error: errorMessage(error) });
    } finally {
      sourceCommit = previousSourceCommit;
    }
  }

  if (fixture === "publication-candidate-proof") {
    const fixturePublicationRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_ROOT);
    const fixturePublicationParent = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_PARENT);
    const fixtureBaseCommit = cleanEnv(process.env.LIFECYCLE_FIXTURE_BASE_COMMIT);
    const fixtureCandidateCommit = cleanEnv(process.env.LIFECYCLE_FIXTURE_CANDIDATE_COMMIT);
    if (
      !fixturePublicationRoot ||
      !fixturePublicationParent ||
      !fixtureBaseCommit ||
      !fixtureCandidateCommit
    ) {
      throw new Error("Publication-candidate proof fixture requires worktree, base, and candidate values.");
    }
    publicationRoot = resolve(fixturePublicationRoot);
    publicationWorktreeParent = resolve(fixturePublicationParent);
    configurePublicationArtifactPaths(publicationRoot);
    const proof = await assertPublicationCandidateProof(
      fixtureCandidateCommit,
      fixtureBaseCommit,
      { label: "fixture publication candidate" }
    );
    await transplantPublicationArtifactsOntoRetryBase({
      retryBaseCommit: fixtureBaseCommit,
      candidateCommit: fixtureCandidateCommit,
      candidateBaseCommit: fixtureBaseCommit
    });
    const candidateDelta = await runCommand(
      "git",
      [
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        fixtureBaseCommit,
        fixtureCandidateCommit,
        "--",
        ...repositoryArtifactPaths()
      ],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: "inspect fixture candidate deletion",
        captureLimit: 1_000_000,
        quiet: true,
        recordEvents: false,
        cwd: root
      }
    );
    const stagedDelta = await runCommand(
      "git",
      ["diff", "--cached", "--name-status", "--no-renames", "-z", "--"],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: "inspect fixture transplant deletion",
        captureLimit: 1_000_000,
        quiet: true,
        recordEvents: false,
        cwd: publicationRoot
      }
    );
    const deletedPath = "outputs/ingestion-source-delta-current.json";
    const deletedIndexEntry = await runCommand(
      "git",
      ["ls-files", "--stage", "--", deletedPath],
      {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: "inspect fixture deleted artifact index",
        captureLimit: 100_000,
        quiet: true,
        recordEvents: false,
        cwd: publicationRoot
      }
    );
    let deletedFromWorktree = false;
    try {
      await stat(join(publicationRoot, deletedPath));
    } catch (error) {
      if (error?.code === "ENOENT") deletedFromWorktree = true;
      else throw error;
    }
    return emit({
      fixture,
      proof,
      candidateDelta: parseGitNameStatusNul(candidateDelta.stdout),
      stagedDelta: parseGitNameStatusNul(stagedDelta.stdout),
      deletedFromIndex: deletedIndexEntry.stdout.trim() === "",
      deletedFromWorktree
    });
  }

  if (fixture === "publication-retry-reuse") {
    const fixturePublicationRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_ROOT);
    const fixturePublicationParent = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_PARENT);
    const fixtureBaseCommit = cleanEnv(process.env.LIFECYCLE_FIXTURE_BASE_COMMIT)?.toLowerCase();
    const fixtureRetryBaseCommit = cleanEnv(process.env.LIFECYCLE_FIXTURE_RETRY_BASE_COMMIT)?.toLowerCase();
    if (
      !fixturePublicationRoot ||
      !fixturePublicationParent ||
      !fixtureBaseCommit ||
      !fixtureRetryBaseCommit
    ) {
      throw new Error("Publication retry-reuse fixture requires worktree, base, and retry-base values.");
    }
    publicationRoot = resolve(fixturePublicationRoot);
    publicationWorktreeParent = resolve(fixturePublicationParent);
    publicationBaseCommit = fixtureBaseCommit;
    configurePublicationArtifactPaths(publicationRoot);
    const previousCandidateMetadata = candidateMetadata;
    const previousLatestPublishedCommit = latestPublishedCommit;
    const previousReceiptSha256 = publicationReceiptSha256;
    candidateMetadata = validateCandidateMetadata({
      trigger: "manual-replay",
      scheduledAt: null,
      slotKey: idempotencyKey,
      required: true
    });
    latestPublishedCommit = null;
    publicationReceiptSha256 = null;

    try {
      const retainedCandidateRows = [{ id: "publication-retry-reuse", retained: true }];
      await writeJsonAtomic(
        join(publicationRoot, "outputs", "source-discovery-paths-current.json"),
        retainedCandidateRows
      );
      await stageRepositoryArtifacts();
      const firstCommit = await commitPublicationArtifacts({
        amend: false,
        allowUnchangedTree: true
      });
      const candidate = {
        ...firstCommit,
        publicationBaseCommit: fixtureBaseCommit,
        proofLabel: "fixture initial publication candidate"
      };
      const rebuilt = await rebuildPublicationCandidateOnConcurrentBase({
        retryBaseCommit: fixtureRetryBaseCommit,
        candidate,
        attempt: 2,
        publicationRunId: "publication-retry-reuse-fixture",
        // The dashboard-only fast path must return before dereferencing this.
        publicationInputs: null
      });
      const proof = await assertPublicationCandidateProof(
        rebuilt.publishedCommit,
        fixtureRetryBaseCommit,
        { label: "fixture reused publication candidate" }
      );
      return emit({
        fixture,
        reusedValidatedCandidate: true,
        proof,
        dashboardBytes: await readFile(join(publicationRoot, "public", "dashboard", "feed.json"), "utf8"),
        retainedCandidateRows: await readJson(
          join(publicationRoot, "outputs", "source-discovery-paths-current.json"),
          null
        )
      });
    } finally {
      candidateMetadata = previousCandidateMetadata;
      latestPublishedCommit = previousLatestPublishedCommit;
      publicationReceiptSha256 = previousReceiptSha256;
    }
  }

  if (fixture === "publication-race-loop") {
    const fixturePublicationRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_ROOT);
    const fixturePublicationParent = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_PARENT);
    const fixtureBaseCommit = cleanEnv(process.env.LIFECYCLE_FIXTURE_BASE_COMMIT)?.toLowerCase();
    const mode = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_RACE_MODE);
    const concurrentCommits = String(process.env.LIFECYCLE_FIXTURE_CONCURRENT_COMMITS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (!fixturePublicationRoot || !fixturePublicationParent || !fixtureBaseCommit || !mode) {
      throw new Error("Publication race fixture requires worktree, base, and mode values.");
    }
    if (mode === "second-concurrent" && concurrentCommits.length !== 2) {
      throw new Error("Second-concurrent publication race fixture requires exactly two concurrent commits.");
    }
    if (!new Set(["second-concurrent", "landed-reconciliation-lost"]).has(mode)) {
      throw new Error(`Unsupported publication race fixture mode: ${mode}.`);
    }

    publicationRoot = resolve(fixturePublicationRoot);
    publicationWorktreeParent = resolve(fixturePublicationParent);
    publicationBaseCommit = fixtureBaseCommit;
    configurePublicationArtifactPaths(publicationRoot);
    const previousCandidateMetadata = candidateMetadata;
    const previousLatestPublishedCommit = latestPublishedCommit;
    const previousReceiptSha256 = publicationReceiptSha256;
    candidateMetadata = validateCandidateMetadata({
      trigger: "manual-replay",
      scheduledAt: null,
      slotKey: idempotencyKey,
      required: true
    });
    latestPublishedCommit = null;
    publicationReceiptSha256 = null;

    try {
      await writeJsonAtomic(
        join(publicationRoot, "outputs", "source-discovery-paths-current.json"),
        [{ id: "publication-race-fixture", mode, retained: true }]
      );
      await stageRepositoryArtifacts();
      const firstCommit = await commitPublicationArtifacts({
        amend: false,
        allowUnchangedTree: true
      });
      const candidateCommits = [firstCommit.publishedCommit];
      let remoteTipCommit = fixtureBaseCommit;
      let pushCalls = 0;
      let fetchCalls = 0;
      let rebuildCalls = 0;

      const outcome = await pushPublicationCandidateWithConcurrentMainRecovery({
        initialCandidate: {
          ...firstCommit,
          publicationBaseCommit: fixtureBaseCommit,
          proofLabel: "fixture initial publication candidate"
        },
        branch: "main",
        pushCandidate: async (candidate) => {
          pushCalls += 1;
          if (mode === "landed-reconciliation-lost") {
            remoteTipCommit = candidate.publishedCommit;
            return {
              code: 128,
              signal: null,
              timedOut: true,
              stdout: "",
              stderr: "simulated lost response after remote accepted candidate",
              retryableTransportFailure: true
            };
          }
          if (pushCalls <= concurrentCommits.length) {
            remoteTipCommit = concurrentCommits[pushCalls - 1];
            return {
              code: 1,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "! [rejected] candidate -> main (non-fast-forward)"
            };
          }
          remoteTipCommit = candidate.publishedCommit;
          return { code: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        },
        fetchRetryBase: async () => {
          fetchCalls += 1;
          await assertTrustedPublicationBaseCommit(remoteTipCommit, {
            label: `fixture publication retry base ${fetchCalls}`,
            allowInertCodeDrift: true
          });
          return remoteTipCommit;
        },
        adoptCandidate: (candidate, options) => adoptReachablePublicationCandidate(candidate, {
          ...options,
          remoteTipCommit: options.remoteTipCommit ?? remoteTipCommit
        }),
        rebuildCandidate: async ({ retryBaseCommit, candidate, attempt }) => {
          rebuildCalls += 1;
          await transplantPublicationArtifactsOntoRetryBase({
            retryBaseCommit,
            candidateCommit: candidate.publishedCommit,
            candidateBaseCommit: candidate.publicationBaseCommit
          });
          publicationBaseCommit = retryBaseCommit;
          await stageRepositoryArtifacts();
          const rebuilt = await commitPublicationArtifacts({
            amend: false,
            allowUnchangedTree: true
          });
          candidateCommits.push(rebuilt.publishedCommit);
          return {
            ...rebuilt,
            publicationBaseCommit: retryBaseCommit,
            proofLabel: `fixture publication retry candidate ${attempt}`
          };
        },
        onRetry: async () => {}
      });

      const candidateParents = [];
      for (const commit of candidateCommits) {
        candidateParents.push((await runCommand(
          "git",
          ["show", "-s", "--format=%P", commit],
          {
            timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
            label: `inspect fixture candidate parent ${commit}`,
            quiet: true,
            recordEvents: false,
            cwd: publicationRoot
          }
        )).stdout.trim());
      }
      return emit({
        fixture,
        mode,
        attempts: outcome.attempts,
        concurrentMainRetries: outcome.concurrentMainRetries,
        adoptedAfterAmbiguousPush: outcome.adoptedAfterAmbiguousPush,
        pushCalls,
        fetchCalls,
        rebuildCalls,
        candidateCommits,
        candidateParents,
        finalCandidate: outcome.candidate.publishedCommit,
        finalBase: outcome.candidate.publicationBaseCommit,
        remoteTipCommit,
        receiptSha256: outcome.candidate.receiptSha256
      });
    } finally {
      candidateMetadata = previousCandidateMetadata;
      latestPublishedCommit = previousLatestPublishedCommit;
      publicationReceiptSha256 = previousReceiptSha256;
    }
  }

  if (fixture === "command-pre-spawn-deadline") {
    const markerPath = cleanEnv(process.env.LIFECYCLE_FIXTURE_MARKER);
    if (!markerPath) throw new Error("Pre-spawn deadline fixture requires a marker path.");
    runnerBudget = createAutonomousRunnerBudget({ phaseMs: 40, startedAt: Date.now() });
    let failureMessage = null;
    const startedAt = Date.now();
    try {
      await runCommand(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.env.LIFECYCLE_FIXTURE_MARKER, 'spawned')"],
        {
          timeoutMs: 500,
          nodeHeapMb: 128,
          label: "fixture fresh pre-spawn deadline",
          envCategory: "test_fixture",
          recordEvents: false,
          preSpawnGuard: () => {
            const guardDeadline = Date.now() + 75;
            while (Date.now() < guardDeadline) {
              // Consume the budget after asynchronous ledger setup but before spawn.
            }
          }
        }
      );
    } catch (error) {
      failureMessage = errorMessage(error);
    }
    let spawned = true;
    try {
      await stat(markerPath);
    } catch (error) {
      if (error?.code === "ENOENT") spawned = false;
      else throw error;
    }
    if (!failureMessage || spawned) {
      throw new Error("Fresh pre-spawn deadline did not refuse an exhausted command.");
    }
    return emit({
      fixture,
      spawned,
      elapsedMs: Date.now() - startedAt,
      failureMessage
    });
  }

  if (fixture === "remote-verification-budget") {
    const timeoutMs = Number(process.env.LIFECYCLE_FIXTURE_REMOTE_TIMEOUT_MS ?? 500);
    const startedAt = Date.now();
    let failure = null;
    try {
      await verifyPublicationCommitOnRemote("a".repeat(40), {
        branch: "main",
        label: "fixture shared remote budget",
        allowDuringCancellation: true,
        timeoutMs
      });
    } catch (error) {
      failure = {
        message: errorMessage(error),
        timedOut: error?.commandResult?.timedOut === true,
        commandTimeoutMs: error?.commandResult?.timeoutMs ?? null
      };
    }
    if (!failure) {
      throw new Error("Shared remote verification budget fixture unexpectedly completed.");
    }
    return emit({
      fixture,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      failure
    });
  }

  if (fixture === "publication-cancellation-recheck") {
    const markerPath = cleanEnv(process.env.LIFECYCLE_FIXTURE_MARKER);
    if (!markerPath) throw new Error("Publication cancellation fixture requires a git-call marker.");
    terminationSignal = null;
    publicationCancellationResolutionPromise = null;
    publicationSignalAdoptionClosed = false;
    latestPublishedCommit = null;
    const candidate = {
      publishedCommit: "b".repeat(40),
      branch: "main",
      label: "fixture possibly-landed publication candidate"
    };
    retainPublicationPushCandidate(candidate);
    const reconciledBeforeSignal = await reconcilePublicationPushCandidate(
      candidate,
      "fixture pre-signal reconciliation"
    );
    const retainedBeforeSignal = publicationPushCandidate?.publishedCommit === candidate.publishedCommit;
    terminationSignal = "SIGTERM";
    await beginPublicationCancellationResolution();
    const calls = (await readFile(markerPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const retainedAfterCancellationRecheck =
      publicationPushCandidate?.publishedCommit === candidate.publishedCommit;
    await finalizePublicationSignalAdoptionWindow();
    return emit({
      fixture,
      reconciledBeforeSignal,
      retainedBeforeSignal,
      retainedAfterCancellationRecheck,
      candidateClearedAfterFinalization: publicationPushCandidate === null,
      fetchCalls: calls.filter((args) => args[0] === "fetch").length,
      ancestryCalls: calls.filter((args) => args[0] === "merge-base").length,
      latestPublishedCommit
    });
  }

  if (fixture === "pid-reuse-ledger") {
    const fixtureRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_MARKER);
    if (!fixtureRoot) throw new Error("PID-reuse fixture requires a marker directory.");
    await mkdir(fixtureRoot, { recursive: true });
    const readyPath = join(fixtureRoot, "victim-ready");
    const signaledPath = join(fixtureRoot, "victim-signaled");
    const ledgerPath = join(fixtureRoot, "forged-child-ledger.log");
    const victim = spawn(process.execPath, ["-e", [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => writeFileSync(process.env.VICTIM_SIGNALED, "yes"));',
      'writeFileSync(process.env.VICTIM_READY, "yes");',
      "setInterval(() => {}, 1000);"
    ].join("")], {
      env: {
        ...process.env,
        VICTIM_READY: readyPath,
        VICTIM_SIGNALED: signaledPath
      },
      stdio: "ignore"
    });
    const victimClosed = new Promise((resolveClose) => victim.once("close", resolveClose));
    const fakeRoot = {
      pid: 2_147_000_000,
      kill() {}
    };
    const ledgerRunId = randomUUID();
    try {
      const readyDeadline = Date.now() + 1_000;
      while (Date.now() < readyDeadline) {
        try {
          await stat(readyPath);
          break;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await delay(10);
        }
      }
      await stat(readyPath);
      const actualIdentity = processStartIdentity(victim.pid);
      if (!actualIdentity) throw new Error("Could not resolve fixture victim process identity.");
      await writeFile(
        ledgerPath,
        `${ledgerRunId}\t${victim.pid}\t${actualIdentity}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      fakeRoot[CHILD_DESCENDANT_PIDS] = new Set();
      fakeRoot[CHILD_PROCESS_LEDGER] = {
        path: ledgerPath,
        runId: ledgerRunId,
        identities: new Map()
      };
      activeChildProcesses.add(fakeRoot);
      let preSignalIdentityReads = 0;
      signalChildProcessTree(fakeRoot, "SIGTERM", {
        readStartIdentity(pid) {
          preSignalIdentityReads += 1;
          if (pid !== victim.pid) return null;
          return preSignalIdentityReads === 1 ? actualIdentity : `${actualIdentity}:reused`;
        }
      });
      await delay(100);
      const victimAlive = processExists(victim.pid);
      let victimSignaled = false;
      try {
        await stat(signaledPath);
        victimSignaled = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return emit({
        fixture,
        victimAlive,
        victimSignaled,
        preSignalIdentityReads,
        victimPruned: !fakeRoot[CHILD_DESCENDANT_PIDS].has(victim.pid) &&
          !fakeRoot[CHILD_PROCESS_LEDGER].identities.has(victim.pid)
      });
    } finally {
      activeChildProcesses.delete(fakeRoot);
      try {
        victim.kill("SIGKILL");
      } catch {}
      await Promise.race([victimClosed, delay(500)]);
      await unlink(ledgerPath).catch(() => {});
    }
  }

  if (fixture === "escaped-descendant") {
    const commandPath = cleanEnv(process.env.LIFECYCLE_FIXTURE_COMMAND);
    if (!commandPath) throw new Error("LIFECYCLE_FIXTURE_COMMAND is required.");
    const startedAt = Date.now();
    let failure = null;
    try {
      await runCommand(process.execPath, [commandPath], {
        timeoutMs: 150,
        label: "escaped descendant lifecycle fixture",
        quiet: true,
        envCategory: "test_fixture",
        env: {
          LIFECYCLE_FIXTURE_MARKER: cleanEnv(process.env.LIFECYCLE_FIXTURE_MARKER)
        },
        terminationGraceMs: 100,
        hardSettleWatchdogMs: 100
      });
    } catch (error) {
      failure = error;
    }
    const elapsedMs = Date.now() - startedAt;
    if (!failure || !/timed out after 150ms/.test(errorMessage(failure))) {
      throw new Error(`Escaped descendant fixture did not terminate as expected: ${errorMessage(failure)}`);
    }
    if (elapsedMs > 1_500) {
      throw new Error(`Escaped descendant fixture exceeded its bounded exit: ${elapsedMs}ms.`);
    }
    return emit({ fixture, elapsedMs, activeChildren: activeChildProcesses.size });
  }

  if (fixture === "normal-exit-descendant") {
    const commandPath = cleanEnv(process.env.LIFECYCLE_FIXTURE_COMMAND);
    if (!commandPath) throw new Error("LIFECYCLE_FIXTURE_COMMAND is required.");
    await runCommand(process.execPath, [commandPath, "normal"], {
      timeoutMs: 2_000,
      label: "normal-exit descendant lifecycle fixture",
      quiet: true,
      envCategory: "test_fixture",
      env: {
        LIFECYCLE_FIXTURE_MARKER: cleanEnv(process.env.LIFECYCLE_FIXTURE_MARKER)
      }
    });
    return emit({ fixture, activeChildren: activeChildProcesses.size });
  }

  if (fixture === "fail-fast-siblings") {
    const commandPath = cleanEnv(process.env.LIFECYCLE_FIXTURE_COMMAND);
    if (!commandPath) throw new Error("LIFECYCLE_FIXTURE_COMMAND is required.");
    let failure = null;
    try {
      await runFailFastBranches([
        () => runCommand(process.execPath, [commandPath, "fail"], {
          timeoutMs: 2_000,
          label: "fail-fast failing branch",
          quiet: true,
          envCategory: "test_fixture",
          env: { LIFECYCLE_FIXTURE_MARKER: cleanEnv(process.env.LIFECYCLE_FIXTURE_MARKER) }
        }),
        () => runCommand(process.execPath, [commandPath, "hang"], {
          timeoutMs: 2_000,
          label: "fail-fast hanging sibling",
          quiet: true,
          envCategory: "test_fixture",
          env: { LIFECYCLE_FIXTURE_MARKER: cleanEnv(process.env.LIFECYCLE_FIXTURE_MARKER) }
        })
      ]);
    } catch (error) {
      failure = error;
    }
    if (!failure || !/failing branch exited with 7/.test(errorMessage(failure))) {
      throw new Error(`Fail-fast fixture did not preserve its first failure: ${errorMessage(failure)}`);
    }
    if (activeChildProcesses.size !== 0) {
      throw new Error("Fail-fast fixture terminalized before every sibling process drained.");
    }
    return emit({ fixture, activeChildren: activeChildProcesses.size });
  }

  if (fixture === "event-timeout") {
    lifecycleOperationTimeoutOverrideMs = 25;
    run = { id: "event-timeout-fixture" };
    supabase = {
      from: () => ({
        insert: () => new Promise((_, reject) => {
          setTimeout(() => reject(new Error("late event rejection")), 80);
        })
      })
    };
    const startedAt = Date.now();
    let failure = null;
    try {
      await event("fixture.timeout", "info", "fixture event");
    } catch (error) {
      failure = error;
    }
    const elapsedMs = Date.now() - startedAt;
    await delay(120);
    if (!failure || !/timed out after 25ms/.test(errorMessage(failure))) {
      throw new Error(`Lifecycle event fixture did not time out: ${errorMessage(failure)}`);
    }
    if (elapsedMs > 250) throw new Error(`Lifecycle event timeout was not bounded: ${elapsedMs}ms.`);
    supabase = null;
    run = null;
    lifecycleOperationTimeoutOverrideMs = null;
    return emit({ fixture, elapsedMs });
  }

  if (fixture === "ingestion-task-pagination") {
    const mode = cleanEnv(process.env.LIFECYCLE_FIXTURE_PAGINATION_MODE);
    if (!new Set(["lifecycle-timeout", "row-cap"]).has(mode)) {
      throw new Error("Ingestion-task pagination fixture requires a supported mode.");
    }
    const previousSupabase = supabase;
    const previousTimeoutOverride = lifecycleOperationTimeoutOverrideMs;
    const fixtureRows = Array.from({ length: 5 }, (_, index) => ({
      id: `task-${String(index + 1).padStart(3, "0")}`,
      status: "completed"
    }));
    const requestedPageSizes = [];
    const requestedCursors = [];
    let queryCalls = 0;
    try {
      if (mode === "lifecycle-timeout") lifecycleOperationTimeoutOverrideMs = 20;
      supabase = {
        from: (table) => {
          if (table !== "ingestion_tasks") throw new Error(`Unexpected fixture table: ${table}`);
          return {
            select: () => {
              const request = { cursor: null, pageSize: null };
              const query = {
                order: () => query,
                limit: (pageSize) => {
                  request.pageSize = pageSize;
                  return query;
                },
                gt: (column, cursor) => {
                  if (column !== "id") throw new Error(`Unexpected fixture cursor column: ${column}`);
                  request.cursor = cursor;
                  return query;
                },
                abortSignal: (signal) => {
                  queryCalls += 1;
                  requestedPageSizes.push(request.pageSize);
                  requestedCursors.push(request.cursor);
                  if (mode === "lifecycle-timeout" && queryCalls === 1) {
                    return new Promise((_, reject) => {
                      signal.addEventListener("abort", () => {
                        reject(signal.reason ?? Object.assign(new Error("fixture query aborted"), {
                          name: "AbortError"
                        }));
                      }, { once: true });
                    });
                  }
                  const cursorIndex = request.cursor === null
                    ? -1
                    : fixtureRows.findIndex((row) => row.id === request.cursor);
                  if (request.cursor !== null && cursorIndex < 0) {
                    throw new Error(`Unknown fixture cursor: ${request.cursor}`);
                  }
                  const serverCap = mode === "row-cap" ? 2 : 1;
                  return Promise.resolve({
                    data: fixtureRows.slice(
                      cursorIndex + 1,
                      cursorIndex + 1 + Math.min(request.pageSize, serverCap)
                    ),
                    error: null
                  });
                }
              };
              return query;
            }
          };
        }
      };
      const rows = await readAllIngestionTaskRows(
        `fixture ${mode} ingestion task read`,
        "id,status",
        (query) => query
      );
      return emit({
        fixture,
        mode,
        ids: rows.map((row) => row.id),
        queryCalls,
        requestedPageSizes,
        requestedCursors,
        retryClassification: {
          abortError: isRetryableIngestionTaskReadError(Object.assign(new Error("aborted"), {
            name: "AbortError"
          })),
          transportTimeout: isRetryableIngestionTaskReadError(Object.assign(
            new TypeError("fetch failed"),
            { cause: { code: "UND_ERR_CONNECT_TIMEOUT", message: "connect timed out" } }
          )),
          authorization: isRetryableIngestionTaskReadError({ code: "42501", message: "permission denied" }),
          runnerBudget: isRetryableIngestionTaskReadError({
            code: "AUTONOMOUS_RUNNER_BUDGET_EXCEEDED",
            message: "runner budget exhausted"
          })
        }
      });
    } finally {
      supabase = previousSupabase;
      lifecycleOperationTimeoutOverrideMs = previousTimeoutOverride;
    }
  }

  if (fixture === "heartbeat-drain") {
    let abortObserved = false;
    heartbeatSchedulingStopped = false;
    heartbeatFailure = null;
    heartbeatDrainPromise = null;
    heartbeatInFlight = null;
    heartbeatAbortController = null;
    terminationSignal = null;
    run = {
      id: "heartbeat-drain-fixture",
      lease_token: "22222222-2222-4222-8222-222222222222"
    };
    runtimeLock = {
      lock_key: "autonomous-ingestion",
      lease_token: "33333333-3333-4333-8333-333333333333"
    };
    supabase = {
      from: () => {
        const query = {
          update: () => query,
          eq: () => query,
          abortSignal: (signal) => new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              abortObserved = true;
              reject(signal.reason ?? new Error("heartbeat fixture aborted"));
            }, { once: true });
          })
        };
        return query;
      },
      rpc: () => Promise.resolve({ data: true, error: null })
    };
    scheduleHeartbeat();
    await delay(10);
    await stopHeartbeatAndDrain();
    if (!abortObserved || heartbeatInFlight !== null || heartbeatFailure) {
      throw new Error("Heartbeat did not abort and drain cleanly before finalization.");
    }
    return emit({ fixture, abortObserved, drained: heartbeatInFlight === null });
  }

  if (fixture === "ambiguous-completion") {
    executionCompletionNonce = "44444444-4444-4444-8444-444444444444";
    run = { id: "ambiguous-completion-fixture", status: "completed" };
    finalizedRunStatus = null;
    successfulRunnerOutcomeCandidate = null;
    completedOutcomeVerifiedByThisExecution = false;
    if (completedFinalizationWon()) {
      throw new Error("A pre-existing completed row won before repository receipt verification.");
    }

    const leaseToken = "11111111-1111-4111-8111-111111111111";
    workerId = "lifecycle-fixture-worker";
    run = {
      id: "ambiguous-completion-fixture",
      status: "running",
      lease_owner: workerId,
      lease_token: leaseToken
    };
    const completionStats = bindCompletionProvenance(
      { fixture: true },
      {
        publicationStatus: "published",
        publishedCommit: "b".repeat(40),
        receipt: { fixture: "ambiguous-completion" }
      }
    );
    const durableCompletedRun = {
      id: run.id,
      status: "completed",
      finished_at: new Date().toISOString(),
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      stats_json: completionStats
    };
    let exposeBoundProvenance = false;
    supabase = {
      rpc: () => Promise.resolve({
        data: null,
        error: { message: "simulated response loss after commit" }
      }),
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: () => Promise.resolve({
            data: exposeBoundProvenance
              ? durableCompletedRun
              : { ...durableCompletedRun, stats_json: { fixture: true } },
            error: null
          })
        };
        return query;
      }
    };
    terminationSignal = null;
    heartbeatFailure = null;
    runFinalizationPromise = null;
    finalizedRunStatus = null;
    const provenanceFree = await reconcileAmbiguousCompletedRun(
      { id: run.id },
      completionStats
    );
    if (provenanceFree) {
      throw new Error("A provenance-free completed row incorrectly won reconciliation.");
    }
    exposeBoundProvenance = true;
    const status = await completeRun("completed", completionStats);
    if (status !== "completed" || !completedFinalizationWon()) {
      throw new Error("Ambiguous completion was not reconciled to the durable completed row.");
    }
    supabase = null;
    return emit({ fixture, status, completionVerified: completedOutcomeVerifiedByThisExecution });
  }

  if (fixture === "emergency-release-failure") {
    const publishedCommit = "a".repeat(40);
    terminationSignal = "SIGINT";
    hardFailure = null;
    process.exitCode = 130;
    completedOutcomeVerifiedByThisExecution = true;
    finalizedRunStatus = "completed";
    successfulRunnerOutcomeCandidate = {
      status: "refreshed",
      publicationStatus: "published",
      publishedCommit
    };
    pendingRunnerOutcome = successfulRunnerOutcomeCandidate;
    latestPublishedCommit = publishedCommit;
    runtimeLock = { lock_key: "autonomous-ingestion", lease_token: "fixture-lock-token" };
    runtimeLockReleasePromise = null;
    runnerOutcomeWritePromise = null;
    supabase = {
      rpc: () => Promise.resolve({
        data: null,
        error: { message: "simulated runtime lock release failure" }
      })
    };
    await emergencyCancellationCleanup();
    if (pendingRunnerOutcome?.status !== "failed" || effectiveTerminationExitCode() !== 1) {
      throw new Error("Emergency lock release failure did not replace the successful outcome.");
    }
    return emit({
      fixture,
      status: pendingRunnerOutcome.status,
      exitCode: effectiveTerminationExitCode()
    });
  }

  if (fixture === "lock-release-response-loss") {
    workerId = "lifecycle-fixture-worker";
    runtimeLock = {
      lock_key: "autonomous-ingestion",
      lease_token: "55555555-5555-4555-8555-555555555555"
    };
    runtimeLockReleasePromise = null;
    let releaseCalls = 0;
    let readBackCalls = 0;
    supabase = {
      rpc: () => {
        releaseCalls += 1;
        return Promise.resolve({
          data: null,
          error: { message: "simulated response loss after lock deletion" }
        });
      },
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: () => {
            readBackCalls += 1;
            return Promise.resolve({ data: null, error: null });
          }
        };
        return query;
      }
    };
    await releaseRuntimeLockOnce();
    if (runtimeLock !== null || releaseCalls !== 1 || readBackCalls !== 1) {
      throw new Error("Runtime-lock response loss was not reconciled exactly once.");
    }
    return emit({ fixture, releaseCalls, readBackCalls, released: runtimeLock === null });
  }

  if (fixture === "emergency-heartbeat-order") {
    terminationSignal = "SIGTERM";
    workerId = "lifecycle-fixture-worker";
    hardFailure = null;
    process.exitCode = 143;
    runtimeLock = {
      lock_key: "autonomous-ingestion",
      lease_token: "66666666-6666-4666-8666-666666666666"
    };
    runtimeLockReleasePromise = null;
    heartbeatSchedulingStopped = false;
    heartbeatDrainPromise = null;
    heartbeatAbortController = new AbortController();
    let settleHeartbeat;
    heartbeatInFlight = new Promise((resolve) => {
      settleHeartbeat = resolve;
    }).finally(() => {
      heartbeatInFlight = null;
    });
    let releaseObservedBeforeHeartbeatDrain = false;
    supabase = {
      rpc: () => {
        releaseObservedBeforeHeartbeatDrain = heartbeatInFlight !== null;
        settleHeartbeat();
        return Promise.resolve({ data: true, error: null });
      }
    };
    await emergencyCancellationCleanup();
    if (!releaseObservedBeforeHeartbeatDrain || runtimeLock !== null || heartbeatInFlight !== null) {
      throw new Error("Emergency cleanup did not release the lock before heartbeat drain.");
    }
    return emit({
      fixture,
      releaseObservedBeforeHeartbeatDrain,
      released: runtimeLock === null,
      heartbeatDrained: heartbeatInFlight === null
    });
  }

  if (fixture === "outcome-write-retry") {
    const badOutput = cleanEnv(process.env.LIFECYCLE_FIXTURE_BAD_OUTPUT);
    const goodOutput = cleanEnv(process.env.LIFECYCLE_FIXTURE_GOOD_OUTPUT);
    if (!badOutput || !goodOutput) throw new Error("Outcome retry fixture paths are required.");
    runnerOutcomeWritePromise = null;
    process.env.GITHUB_OUTPUT = badOutput;
    let firstRejected = false;
    try {
      await writeRunnerOutcomeOnce({ status: "failed", failureMessage: "first write" });
    } catch {
      firstRejected = true;
    }
    if (!firstRejected || runnerOutcomeWritePromise !== null) {
      throw new Error("Rejected outcome write was not cleared for retry.");
    }
    process.env.GITHUB_OUTPUT = goodOutput;
    await writeRunnerOutcomeOnce({ status: "failed", failureMessage: "retry write" });
    await writeRunnerOutcomeOnce({ status: "refreshed" });
    const output = await readFile(goodOutput, "utf8");
    const statusLines = output.match(/^runner_status=/gm) ?? [];
    if (statusLines.length !== 1 || !/^runner_status=failed$/m.test(output)) {
      throw new Error("Successful outcome write was duplicated or replaced.");
    }
    return emit({ fixture, writes: statusLines.length });
  }

  if (fixture === "catalog-sanitize") {
    const commandPath = cleanEnv(process.env.LIFECYCLE_FIXTURE_COMMAND);
    if (!commandPath) throw new Error("LIFECYCLE_FIXTURE_COMMAND is required.");
    let failure = null;
    try {
      await runCommand(process.execPath, [commandPath], {
        timeoutMs: 1_000,
        label: "official mutable YC catalog refresh",
        envCategory: "github_collector"
      });
    } catch (error) {
      failure = error;
    }
    if (!failure) throw new Error("Catalog sanitization fixture unexpectedly succeeded.");
    console.error(sanitizeRunnerDiagnosticText(errorMessage(failure)));
    return emit({ fixture, failedAsExpected: true });
  }

  if (fixture === "publication-trailers") {
    const fixturePublicationRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_ROOT);
    const fixturePublicationParent = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_PARENT);
    if (!fixturePublicationRoot || !fixturePublicationParent) {
      throw new Error("Publication trailer fixture requires its isolated worktree paths.");
    }
    publicationRoot = resolve(fixturePublicationRoot);
    publicationWorktreeParent = resolve(fixturePublicationParent);
    configurePublicationArtifactPaths(publicationRoot);
    const previousCandidateMetadata = candidateMetadata;
    try {
      candidateMetadata = validateCandidateMetadata({
        trigger: cleanEnv(process.env.LIFECYCLE_FIXTURE_CANDIDATE_TRIGGER) ?? "manual-replay",
        scheduledAt: cleanEnv(process.env.LIFECYCLE_FIXTURE_SCHEDULED_AT),
        slotKey: idempotencyKey,
        required: true
      });
      const committed = await commitPublicationArtifacts({
        amend: false,
        allowUnchangedTree: process.env.LIFECYCLE_FIXTURE_ALLOW_EMPTY === "true"
      });
      return emit({
        fixture,
        publishedCommit: committed.publishedCommit,
        receiptSha256: committed.receiptSha256
      });
    } finally {
      candidateMetadata = previousCandidateMetadata;
    }
  }

  if (fixture === "lock-claim-ambiguity") {
    workerId = "lifecycle-fixture-worker";
    executionCompletionNonce = "77777777-7777-4777-8777-777777777777";
    runStartedAt = new Date("2026-08-10T00:00:00.000Z");
    const row = {
      lock_key: "autonomous-ingestion",
      owner_id: workerId,
      lease_token: "88888888-8888-4888-8888-888888888888",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      metadata_json: {
        idempotencyKey,
        startedAt: runStartedAt.toISOString(),
        executionCompletionNonce: "foreign-execution-nonce"
      }
    };
    supabase = {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: () => Promise.resolve({ data: row, error: null })
        };
        return query;
      }
    };
    const rejected = await reconcileAmbiguousRuntimeLockClaim();
    row.metadata_json.executionCompletionNonce = executionCompletionNonce;
    const accepted = await reconcileAmbiguousRuntimeLockClaim();
    supabase = null;
    if (rejected !== null || accepted?.lease_token !== row.lease_token) {
      throw new Error("Ambiguous runtime-lock claim was not reconciled by exact owner and execution nonce.");
    }
    return emit({ fixture, foreignRejected: true, exactAccepted: true });
  }

  if (fixture === "git-transport-classification") {
    const networkError = commandExecutionError("git push failed", {
      code: 128,
      stderr: "fatal: unable to access remote: connection reset by peer"
    });
    const authError = commandExecutionError("git push failed", {
      code: 128,
      stderr: "fatal: authentication failed"
    });
    const ordinaryRejection = commandExecutionError("git push failed", {
      code: 1,
      stderr: "non-fast-forward"
    });
    return emit({
      fixture,
      networkRetryable: isRetryableGitTransportFailure(networkError),
      authRetryable: isRetryableGitTransportFailure(authError),
      rejectionRetryable: isRetryableGitTransportFailure(ordinaryRejection)
    });
  }

  if (fixture === "publication-credential-boundary") {
    const fixturePublicationRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_ROOT);
    const fixturePublicationParent = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_PARENT);
    if (!fixturePublicationRoot || !fixturePublicationParent) {
      throw new Error("Publication credential-boundary fixture requires its worktree paths.");
    }
    publicationRoot = resolve(fixturePublicationRoot);
    publicationWorktreeParent = resolve(fixturePublicationParent);
    let failure = null;
    try {
      await runCommand(process.execPath, ["-e", "process.exit(99)"], {
        timeoutMs: 1_000,
        label: "publication credential boundary fixture",
        envCategory: "github_collector",
        cwd: publicationRoot
      });
    } catch (error) {
      failure = error;
    }
    if (!failure || !/Refusing to expose privileged environment GITHUB_TOKEN/.test(errorMessage(failure))) {
      throw new Error(`Publication credential boundary did not fail closed: ${errorMessage(failure)}`);
    }
    return emit({ fixture, rejectedBeforeSpawn: true });
  }

  if (fixture === "publication-executable-boundary") {
    const fixturePublicationRoot = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_ROOT);
    const fixturePublicationParent = cleanEnv(process.env.LIFECYCLE_FIXTURE_PUBLICATION_PARENT);
    const commandPath = cleanEnv(process.env.LIFECYCLE_FIXTURE_COMMAND);
    if (!fixturePublicationRoot || !fixturePublicationParent || !commandPath) {
      throw new Error("Publication executable-boundary fixture requires worktree and command paths.");
    }
    publicationRoot = resolve(fixturePublicationRoot);
    publicationWorktreeParent = resolve(fixturePublicationParent);
    let failure = null;
    try {
      await runCommand(process.execPath, [commandPath], {
        timeoutMs: 1_000,
        label: "publication executable boundary fixture",
        cwd: root
      });
    } catch (error) {
      failure = error;
    }
    if (!failure || !/Refusing to execute publication-worktree code/.test(errorMessage(failure))) {
      throw new Error(`Publication executable boundary did not fail closed: ${errorMessage(failure)}`);
    }
    return emit({ fixture, rejectedBeforeSpawn: true });
  }

  throw new Error(`Unknown lifecycle contract fixture: ${fixture}.`);
}
