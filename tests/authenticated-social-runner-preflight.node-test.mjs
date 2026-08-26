import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOpenCliChildEnvironment } from "../scripts/lib/opencli-runtime.mjs";
import {
  instagramIdentityProbeJs,
  instagramSelfIdentityDecision,
  linkedInIdentityProbeJs,
  linkedinViewerIdentityDecision,
  normalizeInstagramViewerHandle,
  normalizeLinkedInViewerSlug,
  readableRunnerConfiguration,
  retryAuthenticatedPreflight,
  runAuthenticatedSocialRunnerPreflight,
  resolveOpenCliProfileConfiguration,
  verifyOpenCliBrowserProfileConnection
} from "../scripts/verify-authenticated-social-runner.mjs";

test("Instagram preflight requires an exact HTTPS account-settings self signal", () => {
  const base = {
    expectedHandle: "AllenXTech",
    currentUrl: "https://www.instagram.com/accounts/edit/",
    selfHandle: "allenxtech",
    settingsSurface: true,
    safetyStateKnown: true
  };
  assert.deepEqual(instagramSelfIdentityDecision(base), {
    ok: true,
    reason: "instagram_self_account_verified"
  });
  for (const override of [
    { settingsSurface: false },
    { safetyStateKnown: false },
    { currentUrl: "https://www.instagram.com/another-user/" },
    { currentUrl: "http://www.instagram.com/accounts/edit/" },
    { currentUrl: "https://help.instagram.com/accounts/edit/" },
    { currentUrl: "https://evil.instagram.com/accounts/edit/" },
    { selfHandle: "another-user" },
    { selfHandle: null },
    { loginWall: true },
    { challenge: true },
    { rateLimited: true }
  ]) {
    assert.equal(instagramSelfIdentityDecision({ ...base, ...override }).ok, false);
  }
});

test("LinkedIn requires /in/me/ to redirect and positive own-account controls", () => {
  const base = {
    expectedSlug: "allen-xu-474108336",
    currentUrl: "https://www.linkedin.com/in/allen-xu-474108336/",
    canonicalUrl: "https://www.linkedin.com/in/allen-xu-474108336/",
    safetyStateKnown: true,
    authenticatedNavControl: true,
    ownerEditControl: true
  };
  assert.deepEqual(linkedinViewerIdentityDecision(base), {
    ok: true,
    reason: "linkedin_self_profile_verified"
  });
  assert.deepEqual(linkedinViewerIdentityDecision({
    ...base,
    expectedSlug: "https://www.linkedin.com/in/allen-xu-474108336/"
  }), {
    ok: true,
    reason: "linkedin_self_profile_verified"
  });
  assert.deepEqual(linkedinViewerIdentityDecision({
    ...base,
    canonicalUrl: null
  }), {
    ok: true,
    reason: "linkedin_self_profile_verified"
  });

  assert.deepEqual(linkedinViewerIdentityDecision({
    ...base,
    currentUrl: "https://www.linkedin.com/in/someone-else/",
    canonicalUrl: null
  }), {
    ok: false,
    reason: "linkedin_redirect_slug_mismatch"
  });
  assert.deepEqual(linkedinViewerIdentityDecision({
    ...base,
    canonicalUrl: null,
    ownerEditControl: false
  }), {
    ok: false,
    reason: "linkedin_owner_control_missing"
  });
  assert.deepEqual(linkedinViewerIdentityDecision({
    ...base,
    canonicalUrl: null,
    authenticatedNavControl: false
  }), {
    ok: false,
    reason: "linkedin_authenticated_navigation_missing"
  });
  assert.deepEqual(linkedinViewerIdentityDecision({
    ...base,
    canonicalUrl: "https://www.linkedin.com/in/someone-else/"
  }), {
    ok: false,
    reason: "linkedin_canonical_slug_mismatch"
  });

  // A matching public profile URL/canonical pair is not authenticated
  // self-account proof without both authenticated navigation and owner edit UI.
  assert.equal(linkedinViewerIdentityDecision({
    expectedSlug: base.expectedSlug,
    currentUrl: base.currentUrl,
    canonicalUrl: base.canonicalUrl,
    safetyStateKnown: true
  }).ok, false);

  for (const override of [
    { currentUrl: "https://www.linkedin.com/in/me/" },
    { canonicalUrl: "https://www.linkedin.com/in/someone-else/" },
    { currentUrl: "https://www.linkedin.com/in/someone-else/" },
    { currentUrl: "http://www.linkedin.com/in/allen-xu-474108336/" },
    { currentUrl: "https://help.linkedin.com/in/allen-xu-474108336/" },
    { canonicalUrl: "https://evil.linkedin.com/in/allen-xu-474108336/" },
    { safetyStateKnown: false },
    { authenticatedNavControl: false },
    { ownerEditControl: false },
    { loginWall: true },
    { challenge: true },
    { checkpoint: true },
    { rateLimited: true }
  ]) {
    assert.equal(linkedinViewerIdentityDecision({ ...base, ...override }).ok, false);
  }
});

