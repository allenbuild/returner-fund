#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  INGESTION_RECOVERY_CRON,
  INGESTION_RECOVERY_DISPATCH_EVENT,
  latestEligibleCentralSlot,
  readPublicationWatermark,
  resolveScheduledIngestion
} from "./lib/ingestion-schedule.mjs";

const execFile = promisify(execFileCallback);

export const SUPERVISOR_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_WORKER_LOG_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SCHEDULE_RECOVERY_SILENCE_MINUTES = 30;
export const DEFAULT_SCHEDULE_RECOVERY_COOLDOWN_MINUTES = 30;
export const AUTONOMOUS_WORKFLOW_NAME = "Autonomous Ingestion";
export const AUTONOMOUS_INGESTION_STEP = "Run autonomous ingestion";
export const AUTONOMOUS_PUBLISH_JOB_PREFIX = "Publish accepted slot ";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const CENTRAL_SLOT_KEY = /^central-\d{4}-\d{2}-\d{2}-(?:0600|1800)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "pending",
  "requested",
  "waiting"
]);
const NON_SILENCING_RUN_CONCLUSIONS = new Set(["cancelled", "skipped"]);
const TERMINAL_EVENT_DISPOSITIONS = new Set([
  "baseline",
  "newer_attempt",
  "rerun_accepted",
  "stale_head"
]);

export function supervisorConfig(environment = process.env) {
  const userHome = homedir();
  const stateDir = path.resolve(
    clean(environment.RETURNER_LEASE_SUPERVISOR_STATE_DIR) ??
      path.join(
        userHome,
        "Library",
        "Application Support",
        "Returner Fund",
        "ingestion-lease-supervisor",
        "state"
      )
  );
  const maxWorkerLogBytes = strictInteger(
    environment.RETURNER_MAX_WORKER_LOG_BYTES,
    DEFAULT_MAX_WORKER_LOG_BYTES,
    "RETURNER_MAX_WORKER_LOG_BYTES",
    { minimum: 1024 * 1024, maximum: 256 * 1024 * 1024 }
  );
  const scheduleRecoverySilenceMinutes = strictInteger(
    environment.RETURNER_SCHEDULE_RECOVERY_SILENCE_MINUTES,
    DEFAULT_SCHEDULE_RECOVERY_SILENCE_MINUTES,
    "RETURNER_SCHEDULE_RECOVERY_SILENCE_MINUTES",
    { minimum: 15, maximum: 12 * 60 }
  );
  const scheduleRecoveryCooldownMinutes = strictInteger(
    environment.RETURNER_SCHEDULE_RECOVERY_COOLDOWN_MINUTES,
    DEFAULT_SCHEDULE_RECOVERY_COOLDOWN_MINUTES,
    "RETURNER_SCHEDULE_RECOVERY_COOLDOWN_MINUTES",
    { minimum: 5, maximum: 12 * 60 }
  );

  return Object.freeze({
    repository: validateRepository(
      clean(environment.RETURNER_REPOSITORY) ?? "allenbuild/returner-fund"
    ),
    workflowPath:
      clean(environment.RETURNER_WORKFLOW_PATH) ??
      ".github/workflows/autonomous-ingestion.yml",
    defaultBranch: clean(environment.RETURNER_DEFAULT_BRANCH) ?? "main",
    runnerName:
      clean(environment.RETURNER_RUNNER_NAME) ??
      "returner-social-mac-allenxtech",
    runnerDiagDir: path.resolve(
      clean(environment.RETURNER_RUNNER_DIAG_DIR) ??
        path.join(userHome, "returner-fund-actions-runner", "_diag")
    ),
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock"),
    ghBin: path.resolve(clean(environment.RETURNER_GH_BIN) ?? "/opt/homebrew/bin/gh"),
    maxWorkerLogBytes,
    scheduleRecoveryEnabled: strictBoolean(
      environment.RETURNER_SCHEDULE_RECOVERY_ENABLED,
      true,
      "RETURNER_SCHEDULE_RECOVERY_ENABLED"
    ),
    scheduleRecoverySilenceMinutes,
    scheduleRecoveryCooldownMinutes,
    dryRun: environment.RETURNER_LEASE_SUPERVISOR_DRY_RUN === "true"
  });
}

