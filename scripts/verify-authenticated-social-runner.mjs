import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runOpenCli,
  resolveOpenCliRuntime
} from "./lib/opencli-runtime.mjs";
import { withOpenCliBrowserSession } from "./lib/opencli-browser-session.mjs";
import {
  instagramAdapterProfileIdentityDecision,
  instagramShouldRetryTransientBrowserFailure
} from "./lib/logged-in-instagram-collection.mjs";
import { verifyAuthBrowserLaunchAgent } from "./lib/auth-browser-service.mjs";

const INSTAGRAM_SETTINGS_URL = "https://www.instagram.com/accounts/edit/";
const LINKEDIN_SELF_URL = "https://www.linkedin.com/in/me/";
const MAX_COMMAND_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 8_000;
const MAX_PROFILE_CONFIG_BYTES = 1024 * 1024;
const PLATFORM_PREFLIGHT_ATTEMPTS = 3;
const PLATFORM_PREFLIGHT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);
const SERVICE_PREFLIGHT_ATTEMPTS = 5;
const SERVICE_PREFLIGHT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000]);
const SERVICE_RETRYABLE_REASONS = new Set([
  "auth_browser_service_not_loaded",
  "auth_browser_service_not_running",
  "auth_browser_process_pid_missing",
  "auth_browser_process_identity_mismatch",
  "auth_browser_process_framework_missing",
  "auth_browser_process_singleton_missing",
  "auth_browser_process_inventory_unavailable"
]);
const AUTHENTICATED_RUNNER_REQUIRED_ENV = Object.freeze([
  "OPENCLI_BIN",
  "OPENCLI_HOME",
  "OPENCLI_PROFILE",
  "RETURNER_LINKEDIN_VIEWER_PROFILE",
  "RETURNER_INSTAGRAM_VIEWER_HANDLE"
]);
const INSTAGRAM_ADAPTER_FORMAT_ARGS = Object.freeze([
  "-f",
  "json",
  "--site-session",
  "persistent"
]);

export function normalizeInstagramViewerHandle(value) {
  const normalized = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(normalized) ? normalized : null;
}

export function normalizeLinkedInViewerSlug(value) {
  const candidate = String(value ?? "").trim();
  const bareSlug = candidate.replace(/^@/, "").replace(/\/$/, "").toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,99}$/.test(bareSlug)) return bareSlug;

  // Preserve the host's established canonical profile URL without widening
  // identity proof to arbitrary LinkedIn URLs, credentials, ports, or paths.
  if (!/^https:\/\/(?:www\.)?linkedin\.com\//i.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      !new Set(["linkedin.com", "www.linkedin.com"]).has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const match = /^\/in\/([a-z0-9][a-z0-9-]{0,99})\/?$/i.exec(url.pathname);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export function instagramSelfIdentityDecision({
  expectedHandle,
  currentUrl,
  selfHandle,
  settingsSurface = false,
  safetyStateKnown = false,
  loginWall = false,
  challenge = false,
  rateLimited = false
} = {}) {
  const expected = normalizeInstagramViewerHandle(expectedHandle);
  const observed = normalizeInstagramViewerHandle(selfHandle);
  if (!expected) return { ok: false, reason: "instagram_expected_handle_invalid" };
  if (safetyStateKnown !== true) return { ok: false, reason: "instagram_safety_state_unknown" };
  if (loginWall === true) return { ok: false, reason: "instagram_login_wall" };
  if (challenge === true) return { ok: false, reason: "instagram_challenge_page" };
  if (rateLimited === true) return { ok: false, reason: "instagram_rate_limited" };
  if (settingsSurface !== true || !isInstagramAccountSettingsUrl(currentUrl)) {
    return { ok: false, reason: "instagram_account_settings_missing" };
  }
  if (!observed) return { ok: false, reason: "instagram_self_handle_missing" };
  if (observed !== expected) return { ok: false, reason: "instagram_self_handle_mismatch" };
  return { ok: true, reason: "instagram_self_account_verified" };
}

