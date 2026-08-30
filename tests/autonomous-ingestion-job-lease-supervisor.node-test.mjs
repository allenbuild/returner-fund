import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertAuthBrowserLaunchAgentPlist,
  assertAwakeLaunchAgentPlist,
  AWAKE_LABEL,
  autonomousIngestionHostPaths,
  bootstrapLaunchAgentAfterTeardown,
  findLegacyBroadCaffeinateProcesses,
  installAutonomousIngestionHost,
  renderLaunchAgentTemplate,
  resolveInstallerOperation,
  RUNNER_LAUNCHD_LABEL,
  SUPERVISOR_LABEL,
  uninstallAutonomousIngestionHost
} from "../scripts/install-autonomous-ingestion-job-lease-supervisor.mjs";
import {
  AUTH_BROWSER_LABEL,
  AUTH_CHROME_BUNDLE_IDENTIFIER,
  AUTH_CHROME_TEAM_IDENTIFIER
} from "../scripts/lib/auth-browser-service.mjs";
import {
  acquireSupervisorLock,
  createGitHubClient,
  evaluateDashboardRecovery,
  evaluateLeaseLossEvent,
  evaluateMaintenanceWakeStatus,
  evaluatePowerStatus,
  evaluateRecoveryHostStatus,
  evaluateRunnerRestart,
  evaluateScheduleRecovery,
  kickstartRunnerLaunchAgent,
  loadSupervisorState,
  parseWorkerLeaseLossLog,
  readDashboardPublicationWatermark,
  readHostWakeStatus,
  runSupervisor,
  supervisorConfig,
  verifyCancelledAutonomousJob,
  verifyDashboardRecoveryWorkflow,
  verifyWorkflowRun
} from "../scripts/supervise-autonomous-ingestion-job-lease.mjs";

const CURRENT_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_LOG = `
"jobDisplayName": "Publish accepted slot central-2026-08-25-1800",
"contextData": {"github": {"d": [
  {"k": "repository", "v": "allenbuild/returner-fund"},
  {"k": "run_id", "v": "12345"},
  {"k": "run_attempt", "v": "1"},
  {"k": "workflow", "v": "Autonomous Ingestion"}
]}}
[2026-08-26 02:14:29Z INFO Worker] Cancellation/Shutdown message received.
[2026-08-26 02:14:46Z ERR Worker] TaskOrchestrationJobNotFoundException: Job not found: uuid. workflow instance not found
`;

function config(overrides = {}) {
  const stateDir = overrides.stateDir ?? "/tmp/returner-supervisor-state";
  return {
    repository: "allenbuild/returner-fund",
    workflowPath: ".github/workflows/autonomous-ingestion.yml",
    dashboardWorkflowPath: ".github/workflows/dashboard-refresh.yml",
    defaultBranch: "main",
    runnerName: "returner-social-mac-allenxtech",
    runnerLaunchdLabel: RUNNER_LAUNCHD_LABEL,
    runnerDiagDir: "/tmp/returner-runner-diag",
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock"),
    ghBin: "/opt/homebrew/bin/gh",
    minBatteryPercent: 30,
    maxWorkerLogBytes: 32 * 1024 * 1024,
    runnerRestartEnabled: false,
    runnerRestartCooldownMinutes: 30,
    scheduleRecoveryEnabled: false,
    scheduleRecoverySilenceMinutes: 30,
    scheduleRecoveryCooldownMinutes: 30,
    dashboardRecoveryEnabled: false,
    dashboardRecoveryMaxAgeMinutes: 120,
    dashboardRecoverySilenceMinutes: 30,
    dashboardRecoveryCooldownMinutes: 30,
    dryRun: false,
    ...overrides
  };
}

function event() {
  return parseWorkerLeaseLossLog(WORKER_LOG, { filename: "Worker_20260826-012635-utc.log" });
}

function workflow() {
  return {
    id: 42,
    name: "Autonomous Ingestion",
    path: ".github/workflows/autonomous-ingestion.yml",
    state: "active"
  };
}

function dashboardWorkflow(overrides = {}) {
  return {
    id: 84,
    name: "Technology Dashboard Refresh",
    path: ".github/workflows/dashboard-refresh.yml",
    state: "active",
    ...overrides
  };
}

function dashboardArtifact(generatedAt = "2026-08-26T17:00:00.000Z", overrides = {}) {
  const generatedAtMs = Date.parse(generatedAt);
  return JSON.stringify({
    schemaVersion: "technology-dashboard-v2",
    sourceSnapshotFingerprint: "f".repeat(64),
    generatedAt,
    updatedAt: generatedAt,
    windowStart: new Date(generatedAtMs - 72 * 60 * 60 * 1_000).toISOString(),
    windowEnd: generatedAt,
    todayInTech: [],
    stories: [],
    availableFilters: { topics: [], platforms: [] },
    status: {
      candidateCount: 0,
      eligibleCandidateCount: 0,
      storyCount: 0,
      viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
      partialPlatformFailures: []
    },
    ...overrides
  });
}

function run(overrides = {}) {
  return {
    id: 12345,
    workflow_id: 42,
    name: "Autonomous Ingestion",
    path: ".github/workflows/autonomous-ingestion.yml",
    repository: { full_name: "allenbuild/returner-fund" },
    head_branch: "main",
    head_sha: CURRENT_SHA,
    event: "schedule",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    ...overrides
  };
}

function jobs(overrides = {}) {
  return [
    {
      id: 99,
      name: "Publish accepted slot central-2026-08-25-1800",
      runner_name: "returner-social-mac-allenxtech",
      status: "completed",
      conclusion: "failure",
      steps: [
        { name: "Run autonomous ingestion", status: "completed", conclusion: "cancelled" }
      ],
      ...overrides
    }
  ];
}

function github(overrides = {}) {
  return {
    getWorkflow: async () => workflow(),
    getDashboardWorkflow: async () => dashboardWorkflow(),
    getRun: async () => run(),
    getAttemptJobs: async () => jobs(),
    getBranchHead: async () => CURRENT_SHA,
    getWorkflowRuns: async () => [],
    getDashboardWorkflowRuns: async () => [],
    getActiveRuns: async () => [],
    getRunners: async () => [{ id: 7, name: "returner-social-mac-allenxtech", status: "online", busy: false }],
    getRepositoryText: async () => {
      const error = new Error("fixture artifact is missing");
      error.code = "ENOENT";
      throw error;
    },
    rerunFailedJobs: async () => {},
    dispatchRecovery: async () => {},
    dispatchDashboardRecovery: async () => {},
    ...overrides
  };
}

test("worker parser requires exact autonomous context, cancellation, and JobNotFound", () => {
  assert.deepEqual(event(), {
    runId: "12345",
    runAttempt: 1,
    repository: "allenbuild/returner-fund",
    workflowName: "Autonomous Ingestion",
    jobName: "Publish accepted slot central-2026-08-25-1800",
    workerLog: "Worker_20260826-012635-utc.log",
    eventId: "12345:1:Publish accepted slot central-2026-08-25-1800"
  });
  assert.equal(
    parseWorkerLeaseLossLog(
      WORKER_LOG
        .replace("TaskOrchestrationJobNotFoundException", "OtherFailure")
        .replace("Job not found:", "Different failure:")
    ),
    null
  );
  assert.equal(
    parseWorkerLeaseLossLog(WORKER_LOG.replace("Cancellation/Shutdown", "Ordinary completion")),
    null
  );
  assert.equal(
    parseWorkerLeaseLossLog(WORKER_LOG.replace("Autonomous Ingestion", "Other Workflow")),
    null
  );
});

test("power gate accepts AC and healthy battery while preserving the reserve floor", () => {
  assert.deepEqual(
    evaluatePowerStatus("Now drawing from 'AC Power'\n -InternalBattery-0 12%; charging"),
    { eligible: true, reason: "ac_power", percent: 12 }
  );
  assert.deepEqual(evaluatePowerStatus("Now drawing from 'AC Power'"), {
    eligible: true,
    reason: "ac_power",
    percent: null
  });
  for (const percent of [100, 92, 60, 30]) {
    assert.deepEqual(
      evaluatePowerStatus(
        `Now drawing from 'Battery Power'\n -InternalBattery-0 ${percent}%; discharging`
      ),
      { eligible: true, reason: "healthy_battery_reserve", percent }
    );
  }
  for (const percent of [29, 20, 0]) {
    assert.deepEqual(
      evaluatePowerStatus(
        `Now drawing from 'Battery Power'\n -InternalBattery-0 ${percent}%; discharging`
      ),
      { eligible: false, reason: "battery_below_reserve", percent }
    );
  }
  assert.deepEqual(evaluatePowerStatus("Now drawing from 'Battery Power'", 30), {
    eligible: false,
    reason: "battery_percent_unknown",
    percent: null
  });
  assert.deepEqual(evaluatePowerStatus("unknown"), {
    eligible: false,
    reason: "power_source_unknown",
    percent: null
  });
  assert.deepEqual(evaluatePowerStatus(""), {
    eligible: false,
    reason: "power_status_unavailable",
    percent: null
  });
});