export function parseWorkerLeaseLossLog(source, { filename = "Worker.log" } = {}) {
  if (typeof source !== "string" || !source) return null;
  if (
    !/Task(?:Agent|Orchestration)JobNotFoundException|Job not found:[^\n]+workflow instance not found/i.test(
      source
    )
  ) {
    return null;
  }
  if (
    !/Cancellation\/Shutdown message received|Step result: Canceled|Process Cancellation finished/i.test(
      source
    )
  ) {
    return null;
  }

  const runId = contextString(source, "run_id");
  const runAttempt = contextString(source, "run_attempt");
  const workflowName = contextString(source, "workflow");
  const repository = contextString(source, "repository");
  const jobName = jsonStringField(source, "jobDisplayName");
  if (
    !POSITIVE_INTEGER.test(runId ?? "") ||
    !POSITIVE_INTEGER.test(runAttempt ?? "") ||
    workflowName !== AUTONOMOUS_WORKFLOW_NAME ||
    !repository ||
    !jobName?.startsWith(AUTONOMOUS_PUBLISH_JOB_PREFIX)
  ) {
    return null;
  }

  const event = {
    runId,
    runAttempt: Number(runAttempt),
    repository,
    workflowName,
    jobName,
    workerLog: path.basename(filename)
  };
  return Object.freeze({
    ...event,
    eventId: `${event.runId}:${event.runAttempt}:${event.jobName}`
  });
}

export function evaluatePowerStatus(source) {
  if (typeof source !== "string" || !source.trim()) {
    return Object.freeze({ eligible: false, reason: "power_status_unavailable", percent: null });
  }
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const onAc = /(?:Now drawing from )?'AC Power'/i.test(firstLine);
  const onBattery = /(?:Now drawing from )?'Battery Power'/i.test(firstLine);
  const percentMatch = /(?:^|\s)([0-9]{1,3})%;/.exec(source);
  const parsedPercent = percentMatch ? Number(percentMatch[1]) : null;
  const percent = Number.isInteger(parsedPercent) && parsedPercent >= 0 && parsedPercent <= 100
    ? parsedPercent
    : null;
  if (onAc) {
    return Object.freeze({ eligible: true, reason: "ac_power", percent });
  }
  if (onBattery) {
    return Object.freeze({ eligible: false, reason: "ac_power_required", percent });
  }
  return Object.freeze({ eligible: false, reason: "power_source_unknown", percent });
}

export function verifyWorkflowRun({ workflow, run, event, config }) {
  if (!workflow || !run) return { valid: false, reason: "missing_workflow_or_run" };
  if (String(workflow.path ?? "") !== config.workflowPath) {
    return { valid: false, reason: "workflow_path_mismatch" };
  }
  if (String(workflow.name ?? "") !== AUTONOMOUS_WORKFLOW_NAME) {
    return { valid: false, reason: "workflow_name_mismatch" };
  }
  if (Number(run.workflow_id) !== Number(workflow.id)) {
    return { valid: false, reason: "workflow_id_mismatch" };
  }
  if (String(run.path ?? "") !== config.workflowPath) {
    return { valid: false, reason: "run_path_mismatch" };
  }
  if (String(run.repository?.full_name ?? "") !== config.repository) {
    return { valid: false, reason: "repository_mismatch" };
  }
  if (event.repository !== config.repository) {
    return { valid: false, reason: "worker_repository_mismatch" };
  }
  if (String(run.head_branch ?? "") !== config.defaultBranch) {
    return { valid: false, reason: "head_branch_mismatch" };
  }
  if (!FULL_SHA.test(String(run.head_sha ?? ""))) {
    return { valid: false, reason: "invalid_head_sha" };
  }
  if (
    !new Set(["schedule", "workflow_dispatch", "repository_dispatch"]).has(
      String(run.event ?? "")
    )
  ) {
    return { valid: false, reason: "unsupported_event" };
  }
  if (String(run.status ?? "") !== "completed" || String(run.conclusion ?? "") !== "failure") {
    return { valid: false, reason: "run_not_completed_failure" };
  }
  if (!Number.isInteger(Number(run.run_attempt)) || Number(run.run_attempt) < event.runAttempt) {
    return { valid: false, reason: "run_attempt_regressed" };
  }
  return { valid: true, reason: "verified" };
}

