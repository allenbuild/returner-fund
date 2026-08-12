import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const openCliProcessOwnerContext = new AsyncLocalStorage();
let cachedRuntime = null;
const OPENCLI_PROCESS_SCAN_INTERVAL_MS = 10;
const OPENCLI_PROCESS_FREEZE_GRACE_MS = 250;
const OPENCLI_PROCESS_TERM_GRACE_MS = 500;
const OPENCLI_PROCESS_KILL_GRACE_MS = 1_000;
const OPENCLI_REDACTION_MARKER = "[redacted-secret]";
const OPENCLI_SENSITIVE_ASSIGNMENT_KEY =
  /(?:x-linkedin-auth-token|x-li-at|x-csrf-token|csrf-token|proxy-authorization|authorization|set-cookie|cookie|li_at|jsessionid|bcookie|bscookie|lidc|access[_-]?key|api[_-]?key|credential|password|passwd|secret|token|[a-z0-9_-]*session[a-z0-9_-]*)/gi;

const OPENCLI_CHILD_ENV_ALLOWLIST = Object.freeze([
  "APPDATA",
  "CHROME_BIN",
  "CHROME_PATH",
  "COLORTERM",
  "DISPLAY",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "OPENCLI_HOME",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "__CF_USER_TEXT_ENCODING"
]);

export async function runOpenCli(args, options = {}) {
  if (process.platform === "win32") {
    throw openCliProcessError(
      "OpenCLI execution is disabled on Windows because descendant teardown cannot be identity-bound safely.",
      "OPENCLI_UNSAFE_PLATFORM",
      { killed: false }
    );
  }
  const runtime = resolveOpenCliRuntime();
  const contextualOwner = openCliProcessOwnerContext.getStore();
  const owner = options.processOwner ?? contextualOwner ?? createOpenCliProcessOwner();
  const ephemeralOwner = !options.processOwner && !contextualOwner;
  const commandArgs = [...runtime.prefixArgs, ...args];

  try {
    const stdout = await executeOwnedOpenCliProcess(runtime.command, commandArgs, {
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 45_000,
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
      env: runtime.env,
      owner,
      signal: options.signal
    });
    if (ephemeralOwner) await drainOpenCliProcessOwner(owner);
    return stdout;
  } catch (error) {
    await drainOpenCliProcessOwner(owner).catch((drainError) => {
      Object.defineProperty(error, "processDrainFailure", {
        configurable: true,
        enumerable: false,
        value: drainError
      });
    });
    throw sanitizedOpenCliExecutionError(error);
  }
}

export function createOpenCliProcessOwner({
  scanIntervalMs = OPENCLI_PROCESS_SCAN_INTERVAL_MS,
  freezeGraceMs = OPENCLI_PROCESS_FREEZE_GRACE_MS,
  termGraceMs = OPENCLI_PROCESS_TERM_GRACE_MS,
  killGraceMs = OPENCLI_PROCESS_KILL_GRACE_MS
} = {}) {
  return {
    marker: randomUUID(),
    roots: new Set(),
    processes: new Map(),
    groups: new Set(),
    scanIntervalMs: positiveProcessDuration(scanIntervalMs, "scanIntervalMs"),
    freezeGraceMs: positiveProcessDuration(freezeGraceMs, "freezeGraceMs"),
    termGraceMs: positiveProcessDuration(termGraceMs, "termGraceMs"),
    killGraceMs: positiveProcessDuration(killGraceMs, "killGraceMs"),
    scanTimer: null,
    scanInFlight: null,
    scanFailure: null,
    authorizationFailures: new Map(),
    processExitStates: new Map(),
    drainPromise: null
  };
}

export function withOpenCliProcessOwner(owner, operation) {
  assertOpenCliProcessOwner(owner);
  if (typeof operation !== "function") {
    throw new TypeError("OpenCLI process ownership requires an operation function.");
  }
  return openCliProcessOwnerContext.run(owner, operation);
}

export async function drainOpenCliProcessOwner(owner) {
  assertOpenCliProcessOwner(owner);
  if (owner.drainPromise) return owner.drainPromise;

  owner.drainPromise = drainOwnedProcessTree(owner).finally(() => {
    owner.drainPromise = null;
  });
  return owner.drainPromise;
}

