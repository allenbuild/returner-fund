import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildChildEnvironment,
  finalVerificationCommands,
  normalizeNodeOptions,
  runCommand,
  writeSummary
} from "../scripts/run-final-verification.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("every multi-file package Node test command is explicitly serial", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const violations = [];

  for (const [scriptName, script] of Object.entries(packageJson.scripts)) {
    for (const segment of script.split(/\s*&&\s*/)) {
      if (!/(?:^|\s)--test(?:\s|$)/.test(segment)) continue;
      const testFiles = segment.match(/tests\/[^\s"']+\.node-test\.mjs\b/g) ?? [];
      if (testFiles.length > 1 && !/(?:^|\s)--test-concurrency=1(?:\s|$)/.test(segment)) {
        violations.push({ scriptName, testFiles });
      }
    }
  }

  assert.deepEqual(violations, []);
  assert.match(
    packageJson.scripts["test:collectors"],
    /^node --test --test-concurrency=1 tests\/credentialed-source-discovery\.node-test\.mjs/
  );
  assert.match(packageJson.scripts["test:logged-social"], /^node --test --test-concurrency=1 /);
  assert.match(packageJson.scripts["scoring:v5:audit"], /^node --test --test-concurrency=1 /);
});

test("final verification preserves command order when targeted checks are enabled or skipped", () => {
  const enabled = finalVerificationCommands().map((command) => command.label);
  const skipped = finalVerificationCommands({ skipTargetedIngest: true }).map(
    (command) => command.label
  );

  assert.deepEqual(enabled, [
    "typecheck",
    "tests",
    "build",
    "coverage_report",
    "workers_report",
    "duplicates_report",
    "instagram_doctor",
    "heyclicky_instagram_targeted_check",
    "heyclicky_x_targeted_check",
    "heyclicky_vs_insforge_scoring",
    "scoring_experiments",
    "anomaly_report",
    "longrun_checkpoint",
    "longrun_final_report"
  ]);
  assert.deepEqual(
    skipped,
    enabled.filter((label) => !label.startsWith("heyclicky_instagram_targeted")
      && !label.startsWith("heyclicky_x_targeted"))
  );
});

test("final verification bounds every Node-like child heap while preserving safe options", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "final-verification-node-options-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  assert.equal(
    normalizeNodeOptions("", 2048),
    "--max-old-space-size=2048"
  );
  assert.equal(
    normalizeNodeOptions("--trace-warnings --max-old-space-size=99999", 1024),
    "--trace-warnings --max-old-space-size=1024"
  );
  assert.equal(
    normalizeNodeOptions("--trace-warnings --max-old-space-size=256", 2048),
    "--trace-warnings --max-old-space-size=256"
  );

  assert.equal(
    buildChildEnvironment({ cmd: "bash" }, { NODE_OPTIONS: "--max-old-space-size=99999" }).NODE_OPTIONS,
    undefined
  );
  assert.match(
    buildChildEnvironment({ cmd: "npm" }, { NODE_OPTIONS: "" }).NODE_OPTIONS,
    /--max-old-space-size=1536/
  );
  assert.match(
    buildChildEnvironment({ cmd: "npx" }, { NODE_OPTIONS: "" }).NODE_OPTIONS,
    /--max-old-space-size=1536/
  );
  assert.match(
    buildChildEnvironment({ cmd: "node", nodeHeapCapMb: 99999 }, { NODE_OPTIONS: "" }).NODE_OPTIONS,
    /--max-old-space-size=3072/
  );

  const incompatibleBinaryResult = await runCommand(
    {
      label: "non-node-options-removed",
      cmd: "bash",
      args: ["-c", "test -z \"${NODE_OPTIONS+x}\""],
      required: true
    },
    {
      outputDir: temporaryRoot,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=99999" },
      mirrorOutput: false,
      logByteLimit: 4096,
      tailCharacterLimit: 1024
    }
  );
  assert.equal(incompatibleBinaryResult.exit_code, 0);

  const fixture = "process.stdout.write(process.env.NODE_OPTIONS ?? '')";
  const cases = [
    ["empty", { NODE_OPTIONS: "" }, /--max-old-space-size=1536/],
    ["oversized", { NODE_OPTIONS: "--trace-warnings --max-old-space-size=99999" }, /--trace-warnings --max-old-space-size=1536/],
    ["benign", { NODE_OPTIONS: "--trace-warnings --max-old-space-size=256" }, /--trace-warnings --max-old-space-size=256/]
  ];
  for (const [label, nodeEnvironment, expected] of cases) {
    const result = await runCommand(
      { label: `node-options-${label}`, cmd: process.execPath, args: ["-e", fixture], required: true },
      {
        outputDir: temporaryRoot,
        env: { ...process.env, ...nodeEnvironment },
        mirrorOutput: false,
        logByteLimit: 4096,
        tailCharacterLimit: 1024
      }
    );
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout_tail, expected);
    assert.equal((result.stdout_tail.match(/--max-old-space-size=/g) ?? []).length, 1);
  }
});

