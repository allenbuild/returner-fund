import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  recoverAuthenticatedLinkedInSafetyQuarantine,
  validateAuthenticatedLinkedInLockRecoveryRequest
} from "../scripts/lib/authenticated-linkedin-lock-recovery.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(repositoryRoot, ".github", "workflows", "autonomous-ingestion.yml"),
  "utf8"
);
const recoveryScript = readFileSync(
  path.join(repositoryRoot, "scripts", "recover-authenticated-linkedin-lock.mjs"),
  "utf8"
);
const LOCK_KEY = "authenticated-linkedin:returner-fund-production-linkedin-allen-xu-v1";
const OWNER_ID = "d3f5cd12-b6c0-4510-ab2d-a44a2b72a9b8";
const LEASE_TOKEN = "4b611339-9d5c-43d3-9b35-b47e5fe3e068";
const VALID_ENV = Object.freeze({
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  RECOVER_AUTHENTICATED_LINKEDIN_LOCK: "true",
  AUTHENTICATED_SOCIAL_PREFLIGHT_PASSED: "true",
  AUTHENTICATED_SOCIAL_REPLAY: "true",
  AUTHENTICATED_BACKFILL_SCOPE: "linkedin",
  AUTHENTICATED_BACKFILL_BATCH: "S26",
  AUTHENTICATED_BACKFILL_COMPANY_SLUG: "gamgee",
  LINKEDIN_GLOBAL_LOCK_NAMESPACE: "returner-fund-production-linkedin-allen-xu-v1"
});

function safetyQuarantineRow(overrides = {}) {
  return {
    lock_key: LOCK_KEY,
    owner_id: OWNER_ID,
    lease_token: LEASE_TOKEN,
    heartbeat_at: "2026-09-11T19:10:24.000Z",
    lease_expires_at: "2027-09-11T19:10:24.000Z",
    updated_at: "2026-09-11T19:10:24.000Z",
    metadata_json: {
      collector: "authenticated-linkedin",
      manualRecoveryRequired: true,
      safetyQuarantine: "unproven-browser-session-cleanup",
      quarantinedAt: "2026-09-11T19:10:24.000Z"
    },
    ...overrides
  };
}

function fakeClient({ initialRow = safetyQuarantineRow(), rpcResult = true, finalRow = null } = {}) {
  const calls = [];
  let lookup = 0;
  return {
    calls,
    from(table) {
      const call = { kind: "query", table, columns: null, filters: [] };
      const builder = {
        select(columns) {
          call.columns = columns;
          return builder;
        },
        eq(column, value) {
          call.filters.push([column, value]);
          return builder;
        },
        maybeSingle() {
          calls.push(call);
          const data = lookup === 0 ? initialRow : finalRow;
          lookup += 1;
          return Promise.resolve({ data, error: null });
        }
      };
      return builder;
    },
    rpc(name, parameters) {
      calls.push({ kind: "rpc", name, parameters });
      return Promise.resolve({ data: rpcResult, error: null });
    }
  };
}

test("manual recovery request is bound to a preflighted exact LinkedIn target and lock key", () => {
  assert.deepEqual(validateAuthenticatedLinkedInLockRecoveryRequest(VALID_ENV), {
    lockKey: LOCK_KEY,
    requestedTarget: {
      batchSlug: "S26",
      companySlug: "gamgee"
    }
  });

  for (const [field, value] of [
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_EVENT_NAME", "schedule"],
    ["RECOVER_AUTHENTICATED_LINKEDIN_LOCK", "false"],
    ["AUTHENTICATED_SOCIAL_PREFLIGHT_PASSED", "false"],
    ["AUTHENTICATED_SOCIAL_REPLAY", "false"],
    ["AUTHENTICATED_BACKFILL_SCOPE", "all"],
    ["AUTHENTICATED_BACKFILL_BATCH", "all"],
    ["AUTHENTICATED_BACKFILL_COMPANY_SLUG", ""],
    ["LINKEDIN_GLOBAL_LOCK_NAMESPACE", ""]
  ]) {
    assert.throws(
      () => validateAuthenticatedLinkedInLockRecoveryRequest({ ...VALID_ENV, [field]: value }),
      /Authenticated LinkedIn lock recovery/
    );
  }
});