async function executeOwnedOpenCliProcess(command, args, {
  cwd,
  timeoutMs,
  maxBuffer,
  env,
  owner,
  signal
}) {
  assertOpenCliProcessOwner(owner);
  const boundedTimeoutMs = positiveProcessDuration(timeoutMs, "timeoutMs");
  const boundedMaxBuffer = positiveProcessDuration(maxBuffer, "maxBuffer");
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...env,
      RETURNER_OPENCLI_PROCESS_OWNER: owner.marker
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stdout = createBoundedOutputCollector(child.stdout, boundedMaxBuffer, "stdout");
  const stderr = createBoundedOutputCollector(child.stderr, boundedMaxBuffer, "stderr");
  let rejectForcedFailure;
  const forcedFailure = new Promise((_, reject) => {
    rejectForcedFailure = reject;
  });
  stdout.onOverflow(rejectForcedFailure);
  stderr.onOverflow(rejectForcedFailure);

  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (Number.isInteger(child.pid) && child.pid > 0) {
    const exitState = { settled: false, promise: exit };
    owner.processExitStates.set(child.pid, exitState);
    exit.then(
      () => { exitState.settled = true; },
      () => { exitState.settled = true; }
    );
  }
  const timeout = setTimeout(() => {
    const error = openCliProcessError(
      `OpenCLI command timed out after ${boundedTimeoutMs}ms.`,
      "ETIMEDOUT",
      { killed: true }
    );
    rejectForcedFailure(error);
  }, boundedTimeoutMs);
  let onAbort = null;
  if (signal) {
    onAbort = () => {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : openCliProcessError("OpenCLI command aborted by its owner.", "ABORT_ERR", {
            killed: true
          });
      reason.killed = true;
      reason.code ??= "ABORT_ERR";
      rejectForcedFailure(reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  // Attach all child lifecycle/stdio listeners before the first process scan;
  // a fast OpenCLI command can exit while ownership metadata is being read.
  if (Number.isInteger(child.pid) && child.pid > 0) {
    owner.roots.add(child.pid);
    owner.processes.set(child.pid, {
      pgid: process.platform === "win32" ? child.pid : child.pid,
      state: "running",
      startIdentity: processStartIdentity(child.pid)
    });
    owner.groups.add(child.pid);
    startOpenCliProcessScanner(owner);
    await scanOwnedProcesses(owner).catch(() => undefined);
  }

  let outcome;
  try {
    outcome = await Promise.race([exit, forcedFailure]);
  } catch (error) {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await drainOpenCliProcessOwner(owner);
    await settleOpenCliOutput([stdout, stderr]);
    attachOpenCliOutput(error, stdout.text(), stderr.text());
    throw error;
  }
  clearTimeout(timeout);
  signal?.removeEventListener("abort", onAbort);

  if (outcome.code !== 0) {
    const error = openCliProcessError(
      outcome.signal
        ? `OpenCLI command was terminated by ${outcome.signal}.`
        : `OpenCLI command failed with exit code ${outcome.code}.`,
      outcome.code ?? "OPENCLI_EXECUTION_FAILED",
      { signal: outcome.signal }
    );
    await drainOpenCliProcessOwner(owner);
    await settleOpenCliOutput([stdout, stderr]);
    attachOpenCliOutput(error, stdout.text(), stderr.text());
    throw error;
  }

  await settleOpenCliOutput([stdout, stderr]);
  return stdout.text();
}

function createBoundedOutputCollector(stream, maxBuffer, label) {
  const chunks = [];
  let byteLength = 0;
  let ended = !stream;
  let overflow = null;
  let resolveEnd;
  const endPromise = new Promise((resolve) => {
    resolveEnd = resolve;
  });
  if (ended) resolveEnd();

  stream?.on("data", (chunk) => {
    if (overflow) return;
    const buffer = Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > maxBuffer) {
      overflow = openCliProcessError(
        `OpenCLI ${label} exceeded the ${maxBuffer}-byte output limit.`,
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        { killed: true }
      );
      return;
    }
    chunks.push(buffer);
  });
  const markEnded = () => {
    if (ended) return;
    ended = true;
    resolveEnd();
  };
  stream?.once("end", markEnded);
  stream?.once("close", markEnded);
  stream?.once("error", markEnded);

  return {
    endPromise,
    stream,
    onOverflow(reject) {
      stream?.on("data", () => {
        if (overflow) reject(overflow);
      });
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

async function settleOpenCliOutput(collectors) {
  const streamsEnded = Promise.all(collectors.map((collector) => collector.endPromise));
  await Promise.race([streamsEnded, processDelay(250)]);
  for (const collector of collectors) collector.stream?.destroy();
  // A detached child can keep a pipe descriptor around after its process has
  // exited. The streams have been explicitly destroyed above; never wait
  // without a second bounded deadline for a close event that the OS may not
  // deliver to Node.
  await Promise.race([streamsEnded, processDelay(250)]);
}

function attachOpenCliOutput(error, stdout, stderr) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
  error.stdout = stdout;
  error.stderr = stderr;
}

function openCliProcessError(message, code, { killed = false, signal = null } = {}) {
  const error = new Error(message);
  error.code = code;
  error.killed = killed;
  error.signal = signal;
  return error;
}

function startOpenCliProcessScanner(owner) {
  if (process.platform === "win32" || owner.scanTimer) return;
  owner.scanTimer = setInterval(() => {
    if (owner.scanInFlight) return;
    owner.scanInFlight = scanOwnedProcesses(owner)
      .catch((error) => {
        owner.scanFailure = error;
      })
      .finally(() => {
        owner.scanInFlight = null;
      });
  }, owner.scanIntervalMs);
  owner.scanTimer.unref?.();
}

async function scanOwnedProcesses(owner) {
  if (process.platform === "win32") return;
  const rows = process.platform === "linux"
    ? scanLinuxProcessTable(owner.marker)
    : await scanPortableProcessTable(owner.marker);

  const ownedPids = new Set([...owner.roots, ...owner.processes.keys()]);
  // `detached: true` children can call setsid(2) and be reparented before a
  // parent/child walk sees them. The owner marker is injected into the strict
  // child environment and inherited by every descendant, so the exact marker
  // is a second ownership edge even after both parent and process group change.
  for (const row of rows.values()) {
    if (row.markerPresent) ownedPids.add(row.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows.values()) {
      if (row.pid === process.pid || ownedPids.has(row.pid)) continue;
      if (!ownedPids.has(row.ppid)) continue;
      ownedPids.add(row.pid);
      changed = true;
    }
  }

  for (const pid of ownedPids) {
    const row = rows.get(pid);
    if (!row) continue;
    const startIdentity = row.startIdentity ?? processStartIdentity(pid);
    if (!startIdentity) continue;
    const previous = owner.processes.get(pid);
    // A PID that changed identity is no longer ours. Remove it from every
    // ownership set before any later teardown pass can signal the replacement.
    if (
      previous?.startIdentity &&
      previous.startIdentity !== startIdentity
    ) {
      owner.processes.delete(pid);
      owner.roots.delete(pid);
      continue;
    }
    owner.processes.set(pid, {
      ppid: row.ppid,
      pgid: row.pgid,
      state: row.state,
      startIdentity: previous?.startIdentity ?? startIdentity
    });
    if (row.pgid > 1) owner.groups.add(row.pgid);
  }
  for (const pid of owner.processes.keys()) {
    if (!rows.has(pid)) {
      if (!processHasExited(owner, pid)) continue;
      owner.processes.delete(pid);
      owner.authorizationFailures.delete(pid);
    }
  }
  owner.scanFailure = null;
}

function scanLinuxProcessTable(marker) {
  const rows = new Map();
  const entries = fs.readdirSync("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const row = readLinuxProcessRow(pid, marker);
    if (row) rows.set(pid, row);
  }
  return rows;
}

async function scanPortableProcessTable(marker) {
  const { stdout } = await execFileAsync("/bin/ps", [
    "eww",
    "-axo",
    "pid=,ppid=,pgid=,stat=,command="
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 2_000
  });
  const rows = new Map();
  for (const line of String(stdout).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    rows.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
      command: match[5] ?? "",
      startIdentity: null,
      markerPresent: (match[5] ?? "").includes(`RETURNER_OPENCLI_PROCESS_OWNER=${marker}`),
      markerReadable: true
    });
  }
  return rows;
}

function readLinuxProcessRow(pid, marker) {
  const before = readLinuxProcStat(pid);
  if (!before) return null;
  const markerResult = readLinuxProcessEnvironmentMarker(pid, marker);
  const after = readLinuxProcStat(pid);
  if (!after || before.startIdentity !== after.startIdentity) return null;
  return {
    ...after,
    markerPresent: markerResult.present,
    markerReadable: markerResult.readable
  };
}

function readLinuxProcStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (
      !/^\d+$/.test(startTicks ?? "") ||
      !Number.isInteger(ppid) || ppid < 0 ||
      !Number.isInteger(pgid) || pgid < 0 ||
      typeof fields[0] !== "string" || !fields[0]
    ) {
      return null;
    }
    return {
      pid,
      ppid,
      pgid,
      state: fields[0],
      startIdentity: `linux-proc-start:${startTicks}`
    };
  } catch {
    return null;
  }
}

