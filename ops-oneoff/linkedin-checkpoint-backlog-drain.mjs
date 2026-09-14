#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants as fsConstants,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_REPOSITORY = "allenbuild/returner-fund";
const WORKFLOW_FILE = "autonomous-ingestion.yml";
const WORKFLOW_PATH = ".github/workflows/autonomous-ingestion.yml";
const REPLAY_ROOT_NAME = "authenticated-social-history-v1-0b7b68f8578289bc";
const REQUIRED_RUNNER_LABELS = Object.freeze([
  "self-hosted",
  "macOS",
  "ARM64",
  "returner-social",
  "returner-auth-browser"
]);
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending"
]);
const SUCCESSFUL_PUBLICATION_STATUSES = new Set([
  "published",
  "published_degraded",
  "published_no_new_sources",
  "published_stale_day",
  "no_changes",
  "no_changes_stale_day",
  "noop_completed",
  "noop_degraded",
  "noop_no_new_sources",
  "noop_stale_day"
]);

export const FINAL_PUBLICATION_MAX_REMAINING = 20;
export const BATCH_ORDER = Object.freeze(["S26", "S2026"]);
export const BATCH_CONTRACTS = Object.freeze({
  S26: Object.freeze({
    batchSlug: "S26",
    batchPath: "s26",
    keyPrefix: "incident-20260913-s26-linkedin-backlog-",
    graphFilename: "s26.json",
    catalogCompanyCount: 234,
    companyCount: 234,
    founderCount: 467,
    targetCount: 672,
    quarantinedTargetCount: 4,
    collisionCount: 2,
    collisionTargetCount: 4,
    inventorySha256: "3ea6464b0b025abdf8b526b260b7ea769b089f5a0ad8b30d0f9b3f9c15299182",
    collisionSha256: "1a8fd9092c9bf2ddd5789e49fda8795790baef84c2949a16fce6d20f579ff043"
  }),
  S2026: Object.freeze({
    batchSlug: "S2026",
    batchPath: "s2026",
    keyPrefix: "incident-20260913-s2026-linkedin-backlog-",
    graphFilename: "s2026.json",
    catalogCompanyCount: 197,
    companyCount: 197,
    founderCount: 396,
    targetCount: 568,
    quarantinedTargetCount: 4,
    collisionCount: 2,
    collisionTargetCount: 4,
    inventorySha256: "78fa2076a862d85e56a83fcbda588bbd3b4526cdb6c1ea1fb77093c73ab25a56",
    collisionSha256: "6914b5b2d04bdbc2cf5f0dbd10d2fee5ee60e463ca96daa2e2a9595d76bd5d45"
  })
});

export class DrainStopError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "DrainStopError";
    this.code = code;
    this.details = details;
  }
}

function stop(code, message, details = null) {
  throw new DrainStopError(code, message, details);
}

export function formatReplayKey(batchSlug, number) {
  const contract = batchContract(batchSlug);
  if (!Number.isSafeInteger(number) || number < 1 || number > 999) {
    throw new RangeError("Replay key number must be between 1 and 999.");
  }
  return `${contract.keyPrefix}${String(number).padStart(3, "0")}`;
}

export function replayKeyNumber(value, batchSlug) {
  const contract = batchContract(batchSlug);
  const match = new RegExp(`${escapeRegExp(contract.keyPrefix)}([0-9]{3})(?:$|\\b)`).exec(
    String(value ?? "")
  );
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= 999 ? number : null;
}

export function chooseNextReplayKey(runs, batchSlug) {
  const used = new Set();
  for (const run of runs ?? []) {
    const number = replayKeyNumber(run?.displayTitle ?? run?.name, batchSlug);
    if (number === null) continue;
    if (used.has(number)) {
      stop("duplicate_replay_key", `${formatReplayKey(batchSlug, number)} has multiple GitHub runs.`);
    }
    used.add(number);
  }
  const next = used.size === 0 ? 1 : Math.max(...used) + 1;
  if (next > 999) stop("replay_key_exhausted", `${batchSlug} exhausted its three-digit replay keys.`);
  return formatReplayKey(batchSlug, next);
}

export function activeWorkflowRuns(runs = []) {
  return runs.filter((run) => ACTIVE_RUN_STATUSES.has(run?.status) || run?.status !== "completed");
}

export function nextIncompleteBatch(state) {
  return BATCH_ORDER.find((batchSlug) => state?.batches?.[batchSlug]?.status !== "completed") ?? null;
}

export function validateBatchPlan(plan, {
  contract = BATCH_CONTRACTS[plan?.batchSlug]
} = {}) {
  if (!contract || !plainObject(plan)) stop("invalid_plan", "Canonical LinkedIn planner returned an invalid batch.");
  const targets = Array.isArray(plan.targets) ? plan.targets : [];
  const runnableTargets = Array.isArray(plan.runnableTargets) ? plan.runnableTargets : [];
  const collisions = canonicalCollisions(plan.ownerAccountCollisions);
  const inventory = canonicalInventory(targets);
  const proof = {
    catalogCompanyCount: plan.catalogCompanyCount,
    companyCount: plan.companyCount,
    founderCount: plan.founderCount,
    targetCount: targets.length,
    quarantinedTargetCount: plan.quarantinedTargetCount,
    collisionCount: collisions.length,
    collisionTargetCount: collisions.reduce((total, collision) => total + collision.targets.length, 0),
    inventorySha256: sha256(JSON.stringify(inventory)),
    collisionSha256: sha256(JSON.stringify(collisions))
  };
  for (const field of [
    "catalogCompanyCount",
    "companyCount",
    "founderCount",
    "targetCount",
    "quarantinedTargetCount",
    "collisionCount",
    "collisionTargetCount",
    "inventorySha256",
    "collisionSha256"
  ]) {
    if (proof[field] !== contract[field]) {
      stop("inventory_contract_drift", `${contract.batchSlug} ${field} drifted from its pinned contract.`);
    }
  }
  const remaining = plan.linkedinExecution?.remainingTargetCount;
  const selected = plan.linkedinExecution?.selectedForThisInvocationCount;
  if (
    plan.batchSlug !== contract.batchSlug ||
    plan.requestedTarget !== null ||
    plan.linkedinCollectionMode !== "browser" ||
    plan.linkedinExecution?.workers !== 1 ||
    plan.linkedinExecution?.serial !== true ||
    plan.linkedinExecution?.persistentHostPacing !== true ||
    plan.linkedinExecution?.delayMs !== 30_000 ||
    plan.linkedinExecution?.targetCap !== 5 ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    remaining > contract.targetCount ||
    plan.remainingTargetCount !== remaining ||
    !Number.isSafeInteger(selected) ||
    selected !== Math.min(5, remaining) ||
    plan.selectedForThisInvocationCount !== selected ||
    plan.runnableTargetCount !== selected ||
    runnableTargets.length !== selected
  ) {
    stop("invalid_plan", `${contract.batchSlug} planner no longer satisfies the serial five-target contract.`);
  }
  const inventoryKeys = new Set(inventory.map((target) => target.checkpointKey));
  const collisionKeys = new Set(collisions.flatMap((collision) =>
    collision.targets.map((target) => target.checkpointKey)
  ));
  if (
    inventoryKeys.size !== contract.targetCount ||
    runnableTargets.some((target) =>
      target?.batchSlug !== contract.batchSlug ||
      target?.platform !== "linkedin" ||
      !inventoryKeys.has(target?.checkpointKey) ||
      collisionKeys.has(target?.checkpointKey)
    )
  ) {
    stop("collision_or_inventory_leak", `${contract.batchSlug} runnable targets escaped the safe inventory.`);
  }
  return Object.freeze({
    batchSlug: contract.batchSlug,
    remaining,
    selected,
    proof: Object.freeze(proof),
    inventoryKeys: Object.freeze([...inventoryKeys].sort()),
    collisionKeys: Object.freeze([...collisionKeys].sort())
  });
}

