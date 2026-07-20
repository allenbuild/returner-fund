import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUTONOMOUS_BATCHES,
  AUTONOMOUS_PROCESS_BUDGETS,
  buildAutonomousTaskPlan,
  loadAutonomousCatalogs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  normalizeAutonomousFailureEntityId,
  summarizeTaskCoverage,
  validateAutonomousCollectorSnapshot
} from "./lib/autonomous-ingestion-plan.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const idempotencyKey = args.idempotencyKey ?? process.env.INGESTION_IDEMPOTENCY_KEY;
const workerId = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.pid}:${randomUUID()}`;
const runStartedAt = new Date();
const workRoot = join(root, "work", "autonomous-ingestion", safePathSegment(idempotencyKey ?? "missing"));
const publicOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(workRoot, `public-${batch.slug.toLowerCase()}.json`)])
);
const githubOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(workRoot, `github-${batch.slug.toLowerCase()}.json`)])
);
const topVoiceOutput = join(workRoot, "top-voice-refresh.json");

if (!idempotencyKey) {
  throw new Error("--idempotency-key or INGESTION_IDEMPOTENCY_KEY is required.");
}

const url = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
const durableStorageConfigured = Boolean(url && serviceKey);

await mkdir(workRoot, { recursive: true });
const catalogs = await loadAutonomousCatalogs(root);
const plannedTasks = buildAutonomousTaskPlan(catalogs, { runKey: idempotencyKey });
const plannedTaskByCheckpointKey = new Map(plannedTasks.map((task) => [task.checkpointKey, task]));
const plannedCoverage = summarizeTaskCoverage(plannedTasks);

if (args.plan) {
  console.log(JSON.stringify({ idempotencyKey, batches: catalogSummary(catalogs), coverage: plannedCoverage }, null, 2));
  process.exit(0);
}

const supabase = durableStorageConfigured
  ? createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { "X-Client-Info": "returner-autonomous-ingestion" } }
    })
  : null;

let runtimeLock = null;
let run = null;
let heartbeatTimer = null;
let hardFailure = null;
let heartbeatFailure = null;

try {
  if (durableStorageConfigured) {
    runtimeLock = await claimRuntimeLock();
    if (!runtimeLock) {
      throw new Error("Another ingestion coordinator owns the non-expired autonomous-ingestion lease.");
    }
    run = await getOrCreateRun();
  } else {
    const missing = [
      !url ? "NEXT_PUBLIC_SUPABASE_URL" : null,
      !serviceKey ? "SUPABASE_SERVICE_ROLE_KEY" : null
    ].filter(Boolean);
    console.warn(
      `Durable Supabase import skipped because optional configuration is incomplete (${missing.join(", ")}). ` +
      "File-backed collection and publication will continue."
    );
  }
  if (run?.status === "completed") {
    console.log(`Ingestion ${idempotencyKey} already completed as run ${run.id}; replay is a no-op.`);
    process.exitCode = 0;
  } else {
    if (durableStorageConfigured) {
      heartbeatTimer = setInterval(() => void heartbeat().catch(failHeartbeat), 60_000);
      heartbeatTimer.unref?.();
    }
    await event("run.started", "info", "Autonomous ingestion run started.", {
      workerId,
      durability: durableStorageConfigured ? "supabase" : "file_backed",
      plannedCoverage,
      catalogs: catalogSummary(catalogs)
    });

    const catalogState = durableStorageConfigured ? await syncCatalogs(catalogs) : null;
    if (catalogState) {
      await enqueueTasks(plannedTasks, catalogState);
      await event("inventory.completed", "info", "Canonical entity/account inventory and task plan persisted.", {
        companies: catalogState.companyByBatchSourceKey.size,
        founders: catalogState.founderBySourceKey.size,
        accounts: catalogState.accountBySourceKey.size,
        tasks: plannedTasks.length
      });
    } else {
      await event(
        "inventory.skipped",
        "warning",
        "Durable inventory and task persistence were skipped; collection is using the validated file catalog.",
        { reason: "supabase_not_configured" }
      );
    }

    const [collectionResults, topVoiceRefresh] = args.skipNetwork
      ? [[], null]
      : await Promise.all([runCollectors(), runTopVoiceCollector()]);
    assertLeaseHealthy();
    if (args.skipNetwork && run) {
      await terminalizeQueuedTasks(run.id, "skipped", "network_collection_explicitly_skipped");
    } else if (catalogState) {
      await reconcileCollectorTasks(collectionResults, catalogState);
    }

    const successfulCollectorResults = collectionResults.filter((result) => result.ok);
    const publicSnapshots = await readAvailableSnapshots(
      successfulCollectorResults.filter((result) => result.kind === "public")
    );
    const githubSnapshots = await readAvailableSnapshots(
      successfulCollectorResults.filter((result) => result.kind === "github")
    );
    const collectionCoverage = await summarizeCollectionCoverage(
      plannedTasks,
      collectionResults,
      { skipNetwork: args.skipNetwork }
    );
    assertSuccessfulCollection(collectionResults, collectionCoverage);
    assertSuccessfulTopVoiceRefresh(topVoiceRefresh);
    const previousPublicSnapshot = await readJson(
      join(root, "src", "lib", "social", "public-evidence-current.json"),
      null
    );
    const mergedPublicSnapshot = publicSnapshots.length > 0
      ? mergePublicEvidenceSnapshots(
          [previousPublicSnapshot, ...publicSnapshots].filter(Boolean),
          { durableStorageConfigured }
        )
      : null;

    const durableImport = await importDurableEvidence({
      publicSnapshots,
      githubSnapshots,
      catalogState
    });
    if (durableImport.status === "completed") {
      await event(
        "evidence.imported",
        "info",
        "Collected evidence was validated and imported into durable storage.",
        durableImport
      );
    } else {
      await event(
        "evidence.import_skipped",
        "warning",
        "Durable evidence import was skipped; collected snapshots remain file-backed.",
        durableImport
      );
    }
    assertLeaseHealthy();

    const prePublishCoverage = catalogState
      ? await persistCoverage(catalogState, durableImport)
      : { ...collectionCoverage, stageCounters: durableImport };
    if (prePublishCoverage.nonTerminal > 0) {
      throw new Error(`${prePublishCoverage.nonTerminal} ingestion tasks did not reach a terminal state.`);
    }

    assertLeaseHealthy();
    if (mergedPublicSnapshot) {
      await writeJsonAtomic(join(root, "src", "lib", "social", "public-evidence-current.json"), mergedPublicSnapshot);
    }
    await publishGithubExports(githubSnapshots);

    if (!args.skipPublish) {
      const publicationRunId = run?.id ?? `file:${idempotencyKey}`;
      await runCommand(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.productionBuildMs,
        label: "production build"
      });
      await runCommand(process.execPath, ["scripts/update-daily-benchmarks.mjs"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.benchmarkPublicationMs,
        label: "graph and benchmark publication",
        env: { INGESTION_RUN_ID: publicationRunId }
      });
      await runCommand(process.execPath, ["scripts/write-artifact-manifest.mjs", `--ingestion-run-id=${publicationRunId}`], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactManifestMs,
        label: "artifact manifest"
      });
      await runCommand(process.execPath, ["scripts/validate-public-artifacts.mjs"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
        label: "artifact validation"
      });
      if (run) {
        await persistArtifactManifest(run.id);
      } else {
        await event(
          "artifact_manifest.persistence_skipped",
          "warning",
          "Artifact manifest passed file validation but durable manifest persistence was skipped.",
          { reason: "supabase_not_configured", publicationRunId }
        );
      }
      await publishRepositoryArtifacts();
    }

    const finalCoverage = catalogState
      ? await persistCoverage(catalogState, durableImport)
      : prePublishCoverage;
    if (run) {
      await completeRun("completed", {
        ...finalCoverage,
        stageCounters: durableImport,
        finishedAt: new Date().toISOString()
      });
      await event("run.completed", "info", "Autonomous ingestion completed with every task terminal.", finalCoverage);
    } else {
      await event(
        "run.completed",
        "info",
        "File-backed autonomous ingestion completed; durable database completion was not recorded.",
        { ...finalCoverage, topVoiceRefresh }
      );
    }
    console.log(JSON.stringify({
      runId: run?.id ?? null,
      publicationRunId: run?.id ?? `file:${idempotencyKey}`,
      status: "completed",
      coverage: finalCoverage,
      durableImport,
      topVoiceRefresh
    }, null, 2));
  }
} catch (error) {
  hardFailure = error;
  const message = errorMessage(error);
  console.error(message);
  if (run?.id) {
    await event("run.failed", "error", message, { stack: error instanceof Error ? error.stack ?? null : null }).catch(() => {});
    await completeRun("failed", { error: message, failedAt: new Date().toISOString() }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (runtimeLock) {
    await releaseRuntimeLock().catch((error) => {
      console.error(`Failed to release ingestion lease: ${errorMessage(error)}`);
      if (!hardFailure) process.exitCode = 1;
    });
  }
}

async function claimRuntimeLock() {
  const { data, error } = await supabase.rpc("claim_ingestion_runtime_lock", {
    p_lock_key: "autonomous-ingestion",
    p_owner_id: workerId,
    p_lease_duration: "20 minutes",
    p_metadata_json: { idempotencyKey, startedAt: runStartedAt.toISOString() }
  });
  check(error, "claim runtime lock");
  return Array.isArray(data) ? data[0] ?? null : data;
}

async function releaseRuntimeLock() {
  const { data, error } = await supabase.rpc("release_ingestion_runtime_lock", {
    p_lock_key: runtimeLock.lock_key,
    p_owner_id: workerId,
    p_lease_token: runtimeLock.lease_token
  });
  check(error, "release runtime lock");
  if (data !== true) throw new Error("The ingestion runtime lock was lost before release.");
}

async function heartbeat() {
  if (!run || !runtimeLock) return;
  const now = new Date().toISOString();
  const { error: runError } = await supabase
    .from("ingestion_runs")
    .update({ heartbeat_at: now, lease_expires_at: new Date(Date.now() + 20 * 60_000).toISOString() })
    .eq("id", run.id)
    .eq("lease_token", run.lease_token);
  check(runError, "heartbeat ingestion run");
  const { data, error } = await supabase.rpc("renew_ingestion_runtime_lock", {
    p_lock_key: runtimeLock.lock_key,
    p_owner_id: workerId,
    p_lease_token: runtimeLock.lease_token,
    p_lease_duration: "20 minutes"
  });
  check(error, "heartbeat runtime lock");
  if (data !== true) throw new Error("The ingestion runtime lock expired or was taken by another worker.");
}

function failHeartbeat(error) {
  heartbeatFailure = error instanceof Error ? error : new Error(errorMessage(error));
  console.error(`Heartbeat failure: ${errorMessage(heartbeatFailure)}`);
  process.exitCode = 1;
}

function assertLeaseHealthy() {
  if (heartbeatFailure) {
    throw new Error(`Ingestion lease heartbeat failed; publication aborted: ${errorMessage(heartbeatFailure)}`);
  }
}

async function getOrCreateRun() {
  const existing = await selectMaybeSingle(
    supabase.from("ingestion_runs").select("*").eq("idempotency_key", idempotencyKey).limit(1),
    "read idempotent ingestion run"
  );
  if (existing?.status === "completed") return existing;
  if (existing) {
    const leaseToken = randomUUID();
    const { data, error } = await supabase
      .from("ingestion_runs")
      .update({
        status: "running",
        heartbeat_at: runStartedAt.toISOString(),
        lease_owner: workerId,
        lease_token: leaseToken,
        lease_expires_at: new Date(Date.now() + 20 * 60_000).toISOString()
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    check(error, "recover idempotent ingestion run lease");
    return data;
  }
  const leaseToken = randomUUID();
  const payload = {
    idempotency_key: idempotencyKey,
    status: "running",
    started_at: runStartedAt.toISOString(),
    heartbeat_at: runStartedAt.toISOString(),
    lease_owner: workerId,
    lease_token: leaseToken,
    lease_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    stats_json: { phase: "initializing" },
    logs: [`Started autonomous ingestion ${idempotencyKey}.`],
    errors_json: []
  };
  const { data, error } = await supabase.from("ingestion_runs").insert(payload).select("*").single();
  if (error?.code === "23505") {
    return selectSingle(
      supabase.from("ingestion_runs").select("*").eq("idempotency_key", idempotencyKey).limit(1),
      "recover concurrent ingestion run"
    );
  }
  check(error, "create ingestion run");
  return data;
}

async function event(eventType, severity, message, payload = {}, eventKey = null) {
  if (!supabase || !run?.id) {
    console.log(`[${severity}] ${eventType}: ${message}`);
    return;
  }
  const { error } = await supabase.from("ingestion_run_events").insert({
    ingestion_run_id: run.id,
    event_key: eventKey,
    event_type: eventType,
    severity,
    message,
    payload_json: payload
  });
  check(error, `record ${eventType} event`);
}

async function syncCatalogs(allCatalogs) {
  const batchBySlug = new Map();
  const companyBySourceKey = new Map();
  const companyByBatchSourceKey = new Map();
  const founderBySourceKey = new Map();
  const accountBySourceKey = new Map();

  for (const catalog of allCatalogs) {
    const { data: batch, error: batchError } = await supabase
      .from("batches")
      .upsert(
        { slug: catalog.slug, label: catalog.label, company_count_expected: catalog.companies.length },
        { onConflict: "slug" }
      )
      .select("id,slug")
      .single();
    check(batchError, `upsert batch ${catalog.slug}`);
    batchBySlug.set(catalog.slug, batch.id);

    const companyRows = catalog.companies.map((company) => ({
      batch_id: batch.id,
      source_key: company.sourceKey,
      yc_profile_url: company.profileUrl,
      name: company.name,
      website_url: company.websiteUrl,
      tagline: company.tagline,
      description: company.description,
      group_partner: company.groupPartner,
      review_state: normalizeReviewState(company.reviewState)
    }));
    const { data: companies, error: companyError } = await supabase
      .from("companies")
      .upsert(companyRows, { onConflict: "batch_id,source_key" })
      .select("id,source_key");
    check(companyError, `upsert companies for ${catalog.slug}`);
    for (const company of companies ?? []) {
      companyByBatchSourceKey.set(batchCompanyKey(catalog.slug, company.source_key), company.id);
      if (!companyBySourceKey.has(company.source_key)) companyBySourceKey.set(company.source_key, company.id);
    }

    const founderRows = catalog.companies.flatMap((company) =>
      company.founders.map((founder) => ({
        source_key: founder.sourceKey,
        name: founder.name,
        yc_profile_url: founder.profileUrl,
        personal_website_url: founder.websiteUrl,
        review_state: normalizeReviewState(founder.reviewState)
      }))
    );
    if (founderRows.length) {
      const { data: founders, error: founderError } = await supabase
        .from("founders")
        .upsert(founderRows, { onConflict: "source_key" })
        .select("id,source_key");
      check(founderError, `upsert founders for ${catalog.slug}`);
      for (const founder of founders ?? []) founderBySourceKey.set(founder.source_key, founder.id);
    }

    const joins = catalog.companies.flatMap((company) =>
      company.founders.map((founder) => ({
        company_id: companyByBatchSourceKey.get(batchCompanyKey(catalog.slug, company.sourceKey)),
        founder_id: founderBySourceKey.get(founder.sourceKey),
        review_state: "verified",
        source_url: company.profileUrl
      }))
    );
    if (joins.length) {
      const { error } = await supabase.from("company_founders").upsert(joins, { onConflict: "company_id,founder_id" });
      check(error, `upsert founder relationships for ${catalog.slug}`);
    }

    const accounts = catalog.companies.flatMap((company) => [
      ...company.accounts.map((account) => accountRow(
        account,
        "company",
        companyByBatchSourceKey.get(batchCompanyKey(catalog.slug, company.sourceKey))
      )),
      ...company.founders.flatMap((founder) =>
        founder.accounts.map((account) => accountRow(account, "founder", founderBySourceKey.get(founder.sourceKey)))
      )
    ]);
    if (accounts.length) {
      const { data, error } = await supabase
        .from("social_accounts")
        .upsert(accounts, { onConflict: "source_key" })
        .select("id,source_key");
      check(error, `upsert social accounts for ${catalog.slug}`);
      for (const account of data ?? []) accountBySourceKey.set(account.source_key, account.id);
    }
  }

  return { batchBySlug, companyBySourceKey, companyByBatchSourceKey, founderBySourceKey, accountBySourceKey };
}

function accountRow(account, entityType, entityId) {
  return {
    source_key: account.sourceKey,
    entity_type: entityType,
    entity_id: entityId,
    platform: account.platform,
    handle: account.handle,
    url: account.url,
    account_id: account.accountId,
    verified: account.verified,
    review_state: normalizeReviewState(account.reviewState),
    discovered_from_url: account.discoveredFromUrl,
    evidence_json: { matchReason: account.matchReason }
  };
}

async function enqueueTasks(tasks, catalogState) {
  const now = new Date().toISOString();
  const rows = tasks.map((task) => ({
    ingestion_run_id: run.id,
    batch_id: catalogState.batchBySlug.get(task.batchSlug),
    entity_type: task.entityType,
    entity_id:
      task.entityType === "company"
        ? catalogState.companyByBatchSourceKey.get(batchCompanyKey(task.batchSlug, task.entitySourceKey))
        : catalogState.founderBySourceKey.get(task.entitySourceKey),
    company_name: task.companyName,
    platform: task.platform,
    status: task.status,
    checkpoint_key: task.checkpointKey,
    max_attempts: AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts,
    priority: platformPriority(task.platform),
    terminal_at: task.status === "queued" ? null : now,
    terminal_reason: task.terminalReason,
    last_error_json: {},
    rate_limit_ms: platformDelay(task.platform)
  }));
  await mapWithConcurrency(chunks(rows, 250), 4, async (taskRows) => {
    const { error } = await supabase.from("ingestion_tasks").upsert(taskRows, { onConflict: "checkpoint_key" });
    check(error, "enqueue account/platform tasks");
  });
}

async function runCollectors() {
  await event("collection.started", "info", "Public collectors started in parallel.", {});
  const commands = [
    ...AUTONOMOUS_BATCHES.map(({ slug: batchSlug }) => ({
      kind: "public",
      batchSlug,
      outputPath: publicOutputs.get(batchSlug),
      run: () => runCommand(
        process.execPath,
        [
          "scripts/fetch-public-traction.mjs",
          `--batch=${batchSlug}`,
          "--social=all",
          "--workers=8",
          "--fresh-for-hours=11",
          `--output=${publicOutputs.get(batchSlug)}`,
          `--checkpoint=${join(workRoot, `checkpoint-public-${batchSlug.toLowerCase()}.json`)}`
        ],
        { timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.publicCollectorAttemptMs, label: `public ${batchSlug}` }
      )
    })),
    ...AUTONOMOUS_BATCHES.map((batch) => ({
      kind: "github",
      batchSlug: batch.slug,
      outputPath: githubOutputs.get(batch.slug),
      expectedSourcePath: batch.githubSourcePath,
      run: () => runCommand(
        process.execPath,
        [
          "scripts/fetch-github-traction.mjs",
          `--batch=${batch.slug}`,
          "--workers=8",
          `--output=${githubOutputs.get(batch.slug)}`
        ],
        { timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.githubCollectorAttemptMs, label: `github ${batch.slug}` }
      )
    }))
  ];
  for (const command of commands) command.promise = runCollectorWithRetries(command);
  const settled = await Promise.allSettled(commands.map((command) => command.promise));
  const results = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const result = settled[index];
    results.push({
      ...command,
      promise: undefined,
      ok: result.status === "fulfilled",
      attempts: result.status === "fulfilled"
        ? result.value.attempts
        : AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts,
      successfulRows: result.status === "fulfilled" ? result.value.successfulRows : 0,
      error: result.status === "rejected" ? errorMessage(result.reason) : null
    });
  }
  await event("collection.finished", "info", "Public collector processes reached terminal states.", { results });
  return results;
}

async function runTopVoiceCollector() {
  await event(
    "top_voice_collection.started",
    "info",
    "Insider and YC Partner discovery started alongside the batch collectors.",
    { audiences: ["insiders", "yc_partners"], batches: AUTONOMOUS_BATCHES.map((batch) => batch.slug) }
  );
  await runCommand(
    process.execPath,
    [
      "--experimental-strip-types",
      "--loader",
      "./scripts/lib/scoring-diagnostics-ts-loader.mjs",
      "scripts/run-top-voice-ingestion.mjs",
      `--output=${topVoiceOutput}`,
      `--batches=${AUTONOMOUS_BATCHES.map((batch) => batch.slug).join(",")}`,
      "--audiences=insiders,yc_partners",
      "--x-concurrency=16",
      "--max-posts-per-target=20",
      "--max-top-voice-x-targets=250",
      "--max-network-requests=2500",
      "--deadline-minutes=10"
    ],
    {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.topVoiceCollectorMs,
      label: "Top Voice X discovery"
    }
  );
  const receipt = await readJson(topVoiceOutput, null);
  await event(
    "top_voice_collection.finished",
    "info",
    "Insider and YC Partner discovery reached a terminal state.",
    receipt ?? {}
  );
  return receipt;
}

async function runCollectorWithRetries(command, maxAttempts = AUTONOMOUS_PROCESS_BUDGETS.collectorAttempts) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const attemptStartedAt = Date.now();
      await command.run();
      const snapshot = await readCollectorSnapshot(command.outputPath, command.kind, {
        batchSlug: command.batchSlug,
        expectedSourcePath: command.expectedSourcePath,
        notBefore: attemptStartedAt
      });
      if (!snapshot) throw new Error(`${command.kind} ${command.batchSlug} did not write a collector snapshot.`);
      const retryableFailures = retryableFailuresFromSnapshot(snapshot);
      if (retryableFailures.length === 0 || attempt === maxAttempts) {
        return {
          attempts: attempt,
          retryableFailures: retryableFailures.length,
          successfulRows: successfulCollectorRowCount(snapshot, command.kind)
        };
      }
      await event("collector.retry_scheduled", "warning", `${command.kind} ${command.batchSlug} has retryable failures.`, {
        attempt,
        maxAttempts,
        retryableFailures: retryableFailures.slice(0, 20)
      });
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
      await event("collector.retry_scheduled", "warning", `${command.kind} ${command.batchSlug} process failed.`, {
        attempt,
        maxAttempts,
        error: errorMessage(error)
      });
    }
    await delay(Math.min(
      AUTONOMOUS_PROCESS_BUDGETS.collectorRetryDelayMaxMs,
      1_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 1_000)
    ));
  }
  throw lastError ?? new Error(`${command.kind} ${command.batchSlug} exhausted retries.`);
}

function retryableFailuresFromSnapshot(snapshot) {
  const messages = [
    ...(snapshot?.failures ?? []).map((failure) => failure.message),
    ...(snapshot?.accounts ?? []).filter((account) => account.fetched === false).map((account) => account.error)
  ];
  return messages.filter((message) =>
    /(?:rate.?limit|\b429\b|\b5\d\d\b|timeout|timed out|network|fetch failed|econn|socket|temporar|unavailable)/i.test(String(message ?? ""))
  );
}

function successfulCollectorRowCount(snapshot, kind) {
  if (kind === "github") {
    return snapshot.accounts.filter((account) => account.fetched === true).length;
  }
  return snapshot.evidence.length + snapshot.needsReview.length;
}

async function reconcileCollectorTasks(results, catalogState) {
  const updateGroups = new Map();
  for (const result of results) {
    const platforms = result.kind === "github"
      ? ["github"]
      : ["x", "instagram", "linkedin", "youtube", "product_hunt", "reddit", "hacker_news", "rss", "web"];
    const snapshot = result.ok
      ? await readCollectorSnapshot(result.outputPath, result.kind, result)
      : null;
    const failureKeys = failureKeysFromSnapshot(snapshot, result.batchSlug);
    for (const platform of platforms) {
      const tasks = await tasksFor(result.batchSlug, platform, catalogState);
      for (const task of tasks) {
        const plannedTask = plannedTaskByCheckpointKey.get(task.checkpoint_key);
        const key = plannedTask
          ? collectorEntityKey(platform, plannedTask.entityType, plannedTask.entitySourceKey)
          : collectorEntityKey(platform, task.entity_type, task.company_name);
        const failed = !result.ok || failureKeys.has(key);
        const status = failed ? "failed" : "completed";
        const reason = failed ? result.error ?? "collector_reported_failure" : "checked";
        const groupKey = JSON.stringify([status, reason, result.attempts]);
        const group = updateGroups.get(groupKey) ?? { ids: [], status, reason, attempts: result.attempts };
        group.ids.push(task.id);
        updateGroups.set(groupKey, group);
      }
    }
  }
  const updates = [...updateGroups.values()].flatMap((group) =>
    chunks(group.ids, 100).map((ids) => ({ ...group, ids }))
  );
  await mapWithConcurrency(updates, 4, ({ ids, status, reason, attempts }) =>
    finishTasks(ids, status, reason, attempts)
  );
}

async function tasksFor(batchSlug, platform, catalogState) {
  const { data, error } = await supabase
    .from("ingestion_tasks")
    .select("id,company_name,entity_type,status,checkpoint_key")
    .eq("ingestion_run_id", run.id)
    .eq("batch_id", catalogState.batchBySlug.get(batchSlug))
    .eq("platform", platform)
    .eq("status", "queued");
  check(error, `read ${batchSlug}/${platform} tasks`);
  return data ?? [];
}

async function finishTasks(ids, status, reason, attempts = 1) {
  if (ids.length === 0) return;
  const terminalAt = new Date().toISOString();
  const { error } = await supabase
    .from("ingestion_tasks")
    .update({
      status,
      attempts,
      last_attempt_at: terminalAt,
      terminal_at: terminalAt,
      terminal_reason: reason,
      last_failure_kind: status === "failed" ? "collector_failure" : null,
      last_error: status === "failed" ? reason : null,
      last_error_json: status === "failed" ? { reason } : {}
    })
    .in("id", ids)
    .eq("status", "queued");
  check(error, `finish ${ids.length} ingestion tasks`);
}

async function terminalizeQueuedTasks(runId, status, reason) {
  const { error } = await supabase
    .from("ingestion_tasks")
    .update({ status, terminal_at: new Date().toISOString(), terminal_reason: reason })
    .eq("ingestion_run_id", runId)
    .eq("status", "queued");
  check(error, "terminalize skipped network tasks");
}

async function importDurableEvidence({ publicSnapshots, githubSnapshots, catalogState }) {
  if (!durableStorageConfigured) {
    return {
      status: "skipped",
      configured: false,
      reason: "supabase_not_configured",
      received: publicSnapshots.length + githubSnapshots.length
    };
  }
  if (!catalogState || !run?.id) {
    throw new Error("Durable Supabase import is configured but its catalog or run state is unavailable.");
  }
  if (publicSnapshots.length === 0 && githubSnapshots.length === 0) {
    return {
      status: "completed",
      configured: true,
      received: 0,
      rejected: 0,
      duplicates: 0,
      stored: 0,
      readBack: 0,
      attributions: { stored: 0, duplicates: 0, unresolved: 0 },
      metricObservations: { stored: 0, duplicates: 0 },
      rejections: []
    };
  }
  const importer = await import("./lib/durable-evidence-import.mjs");
  const companyAliases = {};
  for (const [sourceKey, id] of catalogState.companyBySourceKey) {
    companyAliases[sourceKey] = id;
    companyAliases[sourceKey.replace(/^company[:-]/, "")] = id;
    companyAliases[sourceKey.replace(/^a16z-speedrun-006[:-]/, "")] = id;
  }
  const result = await importer.importEvidenceSnapshots({
    client: supabase,
    ingestionRunId: run.id,
    publicSnapshots,
    githubSnapshots,
    catalog: {
      companyByEntityId: companyAliases,
      companyBySlug: companyAliases,
      founderByEntityId: Object.fromEntries(catalogState.founderBySourceKey)
    }
  });
  return { status: "completed", configured: true, ...result };
}

async function summarizeCollectionCoverage(tasks, collectionResults, { skipNetwork }) {
  const resultByCollector = new Map(
    collectionResults.map((result) => [`${result.batchSlug}:${result.kind}`, result])
  );
  const failureKeysByCollector = new Map();
  for (const result of collectionResults) {
    const snapshot = result.ok
      ? await readCollectorSnapshot(result.outputPath, result.kind, result)
      : null;
    failureKeysByCollector.set(
      `${result.batchSlug}:${result.kind}`,
      snapshot ? failureKeysFromSnapshot(snapshot, result.batchSlug) : new Set()
    );
  }

  const report = {
    expected: tasks.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    nonTerminal: 0,
    coveragePercentage: 0,
    generatedAt: new Date().toISOString()
  };
  for (const task of tasks) {
    if (task.status !== "queued" || skipNetwork) {
      report.skipped += 1;
      continue;
    }
    const kind = task.platform === "github" ? "github" : "public";
    const collectorKey = `${task.batchSlug}:${kind}`;
    const result = resultByCollector.get(collectorKey);
    if (!result) {
      report.nonTerminal += 1;
      continue;
    }
    const entityKey = collectorEntityKey(task.platform, task.entityType, task.entitySourceKey);
    if (!result.ok || failureKeysByCollector.get(collectorKey)?.has(entityKey)) {
      report.failed += 1;
    } else {
      report.succeeded += 1;
    }
  }
  report.attempted = report.expected - report.nonTerminal;
  report.coveragePercentage = report.expected
    ? Number((((report.expected - report.nonTerminal) / report.expected) * 100).toFixed(2))
    : 100;
  return report;
}

function assertSuccessfulCollection(collectionResults, coverage) {
  if (collectionResults.length === 0 || !collectionResults.some((result) => result.ok)) {
    throw new Error("No collector completed successfully; publication and run completion are prohibited.");
  }
  if (!collectionResults.some((result) => result.ok && result.successfulRows > 0)) {
    throw new Error("Collector snapshots contained no successful rows; publication and run completion are prohibited.");
  }
  if (coverage.succeeded === 0) {
    throw new Error("Every attempted collection task failed; publication and run completion are prohibited.");
  }
}

function assertSuccessfulTopVoiceRefresh(receipt) {
  if (!receipt || receipt.status !== "completed") {
    throw new Error("Top Voice discovery did not complete every requested audience.");
  }
  const audiences = new Map((receipt.audiences ?? []).map((result) => [result.audience, result]));
  if (!audiences.has("insiders") || !audiences.has("yc_partners")) {
    throw new Error("Top Voice discovery did not scan both Insiders and YC Partners.");
  }
  for (const audience of ["insiders", "yc_partners"]) {
    const result = audiences.get(audience);
    if (result?.status !== "completed" || (result.targetsLoaded ?? 0) <= 0 || (result.networkRequests ?? 0) <= 0) {
      throw new Error(`Top Voice discovery did not fully inspect the curated ${audience} audience.`);
    }
  }
}

async function persistCoverage(catalogState, stageCounters) {
  const { data: tasks, error } = await supabase
    .from("ingestion_tasks")
    .select("status,platform,batch_id,terminal_reason")
    .eq("ingestion_run_id", run.id);
  check(error, "read terminal coverage");
  const terminalStatuses = new Set(["completed", "needs_review", "blocked_or_empty", "skipped", "failed", "canceled", "dead_lettered"]);
  const report = {
    expected: tasks?.length ?? 0,
    attempted: (tasks ?? []).filter((task) => task.status !== "queued").length,
    succeeded: (tasks ?? []).filter((task) => task.status === "completed").length,
    failed: (tasks ?? []).filter((task) => ["failed", "dead_lettered"].includes(task.status)).length,
    skipped: (tasks ?? []).filter((task) => ["skipped", "needs_review", "blocked_or_empty"].includes(task.status)).length,
    nonTerminal: (tasks ?? []).filter((task) => !terminalStatuses.has(task.status)).length,
    coveragePercentage: tasks?.length
      ? Number((((tasks.length - (tasks ?? []).filter((task) => !terminalStatuses.has(task.status)).length) / tasks.length) * 100).toFixed(2))
      : 100,
    stageCounters,
    generatedAt: new Date().toISOString()
  };
  const { error: reportError } = await supabase.from("ingestion_coverage_reports").upsert(
    {
      ingestion_run_id: run.id,
      report_key: "overall",
      expected_count: report.expected,
      attempted_count: report.attempted,
      succeeded_count: report.succeeded,
      failed_count: report.failed,
      skipped_count: report.skipped,
      report_json: report
    },
    { onConflict: "ingestion_run_id,report_key" }
  );
  check(reportError, "persist coverage report");
  return report;
}

async function persistArtifactManifest(runId) {
  const path = join(root, "public", "graph", "manifest.json");
  const content = await readFile(path);
  const details = await stat(path);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const { error } = await supabase.from("ingestion_artifact_manifests").upsert(
    {
      ingestion_run_id: runId,
      artifact_key: "public-graph-manifest",
      artifact_type: "graph_manifest",
      storage_uri: "repo://public/graph/manifest.json",
      content_type: "application/json",
      byte_size: details.size,
      sha256,
      metadata_json: JSON.parse(content.toString("utf8"))
    },
    { onConflict: "ingestion_run_id,artifact_key" }
  );
  check(error, "persist artifact manifest");
}

async function publishGithubExports(snapshots) {
  const destinations = new Map([
    ["S2026", join(root, "src", "lib", "social", "github-traction.json")],
    ["S26", join(root, "src", "lib", "social", "github-traction-summer-2026.json")],
    ["A16ZSR006", join(root, "src", "lib", "social", "github-traction-a16z-speedrun-006.json")]
  ]);
  for (const snapshot of snapshots) {
    const batchSlug = snapshot.source.batchSlug;
    const destination = destinations.get(batchSlug);
    if (!destination) throw new Error(`No GitHub publication destination is configured for ${batchSlug}.`);
    const previous = await readJson(destination, null);
    await writeJsonAtomic(destination, mergeGithubTractionSnapshots(previous, snapshot));
  }
}

async function publishRepositoryArtifacts() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    await event(
      "publication.skipped",
      "warning",
      "Repository publication was skipped outside GitHub Actions; generated artifacts remain local.",
      {}
    );
    return;
  }

  await runCommand("git", ["config", "user.name", "github-actions[bot]"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitConfigMs,
    label: "configure publication author"
  });
  await runCommand("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitConfigMs,
    label: "configure publication email"
  });
  await runCommand("git", [
    "add", "--",
    "public/graph",
    "outputs/benchmarks",
    "src/lib/social/public-evidence-current.json",
    "src/lib/social/targeted-evidence-current.json",
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json"
  ], { timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitStageMs, label: "stage refreshed artifacts" });

  const diff = await runCommand("git", ["diff", "--cached", "--quiet"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "check staged artifacts",
    allowedExitCodes: [0, 1]
  });
  if (diff.code === 0) {
    await event("publication.no_changes", "info", "No public artifact changes required publication.", {});
    return;
  }

  await runCommand("git", ["commit", "-m", `Publish autonomous ingestion ${idempotencyKey}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitCommitMs,
    label: "commit refreshed artifacts"
  });
  await runCommand("git", ["push"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: "push refreshed artifacts"
  });
  await event("publication.completed", "info", "Refreshed artifacts were committed and pushed.", {
    idempotencyKey
  });
}

