import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  S26_CHECKPOINT_EXPECTED_INVENTORY,
  S2026_CHECKPOINT_EXPECTED_INVENTORY,
  authenticatedSocialReplayRoot,
  buildS2026CollectorEnvironment,
  checkpointChunkLimit,
  runS2026CheckpointCollection,
  s2026CollectorArguments,
  validateS2026CheckpointCollectionRequest,
  verifyS2026CheckpointDelta
} from "../scripts/collect-s2026-linkedin-checkpoints.mjs";
import {
  parseAuthenticatedMacFullWakeState,
  readAuthenticatedLinkedInChunkAdmission
} from "../scripts/lib/autonomous-ingestion-power-watchdog.mjs";
import {
  createSupabaseExpiringGlobalLeaseProvider
} from "../scripts/lib/logged-in-linkedin-collection.mjs";

const SOURCE_SHA = "a".repeat(40);

function requestEnvironment({ batch = "S26", keySuffix = "001", root } = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "1",
    CANDIDATE_TRIGGER: "manual-replay",
    INGESTION_IDEMPOTENCY_KEY:
      `incident-20260913-${batch.toLowerCase()}-linkedin-backlog-${keySuffix}`,
    AUTHENTICATED_SOCIAL_REPLAY: "true",
    AUTHENTICATED_BACKFILL_SCOPE: "linkedin",
    AUTHENTICATED_BACKFILL_BATCH: batch,
    AUTHENTICATED_BACKFILL_COMPANY_SLUG: "",
    RECOVER_AUTHENTICATED_LINKEDIN_LOCK: "false",
    INCIDENT_LINKEDIN_CHECKPOINT_ONLY: "true",
    INCIDENT_S2026_LINKEDIN_BACKLOG_BATTERY_OVERRIDE: "true",
    INCIDENT_ZENBU_BATTERY_OVERRIDE: "false",
    AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_RESERVE_PERCENT: "5",
    AUTONOMOUS_WORKFLOW_POWER_WATCHDOG_INTERVAL_SECONDS: "30",
    SOURCE_SHA,
    INCIDENT_LINKEDIN_EXPECTED_CHECKPOINT_SHA256: "b".repeat(64),
    INCIDENT_LINKEDIN_EXPECTED_REMAINING: batch === "S26" ? "672" : "566",
    LINKEDIN_GLOBAL_LOCK_NAMESPACE:
      "returner-fund-production-linkedin-allen-xu-v1",
    OPENCLI_HOME: root ?? "/private/tmp/opencli-test-home",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role"
  };
}

test("checkpoint request is exact, batch-bound, first-attempt, and excludes key 000", () => {
  for (const batch of ["S26", "S2026"]) {
    assert.equal(validateS2026CheckpointCollectionRequest(
      requestEnvironment({ batch })
    ).batch, batch);
  }
  for (const mutate of [
    (value) => { value.GITHUB_RUN_ATTEMPT = "2"; },
    (value) => { value.AUTHENTICATED_BACKFILL_SCOPE = "all"; },
    (value) => { value.AUTHENTICATED_BACKFILL_BATCH = "S25"; },
    (value) => { value.INGESTION_IDEMPOTENCY_KEY =
      "incident-20260913-s26-linkedin-backlog-000"; },
    (value) => { value.INGESTION_IDEMPOTENCY_KEY =
      "incident-20260913-s2026-linkedin-backlog-001"; },
    (value) => { value.INCIDENT_ZENBU_BATTERY_OVERRIDE = "true"; }
  ]) {
    const environment = requestEnvironment({ batch: "S26" });
    mutate(environment);
    assert.throws(() => validateS2026CheckpointCollectionRequest(environment));
  }
});

