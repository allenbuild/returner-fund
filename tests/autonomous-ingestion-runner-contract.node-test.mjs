import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readRequiredCanonicalJson } from "../scripts/lib/canonical-json.mjs";

const repositoryRoot = process.cwd();
const runnerPath = path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs");
const [runner, autonomousPlan] = await Promise.all([
  readFile(runnerPath, "utf8"),
  readFile(path.join(repositoryRoot, "scripts", "lib", "autonomous-ingestion-plan.mjs"), "utf8")
]);
const supabaseConfiguration = await readFile(
  path.join(repositoryRoot, "scripts", "lib", "supabase-configuration.mjs"),
  "utf8"
);
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("autonomous ingestion runner CLI", () => {
  it("prints a complete plan without Supabase credentials or side effects in the repository", async () => {
    const root = await createRunnerRoot("autonomous-ingestion-plan-");
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;

    const result = spawnSync(
      process.execPath,
      [runnerPath, "--plan", "--idempotency-key=plan-contract"],
      { cwd: root, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.idempotencyKey, "plan-contract");
    assert.deepEqual(plan.batches.filter((batch) => batch.slug !== "S26"), [
      { slug: "S2026", companies: 197, founders: 397, accounts: 994 },
      { slug: "A16ZSR006", companies: 59, founders: 128, accounts: 339 }
    ]);
    const summer = plan.batches.find((batch) => batch.slug === "S26");
    assert.ok(summer.companies >= 167);
    assert.ok(summer.founders > 0);
    assert.ok(summer.accounts > 0);
    assert.equal(plan.coverage.expected, plan.coverage.queued + plan.coverage.terminal);
    assert.deepEqual(plan.concurrency, {
      publicShardProcesses: 2,
      publicTasksPerProcess: 8,
      publicTasksAcrossProcesses: 16,
      publicSocialLanePerProcess: 1,
      publicSocialLaneAcrossProcesses: 2
    });
  });

  it("refuses to complete file-backed mode when collection was explicitly skipped", async () => {
    const root = await createRunnerRoot("autonomous-ingestion-file-mode-");
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;

    const result = spawnSync(
      process.execPath,
      [runnerPath, "--idempotency-key=file-contract", "--skip-network", "--skip-publish"],
      { cwd: root, env, encoding: "utf8" }
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Durable Supabase import skipped/);
    assert.match(result.stderr, /No collector completed successfully/);
    assert.doesNotMatch(result.stdout, /"status": "completed"/);
  });

  it("records an invalid Supabase URL as a blocker and continues in file-backed mode", async () => {
    const root = await createRunnerRoot("autonomous-ingestion-invalid-supabase-");
    const env = {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "masked-or-misconfigured-value",
      SUPABASE_SERVICE_ROLE_KEY: "configured-but-not-used"
    };

    const result = spawnSync(
      process.execPath,
      [runnerPath, "--idempotency-key=invalid-supabase-contract", "--skip-network", "--skip-publish"],
      { cwd: root, env, encoding: "utf8" }
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /NEXT_PUBLIC_SUPABASE_URL:invalid_http_url/);
    assert.match(result.stderr, /File-backed collection and publication will continue/);
    assert.doesNotMatch(result.stderr, /Invalid supabaseUrl/);
  });

  it("stops a GitHub Actions file-backed replay before catalogs or collectors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-published-replay-"));
    temporaryRoots.push(root);
    const outputPath = path.join(root, "github-output.txt");
    const idempotencyKey = "central-2026-08-09-1800";
    await mkdir(path.join(root, "outputs"), { recursive: true });
    await writeFile(
      path.join(root, "outputs", "ingestion-source-delta-history.json"),
      `${JSON.stringify([{
        schemaVersion: 1,
        idempotencyKey,
        collectionHealth: "degraded",
        newPhysicalSources: 4,
        dailyNewPhysicalSources: 9,
        dailySourceHealth: "healthy"
      }])}\n`,
      "utf8"
    );
    const env = {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: outputPath,
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    };

    const result = spawnSync(
      process.execPath,
      [runnerPath, `--idempotency-key=${idempotencyKey}`],
      { cwd: root, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /validated publication receipt in main/);
    assert.doesNotMatch(result.stdout, /collection\.started|Public collectors started/);
    const outputs = await readFile(outputPath, "utf8");
    assert.match(outputs, /runner_status=already_completed/);
    assert.match(outputs, /publication_status=already_completed/);
    assert.match(outputs, /collection_health=degraded/);
    assert.match(outputs, /new_physical_sources=4/);
    assert.match(outputs, /daily_new_physical_sources=9/);
  });
});

