import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const runDir = path.join(root, "outputs", "longrun");
const activePath = path.join(runDir, "active-run.json");
const startedAt = process.env.LONG_RUN_START_AT ?? new Date().toISOString();
const runId = process.env.LONG_RUN_ID ?? `background-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const stdoutPath = path.join(runDir, `${runId}.stdout.log`);
const stderrPath = path.join(runDir, `${runId}.stderr.log`);
const args = [
  path.join("scripts", "run-long-cycle.mjs"),
  "--minutes=360",
  "--checkpoint-minutes=30",
  "--max-companies=197",
  "--workers=8",
  "--delay-ms=1200"
];

await mkdir(runDir, { recursive: true });

const existing = await readJson(activePath, null);
if (existing?.pid && isProcessRunning(existing.pid)) {
  console.log(
    JSON.stringify(
      {
        status: "already_running",
        pid: existing.pid,
        runId: existing.runId,
        activePath
      },
      null,
      2
    )
  );
  process.exit(0);
}

await open(stdoutPath, "a").then((handle) => handle.close());
await open(stderrPath, "a").then((handle) => handle.close());
const stdoutFd = openSync(stdoutPath, "a");
const stderrFd = openSync(stderrPath, "a");

const child = spawn(process.execPath, args, {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", stdoutFd, stderrFd],
  env: {
    ...process.env,
    LONG_RUN_START_AT: startedAt,
    LONG_RUN_ID: runId
  }
});

child.unref();
closeSync(stdoutFd);
closeSync(stderrFd);

const active = {
  runId,
  pid: child.pid,
  startedAt,
  launchedAt: new Date().toISOString(),
  command: [process.execPath, ...args].join(" "),
  stdoutPath,
  stderrPath,
  statusPath: path.join(root, "docs", "LONG_RUN_STATUS.md"),
  eventLogPath: path.join(runDir, `${runId}.json`)
};
await writeFile(activePath, JSON.stringify(active, null, 2));

console.log(JSON.stringify({ status: "started", ...active }, null, 2));

function isProcessRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
