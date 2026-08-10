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
  if (url.hostname.endsWith("linkedin.com")) {
    return new Response("<html><body>Forbidden</body></html>", { status: 403 });
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
  const profileBlockers = storedCheckpoint.failures.filter((failure) =>
    failure.platform === "linkedin" &&
    failure.blocker?.provider === "linkedin_public_html" &&
    /LinkedIn public profile verification was blocked:/.test(failure.message)
  );
  const blockerAttemptKeys = new Set(searchBlockers.map((failure) => failure.attemptKey));
  const profileBlockerAttemptKeys = new Set(profileBlockers.map((failure) => failure.attemptKey));
  const profileRequests = fetchedUrls.filter((value) => {
    const url = new URL(value);
    return url.hostname.endsWith("linkedin.com") &&
      (url.pathname.startsWith("/company/") || url.pathname.startsWith("/in/"));
  });

  assert.equal(mappedAttempts.length, 5, "fixture must exercise one company and four founder profiles");
  assert.equal(
    profileRequests.length,
    1,
    "the first HTTP 403 must open the serial LinkedIn circuit without re-fetching that profile"
  );
  assert.equal(new Set(profileRequests).size, 1);
  assert.equal(
    fetchedUrls.filter((url) => url.startsWith("https://duckduckgo.com/html/")).length,
    2,
    "mapped fallbacks must share the same bounded search circuit"
  );
  assert.equal(profileBlockers.length, 5, "every mapped profile needs a structured direct blocker receipt");
  assert.equal(searchBlockers.length, 5, "every mapped profile needs search-fallback evidence");
  assert.ok(mappedAttempts.every((attempt) =>
    profileBlockerAttemptKeys.has(attempt.attemptKey) && blockerAttemptKeys.has(attempt.attemptKey)
  ));
});

test("DuckDuckGo redirects use a pinned manual dispatcher and reject private next hops", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-search-redirect-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const auditPath = join(directory, "search-transport-audit.json");
  const preload = join(directory, "mock-fetch.mjs");

  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
import { writeFileSync } from "node:fs";
const calls = [];
process.on("exit", () => writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify(calls)));
globalThis.fetch = async (input, options = {}) => {
  const value = String(input);
  calls.push({
    url: value,
    redirect: options.redirect ?? null,
    pinnedDispatcher: Boolean(options.dispatcher)
  });
  if (value === "https://www.edenrobotics.ai/") {
    return new Response("<html><body>Eden Robotics</body></html>");
  }
  if (value.startsWith("https://duckduckgo.com/html/")) {
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/latest/meta-data" }
    });
  }
  throw new Error("private redirect target was fetched: " + value);
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=news_web",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const [snapshot, calls] = await Promise.all([
    readFile(output, "utf8").then(JSON.parse),
    readFile(auditPath, "utf8").then(JSON.parse)
  ]);
  const searchCalls = calls.filter((call) => call.url.startsWith("https://duckduckgo.com/html/"));
  assert.equal(searchCalls.length, 1);
  assert.deepEqual(searchCalls[0], {
    url: searchCalls[0].url,
    redirect: "manual",
    pinnedDispatcher: true
  });
  assert.ok(calls.every((call) => !call.url.startsWith("http://127.0.0.1/")));
  assert.ok(snapshot.failures.some((failure) =>
    failure.platform === "web" && /non-public address 127\.0\.0\.1/.test(failure.message)
  ));
});

test("DuckDuckGo raw transport rejects oversized encoded gzip before decoded expansion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-search-encoded-limit-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const auditPath = join(directory, "raw-search-audit.json");
  const preload = join(directory, "mock-raw-request.mjs");

  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
const calls = [];
const decoded = randomBytes(2 * 1024 * 1024 + 1);
const encoded = gzipSync(decoded);
if (encoded.length <= 2 * 1024 * 1024 || decoded.length >= 4 * 1024 * 1024) {
  throw new Error("invalid independent encoded-limit fixture");
}
process.on("exit", () => writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify(calls)));
globalThis.__RETURNER_PUBLIC_RAW_REQUEST__ = async (input, options = {}) => {
  const value = String(input);
  calls.push({
    url: value,
    maxRedirections: options.maxRedirections ?? null,
    pinnedDispatcher: Boolean(options.dispatcher),
    encodedBytes: encoded.length,
    decodedBytes: decoded.length
  });
  if (value === "https://www.edenrobotics.ai/") {
    return {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: Readable.from([Buffer.from("<html><body>Eden Robotics</body></html>")])
    };
  }
  if (value.startsWith("https://duckduckgo.com/html/")) {
    return {
      statusCode: 200,
      headers: {
        "content-type": "text/html",
        "content-encoding": "gzip"
      },
      body: Readable.from([encoded])
    };
  }
  throw new Error("unexpected raw request: " + value);
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=news_web",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
    stdio: "pipe"
  });

  const [snapshot, calls] = await Promise.all([
    readFile(output, "utf8").then(JSON.parse),
    readFile(auditPath, "utf8").then(JSON.parse)
  ]);
  const searchCalls = calls.filter((call) => call.url.startsWith("https://duckduckgo.com/html/"));
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].maxRedirections, 0);
  assert.equal(searchCalls[0].pinnedDispatcher, true);
  assert.ok(searchCalls[0].encodedBytes > 2 * 1024 * 1024);
  assert.ok(searchCalls[0].decodedBytes < 4 * 1024 * 1024);
  assert.ok(snapshot.failures.some((failure) =>
    failure.platform === "web" &&
      /2097152-byte encoded body limit/.test(failure.message) &&
      !/decoded body limit/.test(failure.message)
  ));
});