test("maintenance-wake gate accepts exactly one full-wake signal and fails closed", () => {
  assert.deepEqual(
    evaluateMaintenanceWakeStatus('+-o Root  <class IORegistryEntry>\n  "IOPMUserTriggeredFullWake" = Yes'),
    { fullWake: true, reason: "full_wake" }
  );
  assert.deepEqual(
    evaluateMaintenanceWakeStatus('"IOPMUserTriggeredFullWake" = No'),
    { fullWake: false, reason: "maintenance_dark_wake" }
  );
  for (const unavailable of [
    "",
    "IOPMUserTriggeredFullWake is missing",
    '"IOPMUserTriggeredFullWake" = Yes\n"IOPMUserTriggeredFullWake" = Yes',
    '"IOPMUserTriggeredFullWake" = Yes\n"IOPMUserTriggeredFullWake" = No'
  ]) {
    assert.deepEqual(evaluateMaintenanceWakeStatus(unavailable), {
      fullWake: false,
      reason: "wake_status_unavailable"
    });
  }
});

test("wake-status reader uses the root power domain and retries one transient failure", async () => {
  const calls = [];
  const expected = '"IOPMUserTriggeredFullWake" = Yes';
  const actual = await readHostWakeStatus({
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length === 1) throw new Error("transient ioreg timeout");
      return { stdout: expected };
    }
  });

  assert.equal(actual, expected);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "/usr/sbin/ioreg");
    assert.deepEqual(call.args, ["-r", "-n", "IOPMrootDomain", "-d", "1"]);
    assert.deepEqual(call.options, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    });
  }
});

