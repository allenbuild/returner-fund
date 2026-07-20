import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AUTONOMOUS_BATCHES,
  AUTONOMOUS_PROCESS_BUDGETS,
  autonomousCollectorRetryableFailures,
  buildAutonomousPublicNativeAuthorResolver,
  buildLegacyPublicEvidenceBatchResolver,
  buildAutonomousTaskPlan,
  classifyAutonomousCollectorTaskOutcome,
  countSuccessfulAutonomousCollectorRows,
  indexAutonomousCollectorTaskOutcomes,
  loadAutonomousCatalogs,
  mergeGithubTractionSnapshots,
  mergePublicEvidenceSnapshots,
  summarizeAutonomousCollectorTerminalTaskCoverage,
  summarizeTaskCoverage,
  validateAutonomousCollectorMatrix,
  validateAutonomousCollectorReferentialIntegrity,
  validateAutonomousCollectorSnapshot,
  validateAutonomousTerminalCoverage,
  validateMappedAutonomousCoverage
} from "./lib/autonomous-ingestion-plan.mjs";
import { readRequiredCanonicalJson } from "./lib/canonical-json.mjs";
import { mergeTargetedEvidenceSnapshots } from "./lib/targeted-evidence-merge.mjs";

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
const discoveryAttemptOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(workRoot, `discovery-attempts-${batch.slug.toLowerCase()}.json`)])
);
const sourceDiscoveryPathOutputs = new Map(
  AUTONOMOUS_BATCHES.map((batch) => [batch.slug, join(workRoot, `source-discovery-paths-${batch.slug.toLowerCase()}.json`)])
);
const publishedDiscoveryAttemptsPath = join(root, "outputs", "discovery-attempts-current.json");
const publishedSourceDiscoveryPathsPath = join(root, "outputs", "source-discovery-paths-current.json");
const publishedCohortAuditPath = join(root, "outputs", "cohort-coverage-current.json");
const topVoiceOutput = join(workRoot, "top-voice-refresh.json");

if (!idempotencyKey) {
  throw new Error("--idempotency-key or INGESTION_IDEMPOTENCY_KEY is required.");
}

const url = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
const durableStorageConfigured = Boolean(url && serviceKey);