test("final verification caps large logs and retains only sanitized bounded tails", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "final-verification-memory-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const secret = "unpatterned-private-value-abcdefghijklmnopqrstuvwxyz";
  const logByteLimit = 32 * 1024;
  const tailCharacterLimit = 512;
  const fixture = String.raw`
const secret = process.env.FINAL_VERIFICATION_TEST_SECRET;
const chunk = "x".repeat(8192);
process.stdout.write("stdout-start token=" + secret + "\n");
process.stderr.write("stderr-start Authorization: Bearer " + secret + "\n");
for (let index = 0; index < 64; index += 1) process.stdout.write(chunk);
for (let index = 0; index < 64; index += 1) process.stderr.write(chunk);
process.stdout.write("\nstdout-final token=" + secret + "\n");
process.stderr.write("\nstderr-final cookie=" + secret + "\n");
process.exitCode = 7;
`;

  const result = await runCommand(
    {
      label: "large-output-contract",
      cmd: process.execPath,
      args: ["-e", fixture],
      required: true
    },
    {
      outputDir: temporaryRoot,
      env: {
        ...process.env,
        FINAL_VERIFICATION_TEST_SECRET: secret
      },
      mirrorOutput: false,
      logByteLimit,
      tailCharacterLimit
    }
  );

  assert.equal(result.exit_code, 7);
  assert.equal(result.diagnostic_error, null);
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stderr_truncated, true);
  assert.ok(result.stdout_tail.length <= tailCharacterLimit);
  assert.ok(result.stderr_tail.length <= tailCharacterLimit);
  assert.match(result.stdout_tail, /stdout-final/);
  assert.match(result.stderr_tail, /stderr-final/);

  const [stdoutBytes, stderrBytes, stdoutLog, stderrLog] = await Promise.all([
    stat(result.stdout_path),
    stat(result.stderr_path),
    readFile(result.stdout_path, "utf8"),
    readFile(result.stderr_path, "utf8")
  ]);
  assert.ok(stdoutBytes.size <= logByteLimit);
  assert.ok(stderrBytes.size <= logByteLimit);
  for (const output of [stdoutLog, stderrLog, result.stdout_tail, result.stderr_tail]) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(stdoutLog, /\[redacted\]/);
  assert.match(stderrLog, /\[redacted\]/);
  if (process.platform !== "win32") {
    assert.equal(stdoutBytes.mode & 0o777, 0o600);
    assert.equal(stderrBytes.mode & 0o777, 0o600);
  }
});

test("final verification closes bounded logs when a child cannot spawn", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "final-verification-spawn-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const result = await runCommand(
    {
      label: "missing-command-contract",
      cmd: `missing-final-verification-command-${process.pid}`,
      args: [],
      required: true
    },
    {
      outputDir: temporaryRoot,
      mirrorOutput: false,
      logByteLimit: 1024,
      tailCharacterLimit: 256
    }
  );

  assert.equal(result.exit_code, 1);
  assert.ok(result.diagnostic_error);
  await Promise.all([stat(result.stdout_path), stat(result.stderr_path)]);
});