export function linkedinViewerIdentityDecision({
  expectedSlug,
  currentUrl,
  canonicalUrl,
  safetyStateKnown = false,
  loginWall = false,
  challenge = false,
  checkpoint = false,
  rateLimited = false,
  ownerEditControl = false,
  authenticatedNavControl = false
} = {}) {
  const expected = normalizeLinkedInViewerSlug(expectedSlug);
  if (!expected) return { ok: false, reason: "linkedin_expected_slug_invalid" };
  if (safetyStateKnown !== true) return { ok: false, reason: "linkedin_safety_state_unknown" };
  if (loginWall === true) return { ok: false, reason: "linkedin_login_wall" };
  if (challenge === true) return { ok: false, reason: "linkedin_challenge_page" };
  if (checkpoint === true) return { ok: false, reason: "linkedin_checkpoint_page" };
  if (rateLimited === true) return { ok: false, reason: "linkedin_rate_limited" };

  const current = parseLinkedInUrl(currentUrl);
  const canonical = parseLinkedInUrl(canonicalUrl);
  if (!current || !canonical) return { ok: false, reason: "linkedin_identity_url_missing" };
  if (current.kind !== "profile" || current.slug !== expected) {
    return { ok: false, reason: "linkedin_redirect_slug_mismatch" };
  }
  if (canonical.kind !== "profile" || canonical.slug !== expected) {
    return { ok: false, reason: "linkedin_canonical_slug_mismatch" };
  }
  if (authenticatedNavControl !== true) {
    return { ok: false, reason: "linkedin_authenticated_navigation_missing" };
  }
  if (ownerEditControl !== true) {
    return { ok: false, reason: "linkedin_owner_control_missing" };
  }
  return { ok: true, reason: "linkedin_self_profile_verified" };
}

export function readableRunnerConfiguration({
  openCliBin = process.env.OPENCLI_BIN,
  openCliHome = process.env.OPENCLI_HOME,
  openCliProfile = process.env.OPENCLI_PROFILE,
  openCliConfigDir = process.env.OPENCLI_CONFIG_DIR,
  homeDirectory = os.homedir(),
  searchPath = process.env.PATH,
  runtimeResolver = resolveOpenCliRuntime
} = {}) {
  const executable = resolveExecutable(openCliBin, { searchPath });
  if (!executable) return { ok: false, reason: "opencli_executable_unresolvable" };
  let runtimeExecutable;
  try {
    const runtime = runtimeResolver();
    runtimeExecutable = resolveExecutable(runtime?.command, { searchPath });
  } catch {
    return { ok: false, reason: "opencli_runtime_unresolvable" };
  }
  if (!runtimeExecutable) return { ok: false, reason: "opencli_runtime_unresolvable" };
  if (!sameExecutableIdentity(executable, runtimeExecutable)) {
    return { ok: false, reason: "opencli_runtime_realpath_mismatch" };
  }

  const home = readableDirectory(openCliHome);
  if (!home) return { ok: false, reason: "opencli_home_missing_or_unreadable" };

  const profile = resolveOpenCliProfileConfiguration({
    openCliConfigDir,
    openCliProfile,
    homeDirectory
  });
  if (!profile.ok) return profile;

  return {
    ok: true,
    executableRealPath: executable.realPath,
    home,
    profileContextId: profile.contextId
  };
}

