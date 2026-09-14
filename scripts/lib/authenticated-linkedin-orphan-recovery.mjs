import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  authenticatedSocialReplayRoot,
  LINKEDIN_CHECKPOINT_BATCH_CONTRACTS,
  S2026_CHECKPOINT_AC_MAX_CHUNKS,
  S2026_CHECKPOINT_BATTERY_MAX_CHUNKS,
  S2026_CHECKPOINT_TARGET_CAP
} from "../collect-s2026-linkedin-checkpoints.mjs";
import {
  LINKEDIN_ACCOUNT_LOCK_PATH,
  LINKEDIN_ACCOUNT_PACING_STATE_PATH,
  LINKEDIN_GLOBAL_LEASE_DURATION_MS,
  LINKEDIN_MINIMUM_TARGET_DELAY_MS,
  linkedinGlobalLockKey
} from "./logged-in-linkedin-collection.mjs";

const execFile = promisify(execFileCallback);
const LOCK_TABLE = "ingestion_runtime_locks";
const LOCK_COLUMNS = [
  "lock_key",
  "owner_id",
  "lease_token",
  "heartbeat_at",
  "lease_expires_at",
  "metadata_json",
  "created_at",
  "updated_at"
].join(",");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const MAX_LOCAL_EVIDENCE_BYTES = 128 * 1024 * 1024;
const ACCOUNT_JOB_LABELS = Object.freeze([
  "ARM64",
  "macOS",
  "returner-auth-browser",
  "returner-social",
  "self-hosted"
]);
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending"
]);

export const AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASES =
  Object.freeze(["inspect", "apply"]);
export const AUTHENTICATED_LINKEDIN_ORPHAN_OBSERVATION_DELAY_MS = 5_000;

export function validateAuthenticatedLinkedInOrphanRecoveryRequest(
  env = process.env
) {
  const value = (name) => clean(env[name]);
  const phase = value("AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASE");
  const batchSlug = value("AUTHENTICATED_BACKFILL_BATCH");
  const companySlug = value("AUTHENTICATED_BACKFILL_COMPANY_SLUG");
  const namespace = value("LINKEDIN_GLOBAL_LOCK_NAMESPACE");
  const canceledRunId = value(
    "AUTHENTICATED_LINKEDIN_ORPHAN_CANCELED_RUN_ID"
  );
  const canceledRunAttempt = value(
    "AUTHENTICATED_LINKEDIN_ORPHAN_CANCELED_RUN_ATTEMPT"
  );
  const idempotencyKey = value(
    "AUTHENTICATED_LINKEDIN_ORPHAN_IDEMPOTENCY_KEY"
  );
  const targetKey = value("AUTHENTICATED_LINKEDIN_ORPHAN_TARGET_KEY");
  const expectedFingerprint = value(
    "AUTHENTICATED_LINKEDIN_ORPHAN_EXPECTED_FINGERPRINT"
  );
  const currentRunId = value("GITHUB_RUN_ID");
  const currentRunAttempt = value("GITHUB_RUN_ATTEMPT");
  const currentSourceSha = value("GITHUB_SHA");
  const currentRef = value("GITHUB_REF");
  const currentRefType = value("GITHUB_REF_TYPE");
  const repository = value("GITHUB_REPOSITORY");
  const runnerName = value("RUNNER_NAME");
  const openCliHome = value("OPENCLI_HOME");
  const canceledRunNumber = Number(canceledRunId);
  const canceledAttemptNumber = Number(canceledRunAttempt);
  const currentRunNumber = Number(currentRunId);
  const currentAttemptNumber = Number(currentRunAttempt);
  const backlogKeyPattern = new RegExp(
    "^incident-20260913-" +
      String(batchSlug).toLowerCase() +
      "-linkedin-backlog-(?!000)[0-9]{3}$"
  );
  const targetPrefix =
    batchSlug + ":linkedin:company-" + companySlug + ":";

  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.RECOVER_AUTHENTICATED_LINKEDIN_LOCK !== "true" ||
    env.AUTHENTICATED_SOCIAL_PREFLIGHT_PASSED !== "true" ||
    env.AUTHENTICATED_SOCIAL_REPLAY !== "true" ||
    env.AUTHENTICATED_BACKFILL_SCOPE !== "linkedin" ||
    !AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASES.includes(phase) ||
    !["S26", "S2026"].includes(batchSlug) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(companySlug || "") ||
    !NAMESPACE_PATTERN.test(namespace || "") ||
    !POSITIVE_INTEGER_PATTERN.test(canceledRunId || "") ||
    !POSITIVE_INTEGER_PATTERN.test(canceledRunAttempt || "") ||
    !POSITIVE_INTEGER_PATTERN.test(currentRunId || "") ||
    !POSITIVE_INTEGER_PATTERN.test(currentRunAttempt || "") ||
    !Number.isSafeInteger(canceledRunNumber) ||
    !Number.isSafeInteger(canceledAttemptNumber) ||
    !Number.isSafeInteger(currentRunNumber) ||
    !Number.isSafeInteger(currentAttemptNumber) ||
    !GIT_SHA_PATTERN.test(currentSourceSha || "") ||
    currentRef !== "refs/heads/main" ||
    currentRefType !== "branch" ||
    canceledRunId === currentRunId ||
    !backlogKeyPattern.test(idempotencyKey || "") ||
    !String(targetKey).startsWith(targetPrefix) ||
    !/^https:\/\/(?:www\.)?linkedin\.com\/company\/[^/?#]+\/?$/.test(
      String(targetKey).slice(targetPrefix.length)
    ) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") ||
    !runnerName ||
    !openCliHome ||
    (phase === "inspect" && expectedFingerprint) ||
    (phase === "apply" &&
      !SHA256_PATTERN.test(expectedFingerprint || ""))
  ) {
    throw recoveryError("request identity was incomplete or inconsistent");
  }

  const lockKey = linkedinGlobalLockKey(namespace);
  if (
    !lockKey.startsWith("authenticated-linkedin:") ||
    /checkpoint-controller/i.test(lockKey)
  ) {
    throw recoveryError("refused a non-account or controller lock key");
  }
  return Object.freeze({
    phase,
    batchSlug,
    companySlug,
    lockKey,
    canceledRunId: canceledRunNumber,
    canceledRunAttempt: canceledAttemptNumber,
    idempotencyKey,
    targetKey,
    expectedFingerprint,
    currentRunId: currentRunNumber,
    currentRunAttempt: currentAttemptNumber,
    currentSourceSha,
    currentRef,
    repository,
    runnerName,
    openCliHome
  });
}

