import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autonomousCollectorRetryableFailures } from "../scripts/lib/autonomous-ingestion-plan.mjs";

const root = process.cwd();

function preloadSource(body) {
  return `
import dns from "node:dns";
dns.lookup = (_hostname, options, callback) => {
  if (typeof options === "function") callback = options;
  const address = { address: "93.184.216.34", family: 4 };
  if (options?.all) callback(null, [address]);
  else callback(null, address.address, address.family);
};
${body}
`;
}

async function runRssCollector(t, body) {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-official-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "preload.mjs");
  await Promise.all([
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, preloadSource(body))
  ]);
  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=rss",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    "--official-source-retry-base-ms=0",
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
  return JSON.parse(await readFile(output, "utf8"));
}

test("exhausted official RSS transport is terminal provider-blocked without claiming empty", async (t) => {
  const snapshot = await runRssCollector(t, `
globalThis.fetch = async () => {
  throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
};
`);
  const attempt = snapshot.attempts["rss:eden-robotics"];
  assert.equal(attempt.retryable, false);
  assert.equal(attempt.outcomeStatus, "blocked_or_empty");
  assert.equal(attempt.outcomeReason, "collector_provider_blocked");
  assert.equal(attempt.blocker.provider, "official_source_http");
  assert.equal(attempt.blocker.code, "official_source_transport_failure");
  assert.equal(attempt.blocker.httpStatus, null);
  assert.ok(Date.parse(attempt.blocker.retryAt) > Date.parse(attempt.checkedAt));
  assert.equal(attempt.verifiedEmpty, undefined);
  assert.equal(snapshot.evidence.filter((row) => row.platform === "rss").length, 0);
  assert.ok(snapshot.failures.some((row) => row.platform === "rss" && row.blocker));
  assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), []);
});

test("transient official RSS HTTP 503 exhausts three attempts into an HTTP blocker", async (t) => {
  const snapshot = await runRssCollector(t, `
const calls = new Map();
globalThis.fetch = async (input) => {
  const url = String(input);
  const attempt = (calls.get(url) ?? 0) + 1;
  calls.set(url, attempt);
  return new Response("temporarily unavailable", {
    status: 503,
    statusText: "attempt-" + attempt
  });
};
`);
  const attempt = snapshot.attempts["rss:eden-robotics"];
  assert.equal(attempt.retryable, false);
  assert.equal(attempt.outcomeStatus, "blocked_or_empty");
  assert.equal(attempt.outcomeReason, "collector_provider_blocked");
  assert.equal(attempt.blocker.provider, "official_source_http");
  assert.equal(attempt.blocker.code, "official_source_http_failure");
  assert.equal(attempt.blocker.httpStatus, 503);
  assert.match(attempt.blocker.message, /503 attempt-3/);
  assert.equal(attempt.verifiedEmpty, undefined);
  assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), []);
});

test("RSS evidence remains successful when another exact feed exhausts transport retries", async (t) => {
  const snapshot = await runRssCollector(t, `
let failedFeedCalls = 0;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === "https://www.edenrobotics.ai/") {
    return new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/primary.xml"></head><body>Eden Robotics</body></html>');
  }
  if (url === "https://www.edenrobotics.ai/primary.xml") {
    return new Response('<rss><channel><item><title>Launch</title><link>https://www.edenrobotics.ai/blog/launch</link><description>Eden launch</description><pubDate>Mon, 31 Aug 2026 12:00:00 GMT</pubDate></item></channel></rss>');
  }
  if (url === "https://www.edenrobotics.ai/feed") {
    failedFeedCalls += 1;
    throw Object.assign(new Error("read ECONNRESET call " + failedFeedCalls), { code: "ECONNRESET" });
  }
  throw new Error("Unexpected URL " + url);
};
`);
  const attempt = snapshot.attempts["rss:eden-robotics"];
  assert.equal(attempt.retryable, false);
  assert.equal(attempt.outcomeStatus, "completed");
  assert.equal(attempt.outcomeReason, "collector_evidence_collected");
  assert.equal(attempt.blocker, undefined);
  assert.equal(
    [...snapshot.evidence, ...snapshot.needsReview].filter((row) => row.platform === "rss").length,
    1
  );
  const failedFeed = snapshot.failures.find((row) => row.sourceUrl?.endsWith("/feed"));
  assert.equal(failedFeed.retryable, false);
  assert.equal(failedFeed.blocker, undefined);
  assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), []);
});
