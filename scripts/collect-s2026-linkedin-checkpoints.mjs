import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readAuthenticatedLinkedInChunkAdmission,
  startAutonomousIngestionPowerWatchdog
} from "./lib/autonomous-ingestion-power-watchdog.mjs";
import {
  createSupabaseExpiringGlobalLeaseProvider,
  withLinkedInAccountLock
} from "./lib/logged-in-linkedin-collection.mjs";

export const S2026_CHECKPOINT_CAMPAIGN_KEY = "authenticated-social-history-v1";
export const S2026_CHECKPOINT_TARGET_CAP = 5;
export const S2026_CHECKPOINT_TARGET_DELAY_MS = 30_000;
export const S2026_CHECKPOINT_BATTERY_FLOOR_PERCENT = 5;
export const S2026_CHECKPOINT_BATTERY_MAX_CHUNKS = 4;
export const S2026_CHECKPOINT_AC_MAX_CHUNKS = 12;
export const S2026_CHECKPOINT_FINAL_PUBLICATION_MAX_REMAINING = 20;
export const S2026_CHECKPOINT_CHILD_TIMEOUT_MS = 60 * 60_000;
export const S2026_CHECKPOINT_RUN_DEADLINE_MS = 270 * 60_000;
export const S2026_CHECKPOINT_CHILD_ADMISSION_MS = 65 * 60_000;
export const S2026_CHECKPOINT_EXPECTED_INVENTORY = Object.freeze({
  batchSlug: "S2026",
  catalogCompanyCount: 197,
  companyCount: 197,
  founderCount: 396,
  targetCount: 568,
  quarantinedTargetCount: 4,
  collisionCount: 2,
  collisionTargetCount: 4,
  inventorySha256: "78fa2076a862d85e56a83fcbda588bbd3b4526cdb6c1ea1fb77093c73ab25a56",
  collisionSha256: "6914b5b2d04bdbc2cf5f0dbd10d2fee5ee60e463ca96daa2e2a9595d76bd5d45"
});
export const S26_CHECKPOINT_EXPECTED_INVENTORY = Object.freeze({
  batchSlug: "S26",
  catalogCompanyCount: 234,
  companyCount: 234,
  founderCount: 467,
  targetCount: 672,
  quarantinedTargetCount: 4,
  collisionCount: 2,
  collisionTargetCount: 4,
  inventorySha256: "3ea6464b0b025abdf8b526b260b7ea769b089f5a0ad8b30d0f9b3f9c15299182",
  collisionSha256: "1a8fd9092c9bf2ddd5789e49fda8795790baef84c2949a16fce6d20f579ff043"
});
export const LINKEDIN_CHECKPOINT_BATCH_CONTRACTS = Object.freeze({
  S26: S26_CHECKPOINT_EXPECTED_INVENTORY,
  S2026: S2026_CHECKPOINT_EXPECTED_INVENTORY
});

const CHECKPOINT_REPLAY_KEY_PATTERN =
  /^incident-20260913-(s26|s2026)-linkedin-backlog-(?!000)[0-9]{3}$/;
const LINKEDIN_GLOBAL_LOCK_NAMESPACE =
  "returner-fund-production-linkedin-allen-xu-v1";
const CHECKPOINT_CONTROLLER_LOCK_NAMESPACE =
  "returner-fund-production-linkedin-checkpoint-controller-v1";
const PLAN_CAPTURE_LIMIT = 16 * 1_024 * 1_024;
const PLAN_TIMEOUT_MS = 2 * 60_000;
const CHILD_TERMINATION_GRACE_MS = 6 * 60_000;
const SAFE_CHILD_ENV_KEYS = Object.freeze([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "GITHUB_ACTIONS",
  "HOME",
  "OPENCLI_BIN",
  "OPENCLI_CONFIG_DIR",
  "OPENCLI_HOME",
  "OPENCLI_PROFILE",
  "BROWSER_PROFILE_PATH",
  "CHROME_USER_DATA_DIR",
  "RETURNER_LINKEDIN_VIEWER_PROFILE",
  "LINKEDIN_GLOBAL_LOCK_NAMESPACE",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
]);

export function validateS2026CheckpointCollectionRequest(environment = process.env) {
  const values = {
    eventName: clean(environment.GITHUB_EVENT_NAME),
    runId: clean(environment.GITHUB_RUN_ID),
    runAttempt: clean(environment.GITHUB_RUN_ATTEMPT),
    candidateTrigger: clean(environment.CANDIDATE_TRIGGER),
    idempotencyKey: clean(environment.INGESTION_IDEMPOTENCY_KEY),
    authenticatedReplay: clean(environment.AUTHENTICATED_SOCIAL_REPLAY),
    scope: clean(environment.AUTHENTICATED_BACKFILL_SCOPE),
    batch: clean(environment.AUTHENTICATED_BACKFILL_BATCH),
    companySlug: clean(environment.AUTHENTICATED_BACKFILL_COMPANY_SLUG) ?? "",
    recoverLock: clean(environment.RECOVER_AUTHENTICATED_LINKEDIN_LOCK),
    checkpointOnly: clean(environment.INCIDENT_LINKEDIN_CHECKPOINT_ONLY),
    backlogBatteryOverride: clean(
      environment.INCIDENT_S2026_LINKEDIN_BACKLOG_BATTERY_OVERRIDE
    ),
    zenbuBatteryOverride: clean(environment.INCIDENT_ZENBU_BATTERY_OVERRIDE) ?? "false",
    watchdogFloor: clean(
      environment.AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT
    ),
    watchdogInterval: clean(
      environment.AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS
    ),
    sourceSha: clean(environment.SOURCE_SHA),
    expectedCheckpointSha256: clean(
      environment.INCIDENT_LINKEDIN_EXPECTED_CHECKPOINT_SHA256
    ),
    expectedRemainingRaw: clean(environment.INCIDENT_LINKEDIN_EXPECTED_REMAINING),
    globalLockNamespace: clean(environment.LINKEDIN_GLOBAL_LOCK_NAMESPACE),
    openCliHome: clean(environment.OPENCLI_HOME),
    supabaseUrl: clean(environment.NEXT_PUBLIC_SUPABASE_URL),
    supabaseServiceKey: clean(environment.SUPABASE_SERVICE_ROLE_KEY)
  };
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    values.eventName !== "workflow_dispatch" ||
    !/^[1-9][0-9]*$/.test(values.runId ?? "") ||
    values.runAttempt !== "1" ||
    values.candidateTrigger !== "manual-replay" ||
    values.authenticatedReplay !== "true" ||
    values.scope !== "linkedin" ||
    !LINKEDIN_CHECKPOINT_BATCH_CONTRACTS[values.batch] ||
    values.companySlug !== "" ||
    values.recoverLock !== "false" ||
    values.checkpointOnly !== "true" ||
    values.backlogBatteryOverride !== "true" ||
    values.zenbuBatteryOverride !== "false" ||
    values.watchdogFloor !== String(S2026_CHECKPOINT_BATTERY_FLOOR_PERCENT) ||
    values.watchdogInterval !== "30" ||
    values.globalLockNamespace !== LINKEDIN_GLOBAL_LOCK_NAMESPACE ||
    !CHECKPOINT_REPLAY_KEY_PATTERN.test(values.idempotencyKey ?? "") ||
    !values.idempotencyKey.includes(`-${values.batch.toLowerCase()}-`) ||
    !/^[0-9a-f]{40}$/.test(values.sourceSha ?? "") ||
    !/^[0-9a-f]{64}$/.test(values.expectedCheckpointSha256 ?? "") ||
    !/^(0|[1-9][0-9]{0,3})$/.test(values.expectedRemainingRaw ?? "") ||
    !values.openCliHome ||
    !values.supabaseUrl ||
    !values.supabaseServiceKey
  ) {
    throw new Error(
      "S2026 checkpoint collection is restricted to the exact first-attempt, " +
      "workflow-dispatch-only LinkedIn backlog incident contract."
    );
  }
  return Object.freeze({
    ...values,
    expectedRemaining: Number(values.expectedRemainingRaw)
  });
}

