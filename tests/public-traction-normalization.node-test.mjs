import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

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