test("wake-status reader retries an unavailable result and still fails closed", async () => {
  let calls = 0;
  const actual = await readHostWakeStatus({
    execute: async () => {
      calls += 1;
      return { stdout: "IOPMUserTriggeredFullWake is unavailable" };
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(evaluateMaintenanceWakeStatus(actual), {
    fullWake: false,
    reason: "wake_status_unavailable"
  });
});

test("wake-status reader accepts a valid maintenance wake without retrying", async () => {
  let calls = 0;
  const actual = await readHostWakeStatus({
    execute: async () => {
      calls += 1;
      return { stdout: '"IOPMUserTriggeredFullWake" = No' };
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(evaluateMaintenanceWakeStatus(actual), {
    fullWake: false,
    reason: "maintenance_dark_wake"
  });
});

test("two wake-reader failures remain fail-closed through schedule recovery", async () => {
  let wakeReads = 0;
  let dispatches = 0;
  const decision = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      dispatchRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 87%; discharging",
    readWakeStatus: () => readHostWakeStatus({
      execute: async () => {
        wakeReads += 1;
        throw new Error("persistent ioreg timeout");
      }
    }),
    now: new Date("2026-08-26T05:05:00.000Z")
  });

  assert.equal(wakeReads, 2);
  assert.equal(decision.action, "defer");
  assert.equal(decision.reason, "wake_status_unavailable");
  assert.equal(decision.batteryPercent, 87);
  assert.equal(dispatches, 0);
});

test("recovery host gate ignores wake state on AC and requires full wake on battery", () => {
  assert.deepEqual(
    evaluateRecoveryHostStatus({
      powerSource: "Now drawing from 'AC Power'\n 12%; charging",
      wakeSource: '"IOPMUserTriggeredFullWake" = No'
    }),
    {
      eligible: true,
      reason: "ac_power",
      percent: 12,
      powerReason: "ac_power",
      wakeReason: null
    }
  );
  assert.equal(
    evaluateRecoveryHostStatus({
      powerSource: "Now drawing from 'Battery Power'\n 72%; discharging",
      wakeSource: '"IOPMUserTriggeredFullWake" = Yes'
    }).eligible,
    true
  );
  assert.equal(
    evaluateRecoveryHostStatus({
      powerSource: "Now drawing from 'Battery Power'\n 72%; discharging",
      wakeSource: '"IOPMUserTriggeredFullWake" = No'
    }).reason,
    "maintenance_dark_wake"
  );
  assert.equal(
    evaluateRecoveryHostStatus({
      powerSource: "Now drawing from 'Battery Power'\n 72%; discharging",
      wakeSource: ""
    }).reason,
    "wake_status_unavailable"
  );
});

test("schedule recovery is enabled with bounded silence and cooldown defaults", () => {
  const defaults = supervisorConfig({});
  assert.equal(defaults.runnerRestartEnabled, true);
  assert.equal(defaults.runnerLaunchdLabel, RUNNER_LAUNCHD_LABEL);
  assert.equal(defaults.runnerRestartCooldownMinutes, 30);
  assert.equal(defaults.scheduleRecoveryEnabled, true);
  assert.equal(defaults.scheduleRecoverySilenceMinutes, 30);
  assert.equal(defaults.scheduleRecoveryCooldownMinutes, 30);
  assert.equal(defaults.minBatteryPercent, 30);
  assert.equal(supervisorConfig({ RETURNER_MIN_BATTERY_PERCENT: "100" }).minBatteryPercent, 100);
  assert.throws(
    () => supervisorConfig({ RETURNER_MIN_BATTERY_PERCENT: "20" }),
    /must be between 21 and 100/
  );
  assert.equal(
    supervisorConfig({ RETURNER_SCHEDULE_RECOVERY_ENABLED: "false" }).scheduleRecoveryEnabled,
    false
  );
  assert.equal(
    supervisorConfig({ RETURNER_RUNNER_RESTART_ENABLED: "false" }).runnerRestartEnabled,
    false
  );
  assert.throws(
    () => supervisorConfig({ RETURNER_RUNNER_LAUNCHD_LABEL: "unsafe/label" }),
    /safe launchd service label/
  );
  assert.throws(
    () => supervisorConfig({ RETURNER_SCHEDULE_RECOVERY_SILENCE_MINUTES: "14" }),
    /must be between 15 and 720/
  );
});

test("dashboard recovery is enabled with the public freshness and retry defaults", () => {
  const defaults = supervisorConfig({});
  assert.equal(defaults.dashboardWorkflowPath, ".github/workflows/dashboard-refresh.yml");
  assert.equal(defaults.dashboardRecoveryEnabled, true);
  assert.equal(defaults.dashboardRecoveryMaxAgeMinutes, 120);
  assert.equal(defaults.dashboardRecoverySilenceMinutes, 30);
  assert.equal(defaults.dashboardRecoveryCooldownMinutes, 30);
  assert.equal(
    supervisorConfig({ RETURNER_DASHBOARD_RECOVERY_ENABLED: "false" }).dashboardRecoveryEnabled,
    false
  );
  assert.throws(
    () => supervisorConfig({ RETURNER_DASHBOARD_RECOVERY_MAX_AGE_MINUTES: "59" }),
    /must be between 60 and 1440/
  );
});

test("dashboard watermark accepts only a coherent v2 publication and uses the two-hour boundary", async () => {
  const current = await readDashboardPublicationWatermark({
    readText: async () => dashboardArtifact("2026-08-26T17:00:00.000Z"),
    now: new Date("2026-08-26T19:00:00.000Z"),
    maxAgeMinutes: 120
  });
  assert.deepEqual(current, {
    status: "current",
    generatedAt: "2026-08-26T17:00:00.000Z",
    ageMinutes: 120
  });

  const stale = await readDashboardPublicationWatermark({
    readText: async () => dashboardArtifact("2026-08-26T17:00:00.000Z"),
    now: new Date("2026-08-26T19:00:00.001Z"),
    maxAgeMinutes: 120
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.generatedAt, "2026-08-26T17:00:00.000Z");

  for (const malformed of [
    "not-json",
    dashboardArtifact("2026-08-26T17:00:00.000Z", { schemaVersion: "other" }),
    dashboardArtifact("2026-08-26T17:00:00.000Z", {
      updatedAt: "2026-08-26T18:00:00.000Z"
    }),
    dashboardArtifact("2026-08-26T17:00:00.000Z", {
      windowStart: "2026-08-24T17:00:00.000Z"
    }),
    dashboardArtifact("2026-08-26T20:00:00.000Z")
  ]) {
    const invalid = await readDashboardPublicationWatermark({
      readText: async () => malformed,
      now: new Date("2026-08-26T19:00:00.000Z")
    });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.generatedAt, null);
  }

  const missing = await readDashboardPublicationWatermark({
    readText: async () => {
      throw new Error("404");
    },
    now: new Date("2026-08-26T19:00:00.000Z")
  });
  assert.deepEqual(missing, { status: "missing", generatedAt: null, ageMinutes: null });
});

test("dashboard recovery verifies the exact active workflow identity", () => {
  assert.equal(
    verifyDashboardRecoveryWorkflow({ workflow: dashboardWorkflow(), config: config() }).valid,
    true
  );
  assert.equal(
    verifyDashboardRecoveryWorkflow({
      workflow: dashboardWorkflow({ name: "Lookalike" }),
      config: config()
    }).reason,
    "dashboard_workflow_name_mismatch"
  );
  assert.equal(
    verifyDashboardRecoveryWorkflow({
      workflow: dashboardWorkflow({ state: "disabled_manually" }),
      config: config()
    }).reason,
    "dashboard_workflow_not_active"
  );
});

test("stale dashboard recovery respects battery reserve, runner idle state, and failed wakes", async () => {
  const dispatches = [];
  const testConfig = config({ dashboardRecoveryEnabled: true });
  const api = github({
    getRepositoryText: async () => dashboardArtifact("2026-08-26T17:00:00.000Z"),
    getDashboardWorkflowRuns: async () => [{
      id: 901,
      status: "completed",
      conclusion: "failure",
      created_at: "2026-08-26T19:58:00.000Z"
    }],
    dispatchDashboardRecovery: async (headSha) => dispatches.push(headSha)
  });
  const state = { dashboardRecoveryDispatch: null };
  const now = new Date("2026-08-26T20:05:00.000Z");

  const battery = await evaluateDashboardRecovery({
    config: testConfig,
    github: api,
    state,
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 29%; discharging",
    now
  });
  assert.equal(battery.action, "defer");
  assert.equal(battery.reason, "battery_below_reserve");
  assert.equal(battery.batteryPercent, 29);
  assert.deepEqual(dispatches, []);

  const busy = await evaluateDashboardRecovery({
    config: testConfig,
    github: github({
      ...api,
      getRunners: async () => [{
        id: 7,
        name: "returner-social-mac-allenxtech",
        status: "online",
        busy: true
      }]
    }),
    state,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    now
  });
  assert.equal(busy.reason, "runner_busy");
  assert.deepEqual(dispatches, []);

  const accepted = await evaluateDashboardRecovery({
    config: testConfig,
    github: api,
    state,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 72%; charging",
    now
  });
  assert.equal(accepted.action, "dispatch");
  assert.equal(accepted.watermarkStatus, "stale");
  assert.equal(accepted.publicationWatermark, "2026-08-26T17:00:00.000Z");
  assert.deepEqual(dispatches, [CURRENT_SHA]);
});

test("active dashboard or ingestion work suppresses a duplicate dashboard dispatch", async () => {
  const testConfig = config({ dashboardRecoveryEnabled: true });
  let dispatches = 0;
  const common = {
    getRepositoryText: async () => dashboardArtifact("2026-08-26T17:00:00.000Z"),
    dispatchDashboardRecovery: async () => {
      dispatches += 1;
    }
  };
  const dashboardActive = await evaluateDashboardRecovery({
    config: testConfig,
    github: github({
      ...common,
      getDashboardWorkflowRuns: async () => [{ id: 902, status: "queued" }]
    }),
    state: { dashboardRecoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'",
    now: new Date("2026-08-26T20:05:00.000Z")
  });
  assert.equal(dashboardActive.reason, "dashboard_run_active");

  const ingestionActive = await evaluateDashboardRecovery({
    config: testConfig,
    github: github({
      ...common,
      getActiveRuns: async () => [{ id: 903, status: "in_progress" }]
    }),
    state: { dashboardRecoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'",
    now: new Date("2026-08-26T20:05:00.000Z")
  });
  assert.equal(ingestionActive.reason, "autonomous_run_active");
  assert.equal(dispatches, 0);
});

test("a current dashboard feed and a recent successful wake suppress recovery", async () => {
  const testConfig = config({ dashboardRecoveryEnabled: true });
  let dispatches = 0;
  const current = await evaluateDashboardRecovery({
    config: testConfig,
    github: github({
      getRepositoryText: async () => dashboardArtifact("2026-08-26T19:00:00.000Z"),
      dispatchDashboardRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { dashboardRecoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'",
    now: new Date("2026-08-26T20:05:00.000Z")
  });
  assert.equal(current.action, "current");
  assert.equal(current.reason, "dashboard_publication_current");

  const recentSuccess = await evaluateDashboardRecovery({
    config: testConfig,
    github: github({
      getRepositoryText: async () => dashboardArtifact("2026-08-26T17:00:00.000Z"),
      getDashboardWorkflowRuns: async () => [{
      id: 904,
      status: "completed",
      conclusion: "success",
      created_at: "2026-08-26T17:58:00.000Z",
      updated_at: "2026-08-26T19:58:00.000Z"
      }],
      dispatchDashboardRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { dashboardRecoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'",
    now: new Date("2026-08-26T20:05:00.000Z")
  });
  assert.equal(recentSuccess.reason, "recent_successful_dashboard_wakeup");
  assert.equal(dispatches, 0);
});

test("remote verification is exact about workflow, failed run, runner, and cancelled step", () => {
  const exactEvent = event();
  assert.equal(
    verifyWorkflowRun({ workflow: workflow(), run: run(), event: exactEvent, config: config() }).valid,
    true
  );
  assert.equal(
    verifyWorkflowRun({
      workflow: workflow(),
      run: run({ conclusion: "cancelled" }),
      event: exactEvent,
      config: config()
    }).reason,
    "run_not_completed_failure"
  );
  assert.equal(
    verifyCancelledAutonomousJob({ jobs: jobs(), event: exactEvent, config: config() }).valid,
    true
  );
  assert.equal(
    verifyCancelledAutonomousJob({
      jobs: jobs({ runner_name: "different-runner" }),
      event: exactEvent,
      config: config()
    }).reason,
    "runner_name_mismatch"
  );
  assert.equal(
    verifyCancelledAutonomousJob({
      jobs: jobs({
        steps: [{ name: "Run autonomous ingestion", status: "completed", conclusion: "failure" }]
      }),
      event: exactEvent,
      config: config()
    }).reason,
    "ingestion_step_not_cancelled"
  );
});

test("runner kickstart uses one bounded same-user launchctl command without replacement", async () => {
  const calls = [];
  const result = await kickstartRunnerLaunchAgent({
    label: RUNNER_LAUNCHD_LABEL,
    uid: 501,
    execute: async (binary, args, options) => {
      calls.push({ binary, args, options });
      return { stdout: "8123\n", stderr: "" };
    }
  });
  assert.deepEqual(result, { pid: 8123 });
  assert.deepEqual(calls, [{
    binary: "/bin/launchctl",
    args: ["kickstart", "-p", `gui/501/${RUNNER_LAUNCHD_LABEL}`],
    options: { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8" }
  }]);
  assert.equal(calls[0].args.includes("-k"), false);
  assert.doesNotMatch(JSON.stringify(calls[0]), /svc\.sh|bootstrap|bootout|sudo|shell/);

  await assert.rejects(
    kickstartRunnerLaunchAgent({
      label: RUNNER_LAUNCHD_LABEL,
      uid: 501,
      execute: async () => ({ stdout: "8123\n8124\n", stderr: "" })
    }),
    /one positive process ID/
  );
  await assert.rejects(
    kickstartRunnerLaunchAgent({ label: RUNNER_LAUNCHD_LABEL, uid: 0 }),
    /non-root macOS user ID/
  );
});

test("runner restart evaluation never kickstarts online, busy, missing, or duplicate identities", async () => {
  const cases = [
    {
      runners: [{ id: 7, name: "returner-social-mac-allenxtech", status: "online", busy: false }],
      action: "current",
      reason: "runner_online_idle"
    },
    {
      runners: [{ id: 7, name: "returner-social-mac-allenxtech", status: "online", busy: true }],
      action: "current",
      reason: "runner_online_busy"
    },
    { runners: [], action: "defer", reason: "runner_not_exact" },
    {
      runners: [
        { id: 7, name: "returner-social-mac-allenxtech", status: "offline", busy: false },
        { id: 8, name: "returner-social-mac-allenxtech", status: "offline", busy: false }
      ],
      action: "defer",
      reason: "runner_not_exact"
    },
    {
      runners: [{ id: 7, name: "returner-social-mac-allenxtech", status: "offline", busy: true }],
      action: "defer",
      reason: "runner_offline_busy_inconsistent"
    }
  ];

  for (const scenario of cases) {
    let fresh = null;
    const decision = await evaluateRunnerRestart({
      config: config({ runnerRestartEnabled: true }),
      github: {
        getRunners: async (options) => {
          fresh = options?.fresh;
          return scenario.runners;
        }
      },
      state: { runnerRestartAttempt: null },
      readPowerStatus: async () => {
        throw new Error("power must not be read for this runner state");
      },
      readWakeStatus: async () => {
        throw new Error("wake must not be read for this runner state");
      },
      now: new Date("2026-08-26T05:05:00.000Z")
    });
    assert.equal(fresh, true);
    assert.equal(decision.action, scenario.action);
    assert.equal(decision.reason, scenario.reason);
  }
});

test("stale head and newer attempts are terminal without issuing a rerun", async () => {
  let reruns = 0;
  const stale = await evaluateLeaseLossEvent({
    event: event(),
    config: config(),
    github: github({
      getRun: async () => run({ head_sha: STALE_SHA }),
      rerunFailedJobs: async () => {
        reruns += 1;
      }
    }),
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 1%; discharging"
  });
  assert.deepEqual(stale, {
    action: "mark",
    disposition: "stale_head",
    runHeadSha: STALE_SHA,
    currentHeadSha: CURRENT_SHA
  });

  const newer = await evaluateLeaseLossEvent({
    event: event(),
    config: config(),
    github: github({ getRun: async () => run({ run_attempt: 2 }) }),
    readPowerStatus: async () => ""
  });
  assert.deepEqual(newer, { action: "mark", disposition: "newer_attempt", currentAttempt: 2 });
  assert.equal(reruns, 0);
});

test("active workflow and low battery defer without issuing or deduping a rerun", async () => {
  let reruns = 0;
  const active = await evaluateLeaseLossEvent({
    event: event(),
    config: config(),
    github: github({
      getActiveRuns: async () => [{ id: 777, status: "in_progress" }],
      rerunFailedJobs: async () => {
        reruns += 1;
      }
    }),
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged"
  });
  assert.equal(active.action, "defer");
  assert.equal(active.reason, "autonomous_run_active");

  const battery = await evaluateLeaseLossEvent({
    event: event(),
    config: config(),
    github: github({
      rerunFailedJobs: async () => {
        reruns += 1;
      }
    }),
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 29%; discharging"
  });
  assert.equal(battery.action, "defer");
  assert.equal(battery.reason, "battery_below_reserve");
  assert.equal(battery.batteryPercent, 29);
  assert.equal(reruns, 0);
});

test("every supervisor recovery mutation defers during a battery maintenance dark wake", async () => {
  let mutations = 0;
  const api = github({
    getRepositoryText: async () => dashboardArtifact("2026-08-26T17:00:00.000Z"),
    rerunFailedJobs: async () => {
      mutations += 1;
    },
    dispatchRecovery: async () => {
      mutations += 1;
    },
    dispatchDashboardRecovery: async () => {
      mutations += 1;
    }
  });
  const readPowerStatus = async () => "Now drawing from 'Battery Power'\n 72%; discharging";
  const readWakeStatus = async () => '"IOPMUserTriggeredFullWake" = No';

  const lease = await evaluateLeaseLossEvent({
    event: event(),
    config: config(),
    github: api,
    readPowerStatus,
    readWakeStatus
  });
  assert.equal(lease.reason, "maintenance_dark_wake");

  const schedule = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: api,
    state: { recoveryDispatch: null },
    readPowerStatus,
    readWakeStatus,
    now: new Date("2026-08-26T05:05:00.000Z")
  });
  assert.equal(schedule.reason, "maintenance_dark_wake");

  const dashboard = await evaluateDashboardRecovery({
    config: config({ dashboardRecoveryEnabled: true }),
    github: api,
    state: { dashboardRecoveryDispatch: null },
    readPowerStatus,
    readWakeStatus,
    now: new Date("2026-08-26T20:05:00.000Z")
  });
  assert.equal(dashboard.reason, "maintenance_dark_wake");
  assert.equal(mutations, 0);
});

test("a low-battery deferral preserves the stale slot for immediate charged recovery", async () => {
  const dispatchedHeads = [];
  const testConfig = config({ scheduleRecoveryEnabled: true });
  const testGithub = github({
    getWorkflowRuns: async () => [{
      id: 880,
      event: "schedule",
      status: "completed",
      conclusion: "failure",
      created_at: "2026-08-26T04:30:00.000Z"
    }],
    dispatchRecovery: async (headSha) => dispatchedHeads.push(headSha)
  });
  const state = Object.freeze({ recoveryDispatch: null });
  const batteryDecision = await evaluateScheduleRecovery({
    config: testConfig,
    github: testGithub,
    state,
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 29%; discharging",
    now: new Date("2026-08-26T05:05:00.000Z")
  });

  assert.equal(batteryDecision.action, "defer");
  assert.equal(batteryDecision.reason, "battery_below_reserve");
  assert.equal(batteryDecision.batteryPercent, 29);
  assert.deepEqual(dispatchedHeads, []);

  const chargedDecision = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: testGithub,
    state,
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 72%; discharging",
    readWakeStatus: async () => '"IOPMUserTriggeredFullWake" = Yes',
    now: new Date("2026-08-26T05:05:00.000Z")
  });

  assert.equal(chargedDecision.action, "dispatch");
  assert.equal(chargedDecision.slotKey, "central-2026-08-25-1800");
  assert.equal(chargedDecision.scheduledAt, "2026-08-25T23:00:00.000Z");
  assert.equal(chargedDecision.watermarkStatus, "missing");
  assert.deepEqual(dispatchedHeads, [CURRENT_SHA]);
});

test("cancelled and skipped wakeups never postpone a behind-watermark recovery", async () => {
  for (const conclusion of ["cancelled", "skipped"]) {
    const dispatchedHeads = [];
    const decision = await evaluateScheduleRecovery({
      config: config({ scheduleRecoveryEnabled: true }),
      github: github({
        getWorkflowRuns: async () => [
          {
            id: 882,
            event: "schedule",
            status: "completed",
            conclusion,
            created_at: "2026-08-26T04:58:00.000Z"
          },
          {
            id: 881,
            event: "schedule",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-08-26T04:30:00.000Z"
          }
        ],
        dispatchRecovery: async (headSha) => dispatchedHeads.push(headSha)
      }),
      state: { recoveryDispatch: null },
      readPowerStatus: async () => "Now drawing from 'AC Power'\n 72%; charging",
      now: new Date("2026-08-26T05:05:00.000Z")
    });

    assert.equal(decision.action, "dispatch", conclusion);
    assert.deepEqual(dispatchedHeads, [CURRENT_SHA], conclusion);
  }
});

test("a recent completed failure still enforces the recovery silence window", async () => {
  let dispatches = 0;
  const decision = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      getWorkflowRuns: async () => [{
        id: 883,
        event: "schedule",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-08-26T04:58:00.000Z"
      }],
      dispatchRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 72%; charging",
    now: new Date("2026-08-26T05:05:00.000Z")
  });

  assert.equal(decision.action, "defer");
  assert.equal(decision.reason, "recent_workflow_wakeup");
  assert.equal(decision.latestRunId, "883");
  assert.equal(dispatches, 0);
});

test("an active or pending autonomous run suppresses duplicate recovery", async () => {
  let downstreamCalls = 0;
  const decision = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      getWorkflowRuns: async () => [{
        id: 991,
        event: "repository_dispatch",
        status: "queued",
        created_at: "2026-08-26T04:00:00.000Z"
      }],
      getRunners: async () => {
        downstreamCalls += 1;
        return [];
      },
      dispatchRecovery: async () => {
        downstreamCalls += 1;
      }
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => {
      downstreamCalls += 1;
      return "Now drawing from 'AC Power'\n 100%; charged";
    },
    now: new Date("2026-08-26T05:05:00.000Z")
  });

  assert.equal(decision.action, "defer");
  assert.equal(decision.reason, "autonomous_run_active");
  assert.equal(decision.activeRunId, "991");
  assert.equal(downstreamCalls, 0);
});

test("host recovery waits for the exact runner to be online and power-eligible", async () => {
  let dispatches = 0;
  const offline = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      getWorkflowRuns: async () => [],
      getRunners: async () => [{
        id: 7,
        name: "returner-social-mac-allenxtech",
        status: "offline",
        busy: false
      }],
      dispatchRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    now: new Date("2026-08-26T05:05:00.000Z")
  });
  assert.equal(offline.reason, "runner_offline");

  const battery = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      getWorkflowRuns: async () => [],
      dispatchRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 29%; discharging",
    now: new Date("2026-08-26T05:05:00.000Z")
  });
  assert.equal(battery.reason, "battery_below_reserve");
  assert.equal(battery.batteryPercent, 29);
  assert.equal(dispatches, 0);
});

test("a current committed publication watermark makes host recovery a no-op", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "public/graph/manifest.json"), "utf8")
  );
  let dispatches = 0;
  const decision = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      getWorkflowRuns: async () => [{
        id: 700,
        event: "schedule",
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-24T12:00:00.000Z"
      }],
      getRepositoryText: (relativePath) => readFile(path.join(repositoryRoot, relativePath), "utf8"),
      dispatchRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    now: new Date(manifest.publishedAt)
  });

  assert.equal(decision.action, "current");
  assert.equal(decision.reason, "publication-watermark-current");
  assert.equal(decision.watermarkStatus, "current");
  assert.equal(dispatches, 0);
});