export function authenticatedSocialReplayRoot(openCliHome) {
  const campaignSegment = safePathSegment(S2026_CHECKPOINT_CAMPAIGN_KEY);
  return join(
    resolve(openCliHome),
    "returner-fund-autonomous-replay",
    campaignSegment
  );
}

export function buildS2026CollectorEnvironment(environment, scoringDataRoot) {
  const child = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (environment[key] !== undefined) child[key] = environment[key];
  }
  child.SCORING_DATA_ROOT = resolve(scoringDataRoot);
  child.NODE_OPTIONS = "--max-old-space-size=768";
  return child;
}

export function s2026CollectorArguments({
  batch = "S2026",
  checkpointPath,
  outputPath,
  plan = false,
  finalizeOnly = false
}) {
  if (plan && finalizeOnly) {
    throw new Error("S2026 collector plan and finalize-only modes cannot be combined.");
  }
  return [
    "scripts/fetch-logged-in-social-traction.mjs",
    `--batch=${batch}`,
    "--entities=all",
    "--limit=100",
    "--scrolls=30",
    "--timeout-ms=90000",
    `--output-path=${checkpointSafePath(outputPath, "output")}`,
    `--checkpoint-path=${checkpointSafePath(checkpointPath, "checkpoint")}`,
    "--workers=1",
    "--platforms=linkedin",
    "--allow-linkedin",
    "--linkedin-mode=browser",
    `--linkedin-max-targets=${S2026_CHECKPOINT_TARGET_CAP}`,
    `--delay-ms=${S2026_CHECKPOINT_TARGET_DELAY_MS}`,
    "--terminal-completed-platforms=linkedin",
    ...(plan ? ["--plan"] : []),
    ...(finalizeOnly ? ["--finalize-only"] : [])
  ];
}

export function assertS2026PlanContract(plan, expected = S2026_CHECKPOINT_EXPECTED_INVENTORY) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("S2026 LinkedIn plan must be an object.");
  }
  const execution = plan.linkedinExecution;
  const targets = Array.isArray(plan.targets) ? plan.targets : [];
  const runnableTargets = Array.isArray(plan.runnableTargets)
    ? plan.runnableTargets
    : [];
  const collisions = canonicalCollisions(plan.ownerAccountCollisions);
  const inventory = canonicalInventory(targets);
  const proof = Object.freeze({
    catalogCompanyCount: plan.catalogCompanyCount,
    companyCount: plan.companyCount,
    founderCount: plan.founderCount,
    targetCount: targets.length,
    quarantinedTargetCount: plan.quarantinedTargetCount,
    collisionCount: collisions.length,
    collisionTargetCount: collisions.reduce(
      (total, collision) => total + collision.targets.length,
      0
    ),
    inventorySha256: sha256(JSON.stringify(inventory)),
    collisionSha256: sha256(JSON.stringify(collisions))
  });
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (field === "batchSlug") continue;
    if (proof[field] !== expectedValue) {
      throw new Error(
        `S2026 LinkedIn ${field} drifted: expected ${expectedValue}, received ${proof[field]}.`
      );
    }
  }
  const remaining = execution?.remainingTargetCount;
  const selected = execution?.selectedForThisInvocationCount;
  if (
    plan.batchSlug !== expected.batchSlug ||
    plan.requestedTarget !== null ||
    plan.linkedinCollectionMode !== "browser" ||
    execution?.workers !== 1 ||
    execution?.serial !== true ||
    execution?.persistentHostPacing !== true ||
    execution?.delayMs !== S2026_CHECKPOINT_TARGET_DELAY_MS ||
    execution?.targetCap !== S2026_CHECKPOINT_TARGET_CAP ||
    execution?.maximumTargetCap !== S2026_CHECKPOINT_TARGET_CAP ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    remaining > expected.targetCount ||
    plan.remainingTargetCount !== remaining ||
    !Number.isSafeInteger(selected) ||
    selected < 0 ||
    selected > S2026_CHECKPOINT_TARGET_CAP ||
    selected !== Math.min(S2026_CHECKPOINT_TARGET_CAP, remaining) ||
    plan.selectedForThisInvocationCount !== selected ||
    plan.runnableTargetCount !== selected ||
    runnableTargets.length !== selected ||
    runnableTargets.some((target) => target?.platform !== "linkedin")
  ) {
    throw new Error("S2026 LinkedIn plan no longer satisfies the serial five-target contract.");
  }
  const inventoryKeys = new Set(inventory.map((target) => target.checkpointKey));
  if (
    inventoryKeys.size !== expected.targetCount ||
    runnableTargets.some((target) => !inventoryKeys.has(target?.checkpointKey))
  ) {
    throw new Error("S2026 LinkedIn runnable targets are not a subset of the exact inventory.");
  }
  return Object.freeze({
    proof,
    remaining,
    selected,
    selectedKeys: runnableTargets.map((target) => target.checkpointKey),
    collisionKeys: new Set(
      collisions.flatMap((collision) =>
        collision.targets.map((target) => target.checkpointKey)
      )
    )
  });
}

