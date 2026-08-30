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
export const DEFAULT_MIN_BATTERY_PERCENT = 30;
export const DEFAULT_MAX_WORKER_LOG_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SCHEDULE_RECOVERY_SILENCE_MINUTES = 30;
export const DEFAULT_SCHEDULE_RECOVERY_COOLDOWN_MINUTES = 30;
export const DEFAULT_DASHBOARD_RECOVERY_MAX_AGE_MINUTES = 120;
export const DEFAULT_DASHBOARD_RECOVERY_SILENCE_MINUTES = 30;
export const DEFAULT_DASHBOARD_RECOVERY_COOLDOWN_MINUTES = 30;
export const AUTONOMOUS_WORKFLOW_NAME = "Autonomous Ingestion";
export const AUTONOMOUS_INGESTION_STEP = "Run autonomous ingestion";
export const AUTONOMOUS_PUBLISH_JOB_PREFIX = "Publish accepted slot ";
export const DASHBOARD_WORKFLOW_NAME = "Technology Dashboard Refresh";
export const DASHBOARD_WORKFLOW_PATH = ".github/workflows/dashboard-refresh.yml";
export const DASHBOARD_ARTIFACT_PATH = "public/dashboard/feed.json";
export const DASHBOARD_SCHEMA_VERSION = "technology-dashboard-v2";

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
const DASHBOARD_WINDOW_MS = 72 * 60 * 60 * 1_000;
const DASHBOARD_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const DASHBOARD_WATERMARK_STATUSES = new Set(["current", "stale", "missing", "invalid"]);
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
  const minBatteryPercent = strictInteger(
    environment.RETURNER_MIN_BATTERY_PERCENT,
    DEFAULT_MIN_BATTERY_PERCENT,
    "RETURNER_MIN_BATTERY_PERCENT",
    { minimum: 21, maximum: 100 }
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
  const dashboardRecoveryMaxAgeMinutes = strictInteger(
    environment.RETURNER_DASHBOARD_RECOVERY_MAX_AGE_MINUTES,
    DEFAULT_DASHBOARD_RECOVERY_MAX_AGE_MINUTES,
    "RETURNER_DASHBOARD_RECOVERY_MAX_AGE_MINUTES",
    { minimum: 60, maximum: 24 * 60 }
  );
  const dashboardRecoverySilenceMinutes = strictInteger(
    environment.RETURNER_DASHBOARD_RECOVERY_SILENCE_MINUTES,
    DEFAULT_DASHBOARD_RECOVERY_SILENCE_MINUTES,
    "RETURNER_DASHBOARD_RECOVERY_SILENCE_MINUTES",
    { minimum: 5, maximum: 12 * 60 }
  );
  const dashboardRecoveryCooldownMinutes = strictInteger(
    environment.RETURNER_DASHBOARD_RECOVERY_COOLDOWN_MINUTES,
    DEFAULT_DASHBOARD_RECOVERY_COOLDOWN_MINUTES,
    "RETURNER_DASHBOARD_RECOVERY_COOLDOWN_MINUTES",
    { minimum: 5, maximum: 12 * 60 }
  );

  return Object.freeze({
    repository: validateRepository(
      clean(environment.RETURNER_REPOSITORY) ?? "allenbuild/returner-fund"
    ),
    workflowPath:
      clean(environment.RETURNER_WORKFLOW_PATH) ??
      ".github/workflows/autonomous-ingestion.yml",
    dashboardWorkflowPath: DASHBOARD_WORKFLOW_PATH,
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
    minBatteryPercent,
    maxWorkerLogBytes,
    scheduleRecoveryEnabled: strictBoolean(
      environment.RETURNER_SCHEDULE_RECOVERY_ENABLED,
      true,
      "RETURNER_SCHEDULE_RECOVERY_ENABLED"
    ),
    scheduleRecoverySilenceMinutes,
    scheduleRecoveryCooldownMinutes,
    dashboardRecoveryEnabled: strictBoolean(
      environment.RETURNER_DASHBOARD_RECOVERY_ENABLED,
      true,
      "RETURNER_DASHBOARD_RECOVERY_ENABLED"
    ),
    dashboardRecoveryMaxAgeMinutes,
    dashboardRecoverySilenceMinutes,
    dashboardRecoveryCooldownMinutes,
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

export function evaluatePowerStatus(source, minimumPercent = DEFAULT_MIN_BATTERY_PERCENT) {
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
    if (percent === null) {
      return Object.freeze({ eligible: false, reason: "battery_percent_unknown", percent: null });
    }
    if (percent < minimumPercent) {
      return Object.freeze({ eligible: false, reason: "battery_below_reserve", percent });
    }
    return Object.freeze({ eligible: true, reason: "healthy_battery_reserve", percent });
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

  const power = evaluatePowerStatus(await readPowerStatus(), config.minBatteryPercent);
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

export async function readDashboardPublicationWatermark({
  readText,
  now = new Date(),
  maxAgeMinutes = DEFAULT_DASHBOARD_RECOVERY_MAX_AGE_MINUTES
}) {
  if (typeof readText !== "function") {
    throw new Error("Dashboard publication watermark requires a text reader.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Dashboard publication watermark now must be a valid Date.");
  }
  if (!Number.isSafeInteger(maxAgeMinutes) || maxAgeMinutes < 1) {
    throw new Error("Dashboard publication watermark maximum age must be a positive integer.");
  }

  let source;
  try {
    source = await readText(DASHBOARD_ARTIFACT_PATH);
  } catch {
    return Object.freeze({
      status: "missing",
      generatedAt: null,
      ageMinutes: null
    });
  }

  try {
    const artifact = JSON.parse(source);
    if (!plainObject(artifact) || artifact.schemaVersion !== DASHBOARD_SCHEMA_VERSION) {
      throw new Error("dashboard artifact schema is invalid");
    }
    if (
      typeof artifact.sourceSnapshotFingerprint !== "string" ||
      artifact.sourceSnapshotFingerprint.length < 1 ||
      artifact.sourceSnapshotFingerprint.length > 128 ||
      !Array.isArray(artifact.todayInTech) ||
      !artifact.todayInTech.every((item) => typeof item === "string" && item.length <= 600) ||
      !Array.isArray(artifact.stories) ||
      artifact.stories.length > 300 ||
      !plainObject(artifact.availableFilters) ||
      !Array.isArray(artifact.availableFilters.topics) ||
      !Array.isArray(artifact.availableFilters.platforms) ||
      !plainObject(artifact.status) ||
      !nonNegativeInteger(artifact.status.candidateCount) ||
      !nonNegativeInteger(artifact.status.eligibleCandidateCount) ||
      !nonNegativeInteger(artifact.status.storyCount) ||
      !plainObject(artifact.status.viewStoryCounts) ||
      !["hottest", "breaking", "emerging"].every((view) =>
        nonNegativeInteger(artifact.status.viewStoryCounts[view])
      ) ||
      !Array.isArray(artifact.status.partialPlatformFailures) ||
      artifact.status.storyCount !== artifact.stories.length
    ) {
      throw new Error("dashboard artifact publication fields are invalid");
    }

    const generatedAt = strictUtcInstant(artifact.generatedAt);
    const updatedAt = strictUtcInstant(artifact.updatedAt);
    const windowStart = strictUtcInstant(artifact.windowStart);
    const windowEnd = strictUtcInstant(artifact.windowEnd);
    if (
      generatedAt.getTime() !== updatedAt.getTime() ||
      generatedAt.getTime() !== windowEnd.getTime() ||
      windowEnd.getTime() - windowStart.getTime() !== DASHBOARD_WINDOW_MS
    ) {
      throw new Error("dashboard artifact clocks are inconsistent");
    }

    const ageMs = now.getTime() - generatedAt.getTime();
    if (ageMs < -DASHBOARD_MAX_FUTURE_SKEW_MS) {
      throw new Error("dashboard artifact publication is in the future");
    }
    return Object.freeze({
      status: ageMs <= maxAgeMinutes * 60_000 ? "current" : "stale",
      generatedAt: generatedAt.toISOString(),
      ageMinutes: ageMs / 60_000
    });
  } catch {
    return Object.freeze({
      status: "invalid",
      generatedAt: null,
      ageMinutes: null
    });
  }
}

export function verifyDashboardRecoveryWorkflow({ workflow, config }) {
  if (!workflow) return { valid: false, reason: "missing_dashboard_workflow" };
  if (String(workflow.path ?? "") !== config.dashboardWorkflowPath) {
    return { valid: false, reason: "dashboard_workflow_path_mismatch" };
  }
  if (String(workflow.name ?? "") !== DASHBOARD_WORKFLOW_NAME) {
    return { valid: false, reason: "dashboard_workflow_name_mismatch" };
  }
  if (String(workflow.state ?? "") !== "active") {
    return { valid: false, reason: "dashboard_workflow_not_active" };
  }
  if (!Number.isSafeInteger(Number(workflow.id)) || Number(workflow.id) <= 0) {
    return { valid: false, reason: "dashboard_workflow_id_invalid" };
  }
  return { valid: true, reason: "verified" };
}

export async function evaluateDashboardRecovery({
  config,
  github,
  state,
  readPowerStatus,
  now = new Date(),
  dryRun = config.dryRun
}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Dashboard recovery now must be a valid Date.");
  }

  const workflow = await github.getDashboardWorkflow();
  const workflowVerification = verifyDashboardRecoveryWorkflow({ workflow, config });
  if (!workflowVerification.valid) {
    return Object.freeze({ action: "defer", reason: workflowVerification.reason });
  }

  const mainSha = String(await github.getBranchHead(config.defaultBranch)).toLowerCase();
  if (!FULL_SHA.test(mainSha)) {
    return Object.freeze({ action: "defer", reason: "invalid_default_branch_sha" });
  }

  const watermark = await readDashboardPublicationWatermark({
    readText: (relativePath) => github.getRepositoryText(relativePath, mainSha),
    now,
    maxAgeMinutes: config.dashboardRecoveryMaxAgeMinutes
  });
  if (watermark.status === "current") {
    return Object.freeze({
      action: "current",
      reason: "dashboard_publication_current",
      mainSha,
      watermarkStatus: watermark.status,
      publicationWatermark: watermark.generatedAt,
      ageMinutes: watermark.ageMinutes
    });
  }

  const dashboardRuns = await github.getDashboardWorkflowRuns({ fresh: true });
  const activeDashboardRun = dashboardRuns.find((run) =>
    ACTIVE_RUN_STATUSES.has(String(run?.status ?? ""))
  );
  if (activeDashboardRun) {
    return Object.freeze({
      action: "defer",
      reason: "dashboard_run_active",
      activeRunId: String(activeDashboardRun.id ?? ""),
      activeRunStatus: String(activeDashboardRun.status ?? ""),
      watermarkStatus: watermark.status
    });
  }

  const activeIngestionRun = (await github.getActiveRuns({ fresh: true }))[0];
  if (activeIngestionRun) {
    return Object.freeze({
      action: "defer",
      reason: "autonomous_run_active",
      activeRunId: String(activeIngestionRun.id ?? ""),
      activeRunStatus: String(activeIngestionRun.status ?? ""),
      watermarkStatus: watermark.status
    });
  }

  const lastDispatch = state?.dashboardRecoveryDispatch ?? null;
  if (lastDispatch) {
    const lastDispatchMs = Date.parse(lastDispatch.dispatchedAt ?? "");
    if (!Number.isFinite(lastDispatchMs)) {
      return Object.freeze({ action: "defer", reason: "invalid_dashboard_recovery_dispatch_state" });
    }
    const cooldownAgeMs = now.getTime() - lastDispatchMs;
    if (cooldownAgeMs < 0) {
      return Object.freeze({ action: "defer", reason: "dashboard_recovery_dispatch_state_in_future" });
    }
    if (cooldownAgeMs < config.dashboardRecoveryCooldownMinutes * 60_000) {
      return Object.freeze({
        action: "defer",
        reason: "dashboard_recovery_dispatch_cooldown",
        lastDispatchedAt: new Date(lastDispatchMs).toISOString(),
        watermarkStatus: watermark.status
      });
    }
  }

  const latestSuccessfulRun = dashboardRuns
    .filter((run) => String(run?.conclusion ?? "").toLowerCase() === "success")
    .map((run) => ({
      run,
      completedAtMs: Date.parse(run?.updated_at ?? run?.created_at ?? "")
    }))
    .filter(({ completedAtMs }) => Number.isFinite(completedAtMs))
    .sort((left, right) => right.completedAtMs - left.completedAtMs)[0] ?? null;
  if (latestSuccessfulRun) {
    const silenceMs = now.getTime() - latestSuccessfulRun.completedAtMs;
    if (silenceMs < 0) {
      return Object.freeze({ action: "defer", reason: "dashboard_run_completed_in_future" });
    }
    if (silenceMs < config.dashboardRecoverySilenceMinutes * 60_000) {
      return Object.freeze({
        action: "defer",
        reason: "recent_successful_dashboard_wakeup",
        latestRunId: String(latestSuccessfulRun.run.id ?? ""),
        latestRunCompletedAt: new Date(latestSuccessfulRun.completedAtMs).toISOString(),
        watermarkStatus: watermark.status
      });
    }
  }

  const runnerVerification = verifyRecoveryRunner({
    runners: await github.getRunners({ fresh: true }),
    config
  });
  if (!runnerVerification.valid) {
    return Object.freeze({
      action: "defer",
      reason: runnerVerification.reason,
      matchingRunners: runnerVerification.matching,
      watermarkStatus: watermark.status
    });
  }
  if (runnerVerification.busy) {
    return Object.freeze({
      action: "defer",
      reason: "runner_busy",
      runnerId: runnerVerification.runnerId,
      watermarkStatus: watermark.status
    });
  }

  const power = evaluatePowerStatus(await readPowerStatus(), config.minBatteryPercent);
  if (!power.eligible) {
    return Object.freeze({
      action: "defer",
      reason: power.reason,
      batteryPercent: power.percent,
      watermarkStatus: watermark.status
    });
  }
  if (dryRun) {
    return Object.freeze({
      action: "defer",
      reason: "dry_run_would_dispatch_dashboard_recovery",
      mainSha,
      watermarkStatus: watermark.status,
      publicationWatermark: watermark.generatedAt,
      batteryPercent: power.percent
    });
  }

  await github.dispatchDashboardRecovery(mainSha);
  return Object.freeze({
    action: "dispatch",
    disposition: "dashboard_recovery_dispatch_accepted",
    mainSha,
    watermarkStatus: watermark.status,
    publicationWatermark: watermark.generatedAt,
    ageMinutes: watermark.ageMinutes,
    batteryPercent: power.percent,
    powerReason: power.reason,
    runnerId: runnerVerification.runnerId
  });
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

  const power = evaluatePowerStatus(await readPowerStatus(), config.minBatteryPercent);
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

    let dashboardRecovery = {
      action: "disabled",
      reason: "dashboard_recovery_disabled"
    };
    const ingestionRecoveryAccepted = rerunAccepted || recovery.action === "dispatch";
    if (config.dashboardRecoveryEnabled && !ingestionRecoveryAccepted) {
      try {
        dashboardRecovery = await evaluateDashboardRecovery({
          config,
          github,
          state,
          readPowerStatus,
          now: now()
        });
        if (dashboardRecovery.action === "dispatch") {
          state.dashboardRecoveryDispatch = {
            dispatchedAt: now().toISOString(),
            eventType: "workflow_dispatch",
            workflowPath: config.dashboardWorkflowPath,
            observedHeadSha: dashboardRecovery.mainSha,
            watermarkStatus: dashboardRecovery.watermarkStatus,
            observedGeneratedAt: dashboardRecovery.publicationWatermark ?? null
          };
          await writeSupervisorState(config.statePath, state, now());
          logEvent("dashboard_recovery_dispatch_accepted", withoutUndefined(dashboardRecovery));
        } else {
          logEvent("dashboard_recovery_dispatch_skipped", withoutUndefined(dashboardRecovery));
        }
      } catch (error) {
        dashboardRecovery = { action: "defer", reason: "dashboard_recovery_evaluation_error" };
        logEvent("dashboard_recovery_evaluation_error", { message: safeErrorMessage(error) });
      }
    } else if (ingestionRecoveryAccepted) {
      dashboardRecovery = {
        action: "defer",
        reason: rerunAccepted ? "lease_rerun_accepted" : "ingestion_recovery_dispatch_accepted"
      };
    }
    await writeSupervisorState(config.statePath, state, now());
    return {
      status: "completed",
      scanned: scan.scanned,
      candidates: scan.candidates.length,
      marked,
      deferred,
      recovery,
      dashboardRecovery
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
  let dashboardWorkflowPromise = null;
  let mainPromise = null;
  let runsPromise = null;
  let dashboardRunsPromise = null;
  let runnersPromise = null;
  const repoEndpoint = `repos/${config.repository}`;
  const workflowSelector = encodeURIComponent(path.basename(config.workflowPath));
  const dashboardWorkflowSelector = encodeURIComponent(path.basename(config.dashboardWorkflowPath));
  const getWorkflowRuns = ({ fresh = false } = {}) => {
    if (fresh || !runsPromise) {
      runsPromise = apiJson(
        `${repoEndpoint}/actions/workflows/${workflowSelector}/runs?per_page=100`
      ).then((response) => Array.isArray(response?.workflow_runs) ? response.workflow_runs : []);
    }
    return runsPromise;
  };
  const getDashboardWorkflowRuns = ({ fresh = false } = {}) => {
    if (fresh || !dashboardRunsPromise) {
      dashboardRunsPromise = apiJson(
        `${repoEndpoint}/actions/workflows/${dashboardWorkflowSelector}/runs?per_page=100`
      ).then((response) => Array.isArray(response?.workflow_runs) ? response.workflow_runs : []);
    }
    return dashboardRunsPromise;
  };

  return Object.freeze({
    getWorkflow: () => {
      workflowPromise ??= apiJson(`${repoEndpoint}/actions/workflows/${workflowSelector}`);
      return workflowPromise;
    },
    getDashboardWorkflow: () => {
      dashboardWorkflowPromise ??= apiJson(
        `${repoEndpoint}/actions/workflows/${dashboardWorkflowSelector}`
      );
      return dashboardWorkflowPromise;
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
    getDashboardWorkflowRuns,
    getActiveRuns: ({ fresh = false } = {}) =>
      getWorkflowRuns({ fresh }).then((runs) =>
        runs.filter((run) =>
          ACTIVE_RUN_STATUSES.has(String(run?.status ?? ""))
        )
      ),
    getRunners: ({ fresh = false } = {}) => {
      if (fresh || !runnersPromise) {
        runnersPromise = apiJson(`${repoEndpoint}/actions/runners?per_page=100`).then(
          (response) => Array.isArray(response?.runners) ? response.runners : []
        );
      }
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
    },
    dispatchDashboardRecovery: async (observedHeadSha) => {
      if (!FULL_SHA.test(String(observedHeadSha ?? ""))) {
        throw new Error("Dashboard recovery dispatch requires an exact observed main commit SHA.");
      }
      await execute(
        config.ghBin,
        [
          "api",
          "--method",
          "POST",
          `${repoEndpoint}/actions/workflows/${dashboardWorkflowSelector}/dispatches`,
          "-F",
          `ref=${config.defaultBranch}`,
          "-F",
          "inputs[skip_external_discovery]=false"
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
        recoveryDispatch: null,
        dashboardRecoveryDispatch: null
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
  if (
    parsed.dashboardRecoveryDispatch !== undefined &&
    parsed.dashboardRecoveryDispatch !== null
  ) {
    const recovery = parsed.dashboardRecoveryDispatch;
    if (
      !plainObject(recovery) ||
      recovery.eventType !== "workflow_dispatch" ||
      recovery.workflowPath !== DASHBOARD_WORKFLOW_PATH ||
      !FULL_SHA.test(recovery.observedHeadSha ?? "") ||
      !DASHBOARD_WATERMARK_STATUSES.has(recovery.watermarkStatus) ||
      (recovery.observedGeneratedAt !== null &&
        !strictUtcInstantOrNull(recovery.observedGeneratedAt)) ||
      !Number.isFinite(Date.parse(recovery.dispatchedAt ?? ""))
    ) {
      throw new Error("Lease supervisor dashboard recovery dispatch state is malformed.");
    }
  }
  parsed.dashboardRecoveryDispatch ??= null;
  return parsed;
}

export async function writeSupervisorState(statePath, state, timestamp = new Date()) {
  const next = {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    initializedAt: state.initializedAt ?? null,
    updatedAt: timestamp.toISOString(),
    workerLogs: state.workerLogs,
    handledEvents: state.handledEvents,
    recoveryDispatch: state.recoveryDispatch ?? null,
    dashboardRecoveryDispatch: state.dashboardRecoveryDispatch ?? null
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

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function strictUtcInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error("Timestamp must be an exact UTC RFC3339 instant.");
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw new Error("Timestamp must identify a real UTC instant.");
  }
  return instant;
}

function strictUtcInstantOrNull(value) {
  try {
    strictUtcInstant(value);
    return true;
  } catch {
    return false;
  }
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
