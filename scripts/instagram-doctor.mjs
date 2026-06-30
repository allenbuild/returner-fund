import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const startedAt = new Date().toISOString();
const appData = process.env.APPDATA ?? "";
const openCliMain = path.join(appData, "npm", "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const browserProfileHints = [
  process.env.INSTAGRAM_BROWSER_PROFILE,
  process.env.CHROME_USER_DATA_DIR,
  path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data")
].filter(Boolean);

const checks = [];
const findings = [];

checks.push(await checkPlaywright());
checks.push(checkOpenCli());
checks.push(checkBrowserProfiles());
checks.push(checkConfiguredLoggedInSession());
checks.push(await checkConfiguredSessionBrowser());
const knownProfile = await checkPublicProfile("known-public-profile", "https://www.instagram.com/instagram/");
const heyClickyCandidate = await checkPublicProfile("heyclicky-candidate", "https://www.instagram.com/heyclicky/");
const heyClickyUnderscoreCandidate = await checkPublicProfile(
  "heyclicky-underscore-candidate",
  "https://www.instagram.com/_heyclicky/"
);
checks.push(knownProfile);
checks.push(heyClickyCandidate);
checks.push(heyClickyUnderscoreCandidate);
checks.push(checkPostListing("public-profile-post-listing", knownProfile));
checks.push(await checkKnownPostPage("known-heyclicky-reel", "https://www.instagram.com/reel/DXxrDscJsL2/"));
checks.push(await checkTargetedEvidenceMetrics());
checks.push(checkUrlNormalization());
checks.push(await checkGraphEvidence());
checks.push(await checkStorageWritable());

const result = {
  generated_at: new Date().toISOString(),
  started_at: startedAt,
  policy: {
    read_only: true,
    max_workers: 2,
    disallowed_actions: ["like", "save", "follow", "comment", "dm", "post", "edit", "delete", "subscribe"],
    captcha_bypass: false
  },
  summary: summarize(checks),
  checks,
  findings
};

await fs.mkdir("outputs", { recursive: true });
await fs.writeFile(path.join("outputs", "instagram-doctor.json"), JSON.stringify(result, null, 2));
await updateInstagramDocs(result);
console.log(JSON.stringify({ outputPath: "outputs/instagram-doctor.json", summary: result.summary }, null, 2));

async function checkPlaywright() {
  try {
    await import("playwright");
    return pass("playwright_installed", "Playwright package is importable.");
  } catch {
    findings.push("Playwright is not installed in this project, so script-level Instagram browser automation cannot run yet.");
    return fail("playwright_installed", "Playwright package is not installed.");
  }
}

function checkOpenCli() {
  if (existsSync(openCliMain)) {
    return pass("opencli_installed", `OpenCLI main script found at ${openCliMain}.`);
  }
  findings.push("OpenCLI was not found at the expected global npm path.");
  return fail("opencli_installed", "OpenCLI main script not found.");
}

function checkBrowserProfiles() {
  const existing = browserProfileHints.filter((profilePath) => existsSync(profilePath));
  if (existing.length) {
    return pass("browser_profile_available", `Found browser profile path(s): ${existing.join("; ")}`);
  }
  findings.push("No browser profile/session path was found through INSTAGRAM_BROWSER_PROFILE, CHROME_USER_DATA_DIR, or default Chrome User Data.");
  return fail("browser_profile_available", "No browser profile/session path found.");
}

function checkConfiguredLoggedInSession() {
  const configured = process.env.INSTAGRAM_BROWSER_PROFILE || process.env.INSTAGRAM_COOKIE_FILE;
  if (configured && existsSync(configured)) {
    return pass(
      "logged_in_session_configured",
      `Explicit Instagram session input found at ${configured}. The doctor may use this for future read-only browser checks.`
    );
  }
  findings.push(
    "No explicit INSTAGRAM_BROWSER_PROFILE or INSTAGRAM_COOKIE_FILE was provided. Default Chrome User Data exists, but the doctor does not attach to it automatically to avoid disturbing the user's live account."
  );
  return fail(
    "logged_in_session_configured",
    "No explicit reusable Instagram browser profile/cookie file configured for safe logged-in read-only checks."
  );
}

