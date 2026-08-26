import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const AUTH_BROWSER_LABEL = "com.returner-fund.auth-chrome-runner";
export const AUTH_CHROME_BUNDLE_IDENTIFIER = "com.google.Chrome";
export const AUTH_CHROME_TEAM_IDENTIFIER = "EQHXZ8M8AV";

export function authBrowserHostConfiguration({ userHome = os.homedir() } = {}) {
  const normalizedHome = path.resolve(String(userHome));
  const appBundlePath = path.join(normalizedHome, "Applications", "Google Chrome.app");
  return {
    appBundlePath,
    chromeExecutable: path.join(appBundlePath, "Contents", "MacOS", "Google Chrome"),
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
    await run(
      "/usr/sbin/spctl",
      ["--assess", "--type", "execute", appBundlePath],
      commandOptions(30_000)
    );
    return { ok: true, reason: "auth_chrome_vendor_signature_verified" };
  } catch {
    return { ok: false, reason: "auth_chrome_vendor_signature_unverified" };
  }
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
  try {
    const result = await run(
      "/bin/launchctl",
      ["print", `gui/${uid}/${AUTH_BROWSER_LABEL}`],
      commandOptions(10_000)
    );
    return authBrowserLaunchAgentDecision({
      output: result?.stdout,
      chromeExecutable: executable.chromeExecutable,
      dataDir: executable.dataDir
    });
  } catch {
    return { ok: false, reason: "auth_browser_service_not_loaded" };
  }
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
        "auth_browser_service_not_running"
      ].includes(result.reason) ||
      attempt === maxAttempts
    ) {
      return { ...result, attempts: attempt };
    }
    await sleep(retryDelayMs);
  }
  return { ...result, attempts: maxAttempts };
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