await mkdir(workRoot, { recursive: true });
const catalogs = await loadAutonomousCatalogs(root);
const resolvePublicNativeAuthor = buildAutonomousPublicNativeAuthorResolver(catalogs);
const resolveLegacyPublicEvidenceBatch = buildLegacyPublicEvidenceBatchResolver(catalogs);
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
    await writeRunnerOutcome("already_completed");
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
        founders: catalogState.founderByBatchSourceKey.size,
        accounts: catalogState.accountBySourceKey.size,
        ownerAccounts: catalogState.ownerAccountCount,
        retiredOwnerAccounts: catalogState.retiredOwnerAccounts,
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
    if (!args.skipNetwork) validateAutonomousCollectorMatrix(collectionResults);
    if (args.skipNetwork && run) {
      await terminalizeQueuedTasks(run.id, "skipped", "network_collection_explicitly_skipped");
    } else if (catalogState) {
      await reconcileCollectorTasks(collectionResults, catalogState);
    }

    const successfulCollectorResults = collectionResults.filter((result) => result.ok);
    const publicSnapshots = (await readAvailableSnapshots(
      successfulCollectorResults.filter((result) => result.kind === "public")
    )).map(withSnapshotBatchProvenance);
    const githubSnapshots = await readAvailableSnapshots(
      successfulCollectorResults.filter((result) => result.kind === "github")
    );
    const collectionCoverage = await summarizeCollectionCoverage(
      plannedTasks,
      collectionResults,
      { skipNetwork: args.skipNetwork }
    );
    assertSuccessfulCollection(collectionResults, collectionCoverage);
    validateMappedAutonomousCoverage(collectionCoverage);
    assertSuccessfulTopVoiceRefresh(topVoiceRefresh);
    const publicationRunId = run?.id ?? `file:${idempotencyKey}`;
    if (!args.skipPublish) await synchronizePublicationBase();
    const publicationInputs = {
      publicSnapshots,
      githubSnapshots,
      publicResults: successfulCollectorResults.filter((result) => result.kind === "public"),
      topVoiceRefresh,
      catalogState
    };
    // One sanitized publication plan is computed after synchronizing the base.
    // This exact plan drives both durable persistence and the file publication,
    // so raw collector rows can never reach Supabase ahead of semantic merge.
    publicationInputs.sanitizedPublicSnapshot = await prepareSanitizedPublicSnapshot(publicSnapshots);
    publicationInputs.sanitizedTargetedSnapshot = await prepareSanitizedTargetedSnapshot(topVoiceRefresh);
    const sanitizedEvidenceSnapshots = [
      publicationInputs.sanitizedPublicSnapshot,
      publicationInputs.sanitizedTargetedSnapshot
    ].filter(Boolean);
    const durableImport = await importDurableEvidence({
      publicSnapshots: sanitizedEvidenceSnapshots,
      githubSnapshots,
      catalogState,
      attributionReconciliationLedger: combineAttributionReconciliationLedgers(
        publicationInputs.sanitizedPublicSnapshot?.attributionReconciliationLedger,
        publicationInputs.sanitizedTargetedSnapshot?.attributionReconciliationLedger
      )
    });
    assertDurableAttributionCompleteness(durableImport);
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
    validateAutonomousTerminalCoverage(prePublishCoverage, {
      expectedTaskCount: plannedTasks.length
    });

    assertLeaseHealthy();
    // Publication state must be read only after the rebase. Reading it before
    // synchronizePublicationBase() can overwrite evidence or discovery rows
    // that another completed ingestion pushed while these collectors ran.
    await mergePublicationInputs(publicationInputs);

    if (!args.skipPublish) {
      await buildAndValidatePublication(publicationRunId);
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
      await publishRepositoryArtifacts(publicationRunId, publicationInputs);
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
    await writeRunnerOutcome("refreshed");
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
  const founderByBatchSourceKey = new Map();
  const accountBySourceKey = new Map();
  const accountInventory = [];
  const ownerInventory = [];

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

    const founderRows = [...new Map(catalog.companies.flatMap((company) =>
      company.founders.map((founder) => [founder.sourceKey, {
        source_key: founder.sourceKey,
        name: founder.name,
        yc_profile_url: founder.profileUrl,
        personal_website_url: founder.websiteUrl,
        review_state: normalizeReviewState(founder.reviewState)
      }])
    )).values()];
    if (founderRows.length) {
      const { data: founders, error: founderError } = await supabase
        .from("founders")
        .upsert(founderRows, { onConflict: "source_key" })
        .select("id,source_key");
      check(founderError, `upsert founders for ${catalog.slug}`);
      for (const founder of founders ?? []) {
        founderBySourceKey.set(founder.source_key, founder.id);
        founderByBatchSourceKey.set(batchCompanyKey(catalog.slug, founder.source_key), founder.id);
      }
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

    for (const company of catalog.companies) {
      const companyId = companyByBatchSourceKey.get(batchCompanyKey(catalog.slug, company.sourceKey));
      for (const account of company.accounts) {
        accountInventory.push({ account, entityType: "company", entityId: companyId });
        ownerInventory.push({
          account,
          batchSlug: catalog.slug,
          batchId: batch.id,
          entityType: "company",
          entityId: companyId,
          entitySourceKey: company.sourceKey
        });
      }
      for (const founder of company.founders) {
        const founderId = founderByBatchSourceKey.get(batchCompanyKey(catalog.slug, founder.sourceKey));
        for (const account of founder.accounts) {
          accountInventory.push({ account, entityType: "founder", entityId: founderId });
          ownerInventory.push({
            account,
            batchSlug: catalog.slug,
            batchId: batch.id,
            entityType: "founder",
            entityId: founderId,
            entitySourceKey: founder.sourceKey
          });
        }
      }
    }
  }

  const canonicalAccounts = new Map();
  for (const inventory of accountInventory) {
    const identity = socialAccountIdentity(inventory.account);
    if (!canonicalAccounts.has(identity)) {
      canonicalAccounts.set(identity, accountRow(inventory.account, inventory.entityType, inventory.entityId));
    }
  }
  const accountIdByIdentity = new Map();
  await mapWithConcurrency(chunks([...canonicalAccounts.values()], 250), 4, async (accountRows) => {
    if (accountRows.length === 0) return;
    const { data, error } = await supabase
      .from("social_accounts")
      .upsert(accountRows, { onConflict: "platform,url" })
      .select("id,source_key,platform,url");
    check(error, "upsert canonical social accounts");
    for (const account of data ?? []) {
      accountIdByIdentity.set(socialAccountIdentity(account), account.id);
    }
  });
  for (const inventory of accountInventory) {
    const accountId = accountIdByIdentity.get(socialAccountIdentity(inventory.account));
    if (!accountId) throw new Error(`No durable social account id was returned for ${inventory.account.sourceKey}.`);
    accountBySourceKey.set(inventory.account.sourceKey, accountId);
  }

  const now = new Date().toISOString();
  const ownerRowsByKey = new Map();
  for (const owner of ownerInventory) {
    const ownerKey = socialAccountOwnerKey(owner);
    ownerRowsByKey.set(ownerKey, {
      owner_key: ownerKey,
      social_account_id: accountIdByIdentity.get(socialAccountIdentity(owner.account)),
      batch_id: owner.batchId,
      entity_type: owner.entityType,
      company_id: owner.entityType === "company" ? owner.entityId : null,
      founder_id: owner.entityType === "founder" ? owner.entityId : null,
      owner_source_key: owner.entitySourceKey,
      account_source_key: owner.account.sourceKey,
      platform: owner.account.platform,
      review_state: normalizeReviewState(owner.account.reviewState),
      last_seen_at: now,
      last_seen_run_id: run.id,
      retired_at: null,
      retirement_reason: null
    });
  }
  await mapWithConcurrency(chunks([...ownerRowsByKey.values()], 250), 4, async (ownerRows) => {
    if (ownerRows.length === 0) return;
    const { error } = await supabase
      .from("social_account_owners")
      .upsert(ownerRows, { onConflict: "owner_key" });
    check(error, "upsert batch-scoped social account owners");
  });
  const retiredOwnerAccounts = await retireAbsentSocialAccountOwners(
    new Set(ownerRowsByKey.keys()),
    [...batchBySlug.values()],
    now
  );

  return {
    batchBySlug,
    companyBySourceKey,
    companyByBatchSourceKey,
    founderBySourceKey,
    founderByBatchSourceKey,
    accountBySourceKey,
    ownerAccountCount: ownerRowsByKey.size,
    retiredOwnerAccounts
  };
}

function accountRow(account, entityType, entityId) {
  return {
    source_key: account.sourceKey,
    entity_type: entityType,
    entity_id: entityId,
    platform: account.platform,
    handle: account.handle,
    // Keep the stored URL byte-for-byte compatible with legacy rows and the
    // existing (platform,url) uniqueness constraint. Normalization is used
    // only for in-memory identity matching below.
    url: account.url,
    account_id: account.accountId,
    verified: account.verified,
    review_state: normalizeReviewState(account.reviewState),
    discovered_from_url: account.discoveredFromUrl,
    evidence_json: { matchReason: account.matchReason }
  };
}

