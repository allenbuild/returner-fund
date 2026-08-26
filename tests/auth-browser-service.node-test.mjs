import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTH_BROWSER_LABEL,
  AUTH_CHROME_BUNDLE_IDENTIFIER,
  AUTH_CHROME_TEAM_IDENTIFIER,
  authBrowserHostConfiguration,
  authBrowserLaunchAgentDecision,
  authBrowserProcessDecision,
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

test("auth Chrome verification requires the exact Google bundle, team, and host trust", async () => {
  const calls = [];
  const verified = await verifyGoogleChromeBundle({
    appBundlePath: "/Users/tester/Applications/Google Chrome Canary.app",
    run: async (command, args) => {
      calls.push([command, ...args]);
      return args[0] === "-dv"
        ? {
            stdout: "",
            stderr: `Identifier=${AUTH_CHROME_BUNDLE_IDENTIFIER}\nTeamIdentifier=${AUTH_CHROME_TEAM_IDENTIFIER}\n`
          }
        : command === "/usr/bin/xattr"
          ? { stdout: "/nested/component: com.apple.provenance: value\n", stderr: "" }
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
    "/usr/bin/xattr",
    "/usr/sbin/spctl"
  ]);

  for (const detail of [
    `Identifier=com.google.Chrome\nTeamIdentifier=${AUTH_CHROME_TEAM_IDENTIFIER}\n`,
    `Identifier=${AUTH_CHROME_BUNDLE_IDENTIFIER}\nTeamIdentifier=UNTRUSTEDTEAM\n`
  ]) {
    const mismatch = await verifyGoogleChromeBundle({
      appBundlePath: "/Users/tester/Applications/Google Chrome Canary.app",
      run: async (_command, args) => args[0] === "-dv"
        ? { stdout: detail, stderr: "" }
        : { stdout: "", stderr: "" }
    });
    assert.deepEqual(mismatch, {
      ok: false,
      reason: "auth_chrome_vendor_signature_mismatch"
    });
  }

  const quarantined = await verifyGoogleChromeBundle({
    appBundlePath: "/Users/tester/Applications/Google Chrome Canary.app",
    run: async (command, args) => {
      if (command === "/usr/bin/codesign" && args[0] === "-dv") {
        return {
          stdout: "",
          stderr: `Identifier=${AUTH_CHROME_BUNDLE_IDENTIFIER}\nTeamIdentifier=${AUTH_CHROME_TEAM_IDENTIFIER}\n`
        };
      }
      if (command === "/usr/bin/xattr") {
        return {
          stdout: "/Users/tester/Applications/Google Chrome Canary.app/Contents/Frameworks/nested: com.apple.quarantine: 0083;...\n",
          stderr: ""
        };
      }
      return { stdout: "", stderr: "" };
    }
  });
  assert.deepEqual(quarantined, {
    ok: false,
    reason: "auth_chrome_bundle_quarantined"
  });
});

test("auth browser service proves signature, process tree, singleton, and launch arguments", async (t) => {
  const fixture = await createChromeFixture(t);
  const launchctlOutput = launchctlFixture(fixture);
  const run = async (command, args) => {
    if (command === "/usr/bin/codesign" && args[0] === "-dv") {
      return {
        stdout: "",
        stderr: `Identifier=${AUTH_CHROME_BUNDLE_IDENTIFIER}\nTeamIdentifier=${AUTH_CHROME_TEAM_IDENTIFIER}\n`
      };
    }
    if (command === "/bin/launchctl") {
      assert.deepEqual(args, ["print", `gui/501/${AUTH_BROWSER_LABEL}`]);
      return { stdout: launchctlOutput, stderr: "" };
    }
    if (command === "/bin/ps") {
      return { stdout: processFixture(fixture), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  assert.deepEqual(await verifyAuthBrowserLaunchAgent({
    userHome: fixture.userHome,
    uid: 501,
    run
  }), {
    ok: true,
    reason: "auth_browser_service_running",
    pid: 8123
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

test("auth browser process proof rejects a dormant or redirected launcher", async (t) => {
  const fixture = await createChromeFixture(t);
  const input = {
    launchctlOutput: launchctlFixture(fixture),
    processOutput: processFixture(fixture),
    singletonTarget: "test-host-8123",
    appBundlePath: fixture.paths.appBundlePath,
    chromeExecutable: fixture.paths.chromeExecutable,
    dataDir: fixture.paths.dataDir
  };
  assert.deepEqual(authBrowserProcessDecision(input), {
    ok: true,
    reason: "auth_browser_process_running",
    pid: 8123
  });
  assert.deepEqual(authBrowserProcessDecision({
    ...input,
    processOutput: processFixture(fixture).split("\n")[0]
  }), {
    ok: false,
    reason: "auth_browser_process_framework_missing"
  });
  assert.deepEqual(authBrowserProcessDecision({
    ...input,
    singletonTarget: "test-host-9999"
  }), {
    ok: false,
    reason: "auth_browser_process_singleton_missing"
  });
  assert.deepEqual(authBrowserProcessDecision({
    ...input,
    processOutput: processFixture(fixture).replace(
      fixture.paths.chromeExecutable,
      "/private/var/folders/AppTranslocation/Google Chrome Canary"
    )
  }), {
    ok: false,
    reason: "auth_browser_process_identity_mismatch"
  });
});

test("auth browser service wait retries cold launch and process health states", async (t) => {
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
          stderr: `Identifier=${AUTH_CHROME_BUNDLE_IDENTIFIER}\nTeamIdentifier=${AUTH_CHROME_TEAM_IDENTIFIER}\n`
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
          stdout: launchctlFixture(fixture),
          stderr: ""
        };
      }
      if (command === "/bin/ps") {
        return {
          stdout: launchctlAttempts === 2
            ? processFixture(fixture).split("\n")[0]
            : processFixture(fixture),
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
  assert.equal(result.attempts, 3);
  assert.equal(launchctlAttempts, 3);
  assert.deepEqual(sleeps, [250, 250]);
});

async function createChromeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "returner-auth-browser-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = path.join(root, "home");
  const paths = authBrowserHostConfiguration({ userHome });
  await mkdir(path.dirname(paths.chromeExecutable), { recursive: true });
  await writeFile(paths.chromeExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(paths.chromeExecutable, 0o755);
  await mkdir(paths.dataDir, { recursive: true });
  await symlink("test-host-8123", path.join(paths.dataDir, "SingletonLock"));
  return { root, userHome, paths };
}

function launchctlFixture(fixture) {
  return [
    `${AUTH_BROWSER_LABEL} = {`,
    "\tstate = running",
    "\tpid = 8123",
    `\tprogram = ${fixture.paths.chromeExecutable}`,
    "\targuments = {",
    `\t\t--user-data-dir=${fixture.paths.dataDir}`,
    "\t}",
    "}"
  ].join("\n");
}

function processFixture(fixture) {
  return [
    `8123 1 ${fixture.paths.chromeExecutable} --user-data-dir=${fixture.paths.dataDir} --profile-directory=Default --no-first-run --no-default-browser-check about:blank`,
    `8124 8123 ${fixture.paths.appBundlePath}/Contents/Frameworks/Google Chrome Framework.framework/Versions/Current/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process`
  ].join("\n");
}