test("collector arguments preserve one worker, five targets, and 30-second pacing", () => {
  const args = s2026CollectorArguments({
    batch: "S26",
    checkpointPath: "/private/tmp/checkpoint.json",
    outputPath: "/private/tmp/output.json"
  });
  assert.ok(args.includes("--batch=S26"));
  assert.ok(args.includes("--workers=1"));
  assert.ok(args.includes("--linkedin-max-targets=5"));
  assert.ok(args.includes("--delay-ms=30000"));
  assert.ok(args.includes("--terminal-completed-platforms=linkedin"));
  assert.ok(!args.includes("--finalize-only"));
  const finalizeArgs = s2026CollectorArguments({
    batch: "S2026",
    checkpointPath: "/private/tmp/checkpoint.json",
    outputPath: "/private/tmp/output.json",
    finalizeOnly: true
  });
  assert.ok(finalizeArgs.includes("--finalize-only"));
  assert.throws(() => s2026CollectorArguments({
    checkpointPath: "/private/tmp/checkpoint.json",
    outputPath: "/private/tmp/output.json",
    plan: true,
    finalizeOnly: true
  }));
});

test("collector child environment excludes publication and unrelated credentials", () => {
  const child = buildS2026CollectorEnvironment({
    ...requestEnvironment(),
    GITHUB_TOKEN: "github-secret",
    X_BEARER_TOKEN: "x-secret",
    EXA_API_KEY: "search-secret",
    OPENCLI_HOME: "/private/tmp/opencli"
  }, "/private/tmp/repository");
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.X_BEARER_TOKEN, undefined);
  assert.equal(child.EXA_API_KEY, undefined);
  assert.equal(child.SUPABASE_SERVICE_ROLE_KEY, "test-service-role");
  assert.equal(child.OPENCLI_HOME, "/private/tmp/opencli");
  assert.equal(child.SCORING_DATA_ROOT, "/private/tmp/repository");
});

test("pinned inventory contracts cover both live 2026 cohorts", () => {
  assert.deepEqual(
    [
      S26_CHECKPOINT_EXPECTED_INVENTORY.targetCount,
      S26_CHECKPOINT_EXPECTED_INVENTORY.quarantinedTargetCount,
      S2026_CHECKPOINT_EXPECTED_INVENTORY.targetCount,
      S2026_CHECKPOINT_EXPECTED_INVENTORY.quarantinedTargetCount
    ],
    [672, 4, 568, 4]
  );
});

test("checkpoint delta rejects collision or any other non-selected mutation", () => {
  const beforePlan = { remaining: 3, selectedKeys: ["selected"] };
  const afterPlan = { remaining: 2 };
  assert.deepEqual(verifyS2026CheckpointDelta({
    beforeCheckpoint: { attempts: {} },
    afterCheckpoint: { attempts: { selected: { status: "done" } } },
    beforePlan,
    afterPlan
  }).completedCount, 1);
  assert.throws(() => verifyS2026CheckpointDelta({
    beforeCheckpoint: { attempts: {} },
    afterCheckpoint: {
      attempts: {
        selected: { status: "done" },
        "collision-quarantined": { status: "done" }
      }
    },
    beforePlan,
    afterPlan
  }), /outside the selected targets/);
  assert.throws(() => verifyS2026CheckpointDelta({
    beforeCheckpoint: { attempts: {} },
    afterCheckpoint: { attempts: { selected: { status: "failed" } } },
    beforePlan,
    afterPlan
  }), /not terminally done/);
});

test("any battery-admitted child permanently lowers the run cap to four", () => {
  const ac = { admitted: true, fullWake: true, externalConnected: true };
  const battery = { admitted: true, fullWake: true, externalConnected: false };
  assert.equal(checkpointChunkLimit(ac, 4).maximum, 12);
  assert.equal(checkpointChunkLimit(battery, 3).admitted, true);
  assert.equal(checkpointChunkLimit(ac, 4, { batteryEverAdmitted: true }).admitted, false);
  assert.equal(checkpointChunkLimit(battery, 4).admitted, false);
  assert.throws(() => checkpointChunkLimit({ ...ac, fullWake: false }, 0));
});

