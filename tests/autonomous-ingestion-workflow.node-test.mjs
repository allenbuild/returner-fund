import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { maxAutonomousRunnerProcessBudgetMs } from "../scripts/lib/autonomous-ingestion-plan.mjs";
import {
  AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS,
  AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS
} from "../scripts/lib/autonomous-ingestion-budget.mjs";
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
const receiptPolicy = readFileSync(
  path.join(repositoryRoot, "scripts", "lib", "autonomous-ingestion-receipt-policy.mjs"),
  "utf8"
);
const FULL_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

test("workflow declares exactly the four DST-safe UTC candidates", () => {
  const cronCandidates = Array.from(
    workflow.matchAll(/^\s*- cron:\s*["']([^"']+)["']\s*$/gm),
    (match) => match[1]
  );

  assert.deepEqual(cronCandidates, INGESTION_UTC_CRON_CANDIDATES);
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*replay_key:/);
  assert.match(workflow, /replay_key:[\s\S]*?required:\s*true/);
});

test("accepted runs share the repository publication lane without delaying inactive resolvers", () => {
  assert.match(
    workflow,
    /ingest:[\s\S]*?concurrency:\s*\n\s*group:\s*repository-publication-main\s*\n\s*cancel-in-progress:\s*false\s*\n\s*queue:\s*max/
  );
  assert.doesNotMatch(workflow.split("jobs:")[0], /concurrency:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /ingest:[\s\S]*?permissions:\s*\n\s*contents:\s*write/);
  const resolverJob = workflow.match(/\n  resolve:[\s\S]*?(?=\n  ingest:)/)?.[0] ?? "";
  assert.match(resolverJob, /uses:\s*actions\/checkout@v4[\s\S]*?ref:\s*main/);
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
    /update:[\s\S]*?concurrency:\s*\n\s*group:\s*repository-publication-main\s*\n\s*cancel-in-progress:\s*false\s*\n\s*queue:\s*max/
  );
  assert.doesNotMatch(dailyBenchmarkWorkflow.split("jobs:")[0], /concurrency:/);
  assert.match(dailyBenchmarkWorkflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(dailyBenchmarkWorkflow, /update:[\s\S]*?permissions:\s*\n\s*contents:\s*write/);
});

