import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { maxAutonomousRunnerProcessBudgetMs } from "../scripts/lib/autonomous-ingestion-plan.mjs";
import {
  AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS
} from "../scripts/lib/autonomous-ingestion-budget.mjs";
import {
  AUTONOMOUS_WORKFLOW_ATTEMPT_ALLOWANCE_MS,
  AUTONOMOUS_WORKFLOW_CHILD_TERMINATION_GRACE_MS,
  AUTONOMOUS_WORKFLOW_MINIMUM_ATTEMPT_WINDOW_MS,
  classifyAutonomousWorkflowAttempt,
  executeAutonomousWorkflowAttempt,
  parseAutonomousWorkflowAttemptOutput,
  parseAutonomousWorkflowRetryConfig,
  runAutonomousWorkflowRetries
} from "../scripts/lib/autonomous-ingestion-workflow-retry.mjs";
import {
  autonomousDatabaseFailureMetadata,
  autonomousDatabaseOperationError,
  isRetryableAutonomousDatabaseFailure
} from "../scripts/lib/autonomous-ingestion-database-failure.mjs";
import {
  parseAutonomousPowerWatchdogConfig,
  parseMacPowerStatus,
  shouldTerminateForLowPower,
  startAutonomousIngestionPowerWatchdog
} from "../scripts/lib/autonomous-ingestion-power-watchdog.mjs";
import { DAILY_BENCHMARK_UTC_CRON_CANDIDATES } from "../scripts/lib/daily-benchmark-schedule.mjs";
import { INGESTION_UTC_CRON_CANDIDATES } from "../scripts/lib/ingestion-schedule.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "autonomous-ingestion.yml"),
  "utf8"
);
const dailyBenchmarkWorkflow = readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "daily-benchmarks.yml"),
  "utf8"
);
const dashboardRefreshWorkflow = readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "dashboard-refresh.yml"),
  "utf8"
);
const receiptPolicy = readFileSync(
  path.join(repositoryRoot, "scripts", "lib", "autonomous-ingestion-receipt-policy.mjs"),
  "utf8"
);
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const FULL_COMMIT_SHA = runGit(repositoryRoot, "rev-parse", "HEAD");
assert.match(FULL_COMMIT_SHA, /^[0-9a-f]{40}$/);
const FRESH_DAILY_SLOT_ENV = Object.freeze({
  EXISTING_PUBLICATION_STATUS: "fresh",
  EXISTING_PUBLISHED_COMMIT: "",
  EXISTING_SOURCE_SHA: "",
  EXISTING_RUN_ID: "",
  EXISTING_RUN_ATTEMPT: "",
  EXISTING_TRIGGER: "",
  EXISTING_SCHEDULED_AT: "",
  EXISTING_CENTRAL_DATE: "",
  EXISTING_SCHEDULED_UTC_HOUR: ""
});

function assertSupportedConcurrencySchema(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)concurrency:\s*$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const keys = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) continue;
      const childIndent = /^\s*/.exec(lines[cursor])[0].length;
      if (childIndent <= indent) break;
      if (childIndent === indent + 2) {
        const key = /^\s*([A-Za-z-]+):/.exec(lines[cursor])?.[1];
        if (key) keys.push(key);
      }
    }
    blocks.push(keys);
  }
  assert.ok(blocks.length > 0, "workflow must declare concurrency");
  for (const keys of blocks) {
    assert.deepEqual(
      keys.sort(),
      ["cancel-in-progress", "group", "queue"],
      "concurrency has an unsupported key"
    );
  }
  for (const match of source.matchAll(/^\s*queue:\s*(.*?)\s*$/gm)) {
    assert.equal(match[1], "max", "concurrency queue must preserve every pending writer");
  }
}