test("recovery reads one exact row, releases by exact owner and token RPC, then verifies deletion", async () => {
  const client = fakeClient();
  const result = await recoverAuthenticatedLinkedInSafetyQuarantine(client, { lockKey: LOCK_KEY });

  assert.deepEqual(client.calls.map((call) => call.kind), ["query", "rpc", "query"]);
  assert.deepEqual(client.calls[0].filters, [["lock_key", LOCK_KEY]]);
  assert.deepEqual(client.calls[1], {
    kind: "rpc",
    name: "release_ingestion_runtime_lock",
    parameters: {
      p_lock_key: LOCK_KEY,
      p_owner_id: OWNER_ID,
      p_lease_token: LEASE_TOKEN
    }
  });
  assert.deepEqual(client.calls[2].filters, [["lock_key", LOCK_KEY]]);
  assert.deepEqual(result, {
    status: "released",
    lockKey: LOCK_KEY,
    collector: "authenticated-linkedin",
    safetyQuarantine: "unproven-browser-session-cleanup",
    quarantinedAt: "2026-09-11T19:10:24.000Z"
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(LEASE_TOKEN));
});

test("recovery refuses any row without every safety-quarantine proof before calling release", async () => {
  const invalidRows = [
    null,
    safetyQuarantineRow({ lock_key: `${LOCK_KEY}-other` }),
    safetyQuarantineRow({ owner_id: "" }),
    safetyQuarantineRow({ lease_token: "not-a-uuid" }),
    safetyQuarantineRow({ metadata_json: { ...safetyQuarantineRow().metadata_json, collector: "other" } }),
    safetyQuarantineRow({ metadata_json: { ...safetyQuarantineRow().metadata_json, manualRecoveryRequired: false } }),
    safetyQuarantineRow({ metadata_json: { ...safetyQuarantineRow().metadata_json, safetyQuarantine: "unknown" } }),
    safetyQuarantineRow({ metadata_json: { ...safetyQuarantineRow().metadata_json, quarantinedAt: "invalid" } })
  ];

  for (const initialRow of invalidRows) {
    const client = fakeClient({ initialRow });
    await assert.rejects(
      recoverAuthenticatedLinkedInSafetyQuarantine(client, { lockKey: LOCK_KEY }),
      /Authenticated LinkedIn lock recovery/
    );
    assert.equal(client.calls.some((call) => call.kind === "rpc"), false);
  }
});

test("recovery fails closed when exact release or post-delete verification is not confirmed", async () => {
  const rejectedRelease = fakeClient({ rpcResult: false });
  await assert.rejects(
    recoverAuthenticatedLinkedInSafetyQuarantine(rejectedRelease, { lockKey: LOCK_KEY }),
    /exact owner-bound release was not confirmed/
  );
  assert.equal(rejectedRelease.calls.length, 2);

  const survivingRow = fakeClient({ finalRow: safetyQuarantineRow() });
  await assert.rejects(
    recoverAuthenticatedLinkedInSafetyQuarantine(survivingRow, { lockKey: LOCK_KEY }),
    /could not verify exact lock deletion/
  );
});

test("workflow exposes no automatic recovery path and runs recovery only after browser preflight", () => {
  assert.match(
    workflow,
    /recover_authenticated_linkedin_lock:[\s\S]*?default:\s*false[\s\S]*?type:\s*boolean/
  );
  const ingestJob = workflow.match(/\n  ingest:[\s\S]*?(?=\n  receipt:)/)?.[0] ?? "";
  const preflightIndex = ingestJob.indexOf("Preflight authenticated social runner");
  const recoveryIndex = ingestJob.indexOf("Recover proven authenticated LinkedIn safety quarantine");
  const ingestionIndex = ingestJob.indexOf("Run autonomous ingestion");
  assert.ok(preflightIndex >= 0 && preflightIndex < recoveryIndex);
  assert.ok(recoveryIndex < ingestionIndex);

  const step = ingestJob.match(
    /- name: Recover proven authenticated LinkedIn safety quarantine[\s\S]*?(?=\n\s{6}- name:|$)/
  )?.[0] ?? "";
  assert.match(step, /github\.event_name == 'workflow_dispatch'/);
  assert.match(step, /needs\.resolve\.outputs\.trigger == 'manual-replay'/);
  assert.match(step, /inputs\.recover_authenticated_linkedin_lock == true/);
  assert.match(step, /AUTHENTICATED_SOCIAL_PREFLIGHT_PASSED:\s*\$\{\{ steps\.authenticated_social_preflight\.outcome == 'success' \}\}/);
  assert.match(step, /AUTHENTICATED_SOCIAL_REPLAY:/);
  assert.match(step, /AUTHENTICATED_BACKFILL_SCOPE:/);
  assert.match(step, /AUTHENTICATED_BACKFILL_BATCH:/);
  assert.match(step, /AUTHENTICATED_BACKFILL_COMPANY_SLUG:/);
  assert.match(step, /LINKEDIN_GLOBAL_LOCK_NAMESPACE:\s*returner-fund-production-linkedin-allen-xu-v1/);
  assert.match(step, /node scripts\/recover-authenticated-linkedin-lock\.mjs/);
  assert.match(
    ingestJob,
    /name: Run autonomous ingestion[\s\S]*?inputs\.recover_authenticated_linkedin_lock != true \|\| steps\.authenticated_linkedin_lock_recovery\.outcome == 'success'/
  );
});

test("the CLI emits only a redacted result or fixed fail-closed message", () => {
  assert.doesNotMatch(recoveryScript, /console\.(?:log|error)/);
  assert.doesNotMatch(recoveryScript, /JSON\.stringify\([^)]*(?:lease|token|owner)/i);
  assert.match(recoveryScript, /Authenticated LinkedIn lock recovery failed closed\./);
});

test("transport failures cannot echo the lease token through recovery errors", async () => {
  const client = fakeClient();
  client.rpc = () => Promise.reject(new Error(`upstream echoed ${LEASE_TOKEN}`));
  await assert.rejects(
    recoverAuthenticatedLinkedInSafetyQuarantine(client, { lockKey: LOCK_KEY }),
    (error) => {
      assert.match(error.message, /owner-bound release failed closed/);
      assert.doesNotMatch(error.message, new RegExp(LEASE_TOKEN));
      return true;
    }
  );
});