export async function runAuthenticatedLinkedInOrphanRecovery(
  client,
  request,
  options = {}
) {
  const dependencies = {
    now: options.now || Date.now,
    sleep: options.sleep || defaultSleep,
    readWorkflowRun: options.readWorkflowRun || defaultReadWorkflowRun,
    readWorkflowJobs: options.readWorkflowJobs || defaultReadWorkflowJobs,
    readActiveWorkflowRuns:
      options.readActiveWorkflowRuns || defaultReadActiveWorkflowRuns,
    processIsAlive: options.processIsAlive || defaultProcessIsAlive,
    readProcessInventory:
      options.readProcessInventory || defaultReadProcessInventory,
    readJsonEvidence:
      options.readJsonEvidence || defaultReadJsonEvidence,
    pathExists: options.pathExists || defaultPathExists,
    withLocalRecoveryGuard:
      options.withLocalRecoveryGuard || defaultWithLocalRecoveryGuard
  };
  const observationDelayMs =
    options.observationDelayMs ??
    AUTHENTICATED_LINKEDIN_ORPHAN_OBSERVATION_DELAY_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? 15_000;
  const lockPath = options.lockPath || LINKEDIN_ACCOUNT_LOCK_PATH;
  const pacingPath =
    options.pacingPath || LINKEDIN_ACCOUNT_PACING_STATE_PATH;
  if (
    !client ||
    typeof client.from !== "function" ||
    typeof client.rpc !== "function" ||
    Object.values(dependencies).some((item) => typeof item !== "function") ||
    !Number.isSafeInteger(observationDelayMs) ||
    observationDelayMs < 0 ||
    observationDelayMs > 30_000
  ) {
    throw recoveryError("dependencies or observation delay were invalid");
  }

  const inspect = async ({ acquisitionGuardHeld = false } = {}) => {
    const row = await readExactLockRow(
      client,
      request.lockKey,
      operationTimeoutMs
    );
    return readEvidence({
      request,
      row,
      lockPath,
      pacingPath,
      acquisitionGuardHeld,
      ...dependencies
    });
  };
  const first = await inspect();
  await dependencies.sleep(observationDelayMs);
  const second = await inspect();
  const firstFingerprint = orphanEvidenceFingerprint(first);
  const fingerprint = orphanEvidenceFingerprint(second);
  if (firstFingerprint !== fingerprint) {
    throw recoveryError("evidence changed during stable observation");
  }
  if (request.phase === "inspect") {
    return redactedResult("inspection_ready", request, second, fingerprint);
  }
  if (request.expectedFingerprint !== fingerprint) {
    throw recoveryError("apply fingerprint did not match inspection");
  }
  return dependencies.withLocalRecoveryGuard({
    guardPath: lockPath + ".acquire",
    now: dependencies.now,
    operation: async () => {
      const guarded = await inspect({ acquisitionGuardHeld: true });
      if (orphanEvidenceFingerprint(guarded) !== fingerprint) {
        throw recoveryError("evidence changed after local guard acquisition");
      }
      const released = await bounded(
        () =>
          client.rpc("release_ingestion_runtime_lock", {
            p_lock_key: request.lockKey,
            p_owner_id: guarded.row.owner_id,
            p_lease_token: guarded.row.lease_token
          }),
        operationTimeoutMs,
        "owner/token-fenced release",
        { requireAbortable: true }
      );
      if (released?.error || released?.data !== true) {
        throw recoveryError("owner/token-fenced release was not confirmed");
      }
      const verification = await bounded(
        () =>
          client
            .from(LOCK_TABLE)
            .select("lock_key")
            .eq("lock_key", request.lockKey)
            .maybeSingle(),
        operationTimeoutMs,
        "post-release verification"
      );
      if (verification?.error || verification?.data !== null) {
        throw recoveryError("could not verify exact account-lock deletion");
      }
      return redactedResult("released", request, guarded, fingerprint);
    }
  });
}

