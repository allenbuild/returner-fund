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
  installAutonomousIngestionHost,
  renderLaunchAgentTemplate,
  resolveInstallerOperation,
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
  evaluateLeaseLossEvent,
  evaluatePowerStatus,
  evaluateScheduleRecovery,
  loadSupervisorState,
  parseWorkerLeaseLossLog,
  runSupervisor,
  supervisorConfig,
  verifyCancelledAutonomousJob,
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
    defaultBranch: "main",
    runnerName: "returner-social-mac-allenxtech",
    runnerDiagDir: "/tmp/returner-runner-diag",
    stateDir,
    statePath: path.join(stateDir, "state-v1.json"),
    lockPath: path.join(stateDir, "supervisor.lock"),
    ghBin: "/opt/homebrew/bin/gh",
    minBatteryPercent: 60,
    maxWorkerLogBytes: 32 * 1024 * 1024,
    scheduleRecoveryEnabled: false,
    scheduleRecoverySilenceMinutes: 30,
    scheduleRecoveryCooldownMinutes: 30,
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
    getRun: async () => run(),
    getAttemptJobs: async () => jobs(),
    getBranchHead: async () => CURRENT_SHA,
    getWorkflowRuns: async () => [],
    getActiveRuns: async () => [],
    getRunners: async () => [{ id: 7, name: "returner-social-mac-allenxtech", status: "online", busy: false }],
    getRepositoryText: async () => {
      const error = new Error("fixture artifact is missing");
      error.code = "ENOENT";
      throw error;
    },
    rerunFailedJobs: async () => {},
    dispatchRecovery: async () => {},
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

test("power gate admits AC or a healthy reserve and defers below 60 percent", () => {
  assert.deepEqual(
    evaluatePowerStatus("Now drawing from 'AC Power'\n -InternalBattery-0 12%; charging"),
    { eligible: true, reason: "ac_power", percent: 12 }
  );
  assert.deepEqual(
    evaluatePowerStatus("Now drawing from 'Battery Power'\n -InternalBattery-0 60%; discharging"),
    { eligible: true, reason: "healthy_battery_reserve", percent: 60 }
  );
  assert.deepEqual(
    evaluatePowerStatus("Now drawing from 'Battery Power'\n -InternalBattery-0 59%; discharging"),
    { eligible: false, reason: "battery_below_reserve", percent: 59 }
  );
  assert.equal(evaluatePowerStatus("unknown").eligible, false);
});

test("schedule recovery is enabled with bounded silence and cooldown defaults", () => {
  const defaults = supervisorConfig({});
  assert.equal(defaults.scheduleRecoveryEnabled, true);
  assert.equal(defaults.scheduleRecoverySilenceMinutes, 30);
  assert.equal(defaults.scheduleRecoveryCooldownMinutes, 30);
  assert.equal(
    supervisorConfig({ RETURNER_SCHEDULE_RECOVERY_ENABLED: "false" }).scheduleRecoveryEnabled,
    false
  );
  assert.throws(
    () => supervisorConfig({ RETURNER_SCHEDULE_RECOVERY_SILENCE_MINUTES: "14" }),
    /must be between 15 and 720/
  );
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

test("active workflow and low reserve defer without issuing or deduping a rerun", async () => {
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

  const lowBattery = await evaluateLeaseLossEvent({
    event: event(),
    config: config(),
    github: github({
      rerunFailedJobs: async () => {
        reruns += 1;
      }
    }),
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 46%; discharging"
  });
  assert.equal(lowBattery.action, "defer");
  assert.equal(lowBattery.reason, "battery_below_reserve");
  assert.equal(reruns, 0);
});

test("a dropped wake after an ordinary battery failure dispatches the canonical latest-slot recovery", async () => {
  const dispatchedHeads = [];
  const decision = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      getWorkflowRuns: async () => [{
        id: 880,
        event: "schedule",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-08-26T04:30:00.000Z"
      }],
      dispatchRecovery: async (headSha) => dispatchedHeads.push(headSha)
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'AC Power'\n 72%; charging",
    now: new Date("2026-08-26T05:05:00.000Z")
  });

  assert.equal(decision.action, "dispatch");
  assert.equal(decision.slotKey, "central-2026-08-25-1800");
  assert.equal(decision.scheduledAt, "2026-08-25T23:00:00.000Z");
  assert.equal(decision.watermarkStatus, "missing");
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

  const lowBattery = await evaluateScheduleRecovery({
    config: config({ scheduleRecoveryEnabled: true }),
    github: github({
      getWorkflowRuns: async () => [],
      dispatchRecovery: async () => {
        dispatches += 1;
      }
    }),
    state: { recoveryDispatch: null },
    readPowerStatus: async () => "Now drawing from 'Battery Power'\n 59%; discharging",
    now: new Date("2026-08-26T05:05:00.000Z")
  });
  assert.equal(lowBattery.reason, "battery_below_reserve");
  assert.equal(lowBattery.batteryPercent, 59);
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
    /<key>RETURNER_SCHEDULE_RECOVERY_SILENCE_MINUTES<\/key>\s*<string>30<\/string>/
  );
  assert.match(
    template,
    /<key>RETURNER_SCHEDULE_RECOVERY_COOLDOWN_MINUTES<\/key>\s*<string>30<\/string>/
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
