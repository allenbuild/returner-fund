import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autonomousCollectorRetryableFailures } from
  "../scripts/lib/autonomous-ingestion-plan.mjs";

const collector = await readFile(
  join(process.cwd(), "scripts", "fetch-public-traction.mjs"),
  "utf8"
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("the public X collector is anonymous, bounded, and exact-owner attributed", () => {
  assert.match(
    collector,
    /import \{ extractXPublicProfileReceipt \} from "\.\/lib\/x-public-profile-html\.mjs";/
  );
  const ingest = section(
    collector,
    "async function ingestXPublicProfile",
    "function mergeXNativeEvidence"
  );

  assert.match(ingest, /fetchPublicBoundedText\(accountUrl/);
  assert.match(ingest, /maxResponseBytes: HISTORICAL_BACKFILL_LIMITS\.maxResponseBytes/);
  assert.match(ingest, /maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS\.maxDecodedBytes/);
  assert.match(ingest, /requestedHandle: handle/);
  assert.match(ingest, /limit: 100/);
  assert.match(ingest, /platformPostId: post\.id/);
  assert.match(ingest, /authorHandle: post\.authorHandle/);
  assert.match(ingest, /attributionProvenance: "x_public_profile_schema_org_exact_owner_v1"/);
  assert.match(ingest, /sourceWindow: "first_server_rendered_profile_page"/);
  assert.match(ingest, /sourceExhausted: false/);
  assert.match(ingest, /Anonymous X public profile returned HTTP \$\{response\.status\}/);
  assert.match(ingest, /\[403, 429\]\.includes\(response\.status\)/);
  assert.match(ingest, /recordPlatformCooldownIfNeeded\("x", cooldownError\)/);
  assert.doesNotMatch(ingest, /verifiedEmpty:/);
  assert.match(ingest, /mergeOnly: true/);
  assert.doesNotMatch(
    ingest,
    /\b(?:cookie|authorization|proxy-authorization|session|browser|playwright)\b/i
  );
});

test("the X response timeout remains active through its bounded body read", () => {
  const boundedFetch = section(
    collector,
    "async function fetchPublicBoundedText",
    "function fetchLinkedInPublicText"
  );
  const readIndex = boundedFetch.indexOf("await readBoundedResponseText(response");
  const clearIndex = boundedFetch.indexOf("clearTimeout(timeout)");

  assert.notEqual(readIndex, -1);
  assert.notEqual(clearIndex, -1);
  assert.ok(clearIndex > readIndex, "timeout must clear only after the body read");
});

test("public profile and API rows merge by native post ID without lowering metrics", () => {
  const merge = section(
    collector,
    "function mergeXNativeEvidence",
    "async function ingestInstagramPublicProfile"
  );

  assert.match(merge, /`post:\$\{item\.platformPostId\}`/);
  assert.match(merge, /mergeMetricMaximums\(existing\.metrics, item\.metrics\)/);
  assert.match(merge, /Math\.max\(\.\.\.values\)/);
  assert.match(
    merge,
    /x_public_profile_schema_org\+x_recent_search_exact_owner_v1/
  );
  assert.match(merge, /scoreMetrics\("x", metrics\)/);
});

test("a rerun reconciles stale same-post rows by native ID and keeps per-metric maxima", async (context) => {
  const stale = staleXEvidence();
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: true }),
    seedEvidence: [stale]
  });
  const rows = snapshot.evidence.filter(
    (row) => row.platformPostId === "2083304728046518692"
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "this is much better than the video yall took in my apt lobby LMAO");
  assert.equal(rows[0].postedAt, "2026-07-31T21:32:07.000Z");
  assert.equal(rows[0].publishedAtPrecision, "exact");
  assert.deepEqual(rows[0].metrics, {
    views: 400,
    likes: 5,
    replies: 1,
    reposts: 0,
    quotes: 0
  });
  assert.equal(rows[0].xMetricReceipt.timestampConflict, false);
  assert.equal(rows[0].xMetricReceipt.observations.length, 2);
  assert.equal(JSON.parse(rows[0].rawVisibleText).source, "x_native_evidence_reconciled_v1");

  // A resumed shard can normalize its already-enriched row without collecting
  // a replacement for that physical post. The generated reconciliation clause
  // must remain singular so the immutable same-observation archive can replay.
  const resumedSnapshot = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: false }),
    seedEvidence: rows
  });
  const resumedRows = resumedSnapshot.evidence.filter(
    (row) => row.platformPostId === "2083304728046518692"
  );
  const sourceReason = rows[0].matchReason.replace(
    / Canonical write reconciled [0-9]+ same-owner observations by native X post ID and retained per-metric maxima\./g,
    ""
  );
  assert.equal(resumedRows.length, 1);
  assert.equal(
    resumedRows[0].matchReason,
    `${sourceReason} Canonical write reconciled 1 same-owner observations by native X post ID and retained per-metric maxima.`
  );
  assert.equal(resumedRows[0].matchReason.match(/Canonical write reconciled/g)?.length, 1);
});