export function verifyCancelledAutonomousJob({ jobs, event, config }) {
  const matchingJobs = (jobs ?? []).filter((job) => job?.name === event.jobName);
  if (matchingJobs.length !== 1) return { valid: false, reason: "publish_job_not_exact" };
  const job = matchingJobs[0];
  if (job.runner_name !== config.runnerName) {
    return { valid: false, reason: "runner_name_mismatch" };
  }
  if (job.status !== "completed" || job.conclusion !== "failure") {
    return { valid: false, reason: "publish_job_not_failed" };
  }
  const ingestionSteps = (job.steps ?? []).filter(
    (step) => step?.name === AUTONOMOUS_INGESTION_STEP
  );
  if (ingestionSteps.length !== 1) {
    return { valid: false, reason: "ingestion_step_not_exact" };
  }
  const step = ingestionSteps[0];
  if (step.status !== "completed" || step.conclusion !== "cancelled") {
    return { valid: false, reason: "ingestion_step_not_cancelled" };
  }
  return { valid: true, reason: "verified", jobId: job.id };
}

export async function evaluateLeaseLossEvent({
  event,
  config,
  github,
  readPowerStatus,
  dryRun = config.dryRun
}) {
  const workflow = await github.getWorkflow(config.workflowPath);
  const run = await github.getRun(event.runId);
  const runVerification = verifyWorkflowRun({ workflow, run, event, config });
  if (!runVerification.valid) {
    return Object.freeze({ action: "defer", reason: runVerification.reason });
  }

  const jobs = await github.getAttemptJobs(event.runId, event.runAttempt);
  const jobVerification = verifyCancelledAutonomousJob({ jobs, event, config });
  if (!jobVerification.valid) {
    return Object.freeze({ action: "defer", reason: jobVerification.reason });
  }

  const currentAttempt = Number(run.run_attempt);
  if (currentAttempt > event.runAttempt) {
    return Object.freeze({
      action: "mark",
      disposition: "newer_attempt",
      currentAttempt
    });
  }

  const mainSha = await github.getBranchHead(config.defaultBranch);
  if (!FULL_SHA.test(mainSha ?? "")) {
    return Object.freeze({ action: "defer", reason: "invalid_default_branch_sha" });
  }
  if (String(run.head_sha).toLowerCase() !== mainSha.toLowerCase()) {
    return Object.freeze({
      action: "mark",
      disposition: "stale_head",
      runHeadSha: String(run.head_sha).toLowerCase(),
      currentHeadSha: mainSha.toLowerCase()
    });
  }

  const activeRuns = await github.getActiveRuns();
  const active = activeRuns.find(
    (candidate) =>
      ACTIVE_RUN_STATUSES.has(String(candidate?.status ?? "")) &&
      String(candidate?.id ?? "") !== event.runId
  );
  if (active) {
    return Object.freeze({
      action: "defer",
      reason: "autonomous_run_active",
      activeRunId: String(active.id),
      activeRunStatus: String(active.status)
    });
  }

  const power = evaluatePowerStatus(await readPowerStatus());
  if (!power.eligible) {
    return Object.freeze({ action: "defer", reason: power.reason, batteryPercent: power.percent });
  }
  if (dryRun) {
    return Object.freeze({
      action: "defer",
      reason: "dry_run_would_rerun",
      batteryPercent: power.percent
    });
  }

  await github.rerunFailedJobs(event.runId);
  return Object.freeze({
    action: "mark",
    disposition: "rerun_accepted",
    currentAttempt,
    batteryPercent: power.percent,
    powerReason: power.reason
  });
}