async function retireAbsentSocialAccountOwners(activeOwnerKeys, batchIds, retiredAt) {
  const existingOwners = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await supabase
      .from("social_account_owners")
      .select("id,owner_key")
      .in("batch_id", batchIds)
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    check(error, "read batch-scoped social account owners for retirement");
    existingOwners.push(...(data ?? []));
    if ((data?.length ?? 0) < 1_000) break;
  }
  const staleIds = existingOwners
    .filter((owner) => !activeOwnerKeys.has(owner.owner_key))
    .map((owner) => owner.id);
  await mapWithConcurrency(chunks(staleIds, 250), 4, async (ids) => {
    if (ids.length === 0) return;
    const { error } = await supabase
      .from("social_account_owners")
      .update({
        review_state: "rejected",
        retired_at: retiredAt,
        retirement_reason: "absent_from_current_batch_owner_inventory"
      })
      .in("id", ids);
    check(error, "retire absent batch-scoped social account owners");
  });
  return staleIds.length;
}

function socialAccountOwnerKey(owner) {
  const identity = [
    owner.batchSlug,
    owner.entityType,
    owner.entitySourceKey,
    owner.account.sourceKey
  ].join("\u0000");
  return `owner:${createHash("sha256").update(identity).digest("hex")}`;
}

function socialAccountIdentity(account) {
  return `${String(account.platform).toLowerCase()}\u0000${canonicalAccountUrl(account.url)}`;
}

function canonicalAccountUrl(value) {
  const raw = String(value ?? "").trim();
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw;
  }
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
        : catalogState.founderByBatchSourceKey.get(batchCompanyKey(task.batchSlug, task.entitySourceKey)),
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

async function prepareBatchDiscoveryState() {
  const [publishedAttempts, publishedPaths] = await Promise.all([
    readRequiredCanonicalRows(
      publishedDiscoveryAttemptsPath,
      "Canonical discovery attempts ledger"
    ),
    readRequiredCanonicalRows(
      publishedSourceDiscoveryPathsPath,
      "Canonical source discovery paths ledger"
    )
  ]);
  await Promise.all(AUTONOMOUS_BATCHES.map(async (batch) => {
    const catalog = catalogs.find((candidate) => candidate.slug === batch.slug);
    const companySlugs = new Set((catalog?.companies ?? []).map(plannedCompanySlug));
    const belongsToBatch = (row) => {
      const rowBatch = row?.batch_slug ?? row?.batchSlug;
      if (rowBatch) return rowBatch === batch.slug;
      const slug = row?.company_slug ?? row?.companySlug ?? String(row?.company_id ?? row?.companyId ?? "")
        .replace(/^company-/, "")
        .replace(/^a16z-speedrun-006-/, "");
      return companySlugs.has(slug);
    };
    await Promise.all([
      writeJsonAtomic(discoveryAttemptOutputs.get(batch.slug), publishedAttempts.filter(belongsToBatch)),
      writeJsonAtomic(sourceDiscoveryPathOutputs.get(batch.slug), publishedPaths.filter(belongsToBatch))
    ]);
  }));
}

async function prepareSanitizedPublicSnapshot(publicSnapshots, { baseRef = null } = {}) {
  if (publicSnapshots.length === 0) return null;
  const publicEvidencePath = "src/lib/social/public-evidence-current.json";
  const basePublicSnapshot = baseRef ? await readJsonFromGitRef(baseRef, publicEvidencePath, null) : null;
  const previousPublicSnapshot = await readRequiredCanonicalJson(
    join(root, publicEvidencePath),
    "Canonical public evidence snapshot"
  );
  return mergePublicEvidenceSnapshots(
    [basePublicSnapshot, previousPublicSnapshot, ...publicSnapshots].filter(Boolean),
    {
      durableStorageConfigured,
      resolveBatchSlug: resolveLegacyPublicEvidenceBatch,
      resolveNativeAuthor: resolvePublicNativeAuthor
    }
  );
}

async function prepareSanitizedTargetedSnapshot(topVoiceRefresh, { baseRef = null } = {}) {
  const targetedEvidencePath = "src/lib/social/targeted-evidence-current.json";
  const [baseTargetedSnapshot, previousTargetedSnapshot] = await Promise.all([
    baseRef ? readJsonFromGitRef(baseRef, targetedEvidencePath, null) : null,
    readRequiredCanonicalJson(join(root, targetedEvidencePath), "Canonical targeted evidence snapshot")
  ]);
  return mergeTargetedEvidenceSnapshots(
    [baseTargetedSnapshot, previousTargetedSnapshot].filter(Boolean),
    topVoiceRefresh.isolatedEvidence.snapshot,
    {
      resolveBatchSlug: resolveLegacyPublicEvidenceBatch,
      validateEntityAttribution: isCanonicalBatchEntityAttribution
    }
  );
}

function combineAttributionReconciliationLedgers(...ledgers) {
  const byPhysicalTarget = new Map();
  for (const entry of ledgers.flatMap((ledger) => ledger ?? [])) {
    const stale = entry?.staleAttribution;
    if (!entry?.platform || !stale?.batchSlug || !stale?.entityId) continue;
    const key = [
      entry.platform,
      entry.platformPostId ?? entry.sourceUrl,
      stale.batchSlug,
      stale.entityType ?? "company",
      stale.entityId,
      stale.attributionType ?? "subject"
    ].join(":");
    const previous = byPhysicalTarget.get(key);
    if (!previous || (previous.disposition === "quarantined" && entry.disposition === "reattributed")) {
      byPhysicalTarget.set(key, entry);
    }
  }
  return [...byPhysicalTarget.values()];
}