export function orphanEvidenceFingerprint(evidence) {
  const row = evidence?.row || {};
  return sha256(canonicalJson({
    schemaVersion: 1,
    lock: {
      lockKey: row.lock_key,
      ownerId: row.owner_id,
      leaseTokenSha256: sha256(String(row.lease_token || "")),
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata_json
    },
    localLock: {
      pid: evidence?.localLock?.pid,
      tokenSha256: sha256(String(evidence?.localLock?.token || "")),
      acquiredAt: evidence?.localLock?.acquiredAt
    },
    pacing: {
      version: evidence?.pacing?.version,
      phase: evidence?.pacing?.phase,
      pid: evidence?.pacing?.pid,
      attemptTokenSha256: sha256(
        String(evidence?.pacing?.attemptToken || "")
      ),
      lastTargetAttemptAtMs: evidence?.pacing?.lastTargetAttemptAtMs,
      lastTargetAttemptAt: evidence?.pacing?.lastTargetAttemptAt
    },
    localFiles: evidence?.localFileProof,
    controller: evidence?.controllerProof,
    workflow: evidence?.workflowProof,
    runnerName: evidence?.runnerName,
    recoverySourceSha: evidence?.recoverySourceSha,
    browserProof: evidence?.browserProof
  }));
}

async function readEvidence(input) {
  const { request, row, lockPath, pacingPath } = input;
  validateLegacyRow(row, request.lockKey);
  const pid = row.metadata_json.pid;
  const nowMs = Number(input.now());
  if (
    !Number.isFinite(nowMs) ||
    nowMs <
      Date.parse(row.lease_expires_at) + LINKEDIN_MINIMUM_TARGET_DELAY_MS
  ) {
    throw recoveryError("ordinary lease expiry cooldown has not elapsed");
  }
  if (
    !input.acquisitionGuardHeld &&
    await input.pathExists(lockPath + ".acquire")
  ) {
    throw recoveryError("local lock acquisition is active or unproven");
  }
  const localLockFile = await input.readJsonEvidence(lockPath);
  const pacingFile = await input.readJsonEvidence(pacingPath);
  const localLock = localLockFile.value;
  const pacing = pacingFile.value;
  validateLocalState(localLock, pacing, pid, nowMs);
  if (input.processIsAlive(pid)) {
    throw recoveryError("exact orphan PID is still alive");
  }
  const inventory = String(await input.readProcessInventory());
  if (
    /(?:fetch-logged-in-social-traction|collect-s2026-linkedin-checkpoints|run-autonomous-ingestion|linkedin-checkpoint-backlog-drain|recover-cancelled-s26-linkedin-run001)\.mjs/i.test(
      inventory
    )
  ) {
    throw recoveryError("another local collector or controller is active");
  }

  const stateRoot = authenticatedSocialReplayRoot(request.openCliHome);
  const controllerFile = await input.readJsonEvidence(join(
    stateRoot,
    "checkpoint-collection-runs",
    request.idempotencyKey + ".json"
  ));
  const checkpointFile = await input.readJsonEvidence(join(
    stateRoot,
    "logged-in-checkpoint-" +
      request.batchSlug.toLowerCase() +
      ".json"
  ));
  const outputFile = await input.readJsonEvidence(join(
    stateRoot,
    "logged-in-" + request.batchSlug.toLowerCase() + ".json"
  ));
  const controller = controllerFile.value;
  const checkpoint = checkpointFile.value;
  if (!plainObject(outputFile.value)) {
    throw recoveryError("authenticated output evidence was malformed");
  }
  const controllerProof = validateController(controller, checkpoint, request);
  if (
    outputFile.sha256 !== controller.currentOutputSha256 ||
    (controllerProof.completedPrefixCount === 0 &&
      checkpointFile.sha256 !== controller.currentCheckpointSha256) ||
    (controllerProof.completedPrefixCount > 0 &&
      checkpointFile.sha256 === controller.currentCheckpointSha256)
  ) {
    throw recoveryError("raw checkpoint/output did not match pending intent");
  }
  const workflow = await input.readWorkflowRun(request);
  const jobs = await input.readWorkflowJobs(request);
  const workflowProof = validateCanceledRun({
    workflow,
    jobs,
    request,
    controller,
    row,
    localLock,
    pacing
  });
  const activeRuns = await input.readActiveWorkflowRuns(request);
  if (
    !Array.isArray(activeRuns) ||
    activeRuns.some(
      (run) =>
        ACTIVE_RUN_STATUSES.has(String(run?.status || "")) &&
        Number(run?.id) !== request.currentRunId
    )
  ) {
    throw recoveryError("another autonomous-ingestion workflow is active");
  }
  return {
    row,
    localLock,
    pacing,
    localFileProof: {
      collectorLock: redactedFileProof(localLockFile),
      pacingState: redactedFileProof(pacingFile),
      controllerState: redactedFileProof(controllerFile),
      checkpoint: redactedFileProof(checkpointFile),
      output: redactedFileProof(outputFile)
    },
    controllerProof,
    workflowProof,
    runnerName: request.runnerName,
    recoverySourceSha: request.currentSourceSha,
    browserProof: "authenticated-social-preflight-passed"
  };
}