export function verifyRecoveryWorkflow({ workflow, config }) {
  if (!workflow) return { valid: false, reason: "missing_workflow" };
  if (String(workflow.path ?? "") !== config.workflowPath) {
    return { valid: false, reason: "workflow_path_mismatch" };
  }
  if (String(workflow.name ?? "") !== AUTONOMOUS_WORKFLOW_NAME) {
    return { valid: false, reason: "workflow_name_mismatch" };
  }
  if (String(workflow.state ?? "") !== "active") {
    return { valid: false, reason: "workflow_not_active" };
  }
  if (!Number.isSafeInteger(Number(workflow.id)) || Number(workflow.id) <= 0) {
    return { valid: false, reason: "workflow_id_invalid" };
  }
  return { valid: true, reason: "verified" };
}

export function verifyRecoveryRunner({ runners, config }) {
  const matching = (runners ?? []).filter(
    (runner) => String(runner?.name ?? "") === config.runnerName
  );
  if (matching.length !== 1) {
    return { valid: false, reason: "runner_not_exact", matching: matching.length };
  }
  if (String(matching[0].status ?? "") !== "online") {
    return { valid: false, reason: "runner_offline" };
  }
  return {
    valid: true,
    reason: "verified",
    runnerId: String(matching[0].id ?? ""),
    busy: matching[0].busy === true
  };
}

export async function evaluateScheduleRecovery({
  config,
  github,
  state,
  readPowerStatus,
  now = new Date(),
  dryRun = config.dryRun
}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Schedule recovery now must be a valid Date.");
  }

  const workflow = await github.getWorkflow(config.workflowPath);
  const workflowVerification = verifyRecoveryWorkflow({ workflow, config });
  if (!workflowVerification.valid) {
    return Object.freeze({ action: "defer", reason: workflowVerification.reason });
  }

  const mainSha = String(await github.getBranchHead(config.defaultBranch)).toLowerCase();
  if (!FULL_SHA.test(mainSha)) {
    return Object.freeze({ action: "defer", reason: "invalid_default_branch_sha" });
  }

  // A lease rerun response can be ambiguous, so never reuse its pre-rerun run snapshot here.
  const runs = await github.getWorkflowRuns({ fresh: true });
  const active = runs.find((run) => ACTIVE_RUN_STATUSES.has(String(run?.status ?? "")));
  if (active) {
    return Object.freeze({
      action: "defer",
      reason: "autonomous_run_active",
      activeRunId: String(active.id ?? ""),
      activeRunStatus: String(active.status ?? "")
    });
  }

  const latestSlot = latestEligibleCentralSlot(now);
  const lastDispatch = state?.recoveryDispatch ?? null;
  if (lastDispatch?.slotKey === latestSlot.slotKey) {
    const lastDispatchMs = Date.parse(lastDispatch.dispatchedAt ?? "");
    if (!Number.isFinite(lastDispatchMs)) {
      return Object.freeze({ action: "defer", reason: "invalid_recovery_dispatch_state" });
    }
    const cooldownAgeMs = now.getTime() - lastDispatchMs;
    if (cooldownAgeMs < 0) {
      return Object.freeze({ action: "defer", reason: "recovery_dispatch_state_in_future" });
    }
    if (cooldownAgeMs < config.scheduleRecoveryCooldownMinutes * 60_000) {
      return Object.freeze({
        action: "defer",
        reason: "recovery_dispatch_cooldown",
        slotKey: latestSlot.slotKey,
        lastDispatchedAt: new Date(lastDispatchMs).toISOString()
      });
    }
  }

  const latestRun = runs
    // A cancelled or skipped wake performed no trustworthy publication. It must
    // not postpone recovery when the committed watermark is still behind.
    .filter(
      (run) =>
        !NON_SILENCING_RUN_CONCLUSIONS.has(String(run?.conclusion ?? "").toLowerCase())
    )
    .map((run) => ({ run, createdAtMs: Date.parse(run?.created_at ?? "") }))
    .filter(({ createdAtMs }) => Number.isFinite(createdAtMs))
    .sort((left, right) => right.createdAtMs - left.createdAtMs)[0] ?? null;
  if (latestRun) {
    const silenceMs = now.getTime() - latestRun.createdAtMs;
    if (silenceMs < 0) {
      return Object.freeze({ action: "defer", reason: "workflow_run_created_in_future" });
    }
    if (silenceMs < config.scheduleRecoverySilenceMinutes * 60_000) {
      return Object.freeze({
        action: "defer",
        reason: "recent_workflow_wakeup",
        latestRunId: String(latestRun.run.id ?? ""),
        latestRunCreatedAt: new Date(latestRun.createdAtMs).toISOString()
      });
    }
  }

  const runnerVerification = verifyRecoveryRunner({
    runners: await github.getRunners(),
    config
  });
  if (!runnerVerification.valid) {
    return Object.freeze({
      action: "defer",
      reason: runnerVerification.reason,
      matchingRunners: runnerVerification.matching
    });
  }

  const power = evaluatePowerStatus(await readPowerStatus());
  if (!power.eligible) {
    return Object.freeze({
      action: "defer",
      reason: power.reason,
      batteryPercent: power.percent
    });
  }

  const reads = new Map();
  const publicationState = await readPublicationWatermark({
    now,
    readText: (relativePath) => {
      if (!reads.has(relativePath)) {
        reads.set(relativePath, github.getRepositoryText(relativePath, mainSha));
      }
      return reads.get(relativePath);
    }
  });
  const decision = resolveScheduledIngestion({
    schedule: INGESTION_RECOVERY_CRON,
    publicationState,
    now
  });
  if (!decision.accepted) {
    return Object.freeze({
      action: "current",
      reason: decision.reason,
      mainSha,
      watermarkStatus: decision.watermarkStatus,
      publicationWatermark: decision.publicationWatermark,
      latestSlotKey: decision.latestEligibleSlotKey
    });
  }
  if (decision.slotKey !== latestSlot.slotKey) {
    throw new Error(
      `Schedule recovery slot changed while evaluating the same instant (${latestSlot.slotKey} != ${decision.slotKey}).`
    );
  }
  if (dryRun) {
    return Object.freeze({
      action: "defer",
      reason: "dry_run_would_dispatch_recovery",
      mainSha,
      slotKey: decision.slotKey,
      watermarkStatus: decision.watermarkStatus,
      batteryPercent: power.percent
    });
  }

  await github.dispatchRecovery(mainSha);
  return Object.freeze({
    action: "dispatch",
    disposition: "recovery_dispatch_accepted",
    mainSha,
    slotKey: decision.slotKey,
    scheduledAt: decision.scheduledAt,
    watermarkStatus: decision.watermarkStatus,
    publicationWatermark: decision.publicationWatermark,
    batteryPercent: power.percent,
    powerReason: power.reason,
    runnerId: runnerVerification.runnerId,
    runnerBusy: runnerVerification.busy
  });
}

