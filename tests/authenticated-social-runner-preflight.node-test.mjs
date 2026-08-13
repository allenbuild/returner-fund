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
  resolveOpenCliProfileConfiguration
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
