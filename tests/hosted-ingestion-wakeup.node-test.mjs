import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOSTED_WAKEUP_VERCEL_ACTION,
  HOSTED_WAKEUP_VERCEL_PROJECT_ID,
  resolveHostedIngestionWakeup,
  validateHostedWakeupEvent
} from "../scripts/lib/hosted-ingestion-wakeup.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(repositoryRoot, ".github/workflows/hosted-ingestion-wakeup.yml"),
  "utf8"
);
const vercel = JSON.parse(readFileSync(path.join(repositoryRoot, "vercel.json"), "utf8"));
const HEAD_SHA = "a".repeat(40);
const NOW = new Date("2026-09-07T08:45:00.000Z");
const SLOT_KEY = "central-2026-09-06-1800";
const SCHEDULED_AT = "2026-09-06T23:00:00.000Z";

test("trusted Vercel production success no-ops when exact acceptance is current", async () => {
  const decision = await resolveHostedIngestionWakeup({
    eventName: "repository_dispatch",
    event: repositoryDispatchEvent(),
    headSha: HEAD_SHA,
    now: NOW,
    readPublicationState: async () => publicationState()
  });

  assert.equal(decision.shouldDispatch, false);
  assert.equal(decision.reason, "publication-acceptance-current");
  assert.equal(decision.expectedHeadSha, HEAD_SHA);
  assert.equal(decision.slotKey, SLOT_KEY);
});

test("the bridge dispatches validation or watermark debt and remains slot-idempotent", async () => {
  const validationDebt = await resolveHostedIngestionWakeup({
    eventName: "repository_dispatch",
    event: repositoryDispatchEvent(),
    headSha: HEAD_SHA,
    now: NOW,
    readPublicationState: async () => publicationState({ acceptance: { status: "missing" } })
  });
  assert.equal(validationDebt.shouldDispatch, true);
  assert.equal(validationDebt.reason, "retry-publication-validation");
  assert.equal(validationDebt.slotKey, SLOT_KEY);

  const watermarkDebt = await resolveHostedIngestionWakeup({
    eventName: "deployment_status",
    event: deploymentStatusEvent(),
    headSha: HEAD_SHA,
    now: NOW,
    readPublicationState: async () => publicationState({
      watermark: new Date("2026-09-06T22:59:59.000Z")
    })
  });
  assert.equal(watermarkDebt.shouldDispatch, true);
  assert.equal(watermarkDebt.reason, "retry-publication-watermark");
  assert.equal(watermarkDebt.slotKey, SLOT_KEY);
});

test("event admission rejects spoofed sender, project, environment, state, ref, URL, or stale SHA", () => {
  const trusted = repositoryDispatchEvent();
  for (const mutate of [
    (event) => { event.sender.login = "attacker"; },
    (event) => { event.repository.full_name = "attacker/repo"; },
    (event) => { event.client_payload.project.id = "prj_attacker"; },
    (event) => { event.client_payload.environment = "preview"; },
    (event) => { event.client_payload.state.type = "pending"; },
    (event) => { event.client_payload.git.ref = "feature"; },
    (event) => { event.client_payload.url = "https://attacker.example"; }
  ]) {
    const event = structuredClone(trusted);
    mutate(event);
    assert.throws(
      () => validateHostedWakeupEvent({
        eventName: "repository_dispatch",
        event,
        headSha: HEAD_SHA
      }),
      /hosted wakeup/
    );
  }
});

test("a valid Vercel event for an older deployment cleanly no-ops after main advances", async () => {
  let publicationReads = 0;
  const decision = await resolveHostedIngestionWakeup({
    eventName: "repository_dispatch",
    event: repositoryDispatchEvent(),
    headSha: "b".repeat(40),
    now: NOW,
    readPublicationState: async () => {
      publicationReads += 1;
      return publicationState({ acceptance: { status: "missing" } });
    }
  });

  assert.equal(decision.shouldDispatch, false);
  assert.equal(decision.reason, "deployment-not-current-main");
  assert.equal(decision.expectedHeadSha, "b".repeat(40));
  assert.equal(publicationReads, 0);
});