function assertExactExternalActionPins(source) {
  const uses = Array.from(source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/gm));
  const external = uses.filter((match) => !match[1].startsWith("./"));
  assert.ok(external.length > 0, "workflow must contain external actions");
  for (const [, action, comment] of external) {
    assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${action} is not commit-pinned`);
    assert.equal(comment, "v4", `${action} must retain its v4 audit comment`);
  }
}

test("workflow declares DST-safe primary candidates plus persistent recovery", () => {
  const cronCandidates = Array.from(
    workflow.matchAll(/^\s*- cron:\s*["']([^"']+)["']\s*$/gm),
    (match) => match[1]
  );

  assert.deepEqual(cronCandidates, INGESTION_UTC_CRON_CANDIDATES);
  assert.match(workflow, /cron:\s*["']7,22,37,52 \* \* \* \*["']/);
  assert.match(
    workflow,
    /repository_dispatch:\s*\n\s*types:\s*\[autonomous-ingestion-recovery\]/
  );
  assert.match(
    workflow,
    /INGESTION_RECOVERY_EXPECTED_HEAD_SHA:\s*\$\{\{ github\.event\.client_payload\.expected_head_sha \}\}/
  );
  assert.equal(
    Array.from(
      workflow.matchAll(
        /INGESTION_RECOVERY_EXPECTED_HEAD_SHA:\s*\$\{\{ github\.event\.client_payload\.expected_head_sha \}\}/g
      )
    ).length,
    3,
    "resolver, serialized revalidation, and runner must share exact recovery-dispatch provenance"
  );
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*replay_key:/);
  assert.match(workflow, /replay_key:[\s\S]*?required:\s*true/);
});

test("accepted runs share the repository publication lane without delaying inactive resolvers", () => {
  assert.match(
    workflow,
    /ingest:[\s\S]*?concurrency:\s*\n\s*group:\s*repository-publication-main\s*\n\s*queue:\s*max\s*\n\s*cancel-in-progress:\s*false/
  );
  assertSupportedConcurrencySchema(workflow);
  assertExactExternalActionPins(workflow);
  assert.doesNotMatch(workflow.split("jobs:")[0], /concurrency:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /ingest:[\s\S]*?permissions:\s*\n\s*contents:\s*write/);
  const resolverJob = workflow.match(/\n  resolve:[\s\S]*?(?=\n  ingest:)/)?.[0] ?? "";
  assert.match(resolverJob, /uses:\s*actions\/checkout@[0-9a-f]{40}\s+# v4[\s\S]*?ref:\s*\$\{\{ github\.sha \}\}[\s\S]*?fetch-depth:\s*0[\s\S]*?persist-credentials:\s*false/);
  assert.match(resolverJob, /source_sha:\s*\$\{\{ steps\.source\.outputs\.source_sha \}\}/);
  assert.match(resolverJob, /recovery_debt:\s*\$\{\{ steps\.decision\.outputs\.recovery_debt \}\}/);
});

test("only runnable dashboard refresh jobs share the repository publication lane", () => {
  assert.match(
    dashboardRefreshWorkflow,
    /refresh:[\s\S]*?if:\s*\$\{\{ github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.conclusion == 'success' \}\}[\s\S]*?concurrency:\s*\n(?:\s*#[^\n]*\n)*\s*group:\s*repository-publication-main\s*\n\s*queue:\s*max\s*\n\s*cancel-in-progress:\s*false/
  );
  assertSupportedConcurrencySchema(dashboardRefreshWorkflow);
  assertExactExternalActionPins(dashboardRefreshWorkflow);
  assert.doesNotMatch(dashboardRefreshWorkflow.split("jobs:")[0], /concurrency:/);
});

test("dashboard refresh uses the Mac network for exact YouTube proof", () => {
  assert.match(
    dashboardRefreshWorkflow,
    /refresh:[\s\S]*?runs-on:\s*\[self-hosted,\s*macOS,\s*ARM64,\s*returner-social,\s*returner-auth-browser\]/
  );
  assert.match(
    dashboardRefreshWorkflow,
    /GitHub-hosted egress[\s\S]*?exact player\/watch metadata[\s\S]*?discovery still fails closed/
  );
  assert.match(
    dashboardRefreshWorkflow,
    /Preflight dashboard host[\s\S]*?pmset -g batt[\s\S]*?'AC Power'[\s\S]*?pmset -g assertions[\s\S]*?PreventSystemSleep/
  );
  assert.match(
    dashboardRefreshWorkflow,
    /if \[ "\$\{\{ inputs\.skip_external_discovery \}\}" = "true" \]; then[\s\S]*?dashboard:refresh -- --no-external[\s\S]*?else[\s\S]*?dashboard:refresh/
  );
});

test("daily benchmarks resolve DST before entering the shared publication lane", () => {
  const cronCandidates = Array.from(
    dailyBenchmarkWorkflow.matchAll(/^\s*- cron:\s*["']([^"']+)["']\s*$/gm),
    (match) => match[1]
  );
  assert.deepEqual(cronCandidates, DAILY_BENCHMARK_UTC_CRON_CANDIDATES);
  assert.match(
    dailyBenchmarkWorkflow,
    /resolve:[\s\S]*?node scripts\/lib\/daily-benchmark-schedule\.mjs/
  );
  assert.match(dailyBenchmarkWorkflow, /if:\s*needs\.resolve\.outputs\.should_run == 'true'/);
  assert.match(
    dailyBenchmarkWorkflow,
    /update:[\s\S]*?concurrency:\s*\n\s*group:\s*repository-publication-main\s*\n\s*queue:\s*max\s*\n\s*cancel-in-progress:\s*false/
  );
  assertSupportedConcurrencySchema(dailyBenchmarkWorkflow);
  assertExactExternalActionPins(dailyBenchmarkWorkflow);
  assert.doesNotMatch(dailyBenchmarkWorkflow.split("jobs:")[0], /concurrency:/);
  assert.match(dailyBenchmarkWorkflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(dailyBenchmarkWorkflow, /update:[\s\S]*?permissions:\s*\n\s*contents:\s*write/);
});

test("daily benchmark updater binds publication to the accepted resolver Central date", () => {
  const updateStep = dailyBenchmarkWorkflow.match(
    /\n\s{6}- name: Update daily benchmark snapshots[\s\S]*?(?=\n\s{6}- name:)/
  )?.[0] ?? "";
  assert.match(
    updateStep,
    /BENCHMARK_EXPECTED_CENTRAL_DATE:\s*\$\{\{\s*needs\.resolve\.outputs\.central_date\s*\}\}/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /update:[\s\S]*?if:\s*needs\.resolve\.outputs\.should_run == 'true'[\s\S]*?BENCHMARK_EXPECTED_CENTRAL_DATE:\s*\$\{\{\s*needs\.resolve\.outputs\.central_date\s*\}\}/
  );
  assert.match(
    updateStep,
    /export NODE_OPTIONS="\$\{NODE_OPTIONS:-\} --experimental-strip-types --loader \.\/scripts\/lib\/scoring-diagnostics-ts-loader\.mjs"/
  );
  assert.match(updateStep, /npm run benchmarks:daily[\s\S]*?--pinned-source-in-process/);
  assert.match(updateStep, /if \[ -n \"\$SCHEDULED_UTC_HOUR\" \]/);
});

test("accepted resolver jobs fail closed and re-export only validated outputs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-resolver-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ingestionScript = workflowStepScript(workflow, "Record candidate decision");
  const benchmarkScript = workflowStepScript(dailyBenchmarkWorkflow, "Record candidate decision");

  const ingestionOutput = path.join(directory, "ingestion-output");
  const validIngestion = runScript(ingestionScript, repositoryRoot, {
    SHOULD_RUN: "true",
    SLOT_KEY: "central-2026-08-09-1800",
    TRIGGER: "schedule",
    REASON: "retry-publication-watermark",
    SCHEDULED_AT: "2026-08-09T23:00:00.000Z",
    RECOVERY_DEBT: "true",
    PUBLICATION_WATERMARK: "2026-08-09T10:00:00.000Z",
    WATERMARK_STATUS: "behind",
    LATEST_SLOT_KEY: "central-2026-08-09-1800",
    GITHUB_OUTPUT: ingestionOutput,
    GITHUB_STEP_SUMMARY: "/dev/null"
  });
  assert.equal(validIngestion.status, 0, `${validIngestion.stdout}\n${validIngestion.stderr}`);
  assert.match(readFileSync(ingestionOutput, "utf8"), /should_run=true/);
  assert.match(readFileSync(ingestionOutput, "utf8"), /slot_key=central-2026-08-09-1800/);
  assert.match(readFileSync(ingestionOutput, "utf8"), /recovery_debt=true/);
  assert.match(readFileSync(ingestionOutput, "utf8"), /watermark_status=behind/);

  const recoveryOutput = path.join(directory, "ingestion-recovery-output");
  const validRecovery = runScript(ingestionScript, repositoryRoot, {
    SHOULD_RUN: "true",
    SLOT_KEY: "central-2026-08-22-0600",
    TRIGGER: "schedule",
    REASON: "retry-publication-watermark",
    SCHEDULED_AT: "2026-08-22T11:00:00.000Z",
    RECOVERY_DEBT: "true",
    PUBLICATION_WATERMARK: "",
    WATERMARK_STATUS: "missing",
    LATEST_SLOT_KEY: "central-2026-08-22-0600",
    GITHUB_OUTPUT: recoveryOutput,
    GITHUB_STEP_SUMMARY: "/dev/null"
  });
  assert.equal(validRecovery.status, 0, `${validRecovery.stdout}\n${validRecovery.stderr}`);
  assert.match(readFileSync(recoveryOutput, "utf8"), /recovery_debt=true/);

  for (const overrides of [
    { SHOULD_RUN: "" },
    { SHOULD_RUN: "TRUE" },
    { SLOT_KEY: "" },
    { TRIGGER: "schedule", SCHEDULED_AT: "" },
    { TRIGGER: "schedule", SCHEDULED_AT: "not-a-timestamp" },
    { TRIGGER: "schedule", SCHEDULED_AT: "2026-02-30T23:00:00Z" },
    { TRIGGER: "schedule", SCHEDULED_AT: "2026-08-09T23:00:00+00:00" },
    { RECOVERY_DEBT: "" },
    { RECOVERY_DEBT: "TRUE" },
    { RECOVERY_DEBT: "true", REASON: "intended-central-slot" },
    { RECOVERY_DEBT: "false" },
    { WATERMARK_STATUS: "current" },
    { WATERMARK_STATUS: "behind", PUBLICATION_WATERMARK: "" },
    { LATEST_SLOT_KEY: "central-2026-08-09-0600" },
    { SLOT_KEY: "central-2026-08-09-1800\nforged=true" },
    { REASON: "intended-central-slot\rforged=true" },
    { TRIGGER: "unknown" },
    {
      SHOULD_RUN: "false",
      SLOT_KEY: "",
      TRIGGER: "schedule",
      SCHEDULED_AT: "2026-08-09T23:00:00Z"
    }
  ]) {
    const result = runScript(ingestionScript, repositoryRoot, {
      SHOULD_RUN: "true",
      SLOT_KEY: "central-2026-08-09-1800",
      TRIGGER: "schedule",
      REASON: "retry-publication-watermark",
      SCHEDULED_AT: "2026-08-09T23:00:00.000Z",
      RECOVERY_DEBT: "true",
      PUBLICATION_WATERMARK: "2026-08-09T10:00:00.000Z",
      WATERMARK_STATUS: "behind",
      LATEST_SLOT_KEY: "central-2026-08-09-1800",
      GITHUB_OUTPUT: path.join(directory, `invalid-ingestion-${Math.random()}`),
      GITHUB_STEP_SUMMARY: "/dev/null",
      ...overrides
    });
    assert.notEqual(result.status, 0, `${JSON.stringify(overrides)} unexpectedly passed`);
    assert.match(result.stdout, /Malformed ingestion resolver output/);
  }

  const benchmarkOutput = path.join(directory, "benchmark-output");
  const validBenchmark = runScript(benchmarkScript, repositoryRoot, {
    SHOULD_RUN: "true",
    SCHEDULED_UTC_HOUR: "5",
    TRIGGER: "schedule",
    REASON: "intended-central-midnight",
    SCHEDULED_AT: "2026-08-09T05:00:00.000Z",
    CENTRAL_DATE: "2026-08-09",
    GITHUB_OUTPUT: benchmarkOutput,
    GITHUB_STEP_SUMMARY: "/dev/null"
  });
  assert.equal(validBenchmark.status, 0, `${validBenchmark.stdout}\n${validBenchmark.stderr}`);
  assert.match(readFileSync(benchmarkOutput, "utf8"), /central_date=2026-08-09/);

  const manualOutput = path.join(directory, "manual-benchmark-output");
  const validManual = runScript(benchmarkScript, repositoryRoot, {
    SHOULD_RUN: "true",
    SCHEDULED_UTC_HOUR: "",
    TRIGGER: "manual-dispatch",
    REASON: "explicit-manual-dispatch",
    SCHEDULED_AT: "",
    CENTRAL_DATE: "",
    GITHUB_OUTPUT: manualOutput,
    GITHUB_STEP_SUMMARY: "/dev/null"
  });
  assert.equal(validManual.status, 0, `${validManual.stdout}\n${validManual.stderr}`);
  const manualValues = readFileSync(manualOutput, "utf8");
  const manualScheduledAt = manualValues.match(/^scheduled_at=(.+)$/m)?.[1];
  const manualCentralDate = manualValues.match(/^central_date=(.+)$/m)?.[1];
  assert.ok(manualScheduledAt);
  assert.ok(manualCentralDate);
  const manualParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(manualScheduledAt)).filter(({ type }) => type !== "literal")
    .map(({ type, value }) => [type, value]));
  assert.equal(manualCentralDate, `${manualParts.year}-${manualParts.month}-${manualParts.day}`);

  const validInactiveIngestion = runScript(ingestionScript, repositoryRoot, {
    SHOULD_RUN: "false",
    SLOT_KEY: "",
    TRIGGER: "schedule",
    REASON: "publication-watermark-current",
    SCHEDULED_AT: "",
    RECOVERY_DEBT: "false",
    PUBLICATION_WATERMARK: "2026-08-09T23:01:00.000Z",
    WATERMARK_STATUS: "current",
    LATEST_SLOT_KEY: "central-2026-08-09-1800",
    GITHUB_OUTPUT: path.join(directory, "inactive-ingestion-output"),
    GITHUB_STEP_SUMMARY: "/dev/null"
  });
  assert.equal(
    validInactiveIngestion.status,
    0,
    `${validInactiveIngestion.stdout}\n${validInactiveIngestion.stderr}`
  );

  for (const overrides of [
    { SHOULD_RUN: "" },
    { SHOULD_RUN: "yes" },
    { CENTRAL_DATE: "" },
    { SCHEDULED_UTC_HOUR: "" },
    { SCHEDULED_UTC_HOUR: "05" },
    { SCHEDULED_UTC_HOUR: "7" },
    { SCHEDULED_UTC_HOUR: "99" },
    { CENTRAL_DATE: "2026-02-30" },
    { CENTRAL_DATE: "2026-99-99" },
    { SCHEDULED_AT: "not-a-timestamp" },
    { SCHEDULED_AT: "2026-02-30T05:00:00Z" },
    { SCHEDULED_AT: "2026-08-09T05:00:00+00:00" },
    { REASON: "intended-central-midnight\nforged=true" },
    { TRIGGER: "unknown" }
  ]) {
    const result = runScript(benchmarkScript, repositoryRoot, {
      SHOULD_RUN: "true",
      SCHEDULED_UTC_HOUR: "5",
      TRIGGER: "schedule",
      REASON: "intended-central-midnight",
      SCHEDULED_AT: "2026-08-09T05:00:00.000Z",
      CENTRAL_DATE: "2026-08-09",
      GITHUB_OUTPUT: path.join(directory, `invalid-benchmark-${Math.random()}`),
      GITHUB_STEP_SUMMARY: "/dev/null",
      ...overrides
    });
    assert.notEqual(result.status, 0, `${JSON.stringify(overrides)} unexpectedly passed`);
    assert.match(result.stdout, /Malformed benchmark resolver output/);
  }

  for (const overrides of [
    { CENTRAL_DATE: "2026-02-30", SCHEDULED_AT: "2026-08-09T05:00:00Z" },
    { CENTRAL_DATE: "2026-08-09", SCHEDULED_AT: "2026-08-09 05:00:00Z" },
    { CENTRAL_DATE: "2026-08-08", SCHEDULED_AT: "2026-08-09T12:00:00Z" },
    { CENTRAL_DATE: "2026-08-09\rforged", SCHEDULED_AT: "2026-08-09T05:00:00Z" }
  ]) {
    const result = runScript(benchmarkScript, repositoryRoot, {
      SHOULD_RUN: "true",
      SCHEDULED_UTC_HOUR: "",
      TRIGGER: "manual-dispatch",
      REASON: "explicit-manual-dispatch",
      GITHUB_OUTPUT: path.join(directory, `invalid-manual-benchmark-${Math.random()}`),
      GITHUB_STEP_SUMMARY: "/dev/null",
      ...overrides
    });
    assert.notEqual(result.status, 0, `${JSON.stringify(overrides)} unexpectedly passed`);
    assert.match(result.stdout, /Malformed benchmark resolver output/);
  }

  const validInactiveBenchmark = runScript(benchmarkScript, repositoryRoot, {
    SHOULD_RUN: "false",
    SCHEDULED_UTC_HOUR: "",
    TRIGGER: "schedule",
    REASON: "not-central-midnight",
    SCHEDULED_AT: "",
    CENTRAL_DATE: "",
    GITHUB_OUTPUT: path.join(directory, "inactive-benchmark-output"),
    GITHUB_STEP_SUMMARY: "/dev/null"
  });
  assert.equal(
    validInactiveBenchmark.status,
    0,
    `${validInactiveBenchmark.stdout}\n${validInactiveBenchmark.stderr}`
  );

  for (const scheduleMetadata of [
    { SCHEDULED_UTC_HOUR: "5" },
    { CENTRAL_DATE: "2026-08-09" },
    { SCHEDULED_AT: "2026-08-09T05:00:00Z" }
  ]) {
    const result = runScript(benchmarkScript, repositoryRoot, {
      SHOULD_RUN: "false",
      SCHEDULED_UTC_HOUR: "",
      TRIGGER: "schedule",
      REASON: "not-central-midnight",
      SCHEDULED_AT: "",
      CENTRAL_DATE: "",
      GITHUB_OUTPUT: path.join(directory, `invalid-inactive-benchmark-${Math.random()}`),
      GITHUB_STEP_SUMMARY: "/dev/null",
      ...scheduleMetadata
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Malformed benchmark resolver output/);
  }
});

test("all workflow shell blocks remain fixed at 56 and queued schedules are rechecked", (t) => {
  const shellBlockCount = [workflow, dailyBenchmarkWorkflow, readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "public-artifacts.yml"),
    "utf8"
  )].reduce(
    (total, source) => total + (source.match(/^ {8}run:/gm)?.length ?? 0),
    0
  );
  assert.equal(shellBlockCount, 56);

  const directory = mkdtempSync(path.join(tmpdir(), "returner-queued-freshness-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  const freezeClock = path.join(directory, "freeze-clock.cjs");
  writeFileSync(freezeClock, 'Date.now = () => Date.parse("2026-08-09T10:00:00.000Z");\n');
  writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");
  chmodSync(path.join(bin, "npm"), 0o755);

  const ingestionFreshness = workflowStepScript(workflow, "Require isolated publication credential");
  const freshIngestion = runScript(ingestionFreshness, repositoryRoot, {
    NODE_OPTIONS: `--require=${freezeClock}`,
    CANDIDATE_TRIGGER: "schedule",
    CANDIDATE_SLOT_KEY: "central-2026-08-08-1800",
    CANDIDATE_SCHEDULED_AT: "2026-08-08T23:00:00.000Z",
    CANDIDATE_REASON: "retry-publication-watermark",
    CANDIDATE_RECOVERY_DEBT: "true",
    WORKFLOW_EVENT_NAME: "schedule"
  });
  assert.equal(freshIngestion.status, 0, `${freshIngestion.stdout}\n${freshIngestion.stderr}`);

  const trustedHostRecovery = runScript(ingestionFreshness, repositoryRoot, {
    NODE_OPTIONS: `--require=${freezeClock}`,
    CANDIDATE_TRIGGER: "schedule",
    CANDIDATE_SLOT_KEY: "central-2026-08-08-1800",
    CANDIDATE_SCHEDULED_AT: "2026-08-08T23:00:00.000Z",
    CANDIDATE_REASON: "retry-publication-watermark",
    CANDIDATE_RECOVERY_DEBT: "true",
    WORKFLOW_EVENT_NAME: "repository_dispatch"
  });
  assert.equal(
    trustedHostRecovery.status,
    0,
    `${trustedHostRecovery.stdout}\n${trustedHostRecovery.stderr}`
  );

  const historicalAuthorizedIngestion = runScript(ingestionFreshness, repositoryRoot, {
    NODE_OPTIONS: `--require=${freezeClock}`,
    CANDIDATE_TRIGGER: "schedule",
    CANDIDATE_SLOT_KEY: "central-2026-08-08-0600",
    CANDIDATE_SCHEDULED_AT: "2026-08-08T11:00:00.000Z",
    CANDIDATE_REASON: "retry-publication-watermark",
    CANDIDATE_RECOVERY_DEBT: "true",
    WORKFLOW_EVENT_NAME: "schedule"
  });
  assert.equal(
    historicalAuthorizedIngestion.status,
    0,
    `${historicalAuthorizedIngestion.stdout}\n${historicalAuthorizedIngestion.stderr}`
  );

  const manualIngestion = runScript(ingestionFreshness, repositoryRoot, {
    NODE_OPTIONS: `--require=${freezeClock}`,
    CANDIDATE_TRIGGER: "manual-replay",
    CANDIDATE_SLOT_KEY: "manual-replay-fixture",
    CANDIDATE_SCHEDULED_AT: "",
    CANDIDATE_REASON: "explicit-replay-key",
    CANDIDATE_RECOVERY_DEBT: "false",
    WORKFLOW_EVENT_NAME: "workflow_dispatch"
  });
  assert.equal(manualIngestion.status, 0, `${manualIngestion.stdout}\n${manualIngestion.stderr}`);

  const authorizedRetry = runScript(ingestionFreshness, repositoryRoot, {
    NODE_OPTIONS: `--require=${freezeClock}`,
    CANDIDATE_TRIGGER: "schedule",
    CANDIDATE_SLOT_KEY: "central-2026-08-08-1800",
    CANDIDATE_SCHEDULED_AT: "2026-08-08T23:00:00.000Z",
    CANDIDATE_REASON: "retry-publication-watermark",
    CANDIDATE_RECOVERY_DEBT: "true",
    WORKFLOW_EVENT_NAME: "schedule"
  });
  assert.equal(
    authorizedRetry.status,
    0,
    `${authorizedRetry.stdout}\n${authorizedRetry.stderr}`
  );

  const falseRecoveryClaim = runScript(ingestionFreshness, repositoryRoot, {
    NODE_OPTIONS: `--require=${freezeClock}`,
    CANDIDATE_TRIGGER: "schedule",
    CANDIDATE_SLOT_KEY: "central-2026-08-08-1800",
    CANDIDATE_SCHEDULED_AT: "2026-08-08T23:00:00.000Z",
    CANDIDATE_REASON: "intended-central-slot",
    CANDIDATE_RECOVERY_DEBT: "true",
    WORKFLOW_EVENT_NAME: "schedule"
  });
  assert.notEqual(falseRecoveryClaim.status, 0);
  assert.match(falseRecoveryClaim.stderr, /reason is not publication-watermark authorized/);

  const missingAuthorization = runScript(ingestionFreshness, repositoryRoot, {
    NODE_OPTIONS: `--require=${freezeClock}`,
    CANDIDATE_TRIGGER: "schedule",
    CANDIDATE_SLOT_KEY: "central-2026-08-08-1800",
    CANDIDATE_SCHEDULED_AT: "2026-08-08T23:00:00.000Z",
    CANDIDATE_REASON: "retry-publication-watermark",
    CANDIDATE_RECOVERY_DEBT: "false",
    WORKFLOW_EVENT_NAME: "schedule"
  });
  assert.notEqual(missingAuthorization.status, 0);
  assert.match(missingAuthorization.stderr, /requires publication-watermark retry authorization/);

  const revalidationStep = workflowStepScript(workflow, "Revalidate serialized publication candidate");
  assert.match(revalidationStep, /refs\/remotes\/origin\/main/);
  assert.match(revalidationStep, /git fetch --no-tags origin/);
  assert.match(workflow, /INGESTION_REVALIDATE_CANDIDATE:\s*"true"/);
  assert.ok(
    workflow.indexOf("Revalidate serialized publication candidate") <
      workflow.indexOf("Install dependencies"),
    "serialized candidate revalidation must precede expensive setup"
  );

  const benchmarkFreshness = workflowStepScript(dailyBenchmarkWorkflow, "Update daily benchmark snapshots");
  const sharedBenchmarkEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    NODE_OPTIONS: `--require=${freezeClock}`,
    SCHEDULED_UTC_HOUR: "5",
    CANDIDATE_SCHEDULED_UTC_HOUR: "5",
    CANDIDATE_TRIGGER: "schedule",
    CANDIDATE_SCHEDULED_AT: "2026-08-09T05:00:00.000Z",
    CANDIDATE_CENTRAL_DATE: "2026-08-09",
    WORKFLOW_EVENT_NAME: "schedule"
  };
  const freshBenchmark = runScript(benchmarkFreshness, repositoryRoot, sharedBenchmarkEnv);
  assert.equal(freshBenchmark.status, 0, `${freshBenchmark.stdout}\n${freshBenchmark.stderr}`);
  const staleBenchmark = runScript(benchmarkFreshness, repositoryRoot, {
    ...sharedBenchmarkEnv,
    CANDIDATE_SCHEDULED_AT: "2026-08-08T05:00:00.000Z",
    CANDIDATE_CENTRAL_DATE: "2026-08-08"
  });
  assert.notEqual(staleBenchmark.status, 0);
  assert.match(staleBenchmark.stderr, /became stale while queued/);
  const manualBenchmark = runScript(benchmarkFreshness, repositoryRoot, {
    ...sharedBenchmarkEnv,
    SCHEDULED_UTC_HOUR: "",
    CANDIDATE_SCHEDULED_UTC_HOUR: "",
    CANDIDATE_TRIGGER: "manual-dispatch",
    CANDIDATE_SCHEDULED_AT: "2000-01-01T00:00:00.000Z",
    CANDIDATE_CENTRAL_DATE: "1999-12-31",
    WORKFLOW_EVENT_NAME: "workflow_dispatch"
  });
  assert.equal(manualBenchmark.status, 0, `${manualBenchmark.stdout}\n${manualBenchmark.stderr}`);
});

test("workflow and receipt contracts are required by the ingestion check gate", () => {
  const contracts = packageJson.scripts["test:workflow-contracts"];
  assert.match(contracts, /tests\/autonomous-ingestion-workflow\.node-test\.mjs/);
  assert.match(contracts, /tests\/autonomous-ingestion-job-lease-supervisor\.node-test\.mjs/);
  assert.match(contracts, /tests\/auth-browser-service\.node-test\.mjs/);
  assert.match(contracts, /tests\/authenticated-social-runner-preflight\.node-test\.mjs/);
  assert.match(contracts, /tests\/ingestion-schedule\.node-test\.mjs/);
  assert.match(contracts, /tests\/autonomous-ingestion-receipt-policy\.node-test\.mjs/);
  assert.match(packageJson.scripts["test:collectors"], /npm run test:workflow-contracts/);
  assert.match(packageJson.scripts["test:collectors"], /npm run test:ingestion-contracts/);
  assert.match(packageJson.scripts.check, /npm run test:collectors/);
});

test("daily benchmarks snapshot source, publish one exact candidate, and verify main", () => {
  assert.match(dailyBenchmarkWorkflow, /ref:\s*\$\{\{ github\.sha \}\}/);
  assert.match(dailyBenchmarkWorkflow, /source_sha:\s*\$\{\{ steps\.source\.outputs\.source_sha \}\}/);
  assert.match(dailyBenchmarkWorkflow, /ref:\s*\$\{\{ needs\.resolve\.outputs\.source_sha \}\}/);
  assert.match(dailyBenchmarkWorkflow, /fetch-depth:\s*0/);
  assert.match(dailyBenchmarkWorkflow, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(dailyBenchmarkWorkflow, /git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/);
  assert.match(dailyBenchmarkWorkflow, /PUBLICATION_BRANCH:\s*main/);
  assert.match(dailyBenchmarkWorkflow, /if push_with_process_auth "\$candidate"/);
  assert.match(dailyBenchmarkWorkflow, /GIT_CONFIG_COUNT=3/);
  assert.match(dailyBenchmarkWorkflow, /GIT_CONFIG_KEY_0="\$PUBLICATION_CREDENTIAL_KEY"/);
  assert.match(dailyBenchmarkWorkflow, /GIT_CONFIG_KEY_1="core\.hooksPath"[\s\S]*?GIT_CONFIG_VALUE_1="\/dev\/null"/);
  assert.match(dailyBenchmarkWorkflow, /GIT_CONFIG_KEY_2="credential\.helper"[\s\S]*?GIT_CONFIG_VALUE_2=""/);
  assert.match(dailyBenchmarkWorkflow, /echo "::add-mask::\$PUBLICATION_EXTRAHEADER"/);
  assert.doesNotMatch(dailyBenchmarkWorkflow, /git config --local (?:--add )?http\.https:\/\/github\.com\/\.extraheader/);
  assert.match(dailyBenchmarkWorkflow, /reconcile_pushed_candidate\(\)/);
  assert.match(dailyBenchmarkWorkflow, /publish_exact_candidate\(\)/);
  assert.match(dailyBenchmarkWorkflow, /if ! publish_exact_candidate "\$FIRST_PUSH_CANDIDATE"/);
  assert.doesNotMatch(dailyBenchmarkWorkflow, /RETRY_PUSH_CANDIDATE|git rebase/);
  for (const trailer of [
    "Returner-Slot-Key",
    "Returner-Source-SHA",
    "Returner-Run-ID",
    "Returner-Run-Attempt",
    "Returner-Receipt-SHA256"
  ]) assert.match(dailyBenchmarkWorkflow, new RegExp(`${trailer}:`));
  assert.match(dailyBenchmarkWorkflow, /git -c core\.hooksPath=\/dev\/null -c credential\.helper= \\\n\s*commit/);
  assert.match(dailyBenchmarkWorkflow, /npm run artifacts:validate/);
  assert.match(dailyBenchmarkWorkflow, /is not reachable from remote main/);
  assert.match(dailyBenchmarkWorkflow, /commit_verified=true/);
  assert.match(dailyBenchmarkWorkflow, /PUBLICATION_STATUS="published"/);
  assert.match(dailyBenchmarkWorkflow, /PUBLICATION_STATUS="no_changes"/);
  assert.match(
    dailyBenchmarkWorkflow,
    /kind: "daily-score-benchmark-publication"[\s\S]*?generatedAt: new Date\(\)\.toISOString\(\)/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /node scripts\/lib\/publication-semantic-diff\.mjs --root "\$PWD" --base HEAD --target index --ignore "\$PUBLICATION_RECEIPT_PATH"[\s\S]*?No semantic benchmark changes; creating an immutable provenance commit\.[\s\S]*?commit --allow-empty[\s\S]*?publication_status=\$PUBLICATION_STATUS/
  );
  assert.doesNotMatch(dailyBenchmarkWorkflow, /git diff --cached --quiet/);
  assert.match(dailyBenchmarkWorkflow, /public\/graph\/manifest\.json/);
  assert.match(dailyBenchmarkWorkflow, /STATUS="inactive_candidate_no_update"/);
  assert.match(dailyBenchmarkWorkflow, /STATUS="accepted_candidate_failed"/);
  assert.ok(dailyBenchmarkWorkflow.indexOf("Record executed checkout") < dailyBenchmarkWorkflow.indexOf("npm run build"));
  const updateJob = dailyBenchmarkWorkflow.match(/\n  update:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  const jobTimeout = Number(updateJob.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  const stepTimeouts = Array.from(
    updateJob.matchAll(/^\s{8}timeout-minutes:\s*(\d+)/gm),
    (match) => Number(match[1])
  );
  assert.equal(jobTimeout, 240);
  assert.deepEqual(stepTimeouts, [10, 10, 15, 50, 10, 10, 10, 110]);
  assert.ok(stepTimeouts.reduce((total, timeout) => total + timeout, 0) < jobTimeout);
});

test("daily publication maps semantic-diff exit codes to exact publication outcomes", () => {
  const publishStep = workflowStepScript(dailyBenchmarkWorkflow, "Commit and publish benchmark snapshots");
  const semanticDiffCommand = 'node scripts/lib/publication-semantic-diff.mjs --root "$PWD" --base HEAD --target index --ignore "$PUBLICATION_RECEIPT_PATH"';

  assert.equal((publishStep.match(new RegExp(semanticDiffCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  assert.match(
    publishStep,
    /if node scripts\/lib\/publication-semantic-diff\.mjs --root "\$PWD" --base HEAD --target index --ignore "\$PUBLICATION_RECEIPT_PATH"; then[\s\S]*?SEMANTIC_DIFF_STATUS=0[\s\S]*?else[\s\S]*?SEMANTIC_DIFF_STATUS=\$\?/
  );
  assert.match(
    publishStep,
    /case "\$SEMANTIC_DIFF_STATUS" in[\s\S]*?0\)[\s\S]*?PUBLICATION_STATUS="no_changes"[\s\S]*?commit --allow-empty[\s\S]*?1\)[\s\S]*?PUBLICATION_STATUS="published"[\s\S]*?commit -m[\s\S]*?\*\)[\s\S]*?exit "\$SEMANTIC_DIFF_STATUS"/
  );
  assert.match(publishStep, /benchmark_files=\([\s\S]*public\/graph\/manifest\.json[\s\S]*\)/);
  assert.doesNotMatch(publishStep, /git diff --cached/);
});

test("daily benchmark receipts require exact-SHA reusable public validation", () => {
  assert.match(
    dailyBenchmarkWorkflow,
    /validate_publication:[\s\S]*?uses:\s*\.\/\.github\/workflows\/public-artifacts\.yml[\s\S]*?target_sha:\s*\$\{\{ needs\.update\.outputs\.validation_candidate \|\| needs\.resolve\.outputs\.source_sha \}\}[\s\S]*?policy_source_sha:\s*\$\{\{ needs\.resolve\.outputs\.source_sha \}\}/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /validate_adopted_release:[\s\S]*?uses:\s*\.\/\.github\/workflows\/public-artifacts\.yml[\s\S]*?target_sha:\s*\$\{\{ needs\.resolve\.outputs\.source_sha \}\}[\s\S]*?policy_source_sha:\s*\$\{\{ needs\.resolve\.outputs\.source_sha \}\}/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /needs:\s*\[resolve, update, validate_publication, validate_adopted_release\]/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /validate_publication:[\s\S]*?if:\s*\$\{\{ always\(\) && needs\.resolve\.outputs\.should_run == 'true' && needs\.update\.outputs\.publication_status != 'already_completed' \}\}/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /validate_adopted_release:[\s\S]*?if:\s*\$\{\{ always\(\) && needs\.resolve\.outputs\.should_run == 'true' && needs\.update\.outputs\.publication_status == 'already_completed' \}\}/
  );
  assert.match(dailyBenchmarkWorkflow, /publication_kind:\s*daily-benchmark/);
  assert.match(dailyBenchmarkWorkflow, /publication_receipt_path:\s*outputs\/benchmarks\/daily-publication-receipt\.json/);
  assert.match(dailyBenchmarkWorkflow, /publication_source_sha:\s*\$\{\{ needs\.update\.outputs\.publication_source_sha \}\}/);
  assert.match(dailyBenchmarkWorkflow, /publication_run_id:\s*\$\{\{ needs\.update\.outputs\.publication_run_id \}\}/);
  assert.match(dailyBenchmarkWorkflow, /name:\s*Recover exact benchmark publication commit[\s\S]*?if:\s*always\(\)/);
  assert.match(dailyBenchmarkWorkflow, /published_commit:\s*\$\{\{ steps\.recover_publication\.outputs\.published_commit \}\}/);
  assert.match(
    dailyBenchmarkWorkflow,
    /VALIDATION_RESULT:\s*\$\{\{ needs\.update\.outputs\.publication_status == 'already_completed' && needs\.validate_adopted_release\.result \|\| needs\.validate_publication\.result \}\}/
  );
  assert.match(dailyBenchmarkWorkflow, /COMMIT_REPOSITORY_VERIFIED:\s*\$\{\{ needs\.update\.outputs\.commit_verified \}\}/);
  assert.match(dailyBenchmarkWorkflow, /Public validation result:/);
  assert.match(dailyBenchmarkWorkflow, /name:\s*Materialize daily benchmark receipt[\s\S]*?if:\s*always\(\)/);
  assert.match(dailyBenchmarkWorkflow, /name:\s*Audit machine-readable benchmark receipt[\s\S]*?if:\s*always\(\)/);
  assert.match(dailyBenchmarkWorkflow, /name:\s*Upload daily benchmark receipt[\s\S]*?if:\s*always\(\)/);
  assert.match(dailyBenchmarkWorkflow, /actions\/upload-artifact@[0-9a-f]{40}\s+# v4/);
  assert.match(dailyBenchmarkWorkflow, /daily-benchmark-receipt-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  for (const stepName of [
    "Install dependencies",
    "Test daily benchmark updater",
    "Build app",
    "Update daily benchmark snapshots",
    "Rebuild timeline artifacts",
    "Rebuild graph-derived artifacts",
    "Validate generated public artifacts",
    "Commit and publish benchmark snapshots"
  ]) {
    assert.match(
      dailyBenchmarkWorkflow,
      new RegExp(`- name: ${stepName}[\\s\\S]{0,160}?if: steps\\.existing_slot\\.outputs\\.publication_status != 'already_completed'`)
    );
  }
});

test("daily benchmark receipt is always machine-readable and its audit rejects corruption", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-daily-receipt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const materialize = workflowStepScript(dailyBenchmarkWorkflow, "Materialize daily benchmark receipt");
  const audit = workflowStepScript(dailyBenchmarkWorkflow, "Audit machine-readable benchmark receipt");
  const runId = "31338649652";
  const runAttempt = "2";
  const sharedEnv = {
    RUNNER_TEMP: directory,
    AUDIT_STATUS: "published",
    SHOULD_RUN: "true",
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_UTC_HOUR: "5",
    SCHEDULED_AT: "2026-08-09T05:00:00Z",
    CENTRAL_DATE: "2026-08-09",
    RESOLVE_RESULT: "success",
    UPDATE_RESULT: "success",
    VALIDATION_RESULT: "success",
    PUBLICATION_STATUS: "published",
    RECEIPT_RECOGNIZED: "true",
    COMMIT_PROOF_VALID: "true",
    COMMIT_REPOSITORY_VERIFIED: "true",
    TRIGGER_SHA: FULL_COMMIT_SHA,
    SOURCE_SHA: FULL_COMMIT_SHA,
    EXECUTED_SHA: FULL_COMMIT_SHA,
    PUBLISHED_COMMIT: FULL_COMMIT_SHA,
    RUN_ID: runId,
    RUN_ATTEMPT: runAttempt,
    EVENT_NAME: "schedule",
    WORKFLOW_NAME: "Daily Score Benchmarks",
    REPOSITORY: "allenbuild/returner-fund",
    ACTOR: "github-actions[bot]",
    REF: "refs/heads/main",
    RUN_URL: `https://github.com/allenbuild/returner-fund/actions/runs/${runId}`
  };

  const materialized = runScript(materialize, repositoryRoot, sharedEnv);
  assert.equal(materialized.status, 0, `${materialized.stdout}\n${materialized.stderr}`);
  const receiptPath = path.join(directory, "daily-benchmark-receipt", "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.triggerSha, FULL_COMMIT_SHA);
  assert.equal(receipt.sourceSha, FULL_COMMIT_SHA);
  assert.equal(receipt.executedSha, FULL_COMMIT_SHA);
  assert.equal(receipt.publishedCommit, FULL_COMMIT_SHA);
  assert.deepEqual(receipt.run, {
    id: runId,
    attempt: runAttempt,
    eventName: "schedule",
    workflow: "Daily Score Benchmarks",
    repository: "allenbuild/returner-fund",
    actor: "github-actions[bot]",
    ref: "refs/heads/main",
    url: `https://github.com/allenbuild/returner-fund/actions/runs/${runId}`
  });

  const valid = runScript(audit, repositoryRoot, {
    RUNNER_TEMP: directory,
    EXPECTED_TRIGGER_SHA: FULL_COMMIT_SHA,
    EXPECTED_RUN_ID: runId,
    EXPECTED_RUN_ATTEMPT: runAttempt
  });
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

  const adoptedReceipt = { ...receipt, status: "already_completed", publicationStatus: "already_completed" };
  writeFileSync(receiptPath, `${JSON.stringify(adoptedReceipt, null, 2)}\n`);
  const adopted = runScript(audit, repositoryRoot, {
    RUNNER_TEMP: directory,
    EXPECTED_TRIGGER_SHA: FULL_COMMIT_SHA,
    EXPECTED_RUN_ID: runId,
    EXPECTED_RUN_ATTEMPT: runAttempt
  });
  assert.equal(adopted.status, 0, `${adopted.stdout}\n${adopted.stderr}`);

  for (const [name, mutate] of [
    ["short source SHA", (value) => { value.sourceSha = "c5506de"; }],
    ["accepted failure with every gate successful", (value) => { value.status = "accepted_candidate_failed"; }],
    ["accepted failure with failed resolver", (value) => {
      value.status = "accepted_candidate_failed";
      value.updateResult = "failure";
      value.resolveResult = "failure";
    }],
    ["accepted failure with impossible date", (value) => {
      value.status = "accepted_candidate_failed";
      value.updateResult = "failure";
      value.centralDate = "2026-02-31";
    }],
    ["scheduled trigger with manual event", (value) => {
      value.status = "accepted_candidate_failed";
      value.updateResult = "failure";
      value.run.eventName = "workflow_dispatch";
    }],
    ["date contradicts scheduled instant", (value) => {
      value.status = "accepted_candidate_failed";
      value.updateResult = "failure";
      value.centralDate = "2026-08-08";
    }],
    ["UTC hour contradicts scheduled instant", (value) => {
      value.status = "accepted_candidate_failed";
      value.updateResult = "failure";
      value.scheduledUtcHour = "6";
    }],
    ["accepted failure without source SHA", (value) => {
      value.status = "accepted_candidate_failed";
      value.updateResult = "failure";
      value.sourceSha = null;
    }]
  ]) {
    const corrupted = JSON.parse(JSON.stringify(receipt));
    mutate(corrupted);
    writeFileSync(receiptPath, `${JSON.stringify(corrupted, null, 2)}\n`);
    const result = runScript(audit, repositoryRoot, {
      RUNNER_TEMP: directory,
      EXPECTED_TRIGGER_SHA: FULL_COMMIT_SHA,
      EXPECTED_RUN_ID: runId,
      EXPECTED_RUN_ATTEMPT: runAttempt
    });
    assert.notEqual(result.status, 0, `${name}: contradictory receipt must fail`);
  }
});

