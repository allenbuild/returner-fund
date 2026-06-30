import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const startedAt = process.env.LONG_RUN_START_AT ?? new Date().toISOString();
const runId = process.env.LONG_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const durationMinutes = numberArg("--minutes") ?? numberArg("--duration-minutes") ?? envNumber("LONG_RUN_MINUTES") ?? 360;
const checkpointMinutes = numberArg("--checkpoint-minutes") ?? envNumber("LONG_RUN_CHECKPOINT_MINUTES") ?? 30;
const once = hasArg("--once") || envFlag("LONG_RUN_ONCE");
const skipBuild = hasArg("--skip-build") || envFlag("LONG_RUN_SKIP_BUILD");
const skipTests = hasArg("--skip-tests") || envFlag("LONG_RUN_SKIP_TESTS");
const skipBroadIngest = hasArg("--skip-broad-ingest") || envFlag("LONG_RUN_SKIP_BROAD_INGEST");
const maxCompanies = numberArg("--max-companies") ?? envNumber("LONG_RUN_MAX_COMPANIES") ?? 197;
const workers = numberArg("--workers") ?? envNumber("LONG_RUN_WORKERS") ?? 8;
const delayMs = numberArg("--delay-ms") ?? envNumber("LONG_RUN_DELAY_MS") ?? 1200;
const launchedAtMs = Date.now();
const parsedStartedAtMs = new Date(startedAt).valueOf();
const startedAtMs = Number.isFinite(parsedStartedAtMs) ? parsedStartedAtMs : launchedAtMs;
const stopAtMs = startedAtMs + Math.max(1, durationMinutes) * 60_000;
const checkpointEveryMs = Math.max(1, checkpointMinutes) * 60_000;
let nextCheckpointAtMs = startedAtMs;
const eventLog = [];

await mkdir("outputs", { recursive: true });
await mkdir(path.join("outputs", "longrun"), { recursive: true });

await recordEvent("run_started", {
  runId,
  startedAt,
  durationMinutes,
  checkpointMinutes,
  maxCompanies,
  workers,
  delayMs,
  once,
  skipBuild,
  skipTests,
  skipBroadIngest
});

const phasePlan = [
  phase("baseline", [
    !skipTests && command("npm", ["run", "typecheck"]),
    !skipTests && command("npm", ["test"]),
    !skipBuild && command("npm", ["run", "build"]),
    command("npm", ["run", "debug:coverage"]),
    command("npm", ["run", "debug:workers"]),
    command("npm", ["run", "debug:duplicates"]),
    command("npm", ["run", "instagram:doctor"])
  ]),
  phase("targeted-heyclicky", [
    command("node", [
      "scripts/fetch-public-traction.mjs",
      "--social=all",
      "--company=HeyClicky",
      `--workers=${Math.min(4, workers)}`,
      "--delay-ms=500",
      "--force",
      "--discover-missing-social"
    ]),
    command("node", [
      "scripts/fetch-public-traction.mjs",
      "--social=all",
      "--platform=instagram",
      "--company=HeyClicky",
      "--workers=2",
      "--delay-ms=1500",
      "--force",
      "--discover-missing-social"
    ]),
    command("node", [
      "scripts/fetch-public-traction.mjs",
      "--social=all",
      "--platform=x",
      "--company=HeyClicky",
      "--workers=2",
      "--delay-ms=1500",
      "--force"
    ])
  ]),
  phase("broad-ingest", skipBroadIngest ? [] : [
    command("node", [
      "scripts/fetch-public-traction.mjs",
      "--social=all",
      `--max-companies=${maxCompanies}`,
      `--workers=${workers}`,
      `--delay-ms=${delayMs}`,
      "--discover-missing-social"
    ])
  ]),
  phase("forced-public-platform-retries", skipBroadIngest ? [] : [
    command("node", [
      "scripts/fetch-public-traction.mjs",
      "--social=all",
      "--platform=x",
      `--max-companies=${maxCompanies}`,
      "--workers=2",
      "--delay-ms=1500",
      "--force",
      "--discover-missing-social"
    ]),
    command("node", [
      "scripts/fetch-public-traction.mjs",
      "--social=all",
      "--platform=instagram",
      `--max-companies=${maxCompanies}`,
      "--workers=2",
      "--delay-ms=1800",
      "--force",
      "--discover-missing-social"
    ]),
    command("node", [
      "scripts/fetch-public-traction.mjs",
      "--social=none",
      "--platform=product_hunt",
      `--max-companies=${maxCompanies}`,
      "--workers=2",
      "--delay-ms=1000",
      "--force"
    ])
  ]),
  phase("analysis", [
    command("npm", ["run", "discovery:plan"]),
    command("npm", ["run", "scoring:experiments"]),
    command("npm", ["run", "debug:anomalies"]),
    command("npm", ["run", "debug:coverage"]),
    command("npm", ["run", "debug:workers"]),
    command("npm", ["run", "debug:duplicates"])
  ])
];