test("offline runner kickstart is pre-persisted, suppresses mutations, and obeys durable cooldown", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-runner-restart-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runnerDiagDir = path.join(root, "diag");
  const stateDir = path.join(root, "state");
  await mkdir(runnerDiagDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(runnerDiagDir, "Worker_20260826-012635-utc.log"), WORKER_LOG);
  const testConfig = config({
    runnerDiagDir,
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock"),
    runnerRestartEnabled: true,
    scheduleRecoveryEnabled: true,
    dashboardRecoveryEnabled: true
  });
  await writeFile(testConfig.statePath, `${JSON.stringify({
    schemaVersion: 1,
    initializedAt: "2026-08-26T03:00:00.000Z",
    workerLogs: {},
    handledEvents: {},
    recoveryDispatch: null,
    dashboardRecoveryDispatch: null
  })}\n`);

  let kickstarts = 0;
  let mutations = 0;
  let maskedActiveRunReads = 0;
  const api = github({
    getRunners: async ({ fresh } = {}) => {
      assert.equal(fresh, true);
      return [{
        id: 7,
        name: "returner-social-mac-allenxtech",
        status: "offline",
        busy: false
      }];
    },
    getActiveRuns: async () => {
      maskedActiveRunReads += 1;
      return [{ id: 991, status: "queued" }];
    },
    getWorkflowRuns: async () => {
      maskedActiveRunReads += 1;
      return [{ id: 991, status: "queued" }];
    },
    rerunFailedJobs: async () => {
      mutations += 1;
    },
    dispatchRecovery: async () => {
      mutations += 1;
    },
    dispatchDashboardRecovery: async () => {
      mutations += 1;
    }
  });
  const kickstartRunner = async ({ label, runnerId }) => {
    kickstarts += 1;
    assert.equal(label, RUNNER_LAUNCHD_LABEL);
    assert.equal(runnerId, "7");
    const stateDuringEffect = await loadSupervisorState(testConfig.statePath);
    assert.equal(stateDuringEffect.runnerRestartAttempt.outcome, "pending");
    assert.equal(stateDuringEffect.runnerRestartAttempt.pid, null);
    return { pid: 8100 + kickstarts };
  };

  const first = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    kickstartRunner,
    now: () => new Date("2026-08-26T05:05:00.000Z")
  });
  assert.equal(first.runnerRecovery.action, "kickstart");
  assert.equal(first.runnerRecovery.reason, "runner_restart_accepted");
  assert.equal(first.runnerRecovery.pid, 8101);
  assert.equal(first.deferred, 1);
  assert.equal(first.recovery.reason, "runner_recovery_required");
  assert.equal(first.dashboardRecovery.reason, "runner_recovery_required");
  assert.equal(kickstarts, 1);
  assert.equal(mutations, 0);
  assert.equal(maskedActiveRunReads, 0);
  assert.deepEqual((await loadSupervisorState(testConfig.statePath)).runnerRestartAttempt, {
    attemptedAt: "2026-08-26T05:05:00.000Z",
    launchdLabel: RUNNER_LAUNCHD_LABEL,
    runnerId: "7",
    outcome: "accepted",
    pid: 8101
  });

  const cooldown = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    kickstartRunner,
    now: () => new Date("2026-08-26T05:10:00.000Z")
  });
  assert.equal(cooldown.runnerRecovery.reason, "runner_restart_cooldown");
  assert.equal(kickstarts, 1);

  const expired = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    kickstartRunner,
    now: () => new Date("2026-08-26T05:36:00.000Z")
  });
  assert.equal(expired.runnerRecovery.reason, "runner_restart_accepted");
  assert.equal(expired.runnerRecovery.pid, 8102);
  assert.equal(kickstarts, 2);
  assert.equal(mutations, 0);
});