test("same native X post IDs with conflicting exact timestamps are quarantined", async (context) => {
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: true }),
    seedEvidence: [staleXEvidence({ postedAt: "2026-07-31T21:32:08.000Z" })]
  });
  const evidenceRows = snapshot.evidence.filter(
    (row) => row.platformPostId === "2083304728046518692"
  );
  const reviewRows = snapshot.needsReview.filter(
    (row) => row.platformPostId === "2083304728046518692"
  );

  assert.equal(evidenceRows.length, 0);
  assert.equal(reviewRows.length, 1);
  assert.equal(reviewRows[0].xMetricReceipt.timestampConflict, true);
  assert.match(reviewRows[0].matchReason, /Conflicting exact native timestamps/);

  const resumed = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: false }),
    seedEvidence: reviewRows
  });
  const resumedReviewRows = resumed.needsReview.filter(
    (row) => row.platformPostId === "2083304728046518692"
  );
  assert.equal(resumedReviewRows.length, 1);
  assert.equal(
    resumedReviewRows[0].matchReason.match(/Conflicting exact native timestamps/g)?.length,
    1
  );
  assert.equal(
    resumedReviewRows[0].matchReason.match(/Canonical write reconciled/g)?.length,
    1
  );
});

test("a date-only X Schema.org label is rejected instead of promoted to exact", async (context) => {
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: true, postedAt: "2026-07-31" })
  });

  assert.equal(snapshot.evidence.some(
    (row) => row.platformPostId === "2083304728046518692"
  ), false);
  assert.equal(snapshot.attempts[
    "x:founder:founder-codag-michael-zhou-2706494:https://x.com/michaelzixizhou"
  ].outcomeStatus, "needs_review");
});

test("zero-article X profiles are not terminally accepted as verified empty", async (context) => {
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: false })
  });
  const attempt = snapshot.attempts[
    "x:founder:founder-codag-michael-zhou-2706494:https://x.com/michaelzixizhou"
  ];

  assert.equal(attempt.outcomeStatus, "needs_review");
  assert.equal(attempt.outcomeReason, "collector_needs_review");
  assert.equal(attempt.coverageReceipt.reason, "no_exact_owner_social_media_postings");
  assert.equal(attempt.coverageReceipt.sourceExhausted, false);
  assert.equal(snapshot.evidence.length, 0);
  assert.ok(snapshot.needsReview.length > 0);
  assert.ok(snapshot.failures.length > 0);
});

test("a zero-evidence X review stays retryable when its reader transport fails", async (context) => {
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: false }),
    xFallbackError: "fetch failed: socket closed"
  });
  const attempt = snapshot.attempts[
    "x:founder:founder-codag-michael-zhou-2706494:https://x.com/michaelzixizhou"
  ];
  const transportFailure = snapshot.failures.find(
    (row) => /X public-reader fallback failed: fetch failed: socket closed/.test(row.message ?? "")
  );

  assert.equal(snapshot.evidence.length, 0);
  assert.ok(snapshot.needsReview.length > 0);
  assert.ok(transportFailure);
  assert.equal(transportFailure.retryable, undefined);
  assert.equal(attempt.outcomeStatus, "needs_review");
  assert.equal(attempt.retryable, true);
  assert.ok(autonomousCollectorRetryableFailures(snapshot).includes(transportFailure.message));
});

test("direct X HTTP blockers remain explicit without a remote-reader retry", async (context) => {
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: "rate limited",
    xStatus: 429
  });
  const attempt = snapshot.attempts[
    "x:founder:founder-codag-michael-zhou-2706494:https://x.com/michaelzixizhou"
  ];

  assert.ok(snapshot.failures.some(
    (failure) => failure.message === "Anonymous X public profile returned HTTP 429."
  ));
  assert.equal(attempt.coverageReceipt.reason, "x_public_profile_http_429");
  assert.equal(attempt.coverageReceipt.blocker, "Anonymous X public profile returned HTTP 429.");
});