test("deployment_status fallback requires Vercel's exact successful Production deployment", () => {
  assert.equal(validateHostedWakeupEvent({
    eventName: "deployment_status",
    event: deploymentStatusEvent(),
    headSha: HEAD_SHA
  }).deployedSha, HEAD_SHA);

  for (const mutate of [
    (event) => { event.deployment_status.state = "failure"; },
    (event) => { event.deployment.environment = "Preview"; },
    (event) => { event.deployment.creator.login = "attacker"; },
    (event) => { event.deployment.ref = "feature"; }
  ]) {
    const event = deploymentStatusEvent();
    mutate(event);
    assert.throws(() => validateHostedWakeupEvent({
      eventName: "deployment_status",
      event,
      headSha: HEAD_SHA
    }), /hosted wakeup/);
  }
});

test("workflow provides a non-cron bridge without creating a current-state recursion loop", () => {
  assert.match(workflow, /repository_dispatch:\s*\n\s*types:\s*\[vercel\.deployment\.success\]/);
  assert.match(workflow, /\n\s*deployment_status:\s*\n/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.match(workflow, /github\.event\.deployment_status\.state == 'success'/);
  assert.match(workflow, /github\.event\.deployment\.environment == 'Production'/);
  assert.match(workflow, /github\.event\.deployment\.creator\.login == 'vercel\[bot\]'/);
  assert.match(workflow, /github\.event\.sender\.login == 'vercel\[bot\]'/);
  assert.match(workflow, /ref:\s*main[\s\S]*?fetch-depth:\s*0[\s\S]*?persist-credentials:\s*false/);
  assert.match(workflow, /node scripts\/lib\/hosted-ingestion-wakeup\.mjs/);
  assert.match(workflow, /steps\.resolve\.outputs\.should_dispatch == 'true'/);
  assert.match(workflow, /git fetch --quiet --no-tags origin refs\/heads\/main/);
  assert.match(workflow, /actions\/workflows\/autonomous-ingestion\.yml\/runs\?branch=main&per_page=100/);
  for (const status of ["requested", "waiting", "pending", "queued", "in_progress"]) {
    assert.match(workflow, new RegExp(`"${status}"`));
  }
  assert.match(workflow, /activeStatuses\.has\(String\(run\?\.status/);
  assert.doesNotMatch(workflow, /runs\?branch=main&status=/);
  assert.match(workflow, /event_type:\s*"autonomous-ingestion-recovery"/);
  assert.match(workflow, /client_payload:\s*\{ expected_head_sha: expectedHeadSha \}/);
  assert.match(workflow, /"Content-Type":\s*"application\/json"/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /actions:\s*read/);
  assert.doesNotMatch(workflow, /echo[^\n]*(?:GH_TOKEN|github\.token)/i);
});

test("Vercel invokes only the secret-protected cloud preflight", () => {
  assert.deepEqual(vercel.crons, [{
    path: "/api/internal/ingestion-wakeup",
    schedule: "9 * * * *"
  }]);
  assert.match(workflow, /Hosted Ingestion Wakeup Bridge/);
});

function repositoryDispatchEvent() {
  return {
    action: HOSTED_WAKEUP_VERCEL_ACTION,
    repository: {
      full_name: "allenbuild/returner-fund",
      default_branch: "main"
    },
    sender: { login: "vercel[bot]" },
    client_payload: {
      environment: "production",
      git: { ref: "main", sha: HEAD_SHA, shortSha: HEAD_SHA.slice(0, 7) },
      id: "dpl_fixture123",
      project: { id: HOSTED_WAKEUP_VERCEL_PROJECT_ID, name: "returner-fund" },
      state: { type: "success" },
      url: "https://returner-fund-fixture.vercel.app"
    }
  };
}

function deploymentStatusEvent() {
  return {
    repository: {
      full_name: "allenbuild/returner-fund",
      default_branch: "main"
    },
    sender: { login: "vercel[bot]" },
    deployment_status: { state: "success" },
    deployment: {
      environment: "Production",
      task: "deploy",
      creator: { login: "vercel[bot]" },
      sha: HEAD_SHA,
      ref: "main"
    }
  };
}

function publicationState(overrides = {}) {
  return {
    status: "valid",
    watermark: new Date("2026-09-07T05:47:11.477Z"),
    newestGeneratedAt: new Date("2026-09-07T06:08:07.220Z"),
    graphGeneratedAt: {},
    acceptance: {
      status: "valid",
      marker: {
        slotKey: SLOT_KEY,
        scheduledAt: SCHEDULED_AT,
        publicationCommit: "d".repeat(40)
      }
    },
    ...overrides
  };
}
