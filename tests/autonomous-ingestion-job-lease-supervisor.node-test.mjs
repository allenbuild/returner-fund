import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireSupervisorLock,
  evaluateLeaseLossEvent,
  evaluatePowerStatus,
  loadSupervisorState,
  parseWorkerLeaseLossLog,
  runSupervisor,
  verifyCancelledAutonomousJob,
  verifyWorkflowRun
} from "../scripts/supervise-autonomous-ingestion-job-lease.mjs";

const CURRENT_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
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
    path: ".github/workflows/autonomous-ingestion.yml"
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
    getActiveRuns: async () => [],
    rerunFailedJobs: async () => {},
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
  assert.doesNotMatch(template, /<key>(?:KeepAlive|WatchPaths)<\/key>/);
});
