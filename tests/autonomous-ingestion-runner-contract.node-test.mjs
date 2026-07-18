import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const repositoryRoot = process.cwd();
const runnerPath = path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs");
const runner = await readFile(runnerPath, "utf8");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("autonomous ingestion runner CLI", () => {
  it("prints a complete plan without Supabase credentials or side effects in the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-plan-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "public"), { recursive: true });
    await symlink(path.join(repositoryRoot, "public", "graph"), path.join(root, "public", "graph"), "dir");
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
        { slug: "S2026", companies: 197, founders: 397, accounts: 957 },
        { slug: "S26", companies: 83, founders: 165, accounts: 402 },
        { slug: "A16ZSR006", companies: 59, founders: 128, accounts: 328 }
      ],
      coverage: { expected: 13_377, queued: 4_243, terminal: 9_134 }
    });
  });
});

describe("autonomous ingestion runner static safety contracts", () => {
  it("claims, renews, and releases a durable runtime lock", () => {
    assert.ok(runner.includes('supabase.rpc("claim_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("renew_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("release_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("finalize_completed_ingestion_run"'));
    assert.ok(runner.indexOf("runtimeLock = await claimRuntimeLock()") < runner.indexOf("run = await getOrCreateRun()"));
    assert.match(runner, /finally\s*{[\s\S]*if \(runtimeLock\)[\s\S]*await releaseRuntimeLock\(\)/);
  });

  it("isolates work directories with a hash of the exact idempotency key", () => {
    const safePath = section("function safePathSegment", "function chunks");
    assert.ok(safePath.includes('createHash("sha256")'));
    assert.ok(safePath.includes("update(source)"));
  });

  it("never invokes a collector that depends on a logged-in browser session", () => {
    assert.doesNotMatch(runner, /fetch-logged-in-social-traction|ingest:logged-social|logged[-_ ]?in/i);
    assert.ok(runner.includes('"scripts/fetch-public-traction.mjs"'));
    assert.ok(runner.includes('"scripts/fetch-github-traction.mjs"'));
  });

  it("starts every public and GitHub batch before awaiting them as one parallel settlement", () => {
    const collectors = section("async function runCollectors()", "async function reconcileCollectorTasks");

    assert.equal((collectors.match(/AUTONOMOUS_BATCHES\.map/g) ?? []).length, 2);
    assert.ok(collectors.includes('kind: "public"'));
    assert.ok(collectors.includes('kind: "github"'));
    assert.match(collectors, /run:\s*\(\)\s*=>\s*runCommand\(/);
    assert.ok(collectors.includes("command.promise = runCollectorWithRetries(command)"));
    assert.ok(collectors.includes("await Promise.allSettled(commands.map((command) => command.promise))"));
    assert.doesNotMatch(collectors, /run:\s*async\s*\(\)\s*=>\s*await runCommand\(/);
  });

  it("guards publication on terminal state coverage across all run tasks", () => {
    const coverage = section("async function persistCoverage", "async function persistArtifactManifest");
    const guardIndex = runner.indexOf("if (prePublishCoverage.nonTerminal > 0)");
    const publications = [
      [
        "public evidence snapshot",
        runner.indexOf('await writeJsonAtomic(join(root, "src", "lib", "social", "public-evidence-current.json")')
      ],
      ["GitHub evidence exports", runner.indexOf("await publishGithubExports()")],
      ["production build", runner.indexOf('await runCommand("npm", ["run", "build"]')],
      ["graph and benchmark publication", runner.indexOf('await runCommand("npm", ["run", "benchmarks:daily"]')]
    ];

    assert.ok(coverage.includes('.eq("ingestion_run_id", run.id)'));
    assert.ok(coverage.includes(
      'new Set(["completed", "needs_review", "blocked_or_empty", "skipped", "failed", "canceled", "dead_lettered"])'
    ));
    assert.ok(coverage.includes("!terminalStatuses.has(task.status)"));
    assert.ok(guardIndex > runner.indexOf("const prePublishCoverage = await persistCoverage"));
    for (const [label, publicationIndex] of publications) {
      assert.ok(publicationIndex > guardIndex, `${label} must occur after the all-task terminal guard`);
    }
  });

  it("durably imports evidence before writing or rebuilding any publication artifact", () => {
    const durableImportIndex = runner.indexOf("const durableImport = await importDurableEvidence");
    const publications = [
      [
        "public evidence snapshot",
        runner.indexOf('await writeJsonAtomic(join(root, "src", "lib", "social", "public-evidence-current.json")')
      ],
      ["GitHub evidence exports", runner.indexOf("await publishGithubExports()")],
      ["production build", runner.indexOf('await runCommand("npm", ["run", "build"]')],
      ["graph and benchmark publication", runner.indexOf('await runCommand("npm", ["run", "benchmarks:daily"]')]
    ];

    assert.ok(durableImportIndex > -1);
    for (const [label, publicationIndex] of publications) {
      assert.ok(publicationIndex > durableImportIndex, `${label} must occur after durable evidence import`);
    }
  });

  it("writes, validates, and durably records the artifact manifest before completion", () => {
    const writeIndex = runner.indexOf('"scripts/write-artifact-manifest.mjs"');
    const validateIndex = runner.indexOf('["run", "artifacts:validate"]');
    const persistIndex = runner.indexOf("await persistArtifactManifest(run.id)");
    const completionIndex = runner.indexOf('await completeRun("completed"');
    const manifestPersistence = section("async function persistArtifactManifest", "async function completeRun");

    assert.ok(writeIndex > -1);
    assert.ok(validateIndex > writeIndex);
    assert.ok(persistIndex > validateIndex);
    assert.ok(completionIndex > persistIndex);
    assert.ok(manifestPersistence.includes('join(root, "public", "graph", "manifest.json")'));
    assert.ok(manifestPersistence.includes('from("ingestion_artifact_manifests").upsert'));
    assert.ok(manifestPersistence.includes('artifact_key: "public-graph-manifest"'));
    assert.ok(manifestPersistence.includes("sha256"));
  });

  it("publishes repository artifacts before reporting durable completion", () => {
    const pushIndex = runner.indexOf("await publishRepositoryArtifacts()");
    const completionIndex = runner.indexOf('await completeRun("completed"');
    assert.ok(pushIndex > -1);
    assert.ok(completionIndex > pushIndex);
  });
});

function section(start, end) {
  const startIndex = runner.indexOf(start);
  const endIndex = runner.indexOf(end, startIndex + start.length);
  assert.ok(startIndex > -1);
  assert.ok(endIndex > startIndex);
  return runner.slice(startIndex, endIndex);
}