export function verifyS2026CheckpointDelta({
  beforeCheckpoint,
  afterCheckpoint,
  beforePlan,
  afterPlan
}) {
  const before = beforeCheckpoint?.attempts ?? {};
  const after = afterCheckpoint?.attempts ?? {};
  if (!plainObject(before) || !plainObject(after)) {
    throw new Error("S2026 checkpoint attempts must be objects.");
  }
  const selected = new Set(beforePlan.selectedKeys);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const unexpected = changed.filter((key) => !selected.has(key));
  if (unexpected.length > 0) {
    throw new Error("Checkpoint changed outside the selected targets and collision quarantine.");
  }
  const changedSelected = changed.filter((key) => selected.has(key));
  const nonDone = changedSelected.filter((key) => after[key]?.status !== "done");
  if (nonDone.length > 0) {
    throw new Error("A changed selected checkpoint attempt was not terminally done.");
  }
  const completedKeys = changedSelected.filter(
    (key) => before[key]?.status !== "done" && after[key]?.status === "done"
  );
  const remainingDecrease = beforePlan.remaining - afterPlan.remaining;
  if (
    completedKeys.length < 1 ||
    completedKeys.length > S2026_CHECKPOINT_TARGET_CAP ||
    remainingDecrease !== completedKeys.length
  ) {
    throw new Error("Checkpoint progress was not an exact one-to-five target decrease.");
  }
  return Object.freeze({
    completedCount: completedKeys.length,
    completedKeysSha256: sha256([...completedKeys].sort().join("\n")),
    changedAttemptCount: changed.length
  });
}

export function checkpointChunkLimit(
  powerAdmission,
  chunksCompleted,
  { batteryEverAdmitted = false } = {}
) {
  if (powerAdmission?.admitted !== true || powerAdmission?.fullWake !== true) {
    throw new Error(
      `LinkedIn checkpoint child power admission failed: ${powerAdmission?.reason ?? "unverified"}.`
    );
  }
  const batteryRestricted = batteryEverAdmitted || powerAdmission.externalConnected !== true;
  const maximum = batteryRestricted
    ? S2026_CHECKPOINT_BATTERY_MAX_CHUNKS
    : S2026_CHECKPOINT_AC_MAX_CHUNKS;
  return Object.freeze({
    maximum,
    admitted: chunksCompleted < maximum,
    powerMode: powerAdmission.externalConnected === true ? "ac" : "battery",
    batteryRestricted
  });
}