export function resolveOpenCliProfileConfiguration({
  openCliConfigDir,
  openCliProfile,
  homeDirectory = os.homedir()
} = {}) {
  const profile = normalizeOpenCliProfile(openCliProfile);
  if (!profile) return { ok: false, reason: "opencli_profile_missing_or_invalid" };

  const configDirValue = String(openCliConfigDir ?? "").trim();
  const configDir = configDirValue || path.join(homeDirectory, ".opencli");
  let configDirStat;
  try {
    configDirStat = fs.statSync(configDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, contextId: profile, source: "context_id_no_config" };
    }
    return { ok: false, reason: "opencli_config_dir_missing_or_unreadable" };
  }
  if (!configDirStat.isDirectory()) {
    return { ok: false, reason: "opencli_config_dir_invalid" };
  }
  try {
    fs.accessSync(configDir, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "opencli_config_dir_missing_or_unreadable" };
  }
  const readableConfigDir = path.resolve(configDir);

  const configPath = path.join(readableConfigDir, "browser-profiles.json");
  let configStat;
  try {
    configStat = fs.statSync(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, contextId: profile, source: "context_id_no_config" };
    }
    return { ok: false, reason: "opencli_profile_config_missing_or_unreadable" };
  }
  if (!configStat.isFile() || configStat.size <= 0 || configStat.size > MAX_PROFILE_CONFIG_BYTES) {
    return { ok: false, reason: "opencli_profile_config_invalid" };
  }
  let parsed;
  try {
    fs.accessSync(configPath, fs.constants.R_OK);
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { ok: false, reason: "opencli_profile_config_missing_or_unreadable" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) {
    return { ok: false, reason: "opencli_profile_config_invalid" };
  }
  if (
    Object.hasOwn(parsed, "defaultContextId") &&
    (
      typeof parsed.defaultContextId !== "string" ||
      normalizeOpenCliProfile(parsed.defaultContextId) === null
    )
  ) {
    return { ok: false, reason: "opencli_profile_config_invalid" };
  }
  const aliases = normalizeOpenCliAliases(parsed.aliases);
  if (!aliases) return { ok: false, reason: "opencli_profile_config_invalid" };

  // OpenCLI 1.8.6 treats an explicit --profile/OPENCLI_PROFILE value as a
  // hard requirement and resolves it exactly as aliases[value] ?? value.
  const contextId = aliases[profile] ?? profile;
  if (!normalizeOpenCliProfile(contextId)) {
    return { ok: false, reason: "opencli_profile_context_invalid" };
  }
  return { ok: true, contextId, source: aliases[profile] ? "alias" : "context_id" };
}

export async function runAuthenticatedSocialRunnerPreflight({
  env = process.env,
  runCommand = runOpenCli,
  verifyBrowserService = verifyAuthBrowserLaunchAgent,
  runtimeResolver = resolveOpenCliRuntime,
  sleep = delay
} = {}) {
  const strictReplay = String(env.AUTHENTICATED_SOCIAL_REPLAY ?? "").toLowerCase() === "true";
  const configurationState = authenticatedRunnerConfigurationState(env);
  if (configurationState.absent && !strictReplay) {
    return authenticatedPreflightResult({
      skipped: true,
      configured: false,
      reason: "authenticated_social_not_configured"
    });
  }
  if (!configurationState.complete) {
    return authenticatedPreflightResult({
      configured: false,
      reason: "authenticated_social_configuration_incomplete"
    });
  }

  const configuration = readableRunnerConfiguration({
    openCliBin: env.OPENCLI_BIN,
    openCliHome: env.OPENCLI_HOME,
    openCliProfile: env.OPENCLI_PROFILE,
    openCliConfigDir: env.OPENCLI_CONFIG_DIR,
    homeDirectory: env.HOME || os.homedir(),
    runtimeResolver
  });
  if (!configuration.ok) {
    return authenticatedPreflightResult({ configured: false, reason: configuration.reason });
  }

  const instagramHandle = normalizeInstagramViewerHandle(env.RETURNER_INSTAGRAM_VIEWER_HANDLE);
  const linkedinSlug = normalizeLinkedInViewerSlug(env.RETURNER_LINKEDIN_VIEWER_PROFILE);
  if (!instagramHandle) {
    return authenticatedPreflightResult({
      configured: false,
      reason: "instagram_viewer_handle_missing_or_invalid"
    });
  }
  if (!linkedinSlug) {
    return authenticatedPreflightResult({
      configured: false,
      reason: "linkedin_viewer_profile_missing_or_invalid"
    });
  }

  const service = await retryAuthenticatedPreflight(
    async () => {
      try {
        const result = await verifyBrowserService({ userHome: env.HOME || os.homedir() });
        return {
          ...result,
          retryable: SERVICE_RETRYABLE_REASONS.has(result.reason)
        };
      } catch {
        return {
          ok: false,
          reason: "auth_browser_service_verification_failed",
          retryable: true
        };
      }
    },
    {
      attempts: SERVICE_PREFLIGHT_ATTEMPTS,
      retryDelaysMs: SERVICE_PREFLIGHT_RETRY_DELAYS_MS,
      sleep
    }
  );
  if (!service.ok) {
    return authenticatedPreflightResult({
      configured: true,
      reason: service.reason,
      service,
      instagram: unavailablePlatform(service.reason),
      linkedin: unavailablePlatform(service.reason)
    });
  }

  const profile = await retryAuthenticatedPreflight(
    () => verifyOpenCliBrowserProfileConnection(runCommand),
    {
      attempts: SERVICE_PREFLIGHT_ATTEMPTS,
      retryDelaysMs: SERVICE_PREFLIGHT_RETRY_DELAYS_MS,
      sleep
    }
  );
  if (!profile.ok) {
    const browserService = {
      ...profile,
      launchAgent: service
    };
    return authenticatedPreflightResult({
      configured: true,
      reason: profile.reason,
      service: browserService,
      instagram: unavailablePlatform(profile.reason),
      linkedin: unavailablePlatform(profile.reason)
    });
  }
  const readyService = { ...service, profile };

  const linkedin = await retryAuthenticatedPreflight(
    () => verifyLinkedInIdentity(linkedinSlug, runCommand),
    {
      attempts: PLATFORM_PREFLIGHT_ATTEMPTS,
      retryDelaysMs: PLATFORM_PREFLIGHT_RETRY_DELAYS_MS,
      sleep
    }
  );
  // Keep Instagram last: its exact adapter invocation and identity DOM proof
  // are the final preflight operations before the coordinator launches the
  // Instagram collector lane.
  const instagram = await retryAuthenticatedPreflight(
    () => verifyInstagramReadiness(instagramHandle, runCommand),
    {
      attempts: PLATFORM_PREFLIGHT_ATTEMPTS,
      retryDelaysMs: PLATFORM_PREFLIGHT_RETRY_DELAYS_MS,
      sleep
    }
  );
  return authenticatedPreflightResult({
    configured: true,
    reason: instagram.ok && linkedin.ok
      ? "authenticated_social_runner_verified"
      : "authenticated_social_platform_preflight_failed",
    service: readyService,
    instagram,
    linkedin
  });
}