test("daily benchmarks synchronize, rebuild on push races, and verify main", () => {
  assert.match(dailyBenchmarkWorkflow, /ref:\s*main/);
  assert.match(dailyBenchmarkWorkflow, /fetch-depth:\s*0/);
  assert.match(dailyBenchmarkWorkflow, /git fetch --prune origin main/);
  assert.match(dailyBenchmarkWorkflow, /git rebase origin\/main/);
  assert.match(dailyBenchmarkWorkflow, /PUBLICATION_BRANCH:\s*main/);
  assert.match(dailyBenchmarkWorkflow, /if ! git push origin "HEAD:\$PUBLICATION_BRANCH"/);
  assert.match(dailyBenchmarkWorkflow, /timeout 10m npm ci/);
  assert.match(dailyBenchmarkWorkflow, /git commit --amend --no-edit/);
  assert.match(dailyBenchmarkWorkflow, /npm run artifacts:validate/);
  assert.match(dailyBenchmarkWorkflow, /git merge-base --is-ancestor/);
  assert.match(dailyBenchmarkWorkflow, /publication_status=published/);
  assert.match(dailyBenchmarkWorkflow, /publication_status=no_changes/);
  assert.match(dailyBenchmarkWorkflow, /STATUS="inactive_candidate_no_update"/);
  assert.match(dailyBenchmarkWorkflow, /STATUS="accepted_candidate_failed"/);
  assert.ok(
    dailyBenchmarkWorkflow.indexOf("git rebase origin/main") <
    dailyBenchmarkWorkflow.indexOf("npm run build")
  );
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

test("daily benchmarks rebuild and validate timelines with a database-free fallback", () => {
  const updateJob = dailyBenchmarkWorkflow.match(/\n  update:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  const benchmarkStep = updateJob.match(
    /- name: Update daily benchmark snapshots([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1] ?? "";
  const timelineStep = updateJob.match(
    /- name: Rebuild timeline artifacts([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1] ?? "";

  assert.doesNotMatch(benchmarkStep, /SUPABASE|TIMELINE_REQUIRE_DATABASE|exit 1/);
  assert.match(updateJob, /id:\s*timeline_database/);
  assert.match(updateJob, /validateSupabaseConfiguration/);
  assert.match(updateJob, /configured=false/);
  assert.match(updateJob, /file-backed fallback/);
  assert.doesNotMatch(timelineStep, /^\s*if:\s*steps\.timeline_database/m);
  assert.match(timelineStep, /TIMELINE_DATABASE_CONFIGURED/);
  assert.match(timelineStep, /TIMELINE_REQUIRE_DATABASE=true npm run timeline:backfill/);
  assert.match(timelineStep, /env -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY TIMELINE_REQUIRE_DATABASE=false npm run timeline:backfill/);
  assert.match(timelineStep, /npm run timeline:backfill/);
  assert.match(updateJob, /benchmark_files=\([\s\S]*public\/timelines[\s\S]*artifacts\/company-timeline\/coverage\.json/);
  assert.match(updateJob, /npm run artifacts:validate/);
  assert.match(updateJob, /npm run artifacts:manifest:validate/);
  assert.ok((updateJob.match(/npm run timeline:validate/g) ?? []).length >= 2);
});

test("daily publication rebuilds and validates graph-derived artifacts before both push attempts", () => {
  const updateJob = dailyBenchmarkWorkflow.match(/\n  update:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  const publishStep = updateJob.match(
    /- name: Commit and publish benchmark snapshots([\s\S]*?)$/
  )?.[1] ?? "";

  assert.equal((updateJob.match(/npm run artifacts:derived:build/g) ?? []).length, 2);
  assert.equal((updateJob.match(/npm run artifacts:derived:validate/g) ?? []).length, 2);
  assert.match(
    updateJob,
    /benchmark_files=\([\s\S]*public\/graph[\s\S]*public\/timelines[\s\S]*public\/topic-facets[\s\S]*src\/lib\/graph\/ranked-posts-sidecar\.generated\.json/
  );

  const rebaseIndex = publishStep.indexOf('git rebase "origin/$PUBLICATION_BRANCH"');
  const graphIndex = publishStep.indexOf("npm run benchmarks:daily", rebaseIndex);
  const timelineIndex = publishStep.indexOf("npm run timeline:backfill", graphIndex);
  const derivedBuildIndex = publishStep.indexOf("npm run artifacts:derived:build", timelineIndex);
  const manifestIndex = publishStep.indexOf("scripts/write-artifact-manifest.mjs", derivedBuildIndex);
  const derivedValidateIndex = publishStep.indexOf("npm run artifacts:derived:validate", manifestIndex);
  const stageIndex = publishStep.indexOf('git add -- "${benchmark_files[@]}"', derivedValidateIndex);

  assert.ok(
    rebaseIndex > -1 &&
    graphIndex > rebaseIndex &&
    timelineIndex > graphIndex &&
    derivedBuildIndex > timelineIndex &&
    manifestIndex > derivedBuildIndex &&
    derivedValidateIndex > manifestIndex &&
    stageIndex > derivedValidateIndex
  );
});

test("workflow gates work through the schedule helper and stable key", () => {
  assert.match(workflow, /id:\s*schedule[\s\S]*?node scripts\/lib\/ingestion-schedule\.mjs/);
  assert.match(workflow, /GITHUB_EVENT_SCHEDULE:\s*\$\{\{ github\.event\.schedule \}\}/);
  assert.match(workflow, /INGESTION_REPLAY_KEY:\s*\$\{\{ inputs\.replay_key \}\}/);
  assert.match(workflow, /if:\s*needs\.resolve\.outputs\.should_run == 'true'/);
  assert.match(workflow, /INGESTION_IDEMPOTENCY_KEY:\s*\$\{\{ needs\.resolve\.outputs\.slot_key \}\}/);
  assert.match(workflow, /--idempotency-key="\$INGESTION_IDEMPOTENCY_KEY"/);
});

test("autonomous runner receives optional durability secrets and owns validated publication", () => {
  const runnerStep = workflow.match(
    /- name: Run autonomous ingestion([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1];
  assert.ok(runnerStep, "missing autonomous ingestion step");
  assert.match(runnerStep, /id:\s*ingestion/);
  assert.match(runnerStep, /timeout-minutes:\s*330/);
  assert.match(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\s*\$\{\{ secrets\.NEXT_PUBLIC_SUPABASE_URL \}\}/);
  assert.match(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.match(runnerStep, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(runnerStep, /X_BEARER_TOKEN:\s*\$\{\{ secrets\.X_BEARER_TOKEN \}\}/);
  assert.match(runnerStep, /EXA_API_KEY:\s*\$\{\{ secrets\.EXA_API_KEY \}\}/);
  assert.doesNotMatch(runnerStep, /REDDIT_(?:CLIENT_ID|CLIENT_SECRET|USER_AGENT)/);
  assert.doesNotMatch(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\?/);
  assert.doesNotMatch(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\?/);
  assert.match(runnerStep, /node scripts\/run-autonomous-ingestion\.mjs/);
  assert.match(runnerStep, /INGESTION_PUBLICATION_BRANCH:\s*main/);
  const ingestJob = workflow.match(/\n  ingest:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  assert.match(ingestJob, /uses:\s*actions\/checkout@v4[\s\S]*?ref:\s*main[\s\S]*?fetch-depth:\s*0/);

  const validateIndex = workflow.indexOf("npm run artifacts:validate");
  const runnerIndex = workflow.indexOf("node scripts/run-autonomous-ingestion.mjs");
  assert.ok(runnerIndex >= 0 && validateIndex > runnerIndex);
  const validationStep = workflow.match(
    /- name: Validate generated public artifacts([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1] ?? "";
  assert.match(validationStep, /npm run artifacts:manifest:validate/);
  assert.match(validationStep, /npm run timeline:validate/);
  assert.match(validationStep, /npm run artifacts:derived:validate/);
  const runnerSource = readFileSync(path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs"), "utf8");
  const pushIndex = runnerSource.indexOf("await publishRepositoryArtifacts(publicationRunId, publicationInputs)");
  const completionIndex = runnerSource.indexOf('await completeRun("completed"');
  assert.ok(pushIndex > -1 && completionIndex > pushIndex);
  assert.match(runnerSource, /process\.env\.INGESTION_PUBLICATION_BRANCH \?\? "main"/);
  assert.doesNotMatch(runnerSource, /process\.env\.GITHUB_REF_NAME/);
});

test("workflow step budgets leave setup and scheduling headroom", () => {
  const jobTimeout = Number(workflow.match(/\n  ingest:[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const installTimeout = Number(workflow.match(/- name: Install dependencies[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const runnerTimeout = Number(workflow.match(/- name: Run autonomous ingestion[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const validationTimeout = Number(workflow.match(/- name: Validate generated public artifacts[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);

  assert.equal(jobTimeout, 360);
  assert.equal(installTimeout, 10);
  assert.equal(runnerTimeout, 330);
  assert.equal(validationTimeout, 5);
  assert.ok(runnerTimeout < jobTimeout);
  assert.ok(installTimeout + runnerTimeout + validationTimeout < jobTimeout);
  assert.ok(
    jobTimeout - installTimeout - runnerTimeout - validationTimeout >= 15,
    "checkout, setup-node, receipt, and post steps require explicit job-level headroom"
  );
  assert.ok(maxAutonomousRunnerProcessBudgetMs() < runnerTimeout * 60_000);
  assert.equal(
    AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS + AUTONOMOUS_RUNNER_WORKFLOW_HEADROOM_MS,
    runnerTimeout * 60_000,
    "the enforced runner deadline must leave explicit cleanup headroom inside the workflow step"
  );
  assert.ok(maxAutonomousRunnerProcessBudgetMs() < AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS);
  assert.ok(
    (installTimeout + validationTimeout) * 60_000 + maxAutonomousRunnerProcessBudgetMs() <
      jobTimeout * 60_000
  );
});

test("workflow never invokes a logged-in collector", () => {
  assert.doesNotMatch(workflow, /logged[-_ ]?in|fetch-logged-in-social-traction|ingest:logged-social/i);
});

test("inactive candidates and accepted publication outcomes have distinct auditable receipts", () => {
  assert.match(workflow, /name:\s*Resolve Central slot candidate/);
  assert.match(workflow, /name:\s*Publish accepted slot \$\{\{ needs\.resolve\.outputs\.slot_key \}\}/);
  assert.match(workflow, /STATUS="inactive_candidate_no_refresh"/);
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
  const runnerSource = readFileSync(path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs"), "utf8");
  assert.match(runnerSource, /writeRunnerOutcome\(\{\s*status:\s*"already_completed"/);
  assert.match(runnerSource, /writeRunnerOutcome\(\{\s*status:\s*"refreshed"/);
});

test("autonomous audit fails closed for every accepted job without a recognized commit-backed receipt", () => {
  const script = workflowStepScript(workflow, "Record auditable slot outcome");
  const base = {
    SHOULD_RUN: "true",
    SLOT_KEY: "central-2026-08-09-1800",
    RESOLVE_RESULT: "success",
    INGEST_RESULT: "success",
    RECEIPT_STATUS: "published",
    RECEIPT_CONCLUSION: "success",
    PUBLISHED_COMMIT: FULL_COMMIT_SHA
  };

  for (const ingestResult of ["skipped", "cancelled", "failure"]) {
    const result = runAuditScript(script, { ...base, INGEST_RESULT: ingestResult });
    assert.equal(result.status, 1, `${ingestResult}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /accepted_slot_failed/);
  }

  for (const overrides of [
    { PUBLISHED_COMMIT: "" },
    { PUBLISHED_COMMIT: "c5506de" },
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
});

test("daily benchmark audit fails closed for accepted jobs without exact publication proof", () => {
  const script = workflowStepScript(dailyBenchmarkWorkflow, "Record auditable benchmark outcome");
  const base = {
    SHOULD_RUN: "true",
    RESOLVE_RESULT: "success",
    UPDATE_RESULT: "success",
    PUBLICATION_STATUS: "published",
    PUBLISHED_COMMIT: FULL_COMMIT_SHA,
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
    { PUBLICATION_STATUS: "invented_warning" }
  ]) {
    const result = runAuditScript(script, { ...base, ...overrides });
    assert.equal(result.status, 1, `${JSON.stringify(overrides)}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /accepted_candidate_failed/);
  }

  for (const publicationStatus of ["published", "no_changes"]) {
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