export async function runS2026CheckpointCollection({
  environment = process.env,
  cwd = process.cwd(),
  now = Date.now,
  readPlan,
  runCollector,
  finalizeOutput,
  readArtifact = readJsonArtifact,
  hashArtifact = hashJsonArtifact,
  assertPinnedMain,
  readPowerAdmission,
  startWatchdog,
  withControllerLock,
  expectedInventory
} = {}) {
  const request = validateS2026CheckpointCollectionRequest(environment);
  const inventoryContract = expectedInventory ??
    LINKEDIN_CHECKPOINT_BATCH_CONTRACTS[request.batch];
  if (request.expectedRemaining > inventoryContract.targetCount) {
    throw new Error("Expected LinkedIn remainder exceeds the pinned batch inventory.");
  }
  const root = resolve(cwd);
  const stateRoot = authenticatedSocialReplayRoot(request.openCliHome);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await assertDurableStateRoot(request.openCliHome, stateRoot);
  const batchPathSegment = request.batch.toLowerCase();
  const checkpointPath = join(
    stateRoot,
    `logged-in-checkpoint-${batchPathSegment}.json`
  );
  const outputPath = join(stateRoot, `logged-in-${batchPathSegment}.json`);
  await assertRegularOrMissing(checkpointPath);
  await assertRegularOrMissing(outputPath);

  const childEnvironment = buildS2026CollectorEnvironment(environment, root);
  const planReader = readPlan ?? (() => defaultReadPlan({
    cwd: root,
    batch: request.batch,
    checkpointPath,
    outputPath,
    environment: childEnvironment
  }));
  const collector = runCollector ?? (({ signal }) => defaultRunCollector({
    cwd: root,
    batch: request.batch,
    checkpointPath,
    outputPath,
    environment: childEnvironment,
    signal
  }));
  const outputFinalizer = finalizeOutput ?? (({ signal }) => defaultFinalizeOutput({
    cwd: root,
    batch: request.batch,
    checkpointPath,
    outputPath,
    environment: childEnvironment,
    signal
  }));
  const sourceGuard = assertPinnedMain ?? (() => defaultAssertPinnedMain({
    cwd: root,
    sourceSha: request.sourceSha
  }));
  const powerReader = readPowerAdmission ?? (() =>
    readAuthenticatedLinkedInChunkAdmission({
      floorPercent: S2026_CHECKPOINT_BATTERY_FLOOR_PERCENT
    }));
  const watchdogFactory = startWatchdog ?? ((onLowReserve) =>
    startAutonomousIngestionPowerWatchdog({ environment, onLowReserve }));
  const controllerLock = withControllerLock ?? ((operation) =>
    defaultWithControllerLock({
      operation,
      environment,
      stateRoot
    }));

  return controllerLock(async (controllerGuard = {}) => {
  const startedAtMs = now();
  const deadlineAtMs = startedAtMs + S2026_CHECKPOINT_RUN_DEADLINE_MS;
  const abortController = new AbortController();
  let safetyStop = null;
  const stop = (reason) => {
    if (abortController.signal.aborted) return;
    safetyStop = reason ?? { reason: "checkpoint_controller_terminated" };
    abortController.abort(new Error(safetyStop.reason ?? "checkpoint controller stopped"));
  };
  const sigterm = () => stop({ reason: "checkpoint_controller_sigterm" });
  const sigint = () => stop({ reason: "checkpoint_controller_sigint" });
  const durableLeaseAbort = () => stop({
    reason: "checkpoint_controller_durable_lease_unhealthy"
  });
  process.once("SIGTERM", sigterm);
  process.once("SIGINT", sigint);
  controllerGuard.signal?.addEventListener("abort", durableLeaseAbort, { once: true });
  const watchdog = watchdogFactory(stop);

  try {
    await sourceGuard();
    controllerGuard.assertHealthy?.();
    let initialCheckpoint = await readArtifact(checkpointPath, { attempts: {} });
    let beforeCheckpointSha256 = await hashArtifact(checkpointPath);
    let beforeOutputSha256 = await hashArtifact(outputPath);
    let plan = assertS2026PlanContract(await planReader(), inventoryContract);
    const stateDirectory = join(stateRoot, "checkpoint-collection-runs");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await assertDurableStateRoot(request.openCliHome, stateDirectory);
    const statePath = join(
      stateDirectory,
      `${request.idempotencyKey}.json`
    );
    await assertRegularOrMissing(statePath);
    let runState = await readArtifact(statePath, null);
    if (runState?.status === "completed") {
      assertCompletedRunState(runState, request);
      if (
        beforeCheckpointSha256 !== runState.currentCheckpointSha256 ||
        beforeOutputSha256 !== runState.currentOutputSha256 ||
        plan.remaining !== runState.currentRemaining
      ) {
        throw new Error(
          "Completed checkpoint collection state no longer matches the live checkpoint, output, and plan."
        );
      }
      return { receipt: runState.receipt, checkpointPath, outputPath };
    }
    if (runState === null) {
      if (
        beforeCheckpointSha256 !== request.expectedCheckpointSha256 ||
        plan.remaining !== request.expectedRemaining
      ) {
        throw new Error(
          "S2026 LinkedIn checkpoint changed after dispatch; refusing a stale collection plan."
        );
      }
      if (plan.remaining <= S2026_CHECKPOINT_FINAL_PUBLICATION_MAX_REMAINING) {
        throw new Error(
          "S2026 LinkedIn checkpoint debt is already within the final publication bound."
        );
      }
      runState = {
        schemaVersion: 1,
        kind: "s2026_linkedin_checkpoint_collection_state",
        status: "running",
        idempotencyKey: request.idempotencyKey,
        sourceSha: request.sourceSha,
        expectedCheckpointSha256: request.expectedCheckpointSha256,
        expectedRemaining: request.expectedRemaining,
        beforeRemaining: plan.remaining,
        beforeCheckpointSha256,
        beforeOutputSha256,
        currentRemaining: plan.remaining,
        currentCheckpointSha256: beforeCheckpointSha256,
        currentOutputSha256: beforeOutputSha256,
        completedTargets: 0,
        chunksCompleted: 0,
        batteryChunks: 0,
        acChunks: 0,
        chunkReceipts: [],
        intent: null,
        startedAt: new Date(startedAtMs).toISOString()
      };
      await writeJsonAtomic(statePath, runState);
    } else {
      assertRunningState(runState, request);
      if (runState.intent) {
        const currentCheckpointSha256 = await hashArtifact(checkpointPath);
        if (currentCheckpointSha256 !== runState.intent.checkpointSha256Before) {
          const finalized = await outputFinalizer({ signal: abortController.signal });
          if (finalized?.terminated || finalized?.exitCode !== 0) {
            throw new Error("Could not rebuild output from a partially advanced checkpoint.");
          }
          await sourceGuard();
          const recoveredCheckpoint = await readArtifact(checkpointPath);
          const recoveredOutput = await readArtifact(outputPath);
          assertCheckpointOutputConsistency(recoveredCheckpoint, recoveredOutput);
          const recoveredPlan = assertS2026PlanContract(
            await planReader(),
            inventoryContract
          );
          const intentPlan = {
            remaining: runState.intent.beforeRemaining,
            selectedKeys: runState.intent.selectedKeys,
            collisionKeys: new Set()
          };
          const recoveredDelta = verifyS2026CheckpointDelta({
            beforeCheckpoint: { attempts: runState.intent.beforeAttempts },
            afterCheckpoint: recoveredCheckpoint,
            beforePlan: intentPlan,
            afterPlan: recoveredPlan
          });
          const recoveredCheckpointSha256 = await hashArtifact(checkpointPath);
          const recoveredOutputSha256 = await hashArtifact(outputPath);
          applyRecoveredChunk(runState, {
            delta: recoveredDelta,
            plan: recoveredPlan,
            checkpointSha256: recoveredCheckpointSha256,
            outputSha256: recoveredOutputSha256
          });
          await writeJsonAtomic(statePath, runState);
          initialCheckpoint = recoveredCheckpoint;
          plan = recoveredPlan;
        } else {
          if (
            plan.remaining !== runState.intent.beforeRemaining ||
            JSON.stringify(plan.selectedKeys) !== JSON.stringify(runState.intent.selectedKeys)
          ) {
            throw new Error("Pending checkpoint intent no longer matches its exact target plan.");
          }
          runState.intent = null;
          await writeJsonAtomic(statePath, runState);
        }
      }
      const currentCheckpointSha256 = await hashArtifact(checkpointPath);
      const currentOutputSha256 = await hashArtifact(outputPath);
      if (
        currentCheckpointSha256 !== runState.currentCheckpointSha256 ||
        currentOutputSha256 !== runState.currentOutputSha256 ||
        plan.remaining !== runState.currentRemaining
      ) {
        throw new Error("Checkpoint state changed outside its durable per-key controller intent.");
      }
      initialCheckpoint = await readArtifact(checkpointPath, { attempts: {} });
      beforeCheckpointSha256 = runState.beforeCheckpointSha256;
      beforeOutputSha256 = runState.beforeOutputSha256;
    }
    const beforeRemaining = runState.beforeRemaining;
    if (plan.remaining <= S2026_CHECKPOINT_FINAL_PUBLICATION_MAX_REMAINING && runState.completedTargets < 1) {
      throw new Error(
        "S2026 LinkedIn checkpoint debt is already within the final publication bound."
      );
    }

    let previousCheckpoint = initialCheckpoint;
    let chunksCompleted = runState.chunksCompleted;
    let completedTargets = runState.completedTargets;
    let batteryChunks = runState.batteryChunks;
    let acChunks = runState.acChunks;
    let stopReason = null;
    const chunkReceipts = [...runState.chunkReceipts];

    while (plan.remaining > S2026_CHECKPOINT_FINAL_PUBLICATION_MAX_REMAINING) {
      if (abortController.signal.aborted) {
        throw new Error(`Checkpoint controller safety-stopped: ${safetyStop?.reason ?? "unknown"}.`);
      }
      if (chunksCompleted >= S2026_CHECKPOINT_AC_MAX_CHUNKS) {
        stopReason = "absolute_chunk_cap";
        break;
      }
      if (deadlineAtMs - now() < S2026_CHECKPOINT_CHILD_ADMISSION_MS) {
        stopReason = "deadline_reserve";
        break;
      }

      const powerAdmission = await powerReader();
      const powerLimit = checkpointChunkLimit(powerAdmission, chunksCompleted, {
        batteryEverAdmitted: batteryChunks > 0
      });
      if (!powerLimit.admitted) {
        stopReason = powerLimit.batteryRestricted
          ? "battery_chunk_cap"
          : "absolute_chunk_cap";
        break;
      }
      await sourceGuard();
      controllerGuard.assertHealthy?.();
      const checkpointShaBeforeChunk = await hashArtifact(checkpointPath);
      const outputShaBeforeChunk = await hashArtifact(outputPath);
      const beforeChunkRemaining = plan.remaining;
      runState.intent = {
        chunkNumber: chunksCompleted + 1,
        powerMode: powerLimit.powerMode,
        beforeRemaining: beforeChunkRemaining,
        selectedKeys: [...plan.selectedKeys],
        beforeAttempts: structuredClone(previousCheckpoint?.attempts ?? {}),
        checkpointSha256Before: checkpointShaBeforeChunk,
        outputSha256Before: outputShaBeforeChunk
      };
      await writeJsonAtomic(statePath, runState);
      const result = await collector({ signal: abortController.signal });
      if (result?.terminated || result?.exitCode !== 0) {
        const kind = result?.exitCode === 86
          ? "account safety stop"
          : "collector failure";
        throw new Error(`S2026 LinkedIn ${kind}; checkpoint retained.`);
      }
      if (abortController.signal.aborted) {
        throw new Error(`Checkpoint controller safety-stopped: ${safetyStop?.reason ?? "unknown"}.`);
      }
      await sourceGuard();
      controllerGuard.assertHealthy?.();
      await assertRegularOrMissing(checkpointPath, { missingAllowed: false });
      await assertRegularOrMissing(outputPath, { missingAllowed: false });
      const afterCheckpoint = await readArtifact(checkpointPath);
      const afterOutput = await readArtifact(outputPath);
      const checkpointShaAfterChunk = await hashArtifact(checkpointPath);
      const outputShaAfterChunk = await hashArtifact(outputPath);
      if (
        !checkpointShaAfterChunk ||
        checkpointShaAfterChunk === checkpointShaBeforeChunk ||
        !outputShaAfterChunk ||
        outputShaAfterChunk === outputShaBeforeChunk
      ) {
        throw new Error("S2026 LinkedIn checkpoint/output hashes did not both advance.");
      }
      assertCheckpointOutputConsistency(afterCheckpoint, afterOutput);
      const nextPlan = assertS2026PlanContract(await planReader(), inventoryContract);
      if (
        nextPlan.proof.inventorySha256 !== plan.proof.inventorySha256 ||
        nextPlan.proof.collisionSha256 !== plan.proof.collisionSha256
      ) {
        throw new Error("S2026 LinkedIn inventory or collision proof changed after a child.");
      }
      const delta = verifyS2026CheckpointDelta({
        beforeCheckpoint: previousCheckpoint,
        afterCheckpoint,
        beforePlan: plan,
        afterPlan: nextPlan
      });
      chunksCompleted += 1;
      completedTargets += delta.completedCount;
      if (powerLimit.powerMode === "ac") acChunks += 1;
      else batteryChunks += 1;
      chunkReceipts.push(Object.freeze({
        chunkNumber: chunksCompleted,
        powerMode: powerLimit.powerMode,
        beforeRemaining: beforeChunkRemaining,
        afterRemaining: nextPlan.remaining,
        completedTargets: delta.completedCount,
        completedKeysSha256: delta.completedKeysSha256,
        checkpointSha256Before: checkpointShaBeforeChunk,
        checkpointSha256After: checkpointShaAfterChunk,
        outputSha256Before: outputShaBeforeChunk,
        outputSha256After: outputShaAfterChunk
      }));
      runState = {
        ...runState,
        currentRemaining: nextPlan.remaining,
        currentCheckpointSha256: checkpointShaAfterChunk,
        currentOutputSha256: outputShaAfterChunk,
        completedTargets,
        chunksCompleted,
        batteryChunks,
        acChunks,
        chunkReceipts: [...chunkReceipts],
        intent: null
      };
      await writeJsonAtomic(statePath, runState);
      previousCheckpoint = afterCheckpoint;
      plan = nextPlan;
    }

    if (chunksCompleted < 1 || completedTargets < 1) {
      throw new Error("S2026 LinkedIn checkpoint lane completed no targets.");
    }
    await sourceGuard();
    controllerGuard.assertHealthy?.();
    const afterCheckpointSha256 = await hashArtifact(checkpointPath);
    const afterOutputSha256 = await hashArtifact(outputPath);
    const receipt = Object.freeze({
      schemaVersion: 1,
      kind: "s2026_linkedin_checkpoint_collection",
      status: "checkpoint_collection_completed",
      publicationDeferred: true,
      request: {
        idempotencyKey: request.idempotencyKey,
        sourceSha: request.sourceSha,
        runId: request.runId,
        runAttempt: request.runAttempt,
        eventName: request.eventName,
        scope: request.scope,
        batch: request.batch,
        expectedCheckpointSha256: request.expectedCheckpointSha256,
        expectedRemaining: request.expectedRemaining
      },
      safety: {
        serial: true,
        workers: 1,
        targetCapPerChild: S2026_CHECKPOINT_TARGET_CAP,
        targetDelayMs: S2026_CHECKPOINT_TARGET_DELAY_MS,
        scrollPassesPerTarget: 30,
        postLimitPerTarget: 100,
        batteryFloorPercent: S2026_CHECKPOINT_BATTERY_FLOOR_PERCENT,
        batteryComparison: "strictly_greater_than",
        batteryMaxChunks: S2026_CHECKPOINT_BATTERY_MAX_CHUNKS,
        acMaxChunks: S2026_CHECKPOINT_AC_MAX_CHUNKS,
        globalLockNamespace: LINKEDIN_GLOBAL_LOCK_NAMESPACE,
        controllerLockNamespace: CHECKPOINT_CONTROLLER_LOCK_NAMESPACE,
        fullWakeAdmissionPerChild: true,
        powerAndLidWatchdog: true
      },
      inventory: plan.proof,
      progress: {
        beforeRemaining,
        afterRemaining: plan.remaining,
        completedTargets,
        chunksCompleted,
        batteryChunks,
        acChunks,
        stopReason: stopReason ?? (
          plan.remaining <= S2026_CHECKPOINT_FINAL_PUBLICATION_MAX_REMAINING
            ? "final_publication_ready"
            : "completed"
        ),
        finalPublicationReady:
          plan.remaining <= S2026_CHECKPOINT_FINAL_PUBLICATION_MAX_REMAINING,
        finalPublicationMaximumRemaining:
          S2026_CHECKPOINT_FINAL_PUBLICATION_MAX_REMAINING
      },
      artifacts: {
        checkpointSha256Before: beforeCheckpointSha256,
        checkpointSha256After: afterCheckpointSha256,
        outputSha256Before: beforeOutputSha256,
        outputSha256After: afterOutputSha256
      },
      chunks: chunkReceipts,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(now()).toISOString()
    });
    await writeJsonAtomic(statePath, {
      ...runState,
      status: "completed",
      currentRemaining: plan.remaining,
      currentCheckpointSha256: afterCheckpointSha256,
      currentOutputSha256: afterOutputSha256,
      completedTargets,
      chunksCompleted,
      batteryChunks,
      acChunks,
      chunkReceipts: [...chunkReceipts],
      intent: null,
      receipt
    });
    return { receipt, checkpointPath, outputPath };
  } finally {
    await watchdog?.stop?.();
    process.removeListener("SIGTERM", sigterm);
    process.removeListener("SIGINT", sigint);
    controllerGuard.signal?.removeEventListener("abort", durableLeaseAbort);
  }
  });
}