export async function retryAuthenticatedPreflight(
  operation,
  {
    attempts = PLATFORM_PREFLIGHT_ATTEMPTS,
    retryDelaysMs = PLATFORM_PREFLIGHT_RETRY_DELAYS_MS,
    sleep = delay
  } = {}
) {
  let result = { ok: false, reason: "authenticated_preflight_not_attempted", retryable: false };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await operation();
    if (result.ok || result.retryable !== true || attempt === attempts) {
      return { ...result, attempts: attempt };
    }
    await sleep(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0);
  }
  return { ...result, attempts };
}

async function verifyInstagramReadiness(expectedHandle, runCommand) {
  const adapter = await verifyInstagramAdapter(expectedHandle, runCommand);
  if (!adapter.ok) return adapter;
  return verifyInstagramIdentity(expectedHandle, runCommand);
}

export async function verifyOpenCliBrowserProfileConnection(runCommand) {
  const session = `preflight-profile-${process.pid}-${Date.now()}`;
  try {
    await withOpenCliBrowserSession({
      session,
      runOpenCli: runCommand,
      operation: () => runCommand(
        ["browser", session, "open", "about:blank"],
        { timeoutMs: MAX_COMMAND_TIMEOUT_MS }
      )
    });
    return {
      ok: true,
      reason: "auth_browser_profile_connected",
      retryable: false
    };
  } catch (error) {
    const diagnostic = authenticatedBrowserDiagnostic(error);
    const disconnected = /\b(?:browser profile[^\r\n]{0,120}not connected|profile[_ -]?disconnected|extension (?:is )?(?:not connected|disconnected)|browser bridge[^\r\n]{0,80}not connected)\b/i.test(
      diagnostic
    );
    return {
      ok: false,
      reason: disconnected
        ? "auth_browser_profile_not_connected"
        : "auth_browser_profile_probe_failed",
      retryable: disconnected || authenticatedBrowserCommandRetryable(error)
    };
  }
}