function validateLegacyRow(row, lockKey) {
  const metadata = row?.metadata_json;
  const keys =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? Object.keys(metadata).sort()
      : [];
  if (
    row?.lock_key !== lockKey ||
    /checkpoint-controller/i.test(String(row?.lock_key || "")) ||
    !UUID_PATTERN.test(String(row?.owner_id || "")) ||
    !UUID_PATTERN.test(String(row?.lease_token || "")) ||
    keys.join(",") !== "collector,pid" ||
    metadata.collector !== "authenticated-linkedin" ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    !validTimestamp(row.heartbeat_at) ||
    !validTimestamp(row.lease_expires_at) ||
    !validTimestamp(row.created_at) ||
    !validTimestamp(row.updated_at) ||
    Date.parse(row.created_at) > Date.parse(row.heartbeat_at) ||
    Date.parse(row.heartbeat_at) > Date.parse(row.lease_expires_at) ||
    Date.parse(row.updated_at) > Date.parse(row.lease_expires_at) ||
    Math.abs(
      Date.parse(row.lease_expires_at) -
        Date.parse(row.heartbeat_at) -
        LINKEDIN_GLOBAL_LEASE_DURATION_MS
    ) > 2_000
  ) {
    throw recoveryError("row was not the exact legacy ordinary lease");
  }
}

function validateLocalState(lock, pacing, pid, nowMs) {
  const lockKeys = plainObject(lock) ? Object.keys(lock).sort() : [];
  const pacingKeys = plainObject(pacing) ? Object.keys(pacing).sort() : [];
  if (
    lockKeys.join(",") !== "acquiredAt,pid,token" ||
    lock?.pid !== pid ||
    !UUID_PATTERN.test(String(lock?.token || "")) ||
    !validTimestamp(lock?.acquiredAt) ||
    pacingKeys.join(",") !==
      "attemptToken,lastTargetAttemptAt,lastTargetAttemptAtMs,phase,pid,version" ||
    pacing?.version !== 1 ||
    pacing?.phase !== "in_progress" ||
    pacing?.pid !== pid ||
    !UUID_PATTERN.test(String(pacing?.attemptToken || "")) ||
    !Number.isFinite(pacing?.lastTargetAttemptAtMs) ||
    !validTimestamp(pacing?.lastTargetAttemptAt) ||
    Math.abs(
      Date.parse(pacing.lastTargetAttemptAt) -
        pacing.lastTargetAttemptAtMs
    ) > 1_000 ||
    nowMs <
      pacing.lastTargetAttemptAtMs + LINKEDIN_MINIMUM_TARGET_DELAY_MS
  ) {
    throw recoveryError("local lock and pacing did not match orphan PID");
  }
}