for (const expectedExitCode of [0, 7]) {
test(`final verification terminates and proves a ${expectedExitCode === 0 ? "successful" : "failed"} leader's daemon group is gone`, {
  skip: process.platform === "win32"
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "final-verification-daemon-"));
  let leaderPid = null;
  let daemonPid = null;
  t.after(async () => {
    killProcessGroup(leaderPid);
    killProcess(daemonPid);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const fixture = String.raw`
const { spawn } = require("node:child_process");
const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: false,
  stdio: "ignore"
});
daemon.unref();
process.stdout.write(JSON.stringify({ leaderPid: process.pid, daemonPid: daemon.pid }));
process.exitCode = ${expectedExitCode};
`;
  const result = await runCommand(
    {
      label: "successful-daemon-contract",
      cmd: process.execPath,
      args: ["-e", fixture],
      required: true
    },
    {
      outputDir: temporaryRoot,
      mirrorOutput: false,
      logByteLimit: 4096,
      tailCharacterLimit: 1024
    }
  );

  const processIds = JSON.parse(result.stdout_tail);
  leaderPid = processIds.leaderPid;
  daemonPid = processIds.daemonPid;
  assert.equal(result.exit_code, expectedExitCode);
  assert.equal(result.diagnostic_error, null);
  assert.equal(await waitForProcessExit(daemonPid), true);
  assert.equal(processGroupExists(leaderPid), false);
});
}

test("final verification bounds and redacts mirror-enabled output with one notice per stream", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "final-verification-console-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const secret = "console-private-value-abcdefghijklmnopqrstuvwxyz";
  const consoleByteLimit = 4096;
  const stdoutMirror = collectingWritable();
  const stderrMirror = collectingWritable();
  const fixture = String.raw`
const secret = process.env.FINAL_VERIFICATION_CONSOLE_TEST_SECRET;
const chunk = "y".repeat(8192);
process.stdout.write("stdout-secret=" + secret + "\n");
process.stderr.write("stderr-secret=" + secret + "\n");
for (let index = 0; index < 64; index += 1) {
  process.stdout.write(chunk);
  process.stderr.write(chunk);
}
process.stdout.write("\nstdout-drained-final\n");
process.stderr.write("\nstderr-drained-final\n");
`;

  const result = await runCommand(
    {
      label: "bounded-console-contract",
      cmd: process.execPath,
      args: ["-e", fixture],
      required: true
    },
    {
      outputDir: temporaryRoot,
      env: {
        ...process.env,
        FINAL_VERIFICATION_CONSOLE_TEST_SECRET: secret
      },
      mirrorOutput: true,
      mirrorStreams: {
        stdout: stdoutMirror.stream,
        stderr: stderrMirror.stream
      },
      logByteLimit: 8192,
      tailCharacterLimit: 512,
      consoleByteLimit
    }
  );

  const stdoutConsole = stdoutMirror.text();
  const stderrConsole = stderrMirror.text();
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout_console_truncated, true);
  assert.equal(result.stderr_console_truncated, true);
  assert.equal(countMatches(stdoutConsole, /output truncated/g), 1);
  assert.equal(countMatches(stderrConsole, /output truncated/g), 1);
  assert.ok(Buffer.byteLength(stdoutConsole) <= consoleByteLimit + 160);
  assert.ok(Buffer.byteLength(stderrConsole) <= consoleByteLimit + 160);
  assert.equal(stdoutConsole.includes(secret), false);
  assert.equal(stderrConsole.includes(secret), false);
  assert.match(stdoutConsole, /\[redacted\]/);
  assert.match(stderrConsole, /\[redacted\]/);
  assert.match(result.stdout_tail, /stdout-drained-final/);
  assert.match(result.stderr_tail, /stderr-drained-final/);
});

test("final verification atomically replaces an existing summary with mode 0600", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "final-verification-summary-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const latestPath = path.join(temporaryRoot, "final-verification-latest.json");
  await writeFile(latestPath, "stale", { mode: 0o644 });
  await chmod(latestPath, 0o644);

  const summary = {
    status: "canceled",
    stdout_tail: "bounded",
    stderr_tail: "redacted"
  };
  await writeSummary(latestPath, summary);

  const [metadata, parsed, entries] = await Promise.all([
    stat(latestPath),
    readFile(latestPath, "utf8").then(JSON.parse),
    readdir(temporaryRoot)
  ]);
  assert.deepEqual(parsed, summary);
  if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
  assert.deepEqual(entries, [path.basename(latestPath)]);
});