export function validateCheckpointReceipt(receipt, {
  batchSlug,
  key,
  sourceSha,
  runId,
  before,
  after,
  beforePlan,
  afterPlan,
  contract = BATCH_CONTRACTS[batchSlug]
}) {
  if (!plainObject(receipt)) stop("checkpoint_receipt_invalid", "Checkpoint artifact is not one JSON object.");
  const request = receipt.request;
  const progress = receipt.progress;
  const artifacts = receipt.artifacts;
  const safety = receipt.safety;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "s2026_linkedin_checkpoint_collection" ||
    receipt.status !== "checkpoint_collection_completed" ||
    receipt.publicationDeferred !== true ||
    request?.idempotencyKey !== key ||
    request?.sourceSha !== sourceSha ||
    String(request?.runId) !== String(runId) ||
    String(request?.runAttempt) !== "1" ||
    request?.eventName !== "workflow_dispatch" ||
    request?.scope !== "linkedin" ||
    request?.batch !== batchSlug ||
    request?.expectedCheckpointSha256 !== before.checkpointHash ||
    request?.expectedRemaining !== beforePlan.remaining
  ) {
    stop("checkpoint_receipt_binding_mismatch", "Checkpoint artifact is not bound to the exact dispatch state.");
  }
  if (
    safety?.serial !== true ||
    safety?.workers !== 1 ||
    safety?.targetCapPerChild !== 5 ||
    safety?.targetDelayMs !== 30_000 ||
    safety?.scrollPassesPerTarget !== 30 ||
    safety?.postLimitPerTarget !== 100 ||
    safety?.batteryFloorPercent !== 5 ||
    safety?.batteryComparison !== "strictly_greater_than" ||
    safety?.batteryMaxChunks !== 4 ||
    safety?.acMaxChunks !== 12 ||
    safety?.globalLockNamespace !== "returner-fund-production-linkedin-allen-xu-v1" ||
    safety?.controllerLockNamespace !== "returner-fund-production-linkedin-checkpoint-controller-v1" ||
    safety?.fullWakeAdmissionPerChild !== true ||
    safety?.powerAndLidWatchdog !== true
  ) {
    stop("checkpoint_safety_mismatch", "Checkpoint artifact did not preserve the bounded collection safety policy.");
  }
  for (const field of [
    "catalogCompanyCount",
    "companyCount",
    "founderCount",
    "targetCount",
    "quarantinedTargetCount",
    "collisionCount",
    "collisionTargetCount",
    "inventorySha256",
    "collisionSha256"
  ]) {
    if (receipt.inventory?.[field] !== contract[field]) {
      stop("checkpoint_inventory_mismatch", `Checkpoint artifact has the wrong ${field}.`);
    }
  }
  const completedTargets = beforePlan.remaining - afterPlan.remaining;
  if (
    completedTargets < 1 ||
    completedTargets > 60 ||
    progress?.beforeRemaining !== beforePlan.remaining ||
    progress?.afterRemaining !== afterPlan.remaining ||
    progress?.completedTargets !== completedTargets ||
    !Number.isSafeInteger(progress?.chunksCompleted) ||
    progress.chunksCompleted < 1 ||
    progress.chunksCompleted > 12 ||
    !Number.isSafeInteger(progress?.batteryChunks) ||
    !Number.isSafeInteger(progress?.acChunks) ||
    progress.batteryChunks + progress.acChunks !== progress.chunksCompleted ||
    progress.completedTargets < progress.chunksCompleted ||
    progress.completedTargets > progress.chunksCompleted * 5 ||
    (progress.batteryChunks > 0 && progress.chunksCompleted > 4) ||
    progress.finalPublicationMaximumRemaining !== FINAL_PUBLICATION_MAX_REMAINING ||
    progress.finalPublicationReady !== (afterPlan.remaining <= FINAL_PUBLICATION_MAX_REMAINING)
  ) {
    stop("checkpoint_progress_mismatch", "Checkpoint artifact has invalid bounded progress.");
  }
  if (
    artifacts?.checkpointSha256Before !== before.checkpointHash ||
    artifacts?.checkpointSha256After !== after.checkpointHash ||
    artifacts?.outputSha256Before !== before.outputHash ||
    artifacts?.outputSha256After !== after.outputHash ||
    before.checkpointHash === after.checkpointHash ||
    before.outputHash === after.outputHash
  ) {
    stop("checkpoint_hash_chain_mismatch", "Checkpoint artifact hashes do not bind the durable before/after files.");
  }
  validateChunkChain(receipt.chunks, { beforePlan, afterPlan, before, after, progress });
  if (before.attemptDigests === null) {
    if (!after.attemptDigests || afterPlan.proof.inventorySha256 !== beforePlan.proof.inventorySha256 ||
        afterPlan.proof.collisionSha256 !== beforePlan.proof.collisionSha256) {
      stop("adopted_checkpoint_unverified", "Adopted checkpoint run lacks a stable terminal inventory proof.");
    }
  } else {
    validateAttemptDelta({ batchSlug, before, after, beforePlan, afterPlan, expectedChanged: completedTargets });
  }
  return Object.freeze({
    beforeRemaining: beforePlan.remaining,
    completedTargets,
    afterRemaining: afterPlan.remaining
  });
}

export function validateCheckpointAuditReceipt(audit, {
  controllerReceipt,
  controllerReceiptSha256,
  batchSlug,
  key,
  sourceSha,
  runId
}) {
  const checkpoint = audit?.checkpointCollection;
  if (
    audit?.schemaVersion !== 1 ||
    audit?.status !== "checkpoint_collection_completed" ||
    audit?.slotKey !== key ||
    audit?.shouldRun !== true ||
    audit?.trigger !== "manual-replay" ||
    audit?.sourceSha !== sourceSha ||
    audit?.triggerSha !== sourceSha ||
    audit?.headSha !== sourceSha ||
    audit?.executedSha !== sourceSha ||
    audit?.resolveResult !== "success" ||
    audit?.ingestResult !== "success" ||
    audit?.validationResult !== "skipped" ||
    audit?.acceptanceResult !== "skipped" ||
    audit?.runnerStatus !== "checkpoint_collection_completed" ||
    audit?.hostReady !== true ||
    audit?.publishedCommit !== null ||
    audit?.commitRepositoryVerified !== false ||
    audit?.run?.id !== String(runId) ||
    audit?.run?.attempt !== "1" ||
    audit?.run?.eventName !== "workflow_dispatch" ||
    checkpoint?.checkpointOnly !== true ||
    checkpoint?.receiptRecognized !== true ||
    checkpoint?.batch !== batchSlug ||
    checkpoint?.receiptSha256 !== controllerReceiptSha256 ||
    checkpoint?.sourceSha !== sourceSha
  ) {
    stop("checkpoint_audit_binding_mismatch", "Autonomous receipt does not recognize the exact checkpoint artifact.");
  }
  const progress = controllerReceipt.progress;
  const artifacts = controllerReceipt.artifacts;
  for (const [auditField, expected] of Object.entries({
    beforeRemaining: progress.beforeRemaining,
    afterRemaining: progress.afterRemaining,
    completedTargets: progress.completedTargets,
    chunksCompleted: progress.chunksCompleted,
    batteryChunks: progress.batteryChunks,
    acChunks: progress.acChunks,
    finalPublicationReady: progress.finalPublicationReady,
    checkpointSha256Before: artifacts.checkpointSha256Before,
    checkpointSha256After: artifacts.checkpointSha256After,
    outputSha256Before: artifacts.outputSha256Before,
    outputSha256After: artifacts.outputSha256After,
    inventorySha256: controllerReceipt.inventory.inventorySha256,
    collisionSha256: controllerReceipt.inventory.collisionSha256
  })) {
    if (checkpoint[auditField] !== expected) {
      stop("checkpoint_audit_binding_mismatch", `Autonomous checkpoint field ${auditField} disagrees with its artifact.`);
    }
  }
  return true;
}

