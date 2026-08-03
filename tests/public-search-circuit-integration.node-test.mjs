import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("missing-account discovery records a terminal provider blocker without repeating network timeouts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-search-circuit-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const fetchCountPath = join(directory, "fetch-count.txt");
  const preload = join(directory, "mock-fetch.mjs");

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
import { writeFileSync } from "node:fs";
const urls = [];
process.on("exit", () => writeFileSync(process.env.PUBLIC_SEARCH_FETCH_COUNT_PATH, JSON.stringify(urls)));
globalThis.fetch = async (input) => {
  urls.push(String(input));
  throw new Error("mock provider offline");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=tash",
    "--platforms=instagram",
    "--social=all",
    "--workers=8",
    "--instagram-workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      EXA_API_KEY: "",
      PUBLIC_SEARCH_FETCH_COUNT_PATH: fetchCountPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const [storedCheckpoint, storedAttempts, fetchedUrls] = await Promise.all([
    readFile(checkpoint, "utf8").then(JSON.parse),
    readFile(discoveryAttempts, "utf8").then(JSON.parse),
    readFile(fetchCountPath, "utf8").then(JSON.parse)
  ]);
  const instagramAttempts = Object.values(storedCheckpoint.attempts)
    .filter((attempt) => attempt.platform === "instagram" && attempt.accountUrl == null);
  const missingDiscoveryReceipts = storedAttempts.filter((attempt) =>
    attempt.platform === "instagram" &&
    attempt.company_slug === "tash" &&
    attempt.entityType === "founder" &&
    attempt.source === "public_search_missing_social"
  );

  assert.ok(instagramAttempts.length > 1, "fixture must exercise more than one missing owner");
  assert.equal(
    fetchedUrls.filter((url) => url.startsWith("https://duckduckgo.com/html/")).length,
    2,
    "only the two circuit probes may reach the public-search provider"
  );
  assert.ok(instagramAttempts.every((attempt) => attempt.status === "done"));
  assert.ok(instagramAttempts.every((attempt) => attempt.retryable === false));
  assert.ok(instagramAttempts.every((attempt) =>
    attempt.blocker?.provider === "duckduckgo_html" &&
    attempt.blocker?.retryAt &&
    /DuckDuckGo public search/.test(attempt.error)
  ));
  assert.equal(missingDiscoveryReceipts.length, instagramAttempts.length);
  assert.ok(missingDiscoveryReceipts.every((attempt) =>
    attempt.status === "failed" &&
    /public discovery was blocked: DuckDuckGo public search .*circuit (?:is )?open/.test(attempt.failure_reason)
  ));
});

test("mapped LinkedIn fallbacks retain the exact public-search blocker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-search-fallback-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const fetchCountPath = join(directory, "fetch-count.txt");
  const preload = join(directory, "mock-fetch.mjs");

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
import { writeFileSync } from "node:fs";
const urls = [];
process.on("exit", () => writeFileSync(process.env.PUBLIC_SEARCH_FETCH_COUNT_PATH, JSON.stringify(urls)));
globalThis.fetch = async (input) => {
  const value = String(input);
  urls.push(value);
  const url = new URL(value);
  if (url.hostname === "duckduckgo.com") throw new Error("mock provider offline");
  if (url.hostname === "r.jina.ai") return new Response("Forbidden", { status: 200 });
  if (url.hostname.endsWith("linkedin.com")) {
    if (url.pathname.startsWith("/company/")) {
      return new Response("<html><body>LinkedIn profile unavailable</body></html>", { status: 200 });
    }
    return new Response(
      '<html><head><link rel="canonical" href="' + value + '">' +
        '<meta property="og:title" content="Exact mapped LinkedIn profile">' +
        '<meta property="og:description" content="Public profile with no posts">' +
        '</head></html>',
      { status: 200 }
    );
  }
  throw new Error("unexpected mock URL: " + value);
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=6thsense",
    "--platforms=linkedin",
    "--social=all",
    "--workers=8",
    "--linkedin-workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      EXA_API_KEY: "",
      PUBLIC_SEARCH_FETCH_COUNT_PATH: fetchCountPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const [storedCheckpoint, fetchedUrls] = await Promise.all([
    readFile(checkpoint, "utf8").then(JSON.parse),
    readFile(fetchCountPath, "utf8").then(JSON.parse)
  ]);
  const mappedAttempts = Object.values(storedCheckpoint.attempts).filter((attempt) =>
    attempt.platform === "linkedin" && attempt.accountUrl
  );
  const searchBlockers = storedCheckpoint.failures.filter((failure) =>
    failure.platform === "linkedin" &&
    failure.blocker?.provider === "duckduckgo_html" &&
    /Public post discovery was blocked: DuckDuckGo public search/.test(failure.message)
  );
  const blockedProfiles = storedCheckpoint.failures.filter((failure) =>
    failure.platform === "linkedin" && failure.message === "Public page blocked or login-walled."
  );
  const blockerAttemptKeys = new Set(searchBlockers.map((failure) => failure.attemptKey));

  assert.ok(mappedAttempts.length > 1, "fixture must exercise company and founder profiles");
  assert.equal(
    fetchedUrls.filter((url) => url.startsWith("https://duckduckgo.com/html/")).length,
    2,
    "mapped fallbacks must share the same bounded search circuit"
  );
  assert.equal(searchBlockers.length, mappedAttempts.length);
  assert.ok(mappedAttempts.every((attempt) => blockerAttemptKeys.has(attempt.attemptKey)));
  assert.equal(blockedProfiles.length, 1, "the company fixture must exercise the blocked-profile branch");
  assert.ok(
    searchBlockers.some((failure) => failure.attemptKey === blockedProfiles[0].attemptKey),
    "the blocked-profile branch must retain both its profile failure and its search blocker"
  );
});