test("OpenCLI 1.8.6 profile aliases resolve from OPENCLI_CONFIG_DIR", (t) => {
  const fixture = createRunnerFixture(t, {
    profileConfig: {
      version: 1,
      aliases: { "signed-in chrome": "context-123" },
      defaultContextId: "another-context"
    }
  });
  const alias = resolveOpenCliProfileConfiguration({
    openCliConfigDir: fixture.configDir,
    openCliProfile: " signed-in chrome ",
    homeDirectory: fixture.root
  });
  assert.deepEqual(alias, {
    ok: true,
    contextId: "context-123",
    source: "alias"
  });
  const context = resolveOpenCliProfileConfiguration({
    openCliConfigDir: fixture.configDir,
    openCliProfile: "context-123",
    homeDirectory: fixture.root
  });
  assert.deepEqual(context, {
    ok: true,
    contextId: "context-123",
    source: "context_id"
  });
});

test("OpenCLI profile config defaults exactly to ~/.opencli/browser-profiles.json", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "returner-opencli-default-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, ".opencli");
  mkdirSync(configDir);
  writeFileSync(path.join(configDir, "browser-profiles.json"), JSON.stringify({
    version: 1,
    aliases: { work: "context-work" }
  }));
  assert.deepEqual(resolveOpenCliProfileConfiguration({
    openCliProfile: "work",
    homeDirectory: root
  }), {
    ok: true,
    contextId: "context-work",
    source: "alias"
  });
});

test("an absent profile config preserves OPENCLI_PROFILE as a raw context ID", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "returner-opencli-raw-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missingConfigDir = path.join(root, "missing-opencli-config");
  assert.deepEqual(resolveOpenCliProfileConfiguration({
    openCliConfigDir: missingConfigDir,
    openCliProfile: " raw-context-123 ",
    homeDirectory: root
  }), {
    ok: true,
    contextId: "raw-context-123",
    source: "context_id_no_config"
  });

  const emptyConfigDir = path.join(root, "empty-opencli-config");
  mkdirSync(emptyConfigDir);
  assert.deepEqual(resolveOpenCliProfileConfiguration({
    openCliConfigDir: emptyConfigDir,
    openCliProfile: "raw-context-456",
    homeDirectory: root
  }), {
    ok: true,
    contextId: "raw-context-456",
    source: "context_id_no_config"
  });
});

test("a present malformed browser-profiles.json fails closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "returner-opencli-malformed-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, "opencli-config");
  mkdirSync(configDir);
  const configPath = path.join(configDir, "browser-profiles.json");
  writeFileSync(configPath, "{not-json");
  assert.equal(resolveOpenCliProfileConfiguration({
    openCliConfigDir: configDir,
    openCliProfile: "raw-context"
  }).ok, false);

  writeFileSync(configPath, JSON.stringify({ version: 1, aliases: [] }));
  assert.deepEqual(resolveOpenCliProfileConfiguration({
    openCliConfigDir: configDir,
    openCliProfile: "raw-context"
  }), { ok: false, reason: "opencli_profile_config_invalid" });

  writeFileSync(configPath, JSON.stringify({ version: 1, aliases: { work: 42 } }));
  assert.deepEqual(resolveOpenCliProfileConfiguration({
    openCliConfigDir: configDir,
    openCliProfile: "raw-context"
  }), { ok: false, reason: "opencli_profile_config_invalid" });

  writeFileSync(configPath, JSON.stringify({
    version: 1,
    aliases: {},
    defaultContextId: 42
  }));
  assert.deepEqual(resolveOpenCliProfileConfiguration({
    openCliConfigDir: configDir,
    openCliProfile: "raw-context"
  }), { ok: false, reason: "opencli_profile_config_invalid" });
});

