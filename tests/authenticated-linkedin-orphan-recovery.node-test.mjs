import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  runAuthenticatedLinkedInOrphanRecovery,
  validateAuthenticatedLinkedInOrphanRecoveryRequest
} from "../scripts/lib/authenticated-linkedin-orphan-recovery.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const recoveryWorkflow = readFileSync(
  path.join(
    repositoryRoot,
    ".github",
    "workflows",
    "recover-authenticated-linkedin-orphan.yml"
  ),
  "utf8"
);
const LOCK_KEY =
  "authenticated-linkedin:returner-fund-production-linkedin-allen-xu-v1";
const OWNER_ID = "d3f5cd12-b6c0-4510-ab2d-a44a2b72a9b8";
const LEASE_TOKEN = "4b611339-9d5c-43d3-9b35-b47e5fe3e068";
const LOCAL_TOKEN = "2568d08d-56f4-4c9f-a575-30343d7f9678";
const ATTEMPT_TOKEN = "da9e59f0-486b-46fe-88d9-2dc10eeedc14";
const SOURCE_SHA = "8".repeat(40);
const RECOVERY_SHA = "9".repeat(40);
const CHECKPOINT_SHA = "a".repeat(64);
const OUTPUT_SHA = "b".repeat(64);
const TARGET_KEY =
  "S26:linkedin:company-allia-health:" +
  "https://www.linkedin.com/company/alliahealth/";
const CURRENT_RUN_ID = 34790699999;
const CANCELED_RUN_ID = 34790596070;
const NOW = Date.parse("2026-09-14T01:00:00.000Z");

const VALID_ENV = Object.freeze({
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_RUN_ID: String(CURRENT_RUN_ID),
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: RECOVERY_SHA,
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_TYPE: "branch",
  GITHUB_REPOSITORY: "owner/returner-fund",
  RUNNER_NAME: "returner-social-mac-allenxtech",
  OPENCLI_HOME: "/private/tmp/opencli-home",
  RECOVER_AUTHENTICATED_LINKEDIN_LOCK: "true",
  AUTHENTICATED_SOCIAL_PREFLIGHT_PASSED: "true",
  AUTHENTICATED_SOCIAL_REPLAY: "true",
  AUTHENTICATED_BACKFILL_SCOPE: "linkedin",
  AUTHENTICATED_BACKFILL_BATCH: "S26",
  AUTHENTICATED_BACKFILL_COMPANY_SLUG: "allia-health",
  LINKEDIN_GLOBAL_LOCK_NAMESPACE:
    "returner-fund-production-linkedin-allen-xu-v1",
  AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASE: "inspect",
  AUTHENTICATED_LINKEDIN_ORPHAN_CANCELED_RUN_ID:
    String(CANCELED_RUN_ID),
  AUTHENTICATED_LINKEDIN_ORPHAN_CANCELED_RUN_ATTEMPT: "1",
  AUTHENTICATED_LINKEDIN_ORPHAN_IDEMPOTENCY_KEY:
    "incident-20260913-s26-linkedin-backlog-001",
  AUTHENTICATED_LINKEDIN_ORPHAN_TARGET_KEY: TARGET_KEY,
  AUTHENTICATED_LINKEDIN_ORPHAN_EXPECTED_FINGERPRINT: ""
});

function row(overrides = {}) {
  return {
    lock_key: LOCK_KEY,
    owner_id: OWNER_ID,
    lease_token: LEASE_TOKEN,
    heartbeat_at: "2026-09-14T00:00:00.000Z",
    lease_expires_at: "2026-09-14T00:20:00.000Z",
    created_at: "2026-09-13T23:47:20.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
    metadata_json: {
      collector: "authenticated-linkedin",
      pid: 6822
    },
    ...overrides
  };
}

function controller(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "s2026_linkedin_checkpoint_collection_state",
    status: "running",
    idempotencyKey: VALID_ENV.AUTHENTICATED_LINKEDIN_ORPHAN_IDEMPOTENCY_KEY,
    sourceSha: SOURCE_SHA,
    expectedCheckpointSha256: CHECKPOINT_SHA,
    expectedRemaining: 672,
    beforeRemaining: 672,
    beforeCheckpointSha256: CHECKPOINT_SHA,
    beforeOutputSha256: OUTPUT_SHA,
    currentRemaining: 672,
    currentCheckpointSha256: CHECKPOINT_SHA,
    currentOutputSha256: OUTPUT_SHA,
    completedTargets: 0,
    chunksCompleted: 0,
    batteryChunks: 0,
    acChunks: 0,
    chunkReceipts: [],
    intent: {
      chunkNumber: 1,
      powerMode: "ac",
      beforeRemaining: 672,
      selectedKeys: ["agent", "akon", "aktoria", TARGET_KEY, "fifth"],
      beforeAttempts: {},
      checkpointSha256Before: CHECKPOINT_SHA,
      outputSha256Before: OUTPUT_SHA
    },
    startedAt: "2026-09-13T23:47:18.000Z",
    ...overrides
  };
}

