import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  BoundedBodyError,
  HISTORICAL_BACKFILL_LIMITS,
  buildHistoricalTargets,
  canonicalHistoricalGuid,
  historicalHnSearchUrl,
  matchesHnCompanyStory,
  parseHistoricalDocument,
  parseRobotsTxt,
  readBoundedResponseText,
  robotsAllows,
  runHistoricalBackfill
} from "../scripts/lib/historical-backfill.mjs";
import {
  adaptHistoricalBackfillCoverage
} from "../scripts/lib/historical-coverage-adapter.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("historical backfill planning and Hacker News attribution", () => {
  it("derives every company/platform pair from every selected canonical catalog", () => {
    const plan = buildHistoricalTargets([
      fixtureCatalog("S2026", [
        fixtureCompany("company-acme", "Acme Labs", "https://acme.example"),
        fixtureCompany("company-no-site", "No Site", null)
      ]),
      fixtureCatalog("A16ZSR006", [
        fixtureCompany("company-orbit", "Orbit", "https://orbit.example")
      ])
    ]);

    assert.equal(plan.companiesEvaluated, 3);
    assert.equal(plan.missingOfficialWebsites, 1);
    assert.equal(plan.targetPlatformPairs, 9);
    assert.deepEqual(plan.platforms, ["hacker_news", "rss", "web"]);
    assert.deepEqual(
      plan.batches.map(({ slug, companies, targetPlatformPairs }) => ({ slug, companies, targetPlatformPairs })),
      [
        { slug: "S2026", companies: 2, targetPlatformPairs: 6 },
        { slug: "A16ZSR006", companies: 1, targetPlatformPairs: 3 }
      ]
    );
    assert.equal(
      plan.targets.filter((target) => target.entityId === "company-no-site").every((target) =>
        target.officialWebsite === null && target.officialDomain === null
      ),
      true
    );
  });

  it("uses search_by_date with exact name + official domain and never a batch marker", () => {
    const target = fixtureTarget();
    const requestUrl = new URL(historicalHnSearchUrl(target, 3));
    assert.equal(requestUrl.pathname, "/api/v1/search_by_date");
    assert.equal(requestUrl.searchParams.get("page"), "3");
    assert.equal(requestUrl.searchParams.get("tags"), "story");
    assert.match(requestUrl.searchParams.get("query"), /"Acme Labs"/);
    assert.match(requestUrl.searchParams.get("query"), /acme\.example/);
    assert.doesNotMatch(requestUrl.toString(), /batch|S2026|YC/i);

    assert.equal(matchesHnCompanyStory({
      title: "Acme Labs launches a database",
      url: "https://acme.example/blog/launch"
    }, target), true);
    assert.equal(matchesHnCompanyStory({
      title: "Acme Labs launches a database",
      url: "https://unrelated.example/post"
    }, target), false, "exact company name alone is insufficient");
    assert.equal(matchesHnCompanyStory({
      title: "Acme Laboratory launches a database",
      url: "https://acme.example/blog/launch"
    }, target), false, "official domain alone is insufficient");
    assert.equal(matchesHnCompanyStory({
      title: "NotAcme Labs launches a database",
      url: "https://acme.example/blog/launch"
    }, target), false, "company-name matching uses token boundaries");
  });
});