function readLinuxProcessEnvironmentMarker(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof marker !== "string" || !marker) {
    return { present: false, readable: false };
  }
  try {
    const environment = fs.readFileSync(`/proc/${pid}/environ`);
    const expected = Buffer.from(`RETURNER_OPENCLI_PROCESS_OWNER=${marker}`);
    let start = 0;
    while (start <= environment.length) {
      const end = environment.indexOf(0, start);
      const fieldEnd = end < 0 ? environment.length : end;
      if (environment.subarray(start, fieldEnd).equals(expected)) {
        return { present: true, readable: true };
      }
      if (end < 0) break;
      start = end + 1;
    }
    return { present: false, readable: true };
  } catch {
    return { present: false, readable: false };
  }
}

async function drainOwnedProcessTree(owner) {
  if (owner.scanTimer) {
    clearInterval(owner.scanTimer);
    owner.scanTimer = null;
  }
  await owner.scanInFlight?.catch(() => undefined);

  if (owner.roots.size === 0 && owner.processes.size === 0 && owner.groups.size === 0) {
    resetOpenCliProcessOwner(owner);
    return;
  }

  if (process.platform === "win32") {
    await drainWindowsProcessTree();
    resetOpenCliProcessOwner(owner);
    return;
  }

  // A detached child can become a zombie when its OpenCLI parent is killed.
  // Keep every root alive until its descendants are gone and reaped; only then
  // terminate the roots themselves. This is the important Linux distinction
  // between a process that has exited and a PID that still answers kill(0).
  const drained = await drainOwnedDescendants(owner);
  if (drained) {
    const rootsDrained = await drainOwnedRoots(owner);
    if (rootsDrained && owner.processes.size === 0 && !owner.scanFailure) {
      resetOpenCliProcessOwner(owner);
      return;
    }
  }

  throw openCliProcessDrainFailure(owner);
}

