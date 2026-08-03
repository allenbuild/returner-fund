import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PUBLIC_EVIDENCE_ATTRIBUTION_VERSION } from "../scripts/lib/public-evidence-attribution.mjs";

const root = resolve(import.meta.dirname, "..");
const EMPTY_OUTPUT = Object.freeze({
  source: {},
  attempts: {},
  evidence: [],
  needsReview: [],
  failures: [],
  discoveryAttempts: [],
  sourceDiscoveryPaths: []
});
const EMPTY_CHECKPOINT = Object.freeze({
  attempts: {},
  evidence: [],
  needsReview: [],
  failures: [],
  discoveryAttempts: [],
  sourceDiscoveryPaths: []
});

async function createFixture({
  fetchState = "",
  fetchImplementation,
  outputPayload = EMPTY_OUTPUT,
  checkpointPayload = EMPTY_CHECKPOINT
}) {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-search-outage-integrity-"));
  const fixture = {
    directory,
    output: join(directory, "public-evidence.json"),
    checkpoint: join(directory, "checkpoint.json"),
    discoveryAttempts: join(directory, "discovery-attempts.json"),
    sourceDiscoveryPaths: join(directory, "source-discovery-paths.json"),
    fetchLog: join(directory, "fetch-log.json"),
    preload: join(directory, "mock-fetch.mjs")
  };

  await Promise.all([
    writeFile(fixture.output, `${JSON.stringify(outputPayload, null, 2)}\n`),
    writeFile(fixture.checkpoint, `${JSON.stringify(checkpointPayload, null, 2)}\n`),
    writeFile(fixture.discoveryAttempts, "[]\n"),
    writeFile(fixture.sourceDiscoveryPaths, "[]\n"),
    writeFile(fixture.preload, `
import { writeFileSync } from "node:fs";

const NativeURL = globalThis.URL;
const fetchUrls = [];
const publicSearchAdmissions = [];
globalThis.URL = class InstrumentedURL extends NativeURL {
  constructor(input, base) {
    super(input, base);
    if (String(input).toLowerCase().startsWith("https://duckduckgo.com/html/")) {
      publicSearchAdmissions.push(String(input));
    }
  }
};
${fetchState}
process.on("exit", () => {
  writeFileSync(
    process.env.PUBLIC_SEARCH_FETCH_LOG_PATH,
    JSON.stringify({ fetchUrls, publicSearchAdmissions })
  );
});
globalThis.fetch = async (input) => {
  const value = String(input);
  fetchUrls.push(value);
  ${fetchImplementation}
};
`)
  ]);

  return fixture;
}