test("daily benchmarks rebuild and validate timelines through the structured migration fallback", () => {
  const updateJob = dailyBenchmarkWorkflow.match(/\n  update:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  const benchmarkStep = updateJob.match(
    /- name: Update daily benchmark snapshots([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1] ?? "";
  const timelineStep = updateJob.match(
    /- name: Rebuild timeline artifacts([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1] ?? "";

  assert.doesNotMatch(benchmarkStep, /SUPABASE|TIMELINE_REQUIRE_DATABASE|exit 1/);
  assert.doesNotMatch(timelineStep, /^\s*if:\s*steps\.timeline_database/m);
  assert.match(timelineStep, /npm run timeline:backfill:daily/);
  assert.doesNotMatch(timelineStep, /grep|migration_unavailable/);
  assert.match(updateJob, /benchmark_files=\([\s\S]*public\/timelines[\s\S]*artifacts\/company-timeline\/coverage\.json/);
  assert.match(updateJob, /npm run artifacts:validate/);
  assert.match(updateJob, /npm run artifacts:manifest:validate/);
  assert.equal((updateJob.match(/npm run timeline:validate/g) ?? []).length, 1);
});

test("daily publication prepares artifacts before entering the credential-bearing push boundary", () => {
  const updateJob = dailyBenchmarkWorkflow.match(/\n  update:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  const publishStep = workflowStepScript(dailyBenchmarkWorkflow, "Commit and publish benchmark snapshots");

  assert.equal((updateJob.match(/npm run artifacts:derived:build/g) ?? []).length, 1);
  assert.equal((updateJob.match(/npm run artifacts:derived:validate/g) ?? []).length, 1);
  assert.match(
    updateJob,
    /benchmark_files=\([\s\S]*public\/graph[\s\S]*public\/timelines[\s\S]*public\/topic-facets[\s\S]*src\/lib\/graph\/ranked-posts-sidecar\.generated\.json/
  );
  const stagedArtifacts = publishStep.match(/benchmark_files=\([\s\S]*?\n\s*\)/)?.[0] ?? "";
  for (const supportingPath of [
    "public/timelines",
    "public/topic-facets",
    "src/lib/graph/ranked-posts-sidecar.generated.json",
    "src/lib/social/logged-in-evidence-current.json",
    "docs/outputs/scoring-diagnostics-v4-audit.json",
    "docs/outputs/scoring-diagnostics-v4-report.md"
  ]) {
    assert.match(stagedArtifacts, new RegExp(supportingPath.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(
    publishStep,
    /\bnpm\b|node scripts\/(?!lib\/publication-semantic-diff\.mjs\b)|git\s+(?:rebase|merge(?!-base)|pull)/,
  );
  assert.equal(
    (publishStep.match(/node scripts\/lib\/publication-semantic-diff\.mjs --root "\$PWD" --base HEAD --target index --ignore "\$PUBLICATION_RECEIPT_PATH"/g) ?? []).length,
    1,
  );
  assert.match(publishStep, /node --input-type=module/);
  assert.match(publishStep, /publish_exact_candidate\(\)[\s\S]*?for attempt in 1 2/);
  assert.match(
    publishStep,
    /push_with_process_auth\(\)[\s\S]*?assert_safe_candidate_modes "\$candidate"[\s\S]*?recheck_candidate_freshness[\s\S]*?git push origin "\$candidate:\$PUBLICATION_BRANCH"/
  );
  assert.match(publishStep, /git push origin "\$candidate:\$PUBLICATION_BRANCH"/);
  assert.match(publishStep, /core\.hooksPath[\s\S]*?\/dev\/null[\s\S]*?credential\.helper/);
  assert.match(publishStep, /refusing to execute or rebase newer target code/);
});

test.skip("legacy credential-bearing rebase rebuild fixture is retired", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-tokenless-rebuild-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  const bin = path.join(directory, "bin");
  const rebuildLog = path.join(directory, "rebuild.log");
  const pushCountPath = path.join(directory, "push-count");
  const hookMarker = path.join(directory, "malicious-hook-ran");
  mkdirSync(seed);
  mkdirSync(bin);
  runGit(directory, "init", "--bare", remote);
  runGit(seed, "init");
  runGit(seed, "checkout", "-b", "main");
  runGit(seed, "config", "user.name", "Workflow Test");
  runGit(seed, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(seed, "fixture.txt"), "source\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "source fixture");
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  runGit(directory, "clone", remote, checkout);
  runGit(checkout, "config", "user.name", "Workflow Test");
  runGit(checkout, "config", "user.email", "workflow@example.com");
  const sourceSha = runGit(checkout, "rev-parse", "HEAD");

  writeFileSync(
    path.join(checkout, ".git", "hooks", "pre-push"),
    `#!/usr/bin/env bash\nprintf '%s\n' "\${GITHUB_TOKEN:-}\${PUBLICATION_EXTRAHEADER:-}\${GIT_CONFIG_VALUE_0:-}" > "${hookMarker}"\nexit 97\n`
  );
  chmodSync(path.join(checkout, ".git", "hooks", "pre-push"), 0o755);

  writeFileSync(path.join(seed, "remote-only.txt"), "advanced\n");
  runGit(seed, "add", "remote-only.txt");
  runGit(seed, "commit", "-m", "advance remote main");
  runGit(seed, "push", "origin", "main");
  writeFileSync(path.join(checkout, "fixture.txt"), "generated benchmark\n");

  const guardScript = `#!/usr/bin/env bash
set -euo pipefail
if git config --local --get-all http.https://github.com/.extraheader | grep -q .; then
  echo "credential-present $0 $*" >> "$REBUILD_LOG"
  exit 97
fi
if [ -n "\${PUBLICATION_EXTRAHEADER:-}" ]; then
  echo "credential-exported $0 $*" >> "$REBUILD_LOG"
  exit 98
fi
if [ -n "\${NEXT_PUBLIC_SUPABASE_URL:-}" ] || [ -n "\${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "supabase-credential-present $0 $*" >> "$REBUILD_LOG"
  exit 99
fi
echo "credential-absent $0 $*" >> "$REBUILD_LOG"
`;
  writeFileSync(path.join(bin, "npm"), guardScript);
  writeFileSync(
    path.join(bin, "node"),
    `${guardScript}\nif [ "\${1:-}" = "-p" ]; then echo fixture-run; exit 0; fi\nif [ "\${1:-}" = "scripts/write-artifact-manifest.mjs" ]; then exit 0; fi\nexec "$REAL_NODE" "$@"\n`
  );
  writeFileSync(
    path.join(bin, "timeout"),
    "#!/usr/bin/env bash\nset -euo pipefail\nshift\nexec \"$@\"\n"
  );
  writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "push" ]; then
  test "\${GIT_CONFIG_COUNT:-}" = "3"
  test "\${GIT_CONFIG_KEY_0:-}" = "http.https://github.com/.extraheader"
  test -n "\${GIT_CONFIG_VALUE_0:-}"
  test "\${GIT_CONFIG_KEY_1:-}" = "core.hooksPath"
  test "\${GIT_CONFIG_VALUE_1:-}" = "/dev/null"
  test "\${GIT_CONFIG_KEY_2:-}" = "credential.helper"
  test -z "\${GIT_CONFIG_VALUE_2:-}"
  if git config --local --get-all http.https://github.com/.extraheader | grep -q .; then exit 95; fi
  if [ -n "\${PUBLICATION_EXTRAHEADER:-}" ]; then exit 94; fi
  if [ -n "\${NEXT_PUBLIC_SUPABASE_URL:-}" ] || [ -n "\${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then exit 93; fi
  count=0
  if [ -f "$PUSH_COUNT_PATH" ]; then count="$(cat "$PUSH_COUNT_PATH")"; fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$PUSH_COUNT_PATH"
  set +e
  "$REAL_GIT" "$@"
  status=$?
  set -e
  if [ "$count" -eq 2 ] && [ "$status" -eq 0 ]; then exit 86; fi
  exit "$status"
fi
exec "$REAL_GIT" "$@"
`
  );
  for (const command of ["npm", "node", "timeout", "git"]) chmodSync(path.join(bin, command), 0o755);
  const original = workflowStepScript(dailyBenchmarkWorkflow, "Commit and publish benchmark snapshots");
  const script = original.replace(
    /benchmark_files=\([\s\S]*?\n\s*\)/,
    'benchmark_files=(fixture.txt "$PUBLICATION_RECEIPT_PATH")'
  );
  assert.notEqual(script, original, "fixture must narrow the generated-file pathspec");
  const output = path.join(directory, "publish-output");
  const result = runScript(script, checkout, {
    PATH: `${bin}:${process.env.PATH}`,
    REAL_GIT: commandPath("git"),
    REAL_NODE: commandPath("node"),
    PUSH_COUNT_PATH: pushCountPath,
    REBUILD_LOG: rebuildLog,
    PUBLICATION_BRANCH: "main",
    GITHUB_TOKEN: "fixture-publication-token",
    SCHEDULED_UTC_HOUR: "",
    SCHEDULE_TRIGGER: "manual-dispatch",
    SCHEDULED_AT: "2026-08-09T12:00:00.000Z",
    CENTRAL_DATE: "2026-08-09",
    SOURCE_SHA: sourceSha,
    WORKFLOW_RUN_ID: "31338649652",
    WORKFLOW_RUN_ATTEMPT: "2",
    NEXT_PUBLIC_SUPABASE_URL: "https://sentinel.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "sentinel-service-role-secret",
    GITHUB_OUTPUT: output
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const log = readFileSync(rebuildLog, "utf8");
  assert.match(log, /credential-absent .*npm ci/);
  assert.match(log, /credential-absent .*npm run build/);
  assert.match(log, /credential-absent .*npm run benchmarks:daily/);
  assert.doesNotMatch(log, /credential-present/);
  assert.doesNotMatch(log, /credential-exported/);
  assert.doesNotMatch(log, /supabase-credential-present/);
  assert.equal(existsSync(hookMarker), false, "process-scoped push must disable repository hooks");
  assert.equal(readFileSync(pushCountPath, "utf8").trim(), "2", "retry push must be attempted exactly once");
  const credential = spawnSync(
    "git",
    ["config", "--local", "--get-all", "http.https://github.com/.extraheader"],
    { cwd: checkout, encoding: "utf8" }
  );
  assert.notEqual(credential.status, 0, "publication credential must be absent after retry");
  runGit(seed, "fetch", "origin", "main");
  const remoteBody = runGit(seed, "show", "-s", "--format=%B", "origin/main");
  assert.match(remoteBody, /Returner-Slot-Key: daily-benchmark-2026-08-09/);
  assert.match(remoteBody, new RegExp(`Returner-Source-SHA: ${sourceSha}`));
  assert.match(remoteBody, /Returner-Run-ID: 31338649652/);
  assert.match(remoteBody, /Returner-Run-Attempt: 2/);
  assert.match(remoteBody, /Returner-Receipt-SHA256: [0-9a-f]{64}/);
});

test("daily initial push reconciles a landed commit after a nonzero response", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-initial-push-reconciliation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const checkout = path.join(directory, "checkout");
  const bin = path.join(directory, "bin");
  const pushCountPath = path.join(directory, "push-count");
  mkdirSync(checkout);
  mkdirSync(bin);
  runGit(directory, "init", "--bare", remote);
  runGit(checkout, "init");
  runGit(checkout, "checkout", "-b", "main");
  runGit(checkout, "config", "user.name", "Workflow Test");
  runGit(checkout, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(checkout, "fixture.txt"), "source\n");
  runGit(checkout, "add", "fixture.txt");
  runGit(checkout, "commit", "-m", "source fixture");
  const sourceSha = runGit(checkout, "rev-parse", "HEAD");
  runGit(checkout, "remote", "add", "origin", remote);
  runGit(checkout, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(path.join(checkout, "fixture.txt"), "generated benchmark\n");

  writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "push" ]; then
  test "\${GIT_CONFIG_COUNT:-}" = "3"
  test "\${GIT_CONFIG_KEY_1:-}" = "core.hooksPath"
  test "\${GIT_CONFIG_VALUE_1:-}" = "/dev/null"
  count=0
  if [ -f "$PUSH_COUNT_PATH" ]; then count="$(cat "$PUSH_COUNT_PATH")"; fi
  printf '%s\n' "$((count + 1))" > "$PUSH_COUNT_PATH"
  set +e
  "$REAL_GIT" "$@"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then exit 86; fi
  exit "$status"
fi
exec "$REAL_GIT" "$@"
`
  );
  chmodSync(path.join(bin, "git"), 0o755);

  const original = workflowStepScript(dailyBenchmarkWorkflow, "Commit and publish benchmark snapshots");
  const script = original.replace(
    /benchmark_files=\([\s\S]*?\n\s*\)/,
    'benchmark_files=(fixture.txt "$PUBLICATION_RECEIPT_PATH")'
  );
  const output = path.join(directory, "publish-output");
  const result = runScript(script, checkout, {
    PATH: `${bin}:${process.env.PATH}`,
    REAL_GIT: commandPath("git"),
    PUSH_COUNT_PATH: pushCountPath,
    PUBLICATION_BRANCH: "main",
    GITHUB_TOKEN: "fixture-publication-token",
    SCHEDULED_UTC_HOUR: "",
    SCHEDULE_TRIGGER: "manual-dispatch",
    SCHEDULED_AT: "2026-08-09T12:00:00.000Z",
    CENTRAL_DATE: "2026-08-09",
    SOURCE_SHA: sourceSha,
    WORKFLOW_RUN_ID: "31338649652",
    WORKFLOW_RUN_ATTEMPT: "3",
    GITHUB_OUTPUT: output
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Benchmark push reconciled/);
  assert.equal(readFileSync(pushCountPath, "utf8").trim(), "1");
  const values = readFileSync(output, "utf8");
  const publishedCommit = values.match(/^published_commit=([0-9a-f]{40})$/m)?.[1];
  assert.ok(publishedCommit);
  assert.equal(runGit(checkout, "rev-parse", "HEAD"), publishedCommit);
  assert.equal(runGit(checkout, "rev-parse", "origin/main"), publishedCommit);
});

test("daily publication rejects a generated candidate with a tracked symlink before push", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-daily-candidate-modes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const checkout = path.join(directory, "checkout");
  mkdirSync(checkout);
  runGit(directory, "init", "--bare", remote);
  runGit(checkout, "init");
  runGit(checkout, "checkout", "-b", "main");
  runGit(checkout, "config", "user.name", "Workflow Test");
  runGit(checkout, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(checkout, "fixture.txt"), "source\n");
  runGit(checkout, "add", "fixture.txt");
  runGit(checkout, "commit", "-m", "source fixture");
  const sourceSha = runGit(checkout, "rev-parse", "HEAD");
  runGit(checkout, "remote", "add", "origin", remote);
  runGit(checkout, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  writeFileSync(path.join(checkout, "fixture.txt"), "generated benchmark\n");
  symlinkSync("fixture.txt", path.join(checkout, "unsafe-link"));
  const original = workflowStepScript(dailyBenchmarkWorkflow, "Commit and publish benchmark snapshots");
  const script = original.replace(
    /benchmark_files=\([\s\S]*?\n\s*\)/,
    'benchmark_files=(fixture.txt unsafe-link "$PUBLICATION_RECEIPT_PATH")'
  );
  const result = runScript(script, checkout, {
    PUBLICATION_BRANCH: "main",
    GITHUB_TOKEN: "fixture-publication-token",
    SCHEDULED_UTC_HOUR: "",
    SCHEDULE_TRIGGER: "manual-dispatch",
    SCHEDULED_AT: "2026-08-09T12:00:00.000Z",
    CENTRAL_DATE: "2026-08-09",
    SOURCE_SHA: sourceSha,
    WORKFLOW_RUN_ID: "31338649652",
    WORKFLOW_RUN_ATTEMPT: "4",
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    PUBLICATION_PUSH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: path.join(directory, "publish-output")
  });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /daily publication candidate contains prohibited symlink\/submodule entries/
  );
  assert.equal(runGit(remote, "rev-parse", "refs/heads/main"), sourceSha);
});

test("workflow gates work through the schedule helper and stable key", () => {
  assert.match(workflow, /id:\s*schedule[\s\S]*?node scripts\/lib\/ingestion-schedule\.mjs/);
  assert.match(workflow, /GITHUB_EVENT_SCHEDULE:\s*\$\{\{ github\.event\.schedule \}\}/);
  assert.match(workflow, /INGESTION_REPLAY_KEY:\s*\$\{\{ inputs\.replay_key \}\}/);
  assert.match(workflow, /if:\s*needs\.resolve\.outputs\.should_run == 'true'/);
  assert.match(workflow, /INGESTION_IDEMPOTENCY_KEY:\s*\$\{\{ needs\.resolve\.outputs\.slot_key \}\}/);
  assert.match(workflow, /--idempotency-key="\$INGESTION_IDEMPOTENCY_KEY"/);
  assert.match(workflow, /CANDIDATE_TRIGGER:\s*\$\{\{ needs\.resolve\.outputs\.trigger \}\}/);
  assert.match(workflow, /CANDIDATE_SCHEDULED_AT:\s*\$\{\{ needs\.resolve\.outputs\.scheduled_at \}\}/);
  assert.match(workflow, /CANDIDATE_RECOVERY_DEBT:\s*\$\{\{ needs\.resolve\.outputs\.recovery_debt \}\}/);
  assert.match(workflow, /--candidate-trigger="\$CANDIDATE_TRIGGER"/);
  assert.match(workflow, /--scheduled-at="\$CANDIDATE_SCHEDULED_AT"/);
  assert.match(workflow, /--recovery-debt="\$CANDIDATE_RECOVERY_DEBT"/);
});

test("database failures preserve only normalized structured retry metadata", () => {
  const wrapped = autonomousDatabaseOperationError("persist fixture rows", {
    code: "40p01",
    message: "deadlock detected"
  });
  const outer = new Error("fixture wrapper", { cause: wrapped });

  assert.deepEqual(autonomousDatabaseFailureMetadata(outer), {
    domain: "database",
    code: "40P01"
  });
  assert.equal(isRetryableAutonomousDatabaseFailure({
    domain: "database",
    code: "40P01"
  }), true);

  const invalidCode = autonomousDatabaseOperationError("persist fixture rows", {
    code: "NOT_A_DATABASE_CODE",
    message: "fixture failure"
  });
  assert.deepEqual(autonomousDatabaseFailureMetadata(invalidCode), {
    domain: "database",
    code: ""
  });
  assert.equal(isRetryableAutonomousDatabaseFailure({
    domain: "database",
    code: "23505"
  }), false);
});

test("workflow retry policy retries transient failures but fails closed on lease loss and semantic ambiguity", () => {
  const outcome = ({
    runnerStatus = "failed",
    publicationStatus = "",
    failureMessage = "",
    failureDomain = "",
    failureCode = "",
    publishedCommit = ""
  } = {}) => [
    `runner_status=${runnerStatus}`,
    `publication_status=${publicationStatus}`,
    `failure_message=${failureMessage}`,
    `failure_domain=${failureDomain}`,
    `failure_code=${failureCode}`,
    `published_commit=${publishedCommit}`
  ].join("\n");

  for (const failureMessage of [
    "Ingestion lease heartbeat failed; publication aborted: TypeError: fetch failed",
    "import durable evidence snapshots timed out after 300000ms.",
    "GitHub request failed with HTTP status 503",
    "collector failed with ECONNRESET"
  ]) {
    const decision = classifyAutonomousWorkflowAttempt({
      exitCode: 1,
      output: outcome({ failureMessage })
    });
    assert.equal(decision.retryable, true, failureMessage);
    assert.equal(decision.reason, "transient-infrastructure-failure");
  }

  for (const failureCode of [
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "08P01",
    "40001",
    "40P01",
    "55P03",
    "53300",
    "57014",
    "57P01",
    "57P02",
    "57P03",
    "PGRST000",
    "PGRST002",
    "PGRST003"
  ]) {
    const decision = classifyAutonomousWorkflowAttempt({
      exitCode: 1,
      output: outcome({
        failureMessage: "Failed to persist fixture rows: database operation unavailable",
        failureDomain: "database",
        failureCode
      })
    });
    assert.equal(decision.retryable, true, failureCode);
    assert.equal(decision.reason, "transient-database-failure", failureCode);
  }

  for (const [failureCode, failureMessage] of [
    [
      "23505",
      'Failed to upsert canonical social accounts: duplicate key value violates unique constraint "social_accounts_entity_platform_native_key"'
    ],
    ["23503", "Failed to persist fixture rows: foreign key violation"],
    ["22P02", "Failed to persist fixture rows: invalid input syntax"],
    ["42P01", "Failed to persist fixture rows: undefined table"],
    ["08007", "Failed to persist fixture rows: transaction resolution unknown"],
    ["40003", "Failed to persist fixture rows: statement completion unknown"],
    ["PGRST204", "Failed to persist fixture rows: schema cache mismatch"]
  ]) {
    const decision = classifyAutonomousWorkflowAttempt({
      exitCode: 1,
      output: outcome({ failureMessage, failureDomain: "database", failureCode })
    });
    assert.equal(decision.retryable, false, failureCode);
    assert.equal(decision.reason, "non-retryable-database-failure", failureCode);
  }

  const semanticDatabaseFailure = classifyAutonomousWorkflowAttempt({
    exitCode: 1,
    output: outcome({
      failureMessage: "Lease token mismatch after a serialization failure.",
      failureDomain: "database",
      failureCode: "40001"
    })
  });
  assert.equal(semanticDatabaseFailure.reason, "semantic-lock-or-candidate-failure");
  assert.equal(semanticDatabaseFailure.retryable, false);

  for (const publicationProof of [
    { publishedCommit: "d".repeat(40) },
    { publicationStatus: "no_changes" }
  ]) {
    const decision = classifyAutonomousWorkflowAttempt({
      exitCode: 1,
      output: outcome({
        ...publicationProof,
        failureMessage: "Failed to persist fixture rows: deadlock detected",
        failureDomain: "database",
        failureCode: "40P01"
      })
    });
    assert.equal(decision.reason, "publication-may-have-completed");
    assert.equal(decision.retryable, false);
  }

  const lockContention = classifyAutonomousWorkflowAttempt({
    exitCode: 1,
    output: outcome({
      failureMessage: "Another ingestion coordinator owns the non-expired autonomous-ingestion lease."
    })
  });
  assert.equal(lockContention.retryable, true);
  assert.equal(lockContention.reason, "runtime-lock-contention");

  for (const failureMessage of [
    "The ingestion runtime lock expired or was taken by another worker.",
    "Queued candidate is superseded by a newer Central slot.",
    "Unrecognized evidence schema."
  ]) {
    const decision = classifyAutonomousWorkflowAttempt({
      exitCode: 1,
      output: outcome({ failureMessage })
    });
    assert.equal(decision.retryable, false, failureMessage);
  }

  const publishedFailure = classifyAutonomousWorkflowAttempt({
    exitCode: 1,
    output: outcome({
      failureMessage: "fetch failed after publication",
      publishedCommit: "a".repeat(40)
    })
  });
  assert.equal(publishedFailure.reason, "publication-may-have-completed");
  assert.equal(publishedFailure.retryable, false);

  const completed = classifyAutonomousWorkflowAttempt({
    exitCode: 0,
    output: outcome({
      runnerStatus: "refreshed",
      publicationStatus: "published",
      publishedCommit: "b".repeat(40)
    })
  });
  assert.equal(completed.completed, true);

  const canceled = classifyAutonomousWorkflowAttempt({
    exitCode: 143,
    signal: "SIGTERM",
    output: outcome({
      failureMessage: "Failed to persist fixture rows: deadlock detected",
      failureDomain: "database",
      failureCode: "40P01"
    })
  });
  assert.equal(canceled.reason, "runner-terminated");
  assert.equal(canceled.retryable, false);
});

test("workflow retry policy isolates attempt outputs and enforces a bounded job budget", () => {
  assert.equal(
    parseAutonomousWorkflowAttemptOutput("runner_status=failed\nrunner_status=refreshed\n").valid,
    false
  );
  assert.deepEqual(
    parseAutonomousWorkflowRetryConfig({
      AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS: "6",
      AUTONOMOUS_WORKFLOW_RETRY_MAX_ELAPSED_SECONDS: "22200",
      AUTONOMOUS_WORKFLOW_RETRY_MIN_REMAINING_SECONDS: "19860",
      AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS: "30,120,300,600,180"
    }),
    {
      maxAttempts: 6,
      maxElapsedSeconds: 22_200,
      minRemainingSeconds: 19_860,
      retryDelaysSeconds: [30, 120, 300, 600, 180]
    }
  );
  assert.throws(
    () => parseAutonomousWorkflowRetryConfig({ AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS: "forever" }),
    /must be an integer/
  );
  assert.throws(
    () => parseAutonomousWorkflowRetryConfig({
      AUTONOMOUS_WORKFLOW_RETRY_MAX_ELAPSED_SECONDS: "19200",
      AUTONOMOUS_WORKFLOW_RETRY_MIN_REMAINING_SECONDS: "900"
    }),
    /must be an integer between 19860 and 22500/
  );
  assert.equal(
    AUTONOMOUS_WORKFLOW_ATTEMPT_ALLOWANCE_MS,
    AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS + AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS
  );
  assert.equal(
    AUTONOMOUS_WORKFLOW_MINIMUM_ATTEMPT_WINDOW_MS,
    AUTONOMOUS_WORKFLOW_ATTEMPT_ALLOWANCE_MS + 60_000
  );
  assert.equal(
    AUTONOMOUS_WORKFLOW_CHILD_TERMINATION_GRACE_MS,
    AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS
  );
});

test("production lock-contention retries outwait one complete coordinator lease", () => {
  const runnerStep = workflow.match(
    /- name: Run autonomous ingestion[\s\S]*?(?=\n\s{6}- name:)/
  )?.[0] ?? "";
  const environmentValue = (name) => runnerStep.match(
    new RegExp(`${name}:\\s*"([0-9,]+)"`)
  )?.[1];
  const config = parseAutonomousWorkflowRetryConfig({
    AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS: environmentValue(
      "AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS"
    ),
    AUTONOMOUS_WORKFLOW_RETRY_MAX_ELAPSED_SECONDS: environmentValue(
      "AUTONOMOUS_WORKFLOW_RETRY_MAX_ELAPSED_SECONDS"
    ),
    AUTONOMOUS_WORKFLOW_RETRY_MIN_REMAINING_SECONDS: environmentValue(
      "AUTONOMOUS_WORKFLOW_RETRY_MIN_REMAINING_SECONDS"
    ),
    AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS: environmentValue(
      "AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS"
    )
  });
  const attemptStartOffsetsSeconds = [0];
  let elapsedSeconds = 0;
  for (let attempt = 1; attempt < config.maxAttempts; attempt += 1) {
    const delaySeconds = config.retryDelaysSeconds[
      Math.min(attempt - 1, config.retryDelaysSeconds.length - 1)
    ];
    elapsedSeconds += delaySeconds;
    if (config.maxElapsedSeconds - elapsedSeconds < config.minRemainingSeconds) break;
    attemptStartOffsetsSeconds.push(elapsedSeconds);
  }

  assert.deepEqual(attemptStartOffsetsSeconds, [0, 30, 150, 450, 1_050, 1_230]);
  assert.ok(
    attemptStartOffsetsSeconds.at(-1) >= 20 * 60,
    "a full child attempt must remain admissible after the 20-minute coordinator lease expires"
  );
  assert.ok(
    attemptStartOffsetsSeconds.at(-1) <= (20 * 60) + 60,
    "the post-expiry claim must not leave a long orphan-lock retry gap"
  );
  assert.ok(
    config.maxElapsedSeconds - attemptStartOffsetsSeconds.at(-1) >=
      config.minRemainingSeconds,
    "the post-lease attempt must retain the complete runner and cleanup allowance"
  );
});

test("workflow execs the retry controller so cancellation cannot orphan its signal owner", () => {
  const runnerStep = workflow.match(
    /- name: Run autonomous ingestion[\s\S]*?(?=\n\s{6}- name:)/
  )?.[0] ?? "";
  const execIndex = runnerStep.indexOf(
    "exec node scripts/lib/autonomous-ingestion-workflow-retry.mjs --"
  );

  assert.ok(execIndex > 0, "the retry controller must replace the transient step shell");
  assert.ok(
    runnerStep.indexOf("/usr/bin/caffeinate -ims -w $$") < execIndex,
    "the same exec-stable PID must own the verified wake assertion before controller launch"
  );
  assert.doesNotMatch(
    runnerStep,
    /(?:^|\n)\s*node scripts\/lib\/autonomous-ingestion-workflow-retry\.mjs --/,
    "a shell-parented controller can be orphaned when Actions cancels the shell"
  );
});

test("power watchdog preserves AC runs and trips once at the battery reserve floor", async () => {
  assert.deepEqual(
    parseAutonomousPowerWatchdogConfig({
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT: "20",
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS: "30"
    }),
    { enabled: true, reservePercent: 20, intervalSeconds: 30 }
  );
  assert.throws(
    () => parseAutonomousPowerWatchdogConfig({
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT: "0"
    }),
    /must be an integer between 5 and 50/
  );
  assert.throws(
    () => parseAutonomousPowerWatchdogConfig({
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT: "20",
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS: "1"
    }),
    /must be an integer between 5 and 300/
  );

  const acAtFivePercent = parseMacPowerStatus(
    "Now drawing from 'AC Power'\n -InternalBattery-0 5%; charging; 0:10 remaining"
  );
  const batteryAtTwentyOnePercent = parseMacPowerStatus(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 21%; discharging; 0:30 remaining"
  );
  const batteryAtTwentyPercent = parseMacPowerStatus(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 20%; discharging; 0:25 remaining"
  );
  assert.equal(shouldTerminateForLowPower(acAtFivePercent, 20), false);
  assert.equal(shouldTerminateForLowPower(batteryAtTwentyOnePercent, 20), false);
  assert.equal(shouldTerminateForLowPower(batteryAtTwentyPercent, 20), true);

  const statuses = [acAtFivePercent, batteryAtTwentyOnePercent, batteryAtTwentyPercent];
  const terminations = [];
  let reads = 0;
  const watchdog = startAutonomousIngestionPowerWatchdog({
    environment: {
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT: "20",
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS: "30"
    },
    intervalMs: 1,
    readPowerStatus: async () => statuses[Math.min(reads++, statuses.length - 1)],
    onLowReserve: (status) => terminations.push(status),
    reporter: { warn() {}, error() {} }
  });
  await watchdog.done;
  await watchdog.stop();
  assert.deepEqual(terminations, [{ batteryPercent: 20, reservePercent: 20 }]);
  const readsAfterStop = reads;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, readsAfterStop, "the stopped watchdog must not retain a polling timer");
});

test("power watchdog enters the retry controller SIGTERM drain and leaves the slot retryable", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-power-watchdog-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "checkpointing-runner.mjs");
  const lifecycleMarker = path.join(directory, "lifecycle-marker");
  const githubOutput = path.join(directory, "github-output");
  writeFileSync(
    fixture,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      'process.once("SIGTERM", () => {',
      '  appendFileSync(process.env.LIFECYCLE_MARKER, "sigterm\\n");',
      '  appendFileSync(process.env.GITHUB_OUTPUT, [',
      '    "runner_status=canceled",',
      '    "publication_status=",',
      '    "failure_message=Autonomous ingestion canceled by SIGTERM.",',
      '    "published_commit="',
      '  ].join("\\n") + "\\n");',
      '  setTimeout(() => {',
      '    appendFileSync(process.env.LIFECYCLE_MARKER, "cleanup-complete\\n");',
      '    process.exit(143);',
      '  }, 25);',
      '});',
      'writeFileSync(process.env.LIFECYCLE_MARKER, "started\\n");',
      'setInterval(() => {}, 1_000);'
    ].join("\n")
  );

  let powerReads = 0;
  const exitCode = await runAutonomousWorkflowRetries({
    runnerArguments: [],
    runnerPath: fixture,
    environment: {
      ...process.env,
      GITHUB_OUTPUT: githubOutput,
      RUNNER_TEMP: directory,
      LIFECYCLE_MARKER: lifecycleMarker,
      AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS: "1",
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT: "20",
      AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS: "30"
    },
    powerWatchdogOptions: {
      intervalMs: 5,
      readPowerStatus: async () => {
        powerReads += 1;
        return existsSync(lifecycleMarker)
          ? { onACPower: false, batteryPercent: 20 }
          : { onACPower: true, batteryPercent: 5 };
      },
      reporter: { warn() {}, error() {} }
    }
  });

  assert.equal(exitCode, 143);
  assert.equal(
    readFileSync(lifecycleMarker, "utf8"),
    "started\nsigterm\ncleanup-complete\n"
  );
  const output = readFileSync(githubOutput, "utf8");
  assert.match(output, /^runner_status=canceled$/m);
  assert.match(output, /^workflow_retry_attempts=1$/m);
  assert.match(output, /^workflow_retry_disposition=controller-terminated$/m);
  const readsAfterControllerExit = powerReads;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    powerReads,
    readsAfterControllerExit,
    "the retry controller must clean up its completed power watchdog"
  );
});

test("workflow attempt deadline allows the child to finish cancellation cleanup before hard kill", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-workflow-deadline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "cleanup-runner.mjs");
  const cleanupMarker = path.join(directory, "cleanup-marker");
  const attemptOutputPath = path.join(directory, "attempt-output");
  writeFileSync(
    fixture,
    [
      'import { writeFileSync } from "node:fs";',
      'process.on("SIGTERM", () => {',
      '  writeFileSync(process.env.CLEANUP_MARKER, "sigterm\\n", { flag: "a" });',
      '  setTimeout(() => {',
      '    writeFileSync(process.env.CLEANUP_MARKER, "cleanup-complete\\n", { flag: "a" });',
      '    process.exit(143);',
      '  }, 100);',
      '});',
      'setInterval(() => {}, 1_000);'
    ].join("\n")
  );

  const execution = await executeAutonomousWorkflowAttempt({
    runnerPath: fixture,
    runnerArguments: [],
    attemptOutputPath,
    environment: { ...process.env, CLEANUP_MARKER: cleanupMarker },
    deadlineAt: Date.now() + 1_000,
    now: Date.now,
    onChild: () => {},
    terminationGraceMs: 2_000
  });

  assert.equal(execution.deadlineExpired, true);
  assert.equal(execution.exitCode, 143);
  assert.equal(execution.signal, null);
  assert.equal(readFileSync(cleanupMarker, "utf8"), "sigterm\ncleanup-complete\n");
});

test("workflow retry controller never starts a child with a truncated runner-cleanup window", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-workflow-window-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "must-not-start.mjs");
  const startedMarker = path.join(directory, "started-marker");
  const githubOutput = path.join(directory, "github-output");
  writeFileSync(
    fixture,
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync(process.env.STARTED_MARKER, "started\\n");\n'
  );
  let clockRead = 0;
  const exitCode = await runAutonomousWorkflowRetries({
    runnerArguments: [],
    runnerPath: fixture,
    environment: {
      ...process.env,
      GITHUB_OUTPUT: githubOutput,
      RUNNER_TEMP: directory,
      STARTED_MARKER: startedMarker,
      AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS: "1"
    },
    // The controller starts at zero, but by the first admission check only
    // 330 minutes remain—enough for the old arithmetic, but not the complete
    // 331-minute runner, cleanup, and startup contract.
    now: () => clockRead++ === 0 ? 0 : 15 * 60_000
  });

  assert.equal(exitCode, 1);
  assert.equal(existsSync(startedMarker), false);
  const output = readFileSync(githubOutput, "utf8");
  assert.match(output, /^workflow_retry_attempts=0$/m);
  assert.match(output, /^workflow_retry_disposition=attempt-not-started$/m);
});

test("workflow retry controller forwards only the final isolated attempt outcome", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-workflow-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "successful-runner.mjs");
  const githubOutput = path.join(directory, "github-output");
  writeFileSync(
    fixture,
    [
      'import { appendFileSync } from "node:fs";',
      'appendFileSync(process.env.GITHUB_OUTPUT, [',
      '  "runner_status=refreshed",',
      '  "publication_status=published",',
      '  "failure_message=",',
      `  "published_commit=${"c".repeat(40)}"`,
      '].join("\\n") + "\\n");'
    ].join("\n")
  );

  const exitCode = await runAutonomousWorkflowRetries({
    runnerArguments: [],
    runnerPath: fixture,
    environment: {
      ...process.env,
      GITHUB_OUTPUT: githubOutput,
      RUNNER_TEMP: directory,
      AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS: "1"
    }
  });
  assert.equal(exitCode, 0);
  const output = readFileSync(githubOutput, "utf8");
  assert.equal((output.match(/^runner_status=/gm) ?? []).length, 1);
  assert.match(output, /^runner_status=refreshed$/m);
  assert.match(output, /^workflow_retry_attempts=1$/m);
  assert.match(output, /^workflow_retry_disposition=completed$/m);
});