for (const cancellationSignal of ["SIGINT", "SIGTERM"]) {
test(`${cancellationSignal} cancels the run, drains its group, writes a private summary, and re-signals`, {
  skip: process.platform === "win32",
  timeout: 15_000
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "final-verification-signal-"));
  const outputDir = path.join(temporaryRoot, "logs");
  const latestPath = path.join(temporaryRoot, "latest.json");
  const markerPath = path.join(temporaryRoot, "active-processes.json");
  const secondMarkerPath = path.join(temporaryRoot, "second-command-ran");
  let verifier = null;
  let verifierStderr = "";
  let activeProcesses = null;
  t.after(async () => {
    killProcess(verifier?.pid);
    killProcessGroup(activeProcesses?.leaderPid);
    killProcess(activeProcesses?.daemonPid);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const signalChildFixture = String.raw`
  const { spawn } = require("node:child_process");
  const { writeFileSync } = require("node:fs");
  const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: "ignore"
  });
  daemon.unref();
  writeFileSync(process.argv[1], JSON.stringify({ leaderPid: process.pid, daemonPid: daemon.pid }), {
    mode: 0o600
  });
  setInterval(() => {}, 1000);
`;
  const verifierFixture = `
const [moduleUrl, outputDir, latestPath, markerPath, secondMarkerPath] = process.argv.slice(1);
const { runFinalVerification } = await import(moduleUrl);
const childFixture = ${JSON.stringify(signalChildFixture)};
await runFinalVerification({
  commands: [
    {
      label: "signal-contract",
      cmd: process.execPath,
      args: ["-e", childFixture, markerPath],
      required: true
    },
    {
      label: "must-not-launch-after-signal",
      cmd: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'launched')", secondMarkerPath],
      required: true
    }
  ],
  outputDir,
  latestPath,
  mirrorOutput: false,
  env: process.env
});
`;
  verifier = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      verifierFixture,
      pathToFileURL(path.join(repositoryRoot, "scripts/run-final-verification.mjs")).href,
      outputDir,
      latestPath,
      markerPath,
      secondMarkerPath
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=256",
        FINAL_VERIFICATION_LOG_BYTE_LIMIT: "4096",
        FINAL_VERIFICATION_TAIL_CHARACTER_LIMIT: "256",
        FINAL_VERIFICATION_CONSOLE_BYTE_LIMIT: "1024"
      }
    }
  );
  verifier.stderr.on("data", (chunk) => {
    verifierStderr = `${verifierStderr}${chunk}`.slice(-4096);
  });

  try {
    activeProcesses = await waitForJson(markerPath);
  } catch (error) {
    throw new Error(`${error.message}\nVerifier stderr:\n${verifierStderr}`);
  }
  verifier.kill(cancellationSignal);
  const outcome = await waitForChildExit(verifier);
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, cancellationSignal);

  const summary = JSON.parse(await readFile(latestPath, "utf8"));
  assert.equal(summary.status, "canceled");
  assert.equal(summary.canceled_signal, cancellationSignal);
  assert.ok(summary.canceled_at);
  assert.ok(summary.finished_at);
  assert.equal(summary.planned_command_count, 2);
  assert.equal(summary.command_count, 1);
  assert.equal(summary.commands.length, 1);
  assert.equal(summary.commands[0].signal, cancellationSignal);
  assert.equal(summary.commands[0].exit_code, 1);
  assert.equal(await waitForProcessExit(activeProcesses.leaderPid), true);
  assert.equal(await waitForProcessExit(activeProcesses.daemonPid), true);
  assert.equal(processGroupExists(activeProcesses.leaderPid), false);
  assert.equal(await fileExists(secondMarkerPath), false);

  const [summaryMetadata, stdoutMetadata, stderrMetadata] = await Promise.all([
    stat(latestPath),
    stat(summary.commands[0].stdout_path),
    stat(summary.commands[0].stderr_path)
  ]);
  if (process.platform !== "win32") {
    assert.equal(summaryMetadata.mode & 0o777, 0o600);
    assert.equal(stdoutMetadata.mode & 0o777, 0o600);
    assert.equal(stderrMetadata.mode & 0o777, 0o600);
  }
});
}

function collectingWritable() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8")
  };
}

function countMatches(value, expression) {
  return [...value.matchAll(expression)].length;
}

function processExists(processId) {
  if (!processId) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processGroupExists(processGroupId) {
  if (!processGroupId || process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function killProcess(processId) {
  if (!processId) return;
  try {
    process.kill(processId, "SIGKILL");
  } catch {}
}

function killProcessGroup(processGroupId) {
  if (!processGroupId || process.platform === "win32") return;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch {}
}

async function waitForProcessExit(processId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(processId)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

async function waitForJson(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