describe("bounded document decoding and canonical feed identity", () => {
  it("decodes gzipped sitemap bodies within both encoded and decoded limits", async () => {
    const xml = "<?xml version=\"1.0\"?><urlset><url><loc>https://acme.example/blog/one</loc></url></urlset>";
    const compressed = gzipSync(Buffer.from(xml));
    const response = new Response(compressed, {
      headers: { "content-type": "application/xml", "content-encoding": "gzip" }
    });
    assert.equal(await readBoundedResponseText(response, {
      maxResponseBytes: compressed.length + 10,
      maxDecodedBytes: Buffer.byteLength(xml) + 10
    }), xml);
  });

  it("cancels oversized response bodies instead of buffering without a bound", async () => {
    const response = new Response("x".repeat(128));
    await assert.rejects(
      readBoundedResponseText(response, { maxResponseBytes: 32, maxDecodedBytes: 64 }),
      (error) => error instanceof BoundedBodyError && error.phase === "encoded" && error.limit === 32
    );
  });

  it("canonicalizes tracking variants of feed GUID URLs and deduplicates them", () => {
    assert.equal(
      canonicalHistoricalGuid("https://acme.example/blog/one?utm_source=rss#top"),
      canonicalHistoricalGuid("https://acme.example/blog/one/")
    );
    const parsed = parseHistoricalDocument(`
      <rss><channel>
        <item>
          <guid>https://acme.example/blog/one?utm_source=rss#top</guid>
          <link>https://acme.example/blog/one</link>
          <title>First post</title>
          <pubDate>2026-01-01T00:00:00Z</pubDate>
        </item>
        <item>
          <guid>https://acme.example/blog/one/</guid>
          <link>https://acme.example/blog/one?ref=feed</link>
          <title>First post repeated</title>
          <pubDate>2026-01-01T00:00:00Z</pubDate>
        </item>
      </channel></rss>
    `, {
      url: "https://acme.example/feed.xml",
      contentType: "application/rss+xml",
      platform: "rss",
      target: {
        ...fixtureTarget(),
        targetKey: "S2026:company-acme:rss",
        platform: "rss"
      },
      seenItemKeys: [],
      maxItems: 100
    });
    assert.equal(parsed.itemsSeen, 2);
    assert.equal(parsed.evidence.length, 1);
    assert.equal(parsed.duplicates, 1);
    assert.equal(parsed.evidence[0].publishedAt, "2026-01-01T00:00:00.000Z");
  });

  it("keeps feed evidence exclusively in the RSS target when a web crawl reaches feed.xml", async () => {
    const outputDir = await temporaryDirectory("historical-feed-routing-");
    let tick = 0;
    const feed = `
      <rss><channel><item>
        <guid>https://opentrade.example/blog/one</guid>
        <link>https://opentrade.example/blog/one</link>
        <title>OpenTrade update</title>
        <pubDate>2026-01-01T00:00:00Z</pubDate>
      </item></channel></rss>
    `;
    const summary = await runHistoricalBackfill({
      outputDir,
      catalogs: [fixtureCatalog("S26", [
        fixtureCompany("company-opentrade", "OpenTrade", "https://opentrade.example/feed.xml")
      ])],
      platforms: ["rss", "web"],
      limits: {
        hostPaceMs: 0,
        requestAttempts: 1,
        siteMaxResponses: 3
      },
      now: () => new Date(Date.parse("2026-08-02T18:00:00.000Z") + tick++ * 1_000),
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/robots.txt") return textResponse("User-agent: *", "text/plain");
        if (url.pathname === "/feed.xml") return textResponse(feed, "application/rss+xml");
        return new Response("not found", { status: 404 });
      }
    });

    assert.equal(summary.status, "completed");
    assert.equal(summary.totals.accepted, 1, "the physical feed item is accepted exactly once");
    const events = await ndjson(path.join(outputDir, "pages.ndjson"));
    const webPages = events.filter((event) =>
      event.type === "page_checkpoint" && event.targetKey === "S26:company-opentrade:web"
    );
    const rssPages = events.filter((event) =>
      event.type === "page_checkpoint" && event.targetKey === "S26:company-opentrade:rss"
    );
    assert.equal(webPages.flatMap((event) => event.evidence).length, 0);
    assert.equal(webPages.find((event) => event.receipt.pageType === "feed")?.receipt.pageAccepted, 0);
    assert.equal(rssPages.flatMap((event) => event.evidence).length, 1);
    assert.equal(rssPages.flatMap((event) => event.evidence)[0].platform, "rss");

    const journal = await readFile(path.join(outputDir, "pages.ndjson"));
    const lastEvent = events.at(-1);
    const bridge = await adaptHistoricalBackfillCoverage({
      journal: [journal],
      artifact: {
        path: path.join(outputDir, "pages.ndjson"),
        sha256: createHash("sha256").update(journal).digest("hex"),
        observedAt: lastEvent.recordedAt
      },
      generatedAt: new Date(Date.parse(lastEvent.recordedAt) + 60_000).toISOString()
    });
    assert.equal(bridge.collectorArtifacts[0].snapshot.evidence.length, 1);
    assert.equal(bridge.collectorArtifacts[0].snapshot.evidence[0].platform, "rss");
    assert.equal(
      bridge.targetCoverage.find((row) => row.targetKey === "S26:company-opentrade:web").accepted,
      0
    );
  });
});