async function mergePublicationInputs(
  {
    publicSnapshots,
    githubSnapshots,
    publicResults,
    topVoiceRefresh,
    sanitizedPublicSnapshot = null,
    sanitizedTargetedSnapshot = null
  },
  { baseRef = null } = {}
) {
  const publicEvidencePath = "src/lib/social/public-evidence-current.json";
  if (publicSnapshots.length > 0) {
    const trustedPublicSnapshot = sanitizedPublicSnapshot ?? (
      baseRef
        ? await prepareSanitizedPublicSnapshot(publicSnapshots, { baseRef })
        : await prepareSanitizedPublicSnapshot(publicSnapshots)
    );
    await writeJsonAtomic(
      join(root, publicEvidencePath),
      trustedPublicSnapshot
    );
  }

  const targetedEvidencePath = "src/lib/social/targeted-evidence-current.json";
  const trustedTargetedSnapshot = sanitizedTargetedSnapshot ?? (
    baseRef
      ? await prepareSanitizedTargetedSnapshot(topVoiceRefresh, { baseRef })
      : await prepareSanitizedTargetedSnapshot(topVoiceRefresh)
  );
  await writeJsonAtomic(
    join(root, targetedEvidencePath),
    trustedTargetedSnapshot
  );

  const [baseAttempts, basePaths] = baseRef
    ? await Promise.all([
        readJsonFromGitRef(baseRef, "outputs/discovery-attempts-current.json", []),
        readJsonFromGitRef(baseRef, "outputs/source-discovery-paths-current.json", [])
      ])
    : [[], []];
  const mergedDiscoveryState = await mergeCollectorDiscoveryState(publicResults, { baseAttempts, basePaths });
  await writeJsonAtomic(publishedDiscoveryAttemptsPath, mergedDiscoveryState.discoveryAttempts);
  await writeJsonAtomic(publishedSourceDiscoveryPathsPath, mergedDiscoveryState.sourceDiscoveryPaths);
  await publishGithubExports(githubSnapshots, { baseRef });
}

async function mergeCollectorDiscoveryState(publicResults, { baseAttempts = [], basePaths = [] } = {}) {
  const [publishedAttempts, publishedPaths] = await Promise.all([
    readRequiredCanonicalRows(
      publishedDiscoveryAttemptsPath,
      "Canonical discovery attempts ledger"
    ),
    readRequiredCanonicalRows(
      publishedSourceDiscoveryPathsPath,
      "Canonical source discovery paths ledger"
    )
  ]);
  const attempts = [baseAttempts, publishedAttempts];
  const paths = [basePaths, publishedPaths];
  for (const result of publicResults) {
    attempts.push(await readJson(discoveryAttemptOutputs.get(result.batchSlug), []));
    paths.push(await readJson(sourceDiscoveryPathOutputs.get(result.batchSlug), []));
  }
  return {
    discoveryAttempts: newestRowsById(attempts.flat()),
    sourceDiscoveryPaths: newestRowsById(paths.flat())
  };
}

async function readJsonFromGitRef(ref, path, fallback) {
  const result = await runCommand("git", ["show", `${ref}:${path}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: `read ${path} from ${ref}`,
    allowedExitCodes: [0, 128],
    quiet: true,
    captureLimit: 50_000_000
  });
  if (result.code !== 0) return fallback;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Invalid JSON at ${ref}:${path}: ${errorMessage(error)}`);
  }
}