function checkpoint(overrides = {}) {
  return {
    attempts: {
      agent: { status: "done", count: 0 },
      akon: { status: "done", count: 0 },
      aktoria: { status: "done", count: 0 }
    },
    ...overrides
  };
}

function workflow(overrides = {}) {
  const runName =
    "Autonomous ingestion candidate " +
    VALID_ENV.AUTHENTICATED_LINKEDIN_ORPHAN_IDEMPOTENCY_KEY;
  return {
    id: CANCELED_RUN_ID,
    run_attempt: 1,
    name: runName,
    display_title: runName,
    status: "completed",
    conclusion: "cancelled",
    event: "workflow_dispatch",
    head_sha: SOURCE_SHA,
    head_branch: "main",
    head_repository: { full_name: "owner/returner-fund" },
    path: ".github/workflows/autonomous-ingestion.yml",
    repository: { full_name: "owner/returner-fund" },
    created_at: "2026-09-13T23:45:09.000Z",
    run_started_at: "2026-09-13T23:45:09.000Z",
    updated_at: "2026-09-14T00:02:47.000Z",
    ...overrides
  };
}

function jobs(overrides = {}) {
  return [{
    id: 103814132210,
    name:
      "Publish accepted slot " +
      VALID_ENV.AUTHENTICATED_LINKEDIN_ORPHAN_IDEMPOTENCY_KEY,
    status: "completed",
    conclusion: "cancelled",
    runner_name: VALID_ENV.RUNNER_NAME,
    runner_group_name: "Default",
    labels: [
      "self-hosted",
      "macOS",
      "ARM64",
      "returner-social",
      "returner-auth-browser"
    ],
    started_at: "2026-09-13T23:46:28.000Z",
    completed_at: "2026-09-14T00:02:37.000Z",
    steps: [
      {
        name: "Preflight authenticated social runner",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-13T23:46:42.000Z",
        completed_at: "2026-09-13T23:47:17.000Z"
      },
      {
        name: "Collect bounded 2026 LinkedIn checkpoints",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-09-13T23:47:17.000Z",
        completed_at: "2026-09-14T00:02:34.000Z"
      }
    ],
    ...overrides
  }];
}

function fakeClient({ rows = [row(), row()], rpcResult = true } = {}) {
  const calls = [];
  let lookupIndex = 0;
  return {
    calls,
    from(table) {
      const call = { kind: "query", table, select: null, filters: [] };
      const builder = {
        select(columns) {
          call.select = columns;
          return builder;
        },
        eq(column, value) {
          call.filters.push([column, value]);
          return builder;
        },
        maybeSingle() {
          calls.push(call);
          const data =
            call.select === "lock_key"
              ? null
              : rows[Math.min(lookupIndex++, rows.length - 1)];
          return Promise.resolve({ data, error: null });
        }
      };
      return builder;
    },
    rpc(name, parameters) {
      calls.push({ kind: "rpc", name, parameters });
      const request = Promise.resolve({ data: rpcResult, error: null });
      request.abortSignal = () => request;
      return request;
    }
  };
}

