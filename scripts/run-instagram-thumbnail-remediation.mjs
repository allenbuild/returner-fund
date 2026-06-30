import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const runId = process.env.LONG_RUN_ID ?? `instagram-thumbnails-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const startedAt = process.env.LONG_RUN_START_AT ?? new Date().toISOString();
const durationMinutes = numberArg("--minutes") ?? 360;
const checkpointMinutes = numberArg("--checkpoint-minutes") ?? 30;
const discoveryShardSize = numberArg("--discovery-shard-size") ?? 12;
const instagramWorkers = Math.max(1, Math.min(numberArg("--instagram-workers") ?? 1, 2));
const discoveryWorkers = Math.max(1, Math.min(numberArg("--discovery-workers") ?? 2, 4));
const thumbnailLimit = numberArg("--thumbnail-limit") ?? 30;
const xThumbnailLimit = numberArg("--x-thumbnail-limit") ?? 25;
const linkPreviewLimit = numberArg("--link-preview-limit") ?? 40;
const once = hasArg("--once");
const startedAtMs = new Date(startedAt).valueOf();
const stopAtMs = startedAtMs + durationMinutes * 60_000;
const checkpointEveryMs = checkpointMinutes * 60_000;
let nextCheckpointAtMs = startedAtMs;
let discoveryOffset = numberArg("--offset") ?? 0;
let cycle = 0;
const events = [];

await fs.mkdir("outputs", { recursive: true });
await fs.mkdir(path.join("outputs", "longrun"), { recursive: true });
await writeActiveRun();
await writeEvent("run_started", {
  runId,
  startedAt,
  durationMinutes,
  checkpointMinutes,
  discoveryShardSize,
  discoveryWorkers,
  instagramWorkers,
  thumbnailLimit,
  xThumbnailLimit,
  linkPreviewLimit
});

await checkpoint("initial");

do {
  cycle += 1;
  await writeEvent("cycle_started", { cycle, discoveryOffset });

  await run("npm", ["run", "debug:instagram-coverage"], { phase: "measure-instagram" });
  await run("npm", ["run", "debug:thumbnails"], { phase: "measure-thumbnails" });

  await run(
    "node",
    [
      "scripts/discover-instagram-overrides.mjs",
      "--web-search",
      "--write",
      "--append",
      "--promote-search",
      "--promote-founder-search",
      `--workers=${discoveryWorkers}`,
      `--offset=${discoveryOffset}`,
      `--max-companies=${discoveryShardSize}`
    ],
    { phase: "instagram-discovery" }
  );
  discoveryOffset += discoveryShardSize;
  if (discoveryOffset >= 197) {
    discoveryOffset = 0;
  }

  await run(
    "node",
    [
      "scripts/fetch-logged-in-social-traction.mjs",
      "--platforms=instagram",
      "--entities=all",
      `--workers=${instagramWorkers}`,
      "--limit=40",
      "--scrolls=16",
      "--timeout-ms=120000",
      "--delay-ms=2500",
      "--retry-empty"
    ],
    { phase: "instagram-ingest" }
  );

  await run(
    "node",
    [
      "scripts/backfill-evidence-thumbnails.mjs",
      "--platform=instagram",
      "--cache-instagram",
      "--force",
      `--limit=${thumbnailLimit}`,
      `--max-rows=${thumbnailLimit}`,
      "--delay-ms=1200",
      "--timeout-ms=90000",
      "--checkpoint-rows=5"
    ],
    { phase: "instagram-thumbnails" }
  );

  await run(
    "node",
    [
      "scripts/backfill-evidence-thumbnails.mjs",
      "--platform=x",
      "--cache-x",
      "--validate-x",
      "--force",
      "--thumbnail-source=local-cache",
      `--limit=${xThumbnailLimit}`,
      `--max-rows=${xThumbnailLimit}`,
      "--delay-ms=300",
      "--timeout-ms=90000",
      "--checkpoint-rows=5"
    ],
    { phase: "x-fallback-thumbnails" }
  );

  await run(
    "node",
    [
      "scripts/backfill-evidence-thumbnails.mjs",
      "--platform=x",
      "--cache-x",
      "--validate-x",
      "--missing-only",
      `--limit=${xThumbnailLimit}`,
      `--max-rows=${xThumbnailLimit}`,
      "--delay-ms=300",
      "--timeout-ms=90000",
      "--checkpoint-rows=5"
    ],
    { phase: "x-missing-thumbnails" }
  );

  await run(
    "node",
    [
      "scripts/backfill-evidence-thumbnails.mjs",
      "--fetch-link-preview",
      "--missing-only",
      "--link-preview-platforms=web,rss,hacker_news,linkedin,product_hunt,reddit,bilibili",
      `--limit=${linkPreviewLimit}`,
      `--max-rows=${linkPreviewLimit}`,
      "--delay-ms=350",
      "--timeout-ms=30000",
      "--checkpoint-rows=10"
    ],
    { phase: "link-preview-thumbnails" }
  );

  await run("npm", ["run", "debug:instagram-coverage"], { phase: "post-measure-instagram" });
  await run("npm", ["run", "debug:thumbnails"], { phase: "post-measure-thumbnails" });
  await checkpoint(`cycle-${cycle}`);
  await writeEvent("cycle_finished", { cycle, nextDiscoveryOffset: discoveryOffset });
} while (!once && Date.now() < stopAtMs);

await checkpoint("final");
await writeEvent("run_finished", { elapsedMinutes: elapsedMinutes(), cycles: cycle, nextDiscoveryOffset: discoveryOffset });
await writeLog();

console.log(
  JSON.stringify(
    {
      runId,
      elapsedMinutes: elapsedMinutes(),
      cycles: cycle,
      nextDiscoveryOffset: discoveryOffset,
      log: path.join("outputs", "longrun", `${runId}.json`)
    },
    null,
    2
  )
);

async function run(cmd, args, meta) {
  if (!once && Date.now() >= stopAtMs) return;
  const started = Date.now();
  await writeEvent("command_started", { ...meta, command: [cmd, ...args].join(" ") });
  const result = await exec(cmd, args);
  await writeEvent("command_finished", {
    ...meta,
    command: [cmd, ...args].join(" "),
    exitCode: result.exitCode,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  });
  await checkpointIfDue();
}

function exec(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: true,
      env: { ...process.env, LONG_RUN_ID: runId, LONG_RUN_START_AT: startedAt },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const deadlineTimer =
      once || Date.now() >= stopAtMs
        ? null
        : setTimeout(() => {
            stderr += "\nStopped child command because the remediation window elapsed.";
            terminateChildTree(child);
          }, Math.max(0, stopAtMs - Date.now()));

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
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve({ exitCode, stdout, stderr });
    });
    child.on("error", (error) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

async function checkpointIfDue() {
  if (Date.now() < nextCheckpointAtMs) return;
  await checkpoint("scheduled");
}

async function checkpoint(reason) {
  nextCheckpointAtMs = Date.now() + checkpointEveryMs;
  await writeActiveRun();
  await writeLog();
  await runCheckpointCommand(reason);
}

async function runCheckpointCommand(reason) {
  await writeEvent("checkpoint_started", { reason, elapsedMinutes: elapsedMinutes() });
  const result = await exec("npm", ["run", "longrun:checkpoint"]);
  await writeEvent("checkpoint_finished", {
    reason,
    exitCode: result.exitCode,
    elapsedMinutes: elapsedMinutes(),
    stderrTail: tail(result.stderr)
  });
  await writeLog();
}

async function writeActiveRun() {
  await fs.writeFile(
    path.join("outputs", "longrun", "active-run.json"),
    JSON.stringify(
      {
        runId,
        startedAt,
        objective: "Instagram coverage plus real thumbnail remediation across YC Spring 2026.",
        nextDiscoveryOffset: discoveryOffset,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

async function writeEvent(type, payload) {
  events.push({ type, at: new Date().toISOString(), payload });
  await writeLog();
}

async function writeLog() {
  await fs.writeFile(
    path.join("outputs", "longrun", `${runId}.json`),
    JSON.stringify({ runId, startedAt, eventLog: events }, null, 2)
  );
}

function terminateChildTree(child) {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}

function numberArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!match) return null;
  const value = Number(match.slice(prefix.length));
  return Number.isFinite(value) ? value : null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function elapsedMinutes() {
  return Math.max(0, Math.floor((Date.now() - startedAtMs) / 60_000));
}

function tail(value) {
  return String(value ?? "").split(/\r?\n/).filter(Boolean).slice(-20).join("\n");
}