function newestRowsById(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const previous = byId.get(row.id);
    const rowTime = Date.parse(row.last_checked_at ?? row.checkedAt ?? row.created_at ?? 0) || 0;
    const previousTime = Date.parse(
      previous?.last_checked_at ?? previous?.checkedAt ?? previous?.created_at ?? 0
    ) || 0;
    if (!previous || rowTime >= previousTime) byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function plannedCompanySlug(company) {
  try {
    const parts = new URL(company.profileUrl).pathname.split("/").filter(Boolean);
    const companiesIndex = parts.indexOf("companies");
    if (companiesIndex >= 0 && parts[companiesIndex + 1]) return parts[companiesIndex + 1];
  } catch {
    // Fall through to the stable source key.
  }
  return String(company.sourceKey).replace(/^company-/, "").replace(/^a16z-speedrun-006-/, "");
}

function normalizedCatalogAlias(value) {
  return String(value ?? "").trim().toLowerCase() || null;
}

function isCanonicalBatchEntityAttribution(row, batchSlug) {
  const catalog = catalogs.find((candidate) => candidate.slug === batchSlug);
  if (!catalog) return false;
  const entityType = String(row?.entityType ?? row?.entity_type ?? "").toLowerCase();
  const entityId = String(row?.entityId ?? row?.entity_id ?? "");
  const companyName = normalizedCatalogAlias(row?.companyName ?? row?.company_name);
  for (const company of catalog.companies) {
    if (companyName !== normalizedCatalogAlias(company.name)) continue;
    if (entityType === "company" && entityId === company.sourceKey) return true;
    if (entityType === "founder" && company.founders.some((founder) => founder.sourceKey === entityId)) return true;
  }
  return false;
}

function withSnapshotBatchProvenance(snapshot) {
  const batchSlug = snapshot?.source?.batchSlug;
  if (!batchSlug) throw new Error("A public collector snapshot is missing source.batchSlug.");
  const annotate = (rows) => (rows ?? []).map((row) => ({
    ...row,
    batchSlug: row.batchSlug ?? row.batch_slug ?? batchSlug
  }));
  return {
    ...snapshot,
    evidence: annotate(snapshot.evidence),
    needsReview: annotate(snapshot.needsReview),
    failures: annotate(snapshot.failures)
  };
}

async function runCollectors() {
  await prepareBatchDiscoveryState();
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
          "--discover-missing-social",
          "--workers=16",
          "--linkedin-workers=4",
          "--instagram-workers=8",
          "--fresh-for-hours=11",
          `--output=${publicOutputs.get(batchSlug)}`,
          `--checkpoint=${join(workRoot, `checkpoint-public-${batchSlug.toLowerCase()}.json`)}`,
          `--discovery-attempts=${discoveryAttemptOutputs.get(batchSlug)}`,
          `--source-discovery-paths=${sourceDiscoveryPathOutputs.get(batchSlug)}`
        ],
        { timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.publicCollectorAttemptMs, label: `public ${batchSlug}` }
      )
    })),
    ...AUTONOMOUS_BATCHES.map((batch) => {
      const companyCount = catalogs.find((catalog) => catalog.slug === batch.slug)?.companies.length;
      if (!companyCount) throw new Error(`No company catalog is available for GitHub collection in ${batch.slug}.`);
      return {
        kind: "github",
        batchSlug: batch.slug,
        outputPath: githubOutputs.get(batch.slug),
        expectedSourcePath: batch.githubSourcePath,
        run: () => runCommand(
          process.execPath,
          [
            "scripts/fetch-github-traction.mjs",
            `--batch=${batch.slug}`,
            // Official-page and mapped-account fetches are ordinary GitHub/web
            // reads and must cover the full cohort within the process budget.
            // Search API calls use their own single-worker lane because all
            // cohorts share one workflow token and search rate-limit bucket.
            "--workers=16",
            "--search-workers=1",
            "--website",
            "--search",
            // GitHub fallback issues at most two review-only queries per
            // company. Budget the complete cohort instead of silently
            // truncating discovery after an arbitrary global prefix.
            `--max-searches=${companyCount * 2}`,
            `--output=${githubOutputs.get(batch.slug)}`
          ],
          { timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.githubCollectorAttemptMs, label: `github ${batch.slug}` }
        )
      };
    })
  ];
  let githubQueue = Promise.resolve();
  for (const command of commands) {
    if (command.kind === "github") {
      command.promise = githubQueue.then(() => runCollectorWithRetries(command));
      githubQueue = command.promise.catch(() => {});
    } else {
      command.promise = runCollectorWithRetries(command);
    }
  }
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
      retryableFailures: result.status === "fulfilled" ? result.value.retryableFailures : 0,
      exhaustedRetryableFailures: result.status === "fulfilled"
        ? result.value.exhaustedRetryableFailures
        : 0,
      terminalCoverage: result.status === "fulfilled" ? result.value.terminalCoverage : null,
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
    let retryReasons = [];
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
      const terminalCoverage = summarizeAutonomousCollectorTerminalTaskCoverage(snapshot, {
        kind: command.kind,
        batchSlug: command.batchSlug,
        tasks: plannedTasks
      });
      if (retryableFailures.length === 0 && terminalCoverage.nonTerminal === 0) {
        return {
          attempts: attempt,
          retryableFailures: retryableFailures.length,
          exhaustedRetryableFailures: 0,
          successfulRows: successfulCollectorRowCount(snapshot, command.kind),
          terminalCoverage
        };
      }
      retryReasons = [
        ...retryableFailures,
        ...(terminalCoverage.nonTerminal > 0
          ? [`${terminalCoverage.nonTerminal}/${terminalCoverage.expected} planned task(s) lack explicit terminal outcomes.`]
          : [])
      ];
      if (attempt === maxAttempts) {
        if (terminalCoverage.nonTerminal > 0) {
          await event(
            "collector.retry_exhausted",
            "error",
            `${command.kind} ${command.batchSlug} exhausted retries before explicit task coverage was complete.`,
            { attempt, maxAttempts, retryableFailures, terminalCoverage }
          );
          throw new Error(
            `${command.kind} ${command.batchSlug} exhausted retries with ` +
            `${terminalCoverage.nonTerminal}/${terminalCoverage.expected} planned task(s) lacking explicit terminal outcomes.`
          );
        }
        await event(
          "collector.retry_exhausted",
          "warning",
          `${command.kind} ${command.batchSlug} exhausted retryable failures after every planned task reached an explicit terminal outcome.`,
          { attempt, maxAttempts, exhaustedRetryableFailures: retryableFailures, terminalCoverage }
        );
        return {
          attempts: attempt,
          retryableFailures: retryableFailures.length,
          exhaustedRetryableFailures: retryableFailures.length,
          successfulRows: successfulCollectorRowCount(snapshot, command.kind),
          terminalCoverage
        };
      }
      await event("collector.retry_scheduled", "warning", `${command.kind} ${command.batchSlug} requires another attempt.`, {
        attempt,
        maxAttempts,
        retryableFailures,
        terminalCoverage
      });
    } catch (error) {
      lastError = error;
      retryReasons = retryReasons.length ? retryReasons : [errorMessage(error)];
      if (attempt === maxAttempts) throw error;
      await event("collector.retry_scheduled", "warning", `${command.kind} ${command.batchSlug} process failed.`, {
        attempt,
        maxAttempts,
        error: errorMessage(error)
      });
    }
    const rateLimited = retryReasons.some((reason) =>
      /(?:rate.?limit|secondary.?limit|\b403\b|forbidden|\b429\b)/i.test(String(reason))
    );
    await delay(rateLimited
      ? 65_000
      : Math.min(
          AUTONOMOUS_PROCESS_BUDGETS.collectorRetryDelayMaxMs,
          1_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 1_000)
        ));
  }
  throw lastError ?? new Error(`${command.kind} ${command.batchSlug} exhausted retries.`);
}

function retryableFailuresFromSnapshot(snapshot) {
  return autonomousCollectorRetryableFailures(snapshot);
}

