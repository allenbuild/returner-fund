import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTH_BROWSER_LABEL,
  authBrowserHostConfiguration,
  authBrowserLaunchAgentDecision,
  stableAuthChromeExecutableDecision,
  verifyAuthBrowserLaunchAgent,
  verifyGoogleChromeBundle,
  waitForAuthBrowserLaunchAgent
} from "../scripts/lib/auth-browser-service.mjs";

test("auth Chrome executable must be the exact non-symlinked local application path", async (t) => {
  const fixture = await createChromeFixture(t);
  const accepted = stableAuthChromeExecutableDecision({ userHome: fixture.userHome });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.chromeExecutable, fixture.paths.chromeExecutable);
  assert.equal(accepted.dataDir, fixture.paths.dataDir);

  assert.deepEqual(stableAuthChromeExecutableDecision({
    userHome: fixture.userHome,
    chromeExecutable: "/Volumes/Google Chrome/Google Chrome"
  }), {
    ok: false,
    reason: "auth_chrome_executable_not_dedicated_local_path"
  });

  const target = path.join(fixture.root, "other-chrome");
  await writeFile(target, "#!/bin/sh\nexit 0\n");
  await chmod(target, 0o755);
  await unlink(fixture.paths.chromeExecutable);
  await symlink(target, fixture.paths.chromeExecutable);
  assert.deepEqual(stableAuthChromeExecutableDecision({ userHome: fixture.userHome }), {
    ok: false,
    reason: "auth_chrome_executable_not_stable"
  });
});

test("Google Chrome verification requires the exact Google bundle and team identifiers", async () => {
  const calls = [];
  const verified = await verifyGoogleChromeBundle({
    appBundlePath: "/Users/tester/Applications/Google Chrome.app",
    run: async (command, args) => {
      calls.push([command, ...args]);
      return args[0] === "-dv"
        ? {
            stdout: "",
            stderr: "Identifier=com.google.Chrome\nTeamIdentifier=EQHXZ8M8AV\n"
          }
        : { stdout: "", stderr: "" };
    }
  });
  assert.deepEqual(verified, {
    ok: true,
    reason: "auth_chrome_vendor_signature_verified"
  });
  assert.deepEqual(calls.map(([command]) => command), [
    "/usr/bin/codesign",
    "/usr/bin/codesign",
    "/usr/sbin/spctl"
  ]);

  const mismatch = await verifyGoogleChromeBundle({
    appBundlePath: "/Users/tester/Applications/Google Chrome.app",
    run: async (_command, args) => args[0] === "-dv"
      ? {
          stdout: "Identifier=com.google.Chrome\nTeamIdentifier=UNTRUSTEDTEAM\n",
          stderr: ""
        }
      : { stdout: "", stderr: "" }
  });
  assert.deepEqual(mismatch, {
    ok: false,
    reason: "auth_chrome_vendor_signature_mismatch"
  });
});

test("auth browser service proves signature, running state, executable, and data directory", async (t) => {
  const fixture = await createChromeFixture(t);
  const launchctlOutput = [
    `${AUTH_BROWSER_LABEL} = {`,
    "\tstate = running",
    `\tprogram = ${fixture.paths.chromeExecutable}`,
    "\targuments = {",
    `\t\t--user-data-dir=${fixture.paths.dataDir}`,
    "\t}",
    "}"
  ].join("\n");
  const run = async (command, args) => {
    if (command === "/usr/bin/codesign" && args[0] === "-dv") {
      return {
        stdout: "",
        stderr: "Identifier=com.google.Chrome\nTeamIdentifier=EQHXZ8M8AV\n"
      };
    }
    if (command === "/bin/launchctl") {
      assert.deepEqual(args, ["print", `gui/501/${AUTH_BROWSER_LABEL}`]);
      return { stdout: launchctlOutput, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  assert.deepEqual(await verifyAuthBrowserLaunchAgent({
    userHome: fixture.userHome,
    uid: 501,
    run
  }), {
    ok: true,
    reason: "auth_browser_service_running"
  });

  assert.deepEqual(authBrowserLaunchAgentDecision({
    output: launchctlOutput.replace(fixture.paths.dataDir, "/tmp/ephemeral"),
    chromeExecutable: fixture.paths.chromeExecutable,
    dataDir: fixture.paths.dataDir
  }), {
    ok: false,
    reason: "auth_browser_service_data_dir_mismatch"
  });
  assert.deepEqual(authBrowserLaunchAgentDecision({
    output: launchctlOutput.replace("state = running", "state = exited"),
    chromeExecutable: fixture.paths.chromeExecutable,
    dataDir: fixture.paths.dataDir
  }), {
    ok: false,
    reason: "auth_browser_service_not_running"
  });
});

test("auth browser service wait retries only cold not-loaded and not-running states", async (t) => {
  const fixture = await createChromeFixture(t);
  let launchctlAttempts = 0;
  const sleeps = [];
  const result = await waitForAuthBrowserLaunchAgent({
    userHome: fixture.userHome,
    uid: 501,
    run: async (command, args) => {
      if (command === "/usr/bin/codesign" && args[0] === "-dv") {
        return {
          stdout: "",
          stderr: "Identifier=com.google.Chrome\nTeamIdentifier=EQHXZ8M8AV\n"
        };
      }
      if (command === "/bin/launchctl") {
        launchctlAttempts += 1;
        if (launchctlAttempts === 1) {
          const error = new Error("Could not find service");
          error.code = 3;
          throw error;
        }
        return {
          stdout: [
            "state = running",
            `program = ${fixture.paths.chromeExecutable}`,
            `--user-data-dir=${fixture.paths.dataDir}`
          ].join("\n"),
          stderr: ""
        };
      }
      return { stdout: "", stderr: "" };
    },
    attempts: 3,
    retryDelayMs: 250,
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(launchctlAttempts, 2);
  assert.deepEqual(sleeps, [250]);
});

async function createChromeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "returner-auth-browser-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = path.join(root, "home");
  const paths = authBrowserHostConfiguration({ userHome });
  await mkdir(path.dirname(paths.chromeExecutable), { recursive: true });
  await writeFile(paths.chromeExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(paths.chromeExecutable, 0o755);
  return { root, userHome, paths };
}
