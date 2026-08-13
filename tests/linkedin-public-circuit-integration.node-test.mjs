import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("mapped LinkedIn outages use four bounded probes and persist exact retryable blockers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-linkedin-public-circuit-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const fetchLog = join(directory, "fetch-log.json");
  const preload = join(directory, "mock-fetch.mjs");

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
import { writeFileSync } from "node:fs";
const urls = [];
process.on("exit", () => writeFileSync(process.env.LINKEDIN_PUBLIC_FETCH_LOG_PATH, JSON.stringify(urls)));
globalThis.fetch = async (input) => {
  const value = String(input);
  urls.push(value);
  throw new Error("mock anonymous LinkedIn provider offline");
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
      X_BEARER_TOKEN: "",
      LINKEDIN_PUBLIC_FETCH_LOG_PATH: fetchLog,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const [storedCheckpoint, storedDiscoveryAttempts, fetchedUrls] = await Promise.all([
    readFile(checkpoint, "utf8").then(JSON.parse),
    readFile(discoveryAttempts, "utf8").then(JSON.parse),
    readFile(fetchLog, "utf8").then(JSON.parse)
  ]);
  const mappedAttempts = Object.values(storedCheckpoint.attempts).filter((attempt) =>
    attempt.platform === "linkedin" && attempt.accountUrl
  );
  const mappedFailures = storedCheckpoint.failures.filter((failure) =>
    failure.platform === "linkedin" &&
    failure.accountUrl &&
    failure.blocker?.provider === "jina_linkedin_reader"
  );
  const mappedAttemptIdentities = new Set(mappedAttempts.map((attempt) =>
    `${attempt.entityId}\u0000${attempt.accountUrl}`
  ));
  const mappedReceipts = storedDiscoveryAttempts.filter((attempt) =>
    attempt.platform === "linkedin" &&
    attempt.source === "yc_profile_social_links" &&
    attempt.blocker?.provider === "jina_linkedin_reader" &&
    mappedAttemptIdentities.has(`${attempt.entityId}\u0000${attempt.selected_url}`)
  );
  const directCalls = fetchedUrls.filter((url) => new URL(url).hostname.endsWith("linkedin.com"));
  const readerCalls = fetchedUrls.filter((url) => new URL(url).hostname === "r.jina.ai");

  assert.ok(mappedAttempts.length > 1, "fixture must exercise multiple mapped LinkedIn owners");
  assert.equal(directCalls.length, 2, "native HTML must stop after its two adaptive probes");
  assert.equal(readerCalls.length, 2, "Jina must stop after its two adaptive probes");
  assert.equal(fetchedUrls.length, 4, "open circuits must reject the tail without network calls");
  assert.equal(mappedFailures.length, mappedAttempts.length);
  assert.equal(mappedReceipts.length, mappedAttempts.length);

  const failureByAttempt = new Map(mappedFailures.map((failure) => [failure.attemptKey, failure]));
  const receiptByAttempt = new Map(mappedReceipts.map((receipt) => [
    mappedAttempts.find((attempt) =>
      attempt.entityId === receipt.entityId && attempt.accountUrl === receipt.selected_url
    )?.attemptKey,
    receipt
  ]));
  for (const attempt of mappedAttempts) {
    const failure = failureByAttempt.get(attempt.attemptKey);
    assert.ok(failure, `missing blocker failure for ${attempt.attemptKey}`);
    assert.deepEqual(failure.blocker, attempt.blocker);
    assert.equal(attempt.blocker.provider, "jina_linkedin_reader");
    assert.match(attempt.blocker.code, /^linkedin_public_(?:transport_failure|circuit_open)$/);
    assert.equal(attempt.blocker.httpStatus, null);
    assert.equal(attempt.outcomeStatus, "blocked_or_empty");
    assert.doesNotMatch(JSON.stringify([attempt, failure]), /verified_no_account/i);
    if (attempt.blocker.retryAt) {
      assert.equal(attempt.retryable, false, "cooldown receipts are terminal until retryAt");
      assert.equal(new Date(attempt.blocker.retryAt).toISOString(), attempt.blocker.retryAt);
    } else {
      assert.equal(attempt.retryable, true, "the first degraded probe remains immediately retryable");
    }
    const receipt = receiptByAttempt.get(attempt.attemptKey);
    assert.ok(receipt, `missing discovery receipt for ${attempt.attemptKey}`);
    assert.deepEqual(receipt.blocker, attempt.blocker);
  }
});
