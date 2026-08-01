import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const runDir = path.join(root, "outputs", "longrun");
const activePath = path.join(runDir, "active-run.json");
const active = await readJson(activePath, null);
const latest = await latestEventLog();
const activeEventLog = await eventLogForActive(active);
const orphanedTerminalOutputs = await terminalOutputsWithoutEventLogs();
const liveCheckpoint = await currentSweepCheckpointSummary(active);
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
  activeEventLog,
  stateIntegrity: {
    activeMatchesLatest:
      !active?.runId || !latest?.runId || active.runId === latest.runId,
    activeEventLogPresent: !active?.runId || Boolean(activeEventLog),
    activeRunId: active?.runId ?? null,
    latestRunId: latest?.runId ?? null,
    orphanedTerminalOutputCount: orphanedTerminalOutputs.length
  },
  orphanedTerminalOutputs,
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
      runId: payload?.runId ?? null,
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

async function eventLogForActive(activeRun) {
  if (!activeRun?.runId) return null;
  const filePath = path.join(runDir, `${activeRun.runId}.json`);
  const payload = await readJson(filePath, null);
  if (!payload || payload.runId !== activeRun.runId) return null;
  const eventLog = Array.isArray(payload.eventLog) ? payload.eventLog : [];
  return {
    path: filePath,
    runId: payload.runId,
    eventCount: eventLog.length,
    lastEvent: eventLog.at(-1) ?? null
  };
}

async function terminalOutputsWithoutEventLogs() {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = await Promise.all(
    entries
      .filter((entry) =>
        entry.isFile()
        && /^source-sweep-[A-Za-z0-9._-]+\.stdout\.log$/u.test(entry.name)
      )
      .map(async (entry) => {
        const runId = entry.name.slice(0, -".stdout.log".length);
        if (existsSync(path.join(runDir, `${runId}.json`))) return null;
        const stdoutPath = path.join(runDir, entry.name);
        const terminal = parseTerminalRunSummary(await tailFile(stdoutPath, 64_000));
        return terminal?.runId === runId
          ? {
              runId,
              status: terminal.status,
              elapsedMinutes: terminal.elapsedMinutes,
              stdoutPath,
              expectedEventLogPath: path.join(runDir, `${runId}.json`)
            }
          : null;
      })
  );
  return results.filter(Boolean);
}

function parseTerminalRunSummary(stdout) {
  const tail = String(stdout).trim();
  for (
    let index = tail.lastIndexOf("\n{");
    index >= -1;
    index = index > 0 ? tail.lastIndexOf("\n{", index - 1) : -2
  ) {
    try {
      const parsed = JSON.parse(tail.slice(index + 1));
      if (
        typeof parsed?.runId === "string"
        && ["complete", "smoke_complete", "deadline_complete", "failed", "interrupted"]
          .includes(parsed?.status)
        && Number.isFinite(Number(parsed?.elapsedMinutes))
      ) {
        return parsed;
      }
    } catch {
      // Continue to the previous JSON object in the captured tail.
    }
    if (index === -1) break;
  }
  return null;
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

async function currentSweepCheckpointSummary(activeRun) {
  const idempotencyKey = activeRun?.currentSweep?.idempotencyKey;
  if (!idempotencyKey) return null;

  const workRoot = path.join(
    root,
    "work",
    "autonomous-ingestion",
    safePathSegment(idempotencyKey)
  );
  let entries;
  try {
    entries = await readdir(workRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const checkpointFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^checkpoint-public-.+-shard-\d+-of-\d+\.json$/.test(entry.name)
    )
    .map((entry) => path.join(workRoot, entry.name))
    .sort();
  const checkpoints = (
    await Promise.all(
      checkpointFiles.map(async (filePath) => ({
        filePath,
        checkpoint: await readJson(filePath, null)
      }))
    )
  ).filter((entry) => entry.checkpoint);
  const aggregate = summarizeCheckpoints(checkpoints.map((entry) => entry.checkpoint));

  return {
    idempotencyKey,
    workRoot,
    checkpointCount: checkpoints.length,
    ...aggregate,
    shards: checkpoints.map(({ filePath, checkpoint }) => ({
      path: filePath,
      ...checkpointDescriptor(filePath),
      ...summarizeCheckpoints([checkpoint])
    }))
  };
}

function summarizeCheckpoints(checkpoints) {
  const attempts = checkpoints.flatMap((checkpoint) => Object.values(checkpoint.attempts ?? {}));
  const evidence = checkpoints.flatMap((checkpoint) => checkpoint.evidence ?? []);
  const needsReview = checkpoints.flatMap((checkpoint) => checkpoint.needsReview ?? []);
  const failures = checkpoints.flatMap((checkpoint) => checkpoint.failures ?? []);
  const discoveryAttempts = checkpoints.flatMap(
    (checkpoint) => checkpoint.discoveryAttempts ?? []
  );
  const sourceDiscoveryPaths = checkpoints.flatMap(
    (checkpoint) => checkpoint.sourceDiscoveryPaths ?? []
  );

  return {
    attemptCount: attempts.length,
    attemptStatusCounts: countBy(attempts, (attempt) => attempt.status ?? "unknown"),
    rows: {
      evidence: evidence.length,
      needsReview: needsReview.length,
      failures: failures.length,
      discoveryAttempts: discoveryAttempts.length,
      sourceDiscoveryPaths: sourceDiscoveryPaths.length
    },
    platformRows: {
      evidence: countBy(evidence, (row) => row.platform ?? "unknown"),
      needsReview: countBy(needsReview, (row) => row.platform ?? "unknown"),
      failures: countBy(failures, (row) => row.platform ?? "unknown")
    }
  };
}

function checkpointDescriptor(filePath) {
  const match = path.basename(filePath).match(
    /^checkpoint-public-(.+)-shard-(\d+)-of-(\d+)\.json$/
  );
  return match
    ? {
        batchSlug: match[1].toUpperCase(),
        shardIndex: Number(match[2]),
        shardCount: Number(match[3])
      }
    : {};
}

function safePathSegment(value) {
  const source = String(value);
  const prefix =
    source
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "run";
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