function successfulCollectorRowCount(snapshot, kind) {
  return countSuccessfulAutonomousCollectorRows(snapshot, kind);
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
    const outcomeIndex = result.ok
      ? indexAutonomousCollectorTaskOutcomes(snapshot, {
          kind: result.kind,
          batchSlug: result.batchSlug
        })
      : null;
    for (const platform of platforms) {
      const tasks = await tasksFor(result.batchSlug, platform, catalogState);
      for (const task of tasks) {
        const plannedTask = plannedTaskByCheckpointKey.get(task.checkpoint_key);
        const outcome = classifyAutonomousCollectorTaskOutcome(outcomeIndex, {
          platform,
          entityType: plannedTask?.entityType ?? task.entity_type,
          entityId: plannedTask?.entitySourceKey ?? task.company_name,
          accountUrl: plannedTask?.account?.url ?? null,
          collectorOk: result.ok,
          collectorError: result.error
        });
        const { status, reason } = outcome;
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

async function importDurableEvidence({
  publicSnapshots,
  githubSnapshots,
  catalogState,
  attributionReconciliationLedger = []
}) {
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
  const companyAliasesByBatch = new Map();
  const founderAliasesByBatch = new Map();
  const founderBatchSlugsById = new Map();
  for (const catalog of catalogs) {
    for (const company of catalog.companies) {
      const companyId = catalogState.companyByBatchSourceKey.get(
        batchCompanyKey(catalog.slug, company.sourceKey)
      );
      for (const alias of [
        company.sourceKey,
        plannedCompanySlug(company),
        company.name,
        company.sourceKey.replace(/^company[:-]/, ""),
        company.sourceKey.replace(/^a16z-speedrun-006[:-]/, "")
      ]) {
        if (alias) companyAliasesByBatch.set(batchCompanyKey(catalog.slug, alias), companyId);
      }
      for (const founder of company.founders) {
        const founderId = catalogState.founderByBatchSourceKey.get(
          batchCompanyKey(catalog.slug, founder.sourceKey)
        );
        const founderBatches = founderBatchSlugsById.get(founderId) ?? new Set();
        founderBatches.add(catalog.slug);
        founderBatchSlugsById.set(founderId, founderBatches);
        for (const alias of [founder.sourceKey, founder.name]) {
          if (alias) founderAliasesByBatch.set(batchCompanyKey(catalog.slug, alias), founderId);
        }
      }
    }
  }
  const result = await importer.importEvidenceSnapshots({
    client: supabase,
    ingestionRunId: run.id,
    requireCompleteAttribution: true,
    publicSnapshots,
    githubSnapshots,
    attributionReconciliationLedger,
    catalog: {
      batchBySlug: catalogState.batchBySlug,
      companyByBatchEntityId: companyAliasesByBatch,
      companyByBatchSlug: companyAliasesByBatch,
      founderByBatchEntityId: founderAliasesByBatch,
      founderBatchCountById: new Map(
        [...founderBatchSlugsById].map(([founderId, batchSlugs]) => [founderId, batchSlugs.size])
      )
    }
  });
  return { status: "completed", configured: true, ...result };
}

function assertDurableAttributionCompleteness(importResult) {
  if (
    importResult.status === "completed" &&
    importResult.configured === true &&
    (importResult.attributions?.unresolved ?? 0) > 0
  ) {
    throw new Error(
      `Durable evidence import has ${importResult.attributions.unresolved} unresolved_attribution row(s); ` +
      "publication is prohibited."
    );
  }
}

async function summarizeCollectionCoverage(tasks, collectionResults, { skipNetwork }) {
  const resultByCollector = new Map(
    collectionResults.map((result) => [`${result.batchSlug}:${result.kind}`, result])
  );
  const outcomeIndexByCollector = new Map();
  for (const result of collectionResults) {
    const snapshot = result.ok
      ? await readCollectorSnapshot(result.outputPath, result.kind, result)
      : null;
    outcomeIndexByCollector.set(
      `${result.batchSlug}:${result.kind}`,
      snapshot
        ? indexAutonomousCollectorTaskOutcomes(snapshot, {
            kind: result.kind,
            batchSlug: result.batchSlug
          })
        : null
    );
  }

  const report = {
    expected: tasks.length,
    attempted: 0,
    succeeded: 0,
    needsReview: 0,
    blockedOrEmpty: 0,
    failed: 0,
    skipped: 0,
    nonTerminal: 0,
    mappedExpected: tasks.filter((task) => task.status === "queued" && Boolean(task.account)).length,
    mappedSucceeded: 0,
    mappedNeedsReview: 0,
    mappedBlockedOrEmpty: 0,
    mappedFailed: 0,
    mappedNonTerminal: 0,
    coveragePercentage: 0,
    generatedAt: new Date().toISOString()
  };
  for (const task of tasks) {
    if (skipNetwork) {
      report.skipped += 1;
      continue;
    }
    if (task.status !== "queued") {
      if (task.status === "needs_review") report.needsReview += 1;
      else if (task.status === "blocked_or_empty") report.blockedOrEmpty += 1;
      else if (task.status === "failed") report.failed += 1;
      else report.skipped += 1;
      continue;
    }
    const kind = task.platform === "github" ? "github" : "public";
    const collectorKey = `${task.batchSlug}:${kind}`;
    const result = resultByCollector.get(collectorKey);
    if (!result) {
      report.nonTerminal += 1;
      if (task.account) report.mappedNonTerminal += 1;
      continue;
    }
    const outcome = classifyAutonomousCollectorTaskOutcome(
      outcomeIndexByCollector.get(collectorKey),
      {
        platform: task.platform,
        entityType: task.entityType,
        entityId: task.entitySourceKey,
        accountUrl: task.account?.url ?? null,
        collectorOk: result.ok,
        collectorError: result.error
      }
    );
    if (outcome.status === "completed") report.succeeded += 1;
    else if (outcome.status === "needs_review") report.needsReview += 1;
    else if (outcome.status === "blocked_or_empty") report.blockedOrEmpty += 1;
    else report.failed += 1;
    if (task.account) {
      if (outcome.status === "completed") report.mappedSucceeded += 1;
      else if (outcome.status === "needs_review") report.mappedNeedsReview += 1;
      else if (outcome.status === "blocked_or_empty") report.mappedBlockedOrEmpty += 1;
      else report.mappedFailed += 1;
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
  const isolatedEvidence = receipt.isolatedEvidence;
  if (
    !isolatedEvidence
    || typeof isolatedEvidence.path !== "string"
    || !isolatedEvidence.snapshot
    || !Array.isArray(isolatedEvidence.snapshot.evidence)
    || !Array.isArray(isolatedEvidence.snapshot.needsReview)
  ) {
    throw new Error("Top Voice discovery did not expose its isolated row-level evidence artifact.");
  }
  if (isolatedEvidence.evidenceCount !== isolatedEvidence.snapshot.evidence.length) {
    throw new Error("Top Voice isolated evidence receipt count does not match its row-level artifact.");
  }
}

async function persistCoverage(catalogState, stageCounters) {
  const { data: tasks, error } = await supabase
    .from("ingestion_tasks")
    .select("status,platform,batch_id,terminal_reason,checkpoint_key")
    .eq("ingestion_run_id", run.id);
  check(error, "read terminal coverage");
  const terminalStatuses = new Set(["completed", "needs_review", "blocked_or_empty", "skipped", "failed", "canceled", "dead_lettered"]);
  const needsReview = (tasks ?? []).filter((task) => task.status === "needs_review").length;
  const blockedOrEmpty = (tasks ?? []).filter((task) => task.status === "blocked_or_empty").length;
  const skipped = (tasks ?? []).filter((task) => task.status === "skipped").length;
  const mappedCheckpointKeys = new Set(
    plannedTasks
      .filter((task) => task.status === "queued" && Boolean(task.account))
      .map((task) => task.checkpointKey)
  );
  const mappedTasks = (tasks ?? []).filter((task) => mappedCheckpointKeys.has(task.checkpoint_key));
  const report = {
    expected: tasks?.length ?? 0,
    attempted: (tasks ?? []).filter((task) => task.status !== "queued").length,
    succeeded: (tasks ?? []).filter((task) => task.status === "completed").length,
    needsReview,
    blockedOrEmpty,
    failed: (tasks ?? []).filter((task) => ["failed", "dead_lettered"].includes(task.status)).length,
    skipped,
    nonTerminal: (tasks ?? []).filter((task) => !terminalStatuses.has(task.status)).length,
    mappedExpected: mappedCheckpointKeys.size,
    mappedSucceeded: mappedTasks.filter((task) => task.status === "completed").length,
    mappedNeedsReview: mappedTasks.filter((task) => task.status === "needs_review").length,
    mappedBlockedOrEmpty: mappedTasks.filter((task) => task.status === "blocked_or_empty").length,
    mappedFailed: mappedTasks.filter((task) => ["failed", "dead_lettered"].includes(task.status)).length,
    mappedNonTerminal: mappedTasks.filter((task) => !terminalStatuses.has(task.status)).length,
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
      skipped_count: report.skipped + report.needsReview + report.blockedOrEmpty,
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

async function buildAndValidatePublication(publicationRunId) {
  await runCommand(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.productionBuildMs,
    label: "production build"
  });
  await runCommand(process.execPath, ["scripts/update-daily-benchmarks.mjs"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.benchmarkPublicationMs,
    label: "graph and benchmark publication",
    env: { INGESTION_RUN_ID: publicationRunId }
  });
  await runCommand(process.execPath, [
    "scripts/audit-cohort-coverage.mjs",
    `--run-dir=${workRoot}`,
    `--output=${publishedCohortAuditPath}`
  ], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "cohort coverage audit"
  });
  await runCommand(process.execPath, ["scripts/write-artifact-manifest.mjs", `--ingestion-run-id=${publicationRunId}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactManifestMs,
    label: "artifact manifest"
  });
  await runCommand(process.execPath, ["scripts/validate-public-artifacts.mjs"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.artifactValidationMs,
    label: "artifact validation"
  });
}

async function synchronizePublicationBase() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const branch = publicationBranch();
  await runCommand("git", ["fetch", "origin", branch], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: "fetch publication base"
  });
  try {
    await runCommand("git", ["rebase", "--autostash", `origin/${branch}`], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
      label: "synchronize publication base"
    });
  } catch (error) {
    await abortPublicationRebase();
    throw error;
  }
  await assertNoPublicationConflicts();
  await event("publication.base_synchronized", "info", "Publication base synchronized before artifact generation.", {
    branch
  });
}

async function publishGithubExports(snapshots, { baseRef = null } = {}) {
  const destinations = new Map([
    ["S2026", join(root, "src", "lib", "social", "github-traction.json")],
    ["S26", join(root, "src", "lib", "social", "github-traction-summer-2026.json")],
    ["A16ZSR006", join(root, "src", "lib", "social", "github-traction-a16z-speedrun-006.json")]
  ]);

  // Read every canonical export before writing any of them. A missing or
  // malformed cohort snapshot must abort the merge without partially replacing
  // another cohort's last-good GitHub state.
  const previousByBatch = new Map(await Promise.all(
    [...destinations].map(async ([batchSlug, destination]) => [
      batchSlug,
      await readRequiredCanonicalJson(
        destination,
        `Canonical GitHub traction snapshot for ${batchSlug}`
      )
    ])
  ));

  for (const snapshot of snapshots) {
    const batchSlug = snapshot.source.batchSlug;
    const destination = destinations.get(batchSlug);
    if (!destination) throw new Error(`No GitHub publication destination is configured for ${batchSlug}.`);
    const relativeDestination = destination.slice(root.length + 1);
    const base = baseRef ? await readJsonFromGitRef(baseRef, relativeDestination, null) : null;
    const previous = previousByBatch.get(batchSlug);
    const synchronized = base ? mergeGithubTractionSnapshots(base, previous) : previous;
    await writeJsonAtomic(destination, mergeGithubTractionSnapshots(synchronized, snapshot));
  }
}

async function publishRepositoryArtifacts(publicationRunId, publicationInputs) {
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
  await stageRepositoryArtifacts();

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
  const branch = publicationBranch();
  const firstPush = await runCommand("git", ["push", "origin", `HEAD:${branch}`], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
    label: "push refreshed artifacts",
    allowedExitCodes: [0, 1]
  });
  if (firstPush.code !== 0) {
    await event(
      "publication.push_retry",
      "warning",
      "Publication push was rejected; rebasing, rebuilding, and validating once before retry.",
      { branch, stderr: firstPush.stderr }
    );
    try {
      await runCommand("git", ["fetch", "origin", branch], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
        label: "fetch publication retry base"
      });
      await runCommand("git", ["rebase", `origin/${branch}`], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
        label: "rebase publication commit"
      });
    } catch (error) {
      await abortPublicationRebase();
      throw error;
    }
    await assertNoPublicationConflicts();
    const rebasedSanitizedPublicSnapshot = await prepareSanitizedPublicSnapshot(
      publicationInputs.publicSnapshots,
      { baseRef: `origin/${branch}` }
    );
    const rebasedSanitizedTargetedSnapshot = await prepareSanitizedTargetedSnapshot(
      publicationInputs.topVoiceRefresh,
      { baseRef: `origin/${branch}` }
    );
    const rebasedPublicationInputs = {
      ...publicationInputs,
      sanitizedPublicSnapshot: rebasedSanitizedPublicSnapshot,
      sanitizedTargetedSnapshot: rebasedSanitizedTargetedSnapshot
    };
    const retryDurableImport = await importDurableEvidence({
      publicSnapshots: [
        rebasedSanitizedPublicSnapshot,
        rebasedSanitizedTargetedSnapshot
      ].filter(Boolean),
      githubSnapshots: publicationInputs.githubSnapshots,
      catalogState: publicationInputs.catalogState,
      attributionReconciliationLedger: combineAttributionReconciliationLedgers(
        rebasedSanitizedPublicSnapshot?.attributionReconciliationLedger,
        rebasedSanitizedTargetedSnapshot?.attributionReconciliationLedger
      )
    });
    assertDurableAttributionCompleteness(retryDurableImport);
    await mergePublicationInputs(rebasedPublicationInputs, { baseRef: `origin/${branch}` });
    await buildAndValidatePublication(publicationRunId);
    if (run) await persistArtifactManifest(run.id);
    await stageRepositoryArtifacts();
    const rebuiltDiff = await runCommand("git", ["diff", "--cached", "--quiet"], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
      label: "check rebuilt artifacts",
      allowedExitCodes: [0, 1]
    });
    if (rebuiltDiff.code === 1) {
      await runCommand("git", ["commit", "--amend", "--no-edit"], {
        timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitCommitMs,
        label: "amend rebuilt artifacts"
      });
    }
    await runCommand("git", ["push", "origin", `HEAD:${branch}`], {
      timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitPushMs,
      label: "retry refreshed artifact push"
    });
  }
  await event("publication.completed", "info", "Refreshed artifacts were committed and pushed.", {
    idempotencyKey,
    publicationRunId,
    branch,
    retriedAfterNonFastForward: firstPush.code !== 0,
    publishedPaths: repositoryArtifactPaths()
  });
}

async function stageRepositoryArtifacts() {
  await runCommand("git", [
    "add", "--",
    ...repositoryArtifactPaths()
  ], { timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitStageMs, label: "stage refreshed artifacts" });
}

function repositoryArtifactPaths() {
  return [
    "public/graph",
    "outputs/benchmarks",
    "outputs/cohort-coverage-current.json",
    "outputs/discovery-attempts-current.json",
    "outputs/source-discovery-paths-current.json",
    "src/lib/social/public-evidence-current.json",
    "src/lib/social/targeted-evidence-current.json",
    "src/lib/social/github-traction.json",
    "src/lib/social/github-traction-summer-2026.json",
    "src/lib/social/github-traction-a16z-speedrun-006.json"
  ];
}

function publicationBranch() {
  const branch = String(process.env.GITHUB_REF_NAME ?? "main").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`Unsafe publication branch: ${branch || "empty"}.`);
  }
  return branch;
}

async function assertNoPublicationConflicts() {
  const conflicts = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "check publication conflicts"
  });
  if (conflicts.stdout.trim()) {
    throw new Error(`Publication rebase left unresolved conflicts: ${conflicts.stdout.trim()}`);
  }
}

async function abortPublicationRebase() {
  await runCommand("git", ["rebase", "--abort"], {
    timeoutMs: AUTONOMOUS_PROCESS_BUDGETS.gitDiffMs,
    label: "abort failed publication rebase",
    allowedExitCodes: [0, 128]
  }).catch(() => {});
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

async function runCommand(command, commandArgs, {
  timeoutMs,
  label,
  env = {},
  allowedExitCodes = [0],
  quiet = false,
  captureLimit = 40_000
}) {
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
      stdout = tail(`${stdout}${chunk}`, captureLimit);
      if (!quiet) process.stdout.write(`[${label}] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(`${stderr}${chunk}`, captureLimit);
      if (!quiet) process.stderr.write(`[${label}] ${chunk}`);
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
      const eventPayload = { ...payload, stdout: tail(stdout, 40_000), stderr: tail(stderr, 40_000) };
      if (timedOut) {
        await event("command.failed", "error", `${label} timed out.`, eventPayload).catch(() => {});
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== null && allowedExitCodes.includes(code)) {
        if (heartbeatFailure) {
          reject(new Error(`Ingestion lease heartbeat failed while ${label} was running.`));
          return;
        }
        await event("command.completed", "info", `${label} completed.`, eventPayload).catch(() => {});
        resolve(payload);
      } else {
        await event("command.failed", "error", `${label} failed.`, eventPayload).catch(() => {});
        reject(new Error(`${label} exited with ${code ?? signal ?? "unknown status"}.`));
      }
    });
  });
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
    const snapshot = validateAutonomousCollectorSnapshot(value, {
      kind,
      batchSlug: validation.batchSlug,
      expectedSourcePath: validation.expectedSourcePath,
      notBefore: validation.notBefore ?? null
    });
    return validateAutonomousCollectorReferentialIntegrity(snapshot, {
      kind,
      batchSlug: validation.batchSlug,
      catalog: catalogs.find((catalog) => catalog.slug === validation.batchSlug)
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

async function writeRunnerOutcome(status) {
  const githubOutput = cleanEnv(process.env.GITHUB_OUTPUT);
  if (!githubOutput) return;
  await appendFile(githubOutput, `runner_status=${status}\n`, "utf8");
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function readRequiredCanonicalRows(path, label) {
  const rows = await readRequiredCanonicalJson(path, label);
  if (!Array.isArray(rows)) {
    throw new Error(`${label} must contain a JSON array at ${path}.`);
  }
  return rows;
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
