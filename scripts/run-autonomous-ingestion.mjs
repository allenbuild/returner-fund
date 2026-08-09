import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  loadAutonomousCatalogs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
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
  createAutonomousRunnerBudget
} from "./lib/autonomous-ingestion-budget.mjs";
import { selectPublishedAutonomousIngestionReceipt } from "./lib/autonomous-ingestion-receipt-policy.mjs";
import { mergeTargetedEvidenceSnapshots } from "./lib/targeted-evidence-merge.mjs";
import { archiveAcceptedPublicSnapshot } from "./lib/archive-public-ingestion.mjs";
import { openLosslessPostArchive } from "./lib/lossless-post-archive.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const idempotencyKey = args.idempotencyKey ?? process.env.INGESTION_IDEMPOTENCY_KEY;
const workerId = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.pid}:${randomUUID()}`;
const runStartedAt = new Date();
const runnerBudget = createAutonomousRunnerBudget({
  phaseMs: AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  startedAt: runStartedAt.getTime()
});
const workRoot = join(root, "work", "autonomous-ingestion", safePathSegment(idempotencyKey ?? "missing"));
const collectorRoot = args.campaignKey
  ? join(root, "work", "autonomous-ingestion-campaigns", safePathSegment(args.campaignKey))
  : workRoot;
const publicOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `public-${batch.slug.toLowerCase()}.json`)])
);
const githubOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `github-${batch.slug.toLowerCase()}.json`)])
);
const discoveryAttemptOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `discovery-attempts-${batch.slug.toLowerCase()}.json`)])
);
const sourceDiscoveryPathOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(collectorRoot, `source-discovery-paths-${batch.slug.toLowerCase()}.json`)])
);
const publishedDiscoveryAttemptsPath = join(root, "outputs", "discovery-attempts-current.json");
const publishedSourceDiscoveryPathsPath = join(root, "outputs", "source-discovery-paths-current.json");
const publishedCohortAuditPath = join(root, "outputs", "cohort-coverage-current.json");
const publishedSourceDeltaPath = join(root, "outputs", "ingestion-source-delta-current.json");
const publishedSourceDeltaHistoryPath = join(root, "outputs", "ingestion-source-delta-history.json");
const publishedGithubQuarantinePath = join(root, "src", "lib", "social", "github-traction-quarantine.json");
const topVoiceOutput = join(collectorRoot, "top-voice-refresh.json");
const losslessPublicArchiveRoot = join(collectorRoot, "lossless-public-post-archive");
const PUBLIC_COLLECTOR_SHARDS = Object.freeze({
  S2026: 4,
  S26: 2,
  A16ZSR006: 1
});
const PUBLIC_SHARD_PROCESS_CONCURRENCY = 2;
const PUBLIC_COLLECTOR_TASK_CONCURRENCY = 8;
const PUBLIC_SOCIAL_LANE_CONCURRENCY = 1;
const runWithPublicShardProcessSlot = createConcurrencyGuard(PUBLIC_SHARD_PROCESS_CONCURRENCY);
const GITHUB_COLLECTOR_SHARDS = Object.freeze({
  S2026: 4,
  S26: 2,
  A16ZSR006: 1
});

if (!idempotencyKey) {
  throw new Error("--idempotency-key or INGESTION_IDEMPOTENCY_KEY is required.");
}

const url = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseConfiguration = validateSupabaseConfiguration(url, serviceKey);
const durableStorageConfigured = supabaseConfiguration.valid;
const discoveryCredentialGaps = [
  !cleanEnv(process.env.X_BEARER_TOKEN) ? "X_BEARER_TOKEN" : null,
  !cleanEnv(process.env.EXA_API_KEY) ? "EXA_API_KEY" : null,
  ...supabaseConfiguration.blockers
].filter(Boolean);

const commitBackedReplay = !args.plan &&
  !args.skipPublish &&
  !durableStorageConfigured &&
  process.env.GITHUB_ACTIONS === "true"
  ? await readCommitBackedReplayReceipt()
  : null;
if (commitBackedReplay) {
  const { receipt, classification } = commitBackedReplay;
  console.log(
    `Ingestion ${idempotencyKey} already has a validated publication receipt in main; ` +
    `the file-backed replay is a no-op (${classification.receiptStatus}).`
  );
  await writeRunnerOutcome({
    status: "already_completed",
    publicationStatus: "already_completed",
    collectionHealth: receipt.collectionHealth,
    newPhysicalSources: receipt.newPhysicalSources,
    dailyNewPhysicalSources: receipt.dailyNewPhysicalSources,
    dailySourceHealth: receipt.dailySourceHealth
  });
  process.exit(0);
}

await Promise.all([
  mkdir(workRoot, { recursive: true }),
  mkdir(collectorRoot, { recursive: true })
]);
if (!args.plan && !args.skipNetwork) {
  await refreshMutableYcCatalog();
}
const catalogs = await loadAutonomousCatalogs(root);
const resolvePublicNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
const resolveCanonicalTargetedAttribution = buildCanonicalTargetedAttributionResolver(catalogs);
const resolveLegacyPublicEvidenceBatch = buildLegacyPublicEvidenceBatchResolver(catalogs);
const plannedTasks = buildAutonomousTaskPlan(catalogs, { runKey: idempotencyKey });
const plannedTaskByCheckpointKey = new Map(plannedTasks.map((task) => [task.checkpointKey, task]));
const plannedCoverage = summarizeTaskCoverage(plannedTasks);

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
        PUBLIC_SHARD_PROCESS_CONCURRENCY * PUBLIC_SOCIAL_LANE_CONCURRENCY
    }
  }, null, 2));
  process.exit(0);
}

const supabase = durableStorageConfigured
  ? createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { "X-Client-Info": "returner-autonomous-ingestion" } }
    })
  : null;

let runtimeLock = null;
let run = null;
let heartbeatTimer = null;
let hardFailure = null;
let heartbeatFailure = null;
let collectionBudget = null;

try {
  if (durableStorageConfigured) {
    runtimeLock = await claimRuntimeLock();
    if (!runtimeLock) {
      throw new Error("Another ingestion coordinator owns the non-expired autonomous-ingestion lease.");
    }
    run = await getOrCreateRun();
  } else {
    console.warn(
      `Durable Supabase import skipped because required production configuration is unusable (${supabaseConfiguration.blockers.join(", ")}). ` +
      "File-backed collection and publication will continue, and the workflow receipt will report degraded collection health."
    );
  }
  if (run?.status === "completed") {
    console.log(`Ingestion ${idempotencyKey} already completed as run ${run.id}; replay is a no-op.`);
    const [currentSourceDelta, sourceDeltaHistory] = await Promise.all([
      readJson(publishedSourceDeltaPath, null),
      readJson(publishedSourceDeltaHistoryPath, [])
    ]);
    const priorSourceDelta = selectPublishedAutonomousIngestionReceipt({
      idempotencyKey,
      currentReceipt: currentSourceDelta,
      history: sourceDeltaHistory
    })?.receipt ?? null;
    await writeRunnerOutcome({
      status: "already_completed",
      publicationStatus: "already_completed",
      collectionHealth: priorSourceDelta?.collectionHealth ?? "unknown",
      newPhysicalSources: priorSourceDelta?.newPhysicalSources ?? "",
      dailyNewPhysicalSources: priorSourceDelta?.dailyNewPhysicalSources ?? "",
      dailySourceHealth: priorSourceDelta?.dailySourceHealth ?? "unknown"
    });
    process.exitCode = 0;
  } else {
    if (durableStorageConfigured) {
      heartbeatTimer = setInterval(() => void heartbeat().catch(failHeartbeat), 60_000);
      heartbeatTimer.unref?.();
    }
    await event("run.started", "info", "Autonomous ingestion run started.", {
      workerId,
      durability: durableStorageConfigured ? "supabase" : "file_backed",
      plannedCoverage,
      catalogs: catalogSummary(catalogs)
    });

    const catalogState = durableStorageConfigured ? await syncCatalogs(catalogs) : null;
    if (catalogState) {
      await enqueueTasks(plannedTasks, catalogState);
      await event("inventory.completed", "info", "Canonical entity/account inventory and task plan persisted.", {
        companies: catalogState.companyByBatchSourceKey.size,
        founders: catalogState.founderByBatchSourceKey.size,
        accounts: catalogState.accountBySourceKey.size,
        ownerAccounts: catalogState.ownerAccountCount,
        retiredOwnerAccounts: catalogState.retiredOwnerAccounts,
        tasks: plannedTasks.length
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
    }
    const [collectionResults, topVoiceRefresh] = args.skipNetwork
      ? [[], null]
      : await Promise.all([
          runCollectors(),
          resumeTopVoiceRefresh()
        ]);
    assertLeaseHealthy();
    if (!args.skipNetwork) validateAutonomousCollectorMatrix(collectionResults);
    if (args.skipNetwork && run) {
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
    const collectionCredentialGaps = [...new Set([
      ...discoveryCredentialGaps,
      ...credentialedDiscoveryFailures
    ])];
    const githubSnapshots = await readAvailableSnapshots(
      publishableCollectorResults.filter((result) => result.kind === "github")
    );
    const collectionCoverage = await summarizeCollectionCoverage(
      plannedTasks,
      collectionResults,
      { skipNetwork: args.skipNetwork }
    );
    const terminalFailureBudget = autonomousMappedTerminalFailureBudget(
      collectionCoverage.mappedExpected
    );
    assertSuccessfulCollection(collectionResults, collectionCoverage);
    await recordCollectionCoverage(collectionCoverage, terminalFailureBudget);
    validateMappedAutonomousCoverage(collectionCoverage, {
      maxTerminalFailures: args.skipPublish
        ? Number.POSITIVE_INFINITY
        : terminalFailureBudget
    });
    assertSuccessfulTopVoiceRefresh(topVoiceRefresh);
    const publicationRunId = run?.id ?? `file:${idempotencyKey}`;
    if (!args.skipPublish) await synchronizePublicationBase();
    const publicationBaseline = await readPublicationEvidenceBaseline();
    const sourceDeltaHistory = await readJson(publishedSourceDeltaHistoryPath, []);
    const publicationInputs = {
      publicSnapshots,
      githubSnapshots,
      publicResults: publishableCollectorResults.filter((result) => result.kind === "public"),
      topVoiceRefresh,
      catalogState,
      collectionCoverage,
      credentialGaps: collectionCredentialGaps
    };
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
      publicationInputs.sanitizedTargetedSnapshot
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
    // Publication state must be read only after the rebase. Reading it before
    // synchronizePublicationBase() can overwrite evidence or discovery rows
    // that another completed ingestion pushed while these collectors ran.
    await mergePublicationInputs(publicationInputs);
    publicationInputs.sourceDelta = summarizeIngestionSourceDelta({
      idempotencyKey,
      beforeSnapshots: publicationBaseline,
      afterSnapshots: await readPublicationEvidenceBaseline(),
      previousHistory: sourceDeltaHistory,
      mappedFailures: collectionCoverage.mappedFailed,
      collectionCoverage,
      credentialGaps: collectionCredentialGaps
    });
    await writeSourceDeltaReceipt(publicationInputs.sourceDelta, sourceDeltaHistory);

    let publicationReceipt = { status: "skipped", publishedCommit: null };
    if (!args.skipPublish) {
      // Freeze the exact invalidation set represented by this build. Admin
      // edits that arrive after this claim remain pending for the next build
      // instead of being incorrectly consumed by the publication below.
      const timelineInvalidationClaim = await claimTimelineArtifactInvalidationsForBuild();
      await buildAndValidatePublication(publicationRunId, catalogState);
      if (run) {
        await persistArtifactManifest(run.id);
      } else {
        await event(
          "artifact_manifest.persistence_skipped",
          "warning",
          "Artifact manifest passed file validation but durable manifest persistence was skipped.",
          { reason: "supabase_not_configured", publicationRunId }
        );
      }
      publicationReceipt = await publishRepositoryArtifacts(publicationRunId, publicationInputs);
      await completePublishedTimelineInvalidations(publicationReceipt, timelineInvalidationClaim);
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
    if (run) {
      await completeRun("completed", {
        ...finalCoverage,
        stageCounters: durableImport,
        finishedAt: new Date().toISOString()
      });
      await event("run.completed", "info", "Autonomous ingestion completed with every task terminal.", finalCoverage);
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
      publicationReceipt,
      topVoiceRefresh
    }, null, 2));
    await writeRunnerOutcome({
      status: "refreshed",
      publicationStatus: publicationReceipt.status,
      collectionHealth: publicationInputs.sourceDelta.collectionHealth,
      newPhysicalSources: publicationInputs.sourceDelta.newPhysicalSources,
      dailyNewPhysicalSources: publicationInputs.sourceDelta.dailyNewPhysicalSources,
      dailySourceHealth: publicationInputs.sourceDelta.dailySourceHealth
    });
  }
} catch (error) {
  hardFailure = error;
  const message = errorMessage(error);
  console.error(message);
  if (run?.id) {
    await event("run.failed", "error", message, { stack: error instanceof Error ? error.stack ?? null : null }).catch(() => {});
    await completeRun("failed", { error: message, failedAt: new Date().toISOString() }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (runtimeLock) {
    await releaseRuntimeLock().catch((error) => {
      console.error(`Failed to release ingestion lease: ${errorMessage(error)}`);
      if (!hardFailure) process.exitCode = 1;
    });
  }
}

async function claimRuntimeLock() {
  const { data, error } = await supabase.rpc("claim_ingestion_runtime_lock", {
    p_lock_key: "autonomous-ingestion",
    p_owner_id: workerId,
    p_lease_duration: "20 minutes",
    p_metadata_json: { idempotencyKey, startedAt: runStartedAt.toISOString() }
  });
  check(error, "claim runtime lock");
  return Array.isArray(data) ? data[0] ?? null : data;
}

async function releaseRuntimeLock() {
  const { data, error } = await supabase.rpc("release_ingestion_runtime_lock", {
    p_lock_key: runtimeLock.lock_key,
    p_owner_id: workerId,
    p_lease_token: runtimeLock.lease_token
  });
  check(error, "release runtime lock");
  if (data !== true) throw new Error("The ingestion runtime lock was lost before release.");
}

async function heartbeat() {
  if (!run || !runtimeLock) return;
  const now = new Date().toISOString();
  const { error: runError } = await supabase
    .from("ingestion_runs")
    .update({ heartbeat_at: now, lease_expires_at: new Date(Date.now() + 20 * 60_000).toISOString() })
    .eq("id", run.id)
    .eq("lease_token", run.lease_token);
  check(runError, "heartbeat ingestion run");
  const { data, error } = await supabase.rpc("renew_ingestion_runtime_lock", {
    p_lock_key: runtimeLock.lock_key,
    p_owner_id: workerId,
    p_lease_token: runtimeLock.lease_token,
    p_lease_duration: "20 minutes"
  });
  check(error, "heartbeat runtime lock");
  if (data !== true) throw new Error("The ingestion runtime lock expired or was taken by another worker.");
}

function failHeartbeat(error) {
  heartbeatFailure = error instanceof Error ? error : new Error(errorMessage(error));
  console.error(`Heartbeat failure: ${errorMessage(heartbeatFailure)}`);
  process.exitCode = 1;
}

function assertLeaseHealthy() {
  if (heartbeatFailure) {
    throw new Error(`Ingestion lease heartbeat failed; publication aborted: ${errorMessage(heartbeatFailure)}`);
  }
}

async function getOrCreateRun() {
  const existing = await selectMaybeSingle(
    supabase.from("ingestion_runs").select("*").eq("idempotency_key", idempotencyKey).limit(1),
    "read idempotent ingestion run"
  );
  if (existing?.status === "completed") return existing;
  if (existing) {
    const leaseToken = randomUUID();
    const { data, error } = await supabase
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
      .single();
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
  const { data, error } = await supabase.from("ingestion_runs").insert(payload).select("*").single();
  if (error?.code === "23505") {
    return selectSingle(
      supabase.from("ingestion_runs").select("*").eq("idempotency_key", idempotencyKey).limit(1),
      "recover concurrent ingestion run"
    );
  }
  check(error, "create ingestion run");
  return data;
}

async function event(eventType, severity, message, payload = {}, eventKey = null) {
  if (!supabase || !run?.id) {
    console.log(`[${severity}] ${eventType}: ${message}`);
    return;
  }
  const { error } = await supabase.from("ingestion_run_events").insert({
    ingestion_run_id: run.id,
    event_key: eventKey,
    event_type: eventType,
    severity,
    message,
    payload_json: payload
  });
  check(error, `record ${eventType} event`);
}

async function syncCatalogs(allCatalogs) {
  const batchBySlug = new Map();
  const companyBySourceKey = new Map();
  const companyByBatchSourceKey = new Map();
  const founderBySourceKey = new Map();
  const founderByBatchSourceKey = new Map();
  const accountBySourceKey = new Map();
  const accountInventory = [];
  const ownerInventory = [];

  for (const catalog of allCatalogs) {
    const { data: batch, error: batchError } = await supabase
      .from("batches")
      .upsert(
        { slug: catalog.slug, label: catalog.label, company_count_expected: catalog.companies.length },
        { onConflict: "slug" }
      )
      .select("id,slug")
      .single();
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
    const { data: companies, error: companyError } = await supabase
      .from("companies")
      .upsert(companyRows, { onConflict: "batch_id,source_key" })
      .select("id,source_key");
    check(companyError, `upsert companies for ${catalog.slug}`);
    for (const company of companies ?? []) {
      companyByBatchSourceKey.set(batchCompanyKey(catalog.slug, company.source_key), company.id);
      const canonicalCompanyId = companyBySourceKey.get(company.source_key);
      if (!canonicalCompanyId || String(company.id).localeCompare(String(canonicalCompanyId)) < 0) {
        companyBySourceKey.set(company.source_key, company.id);
      }
    }

    const founderRows = [...new Map(catalog.companies.flatMap((company) =>
      company.founders.map((founder) => [founder.sourceKey, {
        source_key: founder.sourceKey,
        name: founder.name,
        yc_profile_url: founder.profileUrl,
        personal_website_url: founder.websiteUrl,
        review_state: normalizeReviewState(founder.reviewState)
      }])
    )).values()];
    if (founderRows.length) {
      const { data: founders, error: founderError } = await supabase
        .from("founders")
        .upsert(founderRows, { onConflict: "source_key" })
        .select("id,source_key");
      check(founderError, `upsert founders for ${catalog.slug}`);
      for (const founder of founders ?? []) {
        founderBySourceKey.set(founder.source_key, founder.id);
        founderByBatchSourceKey.set(batchCompanyKey(catalog.slug, founder.source_key), founder.id);
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
      const { error } = await supabase.from("company_founders").upsert(joins, { onConflict: "company_id,founder_id" });
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
    const { data, error } = await supabase
      .from("social_accounts")
      .upsert(accountRows, { onConflict: "platform,url" })
      .select("id,source_key,platform,url");
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
      last_seen_at: now,
      last_seen_run_id: run.id,
      retired_at: null,
      retirement_reason: null
    });
  }
  await mapWithConcurrency(chunks([...ownerRowsByKey.values()], 250), 4, async (ownerRows) => {
    if (ownerRows.length === 0) return;
    const { error } = await supabase
      .from("social_account_owners")
      .upsert(ownerRows, { onConflict: "owner_key" });
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
    const { data, error } = await supabase
      .from("social_account_owners")
      .select("id,owner_key")
      .in("batch_id", batchIds)
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    check(error, "read batch-scoped social account owners for retirement");
    existingOwners.push(...(data ?? []));
    if ((data?.length ?? 0) < 1_000) break;
  }
  const staleIds = existingOwners
    .filter((owner) => !activeOwnerKeys.has(owner.owner_key))
    .map((owner) => owner.id);
  await mapWithConcurrency(chunks(staleIds, 250), 4, async (ids) => {
    if (ids.length === 0) return;
    const { error } = await supabase
      .from("social_account_owners")
      .update({
        review_state: "rejected",
        retired_at: retiredAt,
        retirement_reason: "absent_from_current_batch_owner_inventory"
      })
      .in("id", ids);
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
    const { error } = await supabase.from("ingestion_tasks").upsert(taskRows, { onConflict: "checkpoint_key" });
    check(error, "enqueue account/platform tasks");
  });
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
  const publicEvidencePath = "src/lib/social/public-evidence-current.json";
  const basePublicSnapshot = baseRef
    ? await readPublicEvidenceFromGitRef(baseRef, null)
    : null;
  const previousPublicSnapshot = (
    await readPublicEvidenceArtifact(join(root, publicEvidencePath), { rootDir: root })
  ).snapshot;
  return mergePublicEvidenceSnapshots(
    [basePublicSnapshot, previousPublicSnapshot, ...publicSnapshots].filter(Boolean),
    {
      durableStorageConfigured,
      resolveBatchSlug: resolveLegacyPublicEvidenceBatch,
      resolveNativeAuthor: resolvePublicNativeAuthor,
      contentIdentityReferenceRows
    }
  );
}

async function readCanonicalContentIdentityReferenceRows(targetedSnapshot, { baseRef = null } = {}) {
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
      join(root, path),
      `Canonical content-identity evidence ${path}`
    )),
    ...githubPaths.map((path) => readRequiredCanonicalJson(
      join(root, path),
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
  const loggedInEvidencePath = "src/lib/social/logged-in-evidence-current.json";
  const current = await readRequiredCanonicalJson(
    join(root, loggedInEvidencePath),
    "Canonical logged-in attribution reconciliation ledger"
  );
  const base = baseRef ? await readJsonFromGitRef(baseRef, loggedInEvidencePath, null) : null;
  return combineAttributionReconciliationLedgers(
    base?.attributionReconciliationLedger,
    current.attributionReconciliationLedger
  );
}

async function readCanonicalSeededAttributionReconciliationLedger({ baseRef = null } = {}) {
  const reconciliationPath = "src/lib/social/a16z-speedrun-006-attribution-reconciliation.json";
  const current = await readRequiredCanonicalJson(
    join(root, reconciliationPath),
    "Canonical A16Z seeded attribution reconciliation ledger"
  );
  const base = baseRef ? await readJsonFromGitRef(baseRef, reconciliationPath, null) : null;
  return combineAttributionReconciliationLedgers(
    base?.attributionReconciliationLedger,
    current.attributionReconciliationLedger
  );
}

async function readPublicationEvidenceBaseline({ baseRef = null } = {}) {
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
    : readRequiredCanonicalJson(join(root, path), `Canonical publication baseline ${path}`)
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
  const targetedEvidencePath = "src/lib/social/targeted-evidence-current.json";
  const [baseTargetedSnapshot, previousTargetedSnapshot] = await Promise.all([
    baseRef ? readJsonFromGitRef(baseRef, targetedEvidencePath, null) : null,
    readRequiredCanonicalJson(join(root, targetedEvidencePath), "Canonical targeted evidence snapshot")
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

function combineAttributionReconciliationLedgers(...ledgers) {
  const byPhysicalTarget = new Map();
  for (const entry of ledgers.flatMap((ledger) => ledger ?? [])) {
    const stale = entry?.staleAttribution;
    if (!entry?.platform || !stale?.batchSlug || !stale?.entityId) continue;
    const key = [
      entry.platform,
      entry.platformPostId ?? entry.sourceUrl,
      stale.batchSlug,
      stale.entityType ?? "company",
      stale.entityId,
      stale.attributionType ?? "subject"
    ].join(":");
    const previous = byPhysicalTarget.get(key);
    if (!previous || (previous.disposition === "quarantined" && entry.disposition === "reattributed")) {
      byPhysicalTarget.set(key, entry);
    }
  }
  return [...byPhysicalTarget.values()];
}

async function mergePublicationInputs(
  {
    publicSnapshots,
    githubSnapshots,
    publicResults,
    topVoiceRefresh,
    sanitizedPublicSnapshot = null,
    sanitizedTargetedSnapshot = null
  },
  { baseRef = null } = {}
) {
  const publicEvidencePath = "src/lib/social/public-evidence-current.json";
  if (publicSnapshots.length > 0) {
    const trustedPublicSnapshot = sanitizedPublicSnapshot ?? (
      baseRef
        ? await prepareSanitizedPublicSnapshot(publicSnapshots, { baseRef })
        : await prepareSanitizedPublicSnapshot(publicSnapshots)
    );
    await writePublicEvidenceArtifactPairAtomic({
      rootDir: root,
      canonicalPath: join(root, publicEvidencePath),
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
    join(root, targetedEvidencePath),
    trustedTargetedSnapshot
  );

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
    captureLimit: gitRefCaptureLimit(path)
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

async function runCollectors() {
  await prepareBatchDiscoveryState();
  await event("collection.started", "info", "Public collectors started with bounded parallelism.", {
    collectionDeadlineAt: new Date(collectionBudget.deadlineAt).toISOString(),
    collectionPhaseMs: AUTONOMOUS_PROCESS_BUDGETS.collectionPhaseMs,
    publicShardProcessConcurrency: PUBLIC_SHARD_PROCESS_CONCURRENCY,
    publicTaskConcurrencyPerProcess: PUBLIC_COLLECTOR_TASK_CONCURRENCY,
    publicTaskConcurrencyAcrossProcesses:
      PUBLIC_SHARD_PROCESS_CONCURRENCY * PUBLIC_COLLECTOR_TASK_CONCURRENCY,
    publicSocialLaneConcurrencyPerProcess: PUBLIC_SOCIAL_LANE_CONCURRENCY,
    publicSocialLaneConcurrencyAcrossProcesses:
      PUBLIC_SHARD_PROCESS_CONCURRENCY * PUBLIC_SOCIAL_LANE_CONCURRENCY
  });
  const githubSearchArg = process.env.GITHUB_TOKEN?.trim() ? "--search" : "--no-search";
  const commands = [
    ...AUTONOMOUS_BATCHES.map(({ slug: batchSlug }) => ({
      kind: "public",
      batchSlug,
      outputPath: publicOutputs.get(batchSlug),
      run: () => runShardedPublicCollector({
        batchSlug,
        outputPath: publicOutputs.get(batchSlug),
        shardCount: PUBLIC_COLLECTOR_SHARDS[batchSlug] ?? 1,
        baseArgs: [
          "scripts/fetch-public-traction.mjs",
          `--batch=${batchSlug}`,
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
        run: () => runShardedGithubCollector({
          batchSlug: batch.slug,
          outputPath: githubOutputs.get(batch.slug),
          shardCount: GITHUB_COLLECTOR_SHARDS[batch.slug] ?? 1,
          totalCompanyCount: companyCount,
          baseArgs: [
            "scripts/fetch-github-traction.mjs",
            `--batch=${batch.slug}`,
            // Official-page and mapped-account fetches are ordinary GitHub/web
            // reads and must cover the full cohort within the process budget.
            // Search API calls use their own single-worker lane because all
            // cohorts share one workflow token and search rate-limit bucket.
            "--workers=16",
            "--search-workers=1",
            "--website",
            githubSearchArg
          ]
        })
      };
    })
  ];
  let githubQueue = Promise.resolve();
  for (const command of commands) {
    if (command.kind === "github") {
      command.promise = githubQueue.then(() => runCollectorWithRetries(command));
      githubQueue = command.promise.catch(() => {});
    } else {
      command.promise = runCollectorWithRetries(command);
    }
  }
  const settled = await Promise.allSettled(commands.map((command) => command.promise));
  const results = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const result = settled[index];
    const recoveredSnapshot = result.status === "rejected"
      ? await readCollectorSnapshot(command.outputPath, command.kind, command)
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
  await event("collection.finished", "info", "Public collector processes reached terminal states.", { results });
  return results;
}

async function runShardedPublicCollector({
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
  const snapshots = await Promise.all(
    shards.map((shard) => readJson(shard.outputPath, null))
  );
  if (snapshots.some((snapshot) => !snapshot)) {
    throw new Error(`public ${batchSlug} did not write every shard snapshot.`);
  }
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
  const merged = mergePublicEvidenceSnapshots(snapshots, {
    fetchedAt: new Date().toISOString(),
    durableStorageConfigured
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
    recentCoverageCutoff
  };
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

async function runShardedGithubCollector({
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
  // The GitHub search lane remains bounded to one worker per shard. Sharding
  // makes full-cohort discovery finish inside the process budget while every
  // output stays isolated, so a timed-out process can never clobber a sibling.
  // Wait for every sibling to stop before a retry begins.
  const shardResults = await Promise.allSettled(shards.map((shard) =>
    runCommand(
      process.execPath,
      [
        ...baseArgs,
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
        deadlineAt: collectionBudget.deadlineAt,
        label: `github ${batchSlug} shard ${shard.shardIndex + 1}/${shardCount}`
      }
    )
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
  const snapshots = await Promise.all(
    shards.map((shard) => readJson(shard.outputPath, null))
  );
  if (snapshots.some((snapshot) => !snapshot)) {
    throw new Error(`github ${batchSlug} did not write every shard snapshot.`);
  }
  await writeJsonAtomic(
    outputPath,
    mergeGithubCollectorShards(snapshots, {
      batchSlug,
      shardCount,
      fetchedAt: new Date().toISOString()
    })
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
      deadlineAt: collectionBudget.deadlineAt,
      label: `public ${batchSlug} shard ${shardIndex + 1}/${shardCount}`
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
      timeoutMs: boundedCollectionTimeoutMs(
        AUTONOMOUS_PROCESS_BUDGETS.collectorCheckpointFlushMs,
        `public ${batchSlug} shard ${shardIndex + 1}/${shardCount} checkpoint flush`
      ),
      deadlineAt: collectionBudget.deadlineAt,
      label: `public ${batchSlug} shard ${shardIndex + 1}/${shardCount} checkpoint flush`
    });
  }
}

async function runTopVoiceCollector() {
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
      "./scripts/lib/scoring-diagnostics-ts-loader.mjs",
      "scripts/run-top-voice-ingestion.mjs",
      `--output=${topVoiceOutput}`,
      `--batches=${AUTONOMOUS_BATCHES.map((batch) => batch.slug).join(",")}`,
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
      deadlineAt: collectionBudget.deadlineAt,
      label: "Top Voice X discovery"
    }
  );
  const receipt = await readJson(topVoiceOutput, null);
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
    validateSnapshot: assertSuccessfulTopVoiceRefresh,
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

async function runCollectorWithRetries(command, maxAttempts = AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts) {
  if (args.resumeSnapshots) {
    const snapshot = await readCollectorSnapshot(command.outputPath, command.kind, {
      batchSlug: command.batchSlug,
      expectedSourcePath: command.expectedSourcePath
    });
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
      const attemptStartedAt = Date.now();
      await command.run();
      const snapshot = await readCollectorSnapshot(command.outputPath, command.kind, {
        batchSlug: command.batchSlug,
        expectedSourcePath: command.expectedSourcePath,
        notBefore: attemptStartedAt
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
  const { data, error } = await supabase
    .from("ingestion_tasks")
    .select("id,company_name,entity_type,status,checkpoint_key")
    .eq("ingestion_run_id", run.id)
    .eq("batch_id", catalogState.batchBySlug.get(batchSlug))
    .eq("platform", platform)
    .eq("status", "queued");
  check(error, `read ${batchSlug}/${platform} tasks`);
  return data ?? [];
}

async function finishTasks(ids, status, reason, attempts = 1) {
  if (ids.length === 0) return;
  const terminalAt = new Date().toISOString();
  const { error } = await supabase
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
    .eq("status", "queued");
  check(error, `finish ${ids.length} ingestion tasks`);
}

async function terminalizeQueuedTasks(runId, status, reason) {
  const { error } = await supabase
    .from("ingestion_tasks")
    .update({ status, terminal_at: new Date().toISOString(), terminal_reason: reason })
    .eq("ingestion_run_id", runId)
    .eq("status", "queued");
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
  const importer = await import("./lib/durable-evidence-import.mjs");
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
        company.sourceKey.replace(/^a16z-speedrun-006[:-]/, "")
      ]) {
        if (alias) companyAliasesByBatch.set(batchCompanyKey(catalog.slug, alias), companyId);
      }
      for (const founder of company.founders) {
        const founderId = catalogState.founderByBatchSourceKey.get(
          batchCompanyKey(catalog.slug, founder.sourceKey)
        );
        const founderBatches = founderBatchSlugsById.get(founderId) ?? new Set();
        founderBatches.add(catalog.slug);
        founderBatchSlugsById.set(founderId, founderBatches);
        for (const alias of [founder.sourceKey, founder.name]) {
          if (alias) founderAliasesByBatch.set(batchCompanyKey(catalog.slug, alias), founderId);
        }
      }
    }
  }
  const result = await importer.importEvidenceSnapshots({
    client: supabase,
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
  });
  return { status: "completed", configured: true, ...result };
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
            batchSlug: result.batchSlug
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
  const degraded = (coverage.mappedFailed ?? 0) > 0;
  const budgetExceeded = (coverage.mappedFailed ?? 0) > terminalFailureBudget;
  const summary = {
    mappedExpected: coverage.mappedExpected,
    mappedSucceeded: coverage.mappedSucceeded,
    mappedNeedsReview: coverage.mappedNeedsReview,
    mappedBlockedOrEmpty: coverage.mappedBlockedOrEmpty,
    mappedFailed: coverage.mappedFailed,
    mappedNonTerminal: coverage.mappedNonTerminal,
    terminalFailureBudget,
    status: budgetExceeded ? "failed_budget_exceeded" : degraded ? "degraded" : "complete",
    failedTaskSamples: coverage.mappedFailureSamples
  };
  console.log(`COLLECTION_COVERAGE_RECEIPT ${JSON.stringify(summary)}`);
  if (degraded) {
    console.warn(
      budgetExceeded
        ? `Refusing publication because ${coverage.mappedFailed} explicit terminal mapped failure(s) exceed ` +
          `the budget of ${terminalFailureBudget}.`
        : `Publishing a degraded refresh with ${coverage.mappedFailed} explicit terminal mapped failure(s) ` +
          `within the budget of ${terminalFailureBudget}.`
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
    `- Terminal failures: ${coverage.mappedFailed}/${terminalFailureBudget}`,
    `- Nonterminal tasks: ${coverage.mappedNonTerminal}`,
    ...(coverage.mappedFailureSamples ?? []).map((sample) =>
      `- Failed task: \`${sample.checkpointKey}\` — ${sample.reason}`
    ),
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
  const { data: tasks, error } = await supabase
    .from("ingestion_tasks")
    .select("status,platform,batch_id,terminal_reason,checkpoint_key")
    .eq("ingestion_run_id", run.id);
  check(error, "read terminal coverage");
  const terminalStatuses = new Set(["completed", "needs_review", "blocked_or_empty", "skipped", "failed", "canceled", "dead_lettered"]);
  const needsReview = (tasks ?? []).filter((task) => task.status === "needs_review").length;
  const blockedOrEmpty = (tasks ?? []).filter((task) => task.status === "blocked_or_empty").length;
  const skipped = (tasks ?? []).filter((task) => task.status === "skipped").length;
  const mappedCheckpointKeys = new Set(
    plannedTasks
      .filter((task) => task.status === "queued" && Boolean(task.account))
      .map((task) => task.checkpointKey)
  );
  const mappedTasks = (tasks ?? []).filter((task) => mappedCheckpointKeys.has(task.checkpoint_key));
  const report = {
    expected: tasks?.length ?? 0,
    attempted: (tasks ?? []).filter((task) => task.status !== "queued").length,
    succeeded: (tasks ?? []).filter((task) => task.status === "completed").length,
    needsReview,
    blockedOrEmpty,
    failed: (tasks ?? []).filter((task) => ["failed", "dead_lettered"].includes(task.status)).length,
    skipped,
    nonTerminal: (tasks ?? []).filter((task) => !terminalStatuses.has(task.status)).length,
    mappedExpected: mappedCheckpointKeys.size,
    mappedSucceeded: mappedTasks.filter((task) => task.status === "completed").length,
    mappedNeedsReview: mappedTasks.filter((task) => task.status === "needs_review").length,
    mappedBlockedOrEmpty: mappedTasks.filter((task) => task.status === "blocked_or_empty").length,
    mappedFailed: mappedTasks.filter((task) => ["failed", "dead_lettered"].includes(task.status)).length,
    mappedNonTerminal: mappedTasks.filter((task) => !terminalStatuses.has(task.status)).length,
    coveragePercentage: tasks?.length
      ? Number((((tasks.length - (tasks ?? []).filter((task) => !terminalStatuses.has(task.status)).length) / tasks.length) * 100).toFixed(2))
      : 100,
    stageCounters,
    generatedAt: new Date().toISOString()
  };
  const { error: reportError } = await supabase.from("ingestion_coverage_reports").upsert(
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
  );
  check(reportError, "persist coverage report");
  return report;
}