test("full-wake parser and composed child admission fail closed", async () => {
  assert.equal(parseAuthenticatedMacFullWakeState(
    '"IOPMUserTriggeredFullWake" = Yes'
  ), true);
  assert.equal(parseAuthenticatedMacFullWakeState(
    '"IOPMUserTriggeredFullWake" = No'
  ), false);
  assert.equal(parseAuthenticatedMacFullWakeState("unrelated"), null);
  const admission = await readAuthenticatedLinkedInChunkAdmission({
    floorPercent: 5,
    readPowerStatus: async () => ({ onACPower: true, batteryPercent: 80 }),
    readAuthenticatedPowerState: async () => ({
      externalConnected: true,
      clamshellOpen: true
    }),
    readFullWakeState: async () => false
  });
  assert.equal(admission.admitted, false);
  assert.equal(admission.reason, "authenticated_full_wake_inactive");
});

test("durable intent reconciles partial progress and completed key is idempotent", async () => {
  const openCliHome = await mkdtemp(path.join(tmpdir(), "checkpoint-lane-test-"));
  const environment = requestEnvironment({ root: openCliHome });
  const stateRoot = authenticatedSocialReplayRoot(openCliHome);
  const checkpointPath = path.join(stateRoot, "logged-in-checkpoint-s26.json");
  const outputPath = path.join(stateRoot, "logged-in-s26.json");
  await mkdir(stateRoot, { recursive: true });
  const initialCheckpoint = {
    attempts: {},
    evidence: [],
    needsReview: [],
    attributionReconciliationLedger: []
  };
  const initialCheckpointBytes = `${JSON.stringify(initialCheckpoint)}\n`;
  await writeFile(checkpointPath, initialCheckpointBytes);
  environment.INCIDENT_LINKEDIN_EXPECTED_CHECKPOINT_SHA256 =
    createHash("sha256").update(initialCheckpointBytes).digest("hex");
  environment.INCIDENT_LINKEDIN_EXPECTED_REMAINING = "26";
  const targets = Array.from({ length: 26 }, (_, index) => ({
    batchSlug: "S26",
    companySlug: `company-${index}`,
    companyName: `Company ${index}`,
    entityType: "company",
    entityId: `company:company-${index}`,
    entityName: `Company ${index}`,
    platform: "linkedin",
    accountUrl: `https://www.linkedin.com/company/company-${index}/`,
    activityUrl: `https://www.linkedin.com/company/company-${index}/posts/`,
    checkpointKey: `S26:company:company-${index}:linkedin`
  }));
  const canonicalInventory = targets.map((target) => ({
    checkpointKey: target.checkpointKey,
    batchSlug: target.batchSlug,
    companySlug: target.companySlug,
    companyName: target.companyName,
    entityType: target.entityType,
    entityId: target.entityId,
    entityName: target.entityName,
    platform: target.platform,
    accountUrl: target.accountUrl,
    activityUrl: target.activityUrl
  })).sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey));
  const expectedInventory = {
    batchSlug: "S26",
    catalogCompanyCount: 26,
    companyCount: 26,
    founderCount: 0,
    targetCount: 26,
    quarantinedTargetCount: 0,
    collisionCount: 0,
    collisionTargetCount: 0,
    inventorySha256: hashJson(canonicalInventory),
    collisionSha256: hashJson([])
  };
  const readCheckpoint = async () => {
    try {
      return JSON.parse(await readFile(checkpointPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return structuredClone(initialCheckpoint);
      }
      throw error;
    }
  };
  const writeArtifacts = async (keys) => {
    const checkpoint = await readCheckpoint();
    for (const key of keys) checkpoint.attempts[key] = { status: "done" };
    checkpoint.evidence = Object.keys(checkpoint.attempts)
      .filter((key) => checkpoint.attempts[key].status === "done")
      .map((key) => ({ id: key }));
    checkpoint.needsReview = [];
    checkpoint.attributionReconciliationLedger = [];
    const output = {
      // The production output is score-sorted while the checkpoint preserves
      // collection order. The controller must compare their row multisets,
      // not require an order that the collector deliberately does not retain.
      evidence: [...checkpoint.evidence].reverse(),
      needsReview: checkpoint.needsReview,
      attributionReconciliationLedger: checkpoint.attributionReconciliationLedger
    };
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
    await writeFile(outputPath, `${JSON.stringify(output)}\n`);
  };
  const readPlan = async () => {
    const checkpoint = await readCheckpoint();
    const remainingTargets = targets.filter(
      (target) => checkpoint.attempts[target.checkpointKey]?.status !== "done"
    );
    const runnableTargets = remainingTargets.slice(0, 5);
    const selected = runnableTargets.length;
    return {
      batchSlug: "S26",
      requestedTarget: null,
      catalogCompanyCount: 26,
      companyCount: 26,
      founderCount: 0,
      linkedinCollectionMode: "browser",
      quarantinedTargetCount: 0,
      ownerAccountCollisions: [],
      remainingTargetCount: remainingTargets.length,
      selectedForThisInvocationCount: selected,
      runnableTargetCount: selected,
      runnableTargets,
      targets,
      linkedinExecution: {
        workers: 1,
        serial: true,
        persistentHostPacing: true,
        delayMs: 30_000,
        targetCap: 5,
        maximumTargetCap: 5,
        remainingTargetCount: remainingTargets.length,
        selectedForThisInvocationCount: selected
      }
    };
  };
  const dependencies = {
    environment,
    cwd: process.cwd(),
    expectedInventory,
    readPlan,
    assertPinnedMain: async () => undefined,
    readPowerAdmission: async () => ({
      admitted: true,
      fullWake: true,
      externalConnected: false
    }),
    startWatchdog: () => ({ stop: async () => undefined }),
    withControllerLock: async (operation) => operation({
      signal: new AbortController().signal,
      assertHealthy: () => undefined
    })
  };
  try {
    let firstAttempt = true;
    await assert.rejects(runS2026CheckpointCollection({
      ...dependencies,
      runCollector: async () => {
        const plan = await readPlan();
        if (firstAttempt) {
          firstAttempt = false;
          await writeArtifacts(plan.runnableTargets.slice(0, 1).map(
            (target) => target.checkpointKey
          ));
          throw new Error("simulated process interruption");
        }
        throw new Error("unexpected first-run collector retry");
      }
    }), /simulated process interruption/);

    let collectorsAfterRestart = 0;
    const recovered = await runS2026CheckpointCollection({
      ...dependencies,
      finalizeOutput: async () => {
        await writeArtifacts([]);
        return { exitCode: 0, terminated: null };
      },
      runCollector: async () => {
        collectorsAfterRestart += 1;
        const plan = await readPlan();
        await writeArtifacts(plan.runnableTargets.map((target) => target.checkpointKey));
        return { exitCode: 0, terminated: null };
      }
    });
    assert.equal(collectorsAfterRestart, 1);
    assert.equal(recovered.receipt.progress.beforeRemaining, 26);
    assert.equal(recovered.receipt.progress.afterRemaining, 20);
    assert.equal(recovered.receipt.progress.completedTargets, 6);
    assert.equal(recovered.receipt.progress.chunksCompleted, 2);
    assert.equal(recovered.receipt.safety.scrollPassesPerTarget, 30);
    assert.equal(recovered.receipt.safety.postLimitPerTarget, 100);
    assert.equal(recovered.receipt.chunks[0].recoveredFromDurableIntent, true);

    const replayed = await runS2026CheckpointCollection({
      ...dependencies,
      runCollector: async () => {
        throw new Error("completed idempotency key collected twice");
      }
    });
    assert.deepEqual(replayed.receipt, recovered.receipt);

    const statePath = path.join(
      stateRoot,
      "checkpoint-collection-runs",
      `${environment.INGESTION_IDEMPOTENCY_KEY}.json`
    );
    const [sealedStateBytes, sealedOutputBytes] = await Promise.all([
      readFile(statePath, "utf8"),
      readFile(outputPath, "utf8")
    ]);
    const runningState = JSON.parse(sealedStateBytes);
    runningState.status = "running";
    delete runningState.receipt;
    await writeFile(statePath, `${JSON.stringify(runningState)}\n`);
    const driftedOutput = JSON.parse(sealedOutputBytes);
    driftedOutput.unexpectedExternalMutation = true;
    await writeFile(outputPath, `${JSON.stringify(driftedOutput)}\n`);
    await assert.rejects(
      runS2026CheckpointCollection({ ...dependencies }),
      /Checkpoint state changed outside its durable per-key controller intent/
    );
    await Promise.all([
      writeFile(statePath, sealedStateBytes),
      writeFile(outputPath, sealedOutputBytes)
    ]);

    const driftedCheckpoint = await readCheckpoint();
    driftedCheckpoint.unexpectedExternalMutation = true;
    await writeFile(checkpointPath, `${JSON.stringify(driftedCheckpoint)}\n`);
    await assert.rejects(
      runS2026CheckpointCollection({
        ...dependencies,
        runCollector: async () => {
          throw new Error("completed idempotency key collected after drift");
        }
      }),
      /Completed checkpoint collection state no longer matches the live checkpoint, output, and plan/
    );
  } finally {
    await rm(openCliHome, { recursive: true, force: true });
  }
});