test("workflow retry controller replays a structured operational database failure", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-workflow-database-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "database-retry-runner.mjs");
  const attemptCounter = path.join(directory, "attempt-counter");
  const githubOutput = path.join(directory, "github-output");
  writeFileSync(
    fixture,
    [
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const attempt = existsSync(process.env.ATTEMPT_COUNTER)',
      '  ? Number(readFileSync(process.env.ATTEMPT_COUNTER, "utf8")) + 1',
      '  : 1;',
      'writeFileSync(process.env.ATTEMPT_COUNTER, String(attempt));',
      'if (attempt === 1) {',
      '  appendFileSync(process.env.GITHUB_OUTPUT, [',
      '    "runner_status=failed",',
      '    "publication_status=",',
      '    "failure_message=Failed to persist fixture rows: deadlock detected",',
      '    "failure_domain=database",',
      '    "failure_code=40P01",',
      '    "published_commit="',
      '  ].join("\\n") + "\\n");',
      '  process.exit(1);',
      '}',
      'appendFileSync(process.env.GITHUB_OUTPUT, [',
      '  "runner_status=refreshed",',
      '  "publication_status=published",',
      '  "failure_message=",',
      '  "failure_domain=",',
      '  "failure_code=",',
      `  "published_commit=${"e".repeat(40)}"`,
      '].join("\\n") + "\\n");'
    ].join("\n")
  );

  const exitCode = await runAutonomousWorkflowRetries({
    runnerArguments: [],
    runnerPath: fixture,
    environment: {
      ...process.env,
      GITHUB_OUTPUT: githubOutput,
      RUNNER_TEMP: directory,
      ATTEMPT_COUNTER: attemptCounter,
      AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS: "2",
      AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS: "1"
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(readFileSync(attemptCounter, "utf8"), "2");
  const output = readFileSync(githubOutput, "utf8");
  assert.equal((output.match(/^runner_status=/gm) ?? []).length, 1);
  assert.match(output, /^runner_status=refreshed$/m);
  assert.match(output, /^failure_domain=$/m);
  assert.match(output, /^workflow_retry_attempts=2$/m);
  assert.match(output, /^workflow_retry_disposition=completed$/m);
});

test("autonomous runner receives optional durability secrets and owns validated publication", () => {
  const hostPreflight = workflow.match(
    /- name: Preflight autonomous ingestion host([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1];
  assert.ok(hostPreflight, "missing autonomous ingestion host preflight");
  assert.match(hostPreflight, /\/usr\/bin\/pmset -g batt/);
  assert.match(hostPreflight, /Runner requires AC power/);
  assert.match(hostPreflight, /\/usr\/bin\/pmset -g assertions/);
  assert.match(hostPreflight, /PreventSystemSleep\[\[:space:\]\]\+1/);
  assert.match(hostPreflight, /if \[ "\$AUTHENTICATED_SOCIAL_REPLAY" = "true" \]/);
  assert.match(hostPreflight, /IOPMUserTriggeredFullWake/);
  assert.match(hostPreflight, /Authenticated replay requires a user wake/);
  assert.doesNotMatch(hostPreflight, /\/usr\/bin\/caffeinate -u/);
  assert.ok(
    workflow.indexOf("- name: Preflight autonomous ingestion host") <
      workflow.indexOf("- name: Preflight authenticated social runner"),
    "power and interactive-wake safety must run before authenticated browser preflight"
  );
  const runnerStep = workflow.match(
    /- name: Run autonomous ingestion([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1];
  assert.ok(runnerStep, "missing autonomous ingestion step");
  assert.match(runnerStep, /id:\s*ingestion/);
  assert.match(runnerStep, /timeout-minutes:\s*380/);
  assert.match(runnerStep, /NODE_OPTIONS:\s*--max-old-space-size=3072/);
  assert.match(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\s*\$\{\{ secrets\.NEXT_PUBLIC_SUPABASE_URL \}\}/);
  assert.match(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.match(runnerStep, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(runnerStep, /X_BEARER_TOKEN:\s*\$\{\{ secrets\.X_BEARER_TOKEN \}\}/);
  assert.match(runnerStep, /EXA_API_KEY:\s*\$\{\{ secrets\.EXA_API_KEY \}\}/);
  assert.doesNotMatch(runnerStep, /REDDIT_(?:CLIENT_ID|CLIENT_SECRET|USER_AGENT)/);
  assert.doesNotMatch(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\?/);
  assert.doesNotMatch(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\?/);
  assert.match(runnerStep, /exec node scripts\/lib\/autonomous-ingestion-workflow-retry\.mjs --/);
  assert.doesNotMatch(runnerStep, /IOPMUserTriggeredFullWake/);
  assert.match(runnerStep, /\/usr\/bin\/pmset -g batt/);
  assert.match(runnerStep, /\/usr\/bin\/pmset -g assertions/);
  assert.match(runnerStep, /\/usr\/bin\/caffeinate -ims -w \$\$/);
  assert.doesNotMatch(runnerStep, /\/usr\/bin\/caffeinate -[^\n]*d[^\n]* -w \$\$/);
  assert.doesNotMatch(runnerStep, /\/usr\/bin\/caffeinate -[^\n]*u[^\n]* -w \$\$/);
  assert.doesNotMatch(runnerStep, /\/usr\/bin\/caffeinate -u/);
  assert.doesNotMatch(runnerStep, /exec node scripts\/run-autonomous-ingestion\.mjs/);
  assert.match(runnerStep, /AUTONOMOUS_WORKFLOW_RETRY_MAX_ATTEMPTS:\s*"6"/);
  assert.match(runnerStep, /AUTONOMOUS_WORKFLOW_RETRY_MAX_ELAPSED_SECONDS:\s*"22200"/);
  assert.match(runnerStep, /AUTONOMOUS_WORKFLOW_RETRY_MIN_REMAINING_SECONDS:\s*"19860"/);
  assert.match(runnerStep, /AUTONOMOUS_WORKFLOW_RETRY_DELAYS_SECONDS:\s*"30,120,300,600,180"/);
  assert.doesNotMatch(runnerStep, /AUTONOMOUS_MIN_BATTERY_PERCENT/);
  assert.match(runnerStep, /AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT:\s*"20"/);
  assert.match(runnerStep, /AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS:\s*"30"/);
  assert.match(runnerStep, /Runner requires AC power/);
  assert.doesNotMatch(runnerStep, /Runner using battery reserve/);
  assert.match(runnerStep, /CAFFEINATE_PID=\$!/);
  assert.match(runnerStep, /pid\[\[:space:\]\]\+\$\{CAFFEINATE_PID\}.*PreventSystemSleep/);
  assert.ok(
    runnerStep.indexOf("/usr/bin/caffeinate -ims -w $$") < runnerStep.indexOf("/usr/bin/pmset -g batt"),
    "wake assertion must be installed before the runner power preflight"
  );
  assert.match(runnerStep, /INGESTION_PUBLICATION_BRANCH:\s*main/);
  assert.match(runnerStep, /CANDIDATE_TRIGGER:\s*\$\{\{ needs\.resolve\.outputs\.trigger \}\}/);
  assert.match(runnerStep, /CANDIDATE_SCHEDULED_AT:\s*\$\{\{ needs\.resolve\.outputs\.scheduled_at \}\}/);
  assert.match(runnerStep, /CANDIDATE_RECOVERY_DEBT:\s*\$\{\{ needs\.resolve\.outputs\.recovery_debt \}\}/);
  const ingestJob = workflow.match(/\n  ingest:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  assert.match(ingestJob, /uses:\s*actions\/checkout@[0-9a-f]{40}\s+# v4[\s\S]*?ref:\s*\$\{\{ needs\.resolve\.outputs\.source_sha \}\}[\s\S]*?fetch-depth:\s*0[\s\S]*?persist-credentials:\s*false/);
  assert.match(ingestJob, /name:\s*Require isolated publication credential/);
  assert.match(ingestJob, /name:\s*Verify publication credential isolation[\s\S]*?if:\s*always\(\)/);
  assert.doesNotMatch(ingestJob, /git config --local http\.https:\/\/github\.com\/\.extraheader/);
  assert.match(ingestJob, /name:\s*Verify repository-backed publication commit/);
  assert.match(ingestJob, /VERIFIED_COMMIT[\s\S]*?REMOTE_MAIN_COMMIT[\s\S]*?git merge-base --is-ancestor/);
  assert.doesNotMatch(ingestJob, /name:\s*Validate generated public artifacts/);
  assert.match(
    workflow,
    /validate_publication:[\s\S]*?uses:\s*\.\/\.github\/workflows\/public-artifacts\.yml[\s\S]*?target_sha:\s*\$\{\{ needs\.ingest\.outputs\.validation_candidate \|\| needs\.resolve\.outputs\.source_sha \}\}/
  );
  const runnerSource = readFileSync(path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs"), "utf8");
  assert.match(runnerSource, /publication_push:\s*\[[\s\S]*?"GIT_CONFIG_VALUE_0"/);
  assert.match(runnerSource, /GIT_CONFIG_KEY_0:\s*"http\.https:\/\/github\.com\/\.extraheader"/);
  assert.match(runnerSource, /GIT_CONFIG_KEY_1:\s*"core\.hooksPath"[\s\S]*?GIT_CONFIG_VALUE_1:\s*"\/dev\/null"/);
  assert.match(runnerSource, /GIT_CONFIG_KEY_2:\s*"credential\.helper"[\s\S]*?GIT_CONFIG_VALUE_2:\s*""/);
  assert.match(runnerSource, /GIT_CONFIG_NOSYSTEM:\s*"1"/);
  assert.match(runnerSource, /GIT_CONFIG_GLOBAL:\s*"\/dev\/null"/);
  assert.match(runnerSource, /GIT_TERMINAL_PROMPT:\s*"0"/);
  assert.match(runnerSource, /envCategory:\s*"publication_push"[\s\S]*?env:\s*publicationPushAuthEnvironment\(\)/);
  const publicationPushFunction = runnerSource.slice(
    runnerSource.indexOf("async function runPublicationPush"),
    runnerSource.indexOf("async function resolveAmbiguousPublicationAfterCancellation")
  );
  assert.doesNotMatch(publicationPushFunction, /git config/);
  const rebaseAndRebuild = runnerSource.slice(
    runnerSource.indexOf('await runCommand("git", ["fetch", "origin", branch]'),
    runnerSource.indexOf("const publishedCommit = latestPublishedCommit")
  );
  assert.doesNotMatch(rebaseAndRebuild, /GIT_CONFIG_(?:COUNT|KEY|VALUE)/);
  assert.doesNotMatch(rebaseAndRebuild, /\.extraheader/);
  const pushIndex = runnerSource.indexOf("await publishRepositoryArtifacts(publicationRunId, publicationInputs)");
  const completionIndex = runnerSource.indexOf('await completeRun("completed"');
  assert.ok(pushIndex > -1 && completionIndex > pushIndex);
  assert.match(runnerSource, /process\.env\.INGESTION_PUBLICATION_BRANCH \?\? "main"/);
  assert.doesNotMatch(runnerSource, /process\.env\.GITHUB_REF_NAME/);
});

test("publication proof fetches cannot use implicit Git credentials", () => {
  for (const [source, stepName] of [
    [workflow, "Verify repository-backed publication commit"],
    [workflow, "Recover exact publication commit"],
    [dailyBenchmarkWorkflow, "Resolve existing daily benchmark slot"],
    [dailyBenchmarkWorkflow, "Commit and publish benchmark snapshots"],
    [dailyBenchmarkWorkflow, "Recover exact benchmark publication commit"]
  ]) {
    const script = workflowStepScript(source, stepName);
    assert.match(script, /GIT_CONFIG_COUNT=2/);
    assert.match(script, /GIT_CONFIG_KEY_0="core\.hooksPath"[\s\S]*?GIT_CONFIG_VALUE_0="\/dev\/null"/);
    assert.match(script, /GIT_CONFIG_KEY_1="credential\.helper"[\s\S]*?GIT_CONFIG_VALUE_1=""/);
    assert.match(script, /GIT_CONFIG_NOSYSTEM=1/);
    assert.match(script, /GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.match(script, /GIT_TERMINAL_PROMPT=0/);
  }
});

test("autonomous recovery selects only exact trailer-and-receipt provenance", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-autonomous-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  const slotKey = "central-2026-08-09-1800";
  const runId = "31338649652";
  const runAttempt = "2";
  const scheduledAt = "2026-08-09T23:00:00.000Z";
  mkdirSync(seed);
  runGit(directory, "init", "--bare", remote);
  runGit(seed, "init");
  runGit(seed, "checkout", "-b", "main");
  runGit(seed, "config", "user.name", "Workflow Test");
  runGit(seed, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(seed, "fixture.txt"), "source\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "source fixture");
  const sourceSha = runGit(seed, "rev-parse", "HEAD");
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  runGit(directory, "clone", remote, checkout);

  writeFileSync(path.join(seed, "fixture.txt"), "spoofed subject\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", `Publish autonomous ingestion ${slotKey}`);
  const subjectSpoofSha = runGit(seed, "rev-parse", "HEAD");
  const receipt = {
    schemaVersion: 1,
    idempotencyKey: slotKey,
    trigger: "schedule",
    scheduledAt
  };
  const trailerSpoofSha = commitPublicationFixture(seed, {
    subject: `Publish autonomous ingestion ${slotKey}`,
    receiptPath: "outputs/ingestion-source-delta-current.json",
    receipt,
    slotKey,
    sourceSha,
    runId,
    runAttempt: "999",
    fixtureValue: "spoofed trailer\n"
  });
  const hashSpoofSha = commitPublicationFixture(seed, {
    subject: `Publish autonomous ingestion ${slotKey}`,
    receiptPath: "outputs/ingestion-source-delta-current.json",
    receipt,
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    receiptHash: "0".repeat(64),
    fixtureValue: "spoofed hash\n"
  });
  const publishedSha = commitPublicationFixture(seed, {
    subject: `Publish autonomous ingestion ${slotKey}`,
    receiptPath: "outputs/ingestion-source-delta-current.json",
    receipt,
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    fixtureValue: "published\n"
  });
  runGit(seed, "push", "origin", "main");

  const script = workflowStepScript(workflow, "Recover exact publication commit");
  const output = path.join(directory, "recovery-output");
  const recovered = runScript(script, checkout, {
    ...FRESH_DAILY_SLOT_ENV,
    VERIFIED_PUBLISHED_COMMIT: "",
    RUNNER_PUBLISHED_COMMIT: "",
    SLOT_KEY: slotKey,
    SOURCE_SHA: sourceSha,
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_AT: scheduledAt,
    WORKFLOW_RUN_ID: runId,
    WORKFLOW_RUN_ATTEMPT: runAttempt,
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: output
  });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const values = readFileSync(output, "utf8");
  assert.match(values, new RegExp(`published_commit=${publishedSha}`));
  assert.match(values, /commit_verified=true/);
  assert.match(values, /recovery_method=trailers/);
  for (const spoof of [subjectSpoofSha, trailerSpoofSha, hashSpoofSha]) {
    assert.doesNotMatch(values, new RegExp(`published_commit=${spoof}`));
  }

  const missing = runScript(script, checkout, {
    ...FRESH_DAILY_SLOT_ENV,
    VERIFIED_PUBLISHED_COMMIT: "",
    RUNNER_PUBLISHED_COMMIT: "",
    SLOT_KEY: "central-2026-08-09-0600",
    SOURCE_SHA: sourceSha,
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_AT: "2026-08-09T11:00:00.000Z",
    WORKFLOW_RUN_ID: runId,
    WORKFLOW_RUN_ATTEMPT: runAttempt,
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: path.join(directory, "missing-output")
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /No exact repository-backed publication commit/);
});

test("autonomous replay accepts one prior run identity and rejects forged or ambiguous provenance", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-autonomous-replay-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  const slotKey = "central-2026-08-09-1800";
  const originalRunId = "31338649652";
  const originalRunAttempt = "1";
  const replayRunAttempt = "2";
  const scheduledAt = "2026-08-09T23:00:00.000Z";
  const receiptPath = "outputs/ingestion-source-delta-current.json";
  const receipt = {
    schemaVersion: 1,
    idempotencyKey: slotKey,
    trigger: "schedule",
    scheduledAt
  };
  const serializedReceipt = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptHash = createHash("sha256").update(serializedReceipt).digest("hex");
  mkdirSync(seed);
  runGit(directory, "init", "--bare", remote);
  runGit(seed, "init");
  runGit(seed, "checkout", "-b", "main");
  runGit(seed, "config", "user.name", "Workflow Test");
  runGit(seed, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(seed, "fixture.txt"), "source\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "source fixture");
  const sourceSha = runGit(seed, "rev-parse", "HEAD");
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const spoofedCommits = [
    commitPublicationFixture(seed, {
      subject: `Publish autonomous ingestion ${slotKey}`,
      receiptPath,
      receipt,
      slotKey: "central-2026-08-09-0600",
      sourceSha,
      runId: originalRunId,
      runAttempt: originalRunAttempt,
      fixtureValue: "spoofed slot\n"
    }),
    commitPublicationFixture(seed, {
      subject: `Publish autonomous ingestion ${slotKey}`,
      receiptPath,
      receipt,
      slotKey,
      sourceSha: "f".repeat(40),
      runId: originalRunId,
      runAttempt: originalRunAttempt,
      fixtureValue: "spoofed source\n"
    }),
    commitPublicationFixture(seed, {
      subject: `Publish autonomous ingestion ${slotKey}`,
      receiptPath,
      receipt,
      slotKey,
      sourceSha,
      runId: originalRunId,
      runAttempt: originalRunAttempt,
      receiptHash: "0".repeat(64),
      fixtureValue: "spoofed hash\n"
    }),
    commitPublicationFixture(seed, {
      subject: `Publish autonomous ingestion ${slotKey}`,
      receiptPath,
      receipt,
      slotKey,
      sourceSha,
      runId: "not-numeric",
      runAttempt: originalRunAttempt,
      fixtureValue: "malformed run id\n"
    }),
    commitPublicationFixture(seed, {
      subject: `Publish autonomous ingestion ${slotKey}`,
      receiptPath,
      receipt,
      slotKey,
      sourceSha,
      runId: originalRunId,
      runAttempt: "not-numeric",
      fixtureValue: "malformed run attempt\n"
    }),
    commitPublicationFixture(seed, {
      subject: `Publish autonomous ingestion ${slotKey}`,
      receiptPath,
      receipt: { ...receipt, idempotencyKey: "central-2026-08-09-0600" },
      slotKey,
      sourceSha,
      runId: originalRunId,
      runAttempt: originalRunAttempt,
      fixtureValue: "spoofed receipt slot\n"
    }),
    commitPublicationFixture(seed, {
      subject: `Publish autonomous ingestion ${slotKey}`,
      receiptPath,
      receipt,
      slotKey,
      sourceSha,
      runId: originalRunId,
      runAttempt: originalRunAttempt,
      fixtureValue: "duplicate trailer set\n",
      additionalTrailers: [
        `Returner-Slot-Key: ${slotKey}`,
        `Returner-Source-SHA: ${sourceSha}`,
        `Returner-Run-ID: ${originalRunId}`,
        `Returner-Run-Attempt: ${originalRunAttempt}`,
        `Returner-Receipt-SHA256: ${receiptHash}`
      ]
    })
  ];
  const priorCommit = commitPublicationFixture(seed, {
    subject: `Publish autonomous ingestion ${slotKey}`,
    receiptPath,
    receipt,
    slotKey,
    sourceSha,
    runId: originalRunId,
    runAttempt: originalRunAttempt,
    fixtureValue: "valid prior publication\n"
  });
  writeFileSync(path.join(seed, "dispatch-source.txt"), "current manual replay source\n");
  runGit(seed, "add", "dispatch-source.txt");
  runGit(seed, "commit", "-m", "advance main to manual replay dispatch source");
  const currentDispatchSha = runGit(seed, "rev-parse", "HEAD");
  runGit(seed, "push", "origin", "main");
  runGit(directory, "clone", remote, checkout);

  const script = workflowStepScript(workflow, "Recover exact publication commit");
  const replayEnvironment = {
    VERIFIED_PUBLISHED_COMMIT: "",
    RUNNER_PUBLISHED_COMMIT: "",
    RUNNER_STATUS: "already_completed",
    RUNNER_PUBLICATION_STATUS: "already_completed",
    SLOT_KEY: slotKey,
    SOURCE_SHA: currentDispatchSha,
    SCHEDULE_TRIGGER: "manual-replay",
    SCHEDULED_AT: "",
    WORKFLOW_RUN_ID: "31340000000",
    WORKFLOW_RUN_ATTEMPT: replayRunAttempt,
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0"
  };
  const output = path.join(directory, "replay-output");
  const recovered = runScript(script, checkout, {
    ...replayEnvironment,
    GITHUB_OUTPUT: output
  });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const values = readFileSync(output, "utf8");
  assert.match(values, new RegExp(`published_commit=${priorCommit}`));
  assert.match(values, new RegExp(`validation_candidate=${priorCommit}`));
  assert.match(values, new RegExp(`publication_run_id=${originalRunId}`));
  assert.match(values, new RegExp(`publication_run_attempt=${originalRunAttempt}`));
  assert.match(values, new RegExp(`publication_source_sha=${sourceSha}`));
  assert.match(values, /publication_trigger=schedule/);
  assert.match(values, new RegExp(`publication_scheduled_at=${scheduledAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(values, /commit_verified=true/);
  assert.match(values, /recovery_method=trailers/);
  for (const spoof of spoofedCommits) {
    assert.doesNotMatch(values, new RegExp(`published_commit=${spoof}`));
  }
  assert.match(
    workflow,
    /validate_publication:[\s\S]*?target_sha:\s*\$\{\{ needs\.ingest\.outputs\.validation_candidate \|\| needs\.resolve\.outputs\.source_sha \}\}[\s\S]*?publication_source_sha:\s*\$\{\{ needs\.ingest\.outputs\.publication_source_sha \|\| needs\.resolve\.outputs\.source_sha \}\}[\s\S]*?publication_run_id:\s*\$\{\{ needs\.ingest\.outputs\.publication_run_id \|\| github\.run_id \}\}[\s\S]*?publication_run_attempt:\s*\$\{\{ needs\.ingest\.outputs\.publication_run_attempt \|\| github\.run_attempt \}\}[\s\S]*?publication_trigger:\s*\$\{\{ needs\.ingest\.outputs\.publication_trigger \|\| needs\.resolve\.outputs\.trigger \}\}[\s\S]*?publication_scheduled_at:\s*\$\{\{ needs\.ingest\.outputs\.publication_scheduled_at \|\| needs\.resolve\.outputs\.scheduled_at \}\}/
  );

  const contradictoryStatus = runScript(script, checkout, {
    ...replayEnvironment,
    RUNNER_PUBLICATION_STATUS: "published",
    GITHUB_OUTPUT: path.join(directory, "contradictory-status-output")
  });
  assert.notEqual(contradictoryStatus.status, 0);
  assert.match(contradictoryStatus.stdout, /requires consistent already_completed/);

  const secondValidCommit = commitPublicationFixture(seed, {
    subject: `Publish autonomous ingestion ${slotKey}`,
    receiptPath,
    receipt,
    slotKey,
    sourceSha,
    runId: "31338649653",
    runAttempt: "1",
    fixtureValue: "second valid prior publication\n"
  });
  runGit(seed, "push", "origin", "main");
  const ambiguous = runScript(script, checkout, {
    ...replayEnvironment,
    VERIFIED_PUBLISHED_COMMIT: secondValidCommit,
    RUNNER_PUBLISHED_COMMIT: secondValidCommit,
    SOURCE_SHA: secondValidCommit,
    GITHUB_OUTPUT: path.join(directory, "ambiguous-output")
  });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stdout, /Publication recovery ambiguous/);
});

test("daily slot reruns adopt one exact prior publication and fail closed on ambiguity", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-daily-slot-idempotency-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  const receiptPath = "outputs/benchmarks/daily-publication-receipt.json";
  const centralDate = "2026-08-09";
  const slotKey = `daily-benchmark-${centralDate}`;
  const scheduledAt = "2026-08-09T05:00:00.000Z";
  const originalRunId = "31338649652";
  const originalRunAttempt = "1";
  mkdirSync(seed);
  runGit(directory, "init", "--bare", remote);
  runGit(seed, "init");
  runGit(seed, "checkout", "-b", "main");
  runGit(seed, "config", "user.name", "Workflow Test");
  runGit(seed, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(seed, "fixture.txt"), "source\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "source fixture");
  const publicationSourceSha = runGit(seed, "rev-parse", "HEAD");
  const receipt = {
    schemaVersion: 1,
    kind: "daily-score-benchmark-publication",
    slotKey,
    sourceSha: publicationSourceSha,
    runId: originalRunId,
    runAttempt: originalRunAttempt,
    trigger: "schedule",
    scheduledUtcHour: "5",
    scheduledAt,
    centralDate
  };
  const publishedCommit = commitPublicationFixture(seed, {
    subject: "Update daily score benchmark snapshots",
    receiptPath,
    receipt,
    slotKey,
    sourceSha: publicationSourceSha,
    runId: originalRunId,
    runAttempt: originalRunAttempt,
    fixtureValue: "published slot\n"
  });
  writeFileSync(path.join(seed, "current.txt"), "newer current source\n");
  runGit(seed, "add", "current.txt");
  runGit(seed, "commit", "-m", "advance current source");
  const currentSourceSha = runGit(seed, "rev-parse", "HEAD");
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  runGit(directory, "clone", remote, checkout);

  const resolveExisting = workflowStepScript(dailyBenchmarkWorkflow, "Resolve existing daily benchmark slot");
  const existingOutput = path.join(directory, "existing-output");
  const existing = runScript(resolveExisting, checkout, {
    SOURCE_SHA: currentSourceSha,
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_UTC_HOUR: "5",
    SCHEDULED_AT: scheduledAt,
    CENTRAL_DATE: centralDate,
    PUBLICATION_BRANCH: "main",
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: existingOutput
  });
  assert.equal(existing.status, 0, `${existing.stdout}\n${existing.stderr}`);
  const existingValues = readFileSync(existingOutput, "utf8");
  assert.match(existingValues, /publication_status=already_completed/);
  assert.match(existingValues, new RegExp(`published_commit=${publishedCommit}`));
  assert.match(existingValues, new RegExp(`publication_source_sha=${publicationSourceSha}`));
  assert.match(existingValues, new RegExp(`publication_run_id=${originalRunId}`));
  assert.match(existingValues, new RegExp(`publication_run_attempt=${originalRunAttempt}`));

  const recover = workflowStepScript(dailyBenchmarkWorkflow, "Recover exact benchmark publication commit");
  const recoveryOutput = path.join(directory, "recovery-output");
  const recovered = runScript(recover, checkout, {
    VERIFIED_PUBLISHED_COMMIT: "",
    PUBLISH_CANDIDATE: "",
    PUBLISH_STATUS: "",
    EXISTING_PUBLICATION_STATUS: "already_completed",
    EXISTING_PUBLISHED_COMMIT: publishedCommit,
    EXISTING_SOURCE_SHA: publicationSourceSha,
    EXISTING_RUN_ID: originalRunId,
    EXISTING_RUN_ATTEMPT: originalRunAttempt,
    EXISTING_TRIGGER: "schedule",
    EXISTING_SCHEDULED_AT: scheduledAt,
    EXISTING_CENTRAL_DATE: centralDate,
    EXISTING_SCHEDULED_UTC_HOUR: "5",
    SOURCE_SHA: currentSourceSha,
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_UTC_HOUR: "5",
    SCHEDULED_AT: scheduledAt,
    CENTRAL_DATE: centralDate,
    WORKFLOW_RUN_ID: "31340000000",
    WORKFLOW_RUN_ATTEMPT: "2",
    PUBLICATION_BRANCH: "main",
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: recoveryOutput
  });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const recoveryValues = readFileSync(recoveryOutput, "utf8");
  assert.match(recoveryValues, /publication_status=already_completed/);
  assert.match(recoveryValues, new RegExp(`published_commit=${publishedCommit}`));
  assert.match(recoveryValues, /recovery_method=existing_slot/);
  assert.match(recoveryValues, new RegExp(`publication_run_id=${originalRunId}`));

  const duplicateRunId = "31349999999";
  const duplicateReceipt = {
    ...receipt,
    sourceSha: currentSourceSha,
    runId: duplicateRunId,
    runAttempt: "1"
  };
  commitPublicationFixture(seed, {
    subject: "Duplicate daily score benchmark slot",
    receiptPath,
    receipt: duplicateReceipt,
    slotKey,
    sourceSha: currentSourceSha,
    runId: duplicateRunId,
    runAttempt: "1",
    fixtureValue: "duplicate slot\n"
  });
  runGit(seed, "push", "origin", "main");
  const ambiguous = runScript(resolveExisting, checkout, {
    SOURCE_SHA: currentSourceSha,
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_UTC_HOUR: "5",
    SCHEDULED_AT: scheduledAt,
    CENTRAL_DATE: centralDate,
    PUBLICATION_BRANCH: "main",
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: path.join(directory, "ambiguous-output")
  });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stdout, /Daily slot resolution ambiguous/);
});

test("daily recovery selects only exact trailer-and-receipt provenance", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-daily-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  const runId = "31338649652";
  const runAttempt = "2";
  const centralDate = "2026-08-09";
  const slotKey = `daily-benchmark-${centralDate}`;
  const scheduledAt = "2026-08-09T05:00:00.000Z";
  mkdirSync(seed);
  runGit(directory, "init", "--bare", remote);
  runGit(seed, "init");
  runGit(seed, "checkout", "-b", "main");
  runGit(seed, "config", "user.name", "Workflow Test");
  runGit(seed, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(seed, "fixture.txt"), "source\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "source fixture");
  const sourceSha = runGit(seed, "rev-parse", "HEAD");
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  runGit(directory, "clone", remote, checkout);

  writeFileSync(path.join(seed, "fixture.txt"), "subject spoof\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "Update daily score benchmark snapshots");
  const subjectSpoofSha = runGit(seed, "rev-parse", "HEAD");
  const receipt = {
    schemaVersion: 1,
    kind: "daily-score-benchmark-publication",
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    trigger: "schedule",
    scheduledUtcHour: "5",
    scheduledAt,
    centralDate
  };
  const hashSpoofSha = commitPublicationFixture(seed, {
    subject: "Update daily score benchmark snapshots",
    receiptPath: "outputs/benchmarks/daily-publication-receipt.json",
    receipt,
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    receiptHash: "f".repeat(64),
    fixtureValue: "hash spoof\n"
  });
  const publishedSha = commitPublicationFixture(seed, {
    subject: "Update daily score benchmark snapshots",
    receiptPath: "outputs/benchmarks/daily-publication-receipt.json",
    receipt,
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    fixtureValue: "published\n"
  });
  runGit(seed, "push", "origin", "main");

  const script = workflowStepScript(
    dailyBenchmarkWorkflow,
    "Recover exact benchmark publication commit"
  );
  const output = path.join(directory, "recovery-output");
  const recovered = runScript(script, checkout, {
    ...FRESH_DAILY_SLOT_ENV,
    VERIFIED_PUBLISHED_COMMIT: "",
    PUBLISH_CANDIDATE: "",
    PUBLISH_STATUS: "",
    SOURCE_SHA: sourceSha,
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_UTC_HOUR: "5",
    SCHEDULED_AT: scheduledAt,
    CENTRAL_DATE: centralDate,
    WORKFLOW_RUN_ID: runId,
    WORKFLOW_RUN_ATTEMPT: runAttempt,
    PUBLICATION_BRANCH: "main",
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: output
  });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  const values = readFileSync(output, "utf8");
  assert.match(values, new RegExp(`published_commit=${publishedSha}`));
  assert.match(values, /publication_status=published/);
  assert.match(values, /recovery_method=trailers/);
  assert.doesNotMatch(values, new RegExp(`published_commit=${subjectSpoofSha}`));
  assert.doesNotMatch(values, new RegExp(`published_commit=${hashSpoofSha}`));

  const missing = runScript(script, checkout, {
    ...FRESH_DAILY_SLOT_ENV,
    VERIFIED_PUBLISHED_COMMIT: "",
    PUBLISH_CANDIDATE: "",
    PUBLISH_STATUS: "",
    SOURCE_SHA: sourceSha,
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULED_UTC_HOUR: "5",
    SCHEDULED_AT: scheduledAt,
    CENTRAL_DATE: centralDate,
    WORKFLOW_RUN_ID: runId,
    WORKFLOW_RUN_ATTEMPT: "999",
    PUBLICATION_BRANCH: "main",
    PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
    GITHUB_OUTPUT: path.join(directory, "missing-output")
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /No exact repository-backed benchmark commit/);
});

test("lost recovery networking is bounded, fails closed, and preserves exact-SHA validation", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-recovery-fetch-loss-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "checkout");
  const bin = path.join(directory, "bin");
  mkdirSync(checkout);
  mkdirSync(bin);
  runGit(checkout, "init");
  runGit(checkout, "config", "user.name", "Workflow Test");
  runGit(checkout, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(checkout, "fixture.txt"), "source\n");
  runGit(checkout, "add", "fixture.txt");
  runGit(checkout, "commit", "-m", "source fixture");
  const sourceSha = runGit(checkout, "rev-parse", "HEAD");
  writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "fetch" ]; then
  count=0
  if [ -f "$FETCH_COUNT_PATH" ]; then count="$(cat "$FETCH_COUNT_PATH")"; fi
  printf '%s\n' "$((count + 1))" > "$FETCH_COUNT_PATH"
  exit 88
fi
exec "$REAL_GIT" "$@"
`
  );
  chmodSync(path.join(bin, "git"), 0o755);

  const cases = [
    {
      name: "autonomous",
      script: workflowStepScript(workflow, "Recover exact publication commit"),
      env: {
        VERIFIED_PUBLISHED_COMMIT: sourceSha,
        RUNNER_PUBLISHED_COMMIT: "",
        SLOT_KEY: "central-2026-08-09-1800",
        SOURCE_SHA: sourceSha,
        SCHEDULE_TRIGGER: "schedule",
        SCHEDULED_AT: "2026-08-09T23:00:00.000Z",
        WORKFLOW_RUN_ID: "31338649652",
        WORKFLOW_RUN_ATTEMPT: "2"
      }
    },
    {
      name: "daily",
      script: workflowStepScript(dailyBenchmarkWorkflow, "Recover exact benchmark publication commit"),
      env: {
        ...FRESH_DAILY_SLOT_ENV,
        VERIFIED_PUBLISHED_COMMIT: sourceSha,
        PUBLISH_CANDIDATE: "",
        PUBLISH_STATUS: "published",
        SOURCE_SHA: sourceSha,
        SCHEDULE_TRIGGER: "schedule",
        SCHEDULED_UTC_HOUR: "5",
        SCHEDULED_AT: "2026-08-09T05:00:00.000Z",
        CENTRAL_DATE: "2026-08-09",
        WORKFLOW_RUN_ID: "31338649652",
        WORKFLOW_RUN_ATTEMPT: "2",
        PUBLICATION_BRANCH: "main"
      }
    }
  ];

  for (const fixture of cases) {
    const fetchCount = path.join(directory, `${fixture.name}-fetch-count`);
    const output = path.join(directory, `${fixture.name}-output`);
    const result = runScript(fixture.script, checkout, {
      ...fixture.env,
      PATH: `${bin}:${process.env.PATH}`,
      REAL_GIT: commandPath("git"),
      FETCH_COUNT_PATH: fetchCount,
      PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
      GITHUB_OUTPUT: output
    });
    assert.notEqual(result.status, 0, `${fixture.name} recovery must fail closed`);
    assert.equal(readFileSync(fetchCount, "utf8").trim(), "4");
    assert.match(readFileSync(output, "utf8"), new RegExp(`validation_candidate=${sourceSha}`));
  }

  for (const fixture of cases) {
    const fetchCount = path.join(directory, `${fixture.name}-unverified-fetch-count`);
    const output = path.join(directory, `${fixture.name}-unverified-output`);
    const unverifiedEnvironment = fixture.name === "autonomous"
      ? {
          ...fixture.env,
          VERIFIED_PUBLISHED_COMMIT: "",
          RUNNER_PUBLISHED_COMMIT: sourceSha
        }
      : {
          ...fixture.env,
          VERIFIED_PUBLISHED_COMMIT: "",
          PUBLISH_CANDIDATE: sourceSha
        };
    const result = runScript(fixture.script, checkout, {
      ...unverifiedEnvironment,
      PATH: `${bin}:${process.env.PATH}`,
      REAL_GIT: commandPath("git"),
      FETCH_COUNT_PATH: fetchCount,
      PUBLICATION_FETCH_RETRY_DELAY_SECONDS: "0",
      GITHUB_OUTPUT: output
    });
    assert.notEqual(result.status, 0, `${fixture.name} unverified recovery must fail closed`);
    assert.equal(readFileSync(fetchCount, "utf8").trim(), "4");
    assert.match(readFileSync(output, "utf8"), /^validation_candidate=$/m);
  }

  assert.match(
    workflow,
    /validate_publication:[\s\S]*?if:\s*\$\{\{ always\(\) && needs\.resolve\.outputs\.should_run == 'true' && needs\.ingest\.outputs\.revalidation_should_run == 'true' \}\}[\s\S]*?target_sha:\s*\$\{\{ needs\.ingest\.outputs\.validation_candidate \|\| needs\.resolve\.outputs\.source_sha \}\}/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /validate_publication:[\s\S]*?if:\s*\$\{\{ always\(\) && needs\.resolve\.outputs\.should_run == 'true' && needs\.update\.outputs\.publication_status != 'already_completed' \}\}[\s\S]*?target_sha:\s*\$\{\{ needs\.update\.outputs\.validation_candidate \|\| needs\.resolve\.outputs\.source_sha \}\}/
  );
  assert.match(
    dailyBenchmarkWorkflow,
    /validate_adopted_release:[\s\S]*?if:\s*\$\{\{ always\(\) && needs\.resolve\.outputs\.should_run == 'true' && needs\.update\.outputs\.publication_status == 'already_completed' \}\}[\s\S]*?target_sha:\s*\$\{\{ needs\.resolve\.outputs\.source_sha \}\}/
  );
});

test("autonomous publication proof requires remote-main reachability without requiring tip equality", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-autonomous-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  mkdirSync(seed);
  runGit(directory, "init", "--bare", remote);
  runGit(seed, "init");
  runGit(seed, "checkout", "-b", "main");
  runGit(seed, "config", "user.name", "Workflow Test");
  runGit(seed, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(seed, "fixture.txt"), "published\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "published fixture");
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  runGit(directory, "clone", remote, checkout);
  const publishedSha = runGit(checkout, "rev-parse", "HEAD");

  writeFileSync(path.join(seed, "fixture.txt"), "authorized human follow-up\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "authorized follow-up");
  runGit(seed, "push", "origin", "main");
  const remoteTip = runGit(seed, "rev-parse", "HEAD");

  const script = workflowStepScript(workflow, "Verify repository-backed publication commit");
  const validOutput = path.join(directory, "valid-output");
  const valid = runScript(script, checkout, {
    RUNNER_PUBLISHED_COMMIT: publishedSha,
    GITHUB_OUTPUT: validOutput
  });
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  const outputs = readFileSync(validOutput, "utf8");
  assert.match(outputs, new RegExp(`published_commit=${publishedSha}`));
  assert.match(outputs, new RegExp(`remote_main_commit=${remoteTip}`));
  assert.match(outputs, /commit_verified=true/);

  runGit(checkout, "config", "user.name", "Workflow Test");
  runGit(checkout, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(checkout, "local-only.txt"), "not published\n");
  runGit(checkout, "add", "local-only.txt");
  runGit(checkout, "commit", "-m", "local only");
  const unpublishedSha = runGit(checkout, "rev-parse", "HEAD");
  const unpublished = runScript(script, checkout, {
    RUNNER_PUBLISHED_COMMIT: unpublishedSha,
    GITHUB_OUTPUT: path.join(directory, "unpublished-output")
  });
  assert.equal(unpublished.status, 1);
  assert.match(unpublished.stdout, /is not reachable from remote main/);

  const fabricated = runScript(script, checkout, {
    RUNNER_PUBLISHED_COMMIT: "f".repeat(40),
    GITHUB_OUTPUT: path.join(directory, "fabricated-output")
  });
  assert.notEqual(fabricated.status, 0);
  assert.match(fabricated.stderr, /unknown revision|Not a valid object name|Not a valid commit name/);
});

test("daily publication proof accepts an exact published ancestor but rejects a local-only commit", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-daily-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  mkdirSync(seed);
  runGit(directory, "init", "--bare", remote);
  runGit(seed, "init");
  runGit(seed, "checkout", "-b", "main");
  runGit(seed, "config", "user.name", "Workflow Test");
  runGit(seed, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(seed, "fixture.txt"), "published\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "published fixture");
  runGit(seed, "remote", "add", "origin", remote);
  runGit(seed, "push", "-u", "origin", "main");
  runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  runGit(directory, "clone", remote, checkout);
  const publishedSha = runGit(checkout, "rev-parse", "HEAD");

  writeFileSync(path.join(seed, "fixture.txt"), "authorized human follow-up\n");
  runGit(seed, "add", "fixture.txt");
  runGit(seed, "commit", "-m", "authorized follow-up");
  runGit(seed, "push", "origin", "main");
  const remoteTip = runGit(seed, "rev-parse", "HEAD");

  const publishScript = workflowStepScript(
    dailyBenchmarkWorkflow,
    "Commit and publish benchmark snapshots"
  );
  const verificationMarker = 'PUBLISHED_COMMIT="$(git rev-parse HEAD)"';
  const verificationIndex = publishScript.indexOf(verificationMarker);
  assert.ok(verificationIndex >= 0, "missing daily post-push verification script");
  const verificationScript = `fetch_publication_branch() { git fetch "$@"; }\n${publishScript.slice(verificationIndex)}`;
  const validOutput = path.join(directory, "valid-output");
  const valid = runScript(verificationScript, checkout, {
    PUBLICATION_BRANCH: "main",
    GITHUB_OUTPUT: validOutput
  });
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  const outputs = readFileSync(validOutput, "utf8");
  assert.match(outputs, new RegExp(`published_commit=${publishedSha}`));
  assert.match(outputs, new RegExp(`remote_main_commit=${remoteTip}`));
  assert.match(outputs, /commit_verified=true/);

  runGit(checkout, "config", "user.name", "Workflow Test");
  runGit(checkout, "config", "user.email", "workflow@example.com");
  writeFileSync(path.join(checkout, "local-only.txt"), "not published\n");
  runGit(checkout, "add", "local-only.txt");
  runGit(checkout, "commit", "-m", "local only");
  const unpublished = runScript(verificationScript, checkout, {
    PUBLICATION_BRANCH: "main",
    GITHUB_OUTPUT: path.join(directory, "unpublished-output")
  });
  assert.equal(unpublished.status, 1);
  assert.match(unpublished.stdout, /is not reachable from remote main/);
});

test("workflow step budgets leave setup and scheduling headroom", () => {
  const jobTimeout = Number(workflow.match(/\n  ingest:[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const installTimeout = Number(workflow.match(/- name: Install dependencies[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const runnerTimeout = Number(workflow.match(/- name: Run autonomous ingestion[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);

  assert.equal(jobTimeout, 415);
  assert.equal(installTimeout, 5);
  assert.equal(runnerTimeout, 380);
  assert.ok(runnerTimeout < jobTimeout);
  assert.ok(installTimeout + runnerTimeout < jobTimeout);
  assert.ok(
    jobTimeout - installTimeout - runnerTimeout >= 25,
    "checkout, setup-node, receipt, and post steps require explicit job-level headroom"
  );
  assert.ok(maxAutonomousRunnerProcessBudgetMs() < runnerTimeout * 60_000);
  assert.equal(
    AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS + AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS,
    AUTONOMOUS_WORKFLOW_ATTEMPT_ALLOWANCE_MS,
    "every child attempt must retain its complete runner and cleanup allowance"
  );
  assert.ok(
    22_200_000 + AUTONOMOUS_WORKFLOW_CHILD_TERMINATION_GRACE_MS < runnerTimeout * 60_000,
    "the controller deadline and safe child signal grace must leave step-finalization headroom"
  );
  assert.ok(maxAutonomousRunnerProcessBudgetMs() < AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS);
  assert.ok(
    installTimeout * 60_000 + maxAutonomousRunnerProcessBudgetMs() <
      jobTimeout * 60_000
  );
});

test("daily derived-artifact steps use the bounded Node heap", () => {
  for (const stepName of [
    "Update daily benchmark snapshots",
    "Rebuild timeline artifacts",
    "Rebuild graph-derived artifacts",
    "Refresh artifact manifest",
    "Validate generated public artifacts"
  ]) {
    const step = dailyBenchmarkWorkflow.match(
      new RegExp(`- name: ${stepName}[\\s\\S]*?(?=\\n\\s{6}- name:|$)`)
    )?.[0] ?? "";
    assert.match(step, /env:\s+NODE_OPTIONS: --max-old-space-size=3072/);
  }
  const buildStep = dailyBenchmarkWorkflow.match(
    /- name: Build app[\s\S]*?(?=\n\s{6}- name:|$)/
  )?.[0] ?? "";
  assert.match(buildStep, /env:\s+NODE_OPTIONS: --max-old-space-size=1536/);
  const benchmarkTestStep = dailyBenchmarkWorkflow.match(
    /- name: Test daily benchmark updater[\s\S]*?(?=\n\s{6}- name:|$)/
  )?.[0] ?? "";
  assert.match(benchmarkTestStep, /env:\s+NODE_OPTIONS: --max-old-space-size=2304/);
});

test("workflow routes authenticated ingestion to the dedicated Mac runner", () => {
  const ingestJob = workflow.match(/\n  ingest:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  assert.match(
    ingestJob,
    /runs-on:\s*\[self-hosted,\s*macOS,\s*ARM64,\s*returner-social,\s*returner-auth-browser\]/
  );
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.match(
    workflow,
    /LINKEDIN_GLOBAL_LOCK_NAMESPACE:\s*returner-fund-production-linkedin-allen-xu-v1/
  );
  assert.match(workflow, /authenticated_backfill:[\s\S]*?type:\s*boolean/);
  assert.match(ingestJob, /--authenticated-social-replay="\$AUTHENTICATED_SOCIAL_REPLAY"/);
  const preflightIndex = ingestJob.indexOf("Preflight authenticated social runner");
  const ingestionIndex = ingestJob.indexOf("Run autonomous ingestion");
  assert.ok(preflightIndex >= 0, "authenticated runner preflight is required");
  assert.ok(preflightIndex < ingestionIndex, "preflight must run before collection");
  assert.match(
    ingestJob,
    /name: Preflight authenticated social runner[\s\S]*?if: steps\.revalidate\.outputs\.should_run == 'true' && needs\.resolve\.outputs\.trigger == 'manual-replay' && inputs\.authenticated_backfill == true[\s\S]*?timeout-minutes:\s*20[\s\S]*?node scripts\/verify-authenticated-social-runner\.mjs/
  );
  assert.doesNotMatch(
    ingestJob.match(/name: Preflight authenticated social runner[\s\S]*?(?=\n\s{6}- name:|$)/)?.[0] ?? "",
    /SUPABASE|X_BEARER|EXA_API|GITHUB_TOKEN/
  );
});

test("inactive candidates and accepted publication outcomes have distinct auditable receipts", () => {
  assert.match(workflow, /name:\s*Resolve Central slot candidate/);
  assert.match(workflow, /name:\s*Publish accepted slot \$\{\{ needs\.resolve\.outputs\.slot_key \}\}/);
  assert.match(workflow, /STATUS="inactive_candidate_no_refresh"/);
  assert.match(workflow, /STATUS="queued_candidate_noop"/);
  assert.match(workflow, /STATUS="accepted_slot_failed"/);
  assert.match(workflow, /node scripts\/lib\/autonomous-ingestion-receipt-policy\.mjs/);
  assert.match(workflow, /receipt_conclusion:\s*\$\{\{ steps\.publication_receipt\.outputs\.receipt_conclusion \}\}/);
  assert.match(workflow, /RECEIPT_CONCLUSION:\s*\$\{\{ needs\.ingest\.outputs\.receipt_conclusion \}\}/);
  assert.match(workflow, /DAILY_NEW_PHYSICAL_SOURCES/);
  assert.match(workflow, /DAILY_SOURCE_HEALTH/);
  assert.match(workflow, /RUNNER_STATUS:\s*\$\{\{ steps\.ingestion\.outputs\.runner_status \}\}/);
  assert.match(workflow, /PUBLISHED_COMMIT:\s*\$\{\{ steps\.ingestion\.outputs\.published_commit \}\}/);
  assert.match(workflow, /Receipt conclusion:/);
  assert.match(workflow, /if \[ "\$STATUS" = "resolver_failed" \] \|\| \[ "\$STATUS" = "accepted_slot_failed" \]/);
  assert.match(workflow, /accepted slot requires a successful publication job/i);
  assert.match(workflow, /exit 1/);
  assert.match(workflow, /runner_failure_message:\s*\$\{\{ steps\.ingestion\.outputs\.failure_message \}\}/);
  assert.match(workflow, /PROVIDER_BLOCKED:\s*\$\{\{ steps\.ingestion\.outputs\.provider_blocked \}\}/);
  assert.match(workflow, /PROVIDER_BLOCKED_BY_REASON:\s*\$\{\{ steps\.ingestion\.outputs\.provider_blocked_by_reason \}\}/);
  assert.match(workflow, /MAPPED_PROVIDER_BLOCKED:\s*\$\{\{ steps\.ingestion\.outputs\.mapped_provider_blocked \}\}/);
  assert.match(workflow, /MAPPED_SCOPE_UNSUPPORTED:\s*\$\{\{ steps\.ingestion\.outputs\.mapped_scope_unsupported \}\}/);
  assert.match(workflow, /MAPPED_FAILURES:\s*\$\{\{ steps\.ingestion\.outputs\.mapped_failed \}\}/);
  assert.match(workflow, /name:\s*Materialize autonomous ingestion receipt[\s\S]*?if:\s*always\(\)/);
  assert.match(workflow, /name:\s*Audit machine-readable autonomous ingestion receipt[\s\S]*?if:\s*always\(\)/);
  assert.match(workflow, /name:\s*Upload autonomous ingestion receipt[\s\S]*?if:\s*always\(\)/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /executed_sha:\s*\$\{\{ steps\.checkout_state\.outputs\.executed_sha \}\}/);
  assert.match(workflow, /triggerSha:\s*process\.env\.TRIGGER_SHA/);
  assert.match(workflow, /sourceSha:\s*optional\(process\.env\.SOURCE_SHA\)/);
  assert.match(workflow, /executedSha:\s*optional\(process\.env\.EXECUTED_SHA\)/);
  assert.match(workflow, /publishedCommit:\s*optional\(process\.env\.PUBLISHED_COMMIT\)/);
  assert.match(workflow, /runnerPublishedCommit:\s*optional\(process\.env\.RUNNER_PUBLISHED_COMMIT\)/);
  assert.match(workflow, /providerBlocked:\s*integerOrNull\(process\.env\.PROVIDER_BLOCKED\)/);
  assert.match(workflow, /providerBlockedByReason:\s*countMap\(process\.env\.PROVIDER_BLOCKED_BY_REASON\)/);
  assert.match(workflow, /mappedProviderBlocked:\s*integerOrNull\(process\.env\.MAPPED_PROVIDER_BLOCKED\)/);
  assert.match(workflow, /mappedProviderBlockedByReason:\s*countMap\(process\.env\.MAPPED_PROVIDER_BLOCKED_BY_REASON\)/);
  assert.match(workflow, /validate_publication:[\s\S]*?uses:\s*\.\/\.github\/workflows\/public-artifacts\.yml[\s\S]*?target_sha:\s*\$\{\{ needs\.ingest\.outputs\.validation_candidate \|\| needs\.resolve\.outputs\.source_sha \}\}[\s\S]*?policy_source_sha:\s*\$\{\{ needs\.resolve\.outputs\.source_sha \}\}/);
  assert.match(workflow, /validate_publication:[\s\S]*?if:\s*\$\{\{ always\(\) && needs\.resolve\.outputs\.should_run == 'true' && needs\.ingest\.outputs\.revalidation_should_run == 'true' \}\}/);
  assert.match(workflow, /publication_kind:\s*autonomous-ingestion/);
  assert.match(workflow, /publication_receipt_path:\s*outputs\/ingestion-source-delta-current\.json/);
  assert.match(workflow, /name:\s*Recover exact publication commit[\s\S]*?if:\s*\$\{\{ always\(\) && steps\.revalidate\.outputs\.should_run == 'true' \}\}/);
  assert.match(workflow, /published_commit:\s*\$\{\{ steps\.recover_publication\.outputs\.published_commit \}\}/);
  assert.match(workflow, /needs:\s*\[resolve, ingest, validate_publication\]/);
  assert.match(workflow, /VALIDATION_RESULT:\s*\$\{\{ needs\.validate_publication\.result \}\}/);
  assert.match(workflow, /COMMIT_REPOSITORY_VERIFIED:\s*\$\{\{ needs\.ingest\.outputs\.commit_verified \}\}/);
  assert.match(workflow, /autonomous-ingestion-receipt-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/autonomous-ingestion-receipt\/receipt\.json/);
  const receiptSteps = workflow.slice(workflow.indexOf("- name: Materialize autonomous ingestion receipt"));
  assert.doesNotMatch(receiptSteps, /continue-on-error/);
  assert.match(workflow, /::warning title=Autonomous ingestion completed with warnings/);
  assert.doesNotMatch(workflow, /Autonomous ingestion health gate failed/);
  for (const warningStatus of [
    "published_degraded",
    "published_no_new_sources",
    "published_stale_day",
    "no_changes_stale_day",
    "noop_degraded",
    "noop_no_new_sources",
    "noop_stale_day"
  ]) assert.ok(receiptPolicy.includes(`"${warningStatus}"`));
  for (const failureStatus of [
    "noop_missing_receipt"
  ]) assert.ok(receiptPolicy.includes(`"${failureStatus}"`));
});

test("autonomous receipt audits publication, inactive, queued no-op, and failure outcomes", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "returner-autonomous-receipts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const materialize = workflowStepScript(workflow, "Materialize autonomous ingestion receipt");
  const audit = workflowStepScript(workflow, "Audit machine-readable autonomous ingestion receipt");
  const runId = "31338649652";
  const runAttempt = "2";
  const base = {
    AUDIT_STATUS: "published",
    SHOULD_RUN: "true",
    SLOT_KEY: "central-2026-08-09-1800",
    SCHEDULE_TRIGGER: "schedule",
    SCHEDULE_REASON: "retry-publication-watermark",
    SCHEDULED_AT: "2026-08-09T23:00:00Z",
    RESOLVE_RESULT: "success",
    INGEST_RESULT: "success",
    VALIDATION_RESULT: "success",
    RUNNER_STATUS: "completed",
    RUNNER_FAILURE_MESSAGE: "",
    PUBLICATION_STATUS: "published",
    COLLECTION_HEALTH: "healthy",
    COLLECTION_HEALTH_REASONS: "",
    NEW_PHYSICAL_SOURCES: "12",
    DAILY_NEW_PHYSICAL_SOURCES: "12",
    DAILY_SOURCE_HEALTH: "healthy",
    PROVIDER_BLOCKED: "1",
    PROVIDER_BLOCKED_BY_REASON: JSON.stringify({ rate_limit: 1 }),
    MAPPED_PROVIDER_BLOCKED: "1",
    MAPPED_PROVIDER_BLOCKED_BY_REASON: JSON.stringify({ rate_limit: 1 }),
    MAPPED_SCOPE_UNSUPPORTED: "0",
    MAPPED_EXPECTED: "50",
    MAPPED_FAILED: "0",
    MAPPED_NONTERMINAL: "0",
    TERMINAL_FAILURE_BUDGET: "3",
    RECEIPT_STATUS: "published",
    RECEIPT_CONCLUSION: "success",
    RECEIPT_RECOGNIZED: "true",
    COMMIT_PROOF_VALID: "true",
    COMMIT_REPOSITORY_VERIFIED: "true",
    RECOVERY_METHOD: "runner_output",
    REMOTE_MAIN_COMMIT: FULL_COMMIT_SHA,
    PUBLISHED_COMMIT: FULL_COMMIT_SHA,
    RUNNER_PUBLISHED_COMMIT: FULL_COMMIT_SHA,
    RUN_ID: runId,
    RUN_ATTEMPT: runAttempt,
    TRIGGER_SHA: FULL_COMMIT_SHA,
    SOURCE_SHA: FULL_COMMIT_SHA,
    EXECUTED_SHA: FULL_COMMIT_SHA,
    REVALIDATION_SHOULD_RUN: "true",
    REVALIDATION_REASON: "revalidated-publication-watermark",
    REVALIDATION_WATERMARK_STATUS: "behind",
    REVALIDATION_PUBLICATION_WATERMARK: "2026-08-09T22:00:00Z",
    REVALIDATION_LATEST_SLOT_KEY: "central-2026-08-09-1800",
    EVENT_NAME: "schedule",
    WORKFLOW_NAME: "Autonomous Ingestion",
    REPOSITORY: "allenbuild/returner-fund",
    ACTOR: "github-actions[bot]",
    REF: "refs/heads/main",
    RUN_URL: `https://github.com/allenbuild/returner-fund/actions/runs/${runId}`
  };
  const scenarios = [
    { name: "success", overrides: {} },
    {
      name: "warning",
      overrides: {
        AUDIT_STATUS: "published_degraded",
        COLLECTION_HEALTH: "degraded",
        COLLECTION_HEALTH_REASONS: "provider_blocked",
        RECEIPT_STATUS: "published_degraded",
        RECEIPT_CONCLUSION: "warning"
      }
    },
    {
      name: "inactive",
      overrides: {
        AUDIT_STATUS: "inactive_candidate_no_refresh",
        SHOULD_RUN: "false",
        SLOT_KEY: "",
        SCHEDULED_AT: "",
        INGEST_RESULT: "skipped",
        VALIDATION_RESULT: "skipped",
        RUNNER_STATUS: "",
        PUBLICATION_STATUS: "",
        COLLECTION_HEALTH: "",
        NEW_PHYSICAL_SOURCES: "",
        DAILY_NEW_PHYSICAL_SOURCES: "",
        DAILY_SOURCE_HEALTH: "",
        PROVIDER_BLOCKED: "",
        MAPPED_PROVIDER_BLOCKED: "",
        MAPPED_SCOPE_UNSUPPORTED: "",
        MAPPED_EXPECTED: "",
        MAPPED_FAILED: "",
        MAPPED_NONTERMINAL: "",
        TERMINAL_FAILURE_BUDGET: "",
        RECEIPT_STATUS: "",
        RECEIPT_CONCLUSION: "",
        RECEIPT_RECOGNIZED: "false",
        COMMIT_PROOF_VALID: "false",
        COMMIT_REPOSITORY_VERIFIED: "false",
        RECOVERY_METHOD: "",
        REMOTE_MAIN_COMMIT: "",
        PUBLISHED_COMMIT: "",
        RUNNER_PUBLISHED_COMMIT: "",
        EXECUTED_SHA: "",
        REVALIDATION_SHOULD_RUN: "",
        REVALIDATION_REASON: "",
        REVALIDATION_WATERMARK_STATUS: "",
        REVALIDATION_PUBLICATION_WATERMARK: "",
        REVALIDATION_LATEST_SLOT_KEY: ""
      }
    },
    {
      name: "resolver-failure",
      overrides: {
        AUDIT_STATUS: "resolver_failed",
        SHOULD_RUN: "",
        SLOT_KEY: "",
        SCHEDULE_TRIGGER: "",
        SCHEDULE_REASON: "",
        SCHEDULED_AT: "",
        RESOLVE_RESULT: "failure",
        INGEST_RESULT: "skipped",
        VALIDATION_RESULT: "skipped",
        RUNNER_STATUS: "",
        PUBLICATION_STATUS: "",
        RECEIPT_STATUS: "",
        RECEIPT_CONCLUSION: "",
        RECEIPT_RECOGNIZED: "false",
        COMMIT_PROOF_VALID: "false",
        COMMIT_REPOSITORY_VERIFIED: "false",
        RECOVERY_METHOD: "",
        REMOTE_MAIN_COMMIT: "",
        PUBLISHED_COMMIT: "",
        RUNNER_PUBLISHED_COMMIT: "",
        EXECUTED_SHA: "",
        REVALIDATION_SHOULD_RUN: "",
        REVALIDATION_REASON: "",
        REVALIDATION_WATERMARK_STATUS: "",
        REVALIDATION_PUBLICATION_WATERMARK: "",
        REVALIDATION_LATEST_SLOT_KEY: ""
      }
    },
    {
      name: "queued-candidate-noop",
      overrides: {
        AUDIT_STATUS: "queued_candidate_noop",
        INGEST_RESULT: "success",
        VALIDATION_RESULT: "skipped",
        RUNNER_STATUS: "",
        PUBLICATION_STATUS: "",
        RECEIPT_STATUS: "",
        RECEIPT_CONCLUSION: "",
        RECEIPT_RECOGNIZED: "false",
        COMMIT_PROOF_VALID: "false",
        COMMIT_REPOSITORY_VERIFIED: "false",
        RECOVERY_METHOD: "",
        PUBLISHED_COMMIT: "",
        RUNNER_PUBLISHED_COMMIT: "",
        REVALIDATION_SHOULD_RUN: "false",
        REVALIDATION_REASON: "queued-publication-watermark-current",
        REVALIDATION_WATERMARK_STATUS: "current",
        REVALIDATION_PUBLICATION_WATERMARK: "2026-08-09T23:01:00Z"
      }
    },
    {
      name: "accepted-failure-after-push",
      overrides: {
        AUDIT_STATUS: "accepted_slot_failed",
        INGEST_RESULT: "failure",
        VALIDATION_RESULT: "success",
        RUNNER_STATUS: "failed",
        RUNNER_FAILURE_MESSAGE: "post-publication receipt failed",
        RECEIPT_STATUS: "",
        RECEIPT_CONCLUSION: "",
        RECEIPT_RECOGNIZED: "false",
        RECOVERY_METHOD: "trailers"
      }
    },
    {
      name: "accepted-failure-before-publication",
      overrides: {
        AUDIT_STATUS: "accepted_slot_failed",
        INGEST_RESULT: "failure",
        VALIDATION_RESULT: "failure",
        RUNNER_STATUS: "failed",
        RUNNER_FAILURE_MESSAGE: "topic facet regeneration timed out",
        RECEIPT_STATUS: "",
        RECEIPT_CONCLUSION: "",
        RECEIPT_RECOGNIZED: "false",
        COMMIT_PROOF_VALID: "false",
        COMMIT_REPOSITORY_VERIFIED: "false",
        RECOVERY_METHOD: "none",
        REMOTE_MAIN_COMMIT: FULL_COMMIT_SHA,
        PUBLISHED_COMMIT: "",
        RUNNER_PUBLISHED_COMMIT: ""
      }
    }
  ];

  for (const scenario of scenarios) {
    const receiptRoot = path.join(directory, scenario.name);
    mkdirSync(receiptRoot);
    const env = { ...base, ...scenario.overrides, RUNNER_TEMP: receiptRoot };
    const materialized = runScript(materialize, repositoryRoot, env);
    assert.equal(
      materialized.status,
      0,
      `${scenario.name}: ${materialized.stdout}\n${materialized.stderr}`
    );
    const receiptPath = path.join(receiptRoot, "autonomous-ingestion-receipt", "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.status, env.AUDIT_STATUS);
    assert.equal(receipt.triggerSha, FULL_COMMIT_SHA);
    assert.equal(receipt.run.id, runId);
    const audited = runScript(audit, repositoryRoot, {
      RUNNER_TEMP: receiptRoot,
      EXPECTED_TRIGGER_SHA: FULL_COMMIT_SHA,
      EXPECTED_RUN_ID: runId,
      EXPECTED_RUN_ATTEMPT: runAttempt
    });
    assert.equal(audited.status, 0, `${scenario.name}: ${audited.stdout}\n${audited.stderr}`);
  }

  const acceptedFailureRoot = path.join(directory, "accepted-failure-after-push");
  const acceptedFailurePath = path.join(acceptedFailureRoot, "autonomous-ingestion-receipt", "receipt.json");
  const acceptedFailure = JSON.parse(readFileSync(acceptedFailurePath, "utf8"));
  const contradictions = [
    ["failed resolver", (value) => { value.resolveResult = "failure"; }],
    ["invalid slot", (value) => { value.slotKey = "invalid slot key"; }],
    ["scheduled trigger with manual event", (value) => { value.run.eventName = "workflow_dispatch"; }],
    ["slot contradicts scheduled instant", (value) => { value.slotKey = "central-2026-08-09-0600"; }],
    ["missing source", (value) => { value.sourceSha = null; }],
    ["invalid scheduled date", (value) => { value.scheduledAt = "2026-02-31T23:00:00Z"; }]
  ];
  for (const [name, mutate] of contradictions) {
    const corrupted = JSON.parse(JSON.stringify(acceptedFailure));
    mutate(corrupted);
    writeFileSync(acceptedFailurePath, `${JSON.stringify(corrupted, null, 2)}\n`);
    const audited = runScript(audit, repositoryRoot, {
      RUNNER_TEMP: acceptedFailureRoot,
      EXPECTED_TRIGGER_SHA: FULL_COMMIT_SHA,
      EXPECTED_RUN_ID: runId,
      EXPECTED_RUN_ATTEMPT: runAttempt
    });
    assert.notEqual(audited.status, 0, `${name}: contradictory accepted failure must fail`);
  }

  const acceptedFailureBeforePublicationRoot = path.join(directory, "accepted-failure-before-publication");
  const acceptedFailureBeforePublicationPath = path.join(
    acceptedFailureBeforePublicationRoot,
    "autonomous-ingestion-receipt",
    "receipt.json"
  );
  const contradictoryBeforePublication = JSON.parse(
    readFileSync(acceptedFailureBeforePublicationPath, "utf8")
  );
  contradictoryBeforePublication.commitRepositoryVerified = true;
  contradictoryBeforePublication.commitProofValid = true;
  contradictoryBeforePublication.publishedCommit = FULL_COMMIT_SHA;
  writeFileSync(
    acceptedFailureBeforePublicationPath,
    `${JSON.stringify(contradictoryBeforePublication, null, 2)}\n`
  );
  const contradictoryBeforePublicationAudit = runScript(audit, repositoryRoot, {
    RUNNER_TEMP: acceptedFailureBeforePublicationRoot,
    EXPECTED_TRIGGER_SHA: FULL_COMMIT_SHA,
    EXPECTED_RUN_ID: runId,
    EXPECTED_RUN_ATTEMPT: runAttempt
  });
  assert.notEqual(
    contradictoryBeforePublicationAudit.status,
    0,
    "accepted failure before publication cannot claim verified publication with recoveryMethod none"
  );

  const successRoot = path.join(directory, "success");
  const successPath = path.join(successRoot, "autonomous-ingestion-receipt", "receipt.json");
  const falseFailure = JSON.parse(readFileSync(successPath, "utf8"));
  falseFailure.status = "accepted_slot_failed";
  writeFileSync(successPath, `${JSON.stringify(falseFailure, null, 2)}\n`);
  const falseFailureAudit = runScript(audit, repositoryRoot, {
    RUNNER_TEMP: successRoot,
    EXPECTED_TRIGGER_SHA: FULL_COMMIT_SHA,
    EXPECTED_RUN_ID: runId,
    EXPECTED_RUN_ATTEMPT: runAttempt
  });
  assert.notEqual(falseFailureAudit.status, 0, "accepted failure with every publication invariant successful must fail");
});

test("autonomous audit fails closed for every accepted job without a recognized commit-backed receipt", () => {
  const script = workflowStepScript(workflow, "Record auditable slot outcome");
  const base = {
    SHOULD_RUN: "true",
    SLOT_KEY: "central-2026-08-09-1800",
    RESOLVE_RESULT: "success",
    INGEST_RESULT: "success",
    VALIDATION_RESULT: "success",
    RECEIPT_STATUS: "published",
    RECEIPT_CONCLUSION: "success",
    PUBLISHED_COMMIT: FULL_COMMIT_SHA,
    COMMIT_REPOSITORY_VERIFIED: "true",
    TRIGGER_SHA: FULL_COMMIT_SHA,
    SOURCE_SHA: FULL_COMMIT_SHA,
    EXECUTED_SHA: FULL_COMMIT_SHA
  };

  for (const ingestResult of ["skipped", "cancelled", "failure"]) {
    const result = runAuditScript(script, { ...base, INGEST_RESULT: ingestResult });
    assert.equal(result.status, 1, `${ingestResult}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /accepted_slot_failed/);
  }

  for (const overrides of [
    { PUBLISHED_COMMIT: "" },
    { PUBLISHED_COMMIT: "c5506de" },
    { COMMIT_REPOSITORY_VERIFIED: "false" },
    { VALIDATION_RESULT: "failure" },
    { VALIDATION_RESULT: "cancelled" },
    { VALIDATION_RESULT: "skipped" },
    { RECEIPT_STATUS: "invented_warning", RECEIPT_CONCLUSION: "warning" },
    { RECEIPT_STATUS: "published", RECEIPT_CONCLUSION: "failure" }
  ]) {
    const result = runAuditScript(script, { ...base, ...overrides });
    assert.equal(result.status, 1, `${JSON.stringify(overrides)}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /accepted_slot_failed/);
  }

  const valid = runAuditScript(script, base);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Autonomous ingestion outcome::published/);

  const inactive = runAuditScript(script, {
    ...base,
    SHOULD_RUN: "false",
    INGEST_RESULT: "skipped",
    RECEIPT_STATUS: "",
    RECEIPT_CONCLUSION: "",
    PUBLISHED_COMMIT: ""
  });
  assert.equal(inactive.status, 0, inactive.stderr);
  assert.match(inactive.stdout, /inactive_candidate_no_refresh/);

  for (const shouldRun of ["", "TRUE", "yes"]) {
    const malformed = runAuditScript(script, {
      ...base,
      SHOULD_RUN: shouldRun,
      INGEST_RESULT: "skipped",
      VALIDATION_RESULT: "skipped",
      RECEIPT_STATUS: "",
      RECEIPT_CONCLUSION: "",
      PUBLISHED_COMMIT: ""
    });
    assert.equal(malformed.status, 1, `${shouldRun}: ${malformed.stdout}\n${malformed.stderr}`);
    assert.match(malformed.stdout, /resolver_failed/);
    assert.doesNotMatch(malformed.stdout, /inactive_candidate_no_refresh/);
  }
});

test("daily benchmark audit fails closed for accepted jobs without exact publication proof", () => {
  const script = workflowStepScript(dailyBenchmarkWorkflow, "Record auditable benchmark outcome");
  const base = {
    SHOULD_RUN: "true",
    RESOLVE_RESULT: "success",
    UPDATE_RESULT: "success",
    VALIDATION_RESULT: "success",
    PUBLICATION_STATUS: "published",
    PUBLISHED_COMMIT: FULL_COMMIT_SHA,
    COMMIT_REPOSITORY_VERIFIED: "true",
    TRIGGER_SHA: FULL_COMMIT_SHA,
    SOURCE_SHA: FULL_COMMIT_SHA,
    EXECUTED_SHA: FULL_COMMIT_SHA,
    CENTRAL_DATE: "2026-08-09"
  };

  for (const updateResult of ["skipped", "cancelled", "failure"]) {
    const result = runAuditScript(script, { ...base, UPDATE_RESULT: updateResult });
    assert.equal(result.status, 1, `${updateResult}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /accepted_candidate_failed/);
  }

  for (const overrides of [
    { PUBLISHED_COMMIT: "" },
    { PUBLISHED_COMMIT: "c5506de" },
    { COMMIT_REPOSITORY_VERIFIED: "false" },
    { VALIDATION_RESULT: "failure" },
    { VALIDATION_RESULT: "cancelled" },
    { VALIDATION_RESULT: "skipped" },
    { PUBLICATION_STATUS: "invented_warning" }
  ]) {
    const result = runAuditScript(script, { ...base, ...overrides });
    assert.equal(result.status, 1, `${JSON.stringify(overrides)}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /accepted_candidate_failed/);
  }

  for (const publicationStatus of ["published", "no_changes", "already_completed"]) {
    const result = runAuditScript(script, { ...base, PUBLICATION_STATUS: publicationStatus });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Daily benchmark outcome::${publicationStatus}`));
  }

  const inactive = runAuditScript(script, {
    ...base,
    SHOULD_RUN: "false",
    UPDATE_RESULT: "skipped",
    PUBLICATION_STATUS: "",
    PUBLISHED_COMMIT: ""
  });
  assert.equal(inactive.status, 0, inactive.stderr);
  assert.match(inactive.stdout, /inactive_candidate_no_update/);

  for (const shouldRun of ["", "TRUE", "yes"]) {
    const malformed = runAuditScript(script, {
      ...base,
      SHOULD_RUN: shouldRun,
      UPDATE_RESULT: "skipped",
      VALIDATION_RESULT: "skipped",
      PUBLICATION_STATUS: "",
      PUBLISHED_COMMIT: ""
    });
    assert.equal(malformed.status, 1, `${shouldRun}: ${malformed.stdout}\n${malformed.stderr}`);
    assert.match(malformed.stdout, /resolver_failed/);
    assert.doesNotMatch(malformed.stdout, /inactive_candidate_no_update/);
  }
});

function workflowStepScript(source, stepName) {
  const lines = source.split("\n");
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.ok(stepIndex >= 0, `missing workflow step: ${stepName}`);
  const runIndex = lines.findIndex(
    (line, index) => index > stepIndex && line.trim() === "run: |"
  );
  assert.ok(runIndex > stepIndex, `missing run script for workflow step: ${stepName}`);
  const runIndent = lines[runIndex].match(/^\s*/)?.[0].length ?? 0;
  const body = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (line.trim() && indent <= runIndent) break;
    body.push(line.slice(Math.min(line.length, runIndent + 2)));
  }
  return body.join("\n");
}

function runAuditScript(script, env) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: "/dev/null",
        ...env
      }
    }
  );
}

function runScript(script, cwd, env) {
  return spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env }
    }
  );
}

function commandPath(command) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), `missing command: ${command}`);
  return result.stdout.trim();
}

function commitPublicationFixture(
  cwd,
  {
    subject,
    receiptPath,
    receipt,
    slotKey,
    sourceSha,
    runId,
    runAttempt,
    fixtureValue,
    receiptHash,
    additionalTrailers = []
  }
) {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  const absoluteReceiptPath = path.join(cwd, receiptPath);
  mkdirSync(path.dirname(absoluteReceiptPath), { recursive: true });
  writeFileSync(absoluteReceiptPath, serialized);
  writeFileSync(path.join(cwd, "fixture.txt"), fixtureValue);
  const hash = receiptHash ?? createHash("sha256").update(serialized).digest("hex");
  const trailers = [
    `Returner-Slot-Key: ${slotKey}`,
    `Returner-Source-SHA: ${sourceSha}`,
    `Returner-Run-ID: ${runId}`,
    `Returner-Run-Attempt: ${runAttempt}`,
    `Returner-Receipt-SHA256: ${hash}`,
    ...additionalTrailers
  ].join("\n");
  runGit(cwd, "add", "fixture.txt", receiptPath);
  runGit(cwd, "commit", "-m", subject, "-m", trailers);
  return runGit(cwd, "rev-parse", "HEAD");
}

function runGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}