async function persistArtifactManifest(runId) {
  const path = join(root, "public", "graph", "manifest.json");
  const content = await readFile(path);
  const details = await stat(path);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const { error } = await supabase.from("ingestion_artifact_manifests").upsert(
    {
      ingestion_run_id: runId,
      artifact_key: "public-graph-manifest",
      artifact_type: "graph_manifest",
      storage_uri: "repo://public/graph/manifest.json",
      content_type: "application/json",
      byte_size: details.size,
      sha256,
      metadata_json: JSON.parse(content.toString("utf8"))
    },
    { onConflict: "ingestion_run_id,artifact_key" }
  );
  check(error, "persist artifact manifest");
}

async function claimTimelineArtifactInvalidationsForBuild() {
  if (!supabase) return { ids: [], claimedAt: null };
  const claimedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("timeline_artifact_invalidations")
    .update({ status: "processing", processed_at: null, last_error: null })
    .in("status", ["pending", "processing", "failed"])
    .select("id,company_id,invalidated_at");
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

async function completePublishedTimelineInvalidations(publicationReceipt, invalidationClaim) {
  if (
    !supabase
    || !["published", "no_changes"].includes(publicationReceipt.status)
    || !invalidationClaim?.ids?.length
  ) return;
  const processedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("timeline_artifact_invalidations")
    .update({ status: "completed", processed_at: processedAt, last_error: null })
    .eq("status", "processing")
    .in("id", invalidationClaim.ids)
    .select("id,company_id");
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
        "./scripts/lib/scoring-diagnostics-ts-loader.mjs",
        "scripts/discover-company-timeline-public-sources.mjs",
        `--budget-ms=${AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs}`,
        "--concurrency=2",
        "--max-companies=12",
        "--per-fetch-timeout-ms=6000"
      ], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs + 30_000,
        label: "file-backed Company Timeline public discovery",
        captureLimit: 100_000
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

  const { error: migrationError } = await supabase
    .from("timeline_source_coverage")
    .select("company_id", { count: "exact", head: true });
  if (migrationError && isTimelineMigrationUnavailable(migrationError)) {
    await event(
      "timeline.discovery.skipped",
      "warning",
      "Company Timeline migration is not applied; durable discovery was skipped and last-good graph artifacts were preserved.",
      { reason: "timeline_migration_unavailable", code: migrationError.code ?? null }
    );
    throw new Error(
      "Company Timeline migration is unavailable; refusing to rebuild or publish graph-only timeline artifacts over the last-good durable timeline."
    );
  }
  check(migrationError, "preflight Company Timeline migration");

  const inventory = await buildCanonicalTimelineIngestionInventory(catalogState);
  const inventoryPath = join(workRoot, "timeline-company-inventory.json");
  await writeJsonAtomic(inventoryPath, inventory);
  const result = await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    "./scripts/lib/scoring-diagnostics-ts-loader.mjs",
    "scripts/run-company-timeline-ingestion.mjs",
    `--run-id=${run.id}`,
    `--worker-id=${workerId}:timeline`,
    `--inventory=${inventoryPath}`,
    `--budget-ms=${AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.timelineDiscoveryMs + 30_000,
    label: "durable Company Timeline discovery",
    captureLimit: 100_000
  });
  const receipt = JSON.parse(result.stdout.trim());
  await event(
    "timeline.discovery.persisted",
    receipt.deadLetteredTasks ? "warning" : "info",
    "Durable Company Timeline discovery reached terminal coverage.",
    receipt
  );
  return receipt;
}

async function buildCanonicalTimelineIngestionInventory(catalogState) {
  const evidenceByCompany = new Map();
  const graphCompanyIds = new Set();
  for (const batch of AUTONOMOUS_BATCHES) {
    const graph = await readRequiredCanonicalJson(
      join(root, "public", "graph", batch.graphFile),
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

async function buildAndValidatePublication(publicationRunId, catalogState) {
  // The benchmark publisher boots `next start`; build the current canonical
  // evidence first so a clean runner never depends on an absent or stale
  // `.next` directory. A second build below captures the newly written graph
  // and Timeline artifacts in the deployable trace.
  const benchmarkWindowStart = new Date().toISOString();
  await runCommand(process.execPath, ["scripts/prepare-graph-runtime-evidence.mjs"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "pre-publication compact graph runtime preparation"
  });
  await runCommand(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.productionBuildMs,
    label: "pre-publication production build"
  });
  await runCommand(process.execPath, ["scripts/update-daily-benchmarks.mjs"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.benchmarkPublicationMs,
    label: "graph and benchmark publication",
    env: {
      INGESTION_RUN_ID: publicationRunId,
      BENCHMARK_WINDOW_START: benchmarkWindowStart
    }
  });
  // Durable discovery runs against the just-refreshed canonical inventory and
  // must reach terminal source coverage before the artifact backfill reads
  // published database events. A failure aborts publication, preserving the
  // repository's last-good timeline artifacts.
  await runTimelineDiscoveryBeforeBackfill(catalogState);
  const timelineBackfillEnv = durableStorageConfigured
    ? {
        TIMELINE_REQUIRE_DATABASE: "true"
      }
    : {
        NEXT_PUBLIC_SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        TIMELINE_REQUIRE_DATABASE: "false"
      };
  await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    "./scripts/lib/scoring-diagnostics-ts-loader.mjs",
    "scripts/backfill-company-timelines.mjs",
    "--resume"
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.timelineBackfillMs,
    label: "company timeline backfill",
    env: timelineBackfillEnv
  });
  await runCommand(process.execPath, ["scripts/validate-timeline-artifacts.mjs"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "company timeline artifact validation"
  });
  await runCommand(process.execPath, ["scripts/prepare-graph-runtime-evidence.mjs"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "compact graph runtime preparation"
  });
  await runCommand("npm", ["run", "topics:facets"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.derivedArtifactMs,
    label: "topic facet regeneration"
  });
  await runCommand("npm", ["run", "ranked-posts:sidecar"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.derivedArtifactMs,
    label: "Ranked Posts sidecar regeneration"
  });
  await runCommand("npm", ["run", "topics:facets:validate"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.derivedArtifactMs,
    label: "topic facet validation"
  });
  await runCommand("npm", ["run", "ranked-posts:sidecar:validate"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.derivedArtifactMs,
    label: "Ranked Posts sidecar validation"
  });
  // Build only after all public graph, Timeline, topic-facet, and Ranked Posts
  // artifacts have been rebuilt and strictly validated, so the deployable
  // trace is the exact publication we are about to commit rather than the
  // previous artifact generation.
  await runCommand(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.productionBuildMs,
    label: "production build"
  });
  await runCommand(process.execPath, [
    "--experimental-strip-types",
    "--loader",
    "./scripts/lib/scoring-diagnostics-ts-loader.mjs",
    "./scripts/run-scoring-diagnostics-v4.mjs"
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.scoringDiagnosticsMs,
    label: "scoring diagnostics regeneration"
  });
  await runCommand(process.execPath, [
    "scripts/audit-cohort-coverage.mjs",
    `--run-dir=${workRoot}`,
    `--output=${publishedCohortAuditPath}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "cohort coverage audit"
  });
  await runCommand(process.execPath, ["scripts/write-artifact-manifest.mjs", `--ingestion-run-id=${publicationRunId}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactManifestMs,
    label: "artifact manifest"
  });
  await runCommand(process.execPath, ["scripts/validate-public-artifacts.mjs"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "artifact validation"
  });
}

async function synchronizePublicationBase() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const branch = publicationBranch();
  await runCommand("git", ["fetch", "origin", branch], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: "fetch publication base"
  });
  try {
    await runCommand("git", ["rebase", "--autostash", `origin/${branch}`], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
      label: "synchronize publication base"
    });
  } catch (error) {
    await abortPublicationRebase();
    throw error;
  }
  await assertNoPublicationConflicts();
  await event("publication.base_synchronized", "info", "Publication base synchronized before artifact generation.", {
    branch
  });
}

async function publishGithubExports(snapshots, { baseRef = null } = {}) {
  const destinations = new Map([
    ["S2026", join(root, "src", "lib", "social", "github-traction.json")],
    ["S26", join(root, "src", "lib", "social", "github-traction-summer-2026.json")],
    ["A16ZSR006", join(root, "src", "lib", "social", "github-traction-a16z-speedrun-006.json")]
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
    const relativeDestination = destination.slice(root.length + 1);
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

  await runCommand("git", ["config", "user.name", "github-actions[bot]"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitConfigMs,
    label: "configure publication author"
  });
  await runCommand("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitConfigMs,
    label: "configure publication email"
  });
  await stageRepositoryArtifacts();

  const diff = await runCommand("git", ["diff", "--cached", "--quiet"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "check staged artifacts",
    allowedExitCodes: [0, 1]
  });
  if (diff.code === 0) {
    await event("publication.no_changes", "info", "No public artifact changes required publication.", {});
    return {
      status: "no_changes",
      publishedCommit: (await runCommand("git", ["rev-parse", "HEAD"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
        label: "resolve unchanged publication commit"
      })).stdout.trim()
    };
  }

  await runCommand("git", ["commit", "-m", `Publish autonomous ingestion ${idempotencyKey}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitCommitMs,
    label: "commit refreshed artifacts"
  });
  const branch = publicationBranch();
  const firstPush = await runCommand("git", ["push", "origin", `HEAD:${branch}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: "push refreshed artifacts",
    allowedExitCodes: [0, 1]
  });
  if (firstPush.code !== 0) {
    await event(
      "publication.push_retry",
      "warning",
      "Publication push was rejected; rebasing, rebuilding, and validating once before retry.",
      { branch, stderr: firstPush.stderr }
    );
    try {
      await runCommand("git", ["fetch", "origin", branch], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
        label: "fetch publication retry base"
      });
      await runCommand("git", ["rebase", `origin/${branch}`], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
        label: "rebase publication commit"
      });
    } catch (error) {
      await abortPublicationRebase();
      throw error;
    }
    await assertNoPublicationConflicts();
    const rebasedSanitizedTargetedSnapshot = await prepareSanitizedTargetedSnapshot(
      publicationInputs.topVoiceRefresh,
      { baseRef: `origin/${branch}` }
    );
    const rebasedContentIdentityReferenceRows = await readCanonicalContentIdentityReferenceRows(
      rebasedSanitizedTargetedSnapshot,
      { baseRef: `origin/${branch}` }
    );
    const rebasedLoggedInAttributionReconciliationLedger =
      await readCanonicalLoggedInAttributionReconciliationLedger({ baseRef: `origin/${branch}` });
    const rebasedSeededAttributionReconciliationLedger =
      await readCanonicalSeededAttributionReconciliationLedger({ baseRef: `origin/${branch}` });
    const rebasedSanitizedPublicSnapshot = await prepareSanitizedPublicSnapshot(
      publicationInputs.publicSnapshots,
      {
        baseRef: `origin/${branch}`,
        contentIdentityReferenceRows: rebasedContentIdentityReferenceRows
      }
    );
    const rebasedPublicationInputs = {
      ...publicationInputs,
      sanitizedPublicSnapshot: rebasedSanitizedPublicSnapshot,
      sanitizedTargetedSnapshot: rebasedSanitizedTargetedSnapshot
    };
    const [rebasedBaseline, rebasedSourceDeltaHistory] = await Promise.all([
      readPublicationEvidenceBaseline({ baseRef: `origin/${branch}` }),
      readSourceDeltaHistory({ baseRef: `origin/${branch}` })
    ]);
    const retryDurableImport = await importDurableEvidence({
      publicSnapshots: [
        rebasedSanitizedPublicSnapshot,
        rebasedSanitizedTargetedSnapshot
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
    await mergePublicationInputs(rebasedPublicationInputs, { baseRef: `origin/${branch}` });
    rebasedPublicationInputs.sourceDelta = summarizeIngestionSourceDelta({
      idempotencyKey,
      beforeSnapshots: rebasedBaseline,
      afterSnapshots: await readPublicationEvidenceBaseline(),
      previousHistory: rebasedSourceDeltaHistory,
      mappedFailures: publicationInputs.sourceDelta?.mappedFailures ?? 0,
      collectionCoverage: publicationInputs.collectionCoverage,
      credentialGaps: publicationInputs.credentialGaps
    });
    await writeSourceDeltaReceipt(rebasedPublicationInputs.sourceDelta, rebasedSourceDeltaHistory);
    await buildAndValidatePublication(publicationRunId, publicationInputs.catalogState);
    if (run) await persistArtifactManifest(run.id);
    await stageRepositoryArtifacts();
    const rebuiltDiff = await runCommand("git", ["diff", "--cached", "--quiet"], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "check rebuilt artifacts",
      allowedExitCodes: [0, 1]
    });
    if (rebuiltDiff.code === 1) {
      await runCommand("git", ["commit", "--amend", "--no-edit"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitCommitMs,
        label: "amend rebuilt artifacts"
      });
    }
    await runCommand("git", ["push", "origin", `HEAD:${branch}`], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
      label: "retry refreshed artifact push"
    });
    publicationInputs.sourceDelta = rebasedPublicationInputs.sourceDelta;
  }
  const publishedCommit = (await runCommand("git", ["rev-parse", "HEAD"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "resolve published commit"
  })).stdout.trim();
  await runCommand("git", ["fetch", "origin", branch], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: "fetch published remote commit"
  });
  const remoteContainsPublication = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", publishedCommit, `origin/${branch}`],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "verify published commit ancestry",
      allowedExitCodes: [0, 1]
    }
  );
  if (remoteContainsPublication.code !== 0) {
    throw new Error(
      `Publication verification failed: remote ${branch} does not contain ${publishedCommit || "the local commit"}.`
    );
  }
  await event("publication.completed", "info", "Refreshed artifacts were committed and pushed.", {
    idempotencyKey,
    publicationRunId,
    branch,
    retriedAfterNonFastForward: firstPush.code !== 0,
    publishedPaths: repositoryArtifactPaths()
  });
  return { status: "published", publishedCommit };
}

async function stageRepositoryArtifacts() {
  await runCommand("git", [
    "add", "--",
    ...repositoryArtifactPaths()
  ], { timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitStageMs, label: "stage refreshed artifacts" });
}

function repositoryArtifactPaths() {
  return [
    "src/lib/yc/summer-2026-companies.json",
    "src/lib/yc/summer-2026-company-aliases.json",
    "public/graph",
    "public/timelines",
    "public/topic-facets",
    "src/lib/graph/ranked-posts-sidecar.generated.json",
    "artifacts/company-timeline/coverage.json",
    "artifacts/company-timeline/public-discovery-current.json",
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
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json",
    "src/lib/social/github-traction-quarantine.json"
  ];
}

async function refreshMutableYcCatalog() {
  const timeoutMs = runnerBudget.timeoutMs(
    AUTONOMOUS_PROCESS_BUDGETS.catalogRefreshMs,
    "official mutable YC catalog refresh"
  );
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/fetch-yc-spring-2026.mjs"], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"]
    });
    let killTimer = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(
        () => child.kill("SIGKILL"),
        AUTONOMOUS_PROCESS_BUDGETS.processKillGraceMs
      );
      killTimer.unref?.();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Official mutable YC catalog refresh failed with ${code ?? signal ?? "unknown status"}; ` +
          "refusing to plan against a stale roster."
        )
      );
    });
  });
}