function dependencies(overrides = {}) {
  const localLock = {
    pid: 6822,
    token: LOCAL_TOKEN,
    acquiredAt: "2026-09-13T23:47:20.421Z"
  };
  const pacing = {
    version: 1,
    phase: "in_progress",
    attemptToken: ATTEMPT_TOKEN,
    pid: 6822,
    lastTargetAttemptAtMs:
      Date.parse("2026-09-13T23:59:31.611Z"),
    lastTargetAttemptAt: "2026-09-13T23:59:31.611Z"
  };
  return {
    now: () => NOW,
    sleep: async () => undefined,
    observationDelayMs: 0,
    readWorkflowRun: async () => workflow(),
    readWorkflowJobs: async () => jobs(),
    readActiveWorkflowRuns: async () => [
      { id: CURRENT_RUN_ID, status: "in_progress" }
    ],
    processIsAlive: () => false,
    readProcessInventory: async () => "100 /usr/bin/node recovery-script",
    pathExists: async () => false,
    readJsonEvidence: async (requestedPath) => {
      let value;
      if (requestedPath.endsWith(".lock")) {
        value = structuredClone(localLock);
      } else if (requestedPath.endsWith("pacing.json")) {
        value = structuredClone(pacing);
      } else if (
        requestedPath.endsWith(".json") &&
        requestedPath.includes("checkpoint-collection-runs")
      ) {
        value = controller();
      } else if (requestedPath.endsWith("logged-in-s26.json")) {
        value = { evidence: [], failures: [], needsReview: [] };
      } else {
        value = checkpoint();
      }
      const bytes = Buffer.from(JSON.stringify(value));
      return {
        value,
        sha256: requestedPath.endsWith("logged-in-s26.json")
          ? OUTPUT_SHA
          : createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        device: 1,
        inode: requestedPath.endsWith(".lock")
          ? 1
          : requestedPath.endsWith("pacing.json")
            ? 2
            : requestedPath.includes("checkpoint-collection-runs")
              ? 3
              : requestedPath.endsWith("logged-in-s26.json")
                ? 4
                : 5,
        modifiedAtMs: NOW - 1_000
      };
    },
    withLocalRecoveryGuard: async ({ operation }) => operation(),
    lockPath: "/private/tmp/linkedin.lock",
    pacingPath: "/private/tmp/pacing.json",
    ...overrides
  };
}

test("request binds two phases to one exact run, target, and account key", () => {
  const request =
    validateAuthenticatedLinkedInOrphanRecoveryRequest(VALID_ENV);
  assert.equal(request.phase, "inspect");
  assert.equal(request.canceledRunId, CANCELED_RUN_ID);
  assert.equal(request.targetKey, TARGET_KEY);
  assert.equal(request.lockKey, LOCK_KEY);

  for (const [name, value] of [
    ["GITHUB_EVENT_NAME", "schedule"],
    ["RECOVER_AUTHENTICATED_LINKEDIN_LOCK", "false"],
    ["AUTHENTICATED_LINKEDIN_ORPHAN_CANCELED_RUN_ID",
      String(CURRENT_RUN_ID)],
    ["AUTHENTICATED_LINKEDIN_ORPHAN_IDEMPOTENCY_KEY",
      "incident-20260913-s26-linkedin-backlog-000"],
    ["AUTHENTICATED_LINKEDIN_ORPHAN_TARGET_KEY",
      "S26:linkedin:company-other:https://www.linkedin.com/company/other/"],
    ["LINKEDIN_GLOBAL_LOCK_NAMESPACE",
      "returner-fund-production-linkedin-checkpoint-controller-v1"]
  ]) {
    assert.throws(
      () =>
        validateAuthenticatedLinkedInOrphanRecoveryRequest({
          ...VALID_ENV,
          [name]: value
        }),
      /orphan recovery/
    );
  }
});

test("inspect double-reads stable legacy evidence and emits no lease secrets", async () => {
  const client = fakeClient();
  const request =
    validateAuthenticatedLinkedInOrphanRecoveryRequest(VALID_ENV);
  const result = await runAuthenticatedLinkedInOrphanRecovery(
    client,
    request,
    dependencies()
  );
  assert.equal(result.status, "inspection_ready");
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    client.calls.map((call) => call.kind),
    ["query", "query"]
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(LEASE_TOKEN));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(LOCAL_TOKEN));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(OWNER_ID));
});

test("apply requires inspected fingerprint and releases only exact owner/token", async () => {
  const inspectClient = fakeClient();
  const inspectRequest =
    validateAuthenticatedLinkedInOrphanRecoveryRequest(VALID_ENV);
  const inspected = await runAuthenticatedLinkedInOrphanRecovery(
    inspectClient,
    inspectRequest,
    dependencies()
  );
  const applyRequest = validateAuthenticatedLinkedInOrphanRecoveryRequest({
    ...VALID_ENV,
    AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASE: "apply",
    AUTHENTICATED_LINKEDIN_ORPHAN_EXPECTED_FINGERPRINT:
      inspected.fingerprint
  });
  const client = fakeClient();
  const result = await runAuthenticatedLinkedInOrphanRecovery(
    client,
    applyRequest,
    dependencies()
  );
  assert.equal(result.status, "released");
  assert.equal(result.collectionReady, false);
  assert.equal(result.localRecoveryRequired, true);
  assert.deepEqual(
    client.calls.map((call) => call.kind),
    ["query", "query", "query", "rpc", "query"]
  );
  assert.deepEqual(client.calls[3], {
    kind: "rpc",
    name: "release_ingestion_runtime_lock",
    parameters: {
      p_lock_key: LOCK_KEY,
      p_owner_id: OWNER_ID,
      p_lease_token: LEASE_TOKEN
    }
  });
});