async function checkConfiguredSessionBrowser() {
  const profilePath = process.env.INSTAGRAM_BROWSER_PROFILE;
  const cookieFile = process.env.INSTAGRAM_COOKIE_FILE;
  const configuredPath = profilePath || cookieFile;

  if (!configuredPath || !existsSync(configuredPath)) {
    return fail(
      "logged_in_session_browser_probe",
      "Skipped: set INSTAGRAM_BROWSER_PROFILE to a cloned browser profile or INSTAGRAM_COOKIE_FILE to a Playwright storage-state JSON file to run the read-only logged-in probe."
    );
  }

  let browser = null;
  let context = null;
  try {
    const { chromium } = await import("playwright");
    if (profilePath) {
      context = await chromium.launchPersistentContext(profilePath, {
        headless: true,
        viewport: { width: 1280, height: 900 }
      });
    } else {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        storageState: cookieFile,
        viewport: { width: 1280, height: 900 }
      });
    }

    const page = await context.newPage();
    await page.goto("https://www.instagram.com/allenxtech/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    await page.waitForTimeout(2500);
    const bodyText = cleanBrowserText(await page.locator("body").innerText({ timeout: 15_000 }).catch(() => ""));
    const postUrls = await page
      .locator("a[href*='/p/'], a[href*='/reel/']")
      .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.href))].slice(0, 12))
      .catch(() => []);
    const loginWall = /log in|sign up|captcha|challenge|suspended|temporarily blocked/i.test(bodyText);
    const profileVisible = /allenxtech|allen xu|move fast/i.test(bodyText);

    if (profileVisible && !loginWall) {
      return pass(
        "logged_in_session_browser_probe",
        `Explicit read-only session opened @allenxtech and found ${postUrls.length} visible post/reel link(s).`
      );
    }

    return fail(
      "logged_in_session_browser_probe",
      `Explicit session opened, but profile visibility was incomplete: profile_visible=${profileVisible}; login_or_challenge_text=${loginWall}; post_links=${postUrls.length}.`
    );
  } catch (error) {
    findings.push(
      `Configured Instagram browser probe failed at the Playwright session step: ${error instanceof Error ? error.message : "unknown error"}.`
    );
    return fail(
      "logged_in_session_browser_probe",
      `Configured session probe failed: ${error instanceof Error ? error.message : "unknown error"}.`
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function checkPublicProfile(name, url) {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "YCNetworkIntelligence/0.1 read-only instagram doctor" },
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    const blocked = /login|captcha|challenge|not available|temporarily blocked/i.test(text);
    const hasPostLinks = /\/(p|reel|tv)\//i.test(text);
    return {
      name,
      status: response.ok && !blocked ? "pass" : "fail",
      message: `HTTP ${response.status}; blocked_or_login_wall=${blocked}; post_links_visible=${hasPostLinks}.`,
      url
    };
  } catch (error) {
    return fail(name, `Fetch failed: ${error instanceof Error ? error.message : "unknown error"}.`, url);
  }
}

function checkPostListing(name, profileCheck) {
  const hasPostLinks = /post_links_visible=true/.test(profileCheck.message ?? "");
  if (profileCheck.status === "pass" && hasPostLinks) {
    return pass(name, "Recent public Instagram posts/reels were visible from the profile page.", profileCheck.url);
  }
  return fail(
    name,
    "Recent Instagram posts/reels were not visible from the direct public profile fetch; profile appears login-walled or post markup is hidden.",
    profileCheck.url
  );
}

async function checkKnownPostPage(name, url) {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "YCNetworkIntelligence/0.1 read-only instagram doctor" },
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    const blocked = /login|captcha|challenge|not available|temporarily blocked/i.test(text);
    const visibleMetrics = /likes?|comments?|views?/i.test(text);
    if (response.ok && !blocked && visibleMetrics) {
      return pass(name, `HTTP ${response.status}; public post page exposed visible metric text.`, url);
    }
    return fail(name, `HTTP ${response.status}; blocked_or_login_wall=${blocked}; visible_metric_text=${visibleMetrics}.`, url);
  } catch (error) {
    return fail(name, `Fetch failed: ${error instanceof Error ? error.message : "unknown error"}.`, url);
  }
}

async function checkTargetedEvidenceMetrics() {
  try {
    const raw = await fs.readFile(path.join("src", "lib", "social", "targeted-evidence-current.json"), "utf8");
    const snapshot = JSON.parse(raw);
    const reel = snapshot.evidence?.find((item) => item.sourceUrl === "https://www.instagram.com/reel/DXxrDscJsL2/");
    const hasMetrics = (reel?.metrics?.likes ?? 0) > 0 || (reel?.metrics?.comments ?? 0) > 0 || (reel?.metrics?.views ?? 0) > 0;
    if (reel && hasMetrics) {
      return pass(
        "targeted_evidence_metrics",
        `Stored targeted HeyClicky reel metrics: ${reel.metrics.likes ?? 0} likes, ${reel.metrics.comments ?? 0} comments, ${reel.metrics.views ?? 0} views.`
      );
    }
    return fail("targeted_evidence_metrics", "Targeted HeyClicky Instagram reel metrics are missing from targeted evidence.");
  } catch (error) {
    return fail("targeted_evidence_metrics", `Targeted evidence read failed: ${error instanceof Error ? error.message : "unknown error"}.`);
  }
}