async function completeRun(status, stats) {
  if (status === "completed") {
    assertLeaseHealthy();
    const { data, error } = await supabase.rpc("finalize_completed_ingestion_run", {
      p_run_id: run.id,
      p_lease_owner: workerId,
      p_lease_token: run.lease_token,
      p_stats_json: stats
    });
    check(error, "atomically finalize completed ingestion run");
    const finalized = Array.isArray(data) ? data[0] ?? null : data;
    if (!finalized) throw new Error("The ingestion run lease was lost before atomic finalization.");
    run = finalized;
    return;
  }
  const finishedAt = new Date().toISOString();
  const { error } = await supabase
    .from("ingestion_runs")
    .update({
      status,
      finished_at: finishedAt,
      heartbeat_at: finishedAt,
      lease_expires_at: null,
      lease_owner: null,
      lease_token: null,
      stats_json: stats,
      errors_json: status === "failed" ? [stats.error ?? "unknown failure"] : []
    })
    .eq("id", run.id);
  check(error, `mark ingestion run ${status}`);
}

async function runCommand(command, commandArgs, { timeoutMs, label, env = {}, allowedExitCodes = [0] }) {
  assertLeaseHealthy();
  await event("command.started", "info", `${label} started.`, { command, args: commandArgs });
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(
        () => child.kill("SIGKILL"),
        AUTONOMOUS_PROCESS_BUDGETS.processKillGraceMs
      );
      killTimer.unref?.();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = tail(`${stdout}${chunk}`, 40_000);
      process.stdout.write(`[${label}] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(`${stderr}${chunk}`, 40_000);
      process.stderr.write(`[${label}] ${chunk}`);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const payload = { code, signal, timedOut, timeoutMs, stdout, stderr };
      if (timedOut) {
        await event("command.failed", "error", `${label} timed out.`, payload).catch(() => {});
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== null && allowedExitCodes.includes(code)) {
        if (heartbeatFailure) {
          reject(new Error(`Ingestion lease heartbeat failed while ${label} was running.`));
          return;
        }
        await event("command.completed", "info", `${label} completed.`, payload).catch(() => {});
        resolve(payload);
      } else {
        await event("command.failed", "error", `${label} failed.`, payload).catch(() => {});
        reject(new Error(`${label} exited with ${code ?? signal ?? "unknown status"}.`));
      }
    });
  });
}

function failureKeysFromSnapshot(snapshot, batchSlug) {
  const keys = new Set();
  for (const failure of snapshot?.failures ?? []) {
    keys.add(collectorEntityKey(
      failure.platform,
      failure.entityType ?? "company",
      normalizeAutonomousFailureEntityId(failure, { batchSlug })
    ));
  }
  for (const account of snapshot?.accounts ?? []) {
    if (account.fetched === false) {
      keys.add(collectorEntityKey(
        "github",
        account.entityType ?? "company",
        account.entityId ?? account.companyName ?? account.companySlug
      ));
    }
  }
  return keys;
}

function collectorEntityKey(platform, entityType, entityId) {
  return `${normalizePlatform(platform)}:${entityType}:${normalizeName(entityId)}`;
}

function batchCompanyKey(batchSlug, sourceKey) {
  return `${batchSlug}\u0000${sourceKey}`;
}

async function readAvailableSnapshots(results) {
  const values = [];
  for (const result of results) {
    const value = await readCollectorSnapshot(result.outputPath, result.kind, result);
    if (value) values.push(value);
  }
  return values;
}

async function readCollectorSnapshot(path, kind, validation) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Invalid ${kind} collector snapshot at ${path}: ${errorMessage(error)}`);
  }
  try {
    return validateAutonomousCollectorSnapshot(value, {
      kind,
      batchSlug: validation.batchSlug,
      expectedSourcePath: validation.expectedSourcePath,
      notBefore: validation.notBefore ?? null
    });
  } catch (error) {
    throw new Error(`Invalid ${kind} collector snapshot at ${path}: ${errorMessage(error)}`);
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function selectMaybeSingle(query, operation) {
  const { data, error } = await query.maybeSingle();
  check(error, operation);
  return data ?? null;
}

async function selectSingle(query, operation) {
  const { data, error } = await query.single();
  check(error, operation);
  return data;
}

function check(error, operation) {
  if (error) throw new Error(`Failed to ${operation}: ${error.message ?? String(error)}`);
}

function normalizeReviewState(value) {
  return ["verified", "needs_review", "rejected"].includes(value) ? value : "needs_review";
}

function normalizePlatform(value) {
  return value === "twitter" ? "x" : value === "website" ? "web" : value;
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function platformPriority(platform) {
  return ({ github: 90, x: 85, instagram: 80, linkedin: 75, youtube: 70, product_hunt: 65 }[platform] ?? 50);
}

function platformDelay(platform) {
  return ({ linkedin: 2_500, instagram: 2_000, x: 1_500, reddit: 1_000, product_hunt: 1_000 }[platform] ?? 500);
}

function catalogSummary(allCatalogs) {
  return allCatalogs.map((catalog) => ({
    slug: catalog.slug,
    companies: catalog.companies.length,
    founders: catalog.companies.reduce((sum, company) => sum + company.founders.length, 0),
    accounts: catalog.companies.reduce(
      (sum, company) => sum + company.accounts.length + company.founders.reduce((founderSum, founder) => founderSum + founder.accounts.length, 0),
      0
    )
  }));
}

function parseArgs(rawArgs) {
  const value = (name) => rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  return {
    idempotencyKey: value("--idempotency-key"),
    plan: rawArgs.includes("--plan"),
    skipNetwork: rawArgs.includes("--skip-network"),
    skipPublish: rawArgs.includes("--skip-publish")
  };
}

function cleanEnv(value) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function safePathSegment(value) {
  const source = String(value);
  const prefix = source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(values[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tail(value, limit) {
  return value.length > limit ? value.slice(-limit) : value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