test("a mapped X account returning 404 writes an exact typed terminal receipt", async (context) => {
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: "not found",
    xStatus: 404
  });
  const attempt = snapshot.attempts[
    "x:founder:founder-codag-michael-zhou-2706494:https://x.com/michaelzixizhou"
  ];

  assert.equal(attempt.outcomeStatus, "blocked_or_empty");
  assert.equal(attempt.outcomeReason, "collector_mapped_account_not_found");
  assert.equal(attempt.coverageReceipt.reason, "x_public_profile_http_404");
  assert.equal(attempt.retryable, false);
  assert.ok(snapshot.needsReview.some(
    (row) => row.entityId === "founder-codag-michael-zhou-2706494"
  ));
});

test("a mapped X identity mismatch writes an exact typed review receipt", async (context) => {
  const snapshot = await runMockedCodagCollector(context, {
    xHtml: profileHtml({ includePost: true, profileHandle: "different" }),
    xFallbackError: "fetch failed: socket closed"
  });
  const attempt = snapshot.attempts[
    "x:founder:founder-codag-michael-zhou-2706494:https://x.com/michaelzixizhou"
  ];

  assert.equal(attempt.outcomeStatus, "needs_review");
  assert.equal(attempt.outcomeReason, "collector_mapped_account_identity_mismatch");
  assert.equal(attempt.coverageReceipt.reason, "x_profile_identity_mismatch");
  assert.equal(attempt.retryable, false);
  assert.ok(snapshot.failures.some(
    (row) => /X public-reader fallback failed: fetch failed: socket closed/.test(row.message ?? "")
  ));
});

test("resume upgrades an exact legacy X receipt without repeating network collection", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "returner-x-legacy-terminal-resume-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const accountUrl = "https://x.com/michaelzixizhou";
  const entityId = "founder-codag-michael-zhou-2706494";
  const attemptKey = `x:founder:${entityId}:${accountUrl}`;
  const message = "Anonymous X public profile returned HTTP 404.";
  const legacyAttempt = {
    attemptKey,
    attributionVersion: 4,
    batchSlug: "S26",
    platform: "x",
    companySlug: "codag",
    entityType: "founder",
    entityId,
    entityName: "Michael Zhou",
    accountUrl,
    status: "done",
    checkedAt: new Date().toISOString(),
    error: message,
    retryable: false,
    outcomeStatus: "needs_review",
    outcomeReason: "collector_needs_review",
    coverageReceipt: {
      verified: false,
      accountUrl,
      reason: "x_public_profile_http_404"
    }
  };
  await Promise.all([
    writeFile(output, `${JSON.stringify({
      source: {},
      attempts: {},
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    })}\n`),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: { [attemptKey]: legacyAttempt },
      evidence: [],
      needsReview: [],
      failures: [{
        attemptKey,
        platform: "x",
        entityType: "founder",
        entityId,
        accountUrl,
        message
      }],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    })}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
globalThis.fetch = async () => {
  throw new Error("network collection must not run for an upgraded fresh receipt");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=codag",
    "--platforms=x",
    "--social=all",
    "--mapped-only",
    "--workers=1",
    "--x-workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      X_BEARER_TOKEN: "",
      EXA_API_KEY: "",
      NODE_OPTIONS: `--import=${preload}`
    },
    stdio: "pipe"
  });

  const snapshot = JSON.parse(await readFile(output, "utf8"));
  const migrated = snapshot.attempts[attemptKey];
  assert.equal(migrated.outcomeStatus, "blocked_or_empty");
  assert.equal(migrated.outcomeReason, "collector_mapped_account_not_found");
  assert.equal(migrated.retryable, false);
  assert.equal(migrated.coverageReceipt.reason, "x_public_profile_http_404");
  assert.deepEqual(autonomousCollectorRetryableFailures(snapshot), []);
});

test("resume collision selects the strictly newer attempt before legacy X upgrade", async (context) => {
  const currentCheckedAt = new Date(Date.now() - 60_000).toISOString();
  const staleCheckpointCheckedAt = new Date(Date.now() - 120_000).toISOString();
  const currentWinner = storedXAttempt({ checkedAt: currentCheckedAt });
  const staleLegacyCheckpoint = storedXAttempt({
    checkedAt: staleCheckpointCheckedAt,
    legacy404: true
  });
  const currentSnapshot = await runXAttemptCollision(context, {
    currentAttempt: currentWinner,
    checkpointAttempt: staleLegacyCheckpoint
  });

  assert.equal(currentSnapshot.attempts[currentWinner.attemptKey].checkedAt, currentCheckedAt);
  assert.equal(currentSnapshot.attempts[currentWinner.attemptKey].outcomeStatus, "completed");
  assert.equal(currentSnapshot.attempts[currentWinner.attemptKey].coverageReceipt, undefined);

  const newerCheckpointCheckedAt = new Date(Date.now() - 30_000).toISOString();
  const checkpointWinner = storedXAttempt({
    checkedAt: newerCheckpointCheckedAt,
    legacy404: true
  });
  const checkpointSnapshot = await runXAttemptCollision(context, {
    currentAttempt: storedXAttempt({ checkedAt: staleCheckpointCheckedAt }),
    checkpointAttempt: checkpointWinner
  });
  const selectedCheckpoint = checkpointSnapshot.attempts[checkpointWinner.attemptKey];

  assert.equal(selectedCheckpoint.checkedAt, newerCheckpointCheckedAt);
  assert.equal(selectedCheckpoint.outcomeStatus, "blocked_or_empty");
  assert.equal(selectedCheckpoint.outcomeReason, "collector_mapped_account_not_found");
  assert.equal(selectedCheckpoint.retryable, false);
});

