import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const runDir = path.join(root, "outputs", "longrun");
const activePath = path.join(runDir, "active-run.json");
const requestedMinutes = numberArg("--minutes") ?? 300;
const checkpointMinutes = numberArg("--checkpoint-minutes") ?? 5;

await mkdir(runDir, { recursive: true });

const existing = await readJson(activePath, null);
if (existing?.pid && isProcessRunning(existing.pid)) {
  console.log(JSON.stringify({
    status: "already_running",
    pid: existing.pid,
    runId: existing.runId,
    activePath
  }, null, 2));
  process.exit(0);
}

const existingDeadlineMs = new Date(existing?.deadlineAt ?? 0).valueOf();
const canResume =
  existing?.runId &&
  existing?.startedAt &&
  !["complete", "smoke_complete"].includes(existing?.status) &&
  Number.isFinite(existingDeadlineMs) &&
  existingDeadlineMs > Date.now();
const startedAt = canResume
  ? existing.startedAt
  : process.env.LONG_RUN_START_AT ?? new Date().toISOString();
const runId = canResume
  ? existing.runId
  : process.env.LONG_RUN_ID ?? `source-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const durationMinutes = canResume
  ? Number(existing.durationMinutes ?? requestedMinutes)
  : requestedMinutes;
const stdoutPath = canResume
  ? existing.stdoutPath
  : path.join(runDir, `${runId}.stdout.log`);
const stderrPath = canResume
  ? existing.stderrPath
  : path.join(runDir, `${runId}.stderr.log`);
const args = [
  path.join("scripts", "run-long-cycle.mjs"),
  `--minutes=${durationMinutes}`,
  `--checkpoint-minutes=${checkpointMinutes}`
];

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

const deadlineAt = new Date(
  new Date(startedAt).valueOf() + Math.max(1, durationMinutes) * 60_000
).toISOString();
const active = {
  ...(canResume ? existing : {}),
  runId,
  pid: child.pid,
  startedAt,
  deadlineAt,
  durationMinutes,
  launchedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
  command: [process.execPath, ...args].join(" "),
  stdoutPath,
  stderrPath,
  statusPath: path.join(root, "docs", "LONG_RUN_STATUS.md"),
  eventLogPath: path.join(runDir, `${runId}.json`),
  status: canResume ? "resuming" : "running"
};
await writeJsonAtomic(activePath, active);

console.log(JSON.stringify({
  status: canResume ? "resumed" : "started",
  ...active
}, null, 2));

function numberArg(name) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

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

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}
