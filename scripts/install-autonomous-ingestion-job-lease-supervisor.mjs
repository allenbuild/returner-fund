#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const LABEL = "com.returner-fund.ingestion-lease-supervisor";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");

async function main() {
  if (process.platform !== "darwin") throw new Error("This installer requires macOS launchd.");
  if (!process.argv.slice(2).includes("--install")) {
    throw new Error("Pass --install to write and load the user LaunchAgent.");
  }

  const userHome = homedir();
  const installRoot = path.join(
    userHome,
    "Library",
    "Application Support",
    "Returner Fund",
    "ingestion-lease-supervisor"
  );
  const stateDir = path.join(installRoot, "state");
  const installedScript = path.join(
    installRoot,
    "supervise-autonomous-ingestion-job-lease.mjs"
  );
  const installedLibraryDir = path.join(installRoot, "lib");
  const installedScheduleModule = path.join(installedLibraryDir, "ingestion-schedule.mjs");
  const launchAgentsDir = path.join(userHome, "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${LABEL}.plist`);
  const logsDir = path.join(userHome, "Library", "Logs");
  const nodeBin = path.resolve(process.env.RETURNER_NODE_BIN ?? "/opt/homebrew/bin/node");
  const ghBin = path.resolve(process.env.RETURNER_GH_BIN ?? "/opt/homebrew/bin/gh");
  const runnerDiagDir = path.resolve(
    process.env.RETURNER_RUNNER_DIAG_DIR ??
      path.join(userHome, "returner-fund-actions-runner", "_diag")
  );
  const sourceScript = path.join(
    repositoryRoot,
    "scripts",
    "supervise-autonomous-ingestion-job-lease.mjs"
  );
  const sourceScheduleModule = path.join(
    repositoryRoot,
    "scripts",
    "lib",
    "ingestion-schedule.mjs"
  );
  const templatePath = path.join(
    repositoryRoot,
    "ops",
    "launchd",
    `${LABEL}.plist.template`
  );

  await Promise.all(
    [nodeBin, ghBin, runnerDiagDir, sourceScript, sourceScheduleModule, templatePath].map(requirePath)
  );
  await execFile(ghBin, ["auth", "status", "--hostname", "github.com"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(installedLibraryDir, { recursive: true, mode: 0o700 });
  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  await atomicWrite(installedScheduleModule, await readFile(sourceScheduleModule), 0o644);
  await atomicWrite(installedScript, await readFile(sourceScript), 0o755);
  await chmod(installedScript, 0o755);
  const template = await readFile(templatePath, "utf8");
  const replacements = {
    __NODE_BIN__: nodeBin,
    __SUPERVISOR_SCRIPT__: installedScript,
    __GH_BIN__: ghBin,
    __RUNNER_DIAG_DIR__: runnerDiagDir,
    __STATE_DIR__: stateDir,
    __INSTALL_ROOT__: installRoot,
    __STDOUT_LOG__: path.join(logsDir, "returner-fund-ingestion-lease-supervisor.log"),
    __STDERR_LOG__: path.join(logsDir, "returner-fund-ingestion-lease-supervisor.error.log")
  };
  let plist = template;
  for (const [token, value] of Object.entries(replacements)) {
    plist = plist.replaceAll(token, xmlEscape(value));
  }
  if (/__[A-Z0-9_]+__/.test(plist)) throw new Error("LaunchAgent template has unresolved tokens.");
  const validationPath = path.join(installRoot, `launch-agent-${randomUUID()}.plist`);
  await writeFile(validationPath, plist, { mode: 0o600, flag: "wx" });
  try {
    await execFile("/usr/bin/plutil", ["-lint", validationPath], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    await atomicWrite(plistPath, Buffer.from(plist), 0o644);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(validationPath, { force: true }));
  }

  const domain = `gui/${process.getuid()}`;
  await execFile("/bin/launchctl", ["bootout", `${domain}/${LABEL}`], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  }).catch(() => {});
  await execFile("/bin/launchctl", ["bootstrap", domain, plistPath], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  await execFile("/bin/launchctl", ["enable", `${domain}/${LABEL}`], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  process.stdout.write(
    `${JSON.stringify({
      installed: true,
      label: LABEL,
      plistPath,
      installedScript,
      installedScheduleModule,
      stateDir
    })}\n`
  );
}

async function requirePath(value) {
  try {
    await access(value);
  } catch {
    throw new Error(`Required install path is unavailable: ${value}`);
  }
}

async function atomicWrite(targetPath, bytes, mode) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, bytes, { mode, flag: "wx" });
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, mode);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