export function validateFinalReplayReceipt(receipt, {
  batchSlug,
  key,
  checkpointSha256,
  expectedRemaining
}) {
  const replay = receipt?.authenticatedSocialReplay;
  const batch = replay?.batches?.find((entry) => entry?.batchSlug === batchSlug);
  const binding = batch?.linkedin?.checkpointBinding;
  if (
    receipt?.idempotencyKey !== key ||
    receipt?.trigger !== "manual-replay" ||
    replay?.status !== "completed" ||
    replay?.requestedScope !== "linkedin" ||
    JSON.stringify(replay?.requestedPlatforms) !== JSON.stringify(["linkedin"]) ||
    replay?.requestedTarget?.batchSlug !== batchSlug ||
    Object.hasOwn(replay?.requestedTarget ?? {}, "companySlug") ||
    replay?.durableLockConfigured !== true ||
    replay?.configurationSkipped === true ||
    replay?.safetyStopped === true ||
    replay?.infrastructureStopped === true ||
    replay?.remainingTargetCountKnown !== true ||
    replay?.remainingTargetCount !== 0 ||
    replay?.remainingByBatch?.[batchSlug] !== 0 ||
    (replay?.unknownRemainingBatches ?? []).length !== 0 ||
    replay?.maxChunks !== 4 ||
    replay?.targetCapPerChunk !== 5 ||
    replay?.reserveMs !== 900_000 ||
    replay?.drainHeadroomMs !== 300_000 ||
    replay?.chunkAdmissionPolicy !== "battery-floor-watchdog" ||
    replay?.wallClockChunkAdmissionBudgetMs !== 0 ||
    replay?.requiredRemainingForChunkMs !== 1_200_000 ||
    replay?.batteryFloorPercent !== 5 ||
    replay?.batteryFloorComparison !== "strictly_greater_than" ||
    replay?.batteryRuntimeEstimateRequired !== false ||
    replay?.externalPowerRequiredForChunkAdmission !== false ||
    replay?.perChunkBatteryCheckRequired !== true ||
    !Number.isSafeInteger(replay?.chunksAdmitted) ||
    replay.chunksAdmitted < 1 ||
    replay.chunksAdmitted > 4 ||
    replay?.chunksAttempted !== replay.chunksAdmitted ||
    replay?.chunksCompleted !== replay.chunksAttempted ||
    replay?.targetCapacityAdmitted !== replay.chunksAdmitted * 5 ||
    replay?.chunkBudgetExhausted === true ||
    replay?.deadlineExhausted === true ||
    replay?.platformStatus?.linkedin?.requested !== true ||
    replay?.platformStatus?.linkedin?.status !== "completed" ||
    (replay?.platformDebt ?? []).length !== 0 ||
    replay?.batches?.length !== 1 ||
    batch?.linkedin?.status !== "completed" ||
    batch?.linkedin?.finalPlan?.remainingTargetCount !== 0 ||
    binding?.batchSlug !== batchSlug ||
    binding?.checkpointSha256 !== checkpointSha256 ||
    binding?.expectedRemainingTargetCount !== expectedRemaining ||
    binding?.observedRemainingTargetCount !== expectedRemaining
  ) {
    stop("final_replay_receipt_mismatch", "Published source delta is not the exact completed final LinkedIn replay.");
  }
  return replay;
}

export function validatePublicationCommitMessage(message, { key, sourceSha, runId }) {
  const lines = String(message ?? "").split(/\r?\n/);
  if (lines[0] !== `Publish autonomous ingestion ${key}`) {
    stop("publication_commit_mismatch", "Final publication commit has the wrong subject.");
  }
  for (const trailer of [
    `Returner-Slot-Key: ${key}`,
    `Returner-Source-SHA: ${sourceSha}`,
    `Returner-Run-ID: ${runId}`,
    "Returner-Run-Attempt: 1"
  ]) {
    if (!lines.includes(trailer)) stop("publication_commit_mismatch", `Final publication omitted ${trailer}.`);
  }
  return true;
}

export function validateFinalAuditReceipt(receipt, {
  key,
  sourceSha,
  runId,
  publishedSha,
  workflowConclusion
}) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.slotKey !== key ||
    receipt?.shouldRun !== true ||
    receipt?.trigger !== "manual-replay" ||
    receipt?.sourceSha !== sourceSha ||
    receipt?.triggerSha !== sourceSha ||
    receipt?.headSha !== sourceSha ||
    receipt?.run?.id !== String(runId) ||
    receipt?.run?.attempt !== "1" ||
    receipt?.run?.eventName !== "workflow_dispatch"
  ) {
    stop("final_audit_binding_mismatch", "Final autonomous receipt has the wrong run or source binding.");
  }
  if (workflowConclusion === "success") {
    if (
      !SUCCESSFUL_PUBLICATION_STATUSES.has(receipt.status) ||
      receipt.ingestResult !== "success" ||
      receipt.validationResult !== "success" ||
      receipt.acceptanceResult !== "skipped" ||
      receipt.receiptRecognized !== true ||
      receipt.commitProofValid !== true ||
      receipt.commitRepositoryVerified !== true ||
      receipt.publishedCommit !== publishedSha ||
      receipt.executedSha !== sourceSha
    ) {
      stop("final_audit_unrecognized", "Successful final workflow lacks a recognized, verified publication receipt.");
    }
  }
  return true;
}

export function validateFailedPublicationJobs(jobs, { key, publishedSha }) {
  if (!Array.isArray(jobs)) stop("failed_run_jobs_invalid", "Final workflow jobs are unavailable.");
  const exact = (name) => jobs.filter((job) => job?.name === name);
  const resolveJobs = exact("Resolve Central slot candidate");
  const publicationJobs = exact(`Publish accepted slot ${key}`);
  if (
    resolveJobs.length !== 1 ||
    resolveJobs[0]?.status !== "completed" ||
    resolveJobs[0]?.conclusion !== "success" ||
    publicationJobs.length !== 1 ||
    publicationJobs[0]?.status !== "completed"
  ) {
    stop("failed_run_validation_incomplete", "Failed-run reconciliation lacks exact terminal resolve/publication jobs.");
  }
  const prefix = `Validate published commit ${publishedSha} / `;
  const validationJobs = jobs.filter((job) => String(job?.name ?? "").startsWith(prefix));
  if (
    validationJobs.length < 12 ||
    validationJobs.some((job) => job?.status !== "completed" || job?.conclusion !== "success")
  ) {
    stop("failed_run_validation_incomplete", "Not every published-commit validation job succeeded.");
  }
  for (const suffix of [
    "Resolve exact validation target",
    "logged_social",
    "collectors",
    "build",
    "scoring",
    "artifacts",
    "app_tests (1)",
    "app_tests (2)",
    "app_tests (3)",
    "app_tests (4)",
    "quality",
    "validate"
  ]) {
    const matches = exact(`${prefix}${suffix}`);
    if (matches.length !== 1 || matches[0].conclusion !== "success") {
      stop("failed_run_validation_incomplete", `Required validator did not succeed exactly once: ${suffix}.`);
    }
  }
  return true;
}

export function dispatchFields({ batchSlug, key, checkpointSha256, remaining, checkpointOnly }) {
  batchContract(batchSlug);
  if (
    replayKeyNumber(key, batchSlug) === null ||
    !/^[0-9a-f]{64}$/.test(checkpointSha256) ||
    !Number.isSafeInteger(remaining) ||
    remaining < 1 ||
    remaining > BATCH_CONTRACTS[batchSlug].targetCount ||
    (checkpointOnly ? remaining <= FINAL_PUBLICATION_MAX_REMAINING : remaining > FINAL_PUBLICATION_MAX_REMAINING)
  ) {
    stop("dispatch_binding_invalid", "Dispatch is not bound to an exact checkpoint mode and remainder.");
  }
  return Object.freeze({
    replay_key: key,
    authenticated_backfill: "true",
    authenticated_backfill_scope: "linkedin",
    authenticated_backfill_batch: batchSlug,
    authenticated_backfill_company_slug: "",
    recover_authenticated_linkedin_lock: "false",
    incident_s2026_linkedin_backlog_battery_override: "true",
    incident_linkedin_checkpoint_only: checkpointOnly ? "true" : "false",
    incident_linkedin_expected_checkpoint_sha256: checkpointSha256,
    incident_linkedin_expected_remaining: String(remaining)
  });
}