async function verifyInstagramAdapter(expectedHandle, runCommand) {
  try {
    const raw = await runCommand([
      "instagram",
      "profile",
      expectedHandle,
      ...INSTAGRAM_ADAPTER_FORMAT_ARGS
    ], {
      timeoutMs: MAX_COMMAND_TIMEOUT_MS,
      maxBuffer: 128 * 1024
    });
    const profile = parseProbe(raw);
    const decision = instagramAdapterProfileIdentityDecision({
      requestedHandle: expectedHandle,
      profile,
      targetVerified: true
    });
    return decision.ok
      ? { ok: true, reason: "instagram_adapter_profile_verified", retryable: false }
      : {
          ok: false,
          reason: `instagram_adapter_${decision.reason}`,
          retryable: decision.reason === "profile_identity_missing"
        };
  } catch (error) {
    return {
      ok: false,
      reason: "instagram_adapter_preflight_command_failed",
      retryable: authenticatedBrowserCommandRetryable(error)
    };
  }
}

async function verifyInstagramIdentity(expectedHandle, runCommand) {
  const session = `preflight-ig-${process.pid}-${Date.now()}`;
  try {
    const signal = await withOpenCliBrowserSession({
      session,
      runOpenCli: runCommand,
      operation: async () => {
        await runCommand(["browser", session, "open", INSTAGRAM_SETTINGS_URL], { timeoutMs: MAX_COMMAND_TIMEOUT_MS });
        await runCommand(["browser", session, "wait", "time", "3"], { timeoutMs: MAX_WAIT_TIMEOUT_MS });
        const raw = await runCommand(["browser", session, "eval", instagramIdentityProbeJs()], {
          timeoutMs: MAX_COMMAND_TIMEOUT_MS,
          maxBuffer: 128 * 1024
        });
        return parseProbe(raw);
      }
    });
    const decision = instagramSelfIdentityDecision({ expectedHandle, ...signal });
    return {
      ...decision,
      retryable: [
        "instagram_account_settings_missing",
        "instagram_self_handle_missing",
        "instagram_safety_state_unknown"
      ].includes(decision.reason)
    };
  } catch (error) {
    return {
      ok: false,
      reason: "instagram_dom_preflight_command_failed",
      retryable: authenticatedBrowserCommandRetryable(error)
    };
  }
}

async function verifyLinkedInIdentity(expectedSlug, runCommand) {
  const session = `preflight-li-${process.pid}-${Date.now()}`;
  try {
    const signal = await withOpenCliBrowserSession({
      session,
      runOpenCli: runCommand,
      operation: async () => {
        await runCommand(["browser", session, "open", LINKEDIN_SELF_URL], { timeoutMs: MAX_COMMAND_TIMEOUT_MS });
        await runCommand(["browser", session, "wait", "time", "4"], { timeoutMs: MAX_WAIT_TIMEOUT_MS });
        const raw = await runCommand(["browser", session, "eval", linkedInIdentityProbeJs()], {
          timeoutMs: MAX_COMMAND_TIMEOUT_MS,
          maxBuffer: 128 * 1024
        });
        return parseProbe(raw);
      }
    });
    const decision = linkedinViewerIdentityDecision({ expectedSlug, ...signal });
    return {
      ...decision,
      retryable: [
        "linkedin_identity_url_missing",
        "linkedin_authenticated_navigation_missing",
        "linkedin_owner_control_missing",
        "linkedin_safety_state_unknown"
      ].includes(decision.reason)
    };
  } catch (error) {
    return {
      ok: false,
      reason: "linkedin_preflight_command_failed",
      retryable: authenticatedBrowserCommandRetryable(error)
    };
  }
}

function authenticatedBrowserCommandRetryable(error) {
  return instagramShouldRetryTransientBrowserFailure(
    authenticatedBrowserDiagnostic(error)
  );
}

function authenticatedBrowserDiagnostic(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .filter(Boolean)
    .join("\n");
}

function authenticatedRunnerConfigurationState(env) {
  const present = AUTHENTICATED_RUNNER_REQUIRED_ENV.filter((key) =>
    String(env[key] ?? "").trim()
  );
  return {
    absent: present.length === 0,
    complete: present.length === AUTHENTICATED_RUNNER_REQUIRED_ENV.length
  };
}

function authenticatedPreflightResult({
  configured = false,
  skipped = false,
  reason,
  service = null,
  instagram = unavailablePlatform(reason),
  linkedin = unavailablePlatform(reason)
}) {
  return {
    ok: instagram.ok === true && linkedin.ok === true,
    configured,
    skipped,
    reason,
    service,
    instagram,
    linkedin
  };
}

