"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads must be CommonJS. */

// Loaded only into runner-owned Node subprocesses. Recording each spawned PID
// before user code can exit closes the process-tree race where a direct child
// daemonizes with detached stdio and is reparented before the runner observes
// the direct child's close event.
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const ledgerPath = process.env.RETURNER_CHILD_PROCESS_LEDGER;
const ledgerRunId = process.env.RETURNER_CHILD_PROCESS_RUN_ID;

function linuxProcessStartIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    // Fields after the command name begin at proc(5) field 3. starttime is
    // field 22, therefore index 19 in this suffix.
    const startTicks = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(startTicks ?? "")
      ? `linux-proc-start:${startTicks}`
      : null;
  } catch {
    return null;
  }
}

function portableProcessStartIdentity(pid) {
  const result = childProcess.spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
      env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" }
    }
  );
  if (result.status !== 0 || result.error) return null;
  const startedAt = result.stdout.trim().replace(/\s+/g, " ");
  return startedAt ? `ps-lstart:${startedAt}` : null;
}

function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return linuxProcessStartIdentity(pid) ?? portableProcessStartIdentity(pid);
}

if (ledgerPath && ledgerRunId) {
  const record = (child) => {
    if (!Number.isInteger(child?.pid) || child.pid <= 0) return child;
    const startIdentity = processStartIdentity(child.pid);
    // A PID without a stable start identity is unsafe to recover later: it may
    // have exited and been reused before the parent reads the ledger.
    if (!startIdentity) return child;
    try {
      fs.appendFileSync(ledgerPath, `${ledgerRunId}\t${child.pid}\t${startIdentity}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
    } catch {
      // The parent still owns process-group and ps-based cleanup. A ledger I/O
      // failure must not change the command's own semantics.
    }
    return child;
  };

  for (const method of ["spawn", "fork", "exec", "execFile"]) {
    const original = childProcess[method];
    if (typeof original !== "function") continue;
    childProcess[method] = function returnerTrackedChild(...args) {
      return record(original.apply(this, args));
    };
  }
  syncBuiltinESMExports();
}