describe("robots, sitemap caps, receipts, and resumability", () => {
  it("honors wildcard robots rules with longest-match Allow overrides", () => {
    const robots = parseRobotsTxt(`
      User-agent: *
      Disallow: /private
      Allow: /private/public
      Sitemap: https://acme.example/sitemap.xml
    `);
    assert.deepEqual(robots.sitemapUrls, ["https://acme.example/sitemap.xml"]);
    assert.equal(robotsAllows("https://acme.example/private/secret", robots.rules), false);
    assert.equal(robotsAllows("https://acme.example/private/public/story", robots.rules), true);
    assert.equal(robotsAllows("https://acme.example/blog/story", robots.rules), true);
  });

  it("journals every page with complete receipt fields and stops at strict URL/response bounds", async () => {
    const outputDir = await temporaryDirectory("historical-web-");
    const calls = [];
    const mockFetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname === "/robots.txt") {
        return textResponse("User-agent: *\nDisallow: /blog/private\nSitemap: https://acme.example/sitemap.xml", "text/plain");
      }
      if (url.pathname === "/") {
        return textResponse(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body><a href="/blog/archive">Archive</a></body></html>`, "text/html");
      }
      if (url.pathname === "/sitemap.xml") {
        return textResponse(`
          <urlset>
            <url><loc>https://acme.example/blog/one</loc><lastmod>2025-01-01</lastmod></url>
            <url><loc>https://acme.example/blog/two</loc><lastmod>2025-02-01</lastmod></url>
            <url><loc>https://acme.example/blog/three</loc><lastmod>2025-03-01</lastmod></url>
            <url><loc>https://acme.example/blog/private/secret</loc><lastmod>2025-04-01</lastmod></url>
          </urlset>
        `, "application/xml");
      }
      return new Response("not found", { status: 404 });
    };
    const limits = {
      hostPaceMs: 0,
      requestAttempts: 1,
      siteMaxUrls: 12,
      siteMaxResponses: 3,
      siteMaxDepth: 2,
      siteMaxItems: 50
    };
    const summary = await runHistoricalBackfill({
      outputDir,
      catalogs: [fixtureCatalog("S2026", [fixtureCompany("company-acme", "Acme Labs", "https://acme.example")])],
      platforms: ["web"],
      limits,
      fetch: mockFetch
    });

    assert.equal(summary.status, "completed");
    assert.equal(summary.completedTargetPlatformPairs, 1);
    assert.equal(summary.totals.truncated, 1);
    assert.ok(summary.totals.requests <= 3, "response cap is a hard upper bound");
    assert.ok(calls.length <= 3);
    assert.equal(calls.some((url) => url.includes("/blog/private/secret")), false);

    const events = await ndjson(path.join(outputDir, "pages.ndjson"));
    const pageReceipts = events.filter((event) => event.type === "page_checkpoint").map((event) => event.receipt);
    assert.ok(pageReceipts.length > 0);
    const requiredFields = [
      "windowStart",
      "windowEnd",
      "pagesFetched",
      "requests",
      "itemsSeen",
      "accepted",
      "rejected",
      "duplicates",
      "earliest",
      "latest",
      "nextCursor",
      "sourceExhausted",
      "truncated",
      "sourceLimit",
      "credentialRequired",
      "blocker",
      "nextAction",
      "coverageExtent"
    ];
    for (const receipt of pageReceipts) {
      for (const field of requiredFields) assert.ok(field in receipt, `${field} missing from page receipt`);
    }
    const terminal = events.find((event) => event.type === "target_completed").receipt;
    for (const field of requiredFields) assert.ok(field in terminal, `${field} missing from target receipt`);
    assert.ok(["collected", "verified_no_history", "access_blocked", "manual_review"].includes(terminal.outcome));
    assert.deepEqual(terminal.sourceLimit, {
      maxDepth: 2,
      maxUrls: 12,
      maxResponses: 3,
      maxItems: 50,
      maxResponseBytes: HISTORICAL_BACKFILL_LIMITS.maxResponseBytes,
      maxDecodedBytes: HISTORICAL_BACKFILL_LIMITS.maxDecodedBytes
    });
  });

  it("resumes Hacker News from the journaled page cursor without refetching completed pages", async () => {
    const outputDir = await temporaryDirectory("historical-resume-");
    const targetCatalogs = [
      fixtureCatalog("S2026", [fixtureCompany("company-acme", "Acme Labs", "https://acme.example")])
    ];
    const firstPages = [];
    const firstFetch = async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      firstPages.push(page);
      return hnResponse(page, 2);
    };
    let interrupted = false;
    await assert.rejects(
      runHistoricalBackfill({
        outputDir,
        catalogs: targetCatalogs,
        platforms: ["hacker_news"],
        limits: { hostPaceMs: 0, requestAttempts: 1 },
        fetch: firstFetch,
        onPageCommitted() {
          if (!interrupted) {
            interrupted = true;
            throw new DOMException("fixture interruption", "AbortError");
          }
        }
      }),
      (error) => error?.name === "AbortError"
    );
    assert.deepEqual(firstPages, [0]);
    await appendFile(path.join(outputDir, "pages.ndjson"), '{"type":"page_checkpoint"');

    const resumedPages = [];
    const summary = await runHistoricalBackfill({
      outputDir,
      catalogs: targetCatalogs,
      platforms: ["hacker_news"],
      limits: { hostPaceMs: 0, requestAttempts: 1 },
      fetch: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        resumedPages.push(page);
        return hnResponse(page, 2);
      },
      resume: true
    });
    assert.deepEqual(resumedPages, [1]);
    assert.equal(summary.status, "completed");
    assert.equal(summary.totals.accepted, 2);
    const checkpoint = JSON.parse(await readFile(path.join(outputDir, "checkpoint-current.json"), "utf8"));
    assert.equal(checkpoint.recoveredTruncatedJournalTail, true);

    const events = await ndjson(path.join(outputDir, "pages.ndjson"));
    const pageEvents = events.filter((event) => event.type === "page_checkpoint");
    assert.deepEqual(pageEvents.map((event) => event.receipt.page), [0, 1]);
    assert.equal(new Set(pageEvents.map((event) => event.sequence)).size, 2);
  });

  it("reports actual HTTP retry attempts separately from fetched pages", async () => {
    const outputDir = await temporaryDirectory("historical-attempt-count-");
    let calls = 0;
    const summary = await runHistoricalBackfill({
      outputDir,
      catalogs: [
        fixtureCatalog("S2026", [fixtureCompany("company-acme", "Acme Labs", "https://acme.example")])
      ],
      platforms: ["hacker_news"],
      limits: { hostPaceMs: 0, requestAttempts: 2 },
      clock: { sleep: async () => {} },
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("retry", { status: 503 })
          : hnResponse(0, 1);
      }
    });
    assert.equal(calls, 2);
    assert.equal(summary.totals.pagesFetched, 1);
    assert.equal(summary.totals.requests, 2);
  });

  it("records exhausted network retries as an exact blocker without claiming a fetched page", async () => {
    const outputDir = await temporaryDirectory("historical-network-block-");
    let calls = 0;
    const summary = await runHistoricalBackfill({
      outputDir,
      catalogs: [
        fixtureCatalog("S2026", [fixtureCompany("company-acme", "Acme Labs", "https://acme.example")])
      ],
      platforms: ["hacker_news"],
      limits: { hostPaceMs: 0, requestAttempts: 2 },
      clock: { sleep: async () => {} },
      fetch: async () => {
        calls += 1;
        throw new TypeError("fixture socket closed");
      }
    });
    assert.equal(calls, 2);
    assert.equal(summary.totals.pagesAttempted, 1);
    assert.equal(summary.totals.pagesFetched, 0);
    assert.equal(summary.totals.requests, 2);
    assert.equal(summary.totals.accessBlocked, 1);
    const events = await ndjson(path.join(outputDir, "pages.ndjson"));
    const terminal = events.find((event) => event.type === "target_completed").receipt;
    assert.match(terminal.blocker, /^request_error:TypeError:fixture socket closed$/);
    assert.match(terminal.nextAction, /recorded checkpoint/i);
  });

  it("records missing websites as explicit manual-review outcomes without making requests", async () => {
    const outputDir = await temporaryDirectory("historical-missing-site-");
    let calls = 0;
    const summary = await runHistoricalBackfill({
      outputDir,
      catalogs: [fixtureCatalog("S2026", [fixtureCompany("company-no-site", "No Site", null)])],
      platforms: ["hacker_news", "rss", "web"],
      limits: { hostPaceMs: 0, requestAttempts: 1 },
      fetch: async () => {
        calls += 1;
        throw new Error("fetch must not run");
      }
    });
    assert.equal(calls, 0);
    assert.equal(summary.totals.targets, 3);
    assert.equal(summary.totals.manualReview, 3);
    assert.equal(summary.totals.requests, 0);
    const events = await ndjson(path.join(outputDir, "pages.ndjson"));
    for (const event of events.filter((row) => row.type === "target_completed")) {
      assert.equal(event.receipt.blocker, "official_website_missing_or_invalid");
      assert.match(event.receipt.nextAction, /canonical public company website/i);
    }
  });

  it("enforces eight requests globally and one request per host with mocked responses", async () => {
    const outputDir = await temporaryDirectory("historical-concurrency-");
    const companies = Array.from({ length: 10 }, (_, index) => fixtureCompany(
      `company-${index}`,
      `Company ${index}`,
      index < 2 ? "https://shared.example" : `https://host-${index}.example`
    ));
    let activeGlobal = 0;
    let maxGlobal = 0;
    const activeByHost = new Map();
    const maxByHost = new Map();
    const summary = await runHistoricalBackfill({
      outputDir,
      catalogs: [fixtureCatalog("S2026", companies)],
      platforms: ["web"],
      limits: {
        hostPaceMs: 0,
        requestAttempts: 1,
        siteMaxResponses: 1
      },
      fetch: async (input) => {
        const host = new URL(String(input)).hostname;
        activeGlobal += 1;
        activeByHost.set(host, (activeByHost.get(host) ?? 0) + 1);
        maxGlobal = Math.max(maxGlobal, activeGlobal);
        maxByHost.set(host, Math.max(maxByHost.get(host) ?? 0, activeByHost.get(host)));
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeGlobal -= 1;
        activeByHost.set(host, activeByHost.get(host) - 1);
        return new Response("not found", { status: 404 });
      }
    });
    assert.equal(summary.completedTargetPlatformPairs, 10);
    assert.ok(maxGlobal <= 8, `observed ${maxGlobal} simultaneous requests`);
    assert.equal(maxByHost.get("shared.example"), 1);
    assert.ok([...maxByHost.values()].every((value) => value <= 1));
  });
});

function fixtureCatalog(slug, companies) {
  return { slug, companies };
}

function fixtureCompany(sourceKey, name, websiteUrl) {
  return { sourceKey, name, websiteUrl, founders: [], accounts: [] };
}

function fixtureTarget() {
  return {
    targetKey: "S2026:company-acme:hacker_news",
    batchSlug: "S2026",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme Labs",
    companyName: "Acme Labs",
    companySlug: "acme",
    officialWebsite: "https://acme.example/",
    officialDomain: "acme.example",
    platform: "hacker_news"
  };
}

function hnResponse(page, nbPages) {
  return textResponse(JSON.stringify({
    page,
    nbPages,
    hits: [{
      objectID: `story-${page}`,
      title: `Acme Labs historical post ${page}`,
      url: `https://acme.example/blog/post-${page}`,
      created_at: `2026-01-0${page + 1}T00:00:00.000Z`,
      author: "fixture"
    }]
  }), "application/json");
}

function textResponse(body, contentType) {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function ndjson(file) {
  return (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