export function parseOptions(argv, environment = process.env) {
  const flags = new Set();
  const values = new Map();
  for (const argument of argv) {
    if (!argument.startsWith("--")) stop("invalid_argument", `Unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    if (separator < 0) flags.add(argument.slice(2));
    else values.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  const allowedFlags = new Set(["execute", "dry-run", "plan-only", "help"]);
  const allowedValues = new Set([
    "repo-dir",
    "repository",
    "state-file",
    "poll-seconds",
    "appearance-timeout-seconds",
    "public-timeout-minutes",
    "max-dispatches",
    "adopt-run"
  ]);
  for (const flag of flags) if (!allowedFlags.has(flag)) stop("invalid_argument", `Unknown flag: --${flag}`);
  for (const key of values.keys()) if (!allowedValues.has(key)) stop("invalid_argument", `Unknown option: --${key}`);
  if (flags.has("execute") && flags.has("dry-run")) stop("invalid_argument", "--execute conflicts with --dry-run.");
  const openCliHome = environment.OPENCLI_HOME?.trim() || path.join(
    os.homedir(), "Library", "Application Support", "Returner Fund OpenCLI"
  );
  const replayRoot = path.join(openCliHome, "returner-fund-autonomous-replay", REPLAY_ROOT_NAME);
  return Object.freeze({
    help: flags.has("help"),
    execute: flags.has("execute"),
    planOnly: flags.has("plan-only"),
    repoDir: path.resolve(values.get("repo-dir") || DEFAULT_REPO_DIR),
    repository: values.get("repository") || DEFAULT_REPOSITORY,
    statePath: path.resolve(values.get("state-file") || path.join(replayRoot, "linkedin-checkpoint-backlog-drain-state.json")),
    replayRoot,
    openCliHome,
    pollSeconds: boundedInteger(values.get("poll-seconds") ?? "30", "poll-seconds", 5, 300),
    appearanceTimeoutSeconds: boundedInteger(
      values.get("appearance-timeout-seconds") ?? "180", "appearance-timeout-seconds", 30, 900
    ),
    publicTimeoutMinutes: boundedInteger(
      values.get("public-timeout-minutes") ?? (flags.has("execute") ? "20" : "1"),
      "public-timeout-minutes", 1, 60
    ),
    maxDispatches: boundedInteger(values.get("max-dispatches") ?? "999", "max-dispatches", 1, 999),
    adoptRunId: values.has("adopt-run")
      ? boundedInteger(values.get("adopt-run"), "adopt-run", 1, Number.MAX_SAFE_INTEGER)
      : null
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await assertLocalPrerequisites(options);
  const recoveryLockPath = `${options.statePath}.recovery.lock`;
  await assertNoDriverRecovery(recoveryLockPath);
  const release = await acquireExclusiveLock(`${options.statePath}.lock`, recoveryLockPath);
  try {
    await assertNoDriverRecovery(recoveryLockPath);
    let state = await readDriverState(options);
    if (options.adoptRunId !== null) {
      if (state.pending && Number(state.pending.runId) !== options.adoptRunId) {
        stop("adopt_run_conflict", `State already tracks pending run ${state.pending.runId}.`);
      }
      if (!state.pending) {
        state.pending = await createAdoptedPending(options, state, options.adoptRunId);
        await writeDriverState(options, state);
      }
    }
    if (state.pending) state = await resumePendingRun(options, state);
    let dispatched = 0;
    for (const batchSlug of BATCH_ORDER) {
      for (;;) {
        await waitForWorkflowIdle(options);
        const sourceSha = await syncRepositoryToMain(options);
        await assertWorkflowContract(options, sourceSha);
        const snapshot = await readDurableSnapshot(options, batchSlug);
        const plan = validateBatchPlan(await readCanonicalPlan(options, batchSlug));
        assertSnapshotOutputConsistency(snapshot);
        if (plan.remaining === 0) {
          await verifyCommittedCheckpointCoverage(options, batchSlug, snapshot.checkpoint);
          await waitForPublicParity(options, batchSlug);
          state.batches[batchSlug].status = "completed";
          state.batches[batchSlug].finalRemaining = 0;
          state.batches[batchSlug].completedAt = new Date().toISOString();
          await writeDriverState(options, state);
          process.stdout.write(`${batchSlug} is fully checkpointed, committed, and public.\n`);
          break;
        }
        if (state.batches[batchSlug].status === "completed") {
          stop("completed_state_regressed", `${batchSlug} was recorded complete but now has ${plan.remaining} remaining targets.`);
        }
        const checkpointOnly = plan.remaining > FINAL_PUBLICATION_MAX_REMAINING;
        let runs = await listWorkflowRuns(options);
        assertNoActiveRuns(runs);
        await assertRunnerOnlineAndIdle(options);
        await assertPhysicalSafety();
        const stableSha = await fetchRemoteMain(options);
        if (stableSha !== sourceSha) stop("source_drift", `Main changed after ${batchSlug} was planned.`);
        runs = await listWorkflowRuns(options);
        assertNoActiveRuns(runs);
        await assertRunnerOnlineAndIdle(options);
        const dispatchSha = await fetchRemoteMain(options);
        if (dispatchSha !== sourceSha) stop("source_drift", `Main changed at the ${batchSlug} dispatch boundary.`);
        const key = chooseNextReplayKey(runs, batchSlug);
        const fields = dispatchFields({
          batchSlug,
          key,
          checkpointSha256: snapshot.checkpointHash,
          remaining: plan.remaining,
          checkpointOnly
        });
        process.stdout.write(
          `${batchSlug}: ${plan.remaining} remain; next ${checkpointOnly ? "checkpoint" : "final publication"} run is ${key}.\n`
        );
        if (options.planOnly || !options.execute) return;
        if (dispatched >= options.maxDispatches) {
          process.stdout.write(`Stopped cleanly at --max-dispatches=${options.maxDispatches}.\n`);
          return;
        }
        state.pending = {
          batchSlug,
          mode: checkpointOnly ? "checkpoint" : "final",
          key,
          sourceSha,
          beforeRemaining: plan.remaining,
          beforePlan: serializablePlan(plan),
          beforeCheckpointHash: snapshot.checkpointHash,
          beforeOutputHash: snapshot.outputHash,
          beforeAttemptDigests: snapshot.attemptDigests,
          requestedAt: new Date().toISOString(),
          runId: null,
          runUrl: null
        };
        await writeDriverState(options, state);
        await dispatchWorkflow(options, fields);
        dispatched += 1;
        const run = await waitForDispatchedRun(options, { key, batchSlug, sourceSha });
        state.pending.runId = Number(run.databaseId);
        state.pending.runUrl = run.url;
        await writeDriverState(options, state);
        state = await finishPendingRun(options, state, run);
      }
    }
    process.stdout.write(`S26 and S2026 LinkedIn backlog drain completed in ${state.completedRuns.length} run(s).\n`);
  } finally {
    await release();
  }
}

async function finishPendingRun(options, state, initialRun) {
  const pending = state.pending;
  const run = initialRun.status === "completed"
    ? initialRun
    : await waitForTerminalRun(options, initialRun.databaseId);
  if (run.status !== "completed" || !String(run.conclusion ?? "")) {
    stop("github_run_invalid", `${pending.key} did not reach one terminal conclusion.`);
  }
  if (String(run.headSha).toLowerCase() !== pending.sourceSha) {
    stop("run_source_mismatch", `${pending.key} ran a source other than ${pending.sourceSha}.`);
  }
  const artifacts = await downloadRunReceipts(options, pending, run);
  if (pending.mode === "checkpoint") {
    if (run.conclusion !== "success") {
      stop("checkpoint_workflow_failed", `${pending.key} ended ${run.conclusion}; refusing to infer checkpoint success.`, { runUrl: run.url });
    }
    const after = await readDurableSnapshot(options, pending.batchSlug);
    assertSnapshotOutputConsistency(after);
    const afterPlan = validateBatchPlan(await readCanonicalPlan(options, pending.batchSlug));
    const beforePlan = pending.adopted === true
      ? {
          ...afterPlan,
          remaining: artifacts.controller.receipt?.request?.expectedRemaining
        }
      : hydratePlan(pending.beforePlan);
    const beforeSnapshot = pending.adopted === true
      ? {
          checkpointHash: artifacts.controller.receipt?.artifacts?.checkpointSha256Before,
          outputHash: artifacts.controller.receipt?.artifacts?.outputSha256Before,
          attemptDigests: null
        }
      : pendingSnapshot(pending);
    const result = validateCheckpointReceipt(artifacts.controller.receipt, {
      batchSlug: pending.batchSlug,
      key: pending.key,
      sourceSha: pending.sourceSha,
      runId: run.databaseId,
      before: beforeSnapshot,
      after,
      beforePlan,
      afterPlan
    });
    validateCheckpointAuditReceipt(artifacts.audit.receipt, {
      controllerReceipt: artifacts.controller.receipt,
      controllerReceiptSha256: artifacts.controller.sha256,
      batchSlug: pending.batchSlug,
      key: pending.key,
      sourceSha: pending.sourceSha,
      runId: run.databaseId
    });
    state.completedRuns.push(completedRunRecord(pending, run, result));
    state.batches[pending.batchSlug].lastRemaining = result.afterRemaining;
    state.pending = null;
    await writeDriverState(options, state);
    process.stdout.write(`${pending.key}: checkpointed ${result.completedTargets}; ${result.afterRemaining} remain.\n`);
    return state;
  }

  const after = await readDurableSnapshot(options, pending.batchSlug);
  assertSnapshotOutputConsistency(after);
  const publishedSha = await resolvePublicationCommit(options, pending, run, artifacts.audit.receipt);
  await assertPublicationCommit(options, { pending, run, publishedSha });
  await checkoutDetached(options.repoDir, publishedSha);
  const afterPlan = validateBatchPlan(await readCanonicalPlan(options, pending.batchSlug));
  if (afterPlan.remaining !== 0) stop("final_checkpoint_incomplete", `${pending.key} left ${afterPlan.remaining} targets.`);
  validateAttemptDelta({
    batchSlug: pending.batchSlug,
    before: pendingSnapshot(pending),
    after,
    beforePlan: hydratePlan(pending.beforePlan),
    afterPlan,
    expectedChanged: pending.beforeRemaining
  });
  const sourceDelta = await readJsonAtCommit(options, publishedSha, "outputs/ingestion-source-delta-current.json");
  validateFinalReplayReceipt(sourceDelta, {
    batchSlug: pending.batchSlug,
    key: pending.key,
    checkpointSha256: pending.beforeCheckpointHash,
    expectedRemaining: pending.beforeRemaining
  });
  validateFinalAuditReceipt(artifacts.audit.receipt, {
    key: pending.key,
    sourceSha: pending.sourceSha,
    runId: run.databaseId,
    publishedSha,
    workflowConclusion: run.conclusion
  });
  if (run.conclusion !== "success") {
    validateFailedPublicationJobs(await readWorkflowRunJobs(options, run.databaseId), {
      key: pending.key,
      publishedSha
    });
  }
  await verifyCommittedCheckpointCoverage(options, pending.batchSlug, after.checkpoint, publishedSha);
  await waitForPublicParity(options, pending.batchSlug, publishedSha);
  const result = { completedTargets: pending.beforeRemaining, afterRemaining: 0, publishedSha };
  state.completedRuns.push(completedRunRecord(pending, run, result));
  state.batches[pending.batchSlug].status = "completed";
  state.batches[pending.batchSlug].lastRemaining = 0;
  state.batches[pending.batchSlug].finalRemaining = 0;
  state.batches[pending.batchSlug].publishedSha = publishedSha;
  state.batches[pending.batchSlug].completedAt = new Date().toISOString();
  state.pending = null;
  await writeDriverState(options, state);
  process.stdout.write(`${pending.key}: final ${pending.batchSlug} publication ${publishedSha} is committed and public.\n`);
  return state;
}

async function resumePendingRun(options, state) {
  const pending = state.pending;
  const status = (await runCommand("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: options.repoDir
  })).stdout.trim();
  if (status) stop("dirty_checkout", "Foreground drain checkout has tracked changes during resume.");
  await fetchRemoteMain(options);
  await checkoutDetached(options.repoDir, pending.sourceSha);
  const runs = await listWorkflowRuns(options);
  const matches = runs.filter((run) => replayKeyNumber(run?.displayTitle, pending.batchSlug) === replayKeyNumber(pending.key, pending.batchSlug));
  if (matches.length !== 1) {
    stop("ambiguous_pending_dispatch", `${pending.key} has ${matches.length} matching GitHub runs; refusing to reuse its key.`);
  }
  const run = matches[0];
  if (pending.runId && Number(run.databaseId) !== Number(pending.runId)) {
    stop("ambiguous_pending_dispatch", `${pending.key} no longer matches recorded run ${pending.runId}.`);
  }
  return finishPendingRun(options, state, run);
}

async function createAdoptedPending(options, state, runId) {
  if (state.completedRuns.length !== 0 || BATCH_ORDER.some((batchSlug) => state.batches[batchSlug].status === "completed")) {
    stop("adopt_run_conflict", "An explicit adoption is allowed only before this driver has recorded any run.");
  }
  const gh = await commandPath("gh");
  const result = await runCommand(gh, [
    "run", "view", String(runId), "--repo", options.repository,
    "--json", "databaseId,status,conclusion,headSha,displayTitle,event,createdAt,url"
  ], { timeoutMs: 30_000 });
  const run = parseJsonBytes(Buffer.from(result.stdout), `GitHub run ${runId}`);
  const matchingBatches = BATCH_ORDER.filter((batchSlug) => replayKeyNumber(run.displayTitle, batchSlug) !== null);
  if (
    Number(run.databaseId) !== runId ||
    run.event !== "workflow_dispatch" ||
    matchingBatches.length !== 1 ||
    matchingBatches[0] !== "S26" ||
    replayKeyNumber(run.displayTitle, "S26") !== 1 ||
    !/^[0-9a-f]{40}$/.test(String(run.headSha ?? "").toLowerCase())
  ) {
    stop("adopt_run_invalid", `Run ${runId} is not the exact first S26 checkpoint incident run.`);
  }
  return {
    batchSlug: "S26",
    mode: "checkpoint",
    key: formatReplayKey("S26", 1),
    sourceSha: String(run.headSha).toLowerCase(),
    beforeRemaining: null,
    beforePlan: null,
    beforeCheckpointHash: null,
    beforeOutputHash: null,
    beforeAttemptDigests: null,
    adopted: true,
    requestedAt: run.createdAt,
    runId,
    runUrl: run.url
  };
}

function validateChunkChain(chunks, { beforePlan, afterPlan, before, after, progress }) {
  if (!Array.isArray(chunks) || chunks.length !== progress.chunksCompleted) {
    stop("checkpoint_chunk_chain_mismatch", "Checkpoint receipt chunk count is inconsistent.");
  }
  let remaining = beforePlan.remaining;
  let checkpointHash = before.checkpointHash;
  let outputHash = before.outputHash;
  let completed = 0;
  let battery = 0;
  let ac = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (
      chunk?.chunkNumber !== index + 1 ||
      !["ac", "battery"].includes(chunk?.powerMode) ||
      chunk?.beforeRemaining !== remaining ||
      chunk?.checkpointSha256Before !== checkpointHash ||
      chunk?.outputSha256Before !== outputHash ||
      !Number.isSafeInteger(chunk?.completedTargets) ||
      chunk.completedTargets < 1 ||
      chunk.completedTargets > 5 ||
      chunk.afterRemaining !== chunk.beforeRemaining - chunk.completedTargets ||
      !isSha256(chunk.completedKeysSha256) ||
      !isSha256(chunk.checkpointSha256After) ||
      !isSha256(chunk.outputSha256After)
    ) {
      stop("checkpoint_chunk_chain_mismatch", `Checkpoint chunk ${index + 1} is malformed.`);
    }
    remaining = chunk.afterRemaining;
    checkpointHash = chunk.checkpointSha256After;
    outputHash = chunk.outputSha256After;
    completed += chunk.completedTargets;
    if (chunk.powerMode === "battery") battery += 1;
    else ac += 1;
  }
  if (
    remaining !== afterPlan.remaining ||
    checkpointHash !== after.checkpointHash ||
    outputHash !== after.outputHash ||
    completed !== progress.completedTargets ||
    battery !== progress.batteryChunks ||
    ac !== progress.acChunks
  ) {
    stop("checkpoint_chunk_chain_mismatch", "Checkpoint chunk chain does not reach the durable final state.");
  }
}

function validateAttemptDelta({ batchSlug, before, after, beforePlan, afterPlan, expectedChanged }) {
  if (beforePlan.proof.inventorySha256 !== afterPlan.proof.inventorySha256 ||
      beforePlan.proof.collisionSha256 !== afterPlan.proof.collisionSha256) {
    stop("inventory_contract_drift", `${batchSlug} inventory or collision proof changed during a run.`);
  }
  const inventory = new Set(beforePlan.inventoryKeys);
  const collisions = new Set(beforePlan.collisionKeys);
  const keys = new Set([...Object.keys(before.attemptDigests), ...Object.keys(after.attemptDigests)]);
  const changed = [...keys].filter((key) => before.attemptDigests[key]?.digest !== after.attemptDigests[key]?.digest);
  if (
    changed.length !== expectedChanged ||
    beforePlan.remaining - afterPlan.remaining !== expectedChanged ||
    changed.some((key) =>
      !inventory.has(key) ||
      collisions.has(key) ||
      before.attemptDigests[key]?.status === "done" ||
      after.attemptDigests[key]?.status !== "done"
    )
  ) {
    stop("checkpoint_attempt_delta_mismatch", "Durable attempts changed outside the exact safe completed target delta.");
  }
  for (const key of collisions) {
    if (before.attemptDigests[key]?.digest !== after.attemptDigests[key]?.digest) {
      stop("collision_checkpoint_changed", `Quarantined collision target changed: ${key}.`);
    }
  }
  return changed;
}

async function assertLocalPrerequisites(options) {
  if (process.platform !== "darwin") stop("unsupported_host", "The foreground drain must run on the dedicated macOS host.");
  for (const command of ["/usr/bin/git", "/usr/bin/pmset", "/usr/sbin/ioreg"]) {
    await access(command, fsConstants.X_OK).catch(() => stop("missing_command", `${command} is not executable.`));
  }
  await commandPath("gh");
  await access(path.join(options.repoDir, "node_modules", "@supabase", "supabase-js", "package.json"), fsConstants.R_OK)
    .catch(() => stop("dependencies_missing", `Run npm ci --ignore-scripts in ${options.repoDir} first.`));
  const remote = (await runCommand("/usr/bin/git", ["remote", "get-url", "origin"], { cwd: options.repoDir })).stdout.trim();
  if (!new RegExp(`github\\.com[/:]${escapeRegExp(options.repository)}(?:\\.git)?$`, "i").test(remote)) {
    stop("repository_remote_mismatch", `Origin ${remote} does not match ${options.repository}.`);
  }
  for (const batchSlug of BATCH_ORDER) {
    for (const filePath of Object.values(durablePaths(options, batchSlug))) {
      await stat(filePath).then((entry) => {
        if (!entry.isFile()) stop("durable_artifact_invalid", `${filePath} is not a regular file.`);
      }).catch((error) => {
        if (error instanceof DrainStopError) throw error;
        stop("durable_artifact_missing", `${filePath} is missing.`);
      });
    }
  }
}

async function assertWorkflowContract(options, sourceSha) {
  const workflow = await readFile(path.join(options.repoDir, WORKFLOW_PATH), "utf8");
  const collector = await readFile(path.join(options.repoDir, "scripts", "collect-s2026-linkedin-checkpoints.mjs"), "utf8");
  for (const needle of [
    "incident_linkedin_checkpoint_only:",
    "incident_linkedin_expected_checkpoint_sha256:",
    "incident_linkedin_expected_remaining:",
    "Collect bounded 2026 LinkedIn checkpoints",
    "Upload 2026 LinkedIn checkpoint receipt"
  ]) {
    if (!workflow.includes(needle)) stop("workflow_contract_drift", `${sourceSha} lacks ${needle}.`);
  }
  for (const contract of Object.values(BATCH_CONTRACTS)) {
    if (!workflow.includes(contract.keyPrefix) ||
        !workflow.includes(contract.inventorySha256) ||
        !workflow.includes(contract.collisionSha256) ||
        !collector.includes(contract.inventorySha256) ||
        !collector.includes(contract.collisionSha256)) {
      stop("workflow_contract_drift", `${sourceSha} lacks the exact ${contract.batchSlug} incident contract.`);
    }
  }
}

async function readDurableSnapshot(options, batchSlug) {
  const paths = durablePaths(options, batchSlug);
  const [checkpointBytes, outputBytes] = await Promise.all([
    readFile(paths.checkpoint),
    readFile(paths.output)
  ]);
  const checkpoint = parseJsonBytes(checkpointBytes, "checkpoint");
  const output = parseJsonBytes(outputBytes, "output");
  if (!plainObject(checkpoint.attempts) || !Array.isArray(checkpoint.evidence)) {
    stop("checkpoint_invalid", `${batchSlug} checkpoint schema is malformed.`);
  }
  const attemptDigests = {};
  for (const [key, value] of Object.entries(checkpoint.attempts)) {
    if (!key.startsWith(`${batchSlug}:linkedin:`)) continue;
    attemptDigests[key] = { digest: sha256(JSON.stringify(value)), status: value?.status ?? null };
  }
  return {
    checkpoint,
    output,
    checkpointHash: sha256(checkpointBytes),
    outputHash: sha256(outputBytes),
    attemptDigests
  };
}

function assertSnapshotOutputConsistency(snapshot) {
  for (const field of ["evidence", "needsReview", "attributionReconciliationLedger"]) {
    const checkpoint = Array.isArray(snapshot.checkpoint?.[field]) ? snapshot.checkpoint[field] : [];
    const output = Array.isArray(snapshot.output?.[field]) ? snapshot.output[field] : [];
    if (JSON.stringify(canonicalRowMultiset(checkpoint)) !== JSON.stringify(canonicalRowMultiset(output))) {
      stop("checkpoint_output_diverged", `Durable checkpoint and output disagree on ${field}.`);
    }
  }
}

function canonicalRowMultiset(rows) {
  return rows.map((row) => stableJson(row)).sort();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readCanonicalPlan(options, batchSlug) {
  const paths = durablePaths(options, batchSlug);
  const args = [
    "scripts/fetch-logged-in-social-traction.mjs",
    `--batch=${batchSlug}`,
    "--entities=all",
    "--limit=100",
    "--scrolls=30",
    "--timeout-ms=90000",
    `--output-path=${paths.output}`,
    `--checkpoint-path=${paths.checkpoint}`,
    "--workers=1",
    "--platforms=linkedin",
    "--allow-linkedin",
    "--linkedin-mode=browser",
    "--linkedin-max-targets=5",
    "--delay-ms=30000",
    "--terminal-completed-platforms=linkedin",
    "--plan"
  ];
  const result = await runCommand(process.execPath, args, {
    cwd: options.repoDir,
    env: { ...process.env, SCORING_DATA_ROOT: options.repoDir },
    timeoutMs: 120_000,
    maxOutputBytes: 20 * 1024 * 1024
  });
  const start = result.stdout.indexOf("{");
  if (start < 0) stop("invalid_plan_output", `${batchSlug} planner emitted no JSON.`);
  try {
    return JSON.parse(result.stdout.slice(start));
  } catch {
    stop("invalid_plan_output", `${batchSlug} planner emitted malformed JSON.`);
  }
}

async function dispatchWorkflow(options, fields) {
  const gh = await commandPath("gh");
  const args = ["workflow", "run", WORKFLOW_FILE, "--repo", options.repository, "--ref", "main"];
  for (const [name, value] of Object.entries(fields)) args.push("--field", `${name}=${value}`);
  await runCommand(gh, args, { timeoutMs: 60_000 });
}

async function listWorkflowRuns(options) {
  const gh = await commandPath("gh");
  const result = await runCommand(gh, [
    "run", "list", "--repo", options.repository, "--workflow", WORKFLOW_FILE,
    "--limit", "1000", "--json", "databaseId,status,conclusion,headSha,displayTitle,event,createdAt,url"
  ], { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 * 1024 });
  try {
    const runs = JSON.parse(result.stdout);
    if (!Array.isArray(runs)) throw new Error("not array");
    return runs;
  } catch {
    stop("github_runs_invalid", "GitHub workflow run inventory was malformed.");
  }
}

async function readWorkflowRunJobs(options, runId) {
  const gh = await commandPath("gh");
  const result = await runCommand(gh, [
    "run", "view", String(runId), "--repo", options.repository, "--json", "jobs"
  ], { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 * 1024 });
  try {
    const payload = JSON.parse(result.stdout);
    if (!Array.isArray(payload.jobs)) throw new Error("not array");
    return payload.jobs;
  } catch {
    stop("github_jobs_invalid", `GitHub run ${runId} returned malformed jobs.`);
  }
}

function assertNoActiveRuns(runs) {
  const active = activeWorkflowRuns(runs);
  if (active.length) stop("ingestion_already_active", `Ingestion already active: ${active.map((run) => run.databaseId).join(", ")}.`);
}

async function waitForWorkflowIdle(options) {
  let announced = false;
  for (;;) {
    const active = activeWorkflowRuns(await listWorkflowRuns(options));
    if (active.length === 0) return;
    if (!announced) {
      process.stdout.write(`Waiting for ${active.length} existing ingestion run(s) before repinning main.\n`);
      announced = true;
    }
    await delay(options.pollSeconds * 1_000);
  }
}

async function waitForDispatchedRun(options, { key, batchSlug, sourceSha }) {
  const deadline = Date.now() + options.appearanceTimeoutSeconds * 1_000;
  do {
    const matches = (await listWorkflowRuns(options)).filter((run) =>
      replayKeyNumber(run.displayTitle, batchSlug) === replayKeyNumber(key, batchSlug)
    );
    if (matches.length > 1) stop("duplicate_replay_key", `${key} appeared as multiple GitHub runs.`);
    if (matches.length === 1) {
      const run = matches[0];
      if (run.event !== "workflow_dispatch" || String(run.headSha).toLowerCase() !== sourceSha) {
        stop("run_source_mismatch", `${key} did not bind to workflow_dispatch at ${sourceSha}.`);
      }
      return run;
    }
    await delay(5_000);
  } while (Date.now() < deadline);
  stop("dispatched_run_not_found", `${key} did not appear within the bounded discovery window.`);
}

async function waitForTerminalRun(options, runId) {
  const gh = await commandPath("gh");
  for (;;) {
    const result = await runCommand(gh, [
      "run", "view", String(runId), "--repo", options.repository,
      "--json", "databaseId,status,conclusion,headSha,displayTitle,event,createdAt,url"
    ], { timeoutMs: 30_000 });
    let run;
    try { run = JSON.parse(result.stdout); } catch { stop("github_run_invalid", `Run ${runId} returned malformed state.`); }
    if (run.status === "completed") return run;
    if (!ACTIVE_RUN_STATUSES.has(run.status)) stop("github_run_invalid", `Run ${runId} has unknown status ${run.status}.`);
    await delay(options.pollSeconds * 1_000);
  }
}

async function downloadRunReceipts(options, pending, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "returner-linkedin-drain-receipts-"));
  try {
    const audit = await downloadReceiptArtifact(options, run.databaseId,
      `autonomous-ingestion-receipt-${run.databaseId}-1`, path.join(root, "audit"));
    if (pending.mode === "final") return { audit };
    const controller = await downloadReceiptArtifact(options, run.databaseId,
      `linkedin-checkpoint-receipt-${pending.batchSlug}-${run.databaseId}-1`, path.join(root, "controller"));
    return { audit, controller };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function downloadReceiptArtifact(options, runId, name, directory) {
  const gh = await commandPath("gh");
  await mkdir(directory, { recursive: true });
  await runCommand(gh, [
    "run", "download", String(runId), "--repo", options.repository,
    "--name", name, "--dir", directory
  ], { timeoutMs: 120_000 });
  const bytes = await readFile(path.join(directory, "receipt.json"));
  return { receipt: parseJsonBytes(bytes, name), sha256: sha256(bytes) };
}

async function resolvePublicationCommit(options, pending, run, audit) {
  await fetchRemoteMain(options);
  const advertised = String(audit?.publishedCommit ?? "").toLowerCase();
  if (/^[0-9a-f]{40}$/.test(advertised)) return advertised;
  const commits = (await runCommand("/usr/bin/git", [
    "rev-list", "--first-parent", `${pending.sourceSha}..refs/remotes/origin/main`
  ], { cwd: options.repoDir })).stdout.trim().split(/\r?\n/).filter(Boolean);
  const matches = [];
  for (const commit of commits) {
    const message = (await runCommand("/usr/bin/git", ["show", "-s", "--format=%s%n%b", commit], { cwd: options.repoDir })).stdout;
    try {
      validatePublicationCommitMessage(message, { key: pending.key, sourceSha: pending.sourceSha, runId: run.databaseId });
      matches.push(commit);
    } catch (error) {
      if (!(error instanceof DrainStopError) || error.code !== "publication_commit_mismatch") throw error;
    }
  }
  if (matches.length !== 1) stop("publication_commit_unresolved", `${pending.key} resolved to ${matches.length} publication commits.`);
  return matches[0];
}

async function assertPublicationCommit(options, { pending, run, publishedSha }) {
  const parent = (await runCommand("/usr/bin/git", ["rev-parse", `${publishedSha}^`], { cwd: options.repoDir })).stdout.trim();
  if (parent !== pending.sourceSha) stop("publication_parent_mismatch", `${publishedSha} is not directly based on ${pending.sourceSha}.`);
  const message = (await runCommand("/usr/bin/git", ["show", "-s", "--format=%s%n%b", publishedSha], { cwd: options.repoDir })).stdout;
  validatePublicationCommitMessage(message, { key: pending.key, sourceSha: pending.sourceSha, runId: run.databaseId });
  const remote = await fetchRemoteMain(options);
  const ancestor = await runCommand("/usr/bin/git", ["merge-base", "--is-ancestor", publishedSha, remote], {
    cwd: options.repoDir, allowFailure: true
  });
  if (ancestor.code !== 0) stop("publication_not_on_main", `${publishedSha} is not reachable from remote main.`);
}

async function verifyCommittedCheckpointCoverage(options, batchSlug, checkpoint, commit = "refs/remotes/origin/main") {
  const published = await readJsonAtCommit(options, commit, "src/lib/social/logged-in-evidence-current.json");
  const durableIds = evidenceIds(checkpoint?.evidence, batchSlug);
  const publishedIds = new Set(evidenceIds(published?.evidence, batchSlug));
  const missing = durableIds.filter((id) => !publishedIds.has(id));
  if (missing.length) stop("checkpoint_publication_gap", `${missing.length} durable ${batchSlug} LinkedIn posts are absent from committed evidence.`);
}

async function waitForPublicParity(options, batchSlug, commit = "refs/remotes/origin/main") {
  const contract = batchContract(batchSlug);
  const manifest = await readJsonAtCommit(options, commit, "public/graph/manifest.json");
  const graphBytes = await readBytesAtCommit(options, commit, `public/graph/${contract.graphFilename}`);
  const graph = parseJsonBytes(graphBytes, `${batchSlug} graph`);
  const entry = manifest.graphArtifacts?.find((item) => item?.filename === contract.graphFilename);
  if (!entry || entry.sha256 !== sha256(graphBytes) || entry.byteSize !== graphBytes.byteLength || entry.generatedAt !== graph.generatedAt) {
    stop("committed_graph_manifest_mismatch", `${batchSlug} committed graph does not match its manifest.`);
  }
  const deadline = Date.now() + options.publicTimeoutMinutes * 60_000;
  let reason = "not attempted";
  do {
    try {
      const [publicManifest, apiGraph] = await Promise.all([
        fetchJson("https://www.returner.fund/graph/manifest.json"),
        fetchJson(`https://www.returner.fund/api/graph?batch=${encodeURIComponent(batchSlug)}`)
      ]);
      if (
        publicManifest.contentHash !== manifest.contentHash ||
        publicManifest.ingestionRunId !== manifest.ingestionRunId ||
        publicManifest.publishedAt !== manifest.publishedAt ||
        apiGraph.generatedAt !== graph.generatedAt ||
        apiGraph.batch?.slug !== batchSlug ||
        apiGraph.evidenceStats?.totalCount !== graph.evidenceStats?.totalCount
      ) throw new Error("deployed manifest/API have not reached the committed graph");
      return;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() < deadline) await delay(Math.min(15_000, deadline - Date.now()));
  } while (Date.now() < deadline);
  stop("public_parity_timeout", `${batchSlug} public parity did not arrive: ${reason}`);
}