export async function runSupervisor({
  config = supervisorConfig(),
  github = createGitHubClient(config),
  readPowerStatus = readHostPowerStatus,
  now = () => new Date()
} = {}) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireSupervisorLock(config.lockPath, { now });
  if (!lock.acquired) {
    logEvent("lock_held", { lockPath: config.lockPath });
    return { status: "lock_held", scanned: 0, candidates: 0, marked: 0 };
  }

  try {
    const state = await loadSupervisorState(config.statePath);
    const scan = await scanWorkerLogs({ config, state });
    if (!state.initializedAt) {
      const initializedAt = now().toISOString();
      let baselined = 0;
      for (const event of scan.candidates) {
        if (state.handledEvents[event.eventId]) continue;
        state.handledEvents[event.eventId] = {
          disposition: "baseline",
          handledAt: initializedAt,
          runId: event.runId,
          runAttempt: event.runAttempt,
          jobName: event.jobName,
          workerLog: event.workerLog
        };
        baselined += 1;
      }
      state.initializedAt = initializedAt;
      await writeSupervisorState(config.statePath, state, now());
      logEvent("baseline_initialized", {
        initializedAt,
        candidates: scan.candidates.length,
        baselined
      });
      return {
        status: "baseline_initialized",
        scanned: scan.scanned,
        candidates: scan.candidates.length,
        marked: baselined,
        deferred: 0
      };
    }
    let marked = 0;
    let deferred = 0;
    let rerunAccepted = false;
    for (const event of scan.candidates) {
      if (state.handledEvents[event.eventId]) continue;
      let decision;
      try {
        decision = await evaluateLeaseLossEvent({
          event,
          config,
          github,
          readPowerStatus
        });
      } catch (error) {
        deferred += 1;
        logEvent("event_error", {
          eventId: event.eventId,
          message: safeErrorMessage(error)
        });
        continue;
      }

      if (decision.action === "mark") {
        if (!TERMINAL_EVENT_DISPOSITIONS.has(decision.disposition)) {
          throw new Error(`Unsupported terminal disposition ${decision.disposition}.`);
        }
        state.handledEvents[event.eventId] = {
          disposition: decision.disposition,
          handledAt: now().toISOString(),
          runId: event.runId,
          runAttempt: event.runAttempt,
          jobName: event.jobName,
          workerLog: event.workerLog,
          ...withoutUndefined(decision)
        };
        marked += 1;
        await writeSupervisorState(config.statePath, state, now());
        logEvent(decision.disposition, {
          eventId: event.eventId,
          runId: event.runId,
          runAttempt: event.runAttempt,
          ...withoutUndefined(decision)
        });
        if (decision.disposition === "rerun_accepted") {
          rerunAccepted = true;
          break;
        }
      } else {
        deferred += 1;
        logEvent("deferred", {
          eventId: event.eventId,
          runId: event.runId,
          runAttempt: event.runAttempt,
          ...withoutUndefined(decision)
        });
      }
    }

    let recovery = { action: "disabled", reason: "schedule_recovery_disabled" };
    if (config.scheduleRecoveryEnabled && !rerunAccepted) {
      try {
        recovery = await evaluateScheduleRecovery({
          config,
          github,
          state,
          readPowerStatus,
          now: now()
        });
        if (recovery.action === "dispatch") {
          state.recoveryDispatch = {
            dispatchedAt: now().toISOString(),
            eventType: INGESTION_RECOVERY_DISPATCH_EVENT,
            expectedHeadSha: recovery.mainSha,
            slotKey: recovery.slotKey
          };
          await writeSupervisorState(config.statePath, state, now());
          logEvent("recovery_dispatch_accepted", withoutUndefined(recovery));
        } else {
          logEvent("recovery_dispatch_skipped", withoutUndefined(recovery));
        }
      } catch (error) {
        recovery = { action: "defer", reason: "recovery_evaluation_error" };
        logEvent("recovery_evaluation_error", { message: safeErrorMessage(error) });
      }
    } else if (rerunAccepted) {
      recovery = { action: "defer", reason: "lease_rerun_accepted" };
    }
    await writeSupervisorState(config.statePath, state, now());
    return {
      status: "completed",
      scanned: scan.scanned,
      candidates: scan.candidates.length,
      marked,
      deferred,
      recovery
    };
  } finally {
    await lock.release();
  }
}

