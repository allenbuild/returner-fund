#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
export const SUPERVISOR_LABEL = "com.returner-fund.ingestion-lease-supervisor";
export const AWAKE_LABEL = "com.returner-fund.ingestion-awake";
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");

export function resolveInstallerOperation(argv) {
  if (argv.length === 1 && argv[0] === "--install") return "install";
  if (argv.length === 1 && argv[0] === "--uninstall") return "uninstall";
  throw new Error("Pass exactly one of --install or --uninstall.");
}

export function renderLaunchAgentTemplate(template, replacements) {
  let plist = String(template);
  for (const [token, value] of Object.entries(replacements)) {
    plist = plist.replaceAll(token, () => xmlEscape(value));
  }
  if (/__[A-Z0-9_]+__/.test(plist)) {
    throw new Error("LaunchAgent template has unresolved tokens.");
  }
  return plist;
}

export function assertAwakeLaunchAgentPlist(plist) {
  const normalized = String(plist).replace(/\s+/g, " ").trim();
  const programArguments = normalized.match(
    /<key>ProgramArguments<\/key> <array>([\s\S]*?)<\/array>/
  )?.[1]?.trim();
  if (
    !normalized.includes(`<key>Label</key> <string>${AWAKE_LABEL}</string>`) ||
    programArguments !== "<string>/usr/bin/caffeinate</string> <string>-s</string>" ||
    !normalized.includes("<key>KeepAlive</key> <true/>") ||
    !normalized.includes("<key>RunAtLoad</key> <true/>")
  ) {
    throw new Error("Awake LaunchAgent must continuously run only /usr/bin/caffeinate -s.");
  }
}

export function autonomousIngestionHostPaths({
  userHome,
  repositoryRoot = defaultRepositoryRoot
}) {
  const installRoot = path.join(
    userHome,
    "Library",
    "Application Support",
    "Returner Fund",
    "ingestion-lease-supervisor"
  );
  const launchAgentsDir = path.join(userHome, "Library", "LaunchAgents");
  return {
    installRoot,
    stateDir: path.join(installRoot, "state"),
    installedScript: path.join(
      installRoot,
      "supervise-autonomous-ingestion-job-lease.mjs"
    ),
    installedLibraryDir: path.join(installRoot, "lib"),
    installedScheduleModule: path.join(installRoot, "lib", "ingestion-schedule.mjs"),
    launchAgentsDir,
    logsDir: path.join(userHome, "Library", "Logs"),
    supervisorPlistPath: path.join(launchAgentsDir, `${SUPERVISOR_LABEL}.plist`),
    awakePlistPath: path.join(launchAgentsDir, `${AWAKE_LABEL}.plist`),
    sourceScript: path.join(
      repositoryRoot,
      "scripts",
      "supervise-autonomous-ingestion-job-lease.mjs"
    ),
    sourceScheduleModule: path.join(
      repositoryRoot,
      "scripts",
      "lib",
      "ingestion-schedule.mjs"
    ),
    supervisorTemplatePath: path.join(
      repositoryRoot,
      "ops",
      "launchd",
      `${SUPERVISOR_LABEL}.plist.template`
    ),
    awakeTemplatePath: path.join(
      repositoryRoot,
      "ops",
      "launchd",
      `${AWAKE_LABEL}.plist.template`
    )
  };
}

