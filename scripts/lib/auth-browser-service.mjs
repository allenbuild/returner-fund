import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const AUTH_BROWSER_LABEL = "com.returner-fund.auth-chrome-runner";
export const AUTH_CHROME_BUNDLE_IDENTIFIER = "com.google.Chrome.canary";
export const AUTH_CHROME_TEAM_IDENTIFIER = "EQHXZ8M8AV";

export function authBrowserHostConfiguration({ userHome = os.homedir() } = {}) {
  const normalizedHome = path.resolve(String(userHome));
  const appBundlePath = path.join(
    normalizedHome,
    "Applications",
    "Google Chrome Canary.app"
  );
  return {
    appBundlePath,
    chromeExecutable: path.join(
      appBundlePath,
      "Contents",
      "MacOS",
      "Google Chrome Canary"
    ),
    dataDir: path.join(
      normalizedHome,
      "Library",
      "Application Support",
      "Returner Fund Auth Chrome Runner"
    )
  };
}

export function stableAuthChromeExecutableDecision({
  userHome = os.homedir(),
  chromeExecutable = authBrowserHostConfiguration({ userHome }).chromeExecutable
} = {}) {
  const expected = authBrowserHostConfiguration({ userHome });
  const requested = String(chromeExecutable ?? "").trim();
  if (
    !requested ||
    /[\0\r\n]/.test(requested) ||
    !path.isAbsolute(requested) ||
    path.resolve(requested) !== expected.chromeExecutable
  ) {
    return { ok: false, reason: "auth_chrome_executable_not_dedicated_local_path" };
  }

  let realPath;
  let stat;
  let linkStat;
  let bundleComponentsStable;
  try {
    realPath = fs.realpathSync.native(requested);
    stat = fs.statSync(realPath, { bigint: true });
    linkStat = fs.lstatSync(requested, { bigint: true });
    bundleComponentsStable = [
      expected.appBundlePath,
      path.join(expected.appBundlePath, "Contents"),
      path.join(expected.appBundlePath, "Contents", "MacOS")
    ].every((component) => fs.lstatSync(component, { bigint: true }).isDirectory());
    fs.accessSync(realPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "auth_chrome_executable_missing_or_unreadable" };
  }

  if (
    !stat.isFile() ||
    !linkStat.isFile() ||
    !bundleComponentsStable ||
    transientApplicationPath(requested) ||
    transientApplicationPath(realPath)
  ) {
    return { ok: false, reason: "auth_chrome_executable_not_stable" };
  }

  return {
    ok: true,
    appBundlePath: expected.appBundlePath,
    chromeExecutable: requested,
    dataDir: expected.dataDir,
    executableIdentity: { device: stat.dev, inode: stat.ino }
  };
}

export async function verifyGoogleChromeBundle({
  appBundlePath,
  run = execFile
} = {}) {
  const initialVerification = await verifyChromeSignatureAndQuarantine({
    appBundlePath,
    run
  });
  if (!initialVerification.ok) return initialVerification;

  try {
    await run(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", appBundlePath],
      commandOptions(30_000)
    );
  } catch (error) {
    if (!execFileTimedOut(error)) {
      return { ok: false, reason: "auth_chrome_vendor_signature_unverified" };
    }

    // Gatekeeper can occasionally stop responding even for a valid, already
    // installed Google bundle. A timeout is not an explicit policy rejection.
    // Re-run every deterministic bundle check after the timeout so a bundle
    // changed while spctl was blocked still fails closed.
    const postTimeoutVerification = await verifyChromeSignatureAndQuarantine({
      appBundlePath,
      run
    });
    if (!postTimeoutVerification.ok) return postTimeoutVerification;
    return {
      ok: true,
      reason: "auth_chrome_vendor_signature_verified_gatekeeper_timeout"
    };
  }
  return { ok: true, reason: "auth_chrome_vendor_signature_verified" };
}

async function verifyChromeSignatureAndQuarantine({ appBundlePath, run }) {
  try {
    await run(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", appBundlePath],
      commandOptions(30_000)
    );
    const detail = await run(
      "/usr/bin/codesign",
      ["-dv", "--verbose=2", appBundlePath],
      commandOptions(15_000)
    );
    const detailLines = `${detail?.stdout ?? ""}\n${detail?.stderr ?? ""}`
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (
      !detailLines.includes(`Identifier=${AUTH_CHROME_BUNDLE_IDENTIFIER}`) ||
      !detailLines.includes(`TeamIdentifier=${AUTH_CHROME_TEAM_IDENTIFIER}`)
    ) {
      return { ok: false, reason: "auth_chrome_vendor_signature_mismatch" };
    }
  } catch {
    return { ok: false, reason: "auth_chrome_vendor_signature_unverified" };
  }

  let attributes;
  try {
    attributes = await run(
      "/usr/bin/xattr",
      ["-lr", appBundlePath],
      commandOptions(30_000)
    );
  } catch {
    return { ok: false, reason: "auth_chrome_quarantine_scan_failed" };
  }
  if (recursiveQuarantinePresent(attributes?.stdout)) {
    return { ok: false, reason: "auth_chrome_bundle_quarantined" };
  }
  return { ok: true };
}

