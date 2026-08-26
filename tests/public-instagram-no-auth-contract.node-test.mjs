import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import {
  instagramNativeFeedRequest,
  instagramPublicProfileRequest
} from "../scripts/lib/instagram-public-profile.mjs";

const root = process.cwd();
const collector = await readFile(
  join(root, "scripts", "fetch-public-traction.mjs"),
  "utf8"
);
const discoveryProducer = await readFile(
  join(root, "scripts", "discover-instagram-overrides.mjs"),
  "utf8"
);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("public Instagram profile requests omit account credentials and sensitive URL input", () => {
  const request = instagramPublicProfileRequest({
    accountUrl:
      "https://www.instagram.com/Tash.Cards/?sessionid=must-not-propagate#authorization=also-private"
  });
  const headers = new Headers(request.options.headers);

  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.redirect, "error");
  assert.equal(headers.has("cookie"), false);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("proxy-authorization"), false);
  assert.deepEqual(
    [...headers.keys()].sort(),
    ["accept", "referer", "user-agent", "x-ig-app-id"]
  );
  assert.equal(
    request.url,
    "https://www.instagram.com/api/v1/users/web_profile_info/?username=tash.cards"
  );
  assert.equal(request.options.headers.referer, "https://www.instagram.com/tash.cards/");
  assert.doesNotMatch(JSON.stringify(request), /must-not-propagate|also-private/);

  const nativeFeedRequest = instagramNativeFeedRequest({
    accountUrl:
      "https://www.instagram.com/Tash.Cards/?sessionid=must-not-propagate#authorization=also-private"
  });
  const nativeHeaders = new Headers(nativeFeedRequest.options.headers);
  assert.equal(nativeFeedRequest.options.credentials, "omit");
  assert.equal(nativeHeaders.has("cookie"), false);
  assert.equal(nativeHeaders.has("authorization"), false);
  assert.equal(nativeHeaders.has("proxy-authorization"), false);
  assert.doesNotMatch(
    JSON.stringify(nativeFeedRequest),
    /must-not-propagate|also-private/
  );
});

