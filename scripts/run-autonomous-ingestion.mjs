import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUTONOMOUS_BATCHES,
  buildAutonomousTaskPlan,
  loadAutonomousCatalogs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  summarizeTaskCoverage
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

if (!idempotencyKey) {
  throw new Error("--idempotency-key or INGESTION_IDEMPOTENCY_KEY is required.");
}

const url = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
if ((!url || !serviceKey) && !args.plan) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless --plan is used.");
}

await mkdir(workRoot, { recursive: true });
const catalogs = await loadAutonomousCatalogs(root);
const plannedTasks = buildAutonomousTaskPlan(catalogs, { runKey: idempotencyKey });
const plannedTaskByCheckpointKey = new Map(plannedTasks.map((task) => [task.checkpointKey, task]));
const plannedCoverage = summarizeTaskCoverage(plannedTasks);

if (args.plan) {
  console.log(JSON.stringify({ idempotencyKey, batches: catalogSummary(catalogs), coverage: plannedCoverage }, null, 2));
  process.exit(0);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { headers: { "X-Client-Info": "returner-autonomous-ingestion" } }
});

let runtimeLock = null;
let run = null;
let heartbeatTimer = null;
let hardFailure = null;
let heartbeatFailure = null;

try {
  runtimeLock = await claimRuntimeLock();
  if (!runtimeLock) {
    throw new Error("Another ingestion coordinator owns the non-expired autonomous-ingestion lease.");
  }
  run = await getOrCreateRun();
  if (run.status === "completed") {
    console.log(`Ingestion ${idempotencyKey} already completed as run ${run.id}; replay is a no-op.`);
    process.exitCode = 0;
  } else {
    heartbeatTimer = setInterval(() => void heartbeat().catch(failHeartbeat), 60_000);
    heartbeatTimer.unref?.();
    await event("run.started", "info", "Autonomous ingestion run started.", {
      workerId,
      plannedCoverage,
      catalogs: catalogSummary(catalogs)
    });

    const catalogState = await syncCatalogs(catalogs);
    await enqueueTasks(plannedTasks, catalogState);
    await event("inventory.completed", "info", "Canonical entity/account inventory and task plan persisted.", {
      companies: catalogState.companyByBatchSourceKey.size,
      founders: catalogState.founderBySourceKey.size,
      accounts: catalogState.accountBySourceKey.size,
      tasks: plannedTasks.length
    });

    const collectionResults = args.skipNetwork ? [] : await runCollectors();
    assertLeaseHealthy();
    if (args.skipNetwork) {
      await terminalizeQueuedTasks(run.id, "skipped", "network_collection_explicitly_skipped");
    } else {
      await reconcileCollectorTasks(collectionResults, catalogState);
    }

    const publicSnapshots = await readAvailableSnapshots([...publicOutputs.values()]);
    const previousPublicSnapshot = await readJson(
      join(root, "src", "lib", "social", "public-evidence-current.json"),
      null
    );
    const mergedPublicSnapshot = publicSnapshots.length > 0
      ? mergePublicEvidenceSnapshots([previousPublicSnapshot, ...publicSnapshots].filter(Boolean))
      : null;

    const durableImport = await importDurableEvidence({
      publicSnapshots,
      githubSnapshots: await readAvailableSnapshots([...githubOutputs.values()]),
      catalogState
    });
    await event("evidence.imported", "info", "Collected evidence was validated and imported into durable storage.", durableImport);
    assertLeaseHealthy();

    const prePublishCoverage = await persistCoverage(catalogState, durableImport);
    if (prePublishCoverage.nonTerminal > 0) {
      throw new Error(`${prePublishCoverage.nonTerminal} ingestion tasks did not reach a terminal state.`);
    }

    assertLeaseHealthy();
    if (mergedPublicSnapshot) {
      await writeJsonAtomic(join(root, "src", "lib", "social", "public-evidence-current.json"), mergedPublicSnapshot);
    }
    await publishGithubExports();

    if (!args.skipPublish) {
      await runCommand("npm", ["run", "build"], { timeoutMs: 20 * 60_000, label: "production build" });
      await runCommand("npm", ["run", "benchmarks:daily"], {
        timeoutMs: 15 * 60_000,
        label: "graph and benchmark publication",
        env: { INGESTION_RUN_ID: run.id }
      });
      await runCommand(process.execPath, ["scripts/write-artifact-manifest.mjs", `--ingestion-run-id=${run.id}`], {
        timeoutMs: 2 * 60_000,
        label: "artifact manifest"
      });
      await runCommand("npm", ["run", "artifacts:validate"], { timeoutMs: 10 * 60_000, label: "artifact validation" });
      await persistArtifactManifest(run.id);
      await publishRepositoryArtifacts();
    }

    const finalCoverage = await persistCoverage(catalogState, durableImport);
    await completeRun("completed", {
      ...finalCoverage,
      stageCounters: durableImport,
      finishedAt: new Date().toISOString()
    });
    await event("run.completed", "info", "Autonomous ingestion completed with every task terminal.", finalCoverage);
    console.log(JSON.stringify({ runId: run.id, status: "completed", coverage: finalCoverage, durableImport }, null, 2));
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
    max_attempts: 3,
    priority: platformPriority(task.platform),
    terminal_at: task.status === "queued" ? null : now,
    terminal_reason: task.terminalReason,
    last_error_json: {},
    rate_limit_ms: platformDelay(task.platform)
  }));
  for (const chunk of chunks(rows, 250)) {
    const { error } = await supabase.from("ingestion_tasks").upsert(chunk, { onConflict: "checkpoint_key" });
    check(error, "enqueue account/platform tasks");
  }
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
        { timeoutMs: 55 * 60_000, label: `public ${batchSlug}` }
      )
    })),
    ...AUTONOMOUS_BATCHES.map((batch) => ({
      kind: "github",
      batchSlug: batch.slug,
      outputPath: githubOutputs.get(batch.slug),
      run: () => runCommand(
        process.execPath,
        [
          "scripts/fetch-github-traction.mjs",
          `--batch=${batch.slug}`,
          "--workers=8",
          `--output=${githubOutputs.get(batch.slug)}`
        ],
        { timeoutMs: 45 * 60_000, label: `github ${batch.slug}` }
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
      attempts: result.status === "fulfilled" ? result.value.attempts : 3,
      error: result.status === "rejected" ? errorMessage(result.reason) : null
    });
  }
  await event("collection.finished", "info", "Public collector processes reached terminal states.", { results });
  return results;
}