function publicationBranch() {
  const branch = String(process.env.INGESTION_PUBLICATION_BRANCH ?? "main").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`Unsafe publication branch: ${branch || "empty"}.`);
  }
  return branch;
}

async function assertNoPublicationConflicts() {
  const conflicts = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "check publication conflicts"
  });
  if (conflicts.stdout.trim()) {
    throw new Error(`Publication rebase left unresolved conflicts: ${conflicts.stdout.trim()}`);
  }
}

async function abortPublicationRebase() {
  await runCommand("git", ["rebase", "--abort"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "abort failed publication rebase",
    allowedExitCodes: [0, 128]
  }).catch(() => {});
}

async function completeRun(status, stats) {
  if (status === "completed") {
    assertLeaseHealthy();
    const { data, error } = await supabase.rpc("finalize_completed_ingestion_run", {
      p_run_id: run.id,
      p_lease_owner: workerId,
      p_lease_token: run.lease_token,
      p_stats_json: stats
    });
    check(error, "atomically finalize completed ingestion run");
    const finalized = Array.isArray(data) ? data[0] ?? null : data;
    if (!finalized) throw new Error("The ingestion run lease was lost before atomic finalization.");
    run = finalized;
    return;
  }
  const finishedAt = new Date().toISOString();
  const { error } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      finished_at: finishedAt,
      heartbeat_at: finishedAt,
      lease_expires_at: null,
      lease_owner: null,
      lease_token: null,
      stats_json: stats,
      errors_json: status === "failed" ? [stats.error ?? "unknown failure"] : []
    })
    .eq("id", run.id);
  check(error, `mark ingestion run ${status}`);
}