function validateController(controller, checkpoint, request) {
  const selected = controller?.intent?.selectedKeys;
  const before = controller?.intent?.beforeAttempts;
  const attempts = checkpoint?.attempts;
  if (
    !plainObject(controller) ||
    Object.keys(controller).sort().join(",") !==
      "acChunks,batteryChunks,beforeCheckpointSha256,beforeOutputSha256," +
      "beforeRemaining,chunkReceipts,chunksCompleted,completedTargets," +
      "currentCheckpointSha256,currentOutputSha256,currentRemaining," +
      "expectedCheckpointSha256,expectedRemaining,idempotencyKey,intent," +
      "kind,schemaVersion,sourceSha,startedAt,status" ||
    controller?.schemaVersion !== 1 ||
    controller?.kind !== "s2026_linkedin_checkpoint_collection_state" ||
    controller?.status !== "running" ||
    controller?.idempotencyKey !== request.idempotencyKey ||
    !GIT_SHA_PATTERN.test(String(controller?.sourceSha || "")) ||
    !validTimestamp(controller?.startedAt) ||
    !SHA256_PATTERN.test(controller?.expectedCheckpointSha256 || "") ||
    !SHA256_PATTERN.test(controller?.beforeCheckpointSha256 || "") ||
    !SHA256_PATTERN.test(controller?.beforeOutputSha256 || "") ||
    !SHA256_PATTERN.test(controller?.currentCheckpointSha256 || "") ||
    !SHA256_PATTERN.test(controller?.currentOutputSha256 || "") ||
    controller.expectedCheckpointSha256 !==
      controller.beforeCheckpointSha256 ||
    !nonnegativeInteger(controller?.expectedRemaining) ||
    !nonnegativeInteger(controller?.beforeRemaining) ||
    !nonnegativeInteger(controller?.currentRemaining) ||
    controller.expectedRemaining !== controller.beforeRemaining ||
    controller.beforeRemaining < controller.currentRemaining ||
    controller.beforeRemaining >
      LINKEDIN_CHECKPOINT_BATCH_CONTRACTS[request.batchSlug].targetCount ||
    !nonnegativeInteger(controller?.completedTargets) ||
    controller.completedTargets !==
      controller.beforeRemaining - controller.currentRemaining ||
    !nonnegativeInteger(controller?.chunksCompleted) ||
    controller.chunksCompleted > S2026_CHECKPOINT_AC_MAX_CHUNKS ||
    !nonnegativeInteger(controller?.batteryChunks) ||
    controller.batteryChunks > S2026_CHECKPOINT_BATTERY_MAX_CHUNKS ||
    !nonnegativeInteger(controller?.acChunks) ||
    controller.acChunks > S2026_CHECKPOINT_AC_MAX_CHUNKS ||
    controller.batteryChunks + controller.acChunks !==
      controller.chunksCompleted ||
    !Array.isArray(controller?.chunkReceipts) ||
    controller.chunkReceipts.length !== controller.chunksCompleted ||
    !plainObject(controller?.intent) ||
    Object.keys(controller.intent).sort().join(",") !==
      "beforeAttempts,beforeRemaining,checkpointSha256Before,chunkNumber," +
      "outputSha256Before,powerMode,selectedKeys" ||
    controller.intent.chunkNumber !== controller.chunksCompleted + 1 ||
    !["ac", "battery"].includes(controller.intent.powerMode) ||
    controller.intent.beforeRemaining !== controller.currentRemaining ||
    controller.intent.checkpointSha256Before !==
      controller.currentCheckpointSha256 ||
    controller.intent.outputSha256Before !== controller.currentOutputSha256 ||
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > S2026_CHECKPOINT_TARGET_CAP ||
    selected.length !==
      Math.min(S2026_CHECKPOINT_TARGET_CAP, controller.currentRemaining) ||
    new Set(selected).size !== selected.length ||
    selected.some((key) => typeof key !== "string" || !key) ||
    !plainObject(before) ||
    !plainObject(checkpoint) ||
    !plainObject(attempts)
  ) {
    throw recoveryError("canceled controller intent was malformed");
  }
  validateChunkReceiptChain(controller);

  const selectedSet = new Set(selected);
  const allAttemptKeys = new Set([
    ...Object.keys(before),
    ...Object.keys(attempts)
  ]);
  if (
    [...allAttemptKeys].some(
      (key) =>
        !selectedSet.has(key) &&
        canonicalJson(before[key]) !== canonicalJson(attempts[key])
    ) ||
    selected.some((key) => before[key]?.status === "done")
  ) {
    throw recoveryError("checkpoint changed outside pending intent");
  }

  let completedPrefixCount = 0;
  let foundUnchanged = false;
  for (const key of selected) {
    const unchanged = canonicalJson(before[key]) === canonicalJson(attempts[key]);
    if (unchanged) {
      foundUnchanged = true;
      continue;
    }
    if (foundUnchanged || attempts[key]?.status !== "done") {
      throw recoveryError("checkpoint was not an exact serial prefix");
    }
    completedPrefixCount += 1;
  }
  if (
    completedPrefixCount >= selected.length ||
    selected[completedPrefixCount] !== request.targetKey
  ) {
    throw recoveryError("checkpoint did not prove exact interrupted target");
  }
  return {
    idempotencyKey: controller.idempotencyKey,
    sourceSha: controller.sourceSha,
    chunkNumber: controller.intent.chunkNumber,
    targetKeySha256: sha256(selected[completedPrefixCount]),
    selectedKeysSha256: sha256(selected.join("\n")),
    beforeAttemptsSha256: sha256(canonicalJson(before)),
    controllerSha256: sha256(canonicalJson(controller)),
    checkpointSha256: sha256(canonicalJson(checkpoint)),
    completedPrefixCount
  };
}