function unavailablePlatform(reason) {
  return { ok: false, reason, retryable: false, attempts: 0 };
}

function parseProbe(raw) {
  const value = String(raw ?? "").trim();
  const starts = [value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error("identity_probe_signal_missing");
  const parsed = JSON.parse(value.slice(start));
  const signal = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
    throw new Error("identity_probe_signal_missing");
  }
  return signal;
}

function isInstagramAccountSettingsUrl(value) {
  const url = exactHttpsUrl(value, new Set(["instagram.com", "www.instagram.com"]));
  return Boolean(url && /^\/accounts\/edit\/?$/i.test(url.pathname));
}

function parseLinkedInUrl(value) {
  const url = exactHttpsUrl(value, new Set(["linkedin.com", "www.linkedin.com"]));
  if (!url) return null;
  try {
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    if (parts.length === 2 && parts[0].toLowerCase() === "in") {
      if (parts[1].toLowerCase() === "me") return { kind: "me", slug: null };
      const slug = normalizeLinkedInViewerSlug(parts[1]);
      if (slug) return { kind: "profile", slug };
    }
    return null;
  } catch {
    return null;
  }
}

function exactHttpsUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !allowedHosts.has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function resolveExecutable(value, { searchPath = process.env.PATH } = {}) {
  const candidate = String(value ?? "").trim();
  if (!candidate || /[\0\r\n]/.test(candidate)) return null;
  if (!path.isAbsolute(candidate) && !candidate.includes(path.sep) && /\s/.test(candidate)) {
    return null;
  }
  const candidates = path.isAbsolute(candidate) || candidate.includes(path.sep)
    ? [candidate]
    : String(searchPath ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, candidate));
  for (const file of candidates) {
    try {
      const realPath = fs.realpathSync.native(file);
      const stat = fs.statSync(realPath);
      if (stat.isFile()) {
        fs.accessSync(realPath, fs.constants.R_OK | fs.constants.X_OK);
        return { realPath, device: stat.dev, inode: stat.ino };
      }
    } catch {
      // Continue through the bounded candidate list.
    }
  }
  return null;
}

function sameExecutableIdentity(left, right) {
  return left.realPath === right.realPath && left.device === right.device && left.inode === right.inode;
}

function readableDirectory(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate || /[\r\n]/.test(candidate)) return null;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) return null;
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.X_OK);
    return path.resolve(candidate);
  } catch {
    return null;
  }
}

function normalizeOpenCliProfile(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\0\r\n\u0001-\u001f\u007f]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeOpenCliAliases(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const aliases = Object.create(null);
  for (const [alias, contextId] of Object.entries(value)) {
    if (
      normalizeOpenCliProfile(alias) === null ||
      typeof contextId !== "string" ||
      normalizeOpenCliProfile(contextId) === null
    ) return null;
    // Keep exact stored spelling because OpenCLI 1.8.6 performs an exact
    // aliases[explicitProfile] lookup after trimming only the explicit value.
    aliases[alias] = contextId;
  }
  return aliases;
}

export function instagramIdentityProbeJs() {
  return `(() => {
  const text = String(document.body?.innerText ?? "").slice(0, 200000);
  const input = document.querySelector('input[name="username"], input[autocomplete="username"]');
  const pathname = location.pathname;
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href ?? "";
  const pageState = [location.href, canonicalUrl, document.title, pathname, text].join(" ");
  const loginDom = Boolean(document.querySelector('form[action*="login" i], input[type="password"], a[href*="/accounts/login" i]'));
  const challengeDom = Boolean(document.querySelector('input[name*="security" i], input[name*="code" i], form[action*="challenge" i]'));
  return [{
    currentUrl: location.href,
    settingsSurface: /^\\/accounts\\/edit\\/?$/i.test(pathname),
    selfHandle: input?.value ?? null,
    safetyStateKnown: true,
    loginWall: loginDom || /\\/(?:accounts\\/)?login\\b|authwall|log in|sign up|create an account/i.test(pageState),
    challenge: challengeDom || /challenge|checkpoint|confirm it'?s you|suspicious login|security code|verify your identity|captcha/i.test(pageState),
    rateLimited: /rate limit|too many requests|try again later|temporarily restricted|please wait a few minutes/i.test(pageState)
  }];
})()`;
}

