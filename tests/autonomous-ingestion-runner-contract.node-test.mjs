import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readRequiredCanonicalJson } from "../scripts/lib/canonical-json.mjs";
import {
  isProtectedSourcePolicyPath,
  isReplaySafePublicationDataPath
} from "../scripts/lib/autonomous-publication-trust.mjs";

const repositoryRoot = process.cwd();
const runnerPath = path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs");
const [runnerSource, autonomousPlan, childProcessLedgerHook] = await Promise.all([
  readFile(runnerPath, "utf8"),
  readFile(path.join(repositoryRoot, "scripts", "lib", "autonomous-ingestion-plan.mjs"), "utf8"),
  readFile(path.join(repositoryRoot, "scripts", "lib", "child-process-ledger-hook.cjs"), "utf8")
]);
// Keep structural assertions readable while the runner deliberately resolves
// executable scripts from its pinned source checkout instead of the mutable
// publication worktree.
const runner = normalizePinnedSourcePaths(runnerSource);
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
    const env = {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"
    };

    const result = spawnSync(
      process.execPath,
      [runnerPath, "--plan", "--idempotency-key=plan-contract"],
      { cwd: repositoryRoot, env, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.idempotencyKey, "plan-contract");
    assert.deepEqual(
      plan.batches.map((batch) => batch.slug).sort(),
      ["A16ZSR006", "S2026", "S26"]
    );
    for (const batch of plan.batches) {
      assert.ok(batch.companies > 0, `${batch.slug} must retain companies`);
      assert.ok(batch.founders >= batch.companies, `${batch.slug} must retain founder coverage`);
      assert.ok(batch.accounts >= batch.companies, `${batch.slug} must retain account coverage`);
    }
    const summer = plan.batches.find((batch) => batch.slug === "S26");
    assert.ok(summer);
    assert.ok(summer.founders > 0);
    assert.ok(summer.accounts > 0);
    assert.equal(plan.coverage.expected, plan.coverage.queued + plan.coverage.terminal);
    assert.deepEqual(plan.concurrency, {
      publicShardProcesses: 2,
      publicTasksPerProcess: 8,
      publicTasksAcrossProcesses: 16,
      publicSocialLanePerProcess: 1,
      publicSocialLaneAcrossProcesses: 2,
      githubShardProcesses: 2,
      githubTasksPerProcess: 4,
      githubInitialRequestsAcrossProcesses: 8
    });
  });

  it("reports a missing idempotency key through GitHub outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-missing-key-"));
    temporaryRoots.push(root);
    const outputPath = path.join(root, "github-output.txt");
    const env = { ...process.env, GITHUB_OUTPUT: outputPath };
    delete env.INGESTION_IDEMPOTENCY_KEY;
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;

    const result = spawnSync(process.execPath, [runnerPath], {
      cwd: root,
      env,
      encoding: "utf8"
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--idempotency-key or INGESTION_IDEMPOTENCY_KEY is required/);
    const outputs = await readFile(outputPath, "utf8");
    assert.match(outputs, /^runner_status=failed$/m);
    assert.match(
      outputs,
      /^failure_message=--idempotency-key or INGESTION_IDEMPOTENCY_KEY is required\.$/m
    );
  });

  it("rejects an external data cwd before file-backed execution", async () => {
    const root = await createRunnerRoot("autonomous-ingestion-file-mode-");
    const outputPath = path.join(root, "github-output.txt");
    const env = { ...process.env, GITHUB_OUTPUT: outputPath };
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;

    const result = spawnSync(
      process.execPath,
      [runnerPath, "--idempotency-key=file-contract", "--skip-network", "--skip-publish"],
      { cwd: root, env, encoding: "utf8" }
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Runner source-root mismatch/);
    assert.doesNotMatch(result.stdout, /"status": "completed"/);
    const outputs = await readFile(outputPath, "utf8");
    assert.match(outputs, /^runner_status=failed$/m);
    assert.match(outputs, /^failure_message=Runner source-root mismatch:/m);
  });

  it("rejects source-root mismatch before inspecting Supabase configuration", async () => {
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
    assert.match(result.stderr, /Runner source-root mismatch/);
    assert.doesNotMatch(result.stderr, /NEXT_PUBLIC_SUPABASE_URL:invalid_http_url/);
    assert.doesNotMatch(result.stderr, /Invalid supabaseUrl/);
  });

  it("rejects replay when executing code and repository roots differ", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-published-replay-"));
    const remote = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-published-remote-"));
    temporaryRoots.push(root);
    temporaryRoots.push(remote);
    const outputPath = path.join(root, "github-output.txt");
    const idempotencyKey = "central-2026-08-09-1800";
    await mkdir(path.join(root, "outputs"), { recursive: true });
    await writeFile(
      path.join(root, "outputs", "ingestion-source-delta-history.json"),
      `${JSON.stringify([{
        schemaVersion: 1,
        idempotencyKey,
        collectionHealth: "degraded",
        providerBlocked: 8,
        providerBlockedByReason: {
          "provider_blocked:duckduckgo_html:public_search_circuit_open": 8
        },
        mappedProviderBlocked: 0,
        mappedProviderBlockedByReason: {},
        mappedScopeUnsupported: 0,
        mappedExpected: 77,
        mappedFailures: 0,
        mappedNonTerminal: 0,
        terminalFailureBudget: 4,
        newPhysicalSources: 4,
        dailyNewPhysicalSources: 9,
        dailySourceHealth: "healthy"
      }])}\n`,
      "utf8"
    );
    runGit(root, ["init", "-b", "main"]);
    runGit(root, ["config", "user.name", "Receipt Contract"]);
    runGit(root, ["config", "user.email", "receipt-contract@example.com"]);
    runGit(root, ["add", "outputs/ingestion-source-delta-history.json"]);
    runGit(root, ["commit", "-m", "Record ingestion receipt"]);
    runGit(remote, ["init", "--bare"]);
    runGit(root, ["remote", "add", "origin", remote]);
    runGit(root, ["push", "-u", "origin", "main"]);
    const publishedCommit = runGit(root, ["rev-parse", "HEAD"]).stdout.trim();
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

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Runner source-root mismatch/);
    assert.doesNotMatch(result.stdout, /collection\.started|Public collectors started/);
    const outputs = await readFile(outputPath, "utf8");
    assert.match(outputs, /runner_status=failed/);
    assert.match(outputs, /failure_message=Runner source-root mismatch:/);
    assert.doesNotMatch(outputs, new RegExp(`published_commit=${publishedCommit}`));
  });

  it("fetches exact current origin history and replays a receipt while source checkout is behind", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-behind-source-"));
    const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-behind-remote-"));
    const publisherRoot = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-behind-publisher-"));
    temporaryRoots.push(sourceRoot, remoteRoot, publisherRoot);
    await cp(path.join(repositoryRoot, "scripts"), path.join(sourceRoot, "scripts"), { recursive: true });
    await cp(path.join(repositoryRoot, "package.json"), path.join(sourceRoot, "package.json"));
    await writeFile(path.join(sourceRoot, ".gitignore"), "node_modules/\nwork/\n");
    await symlink(path.join(repositoryRoot, "node_modules"), path.join(sourceRoot, "node_modules"), "dir");
    runGit(sourceRoot, ["init", "-b", "main"]);
    runGit(sourceRoot, ["config", "user.name", "Replay Fixture"]);
    runGit(sourceRoot, ["config", "user.email", "replay-fixture@example.com"]);
    runGit(sourceRoot, ["add", ".gitignore", "package.json", "scripts"]);
    runGit(sourceRoot, ["commit", "-m", "source commit"]);
    const sourceSha = runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim();
    runGit(remoteRoot, ["init", "--bare"]);
    runGit(remoteRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    runGit(sourceRoot, ["remote", "add", "origin", remoteRoot]);
    runGit(sourceRoot, ["push", "-u", "origin", "main"]);
    runGit(publisherRoot, ["clone", remoteRoot, "."]);
    runGit(publisherRoot, ["config", "user.name", "Publisher Fixture"]);
    runGit(publisherRoot, ["config", "user.email", "publisher-fixture@example.com"]);
    const idempotencyKey = "central-2026-08-10-1800";
    const receipt = {
      schemaVersion: 1,
      idempotencyKey,
      trigger: "schedule",
      scheduledAt: "2026-08-10T23:00:00.000Z",
      collectionHealth: "complete",
      collectionHealthReasons: [],
      providerBlocked: 0,
      providerBlockedByReason: {},
      mappedProviderBlocked: 0,
      mappedProviderBlockedByReason: {},
      mappedScopeUnsupported: 0,
      mappedExpected: 5,
      mappedFailures: 0,
      mappedNonTerminal: 0,
      terminalFailureBudget: 1,
      newPhysicalSources: 2,
      dailyNewPhysicalSources: 2,
      dailySourceHealth: "healthy"
    };
    await mkdir(path.join(publisherRoot, "outputs"), { recursive: true });
    const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeFile(
      path.join(publisherRoot, "outputs", "ingestion-source-delta-current.json"),
      receiptBytes,
      "utf8"
    );
    await writeFile(
      path.join(publisherRoot, "outputs", "ingestion-source-delta-history.json"),
      `${JSON.stringify([receipt], null, 2)}\n`,
      "utf8"
    );
    runGit(publisherRoot, ["add", "outputs"]);
    runGit(publisherRoot, [
      "commit",
      "-m",
      "Publish autonomous ingestion fixture",
      "-m",
      [
        `Returner-Slot-Key: ${idempotencyKey}`,
        `Returner-Source-SHA: ${sourceSha}`,
        "Returner-Run-ID: fixture-run",
        "Returner-Run-Attempt: 1",
        `Returner-Receipt-SHA256: ${createHash("sha256").update(receiptBytes).digest("hex")}`
      ].join("\n")
    ]);
    runGit(publisherRoot, ["push", "origin", "main"]);
    const remoteReceiptCommit = runGit(publisherRoot, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(publisherRoot, "scripts", "later-code-only.mjs"), "export const later = true;\n");
    runGit(publisherRoot, ["add", "scripts/later-code-only.mjs"]);
    runGit(publisherRoot, ["commit", "-m", "later executable code"]);
    runGit(publisherRoot, ["push", "origin", "main"]);
    const laterCodeTip = runGit(publisherRoot, ["rev-parse", "HEAD"]).stdout.trim();
    assert.notEqual(laterCodeTip, remoteReceiptCommit);
    assert.equal(runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim(), sourceSha);

    const outputPath = path.join(sourceRoot, "github-output.txt");
    const result = spawnSync(
      process.execPath,
      [
        path.join(sourceRoot, "scripts", "run-autonomous-ingestion.mjs"),
        `--idempotency-key=${idempotencyKey}`,
        "--candidate-trigger=manual-replay",
        "--scheduled-at="
      ],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_OUTPUT: outputPath,
          GITHUB_SHA: sourceSha,
          RETURNER_EXPECTED_SOURCE_SHA: sourceSha,
          NEXT_PUBLIC_SUPABASE_URL: "",
          SUPABASE_SERVICE_ROLE_KEY: ""
        },
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(runGit(sourceRoot, ["rev-parse", "HEAD"]).stdout.trim(), sourceSha);
    const outputs = await readFile(outputPath, "utf8");
    assert.match(outputs, /^runner_status=already_completed$/m);
    assert.match(outputs, new RegExp(`^published_commit=${remoteReceiptCommit}$`, "m"));
    assert.doesNotMatch(outputs, new RegExp(`^published_commit=${laterCodeTip}$`, "m"));

    runGit(publisherRoot, [
      "commit",
      "--allow-empty",
      "-m",
      "forged replay provenance",
      "-m",
      [
        `Returner-Slot-Key: ${idempotencyKey}`,
        `Returner-Source-SHA: ${sourceSha}`,
        "Returner-Run-ID: forged-run",
        "Returner-Run-Attempt: 1",
        `Returner-Receipt-SHA256: ${"0".repeat(64)}`
      ].join("\n")
    ]);
    runGit(publisherRoot, ["push", "origin", "main"]);
    const forgedOutputPath = path.join(sourceRoot, "forged-github-output.txt");
    const forgedResult = spawnSync(
      process.execPath,
      [
        path.join(sourceRoot, "scripts", "run-autonomous-ingestion.mjs"),
        `--idempotency-key=${idempotencyKey}`,
        "--candidate-trigger=manual-replay",
        "--scheduled-at="
      ],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_OUTPUT: forgedOutputPath,
          GITHUB_SHA: sourceSha,
          RETURNER_EXPECTED_SOURCE_SHA: sourceSha,
          NEXT_PUBLIC_SUPABASE_URL: "",
          SUPABASE_SERVICE_ROLE_KEY: ""
        },
        encoding: "utf8"
      }
    );
    assert.equal(forgedResult.status, 1, forgedResult.stdout);
    assert.match(forgedResult.stderr, /does not match its Returner-Receipt-SHA256 trailer/);
  });

  it("rejects an external cwd before a fake credential-bearing Git command can run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-command-tail-"));
    temporaryRoots.push(root);
    const bin = path.join(root, "bin");
    const outputPath = path.join(root, "github-output.txt");
    const secret = ["github", "pat", "command_tail_contract_secret_123456789"].join("_");
    await mkdir(bin, { recursive: true });
    await writeExecutable(path.join(bin, "git"), `#!/usr/bin/env node
process.stdout.write(\`final stdout marker token=\${process.env.GITHUB_TOKEN}\\n\`);
process.stderr.write(\`final stderr marker Bearer \${process.env.GITHUB_TOKEN}\\n\`);
process.exitCode = 7;
`);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: outputPath,
      GITHUB_TOKEN: secret,
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    };

    const result = spawnSync(
      process.execPath,
      [runnerPath, "--idempotency-key=command-tail-contract"],
      { cwd: root, env, encoding: "utf8" }
    );

    assert.equal(result.status, 1, result.stderr);
    const outputs = await readFile(outputPath, "utf8");
    const diagnostics = `${result.stdout}\n${result.stderr}\n${outputs}`;
    assert.match(outputs, /failure_message=Runner source-root mismatch:/);
    assert.doesNotMatch(diagnostics, /final stderr marker|final stdout marker/);
    assert.doesNotMatch(diagnostics, new RegExp(secret, "g"));
    assert.doesNotMatch(
      diagnostics,
      new RegExp(["Bearer github", "pat"].join("_") + "_")
    );
    assert.ok(outputs.length < 8_192, "the source-boundary failure receipt must remain bounded");
  });

  it("rejects an external cwd before a cancellation fixture can spawn a process tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-signal-"));
    temporaryRoots.push(root);
    const bin = path.join(root, "bin");
    const outputPath = path.join(root, "github-output.txt");
    const markerPath = path.join(root, "child-processes.json");
    await mkdir(bin, { recursive: true });
    await writeExecutable(path.join(bin, "git"), `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", [
  "process.on('SIGINT', () => {});",
  "process.on('SIGTERM', () => {});",
  "setInterval(() => {}, 1000);"
].join("")], { stdio: "ignore" });
writeFileSync("child-processes.json", JSON.stringify({
  child: process.pid,
  grandchild: grandchild.pid
}));
setInterval(() => {}, 1000);
`);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: outputPath,
      SIGNAL_CHILD_MARKER: markerPath,
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    };
    const result = spawnSync(
      process.execPath,
      [runnerPath, "--idempotency-key=signal-contract"],
      { cwd: root, env, encoding: "utf8" }
    );
    assert.equal(result.status, 1, result.stderr);
    const outputs = await readFile(outputPath, "utf8");
    assert.match(outputs, /^runner_status=failed$/m);
    assert.match(outputs, /failure_message=Runner source-root mismatch:/);
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
  });

  it("hard-settles when an escaped descendant keeps the subprocess pipes open", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-escaped-child-"));
    temporaryRoots.push(root);
    const commandPath = path.join(root, "escaped-child.mjs");
    const markerPath = path.join(root, "escaped-child.json");
    await writeExecutable(commandPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", process.stdout, process.stderr]
});
escaped.unref();
writeFileSync(process.env.LIFECYCLE_FIXTURE_MARKER, JSON.stringify({
  parent: process.pid,
  escaped: escaped.pid,
  unrelatedSecret: process.env.UNRELATED_RUNNER_SECRET ?? null
}));
setInterval(() => {}, 1000);
`);
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [runnerPath, "--idempotency-key=escaped-descendant-contract"],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "test",
          AUTONOMOUS_INGESTION_LIFECYCLE_TEST_FIXTURE: "escaped-descendant",
          LIFECYCLE_FIXTURE_COMMAND: commandPath,
          LIFECYCLE_FIXTURE_MARKER: markerPath,
          UNRELATED_RUNNER_SECRET: "must-not-reach-child"
        },
        encoding: "utf8",
        timeout: 5_000
      }
    );
    const wallClockMs = Date.now() - startedAt;
    const tracked = JSON.parse(await readFile(markerPath, "utf8"));
    await waitForProcessExit(tracked.escaped, 1_000);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.ok(wallClockMs < 2_000, `runner took ${wallClockMs}ms to hard-settle`);
    assert.equal(processExists(tracked.parent), false, "the tracked process group must be killed");
    assert.equal(processExists(tracked.escaped), false, "escaped descendant must be killed without manual cleanup");
    assert.equal(tracked.unrelatedSecret, null, "unrelated parent secrets must not reach children");
    assert.match(result.stdout, /"fixture":"escaped-descendant"/);
    assert.match(result.stdout, /"activeChildren":0/);
  });

  it("drains a detached-stdio descendant after its root exits normally", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-normal-descendant-"));
    temporaryRoots.push(root);
    const commandPath = path.join(root, "normal-descendant.mjs");
    const markerPath = path.join(root, "normal-descendant.json");
    await writeExecutable(commandPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore"
});
escaped.unref();
writeFileSync(process.env.LIFECYCLE_FIXTURE_MARKER, JSON.stringify({ escaped: escaped.pid }));
`);
    const result = runLifecycleFixture("normal-exit-descendant", {
      LIFECYCLE_FIXTURE_COMMAND: commandPath,
      LIFECYCLE_FIXTURE_MARKER: markerPath
    }, root);
    const tracked = JSON.parse(await readFile(markerPath, "utf8"));
    await waitForProcessExit(tracked.escaped, 1_000);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(processExists(tracked.escaped), false, "normal-exit descendant must be reaped");
    assert.match(result.stdout, /"fixture":"normal-exit-descendant"/);
    assert.match(result.stdout, /"activeChildren":0/);
  });

  it("re-reads ledger identity immediately before signaling and prunes a reused PID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-pid-reuse-"));
    temporaryRoots.push(root);
    const result = runLifecycleFixture("pid-reuse-ledger", {
      LIFECYCLE_FIXTURE_MARKER: root
    });
    const payload = lifecycleFixturePayload(result);

    assert.equal(payload.victimAlive, true);
    assert.equal(payload.victimSignaled, false);
    assert.equal(payload.preSignalIdentityReads, 2);
    assert.equal(payload.victimPruned, true);
  });

  it("fail-fast branch failure cancels and awaits every sibling process tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-fail-fast-"));
    temporaryRoots.push(root);
    const commandPath = path.join(root, "fail-fast-fixture.mjs");
    const markerPath = path.join(root, "fail-fast-fixture.json");
    await writeExecutable(commandPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
if (mode === "fail") {
  setTimeout(() => process.exit(7), 150);
} else {
  const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  escaped.unref();
  writeFileSync(process.env.LIFECYCLE_FIXTURE_MARKER, JSON.stringify({
    sibling: process.pid,
    escaped: escaped.pid
  }));
  setInterval(() => {}, 1000);
}
`);
    const result = runLifecycleFixture("fail-fast-siblings", {
      LIFECYCLE_FIXTURE_COMMAND: commandPath,
      LIFECYCLE_FIXTURE_MARKER: markerPath
    }, root);
    const tracked = JSON.parse(await readFile(markerPath, "utf8"));
    await Promise.all([
      waitForProcessExit(tracked.sibling, 1_000),
      waitForProcessExit(tracked.escaped, 1_000)
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(processExists(tracked.sibling), false, "sibling root must be canceled");
    assert.equal(processExists(tracked.escaped), false, "sibling descendant must be canceled");
    assert.match(result.stdout, /"fixture":"fail-fast-siblings"/);
    assert.match(result.stdout, /"activeChildren":0/);
  });

  it("bounds lifecycle event I/O and handles a late rejection", () => {
    const result = spawnSync(
      process.execPath,
      [runnerPath, "--idempotency-key=event-timeout-contract"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --unhandled-rejections=strict`.trim(),
          AUTONOMOUS_INGESTION_LIFECYCLE_TEST_FIXTURE: "event-timeout"
        },
        encoding: "utf8",
        timeout: 3_000
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /"fixture":"event-timeout"/);
  });

  it("aborts and drains an in-flight heartbeat before finalization", () => {
    const result = runLifecycleFixture("heartbeat-drain");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"abortObserved":true/);
    assert.match(result.stdout, /"drained":true/);
  });

  it("rejects an unverified pre-existing completion and reconciles response loss", () => {
    const result = runLifecycleFixture("ambiguous-completion");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"completed"/);
    assert.match(result.stdout, /"completionVerified":true/);
  });

  it("turns emergency runtime-lock release failure into a failed output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-emergency-release-"));
    temporaryRoots.push(root);
    const outputPath = path.join(root, "github-output.txt");
    const result = runLifecycleFixture("emergency-release-failure", {
      GITHUB_OUTPUT: outputPath
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status":"failed"/);
    assert.match(result.stdout, /"exitCode":1/);
    const output = await readFile(outputPath, "utf8");
    assert.match(output, /^runner_status=failed$/m);
    assert.match(output, /Failed to release ingestion lease/);
  });

  it("reconciles runtime-lock response loss by exact ownership read-back", () => {
    const result = runLifecycleFixture("lock-release-response-loss");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"releaseCalls":1/);
    assert.match(result.stdout, /"readBackCalls":1/);
    assert.match(result.stdout, /"released":true/);
  });

  it("rejects an ambiguous runtime-lock claim until owner and execution nonce both match", () => {
    const result = runLifecycleFixture("lock-claim-ambiguity");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"foreignRejected":true/);
    assert.match(result.stdout, /"exactAccepted":true/);
  });

  it("releases the runtime lock before draining an abort-insensitive heartbeat", () => {
    const result = runLifecycleFixture("emergency-heartbeat-order");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"releaseObservedBeforeHeartbeatDrain":true/);
    assert.match(result.stdout, /"released":true/);
    assert.match(result.stdout, /"heartbeatDrained":true/);
  });

  it("retries a rejected GITHUB_OUTPUT write without duplicating a successful write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-output-retry-"));
    temporaryRoots.push(root);
    const badOutput = path.join(root, "bad-output-directory");
    const goodOutput = path.join(root, "github-output.txt");
    await mkdir(badOutput);
    const result = runLifecycleFixture("outcome-write-retry", {
      LIFECYCLE_FIXTURE_BAD_OUTPUT: badOutput,
      LIFECYCLE_FIXTURE_GOOD_OUTPUT: goodOutput
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"writes":1/);
    const output = await readFile(goodOutput, "utf8");
    assert.equal((output.match(/^runner_status=/gm) ?? []).length, 1);
    assert.match(output, /^runner_status=failed$/m);
  });

  it("sanitizes mutable-catalog stdout and stderr through the command runner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-catalog-sanitize-"));
    temporaryRoots.push(root);
    const scripts = path.join(root, "scripts");
    const secret = ["github", "pat", "catalog_refresh_contract_secret_123456789"].join("_");
    await mkdir(scripts, { recursive: true });
    await writeFile(
      path.join(scripts, "fetch-yc-spring-2026.mjs"),
      `process.stdout.write(\`catalog stdout token=\${process.env.GITHUB_TOKEN}\\n\`);\n` +
      `process.stderr.write(\`catalog stderr Bearer \${process.env.GITHUB_TOKEN}\\n\`);\n` +
      "process.exitCode = 7;\n",
      "utf8"
    );
    const result = runLifecycleFixture("catalog-sanitize", {
      GITHUB_TOKEN: secret,
      LIFECYCLE_FIXTURE_COMMAND: path.join(scripts, "fetch-yc-spring-2026.mjs")
    }, root);
    const diagnostics = `${result.stdout}\n${result.stderr}`;

    assert.equal(result.status, 0, result.stderr);
    assert.match(diagnostics, /catalog stdout token=\[redacted\]/);
    assert.match(diagnostics, /catalog stderr Bearer \[redacted\]/);
    assert.doesNotMatch(diagnostics, new RegExp(secret, "g"));
  });

  it("commits exactly five immutable Returner trailers bound to the committed receipt bytes", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-trailer-source-"));
    const publicationParent = await mkdtemp(path.join(os.tmpdir(), "returner-publication-trailer-"));
    const publicationRoot = path.join(publicationParent, "checkout");
    temporaryRoots.push(sourceRoot, publicationParent);
    runGit(sourceRoot, ["init", "-b", "main"]);
    runGit(sourceRoot, ["config", "user.name", "Trailer Fixture"]);
    runGit(sourceRoot, ["config", "user.email", "trailer-fixture@example.com"]);
    await writeFile(path.join(sourceRoot, "README.md"), "fixture\n", "utf8");
    runGit(sourceRoot, ["add", "README.md"]);
    runGit(sourceRoot, ["commit", "-m", "fixture base"]);
    const publicationBaseSha = runGit(sourceRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
    const pinnedSourceSha = runGit(repositoryRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
    runGit(sourceRoot, ["worktree", "add", "--detach", publicationRoot, publicationBaseSha]);
    const receipt = `${JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "publication-trailers-contract",
      trigger: "manual-replay",
      scheduledAt: null,
      fixture: "exact committed bytes"
    }, null, 2)}\n`;
    await mkdir(path.join(publicationRoot, "outputs"), { recursive: true });
    await writeFile(
      path.join(publicationRoot, "outputs", "ingestion-source-delta-current.json"),
      receipt,
      "utf8"
    );
    runGit(publicationRoot, ["add", "outputs/ingestion-source-delta-current.json"]);

    const result = runLifecycleFixture("publication-trailers", {
      GITHUB_RUN_ID: "31338649652",
      GITHUB_RUN_ATTEMPT: "7",
      LIFECYCLE_FIXTURE_PUBLICATION_ROOT: publicationRoot,
      LIFECYCLE_FIXTURE_PUBLICATION_PARENT: publicationParent
    }, sourceRoot);
    assert.equal(result.status, 0, result.stderr);
    const fixtureResult = JSON.parse(
      result.stdout.match(/LIFECYCLE_FIXTURE_RESULT=(\{.*\})/)?.[1] ?? "null"
    );
    const commitMessage = runGit(publicationRoot, ["show", "-s", "--format=%B", "HEAD"]).stdout;
    const expectedHash = createHash("sha256").update(receipt).digest("hex");
    const expectedTrailers = [
      `Returner-Slot-Key: publication-trailers-contract`,
      `Returner-Source-SHA: ${pinnedSourceSha}`,
      `Returner-Run-ID: 31338649652`,
      `Returner-Run-Attempt: 7`,
      `Returner-Receipt-SHA256: ${expectedHash}`
    ];
    for (const trailer of expectedTrailers) {
      assert.equal(
        commitMessage.split("\n").filter((line) => line === trailer).length,
        1,
        `${trailer} must appear exactly once`
      );
    }
    assert.equal(fixtureResult.receiptSha256, expectedHash);
    assert.equal(fixtureResult.publishedCommit, runGit(publicationRoot, ["rev-parse", "HEAD"]).stdout.trim());
    assert.equal(
      runGit(publicationRoot, ["show", "HEAD:outputs/ingestion-source-delta-current.json"]).stdout,
      receipt
    );
  });

  it("creates a provenance-bound empty commit for a truthful no-change publication", async () => {
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "autonomous-ingestion-no-change-source-"));
    const publicationParent = await mkdtemp(path.join(os.tmpdir(), "returner-publication-no-change-"));
    const publicationRoot = path.join(publicationParent, "checkout");
    temporaryRoots.push(sourceRoot, publicationParent);
    runGit(sourceRoot, ["init", "-b", "main"]);
    runGit(sourceRoot, ["config", "user.name", "No Change Fixture"]);
    runGit(sourceRoot, ["config", "user.email", "no-change-fixture@example.com"]);
    const receipt = `${JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "publication-trailers-contract",
      trigger: "manual-replay",
      scheduledAt: null,
      fixture: "no artifact bytes changed"
    }, null, 2)}\n`;
    await mkdir(path.join(sourceRoot, "outputs"), { recursive: true });
    await writeFile(
      path.join(sourceRoot, "outputs", "ingestion-source-delta-current.json"),
      receipt,
      "utf8"
    );
    runGit(sourceRoot, ["add", "outputs/ingestion-source-delta-current.json"]);
    runGit(sourceRoot, ["commit", "-m", "fixture base receipt"]);
    const publicationBaseSha = runGit(sourceRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
    const pinnedSourceSha = runGit(repositoryRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
    runGit(sourceRoot, ["worktree", "add", "--detach", publicationRoot, publicationBaseSha]);

    const result = runLifecycleFixture("publication-trailers", {
      GITHUB_RUN_ID: "31338649652",
      GITHUB_RUN_ATTEMPT: "8",
      LIFECYCLE_FIXTURE_ALLOW_EMPTY: "true",
      LIFECYCLE_FIXTURE_PUBLICATION_ROOT: publicationRoot,
      LIFECYCLE_FIXTURE_PUBLICATION_PARENT: publicationParent
    }, sourceRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      runGit(publicationRoot, ["rev-parse", "HEAD^{tree}"]).stdout.trim(),
      runGit(publicationRoot, ["rev-parse", "HEAD^1^{tree}"]).stdout.trim(),
      "no-change provenance commit must retain the exact parent tree"
    );
    const message = runGit(publicationRoot, ["show", "-s", "--format=%B", "HEAD"]).stdout;
    assert.match(message, /Returner-Slot-Key: publication-trailers-contract/);
    assert.match(message, new RegExp(`Returner-Source-SHA: ${pinnedSourceSha}`));
    assert.match(message, /Returner-Run-Attempt: 8/);
  });

  it("retries transport failures but never retries authentication or ordinary push rejection as transport", () => {
    const result = runLifecycleFixture("git-transport-classification");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"networkRetryable":true/);
    assert.match(result.stdout, /"authRetryable":false/);
    assert.match(result.stdout, /"rejectionRetryable":false/);
  });

  it("validates candidate semantics and rejects a scheduled run after the 11-hour window", () => {
    const scheduledAt = "2026-08-09T23:00:00.000Z";
    const common = {
      LIFECYCLE_FIXTURE_CANDIDATE_TRIGGER: "schedule",
      LIFECYCLE_FIXTURE_SCHEDULED_AT: scheduledAt,
      LIFECYCLE_FIXTURE_SLOT_KEY: "central-2026-08-09-1800",
      LIFECYCLE_FIXTURE_PUSH_LABEL: "first publication push"
    };
    const fresh = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      ...common,
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse(scheduledAt) + (11 * 60 * 60_000))
    }));
    const stale = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      ...common,
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse(scheduledAt) + (11 * 60 * 60_000) + 1)
    }));
    const wrongSlot = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      ...common,
      LIFECYCLE_FIXTURE_SLOT_KEY: "central-2026-08-09-0600",
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse(scheduledAt))
    }));
    const manual = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      LIFECYCLE_FIXTURE_CANDIDATE_TRIGGER: "manual-replay",
      LIFECYCLE_FIXTURE_SLOT_KEY: "manual-replay-fixture",
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse(scheduledAt) + (30 * 60 * 60_000))
    }));

    assert.equal(fresh.accepted, true);
    assert.equal(stale.accepted, false);
    assert.match(stale.error, /exceeded the 11-hour freshness window before first publication push/);
    assert.equal(wrongSlot.accepted, false);
    assert.match(wrongSlot.error, /slot key mismatch/);
    assert.equal(manual.accepted, true);
    assert.equal(manual.candidateMetadata.scheduledAt, null);
  });

  it("fails before spawning code when a privileged environment targets the publication worktree", async () => {
    const publicationParent = await mkdtemp(path.join(os.tmpdir(), "returner-publication-boundary-"));
    const publicationRoot = path.join(publicationParent, "checkout");
    temporaryRoots.push(publicationParent);
    await mkdir(publicationRoot, { recursive: true });
    const result = runLifecycleFixture("publication-credential-boundary", {
      GITHUB_TOKEN: "fixture-publication-boundary-token",
      LIFECYCLE_FIXTURE_PUBLICATION_ROOT: publicationRoot,
      LIFECYCLE_FIXTURE_PUBLICATION_PARENT: publicationParent
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"rejectedBeforeSpawn":true/);
  });
});