function validateChunkReceiptChain(controller) {
  let remaining = controller.beforeRemaining;
  let completedTargets = 0;
  let batteryChunks = 0;
  let acChunks = 0;
  let checkpointSha256 = controller.beforeCheckpointSha256;
  let outputSha256 = controller.beforeOutputSha256;
  for (const [index, receipt] of controller.chunkReceipts.entries()) {
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
      receipt.afterRemaining !==
        receipt.beforeRemaining - receipt.completedTargets ||
      !SHA256_PATTERN.test(receipt.completedKeysSha256 || "") ||
      !SHA256_PATTERN.test(receipt.checkpointSha256After || "") ||
      !SHA256_PATTERN.test(receipt.outputSha256After || "")
    ) {
      throw recoveryError("controller chunk receipt chain was malformed");
    }
    remaining = receipt.afterRemaining;
    checkpointSha256 = receipt.checkpointSha256After;
    outputSha256 = receipt.outputSha256After;
    completedTargets += receipt.completedTargets;
    if (receipt.powerMode === "battery") batteryChunks += 1;
    else acChunks += 1;
  }
  if (
    remaining !== controller.currentRemaining ||
    checkpointSha256 !== controller.currentCheckpointSha256 ||
    outputSha256 !== controller.currentOutputSha256 ||
    completedTargets !== controller.completedTargets ||
    batteryChunks !== controller.batteryChunks ||
    acChunks !== controller.acChunks
  ) {
    throw recoveryError("controller chunk receipt chain was inconsistent");
  }
}

