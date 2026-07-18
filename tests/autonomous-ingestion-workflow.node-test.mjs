import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.match(workflow, /if:\s*steps\.schedule\.outputs\.should_run == 'true'/);
  assert.match(workflow, /--idempotency-key="\$INGESTION_IDEMPOTENCY_KEY"/);
});

test("autonomous runner is secret-guarded and owns validated publication", () => {
  const runnerStep = workflow.match(
    /- name: Run autonomous ingestion([\s\S]*?)(?=\n\s{6}- name:)/
  )?.[1];
  assert.ok(runnerStep, "missing autonomous ingestion step");
  assert.match(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\s*\$\{\{ secrets\.NEXT_PUBLIC_SUPABASE_URL \}\}/);
  assert.match(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\s*\$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.match(runnerStep, /NEXT_PUBLIC_SUPABASE_URL:\?/);
  assert.match(runnerStep, /SUPABASE_SERVICE_ROLE_KEY:\?/);
  assert.match(runnerStep, /node scripts\/run-autonomous-ingestion\.mjs/);

  const validateIndex = workflow.indexOf("npm run artifacts:validate");
  const runnerIndex = workflow.indexOf("node scripts/run-autonomous-ingestion.mjs");
  assert.ok(runnerIndex >= 0 && validateIndex > runnerIndex);
  const runnerSource = readFileSync(path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs"), "utf8");
  const pushIndex = runnerSource.indexOf("await publishRepositoryArtifacts()");
  const completionIndex = runnerSource.indexOf('await completeRun("completed"');
  assert.ok(pushIndex > -1 && completionIndex > pushIndex);
});

test("workflow never invokes a logged-in collector", () => {
  assert.doesNotMatch(workflow, /logged[-_ ]?in|fetch-logged-in-social-traction|ingest:logged-social/i);
});