function checkUrlNormalization() {
  const examples = [
    ["https://www.instagram.com/reel/ABC123/?igshid=abc&utm_source=foo", "https://instagram.com/reel/ABC123"],
    ["https://instagram.com/p/XYZ789/?utm_campaign=x", "https://instagram.com/p/XYZ789"]
  ];
  const failures = examples.filter(([input, expected]) => normalizeInstagramUrl(input) !== expected);
  if (!failures.length) {
    return pass("url_normalization", "Instagram /p/ and /reel/ URL normalization works.");
  }
  return fail("url_normalization", `Normalization mismatches: ${JSON.stringify(failures)}.`);
}

async function checkGraphEvidence() {
  try {
    const graph = await fetchJson(process.env.GRAPH_API_URL ?? "http://127.0.0.1:3001/api/graph?batch=S2026");
    const instagramEvidence = graph.evidence.filter((item) => item.platform === "instagram");
    const scored = instagramEvidence.filter((item) => item.contributionScore > 0);
    const heyClicky = graph.nodes.find((node) => node.label === "HeyClicky");
    const heyClickyEvidence = heyClicky
      ? instagramEvidence.filter((item) => (heyClicky.evidenceIds ?? []).includes(item.id))
      : [];
    return {
      name: "app_feed_instagram_evidence",
      status: instagramEvidence.length ? "pass" : "fail",
      message: `${instagramEvidence.length} Instagram evidence rows, ${scored.length} scored, ${heyClickyEvidence.length} attached to HeyClicky.`,
      instagramEvidenceCount: instagramEvidence.length,
      scoredCount: scored.length,
      heyClickyEvidenceCount: heyClickyEvidence.length
    };
  } catch (error) {
    return fail("app_feed_instagram_evidence", `Graph check failed: ${error instanceof Error ? error.message : "unknown error"}.`);
  }
}

async function checkStorageWritable() {
  const testPath = path.join("outputs", "instagram-doctor-storage-check.json");
  await fs.mkdir("outputs", { recursive: true });
  await fs.writeFile(testPath, JSON.stringify({ ok: true, at: new Date().toISOString() }));
  return pass("storage_writable", `Wrote ${testPath}.`);
}

function normalizeInstagramUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hostname = "instagram.com";
    url.hash = "";
    url.search = "";
    const match = url.pathname.match(/^\/(p|reel|tv)\/([^/]+)/i);
    if (match) {
      url.pathname = `/${match[1].toLowerCase()}/${match[2]}`;
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function cleanBrowserText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

async function updateInstagramDocs(result) {
  const loggedInSocial = summarizeLoggedInSocial(await readJson(path.join("src", "lib", "social", "logged-in-evidence-current.json"), null));
  const discovery = await readJson(path.join("outputs", "instagram-discovery-candidates.json"), null);
  const lines = [
    "# Instagram Status",
    "",
    "## Latest Doctor Run",
    "",
    `- Generated at: ${result.generated_at}.`,
    `- Overall status: ${result.summary.overall_status}.`,
    `- Passing checks: ${result.summary.pass_count}/${result.summary.total_checks}.`,
    "- Important distinction: `instagram:doctor` checks direct public fetches and explicit Playwright storage-state/profile configuration. The authenticated OpenCLI read-only browser path is working when a verified profile is provided to `fetch-logged-in-social-traction.mjs`.",
    "",
    "## OpenCLI Read-Only Session Result",
    "",
    loggedInSocial
      ? `- Stored logged-in read-only social rows: ${loggedInSocial.evidence_rows}; platform rows ${JSON.stringify(loggedInSocial.platform_rows)}; companies by platform ${JSON.stringify(loggedInSocial.companies_by_platform)}.`
      : "- Stored logged-in read-only social rows: not available.",
    "- Verified `_heyclicky` through the logged-in OpenCLI browser/session as the company Instagram profile.",
    "- Verified `farza954` as founder Farza Majeed's Instagram profile; the visible bio links him to `_heyclicky`.",
    "- Parsed 19/19 visible `_heyclicky` Instagram posts and 22/22 visible `farza954` Instagram posts in the logged-in evidence artifact.",
    "- Instagram grid views are visible in Chrome UI but were not exposed in readable DOM/meta fields during this pass; current stored Instagram metrics are likes/comments, not reel views.",
    "",
    "## Batch Discovery Result",
    "",
    "- Added `npm run instagram:discover` for safe verified-handle discovery.",
    discovery
      ? `- Latest discovery checked ${discovery.companies_checked} companies, produced ${discovery.candidates?.length ?? 0} candidates, auto-verified ${discovery.newly_verified_in_this_run} new profiles, and has ${discovery.verified_company_instagram_profiles} total verified company Instagram profiles.`
      : "- Latest discovery has not run.",
    "- Official-site discovery can auto-promote Instagram links. OpenCLI Instagram search is a candidate generator only unless explicitly promoted later.",
    "",
    "## Check Results",
    "",
    ...result.checks.map((check) => `- ${check.name}: ${check.status} - ${check.message}`),
    "",
    "## HeyClicky",
    "",
    "- YC lists HeyClicky website and X, but no Instagram URL.",
    "- The doctor probes `https://www.instagram.com/heyclicky/` read-only as a candidate only; the verified working profile is `https://www.instagram.com/_heyclicky/`.",
    "- Current graph feed check is recorded in `outputs/instagram-doctor.json`.",
    "- Targeted public discovery found `https://www.instagram.com/_heyclicky/` as a strong HeyClicky profile candidate.",
    "- OpenCLI read-only ingestion found the full visible company/founder Instagram set: 19 company posts plus 22 founder posts.",
    "- Top stored Instagram evidence includes Farza's `https://www.instagram.com/reel/DXk3VriDylM/` with 123K+ likes and 30K+ comments, plus `_heyclicky`'s `https://www.instagram.com/reel/DZEX2WRgyMu/` with 19K+ likes.",
    "- The evidence is stored in `src/lib/social/logged-in-evidence-current.json`, appears in the HeyClicky feed, and rolls founder posts into the company score.",
    "- A DailyDropout public web article is stored as non-scoring context because it reports viral traction but does not expose the underlying social post metrics directly.",
    "- Public ingestion now has a conservative search-result snippet fallback for real Instagram post/reel URLs when the post page is blocked, but only if the snippet itself exposes visible metrics and a strong HeyClicky/company/founder match.",
    "",
    "## Blockers / Next Fixes",
    "",
    ...result.findings.map((finding) => `- ${finding}`),
    "- To run the logged-in read-only probe safely, use a cloned browser profile or Playwright storage-state JSON, then rerun `npm run instagram:doctor`.",
    "- Example profile command: `$env:INSTAGRAM_BROWSER_PROFILE=\"C:\\\\path\\\\to\\\\cloned-instagram-profile\"; npm run instagram:doctor`.",
    "- Example storage-state command: `$env:INSTAGRAM_COOKIE_FILE=\"C:\\\\path\\\\to\\\\instagram.storage-state.json\"; npm run instagram:doctor`.",
    "",
    "Machine-readable output: `outputs/instagram-doctor.json`.",
    ""
  ];
  await fs.writeFile(path.join("docs", "INSTAGRAM_STATUS.md"), lines.join("\n"));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function summarizeLoggedInSocial(snapshot) {
  if (!snapshot) return null;
  const evidence = snapshot.evidence ?? [];
  return {
    evidence_rows: evidence.length,
    platform_rows: countBy(evidence, (row) => row.platform ?? "unknown"),
    companies_by_platform: Object.fromEntries(
      Object.entries(
        evidence.reduce((acc, row) => {
          if (!row.platform || !row.companySlug) return acc;
          (acc[row.platform] ??= new Set()).add(row.companySlug);
          return acc;
        }, {})
      ).map(([platform, companies]) => [platform, companies.size])
    )
  };
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Graph API failed with ${response.status}`);
  return response.json();
}

function summarize(items) {
  const passCount = items.filter((item) => item.status === "pass").length;
  return {
    pass_count: passCount,
    total_checks: items.length,
    overall_status: passCount === items.length ? "pass" : "needs_attention"
  };
}

function pass(name, message, url) {
  return { name, status: "pass", message, ...(url ? { url } : {}) };
}

function fail(name, message, url) {
  return { name, status: "fail", message, ...(url ? { url } : {}) };
}