function validateCanceledRun({
  workflow,
  jobs,
  request,
  controller,
  row,
  localLock,
  pacing
}) {
  const expectedRunName =
    "Autonomous ingestion candidate " + request.idempotencyKey;
  const expectedJobName = "Publish accepted slot " + request.idempotencyKey;
  if (
    Number(workflow?.id) !== request.canceledRunId ||
    Number(workflow?.run_attempt) !== request.canceledRunAttempt ||
    workflow?.name !== expectedRunName ||
    workflow?.display_title !== expectedRunName ||
    workflow?.status !== "completed" ||
    workflow?.conclusion !== "cancelled" ||
    workflow?.event !== "workflow_dispatch" ||
    workflow?.head_sha !== controller.sourceSha ||
    workflow?.head_branch !== "main" ||
    workflow?.head_repository?.full_name !== request.repository ||
    workflow?.repository?.full_name !== request.repository ||
    workflow?.path !== ".github/workflows/autonomous-ingestion.yml" ||
    !validTimestamp(workflow?.created_at) ||
    !validTimestamp(workflow?.run_started_at) ||
    !validTimestamp(workflow?.updated_at) ||
    !Array.isArray(jobs)
  ) {
    throw recoveryError("GitHub did not prove exact canceled workflow");
  }

  const matches = jobs.filter((job) => job?.name === expectedJobName);
  const job = matches.length === 1 ? matches[0] : null;
  const labels = Array.isArray(job?.labels)
    ? [...job.labels].sort()
    : [];
  const preflight = exactWorkflowStep(
    job,
    "Preflight authenticated social runner"
  );
  const collection = exactWorkflowStep(
    job,
    "Collect bounded 2026 LinkedIn checkpoints"
  );
  if (
    !job ||
    !Number.isSafeInteger(job.id) ||
    job.id <= 0 ||
    job.status !== "completed" ||
    job.conclusion !== "cancelled" ||
    job.runner_name !== request.runnerName ||
    job.runner_group_name !== "Default" ||
    labels.join(",") !== ACCOUNT_JOB_LABELS.join(",") ||
    !validTimestamp(job.started_at) ||
    !validTimestamp(job.completed_at) ||
    preflight?.status !== "completed" ||
    preflight?.conclusion !== "success" ||
    !validTimestamp(preflight?.started_at) ||
    !validTimestamp(preflight?.completed_at) ||
    collection?.status !== "completed" ||
    collection?.conclusion !== "cancelled" ||
    !validTimestamp(collection?.started_at) ||
    !validTimestamp(collection?.completed_at)
  ) {
    throw recoveryError("GitHub did not prove exact canceled runner job");
  }

  const orderedTimes = [
    workflow.created_at,
    workflow.run_started_at,
    job.started_at,
    preflight.started_at,
    preflight.completed_at,
    collection.started_at,
    controller.startedAt,
    row.created_at,
    localLock.acquiredAt,
    pacing.lastTargetAttemptAt,
    collection.completed_at,
    job.completed_at,
    workflow.updated_at
  ].map((value) => Date.parse(value));
  if (
    orderedTimes.some((value) => !Number.isFinite(value)) ||
    orderedTimes.some(
      (value, index) => index > 0 && value < orderedTimes[index - 1]
    ) ||
    Date.parse(row.heartbeat_at) < Date.parse(row.created_at) ||
    Date.parse(row.heartbeat_at) > Date.parse(collection.completed_at) ||
    Date.parse(row.updated_at) < Date.parse(row.created_at) ||
    Date.parse(row.updated_at) > Date.parse(collection.completed_at)
  ) {
    throw recoveryError("legacy evidence was outside canceled job timing");
  }
  return {
    id: Number(workflow.id),
    runAttempt: Number(workflow.run_attempt),
    status: workflow.status,
    conclusion: workflow.conclusion,
    event: workflow.event,
    headSha: workflow.head_sha,
    repository: workflow.repository.full_name,
    path: workflow.path,
    runName: workflow.name,
    runStartedAt: workflow.run_started_at,
    runUpdatedAt: workflow.updated_at,
    jobId: job.id,
    jobName: job.name,
    runnerName: job.runner_name,
    runnerGroupName: job.runner_group_name,
    labelsSha256: sha256(labels.join("\n")),
    jobStartedAt: job.started_at,
    jobCompletedAt: job.completed_at,
    collectionStartedAt: collection.started_at,
    collectionCompletedAt: collection.completed_at
  };
}

async function readExactLockRow(client, lockKey, timeoutMs) {
  const result = await bounded(
    () =>
      client
        .from(LOCK_TABLE)
        .select(LOCK_COLUMNS)
        .eq("lock_key", lockKey)
        .maybeSingle(),
    timeoutMs,
    "exact account-lock lookup"
  );
  if (result?.error || !result?.data) {
    throw recoveryError("could not read exact ordinary lease");
  }
  return result.data;
}

async function defaultWithLocalRecoveryGuard({ guardPath, now, operation }) {
  if (
    typeof guardPath !== "string" ||
    !guardPath.endsWith(".lock.acquire") ||
    typeof now !== "function" ||
    typeof operation !== "function"
  ) {
    throw recoveryError("local acquisition-guard request was invalid");
  }
  const acquiredAtMs = Number(now());
  if (!Number.isFinite(acquiredAtMs)) {
    throw recoveryError("local acquisition-guard clock was invalid");
  }
  const guard = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date(acquiredAtMs).toISOString()
  };

  let handle = null;
  let primaryError = null;
  let result;
  try {
    handle = await open(guardPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(guard));
    await handle.sync();
    result = await operation();
  } catch (error) {
    primaryError = error?.code === "EEXIST"
      ? recoveryError("another local lock acquisition was active")
      : error;
  }

  let cleanupError = null;
  try {
    await handle?.close();
    if (handle) {
      const current = await defaultReadJson(guardPath);
      if (canonicalJson(current) !== canonicalJson(guard)) {
        throw recoveryError("local acquisition-guard ownership changed");
      }
      await unlink(guardPath);
    }
  } catch {
    cleanupError = recoveryError(
      "local acquisition-guard cleanup was not confirmed"
    );
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) {
    if (
      primaryError instanceof Error &&
      primaryError.message.startsWith(
        "Authenticated LinkedIn orphan recovery "
      )
    ) {
      throw primaryError;
    }
    throw recoveryError("local guarded operation failed closed");
  }
  return result;
}

async function defaultReadWorkflowRun(request) {
  return githubJson(
    request,
    "/repos/" +
      request.repository +
      "/actions/runs/" +
      request.canceledRunId
  );
}