test("equal or undated resume collisions fail closed and rerun collection", async (context) => {
  const equalCheckedAt = new Date(Date.now() - 60_000).toISOString();
  const cases = [{
    label: "equal",
    currentCheckedAt: equalCheckedAt,
    checkpointCheckedAt: equalCheckedAt
  }, {
    label: "undated-current",
    currentCheckedAt: null,
    checkpointCheckedAt: new Date(Date.now() - 30_000).toISOString()
  }];

  for (const fixture of cases) {
    const currentAttempt = storedXAttempt({ checkedAt: fixture.currentCheckedAt });
    const checkpointAttempt = storedXAttempt({
      checkedAt: fixture.checkpointCheckedAt,
      legacy404: true
    });
    const snapshot = await runXAttemptCollision(context, {
      currentAttempt,
      checkpointAttempt,
      collectHtml: profileHtml({ includePost: true })
    });
    const collected = snapshot.attempts[currentAttempt.attemptKey];

    assert.equal(collected.outcomeStatus, "completed", fixture.label);
    assert.equal(collected.coverageReceipt.verified, true, fixture.label);
    assert.notEqual(collected.checkedAt, fixture.checkpointCheckedAt, fixture.label);
    assert.ok(snapshot.evidence.some(
      (row) => row.platformPostId === "2083304728046518692"
    ), fixture.label);
  }
});

function storedXAttempt({ checkedAt, legacy404 = false }) {
  const accountUrl = "https://x.com/michaelzixizhou";
  const entityId = "founder-codag-michael-zhou-2706494";
  const attemptKey = `x:founder:${entityId}:${accountUrl}`;
  return {
    attemptKey,
    attributionVersion: 4,
    batchSlug: "S26",
    platform: "x",
    companySlug: "codag",
    entityType: "founder",
    entityId,
    entityName: "Michael Zhou",
    accountUrl,
    status: "done",
    ...(checkedAt ? { checkedAt } : {}),
    retryable: false,
    outcomeStatus: legacy404 ? "needs_review" : "completed",
    outcomeReason: legacy404 ? "collector_needs_review" : "collector_evidence_collected",
    ...(legacy404
      ? {
          error: "Anonymous X public profile returned HTTP 404.",
          coverageReceipt: {
            verified: false,
            accountUrl,
            reason: "x_public_profile_http_404"
          }
        }
      : {})
  };
}