do {
  for (const currentPhase of phasePlan) {
    if (Date.now() >= stopAtMs && !once) break;
    await runPhase(currentPhase);
    await checkpointIfDue({ force: once });
  }
} while (!once && Date.now() < stopAtMs);

await checkpointIfDue({ force: true });
await recordEvent("run_finished", { elapsedMinutes: elapsedMinutes() });
await writeRunLog();
console.log(
  JSON.stringify(
    {
      runId,
      elapsedMinutes: elapsedMinutes(),
      eventLog: path.join("outputs", "longrun", `${runId}.json`),
      status: "complete_for_requested_window"
    },
    null,
    2
  )
);

function phase(name, commands) {
  return { name, commands: commands.filter(Boolean) };
}

function command(cmd, args, options = {}) {
  return { cmd, args, options };
}

async function runPhase(currentPhase) {
  await recordEvent("phase_started", { phase: currentPhase.name });
  for (const task of currentPhase.commands) {
    if (Date.now() >= stopAtMs && !once) break;
    await runCommand(task);
    await checkpointIfDue({ force: false });
  }
  await recordEvent("phase_finished", { phase: currentPhase.name });
}

async function runCommand(task) {
  const started = Date.now();
  await recordEvent("command_started", { command: commandLine(task) });
  const result = await execFile(task.cmd, task.args, task.options, { allowCheckpoints: true, deadlineMs: stopAtMs });
  await recordEvent("command_finished", {
    command: commandLine(task),
    exitCode: result.exitCode,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  });
}

function execFile(cmd, args, options, runtime = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: true,
      env: { ...process.env, LONG_RUN_START_AT: startedAt, LONG_RUN_ID: runId },
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    let deadlineReached = false;
    const checkpointTimer =
      runtime.allowCheckpoints === false
        ? null
        : setInterval(() => {
            void checkpointIfDue({ force: false });
          }, 10_000);
    const deadlineTimer =
      runtime.deadlineMs && !once
        ? setTimeout(() => {
            deadlineReached = true;
            stderr += `\nStopped command because the long-run duration window elapsed.`;
            terminateChildTree(child);
          }, Math.max(0, runtime.deadlineMs - Date.now()))
        : null;
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      stdout += value;
      process.stdout.write(value);
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      stderr += value;
      process.stderr.write(value);
    });
    child.on("close", (exitCode) => {
      if (checkpointTimer) clearInterval(checkpointTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve({ exitCode: deadlineReached ? 124 : exitCode, stdout, stderr });
    });
    child.on("error", (error) => {
      if (checkpointTimer) clearInterval(checkpointTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

function terminateChildTree(child) {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => child.kill());
    return;
  }

  child.kill("SIGTERM");
}

async function checkpointIfDue({ force }) {
  if (!force && Date.now() < nextCheckpointAtMs) return;
  nextCheckpointAtMs = Date.now() + checkpointEveryMs;
  await recordEvent("checkpoint_started", { elapsedMinutes: elapsedMinutes() });
  await execFile("npm", ["run", "longrun:checkpoint"], {}, { allowCheckpoints: false });
  await writeRunLog();
  await recordEvent("checkpoint_finished", { elapsedMinutes: elapsedMinutes() });
}

async function recordEvent(type, payload) {
  eventLog.push({
    type,
    at: new Date().toISOString(),
    elapsedMinutes: elapsedMinutes(),
    ...payload
  });
  await writeRunLog();
}

async function writeRunLog() {
  await writeFile(path.join("outputs", "longrun", `${runId}.json`), JSON.stringify({ runId, startedAt, eventLog }, null, 2));
}

function commandLine(task) {
  return [task.cmd, ...task.args].join(" ");
}

function tail(value, max = 1600) {
  const cleaned = String(value ?? "").trim();
  return cleaned.length > max ? cleaned.slice(-max) : cleaned;
}

function elapsedMinutes() {
  return Math.floor((Date.now() - startedAtMs) / 60_000);
}

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.split("=").slice(1).join("=");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function envNumber(name) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : null;
}

function envFlag(name) {
  return /^(1|true|yes)$/i.test(process.env[name] ?? "");
}