test("the public collector passes the anonymous request through without credential overrides", () => {
  const instagramIngest = section(
    collector,
    "async function ingestInstagramPublicProfile",
    "function xApiEvidenceForAccount"
  );
  const fetchCall = section(
    instagramIngest,
    "fetchPublicBoundedText(request.url",
    "} catch (error) {"
  );

  assert.match(
    instagramIngest,
    /const request = instagramPublicProfileRequest\(\{ accountUrl \}\);/
  );
  assert.match(fetchCall, /headers: request\.options\.headers/);
  assert.match(fetchCall, /redirect: "error"/);
  assert.match(fetchCall, /maxResponseBytes: HISTORICAL_BACKFILL_LIMITS\.maxResponseBytes/);
  assert.match(fetchCall, /maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS\.maxDecodedBytes/);
  assert.doesNotMatch(fetchCall, /\bfetch\(request\.url/);
  assert.doesNotMatch(
    fetchCall,
    /\b(?:cookie|authorization|proxy-authorization)\b|credentials\s*:/i
  );
});

test("embedded Instagram receipts stay compact while evidence retains media URLs", () => {
  const instagramIngest = section(
    collector,
    "async function ingestInstagramPublicProfile",
    "function xApiEvidenceForAccount"
  );

  assert.match(instagramIngest, /const postReceipt = \{/);
  assert.match(instagramIngest, /mediaUrlCount:/);
  assert.match(
    instagramIngest,
    /rawVisibleText: JSON\.stringify\(\{ receipt: receiptSummary, post: postReceipt \}\)/
  );
  assert.match(instagramIngest, /mediaUrls: post\.mediaUrls/);
  assert.match(instagramIngest, /const accepted = post\.profileRole === "primary"/);
  assert.match(
    instagramIngest,
    /needsReview: rowRecords\.filter\(\(item\) => !item\.accepted\)/
  );
  assert.match(instagramIngest, /instagramProfileReceiptFromNativeFeed/);

  const compactReceipt = section(
    instagramIngest,
    "const postReceipt = {",
    "const metrics = removeNullish(instagramEvidenceMetrics(post))"
  );
  assert.doesNotMatch(compactReceipt, /^\s*mediaUrls:/m);
});

test("the native feed paginator stays anonymous, bounded, and cursor-limited", () => {
  const nativeFeedIngest = section(
    collector,
    "async function fetchInstagramNativeFeedMetricReceipt",
    "function xApiEvidenceForAccount"
  );

  assert.match(nativeFeedIngest, /instagramNativeFeedRequest\(\{ accountUrl, maxId \}\)/);
  assert.match(nativeFeedIngest, /instagramNativeFeedMaxPages/);
  assert.match(nativeFeedIngest, /instagramNativeFeedMaxItems/);
  assert.match(nativeFeedIngest, /fetchPublicBoundedText\(request\.url/);
  assert.match(nativeFeedIngest, /headers: request\.options\.headers/);
  assert.match(nativeFeedIngest, /redirect: "error"/);
  assert.match(nativeFeedIngest, /seenCursors\.has\(nextMaxId\)/);
  assert.match(nativeFeedIngest, /partialReceipt/);
  assert.match(nativeFeedIngest, /paginationFailureMessage/);
  assert.doesNotMatch(nativeFeedIngest, /\bfetch\(request\.url/);
  assert.doesNotMatch(
    nativeFeedIngest,
    /\b(?:cookie|authorization|proxy-authorization)\b|credentials\s*:/i
  );
});

test("checkpoint snapshots are coalesced and canonical evidence keeps durable batch scope", () => {
  const checkpointWriter = section(
    collector,
    "async function writeCheckpoint",
    "async function readJson"
  );
  const evidenceFactory = section(
    collector,
    "function evidenceItem",
    "function reviewCandidate"
  );
  const normalizer = section(
    collector,
    "function normalizeStoredEvidence",
    "function nativeAuthorMatchesCanonicalAttribution"
  );

  assert.match(collector, /await writeCheckpoint\(\{ force: true \}\);/);
  assert.match(checkpointWriter, /checkpointCompletionsSinceWrite < checkpointEvery/);
  assert.match(evidenceFactory, /batchSlug: batchConfig\.slug/);
  assert.match(
    normalizer,
    /if \(item\.batchSlug && item\.batchSlug !== batchConfig\.slug\) return item;/
  );
  assert.match(normalizer, /batchSlug: item\.batchSlug \?\? batchConfig\.slug/);
});

test("exact native-feed fallback survives web profile failure and quarantines non-primary rows", async (context) => {
  const snapshot = await runMockedTashInstagramCollector(context);
  const accepted = snapshot.evidence.filter((row) => row.platform === "instagram");
  const review = snapshot.needsReview.filter((row) => row.platform === "instagram");

  assert.deepEqual(accepted.map((row) => row.platformPostId), ["PRIMARY"]);
  assert.equal(accepted[0].batchSlug, "S26");
  assert.equal(accepted[0].authorHandle, "tash.cards");
  assert.equal(accepted[0].postedAt, "2024-08-01T00:00:01.000Z");
  assert.equal(accepted[0].publishedAtPrecision, "exact");
  assert.deepEqual(
    review.map((row) => row.platformPostId).sort(),
    ["COAUTHOR", "SURFACE"]
  );
  assert.ok(review.every((row) => row.attributionStatus === "needs_review"));
  assert.equal(snapshot.failures.some((row) =>
    /web profile endpoint returned HTTP 400/i.test(row.message)
  ), false);
  const receipt = JSON.parse(accepted[0].rawVisibleText).receipt;
  assert.match(
    receipt.profileFallbackDiagnostic,
    /Instagram public profile endpoint returned HTTP 400/i
  );
});

test("an exhausted exact native feed preserves verified-empty terminal proof", async (context) => {
  const snapshot = await runMockedTashInstagramCollector(context, { items: [] });
  const attempt = snapshot.attempts[
    "instagram:company:company-tash:https://instagram.com/tash.cards"
  ];

  assert.ok(
    attempt,
    `Missing Instagram attempt: ${JSON.stringify(Object.keys(snapshot.attempts))}`
  );
  assert.equal(snapshot.evidence.length, 0);
  assert.equal(snapshot.needsReview.length, 0);
  assert.equal(snapshot.failures.length, 0);
  assert.equal(attempt.outcomeStatus, "completed");
  assert.equal(
    attempt.outcomeReason,
    "collector_verified_native_account_empty_public_window"
  );
  assert.equal(attempt.coverageReceipt.verified, true);
  assert.equal(attempt.coverageReceipt.verifiedEmpty, true);
  assert.equal(attempt.coverageReceipt.sourceExhausted, true);
  assert.equal(attempt.coverageReceipt.uniqueItemCount, 0);
  assert.equal(attempt.coverageReceipt.pageCount, 1);
  assert.equal(
    attempt.coverageReceipt.outcome,
    "verified_empty_exact_native_feed"
  );
});

test("--mapped-only disables discovery and exits before URL-less task fanout", () => {
  const argumentSetup = section(
    collector,
    "const mappedAccountsOnly = hasArg",
    "const discoveryAttemptsPath"
  );
  const socialTaskPlanner = section(
    collector,
    "function socialTasksForEntity",
    "async function runTaskPlan"
  );

  assert.match(argumentSetup, /hasArg\("--mapped-only"\)/);
  assert.match(
    argumentSetup,
    /const discoverMissingSocial\s*=\s*!mappedAccountsOnly\s*&&/
  );

  const mappedOnlyGuard = socialTaskPlanner.indexOf(
    "if (!accountUrls.length && mappedAccountsOnly) return [];"
  );
  const urlLessFallback = socialTaskPlanner.indexOf(
    "(accountUrls.length ? accountUrls : [null])"
  );
  assert.notEqual(mappedOnlyGuard, -1, "missing mapped-only empty-account guard");
  assert.notEqual(urlLessFallback, -1, "missing URL-less discovery fallback");
  assert.ok(
    mappedOnlyGuard < urlLessFallback,
    "mapped-only must return before a URL-less discovery task can be created"
  );
});

test("Instagram discovery artifacts never disclose absolute source snapshot paths", async () => {
  assert.match(
    discoveryProducer,
    /source_snapshot: repositoryRelativePath\(cohortSnapshotPath\)/
  );
  assert.match(discoveryProducer, /relative\(root, absolutePath\)/);
  assert.match(discoveryProducer, /relativePath\.startsWith\(`\.\.\$\{sep\}`\)/);

  const artifacts = [
    ["outputs/instagram-discovery-candidates.json", "src/lib/yc/summer-2026-companies.json"],
    ["outputs/instagram-discovery-candidates-s2026.json", "src/lib/yc/spring-2026-companies.json"],
    ["outputs/instagram-discovery-candidates-a16zsr006.json", "public/graph/a16zsr006.json"]
  ];
  for (const [artifactPath, expectedSourceSnapshot] of artifacts) {
    const document = JSON.parse(await readFile(join(root, artifactPath), "utf8"));
    assert.equal(document.source_snapshot, expectedSourceSnapshot, artifactPath);
    assertSafeSourceSnapshot(document, artifactPath);
  }
});

test("Instagram discovery serializes a repo-relative source snapshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "instagram-discovery-path-contract-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "report.json");
  execFileSync(process.execPath, [
    "scripts/discover-instagram-overrides.mjs",
    "--batch=S26",
    "--max-companies=0",
    "--company-only",
    "--skip-official",
    `--output=${outputPath}`
  ], { cwd: root, stdio: "pipe" });

  const document = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(document.source_snapshot, "src/lib/yc/summer-2026-companies.json");
  assertSafeSourceSnapshot(document, outputPath);
});

function assertSafeSourceSnapshot(document, label) {
  assert.equal(isAbsolute(document.source_snapshot), false, label);
  assert.doesNotMatch(document.source_snapshot, /^(?:~[\\/]|file:|[a-z]:[\\/])/i, label);
  assert.doesNotMatch(
    JSON.stringify(document),
    /(?:\/Users\/|\/home\/|[a-z]:\\\\Users\\\\|file:\/\/|blob:http:\/\/localhost)/i,
    label
  );
}

async function runMockedTashInstagramCollector(context, { items = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-instagram-contract-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const nativeItems = items ?? [
    nativeFeedFixture("PRIMARY", "1", "tash.cards", []),
    nativeFeedFixture("COAUTHOR", "2", "other.author", ["tash.cards"]),
    nativeFeedFixture("SURFACE", "3", "surface.author", ["someone.else"])
  ];
  await Promise.all([
    writeFile(output, `${JSON.stringify({
      source: {}, attempts: {}, evidence: [], needsReview: [], failures: [],
      discoveryAttempts: [], sourceDiscoveryPaths: []
    })}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const feed = ${JSON.stringify({
  status: "ok",
  user: { username: "tash.cards" },
  num_results: nativeItems.length,
  more_available: false,
  next_max_id: null,
  items: nativeItems
})};
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.includes("/api/v1/users/web_profile_info/")) {
    return new Response("asset unavailable", { status: 400 });
  }
  if (value.includes("/api/v1/feed/user/tash.cards/username/")) {
    return new Response(JSON.stringify(feed), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  throw new Error("unexpected request: " + value);
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S26",
    "--company=tash",
    "--platforms=instagram",
    "--social=company",
    "--mapped-only",
    "--workers=1",
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
      X_BEARER_TOKEN: "",
      EXA_API_KEY: "",
      NODE_OPTIONS: `--max-old-space-size=1024 --import=${preload}`
    },
    stdio: "pipe"
  });
  return JSON.parse(await readFile(output, "utf8"));
}

function nativeFeedFixture(shortcode, pk, authorUsername, coauthors) {
  return {
    pk,
    code: shortcode,
    media_type: 1,
    product_type: "feed",
    taken_at: 1_722_470_400 + Number(pk),
    user: { username: authorUsername },
    coauthor_producers: coauthors.map((username) => ({ username })),
    caption: { text: `tash launch ${shortcode}` },
    like_count: 10,
    comment_count: 2,
    image_versions2: {
      candidates: [{ url: `https://scontent.cdninstagram.com/${shortcode}.jpg?oh=signed&oe=expiry` }]
    }
  };
}
