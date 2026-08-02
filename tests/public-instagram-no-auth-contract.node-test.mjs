import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import {
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
});

test("the public collector passes the anonymous request through without credential overrides", () => {
  const instagramIngest = section(
    collector,
    "async function ingestInstagramPublicProfile",
    "function xApiEvidenceForAccount"
  );
  const fetchCall = section(
    instagramIngest,
    "response = await fetch(request.url",
    "payloadText = await response.text()"
  );

  assert.match(
    instagramIngest,
    /const request = instagramPublicProfileRequest\(\{ accountUrl \}\);/
  );
  assert.match(fetchCall, /\.\.\.request\.options/);
  assert.match(fetchCall, /signal: controller\.signal/);
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

  const compactReceipt = section(
    instagramIngest,
    "const postReceipt = {",
    "const views = Math.max"
  );
  assert.doesNotMatch(compactReceipt, /^\s*mediaUrls:/m);
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