describe("autonomous ingestion runner static safety contracts", () => {
  it("claims, renews, and releases a durable runtime lock", () => {
    assert.ok(runner.includes('supabase.rpc("claim_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("renew_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("release_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("finalize_completed_ingestion_run"'));
    assert.ok(runner.indexOf("if (durableStorageConfigured)") < runner.indexOf("runtimeLock = await claimRuntimeLock()"));
    assert.ok(runner.indexOf("runtimeLock = await claimRuntimeLock()") < runner.indexOf("run = await getOrCreateRun()"));
    assert.match(runner, /finally\s*{[\s\S]*if \(runtimeLock\)[\s\S]*await releaseRuntimeLock\(\)/);
  });

  it("allows file-backed recovery without Supabase but explicitly degrades workflow health", () => {
    assert.ok(runner.includes("const supabaseConfiguration = validateSupabaseConfiguration(url, serviceKey)"));
    assert.ok(runner.includes("const durableStorageConfigured = supabaseConfiguration.valid"));
    assert.ok(supabaseConfiguration.includes('`${SUPABASE_URL_BLOCKER}:invalid_http_url`'));
    assert.doesNotMatch(runner, /SUPABASE_SERVICE_ROLE_KEY are required/);
    assert.ok(runner.includes("workflow receipt will report degraded collection health"));
    assert.doesNotMatch(runner, /workflow receipt will fail/);
    assert.ok(runner.includes('status: "skipped"'));
    assert.ok(runner.includes('reason: "supabase_not_configured"'));
    assert.ok(runner.includes('runId: run?.id ?? null'));
  });

  it("runs timeline backfill in strict database mode only with validated durable storage", () => {
    const publicationBuild = section("async function buildAndValidatePublication", "async function synchronizePublicationBase");
    const timelineBackfill = section(
      "const timelineBackfillEnv = durableStorageConfigured",
      'await runCommand(process.execPath, ["scripts/validate-timeline-artifacts.mjs"]',
      publicationBuild
    );

    assert.match(
      timelineBackfill,
      /durableStorageConfigured\s*\?\s*{\s*TIMELINE_REQUIRE_DATABASE:\s*"true"\s*}/
    );
    assert.match(
      timelineBackfill,
      /:\s*{\s*NEXT_PUBLIC_SUPABASE_URL:\s*"",\s*SUPABASE_SERVICE_ROLE_KEY:\s*"",\s*TIMELINE_REQUIRE_DATABASE:\s*"false"\s*}/
    );
    assert.ok(timelineBackfill.includes('"scripts/backfill-company-timelines.mjs"'));
    assert.ok(timelineBackfill.includes("env: timelineBackfillEnv"));
  });

  it("carries credential gaps and mapped efficacy into the published health receipt", () => {
    assert.ok(runner.includes('!cleanEnv(process.env.X_BEARER_TOKEN) ? "X_BEARER_TOKEN"'));
    assert.ok(runner.includes('!cleanEnv(process.env.EXA_API_KEY) ? "EXA_API_KEY"'));
    assert.ok(runner.includes("collectionCoverage,"));
    assert.ok(runner.includes("credentialGaps: collectionCredentialGaps"));
    assert.ok(runner.includes("collectionHealthReasons"));
  });

  it("uses an explicit bounded terminal-failure budget for publication", () => {
    assert.match(
      runner,
      /const terminalFailureBudget = autonomousMappedTerminalFailureBudget\([\s\S]*maxTerminalFailures: args\.skipPublish[\s\S]*terminalFailureBudget/
    );
    assert.match(autonomousPlan, /AUTONOMOUS_MAPPED_TERMINAL_FAILURE_RATIO = 0\.05/);
    assert.match(runner, /mappedFailureSamples/);
    assert.match(runner, /COLLECTION_COVERAGE_RECEIPT/);
  });

  it("records a stale final day as a warning and still completes the verified run", () => {
    const staleGate = runner.indexOf('publicationInputs.sourceDelta.dailySourceHealth === "stale_day"');
    const completion = runner.indexOf('await completeRun("completed"');
    assert.ok(staleGate > -1 && completion > staleGate);
    const staleSection = runner.slice(staleGate, completion);
    assert.match(staleSection, /"warning"/);
    assert.match(staleSection, /verified publication/);
    assert.doesNotMatch(staleSection, /throw new Error/);
  });

  it("does not fail a quiet morning slot merely because publication had no changes", () => {
    assert.doesNotMatch(
      runner,
      /publicationReceipt\.status === "no_changes"[\s\S]{0,200}throw new Error/
    );
    assert.match(runner, /publicationStatus: publicationReceipt\.status/);
  });

  it("recovers completed-slot freshness metadata from current or historical receipts", () => {
    const completedReplay = section('if (run?.status === "completed")', "} else {");
    assert.ok(completedReplay.includes("publishedSourceDeltaPath"));
    assert.ok(completedReplay.includes("publishedSourceDeltaHistoryPath"));
    assert.ok(completedReplay.includes("selectPublishedAutonomousIngestionReceipt"));
  });

  it("uses a commit-backed receipt to make file-backed GitHub Actions replays idempotent", () => {
    const replayGate = section("const commitBackedReplay", "await Promise.all([");
    assert.ok(replayGate.includes('process.env.GITHUB_ACTIONS === "true"'));
    assert.ok(replayGate.includes("!durableStorageConfigured"));
    assert.ok(replayGate.includes("!args.skipPublish"));
    assert.ok(replayGate.includes('status: "already_completed"'));
    assert.ok(replayGate.includes('publicationStatus: "already_completed"'));
    assert.ok(runner.indexOf("const commitBackedReplay") < runner.indexOf("await refreshMutableYcCatalog()"));
    assert.ok(runner.indexOf("const commitBackedReplay") < runner.indexOf("runCollectors()"));
  });

  it("counts all canonical GitHub traction exports in source freshness after publication merge", () => {
    const baselineReader = section(
      "async function readPublicationEvidenceBaseline",
      "async function readSourceDeltaHistory"
    );
    for (const path of [
      "src/lib/social/github-traction.json",
      "src/lib/social/github-traction-summer-2026.json",
      "src/lib/social/github-traction-a16z-speedrun-006.json"
    ]) {
      assert.ok(baselineReader.includes(`"${path}"`));
    }
    assert.ok(baselineReader.includes("canonicalGithubContentIdentityRows(snapshot)"));
    for (const path of [
      "src/lib/social/logged-in-evidence-current.json",
      "src/lib/social/a16z-speedrun-006-social-evidence.json"
    ]) {
      assert.ok(
        baselineReader.includes(`"${path}"`),
        `${path} must prevent an already-published physical source from being recounted when promoted`
      );
    }

    const initialMerge = runner.indexOf("await mergePublicationInputs(publicationInputs)");
    const initialDelta = runner.indexOf(
      "afterSnapshots: await readPublicationEvidenceBaseline()",
      initialMerge
    );
    assert.ok(initialMerge > -1 && initialDelta > initialMerge);

    const rebasedMerge = runner.indexOf(
      "await mergePublicationInputs(rebasedPublicationInputs, { baseRef: `origin/${branch}` })"
    );
    const rebasedDelta = runner.indexOf(
      "afterSnapshots: await readPublicationEvidenceBaseline()",
      rebasedMerge
    );
    assert.ok(rebasedMerge > -1 && rebasedDelta > rebasedMerge);
  });

  it("carries the seeded A16Z retirement ledger through initial and rebased durable imports", () => {
    const reader = section(
      "async function readCanonicalSeededAttributionReconciliationLedger",
      "async function readPublicationEvidenceBaseline"
    );
    assert.ok(reader.includes('"src/lib/social/a16z-speedrun-006-attribution-reconciliation.json"'));
    assert.ok(reader.includes("readRequiredCanonicalJson"));
    assert.ok(reader.includes("readJsonFromGitRef"));

    assert.ok(runner.includes("publicationInputs.seededAttributionReconciliationLedger"));
    assert.ok(runner.includes("rebasedSeededAttributionReconciliationLedger"));
    assert.ok(
      runner.indexOf("publicationInputs.seededAttributionReconciliationLedger") <
      runner.indexOf("const durableImport = await importDurableEvidence")
    );
  });

  it("isolates work directories with a hash of the exact idempotency key", () => {
    const safePath = section("function safePathSegment", "function chunks");
    assert.ok(safePath.includes('createHash("sha256")'));
    assert.ok(safePath.includes("update(source)"));
  });

  it("never invokes a collector that depends on a logged-in browser session", () => {
    const collectors = section("async function runCollectors()", "async function runTopVoiceCollector");
    assert.doesNotMatch(collectors, /fetch-logged-in-social-traction|ingest:logged-social|logged[-_ ]?in/i);
    assert.ok(collectors.includes('"scripts/fetch-public-traction.mjs"'));
    assert.ok(collectors.includes('"scripts/fetch-github-traction.mjs"'));
  });

  it("refreshes and publishes the mutable Summer catalog before planning", () => {
    const refreshIndex = runner.indexOf("await refreshMutableYcCatalog()");
    const planningIndex = runner.indexOf("const catalogs = await loadAutonomousCatalogs(root)");
    const artifactPaths = section("function repositoryArtifactPaths", "async function refreshMutableYcCatalog");

    assert.ok(refreshIndex > -1 && refreshIndex < planningIndex);
    assert.ok(artifactPaths.includes('"src/lib/yc/summer-2026-companies.json"'));
    assert.ok(artifactPaths.includes('"src/lib/yc/summer-2026-company-aliases.json"'));
    const refresh = section("async function refreshMutableYcCatalog", "function publicationBranch");
    assert.ok(refresh.includes("AUTONOMOUS_PROCESS_BUDGETS.catalogRefreshMs"));
    assert.ok(refresh.includes('child.kill("SIGTERM")'));
    assert.ok(refresh.includes('child.kill("SIGKILL")'));
  });

  it("carries the batch-resolved logged-in quarantine ledger into initial and rebased durable imports", () => {
    const ledgerRead = section(
      "async function readCanonicalLoggedInAttributionReconciliationLedger",
      "function canonicalGithubContentIdentityRows"
    );
    assert.ok(ledgerRead.includes('"src/lib/social/logged-in-evidence-current.json"'));
    assert.ok(ledgerRead.includes("base?.attributionReconciliationLedger"));
    assert.ok(ledgerRead.includes("current.attributionReconciliationLedger"));
    assert.ok(runner.includes("publicationInputs.loggedInAttributionReconciliationLedger"));
    assert.ok(runner.includes("rebasedLoggedInAttributionReconciliationLedger"));
    assert.ok(
      runner.indexOf("publicationInputs.loggedInAttributionReconciliationLedger") <
      runner.indexOf("const durableImport = await importDurableEvidence")
    );
  });

  it("bounds public shard processes globally and rate-limits exhaustive GitHub batches through one queue", () => {
    const collectors = section("async function runCollectors()", "async function runTopVoiceCollector");
    const shardedCollector = section(
      "async function runShardedPublicCollector",
      "async function runPublicCollectorWithCheckpointRecovery"
    );
    const shardedGithubCollector = section(
      "async function runShardedGithubCollector",
      "async function runPublicCollectorWithCheckpointRecovery"
    );
    const successfulRows = section("function successfulCollectorRowCount", "async function reconcileCollectorTasks");

    assert.equal((collectors.match(/AUTONOMOUS_BATCHES\.map/g) ?? []).length, 2);
    assert.ok(collectors.includes('kind: "public"'));
    assert.ok(collectors.includes('kind: "github"'));
    assert.ok(collectors.includes("run: () => runShardedGithubCollector({"));
    assert.ok(collectors.includes("totalCompanyCount: companyCount"));
    assert.ok(collectors.includes("command.promise = runCollectorWithRetries(command)"));
    assert.ok(runner.includes("const PUBLIC_SHARD_PROCESS_CONCURRENCY = 2"));
    assert.ok(runner.includes("const PUBLIC_COLLECTOR_TASK_CONCURRENCY = 8"));
    assert.ok(runner.includes("const PUBLIC_SOCIAL_LANE_CONCURRENCY = 1"));
    assert.ok(shardedCollector.includes("runWithPublicShardProcessSlot(() =>"));
    assert.ok(collectors.includes("let githubQueue = Promise.resolve()"));
    assert.ok(collectors.includes("command.promise = githubQueue.then(() => runCollectorWithRetries(command))"));
    assert.ok(collectors.includes("runShardedGithubCollector"));
    assert.ok(shardedGithubCollector.includes("Promise.allSettled"));
    assert.ok(shardedGithubCollector.includes("`--company-shard-count=${shardCount}`"));
    assert.ok(shardedGithubCollector.includes("`--company-shard-index=${shard.shardIndex}`"));
    assert.ok(shardedGithubCollector.includes("githubShardSearchBudget(totalCompanyCount, shardCount, shardIndex)"));
    assert.ok(shardedGithubCollector.includes("`--max-searches=${shard.searchBudget}`"));
    assert.ok(shardedGithubCollector.includes("mergeGithubCollectorShards"));
    assert.ok(collectors.includes("await Promise.allSettled(commands.map((command) => command.promise))"));
    assert.ok(collectors.includes('"--discover-missing-social"'));
    assert.ok(shardedCollector.includes("`--discovery-attempts=${shard.discoveryAttemptsPath}`"));
    assert.ok(shardedCollector.includes("`--source-discovery-paths=${shard.sourceDiscoveryPathsPath}`"));
    assert.ok(shardedCollector.includes('label: "Public unauthenticated platform/page ingestion"'));
    assert.ok(collectors.includes('`--workers=${PUBLIC_COLLECTOR_TASK_CONCURRENCY}`'));
    assert.ok(collectors.includes('`--x-workers=${PUBLIC_SOCIAL_LANE_CONCURRENCY}`'));
    assert.ok(collectors.includes('`--linkedin-workers=${PUBLIC_SOCIAL_LANE_CONCURRENCY}`'));
    assert.ok(collectors.includes('`--instagram-workers=${PUBLIC_SOCIAL_LANE_CONCURRENCY}`'));
    assert.ok(collectors.includes('"--search-workers=1"'));
    assert.ok(collectors.includes('process.env.GITHUB_TOKEN?.trim() ? "--search" : "--no-search"'));
    assert.ok(collectors.includes("githubSearchArg"));
    assert.doesNotMatch(collectors, /`--max-searches=\$\{companyCount \* 2\}`/);
    assert.doesNotMatch(collectors, /--max-searches=60/);
    assert.ok(successfulRows.includes("countSuccessfulAutonomousCollectorRows(snapshot, kind)"));
    assert.doesNotMatch(successfulRows, /needsReview/);
    assert.doesNotMatch(collectors, /run:\s*async\s*\(\)\s*=>\s*await runCommand\(/);
  });

  it("enforces one wall-clock collection deadline across queued shards, retries, and Top Voice", () => {
    assert.ok(runner.includes("createAutonomousCollectionBudget"));
    assert.ok(runner.includes(
      "phaseMs: AUTONOMOUS_PROCESS_BUDGETS.collectionPhaseMs"
    ));
    assert.ok(runner.includes(
      "AUTONOMOUS_PROCESS_BUDGETS.collectorRateLimitRetryDelayMs"
    ));
    assert.ok(runner.includes("boundedCollectionTimeoutMs("));
    assert.ok(runner.includes("boundedCollectionDelayMs("));

    const publicCollector = section(
      "async function runPublicCollectorWithCheckpointRecovery",
      "async function runTopVoiceCollector"
    );
    const topVoiceCollector = section(
      "async function runTopVoiceCollector",
      "async function resumeTopVoiceRefresh"
    );
    const githubCollector = section(
      "async function runShardedGithubCollector",
      "function githubShardSearchBudget"
    );
    const retryLoop = section(
      "async function runCollectorWithRetries",
      "function retryableFailuresFromSnapshot"
    );
    assert.ok(publicCollector.includes("boundedCollectionTimeoutMs("));
    assert.ok(publicCollector.includes("deadlineAt: collectionBudget.deadlineAt"));
    assert.ok(topVoiceCollector.includes("boundedCollectionTimeoutMs("));
    assert.ok(topVoiceCollector.includes("deadlineAt: collectionBudget.deadlineAt"));
    assert.ok(githubCollector.includes("boundedCollectionTimeoutMs("));
    assert.ok(githubCollector.includes("deadlineAt: collectionBudget.deadlineAt"));
    assert.ok(retryLoop.includes("boundedCollectionDelayMs("));
    assert.doesNotMatch(retryLoop, /\?\s*65_000/);

    const commandRunner = section("async function runCommand", "function batchCompanyKey");
    assert.ok(commandRunner.includes("deadlineAt = null"));
    assert.ok(commandRunner.includes("deadlineAt - Date.now()"));
    assert.ok(commandRunner.includes("effectiveTimeoutMs"));
  });

  it("enforces one runner deadline across every publication and git subprocess path", () => {
    assert.ok(runner.includes("createAutonomousRunnerBudget"));
    assert.ok(runner.includes("AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS"));
    assert.ok(runner.includes("startedAt: runStartedAt.getTime()"));

    const commandRunner = section("async function runCommand", "function batchCompanyKey");
    assert.equal(
      (commandRunner.match(/runnerBudget\.timeoutMs\(timeoutMs, label\)/g) ?? []).length,
      2,
      "commands must check the absolute runner deadline before and after event I/O"
    );
    assert.ok(commandRunner.includes("Math.min(timeoutMs, runnerRemainingMs, deadlineRemainingMs)"));

    for (const [start, end] of [
      ["async function readTextFromGitRef", "function gitRefCaptureLimit"],
      ["async function buildAndValidatePublication", "async function synchronizePublicationBase"],
      ["async function synchronizePublicationBase", "async function publishGithubExports"],
      ["async function publishRepositoryArtifacts", "async function stageRepositoryArtifacts"],
      ["async function assertNoPublicationConflicts", "async function abortPublicationRebase"],
      ["async function abortPublicationRebase", "async function completeRun"]
    ]) {
      const boundedPath = section(start, end);
      assert.ok(boundedPath.includes("runCommand("), `${start} must use the globally bounded command runner`);
      assert.doesNotMatch(boundedPath, /\bspawn\(/);
    }

    const mutableCatalogRefresh = section(
      "async function refreshMutableYcCatalog",
      "function publicationBranch"
    );
    assert.ok(mutableCatalogRefresh.includes("runnerBudget.timeoutMs("));
    assert.ok(
      mutableCatalogRefresh.indexOf("runnerBudget.timeoutMs(") < mutableCatalogRefresh.indexOf("spawn("),
      "the catalog child must not spawn before the runner deadline check"
    );
    assert.ok(mutableCatalogRefresh.includes("}, timeoutMs)"));
  });

  it("retries exact failure ledgers and accepts exhaustion only after explicit terminal coverage", () => {
    const retry = section("async function runCollectorWithRetries", "function retryableFailuresFromSnapshot");
    const failures = section("function retryableFailuresFromSnapshot", "function successfulCollectorRowCount");

    assert.ok(failures.includes("autonomousCollectorRetryableFailures(snapshot)"));
    assert.ok(retry.includes("summarizeAutonomousCollectorTerminalTaskCoverage"));
    assert.ok(retry.includes("terminalCoverage.nonTerminal"));
    assert.ok(retry.includes("exhaustedRetryableFailures"));
    assert.ok(retry.includes("every planned task reached an explicit terminal outcome"));
    assert.ok(retry.includes("AUTONOMOUS_PROCESS_BUDGETS.collectorRateLimitRetryDelayMs"));
    assert.ok(retry.includes("exhausted retries with"));
    assert.doesNotMatch(retry, /retryableFailures\.length === 0 \|\| attempt === maxAttempts/);
    assert.ok(retry.includes("args.resumeSnapshots"));
    assert.ok(retry.includes("collector.snapshot_resumed"));
    assert.ok(retry.includes("terminalCoverage.nonTerminal === 0 && retryableFailures.length === 0"));
    assert.ok(runner.includes('resumeSnapshots: rawArgs.includes("--resume-snapshots")'));
  });

  it("reuses a campaign collector ledger across distinct durable sweep runs", () => {
    const preparation = section("async function prepareBatchDiscoveryState", "async function mergeCollectorDiscoveryState");
    const shardedPublic = section("async function runShardedPublicCollector", "async function seedShardLedger");
    const shardedGithub = section("async function runShardedGithubCollector", "function githubShardSearchBudget");

    assert.ok(runner.includes('campaignKey: value("--campaign-key")'));
    assert.ok(runner.includes('"autonomous-ingestion-campaigns"'));
    assert.ok(runner.includes("const collectorRoot = args.campaignKey"));
    assert.ok(runner.includes("join(collectorRoot, `public-${batch.slug.toLowerCase()}.json`)"));
    assert.ok(runner.includes("join(collectorRoot, `github-${batch.slug.toLowerCase()}.json`)"));
    assert.ok(runner.includes('const topVoiceOutput = join(collectorRoot, "top-voice-refresh.json")'));
    assert.ok(preparation.includes("seedShardLedger(discoveryAttemptOutputs.get(batch.slug)"));
    assert.ok(preparation.includes("seedShardLedger(sourceDiscoveryPathOutputs.get(batch.slug)"));
    assert.doesNotMatch(preparation, /writeJsonAtomic\(discoveryAttemptOutputs/);
    assert.ok(shardedPublic.includes("join(collectorRoot"));
    assert.ok(shardedGithub.includes("collectorRoot"));
  });

  it("seeds learned discovery state by explicit batch identity before legacy slug fallback", () => {
    const preparation = section("async function prepareBatchDiscoveryState", "async function mergeCollectorDiscoveryState");
    const batchIdentity = preparation.indexOf("row?.batch_slug ?? row?.batchSlug");
    const legacySlug = preparation.indexOf("row?.company_slug ?? row?.companySlug");

    assert.ok(batchIdentity > -1);
    assert.ok(legacySlug > batchIdentity);
    assert.ok(preparation.includes("if (rowBatch) return rowBatch === batch.slug"));
  });

  it("requires every canonical GitHub and discovery input before replacing its artifact set", () => {
    const preparation = section("async function prepareBatchDiscoveryState", "async function mergePublicationInputs");
    const publicationMerge = section("async function mergePublicationInputs", "async function mergeCollectorDiscoveryState");
    const discoveryMerge = section("async function mergeCollectorDiscoveryState", "async function readJsonFromGitRef");
    const githubMerge = section("async function publishGithubExports", "async function publishRepositoryArtifacts");

    assert.equal((preparation.match(/readRequiredCanonicalRows\(/g) ?? []).length, 2);
    assert.ok(preparation.includes("publishedDiscoveryAttemptsPath"));
    assert.ok(preparation.includes("publishedSourceDiscoveryPathsPath"));
    assert.doesNotMatch(preparation, /readJson\(published(?:DiscoveryAttempts|SourceDiscoveryPaths)Path/);

    assert.equal((discoveryMerge.match(/readRequiredCanonicalRows\(/g) ?? []).length, 2);
    const discoveryReadIndex = publicationMerge.indexOf("await mergeCollectorDiscoveryState(");
    const discoveryAttemptWriteIndex = publicationMerge.indexOf("await writeJsonAtomic(publishedDiscoveryAttemptsPath");
    const discoveryPathWriteIndex = publicationMerge.indexOf("await writeJsonAtomic(publishedSourceDiscoveryPathsPath");
    assert.ok(discoveryReadIndex > -1 && discoveryAttemptWriteIndex > discoveryReadIndex);
    assert.ok(discoveryPathWriteIndex > discoveryAttemptWriteIndex);
    assert.doesNotMatch(discoveryMerge, /readJson\(published(?:DiscoveryAttempts|SourceDiscoveryPaths)Path/);
    assert.ok(discoveryMerge.includes("readJson(discoveryAttemptOutputs.get(result.batchSlug), [])"));
    assert.ok(discoveryMerge.includes("readJson(sourceDiscoveryPathOutputs.get(result.batchSlug), [])"));

    assert.equal((githubMerge.match(/Canonical GitHub traction snapshot for/g) ?? []).length, 1);
    assert.equal((githubMerge.match(/\["S2026"|\["S26"|\["A16ZSR006"/g) ?? []).length, 3);
    assert.ok(githubMerge.includes("previousByBatch = new Map(await Promise.all("));
    assert.ok(githubMerge.indexOf("readRequiredCanonicalJson(") < githubMerge.indexOf("for (const snapshot of snapshots)"));
    assert.ok(githubMerge.indexOf("for (const snapshot of snapshots)") < githubMerge.indexOf("writeJsonAtomic(destination"));
    assert.doesNotMatch(githubMerge, /readJson\(destination/);
    assert.ok(githubMerge.includes("baseRef ? await readJsonFromGitRef(baseRef, relativeDestination, null) : null"));
  });

  it("runs Insider and YC Partner discovery concurrently with every batch collector", () => {
    const parallelStart = runner.search(
      /await Promise\.all\(\[\s*runCollectors\(\),\s*resumeTopVoiceRefresh\(\)\s*\]\)/
    );
    const topVoiceCollector = section("async function runTopVoiceCollector", "async function resumeTopVoiceRefresh");
    const topVoiceResume = section("async function resumeTopVoiceRefresh", "async function runCollectorWithRetries");

    assert.ok(parallelStart > -1);
    assert.ok(topVoiceCollector.includes('"--audiences=insiders,yc_partners"'));
    assert.ok(topVoiceCollector.includes('"--x-concurrency=16"'));
    assert.ok(topVoiceCollector.includes('"--max-posts-per-target=20"'));
    assert.ok(topVoiceCollector.includes('"--max-top-voice-x-targets=250"'));
    assert.ok(topVoiceCollector.includes('"--deadline-minutes=10"'));
    assert.ok(topVoiceCollector.includes('"scripts/run-top-voice-ingestion.mjs"'));
    assert.ok(topVoiceResume.includes("resumeValidatedSnapshotOrRun"));
    assert.ok(topVoiceResume.includes("validateSnapshot: assertSuccessfulTopVoiceRefresh"));
    assert.ok(topVoiceResume.includes("runFresh: runTopVoiceCollector"));
    assert.ok(runner.includes("assertSuccessfulTopVoiceRefresh(topVoiceRefresh)"));
    assert.ok(runner.includes('receipt.status !== "completed"'));
    assert.ok(runner.includes('(result.networkRequests ?? 0) <= 0'));
  });

  it("validates collector snapshot shape before merge or publication", () => {
    const reader = section("async function readCollectorSnapshot", "async function writeJsonAtomic");

    assert.ok(runner.includes("await readCollectorSnapshot(command.outputPath, command.kind, {"));
    assert.ok(reader.includes("JSON.parse(await readFile"));
    assert.ok(reader.includes("validateAutonomousCollectorSnapshot"));
    assert.match(reader, /Invalid \$\{kind\} collector snapshot/);
  });

  it("blocks import, publication, and completion when no collection task succeeds", () => {
    const guardIndex = runner.indexOf("assertSuccessfulCollection(collectionResults, collectionCoverage)");
    const importIndex = runner.indexOf("const durableImport = await importDurableEvidence");
    const publicationIndex = runner.indexOf("await mergePublicationInputs(publicationInputs)");
    const completionIndex = runner.indexOf('await completeRun("completed"');
    const guard = section("function assertSuccessfulCollection", "async function persistCoverage");

    assert.ok(guardIndex > -1 && guardIndex < importIndex);
    assert.ok(publicationIndex > guardIndex);
    assert.ok(completionIndex > publicationIndex);
    assert.ok(guard.includes("collectionResults.some((result) => result.snapshotAvailable)"));
    assert.ok(guard.includes("result.snapshotAvailable && result.successfulRows > 0"));
    assert.ok(guard.includes("coverage.succeeded === 0"));
  });

  it("publishes validated snapshots recovered from collectors that exhausted retries", () => {
    const publicationInputs = section(
      "const publishableCollectorResults",
      "const collectionCoverage = await summarizeCollectionCoverage"
    );

    assert.ok(publicationInputs.includes("result.snapshotAvailable"));
    assert.ok(publicationInputs.includes('result.kind === "public"'));
    assert.ok(publicationInputs.includes('result.kind === "github"'));
    assert.doesNotMatch(publicationInputs, /filter\(\(result\) => result\.ok\)/);
  });

  it("batches task persistence and reconciliation with bounded concurrency", () => {
    const enqueue = section("async function enqueueTasks", "async function runCollectors");
    const reconcile = section("async function reconcileCollectorTasks", "async function tasksFor");
    const finish = section("async function finishTasks", "async function terminalizeQueuedTasks");
    const concurrency = section("async function mapWithConcurrency", "function delay");

    assert.ok(enqueue.includes("mapWithConcurrency(chunks(rows, 250), 4"));
    assert.ok(reconcile.includes("mapWithConcurrency(updates, 4"));
    assert.ok(reconcile.includes("indexAutonomousCollectorTaskOutcomes"));
    assert.ok(reconcile.includes("classifyAutonomousCollectorTaskOutcome"));
    assert.ok(reconcile.includes("const snapshot = await readCollectorSnapshot"));
    assert.doesNotMatch(reconcile, /const snapshot = result\.ok\s*\?/);
    assert.doesNotMatch(reconcile, /failed \? "failed" : "completed"/);
    assert.ok(finish.includes('.in("id", ids)'));
    assert.ok(concurrency.includes("await Promise.allSettled(workers)"));
    assert.doesNotMatch(reconcile, /await finishTask\(/);
  });

  it("guards publication on terminal state coverage across all run tasks", () => {
    const coverage = section("async function persistCoverage", "async function persistArtifactManifest");
    const guardIndex = runner.indexOf("validateAutonomousTerminalCoverage(prePublishCoverage");
    const publications = [
      ["semantic publication merge", runner.indexOf("await mergePublicationInputs(publicationInputs)")],
      ["production build", runner.indexOf('await runCommand(process.execPath, ["node_modules/next/dist/bin/next", "build"]')],
      ["graph and benchmark publication", runner.indexOf('await runCommand(process.execPath, ["scripts/update-daily-benchmarks.mjs"]')]
    ];

    assert.ok(coverage.includes('.eq("ingestion_run_id", run.id)'));
    assert.ok(coverage.includes(
      'new Set(["completed", "needs_review", "blocked_or_empty", "skipped", "failed", "canceled", "dead_lettered"])'
    ));
    assert.ok(coverage.includes("!terminalStatuses.has(task.status)"));
    assert.ok(guardIndex > runner.indexOf("const prePublishCoverage = catalogState"));
    for (const [label, publicationIndex] of publications) {
      assert.ok(publicationIndex > guardIndex, `${label} must occur after the all-task terminal guard`);
    }
  });

  it("resolves durable import or an explicit skip before writing or rebuilding any publication artifact", () => {
    const durableImportIndex = runner.indexOf("const durableImport = await importDurableEvidence");
    const publications = [
      ["semantic publication merge", runner.indexOf("await mergePublicationInputs(publicationInputs)")],
      ["production build", runner.indexOf('await runCommand(process.execPath, ["node_modules/next/dist/bin/next", "build"]')],
      ["graph and benchmark publication", runner.indexOf('await runCommand(process.execPath, ["scripts/update-daily-benchmarks.mjs"]')]
    ];

    assert.ok(durableImportIndex > -1);
    for (const [label, publicationIndex] of publications) {
      assert.ok(publicationIndex > durableImportIndex, `${label} must occur after durable evidence import`);
    }
  });

  it("hard-fails configured durable imports with unresolved entity attributions", () => {
    const importIndex = runner.indexOf("const durableImport = await importDurableEvidence");
    const guardIndex = runner.indexOf("assertDurableAttributionCompleteness(durableImport)");
    const publicationIndex = runner.indexOf("await mergePublicationInputs(publicationInputs)");
    const importer = section("async function importDurableEvidence", "function assertDurableAttributionCompleteness");
    const guard = section("function assertDurableAttributionCompleteness", "async function summarizeCollectionCoverage");

    assert.ok(importIndex > -1 && guardIndex > importIndex && publicationIndex > guardIndex);
    assert.ok(importer.includes("requireCompleteAttribution: true"));
    assert.ok(guard.includes("importResult.attributions?.unresolved"));
    assert.ok(guard.includes("publication is prohibited"));
  });

  it("terminates timed-out subprocesses within a bounded grace period", () => {
    const commandRunner = section("async function runCommand", "function batchCompanyKey");

    assert.ok(commandRunner.includes('child.kill("SIGTERM")'));
    assert.ok(commandRunner.includes('child.kill("SIGKILL")'));
    assert.ok(commandRunner.includes("AUTONOMOUS_PROCESS_BUDGETS.processKillGraceMs"));
    assert.ok(commandRunner.includes("if (timedOut)"));
  });

  it("flushes public checkpoints after a process timeout instead of discarding task outcomes", () => {
    const collectorRunner = section("async function runPublicCollectorWithCheckpointRecovery", "async function runTopVoiceCollector");

    assert.ok(collectorRunner.includes("collector.timeout_checkpoint_flush"));
    assert.ok(collectorRunner.includes('"--max-companies=0"'));
    assert.ok(collectorRunner.includes("AUTONOMOUS_PROCESS_BUDGETS.collectorCheckpointFlushMs"));
    assert.ok(collectorRunner.includes("boundedCollectionDrainTimeoutMs("));
    assert.ok(collectorRunner.includes("deadlineAt: collectionDrainBudget.deadlineAt"));
    assert.equal(
      (collectorRunner.match(/deadlineAt: collectionBudget\.deadlineAt/g) ?? []).length,
      1,
      "only the collector attempt may use the collection deadline; checkpoint flushes use drain headroom"
    );
    assert.ok(runner.includes("createAutonomousCollectionDrainBudget"));
    assert.ok(runner.includes(
      "drainHeadroomMs: AUTONOMOUS_PROCESS_BUDGETS.collectionDeadlineDrainHeadroomMs"
    ));
    assert.ok(runner.includes("runnerDeadlineAt: runnerBudget.deadlineAt"));
    assert.match(runner, /`--x-workers=\$\{PUBLIC_SOCIAL_LANE_CONCURRENCY\}`/);
  });

  it("shards large public cohorts and merges shard checkpoints before coverage", () => {
    const collectorRunner = section("async function runShardedPublicCollector", "async function runPublicCollectorWithCheckpointRecovery");

    assert.ok(runner.includes("S2026: 4"));
    assert.ok(runner.includes("S26: 2"));
    assert.ok(runner.includes("PUBLIC_SHARD_PROCESS_CONCURRENCY = 2"));
    assert.ok(collectorRunner.includes("runWithPublicShardProcessSlot"));
    assert.ok(collectorRunner.includes("--company-shard-count="));
    assert.ok(collectorRunner.includes("--company-shard-index="));
    assert.ok(collectorRunner.includes("Promise.allSettled"));
    assert.ok(collectorRunner.includes("after every sibling stopped"));
    assert.ok(collectorRunner.includes("seedShardLedger(shard.discoveryAttemptsPath"));
    assert.ok(collectorRunner.includes("seedShardLedger(shard.sourceDiscoveryPathsPath"));
    assert.ok(collectorRunner.includes("mergePublicEvidenceSnapshots(snapshots"));
    assert.ok(collectorRunner.includes("writeJsonAtomic(outputPath, merged)"));
    const checkpointRecovery = section("async function runPublicCollectorWithCheckpointRecovery", "async function runTopVoiceCollector");
    assert.ok(checkpointRecovery.includes("shard ${shardIndex + 1}/${shardCount}"));
  });

  it("writes, validates, and durably records the artifact manifest before completion", () => {
    const publicationBuild = section("async function buildAndValidatePublication", "async function synchronizePublicationBase");
    const scoringDiagnosticsIndex = publicationBuild.indexOf('"./scripts/run-scoring-diagnostics-v4.mjs"');
    const writeIndex = publicationBuild.indexOf('"scripts/write-artifact-manifest.mjs"');
    const validateIndex = publicationBuild.indexOf('["scripts/validate-public-artifacts.mjs"]');
    const persistIndex = runner.indexOf("await persistArtifactManifest(run.id)", runner.indexOf("await buildAndValidatePublication(publicationRunId)"));
    const completionIndex = runner.indexOf('await completeRun("completed"');
    const manifestPersistence = section("async function persistArtifactManifest", "async function buildAndValidatePublication");

    assert.ok(scoringDiagnosticsIndex > -1);
    assert.ok(writeIndex > -1);
    assert.ok(writeIndex > scoringDiagnosticsIndex && validateIndex > writeIndex);
    assert.ok(persistIndex > runner.indexOf("await buildAndValidatePublication(publicationRunId)"));
    assert.ok(completionIndex > persistIndex);
    assert.ok(manifestPersistence.includes('join(root, "public", "graph", "manifest.json")'));
    assert.ok(manifestPersistence.includes('from("ingestion_artifact_manifests").upsert'));
    assert.ok(manifestPersistence.includes('artifact_key: "public-graph-manifest"'));
    assert.ok(manifestPersistence.includes("sha256"));
  });

  it("publishes repository artifacts before reporting durable completion", () => {
    const pushIndex = runner.indexOf("await publishRepositoryArtifacts(publicationRunId, publicationInputs)");
    const completionIndex = runner.indexOf('await completeRun("completed"');
    assert.ok(pushIndex > -1);
    assert.ok(completionIndex > pushIndex);
  });

  it("publishes newly discovered raw Top Voice evidence with the generated graphs", () => {
    const artifactPaths = section("function repositoryArtifactPaths", "function publicationBranch");
    assert.ok(artifactPaths.includes('"src/lib/social/targeted-evidence-current.json"'));
  });

  it("publishes the GitHub authoritative quarantine ledger with every scheduled release", () => {
    const artifactPaths = section("function repositoryArtifactPaths", "function publicationBranch");
    assert.ok(artifactPaths.includes('"src/lib/social/github-traction-quarantine.json"'));
  });

  it("stages and reloads the split review ledger across publication rebases", () => {
    const artifactPaths = section("function repositoryArtifactPaths", "async function refreshMutableYcCatalog");
    const captureLimit = section("function gitRefCaptureLimit", "function newestRowsById");
    const gitRefReader = section("async function readPublicEvidenceFromGitRef", "async function readJsonFromGitRef");

    assert.ok(
      artifactPaths.includes('"outputs/public-ingestion-review-ledger-current.json"')
    );
    assert.match(captureLimit, /PUBLIC_EVIDENCE_REVIEW_LEDGER_PATH/);
    assert.match(captureLimit, /PUBLIC_EVIDENCE_REVIEW_LEDGER_MAX_BYTES/);
    assert.match(gitRefReader, /hydratePublicEvidenceArtifactWithLoader/);
    assert.match(gitRefReader, /readTextFromGitRef\(ref, relativePath/);
  });

  it("runs the ingestion safety contracts through the collector and release gates", () => {
    const contractScript = packageJson.scripts["test:ingestion-contracts"];
    assert.equal(
      contractScript,
      "node --test --test-concurrency=1 " + [
        "tests/autonomous-ingestion-runner-contract.node-test.mjs",
        "tests/github-api-client.node-test.mjs",
        "tests/github-authoritative-reconciliation.node-test.mjs",
        "tests/ingestion-coverage-receipt.node-test.mjs",
        "tests/ingestion-coverage-adapter.node-test.mjs",
        "tests/historical-backfill.node-test.mjs",
        "tests/historical-coverage-adapter.node-test.mjs",
        "tests/public-search-circuit.node-test.mjs",
        "tests/public-search-circuit-integration.node-test.mjs",
        "tests/public-search-outage-integrity.node-test.mjs"
      ].join(" ")
    );
    assert.match(packageJson.scripts["test:collectors"], /npm run test:ingestion-contracts/);
    assert.equal(packageJson.scripts["ingest:historical"], "node scripts/run-historical-backfill.mjs");
    assert.equal(
      packageJson.scripts["ingest:historical:plan"],
      "node scripts/run-historical-backfill.mjs --plan"
    );
    assert.match(packageJson.scripts.check, /npm run test:collectors/);
    assert.match(packageJson.scripts["check:release"], /npm run check/);
  });

  it("regenerates and stages scoring diagnostics with each evidence publication", () => {
    const publicationBuild = section(
      "async function buildAndValidatePublication",
      "async function synchronizePublicationBase"
    );
    const artifactPaths = section("function repositoryArtifactPaths", "function publicationBranch");
    const benchmarkIndex = publicationBuild.indexOf('"scripts/update-daily-benchmarks.mjs"');
    const diagnosticsIndex = publicationBuild.indexOf(
      '"./scripts/run-scoring-diagnostics-v4.mjs"'
    );
    const cohortAuditIndex = publicationBuild.indexOf('"scripts/audit-cohort-coverage.mjs"');

    assert.ok(benchmarkIndex > -1 && diagnosticsIndex > benchmarkIndex);
    assert.ok(cohortAuditIndex > diagnosticsIndex);
    assert.ok(publicationBuild.includes("AUTONOMOUS_PROCESS_BUDGETS.scoringDiagnosticsMs"));
    assert.ok(publicationBuild.includes('"./scripts/lib/scoring-diagnostics-ts-loader.mjs"'));
    assert.ok(artifactPaths.includes('"docs/outputs/scoring-diagnostics-v4-audit.json"'));
    assert.ok(artifactPaths.includes('"docs/outputs/scoring-diagnostics-v4-report.md"'));
  });

  it("regenerates, validates, and stages every graph-derived publication artifact", () => {
    const publicationBuild = section(
      "async function buildAndValidatePublication",
      "async function synchronizePublicationBase"
    );
    const artifactPaths = section(
      "function repositoryArtifactPaths",
      "async function refreshMutableYcCatalog"
    );
    const graphIndex = publicationBuild.indexOf('"scripts/update-daily-benchmarks.mjs"');
    const timelineIndex = publicationBuild.indexOf('"scripts/validate-timeline-artifacts.mjs"');
    const prepareIndex = publicationBuild.indexOf('label: "compact graph runtime preparation"');
    const topicBuildIndex = publicationBuild.indexOf('["run", "topics:facets"]');
    const rankedBuildIndex = publicationBuild.indexOf('["run", "ranked-posts:sidecar"]');
    const topicValidateIndex = publicationBuild.indexOf('["run", "topics:facets:validate"]');
    const rankedValidateIndex = publicationBuild.indexOf('["run", "ranked-posts:sidecar:validate"]');
    const productionBuildIndex = publicationBuild.indexOf('label: "production build"');

    assert.ok(
      graphIndex > -1 &&
      timelineIndex > graphIndex &&
      prepareIndex > timelineIndex &&
      topicBuildIndex > prepareIndex &&
      rankedBuildIndex > topicBuildIndex &&
      topicValidateIndex > rankedBuildIndex &&
      rankedValidateIndex > topicValidateIndex &&
      productionBuildIndex > rankedValidateIndex
    );
    assert.ok(artifactPaths.includes('"public/graph"'));
    assert.ok(artifactPaths.includes('"public/timelines"'));
    assert.ok(artifactPaths.includes('"public/topic-facets"'));
    assert.ok(artifactPaths.includes('"src/lib/graph/ranked-posts-sidecar.generated.json"'));

    assert.match(packageJson.scripts["artifacts:derived:build"], /topics:facets/);
    assert.match(packageJson.scripts["artifacts:derived:build"], /ranked-posts:sidecar/);
    assert.match(packageJson.scripts["topics:facets"], /scripts\/build-topic-facets\.mjs/);
    assert.match(
      packageJson.scripts["ranked-posts:sidecar"],
      /scripts\/build-ranked-posts-sidecar\.mjs/
    );
    assert.match(packageJson.scripts["topics:facets:validate"], /--validate/);
    assert.match(packageJson.scripts["ranked-posts:sidecar:validate"], /--validate/);
    assert.match(packageJson.scripts["artifacts:derived:validate"], /topics:facets:validate/);
    assert.match(packageJson.scripts["artifacts:derived:validate"], /ranked-posts:sidecar:validate/);
    assert.match(packageJson.scripts["check:release:artifacts"], /artifacts:derived:validate/);
  });

  it("builds current graph inputs before starting the benchmark publication server", () => {
    const publicationBuild = section(
      "async function buildAndValidatePublication",
      "async function synchronizePublicationBase"
    );
    const prepareIndex = publicationBuild.indexOf(
      'label: "pre-publication compact graph runtime preparation"'
    );
    const buildIndex = publicationBuild.indexOf(
      'label: "pre-publication production build"'
    );
    const benchmarkIndex = publicationBuild.indexOf(
      '"scripts/update-daily-benchmarks.mjs"'
    );

    assert.ok(prepareIndex > -1 && buildIndex > prepareIndex && benchmarkIndex > buildIndex);
  });

  it("rebases, rebuilds, validates, and retries a non-fast-forward publication once", () => {
    const publication = section("async function publishRepositoryArtifacts", "async function stageRepositoryArtifacts");
    assert.ok(publication.includes('["push", "origin", `HEAD:${branch}`]'));
    assert.ok(publication.includes("allowedExitCodes: [0, 1]"));
    assert.ok(publication.includes('"publication.push_retry"'));
    assert.ok(publication.includes('["rebase", `origin/${branch}`]'));
    assert.ok(publication.includes("rebasedSanitizedPublicSnapshot"));
    assert.ok(publication.includes("const retryDurableImport = await importDurableEvidence"));
    assert.ok(publication.includes("assertDurableAttributionCompleteness(retryDurableImport)"));
    assert.ok(publication.includes(
      "await mergePublicationInputs(rebasedPublicationInputs, { baseRef: `origin/${branch}` })"
    ));
    const rebaseIndex = publication.indexOf('["rebase", `origin/${branch}`]');
    const prepareIndex = publication.indexOf("const rebasedSanitizedPublicSnapshot");
    const retryImportIndex = publication.indexOf("const retryDurableImport = await importDurableEvidence");
    const guardIndex = publication.indexOf("assertDurableAttributionCompleteness(retryDurableImport)");
    const samePlanMergeIndex = publication.indexOf("await mergePublicationInputs(rebasedPublicationInputs");
    const rebuildIndex = publication.indexOf(
      "await buildAndValidatePublication(publicationRunId, publicationInputs.catalogState)",
      samePlanMergeIndex,
    );
    assert.ok(
      rebaseIndex < prepareIndex &&
      prepareIndex < retryImportIndex &&
      retryImportIndex < guardIndex &&
      guardIndex < samePlanMergeIndex &&
      samePlanMergeIndex < rebuildIndex
    );
    assert.ok(publication.includes(
      "await buildAndValidatePublication(publicationRunId, publicationInputs.catalogState)",
    ));
    assert.ok(publication.includes("await stageRepositoryArtifacts()"));
    assert.ok(publication.includes('label: "retry refreshed artifact push"'));
  });

  it("publishes learned discovery state from isolated batch collector files", () => {
    const collectors = section("async function runCollectors()", "async function runTopVoiceCollector");
    const artifactPaths = section("function repositoryArtifactPaths", "function publicationBranch");
    assert.ok(collectors.includes("await prepareBatchDiscoveryState()"));
    assert.ok(runner.includes("await mergeCollectorDiscoveryState("));
    assert.ok(artifactPaths.includes('"outputs/discovery-attempts-current.json"'));
    assert.ok(artifactPaths.includes('"outputs/source-discovery-paths-current.json"'));
  });

  it("re-reads and semantically merges publication state only after the initial rebase", () => {
    const synchronizeIndex = runner.indexOf("await synchronizePublicationBase()");
    const mergeIndex = runner.indexOf("await mergePublicationInputs(publicationInputs)");
    const preparation = section("async function prepareSanitizedPublicSnapshot", "async function mergePublicationInputs");
    const merge = section("async function mergePublicationInputs", "async function mergeCollectorDiscoveryState");

    assert.ok(synchronizeIndex > -1 && mergeIndex > synchronizeIndex);
    assert.ok(preparation.includes("await readPublicEvidenceArtifact"));
    assert.ok(preparation.includes("basePublicSnapshot"));
    assert.ok(preparation.includes("mergePublicEvidenceSnapshots"));
    assert.ok(preparation.includes("resolveBatchSlug: resolveLegacyPublicEvidenceBatch"));
    assert.ok(preparation.includes("resolveNativeAuthor: resolvePublicNativeAuthor"));
    assert.ok(merge.includes("publishGithubExports(githubSnapshots, { baseRef })"));
    const resolver = section(
      "export function buildLegacyPublicEvidenceBatchResolver",
      "function normalizedCatalogBatchAlias",
      autonomousPlan
    );
    assert.ok(resolver.includes("matches.size === 1"));
    assert.ok(resolver.includes("validExplicit && matches.has(validExplicit)"));
    assert.ok(resolver.includes("return null"));
  });

  it("persists exact batch owner mappings and retires only absent associations", () => {
    const sync = section("async function syncCatalogs", "function accountRow");
    const retirement = section("async function retireAbsentSocialAccountOwners", "function socialAccountOwnerKey");
    const durableImport = section("async function importDurableEvidence", "async function summarizeCollectionCoverage");

    assert.ok(sync.includes('from("social_account_owners")'));
    assert.ok(sync.includes('onConflict: "owner_key"'));
    assert.ok(sync.includes("founderByBatchSourceKey"));
    assert.ok(retirement.includes('review_state: "rejected"'));
    assert.ok(retirement.includes('retirement_reason: "absent_from_current_batch_owner_inventory"'));
    assert.doesNotMatch(retirement, /\.delete\(/);
    assert.ok(durableImport.includes("companyByBatchEntityId"));
    assert.ok(durableImport.includes("founderByBatchEntityId"));
    assert.ok(durableImport.includes("batchBySlug"));
  });

  it("runs the all-cohort coverage audit as a hard gate before manifest publication", () => {
    const publicationBuild = section("async function buildAndValidatePublication", "async function synchronizePublicationBase");
    const auditIndex = publicationBuild.indexOf('"scripts/audit-cohort-coverage.mjs"');
    const manifestIndex = publicationBuild.indexOf('"scripts/write-artifact-manifest.mjs"');
    const validationIndex = publicationBuild.indexOf('"scripts/validate-public-artifacts.mjs"');

    assert.ok(auditIndex > -1 && manifestIndex > auditIndex && validationIndex > manifestIndex);
    assert.ok(publicationBuild.includes("--run-dir="));
    assert.ok(publicationBuild.includes("--output="));
  });
});

describe("required canonical publication inputs", () => {
  it("fails on missing and malformed GitHub/discovery inputs without overwriting last-good peers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-required-publication-inputs-"));
    temporaryRoots.push(root);

    for (const fixture of [
      { label: "Canonical GitHub traction snapshot", kind: "missing", expected: /could not be read/ },
      { label: "Canonical GitHub traction snapshot", kind: "malformed", expected: /is malformed/ },
      { label: "Canonical discovery attempts ledger", kind: "missing", expected: /could not be read/ },
      { label: "Canonical discovery attempts ledger", kind: "malformed", expected: /is malformed/ },
      { label: "Canonical source discovery paths ledger", kind: "missing", expected: /could not be read/ },
      { label: "Canonical source discovery paths ledger", kind: "malformed", expected: /is malformed/ }
    ]) {
      const fixtureSlug = `${fixture.label.toLowerCase().replace(/[^a-z]+/g, "-")}-${fixture.kind}`;
      const requiredPath = path.join(root, `${fixtureSlug}.json`);
      const peerPath = path.join(root, `${fixtureSlug}-peer.json`);
      const lastGoodPeer = `{"fixture":"${fixtureSlug}","status":"last-good"}\n`;
      await writeFile(peerPath, lastGoodPeer, "utf8");
      if (fixture.kind === "malformed") await writeFile(requiredPath, "{ malformed\n", "utf8");

      await assert.rejects(
        replacePeerAfterRequiredCanonicalRead(requiredPath, peerPath, fixture.label),
        fixture.expected
      );
      assert.equal(await readFile(peerPath, "utf8"), lastGoodPeer);
    }
  });
});

function section(start, end, source = runner) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex > -1);
  assert.ok(endIndex > startIndex);
  return source.slice(startIndex, endIndex);
}

async function createRunnerRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "public"), { recursive: true });
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await symlink(path.join(repositoryRoot, "public", "graph"), path.join(root, "public", "graph"), "dir");
  await symlink(path.join(repositoryRoot, "src", "lib", "yc"), path.join(root, "src", "lib", "yc"), "dir");
  await symlink(path.join(repositoryRoot, "src", "lib", "social"), path.join(root, "src", "lib", "social"), "dir");
  return root;
}

async function replacePeerAfterRequiredCanonicalRead(requiredPath, peerPath, label) {
  const value = await readRequiredCanonicalJson(requiredPath, label);
  await writeFile(peerPath, `${JSON.stringify(value)}\n`, "utf8");
}