test("failed runner kickstart is durable and consumes the same cooldown", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-runner-restart-failure-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runnerDiagDir = path.join(root, "diag");
  const stateDir = path.join(root, "state");
  await mkdir(runnerDiagDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const testConfig = config({
    runnerDiagDir,
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock"),
    runnerRestartEnabled: true
  });
  await writeFile(testConfig.statePath, `${JSON.stringify({
    schemaVersion: 1,
    initializedAt: "2026-08-26T03:00:00.000Z",
    workerLogs: {},
    handledEvents: {}
  })}\n`);
  const api = github({
    getRunners: async () => [{
      id: 7,
      name: "returner-social-mac-allenxtech",
      status: "offline",
      busy: false
    }]
  });
  let kickstarts = 0;
  const kickstartRunner = async () => {
    kickstarts += 1;
    throw new Error("launchctl rejected fixture request");
  };

  const failed = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'",
    kickstartRunner,
    now: () => new Date("2026-08-26T05:05:00.000Z")
  });
  assert.equal(failed.runnerRecovery.reason, "runner_restart_failed");
  assert.equal((await loadSupervisorState(testConfig.statePath)).runnerRestartAttempt.outcome, "failed");

  const cooldown = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'",
    kickstartRunner,
    now: () => new Date("2026-08-26T05:10:00.000Z")
  });
  assert.equal(cooldown.runnerRecovery.reason, "runner_restart_cooldown");
  assert.equal(kickstarts, 1);
});

test("missing workflow events dispatch once and durable same-slot cooldown prevents a storm", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-schedule-recovery-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runnerDiagDir = path.join(root, "diag");
  const stateDir = path.join(root, "state");
  await mkdir(runnerDiagDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const testConfig = config({
    runnerDiagDir,
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock"),
    scheduleRecoveryEnabled: true
  });
  await writeFile(testConfig.statePath, `${JSON.stringify({
    schemaVersion: 1,
    initializedAt: "2026-08-26T03:00:00.000Z",
    workerLogs: {},
    handledEvents: {},
    recoveryDispatch: null
  })}\n`);
  let dispatches = 0;
  const api = github({
    getWorkflowRuns: async () => [],
    dispatchRecovery: async () => {
      dispatches += 1;
    }
  });

  const first = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    now: () => new Date("2026-08-26T05:05:00.000Z")
  });
  assert.equal(first.recovery.action, "dispatch");
  assert.equal(dispatches, 1);
  const state = await loadSupervisorState(testConfig.statePath);
  assert.deepEqual(state.recoveryDispatch, {
    dispatchedAt: "2026-08-26T05:05:00.000Z",
    eventType: "autonomous-ingestion-recovery",
    expectedHeadSha: CURRENT_SHA,
    slotKey: "central-2026-08-25-1800"
  });

  const second = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    now: () => new Date("2026-08-26T05:10:00.000Z")
  });
  assert.equal(second.recovery.reason, "recovery_dispatch_cooldown");
  assert.equal(dispatches, 1);
});

test("an accepted dashboard catch-up dispatch is durably cooled down", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-dashboard-recovery-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runnerDiagDir = path.join(root, "diag");
  const stateDir = path.join(root, "state");
  await mkdir(runnerDiagDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const testConfig = config({
    runnerDiagDir,
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock"),
    dashboardRecoveryEnabled: true
  });
  await writeFile(testConfig.statePath, `${JSON.stringify({
    schemaVersion: 1,
    initializedAt: "2026-08-26T19:00:00.000Z",
    workerLogs: {},
    handledEvents: {},
    recoveryDispatch: null,
    dashboardRecoveryDispatch: null
  })}\n`);
  let dispatches = 0;
  const api = github({
    getRepositoryText: async () => dashboardArtifact("2026-08-26T17:00:00.000Z"),
    dispatchDashboardRecovery: async () => {
      dispatches += 1;
    }
  });

  const first = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    now: () => new Date("2026-08-26T20:05:00.000Z")
  });
  assert.equal(first.dashboardRecovery.action, "dispatch");
  assert.equal(dispatches, 1);
  assert.deepEqual((await loadSupervisorState(testConfig.statePath)).dashboardRecoveryDispatch, {
    dispatchedAt: "2026-08-26T20:05:00.000Z",
    eventType: "workflow_dispatch",
    workflowPath: ".github/workflows/dashboard-refresh.yml",
    observedHeadSha: CURRENT_SHA,
    watermarkStatus: "stale",
    observedGeneratedAt: "2026-08-26T17:00:00.000Z"
  });

  const second = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
    now: () => new Date("2026-08-26T20:10:00.000Z")
  });
  assert.equal(second.dashboardRecovery.reason, "dashboard_recovery_dispatch_cooldown");
  assert.equal(dispatches, 1);
});

test("persistent lease lookup errors cannot starve independent schedule recovery", async (context) => {
  for (const failingLookup of ["getRun", "getAttemptJobs"]) {
    await context.test(failingLookup, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "returner-lease-uncertainty-test-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const runnerDiagDir = path.join(root, "diag");
      const stateDir = path.join(root, "state");
      await mkdir(runnerDiagDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(runnerDiagDir, "Worker_20260826-012635-utc.log"), WORKER_LOG);
      const testConfig = config({
        runnerDiagDir,
        stateDir,
        statePath: path.join(stateDir, "state-v1.json"),
        lockPath: path.join(stateDir, "supervisor.lock"),
        scheduleRecoveryEnabled: true
      });
      await writeFile(testConfig.statePath, `${JSON.stringify({
        schemaVersion: 1,
        initializedAt: "2026-08-26T03:00:00.000Z",
        workerLogs: {},
        handledEvents: {},
        recoveryDispatch: null
      })}\n`);

      let dispatches = 0;
      let leaseLookupFailures = 0;
      let workflowRunReads = 0;
      const failLeaseLookup = async () => {
        leaseLookupFailures += 1;
        throw new Error(`persistent ${failingLookup} failure`);
      };
      const api = github({
        [failingLookup]: failLeaseLookup,
        getWorkflowRuns: async ({ fresh } = {}) => {
          assert.equal(fresh, true);
          workflowRunReads += 1;
          return [];
        },
        dispatchRecovery: async () => {
          dispatches += 1;
        }
      });

      const first = await runSupervisor({
        config: testConfig,
        github: api,
        readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
        now: () => new Date("2026-08-26T05:05:00.000Z")
      });
      assert.equal(first.deferred, 1);
      assert.equal(first.recovery.action, "dispatch");

      const second = await runSupervisor({
        config: testConfig,
        github: api,
        readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
        now: () => new Date("2026-08-26T05:10:00.000Z")
      });
      assert.equal(second.deferred, 1);
      assert.equal(second.recovery.reason, "recovery_dispatch_cooldown");
      assert.equal(leaseLookupFailures, 2);
      assert.equal(workflowRunReads, 2);
      assert.equal(dispatches, 1);

      const state = await loadSupervisorState(testConfig.statePath);
      assert.deepEqual(state.handledEvents, {});
      assert.equal(state.recoveryDispatch.slotKey, "central-2026-08-25-1800");
    });
  }
});