export async function scanWorkerLogs({ config, state }) {
  const entries = await readdir(config.runnerDiagDir, { withFileTypes: true });
  const workerFiles = entries
    .filter((entry) => entry.isFile() && /^Worker_[0-9]{8}-[0-9]{6}-utc\.log$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const candidates = [];
  let scanned = 0;

  for (const filename of workerFiles) {
    const logPath = path.join(config.runnerDiagDir, filename);
    const metadata = await stat(logPath);
    const cached = state.workerLogs[filename];
    let event = cached?.event ?? null;
    if (cached?.size !== metadata.size || cached?.mtimeMs !== metadata.mtimeMs) {
      const source = await readBoundedWorkerLog(logPath, metadata.size, config.maxWorkerLogBytes);
      event = parseWorkerLeaseLossLog(source, { filename });
      state.workerLogs[filename] = {
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        event
      };
      scanned += 1;
    }
    if (event && !state.handledEvents[event.eventId]) candidates.push(event);
  }

  pruneRecord(state.workerLogs, 512, (value) => Number(value?.mtimeMs ?? 0));
  pruneRecord(state.handledEvents, 512, (value) => Date.parse(value?.handledAt ?? "") || 0);
  return { scanned, candidates };
}

export async function acquireSupervisorLock(lockPath, { now = () => new Date() } = {}) {
  const tryAcquire = async () => {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, startedAt: now().toISOString() })}\n`,
        { mode: 0o600 }
      );
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  };

  if (await tryAcquire()) {
    return { acquired: true, release: () => rm(lockPath, { recursive: true, force: true }) };
  }

  let owner = null;
  try {
    owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return { acquired: false, release: async () => {} };
  }
  if (Number.isInteger(owner?.pid) && owner.pid > 0 && processExists(owner.pid)) {
    return { acquired: false, release: async () => {} };
  }

  await rm(lockPath, { recursive: true, force: true });
  if (!(await tryAcquire())) return { acquired: false, release: async () => {} };
  return { acquired: true, release: () => rm(lockPath, { recursive: true, force: true }) };
}

export function createGitHubClient(config, { execute = execFile } = {}) {
  const apiJson = async (endpoint) => {
    const { stdout } = await execute(
      config.ghBin,
      ["api", "--method", "GET", endpoint],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }
    );
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(`GitHub API returned invalid JSON for ${endpoint}: ${safeErrorMessage(error)}`);
    }
  };
  const apiText = async (endpoint) => {
    const { stdout } = await execute(
      config.ghBin,
      [
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github.raw+json",
        endpoint
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }
    );
    return stdout;
  };
  let workflowPromise = null;
  let mainPromise = null;
  let runsPromise = null;
  let runnersPromise = null;
  const repoEndpoint = `repos/${config.repository}`;
  const workflowSelector = encodeURIComponent(path.basename(config.workflowPath));
  const getWorkflowRuns = ({ fresh = false } = {}) => {
    if (fresh || !runsPromise) {
      runsPromise = apiJson(
        `${repoEndpoint}/actions/workflows/${workflowSelector}/runs?per_page=100`
      ).then((response) => Array.isArray(response?.workflow_runs) ? response.workflow_runs : []);
    }
    return runsPromise;
  };

  return Object.freeze({
    getWorkflow: () => {
      workflowPromise ??= apiJson(`${repoEndpoint}/actions/workflows/${workflowSelector}`);
      return workflowPromise;
    },
    getRun: (runId) => apiJson(`${repoEndpoint}/actions/runs/${runId}`),
    getAttemptJobs: async (runId, attempt) => {
      const response = await apiJson(
        `${repoEndpoint}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`
      );
      return Array.isArray(response?.jobs) ? response.jobs : [];
    },
    getBranchHead: () => {
      mainPromise ??= apiJson(`${repoEndpoint}/git/ref/heads/${config.defaultBranch}`).then(
        (response) => String(response?.object?.sha ?? "")
      );
      return mainPromise;
    },
    getWorkflowRuns,
    getActiveRuns: () =>
      getWorkflowRuns().then((runs) =>
        runs.filter((run) =>
          ACTIVE_RUN_STATUSES.has(String(run?.status ?? ""))
        )
      ),
    getRunners: () => {
      runnersPromise ??= apiJson(`${repoEndpoint}/actions/runners?per_page=100`).then(
        (response) => Array.isArray(response?.runners) ? response.runners : []
      );
      return runnersPromise;
    },
    getRepositoryText: (relativePath, ref) => {
      const encodedPath = encodeRepositoryPath(relativePath);
      if (!FULL_SHA.test(String(ref ?? ""))) {
        throw new Error("Repository artifact reads require an exact commit SHA.");
      }
      return apiText(`${repoEndpoint}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    },
    rerunFailedJobs: async (runId) => {
      await execute(
        config.ghBin,
        ["api", "--method", "POST", `${repoEndpoint}/actions/runs/${runId}/rerun-failed-jobs`],
        { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8" }
      );
    },
    dispatchRecovery: async (expectedHeadSha) => {
      if (!FULL_SHA.test(String(expectedHeadSha ?? ""))) {
        throw new Error("Recovery dispatch requires an exact expected main commit SHA.");
      }
      await execute(
        config.ghBin,
        [
          "api",
          "--method",
          "POST",
          `${repoEndpoint}/dispatches`,
          "-F",
          `event_type=${INGESTION_RECOVERY_DISPATCH_EVENT}`,
          "-F",
          `client_payload[expected_head_sha]=${String(expectedHeadSha).toLowerCase()}`
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8" }
      );
    }
  });
}