async function runXAttemptCollision(context, {
  currentAttempt,
  checkpointAttempt,
  collectHtml = null
}) {
  const directory = await mkdtemp(join(tmpdir(), "returner-x-attempt-collision-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const attemptKey = currentAttempt.attemptKey;
  await Promise.all([
    writeFile(output, `${JSON.stringify({
      source: {},
      attempts: { [attemptKey]: currentAttempt },
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    })}\n`),
    writeFile(checkpoint, `${JSON.stringify({
      attempts: { [attemptKey]: checkpointAttempt },
      evidence: [],
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    })}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
import dns from "node:dns";
dns.lookup = (_hostname, options, callback) => {
  const addresses = [{ address: "93.184.216.34", family: 4 }];
  if (options?.all) callback(null, addresses);
  else callback(null, addresses[0].address, addresses[0].family);
};
const collectHtml = ${JSON.stringify(collectHtml)};
globalThis.fetch = async (url) => {
  if (collectHtml && String(url) === "https://x.com/michaelzixizhou") {
    return new Response(collectHtml, { status: 200, headers: { "content-type": "text/html" } });
  }
  throw new Error("resume collision winner must not collect network data");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=codag",
    "--platforms=x",
    "--social=all",
    "--mapped-only",
    "--workers=1",
    "--x-workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      X_BEARER_TOKEN: "",
      EXA_API_KEY: "",
      NODE_OPTIONS: `--import=${preload}`
    },
    stdio: "pipe"
  });

  return JSON.parse(await readFile(output, "utf8"));
}

async function runMockedCodagCollector(context, {
  xHtml,
  xStatus = 200,
  seedEvidence = [],
  xFallbackError = null
}) {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-x-contract-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  await Promise.all([
    writeFile(output, `${JSON.stringify({
      source: {},
      attempts: {},
      evidence: seedEvidence,
      needsReview: [],
      failures: [],
      discoveryAttempts: [],
      sourceDiscoveryPaths: []
    })}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
import dns from "node:dns";
dns.lookup = (_hostname, options, callback) => {
  const addresses = [{ address: "93.184.216.34", family: 4 }];
  if (options?.all) callback(null, addresses);
  else callback(null, addresses[0].address, addresses[0].family);
};
const xHtml = ${JSON.stringify(xHtml)};
const xFallbackError = ${JSON.stringify(xFallbackError)};
let xRequestCount = 0;
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value === "https://x.com/michaelzixizhou") {
    xRequestCount += 1;
    if (xRequestCount > 1 && xFallbackError) throw new Error(xFallbackError);
    return new Response(xHtml, { status: ${xStatus}, headers: { "content-type": "text/html" } });
  }
  if (value.startsWith("https://r.jina.ai/http://")) {
    throw new Error("remote reader fallback must remain disabled");
  }
  throw new Error("unexpected request: " + value);
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=codag",
    "--platforms=x",
    "--social=all",
    "--mapped-only",
    "--workers=1",
    "--x-workers=1",
    "--delay-ms=0",
    "--force",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      X_BEARER_TOKEN: "",
      EXA_API_KEY: "",
      NODE_OPTIONS: `--import=${preload}`
    },
    stdio: "pipe"
  });
  return JSON.parse(await readFile(output, "utf8"));
}

function profileHtml({
  includePost,
  postedAt = "2026-07-31T21:32:07.000Z",
  profileHandle = "michaelzixizhou"
}) {
  return `<!doctype html><html><body>
    <div itemscope itemtype="https://schema.org/ProfilePage">
      <meta itemprop="url" content="https://x.com/${profileHandle}">
      ${includePost ? `<article data-tweet-id="2083304728046518692" itemscope itemtype="https://schema.org/SocialMediaPosting">
        <meta itemprop="identifier" content="2083304728046518692">
        <meta itemprop="datePublished" content="${postedAt}">
        <meta itemprop="url" content="https://x.com/michaelzixizhou/status/2083304728046518692">
        <meta itemprop="articleBody" content="this is much better than the video yall took in my apt lobby LMAO">
        <div itemprop="author" itemscope itemtype="https://schema.org/Person">
          <meta itemprop="alternateName" content="michaelzixizhou">
          <meta itemprop="name" content="Michael Zhou">
        </div>
        ${metricHtml("Views", "ViewAction", 400)}
        ${metricHtml("Likes", "LikeAction", 4)}
        ${metricHtml("Replies", "ReplyAction", 1)}
        ${metricHtml("Retweets", "ShareAction", 0)}
        ${metricHtml("Quotes", "InteractAction", 0)}
      </article>` : ""}
    </div>
  </body></html>`;
}

function metricHtml(name, action, value) {
  return `<div itemprop="interactionStatistic" itemscope itemtype="https://schema.org/InteractionCounter">
    <meta itemprop="interactionType" content="https://schema.org/${action}">
    <meta itemprop="name" content="${name}">
    <meta itemprop="userInteractionCount" content="${value}">
  </div>`;
}

function staleXEvidence(overrides = {}) {
  return {
    id: "stale-title-derived-id",
    entityType: "founder",
    entityId: "founder-codag-michael-zhou-2706494",
    companySlug: "codag",
    companyName: "Codag",
    platform: "x",
    title: "A stale title that differs from the native body",
    sourceUrl: "https://x.com/michaelzixizhou/status/2083304728046518692",
    accountUrl: "https://x.com/michaelzixizhou",
    platformPostId: "2083304728046518692",
    authorHandle: "michaelzixizhou",
    text: "stale body",
    rawVisibleText: JSON.stringify({ source: "stale_fixture" }),
    postedAt: "2026-07-31T21:32:07.000Z",
    metrics: { views: 398, likes: 5, replies: 0 },
    contributionScore: 10,
    review_state: "verified",
    attributionVersion: 3,
    attributionStatus: "verified",
    attributionProvenance: "stale_x_fixture_v1",
    matchReason: "Verified public X post from the exact mapped native author.",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_checked_at: "2026-08-01T00:00:00.000Z",
    last_updated_at: "2026-07-31T21:32:07.000Z",
    ...overrides
  };
}