async function drainOwnedDescendants(owner) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!await freezeOwnedProcessTree(owner)) return false;

    if (!hasOwnedProcesses(owner, { roots: false })) return true;

    signalOwnedProcesses(owner, "SIGTERM", { roots: false });
    signalOwnedProcesses(owner, "SIGCONT", { roots: false });

    let terminated = await waitForOwnedProcessesToTerminate(
      owner,
      owner.termGraceMs,
      { roots: false }
    );
    if (!terminated) {
      // Re-freeze before SIGKILL so a descendant that forked while handling
      // SIGTERM cannot outrun the final signal pass.
      if (!await freezeOwnedProcessTree(owner)) return false;
      signalOwnedProcesses(owner, "SIGKILL", { roots: false });
      terminated = await waitForOwnedProcessesToTerminate(
        owner,
        owner.killGraceMs,
        { roots: false }
      );
    }
    if (!terminated) return false;

    // Roots were stopped while descendants were terminated. Let them run long
    // enough to receive SIGCHLD and reap those descendants, then stop them
    // again before checking for a new fork race.
    signalOwnedProcesses(owner, "SIGCONT", { roots: true, descendants: false });
    if (!await waitForOwnedProcessesToExit(owner, owner.killGraceMs, { roots: false })) {
      return false;
    }
    if (!await freezeOwnedProcessTree(owner)) return false;
    if (!hasOwnedProcesses(owner, { roots: false })) return true;
  }
  return false;
}

async function drainOwnedRoots(owner) {
  if (!hasOwnedProcesses(owner, { roots: true, descendants: false })) return true;

  signalOwnedProcesses(owner, "SIGTERM", { roots: true, descendants: false });
  signalOwnedProcesses(owner, "SIGCONT", { roots: true, descendants: false });
  if (await waitForOwnedRootExitEvents(owner, owner.termGraceMs)) {
    return true;
  }

  signalOwnedProcesses(owner, "SIGKILL", { roots: true, descendants: false });
  return waitForOwnedRootExitEvents(owner, owner.killGraceMs);
}

async function waitForOwnedRootExitEvents(owner, timeoutMs) {
  const pending = [...owner.processes.keys()]
    .filter((pid) => owner.roots.has(pid) && !processHasExited(owner, pid))
    .map((pid) => owner.processExitStates.get(pid)?.promise?.catch(() => undefined));
  const exitEvents = pending.filter(Boolean);
  if (exitEvents.length === 0) {
    return waitForOwnedProcessesToExit(owner, timeoutMs, {
      roots: true,
      descendants: false
    });
  }
  await Promise.race([Promise.all(exitEvents), processDelay(timeoutMs)]);
  await scanOwnedProcesses(owner).catch((error) => {
    owner.scanFailure = error;
  });
  return !owner.scanFailure && !hasOwnedProcesses(owner, { roots: true, descendants: false });
}