export async function main(environment = process.env) {
  const { receipt } = await runS2026CheckpointCollection({ environment });
  const receiptDirectory = join(
    clean(environment.RUNNER_TEMP) ?? resolve("work"),
    "s2026-linkedin-checkpoint-collection"
  );
  const receiptPath = join(receiptDirectory, "receipt.json");
  await writeJsonAtomic(receiptPath, receipt);
  const receiptSha256 = await hashJsonArtifact(receiptPath);
  await writeGithubOutputs(environment.GITHUB_OUTPUT, {
    checkpoint_only: "true",
    batch: receipt.request.batch,
    runner_status: receipt.status,
    receipt_path: receiptPath,
    receipt_sha256: receiptSha256,
    source_sha: receipt.request.sourceSha,
    before_remaining: receipt.progress.beforeRemaining,
    after_remaining: receipt.progress.afterRemaining,
    completed_targets: receipt.progress.completedTargets,
    chunks_completed: receipt.progress.chunksCompleted,
    battery_chunks: receipt.progress.batteryChunks,
    ac_chunks: receipt.progress.acChunks,
    final_publication_ready: receipt.progress.finalPublicationReady,
    checkpoint_sha256_before: receipt.artifacts.checkpointSha256Before ?? "",
    checkpoint_sha256_after: receipt.artifacts.checkpointSha256After,
    output_sha256_before: receipt.artifacts.outputSha256Before ?? "",
    output_sha256_after: receipt.artifacts.outputSha256After,
    inventory_sha256: receipt.inventory.inventorySha256,
    collision_sha256: receipt.inventory.collisionSha256
  });
  console.log(
    `${receipt.request.batch} LinkedIn checkpoint collection completed ` +
    `${receipt.progress.completedTargets} ` +
    `target(s) in ${receipt.progress.chunksCompleted} chunk(s); ` +
    `${receipt.progress.afterRemaining} remain.`
  );
}