async function assertRunnerOnlineAndIdle(options) {
  const gh = await commandPath("gh");
  const result = await runCommand(gh, ["api", `repos/${options.repository}/actions/runners?per_page=100`], { timeoutMs: 30_000 });
  const payload = parseJsonBytes(Buffer.from(result.stdout), "runner inventory");
  const matches = (payload.runners ?? []).filter((runner) => {
    const labels = new Set((runner.labels ?? []).map((label) => label.name));
    return REQUIRED_RUNNER_LABELS.every((label) => labels.has(label));
  });
  if (matches.length !== 1) stop("runner_identity_ambiguous", `Expected one authenticated runner; found ${matches.length}.`);
  if (matches[0].status !== "online" || matches[0].busy !== false) {
    stop("runner_not_idle", `Dedicated runner is ${matches[0].status} and busy=${String(matches[0].busy)}.`);
  }
}

async function assertPhysicalSafety() {
  const battery = await runCommand("/usr/bin/pmset", ["-g", "batt"]);
  const percentages = [...battery.stdout.matchAll(/\b(100|[0-9]{1,2})%;/g)].map((match) => Number(match[1]));
  if (percentages.length !== 1 || percentages[0] <= 5) stop("battery_floor", "Battery is not exactly readable and strictly above 5%.");
  const lid = await runCommand("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "4"]);
  const lidValues = [...lid.stdout.matchAll(/"AppleClamshellState"\s*=\s*(Yes|No)/g)].map((match) => match[1]);
  if (lidValues.length !== 1 || lidValues[0] !== "No") stop("lid_not_open", "The dedicated runner lid is not exactly verified open.");
  const wake = await runCommand("/usr/sbin/ioreg", ["-r", "-k", "IOPMUserTriggeredFullWake", "-d", "4"]);
  const wakeValues = [...wake.stdout.matchAll(/"IOPMUserTriggeredFullWake"\s*=\s*(Yes|No)/g)].map((match) => match[1]);
  if (wakeValues.length !== 1 || wakeValues[0] !== "Yes") stop("full_wake_missing", "The dedicated runner is not in one verified full wake.");
}

async function syncRepositoryToMain(options) {
  const status = (await runCommand("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], { cwd: options.repoDir })).stdout.trim();
  if (status) stop("dirty_checkout", "Foreground drain checkout has tracked changes.");
  const sha = await fetchRemoteMain(options);
  await checkoutDetached(options.repoDir, sha);
  return sha;
}

async function fetchRemoteMain(options) {
  await runCommand("/usr/bin/git", [
    "fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"
  ], { cwd: options.repoDir, timeoutMs: 120_000 });
  const sha = (await runCommand("/usr/bin/git", ["rev-parse", "refs/remotes/origin/main"], { cwd: options.repoDir })).stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) stop("invalid_main_sha", "Remote main returned a malformed SHA.");
  return sha;
}

async function checkoutDetached(repoDir, sha) {
  await runCommand("/usr/bin/git", ["switch", "--detach", sha], { cwd: repoDir, timeoutMs: 60_000 });
}

async function readJsonAtCommit(options, commit, filePath) {
  return parseJsonBytes(await readBytesAtCommit(options, commit, filePath), filePath);
}

async function readBytesAtCommit(options, commit, filePath) {
  const result = await runCommand("/usr/bin/git", ["show", `${commit}:${filePath}`], {
    cwd: options.repoDir,
    maxOutputBytes: 128 * 1024 * 1024
  });
  return result.stdoutBytes;
}

async function readDriverState(options) {
  try {
    const state = JSON.parse(await readFile(options.statePath, "utf8"));
    if (
      state?.schemaVersion !== 2 ||
      state.kind !== "linkedin_checkpoint_backlog_foreground_drain" ||
      state.repository !== options.repository ||
      state.workflow !== WORKFLOW_FILE ||
      !plainObject(state.batches) ||
      BATCH_ORDER.some((batchSlug) => !plainObject(state.batches[batchSlug])) ||
      !Array.isArray(state.completedRuns) ||
      !(state.pending === null || plainObject(state.pending))
    ) {
      stop("driver_state_invalid", `Driver state is malformed: ${options.statePath}.`);
    }
    return state;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schemaVersion: 2,
      kind: "linkedin_checkpoint_backlog_foreground_drain",
      repository: options.repository,
      workflow: WORKFLOW_FILE,
      createdAt: new Date().toISOString(),
      batches: Object.fromEntries(BATCH_ORDER.map((batchSlug) => [batchSlug, { status: "pending", lastRemaining: null }])),
      completedRuns: [],
      pending: null
    };
  }
}

async function writeDriverState(options, state) {
  await mkdir(path.dirname(options.statePath), { recursive: true });
  const temporary = `${options.statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, options.statePath);
}

async function acquireExclusiveLock(lockPath, recoveryLockPath = null) {
  if (recoveryLockPath) await assertNoDriverRecovery(recoveryLockPath);
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch { stop("driver_lock_ambiguous", `Unreadable lock: ${lockPath}.`); }
    if (Number.isSafeInteger(owner?.pid) && processExists(owner.pid)) stop("driver_already_running", `Driver PID ${owner.pid} is already active.`);
    if (recoveryLockPath) await assertNoDriverRecovery(recoveryLockPath);
    await rm(lockPath);
    return acquireExclusiveLock(lockPath, recoveryLockPath);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true });
  };
}

async function assertNoDriverRecovery(recoveryLockPath) {
  try {
    await access(recoveryLockPath, fsConstants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  stop("driver_recovery_active", `A sealed local-state recovery is active: ${recoveryLockPath}.`);
}

function durablePaths(options, batchSlug) {
  const segment = batchContract(batchSlug).batchPath;
  return Object.freeze({
    checkpoint: path.join(options.replayRoot, `logged-in-checkpoint-${segment}.json`),
    output: path.join(options.replayRoot, `logged-in-${segment}.json`)
  });
}

function pendingSnapshot(pending) {
  return {
    checkpointHash: pending.beforeCheckpointHash,
    outputHash: pending.beforeOutputHash,
    attemptDigests: pending.beforeAttemptDigests
  };
}

function serializablePlan(plan) {
  return {
    batchSlug: plan.batchSlug,
    remaining: plan.remaining,
    proof: plan.proof,
    inventoryKeys: plan.inventoryKeys,
    collisionKeys: plan.collisionKeys
  };
}

function hydratePlan(plan) {
  if (!plainObject(plan) || !Array.isArray(plan.inventoryKeys) || !Array.isArray(plan.collisionKeys)) {
    stop("driver_state_invalid", "Pending plan proof is malformed.");
  }
  return plan;
}

function completedRunRecord(pending, run, result) {
  return {
    batchSlug: pending.batchSlug,
    mode: pending.mode,
    key: pending.key,
    runId: Number(run.databaseId),
    runUrl: run.url,
    sourceSha: pending.sourceSha,
    workflowConclusion: run.conclusion,
    beforeRemaining: result.beforeRemaining ?? pending.beforeRemaining,
    afterRemaining: result.afterRemaining,
    completedTargets: result.completedTargets,
    publishedSha: result.publishedSha ?? null,
    completedAt: new Date().toISOString()
  };
}

function evidenceIds(rows, batchSlug) {
  const values = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.platform !== "linkedin" || row?.batchSlug !== batchSlug) continue;
    const nativeId = String(row.platformPostId ?? "").trim();
    if (!nativeId) stop("linkedin_native_id_missing", `${batchSlug} durable LinkedIn evidence lacks a native post id.`);
    values.push(nativeId);
  }
  return [...new Set(values)].sort();
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
  })).sort((left, right) => `${left.platform}:${left.accountIdentity}`.localeCompare(`${right.platform}:${right.accountIdentity}`));
}

function batchContract(batchSlug) {
  const contract = BATCH_CONTRACTS[batchSlug];
  if (!contract) stop("invalid_batch", `Unsupported batch: ${batchSlug}.`);
  return contract;
}

function parseJsonBytes(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!plainObject(value)) throw new Error("not object");
    return value;
  } catch {
    stop("json_artifact_invalid", `${label} is not one valid JSON object.`);
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedInteger(value, label, minimum, maximum) {
  if (!/^[0-9]+$/.test(String(value))) stop("invalid_argument", `--${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    stop("invalid_argument", `--${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

async function commandPath(command) {
  const result = await runCommand("/usr/bin/which", [command], { allowFailure: true });
  const resolved = result.stdout.trim();
  if (result.code !== 0 || !resolved) stop("missing_command", `${command} is not on PATH.`);
  return resolved;
}

async function runCommand(command, args, {
  cwd,
  env = process.env,
  timeoutMs = 30_000,
  maxOutputBytes = 4 * 1024 * 1024,
  allowFailure = false
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) overflow = true;
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) overflow = true;
      else stderr.push(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const result = {
        code: code ?? -1,
        signal,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: stderrBuffer.toString("utf8"),
        stdoutBytes: stdoutBuffer
      };
      if (overflow) return rejectPromise(new DrainStopError("command_output_overflow", `${path.basename(command)} output exceeded its bound.`));
      if (timedOut) return rejectPromise(new DrainStopError("command_timeout", `${path.basename(command)} timed out.`));
      if (result.code !== 0 && !allowFailure) {
        return rejectPromise(new DrainStopError("command_failed", `${path.basename(command)} exited ${result.code}: ${result.stderr.trim().slice(-1000)}`));
      }
      resolvePromise(result);
    });
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function usage() {
  return [
    "Usage:",
    `  node ${SCRIPT_PATH} --plan-only`,
    `  node ${SCRIPT_PATH} --dry-run`,
    `  node ${SCRIPT_PATH} --execute`,
    "",
    "This is a resumable foreground one-off process. It creates no daemon, automation, or schedule.",
    "It drains S26 before S2026, using checkpoint-only runs until <=20 remain, then publishes once.",
    "Optional: --repo-dir=PATH --repository=OWNER/REPO --state-file=PATH",
    "          --poll-seconds=30 --appearance-timeout-seconds=180",
    "          --public-timeout-minutes=20 --max-dispatches=999",
    "          --adopt-run=RUN_ID (only for the already-started exact S26 key 001 run)"
  ].join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  main().catch((error) => {
    if (error instanceof DrainStopError) {
      process.stderr.write(`[stopped:${error.code}] ${error.message}\n`);
      if (error.details?.runUrl) process.stderr.write(`Run: ${error.details.runUrl}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`[failed:unexpected] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
