import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("public collection plans verified Eden accounts and supersedes stale catalog links", () => {
  const plan = JSON.parse(execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=x,linkedin",
    "--social=all",
    "--plan"
  ], { cwd: root, encoding: "utf8" }));

  const targets = plan.socialTargets.map((target) => `${target.entityType}:${target.platform}:${target.accountUrl}`);
  assert.ok(targets.includes("company:linkedin:https://www.linkedin.com/company/eden-ai-robotics"));
  assert.ok(targets.includes("company:x:https://x.com/thefinalcompany"));
  assert.ok(targets.includes("founder:linkedin:https://www.linkedin.com/in/stamatis-floratos-535b19244"));
  assert.ok(targets.includes("founder:x:https://x.com/cybermetheus"));
  assert.equal(targets.some((target) => /StamatisTWIY/i.test(target)), false);
});

test("readable LinkedIn profiles with zero posts fall back to founder-first discovery and require the native author", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-linkedin-fallback-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const goodPost = "https://www.linkedin.com/posts/russellhowardsmith_counter-drone-activity-7999999999999999991-good";
  const wrongAuthorPost = "https://www.linkedin.com/posts/someone-else_counter-drone-activity-7999999999999999992-bad";
  const canonicalGoodPost = goodPost.replace("www.linkedin.com", "linkedin.com");
  const canonicalWrongAuthorPost = wrongAuthorPost.replace("www.linkedin.com", "linkedin.com");

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const goodPost = ${JSON.stringify(goodPost)};
const wrongAuthorPost = ${JSON.stringify(wrongAuthorPost)};
const response = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
globalThis.fetch = async (input) => {
  const rawUrl = String(input);
  if (rawUrl.startsWith("https://duckduckgo.com/html/")) {
    const query = new URL(rawUrl).searchParams.get("q") ?? "";
    if (!query.includes("Russell Smith")) return response("<html></html>");
    return response(\`<html><body>
      <div class="result"><h2 class="result__title"><a class="result__a" href="\${goodPost}">Russell Smith at 9 Mothers</a></h2><div class="result__snippet">9 Mothers founder startup update with 20 reactions</div></div>
      <div class="result"><h2 class="result__title"><a class="result__a" href="\${wrongAuthorPost}">Russell Smith and 9 Mothers</a></h2><div class="result__snippet">9 Mothers founder startup update with 20 reactions</div></div>
    </body></html>\`);
  }
  if (rawUrl.includes("7999999999999999991")) {
    return response("Title: Russell Smith update | LinkedIn\\nRussell Smith at 9 Mothers shares a startup update. 20 reactions 2 comments");
  }
  if (rawUrl.includes("7999999999999999992")) {
    return response("Title: Someone Else mentions 9 Mothers | LinkedIn\\nSomeone Else shares a 9 Mothers startup update. 20 reactions 2 comments");
  }
  if (rawUrl.includes("linkedin.com/in/russellhowardsmith")) {
    return response("Title: Russell Smith | LinkedIn\\nRussell Smith is a founder at 9 Mothers. No native activity links are visible here.");
  }
  return response("Title: Unmatched LinkedIn profile\\nThis readable profile does not match the requested entity.");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=9-mothers-corporation",
    "--platforms=linkedin",
    "--social=all",
    "--workers=1",
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
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const [normalized, paths] = await Promise.all([
    readFile(output, "utf8").then(JSON.parse),
    readFile(sourceDiscoveryPaths, "utf8").then(JSON.parse)
  ]);
  const founderId = "founder-9-mothers-corporation-russell-smith-1373";
  const nativeFounderPosts = normalized.evidence.filter(
    (row) => row.entityId === founderId && row.platformPostId
  );
  assert.deepEqual(nativeFounderPosts.map((row) => row.sourceUrl), [canonicalGoodPost]);
  assert.equal(nativeFounderPosts[0].authorHandle, "russellhowardsmith");
  assert.ok(nativeFounderPosts[0].contributionScore > 0);
  const wrongAuthorReview = normalized.needsReview.find((row) => row.candidateUrl === canonicalWrongAuthorPost);
  assert.equal(wrongAuthorReview.entityId, founderId);
  assert.match(wrongAuthorReview.matchReason, /exact verified founder author identity is required/i);
  assert.ok(
    paths.some(
      (row) =>
        row.discovered_url === canonicalGoodPost &&
        /readable but exposed no verified native posts/i.test(row.match_reason) &&
        /site:linkedin\.com\/posts/i.test(row.match_reason)
    )
  );
});

test("verified LinkedIn vanity aliases keep Eden founder discovery eligible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-linkedin-alias-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const preload = join(directory, "mock-fetch.mjs");
  const postUrl = "https://www.linkedin.com/posts/stamatis-floratos-535b19244_eden-robotics-activity-7999999999999999993-good";
  const canonicalPostUrl = postUrl.replace("www.linkedin.com", "linkedin.com");

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: [], needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n"),
    writeFile(preload, `
const postUrl = ${JSON.stringify(postUrl)};
const response = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
globalThis.fetch = async (input) => {
  const rawUrl = String(input);
  if (rawUrl.startsWith("https://duckduckgo.com/html/")) {
    const query = new URL(rawUrl).searchParams.get("q") ?? "";
    if (!query.toLowerCase().includes("stamatis floratos")) return response("<html></html>");
    return response(\`<html><body><div class="result"><h2 class="result__title"><a class="result__a" href="\${postUrl}">Stamatis Floratos at Eden Robotics</a></h2><div class="result__snippet">Eden Robotics founder update with 20 reactions</div></div></body></html>\`);
  }
  if (rawUrl.includes("7999999999999999993")) {
    return response("Title: Stamatis Floratos at Eden Robotics | LinkedIn\\nStamatis Floratos shares an Eden Robotics founder update. 20 reactions 2 comments");
  }
  if (rawUrl.includes("linkedin.com/in/stamatis-floratos-535b19244")) {
    return response("Title: Stamatis Floratos | LinkedIn\\nStamatis Floratos is co-founder and CEO of Eden. No native activity links are visible here.");
  }
  return response("Title: Unmatched LinkedIn profile\\nThis readable profile does not match the requested entity.");
};
`)
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--company=eden-robotics",
    "--platforms=linkedin",
    "--social=all",
    "--workers=1",
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
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ")
    },
    stdio: "pipe"
  });

  const normalized = JSON.parse(await readFile(output, "utf8"));
  const founderId = "founder-eden-robotics-stamatios-floratos-1956825";
  const nativeFounderPosts = normalized.evidence.filter(
    (row) => row.entityId === founderId && row.platformPostId
  );
  assert.deepEqual(nativeFounderPosts.map((row) => row.sourceUrl), [canonicalPostUrl]);
  assert.equal(nativeFounderPosts[0].authorHandle, "stamatis-floratos-535b19244");
  assert.ok(nativeFounderPosts[0].contributionScore > 0);
});

test("checkpoint flush canonicalizes native IDs, eligibility, and exact social authors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "returner-public-normalization-"));
  const output = join(directory, "public-evidence.json");
  const checkpoint = join(directory, "checkpoint.json");
  const discoveryAttempts = join(directory, "discovery-attempts.json");
  const sourceDiscoveryPaths = join(directory, "source-discovery-paths.json");
  const base = {
    entityType: "company",
    entityId: "company-9-mothers-corporation",
    companySlug: "9-mothers-corporation",
    companyName: "9 Mothers",
    title: "Fixture",
    text: "Fixture",
    rawVisibleText: "Fixture",
    postedAt: "2026-07-18T12:00:00.000Z",
    review_state: "verified",
    matchReason: "Verified public post candidate from search results.",
    first_seen_at: "2026-07-18T12:00:00.000Z",
    last_checked_at: "2026-07-18T12:00:00.000Z",
    last_updated_at: "2026-07-18T12:00:00.000Z"
  };
  const rows = [
    {
      ...base,
      id: "hn-destination-fixture",
      platform: "hacker_news",
      sourceUrl: "https://9mothers.com/launch",
      platformPostId: null,
      rawVisibleText: JSON.stringify({ objectID: "44770001", url: "https://9mothers.com/launch" }),
      metrics: { upvotes: 12, comments: 3 },
      contributionScore: 99
    },
    {
      ...base,
      id: "linkedin-slug-id-fixture",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/9-mothers_counter-drone-activity-7475266867537039360-QwfJ?utm_source=test",
      platformPostId: "9-mothers_counter-drone-activity-7475266867537039360-QwfJ",
      metrics: { reactions: 20, comments: 4 },
      contributionScore: 99
    },
    {
      ...base,
      id: "hn-unrecoverable-fixture",
      platform: "hacker_news",
      sourceUrl: "https://9mothers.com/no-native-id",
      platformPostId: null,
      rawVisibleText: JSON.stringify({ url: "https://9mothers.com/no-native-id" }),
      metrics: { upvotes: 8 },
      contributionScore: 99
    },
    {
      ...base,
      id: "mapped-founder-x-fixture",
      platform: "x",
      sourceUrl: "https://x.com/rhs/status/2070898557645660388",
      platformPostId: "2070898557645660388",
      metrics: { views: 7_100 },
      contributionScore: 99
    },
    {
      ...base,
      id: "third-party-instagram-fixture",
      platform: "instagram",
      sourceUrl: "https://instagram.com/p/DZvV_fMj2Mw",
      platformPostId: "DZvV_fMj2Mw",
      rawVisibleText: "Never miss a post from brycent [brycent](https://instagram.com/brycent/)",
      metrics: { likes: 2 },
      contributionScore: 99
    },
    {
      ...base,
      id: "empty-youtube-fixture",
      platform: "youtube",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      platformPostId: "abcdefghijk",
      metrics: {},
      contributionScore: 99
    },
    {
      ...base,
      id: "linkedin-hallucinated-comments-fixture",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/arctic-health_activity-7479951057700306944-test",
      platformPostId: "7479951057700306944",
      rawVisibleText: "The native post visibly shows 13 reactions. Like Comment Share",
      metrics: { comments: 47_000 },
      contributionScore: 100
    },
    {
      ...base,
      id: "founder-linkedin-author-match",
      entityType: "founder",
      entityId: "founder-9-mothers-corporation-russell-smith-1373",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/russellhowardsmith_counter-drone-activity-7475000000000000001-good",
      platformPostId: "7475000000000000001",
      metrics: { reactions: 18 },
      contributionScore: 99
    },
    {
      ...base,
      id: "founder-linkedin-author-mismatch",
      entityType: "founder",
      entityId: "founder-9-mothers-corporation-russell-smith-1373",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/someone-else_counter-drone-activity-7475000000000000002-bad",
      platformPostId: "7475000000000000002",
      metrics: { reactions: 18 },
      contributionScore: 99
    },
    {
      ...base,
      id: "ambiguous-linkedin-first",
      platform: "linkedin",
      sourceUrl: "https://www.linkedin.com/posts/example_activity-7475000000000000000-test",
      platformPostId: "7475000000000000000",
      metrics: { reactions: 10 },
      contributionScore: 99
    },
    {
      ...base,
      id: "ambiguous-linkedin-second",
      entityId: "company-dayjob",
      companySlug: "dayjob",
      companyName: "Dayjob",
      platform: "linkedin",
      sourceUrl: "https://linkedin.com/posts/example_activity-7475000000000000000-test",
      platformPostId: "7475000000000000000",
      metrics: { reactions: 10 },
      contributionScore: 99
    }
  ];

  await Promise.all([
    writeFile(output, `${JSON.stringify({ source: {}, evidence: rows, needsReview: [], failures: [] }, null, 2)}\n`),
    writeFile(checkpoint, `${JSON.stringify({ attempts: {}, evidence: [], needsReview: [], failures: [], discoveryAttempts: [], sourceDiscoveryPaths: [] }, null, 2)}\n`),
    writeFile(discoveryAttempts, "[]\n"),
    writeFile(sourceDiscoveryPaths, "[]\n")
  ]);

  execFileSync(process.execPath, [
    "scripts/fetch-public-traction.mjs",
    "--batch=S2026",
    "--max-companies=0",
    "--social=none",
    "--workers=1",
    "--delay-ms=0",
    `--output=${output}`,
    `--checkpoint=${checkpoint}`,
    `--discovery-attempts=${discoveryAttempts}`,
    `--source-discovery-paths=${sourceDiscoveryPaths}`
  ], { cwd: root, stdio: "pipe" });

  const normalized = JSON.parse(await readFile(output, "utf8"));
  const byId = new Map(normalized.evidence.map((row) => [row.id, row]));
  const hackerNews = byId.get("hn-destination-fixture");
  const linkedIn = byId.get("linkedin-slug-id-fixture");
  const mappedFounder = byId.get("mapped-founder-x-fixture");
  const thirdParty = byId.get("third-party-instagram-fixture");
  const emptyMetrics = byId.get("empty-youtube-fixture");
  const hallucinatedLinkedInComments = byId.get("linkedin-hallucinated-comments-fixture");
  const matchingFounderLinkedIn = byId.get("founder-linkedin-author-match");
  const mismatchingFounderLinkedIn = byId.get("founder-linkedin-author-mismatch");

  assert.equal(hackerNews.sourceUrl, "https://news.ycombinator.com/item?id=44770001");
  assert.equal(hackerNews.submittedUrl, "https://9mothers.com/launch");
  assert.equal(hackerNews.platformPostId, "44770001");
  assert.ok(hackerNews.contributionScore > 0);
  assert.equal(linkedIn.platformPostId, "7475266867537039360");
  assert.equal(linkedIn.sourceUrl.includes("utm_source"), false);
  assert.ok(linkedIn.contributionScore > 0);
  assert.equal(mappedFounder.authorHandle, "rhs");
  assert.ok(mappedFounder.contributionScore > 0);
  assert.equal(mappedFounder.review_state, "verified");
  assert.equal(thirdParty.authorHandle, "brycent");
  assert.equal(thirdParty.contributionScore, 0);
  assert.equal(thirdParty.review_state, "needs_review");
  assert.match(thirdParty.matchReason, /could not match the native post author/i);
  assert.equal(emptyMetrics.contributionScore, 0);
  assert.equal(emptyMetrics.review_state, "needs_review");
  assert.match(emptyMetrics.matchReason, /no positive supported visible traction metric/i);
  assert.deepEqual(hallucinatedLinkedInComments.metrics, {});
  assert.equal(hallucinatedLinkedInComments.contributionScore, 0);
  assert.equal(hallucinatedLinkedInComments.review_state, "needs_review");
  assert.match(hallucinatedLinkedInComments.matchReason, /no positive supported visible traction metric/i);
  assert.equal(matchingFounderLinkedIn.authorHandle, "russellhowardsmith");
  assert.ok(matchingFounderLinkedIn.contributionScore > 0);
  assert.equal(matchingFounderLinkedIn.review_state, "verified");
  assert.equal(mismatchingFounderLinkedIn.contributionScore, 0);
  assert.equal(mismatchingFounderLinkedIn.review_state, "needs_review");
  assert.match(mismatchingFounderLinkedIn.matchReason, /could not match the native post author/i);
  assert.equal(byId.has("hn-unrecoverable-fixture"), false);
  assert.equal(byId.has("ambiguous-linkedin-first"), false);
  assert.equal(byId.has("ambiguous-linkedin-second"), false);
  const unrecoverableReview = normalized.needsReview.find((row) => row.submittedUrl === "https://9mothers.com/no-native-id");
  assert.equal(unrecoverableReview.review_state, "needs_review");
  assert.match(unrecoverableReview.matchReason, /could not recover a native Hacker News item ID/i);
  const ambiguousReviews = normalized.needsReview.filter((row) => row.platformPostId === "7475000000000000000");
  assert.equal(ambiguousReviews.length, 2);
  assert.ok(ambiguousReviews.every((row) => /same native post attached to multiple companies/i.test(row.matchReason)));
});