test("apply fails closed before RPC for drift, liveness, timing, or run mismatch", async () => {
  const request = validateAuthenticatedLinkedInOrphanRecoveryRequest({
    ...VALID_ENV,
    AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASE: "apply",
    AUTHENTICATED_LINKEDIN_ORPHAN_EXPECTED_FINGERPRINT: "a".repeat(64)
  });
  const cases = [
    {
      client: fakeClient({
        rows: [
          row(),
          row({ metadata_json: {
            collector: "authenticated-linkedin",
            pid: 6822,
            unexpected: true
          } })
        ]
      }),
      deps: dependencies(),
      pattern: /exact legacy ordinary lease/
    },
    {
      client: fakeClient(),
      deps: dependencies({ processIsAlive: () => true }),
      pattern: /exact orphan PID is still alive/
    },
    {
      client: fakeClient(),
      deps: dependencies({
        now: () => Date.parse("2026-09-14T00:20:29.999Z")
      }),
      pattern: /expiry cooldown has not elapsed/
    },
    {
      client: fakeClient(),
      deps: dependencies({
        readWorkflowRun: async () => workflow({ conclusion: "success" })
      }),
      pattern: /exact canceled workflow/
    },
    {
      client: fakeClient(),
      deps: dependencies({
        readActiveWorkflowRuns: async () => [
          { id: 999, status: "in_progress" }
        ]
      }),
      pattern: /another autonomous-ingestion workflow is active/
    }
  ];
  for (const item of cases) {
    await assert.rejects(
      runAuthenticatedLinkedInOrphanRecovery(
        item.client,
        request,
        item.deps
      ),
      item.pattern
    );
    assert.equal(
      item.client.calls.some((call) => call.kind === "rpc"),
      false
    );
  }
});

test("raw-byte-only drift invalidates inspect and guarded apply", async () => {
  const inspectRequest =
    validateAuthenticatedLinkedInOrphanRecoveryRequest(VALID_ENV);
  const driftingInspect = dependencies();
  const inspectReader = driftingInspect.readJsonEvidence;
  let inspectPacingReads = 0;
  driftingInspect.readJsonEvidence = async (requestedPath) => {
    const evidence = await inspectReader(requestedPath);
    if (
      requestedPath.endsWith("pacing.json") &&
      ++inspectPacingReads === 2
    ) {
      return { ...evidence, sha256: "c".repeat(64) };
    }
    return evidence;
  };
  await assert.rejects(
    runAuthenticatedLinkedInOrphanRecovery(
      fakeClient(),
      inspectRequest,
      driftingInspect
    ),
    /evidence changed during stable observation/
  );

  const inspected = await runAuthenticatedLinkedInOrphanRecovery(
    fakeClient(),
    inspectRequest,
    dependencies()
  );
  const applyRequest = validateAuthenticatedLinkedInOrphanRecoveryRequest({
    ...VALID_ENV,
    AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASE: "apply",
    AUTHENTICATED_LINKEDIN_ORPHAN_EXPECTED_FINGERPRINT:
      inspected.fingerprint
  });
  const guardedDrift = dependencies();
  const guardedReader = guardedDrift.readJsonEvidence;
  let lockReads = 0;
  let guardReleased = false;
  guardedDrift.readJsonEvidence = async (requestedPath) => {
    const evidence = await guardedReader(requestedPath);
    if (requestedPath.endsWith("linkedin.lock") && ++lockReads === 3) {
      return { ...evidence, sha256: "d".repeat(64) };
    }
    return evidence;
  };
  guardedDrift.withLocalRecoveryGuard = async ({ operation }) => {
    try {
      return await operation();
    } finally {
      guardReleased = true;
    }
  };
  const client = fakeClient();
  await assert.rejects(
    runAuthenticatedLinkedInOrphanRecovery(
      client,
      applyRequest,
      guardedDrift
    ),
    /evidence changed after local guard acquisition/
  );
  assert.equal(guardReleased, true);
  assert.equal(client.calls.some((call) => call.kind === "rpc"), false);
});