async function defaultReadPlan({
  cwd,
  batch,
  checkpointPath,
  outputPath,
  environment
}) {
  const result = await executeChild({
    args: s2026CollectorArguments({
      batch,
      checkpointPath,
      outputPath,
      plan: true
    }),
    cwd,
    environment,
    timeoutMs: PLAN_TIMEOUT_MS,
    capture: true
  });
  if (result.exitCode !== 0 || result.stdoutTruncated) {
    throw new Error("S2026 LinkedIn plan child failed or returned truncated output.");
  }
  const objectStart = result.stdout.indexOf("{");
  if (objectStart < 0) throw new Error("S2026 LinkedIn plan child returned no JSON object.");
  return JSON.parse(result.stdout.slice(objectStart));
}

async function defaultRunCollector({
  cwd,
  batch,
  checkpointPath,
  outputPath,
  environment,
  signal
}) {
  return executeChild({
    args: s2026CollectorArguments({ batch, checkpointPath, outputPath }),
    cwd,
    environment,
    timeoutMs: S2026_CHECKPOINT_CHILD_TIMEOUT_MS,
    signal,
    capture: false
  });
}

async function defaultFinalizeOutput({
  cwd,
  batch,
  checkpointPath,
  outputPath,
  environment,
  signal
}) {
  return executeChild({
    args: s2026CollectorArguments({
      checkpointPath,
      outputPath,
      batch,
      finalizeOnly: true
    }),
    cwd,
    environment,
    timeoutMs: PLAN_TIMEOUT_MS,
    signal,
    capture: false
  });
}

async function defaultWithControllerLock({ operation, environment, stateRoot }) {
  const client = createClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      },
      global: {
        headers: { "X-Client-Info": "returner-s2026-linkedin-checkpoint-controller" }
      }
    }
  );
  return withLinkedInAccountLock(operation, {
    lockPath: join(stateRoot, "s2026-linkedin-checkpoint-controller.lock"),
    globalLeaseProvider: createSupabaseExpiringGlobalLeaseProvider(client),
    globalLockNamespace: CHECKPOINT_CONTROLLER_LOCK_NAMESPACE
  });
}

function assertRunStateIdentity(runState, request) {
  if (
    !plainObject(runState) ||
    runState.schemaVersion !== 1 ||
    runState.kind !== "s2026_linkedin_checkpoint_collection_state" ||
    runState.idempotencyKey !== request.idempotencyKey ||
    runState.sourceSha !== request.sourceSha ||
    runState.expectedCheckpointSha256 !== request.expectedCheckpointSha256 ||
    runState.expectedRemaining !== request.expectedRemaining
  ) {
    throw new Error("Durable checkpoint collection state identity did not match this request.");
  }
}