test("collector installs cooperative signal cleanup inside the durable account lock", async () => {
  const source = await readFile(
    new URL("../scripts/fetch-logged-in-social-traction.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /createLinkedInGracefulShutdown\(\)/);
  assert.match(source, /AbortSignal\.any\(\[/);
  assert.match(source, /withLinkedInAccountLock\([\s\S]*gracefulShutdown\.close\(\)/);
  assert.match(source, /collectionGuard\?\.signal\?\.aborted/);
});

test("controller lease uses the expiry-reclaiming runtime-lock RPC", async () => {
  const calls = [];
  const provider = createSupabaseExpiringGlobalLeaseProvider({
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      if (name === "claim_ingestion_runtime_lock") {
        return { data: [{ lease_token: "controller-lease-token" }], error: null };
      }
      return { data: true, error: null };
    }
  });
  const lease = await provider.claim({
    lockKey: "controller-key",
    ownerId: "controller-owner",
    leaseDurationMs: 20 * 60_000,
    metadata: { controller: true }
  });
  assert.deepEqual(lease, { leaseToken: "controller-lease-token" });
  assert.equal(calls[0].name, "claim_ingestion_runtime_lock");
  assert.equal(calls[0].parameters.p_lease_duration, "1200 seconds");
  assert.equal(await provider.renew({
    lockKey: "controller-key",
    ownerId: "controller-owner",
    leaseToken: lease.leaseToken,
    leaseDurationMs: 20 * 60_000
  }), true);
  assert.equal(await provider.release({
    lockKey: "controller-key",
    ownerId: "controller-owner",
    leaseToken: lease.leaseToken
  }), true);

  const migration = await readFile(
    new URL("../supabase/migrations/008_autonomous_ingestion_runtime.sql", import.meta.url),
    "utf8"
  );
  assert.match(
    migration,
    /claim_ingestion_runtime_lock[\s\S]*?on conflict \(lock_key\) do update[\s\S]*?where runtime_lock\.lease_expires_at <= clock_timestamp\(\)/
  );
  const controllerSource = await readFile(
    new URL("../scripts/collect-s2026-linkedin-checkpoints.mjs", import.meta.url),
    "utf8"
  );
  assert.match(controllerSource, /createSupabaseExpiringGlobalLeaseProvider\(client\)/);
  assert.doesNotMatch(controllerSource, /createSupabaseLinkedInGlobalLeaseProvider\(client\)/);
});

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