test("positive apply uses a temporary guard and leaves local bytes exact", async () => {
  const inspectRequest =
    validateAuthenticatedLinkedInOrphanRecoveryRequest(VALID_ENV);
  const inspected = await runAuthenticatedLinkedInOrphanRecovery(
    fakeClient(),
    inspectRequest,
    dependencies()
  );
  const applyRequest = validateAuthenticatedLinkedInOrphanRecoveryRequest({
    ...VALID_ENV,
    AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASE: "apply",
    AUTHENTICATED_LINKEDIN_ORPHAN_EXPECTED_FINGERPRINT:
      inspected.fingerprint
  });
  const directory = await mkdtemp(
    path.join(tmpdir(), "linkedin-orphan-recovery-test-")
  );
  const lockPath = path.join(directory, "linkedin.lock");
  const pacingPath = path.join(directory, "pacing.json");
  const lockBytes = Buffer.from("sealed collector lock bytes\n");
  const pacingBytes = Buffer.from("sealed pacing bytes\n");
  try {
    await writeFile(lockPath, lockBytes, { mode: 0o600 });
    await writeFile(pacingPath, pacingBytes, { mode: 0o600 });
    const options = dependencies({ lockPath, pacingPath });
    delete options.withLocalRecoveryGuard;
    const result = await runAuthenticatedLinkedInOrphanRecovery(
      fakeClient(),
      applyRequest,
      options
    );
    assert.equal(result.status, "released");
    assert.deepEqual(await readFile(lockPath), lockBytes);
    assert.deepEqual(await readFile(pacingPath), pacingBytes);
    await assert.rejects(access(lockPath + ".acquire"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply refuses a non-abortable release transport", async () => {
  const inspectRequest =
    validateAuthenticatedLinkedInOrphanRecoveryRequest(VALID_ENV);
  const inspected = await runAuthenticatedLinkedInOrphanRecovery(
    fakeClient(),
    inspectRequest,
    dependencies()
  );
  const applyRequest = validateAuthenticatedLinkedInOrphanRecoveryRequest({
    ...VALID_ENV,
    AUTHENTICATED_LINKEDIN_ORPHAN_RECOVERY_PHASE: "apply",
    AUTHENTICATED_LINKEDIN_ORPHAN_EXPECTED_FINGERPRINT:
      inspected.fingerprint
  });
  const client = fakeClient();
  client.rpc = (name, parameters) => {
    client.calls.push({ kind: "rpc", name, parameters });
    return Promise.resolve({ data: true, error: null });
  };
  await assert.rejects(
    runAuthenticatedLinkedInOrphanRecovery(
      client,
      applyRequest,
      dependencies()
    ),
    /owner\/token-fenced release transport was not abortable/
  );
});

test("recovery CLI has a fixed redacted failure surface", () => {
  const source = readFileSync(
    path.join(
      repositoryRoot,
      "scripts",
      "recover-authenticated-linkedin-orphan.mjs"
    ),
    "utf8"
  );
  assert.match(source, /failed closed/);
  assert.doesNotMatch(source, /console\.(?:log|error)/);
  assert.doesNotMatch(
    source,
    /JSON\.stringify\([^)]*(?:lease|token|owner)/i
  );
});

test("recovery workflow is main-bound, serialized, and cannot ingest", () => {
  assert.match(recoveryWorkflow, /on:\s*\n\s*workflow_dispatch:/);
  assert.match(
    recoveryWorkflow,
    /runs-on: \[self-hosted, macOS, ARM64, returner-social, returner-auth-browser\]/
  );
  assert.match(
    recoveryWorkflow,
    /if: github\.ref == 'refs\/heads\/main' && github\.ref_type == 'branch'/
  );
  assert.match(
    recoveryWorkflow,
    /concurrency:[\s\S]*?group: autonomous-ingestion-main[\s\S]*?cancel-in-progress: false/
  );
  assert.match(
    recoveryWorkflow,
    /ref: \$\{\{ github\.sha \}\}/
  );
  const preflightIndex = recoveryWorkflow.indexOf(
    "Preflight authenticated LinkedIn runner"
  );
  const recoveryIndex = recoveryWorkflow.indexOf(
    "Inspect or release exact orphan lease only"
  );
  assert.ok(preflightIndex >= 0 && preflightIndex < recoveryIndex);
  assert.match(
    recoveryWorkflow,
    /AUTHENTICATED_SOCIAL_PREFLIGHT_PASSED: \$\{\{ steps\.authenticated_social_preflight\.outcome == 'success'[\s\S]*?authenticated_backfill_target_company_slug == inputs\.company_slug \}\}/
  );
  assert.match(
    recoveryWorkflow,
    /node scripts\/recover-authenticated-linkedin-orphan\.mjs/
  );
  assert.doesNotMatch(
    recoveryWorkflow,
    /(?:run-autonomous-ingestion|collect-s2026-linkedin-checkpoints|fetch-logged-in-social-traction|contents:\s*write|git\s+push)/
  );
});