export function authBrowserLaunchAgentDecision({
  output,
  chromeExecutable,
  dataDir
} = {}) {
  const value = String(output ?? "");
  if (!/(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/.test(value)) {
    return { ok: false, reason: "auth_browser_service_not_running" };
  }
  if (!launchctlFieldContains(value, "program", chromeExecutable)) {
    return { ok: false, reason: "auth_browser_service_executable_mismatch" };
  }
  const dataDirArguments = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("--user-data-dir="));
  if (
    dataDirArguments.length !== 1 ||
    dataDirArguments[0] !== `--user-data-dir=${dataDir}`
  ) {
    return { ok: false, reason: "auth_browser_service_data_dir_mismatch" };
  }
  return { ok: true, reason: "auth_browser_service_running" };
}

export function authBrowserProcessDecision({
  launchctlOutput,
  processOutput,
  singletonTarget,
  appBundlePath,
  chromeExecutable,
  dataDir
} = {}) {
  const pidMatch = String(launchctlOutput ?? "").match(/(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/);
  const pid = Number(pidMatch?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, reason: "auth_browser_process_pid_missing" };
  }
  const processes = parseProcessInventory(processOutput);
  const root = processes.find((process) => process.pid === pid);
  const expectedCommand = [
    chromeExecutable,
    `--user-data-dir=${dataDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ].join(" ");
  if (!root || root.command !== expectedCommand) {
    return { ok: false, reason: "auth_browser_process_identity_mismatch" };
  }
  const frameworkPrefix = `${appBundlePath}${path.sep}Contents${path.sep}Frameworks${path.sep}`;
  if (!processes.some((process) =>
    process.ppid === pid && process.command.startsWith(frameworkPrefix)
  )) {
    return { ok: false, reason: "auth_browser_process_framework_missing" };
  }
  if (!new RegExp(`-${pid}$`).test(String(singletonTarget ?? ""))) {
    return { ok: false, reason: "auth_browser_process_singleton_missing" };
  }
  return { ok: true, reason: "auth_browser_process_running", pid };
}

export async function verifyAuthBrowserLaunchAgent({
  userHome = os.homedir(),
  uid = process.getuid?.(),
  run = execFile
} = {}) {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    return { ok: false, reason: "auth_browser_service_uid_unavailable" };
  }
  const executable = stableAuthChromeExecutableDecision({ userHome });
  if (!executable.ok) return executable;
  const signature = await verifyGoogleChromeBundle({
    appBundlePath: executable.appBundlePath,
    run
  });
  if (!signature.ok) return signature;
  let launchctlResult;
  try {
    launchctlResult = await run(
      "/bin/launchctl",
      ["print", `gui/${uid}/${AUTH_BROWSER_LABEL}`],
      commandOptions(10_000)
    );
  } catch {
    return { ok: false, reason: "auth_browser_service_not_loaded" };
  }
  const service = authBrowserLaunchAgentDecision({
    output: launchctlResult?.stdout,
    chromeExecutable: executable.chromeExecutable,
    dataDir: executable.dataDir
  });
  if (!service.ok) return service;

  let processes;
  try {
    processes = await run(
      "/bin/ps",
      ["-axo", "pid=,ppid=,command="],
      commandOptions(10_000)
    );
  } catch {
    return { ok: false, reason: "auth_browser_process_inventory_unavailable" };
  }
  let singletonTarget;
  try {
    singletonTarget = fs.readlinkSync(path.join(executable.dataDir, "SingletonLock"));
  } catch {
    singletonTarget = null;
  }
  const process = authBrowserProcessDecision({
    launchctlOutput: launchctlResult?.stdout,
    processOutput: processes?.stdout,
    singletonTarget,
    appBundlePath: executable.appBundlePath,
    chromeExecutable: executable.chromeExecutable,
    dataDir: executable.dataDir
  });
  return process.ok
    ? { ok: true, reason: "auth_browser_service_running", pid: process.pid }
    : process;
}

export async function waitForAuthBrowserLaunchAgent({
  userHome = os.homedir(),
  uid = process.getuid?.(),
  run = execFile,
  attempts = 5,
  retryDelayMs = 1_000,
  sleep = delay
} = {}) {
  const maxAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  let result = { ok: false, reason: "auth_browser_service_not_checked" };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await verifyAuthBrowserLaunchAgent({ userHome, uid, run });
    if (
      result.ok ||
      ![
        "auth_browser_service_not_loaded",
        "auth_browser_service_not_running",
        "auth_browser_process_pid_missing",
        "auth_browser_process_identity_mismatch",
        "auth_browser_process_framework_missing",
        "auth_browser_process_singleton_missing",
        "auth_browser_process_inventory_unavailable"
      ].includes(result.reason) ||
      attempt === maxAttempts
    ) {
      return { ...result, attempts: attempt };
    }
    await sleep(retryDelayMs);
  }
  return { ...result, attempts: maxAttempts };
}

function parseProcessInventory(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }];
    });
}

function recursiveQuarantinePresent(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .some((line) => /:\s*com\.apple\.quarantine:/.test(line));
}

function transientApplicationPath(value) {
  const normalized = path.resolve(value);
  return (
    normalized === "/Volumes" ||
    normalized.startsWith(`/Volumes${path.sep}`) ||
    /(?:^|\/)AppTranslocation(?:\/|$)/.test(normalized)
  );
}

function launchctlFieldContains(value, field, expected) {
  if (!expected) return false;
  return value.split("\n").some((line) => {
    const match = line.match(new RegExp(`^\\s*${field}\\s*=\\s*(.*?)\\s*$`));
    return match?.[1] === expected;
  });
}

function commandOptions(timeout) {
  return { timeout, maxBuffer: 1024 * 1024 };
}

function execFileTimedOut(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    error.code === null &&
    error.killed === true &&
    error.signal === "SIGTERM" &&
    error.stdout === "" &&
    error.stderr === ""
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