test("runner executable must match the exact runtime realpath and inode", (t) => {
  const fixture = createRunnerFixture(t);
  const approvedLink = path.join(fixture.root, "approved opencli");
  symlinkSync(fixture.binaryA, approvedLink);

  const valid = readableRunnerConfiguration({
    openCliBin: approvedLink,
    openCliHome: fixture.openCliHome,
    openCliProfile: "authenticated",
    openCliConfigDir: fixture.configDir,
    runtimeResolver: () => ({ command: fixture.binaryA })
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.executableRealPath, realpathSync.native(fixture.binaryA));

  const mismatch = readableRunnerConfiguration({
    openCliBin: approvedLink,
    openCliHome: fixture.openCliHome,
    openCliProfile: "authenticated",
    openCliConfigDir: fixture.configDir,
    runtimeResolver: () => ({ command: fixture.binaryB })
  });
  assert.deepEqual(mismatch, { ok: false, reason: "opencli_runtime_realpath_mismatch" });

  const swappedLink = path.join(fixture.root, "swapped-opencli");
  symlinkSync(fixture.binaryA, swappedLink);
  const swapped = readableRunnerConfiguration({
    openCliBin: swappedLink,
    openCliHome: fixture.openCliHome,
    openCliProfile: "authenticated",
    openCliConfigDir: fixture.configDir,
    runtimeResolver: () => {
      unlinkSync(swappedLink);
      symlinkSync(fixture.binaryB, swappedLink);
      return { command: swappedLink };
    }
  });
  assert.deepEqual(swapped, { ok: false, reason: "opencli_runtime_realpath_mismatch" });
});

test("runner configuration fails closed before any browser operation", () => {
  const result = readableRunnerConfiguration({
    openCliBin: "/definitely/missing/opencli",
    openCliHome: "/definitely/missing/opencli-home",
    openCliProfile: "authenticated",
    runtimeResolver: () => ({ command: "/definitely/missing/opencli" })
  });
  assert.deepEqual(result, { ok: false, reason: "opencli_executable_unresolvable" });
  assert.equal(normalizeInstagramViewerHandle("@AllenXTech"), "allenxtech");
  assert.equal(normalizeInstagramViewerHandle("bad handle"), null);
  assert.equal(normalizeLinkedInViewerSlug("Allen-Xu-474108336/"), "allen-xu-474108336");
  assert.equal(
    normalizeLinkedInViewerSlug("https://www.linkedin.com/in/Allen-Xu-474108336/"),
    "allen-xu-474108336"
  );
  assert.equal(
    normalizeLinkedInViewerSlug("https://linkedin.com/in/allen-xu-474108336"),
    "allen-xu-474108336"
  );
  for (const invalid of [
    "http://www.linkedin.com/in/allen-xu-474108336/",
    "https://user@www.linkedin.com/in/allen-xu-474108336/",
    "https://www.linkedin.com:443/in/allen-xu-474108336/",
    "https://www.linkedin.com:8443/in/allen-xu-474108336/",
    "https://help.linkedin.com/in/allen-xu-474108336/",
    "https://www.linkedin.com/in/allen-xu-474108336/details/",
    "https://www.linkedin.com/in/allen-xu-474108336/?trk=profile",
    "https://www.linkedin.com/in/allen-xu-474108336/#about",
    "https://www.linkedin.com/in/allen%2Dxu-474108336/"
  ]) {
    assert.equal(normalizeLinkedInViewerSlug(invalid), null, invalid);
  }
  assert.equal(normalizeLinkedInViewerSlug("bad slug!"), null);
});

test("identity probes combine URL and DOM safety over a bounded window beyond 5k", () => {
  for (const source of [instagramIdentityProbeJs(), linkedInIdentityProbeJs()]) {
    assert.match(source, /slice\(0, 200000\)/);
    assert.doesNotMatch(source, /slice\(0, 5000\)/);
    assert.match(source, /document\.querySelector/);
    assert.match(source, /location\.(?:href|pathname)/);
    assert.doesNotMatch(source, /bodyText:|text:/);
  }
  assert.match(linkedInIdentityProbeJs(), /ownerEditControl/);
  assert.match(linkedInIdentityProbeJs(), /authenticatedNavControl/);
});

test("OPENCLI_CONFIG_DIR is preserved for OpenCLI child profile resolution", () => {
  const child = buildOpenCliChildEnvironment({
    OPENCLI_CONFIG_DIR: "/runner/opencli-config",
    OPENCLI_HOME: "/runner/opencli-home",
    PATH: "/usr/bin:/bin"
  }, { nodeBinDir: "/node/bin" });
  assert.equal(child.OPENCLI_CONFIG_DIR, "/runner/opencli-config");
  assert.equal(child.OPENCLI_HOME, "/runner/opencli-home");
});

test("cold preflight retries a disconnected profile and proves the exact Instagram adapter last", async (t) => {
  const fixture = createRunnerFixture(t);
  const env = authenticatedPreflightEnvironment(fixture);
  const calls = [];
  const sleeps = [];
  let instagramAdapterAttempts = 0;
  const runCommand = async (args) => {
    calls.push(args);
    if (args[0] === "instagram") {
      instagramAdapterAttempts += 1;
      assert.deepEqual(args, [
        "instagram",
        "profile",
        "allenxtech",
        "-f",
        "json",
        "--site-session",
        "persistent"
      ]);
      if (instagramAdapterAttempts === 1) {
        throw new Error('Browser profile "4dwub6zw" is not connected');
      }
      return JSON.stringify({ username: "allenxtech" });
    }
    if (args[0] === "browser" && args[2] === "eval") {
      return args[1].startsWith("preflight-li-")
        ? JSON.stringify([linkedInReadySignal()])
        : JSON.stringify([instagramReadySignal()]);
    }
    return "";
  };

  const result = await runAuthenticatedSocialRunnerPreflight({
    env,
    runCommand,
    runtimeResolver: () => ({ command: fixture.binaryA }),
    verifyBrowserService: async () => ({
      ok: true,
      reason: "auth_browser_service_running"
    }),
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  assert.equal(result.ok, true);
  assert.equal(result.service.attempts, 1);
  assert.deepEqual(result.service.profile, {
    ok: true,
    reason: "auth_browser_profile_connected",
    retryable: false,
    attempts: 1
  });
  assert.equal(result.linkedin.attempts, 1);
  assert.equal(result.instagram.attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
  const linkedinEvalIndex = calls.findIndex((args) =>
    args[0] === "browser" && args[1].startsWith("preflight-li-") && args[2] === "eval"
  );
  const firstInstagramAdapterIndex = calls.findIndex((args) => args[0] === "instagram");
  const instagramEvalIndex = calls.findIndex((args) =>
    args[0] === "browser" && args[1].startsWith("preflight-ig-") && args[2] === "eval"
  );
  assert.ok(linkedinEvalIndex > -1 && linkedinEvalIndex < firstInstagramAdapterIndex);
  assert.ok(instagramEvalIndex > firstInstagramAdapterIndex);
  assert.equal(calls.at(-1)[0], "browser");
  assert.equal(calls.at(-1)[2], "close");
  assert.match(calls.at(-1)[1], /^preflight-ig-/);
});

test("strict preflight fails closed before platform probes when the exact profile is disconnected", async (t) => {
  const fixture = createRunnerFixture(t);
  const env = authenticatedPreflightEnvironment(fixture);
  const calls = [];
  const sleeps = [];
  const result = await runAuthenticatedSocialRunnerPreflight({
    env,
    runtimeResolver: () => ({ command: fixture.binaryA }),
    verifyBrowserService: async () => ({
      ok: true,
      reason: "auth_browser_service_running",
      pid: 8123
    }),
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === "browser" && args[2] === "close") return "";
      throw new Error('Browser profile "context-authenticated" is not connected');
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds)
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "auth_browser_profile_not_connected");
  assert.equal(result.service.ok, false);
  assert.equal(result.service.reason, "auth_browser_profile_not_connected");
  assert.equal(result.service.attempts, 5);
  assert.deepEqual(result.service.launchAgent, {
    ok: true,
    reason: "auth_browser_service_running",
    pid: 8123,
    retryable: false,
    attempts: 1
  });
  assert.equal(result.instagram.reason, "auth_browser_profile_not_connected");
  assert.equal(result.linkedin.reason, "auth_browser_profile_not_connected");
  assert.equal(result.instagram.attempts, 0);
  assert.equal(result.linkedin.attempts, 0);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 8_000]);
  assert.equal(calls.filter((args) => args[2] === "open").length, 5);
  assert.equal(calls.filter((args) => args[2] === "close").length, 5);
  assert.equal(calls.some((args) => args[0] === "instagram"), false);
  assert.equal(calls.some((args) => args[1]?.startsWith("preflight-li-")), false);
});

test("profile connection probe does not retry a non-transient command failure", async () => {
  const result = await verifyOpenCliBrowserProfileConnection(async (args) => {
    if (args[2] === "close") return "";
    throw new Error("invalid browser command");
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "auth_browser_profile_probe_failed",
    retryable: false
  });
});

test("scheduled preflight skips absent configuration and preserves per-platform debt", async (t) => {
  let calls = 0;
  const skipped = await runAuthenticatedSocialRunnerPreflight({
    env: {},
    runCommand: async () => {
      calls += 1;
    },
    verifyBrowserService: async () => {
      calls += 1;
    }
  });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.instagram.attempts, 0);
  assert.equal(skipped.linkedin.attempts, 0);
  assert.equal(calls, 0);

  const fixture = createRunnerFixture(t);
  const env = authenticatedPreflightEnvironment(fixture);
  const partial = await runAuthenticatedSocialRunnerPreflight({
    env,
    runtimeResolver: () => ({ command: fixture.binaryA }),
    verifyBrowserService: async () => ({ ok: true, reason: "auth_browser_service_running" }),
    runCommand: async (args) => {
      if (args[0] === "instagram") return JSON.stringify({ username: "allenxtech" });
      if (args[0] === "browser" && args[2] === "eval") {
        return args[1].startsWith("preflight-li-")
          ? JSON.stringify([{ ...linkedInReadySignal(), loginWall: true }])
          : JSON.stringify([instagramReadySignal()]);
      }
      return "";
    },
    sleep: async () => {}
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.instagram.ok, true);
  assert.equal(partial.linkedin.ok, false);
  assert.equal(partial.linkedin.reason, "linkedin_login_wall");
  assert.equal(partial.linkedin.attempts, 1);
});

test("preflight retry stops immediately for non-transient account safety states", async () => {
  const sleeps = [];
  let attempts = 0;
  const result = await retryAuthenticatedPreflight(
    async () => {
      attempts += 1;
      return { ok: false, reason: "instagram_challenge_page", retryable: false };
    },
    {
      attempts: 3,
      retryDelaysMs: [2_000, 5_000],
      sleep: async (milliseconds) => sleeps.push(milliseconds)
    }
  );
  assert.equal(result.attempts, 1);
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

function createRunnerFixture(t, {
  profileConfig = { version: 1, aliases: { authenticated: "context-authenticated" } }
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "returner-auth-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const openCliHome = path.join(root, "opencli-home");
  const configDir = path.join(root, "opencli-config");
  mkdirSync(openCliHome);
  mkdirSync(configDir);
  writeFileSync(path.join(configDir, "browser-profiles.json"), JSON.stringify(profileConfig));
  const binaryA = path.join(root, "opencli-a");
  const binaryB = path.join(root, "opencli-b");
  writeFileSync(binaryA, "#!/bin/sh\nexit 0\n");
  writeFileSync(binaryB, "#!/bin/sh\nexit 0\n");
  chmodSync(binaryA, 0o755);
  chmodSync(binaryB, 0o755);
  return { root, openCliHome, configDir, binaryA, binaryB };
}

function authenticatedPreflightEnvironment(fixture) {
  return {
    HOME: fixture.root,
    OPENCLI_BIN: fixture.binaryA,
    OPENCLI_HOME: fixture.openCliHome,
    OPENCLI_PROFILE: "authenticated",
    OPENCLI_CONFIG_DIR: fixture.configDir,
    RETURNER_LINKEDIN_VIEWER_PROFILE: "https://www.linkedin.com/in/allen-xu-474108336/",
    RETURNER_INSTAGRAM_VIEWER_HANDLE: "allenxtech"
  };
}

function instagramReadySignal() {
  return {
    currentUrl: "https://www.instagram.com/accounts/edit/",
    selfHandle: "allenxtech",
    settingsSurface: true,
    safetyStateKnown: true,
    loginWall: false,
    challenge: false,
    rateLimited: false
  };
}

function linkedInReadySignal() {
  return {
    currentUrl: "https://www.linkedin.com/in/allen-xu-474108336/",
    canonicalUrl: "https://www.linkedin.com/in/allen-xu-474108336/",
    safetyStateKnown: true,
    loginWall: false,
    challenge: false,
    checkpoint: false,
    rateLimited: false,
    ownerEditControl: true,
    authenticatedNavControl: true
  };
}
