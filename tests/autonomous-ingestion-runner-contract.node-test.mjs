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
  isReplaySafePublicationDataPath,
  isSafeInertPublicationBasePath,
  isValidatedPublicationRetryReuseSafePath
} from "../scripts/lib/autonomous-publication-trust.mjs";
import {
  INGESTION_RECOVERY_DISPATCH_EVENT,
  latestEligibleCentralSlot
} from "../scripts/lib/ingestion-schedule.mjs";
import { isTimelineCoverageMigrationUnavailable } from "../scripts/lib/timeline-migration-availability.mjs";

const repositoryRoot = process.cwd();
const runnerPath = path.join(repositoryRoot, "scripts", "run-autonomous-ingestion.mjs");
const [runnerSource, autonomousPlan, childProcessLedgerHook, timelineCommand, ycCatalogRefresh] = await Promise.all([
  readFile(runnerPath, "utf8"),
  readFile(path.join(repositoryRoot, "scripts", "lib", "autonomous-ingestion-plan.mjs"), "utf8"),
  readFile(path.join(repositoryRoot, "scripts", "lib", "child-process-ledger-hook.cjs"), "utf8"),
  readFile(path.join(repositoryRoot, "scripts", "run-company-timeline-ingestion.mjs"), "utf8"),
  readFile(path.join(repositoryRoot, "scripts", "fetch-yc-spring-2026.mjs"), "utf8")
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
  it("fails open only for the exact absent Timeline coverage table", () => {
    assert.equal(isTimelineCoverageMigrationUnavailable({
      code: "PGRST205",
      message: "Could not find the table 'public.timeline_source_coverage' in the schema cache"
    }), true);
    assert.equal(isTimelineCoverageMigrationUnavailable({
      code: "42P01",
      message: 'relation "public.timeline_source_coverage" does not exist'
    }), true);

    for (const error of [
      { code: "42501", message: "permission denied for table timeline_source_coverage" },
      { code: "PGRST301", message: "JWT expired while reading timeline_source_coverage" },
      { code: "LIFECYCLE_OPERATION_TIMEOUT", message: "timeline_source_coverage timed out" },
      { code: "ETIMEDOUT", message: "timeline_source_coverage request timed out" },
      { code: "PGRST205", message: "Could not find the table 'public.other_optional_table' in the schema cache" },
      { code: "PGRST204", message: "Could not find the 'terminal_at' column of 'timeline_source_coverage'" }
    ]) {
      assert.equal(isTimelineCoverageMigrationUnavailable(error), false, JSON.stringify(error));
    }
  });

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

  it("accepts recovery debt only from an exact trusted host-dispatch binding", () => {
    const slot = latestEligibleCentralSlot(new Date());
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(head.status, 0, head.stderr);
    const expectedHeadSha = head.stdout.trim();
    const env = {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_ACTION: INGESTION_RECOVERY_DISPATCH_EVENT,
      GITHUB_SHA: expectedHeadSha,
      GITHUB_TRIGGER_SHA: expectedHeadSha,
      INGESTION_RECOVERY_EXPECTED_HEAD_SHA: expectedHeadSha
    };
    const args = [
      runnerPath,
      "--plan",
      `--idempotency-key=${slot.slotKey}`,
      "--candidate-trigger=schedule",
      `--scheduled-at=${slot.scheduledAt.toISOString()}`,
      "--recovery-debt=true"
    ];

    const accepted = spawnSync(process.execPath, args, {
      cwd: repositoryRoot,
      env,
      encoding: "utf8"
    });
    assert.equal(accepted.status, 0, accepted.stderr);

    const mismatchedHead = spawnSync(process.execPath, args, {
      cwd: repositoryRoot,
      env: {
        ...env,
        INGESTION_RECOVERY_EXPECTED_HEAD_SHA: "b".repeat(40)
      },
      encoding: "utf8"
    });
    assert.equal(mismatchedHead.status, 1, mismatchedHead.stderr);
    assert.match(
      mismatchedHead.stderr,
      /Recovery debt bypass requires a resolver-authorized GitHub schedule wakeup/
    );
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

  it("retries a thrown Supabase lifecycle timeout and cautiously restores task page size", () => {
    const payload = lifecycleFixturePayload(runLifecycleFixture(
      "ingestion-task-pagination",
      { LIFECYCLE_FIXTURE_PAGINATION_MODE: "lifecycle-timeout" },
      repositoryRoot,
      8_000
    ));

    assert.deepEqual(payload.ids, ["task-001", "task-002", "task-003", "task-004", "task-005"]);
    assert.deepEqual(payload.requestedPageSizes, [1_000, 500, 500, 1_000, 1_000, 1_000, 1_000]);
    assert.deepEqual(payload.requestedCursors, [
      null,
      null,
      "task-001",
      "task-002",
      "task-003",
      "task-004",
      "task-005"
    ]);
    assert.equal(payload.queryCalls, 7);
    assert.deepEqual(payload.retryClassification, {
      abortError: true,
      transportTimeout: true,
      authorization: false,
      runnerBudget: false
    });
  });

  it("continues keyset pagination across server-capped short pages until an empty page", () => {
    const payload = lifecycleFixturePayload(runLifecycleFixture(
      "ingestion-task-pagination",
      { LIFECYCLE_FIXTURE_PAGINATION_MODE: "row-cap" }
    ));

    assert.deepEqual(payload.ids, ["task-001", "task-002", "task-003", "task-004", "task-005"]);
    assert.deepEqual(payload.requestedPageSizes, [1_000, 1_000, 1_000, 1_000]);
    assert.deepEqual(payload.requestedCursors, [null, "task-002", "task-004", "task-005"]);
    assert.equal(payload.queryCalls, 4);
  });

  it("aborts and drains an in-flight heartbeat before finalization", () => {
    const result = runLifecycleFixture("heartbeat-drain");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"abortObserved":true/);
    assert.match(result.stdout, /"drained":true/);
  });

  it("retries a transient heartbeat transport failure with the exact same lease tokens", () => {
    const payload = lifecycleFixturePayload(runLifecycleFixture("heartbeat-transient-recovery"));

    assert.equal(payload.operationError, null);
    assert.equal(payload.leaseFailure, null);
    assert.deepEqual(payload.retryDelays, [1_000]);
    assert.equal(payload.runHeartbeats.length, 2);
    assert.equal(payload.lockHeartbeats.length, 2);
    for (const attempt of payload.runHeartbeats) {
      assert.equal(attempt.id, "heartbeat-retry-fixture");
      assert.equal(attempt.leaseToken, payload.runLeaseToken);
      assert.ok(Date.parse(attempt.heartbeatAt) > 0);
      assert.ok(Date.parse(attempt.leaseExpiresAt) > Date.parse(attempt.heartbeatAt));
    }
    for (const attempt of payload.lockHeartbeats) {
      assert.equal(attempt.name, "renew_ingestion_runtime_lock");
      assert.equal(attempt.lockKey, "autonomous-ingestion");
      assert.equal(attempt.ownerId, "heartbeat-retry-fixture-worker");
      assert.equal(attempt.leaseToken, payload.lockLeaseToken);
      assert.equal(attempt.leaseDuration, "20 minutes");
    }
  });

  it("retries a resolved Supabase heartbeat error wrapping TypeError: fetch failed", () => {
    const payload = lifecycleFixturePayload(
      runLifecycleFixture("heartbeat-resolved-transport-recovery")
    );

    assert.equal(payload.operationError, null);
    assert.equal(payload.leaseFailure, null);
    assert.deepEqual(payload.retryDelays, [1_000]);
    assert.equal(payload.runHeartbeats.length, 2);
    assert.equal(payload.lockHeartbeats.length, 1);
    for (const attempt of payload.runHeartbeats) {
      assert.equal(attempt.id, "heartbeat-retry-fixture");
      assert.equal(attempt.leaseToken, payload.runLeaseToken);
    }
    assert.equal(payload.lockHeartbeats[0].leaseToken, payload.lockLeaseToken);
  });

  it("keeps retrying heartbeat transport failures beyond the former four-attempt ceiling", () => {
    const payload = lifecycleFixturePayload(runLifecycleFixture("heartbeat-long-transient-recovery"));

    assert.deepEqual(payload.retryDelays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    assert.equal(payload.runHeartbeats.length, 9);
    assert.equal(payload.lockHeartbeats.length, 1);
    assert.equal(payload.operationError, null);
    assert.equal(payload.leaseFailure, null);
    assert.equal(payload.finalRunLeaseExpiresAt, payload.finalLockLeaseExpiresAt);
    for (const attempt of payload.runHeartbeats) {
      assert.equal(attempt.leaseToken, payload.runLeaseToken);
    }
  });

  it("fails closed only when transient retries consume the safe lease-renewal window", () => {
    const payload = lifecycleFixturePayload(runLifecycleFixture("heartbeat-transient-exhaustion"));

    assert.deepEqual(payload.retryDelays, [1_000, 2_000, 4_000, 3_000]);
    assert.equal(payload.runHeartbeats.length, 5);
    assert.equal(payload.lockHeartbeats.length, 0);
    assert.match(payload.operationError, /safe lease-renewal window/);
    assert.match(payload.leaseFailure, /Ingestion lease heartbeat failed; publication aborted: Transient heartbeat/);
    for (const attempt of payload.runHeartbeats) {
      assert.equal(attempt.leaseToken, payload.runLeaseToken);
    }
  });

  it("fails closed immediately on lock loss and semantic heartbeat errors", () => {
    const lockLoss = lifecycleFixturePayload(runLifecycleFixture("heartbeat-lock-loss"));
    assert.deepEqual(lockLoss.retryDelays, []);
    assert.equal(lockLoss.runHeartbeats.length, 1);
    assert.equal(lockLoss.lockHeartbeats.length, 1);
    assert.match(lockLoss.operationError, /runtime lock expired or was taken/);
    assert.match(lockLoss.leaseFailure, /Ingestion lease heartbeat failed; publication aborted/);

    const semanticError = lifecycleFixturePayload(runLifecycleFixture("heartbeat-semantic-error"));
    assert.deepEqual(semanticError.retryDelays, []);
    assert.equal(semanticError.runHeartbeats.length, 1);
    assert.equal(semanticError.lockHeartbeats.length, 0);
    assert.match(semanticError.operationError, /permission denied for ingestion_runs/);
    assert.match(semanticError.leaseFailure, /Ingestion lease heartbeat failed; publication aborted/);
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

  it("proves candidate parent identity and dynamically transplants a deletion record", async () => {
    const publicationParent = await mkdtemp(path.join(os.tmpdir(), "returner-publication-proof-"));
    const publicationRoot = path.join(publicationParent, "checkout");
    temporaryRoots.push(publicationParent);
    const sourceCommit = runGit(repositoryRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
    const artifactPath = "outputs/ingestion-source-delta-current.json";
    const baseCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: artifactPath,
      content: '{"fixture":"candidate-base"}\n'
    });
    const candidateCommit = await createDetachedFixtureDeletionCommit({
      parent: baseCommit,
      filePath: artifactPath
    });
    runGit(repositoryRoot, ["worktree", "add", "--detach", publicationRoot, baseCommit]);
    try {
      const result = lifecycleFixturePayload(runLifecycleFixture("publication-candidate-proof", {
        LIFECYCLE_FIXTURE_PUBLICATION_ROOT: publicationRoot,
        LIFECYCLE_FIXTURE_PUBLICATION_PARENT: publicationParent,
        LIFECYCLE_FIXTURE_BASE_COMMIT: baseCommit,
        LIFECYCLE_FIXTURE_CANDIDATE_COMMIT: candidateCommit
      }));
      assert.equal(result.proof.candidateCommit, candidateCommit);
      assert.equal(result.proof.publicationBaseCommit, baseCommit);
      assert.equal(result.proof.parentCommit, baseCommit);
      assert.deepEqual(result.proof.changedPaths, [artifactPath]);
      assert.deepEqual(result.candidateDelta, [{ status: "D", path: artifactPath }]);
      assert.deepEqual(result.stagedDelta, [{ status: "D", path: artifactPath }]);
      assert.equal(result.deletedFromIndex, true);
      assert.equal(result.deletedFromWorktree, true);
    } finally {
      runGit(repositoryRoot, ["worktree", "remove", "--force", publicationRoot]);
      runGit(repositoryRoot, ["worktree", "prune"]);
    }
  });

  it("rebuilds exact direct-child candidates across a second concurrent main advance", async () => {
    const fixture = await runPublicationRaceFixture({
      mode: "second-concurrent",
      concurrentAdvanceCount: 2
    });

    assert.equal(fixture.payload.attempts, 3);
    assert.equal(fixture.payload.pushCalls, 3);
    assert.equal(fixture.payload.fetchCalls, 2);
    assert.equal(fixture.payload.rebuildCalls, 2);
    assert.equal(fixture.payload.concurrentMainRetries, 2);
    assert.equal(fixture.payload.adoptedAfterAmbiguousPush, false);
    assert.deepEqual(
      fixture.payload.candidateParents,
      [fixture.baseCommit, ...fixture.concurrentCommits]
    );
    assert.equal(fixture.payload.finalBase, fixture.concurrentCommits[1]);
    assert.equal(fixture.payload.finalCandidate, fixture.payload.remoteTipCommit);
    assert.equal(new Set(fixture.payload.candidateCommits).size, 3);
    assert.match(fixture.payload.receiptSha256, /^[0-9a-f]{64}$/);
  });

  it("adopts an already-landed initial candidate after reconciliation response loss", async () => {
    const fixture = await runPublicationRaceFixture({
      mode: "landed-reconciliation-lost",
      concurrentAdvanceCount: 0
    });

    assert.equal(fixture.payload.attempts, 1);
    assert.equal(fixture.payload.pushCalls, 1);
    assert.equal(fixture.payload.fetchCalls, 0);
    assert.equal(fixture.payload.rebuildCalls, 0);
    assert.equal(fixture.payload.concurrentMainRetries, 0);
    assert.equal(fixture.payload.adoptedAfterAmbiguousPush, true);
    assert.deepEqual(fixture.payload.candidateParents, [fixture.baseCommit]);
    assert.equal(fixture.payload.finalBase, fixture.baseCommit);
    assert.equal(fixture.payload.finalCandidate, fixture.payload.remoteTipCommit);
    assert.equal(fixture.payload.candidateCommits.length, 1);
    assert.match(fixture.payload.receiptSha256, /^[0-9a-f]{64}$/);
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

  it("allows only the newest resolver-authorized scheduled slot and keeps manual replay separate", () => {
    const scheduledAt = "2026-08-09T23:00:00.000Z";
    const common = {
      LIFECYCLE_FIXTURE_CANDIDATE_TRIGGER: "schedule",
      LIFECYCLE_FIXTURE_SCHEDULED_AT: scheduledAt,
      LIFECYCLE_FIXTURE_SLOT_KEY: "central-2026-08-09-1800",
      LIFECYCLE_FIXTURE_RECOVERY_DEBT: "true",
      LIFECYCLE_FIXTURE_PUSH_LABEL: "first publication push"
    };
    const latest = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      ...common,
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse("2026-08-10T10:59:59.000Z"))
    }));
    const superseded = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      ...common,
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse("2026-08-10T11:00:00.000Z"))
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
    const missingAuthorization = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      LIFECYCLE_FIXTURE_CANDIDATE_TRIGGER: "schedule",
      LIFECYCLE_FIXTURE_SCHEDULED_AT: scheduledAt,
      LIFECYCLE_FIXTURE_SLOT_KEY: "central-2026-08-09-1800",
      LIFECYCLE_FIXTURE_RECOVERY_DEBT: "false",
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse(scheduledAt))
    }));
    const manualRecovery = lifecycleFixturePayload(runLifecycleFixture("candidate-metadata", {
      LIFECYCLE_FIXTURE_CANDIDATE_TRIGGER: "manual-replay",
      LIFECYCLE_FIXTURE_SLOT_KEY: "manual-replay-fixture",
      LIFECYCLE_FIXTURE_RECOVERY_DEBT: "true",
      LIFECYCLE_FIXTURE_NOW_MS: String(Date.parse(scheduledAt) + (36 * 60 * 60_000))
    }));

    assert.equal(latest.accepted, true);
    assert.equal(superseded.accepted, false);
    assert.match(superseded.error, /was superseded by newest eligible Central slot/);
    assert.equal(wrongSlot.accepted, false);
    assert.match(wrongSlot.error, /slot key mismatch/);
    assert.equal(manual.accepted, true);
    assert.equal(manual.candidateMetadata.scheduledAt, null);
    assert.equal(manual.candidateMetadata.recoveryDebt, false);
    assert.equal(missingAuthorization.accepted, false);
    assert.match(missingAuthorization.error, /publication-watermark retry metadata/);
    assert.equal(manualRecovery.accepted, false);
    assert.match(manualRecovery.error, /must not claim resolver recovery debt/);
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
  it("binds scheduled publication to resolver authorization and newest-slot freshness", () => {
    const eventAuthorization = section(
      "function resolverAuthorizedRecoveryDebtEvent",
      "function validateCandidateMetadata"
    );
    const candidateValidation = section(
      "function validateCandidateMetadata",
      "function publicationCandidateReceiptFields"
    );
    const freshness = section(
      "function assertCandidateFreshForPublication",
      "function parseArgs"
    );

    assert.ok(runner.includes("args.recoveryDebt &&"));
    assert.ok(runner.includes("!resolverAuthorizedRecoveryDebtEvent(process.env)"));
    assert.ok(eventAuthorization.includes('environment.GITHUB_ACTIONS !== "true"'));
    assert.ok(eventAuthorization.includes('environment.GITHUB_EVENT_NAME === "schedule"'));
    assert.ok(eventAuthorization.includes("scheduleForTrustedEvent"));
    assert.ok(eventAuthorization.includes("INGESTION_RECOVERY_EXPECTED_HEAD_SHA"));
    assert.ok(eventAuthorization.includes("GITHUB_TRIGGER_SHA ?? environment.GITHUB_SHA"));
    assert.ok(eventAuthorization.includes("=== INGESTION_RECOVERY_CRON"));
    assert.ok(runner.includes('recoveryDebt: booleanValue("--recovery-debt")'));
    assert.ok(candidateValidation.includes("recoveryDebt = false"));
    assert.ok(candidateValidation.includes("publication-watermark retry metadata"));
    assert.ok(freshness.includes("latestEligibleCentralSlot"));
    assert.ok(freshness.includes("was superseded by newest eligible"));
    assert.ok(!freshness.includes("freshnessWindowMs"));
  });

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
    const enqueue = section("async function enqueueTasks", "async function prepareBatchDiscoveryState");
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
    assert.ok(enqueue.includes("{ timeoutMs: SUPABASE_BULK_OPERATION_TIMEOUT_MS }"));
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
    assert.ok(runner.includes(
      'authenticated_social: [\n    "HOME",\n    "OPENCLI_BIN",\n    "OPENCLI_CONFIG_DIR",\n    "OPENCLI_HOME"'
    ));
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
      section(
        "const timelineBackfillEnv = timelineUsesDatabase",
        "await runCommand(process.execPath, [\"scripts/validate-timeline-artifacts.mjs\"]",
        publicationBuild
      ),
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
      "const timelineBackfillEnv = timelineUsesDatabase",
      "latestTimelineBuildReceipt = {",
      publicationBuild
    );

    assert.match(
      timelineBackfill,
      /timelineUsesDatabase\s*\?\s*{\s*TIMELINE_REQUIRE_DATABASE:\s*"true",[\s\S]*?SCORING_DATA_ROOT:\s*targetRoot/
    );
    assert.match(
      timelineBackfill,
      /:\s*{\s*TIMELINE_REQUIRE_DATABASE:\s*"false",[\s\S]*?SCORING_DATA_ROOT:\s*targetRoot/
    );
    assert.ok(timelineBackfill.includes('"scripts/backfill-company-timelines.mjs"'));
    assert.ok(timelineBackfill.includes("--database-snapshot="));
    assert.ok(timelineBackfill.includes("env: timelineBackfillEnv"));
  });

  it("keeps the optional admin lane independent and file-backfills when its exact coverage table is absent", () => {
    const discovery = section(
      "async function runTimelineDiscoveryBeforeBackfill",
      "async function buildCanonicalTimelineIngestionInventory"
    );
    const publicationBuild = section(
      "async function buildAndValidatePublication",
      "async function synchronizePublicationBase"
    );

    assert.doesNotMatch(timelineCommand, /adminTaskDrain\.status === "migration_unavailable"\s*\?/);
    assert.match(timelineCommand, /const receipt = await runTimelineDiscoveryIngestion/);
    const coveragePreflight = timelineCommand.indexOf("const coveragePreflight");
    const adminDrain = timelineCommand.indexOf("const adminTaskDrain", coveragePreflight);
    assert.ok(coveragePreflight >= 0 && adminDrain > coveragePreflight);
    assert.match(timelineCommand, /timeline_source_coverage_unavailable/);
    assert.match(timelineCommand, /enqueuedTasks:\s*0/);
    assert.match(timelineCommand, /claimedTasks:\s*0/);
    assert.match(discovery, /receipt\.adminTaskDrain\?\.status === "migration_unavailable"/);
    assert.match(discovery, /timeline\.discovery\.skipped/);
    assert.match(discovery, /isTimelineCoverageMigrationUnavailable\(migrationError\)/);
    assert.match(discovery, /\.select\("company_id"\)\s*\.limit\(1\)/);
    assert.match(publicationBuild, /const coverageMigrationUnavailable/);
    assert.match(publicationBuild, /const timelineUsesDatabase = durableStorageConfigured && !coverageMigrationUnavailable/);
    assert.match(publicationBuild, /timeline\.artifacts\.file_backed_fallback/);
    assert.match(publicationBuild, /TIMELINE_REQUIRE_DATABASE:\s*"false"/);
    assert.doesNotMatch(runner, /preserveLastGoodTimelineArtifacts|timeline\.artifacts\.preserved/);
    assert.match(publicationBuild, /status:\s*"rebuilt"/);
    assert.match(publicationBuild, /if \(timelineUsesDatabase\)[\s\S]*?export durable Company Timeline database snapshot/);
    assert.match(publicationBuild, /mode:\s*timelineUsesDatabase \? "database_backed" : "file_backed"/);
    assert.match(publicationBuild, /label: "company timeline backfill"/);
    const discoveryIndex = publicationBuild.indexOf("await runTimelineDiscoveryBeforeBackfill");
    const backfillIndex = publicationBuild.indexOf('label: "company timeline backfill"');
    const validationIndex = publicationBuild.indexOf('"scripts/validate-timeline-artifacts.mjs"');
    assert.ok(discoveryIndex >= 0 && backfillIndex > discoveryIndex && validationIndex > backfillIndex);
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

  it("verifies publication outcomes remotely and resolves replay from the exact historical publication commit", async () => {
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
      "async function reconcilePublicationPushCandidate"
    );

    assert.match(
      publication,
      /const publicationStatus = publicationTreeChanged \? "published" : "no_changes";[\s\S]*status:\s*publicationStatus,[\s\S]*publishedCommit/
    );
    assert.equal(publication.match(/verifyPublicationCommitOnRemote/g)?.length, 2);
    assert.ok(publication.includes("pushPublicationCandidateWithConcurrentMainRecovery"));
    assert.ok(publication.includes("runPublicationPush(pushCandidate"));
    assert.ok(publication.includes("adoptReachablePublicationCandidate"));
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
    assert.equal(
      (verifier.match(/deadlineAt: remoteVerificationDeadlineAt/g) ?? []).length,
      2,
      "fetch and ancestry must consume one absolute remote-verification deadline"
    );

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "returner-remote-budget-"));
    temporaryRoots.push(fixtureRoot);
    const markerPath = path.join(fixtureRoot, "git-calls.jsonl");
    await writeFile(markerPath, "", "utf8");
    const bin = await createTimedFakeGit({
      root: fixtureRoot,
      markerPath,
      fetchDelayMs: 180,
      ancestryDelayMs: 450
    });
    const bounded = lifecycleFixturePayload(runLifecycleFixture(
      "remote-verification-budget",
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        LIFECYCLE_FIXTURE_REMOTE_TIMEOUT_MS: "500"
      },
      repositoryRoot,
      3_000
    ));
    const calls = (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.ok(
      calls.length === 1 || calls.length === 2,
      `remote verifier did not execute the bounded fake Git path: ${JSON.stringify(bounded)}`
    );
    if (calls.length === 2) {
      assert.equal(bounded.failure.timedOut, true);
      assert.ok(
        bounded.failure.commandTimeoutMs > 0 && bounded.failure.commandTimeoutMs < 400,
        `ancestry received stale timeout ${bounded.failure.commandTimeoutMs}`
      );
    } else {
      assert.ok(
        /did not start before its phase deadline/i.test(bounded.failure.message) ||
        (
          bounded.failure.timedOut === true &&
          bounded.failure.commandTimeoutMs > 0 &&
          bounded.failure.commandTimeoutMs <= bounded.timeoutMs
        ),
        `single-command exhaustion did not preserve the shared bound: ${bounded.failure.message}`
      );
    }
    assert.ok(
      // Child process-group drain is intentionally outside the operation
      // timer, but the second command must not receive another full budget.
      bounded.elapsedMs <= bounded.timeoutMs + 750,
      `remote verification exceeded its shared bound: ${bounded.elapsedMs}ms`
    );
  });

  it("classifies each provenance candidate against its exact publication base", () => {
    const publication = section(
      "async function publishRepositoryArtifacts",
      "async function stageRepositoryArtifacts"
    );
    const comparator = section(
      "async function classifyPublicationSemantics",
      "async function publicationCommitProvenance"
    );
    const candidateClassifier = section(
      "async function verifyAndClassifyPublicationCandidate",
      "async function verifyPublicationCandidateIdentity"
    );

    assert.ok(runner.includes('"./lib/publication-semantic-diff.mjs"'));
    assert.ok(comparator.includes("rootDir: publicationRoot"));
    assert.ok(comparator.includes("baseRef,"));
    assert.ok(comparator.includes("targetRef,"));
    assert.ok(comparator.includes("ignoredPaths: PUBLICATION_SEMANTIC_IGNORED_PATHS"));
    assert.ok(runner.includes('"outputs/ingestion-source-delta-current.json"'));
    assert.ok(runner.includes('"outputs/ingestion-source-delta-history.json"'));
    assert.match(candidateClassifier, /baseRef: candidate\.publicationBaseCommit/);
    assert.match(candidateClassifier, /targetRef: candidate\.publishedCommit/);
    assert.match(publication, /publicationTreeChanged = await verifyAndClassifyPublicationCandidate\(candidate\)/);
    assert.doesNotMatch(publication, /publicationTreeChanged\s*=\s*publicationTreeChanged\s*\|\|/);
    assert.doesNotMatch(publication, /git", \["diff", "--cached", "--quiet"\]/);
    assert.equal(
      (publication.match(/allowUnchangedTree: true/g) ?? []).length,
      3,
      "initial, validated-reuse, and full-rebuild provenance commits must permit an unchanged semantic tree"
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

    const recovery = publication.indexOf("await pushPublicationCandidateWithConcurrentMainRecovery");
    const verification = publication.indexOf("await verifyPublicationCommitOnRemote(publishedCommit");
    const completionEvent = publication.indexOf(
      'publicationTreeChanged ? "publication.completed" : "publication.no_changes"'
    );
    assert.ok(recovery > -1 && verification > recovery && completionEvent > verification);
    const pushAttempt = section(
      "async function pushPublicationCandidateAttempt",
      "async function fetchExactPublicationRetryBase"
    );
    assert.ok(pushAttempt.includes('"push refreshed artifacts"'));
    assert.ok(pushAttempt.includes("`retry refreshed artifact push ${attempt}`"));
    assert.ok(pushAttempt.includes("runPublicationPush(pushCandidate"));
    const pushRunner = section("async function runPublicationPush", "async function resolveAmbiguousPublicationAfterCancellation");
    assert.ok(pushRunner.includes("latestPublishedCommit = candidate.publishedCommit"));
    assert.ok(pushRunner.includes("reconcilePublicationPushCandidate(candidate"));
  });

  it("verifies an ambiguous interrupted push before writing its cancellation receipt", async () => {
    const publication = section(
      "async function publishRepositoryArtifacts",
      "async function stageRepositoryArtifacts"
    );
    const cleanup = section("} finally {", "function installTerminationSignalHandlers");

    assert.equal((publication.match(/const pushCandidate = \{/g) ?? []).length, 1);
    assert.ok(publication.includes('"first publication push"'));
    assert.ok(publication.includes("`publication retry push ${attempt}`"));
    assert.ok(runner.includes("reconcilePublicationPushCandidate(candidate"));
    assert.ok(runner.includes('"failure or response loss"'));
    assert.ok(runner.includes("allowDuringCancellation: true"));
    assert.ok(runner.includes("CANCELLATION_REMOTE_VERIFY_TIMEOUT_MS"));
    assert.ok(cleanup.indexOf("await resolveAmbiguousPublicationAfterCancellation()") <
      cleanup.indexOf("pendingRunnerOutcome = canceledRunnerOutcome(terminationSignal)"));
    const reconciliation = section(
      "async function reconcilePublicationPushCandidate",
      "async function runPublicationPush"
    );
    const marker = section(
      "function markPublicationCandidatePublished",
      "function isConcurrentMainPushRejection"
    );
    assert.doesNotMatch(reconciliation, /publicationPushCandidate\s*=\s*null/);
    assert.doesNotMatch(marker, /publicationPushCandidate\s*=\s*null/);
    assert.ok(runner.includes("void beginPublicationCancellationResolution()"));
    assert.ok(runner.includes("await finalizePublicationSignalAdoptionWindow()"));

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "returner-cancellation-recheck-"));
    temporaryRoots.push(fixtureRoot);
    const markerPath = path.join(fixtureRoot, "git-calls.jsonl");
    await writeFile(markerPath, "", "utf8");
    const bin = await createTimedFakeGit({ root: fixtureRoot, markerPath });
    const result = lifecycleFixturePayload(runLifecycleFixture(
      "publication-cancellation-recheck",
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        LIFECYCLE_FIXTURE_MARKER: markerPath
      },
      repositoryRoot,
      3_000
    ));
    assert.equal(result.reconciledBeforeSignal, true);
    assert.equal(result.retainedBeforeSignal, true);
    assert.equal(result.retainedAfterCancellationRecheck, true);
    assert.equal(result.fetchCalls, 2, "cancellation must perform one fresh exact fetch");
    assert.equal(result.ancestryCalls, 2, "cancellation must perform one fresh exact ancestry check");
    assert.equal(result.latestPublishedCommit, "b".repeat(40));
    assert.equal(result.candidateClearedAfterFinalization, true);
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

  it("hydrates historical durable catalog identities before attribution reconciliation", () => {
    const historicalCatalog = section(
      "async function readHistoricalAttributionCatalogMaps",
      "function assertDurableAttributionCompleteness"
    );
    assert.ok(historicalCatalog.includes('from("companies")'));
    assert.ok(historicalCatalog.includes('from("company_founders")'));
    assert.ok(historicalCatalog.includes('from("founders")'));
    assert.ok(historicalCatalog.includes("companyByBatchEntityId"));
    assert.ok(historicalCatalog.includes("founderByBatchEntityId"));
    assert.ok(historicalCatalog.includes("runHistoricalAttributionRead"));
    assert.ok(historicalCatalog.includes("readHistoricalAttributionRows"));
    assert.ok(historicalCatalog.includes("HISTORICAL_ATTRIBUTION_READ_BATCH_SIZE"));
    assert.ok(historicalCatalog.includes("chunk ${index + 1}/${valueChunks.length}"));
    assert.ok(historicalCatalog.includes("function runHistoricalAttributionRead(label, createOperation)"));
    assert.ok(historicalCatalog.includes("result?.error"));
    assert.ok(historicalCatalog.includes("fetch failed"));
    assert.ok(historicalCatalog.includes("retrying in"));
    const retryConstant = runner.indexOf("const HISTORICAL_ATTRIBUTION_READ_ATTEMPTS = 3");
    const durableImportStart = runner.indexOf("async function importDurableEvidence");
    assert.ok(retryConstant > -1 && retryConstant < durableImportStart);
    const durableImport = section(
      "async function importDurableEvidence",
      "async function readHistoricalAttributionCatalogMaps"
    );
    assert.ok(durableImport.includes("readHistoricalAttributionCatalogMaps(catalogState)"));
    assert.doesNotMatch(durableImport, /attributionReconciliationLedger\.length\s*>\s*0/);
  });

  it("isolates work directories with a hash of the exact idempotency key", () => {
    const safePath = section("function safePathSegment", "function chunks");
    assert.ok(safePath.includes('createHash("sha256")'));
    assert.ok(safePath.includes("update(source)"));
  });

  it("runs authenticated social collection only through the dedicated bounded lane", () => {
    const collectors = section("async function runAuthenticatedCollectors", "async function runAuthenticatedCollectorCommand");
    assert.match(collectors, /fetch-logged-in-social-traction/);
    assert.match(collectors, /"--platforms=instagram"/);
    assert.match(collectors, /"--platforms=linkedin"/);
    assert.match(collectors, /"--allow-linkedin"/);
    assert.match(collectors, /"--workers=1"/);
    assert.match(collectors, /historicalReplay \? 2 : 1/);
    assert.match(collectors, /linkedin-max-targets/);
    assert.match(collectors, /"--delay-ms=30000"/);
    assert.ok(runner.includes('env: { HOME: process.env.HOME }'));
  });

  it("drives LinkedIn historical replay through a sequential seven-chunk state machine", () => {
    const replay = linkedInReplayRuntime();

    let state = replay.createLinkedInReplayState(["S26"]);
    const remainingPlan = [35, 30, 25, 20, 15, 10, 5];
    for (const [index, runnableTargetCount] of remainingPlan.entries()) {
      state = replay.reduceLinkedInReplayState(state, {
        type: "plan",
        batchSlug: "S26",
        runnableTargetCount
      });
      const admission = replay.decideLinkedInReplayAdmission({
        runnableTargetCount,
        admittedChunks: state.chunksAdmitted,
        remainingMs: 25 * 60_000,
        reserveMs: 15 * 60_000,
        drainHeadroomMs: 5 * 60_000,
        maxChunks: 7
      });
      assert.equal(admission.action, "admit-chunk");
      assert.equal(admission.targetCap, 5);
      assert.equal(admission.chunkNumber, index + 1);
      state = replay.reduceLinkedInReplayState(state, {
        type: "chunk_admitted",
        batchSlug: "S26"
      });
      state = replay.reduceLinkedInReplayState(state, {
        type: "chunk_completed",
        batchSlug: "S26"
      });
    }
    assert.equal(state.chunksAdmitted, 7);
    assert.equal(state.chunksAttempted, 7);
    assert.equal(state.chunksCompleted, 7);
    assert.equal(state.targetCapacityAdmitted, 35);
    assert.equal(
      replay.decideLinkedInReplayAdmission({
        runnableTargetCount: 5,
        admittedChunks: 7,
        remainingMs: 25 * 60_000,
        reserveMs: 15 * 60_000,
        drainHeadroomMs: 5 * 60_000,
        maxChunks: 7
      }).action,
      "chunk-budget-exhausted"
    );
    assert.equal(
      replay.decideLinkedInReplayAdmission({
        runnableTargetCount: 5,
        admittedChunks: 0,
        remainingMs: 20 * 60_000 - 1,
        reserveMs: 15 * 60_000,
        drainHeadroomMs: 5 * 60_000,
        maxChunks: 7
      }).action,
      "deadline-exhausted"
    );
    assert.equal(
      replay.decideLinkedInReplayAdmission({
        runnableTargetCount: 0,
        admittedChunks: 0,
        remainingMs: 0,
        reserveMs: 15 * 60_000,
        drainHeadroomMs: 5 * 60_000,
        maxChunks: 7
      }).action,
      "advance-batch"
    );
    const result = replay.createLinkedInReplayResult(state);
    assert.equal(result.maxChunks, 7);
    assert.equal(result.targetCapPerChunk, 5);
    assert.equal(result.remainingTargetCount, null);
    assert.equal(result.remainingTargetCountKnown, false);
    assert.deepEqual(result.unknownRemainingBatches, ["S26"]);
  });

  it("propagates LinkedIn safety and infrastructure stops with unknown later-batch counts", () => {
    const replay = linkedInReplayRuntime();
    for (const type of ["safety_stop", "infrastructure_failure"]) {
      let state = replay.reduceLinkedInReplayState(
        replay.createLinkedInReplayState(["S2026", "S26", "A16ZSR006"]),
        { type: "plan", batchSlug: "S2026", runnableTargetCount: 9 }
      );
      state = replay.reduceLinkedInReplayState(state, {
        type: "chunk_admitted",
        batchSlug: "S2026"
      });
      state = replay.reduceLinkedInReplayState(
        state,
        { type, batchSlug: "S26", error: type }
      );
      assert.equal(state.halted, true);
      assert.equal(state.chunksAdmitted, 1);
      assert.equal(state.chunksAttempted, 1);
      assert.equal(state.chunksCompleted, 0);
      assert.equal(state.safetyStopped, type === "safety_stop");
      assert.equal(state.infrastructureStopped, type === "infrastructure_failure");
      const result = replay.createLinkedInReplayResult(state);
      assert.equal(result.remainingTargetCount, null);
      assert.equal(result.remainingTargetCountKnown, false);
      assert.deepEqual(
        result.unknownRemainingBatches,
        ["S2026", "S26", "A16ZSR006"]
      );
    }

    const collectors = section("async function runAuthenticatedCollectors", "async function runAuthenticatedCollectorCommand");
    assert.match(collectors, /LINKEDIN_CHILD_SAFETY_STOP|safety_stopped/);
    assert.match(collectors, /if \(replayState\.halted\)/);
    assert.doesNotMatch(collectors, /if \(replayState\.halted\) break;/);
  });

  it("binds every admitted LinkedIn chunk to the pre-reserve absolute deadline at runtime", async () => {
    const nowMs = 1_800_000_000_000;
    const collectionDeadlineAt = nowMs + 60 * 60_000;
    const expectedChildDeadlineAt = collectionDeadlineAt - 20 * 60_000;
    const planDeadlines = [];
    const chunkDeadlines = [];
    const plans = [5, 0];
    const replay = linkedInReplayRuntime({
      nowMs,
      collectionDeadlineAt,
      plan: async (_batchSlug, _args, options) => {
        planDeadlines.push(options.deadlineAt);
        return { status: "completed", runnableTargetCount: plans.shift(), plan: {} };
      },
      collect: async (_batchSlug, _platform, _args, options) => {
        chunkDeadlines.push(options.deadlineAt);
        return { status: "completed", exitCode: 0 };
      }
    });

    const result = await replay.runAuthenticatedLinkedInReplayBatch({
      batch: { slug: "S26" },
      commonArgs: ["collector", "--checkpoint-path=/durable/checkpoint.json"],
      replayState: replay.createLinkedInReplayState(["S26"])
    });

    assert.deepEqual(planDeadlines, [expectedChildDeadlineAt, expectedChildDeadlineAt]);
    assert.deepEqual(chunkDeadlines, [expectedChildDeadlineAt]);
    assert.equal(result.replayState.chunksAdmitted, 1);
    assert.equal(result.replayState.chunksAttempted, 1);
    assert.equal(result.replayState.chunksCompleted, 1);
    assert.equal(result.replayState.remainingByBatch.S26, 0);
  });

  it("counts safety and infrastructure failures as admitted attempts before spawn", async () => {
    for (const childResult of [
      { status: "safety_stopped", exitCode: 86, error: "account safety" },
      { status: "failed", exitCode: 1, error: "infrastructure" }
    ]) {
      const plans = [5, 4];
      const replay = linkedInReplayRuntime({
        plan: async () => ({
          status: "completed",
          runnableTargetCount: plans.shift(),
          plan: {}
        }),
        collect: async () => childResult
      });
      const result = await replay.runAuthenticatedLinkedInReplayBatch({
        batch: { slug: "S2026" },
        commonArgs: ["collector", "--checkpoint-path=/durable/checkpoint.json"],
        replayState: replay.createLinkedInReplayState(["S2026", "S26"])
      });
      assert.equal(result.replayState.chunksAdmitted, 1);
      assert.equal(result.replayState.chunksAttempted, 1);
      assert.equal(result.replayState.chunksCompleted, 0);
      assert.equal(result.replayState.targetCapacityAdmitted, 5);
      assert.equal(result.replayState.remainingByBatch.S2026, 4);
      assert.equal(result.replayState.remainingByBatch.S26, null);
      assert.equal(result.replayState.safetyStopped, childResult.exitCode === 86);
      assert.equal(result.replayState.infrastructureStopped, childResult.exitCode !== 86);
    }
  });

  it("preserves authenticated collector failures when optional diagnostic persistence is unavailable", async () => {
    for (const fixture of [
      {
        platform: "instagram",
        commandError: Object.assign(new Error("collector network failed"), {
          commandResult: { code: 1, stderr: "collector stderr", stdout: "" }
        }),
        expectedEventType: "authenticated_social.failed",
        expectedResult: {
          status: "failed",
          exitCode: 1,
          error: "collector network failed"
        }
      },
      {
        platform: "linkedin",
        commandError: Object.assign(new Error("collector safety stop"), {
          commandResult: {
            code: 86,
            stderr: "LINKEDIN_CHILD_SAFETY_STOP",
            stdout: ""
          }
        }),
        expectedEventType: "authenticated_social.linkedin_safety_stop",
        expectedResult: {
          status: "safety_stopped",
          exitCode: 86,
          error: "collector safety stop"
        }
      }
    ]) {
      const eventCalls = [];
      const warnings = [];
      const runAuthenticatedCollectorCommand = authenticatedCollectorCommandRuntime({
        runCommand: async () => {
          throw fixture.commandError;
        },
        event: async (...args) => {
          eventCalls.push(args);
          throw new TypeError("fetch failed");
        },
        warn: (message) => warnings.push(message)
      });

      const result = await runAuthenticatedCollectorCommand(
        "S26",
        fixture.platform,
        ["collector.mjs"]
      );

      assert.deepEqual(result, fixture.expectedResult);
      assert.equal(eventCalls.length, 1);
      assert.equal(eventCalls[0][0], fixture.expectedEventType);
      assert.deepEqual(eventCalls[0][3], {
        batchSlug: "S26",
        platform: fixture.platform,
        ...fixture.expectedResult
      });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], new RegExp(fixture.expectedEventType.replaceAll(".", "\\.")));
      assert.match(warnings[0], /fetch failed/);
    }
  });

  it("continues every later Instagram batch after LinkedIn safety stop and keeps unscanned counts unknown", async () => {
    const replay = linkedInReplayRuntime();
    const instagramBatches = [];
    const replayBatches = [];
    const runAuthenticatedCollectors = authenticatedCollectorsRuntime({
      replay,
      collect: async (batchSlug, platform) => {
        assert.equal(platform, "instagram");
        instagramBatches.push(batchSlug);
        return { status: "completed", exitCode: 0 };
      },
      replayBatch: async ({ batch, replayState }) => {
        replayBatches.push(batch.slug);
        let next = replay.reduceLinkedInReplayState(replayState, {
          type: "plan",
          batchSlug: batch.slug,
          runnableTargetCount: 5
        });
        next = replay.reduceLinkedInReplayState(next, {
          type: "chunk_admitted",
          batchSlug: batch.slug
        });
        next = replay.reduceLinkedInReplayState(next, {
          type: "safety_stop",
          batchSlug: batch.slug,
          error: "LINKEDIN_CHILD_SAFETY_STOP"
        });
        next = replay.reduceLinkedInReplayState(next, {
          type: "plan",
          batchSlug: batch.slug,
          runnableTargetCount: 4
        });
        return {
          status: "safety_stopped",
          chunks: [{ chunkNumber: 1, status: "safety_stopped", exitCode: 86 }],
          finalPlan: {},
          replayState: next
        };
      }
    });

    const result = await runAuthenticatedCollectors({ historicalReplay: true });

    assert.deepEqual(instagramBatches, ["S2026", "S26", "A16ZSR006"]);
    assert.deepEqual(replayBatches, ["S2026"]);
    assert.equal(result.batches.length, 3);
    assert.deepEqual(
      result.batches.map(({ batchSlug, instagram, linkedin }) => ({
        batchSlug,
        instagram: instagram.status,
        linkedin: linkedin.status
      })),
      [
        { batchSlug: "S2026", instagram: "completed", linkedin: "safety_stopped" },
        { batchSlug: "S26", instagram: "completed", linkedin: "skipped" },
        { batchSlug: "A16ZSR006", instagram: "completed", linkedin: "skipped" }
      ]
    );
    assert.equal(result.status, "partial");
    assert.equal(result.linkedinReplay.status, "stopped");
    assert.deepEqual(result.linkedinReplay.remainingByBatch, {
      S2026: 4,
      S26: null,
      A16ZSR006: null
    });
    assert.equal(result.linkedinReplay.remainingTargetCount, null);
    assert.equal(result.linkedinReplay.remainingTargetCountKnown, false);
    assert.deepEqual(result.linkedinReplay.unknownRemainingBatches, ["S26", "A16ZSR006"]);
  });

  it("reports missing durable LinkedIn lock as an incomplete unknown replay that cannot claim publication completion", async () => {
    const replay = linkedInReplayRuntime();
    const instagramBatches = [];
    const runAuthenticatedCollectors = authenticatedCollectorsRuntime({
      replay,
      env: authenticatedCollectorEnvironment({ durableLock: false }),
      collect: async (batchSlug, platform) => {
        assert.equal(platform, "instagram");
        instagramBatches.push(batchSlug);
        return { status: "completed", exitCode: 0 };
      },
      replayBatch: async () => {
        throw new Error("LinkedIn replay must not run without its durable lock configuration.");
      }
    });

    const result = await runAuthenticatedCollectors({ historicalReplay: true });

    assert.deepEqual(instagramBatches, ["S2026", "S26", "A16ZSR006"]);
    assert.equal(result.status, "partial");
    assert.equal(result.linkedinReplay.status, "skipped");
    assert.equal(result.linkedinReplay.configurationSkipped, true);
    assert.equal(result.linkedinReplay.durableLockConfigured, false);
    assert.deepEqual(result.linkedinReplay.remainingByBatch, {
      S2026: null,
      S26: null,
      A16ZSR006: null
    });
    assert.equal(result.linkedinReplay.remainingTargetCount, null);
    assert.equal(result.linkedinReplay.remainingTargetCountKnown, false);
    assert.deepEqual(
      result.linkedinReplay.unknownRemainingBatches,
      ["S2026", "S26", "A16ZSR006"]
    );

    const assertCanPublish = authenticatedReplayPublicationValidator();
    assert.doesNotThrow(() => assertCanPublish(result));
    const forgedCompletion = {
      ...result,
      status: "completed",
      linkedinReplay: {
        ...result.linkedinReplay,
        status: "completed",
        configurationSkipped: false
      }
    };
    assert.throws(
      () => assertCanPublish(forgedCompletion),
      /cannot claim completion without a durable lock and exact zero remaining targets/
    );
  });

  it("keeps Instagram outside the LinkedIn chunk loop and publishes once after replay", () => {
    const replayBatch = section(
      "async function runAuthenticatedLinkedInReplayBatch",
      "async function runAuthenticatedLinkedInPlan"
    );
    const authenticatedLoop = section(
      "async function runAuthenticatedCollectors",
      "async function runAuthenticatedLinkedInReplayBatch"
    );
    assert.doesNotMatch(replayBatch, /platforms=instagram|runAuthenticatedCollectorCommand\(\s*batch\.slug,\s*"instagram"/);
    assert.match(replayBatch, /--terminal-completed-platforms=linkedin/);
    assert.match(authenticatedLoop, /checkpointPath/);
    assert.match(replayBatch, /--linkedin-mode=browser/);
    assert.match(replayBatch, /--workers=1/);
    assert.match(replayBatch, /--linkedin-max-targets=\$\{LINKEDIN_REPLAY_TARGET_CAP\}/);
    assert.match(replayBatch, /--delay-ms=30000/);
    assert.match(replayBatch, /--terminal-completed-platforms=linkedin/);
    const linkedInPlan = section(
      "async function runAuthenticatedLinkedInPlan",
      "async function runAuthenticatedCollectorCommand"
    );
    assert.match(linkedInPlan, /linkedinExecution\?\.remainingTargetCount/);
    assert.doesNotMatch(linkedInPlan, /linkedinExecution\?\.runnableTargetCount/);

    const authenticatedBranch = section(
      "if (!args.skipNetwork && args.authenticatedSocialReplay)",
      "} else if (!args.skipNetwork)"
    );
    assert.match(authenticatedBranch, /runAuthenticatedCollectors\(\{ historicalReplay: true \}\)/);
    assert.equal((runner.match(/publicationReceipt = await publishRepositoryArtifacts\(publicationRunId, publicationInputs\)/g) ?? []).length, 1);
    assert.match(runner, /linkedin_remaining_target_count/);
    assert.match(runner, /linkedin_chunk_budget_exhausted/);
    assert.match(runner, /linkedin_deadline_exhausted/);
    assert.match(runner, /linkedin_safety_stopped/);
    assert.match(runner, /linkedin_infrastructure_stopped/);
  });

  it("publishes authenticated historical replays without rerunning public collector lanes", () => {
    assert.ok(runner.includes('args.authenticatedSocialReplay'));
    assert.ok(runner.includes('runAuthenticatedCollectors({ historicalReplay: true })'));
    assert.ok(runner.includes('{ skipNetwork: args.skipNetwork || args.authenticatedSocialReplay }'));
    assert.ok(runner.includes('candidateMetadata?.trigger !== "manual-replay"'));
    assert.ok(runner.includes('collectorRoot = autonomousCollectorStateRoot()'));
    assert.ok(runner.includes('if (args.authenticatedSocialReplay) return authenticatedSocialReplayRoot()'));
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

  it("retries transient mutable-catalog requests inside bounded request and refresh deadlines", () => {
    assert.match(ycCatalogRefresh, /fetchTextWithRetry/);
    assert.match(ycCatalogRefresh, /const REQUEST_MAX_ATTEMPTS = 3/);
    assert.match(ycCatalogRefresh, /const REQUEST_TOTAL_TIMEOUT_MS = 95_000/);
    assert.match(ycCatalogRefresh, /const REFRESH_TIMEOUT_MS = 5 \* 60_000/);
    assert.match(ycCatalogRefresh, /totalTimeoutMs: REQUEST_TOTAL_TIMEOUT_MS/);
    assert.match(ycCatalogRefresh, /maxAttempts: REQUEST_MAX_ATTEMPTS/);
    assert.ok((ycCatalogRefresh.match(/requestText\(/g) ?? []).length >= 3);
    assert.match(ycCatalogRefresh, /detailController\.abort\(error\)/);
    assert.doesNotMatch(ycCatalogRefresh, /requestSignal/);
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

  it("materializes legacy logged-in cohorts without inheriting a singular source batch", () => {
    const merge = section(
      "async function prepareMergedLoggedInEvidenceSnapshot",
      "async function readCanonicalContentIdentityReferenceRows"
    );
    assert.ok(merge.includes("mergeLoggedInEvidenceRows([base, current], incomingSnapshots ?? [])"));
    assert.ok(merge.includes("defaultBatchSlug: null"));
    assert.ok(merge.includes("delete multiCohortSource.batchSlug"));
    assert.ok(merge.includes("delete multiCohortSource.batch_slug"));
    assert.ok(merge.includes("...multiCohortSource"));
    assert.ok(merge.includes("batchSlugs: AUTONOMOUS_BATCHES.map"));
    assert.doesNotMatch(merge, /source:\s*\{\s*\.\.\.source/);
    assert.doesNotMatch(merge, /snapshots\.flatMap\([\s\S]*snapshot\.source\?\.batchSlug/);
  });

  it("wires mutable-catalog rename and removed-founder aliases into durable attribution", () => {
    const durableImport = section(
      "async function importDurableEvidence",
      "async function readHistoricalAttributionCatalogMaps"
    );
    const sync = section("async function syncCatalogs", "function accountRow");
    assert.ok(durableImport.includes("...(company.legacyEntityAliases ?? [])"));
    assert.ok(durableImport.includes("...(founder.legacyEntityAliases ?? [])"));
    assert.ok(durableImport.includes("...(company.historicalFounders ?? [])"));
    assert.ok(durableImport.includes("historicalFounderByBatchSourceKey"));
    assert.ok(sync.includes("...(company.historicalFounders ?? [])"));
    assert.ok(sync.includes("historicalFounderByBatchSourceKey"));
  });

  it("bounds public and GitHub shard processes with separate request lanes", () => {
    const collectors = section("async function runCollectors()", "async function runAuthenticatedCollectors");
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

  it("enforces one runner deadline across every publication and git subprocess path", async () => {
    assert.ok(runner.includes("createAutonomousRunnerBudget"));
    assert.ok(runner.includes("AUTONOMOUS_RUNNER_WALL_CLOCK_BUDGET_MS"));
    assert.ok(runner.includes("startedAt: runStartedAt.getTime()"));

    const commandRunner = section("async function runCommand", "function batchCompanyKey");
    assert.equal(
      (commandRunner.match(/runnerBudget\.timeoutMs\(timeoutMs, label\)/g) ?? []).length,
      2,
      "commands must check the absolute runner deadline initially and immediately before spawn"
    );
    assert.ok(commandRunner.includes("Math.min(timeoutMs, runnerRemainingMs, deadlineRemainingMs)"));
    const ledgerWrite = commandRunner.indexOf('await writeFile(ledgerPath, ""');
    const preSpawnGuard = commandRunner.indexOf("preSpawnGuard();", ledgerWrite);
    const freshBudget = commandRunner.indexOf("runnerBudget.timeoutMs(timeoutMs, label)", preSpawnGuard);
    const spawnIndex = commandRunner.indexOf("spawn(command, commandArgs", freshBudget);
    assert.ok(
      ledgerWrite > -1 && preSpawnGuard > ledgerWrite && freshBudget > preSpawnGuard && spawnIndex > freshBudget,
      "the actual timeout must be derived after ledger/guard setup and directly before spawn"
    );

    for (const [start, end] of [
      ["async function readTextFromGitRef", "function gitRefCaptureLimit"],
      ["async function buildAndValidatePublication", "async function synchronizePublicationBase"],
      ["async function synchronizePublicationBase", "async function publishGithubExports"],
      ["async function publishRepositoryArtifacts", "async function stageRepositoryArtifacts"],
      ["async function transplantPublicationArtifactsOntoRetryBase", "function repositoryArtifactPaths"]
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

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "returner-pre-spawn-deadline-"));
    temporaryRoots.push(fixtureRoot);
    const markerPath = path.join(fixtureRoot, "spawned.txt");
    const deadlineResult = lifecycleFixturePayload(runLifecycleFixture(
      "command-pre-spawn-deadline",
      { LIFECYCLE_FIXTURE_MARKER: markerPath },
      repositoryRoot,
      2_000
    ));
    assert.equal(deadlineResult.spawned, false);
    assert.match(deadlineResult.failureMessage, /runner deadline exhausted|phase deadline/i);
    assert.ok(deadlineResult.elapsedMs < 500, `pre-spawn refusal took ${deadlineResult.elapsedMs}ms`);
  });

  it("preserves UTF-8 command output and refuses truncated structured Git records", () => {
    const utf8 = lifecycleFixturePayload(runLifecycleFixture(
      "utf8-command-capture",
      {},
      repositoryRoot,
      2_000
    ));
    assert.equal(utf8.stdout, utf8.expected);
    assert.equal(utf8.stderr, utf8.expected);
    assert.equal(utf8.stdoutBytes, utf8.expectedBytes);
    assert.equal(utf8.stderrBytes, utf8.expectedBytes);

    const overflow = lifecycleFixturePayload(runLifecycleFixture(
      "complete-output-overflow",
      {},
      repositoryRoot,
      2_000
    ));
    assert.equal(overflow.accepted, false);
    assert.equal(overflow.stdoutTruncated, true);
    assert.match(overflow.error, /refusing to consume truncated structured output/i);

    const stderrOverflow = lifecycleFixturePayload(runLifecycleFixture(
      "complete-stderr-overflow",
      {},
      repositoryRoot,
      2_000
    ));
    assert.equal(stderrOverflow.accepted, false);
    assert.equal(stderrOverflow.stderrTruncated, true);
    assert.match(stderrOverflow.error, /refusing to consume truncated structured output/i);

    const commandRunner = section("async function runCommand", "function batchCompanyKey");
    assert.ok(commandRunner.includes('child.stdout.setEncoding("utf8")'));
    assert.ok(commandRunner.includes('child.stderr.setEncoding("utf8")'));
    assert.ok(commandRunner.includes("requireCompleteOutput"));
    assert.ok(commandRunner.includes("stdoutTruncated"));

    for (const [start, end] of [
      ["async function readTextFromGitRef", "function gitRefCaptureLimit"],
      ["async function verifyPinnedSourceExecutionBoundary", "async function assertTrustedPublicationBaseCommit"],
      ["async function assertTrustedPublicationBaseCommit", "async function assertNoTrackedSymlinksAtCommit"],
      ["async function assertNoTrackedSymlinksAtCommit", "function assertNoTrackedSymlinksAtCommitSync"],
      ["async function transplantPublicationArtifactsOntoRetryBase", "function parseGitNameStatusNul"],
      ["async function assertPublicationCandidateProof", "async function classifyPublicationSemantics"]
    ]) {
      const structuredReader = section(start, end);
      assert.ok(
        structuredReader.includes("requireCompleteOutput: true"),
        `${start} must reject incomplete structured output`
      );
    }

    const synchronousTreeReader = section(
      "function assertNoTrackedSymlinksAtCommitSync",
      "function unsafeTrackedTreeEntries"
    );
    assert.ok(synchronousTreeReader.includes("maxBuffer: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT"));
    for (const [start, end] of [
      ["async function verifyPublicationCommitProvenance", "async function refreshMutableYcCatalog"],
      ["async function readCommitBackedReplayReceipt", "async function resolveVerifiedCurrentPublicationCommit"]
    ]) {
      const structuredReader = section(start, end);
      assert.ok(structuredReader.includes("captureLimit: STRUCTURED_GIT_OUTPUT_CAPTURE_LIMIT"));
      assert.ok(structuredReader.includes("requireCompleteOutput: true"));
    }
  });

  it("retries exact failure ledgers until success or the collection deadline", () => {
    const retry = section("async function runCollectorWithRetries", "function retryableFailuresFromSnapshot");
    const failures = section("function retryableFailuresFromSnapshot", "function successfulCollectorRowCount");

    assert.ok(failures.includes("autonomousCollectorRetryableFailures(snapshot)"));
    assert.ok(retry.includes("summarizeAutonomousCollectorTerminalTaskCoverage"));
    assert.ok(retry.includes("terminalCoverage.nonTerminal"));
    assert.ok(retry.includes('retryPolicy: "until_success_within_collection_deadline"'));
    assert.ok(retry.includes("for (let attempt = 1; ; attempt += 1)"));
    assert.ok(retry.includes("AUTONOMOUS_PROCESS_BUDGETS.collectorRateLimitRetryDelayMs"));
    assert.ok(retry.includes("cappedExponentialBackoffMs"));
    assert.doesNotMatch(retry, /attempt === maxAttempts/);
    assert.doesNotMatch(retry, /retryableFailures\.length === 0 \|\| attempt === maxAttempts/);
    assert.ok(retry.includes("args.resumeSnapshots"));
    assert.ok(retry.includes("collector.snapshot_resumed"));
    assert.ok(retry.includes("terminalCoverage.nonTerminal === 0 && retryableFailures.length === 0"));
    assert.ok(runner.includes('resumeSnapshots: !rawArgs.includes("--no-resume-snapshots")'));
  });

  it("reuses a campaign collector ledger across distinct durable sweep runs", () => {
    const preparation = section("async function prepareBatchDiscoveryState", "async function mergeCollectorDiscoveryState");
    const shardedPublic = section("async function runShardedPublicCollector", "async function seedShardLedger");
    const shardedGithub = section("async function runShardedGithubCollector", "function githubShardSearchBudget");

    assert.ok(runner.includes('campaignKey: value("--campaign-key")'));
    assert.ok(runner.includes('"autonomous-ingestion-campaigns"'));
    assert.ok(runner.includes("function autonomousCollectorStateRoot()"));
    assert.ok(runner.includes("RETURNER_INGESTION_STATE_ROOT"));
    assert.ok(runner.includes("RUNNER_WORKSPACE"));
    assert.ok(runner.includes('"returner-fund-autonomous-ingestion-state", "v1"'));
    assert.ok(runner.includes('join(durableBase, "campaigns", safePathSegment(args.campaignKey))'));
    assert.ok(runner.includes('join(durableBase, "slots", safePathSegment(idempotencyKey))'));
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
    assert.ok(enqueue.includes("{ timeoutMs: SUPABASE_BULK_OPERATION_TIMEOUT_MS }"));
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

  it("paginates reconciliation and terminal coverage across the complete task plan", () => {
    const taskRead = section("async function tasksFor", "async function finishTasks");
    const coverage = section("async function persistCoverage", "async function persistArtifactManifest");

    assert.ok(taskRead.includes("readAllIngestionTaskRows("));
    assert.ok(taskRead.includes("let lastSeenId = null"));
    assert.ok(taskRead.includes("INGESTION_TASK_READ_MAX_ATTEMPTS"));
    assert.ok(taskRead.includes("INGESTION_TASK_READ_SUCCESS_PAGES_BEFORE_GROWTH"));
    assert.ok(taskRead.includes('.order("id", { ascending: true })'));
    assert.ok(taskRead.includes(".limit(pageSize)"));
    assert.ok(taskRead.includes('query.gt("id", lastSeenId)'));
    assert.ok(taskRead.includes("isRetryableIngestionTaskReadError(pageResult.error)"));
    assert.ok(taskRead.includes("isRetryableIngestionTaskReadError(error)"));
    assert.ok(taskRead.includes("if (pageRows.length === 0) break"));
    assert.doesNotMatch(taskRead, /pageRows\.length < pageSize/);
    assert.doesNotMatch(taskRead, /\.range\(offset,/);
    assert.ok(coverage.includes("await readAllIngestionTaskRows("));
    assert.ok(coverage.includes("partitionAutonomousTaskInventory(tasks, plannedTasks,"));
    assert.doesNotMatch(coverage, /runSupabaseOperation\(\s*"read terminal coverage"/);
  });

  it("indexes the durable run cursor used by terminal coverage", async () => {
    const migration = await readFile(
      path.join(repositoryRoot, "supabase", "migrations", "028_ingestion_tasks_run_cursor_index.sql"),
      "utf8"
    );

    assert.match(
      migration,
      /on public\.ingestion_tasks \(ingestion_run_id, id\)/
    );
  });

  it("guards publication on the current plan and cancels superseded same-slot work", () => {
    const coverage = section("async function persistCoverage", "async function persistArtifactManifest");
    const taskInventory = section("async function cancelSupersededRunTasks", "async function prepareBatchDiscoveryState");
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
    assert.ok(taskInventory.includes('terminal_reason: "superseded_by_current_catalog_plan"'));
    assert.ok(taskInventory.includes('isAutonomousCollectorTaskForRun(task, { runKey: idempotencyKey })'));
    assert.ok(taskInventory.includes('.in("status", nonTerminalStatuses)'));
    assert.ok(runner.indexOf("await cancelSupersededRunTasks()") < runner.indexOf("() => runCollectors()"));
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

  it("persists only the exact remotely verified published manifest before completion", () => {
    const publicationBuild = section("async function buildAndValidatePublication", "async function synchronizePublicationBase");
    const scoringDiagnosticsIndex = publicationBuild.indexOf('"scripts/run-scoring-diagnostics-v4.mjs"');
    const writeIndex = publicationBuild.indexOf('"scripts/write-artifact-manifest.mjs"');
    const validateIndex = publicationBuild.indexOf('["scripts/validate-public-artifacts.mjs"]');
    const strictManifestIndex = publicationBuild.indexOf('"scripts/write-artifact-manifest.mjs", "--validate"');
    const buildCallIndex = runner.indexOf("await buildAndValidatePublication(publicationRunId, catalogState)");
    const publishIndex = runner.indexOf(
      "await publishRepositoryArtifacts(publicationRunId, publicationInputs)"
    );
    const captureIndex = runner.indexOf(
      "latestPublishedCommit = publicationReceipt.publishedCommit ?? null",
      publishIndex
    );
    const persistIndex = runner.indexOf(
      "await persistArtifactManifest(run.id, publicationReceipt)",
      captureIndex
    );
    const completionIndex = runner.indexOf('await completeRun("completed"');
    const manifestPersistence = section(
      "async function persistArtifactManifest",
      "async function claimTimelineArtifactInvalidationsForBuild"
    );
    const publication = section(
      "async function publishRepositoryArtifacts",
      "async function stageRepositoryArtifacts"
    );

    assert.ok(scoringDiagnosticsIndex > -1);
    assert.ok(writeIndex > -1);
    assert.ok(
      writeIndex > scoringDiagnosticsIndex &&
      validateIndex > writeIndex &&
      strictManifestIndex > validateIndex
    );
    assert.ok(persistIndex > buildCallIndex);
    assert.ok(buildCallIndex < publishIndex && publishIndex < captureIndex && captureIndex < persistIndex);
    assert.ok(completionIndex > persistIndex);
    assert.equal((runner.match(/persistArtifactManifest\(/g) ?? []).length, 2);
    assert.doesNotMatch(publication, /persistArtifactManifest/);
    assert.match(
      manifestPersistence,
      /verifyPublicationCommitOnRemote\(claimedCommit,[\s\S]*?label: "artifact manifest persistence"/
    );
    assert.ok(manifestPersistence.includes('readTextFromGitRef(publishedCommit, manifestPath, null)'));
    assert.ok(manifestPersistence.includes('from("ingestion_artifact_manifests").upsert'));
    assert.ok(manifestPersistence.includes('artifact_key: "public-graph-manifest"'));
    assert.ok(manifestPersistence.includes('storage_uri: `repo://${publishedCommit}/${manifestPath}`'));
    assert.ok(manifestPersistence.includes("publicationBinding"));
    assert.ok(manifestPersistence.includes("publishedCommit,"));
    assert.ok(manifestPersistence.includes("publicationStatus,"));
    assert.ok(manifestPersistence.includes("receiptSha256,"));
    assert.ok(manifestPersistence.includes("manifestSha256: sha256"));
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

  it("transplants generated artifacts onto a concurrent main base, then rebuilds with pinned code", () => {
    const publication = section("async function publishRepositoryArtifacts", "async function stageRepositoryArtifacts");
    const pushRunner = section("async function runPublicationPush", "async function resolveAmbiguousPublicationAfterCancellation");
    const recovery = section(
      "async function pushPublicationCandidateWithConcurrentMainRecovery",
      "async function pushPublicationCandidateAttempt"
    );
    const pushAttempt = section(
      "async function pushPublicationCandidateAttempt",
      "async function fetchExactPublicationRetryBase"
    );
    const fetchRetryBase = section(
      "async function fetchExactPublicationRetryBase",
      "async function rebuildPublicationCandidateOnConcurrentBase"
    );
    const rebuild = section(
      "async function rebuildPublicationCandidateOnConcurrentBase",
      "async function verifyAndClassifyPublicationCandidate"
    );
    const identity = section(
      "async function verifyPublicationCandidateIdentity",
      "async function adoptReachablePublicationCandidate"
    );
    assert.ok(pushRunner.includes('`${candidate.publishedCommit}:${candidate.branch}`'));
    assert.ok(pushAttempt.includes("allowedExitCodes: [0, 1]"));
    assert.ok(pushAttempt.includes("retryTransportFailures: true"));
    assert.ok(publication.includes('"publication.push_retry"'));
    assert.ok(runner.includes("const MAX_PUBLICATION_PUSH_ATTEMPTS = 3"));
    assert.ok(recovery.includes("while (attempts < MAX_PUBLICATION_PUSH_ATTEMPTS)"));
    assert.ok(recovery.includes("isConcurrentMainPushRejection(pushResult)"));
    assert.ok(recovery.includes("retryableTransportFailure"));
    assert.ok(recovery.includes("await adoptCandidate(candidate"));
    assert.ok(recovery.includes("remoteTipCommit: retryBaseCommit"));
    assert.ok(recovery.includes("retryBaseCommit === candidate.publishedCommit"));
    assert.ok(recovery.includes("retryBaseCommit === candidate.publicationBaseCommit"));
    assert.ok(recovery.indexOf("remoteTipCommit: retryBaseCommit") < recovery.indexOf("await rebuildCandidate({"));
    assert.ok(fetchRetryBase.includes("assertTrustedPublicationBaseCommit(retryBaseCommit"));
    assert.ok(fetchRetryBase.includes("allowInertCodeDrift: true"));
    assert.ok(rebuild.includes("transplantPublicationArtifactsOntoRetryBase"));
    assert.ok(rebuild.includes("inspectValidatedPublicationCandidateReuse"));
    assert.ok(rebuild.includes("if (validatedCandidateReuse)"));
    assert.ok(rebuild.includes("readGitRawDelta(retryBaseCommit, retryCommit.publishedCommit"));
    assert.ok(rebuild.includes("retryCommit.provenance"));
    assert.ok(rebuild.includes("candidateCommit: candidate.publishedCommit"));
    assert.ok(rebuild.includes("candidateBaseCommit: candidate.publicationBaseCommit"));
    assert.ok(rebuild.includes("rebasedSanitizedPublicSnapshot"));
    assert.ok(rebuild.includes("const retryDurableImport = await importDurableEvidence"));
    assert.ok(rebuild.includes("assertDurableAttributionCompleteness(retryDurableImport)"));
    assert.ok(rebuild.includes(
      "await mergePublicationInputs(rebasedPublicationInputs, { baseRef: publicationBaseCommit })"
    ));
    assert.ok(identity.includes("assertPublicationCandidateProof("));
    assert.ok(identity.includes("verifyPublicationCommitProvenance(candidate.publishedCommit"));
    assert.doesNotMatch(rebuild, /amend:\s*true|headHasPublicationRunIdentity/);
    assert.match(rebuild, /amend: false/);
    assert.doesNotMatch(publication, /\brebase\b/);
    const transplant = section(
      "async function transplantPublicationArtifactsOntoRetryBase",
      "function parseGitNameStatusNul"
    );
    assert.match(transplant, /allowedExitCodes: \[0\]/);
    assert.doesNotMatch(transplant, /allowedExitCodes: \[0, 128\]/);
    const transplantIndex = rebuild.indexOf("transplantPublicationArtifactsOntoRetryBase");
    const prepareIndex = rebuild.indexOf("const rebasedSanitizedPublicSnapshot");
    const retryImportIndex = rebuild.indexOf("const retryDurableImport = await importDurableEvidence");
    const guardIndex = rebuild.indexOf("assertDurableAttributionCompleteness(retryDurableImport)");
    const samePlanMergeIndex = rebuild.indexOf("await mergePublicationInputs(rebasedPublicationInputs");
    const rebuildIndex = rebuild.indexOf(
      "await buildAndValidatePublication(publicationRunId, publicationInputs.catalogState)",
      samePlanMergeIndex,
    );
    assert.ok(
      transplantIndex < prepareIndex &&
      prepareIndex < retryImportIndex &&
      retryImportIndex < guardIndex &&
      guardIndex < samePlanMergeIndex &&
      samePlanMergeIndex < rebuildIndex
    );
    assert.ok(rebuild.includes(
      "await buildAndValidatePublication(publicationRunId, publicationInputs.catalogState)",
    ));
    assert.ok(rebuild.includes("await stageRepositoryArtifacts()"));
    assert.ok(pushAttempt.includes("`retry refreshed artifact push ${attempt}`"));
  });

  it("reuses a validated candidate across dashboard-only drift without entering the heavyweight rebuild", async () => {
    const publicationParent = await mkdtemp(path.join(os.tmpdir(), "returner-dashboard-race-"));
    const publicationRoot = path.join(publicationParent, "checkout");
    temporaryRoots.push(publicationParent);
    const sourceCommit = runGit(repositoryRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
    const receipt = `${JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "publication-retry-reuse-contract",
      trigger: "manual-replay",
      scheduledAt: null,
      fixture: "dashboard-only-concurrent-drift"
    }, null, 2)}\n`;
    const baseCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "outputs/ingestion-source-delta-current.json",
      content: receipt
    });
    const dashboardArtifactCommit = await createDetachedFixtureCommit({
      parent: baseCommit,
      filePath: "artifacts/dashboard/current.json",
      content: '{"fixture":"newer-dashboard-artifact"}\n'
    });
    const dashboardBytes = '{"fixture":"newer-dashboard-must-survive"}\n';
    const retryBaseCommit = await createDetachedFixtureCommit({
      parent: dashboardArtifactCommit,
      filePath: "public/dashboard/feed.json",
      content: dashboardBytes
    });

    runGit(repositoryRoot, ["worktree", "add", "--detach", publicationRoot, baseCommit]);
    try {
      const result = runLifecycleFixture("publication-retry-reuse", {
        GITHUB_RUN_ID: "publication-retry-reuse-fixture",
        GITHUB_RUN_ATTEMPT: "1",
        LIFECYCLE_FIXTURE_PUBLICATION_ROOT: publicationRoot,
        LIFECYCLE_FIXTURE_PUBLICATION_PARENT: publicationParent,
        LIFECYCLE_FIXTURE_BASE_COMMIT: baseCommit,
        LIFECYCLE_FIXTURE_RETRY_BASE_COMMIT: retryBaseCommit
      }, repositoryRoot, 15_000);
      const payload = lifecycleFixturePayload(result);
      assert.equal(payload.reusedValidatedCandidate, true);
      assert.equal(payload.proof.parentCommit, retryBaseCommit);
      assert.equal(payload.dashboardBytes, dashboardBytes);
      assert.deepEqual(payload.retainedCandidateRows, [{
        id: "publication-retry-reuse",
        retained: true
      }]);
      assert.ok(payload.proof.changedPaths.includes("outputs/source-discovery-paths-current.json"));
      assert.ok(!payload.proof.changedPaths.includes("public/dashboard/feed.json"));
    } finally {
      runGit(repositoryRoot, ["worktree", "remove", "--force", publicationRoot]);
      runGit(repositoryRoot, ["worktree", "prune"]);
    }
  });

  it("publishes learned discovery state from isolated batch collector files", () => {
    const collectors = section("async function runCollectors()", "async function runTopVoiceCollector");
    const artifactPaths = section("function repositoryArtifactPaths", "function publicationBranch");
    assert.ok(collectors.includes("await prepareBatchDiscoveryState()"));
    assert.ok(runner.includes("await mergeCollectorDiscoveryState("));
    assert.ok(artifactPaths.includes('"outputs/discovery-attempts-current.json"'));
    assert.ok(artifactPaths.includes('"outputs/source-discovery-paths-current.json"'));
  });

  it("re-reads and semantically merges publication state only after initial base synchronization", () => {
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
    assert.ok(sync.includes("first_seen_at: now"));
    assert.ok(sync.includes("last_seen_at: now"));
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
  it("accepts data-only bases and explicitly inert source drift, while rejecting executable/policy drift", async () => {
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
    const inertCodeCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "src/lib/graph/layout.ts",
      content: "export const inertLayoutFixture = true;\n"
    });
    const inertTestCodeCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "tests/fixture-layout.tsx",
      content: "export const inertTestLayoutFixture = true;\n"
    });
    const dashboardArtifactCommit = await createDetachedFixtureCommit({
      parent: sourceCommit,
      filePath: "artifacts/dashboard/current.json",
      content: '{"fixture":"dashboard-artifact-base"}\n'
    });
    const dashboardSnapshotCommit = await createDetachedFixtureCommit({
      parent: dashboardArtifactCommit,
      filePath: "public/dashboard/feed.json",
      content: '{"fixture":"dashboard-feed-base"}\n'
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
    assert.equal(isReplaySafePublicationDataPath("artifacts/dashboard/current.json"), false);
    assert.equal(isReplaySafePublicationDataPath("public/dashboard/feed.json"), false);
    assert.equal(isSafeInertPublicationBasePath("artifacts/dashboard/current.json"), true);
    assert.equal(isSafeInertPublicationBasePath("public/dashboard/feed.json"), true);
    assert.equal(isSafeInertPublicationBasePath("src/lib/graph/layout.ts"), true);
    assert.equal(isSafeInertPublicationBasePath("tests/fixture-layout.tsx"), true);
    assert.equal(isSafeInertPublicationBasePath("tests/fixture-layout.js"), false);
    assert.equal(isSafeInertPublicationBasePath("src/config.ts"), false);
    assert.equal(isSafeInertPublicationBasePath("tests/dependencies/fixture.ts"), false);
    for (const suffix of ["config", "policy", "settings"]) {
      assert.equal(isSafeInertPublicationBasePath(`src/lib/runtime.${suffix}.ts`), false);
      assert.equal(isSafeInertPublicationBasePath(`tests/runtime.${suffix}.tsx`), false);
    }
    assert.equal(isSafeInertPublicationBasePath("scripts/queued-run-malicious.mjs"), false);
    assert.equal(isSafeInertPublicationBasePath(".github/workflows/fixture.ts"), false);
    assert.equal(isSafeInertPublicationBasePath("supabase/functions/fixture.ts"), false);
    assert.equal(isValidatedPublicationRetryReuseSafePath("artifacts/dashboard/current.json"), true);
    assert.equal(isValidatedPublicationRetryReuseSafePath("public/dashboard/feed.json"), true);
    assert.equal(isValidatedPublicationRetryReuseSafePath("public/graph/s26.json"), false);
    assert.equal(isValidatedPublicationRetryReuseSafePath("src/lib/graph/layout.ts"), false);
    assert.equal(isProtectedSourcePolicyPath("src/lib/social/package.json"), true);
    assert.equal(
      isReplaySafePublicationDataPath("src/lib/social/logged-in-evidence-current.json"),
      true
    );
    assert.equal(isReplaySafePublicationDataPath("artifacts/dashboard/current.json"), false);
    assert.equal(isReplaySafePublicationDataPath("public/dashboard/feed.json"), false);
    assert.equal(isReplaySafePublicationDataPath("public/timelines/companies/config.json"), false);
    assert.equal(isReplaySafePublicationDataPath("public/timelines/companies/acme-labs.json"), true);
    const artifactPaths = section("function repositoryArtifactPaths", "function publicationBranch");
    assert.doesNotMatch(artifactPaths, /"artifacts\/dashboard\/current\.json"/);
    assert.doesNotMatch(artifactPaths, /"public\/dashboard\/feed\.json"/);

    const accepted = lifecycleFixturePayload(runLifecycleFixture("publication-base-trust", {
      LIFECYCLE_FIXTURE_SOURCE_COMMIT: sourceCommit,
      LIFECYCLE_FIXTURE_BASE_COMMIT: dataCommit,
      LIFECYCLE_FIXTURE_BASE_LABEL: "initial publication base"
    }));
    assert.equal(accepted.accepted, true);

    const acceptedDashboardSnapshot = lifecycleFixturePayload(runLifecycleFixture("publication-base-trust", {
      LIFECYCLE_FIXTURE_SOURCE_COMMIT: sourceCommit,
      LIFECYCLE_FIXTURE_BASE_COMMIT: dashboardSnapshotCommit,
      LIFECYCLE_FIXTURE_BASE_LABEL: "initial publication base",
      LIFECYCLE_FIXTURE_ALLOW_INERT_CODE_DRIFT: "true"
    }));
    assert.equal(acceptedDashboardSnapshot.accepted, true);

    const rejectedDashboardSnapshotReplay = lifecycleFixturePayload(runLifecycleFixture("publication-base-trust", {
      LIFECYCLE_FIXTURE_SOURCE_COMMIT: sourceCommit,
      LIFECYCLE_FIXTURE_BASE_COMMIT: dashboardSnapshotCommit,
      LIFECYCLE_FIXTURE_BASE_LABEL: "commit-backed replay publication"
    }));
    assert.equal(rejectedDashboardSnapshotReplay.accepted, false);
    assert.match(
      rejectedDashboardSnapshotReplay.error,
      /non-allowlisted drift.*(?:artifacts\/dashboard\/current\.json|public\/dashboard\/feed\.json)/
    );

    const acceptedInertCode = lifecycleFixturePayload(runLifecycleFixture("publication-base-trust", {
      LIFECYCLE_FIXTURE_SOURCE_COMMIT: sourceCommit,
      LIFECYCLE_FIXTURE_BASE_COMMIT: inertCodeCommit,
      LIFECYCLE_FIXTURE_BASE_LABEL: "publication retry base",
      LIFECYCLE_FIXTURE_ALLOW_INERT_CODE_DRIFT: "true"
    }));
    assert.equal(acceptedInertCode.accepted, true);

    const acceptedInertTestCode = lifecycleFixturePayload(runLifecycleFixture("publication-base-trust", {
      LIFECYCLE_FIXTURE_SOURCE_COMMIT: sourceCommit,
      LIFECYCLE_FIXTURE_BASE_COMMIT: inertTestCodeCommit,
      LIFECYCLE_FIXTURE_BASE_LABEL: "publication retry base",
      LIFECYCLE_FIXTURE_ALLOW_INERT_CODE_DRIFT: "true"
    }));
    assert.equal(acceptedInertTestCode.accepted, true);

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
    const retryFetchBoundary = section(
      "async function fetchExactPublicationRetryBase",
      "async function rebuildPublicationCandidateOnConcurrentBase"
    );
    const retryRebuildBoundary = section(
      "async function rebuildPublicationCandidateOnConcurrentBase",
      "async function verifyAndClassifyPublicationCandidate"
    );
    assert.match(ensureBoundary, /assertTrustedPublicationBaseCommit\(baseCommit/);
    assert.match(ensureBoundary, /allowInertCodeDrift: true/);
    assert.match(runner, /resolveVerifiedCurrentPublicationCommit\(\{\n\s*labelPrefix: "initial publication base",\n\s*allowInertCodeDrift: true/);
    assert.match(retryFetchBoundary, /assertTrustedPublicationBaseCommit\(retryBaseCommit/);
    assert.match(retryFetchBoundary, /allowInertCodeDrift: true/);
    assert.match(retryRebuildBoundary, /transplantPublicationArtifactsOntoRetryBase/);
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

function linkedInReplayRuntime({
  nowMs = 1_800_000_000_000,
  collectionDeadlineAt = nowMs + 60 * 60_000,
  plan = async () => ({ status: "completed", runnableTargetCount: 0, plan: {} }),
  collect = async () => ({ status: "completed", exitCode: 0 })
} = {}) {
  const replaySource = section(
    "function createLinkedInReplayState",
    "async function runAuthenticatedLinkedInPlan"
  );
  const runtime = new Function(
    "LINKEDIN_REPLAY_MAX_CHUNKS",
    "LINKEDIN_REPLAY_TARGET_CAP",
    "LINKEDIN_REPLAY_RESERVE_MS",
    "AUTONOMOUS_PROCESS_BUDGETS",
    "collectionBudget",
    "runAuthenticatedLinkedInPlan",
    "runAuthenticatedCollectorCommand",
    "event",
    "Date",
    `${replaySource}\nreturn {\n` +
      "  createLinkedInReplayState,\n" +
      "  reduceLinkedInReplayState,\n" +
      "  linkedInReplayIsComplete,\n" +
      "  decideLinkedInReplayAdmission,\n" +
      "  createLinkedInReplayResult,\n" +
      "  linkedInReplayChildDeadlineAt,\n" +
      "  runAuthenticatedLinkedInReplayBatch\n" +
      "};"
  );
  return runtime(
    7,
    5,
    15 * 60_000,
    { collectionDeadlineDrainHeadroomMs: 5 * 60_000 },
    {
      deadlineAt: collectionDeadlineAt,
      remainingMs: () => Math.max(0, collectionDeadlineAt - nowMs)
    },
    plan,
    collect,
    async () => {},
    { now: () => nowMs }
  );
}

function authenticatedCollectorEnvironment({ durableLock = true } = {}) {
  return {
    OPENCLI_BIN: "/opt/opencli/bin/opencli",
    OPENCLI_PROFILE: "/runner/profile",
    RETURNER_LINKEDIN_VIEWER_PROFILE: "linkedin-viewer",
    RETURNER_INSTAGRAM_VIEWER_HANDLE: "instagram-viewer",
    ...(durableLock
      ? {
          NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          LINKEDIN_GLOBAL_LOCK_NAMESPACE: "linkedin-global"
        }
      : {})
  };
}

function authenticatedCollectorCommandRuntime({ runCommand, event, warn }) {
  const commandSource = section(
    "async function runAuthenticatedCollectorCommand",
    "async function runShardedPublicCollector"
  );
  const runtime = new Function(
    "process",
    "runCommand",
    "collectorLaunchProvenanceArgs",
    "createCollectorAttemptContext",
    "boundedCollectionTimeoutMs",
    "LINKEDIN_REPLAY_PLAN_TIMEOUT_MS",
    "AUTONOMOUS_PROCESS_BUDGETS",
    "collectionBudget",
    "COLLECTOR_NODE_HEAP_MB",
    "root",
    "errorMessage",
    "event",
    "sanitizeRunnerDiagnosticText",
    "console",
    `${commandSource}\nreturn runAuthenticatedCollectorCommand;`
  );
  return runtime(
    { execPath: "/usr/bin/node", env: { HOME: "/runner/home" } },
    runCommand,
    () => [],
    () => ({ attempt: 1 }),
    (timeoutMs) => timeoutMs,
    5_000,
    { publicCollectorAttemptMs: 10_000 },
    { deadlineAt: 100_000 },
    512,
    "/repo",
    (error) => error instanceof Error ? error.message : String(error),
    event,
    (value) => String(value),
    { warn }
  );
}

function authenticatedCollectorsRuntime({
  replay,
  env = authenticatedCollectorEnvironment(),
  collect,
  replayBatch,
  batchSlugs = ["S2026", "S26", "A16ZSR006"]
}) {
  const collectorsSource = section(
    "async function runAuthenticatedCollectors",
    "function createLinkedInReplayState"
  );
  const batches = batchSlugs.map((slug) => ({ slug }));
  const runtime = new Function(
    "process",
    "cleanEnv",
    "event",
    "AUTONOMOUS_BATCHES",
    "loggedInOutputs",
    "loggedInCheckpointOutputs",
    "runAuthenticatedCollectorCommand",
    "runAuthenticatedLinkedInReplayBatch",
    "createLinkedInReplayState",
    "reduceLinkedInReplayState",
    "createLinkedInReplayResult",
    "linkedInReplayIsComplete",
    "LINKEDIN_REPLAY_TARGET_CAP",
    `${collectorsSource}\nreturn runAuthenticatedCollectors;`
  );
  return runtime(
    { env },
    (value) => typeof value === "string" && value.trim() ? value.trim() : null,
    async () => {},
    batches,
    new Map(batchSlugs.map((slug) => [slug, `/outputs/${slug}.json`])),
    new Map(batchSlugs.map((slug) => [slug, `/checkpoints/${slug}.json`])),
    collect,
    replayBatch,
    replay.createLinkedInReplayState,
    replay.reduceLinkedInReplayState,
    replay.createLinkedInReplayResult,
    replay.linkedInReplayIsComplete,
    5
  );
}

function authenticatedReplayPublicationValidator() {
  const validatorSource = section(
    "function assertAuthenticatedReplayCanPublish",
    "function assertSuccessfulTopVoiceRefresh"
  );
  return new Function(
    "LINKEDIN_REPLAY_MAX_CHUNKS",
    "LINKEDIN_REPLAY_TARGET_CAP",
    `${validatorSource}\nreturn assertAuthenticatedReplayCanPublish;`
  )(7, 5);
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

async function createTimedFakeGit({
  root,
  markerPath,
  fetchDelayMs = 0,
  ancestryDelayMs = 0
}) {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeExecutable(path.join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify(args) + "\\n");
const delay = args[0] === "fetch" ? ${fetchDelayMs} :
  args[0] === "merge-base" ? ${ancestryDelayMs} : 0;
setTimeout(() => process.exit(0), delay);
`);
  return bin;
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

function runLifecycleFixture(fixture, extraEnv = {}, cwd = repositoryRoot, timeoutMs = 5_000) {
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
      timeout: timeoutMs
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

async function createDetachedFixtureDeletionCommit({ parent, filePath }) {
  const indexRoot = await mkdtemp(path.join(os.tmpdir(), "returner-publication-delete-"));
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
  runGitWithOptions(repositoryRoot, ["update-index", "--force-remove", "--", filePath], { env: fixtureEnv });
  const tree = runGitWithOptions(repositoryRoot, ["write-tree"], { env: fixtureEnv }).stdout.trim();
  return runGitWithOptions(
    repositoryRoot,
    ["commit-tree", tree, "-p", parent, "-m", `fixture delete ${filePath}`],
    { env: fixtureEnv }
  ).stdout.trim();
}

async function runPublicationRaceFixture({ mode, concurrentAdvanceCount }) {
  const publicationParent = await mkdtemp(path.join(os.tmpdir(), "returner-publication-race-"));
  const publicationRoot = path.join(publicationParent, "checkout");
  temporaryRoots.push(publicationParent);
  const sourceCommit = runGit(repositoryRoot, ["rev-parse", "HEAD^{commit}"]).stdout.trim();
  const receipt = `${JSON.stringify({
    schemaVersion: 1,
    idempotencyKey: "publication-race-loop-contract",
    trigger: "manual-replay",
    scheduledAt: null,
    fixture: mode
  }, null, 2)}\n`;
  const baseCommit = await createDetachedFixtureCommit({
    parent: sourceCommit,
    filePath: "outputs/ingestion-source-delta-current.json",
    content: receipt
  });
  const concurrentCommits = [];
  let concurrentParent = baseCommit;
  for (let index = 0; index < concurrentAdvanceCount; index += 1) {
    const concurrentCommit = await createDetachedFixtureCommit({
      parent: concurrentParent,
      filePath: `src/lib/graph/publication-race-${index + 1}.ts`,
      content: `export const publicationRace${index + 1} = true;\n`
    });
    concurrentCommits.push(concurrentCommit);
    concurrentParent = concurrentCommit;
  }

  runGit(repositoryRoot, ["worktree", "add", "--detach", publicationRoot, baseCommit]);
  try {
    const result = runLifecycleFixture("publication-race-loop", {
      GITHUB_RUN_ID: "publication-race-fixture",
      GITHUB_RUN_ATTEMPT: "1",
      LIFECYCLE_FIXTURE_PUBLICATION_ROOT: publicationRoot,
      LIFECYCLE_FIXTURE_PUBLICATION_PARENT: publicationParent,
      LIFECYCLE_FIXTURE_BASE_COMMIT: baseCommit,
      LIFECYCLE_FIXTURE_PUBLICATION_RACE_MODE: mode,
      LIFECYCLE_FIXTURE_CONCURRENT_COMMITS: concurrentCommits.join(",")
    }, repositoryRoot, 15_000);
    return {
      payload: lifecycleFixturePayload(result),
      baseCommit,
      concurrentCommits
    };
  } finally {
    runGit(repositoryRoot, ["worktree", "remove", "--force", publicationRoot]);
    runGit(repositoryRoot, ["worktree", "prune"]);
  }
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