export function linkedInIdentityProbeJs() {
  return `(() => {
  const text = String(document.body?.innerText ?? "").slice(0, 200000);
  const currentUrl = location.href;
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href ?? null;
  const pageState = [location.pathname, currentUrl, canonicalUrl, document.title, text].join(" ");
  const loginDom = Boolean(document.querySelector('form[action*="login" i], input[type="password"], a[href*="/login" i], a[href*="/authwall" i]'));
  const challengeDom = Boolean(document.querySelector('iframe[src*="captcha" i], form[action*="checkpoint" i], form[action*="challenge" i], input[name*="challenge" i]'));
  const authenticatedNavControl = Array.from(document.querySelectorAll('nav a, nav button, header a, header button')).some((node) => {
    const label = [node.getAttribute('aria-label'), node.textContent].filter(Boolean).join(' ').trim();
    const href = node instanceof HTMLAnchorElement ? node.href : '';
    return /(?:^|\\s)Me(?:\\s|$)/.test(label) || /\\/(?:mypreferences|settings)\\//i.test(href);
  });
  const ownerEditControl = Array.from(document.querySelectorAll('main a, main button')).some((node) => {
    const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent].filter(Boolean).join(' ').trim();
    const href = node instanceof HTMLAnchorElement ? node.href : '';
    return /^Edit (?:intro|profile|headline|about|experience|education|contact info)\\b/i.test(label) ||
      /^Add profile section$/i.test(label) ||
      /\\/in\\/[^/]+\\/edit(?:\\/|$)/i.test(href);
  });
  return [{
    currentUrl,
    canonicalUrl,
    safetyStateKnown: true,
    authenticatedNavControl,
    ownerEditControl,
    loginWall: loginDom || /\\/(?:login|authwall)\\b|sign in|join now/i.test(pageState),
    challenge: challengeDom || /challenge|security verification|verify your identity|captcha|suspicious activity|automated activity/i.test(pageState),
    checkpoint: /\\/checkpoint(?:\\/|\\b)|security checkpoint/i.test(pageState),
    rateLimited: /rate limit|too many requests|slow down|temporarily restricted|commercial use limit|weekly invitation limit/i.test(pageState)
  }];
})()`;
}

async function main() {
  const result = await runAuthenticatedSocialRunnerPreflight();
  writePreflightOutputs(result, process.env.GITHUB_OUTPUT);
  if (result.skipped) {
    process.stdout.write("Authenticated social runner preflight skipped.\n");
    return;
  }
  const strictReplay = String(process.env.AUTHENTICATED_SOCIAL_REPLAY ?? "").toLowerCase() === "true";
  if (!result.ok && strictReplay) {
    process.stderr.write(`::error title=Authenticated runner preflight failed::${result.reason}\n`);
    process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    for (const [platform, readiness] of [
      ["Instagram", result.instagram],
      ["LinkedIn", result.linkedin]
    ]) {
      if (readiness.ok) continue;
      process.stderr.write(
        `::warning title=${platform} authenticated lane deferred::${readiness.reason}\n`
      );
    }
    process.stdout.write("Authenticated social runner preflight recorded platform debt.\n");
    return;
  }
  process.stdout.write("Authenticated social runner preflight passed.\n");
}

function writePreflightOutputs(result, outputPath) {
  if (!outputPath) return;
  const lines = [
    `configured=${result.configured === true}`,
    `instagram_ready=${result.instagram?.ok === true}`,
    `instagram_reason=${safeOutputValue(result.instagram?.reason)}`,
    `instagram_attempts=${safeAttemptCount(result.instagram?.attempts)}`,
    `linkedin_ready=${result.linkedin?.ok === true}`,
    `linkedin_reason=${safeOutputValue(result.linkedin?.reason)}`,
    `linkedin_attempts=${safeAttemptCount(result.linkedin?.attempts)}`
  ];
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, { encoding: "utf8" });
}

function safeOutputValue(value) {
  const normalized = String(value ?? "unknown").trim();
  return /^[a-z0-9_]{1,120}$/.test(normalized) ? normalized : "unknown";
}

function safeAttemptCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