function assertRunningState(runState, request) {
  assertRunStateIdentity(runState, request);
  if (
    runState.status !== "running" ||
    !Number.isSafeInteger(runState.beforeRemaining) ||
    !Number.isSafeInteger(runState.currentRemaining) ||
    !Number.isSafeInteger(runState.completedTargets) ||
    !Number.isSafeInteger(runState.chunksCompleted) ||
    !Number.isSafeInteger(runState.batteryChunks) ||
    !Number.isSafeInteger(runState.acChunks) ||
    runState.beforeRemaining < runState.currentRemaining ||
    runState.currentRemaining < 0 ||
    runState.completedTargets !== runState.beforeRemaining - runState.currentRemaining ||
    runState.completedTargets < 0 ||
    runState.chunksCompleted < 0 ||
    runState.chunksCompleted > S2026_CHECKPOINT_AC_MAX_CHUNKS ||
    runState.batteryChunks < 0 ||
    runState.batteryChunks > S2026_CHECKPOINT_BATTERY_MAX_CHUNKS ||
    runState.acChunks < 0 ||
    runState.batteryChunks + runState.acChunks !== runState.chunksCompleted ||
    !Array.isArray(runState.chunkReceipts) ||
    runState.chunkReceipts.length !== runState.chunksCompleted ||
    !hashOrNull(runState.beforeCheckpointSha256) ||
    !hashOrNull(runState.beforeOutputSha256) ||
    !hashOrNull(runState.currentCheckpointSha256) ||
    !hashOrNull(runState.currentOutputSha256)
  ) {
    throw new Error("Durable checkpoint collection state was malformed or inconsistent.");
  }
  assertChunkReceipts(runState.chunkReceipts, runState);
  if (runState.intent !== null) assertPendingIntent(runState.intent, runState);
}

function assertCompletedRunState(runState, request) {
  assertRunStateIdentity(runState, request);
  if (runState.status !== "completed" || !plainObject(runState.receipt)) {
    throw new Error("Durable completed checkpoint state was malformed.");
  }
  const receipt = runState.receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "s2026_linkedin_checkpoint_collection" ||
    receipt.status !== "checkpoint_collection_completed" ||
    receipt.publicationDeferred !== true ||
    receipt.request?.idempotencyKey !== request.idempotencyKey ||
    receipt.request?.sourceSha !== request.sourceSha ||
    receipt.progress?.beforeRemaining !== runState.beforeRemaining ||
    receipt.progress?.afterRemaining !== runState.currentRemaining ||
    receipt.progress?.completedTargets !== runState.completedTargets ||
    receipt.progress?.chunksCompleted !== runState.chunksCompleted ||
    receipt.artifacts?.checkpointSha256After !== runState.currentCheckpointSha256 ||
    receipt.artifacts?.outputSha256After !== runState.currentOutputSha256 ||
    JSON.stringify(receipt.chunks) !== JSON.stringify(runState.chunkReceipts)
  ) {
    throw new Error("Durable completed checkpoint receipt did not match its sealed state.");
  }
  assertRunningState({ ...runState, status: "running", receipt: undefined }, request);
}

function assertPendingIntent(intent, runState) {
  if (
    !plainObject(intent) ||
    intent.chunkNumber !== runState.chunksCompleted + 1 ||
    !["ac", "battery"].includes(intent.powerMode) ||
    intent.beforeRemaining !== runState.currentRemaining ||
    !Array.isArray(intent.selectedKeys) ||
    intent.selectedKeys.length < 1 ||
    intent.selectedKeys.length > S2026_CHECKPOINT_TARGET_CAP ||
    new Set(intent.selectedKeys).size !== intent.selectedKeys.length ||
    !plainObject(intent.beforeAttempts) ||
    intent.checkpointSha256Before !== runState.currentCheckpointSha256 ||
    intent.outputSha256Before !== runState.currentOutputSha256
  ) {
    throw new Error("Durable checkpoint child intent was malformed or inconsistent.");
  }
}

function assertChunkReceipts(receipts, state) {
  let remaining = state.beforeRemaining;
  let completedTargets = 0;
  let batteryChunks = 0;
  let acChunks = 0;
  let checkpointSha256 = state.beforeCheckpointSha256;
  let outputSha256 = state.beforeOutputSha256;
  for (const [index, receipt] of receipts.entries()) {
    if (
      !plainObject(receipt) ||
      receipt.chunkNumber !== index + 1 ||
      !["ac", "battery"].includes(receipt.powerMode) ||
      receipt.beforeRemaining !== remaining ||
      receipt.checkpointSha256Before !== checkpointSha256 ||
      receipt.outputSha256Before !== outputSha256 ||
      !Number.isSafeInteger(receipt.completedTargets) ||
      receipt.completedTargets < 1 ||
      receipt.completedTargets > S2026_CHECKPOINT_TARGET_CAP ||
      receipt.afterRemaining !== receipt.beforeRemaining - receipt.completedTargets ||
      !isSha256(receipt.completedKeysSha256) ||
      !isSha256(receipt.checkpointSha256After) ||
      !isSha256(receipt.outputSha256After) ||
      !hashOrNull(receipt.checkpointSha256Before) ||
      !hashOrNull(receipt.outputSha256Before)
    ) {
      throw new Error("Durable checkpoint chunk receipt was malformed or inconsistent.");
    }
    remaining = receipt.afterRemaining;
    checkpointSha256 = receipt.checkpointSha256After;
    outputSha256 = receipt.outputSha256After;
    completedTargets += receipt.completedTargets;
    if (receipt.powerMode === "battery") batteryChunks += 1;
    else acChunks += 1;
  }
  if (
    remaining !== state.currentRemaining ||
    checkpointSha256 !== state.currentCheckpointSha256 ||
    outputSha256 !== state.currentOutputSha256 ||
    completedTargets !== state.completedTargets ||
    batteryChunks !== state.batteryChunks ||
    acChunks !== state.acChunks
  ) {
    throw new Error("Durable checkpoint chunk receipt chain did not match controller state.");
  }
}