describe("autonomous ingestion runner static safety contracts", () => {
  it("claims, renews, and releases a durable runtime lock", () => {
    const lifecycle = section("} finally {", "function installTerminationSignalHandlers");
    const releaseOnce = section("async function releaseRuntimeLock", "function startHeartbeatScheduling");
    assert.ok(runner.includes('supabase.rpc("claim_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("renew_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("release_ingestion_runtime_lock"'));
    assert.ok(runner.includes('supabase.rpc("finalize_completed_ingestion_run"'));
    assert.ok(runner.indexOf("if (!args.plan && durableStorageConfigured)") < runner.indexOf("runtimeLock = await claimRuntimeLock()"));
    assert.ok(runner.indexOf("runtimeLock = await claimRuntimeLock()") < runner.indexOf("run = await getOrCreateRun()"));
    assert.ok(runner.indexOf("run = await getOrCreateRun()") < runner.indexOf("await refreshMutableYcCatalog()"));
    assert.ok(lifecycle.includes("await releaseRuntimeLockOnce()"));
    assert.ok(releaseOnce.includes("runtimeLockIsReleased(lock)"));
    assert.ok(releaseOnce.includes("runtimeLockReleasePromise = null"));
    assert.ok(releaseOnce.indexOf("await runtimeLockIsReleased(lock)") < releaseOnce.indexOf("runtimeLock = null"));
    assert.ok(releaseOnce.includes("releaseRuntimeLock(lock)"));
  });

  it("serializes heartbeat renewals and drains the snapshotted lease before finalization", () => {
    const heartbeatControl = section("function startHeartbeatScheduling", "async function getOrCreateRun");
    const successLifecycle = section("const finalCoverage =", "} catch (error) {");
    const cleanupLifecycle = section("} finally {", "function installTerminationSignalHandlers");
    const failureHandler = section("function failHeartbeat", "function assertLeaseHealthy");

    assert.ok(heartbeatControl.includes("heartbeatInFlight"));
    assert.ok(heartbeatControl.includes("heartbeatDrainPromise"));
    assert.ok(heartbeatControl.includes("if (heartbeatSchedulingStopped || terminationSignal || heartbeatInFlight)"));
    assert.ok(heartbeatControl.includes("const runSnapshot"));
    assert.ok(heartbeatControl.includes("const lockSnapshot"));
    assert.ok(heartbeatControl.includes("HEARTBEAT_DRAIN_TIMEOUT_MS"));
    assert.ok(
      successLifecycle.indexOf("await stopHeartbeatAndDrain()") <
      successLifecycle.indexOf('await completeRun("completed"')
    );
    assert.ok(
      cleanupLifecycle.indexOf("await stopHeartbeatAndDrain()") <
      cleanupLifecycle.indexOf("await releaseRuntimeLockOnce()")
    );
    assert.doesNotMatch(failureHandler, /process\.exitCode/);
  });

  it("bounds every runner-owned Supabase await and aborts bulk importer queries", () => {
    const deadlineWrapper = section("async function withLifecycleDeadline", "async function claimRuntimeLock");
    assert.doesNotMatch(runner, /await\s+supabase(?:\.|\s)/);
    assert.doesNotMatch(runner, /await\s+runLifecycleSupabaseOperation/);
    assert.ok(deadlineWrapper.includes("runnerBudget.timeoutMs(requestedTimeoutMs, label)"));
    assert.ok(deadlineWrapper.includes("operationPromise.catch(() => {})"));
    assert.ok(deadlineWrapper.includes("controller.abort(timeoutError)"));
    assert.ok(deadlineWrapper.includes("createAbortBoundSupabaseClient"));
    const durableImport = section("async function importDurableEvidence", "function assertDurableAttributionCompleteness");
    assert.ok(durableImport.includes('runSupabaseOperation(\n    "import durable evidence snapshots"'));
    assert.ok(durableImport.includes("createAbortBoundSupabaseClient(supabase, signal)"));
    for (const operation of [
      "upsert batch",
      "upsert companies",
      "enqueue account/platform tasks",
      "read terminal coverage",
      "persist coverage report",
      "persist artifact manifest",
      "Timeline artifact invalidations"
    ]) {
      assert.ok(runner.includes(operation), `missing bounded Supabase operation: ${operation}`);
    }
  });

  it("constructs category-specific child environments without inheriting parent secrets", () => {
    const commandRunner = section("function buildChildEnvironment", "function batchCompanyKey");
    assert.doesNotMatch(commandRunner, /\.\.\.process\.env/);
    assert.ok(commandRunner.includes("CHILD_ENV_CATEGORY_KEYS[category]"));
    assert.ok(commandRunner.includes("buildChildEnvironment(envCategory, env, cwd)"));
    assert.ok(commandRunner.includes("assertPublicationCommandCredentialBoundary(command, cwd, childEnvironment)"));
    assert.ok(commandRunner.includes('HOME: isolatedHome'));
    assert.ok(runner.includes('envCategory: "public_collector"'));
    assert.ok(runner.includes('envCategory: "github_collector"'));
    assert.ok(runner.includes('authenticated_social: [\n    "HOME"'));
    assert.ok(runner.includes('envCategory: "durable_timeline"'));
    assert.ok(runner.includes('envCategory: "publication_data"'));
    assert.ok(runner.includes('envCategory: "benchmark"'));
    assert.ok(runner.includes('envCategory: "timeline_backfill"'));
    const pushAuth = section("function publicationPushAuthEnvironment", "function githubPublicationAuthorizationHeader");
    assert.ok(pushAuth.includes('GIT_CONFIG_COUNT: "3"'));
    assert.ok(pushAuth.includes('GIT_CONFIG_KEY_2: "credential.helper"'));
    assert.ok(pushAuth.includes('GIT_CONFIG_VALUE_2: ""'));
    assert.ok(pushAuth.includes('GIT_CONFIG_NOSYSTEM: "1"'));
    assert.ok(pushAuth.includes('GIT_CONFIG_GLOBAL: "/dev/null"'));
    assert.ok(pushAuth.includes('GIT_TERMINAL_PROMPT: "0"'));
    const push = section("async function runPublicationPush", "function isRetryableGitTransportFailure");
    assert.ok(push.includes("assertNoTrackedSymlinksAtCommitSync(candidate.publishedCommit"));
    assert.ok(push.includes("`${candidate.publishedCommit}:${candidate.branch}`"));
    const preSpawnModeAudit = push.indexOf("assertNoTrackedSymlinksAtCommitSync(candidate.publishedCommit");
    const preSpawnFreshness = push.indexOf("assertCandidateFreshForPublication(candidate.label)");
    assert.ok(preSpawnModeAudit > push.indexOf("preSpawnGuard: () =>"));
    assert.ok(preSpawnFreshness > preSpawnModeAudit);
    const commandBoundary = section("async function runCommand", "function batchCompanyKey");
    assert.ok(commandBoundary.indexOf('await event("command.started"') < commandBoundary.indexOf("if (preSpawnGuard) {"));
    assert.ok(commandBoundary.indexOf("preSpawnGuard();") < commandBoundary.indexOf("spawn(command, commandArgs"));
    assert.ok(push.includes("error?.preSpawnGuardFailed === true"));
    assert.ok(runner.includes("const DEFAULT_NODE_CHILD_HEAP_MB = 1_536;"));
    assert.ok(commandBoundary.includes(
      "nodeHeapMb = isNodeExecutable(command) ? DEFAULT_NODE_CHILD_HEAP_MB : null"
    ));
    assert.ok(commandBoundary.includes("Number.isInteger(nodeHeapMb)"));
    assert.ok(commandBoundary.includes("nodeHeapMb <= 0"));
    assert.ok(commandBoundary.includes("nodeHeapMb must be a positive integer"));
    assert.ok(commandBoundary.includes("const childEnvironment = buildChildEnvironment(envCategory, env, cwd)"));
    assert.ok(commandBoundary.includes("--max-old-space-size=${nodeHeapMb}"));
    assert.ok(commandBoundary.includes("childEnvironment.NODE_OPTIONS = ["));
  });

  it("keeps privileged execution on the pinned source checkout and isolates publication mutation", () => {
    const worktree = section("async function ensurePublicationWorktree", "async function publishGithubExports");
    const collectors = section("async function runCollectors()", "async function runTopVoiceCollector");
    const publicCollector = section(
      "async function runPublicCollectorWithCheckpointRecovery",
      "async function runTopVoiceCollector"
    );
    const timeline = section(
      "async function runTimelineDiscoveryBeforeBackfill",
      "async function buildCanonicalTimelineIngestionInventory"
    );
    const publicationBuild = section(
      "async function buildAndValidatePublication",
      "async function synchronizePublicationBase"
    );
    const push = section(
      "async function runPublicationPush",
      "async function resolveAmbiguousPublicationAfterCancellation"
    );

    assert.ok(runnerSource.includes("const pinnedSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), \"..\")"));
    assert.ok(runnerSource.includes("return join(pinnedSourceRoot, ...segments)"));
    assert.ok(worktree.includes('["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", target, baseCommit]'));
    assert.ok(worktree.includes("assertTrustedPublicationBaseCommit(baseCommit"));
    assert.ok(worktree.includes("preverifiedPublicationBaseCommit"));
    assert.ok(runnerSource.includes('["merge-base", "--is-ancestor", immutableSourceCommit, commit]'));
    assert.ok(runnerSource.includes('parentName.startsWith("returner-publication-")'));
    assert.ok(runnerSource.includes("verifyPinnedSourceExecutionBoundary"));
    assert.ok(runnerSource.includes("assertNoTrackedSymlinksAtCommit"));
    assert.match(collectors, /envCategory: "github_collector",\s*cwd: root/);
    assert.match(publicCollector, /envCategory: "public_collector",\s*cwd: root/g);
    assert.match(timeline, /envCategory: "durable_timeline",[\s\S]*?cwd: root/);
    assert.match(publicationBuild, /label: "export durable Company Timeline database snapshot",[\s\S]*envCategory: "durable_timeline",[\s\S]*?cwd: root/);
    assert.match(publicationBuild, /envCategory: "timeline_backfill",[\s\S]*cwd: targetRoot/);
    assert.ok(publicationBuild.includes("`--database-snapshot=${timelineDatabaseSnapshotPath}`"));
    assert.doesNotMatch(
      section("const timelineBackfillEnv = durableStorageConfigured", "await runCommand(process.execPath, [\"scripts/validate-timeline-artifacts.mjs\"]", publicationBuild),
      /SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_URL/
    );
    assert.match(push, /"-C",\s*publicationRoot,\s*"push"/);
    assert.ok(push.includes("cwd: root"));
    assert.ok(runnerSource.includes("assertPublicationCommandCredentialBoundary(command, cwd, childEnvironment)"));
  });

  it("binds every collector shard to one fresh campaign attempt before merge", () => {
    const publicShards = section("async function runShardedPublicCollector", "async function seedShardLedger");
    const binding = section("async function removeCollectorAttemptOutput", "async function runShardedGithubCollector");
    const githubShards = section("async function runShardedGithubCollector", "function githubShardSearchBudget");
    const snapshotReader = section("async function readCollectorSnapshot", "async function writeJsonAtomic");

    for (const collector of [publicShards, githubShards]) {
      assert.ok(collector.includes("removeCollectorAttemptOutput(shard.outputPath)"));
      assert.ok(collector.includes("readFreshCollectorShard"));
      assert.ok(collector.includes("collectorLaunchProvenanceArgs(attemptContext)"));
      assert.ok(collector.includes("latestCollectorFetchedAt(snapshots)"));
      assert.ok(collector.includes("shardAttempts"));
    }
    assert.ok(binding.includes("fileStat.mtimeMs"));
    assert.ok(binding.includes("foreign shard provenance"));
    assert.ok(binding.includes("expectedAttemptId: attemptContext.attemptId"));
    assert.ok(binding.includes("expectedCampaignKey: attemptContext.campaignKey"));
    assert.ok(binding.includes("expectedExecutionNonce: attemptContext.executionNonce"));
    assert.doesNotMatch(binding, /autonomousAttempt:\s*collectorAttemptBinding/);
    assert.ok(snapshotReader.includes("requireAttemptBinding"));
    assert.ok(snapshotReader.includes("expectedExecutionNonce"));
  });

  it("emits exactly the five workflow provenance trailers and verifies committed receipt bytes", () => {
    const commit = section("async function commitPublicationArtifacts", "async function refreshMutableYcCatalog");
    const expectedNames = [
      "Returner-Slot-Key",
      "Returner-Source-SHA",
      "Returner-Run-ID",
      "Returner-Run-Attempt",
      "Returner-Receipt-SHA256"
    ];
    for (const name of expectedNames) {
      assert.equal((commit.match(new RegExp(name, "g")) ?? []).length >= 1, true, `${name} missing`);
    }
    assert.ok(commit.includes('createHash("sha256").update(receiptBytes).digest("hex")'));
    assert.ok(commit.includes('readTextFromGitRef(\n    commit,\n    "outputs/ingestion-source-delta-current.json"'));
    assert.ok(commit.includes('createHash("sha256").update(committedReceipt).digest("hex")'));
    assert.ok(commit.includes("core.hooksPath=/dev/null"));
  });

  it("keeps post-completion telemetry best-effort after durable completion wins", () => {
    const completion = section("const finalCoverage =", "} catch (error) {");
    const durableCompletion = completion.indexOf('await completeRun("completed", completionStats)');
    const telemetry = completion.indexOf('"run.completed"', durableCompletion);
    const telemetryCatch = completion.indexOf(").catch((error) => {", telemetry);
    assert.ok(durableCompletion > -1 && telemetry > durableCompletion && telemetryCatch > telemetry);
    assert.doesNotMatch(completion.slice(telemetryCatch), /completeRun\("failed"/);
  });

  it("handles first and second termination signals through bounded idempotent cleanup", () => {
    const signals = section("function installTerminationSignalHandlers", "async function claimRuntimeLock");
    const childTracker = section("function trackChildProcess", "async function writeRunnerOutcomeOnce");

    assert.ok(signals.includes('process.on(signal'));
    assert.ok(signals.includes('signalActiveChildProcesses("SIGTERM")'));
    assert.ok(signals.includes('signalActiveChildProcesses("SIGKILL")'));
    assert.ok(signals.includes("beginEmergencyCancellationCleanup()"));
    assert.ok(signals.includes("CANCELLATION_CLEANUP_TIMEOUT_MS"));
    assert.ok(signals.includes("CANCELLATION_EMERGENCY_TIMEOUT_MS"));
    assert.doesNotMatch(
      section("function installTerminationSignalHandlers", "function scheduleCancellationDeadline"),
      /process\.exit\(/
    );
    assert.ok(childTracker.includes("snapshotProcessDescendants"));
    assert.ok(childTracker.includes("signalChildProcessTree"));
    assert.ok(childTracker.includes("waitForTrackedChildren"));
    assert.ok(runner.includes("CANCELLATION_EMERGENCY_TIMEOUT_MS = 150_000"));
  });

  it("serializes lease-guarded finalization and preserves a completed winner", () => {
    const finalization = section("async function completeRun", "async function runCommand");
    const cancellationCleanup = section("} finally {", "function installTerminationSignalHandlers");

    assert.ok(finalization.includes("runFinalizationPromise"));
    assert.ok(finalization.includes("finalizedRunStatus"));
    assert.ok(finalization.includes("finalizeRunWithClaimedLease"));
    assert.ok(finalization.includes('.eq("lease_owner", runSnapshot.leaseOwner)'));
    assert.ok(finalization.includes('.eq("lease_token", runSnapshot.leaseToken)'));
    assert.ok(finalization.includes('supabase.rpc("finalize_completed_ingestion_run"'));
    assert.ok(finalization.includes("completionProvenanceMatches(stats, stats)"));
    assert.ok(finalization.includes("completionProvenanceMatches(data.stats_json, expectedStats)"));
    assert.ok(runner.includes("receiptHash: hashCanonicalJson(receipt)"));
    assert.ok(runner.includes("publishedCommit: normalizedCommit"));
    assert.ok(cancellationCleanup.includes("await waitForRunFinalization()"));
    assert.ok(cancellationCleanup.includes("if (completedFinalizationWon())"));
    assert.ok(cancellationCleanup.includes("successfulRunnerOutcomeCandidate ?? pendingRunnerOutcome"));
    assert.ok(cancellationCleanup.includes("process.exitCode = 0"));
  });

  it("allows file-backed recovery without Supabase but explicitly degrades workflow health", () => {
    assert.ok(runner.includes("supabaseConfiguration = validateSupabaseConfiguration(url, serviceKey)"));
    assert.ok(runner.includes("durableStorageConfigured = supabaseConfiguration.valid"));
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
      /durableStorageConfigured\s*\?\s*{\s*TIMELINE_REQUIRE_DATABASE:\s*"true",[\s\S]*?SCORING_DATA_ROOT:\s*targetRoot/
    );
    assert.match(
      timelineBackfill,
      /:\s*{\s*TIMELINE_REQUIRE_DATABASE:\s*"false",[\s\S]*?SCORING_DATA_ROOT:\s*targetRoot/
    );
    assert.ok(timelineBackfill.includes('"scripts/backfill-company-timelines.mjs"'));
    assert.ok(timelineBackfill.includes("--database-snapshot="));
    assert.ok(timelineBackfill.includes("env: timelineBackfillEnv"));
  });

  it("carries provider health, credential gaps, and mapped efficacy into the published health receipt", () => {
    const coverageSummary = section(
      "async function summarizeCollectionCoverage",
      "async function recordCollectionCoverage"
    );
    const outcomeWriter = section(
      "async function writeRunnerOutcome",
      "async function readCommitBackedReplayReceipt"
    );
    assert.ok(runner.includes('!cleanEnv(process.env.X_BEARER_TOKEN) ? "X_BEARER_TOKEN"'));
    assert.ok(runner.includes('!cleanEnv(process.env.EXA_API_KEY) ? "EXA_API_KEY"'));
    assert.ok(runner.includes("collectionCoverage,"));
    assert.ok(runner.includes("credentialGaps: collectionCredentialGaps"));
    assert.ok(runner.includes("collectionHealthReasons"));
    assert.ok(runner.includes("explicitTerminalOnly: true"));
    assert.ok(runner.includes("providerBlocked"));
    assert.ok(runner.includes("mappedProviderBlocked"));
    const totalProviderBlocker = coverageSummary.indexOf("if (outcome.providerBlocked === true)");
    const mappedAccountingAfterBlocker = coverageSummary.indexOf("if (task.account)", totalProviderBlocker);
    assert.ok(totalProviderBlocker > -1 && mappedAccountingAfterBlocker > totalProviderBlocker);
    assert.match(outcomeWriter, /provider_blocked:\s*normalized\.providerBlocked/);
    assert.match(outcomeWriter, /provider_blocked_by_reason:\s*JSON\.stringify/);
    assert.match(outcomeWriter, /mapped_scope_unsupported:\s*normalized\.mappedScopeUnsupported/);
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
    const receiptReader = section(
      "async function readCommitBackedReplayReceipt",
      "async function resolveVerifiedCurrentPublicationCommit"
    );
    assert.ok(completedReplay.includes("readCommitBackedReplayReceipt"));
    assert.ok(completedReplay.includes("repositoryBackedReplay.publishedCommit"));
    assert.ok(receiptReader.includes('"outputs/ingestion-source-delta-current.json"'));
    assert.ok(receiptReader.includes('"outputs/ingestion-source-delta-history.json"'));
    assert.ok(receiptReader.includes("selectPublishedAutonomousIngestionReceipt"));
  });

  it("uses a commit-backed receipt to make file-backed GitHub Actions replays idempotent", () => {
    const replayGate = section("let commitBackedReplay", "await Promise.all([");
    assert.ok(replayGate.includes('process.env.GITHUB_ACTIONS === "true"'));
    assert.ok(replayGate.includes("!durableStorageConfigured"));
    assert.ok(replayGate.includes("!args.skipPublish"));
    assert.ok(replayGate.includes('status: "already_completed"'));
    assert.ok(replayGate.includes('publicationStatus: "already_completed"'));
    assert.ok(replayGate.includes("publishedCommit"));
    assert.ok(runner.indexOf("let commitBackedReplay") < runner.indexOf("await refreshMutableYcCatalog()"));
    assert.ok(runner.indexOf("let commitBackedReplay") < runner.indexOf("runCollectors()"));
    const receiptReader = section("async function readCommitBackedReplayReceipt", "async function resolveVerifiedCurrentPublicationCommit");
    assert.ok(receiptReader.includes("readJsonFromGitRef"));
    assert.ok(receiptReader.includes("publishedCommit"));
  });

  it("verifies publication outcomes remotely and resolves replay from the exact historical publication commit", () => {
    const publication = section(
      "async function publishRepositoryArtifacts",
      "async function stageRepositoryArtifacts"
    );
    const replay = section(
      "async function resolvePublicationRemoteTip",
      "async function readJson"
    );
    const replayReader = section(
      "async function readCommitBackedReplayReceipt",
      "function parsePublicationLogEntries"
    );
    const verifier = section(
      "async function verifyPublicationCommitOnRemote",
      "async function assertNoPublicationConflicts"
    );

    assert.match(
      publication,
      /const publicationStatus = publicationTreeChanged \? "published" : "no_changes";[\s\S]*status:\s*publicationStatus,[\s\S]*publishedCommit/
    );
    assert.equal(publication.match(/verifyPublicationCommitOnRemote/g)?.length, 1);
    assert.ok(publication.includes("runPublicationPush(firstPushCandidate"));
    assert.ok(publication.includes("runPublicationPush(retryPushCandidate"));
    assert.ok(replay.includes('["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]'));
    assert.ok(replay.includes('["rev-parse", `refs/remotes/origin/${branch}^{commit}`]'));
    assert.ok(replay.includes('["merge-base", "--is-ancestor", immutableSourceCommit, remoteCommit]'));
    assert.ok(replayReader.includes('"--grep=Returner-Slot-Key:"'));
    assert.ok(replayReader.includes("validateReplayPublicationTrailers"));
    assert.ok(replayReader.includes("assertTrustedPublicationBaseCommit(publishedCommit"));
    assert.ok(replayReader.includes("return selected"));
    assert.match(verifier, /\^\[0-9a-f\]\{40\}\$/i);
    assert.ok(verifier.includes('["fetch", "--prune", "origin", branch]'));
    assert.ok(verifier.includes('["merge-base", "--is-ancestor", publishedCommit, `origin/${branch}`]'));
  });

  it("classifies each provenance candidate against its exact publication base", () => {
    const publication = section(
      "async function publishRepositoryArtifacts",
      "async function stageRepositoryArtifacts"
    );
    const comparator = section(
      "async function classifyPublicationSemantics",
      "async function headHasPublicationRunIdentity"
    );

    assert.ok(runner.includes('"./lib/publication-semantic-diff.mjs"'));
    assert.ok(comparator.includes("rootDir: publicationRoot"));
    assert.ok(comparator.includes("baseRef,"));
    assert.ok(comparator.includes("targetRef,"));
    assert.ok(comparator.includes("ignoredPaths: PUBLICATION_SEMANTIC_IGNORED_PATHS"));
    assert.ok(runner.includes('"outputs/ingestion-source-delta-current.json"'));
    assert.ok(runner.includes('"outputs/ingestion-source-delta-history.json"'));
    assert.match(
      publication,
      /publicationTreeChanged = await classifyPublicationSemantics\(\{[\s\S]*?baseRef: publicationBaseCommit[\s\S]*?targetRef: firstPushCommit/
    );
    assert.match(
      publication,
      /publicationTreeChanged = await classifyPublicationSemantics\(\{[\s\S]*?baseRef: retryBaseCommit[\s\S]*?targetRef: retryPushCommit/
    );
    assert.doesNotMatch(publication, /publicationTreeChanged\s*=\s*publicationTreeChanged\s*\|\|/);
    assert.doesNotMatch(publication, /git", \["diff", "--cached", "--quiet"\]/);
    assert.equal(
      (publication.match(/allowUnchangedTree: true/g) ?? []).length,
      2,
      "initial and retry provenance commits must both permit an unchanged semantic tree"
    );
  });

  it("exports the verified publication commit for workflow receipt wiring", () => {
    const outcomeWriter = section("async function writeRunnerOutcome", "async function readCommitBackedReplayReceipt");
    const publication = section(
      "async function publishRepositoryArtifacts",
      "async function stageRepositoryArtifacts"
    );
    assert.ok(outcomeWriter.includes("published_commit: normalized.publishedCommit"));
    assert.match(runner, /publicationStatus:\s*publicationReceipt\.status[\s\S]*publishedCommit:\s*publicationReceipt\.publishedCommit/);
    assert.match(runner, /latestPublishedCommit = publicationReceipt\.publishedCommit/);
    assert.match(runner, /terminalFailureBudget:\s*latestTerminalFailureBudget,[\s\S]*publishedCommit:\s*latestPublishedCommit/);

    const firstPush = publication.indexOf('commandLabel: "push refreshed artifacts"');
    const firstCapture = publication.indexOf("runPublicationPush(firstPushCandidate");
    const retryPush = publication.indexOf('commandLabel: "retry refreshed artifact push"');
    const retryCapture = publication.indexOf("runPublicationPush(retryPushCandidate");
    const verification = publication.indexOf("await verifyPublicationCommitOnRemote(publishedCommit");
    const completionEvent = publication.indexOf(
      'publicationTreeChanged ? "publication.completed" : "publication.no_changes"'
    );
    assert.ok(firstCapture > -1 && firstPush > firstCapture);
    assert.ok(retryCapture > firstPush && retryPush > retryCapture);
    assert.ok(verification > retryPush && completionEvent > verification);
    const pushRunner = section("async function runPublicationPush", "async function resolveAmbiguousPublicationAfterCancellation");
    assert.ok(pushRunner.includes("latestPublishedCommit = candidate.publishedCommit"));
    assert.ok(pushRunner.includes("reconcilePublicationPushCandidate(candidate"));
  });

  it("verifies an ambiguous interrupted push before writing its cancellation receipt", () => {
    const publication = section(
      "async function publishRepositoryArtifacts",
      "async function stageRepositoryArtifacts"
    );
    const cleanup = section("} finally {", "function installTerminationSignalHandlers");

    assert.equal((publication.match(/const (?:first|retry)PushCandidate = \{/g) ?? []).length, 2);
    assert.ok(publication.includes('label: "first publication push"'));
    assert.ok(publication.includes('label: "retry publication push"'));
    assert.ok(runner.includes("reconcilePublicationPushCandidate(candidate"));
    assert.ok(runner.includes('"failure or response loss"'));
    assert.ok(runner.includes("allowDuringCancellation: true"));
    assert.ok(runner.includes("CANCELLATION_REMOTE_VERIFY_TIMEOUT_MS"));
    assert.ok(cleanup.indexOf("await resolveAmbiguousPublicationAfterCancellation()") <
      cleanup.indexOf("pendingRunnerOutcome = canceledRunnerOutcome(terminationSignal)"));
  });

  it("captures bootstrap failures inside the diagnostic outcome boundary", () => {
    const tryBoundary = runner.indexOf("try {\nroot = resolve(process.cwd())");
    assert.ok(tryBoundary >= 0);
    for (const bootstrapStep of [
      "parseArgs(process.argv.slice(2))",
      "randomUUID()",
      "createAutonomousRunnerBudget({",
      "if (!idempotencyKey)",
      "validateSupabaseConfiguration(url, serviceKey)",
      "readCommitBackedReplayReceipt()",
      "mkdir(workRoot",
      "refreshMutableYcCatalog()",
      "loadAutonomousCatalogs(publicationArtifactRoot())",
      "buildAutonomousTaskPlan(catalogs"
    ]) {
      assert.ok(runner.indexOf(bootstrapStep) > tryBoundary, bootstrapStep);
    }
    assert.ok(runner.indexOf("} catch (error) {") > runner.indexOf("buildAutonomousTaskPlan(catalogs"));
  });

  it("sanitizes every top-level failure sink", () => {
    const catchPath = section("} catch (error) {", "} finally {");
    const sanitizer = section("function sanitizedRunnerFailure", "function failedRunnerOutcome");

    assert.ok(catchPath.includes("const failure = sanitizedRunnerFailure(error)"));
    assert.ok(catchPath.includes("console.error(sanitizeRunnerDiagnosticText(message))"));
    assert.ok(catchPath.includes("console.error(failure.message)"));
    assert.ok(catchPath.includes('event("run.failed", "error", failure.message, { stack: failure.stack })'));
    assert.ok(catchPath.includes("error: failure.message"));
    assert.ok(catchPath.includes("stack: failure.stack"));
    assert.doesNotMatch(catchPath, /console\.error\(message\)/);
    assert.doesNotMatch(catchPath, /error\.stack/);
    assert.ok(sanitizer.includes("sanitizeRunnerFailureMessage(errorMessage(error), options)"));
    assert.ok(sanitizer.includes("sanitizeRunnerFailureMessage(error.stack"));
  });

  it("turns runtime-lock cleanup failure into a failed outcome after preserving publication", () => {
    const lifecycle = section("} finally {", "function installTerminationSignalHandlers");
    const release = lifecycle.indexOf("await releaseRuntimeLockOnce()");
    const failureOutcome = lifecycle.indexOf("pendingRunnerOutcome = failedRunnerOutcome(", release);
    const outcomeWrite = lifecycle.indexOf(
      "await writeRunnerOutcomeOnce(pendingRunnerOutcome)",
      failureOutcome
    );

    assert.ok(release > -1 && failureOutcome > release && outcomeWrite > failureOutcome);
    assert.ok(lifecycle.includes('event(\n            "run.cleanup_failed"'));
    assert.ok(lifecycle.includes("publishedCommit: latestPublishedCommit"));
    assert.ok(lifecycle.includes("process.exitCode = 1"));
    assert.ok(runner.includes(
      "publishedCommit: latestPublishedCommit ?? pendingRunnerOutcome?.publishedCommit ?? null"
    ));
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
      "await mergePublicationInputs(rebasedPublicationInputs, { baseRef: publicationBaseCommit })"
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

  it("runs authenticated social collection only through the dedicated bounded lane", () => {
    const collectors = section("async function runCollectors()", "async function runTopVoiceCollector");
    assert.match(collectors, /fetch-logged-in-social-traction/);
    assert.match(collectors, /"--platforms=instagram"/);
    assert.match(collectors, /"--platforms=linkedin"/);
    assert.match(collectors, /"--allow-linkedin"/);
    assert.match(collectors, /"--workers=1"/);
    assert.match(collectors, /historicalReplay \? 2 : 1/);
    assert.match(collectors, /"--linkedin-max-targets=5"/);
    assert.match(collectors, /"--delay-ms=30000"/);
    assert.ok(collectors.includes('env: { HOME: process.env.HOME }'));
    assert.ok(collectors.includes('"scripts/fetch-public-traction.mjs"'));
    assert.ok(collectors.includes('"scripts/fetch-github-traction.mjs"'));
  });

  it("publishes authenticated historical replays without rerunning public collector lanes", () => {
    assert.ok(runner.includes('args.authenticatedSocialReplay'));
    assert.ok(runner.includes('runAuthenticatedCollectors({ historicalReplay: true })'));
    assert.ok(runner.includes('{ skipNetwork: args.skipNetwork || args.authenticatedSocialReplay }'));
    assert.ok(runner.includes('candidateMetadata?.trigger !== "manual-replay"'));
    assert.ok(runner.includes('collectorRoot = args.authenticatedSocialReplay'));
    assert.ok(runner.includes('resolve(openCliHome)'));
    assert.ok(runner.includes('if (!args.authenticatedSocialReplay) {\n      assertSuccessfulTopVoiceRefresh(topVoiceRefresh);'));
  });

  it("refreshes and publishes the mutable Summer catalog before planning", () => {
    const refreshIndex = runner.indexOf("await refreshMutableYcCatalog()");
    const planningIndex = runner.indexOf("catalogs = await loadAutonomousCatalogs(publicationArtifactRoot())");
    const lockIndex = runner.indexOf("runtimeLock = await claimRuntimeLock()");
    const artifactPaths = section("function repositoryArtifactPaths", "async function refreshMutableYcCatalog");

    assert.ok(refreshIndex > -1 && refreshIndex < planningIndex);
    assert.ok(lockIndex > -1 && lockIndex < refreshIndex);
    assert.ok(artifactPaths.includes('"src/lib/yc/summer-2026-companies.json"'));
    assert.ok(artifactPaths.includes('"src/lib/yc/summer-2026-company-aliases.json"'));
    const refresh = section("async function refreshMutableYcCatalog", "function publicationBranch");
    assert.ok(refresh.includes("AUTONOMOUS_PROCESS_BUDGETS.catalogRefreshMs"));
    assert.ok(refresh.includes("await runCommand(process.execPath"));
    assert.doesNotMatch(refresh, /\bspawn\(/);
    assert.doesNotMatch(refresh, /stdio:\s*\[[^\]]*inherit/);
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

  it("bounds public and GitHub shard processes with separate request lanes", () => {
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
    assert.ok(collectors.includes("run: (attemptContext) => runShardedGithubCollector({"));
    assert.ok(collectors.includes("totalCompanyCount: companyCount"));
    assert.ok(collectors.includes("command.promise = runCollectorWithRetries(command)"));
    assert.ok(runner.includes("PUBLIC_SHARD_PROCESS_CONCURRENCY = 2"));
    assert.ok(runner.includes("PUBLIC_COLLECTOR_TASK_CONCURRENCY = 8"));
    assert.ok(runner.includes("PUBLIC_SOCIAL_LANE_CONCURRENCY = 1"));
    assert.ok(runner.includes("GITHUB_SHARD_PROCESS_CONCURRENCY = 2"));
    assert.ok(runner.includes("GITHUB_COLLECTOR_TASK_CONCURRENCY = 4"));
    assert.ok(runner.includes("runWithGithubShardProcessSlot = createConcurrencyGuard(GITHUB_SHARD_PROCESS_CONCURRENCY)"));
    assert.ok(shardedCollector.includes("runWithPublicShardProcessSlot(() =>"));
    assert.doesNotMatch(collectors, /githubQueue/);
    assert.equal(
      (collectors.match(/command\.promise = runCollectorWithRetries\(command\)/g) ?? []).length,
      1,
      "all cohorts must be admitted together; GitHub shard slots provide the process cap"
    );
    assert.ok(collectors.includes("runShardedGithubCollector"));
    assert.ok(shardedGithubCollector.includes("Promise.allSettled"));
    assert.ok(shardedGithubCollector.includes("runWithGithubShardProcessSlot(() => runCommand("));
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
    assert.ok(collectors.includes('`--workers=${GITHUB_COLLECTOR_TASK_CONCURRENCY}`'));
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

  it("applies a conservative heap cap to every public and GitHub collector launch", () => {
    const githubCollector = section(
      "async function runShardedGithubCollector",
      "function githubShardSearchBudget"
    );
    const publicCollector = section(
      "async function runPublicCollectorWithCheckpointRecovery",
      "async function runTopVoiceCollector"
    );
    const topVoiceCollector = section("async function runTopVoiceCollector", "async function resumeTopVoiceRefresh");
    const fullCorpusHeap = runner.match(/const FULL_CORPUS_NODE_HEAP_MB = ([\d_]+);/)?.[1];
    const collectorHeap = runner.match(/const COLLECTOR_NODE_HEAP_MB = ([\d_]+);/)?.[1];

    assert.ok(collectorHeap, "collector heap constant must be declared");
    assert.ok(fullCorpusHeap, "full-corpus heap constant must be declared");
    assert.ok(Number(collectorHeap.replaceAll("_", "")) > 0);
    assert.ok(
      Number(collectorHeap.replaceAll("_", "")) <= 768,
      "five overlapping collector processes must leave native-memory headroom on a 7 GB runner"
    );
    assert.ok(
      Number(collectorHeap.replaceAll("_", "")) < Number(fullCorpusHeap.replaceAll("_", ""))
    );
    assert.match(githubCollector, /nodeHeapMb: COLLECTOR_NODE_HEAP_MB/);
    assert.equal(
      (publicCollector.match(/nodeHeapMb: COLLECTOR_NODE_HEAP_MB/g) ?? []).length,
      2,
      "public attempt and checkpoint-flush launches must both be heap bounded"
    );
    assert.match(topVoiceCollector, /nodeHeapMb: COLLECTOR_NODE_HEAP_MB/);
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
    assert.ok(mutableCatalogRefresh.includes("await runCommand(process.execPath"));
    assert.doesNotMatch(mutableCatalogRefresh, /\bspawn\(/);
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
    assert.ok(runner.includes(": args.campaignKey\n    ? join(root, \"work\", \"autonomous-ingestion-campaigns\""));
    assert.ok(runner.includes("join(collectorRoot, `public-${batch.slug.toLowerCase()}.json`)"));
    assert.ok(runner.includes("join(collectorRoot, `github-${batch.slug.toLowerCase()}.json`)"));
    assert.ok(runner.includes('topVoiceOutput = join(collectorRoot, "top-voice-refresh.json")'));
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
      /await runFailFastBranches\(\[\s*\(\) => runCollectors\(\),\s*\(\) => resumeTopVoiceRefresh\(\)\s*\]\)/
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
    assert.ok(topVoiceResume.includes("validateSnapshot: (receipt) =>"));
    assert.ok(topVoiceResume.includes("assertSuccessfulTopVoiceRefresh(receipt)"));
    assert.ok(topVoiceResume.includes("stale, future, or foreign collector provenance"));
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
      ["derived artifact generation", runner.indexOf("await buildAndValidatePublication(publicationRunId, catalogState)")],
      ["repository publication", runner.indexOf("await publishRepositoryArtifacts(publicationRunId, publicationInputs)")]
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
      ["derived artifact generation", runner.indexOf("await buildAndValidatePublication(publicationRunId, catalogState)")],
      ["repository publication", runner.indexOf("await publishRepositoryArtifacts(publicationRunId, publicationInputs)")]
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

    assert.ok(commandRunner.includes('signalChildProcessTree(child, "SIGTERM")'));
    assert.ok(commandRunner.includes('signalChildProcessTree(child, "SIGKILL")'));
    assert.ok(commandRunner.includes("AUTONOMOUS_PROCESS_BUDGETS.processKillGraceMs"));
    assert.ok(commandRunner.includes("if (timedOut)"));
    assert.ok(commandRunner.includes('child.once("close"'));
    assert.doesNotMatch(commandRunner, /child\.once\("exit"/);
  });

  it("binds every child-ledger PID to a stable start identity before signaling", () => {
    const ledgerReader = section("function rememberLedgerDescendants", "function processHasChildLedgerMarker");
    const treeSignaler = section("function signalChildProcessTree", "function signalActiveChildProcesses");

    assert.match(childProcessLedgerHook, /linux-proc-start/);
    assert.match(childProcessLedgerHook, /ps-lstart/);
    assert.match(
      childProcessLedgerHook,
      /`\$\{ledgerRunId\}\\t\$\{child\.pid\}\\t\$\{startIdentity\}\\n`/
    );
    assert.ok(ledgerReader.includes("snapshotProcessStartIdentities(recordedIdentities.keys())"));
    assert.ok(ledgerReader.includes("identities.has(observedIdentity)"));
    assert.ok(ledgerReader.includes("ledger.identities = validIdentities"));
    assert.doesNotMatch(treeSignaler, /signalStartIdentities/);
    assert.ok(treeSignaler.includes(
      "signalPid(pid, signal, expectedStartIdentity, readStartIdentity)"
    ));
    assert.ok(treeSignaler.includes("CHILD_DESCENDANT_PIDS]?.delete(pid)"));
    assert.ok(treeSignaler.includes("CHILD_PROCESS_LEDGER]?.identities?.delete(pid)"));
    assert.ok(runnerSource.includes("observedStartIdentity !== expectedStartIdentity"));
  });

  it("retains exit status with a bounded failure-sanitized stdout and stderr tail", () => {
    const commandRunner = section("async function runCommand", "function batchCompanyKey");
    const failureMessage = section("function commandFailureMessage", "function errorMessage");

    assert.ok(commandRunner.includes("commandExecutionError("));
    assert.ok(failureMessage.includes("commandFailureMessage(status, payload)"));
    assert.ok(commandRunner.includes('`${label} exited with ${code ?? signal ?? "unknown status"}.`'));
    assert.ok(failureMessage.includes("sanitizeRunnerDiagnosticText"));
    assert.ok(failureMessage.includes("COMMAND_FAILURE_TAIL_MAX_LENGTH"));
    assert.ok(failureMessage.includes("stderr:"));
    assert.ok(failureMessage.includes("stdout:"));
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
    assert.ok(runner.includes("GITHUB_SHARD_PROCESS_CONCURRENCY = 2"));
    assert.ok(runner.includes("GITHUB_COLLECTOR_TASK_CONCURRENCY = 4"));
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
    const scoringDiagnosticsIndex = publicationBuild.indexOf('"scripts/run-scoring-diagnostics-v4.mjs"');
    const writeIndex = publicationBuild.indexOf('"scripts/write-artifact-manifest.mjs"');
    const validateIndex = publicationBuild.indexOf('["scripts/validate-public-artifacts.mjs"]');
    const strictManifestIndex = publicationBuild.indexOf('"scripts/write-artifact-manifest.mjs", "--validate"');
    const buildCallIndex = runner.indexOf("await buildAndValidatePublication(publicationRunId, catalogState)");
    const persistIndex = runner.indexOf("await persistArtifactManifest(run.id)", buildCallIndex);
    const publishIndex = runner.indexOf(
      "await publishRepositoryArtifacts(publicationRunId, publicationInputs)"
    );
    const completionIndex = runner.indexOf('await completeRun("completed"');
    const manifestPersistence = section("async function persistArtifactManifest", "async function buildAndValidatePublication");

    assert.ok(scoringDiagnosticsIndex > -1);
    assert.ok(writeIndex > -1);
    assert.ok(
      writeIndex > scoringDiagnosticsIndex &&
      validateIndex > writeIndex &&
      strictManifestIndex > validateIndex
    );
    assert.ok(persistIndex > buildCallIndex);
    assert.ok(publishIndex > persistIndex);
    assert.ok(completionIndex > persistIndex);
    assert.ok(manifestPersistence.includes('join(publicationArtifactRoot(), "public", "graph", "manifest.json")'));
    assert.ok(manifestPersistence.includes('from("ingestion_artifact_manifests").upsert'));
    assert.ok(manifestPersistence.includes('artifact_key: "public-graph-manifest"'));
    assert.ok(manifestPersistence.includes("sha256"));
  });

  it("persists exact mapped policy inputs and the computed terminal budget in every source receipt", () => {
    const initialReceipt = section(
      "publicationInputs.sourceDelta = {",
      "await writeSourceDeltaReceipt(publicationInputs.sourceDelta, sourceDeltaHistory)"
    );
    const rebasedReceipt = section(
      "rebasedPublicationInputs.sourceDelta = {",
      "await writeSourceDeltaReceipt(rebasedPublicationInputs.sourceDelta, rebasedSourceDeltaHistory)"
    );
    const successfulOutcome = section(
      "successfulRunnerOutcomeCandidate = {",
      "await stopHeartbeatAndDrain()"
    );

    for (const receipt of [initialReceipt, rebasedReceipt]) {
      assert.match(receipt, /mappedExpected:/);
      assert.match(receipt, /mappedNonTerminal:/);
      assert.match(receipt, /terminalFailureBudget:/);
    }
    assert.ok(initialReceipt.includes("terminalFailureBudget: terminalFailureBudget"));
    assert.ok(rebasedReceipt.includes("publicationInputs.sourceDelta.terminalFailureBudget"));
    assert.ok(successfulOutcome.includes("publicationInputs.sourceDelta.terminalFailureBudget"));
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

  it("publishes the merged authenticated evidence ledger with the generated graphs", () => {
    const artifactPaths = section("function repositoryArtifactPaths", "function publicationBranch");
    assert.ok(artifactPaths.includes('"src/lib/social/logged-in-evidence-current.json"'));
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
    const workflowContractScript = packageJson.scripts["test:workflow-contracts"];
    assert.match(contractScript, /^node --test --test-concurrency=1\s+/);
    for (const requiredContract of [
      "tests/autonomous-ingestion-runner-contract.node-test.mjs",
      "tests/autonomous-ingestion-plan.node-test.mjs",
      "tests/runner-failure-sanitizer.node-test.mjs",
      "tests/social-account-remediation.node-test.mjs",
      "tests/scoring-data-root-loader.node-test.mjs",
      "tests/linkedin-public-circuit.node-test.mjs",
      "tests/public-linkedin-no-auth-contract.node-test.mjs",
      "tests/github-api-client.node-test.mjs",
      "tests/ingestion-coverage-receipt.node-test.mjs",
      "tests/public-search-circuit.node-test.mjs",
      "tests/public-search-circuit-integration.node-test.mjs"
    ]) {
      assert.match(contractScript, new RegExp(`(?:^|\\s)${escapeRegExp(requiredContract)}(?:\\s|$)`));
    }
    assert.match(workflowContractScript, /^node --test --test-concurrency=1\s+/);
    for (const requiredWorkflowContract of [
      "tests/autonomous-ingestion-workflow.node-test.mjs",
      "tests/autonomous-ingestion-receipt-policy.node-test.mjs",
      "tests/final-verification-memory.node-test.mjs"
    ]) {
      assert.match(
        workflowContractScript,
        new RegExp(`(?:^|\\s)${escapeRegExp(requiredWorkflowContract)}(?:\\s|$)`)
      );
      assert.doesNotMatch(contractScript, new RegExp(escapeRegExp(requiredWorkflowContract)));
    }
    assert.match(packageJson.scripts["test:collectors"], /npm run test:ingestion-contracts/);
    assert.match(packageJson.scripts["test:collectors"], /npm run test:workflow-contracts/);
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
      '"scripts/run-scoring-diagnostics-v4.mjs"'
    );
    const cohortAuditIndex = publicationBuild.indexOf('"scripts/audit-cohort-coverage.mjs"');

    assert.ok(benchmarkIndex > -1 && diagnosticsIndex > benchmarkIndex);
    assert.ok(cohortAuditIndex > diagnosticsIndex);
    assert.ok(publicationBuild.includes("AUTONOMOUS_PROCESS_BUDGETS.scoringDiagnosticsMs"));
    assert.ok(publicationBuild.includes('"scripts/lib/scoring-diagnostics-ts-loader.mjs"'));
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
    const topicBuildIndex = publicationBuild.indexOf(
      'label: "topic facet regeneration and validation"'
    );
    const rankedBuildIndex = publicationBuild.indexOf(
      'label: "Ranked Posts sidecar regeneration and validation"'
    );
    const scoringIndex = publicationBuild.indexOf('label: "scoring diagnostics regeneration"');
    const manifestIndex = publicationBuild.indexOf('label: "artifact manifest"');
    const validationIndex = publicationBuild.indexOf('label: "artifact validation"');

    assert.ok(
      graphIndex > -1 &&
      timelineIndex > graphIndex &&
      prepareIndex > timelineIndex &&
      topicBuildIndex > prepareIndex &&
      rankedBuildIndex > topicBuildIndex &&
      scoringIndex > rankedBuildIndex &&
      manifestIndex > scoringIndex &&
      validationIndex > manifestIndex
    );
    assert.equal(
      (publicationBuild.match(/"scripts\/build-topic-facets\.mjs"/g) ?? []).length,
      1
    );
    assert.equal(
      (publicationBuild.match(/"scripts\/build-ranked-posts-sidecar\.mjs"/g) ?? []).length,
      1
    );
    assert.equal(
      (publicationBuild.match(/nodeHeapMb: FULL_CORPUS_NODE_HEAP_MB/g) ?? []).length,
      4
    );
    assert.doesNotMatch(publicationBuild, /`--max-old-space-size=\$\{FULL_CORPUS_NODE_HEAP_MB\}`/);
    assert.doesNotMatch(publicationBuild, /node_modules\/next|production build|npm\s+(?:run|ci)/);
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

  it("runs pinned graph preparation before pinned benchmark generation without target app code", () => {
    const publicationBuild = section(
      "async function buildAndValidatePublication",
      "async function synchronizePublicationBase"
    );
    const prepareIndex = publicationBuild.indexOf(
      'label: "pre-publication compact graph runtime preparation"'
    );
    const benchmarkIndex = publicationBuild.indexOf(
      '"scripts/update-daily-benchmarks.mjs"'
    );

    assert.ok(prepareIndex > -1 && benchmarkIndex > prepareIndex);
    assert.ok(publicationBuild.includes('"--pinned-source-in-process"'));
    assert.ok(publicationBuild.includes('`--root=${targetRoot}`'));
    assert.doesNotMatch(publicationBuild, /node_modules\/next|production build/);
  });

  it("rebases, rebuilds, validates, and retries a non-fast-forward publication once", () => {
    const publication = section("async function publishRepositoryArtifacts", "async function stageRepositoryArtifacts");
    const pushRunner = section("async function runPublicationPush", "async function resolveAmbiguousPublicationAfterCancellation");
    assert.ok(pushRunner.includes('`${candidate.publishedCommit}:${candidate.branch}`'));
    assert.ok(publication.includes("allowedExitCodes: [0, 1]"));
    assert.ok(publication.includes('"publication.push_retry"'));
    assert.ok(publication.includes('["-c", "core.hooksPath=/dev/null", "rebase", retryBaseCommit]'));
    assert.ok(publication.includes("rebasedSanitizedPublicSnapshot"));
    assert.ok(publication.includes("const retryDurableImport = await importDurableEvidence"));
    assert.ok(publication.includes("assertDurableAttributionCompleteness(retryDurableImport)"));
    assert.ok(publication.includes(
      "await mergePublicationInputs(rebasedPublicationInputs, { baseRef: publicationBaseCommit })"
    ));
    assert.ok(publication.includes("assertTrustedPublicationBaseCommit(retryBaseCommit"));
    assert.ok(publication.includes("assertNoTrackedSymlinksAtCommit(rebasedHeadCommit"));
    const rebaseIndex = publication.indexOf('["-c", "core.hooksPath=/dev/null", "rebase", retryBaseCommit]');
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
    assert.ok(publication.includes('commandLabel: "retry refreshed artifact push"'));
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

describe("pinned source and publication-base trust boundaries", () => {
  it("accepts only data-only descendants and rejects executable drift and tracked symlinks", async () => {
    const sourceCommit = runGit(repositoryRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
    const dataCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "outputs/ingestion-source-delta-current.json",
      content: '{"fixture":"data-only-replay"}\n'
    });
    const codeCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "scripts/queued-run-malicious.mjs",
      content: 'throw new Error("target code executed");\n'
    });
    const symlinkCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "outputs/ingestion-source-delta-current.json",
      content: "../../scripts/run-autonomous-ingestion.mjs",
      mode: "120000"
    });
    const packagePolicyCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "src/lib/social/package.json",
      content: '{"type":"commonjs"}\n'
    });

    assert.equal(isReplaySafePublicationDataPath("src/lib/social/package.json"), false);
    assert.equal(isProtectedSourcePolicyPath("src/lib/social/package.json"), true);
    assert.equal(
      isReplaySafePublicationDataPath("src/lib/social/logged-in-evidence-current.json"),
      true
    );
    assert.equal(isReplaySafePublicationDataPath("public/timelines/companies/config.json"), false);
    assert.equal(isReplaySafePublicationDataPath("public/timelines/companies/acme-labs.json"), true);

    const accepted = lifecycleFixturePayload(runLifecycleFixture("publication-base-trust", {
      LIFECYCLE_FIXTURE_SOURCE_COMMIT: sourceCommit,
      LIFECYCLE_FIXTURE_BASE_COMMIT: dataCommit,
      LIFECYCLE_FIXTURE_BASE_LABEL: "initial publication base"
    }));
    assert.equal(accepted.accepted, true);

    for (const [candidateCommit, expected] of [
      [codeCommit, /executable, policy, dependency, or non-allowlisted drift.*scripts\/queued-run-malicious\.mjs/],
      [symlinkCommit, /prohibited tracked symlink\/submodule entries/],
      [packagePolicyCommit, /executable, policy, dependency, or non-allowlisted drift.*src\/lib\/social\/package\.json/]
    ]) {
      const rejected = lifecycleFixturePayload(runLifecycleFixture("publication-base-trust", {
        LIFECYCLE_FIXTURE_SOURCE_COMMIT: sourceCommit,
        LIFECYCLE_FIXTURE_BASE_COMMIT: candidateCommit,
        LIFECYCLE_FIXTURE_BASE_LABEL: "publication retry base"
      }));
      assert.equal(rejected.accepted, false);
      assert.match(rejected.error, expected);
    }

    const ensureBoundary = section("async function ensurePublicationWorktree", "async function resolveSourceExecutionCommit");
    const retryBoundary = section("if (firstPush.code !== 0)", "const rebasedSanitizedTargetedSnapshot");
    assert.match(ensureBoundary, /assertTrustedPublicationBaseCommit\(baseCommit/);
    assert.match(retryBoundary, /assertTrustedPublicationBaseCommit\(retryBaseCommit/);
    assert.match(retryBoundary, /rebase", retryBaseCommit/);
  });

  it("rejects source-root mismatch and dirty executable code before privileged work", async () => {
    const codeRoot = await mkdtemp(path.join(os.tmpdir(), "returner-source-trust-code-"));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "returner-source-trust-other-"));
    temporaryRoots.push(codeRoot, otherRoot);
    await mkdir(path.join(codeRoot, "scripts"), { recursive: true });
    await writeFile(path.join(codeRoot, "scripts", "runner.mjs"), "export const clean = true;\n");
    runGit(codeRoot, ["init", "-b", "main"]);
    runGit(codeRoot, ["config", "user.name", "Source Trust Fixture"]);
    runGit(codeRoot, ["config", "user.email", "source-trust@example.com"]);
    runGit(codeRoot, ["add", "scripts/runner.mjs"]);
    runGit(codeRoot, ["commit", "-m", "pinned source"]);
    const expectedSourceSha = runGit(codeRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();

    const clean = lifecycleFixturePayload(runLifecycleFixture("source-boundary", {
      LIFECYCLE_FIXTURE_WORKING_ROOT: codeRoot,
      LIFECYCLE_FIXTURE_CODE_ROOT: codeRoot,
      LIFECYCLE_FIXTURE_EXPECTED_SOURCE_SHA: expectedSourceSha
    }));
    assert.equal(clean.accepted, true);
    assert.equal(clean.sourceCommit, expectedSourceSha);

    const mismatch = lifecycleFixturePayload(runLifecycleFixture("source-boundary", {
      LIFECYCLE_FIXTURE_WORKING_ROOT: otherRoot,
      LIFECYCLE_FIXTURE_CODE_ROOT: codeRoot,
      LIFECYCLE_FIXTURE_EXPECTED_SOURCE_SHA: expectedSourceSha
    }));
    assert.equal(mismatch.accepted, false);
    assert.match(mismatch.error, /Runner source-root mismatch/);

    await writeFile(path.join(codeRoot, "scripts", "runner.mjs"), "export const dirty = true;\n");
    const dirty = lifecycleFixturePayload(runLifecycleFixture("source-boundary", {
      LIFECYCLE_FIXTURE_WORKING_ROOT: codeRoot,
      LIFECYCLE_FIXTURE_CODE_ROOT: codeRoot,
      LIFECYCLE_FIXTURE_EXPECTED_SOURCE_SHA: expectedSourceSha
    }));
    assert.equal(dirty.accepted, false);
    assert.match(dirty.error, /not byte-bound.*scripts\/runner\.mjs/);
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

function normalizePinnedSourcePaths(source) {
  return source.replace(/sourcePath\((?:\s*"[^"]+"\s*,?)+\)/g, (call) => {
    const segments = [...call.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    return `"${segments.join("/")}"`;
  });
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

async function writeExecutable(filePath, source) {
  await writeFile(filePath, source, { encoding: "utf8", mode: 0o755 });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await delayForTest(20);
  }
}

function runLifecycleFixture(fixture, extraEnv = {}, cwd = repositoryRoot) {
  return spawnSync(
    process.execPath,
    [runnerPath, `--idempotency-key=${fixture}-contract`],
    {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "test",
        AUTONOMOUS_INGESTION_LIFECYCLE_TEST_FIXTURE: fixture,
        ...extraEnv
      },
      encoding: "utf8",
      timeout: 5_000
    }
  );
}

function lifecycleFixturePayload(result) {
  assert.equal(result.status, 0, result.stderr);
  const payload = result.stdout.match(/LIFECYCLE_FIXTURE_RESULT=(\{.*\})/)?.[1];
  assert.ok(payload, `Missing lifecycle fixture payload: ${result.stdout}`);
  return JSON.parse(payload);
}

async function createDetachedFixtureCommit({ parent, filePath, content, mode = "100644" }) {
  const indexRoot = await mkdtemp(path.join(os.tmpdir(), "returner-publication-tree-"));
  temporaryRoots.push(indexRoot);
  const gitIndex = path.join(indexRoot, "index");
  const fixtureEnv = {
    ...process.env,
    GIT_INDEX_FILE: gitIndex,
    GIT_AUTHOR_NAME: "Publication Trust Fixture",
    GIT_AUTHOR_EMAIL: "publication-trust@example.com",
    GIT_COMMITTER_NAME: "Publication Trust Fixture",
    GIT_COMMITTER_EMAIL: "publication-trust@example.com"
  };
  runGitWithOptions(repositoryRoot, ["read-tree", parent], { env: fixtureEnv });
  const blob = runGitWithOptions(repositoryRoot, ["hash-object", "-w", "--stdin"], {
    env: fixtureEnv,
    input: content
  }).stdout.trim();
  runGitWithOptions(
    repositoryRoot,
    ["update-index", "--add", "--cacheinfo", mode, blob, filePath],
    { env: fixtureEnv }
  );
  const tree = runGitWithOptions(repositoryRoot, ["write-tree"], { env: fixtureEnv }).stdout.trim();
  return runGitWithOptions(
    repositoryRoot,
    ["commit-tree", tree, "-p", parent, "-m", `fixture ${filePath}`],
    { env: fixtureEnv }
  ).stdout.trim();
}

function delayForTest(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runGit(cwd, args) {
  return runGitWithOptions(cwd, args);
}

function runGitWithOptions(cwd, args, { env = process.env, input } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, input });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`
  );
  return result;
}