export async function loadSupervisorState(statePath) {
  let source;
  try {
    source = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        schemaVersion: SUPERVISOR_SCHEMA_VERSION,
        workerLogs: {},
        handledEvents: {},
        recoveryDispatch: null
      };
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Lease supervisor state is invalid JSON: ${safeErrorMessage(error)}`);
  }
  if (parsed?.schemaVersion !== SUPERVISOR_SCHEMA_VERSION) {
    throw new Error(`Unsupported lease supervisor state schema ${parsed?.schemaVersion ?? "missing"}.`);
  }
  if (!plainObject(parsed.workerLogs) || !plainObject(parsed.handledEvents)) {
    throw new Error("Lease supervisor state maps are malformed.");
  }
  if (parsed.recoveryDispatch !== undefined && parsed.recoveryDispatch !== null) {
    const recovery = parsed.recoveryDispatch;
    if (
      !plainObject(recovery) ||
      recovery.eventType !== INGESTION_RECOVERY_DISPATCH_EVENT ||
      !FULL_SHA.test(recovery.expectedHeadSha ?? "") ||
      !CENTRAL_SLOT_KEY.test(recovery.slotKey ?? "") ||
      !Number.isFinite(Date.parse(recovery.dispatchedAt ?? ""))
    ) {
      throw new Error("Lease supervisor recovery dispatch state is malformed.");
    }
  }
  parsed.recoveryDispatch ??= null;
  return parsed;
}

export async function writeSupervisorState(statePath, state, timestamp = new Date()) {
  const next = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    initializedAt: state.initializedAt ?? null,
    updatedAt: timestamp.toISOString(),
    workerLogs: state.workerLogs,
    handledEvents: state.handledEvents,
    recoveryDispatch: state.recoveryDispatch ?? null
  };
  const temporaryPath = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  await rename(temporaryPath, statePath);
}

async function readBoundedWorkerLog(logPath, size, maximumBytes) {
  if (size <= maximumBytes) return readFile(logPath, "utf8");
  const headBytes = Math.min(8 * 1024 * 1024, Math.floor(maximumBytes / 2));
  const tailBytes = Math.min(maximumBytes - headBytes, size - headBytes);
  const handle = await open(logPath, "r");
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    await handle.read(head, 0, headBytes, 0);
    await handle.read(tail, 0, tailBytes, size - tailBytes);
    return `${head.toString("utf8")}\n[...bounded worker log gap...]\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

async function readHostPowerStatus() {
  const { stdout } = await execFile("/usr/bin/pmset", ["-g", "batt"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  return stdout;
}

function contextString(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `"k"\\s*:\\s*"${escaped}"\\s*,\\s*"v"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`
  ).exec(source);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function jsonStringField(source, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `"${escaped}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`
  ).exec(source);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function strictInteger(value, fallback, label, { minimum, maximum }) {
  const normalized = clean(value);
  if (!normalized) return fallback;
  if (!/^[0-9]+$/.test(normalized)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function strictBoolean(value, fallback, label) {
  const normalized = clean(value);
  if (normalized === null) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${label} must be exactly true or false.`);
}

function encodeRepositoryPath(relativePath) {
  const normalized = clean(relativePath);
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Repository artifact path must be a safe relative path.");
  }
  return normalized.split("/").map(encodeURIComponent).join("/");
}

function validateRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("RETURNER_REPOSITORY must be an owner/repository pair.");
  }
  return value;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function pruneRecord(record, maximum, score) {
  const entries = Object.entries(record);
  if (entries.length <= maximum) return;
  entries
    .sort((left, right) => score(right[1]) - score(left[1]))
    .slice(maximum)
    .forEach(([key]) => delete record[key]);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "unknown error").replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function logEvent(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

async function main() {
  const result = await runSupervisor();
  logEvent("supervisor_complete", result);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: "supervisor_failed",
        message: safeErrorMessage(error)
      })}\n`
    );
    process.exitCode = 1;
  });
}