function applyRecoveredChunk(runState, {
  delta,
  plan,
  checkpointSha256,
  outputSha256
}) {
  assertRunningState(runState, {
    idempotencyKey: runState.idempotencyKey,
    sourceSha: runState.sourceSha,
    expectedCheckpointSha256: runState.expectedCheckpointSha256,
    expectedRemaining: runState.expectedRemaining
  });
  const intent = runState.intent;
  const receipt = {
    chunkNumber: intent.chunkNumber,
    powerMode: intent.powerMode,
    recoveredFromDurableIntent: true,
    beforeRemaining: intent.beforeRemaining,
    afterRemaining: plan.remaining,
    completedTargets: delta.completedCount,
    completedKeysSha256: delta.completedKeysSha256,
    checkpointSha256Before: intent.checkpointSha256Before,
    checkpointSha256After: checkpointSha256,
    outputSha256Before: intent.outputSha256Before,
    outputSha256After: outputSha256
  };
  runState.currentRemaining = plan.remaining;
  runState.currentCheckpointSha256 = checkpointSha256;
  runState.currentOutputSha256 = outputSha256;
  runState.completedTargets += delta.completedCount;
  runState.chunksCompleted += 1;
  if (intent.powerMode === "battery") runState.batteryChunks += 1;
  else runState.acChunks += 1;
  runState.chunkReceipts = [...runState.chunkReceipts, receipt];
  runState.intent = null;
  assertRunningState(runState, {
    idempotencyKey: runState.idempotencyKey,
    sourceSha: runState.sourceSha,
    expectedCheckpointSha256: runState.expectedCheckpointSha256,
    expectedRemaining: runState.expectedRemaining
  });
}

function hashOrNull(value) {
  return value === null || isSha256(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

async function executeChild({
  args,
  cwd,
  environment,
  timeoutMs,
  signal,
  capture
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: environment,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
    });
    let stdout = "";
    let stdoutTruncated = false;
    let settled = false;
    let killTimer = null;
    let terminated = null;
    const terminate = (reason) => {
      terminated ??= reason;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_TERMINATION_GRACE_MS);
      killTimer.unref?.();
    };
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref?.();
    const abort = () => terminate("abort");
    signal?.addEventListener("abort", abort, { once: true });
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length + chunk.length > PLAN_CAPTURE_LIMIT) {
          stdoutTruncated = true;
          stdout = `${stdout}${chunk}`.slice(-PLAN_CAPTURE_LIMIT);
        } else {
          stdout += chunk;
        }
      });
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      rejectPromise(error);
    });
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({
        exitCode,
        signal: exitSignal,
        stdout,
        stdoutTruncated,
        terminated
      });
    });
  });
}

async function defaultAssertPinnedMain({ cwd, sourceSha }) {
  const trackedStatus = await executeGit(cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no"
  ]);
  if (trackedStatus !== "") {
    throw new Error("Checkpoint controller checkout has tracked worktree changes.");
  }
  const local = await executeGit(cwd, ["rev-parse", "HEAD^{commit}"]);
  if (local !== sourceSha) {
    throw new Error("Checkpoint controller checkout no longer matches its source SHA.");
  }
  await executeGit(cwd, [
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main"
  ]);
  const remote = await executeGit(cwd, [
    "rev-parse",
    "refs/remotes/origin/main^{commit}"
  ]);
  if (remote !== sourceSha) {
    throw new Error("Remote main changed during checkpoint collection; stopping before another child.");
  }
}

async function executeGit(cwd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const gitEnvironment = Object.fromEntries(
      ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    );
    Object.assign(gitEnvironment, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0"
    });
    const child = spawn("git", args, {
      cwd,
      env: gitEnvironment,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`Git source-boundary command failed with exit ${code}.`));
    });
  });
}

async function assertDurableStateRoot(openCliHome, stateRoot) {
  const [home, state] = await Promise.all([
    realpath(resolve(openCliHome)),
    realpath(stateRoot)
  ]);
  const childPath = relative(home, state);
  if (childPath === "" || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error("Authenticated replay state escaped the durable OPENCLI_HOME boundary.");
  }
}

async function assertRegularOrMissing(path, { missingAllowed = true } = {}) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Authenticated replay artifacts must be regular files.");
    }
  } catch (error) {
    if (error?.code === "ENOENT" && missingAllowed) return;
    throw error;
  }
}

async function readJsonArtifact(path, fallback) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Authenticated replay artifact must contain one JSON object.");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
}

async function hashJsonArtifact(path) {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

async function writeGithubOutputs(path, outputs) {
  if (!clean(path)) throw new Error("GITHUB_OUTPUT is required for checkpoint collection.");
  const lines = [];
  for (const [key, rawValue] of Object.entries(outputs)) {
    const value = String(rawValue ?? "");
    if (!/^[a-z][a-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
      throw new Error("Checkpoint collection output was not a safe single-line value.");
    }
    lines.push(`${key}=${value}`);
  }
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

function canonicalInventory(targets) {
  return targets.map((target) => ({
    checkpointKey: target.checkpointKey,
    batchSlug: target.batchSlug,
    companySlug: target.companySlug,
    companyName: target.companyName,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.entityName,
    platform: target.platform,
    accountUrl: target.accountUrl,
    activityUrl: target.activityUrl
  })).sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));
}

function canonicalCollisions(value) {
  return (Array.isArray(value) ? value : []).map((collision) => ({
    batchSlug: collision.batchSlug,
    platform: collision.platform,
    accountIdentity: collision.accountIdentity,
    entityIds: [...(collision.entityIds ?? [])].sort(),
    targets: [...(collision.targets ?? [])].map((target) => ({ ...target }))
      .sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey))
  })).sort((left, right) =>
    `${left.platform}:${left.accountIdentity}`.localeCompare(
      `${right.platform}:${right.accountIdentity}`
    ));
}

function safePathSegment(value) {
  const source = String(value);
  const prefix = source.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "run";
  return `${prefix}-${sha256(source).slice(0, 16)}`;
}

function checkpointSafePath(path, label) {
  const value = resolve(String(path ?? ""));
  if (!isAbsolute(value)) throw new Error(`${label} path must be absolute.`);
  return value;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function assertCheckpointOutputConsistency(checkpoint, output) {
  for (const field of ["evidence", "needsReview", "attributionReconciliationLedger"]) {
    const checkpointRows = Array.isArray(checkpoint?.[field]) ? checkpoint[field] : [];
    const outputRows = Array.isArray(output?.[field]) ? output[field] : [];
    if (JSON.stringify(checkpointRows) !== JSON.stringify(outputRows)) {
      throw new Error(`Authenticated replay ${field} diverged between checkpoint and output.`);
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

const executablePath = process.argv[1] ? resolve(process.argv[1]) : null;
if (executablePath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`S2026 checkpoint collection failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