async function freezeOwnedProcessTree(owner) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await scanOwnedProcesses(owner).catch((error) => {
      owner.scanFailure = error;
    });
    if (owner.scanFailure) continue;

    // A process-group SIGSTOP closes the fork race between the scan and the
    // direct-PID pass. Group termination is intentionally never used: a root
    // must survive long enough to reap its detached descendants.
    signalOwnedProcesses(owner, "SIGSTOP", { roots: true, descendants: true });
    if (await waitForOwnedProcessesToStop(owner, owner.freezeGraceMs)) return true;
  }
  return false;
}

async function waitForOwnedProcessesToStop(owner, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    await scanOwnedProcesses(owner).catch((error) => {
      owner.scanFailure = error;
    });
    if (!owner.scanFailure) {
      const running = [...owner.processes.entries()].some(
        ([pid, processState]) =>
          !processHasExited(owner, pid) &&
          !isProcessTerminated(processState.state) &&
          !isProcessStopped(processState.state)
      );
      if (!running) return true;
    }
    await processDelay(Math.min(owner.scanIntervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

async function waitForOwnedProcessesToTerminate(owner, timeoutMs, scope) {
  return waitForOwnedProcesses(owner, timeoutMs, scope, { requireReaped: false });
}

async function waitForOwnedProcessesToExit(owner, timeoutMs, scope) {
  return waitForOwnedProcesses(owner, timeoutMs, scope, { requireReaped: true });
}

async function waitForOwnedProcesses(owner, timeoutMs, {
  roots = true,
  descendants = true
} = {}, { requireReaped }) {
  const deadline = Date.now() + timeoutMs;
  do {
    await scanOwnedProcesses(owner).catch((error) => {
      owner.scanFailure = error;
    });
    if (!owner.scanFailure) {
      const pending = [...owner.processes.entries()].some(([pid, processState]) => {
        const isRoot = owner.roots.has(pid);
        if ((isRoot && !roots) || (!isRoot && !descendants)) return false;
        if (processHasExited(owner, pid)) return false;
        return requireReaped || !isProcessTerminated(processState.state);
      });
      if (!pending) return true;
    }
    await processDelay(Math.min(owner.scanIntervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

function signalOwnedProcesses(owner, signal, {
  roots = true,
  descendants = true
} = {}) {
  const targets = [...owner.processes.entries()].filter(([pid]) => {
    const isRoot = owner.roots.has(pid);
    return (isRoot && roots) || (!isRoot && descendants);
  });
  if (signal === "SIGSTOP") signalOwnedProcessGroups(owner, targets, signal);

  for (const [pid, processState] of targets) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    if (isProcessTerminated(processState.state)) continue;
    if (!processIsRunning(pid)) continue;

    const authorization = ownedProcessIdentityStatus(pid, processState, owner);
    if (authorization !== "authorized") {
      recordSignalAuthorizationFailure(owner, pid, processState, authorization);
      continue;
    }
    try {
      process.kill(pid, signal);
      owner.authorizationFailures.delete(pid);
    } catch (error) {
      if (error?.code !== "ESRCH") owner.scanFailure ??= error;
    }
  }
}

function hasOwnedProcesses(owner, {
  roots = true,
  descendants = true
} = {}) {
  return [...owner.processes.keys()].some((pid) => {
    const isRoot = owner.roots.has(pid);
    return (isRoot && roots) || (!isRoot && descendants);
  });
}

function processHasExited(owner, pid) {
  if (owner.processExitStates.get(pid)?.settled) return true;
  return !processIsRunning(pid);
}

function isProcessTerminated(state) {
  return String(state ?? "").startsWith("Z");
}

function isProcessStopped(state) {
  return String(state ?? "").startsWith("T");
}

function ownedProcessIdentityStatus(pid, processState, owner) {
  if (isProcessTerminated(processState?.state)) return "terminated";
  if (!processState?.startIdentity || !owner?.marker) return "unverifiable";

  const snapshot = readProcessSignalSnapshot(pid, owner.marker);
  if (!snapshot) return "unverifiable";
  if (snapshot.startIdentity !== processState.startIdentity) {
    return "replaced";
  }
  if (snapshot.pgid !== processState.pgid) return "moved";
  if (isProcessTerminated(snapshot.state)) return "terminated";
  return snapshot.markerPresent ? "authorized" : "unverifiable";
}

function recordSignalAuthorizationFailure(owner, pid, processState, authorization) {
  if (authorization === "terminated") return;
  if (authorization === "replaced") {
    // The original process is gone. Do not signal a replacement PID, and do
    // not let the stale ownership record make a later drain look successful.
    owner.processes.delete(pid);
    owner.roots.delete(pid);
    owner.authorizationFailures.delete(pid);
    return;
  }
  owner.authorizationFailures.set(pid, {
    state: processState?.state ?? "",
    reason: authorization
  });
}

function openCliProcessDrainFailure(owner) {
  const remaining = [...owner.processes.keys()].filter((pid) => !processHasExited(owner, pid));
  const detail = [
    owner.scanFailure ? " Process enumeration also failed during teardown." : "",
    owner.authorizationFailures.size > 0
      ? " At least one live process could not be identity-authorized for signaling."
      : ""
  ].join("");
  return openCliProcessError(
    `OpenCLI process teardown could not drain ${remaining.length} descendant process(es) within the bounded SIGTERM/SIGKILL windows.${detail}`,
    "OPENCLI_PROCESS_DRAIN_FAILED",
    { killed: true }
  );
}

function signalOwnedProcessGroups(owner, targets, signal) {
  const ownGroup = currentProcessGroupId();
  for (const pgid of owner.groups) {
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === ownGroup) continue;
    const groupMembers = targets.filter(
      ([, processState]) => processState.pgid === pgid
    );
    // Never signal a stale/reused group. Every known member in the selected
    // scope must still have the same start identity immediately before the
    // group stop; direct signaling below handles members in other groups.
    if (
      groupMembers.length === 0 ||
      groupMembers.some(([pid, processState]) => {
        const authorization = ownedProcessIdentityStatus(pid, processState, owner);
        if (authorization !== "authorized") {
          recordSignalAuthorizationFailure(owner, pid, processState, authorization);
          return true;
        }
        return false;
      })
    ) {
      continue;
    }
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") owner.scanFailure ??= error;
    }
  }
}

async function drainWindowsProcessTree() {
  throw openCliProcessError(
    "OpenCLI process teardown is disabled on Windows because PID-only descendant signaling cannot be identity-bound safely.",
    "OPENCLI_UNSAFE_PLATFORM",
    { killed: false }
  );
}

function resetOpenCliProcessOwner(owner) {
  owner.roots.clear();
  owner.processes.clear();
  owner.groups.clear();
  owner.scanFailure = null;
  owner.authorizationFailures.clear();
  owner.processExitStates.clear();
}

function currentProcessGroupId() {
  // getpgrp is not exposed by Node. `ps` discovery is intentionally avoided in
  // the signal loop; a detached OpenCLI root always has a distinct root PGID.
  return null;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function openCliProcessSignalAuthorization({
  platform = process.platform,
  expectedStartIdentity,
  currentStartIdentity,
  expectedMarker,
  currentMarker
} = {}) {
  if (platform === "win32") return false;
  if (
    typeof expectedStartIdentity !== "string" ||
    typeof currentStartIdentity !== "string" ||
    typeof expectedMarker !== "string" ||
    typeof currentMarker !== "string"
  ) {
    return false;
  }
  return (
    expectedStartIdentity === currentStartIdentity &&
    expectedMarker === currentMarker
  );
}

function processOwnerMarker(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof marker !== "string" || !marker) {
    return null;
  }
  const expected = `RETURNER_OPENCLI_PROCESS_OWNER=${marker}`;
  if (process.platform === "linux") {
    return readLinuxProcessEnvironmentMarker(pid, marker).present ? marker : null;
  }
  try {
    const result = execFileSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" }
    });
    return String(result).includes(expected) ? marker : null;
  } catch {
    return null;
  }
}

function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    return readLinuxProcStat(pid)?.startIdentity ?? null;
  }
  try {
    const result = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" }
    });
    const startedAt = result.trim().replace(/\s+/g, " ");
    return startedAt ? `ps-lstart:${startedAt}` : null;
  } catch {
    return null;
  }
}