async function runCommand(command, commandArgs, {
  timeoutMs,
  deadlineAt = null,
  label,
  env = {},
  allowedExitCodes = [0],
  quiet = false,
  captureLimit = 40_000
}) {
  assertLeaseHealthy();
  // Fail before event I/O when the runner is already exhausted, then recalculate
  // after that I/O so the child timeout still ends at the absolute deadline.
  runnerBudget.timeoutMs(timeoutMs, label);
  await event("command.started", "info", `${label} started.`, { command, args: commandArgs });
  const runnerRemainingMs = runnerBudget.timeoutMs(timeoutMs, label);
  const deadlineRemainingMs = deadlineAt === null
    ? runnerRemainingMs
    : Math.floor(deadlineAt - Date.now());
  if (deadlineRemainingMs <= 0) {
    throw new Error(`${label} did not start before its phase deadline.`);
  }
  const effectiveTimeoutMs = Math.min(timeoutMs, runnerRemainingMs, deadlineRemainingMs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(
        () => child.kill("SIGKILL"),
        AUTONOMOUS_PROCESS_BUDGETS.processKillGraceMs
      );
      killTimer.unref?.();
    }, effectiveTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = tail(`${stdout}${chunk}`, captureLimit);
      if (!quiet) process.stdout.write(`[${label}] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(`${stderr}${chunk}`, captureLimit);
      if (!quiet) process.stderr.write(`[${label}] ${chunk}`);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const payload = {
        code,
        signal,
        timedOut,
        timeoutMs: effectiveTimeoutMs,
        stdout,
        stderr
      };
      const eventPayload = { ...payload, stdout: tail(stdout, 40_000), stderr: tail(stderr, 40_000) };
      if (timedOut) {
        await event("command.failed", "error", `${label} timed out.`, eventPayload).catch(() => {});
        reject(new Error(`${label} timed out after ${effectiveTimeoutMs}ms.`));
        return;
      }
      if (code !== null && allowedExitCodes.includes(code)) {
        if (heartbeatFailure) {
          reject(new Error(`Ingestion lease heartbeat failed while ${label} was running.`));
          return;
        }
        await event("command.completed", "info", `${label} completed.`, eventPayload).catch(() => {});
        resolve(payload);
      } else {
        await event("command.failed", "error", `${label} failed.`, eventPayload).catch(() => {});
        reject(new Error(`${label} exited with ${code ?? signal ?? "unknown status"}.`));
      }
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
      notBefore: validation.notBefore ?? null
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
    new_physical_sources: normalized.newPhysicalSources ?? "",
    daily_new_physical_sources: normalized.dailyNewPhysicalSources ?? "",
    daily_source_health: normalized.dailySourceHealth ?? ""
  };
  await appendFile(
    githubOutput,
    `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8"
  );
}

async function readCommitBackedReplayReceipt() {
  const [currentReceipt, history] = await Promise.all([
    readJson(publishedSourceDeltaPath, null),
    readJson(publishedSourceDeltaHistoryPath, [])
  ]);
  return selectPublishedAutonomousIngestionReceipt({
    idempotencyKey,
    currentReceipt,
    history
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

async function selectMaybeSingle(query, operation) {
  const { data, error } = await query.maybeSingle();
  check(error, operation);
  return data ?? null;
}

async function selectSingle(query, operation) {
  const { data, error } = await query.single();
  check(error, operation);
  return data;
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

function parseArgs(rawArgs) {
  const value = (name) => rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  return {
    idempotencyKey: value("--idempotency-key"),
    campaignKey: value("--campaign-key"),
    plan: rawArgs.includes("--plan"),
    resumeSnapshots: rawArgs.includes("--resume-snapshots"),
    skipNetwork: rawArgs.includes("--skip-network"),
    skipPublish: rawArgs.includes("--skip-publish")
  };
}

function cleanEnv(value) {
  const trimmed = value?.trim();
  return trimmed || null;
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

function tail(value, limit) {
  return value.length > limit ? value.slice(-limit) : value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
