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
    assert.deepEqual({
      idempotencyKey: plan.idempotencyKey,
      batches: plan.batches,
      coverage: {
        expected: plan.coverage.expected,
        queued: plan.coverage.queued,
        terminal: plan.coverage.terminal
      }
    }, {
      idempotencyKey: "plan-contract",
      batches: [
        { slug: "S2026", companies: 197, founders: 397, accounts: 959 },
        { slug: "S26", companies: 115, founders: 230, accounts: 551 },
        { slug: "A16ZSR006", companies: 59, founders: 128, accounts: 327 }
      ],
      coverage: { expected: 14_642, queued: 6_735, terminal: 7_907 }
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

  it("treats Supabase as optional and labels the skipped durability path", () => {
    assert.ok(runner.includes("const durableStorageConfigured = Boolean(url && serviceKey)"));
    assert.doesNotMatch(runner, /SUPABASE_SERVICE_ROLE_KEY are required/);
    assert.ok(runner.includes('status: "skipped"'));
    assert.ok(runner.includes('reason: "supabase_not_configured"'));
    assert.ok(runner.includes('runId: run?.id ?? null'));
  });

  it("opts into terminal mapped failures only for skip-publish runs", () => {
    assert.match(
      runner,
      /validateMappedAutonomousCoverage\(collectionCoverage,\s*{\s*allowTerminalFailures: args\.skipPublish\s*}\s*\)/
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

  it("starts public batches in parallel and rate-limits exhaustive GitHub batches through one queue", () => {
    const collectors = section("async function runCollectors()", "async function runTopVoiceCollector");
    const successfulRows = section("function successfulCollectorRowCount", "async function reconcileCollectorTasks");

    assert.equal((collectors.match(/AUTONOMOUS_BATCHES\.map/g) ?? []).length, 2);
    assert.ok(collectors.includes('kind: "public"'));
    assert.ok(collectors.includes('kind: "github"'));
    assert.match(collectors, /run:\s*\(\)\s*=>\s*runCommand\(/);
    assert.ok(collectors.includes("command.promise = runCollectorWithRetries(command)"));
    assert.ok(collectors.includes("let githubQueue = Promise.resolve()"));
    assert.ok(collectors.includes("command.promise = githubQueue.then(() => runCollectorWithRetries(command))"));
    assert.ok(collectors.includes("await Promise.allSettled(commands.map((command) => command.promise))"));
    assert.ok(collectors.includes('"--discover-missing-social"'));
    assert.ok(collectors.includes('`--discovery-attempts=${discoveryAttemptOutputs.get(batchSlug)}`'));
    assert.ok(collectors.includes('`--source-discovery-paths=${sourceDiscoveryPathOutputs.get(batchSlug)}`'));
    assert.ok(collectors.includes('"--workers=16"'));
    assert.ok(collectors.includes('"--linkedin-workers=4"'));
    assert.ok(collectors.includes('"--instagram-workers=8"'));
    assert.ok(collectors.includes('"--search-workers=1"'));
    assert.ok(collectors.includes('`--max-searches=${companyCount * 2}`'));
    assert.doesNotMatch(collectors, /--max-searches=60/);
    assert.ok(successfulRows.includes("countSuccessfulAutonomousCollectorRows(snapshot, kind)"));
    assert.doesNotMatch(successfulRows, /needsReview/);
    assert.doesNotMatch(collectors, /run:\s*async\s*\(\)\s*=>\s*await runCommand\(/);
  });

  it("retries exact failure ledgers and accepts exhaustion only after explicit terminal coverage", () => {
    const retry = section("async function runCollectorWithRetries", "function retryableFailuresFromSnapshot");
    const failures = section("function retryableFailuresFromSnapshot", "function successfulCollectorRowCount");

    assert.ok(failures.includes("autonomousCollectorRetryableFailures(snapshot)"));
    assert.ok(retry.includes("summarizeAutonomousCollectorTerminalTaskCoverage"));
    assert.ok(retry.includes("terminalCoverage.nonTerminal"));
    assert.ok(retry.includes("exhaustedRetryableFailures"));
    assert.ok(retry.includes("every planned task reached an explicit terminal outcome"));
    assert.ok(retry.includes("65_000"));
    assert.ok(retry.includes("exhausted retries with"));
    assert.doesNotMatch(retry, /retryableFailures\.length === 0 \|\| attempt === maxAttempts/);
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
    const parallelStart = runner.indexOf("await Promise.all([runCollectors(), runTopVoiceCollector()])");
    const topVoiceCollector = section("async function runTopVoiceCollector", "async function runCollectorWithRetries");

    assert.ok(parallelStart > -1);
    assert.ok(topVoiceCollector.includes('"--audiences=insiders,yc_partners"'));
    assert.ok(topVoiceCollector.includes('"--x-concurrency=16"'));
    assert.ok(topVoiceCollector.includes('"--max-posts-per-target=20"'));
    assert.ok(topVoiceCollector.includes('"--max-top-voice-x-targets=250"'));
    assert.ok(topVoiceCollector.includes('"--deadline-minutes=10"'));
    assert.ok(topVoiceCollector.includes('"scripts/run-top-voice-ingestion.mjs"'));
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
    assert.ok(guard.includes("collectionResults.some((result) => result.ok)"));
    assert.ok(guard.includes("result.ok && result.successfulRows > 0"));
    assert.ok(guard.includes("coverage.succeeded === 0"));
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

  it("writes, validates, and durably records the artifact manifest before completion", () => {
    const publicationBuild = section("async function buildAndValidatePublication", "async function synchronizePublicationBase");
    const writeIndex = publicationBuild.indexOf('"scripts/write-artifact-manifest.mjs"');
    const validateIndex = publicationBuild.indexOf('["scripts/validate-public-artifacts.mjs"]');
    const persistIndex = runner.indexOf("await persistArtifactManifest(run.id)", runner.indexOf("await buildAndValidatePublication(publicationRunId)"));
    const completionIndex = runner.indexOf('await completeRun("completed"');
    const manifestPersistence = section("async function persistArtifactManifest", "async function buildAndValidatePublication");

    assert.ok(writeIndex > -1);
    assert.ok(validateIndex > writeIndex);
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
    const rebuildIndex = publication.indexOf("await buildAndValidatePublication(publicationRunId)", samePlanMergeIndex);
    assert.ok(
      rebaseIndex < prepareIndex &&
      prepareIndex < retryImportIndex &&
      retryImportIndex < guardIndex &&
      guardIndex < samePlanMergeIndex &&
      samePlanMergeIndex < rebuildIndex
    );
    assert.ok(publication.includes("await buildAndValidatePublication(publicationRunId)"));
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
    assert.ok(preparation.includes("previousPublicSnapshot = await readRequiredCanonicalJson"));
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
