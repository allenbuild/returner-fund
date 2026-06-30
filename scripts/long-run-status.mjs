import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const runDir = path.join(root, "outputs", "longrun");
const activePath = path.join(runDir, "active-run.json");
const active = await readJson(activePath, null);
const latest = await latestEventLog();
const liveCheckpoint = summarizeLiveCheckpoint(await readJson(path.join(root, "work", "public-traction-checkpoint.json"), null));
const statusDoc = existsSync(path.join(root, "docs", "LONG_RUN_STATUS.md"))
  ? await readFile(path.join(root, "docs", "LONG_RUN_STATUS.md"), "utf8")
  : "";

const payload = {
  active: active
    ? {
        ...active,
        running: active.pid ? isProcessRunning(active.pid) : false,
        elapsedMinutesFromStart: elapsedMinutes(active.startedAt),
        elapsedMinutesFromLaunch: elapsedMinutes(active.launchedAt),
        stdoutTail: await tailFile(active.stdoutPath, 2000),
        stderrTail: await tailFile(active.stderrPath, 2000)
      }
    : null,
  latestEventLog: latest,
  liveIngestionCheckpoint: liveCheckpoint,
  longRunStatusExcerpt: statusDoc.slice(0, 2200)
};

console.log(JSON.stringify(payload, null, 2));

async function latestEventLog() {
  try {
    const entries = await readdir(runDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "active-run.json")
        .map(async (entry) => {
          const filePath = path.join(runDir, entry.name);
          return { filePath, stat: await stat(filePath) };
        })
    );
    const latest = files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
    if (!latest) return null;
    const payload = await readJson(latest.filePath, null);
    const eventLog = payload?.eventLog ?? [];
    return {
      path: latest.filePath,
      eventCount: eventLog.length,
      lastEvent: eventLog.at(-1) ?? null,
      runningCommand: currentCommand(eventLog),
      latestEventAgeSeconds: eventLog.at(-1)?.at ? Math.max(0, Math.round((Date.now() - new Date(eventLog.at(-1).at).getTime()) / 1000)) : null,
      lastFinishedCommand: [...eventLog].reverse().find((event) => event.type === "command_finished") ?? null
    };
  } catch {
    return null;
  }
}

function currentCommand(eventLog) {
  const lastCommandEvent = [...eventLog]
    .reverse()
    .find((event) => event.type === "command_started" || event.type === "command_finished");
  return lastCommandEvent?.type === "command_started" ? lastCommandEvent : null;
}

async function tailFile(filePath, maxChars) {
  if (!filePath || !existsSync(filePath)) return "";
  const text = await readFile(filePath, "utf8");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

async function readJson(filePath, fallback) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function elapsedMinutes(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 60_000));
}

function summarizeLiveCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  const attempts = Object.values(checkpoint.attempts ?? {});
  return {
    attemptCount: attempts.length,
    attemptStatusCounts: countBy(attempts, (attempt) => attempt.status ?? "unknown"),
    rows: {
      evidence: checkpoint.evidence?.length ?? 0,
      needsReview: checkpoint.needsReview?.length ?? 0,
      failures: checkpoint.failures?.length ?? 0,
      discoveryAttempts: checkpoint.discoveryAttempts?.length ?? 0,
      sourceDiscoveryPaths: checkpoint.sourceDiscoveryPaths?.length ?? 0
    },
    platformRows: {
      evidence: countBy(checkpoint.evidence ?? [], (row) => row.platform ?? "unknown"),
      needsReview: countBy(checkpoint.needsReview ?? [], (row) => row.platform ?? "unknown"),
      failures: countBy(checkpoint.failures ?? [], (row) => row.platform ?? "unknown")
    }
  };
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
