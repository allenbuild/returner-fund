import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { maxAutonomousRunnerProcessBudgetMs } from "../scripts/lib/autonomous-ingestion-plan.mjs";
import { INGESTION_UTC_CRON_CANDIDATES } from "../scripts/lib/ingestion-schedule.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "autonomous-ingestion.yml"),
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

test("scheduled and manual runs share non-canceling concurrency", () => {
  assert.match(
    workflow,
    /concurrency:\s*\n\s*group:\s*autonomous-ingestion\s*\n\s*cancel-in-progress:\s*false/
  );
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.(?:ref|event_name|run_id)/);
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
  assert.match(runnerStep, /timeout-minutes:\s*260/);
  assert.match(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\s*\$\{\{ secrets\.NEXT_PUBLIC_SUPABASE_URL \}\}/);
  assert.match(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.doesNotMatch(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\?/);
  assert.doesNotMatch(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\?/);
  assert.match(runnerStep, /node scripts\/run-autonomous-ingestion\.mjs/);

  const validateIndex = workflow.indexOf("npm run artifacts:validate");
  const runnerIndex = workflow.indexOf("node scripts/run-autonomous-ingestion.mjs");
  assert.ok(runnerIndex >= 0 && validateIndex > runnerIndex);
  const runnerSource = readFileSync(path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs"), "utf8");
  const pushIndex = runnerSource.indexOf("await publishRepositoryArtifacts(publicationRunId, publicationInputs)");
  const completionIndex = runnerSource.indexOf('await completeRun("completed"');
  assert.ok(pushIndex > -1 && completionIndex > pushIndex);
});

test("workflow step budgets leave setup and scheduling headroom", () => {
  const jobTimeout = Number(workflow.match(/\n  ingest:[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const installTimeout = Number(workflow.match(/- name: Install dependencies[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const runnerTimeout = Number(workflow.match(/- name: Run autonomous ingestion[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);
  const validationTimeout = Number(workflow.match(/- name: Validate generated public artifacts[\s\S]*?timeout-minutes:\s*(\d+)/)?.[1]);

  assert.equal(jobTimeout, 285);
  assert.equal(installTimeout, 10);
  assert.equal(runnerTimeout, 260);
  assert.equal(validationTimeout, 5);
  assert.ok(installTimeout + runnerTimeout + validationTimeout < jobTimeout);
  assert.ok(maxAutonomousRunnerProcessBudgetMs() < runnerTimeout * 60_000);
});

test("workflow never invokes a logged-in collector", () => {
  assert.doesNotMatch(workflow, /logged[-_ ]?in|fetch-logged-in-social-traction|ingest:logged-social/i);
});

test("inactive candidates and accepted publication outcomes have distinct auditable receipts", () => {
  assert.match(workflow, /name:\s*Resolve Central slot candidate/);
  assert.match(workflow, /name:\s*Publish accepted slot \$\{\{ needs\.resolve\.outputs\.slot_key \}\}/);
  assert.match(workflow, /STATUS="inactive_candidate_no_refresh"/);
  assert.match(workflow, /STATUS="accepted_slot_failed"/);
  assert.match(workflow, /RECEIPT_STATUS="noop_completed"/);
  assert.match(workflow, /RECEIPT_STATUS="published"/);
  assert.match(workflow, /receipt_status=\$RECEIPT_STATUS/);
  assert.match(workflow, /RUNNER_STATUS:\s*\$\{\{ steps\.ingestion\.outputs\.runner_status \}\}/);
  assert.match(workflow, /Published commit:/);
  assert.match(workflow, /if \[ "\$STATUS" = "resolver_failed" \] \|\| \[ "\$STATUS" = "accepted_slot_failed" \]/);
  const runnerSource = readFileSync(path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs"), "utf8");
  assert.match(runnerSource, /writeRunnerOutcome\("already_completed"\)/);
  assert.match(runnerSource, /writeRunnerOutcome\("refreshed"\)/);
});