export async function installAutonomousIngestionHost({
  platform = process.platform,
  userHome = homedir(),
  uid = process.getuid?.(),
  environment = process.env,
  repositoryRoot = defaultRepositoryRoot,
  run = execFile,
  checkPath = requirePath
} = {}) {
  assertMacUser({ platform, uid });
  const paths = autonomousIngestionHostPaths({ userHome, repositoryRoot });
  const nodeBin = path.resolve(environment.RETURNER_NODE_BIN ?? "/opt/homebrew/bin/node");
  const ghBin = path.resolve(environment.RETURNER_GH_BIN ?? "/opt/homebrew/bin/gh");
  const runnerDiagDir = path.resolve(
    environment.RETURNER_RUNNER_DIAG_DIR ??
      path.join(userHome, "returner-fund-actions-runner", "_diag")
  );

  await Promise.all(
    [
      nodeBin,
      ghBin,
      runnerDiagDir,
      "/usr/bin/caffeinate",
      paths.sourceScript,
      paths.sourceScheduleModule,
      paths.supervisorTemplatePath,
      paths.awakeTemplatePath
    ].map(checkPath)
  );
  await run(ghBin, ["auth", "status", "--hostname", "github.com"], commandOptions(15_000));
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.installedLibraryDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.launchAgentsDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });

  await atomicWrite(
    paths.installedScheduleModule,
    await readFile(paths.sourceScheduleModule),
    0o644
  );
  await atomicWrite(paths.installedScript, await readFile(paths.sourceScript), 0o755);

  const supervisorPlist = renderLaunchAgentTemplate(
    await readFile(paths.supervisorTemplatePath, "utf8"),
    {
      __NODE_BIN__: nodeBin,
      __SUPERVISOR_SCRIPT__: paths.installedScript,
      __GH_BIN__: ghBin,
      __RUNNER_DIAG_DIR__: runnerDiagDir,
      __STATE_DIR__: paths.stateDir,
      __INSTALL_ROOT__: paths.installRoot,
      __STDOUT_LOG__: path.join(
        paths.logsDir,
        "returner-fund-ingestion-lease-supervisor.log"
      ),
      __STDERR_LOG__: path.join(
        paths.logsDir,
        "returner-fund-ingestion-lease-supervisor.error.log"
      )
    }
  );
  const awakePlist = renderLaunchAgentTemplate(
    await readFile(paths.awakeTemplatePath, "utf8"),
    {
      __STDOUT_LOG__: path.join(paths.logsDir, "returner-fund-ingestion-awake.log"),
      __STDERR_LOG__: path.join(
        paths.logsDir,
        "returner-fund-ingestion-awake.error.log"
      )
    }
  );
  assertAwakeLaunchAgentPlist(awakePlist);

  await validateAndInstallPlist({
    plist: supervisorPlist,
    targetPath: paths.supervisorPlistPath,
    validationDir: paths.installRoot,
    run
  });
  await validateAndInstallPlist({
    plist: awakePlist,
    targetPath: paths.awakePlistPath,
    validationDir: paths.installRoot,
    run
  });

  const domain = `gui/${uid}`;
  await bootoutIfLoaded({ domain, label: SUPERVISOR_LABEL, run });
  await bootoutIfLoaded({ domain, label: AWAKE_LABEL, run });
  await bootstrapAgent({ domain, label: AWAKE_LABEL, plistPath: paths.awakePlistPath, run });
  await bootstrapAgent({
    domain,
    label: SUPERVISOR_LABEL,
    plistPath: paths.supervisorPlistPath,
    run
  });

  return {
    operation: "install",
    installed: true,
    launchAgents: [
      { label: AWAKE_LABEL, plistPath: paths.awakePlistPath },
      { label: SUPERVISOR_LABEL, plistPath: paths.supervisorPlistPath }
    ],
    installedScript: paths.installedScript,
    installedScheduleModule: paths.installedScheduleModule,
    stateDir: paths.stateDir
  };
}

export async function uninstallAutonomousIngestionHost({
  platform = process.platform,
  userHome = homedir(),
  uid = process.getuid?.(),
  run = execFile
} = {}) {
  assertMacUser({ platform, uid });
  const paths = autonomousIngestionHostPaths({ userHome });
  const domain = `gui/${uid}`;

  await bootoutIfLoaded({ domain, label: SUPERVISOR_LABEL, run });
  await bootoutIfLoaded({ domain, label: AWAKE_LABEL, run });
  await rm(paths.supervisorPlistPath, { force: true });
  await rm(paths.awakePlistPath, { force: true });

  return {
    operation: "uninstall",
    installed: false,
    removedLaunchAgents: [SUPERVISOR_LABEL, AWAKE_LABEL],
    preservedStateDir: paths.stateDir,
    preservedLogsDir: paths.logsDir
  };
}

export async function bootoutIfLoaded({ domain, label, run = execFile }) {
  try {
    await run("/bin/launchctl", ["bootout", `${domain}/${label}`], commandOptions());
    return true;
  } catch (error) {
    if (launchAgentWasNotLoaded(error)) return false;
    throw error;
  }
}

function launchAgentWasNotLoaded(error) {
  const detail = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
  return Number(error?.code) === 3 || /no such process|could not find service/i.test(detail);
}

async function bootstrapAgent({ domain, label, plistPath, run }) {
  await run("/bin/launchctl", ["bootstrap", domain, plistPath], commandOptions());
  await run("/bin/launchctl", ["enable", `${domain}/${label}`], commandOptions());
}

async function validateAndInstallPlist({ plist, targetPath, validationDir, run }) {
  const validationPath = path.join(validationDir, `launch-agent-${randomUUID()}.plist`);
  await writeFile(validationPath, plist, { mode: 0o600, flag: "wx" });
  try {
    await run("/usr/bin/plutil", ["-lint", validationPath], commandOptions());
    await atomicWrite(targetPath, Buffer.from(plist), 0o644);
  } finally {
    await rm(validationPath, { force: true });
  }
}

function assertMacUser({ platform, uid }) {
  if (platform !== "darwin") throw new Error("This installer requires macOS launchd.");
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Unable to resolve the current macOS user ID.");
  }
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

function commandOptions(timeout = 10_000) {
  return { timeout, maxBuffer: 1024 * 1024 };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function main() {
  const operation = resolveInstallerOperation(process.argv.slice(2));
  const result = operation === "install"
    ? await installAutonomousIngestionHost()
    : await uninstallAutonomousIngestionHost();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