function readProcessSignalSnapshot(pid, marker) {
  if (process.platform === "linux") {
    const before = readLinuxProcStat(pid);
    if (!before) return null;
    const markerResult = readLinuxProcessEnvironmentMarker(pid, marker);
    const after = readLinuxProcStat(pid);
    if (!after || before.startIdentity !== after.startIdentity) return null;
    return {
      startIdentity: after.startIdentity,
      state: after.state,
      pgid: after.pgid,
      markerPresent: markerResult.present && markerResult.readable
    };
  }

  const before = readPortableProcessStatus(pid);
  if (!before) return null;
  const markerPresent = processOwnerMarker(pid, marker) === marker;
  const after = readPortableProcessStatus(pid);
  if (!after || before.startIdentity !== after.startIdentity) return null;
  return {
    startIdentity: after.startIdentity,
    state: after.state,
    pgid: after.pgid,
    markerPresent
  };
}

function readPortableProcessStatus(pid) {
  try {
    const result = execFileSync("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "pid=,pgid=,stat=,lstart="
    ], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" }
    }).trim();
    const match = result.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      pgid: Number(match[2]),
      state: match[3],
      startIdentity: `ps-lstart:${match[4].trim().replace(/\s+/g, " ")}`
    };
  } catch {
    return null;
  }
}