test("schedule recovery refreshes cached runs after an ambiguous rerun response", async (context) => {
  const scenarios = [
    {
      name: "active rerun",
      freshRuns: [{
        id: 12345,
        event: "schedule",
        status: "queued",
        conclusion: null,
        created_at: "2026-08-26T05:04:00.000Z"
      }],
      expectedReason: "autonomous_run_active"
    },
    {
      name: "recent completed rerun",
      freshRuns: [{
        id: 12345,
        event: "schedule",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-08-26T05:04:00.000Z"
      }],
      expectedReason: "recent_workflow_wakeup"
    }
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async (subtest) => {
      const root = await mkdtemp(path.join(tmpdir(), "returner-runs-refresh-test-"));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const runnerDiagDir = path.join(root, "diag");
      const stateDir = path.join(root, "state");
      await mkdir(runnerDiagDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(runnerDiagDir, "Worker_20260826-012635-utc.log"), WORKER_LOG);
      const testConfig = config({
        runnerDiagDir,
        stateDir,
        statePath: path.join(stateDir, "state-v1.json"),
        lockPath: path.join(stateDir, "supervisor.lock"),
        scheduleRecoveryEnabled: true
      });
      await writeFile(testConfig.statePath, `${JSON.stringify({
        schemaVersion: 1,
        initializedAt: "2026-08-26T03:00:00.000Z",
        workerLogs: {},
        handledEvents: {},
        recoveryDispatch: null
      })}\n`);

      let workflowRunsGets = 0;
      let rerunPosts = 0;
      let recoveryDispatchPosts = 0;
      const execute = async (_binary, args) => {
        const method = args[args.indexOf("--method") + 1];
        const endpoint = args.find((argument) => argument.startsWith("repos/"));
        if (method === "POST" && endpoint?.endsWith("/rerun-failed-jobs")) {
          rerunPosts += 1;
          throw new Error("connection reset after server accepted rerun");
        }
        if (method === "POST") {
          recoveryDispatchPosts += 1;
          return { stdout: "", stderr: "" };
        }
        if (endpoint?.endsWith("/actions/workflows/autonomous-ingestion.yml")) {
          return { stdout: JSON.stringify(workflow()), stderr: "" };
        }
        if (endpoint?.endsWith("/actions/runs/12345")) {
          return { stdout: JSON.stringify(run()), stderr: "" };
        }
        if (endpoint?.includes("/actions/runs/12345/attempts/1/jobs")) {
          return { stdout: JSON.stringify({ jobs: jobs() }), stderr: "" };
        }
        if (endpoint?.endsWith("/git/ref/heads/main")) {
          return { stdout: JSON.stringify({ object: { sha: CURRENT_SHA } }), stderr: "" };
        }
        if (endpoint?.includes("/actions/workflows/autonomous-ingestion.yml/runs?")) {
          workflowRunsGets += 1;
          return {
            stdout: JSON.stringify({
              workflow_runs: workflowRunsGets === 1 ? [] : scenario.freshRuns
            }),
            stderr: ""
          };
        }
        throw new Error(`Unexpected GitHub API request: ${method} ${endpoint}`);
      };

      const result = await runSupervisor({
        config: testConfig,
        github: createGitHubClient(testConfig, { execute }),
        readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged",
        now: () => new Date("2026-08-26T05:05:00.000Z")
      });

      assert.equal(result.deferred, 1);
      assert.equal(result.recovery.reason, scenario.expectedReason);
      assert.equal(workflowRunsGets, 2);
      assert.equal(rerunPosts, 1);
      assert.equal(recoveryDispatchPosts, 0);
      assert.deepEqual((await loadSupervisorState(testConfig.statePath)).handledEvents, {});
    });
  }
});

test("GitHub recovery dispatch sends only the trusted event and expected main SHA", async () => {
  const calls = [];
  const client = createGitHubClient(config(), {
    execute: async (binary, args, options) => {
      calls.push({ binary, args, options });
      return { stdout: "", stderr: "" };
    }
  });

  await client.dispatchRecovery(CURRENT_SHA);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("event_type=autonomous-ingestion-recovery"));
  assert.ok(calls[0].args.includes(`client_payload[expected_head_sha]=${CURRENT_SHA}`));
  assert.doesNotMatch(JSON.stringify(calls[0].args), /central-\d{4}/);
});

test("GitHub dashboard recovery dispatch always requests the full strictly gated refresh", async () => {
  const calls = [];
  const client = createGitHubClient(config(), {
    execute: async (binary, args, options) => {
      calls.push({ binary, args, options });
      return { stdout: "", stderr: "" };
    }
  });

  await client.dispatchDashboardRecovery(CURRENT_SHA);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].args.includes(
      "repos/allenbuild/returner-fund/actions/workflows/dashboard-refresh.yml/dispatches"
    )
  );
  assert.ok(calls[0].args.includes("ref=main"));
  assert.ok(calls[0].args.includes("inputs[skip_external_discovery]=false"));
  assert.doesNotMatch(JSON.stringify(calls[0].args), /no-external|skip_external_discovery=true/);
});