async function defaultReadWorkflowJobs(request) {
  const payload = await githubJson(
    request,
    "/repos/" +
      request.repository +
      "/actions/runs/" +
      request.canceledRunId +
      "/attempts/" +
      request.canceledRunAttempt +
      "/jobs?per_page=100"
  );
  if (
    !Array.isArray(payload?.jobs) ||
    !Number.isSafeInteger(payload?.total_count) ||
    payload.total_count !== payload.jobs.length
  ) {
    throw recoveryError("canceled workflow jobs proof was incomplete");
  }
  return payload.jobs;
}

async function defaultReadActiveWorkflowRuns(request) {
  const workflowFiles = [
    "autonomous-ingestion.yml",
    "recover-authenticated-linkedin-orphan.yml"
  ];
  const groups = await Promise.all(
    workflowFiles.flatMap((workflowFile) =>
      [...ACTIVE_RUN_STATUSES].map(async (status) => {
      const payload = await githubJson(
        request,
        "/repos/" +
          request.repository +
          "/actions/workflows/" +
          workflowFile +
          "/runs?status=" +
          status +
          "&per_page=100"
      );
      if (
        !Array.isArray(payload?.workflow_runs) ||
        !Number.isSafeInteger(payload?.total_count) ||
        payload.total_count !== payload.workflow_runs.length
      ) {
        throw recoveryError("active workflow proof was incomplete");
      }
      return payload.workflow_runs;
      })
    )
  );
  return groups.flat();
}

async function githubJson(_request, path) {
  const token = clean(process.env.GITHUB_TOKEN);
  if (!token) throw recoveryError("GitHub proof token was missing");
  const response = await fetch("https://api.github.com" + path, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw recoveryError("GitHub proof lookup failed closed");
  return response.json();
}

async function defaultReadProcessInventory() {
  const result = await execFile("/bin/ps", ["-axo", "pid=,command="], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return result.stdout;
}

function defaultProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function defaultReadJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw recoveryError("required local evidence was unreadable");
  }
}

async function defaultReadJsonEvidence(path) {
  try {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > MAX_LOCAL_EVIDENCE_BYTES
    ) {
      throw new Error("invalid evidence file");
    }
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size
    ) {
      throw new Error("evidence changed while reading");
    }
    return {
      value: JSON.parse(bytes.toString("utf8")),
      sha256: sha256(bytes),
      size: before.size,
      device: before.dev,
      inode: before.ino,
      modifiedAtMs: before.mtimeMs
    };
  } catch {
    throw recoveryError("required exact local evidence was unreadable");
  }
}

async function defaultPathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw recoveryError("local guard inspection failed");
  }
}

async function bounded(
  operation,
  timeoutMs,
  label,
  { requireAbortable = false } = {}
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 60_000
  ) {
    throw recoveryError("operation timeout was invalid");
  }
  const controller = new AbortController();
  const timeoutError = recoveryError(label + " timed out");
  let timer = null;
  try {
    const request = operation();
    if (requireAbortable && typeof request?.abortSignal !== "function") {
      throw recoveryError(label + " transport was not abortable");
    }
    const abortBound = typeof request?.abortSignal === "function"
      ? request.abortSignal(controller.signal)
      : request;
    timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    return await Promise.race([
      Promise.resolve(abortBound),
      new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(timeoutError),
          { once: true }
        );
      })
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Authenticated LinkedIn orphan recovery ")
    ) {
      throw error;
    }
    throw recoveryError(label + " failed closed");
  } finally {
    clearTimeout(timer);
  }
}

function redactedResult(status, request, evidence, fingerprint) {
  return Object.freeze({
    status,
    fingerprint,
    lockKey: request.lockKey,
    canceledRunId: request.canceledRunId,
    canceledRunAttempt: request.canceledRunAttempt,
    idempotencyKey: request.idempotencyKey,
    batchSlug: request.batchSlug,
    companySlug: request.companySlug,
    targetKeySha256: sha256(request.targetKey),
    orphanPid: evidence.row.metadata_json.pid,
    leaseExpiredAt: evidence.row.lease_expires_at,
    browserProof: evidence.browserProof,
    collectionReady: false,
    localRecoveryRequired: true
  });
}

function exactWorkflowStep(job, name) {
  const matches = Array.isArray(job?.steps)
    ? job.steps.filter((step) => step?.name === name)
    : [];
  return matches.length === 1 ? matches[0] : null;
}

function redactedFileProof(file) {
  return {
    sha256: file.sha256,
    size: file.size,
    device: file.device,
    inode: file.inode,
    modifiedAtMs: file.modifiedAtMs
  };
}

function plainObject(value) {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value)
  );
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (plainObject(value)) {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recoveryError(reason) {
  return new Error("Authenticated LinkedIn orphan recovery " + reason + ".");
}
