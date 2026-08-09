import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { maxAutonomousRunnerProcessBudgetMs } from "../scripts/lib/autonomous-ingestion-plan.mjs";
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
  assert.deepEqual(stepTimeouts, [10, 10, 15, 50, 10, 5, 75]);
  assert.ok(stepTimeouts.reduce((total, timeout) => total + timeout, 0) < jobTimeout);
});

test("daily benchmarks preserve legacy publication without timeline database secrets", () => {
  const updateJob = dailyBenchmarkWorkflow.match(/\n  update:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  const benchmarkStep = updateJob.match(
    /- name: Update daily benchmark snapshots([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1] ?? "";
  const timelineStep = updateJob.match(
    /- name: Rebuild database-backed timeline artifacts([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1] ?? "";

  assert.doesNotMatch(benchmarkStep, /SUPABASE|TIMELINE_REQUIRE_DATABASE|exit 1/);
  assert.match(updateJob, /id:\s*timeline_database/);
  assert.match(updateJob, /configured=false/);
  assert.match(updateJob, /preserving the last-good public timeline artifacts/);
  assert.match(timelineStep, /if:\s*steps\.timeline_database\.outputs\.configured == 'true'/);
  assert.match(timelineStep, /TIMELINE_REQUIRE_DATABASE:\s*"true"/);
  assert.match(timelineStep, /npm run timeline:backfill/);
  assert.match(updateJob, /if \[ "\$TIMELINE_DATABASE_CONFIGURED" = "true" \]; then\s*\n\s*benchmark_files\+=\(public\/timelines\)/);
  assert.match(updateJob, /npm run artifacts:validate/);
  assert.match(updateJob, /npm run artifacts:manifest:validate/);
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
  assert.match(runnerStep, /timeout-minutes:\s*340/);
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
  assert.equal(runnerTimeout, 340);
  assert.equal(validationTimeout, 5);
  assert.ok(runnerTimeout < jobTimeout);
  assert.ok(installTimeout + runnerTimeout + validationTimeout < jobTimeout);
  assert.ok(maxAutonomousRunnerProcessBudgetMs() < runnerTimeout * 60_000);
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
  assert.match(workflow, /Receipt conclusion:/);
  assert.match(workflow, /if \[ "\$STATUS" = "resolver_failed" \] \|\| \[ "\$STATUS" = "accepted_slot_failed" \]/);
  assert.match(workflow, /upstream resolver or ingestion job is the single failing job/);
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