function assertOpenCliProcessOwner(owner) {
  if (!owner || typeof owner !== "object" || typeof owner.marker !== "string") {
    throw new TypeError("Invalid OpenCLI process owner.");
  }
}

function positiveProcessDuration(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`OpenCLI ${label} must be a positive integer.`);
  }
  return value;
}

function processDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildOpenCliChildEnvironment(
  parentEnv = process.env,
  { nodeBinDir = path.dirname(process.execPath) } = {}
) {
  const env = {};
  for (const name of OPENCLI_CHILD_ENV_ALLOWLIST) {
    const value = parentEnv?.[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  env.PATH = [nodeBinDir, parentEnv?.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

export function sanitizeOpenCliDiagnostic(value) {
  let sanitized = String(value ?? "");
  for (let pass = 0; pass < 8; pass += 1) {
    const next = redactOpenCliDiagnosticPass(sanitized);
    if (next === sanitized) return next;
    sanitized = next;
  }
  return sanitized;
}

function redactOpenCliDiagnosticPass(value) {
  return redactSensitiveAssignments(value)
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "[redacted-public-token]")
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[redacted-public-token]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-public-token]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, "[redacted-public-token]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted-public-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [redacted-public-token]")
    .replace(/\b[A-Za-z0-9_-]{3,}=[A-Za-z0-9%._~+/-]{16,}/g, (match) => {
      const key = match.split("=")[0];
      return `${key}=[redacted-public-param]`;
    });
}

function redactSensitiveAssignments(value) {
  const ranges = [];
  OPENCLI_SENSITIVE_ASSIGNMENT_KEY.lastIndex = 0;
  let match;
  while ((match = OPENCLI_SENSITIVE_ASSIGNMENT_KEY.exec(value)) !== null) {
    const keyStart = match.index;
    const keyEnd = keyStart + match[0].length;
    if (isDiagnosticKeyCharacter(value[keyStart - 1]) || isDiagnosticKeyCharacter(value[keyEnd])) {
      continue;
    }

    let cursor = keyEnd;
    while (cursor < value.length && /[\s\\"']/.test(value[cursor])) cursor += 1;
    if (value[cursor] !== ":" && value[cursor] !== "=") continue;
    cursor += 1;
    while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;

    const openingEscapeStart = cursor;
    while (value[cursor] === "\\") cursor += 1;
    const openingEscapeCount = cursor - openingEscapeStart;
    const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : null;
    if (quote) cursor += 1;
    else cursor = openingEscapeStart;

    const bearer = /^Bearer\s+/i.exec(value.slice(cursor));
    if (!quote && bearer) cursor += bearer[0].length;
    const valueStart = cursor;
    const valueEnd = quote
      ? findEscapedClosingQuote(value, valueStart, quote, openingEscapeCount)
      : findUnquotedDiagnosticValueEnd(value, valueStart);
    if (valueEnd <= valueStart) continue;
    if (value.slice(valueStart, valueEnd) === OPENCLI_REDACTION_MARKER) continue;
    ranges.push({ start: valueStart, end: valueEnd });
  }

  if (ranges.length === 0) return value;
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  let output = "";
  let copiedThrough = 0;
  for (const range of ranges) {
    if (range.start < copiedThrough) continue;
    output += value.slice(copiedThrough, range.start);
    output += OPENCLI_REDACTION_MARKER;
    copiedThrough = range.end;
  }
  return output + value.slice(copiedThrough);
}

function findEscapedClosingQuote(value, start, quote, minimumEscapeCount) {
  for (let cursor = start; cursor < value.length; cursor += 1) {
    if (value[cursor] !== quote) continue;
    let escapeStart = cursor;
    while (escapeStart > start && value[escapeStart - 1] === "\\") escapeStart -= 1;
    if (cursor - escapeStart >= minimumEscapeCount) return escapeStart;
  }
  return findUnquotedDiagnosticValueEnd(value, start);
}

function findUnquotedDiagnosticValueEnd(value, start) {
  let cursor = start;
  while (cursor < value.length && !/[\s,;}\]\[\r\n"']/.test(value[cursor])) cursor += 1;
  return cursor;
}

function isDiagnosticKeyCharacter(value) {
  return typeof value === "string" && /[A-Za-z0-9_-]/.test(value);
}

export function openCliAvailable() {
  try {
    resolveOpenCliRuntime();
    return true;
  } catch {
    return false;
  }
}

export function describeOpenCliCommand() {
  try {
    const runtime = resolveOpenCliRuntime();
    return [runtime.command, ...runtime.prefixArgs].join(" ");
  } catch (error) {
    return error instanceof Error ? error.message : "OpenCLI command could not be resolved.";
  }
}

export function resolveOpenCliRuntime() {
  if (cachedRuntime) return cachedRuntime;

  const nodeBinDir = path.dirname(process.execPath);
  const env = buildOpenCliChildEnvironment(process.env, { nodeBinDir });
  const profileArgs = process.env.OPENCLI_PROFILE?.trim()
    ? ["--profile", process.env.OPENCLI_PROFILE.trim()]
    : [];
  const withProfile = (prefixArgs) => [...prefixArgs, ...profileArgs];

  const explicitBin = process.env.OPENCLI_BIN;
  if (explicitBin) {
    cachedRuntime = { command: explicitBin, prefixArgs: withProfile([]), env };
    return cachedRuntime;
  }

  const explicitMain = process.env.OPENCLI_MAIN;
  if (explicitMain) {
    cachedRuntime = { command: process.execPath, prefixArgs: withProfile([explicitMain]), env };
    return cachedRuntime;
  }

  const mainCandidates = [
    process.platform === "win32"
      ? path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js")
      : "",
    path.join(os.homedir(), ".agent-reach", "tools", "opencli", "dist", "src", "main.js")
  ].filter(Boolean);
  for (const candidate of mainCandidates) {
    if (fs.existsSync(candidate)) {
      cachedRuntime = { command: process.execPath, prefixArgs: withProfile([candidate]), env };
      return cachedRuntime;
    }
  }

  const binCandidates = [
    findOnPath("opencli", env.PATH),
    path.join(os.homedir(), ".agent-reach-venv", process.platform === "win32" ? "Scripts/opencli.exe" : "bin/opencli"),
    path.join(os.homedir(), ".local", "bin", "opencli"),
    "/opt/homebrew/bin/opencli",
    "/usr/local/bin/opencli",
    latestPnpmDlxOpenCliBin()
  ].filter(Boolean);
  for (const candidate of binCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      cachedRuntime = { command: candidate, prefixArgs: withProfile([]), env };
      return cachedRuntime;
    }
  }

  const pnpmBin = process.env.PNPM_BIN ?? bundledPnpmPath();
  if (pnpmBin && fs.existsSync(pnpmBin)) {
    cachedRuntime = {
      command: pnpmBin,
      prefixArgs: withProfile(["dlx", "@jackwener/opencli"]),
      env
    };
    return cachedRuntime;
  }

  throw new Error("OpenCLI not found. Set OPENCLI_BIN or OPENCLI_MAIN, or install @jackwener/opencli.");
}

function sanitizedOpenCliExecutionError(error) {
  const drainFailure = error?.processDrainFailure;
  const message = sanitizeOpenCliDiagnostic(
    `${error instanceof Error ? error.message : String(error)}` +
      `${drainFailure ? ` Process teardown failed: ${drainFailure.message}` : ""}`
  );
  const sanitized = new Error(message || "OpenCLI command failed.");
  sanitized.name = error?.name === "Error" || typeof error?.name !== "string"
    ? "OpenCliExecutionError"
    : error.name;
  sanitized.code = drainFailure?.code ?? error?.code ?? "OPENCLI_EXECUTION_FAILED";
  sanitized.killed = Boolean(error?.killed || drainFailure?.killed);
  sanitized.signal = typeof error?.signal === "string" ? error.signal : null;
  sanitized.stdout = sanitizeOpenCliDiagnostic(error?.stdout);
  sanitized.stderr = sanitizeOpenCliDiagnostic(error?.stderr);
  return sanitized;
}

function findOnPath(command, pathValue) {
  for (const dir of String(pathValue ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function bundledPnpmPath() {
  const candidate = path.resolve(path.dirname(process.execPath), "..", "..", "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  return fs.existsSync(candidate) ? candidate : null;
}

function latestPnpmDlxOpenCliBin() {
  const dlxRoot = path.join(os.homedir(), "Library", "Caches", "pnpm", "dlx");
  if (!fs.existsSync(dlxRoot)) return null;

  const candidates = [];
  collectOpenCliBins(dlxRoot, candidates, 0);
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path ?? null;
}

function collectOpenCliBins(dir, candidates, depth) {
  if (depth > 9) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectOpenCliBins(entryPath, candidates, depth + 1);
      continue;
    }
    if (entry.name !== "opencli" && entry.name !== "opencli.cmd") continue;
    if (!entryPath.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`)) continue;
    try {
      candidates.push({ path: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
    } catch {
      // Ignore stale cache entries.
    }
  }
}