async function runCollectorWithRetries(command, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await command.run();
      const snapshot = await readJson(command.outputPath, null);
      const retryableFailures = retryableFailuresFromSnapshot(snapshot);
      if (retryableFailures.length === 0 || attempt === maxAttempts) {
        return { attempts: attempt, retryableFailures: retryableFailures.length };
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
    await delay(Math.min(30_000, 1_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 1_000)));
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

async function reconcileCollectorTasks(results, catalogState) {
  for (const result of results) {
    const platforms = result.kind === "github"
      ? ["github"]
      : ["x", "instagram", "linkedin", "youtube", "product_hunt", "reddit", "hacker_news", "rss", "web"];
    const snapshot = result.ok ? await readJson(result.outputPath, null) : null;
    const failureKeys = failureKeysFromSnapshot(snapshot);
    for (const platform of platforms) {
      const tasks = await tasksFor(result.batchSlug, platform, catalogState);
      for (const chunk of chunks(tasks, 100)) {
        for (const task of chunk) {
          const plannedTask = plannedTaskByCheckpointKey.get(task.checkpoint_key);
          const key = plannedTask
            ? collectorEntityKey(platform, plannedTask.entityType, plannedTask.entitySourceKey)
            : collectorEntityKey(platform, task.entity_type, task.company_name);
          const failed = !result.ok || failureKeys.has(key);
          await finishTask(
            task.id,
            failed ? "failed" : "completed",
            failed ? result.error ?? "collector_reported_failure" : "checked",
            result.attempts
          );
        }
      }
    }
  }
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

async function finishTask(id, status, reason, attempts = 1) {
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
    .eq("id", id)
    .eq("status", "queued");
  check(error, `finish ingestion task ${id}`);
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
  if (publicSnapshots.length === 0 && githubSnapshots.length === 0) {
    return {
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
  return importer.importEvidenceSnapshots({
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

async function publishGithubExports() {
  const destinations = new Map([
    ["S2026", join(root, "src", "lib", "social", "github-traction.json")],
    ["S26", join(root, "src", "lib", "social", "github-traction-summer-2026.json")],
    ["A16ZSR006", join(root, "src", "lib", "social", "github-traction-a16z-speedrun-006.json")]
  ]);
  for (const [batchSlug, sourcePath] of githubOutputs) {
    const snapshot = await readJson(sourcePath, null);
    if (!snapshot) continue;
    const destination = destinations.get(batchSlug);
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
    timeoutMs: 30_000,
    label: "configure publication author"
  });
  await runCommand("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], {
    timeoutMs: 30_000,
    label: "configure publication email"
  });
  await runCommand("git", [
    "add", "--",
    "public/graph",
    "outputs/benchmarks",
    "src/lib/social/public-evidence-current.json",
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json"
  ], { timeoutMs: 60_000, label: "stage refreshed artifacts" });

  const diff = await runCommand("git", ["diff", "--cached", "--quiet"], {
    timeoutMs: 30_000,
    label: "check staged artifacts",
    allowedExitCodes: [0, 1]
  });
  if (diff.code === 0) {
    await event("publication.no_changes", "info", "No public artifact changes required publication.", {});
    return;
  }

  await runCommand("git", ["commit", "-m", `Publish autonomous ingestion ${idempotencyKey}`], {
    timeoutMs: 2 * 60_000,
    label: "commit refreshed artifacts"
  });
  await runCommand("git", ["push"], { timeoutMs: 5 * 60_000, label: "push refreshed artifacts" });
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
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
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
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timer);
      const payload = { code, signal, stdout, stderr };
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

function failureKeysFromSnapshot(snapshot) {
  const keys = new Set();
  for (const failure of snapshot?.failures ?? []) {
    keys.add(collectorEntityKey(
      failure.platform,
      failure.entityType ?? "company",
      failure.entityId ?? failure.companyName ?? failure.companySlug
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

async function readAvailableSnapshots(paths) {
  const values = [];
  for (const path of paths) {
    const value = await readJson(path, null);
    if (value) values.push(value);
  }
  return values;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tail(value, limit) {
  return value.length > limit ? value.slice(-limit) : value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