function runCollector(fixture, {
  company = "6thsense",
  platform = "instagram",
  social = "company",
  force = true,
  workers = 1,
  laneWorkers = 1
} = {}) {
  const laneWorkerFlag = platform === "linkedin"
    ? `--linkedin-workers=${laneWorkers}`
    : platform === "instagram"
      ? `--instagram-workers=${laneWorkers}`
      : `--${platform}-workers=${laneWorkers}`;
  const args = [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    `--company=${company}`,
    `--platforms=${platform}`,
    `--social=${social}`,
    `--workers=${workers}`,
    laneWorkerFlag,
    "--delay-ms=0",
    "--fresh-for-hours=12",
    ...(force ? ["--force"] : []),
    `--output=${fixture.output}`,
    `--checkpoint=${fixture.checkpoint}`,
    `--discovery-attempts=${fixture.discoveryAttempts}`,
    `--source-discovery-paths=${fixture.sourceDiscoveryPaths}`
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      EXA_API_KEY: "",
      X_BEARER_TOKEN: "",
      PUBLIC_SEARCH_FETCH_LOG_PATH: fixture.fetchLog,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fixture.preload}`]
        .filter(Boolean)
        .join(" ")
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000
  });

  assert.equal(
    result.status,
    0,
    `collector subprocess failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

async function readFixture(fixture) {
  const [output, checkpoint, discoveryAttempts, fetchLog] = await Promise.all([
    readFile(fixture.output, "utf8").then(JSON.parse),
    readFile(fixture.checkpoint, "utf8").then(JSON.parse),
    readFile(fixture.discoveryAttempts, "utf8").then(JSON.parse),
    readFile(fixture.fetchLog, "utf8").then(JSON.parse)
  ]);
  return { output, checkpoint, discoveryAttempts, fetchLog };
}

function missingCompanyReceipt(stored, platform = "instagram", companySlug = "6thsense") {
  const attempt = Object.values(stored.output.attempts).find((candidate) =>
    candidate.platform === platform &&
    candidate.companySlug === companySlug &&
    candidate.entityType === "company" &&
    candidate.accountUrl == null
  );
  assert.ok(attempt, "expected the URL-less company attempt");

  const discovery = stored.discoveryAttempts
    .filter((candidate) =>
      candidate.platform === platform &&
      candidate.company_slug === companySlug &&
      candidate.entityType === "company" &&
      candidate.source === "public_search_missing_social" &&
      candidate.blocker
    )
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
  assert.ok(discovery, "expected the URL-less company discovery receipt");

  const failure = stored.output.failures.find((candidate) =>
    candidate.attemptKey === attempt.attemptKey && candidate.blocker
  );
  assert.ok(failure, "expected a durable failure row with blocker metadata");
  return { attempt, discovery, failure };
}

function assertExactBlocker(blocker, {
  code,
  httpStatus,
  messagePrefix,
  retryAt = blocker?.retryAt
}) {
  assert.deepEqual(
    Object.keys(blocker ?? {}).sort(),
    ["code", "httpStatus", "message", "provider", "retryAt"],
    "blocker schema must remain exact and machine-readable"
  );
  assert.ok(retryAt, "terminal public-search blocker must include retryAt");
  assert.equal(new Date(retryAt).toISOString(), retryAt, "retryAt must be canonical ISO-8601");
  assert.deepEqual(blocker, {
    provider: "duckduckgo_html",
    code,
    retryAt,
    httpStatus,
    message: `${messagePrefix}; circuit open until ${retryAt}`
  });
  return blocker;
}

function assertSharedBlocker({ attempt, discovery, failure }, expected) {
  const blocker = assertExactBlocker(attempt.blocker, expected);
  assert.deepEqual(discovery.blocker, blocker, "discovery receipt must retain the exact blocker");
  assert.deepEqual(failure.blocker, blocker, "failure row must retain the exact blocker");
  assert.equal(attempt.retryable, false, "the attempt is terminal only for the blocker cooldown");
  assert.equal(failure.retryable, false, "the durable failure must not replay within the cooldown");
}

test("HTTP 404 public-search responses become exact structured blocked receipts", async () => {
  const fixture = await createFixture({
    fetchImplementation: 'return new Response("mock not found", { status: 404 });'
  });
  runCollector(fixture);
  const stored = await readFixture(fixture);
  const receipt = missingCompanyReceipt(stored);

  assertSharedBlocker(receipt, {
    code: "public_search_http_failure",
    httpStatus: 404,
    messagePrefix: "DuckDuckGo public search returned HTTP 404"
  });
  assert.equal(stored.fetchLog.fetchUrls.length, 2, "404 opens the circuit after two bounded probes");
  assert.equal(stored.fetchLog.publicSearchAdmissions.length, 2);
  assert.doesNotMatch(
    JSON.stringify([receipt.attempt, receipt.discovery, receipt.failure]),
    /verified_no_account/i,
    "provider failure must never be converted to verified account absence"
  );
});

test("HTTP 200 CAPTCHA pages become exact structured blocked receipts", async () => {
  const fixture = await createFixture({
    fetchImplementation: `return new Response(
      '<html><body><form class="challenge-form">Complete this CAPTCHA challenge</form></body></html>',
      { status: 200, headers: { "content-type": "text/html" } }
    );`
  });
  runCollector(fixture);
  const stored = await readFixture(fixture);
  const receipt = missingCompanyReceipt(stored);

  assertSharedBlocker(receipt, {
    code: "public_search_soft_block",
    httpStatus: 200,
    messagePrefix: "DuckDuckGo public search returned an HTTP 200 challenge/block page"
  });
  assert.equal(stored.fetchLog.fetchUrls.length, 1, "a challenge page opens the circuit immediately");
  assert.equal(stored.fetchLog.publicSearchAdmissions.length, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /verified_no_account/i);
});

test("partial public-search success retains candidates and the later outage blocker", async () => {
  const fixture = await createFixture({
    fetchState: "let searchCallCount = 0;",
    fetchImplementation: `
      searchCallCount += 1;
      if (searchCallCount === 1) {
        return new Response(
          '<div class="result">' +
            '<h2 class="result__title"><a class="result__a" href="https://www.instagram.com/6thsenseai/">6thSense YC S26 Instagram</a></h2>' +
            '<div class="result__snippet">Official 6thSense YC Summer 2026 account</div>' +
          '</div>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      throw new Error("mock partial provider outage");
    `
  });
  runCollector(fixture);
  const stored = await readFixture(fixture);
  const receipt = missingCompanyReceipt(stored);

  assert.equal(receipt.attempt.count, 1, "candidate found before the outage must be retained");
  assert.equal(receipt.attempt.outcomeStatus, "needs_review");
  assert.equal(receipt.discovery.result_count, 1);
  assert.equal(receipt.discovery.status, "needs_review");
  assert.equal(receipt.discovery.selected_url, "https://instagram.com/6thsenseai");
  assert.match(receipt.failure.message, /partially blocked/i);
  assertSharedBlocker(receipt, {
    code: "public_search_transport_failure",
    httpStatus: null,
    messagePrefix: "DuckDuckGo public search transport failed: mock partial provider outage"
  });
  assert.equal(stored.fetchLog.fetchUrls.length, 3, "one success plus two failed probes must be bounded");
  assert.equal(stored.fetchLog.publicSearchAdmissions.length, 3);
});

test("an open circuit stops every remaining owner query loop", async () => {
  const fixture = await createFixture({
    fetchImplementation: 'throw new Error("mock provider offline");'
  });
  runCollector(fixture, { social: "all", workers: 8, laneWorkers: 1 });
  const stored = await readFixture(fixture);
  const attempts = Object.values(stored.output.attempts).filter((attempt) =>
    attempt.platform === "instagram" &&
    attempt.companySlug === "6thsense" &&
    attempt.accountUrl == null
  );

  assert.equal(attempts.length, 5, "fixture must cover the company and all four founders");
  assert.equal(stored.fetchLog.fetchUrls.length, 2, "only the two circuit-opening probes reach fetch");
  assert.equal(
    stored.fetchLog.publicSearchAdmissions.length,
    attempts.length + 1,
    "the first owner uses two probes and every later owner exits after one circuit-open rejection"
  );
  assert.ok(attempts.every((attempt) => attempt.blocker?.retryAt));
  assert.equal(new Set(attempts.map((attempt) => attempt.blocker.retryAt)).size, 1);
});

test("mapped LinkedIn zero-post fallback outage preserves prior native post evidence", async () => {
  const priorPost = priorTashLinkedInPost();
  const seededOutput = {
    ...EMPTY_OUTPUT,
    evidence: [priorPost]
  };
  const seededCheckpoint = {
    ...EMPTY_CHECKPOINT,
    evidence: [priorPost]
  };
  const fixture = await createFixture({
    outputPayload: seededOutput,
    checkpointPayload: seededCheckpoint,
    fetchImplementation: `
      if (value.startsWith("https://duckduckgo.com/html/")) {
        throw new Error("mock LinkedIn search outage");
      }
      if (
        value.startsWith("https://www.linkedin.com/company/tash-cards") ||
        value.startsWith("https://linkedin.com/company/tash-cards")
      ) {
        return new Response(
          '<html><head>' +
            '<link rel="canonical" href="https://www.linkedin.com/company/tash-cards">' +
            '<meta property="og:title" content="tash (YC S26) | LinkedIn">' +
            '<meta property="og:description" content="tash builds the investment platform for sports and trading cards. 304 followers">' +
          '</head><body></body></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      throw new Error("unexpected mock URL: " + value);
    `
  });
  runCollector(fixture, { company: "tash", platform: "linkedin" });
  const stored = await readFixture(fixture);
  const retained = stored.output.evidence.find((item) => item.sourceUrl === priorPost.sourceUrl);
  const attempt = Object.values(stored.output.attempts).find((candidate) =>
    candidate.platform === "linkedin" &&
    candidate.companySlug === "tash" &&
    candidate.entityType === "company" &&
    candidate.accountUrl
  );
  assert.ok(attempt, "expected mapped LinkedIn attempt");
  const discovery = stored.discoveryAttempts
    .filter((candidate) =>
      candidate.platform === "linkedin" &&
      candidate.company_slug === "tash" &&
      candidate.entityType === "company" &&
      candidate.source === "yc_profile_social_links" &&
      candidate.blocker
    )
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
  assert.ok(discovery, "expected mapped LinkedIn discovery receipt");
  const failure = stored.output.failures.find((candidate) =>
    candidate.attemptKey === attempt.attemptKey && candidate.blocker
  );
  assert.ok(failure, "expected zero-post fallback blocker failure");

  assert.ok(retained, "a blocked shallow refresh must not erase a previously recovered native post");
  assert.equal(retained.platformPostId, priorPost.platformPostId);
  assert.equal(retained.contributionScore, priorPost.contributionScore);
  assertSharedBlocker({ attempt, discovery, failure }, {
    code: "public_search_transport_failure",
    httpStatus: null,
    messagePrefix: "DuckDuckGo public search transport failed: mock LinkedIn search outage"
  });
});

test("terminal public-search blocker skips before retryAt and reruns immediately after retryAt", async () => {
  const futureRetryAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const futureAttempt = blockedInstagramAttempt(futureRetryAt);
  const futureFixture = await createFixture({
    checkpointPayload: { ...EMPTY_CHECKPOINT, attempts: { [futureAttempt.attemptKey]: futureAttempt } },
    fetchImplementation: 'return new Response("mock not found", { status: 404 });'
  });
  runCollector(futureFixture, { force: false });
  const futureStored = await readFixture(futureFixture);

  assert.equal(futureStored.fetchLog.fetchUrls.length, 0, "future blocker cooldown must skip collection");
  assert.equal(futureStored.fetchLog.publicSearchAdmissions.length, 0);

  const pastRetryAt = new Date(Date.now() - 60_000).toISOString();
  const pastAttempt = blockedInstagramAttempt(pastRetryAt);
  const pastFixture = await createFixture({
    checkpointPayload: { ...EMPTY_CHECKPOINT, attempts: { [pastAttempt.attemptKey]: pastAttempt } },
    fetchImplementation: 'return new Response("mock not found", { status: 404 });'
  });
  runCollector(pastFixture, { force: false });
  const pastStored = await readFixture(pastFixture);

  assert.equal(
    pastStored.fetchLog.fetchUrls.length,
    2,
    "expired blocker must rerun immediately even while the ordinary freshness window remains active"
  );
  assert.equal(pastStored.fetchLog.publicSearchAdmissions.length, 2);
  const refreshed = missingCompanyReceipt(pastStored);
  assert.notEqual(refreshed.attempt.blocker.retryAt, pastRetryAt);
  assert.ok(Date.parse(refreshed.attempt.checkedAt) > Date.parse(pastAttempt.checkedAt));
});

function blockedInstagramAttempt(retryAt) {
  const attemptKey = "instagram:company:company-6thsense:missing-url";
  return {
    attemptKey,
    status: "done",
    checkedAt: new Date().toISOString(),
    error: `DuckDuckGo public search circuit is open until ${retryAt}`,
    blocker: {
      provider: "duckduckgo_html",
      code: "public_search_circuit_open",
      retryAt,
      httpStatus: null,
      message: `DuckDuckGo public search circuit is open until ${retryAt}`
    },
    retryable: false,
    outcomeStatus: "blocked_or_empty",
    outcomeReason: "collector_checked_blocked_or_empty",
    attributionVersion: PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
    batchSlug: "S26",
    platform: "instagram",
    companySlug: "6thsense",
    entityType: "company",
    entityId: "company-6thsense",
    entityName: "6thSense",
    accountUrl: null
  };
}

function priorTashLinkedInPost() {
  const sourceUrl = "https://linkedin.com/posts/tash-cards_were-excited-to-share-that-tash-is-part-activity-7489018280448245760-hDoc";
  const accountUrl = "https://linkedin.com/company/tash-cards";
  const postedAt = "2026-07-31T18:04:57.270Z";
  return {
    id: "regression-prior-tash-linkedin-post",
    entityType: "company",
    entityId: "company-tash",
    entityName: "tash",
    companySlug: "tash",
    companyName: "tash",
    platform: "linkedin",
    sourceUrl,
    platformPostId: "7489018280448245760",
    accountUrl,
    authorHandle: accountUrl,
    title: "We’re excited to share that tash is part of the YC S26 batch.",
    text: "We’re excited to share that tash is part of the YC S26 batch.",
    rawVisibleText: JSON.stringify({
      post: {
        id: "7489018280448245760",
        url: sourceUrl,
        articleBody: "We’re excited to share that tash is part of the YC S26 batch.",
        datePublished: postedAt,
        author: { name: "tash (YC S26)", url: accountUrl, slug: "tash-cards" },
        counts: { reactions: 304, comments: 118 },
        verification: { status: "accepted", activityIdMatched: true, authorMatched: true }
      }
    }),
    postedAt,
    metrics: { reactions: 304, comments: 118 },
    contributionScore: 100,
    review_state: "verified",
    attributionVersion: PUBLIC_EVIDENCE_ATTRIBUTION_VERSION,
    attributionStatus: "verified",
    attributionMode: "account_owner",
    attributionSignals: [
      "mapped_official_account",
      "same_company_native_author_subject",
      "unique_native_author"
    ],
    matchReason: "Previously verified exact LinkedIn activity ID and mapped native author.",
    first_seen_at: postedAt,
    last_checked_at: postedAt,
    last_updated_at: postedAt
  };
}