test("only an accepted rerun creates durable dedupe state", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-lease-supervisor-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runnerDiagDir = path.join(root, "diag");
  const stateDir = path.join(root, "state");
  await mkdir(runnerDiagDir, { recursive: true });
  await writeFile(path.join(runnerDiagDir, "Worker_20260826-012635-utc.log"), WORKER_LOG);
  const testConfig = config({
    runnerDiagDir,
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock")
  });
  let rerunCalls = 0;
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    testConfig.statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      initializedAt: "2026-08-26T00:00:00.000Z",
      workerLogs: {},
      handledEvents: {}
    })}\n`
  );
  const api = github({
    rerunFailedJobs: async () => {
      rerunCalls += 1;
      if (rerunCalls === 1) throw new Error("connection reset after no response");
    }
  });

  const first = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged"
  });
  assert.equal(first.deferred, 1);
  assert.deepEqual((await loadSupervisorState(testConfig.statePath)).handledEvents, {});

  const second = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged"
  });
  assert.equal(second.marked, 1);
  assert.equal(rerunCalls, 2);
  const state = await loadSupervisorState(testConfig.statePath);
  assert.equal(state.handledEvents[event().eventId].disposition, "rerun_accepted");

  const third = await runSupervisor({
    config: testConfig,
    github: api,
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 100%; charged"
  });
  assert.equal(third.marked, 0);
  assert.equal(rerunCalls, 2);
  assert.match(await readFile(testConfig.statePath, "utf8"), /"rerun_accepted"/);
});

test("first run baselines historical candidates without calling GitHub", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-lease-baseline-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runnerDiagDir = path.join(root, "diag");
  const stateDir = path.join(root, "state");
  await mkdir(runnerDiagDir, { recursive: true });
  await writeFile(path.join(runnerDiagDir, "Worker_20260826-012635-utc.log"), WORKER_LOG);
  const testConfig = config({
    runnerDiagDir,
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock")
  });
  let githubCalls = 0;
  const failIfCalled = async () => {
    githubCalls += 1;
    throw new Error("GitHub must not be called while baselining");
  };
  const result = await runSupervisor({
    config: testConfig,
    github: {
      getWorkflow: failIfCalled,
      getRun: failIfCalled,
      getAttemptJobs: failIfCalled,
      getBranchHead: failIfCalled,
      getActiveRuns: failIfCalled,
      rerunFailedJobs: failIfCalled
    },
    now: () => new Date("2026-08-26T03:00:00.000Z")
  });
  assert.equal(result.status, "baseline_initialized");
  assert.equal(result.marked, 1);
  assert.equal(githubCalls, 0);
  const state = await loadSupervisorState(testConfig.statePath);
  assert.equal(state.initializedAt, "2026-08-26T03:00:00.000Z");
  assert.equal(state.handledEvents[event().eventId].disposition, "baseline");
});

test("runner restart state is backward compatible and strictly validated", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-runner-state-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "state-v1.json");
  const legacyState = {
    schemaVersion: 1,
    initializedAt: "2026-08-26T03:00:00.000Z",
    workerLogs: {},
    handledEvents: {},
    recoveryDispatch: null,
    dashboardRecoveryDispatch: null
  };
  await writeFile(statePath, `${JSON.stringify(legacyState)}\n`);
  assert.equal((await loadSupervisorState(statePath)).runnerRestartAttempt, null);

  const validAttempt = {
    attemptedAt: "2026-08-26T05:05:00.000Z",
    launchdLabel: RUNNER_LAUNCHD_LABEL,
    runnerId: "7",
    outcome: "accepted",
    pid: 8123
  };
  for (const malformed of [
    { ...validAttempt, attemptedAt: "2026-08-26T05:05:00Z" },
    { ...validAttempt, launchdLabel: "unsafe/label" },
    { ...validAttempt, runnerId: 7 },
    { ...validAttempt, runnerId: "0" },
    { ...validAttempt, outcome: "unknown" },
    { ...validAttempt, pid: 0 }
  ]) {
    await writeFile(statePath, `${JSON.stringify({
      ...legacyState,
      runnerRestartAttempt: malformed
    })}\n`);
    await assert.rejects(
      loadSupervisorState(statePath),
      /runner restart state is malformed/
    );
  }
});

test("atomic directory lock rejects overlap and recovers a dead owner", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-lease-lock-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "lock");
  const first = await acquireSupervisorLock(lockPath);
  assert.equal(first.acquired, true);
  const overlapping = await acquireSupervisorLock(lockPath);
  assert.equal(overlapping.acquired, false);
  await first.release();
  const replacement = await acquireSupervisorLock(lockPath);
  assert.equal(replacement.acquired, true);
  await replacement.release();
});

test("LaunchAgent template is a five-minute one-shot without KeepAlive", async () => {
  const template = await readFile(
    new URL(
      "../ops/launchd/com.returner-fund.ingestion-lease-supervisor.plist.template",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(template, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(template, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(
    template,
    /<string>__NODE_BIN__<\/string>\s*<string>__SUPERVISOR_SCRIPT__<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_SCHEDULE_RECOVERY_ENABLED<\/key>\s*<string>true<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_RUNNER_RESTART_ENABLED<\/key>\s*<string>true<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_RUNNER_LAUNCHD_LABEL<\/key>\s*<string>__RUNNER_LAUNCHD_LABEL__<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_RUNNER_RESTART_COOLDOWN_MINUTES<\/key>\s*<string>30<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_SCHEDULE_RECOVERY_SILENCE_MINUTES<\/key>\s*<string>30<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_SCHEDULE_RECOVERY_COOLDOWN_MINUTES<\/key>\s*<string>30<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_DASHBOARD_RECOVERY_ENABLED<\/key>\s*<string>true<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_DASHBOARD_RECOVERY_MAX_AGE_MINUTES<\/key>\s*<string>120<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_DASHBOARD_RECOVERY_SILENCE_MINUTES<\/key>\s*<string>30<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_DASHBOARD_RECOVERY_COOLDOWN_MINUTES<\/key>\s*<string>30<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_MIN_BATTERY_PERCENT<\/key>\s*<string>30<\/string>/
  );
  assert.doesNotMatch(template, /<key>(?:KeepAlive|WatchPaths)<\/key>/);

  const installer = await readFile(
    new URL("../scripts/install-autonomous-ingestion-job-lease-supervisor.mjs", import.meta.url),
    "utf8"
  );
  assert.match(installer, /installedScheduleModule/);
  assert.match(installer, /scripts[\s\S]*?lib[\s\S]*?ingestion-schedule\.mjs/);
});

test("awake LaunchAgent is AC-only and never simulates user activity", async () => {
  const template = await readFile(
    new URL(
      "../ops/launchd/com.returner-fund.ingestion-awake.plist.template",
      import.meta.url
    ),
    "utf8"
  );
  const plist = renderLaunchAgentTemplate(template, {
    __STDOUT_LOG__: "/Users/tester/Library/Logs/awake $& output.log",
    __STDERR_LOG__: "/Users/tester/Library/Logs/awake.error.log"
  });

  assert.doesNotThrow(() => assertAwakeLaunchAgentPlist(plist));
  assert.match(plist, /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-s<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /awake \$&amp; output\.log/);
  assert.doesNotMatch(plist, /<string>-[^<]*[du][^<]*<\/string>|pmset|sudo/i);

  for (const mutation of [
    plist.replace("<string>-s</string>", "<string>-su</string>"),
    plist.replace("<string>-s</string>", "<string>-d</string>"),
    plist.replace("/usr/bin/caffeinate", "/usr/bin/pmset"),
    plist.replace("<key>KeepAlive</key>\n  <true/>", "<key>KeepAlive</key>\n  <false/>")
  ]) {
    assert.throws(() => assertAwakeLaunchAgentPlist(mutation), /Awake LaunchAgent/);
  }
});

test("host installer rejects only legacy broad standalone caffeinate assertions", () => {
  assert.deepEqual(
    findLegacyBroadCaffeinateProcesses([
      " 4216 caffeinate -dimsu",
      " 4217 /usr/bin/caffeinate -d -i -m -s -u",
      " 97283 /usr/bin/caffeinate -s",
      " 59519 /usr/bin/caffeinate -ims -w 59518",
      " 77777 /usr/bin/caffeinate -s npm test",
      " 88888 /usr/bin/not-caffeinate -dimsu"
    ].join("\n")),
    [
      { pid: 4216, flags: "dimsu" },
      { pid: 4217, flags: "dimsu" }
    ]
  );
});

test("auth browser LaunchAgent pins the dedicated local Chrome Canary and persistent data directory", async () => {
  const template = await readFile(
    new URL(
      "../ops/launchd/com.returner-fund.auth-chrome-runner.plist.template",
      import.meta.url
    ),
    "utf8"
  );
  const chromeExecutable = "/Users/tester/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
  const dataDir = "/Users/tester/Library/Application Support/Returner Fund Auth Chrome Runner";
  const plist = renderLaunchAgentTemplate(template, {
    __AUTH_CHROME_BIN__: chromeExecutable,
    __AUTH_CHROME_DATA_DIR__: dataDir,
    __STDOUT_LOG__: "/Users/tester/Library/Logs/auth-browser.log",
    __STDERR_LOG__: "/Users/tester/Library/Logs/auth-browser.error.log"
  });

  assert.doesNotThrow(() => assertAuthBrowserLaunchAgentPlist(plist, {
    chromeExecutable,
    dataDir
  }));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.doesNotMatch(plist, /remote-debugging|\/Volumes|AppTranslocation/);

  for (const mutation of [
    plist.replace(chromeExecutable, "/Volumes/Google Chrome Canary/Google Chrome Canary"),
    plist.replace(`--user-data-dir=${dataDir}`, "--user-data-dir=/tmp/chrome"),
    plist.replace("<key>KeepAlive</key>\n  <true/>", "<key>KeepAlive</key>\n  <false/>"),
    plist.replace("--no-first-run", "--remote-debugging-port=9222")
  ]) {
    assert.throws(
      () => assertAuthBrowserLaunchAgentPlist(mutation, { chromeExecutable, dataDir }),
      /Auth browser LaunchAgent/
    );
  }
});

test("host installer requires one explicit reversible operation", () => {
  assert.equal(resolveInstallerOperation(["--install"]), "install");
  assert.equal(resolveInstallerOperation(["--uninstall"]), "uninstall");
  for (const argv of [[], ["--install", "--uninstall"], ["--install", "extra"]]) {
    assert.throws(() => resolveInstallerOperation(argv), /exactly one/);
  }
});

test("launchd bootstrap retries only the exact transient post-teardown I/O error", async () => {
  const calls = [];
  const sleeps = [];
  let bootstrapAttempts = 0;
  await bootstrapLaunchAgentAfterTeardown({
    domain: "gui/501",
    label: AUTH_BROWSER_LABEL,
    plistPath: "/Users/tester/Library/LaunchAgents/auth-browser.plist",
    run: async (command, args, options) => {
      calls.push([command, ...args]);
      assert.deepEqual(options, { timeout: 10_000, maxBuffer: 1024 * 1024 });
      if (args[0] === "bootstrap") {
        bootstrapAttempts += 1;
        if (bootstrapAttempts === 1) throw launchctlBootstrapIoError();
      }
      if (args[0] === "print") throw launchAgentNotLoadedError();
      return { stdout: "", stderr: "" };
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  assert.equal(bootstrapAttempts, 2);
  assert.deepEqual(sleeps, [1_000]);
  assert.deepEqual(calls, [
    [
      "/bin/launchctl",
      "bootstrap",
      "gui/501",
      "/Users/tester/Library/LaunchAgents/auth-browser.plist"
    ],
    [
      "/bin/launchctl",
      "print",
      `gui/501/${AUTH_BROWSER_LABEL}`
    ],
    [
      "/bin/launchctl",
      "bootstrap",
      "gui/501",
      "/Users/tester/Library/LaunchAgents/auth-browser.plist"
    ],
    ["/bin/launchctl", "enable", `gui/501/${AUTH_BROWSER_LABEL}`]
  ]);
});

test("launchd bootstrap keeps every non-exact I/O failure fail-closed", async () => {
  const failures = [
    launchctlBootstrapIoError({ code: 4 }),
    launchctlBootstrapIoError({ code: "5" }),
    launchctlBootstrapIoError({ killed: true, signal: "SIGTERM" }),
    launchctlBootstrapIoError({ stdout: "unexpected output\n" }),
    launchctlBootstrapIoError({ stderr: "Bootstrap failed: 5: Permission denied\n" }),
    launchctlBootstrapIoError({
      stderr: "Bootstrap failed: 5: Input/output error\nUnexpected extra diagnostic\n"
    })
  ];

  for (const failure of failures) {
    const calls = [];
    const sleeps = [];
    await assert.rejects(
      bootstrapLaunchAgentAfterTeardown({
        domain: "gui/501",
        label: AUTH_BROWSER_LABEL,
        plistPath: "/Users/tester/Library/LaunchAgents/auth-browser.plist",
        run: async (command, args) => {
          calls.push([command, ...args]);
          throw failure;
        },
        sleep: async (milliseconds) => sleeps.push(milliseconds)
      }),
      (error) => error === failure
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test("launchd bootstrap bounds exact I/O retries to 1s, 2s, and 4s backoff", async () => {
  const failure = launchctlBootstrapIoError();
  const calls = [];
  const sleeps = [];
  await assert.rejects(
    bootstrapLaunchAgentAfterTeardown({
      domain: "gui/501",
      label: AUTH_BROWSER_LABEL,
      plistPath: "/Users/tester/Library/LaunchAgents/auth-browser.plist",
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "print") throw launchAgentNotLoadedError();
        throw failure;
      },
      sleep: async (milliseconds) => sleeps.push(milliseconds)
    }),
    (error) => error === failure
  );
  assert.equal(calls.filter(([, operation]) => operation === "bootstrap").length, 4);
  assert.equal(calls.filter(([, operation]) => operation === "print").length, 4);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000]);
});

test("launchd bootstrap reconciles an ambiguous exit-5 response before retrying", async () => {
  const calls = [];
  const sleeps = [];
  await bootstrapLaunchAgentAfterTeardown({
    domain: "gui/501",
    label: AUTH_BROWSER_LABEL,
    plistPath: "/Users/tester/Library/LaunchAgents/auth-browser.plist",
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "bootstrap") throw launchctlBootstrapIoError();
      return { stdout: "state = running\n", stderr: "" };
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  assert.equal(calls.filter(([, operation]) => operation === "bootstrap").length, 1);
  assert.equal(calls.filter(([, operation]) => operation === "print").length, 1);
  assert.equal(calls.filter(([, operation]) => operation === "enable").length, 1);
  assert.deepEqual(sleeps, []);
});

test("launchd bootstrap polls boundedly for teardown absence before starting", async () => {
  const calls = [];
  const sleeps = [];
  let printAttempts = 0;
  await bootstrapLaunchAgentAfterTeardown({
    domain: "gui/501",
    label: AUTH_BROWSER_LABEL,
    plistPath: "/Users/tester/Library/LaunchAgents/auth-browser.plist",
    teardownStarted: true,
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "print") {
        printAttempts += 1;
        if (printAttempts === 2) throw launchAgentNotLoadedError();
      }
      return { stdout: "", stderr: "" };
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  assert.equal(printAttempts, 2);
  assert.equal(calls.filter(([, operation]) => operation === "bootstrap").length, 1);
  assert.deepEqual(sleeps, [250]);
});

test("host LaunchAgent install and uninstall are idempotent without deleting audit state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "returner-host-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = path.join(root, "home");
  const runnerDiagDir = path.join(root, "runner-diag");
  await mkdir(userHome, { recursive: true });
  await mkdir(runnerDiagDir, { recursive: true });
  const paths = autonomousIngestionHostPaths({ userHome, repositoryRoot });
  await mkdir(path.dirname(paths.authBrowserChromeExecutable), { recursive: true });
  await writeFile(paths.authBrowserChromeExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(paths.authBrowserChromeExecutable, 0o755);
  await mkdir(paths.authBrowserDataDir, { recursive: true });
  await symlink("test-host-8123", path.join(paths.authBrowserDataDir, "SingletonLock"));
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/launchctl" && args[0] === "bootout") {
      const error = new Error("Boot-out failed: 3: No such process");
      error.code = 3;
      error.stderr = "Boot-out failed: 3: No such process";
      throw error;
    }
    if (command === "/bin/launchctl" && args[0] === "print") {
      return {
        stdout: [
          "state = running",
          "pid = 8123",
          `program = ${paths.authBrowserChromeExecutable}`,
          `--user-data-dir=${paths.authBrowserDataDir}`
        ].join("\n"),
        stderr: ""
      };
    }
    if (command === "/usr/bin/codesign" && args[0] === "-dv") {
      return {
        stdout: "",
        stderr: `Identifier=${AUTH_CHROME_BUNDLE_IDENTIFIER}\nTeamIdentifier=${AUTH_CHROME_TEAM_IDENTIFIER}\n`
      };
    }
    if (command === "/bin/ps") {
      return {
        stdout: [
          `8123 1 ${paths.authBrowserChromeExecutable} --user-data-dir=${paths.authBrowserDataDir} --profile-directory=Default --no-first-run --no-default-browser-check about:blank`,
          `8124 8123 ${paths.authBrowserAppBundlePath}/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process`
        ].join("\n"),
        stderr: ""
      };
    }
    return { stdout: "", stderr: "" };
  };
  const options = {
    platform: "darwin",
    userHome,
    uid: 501,
    repositoryRoot,
    environment: {
      RETURNER_NODE_BIN: process.execPath,
      RETURNER_GH_BIN: path.join(root, "gh"),
      RETURNER_RUNNER_DIAG_DIR: runnerDiagDir
    },
    run,
    checkPath: async () => {}
  };

  const first = await installAutonomousIngestionHost(options);
  const firstAwakePlist = await readFile(paths.awakePlistPath, "utf8");
  const second = await installAutonomousIngestionHost(options);
  assert.equal(await readFile(paths.awakePlistPath, "utf8"), firstAwakePlist);
  assert.equal(first.installed, true);
  assert.equal(second.installed, true);
  assert.equal(first.runnerLaunchdLabel, RUNNER_LAUNCHD_LABEL);
  await assert.rejects(
    installAutonomousIngestionHost({
      ...options,
      run: async (command, args, commandOptions) => {
        if (command === "/bin/ps" && args.join(" ") === "-axo pid=,command=") {
          return { stdout: "4216 caffeinate -dimsu\n", stderr: "" };
        }
        return run(command, args, commandOptions);
      }
    }),
    /Refusing to install while legacy broad caffeinate assertions are active: PID 4216 \(-dimsu\)/
  );
  assert.deepEqual(
    first.launchAgents.map(({ label }) => label),
    [AUTH_BROWSER_LABEL, AWAKE_LABEL, SUPERVISOR_LABEL]
  );
  assert.doesNotThrow(() => assertAwakeLaunchAgentPlist(firstAwakePlist));
  const firstAuthBrowserPlist = await readFile(paths.authBrowserPlistPath, "utf8");
  assert.doesNotThrow(() => assertAuthBrowserLaunchAgentPlist(firstAuthBrowserPlist, {
    chromeExecutable: paths.authBrowserChromeExecutable,
    dataDir: paths.authBrowserDataDir
  }));
  assert.equal((await stat(paths.authBrowserDataDir)).mode & 0o777, 0o700);
  await readFile(paths.supervisorPlistPath, "utf8");

  const bootstrapTargets = calls
    .filter(([command, operation]) => command === "/bin/launchctl" && operation === "bootstrap")
    .map((call) => call[3]);
  assert.deepEqual(bootstrapTargets, [
    paths.authBrowserPlistPath,
    paths.awakePlistPath,
    paths.supervisorPlistPath,
    paths.authBrowserPlistPath,
    paths.awakePlistPath,
    paths.supervisorPlistPath
  ]);
  assert.equal(
    calls.some((call) =>
      call[0] === "/bin/launchctl" &&
      new Set(["bootstrap", "bootout", "enable"]).has(call[1]) &&
      call.some((argument) => String(argument).includes(RUNNER_LAUNCHD_LABEL))
    ),
    false
  );

  const stateMarker = path.join(paths.stateDir, "preserved-state.json");
  const authBrowserMarker = path.join(paths.authBrowserDataDir, "preserved-profile.json");
  await writeFile(stateMarker, "{}\n", { mode: 0o600 });
  await writeFile(authBrowserMarker, "{}\n", { mode: 0o600 });
  const removed = await uninstallAutonomousIngestionHost({
    platform: "darwin",
    userHome,
    uid: 501,
    run
  });
  const removedAgain = await uninstallAutonomousIngestionHost({
    platform: "darwin",
    userHome,
    uid: 501,
    run
  });
  assert.equal(removed.installed, false);
  assert.equal(removedAgain.installed, false);
  await assert.rejects(readFile(paths.awakePlistPath, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(paths.supervisorPlistPath, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(paths.authBrowserPlistPath, "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(stateMarker, "utf8"), "{}\n");
  assert.equal(await readFile(authBrowserMarker, "utf8"), "{}\n");
});

function launchctlBootstrapIoError(overrides = {}) {
  return Object.assign(new Error("launchctl bootstrap failed"), {
    code: 5,
    killed: false,
    signal: null,
    stdout: "",
    stderr: "Bootstrap failed: 5: Input/output error\n"
  }, overrides);
}

function launchAgentNotLoadedError() {
  return Object.assign(new Error("Could not find service"), {
    code: 3,
    killed: false,
    signal: null,
    stdout: "",
    stderr: "Could not find service\n"
  });
}
