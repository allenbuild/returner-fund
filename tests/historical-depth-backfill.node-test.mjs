import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HistoricalDepthBodyLimitError,
  buildHistoricalDepthPlan,
  readBoundedText,
  runHistoricalDepthBackfill
} from "../scripts/lib/historical-depth-backfill.mjs";
import {
  buildHistoricalDepthTargets,
  canonicalHistoricalDepthAccountUrl
} from "../scripts/lib/historical-depth-targets.mjs";
import {
  HistoricalDepthPayloadError,
  canonicalExactTimestamp,
  parseProductHuntPage,
  parseRedditListing,
  parseYouTubeFeed,
  parseYouTubePlaylistPage,
  parseYouTubePublicPage,
  productHuntGraphqlRequest,
  redditListingRequest
} from "../scripts/lib/historical-depth-sources.mjs";

describe("historical depth target planning", () => {
  it("evaluates every owner/platform pair but targets only unique verified mappings", async () => {
    const catalogs = fixtureCatalogs({
      companyAccounts: [
        verified("youtube", "https://www.youtube.com/@Acme"),
        verified("youtube", "https://youtube.com/@Acme/"),
        verified("product_hunt", "https://www.producthunt.com/posts/not-an-account"),
        { ...verified("reddit", "https://www.reddit.com/r/acme"), verified: false, reviewState: "needs_review" }
      ],
      founderAccounts: [verified("reddit", "https://old.reddit.com/u/founder")]
    });
    const targetPlan = buildHistoricalDepthTargets(catalogs);
    assert.equal(targetPlan.companiesEvaluated, 1);
    assert.equal(targetPlan.foundersEvaluated, 1);
    assert.equal(targetPlan.ownerPlatformPairsEvaluated, 6);
    assert.equal(targetPlan.verifiedMappingsFound, 4);
    assert.equal(targetPlan.verifiedAccountsMapped, 2);
    assert.equal(targetPlan.invalidVerifiedMappings, 1);
    assert.equal(targetPlan.unverifiedMappingsSkipped, 1);
    assert.equal(targetPlan.targetAccountPairs, 3);
    assert.equal(targetPlan.unmappedOwnerPlatformPairs, 3);
    assert.deepEqual(targetPlan.targets.map((target) => [target.entityType, target.platform, target.accountUrl]), [
      ["company", "youtube", "https://www.youtube.com/@Acme"],
      ["company", "product_hunt", null],
      ["founder", "reddit", "https://www.reddit.com/user/founder"]
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));

    const plan = await buildHistoricalDepthPlan(process.cwd(), { catalogs });
    assert.equal(plan.estimatedWorstCaseLogicalRequestsByPlatform.youtube, 11);
    assert.equal(plan.estimatedWorstCaseLogicalRequestsByPlatform.product_hunt, 0);
    assert.equal(plan.estimatedWorstCaseLogicalRequestsByPlatform.reddit, 10);
    assert.equal(plan.estimatedWorstCaseLogicalRequests, 21);
    assert.equal(plan.estimatedWorstCaseHttpAttempts, 42);
    assert.deepEqual(plan.credentials, {
      youtubeApiKey: false,
      productHuntToken: false,
      redditAccessToken: false
    });
    await assert.rejects(
      buildHistoricalDepthPlan(process.cwd(), { catalogs, limits: { globalConcurrency: 5 } }),
      /cannot exceed the safe maximum of 4/
    );
    await assert.rejects(
      buildHistoricalDepthPlan(process.cwd(), { catalogs, limits: { hostConcurrency: 2 } }),
      /hostConcurrency is fixed at 1/
    );
  });

  it("accepts only native account profile URL shapes", () => {
    assert.equal(
      canonicalHistoricalDepthAccountUrl("youtube", "https://youtube.com/channel/UCAbC123"),
      "https://www.youtube.com/channel/UCAbC123"
    );
    assert.equal(
      canonicalHistoricalDepthAccountUrl("product_hunt", "https://producthunt.com/products/acme"),
      "https://www.producthunt.com/products/acme"
    );
    assert.equal(
      canonicalHistoricalDepthAccountUrl("reddit", "https://old.reddit.com/r/Acme/"),
      "https://www.reddit.com/r/Acme"
    );
    assert.equal(canonicalHistoricalDepthAccountUrl("youtube", "https://youtube.com/watch?v=x"), null);
    assert.equal(canonicalHistoricalDepthAccountUrl("product_hunt", "https://producthunt.com/posts/acme"), null);
    assert.equal(canonicalHistoricalDepthAccountUrl("reddit", "https://reddit.com/comments/abc"), null);
  });
});

describe("historical depth source parsers", () => {
  const youtubeTarget = sourceTarget("youtube", "https://www.youtube.com/channel/UCAbC123");

  it("accepts exact YouTube feed timestamps and deduplicates native IDs", () => {
    const seen = new Set(["youtube:duplicate"]);
    const parsed = parseYouTubeFeed(youtubeFeedFixture(), {
      target: youtubeTarget,
      seen,
      discoveredAt: new Date("2026-08-02T20:00:00.000Z")
    });
    assert.equal(parsed.itemsSeen, 3);
    assert.equal(parsed.accepted, 1);
    assert.equal(parsed.duplicates, 1);
    assert.equal(parsed.rejected, 1);
    assert.equal(parsed.evidence[0].nativeId, "freshVideo");
    assert.equal(parsed.evidence[0].publishedAt, "2026-07-20T10:11:12.000Z");
    assert.equal(parsed.evidence[0].attribution.nativeChannelId, "UCAbC123");
    assert.deepEqual(parsed.evidence[0].metrics, { views: 123 });
    assert.equal(canonicalExactTimestamp("2026-07-20"), null, "date-only values are not exact timestamps");
  });

  it("keeps relative-date YouTube public continuations as discovery-only rejections", () => {
    const parsed = parseYouTubePublicPage(JSON.stringify({
      metadata: { channelId: "UCAbC123" },
      INNERTUBE_API_KEY: "public-key",
      INNERTUBE_CLIENT_VERSION: "2.20260801.00.00",
      videoRenderer: { videoId: "relativeVideo", publishedTimeText: { simpleText: "2 days ago" } },
      continuationCommand: { token: "NEXT" }
    }));
    assert.equal(parsed.channelId, "UCAbC123");
    assert.equal(parsed.continuationToken, "NEXT");
    assert.equal(parsed.itemsSeen, 1);
    assert.equal(parsed.rejectedMissingExactTimestamp, 1);
    assert.deepEqual(parsed.evidence, []);
  });

  it("parses exact YouTube uploads-playlist history and preserves case-sensitive IDs", () => {
    const parsed = parseYouTubePlaylistPage({
      items: [
        youtubeApiItem("VideoAbC", "2020-01-02T03:04:05Z"),
        youtubeApiItem("videoabc", "2019-01-02T03:04:05Z"),
        youtubeApiItem("wrongOwner", "2018-01-02T03:04:05Z", "UCOther")
      ],
      nextPageToken: "NEXT",
      pageInfo: { totalResults: 100 }
    }, {
      target: youtubeTarget,
      expectedChannelId: "UCAbC123",
      seen: new Set(),
      discoveredAt: new Date("2026-08-02T20:00:00.000Z")
    });
    assert.deepEqual(parsed.evidence.map((row) => row.nativeId), ["VideoAbC", "videoabc"]);
    assert.equal(parsed.rejected, 1);
    assert.equal(parsed.nextCursor, "NEXT");
    assert.equal(parsed.sourceExhausted, false);
  });

  it("paginates Product Hunt by exact official URL and rejects malformed timestamps", () => {
    const target = sourceTarget("product_hunt", "https://www.producthunt.com/products/acme");
    const request = productHuntGraphqlRequest(target, { token: "secret", pageSize: 20 });
    assert.equal(request.url, "https://api.producthunt.com/v2/api/graphql");
    assert.equal(request.init.headers.authorization, "Bearer secret");
    const variables = JSON.parse(request.init.body).variables;
    assert.equal(variables.url, "https://acme.example/");
    assert.equal(variables.postedAfter, "1970-01-01T00:00:00.000Z");

    const parsed = parseProductHuntPage({
      data: {
        posts: {
          totalCount: 2,
          nodes: [
            productHuntPost("1", "acme-one", "2025-01-01T01:02:03Z"),
            productHuntPost("2", "acme-two", "not-a-time")
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    }, { target, seen: new Set(), discoveredAt: new Date("2026-08-02T20:00:00Z") });
    assert.equal(parsed.accepted, 1);
    assert.equal(parsed.rejected, 1);
    assert.equal(parsed.sourceExhausted, true);
    assert.equal(parsed.evidence[0].externalId, "product_hunt:1");
    assert.equal(parsed.evidence[0].attribution.officialDomain, "acme.example");
  });

  it("enforces exact Reddit owner attribution and exposes listing cutoff semantics", () => {
    const target = sourceTarget("reddit", "https://www.reddit.com/user/acmefounder");
    const request = redditListingRequest(target, { after: "t3_after", count: 100, pageSize: 100 });
    assert.match(request.url, /\/user\/acmefounder\/submitted\.json/);
    assert.match(request.url, /after=t3_after/);
    const parsed = parseRedditListing({
      data: {
        after: null,
        children: [
          redditPost("t3_good", "acmefounder", "acme", 1_700_000_000),
          redditPost("t3_wrong", "someone_else", "acme", 1_700_000_001),
          { kind: "t1", data: { id: "comment", created_utc: 1_700_000_002 } }
        ]
      }
    }, { target, identity: request.identity, seen: new Set(), discoveredAt: new Date("2026-08-02T20:00:00Z") });
    assert.equal(parsed.accepted, 1);
    assert.equal(parsed.rejected, 2);
    assert.equal(parsed.sourceExhausted, true);
    assert.equal(parsed.endpointCutoff, "reddit_listing_window_maximum_1000_items");
    assert.equal(parsed.evidence[0].publishedAt, "2023-11-14T22:13:20.000Z");
  });

  it("bounds response bodies before retaining unbounded input", async () => {
    await assert.rejects(
      readBoundedText(new Response("0123456789"), 5),
      (error) => error instanceof HistoricalDepthBodyLimitError && error.limit === 5
    );
  });

  it("rejects GraphQL errors instead of converting access failure to empty history", () => {
    const target = sourceTarget("product_hunt", "https://www.producthunt.com/products/acme");
    assert.throws(
      () => parseProductHuntPage({ errors: [{ message: "invalid token" }] }, { target }),
      (error) => error instanceof HistoricalDepthPayloadError && error.code === "product_hunt_graphql_error"
    );
  });
});

describe("historical depth resumable runner", () => {
  it("queues Product Hunt credentials without network work or false no-history claims", async () => {
    await withTempDirectory(async (outputDir) => {
      let calls = 0;
      const summary = await runHistoricalDepthBackfill({
        outputDir,
        catalogs: fixtureCatalogs({ companyAccounts: [verified("product_hunt", "https://producthunt.com/products/acme")] }),
        platforms: ["product_hunt"],
        fetch: async () => {
          calls += 1;
          throw new Error("network must not run without the required token");
        },
        limits: testLimits()
      });
      assert.equal(calls, 0);
      assert.equal(summary.totals.manualReview, 1);
      assert.equal(summary.totals.credentialRequired, 1);
      assert.equal(summary.totals.verifiedNoHistory, 0);
      const journal = await journalEvents(outputDir);
      const terminal = journal.find((event) => event.type === "target_completed").receipt;
      assert.equal(terminal.requiredCredential, "PRODUCT_HUNT_TOKEN");
      assert.equal(terminal.sourceExhausted, false);
      assert.match(terminal.blocker, /^credentials_required:PRODUCT_HUNT_TOKEN/);
    });
  });

  it("stores recent YouTube feed evidence while queuing full exact-timestamp history", async () => {
    await withTempDirectory(async (outputDir) => {
      const calls = [];
      const summary = await runHistoricalDepthBackfill({
        outputDir,
        catalogs: fixtureCatalogs({ companyAccounts: [verified("youtube", "https://youtube.com/@Acme")] }),
        platforms: ["youtube"],
        fetch: async (url) => {
          calls.push(String(url));
          if (String(url).includes("youtube.com/@Acme/videos")) {
            return new Response(
              '<meta itemprop="channelId" content="UCAbC123"><script>{"videoId":"relativeVideo"}</script>',
              { status: 200, headers: { "content-type": "text/html" } }
            );
          }
          if (String(url).includes("feeds/videos.xml")) {
            return new Response(youtubeFeedFixture(), {
              status: 200,
              headers: { "content-type": "application/atom+xml" }
            });
          }
          throw new Error(`unexpected URL ${url}`);
        },
        limits: testLimits({ youtubePublicMaxPages: 2 })
      });
      assert.equal(calls.length, 2);
      assert.equal(summary.totals.manualReview, 1);
      assert.equal(summary.totals.credentialRequired, 1);
      assert.equal(summary.totals.partialEvidenceTargets, 1);
      assert.equal(summary.totals.accepted, 2, "feed fixture has two exact unique timestamps when no prior seen set exists");
      const events = await journalEvents(outputDir);
      const evidence = events.flatMap((event) => event.evidence ?? []);
      assert.deepEqual(evidence.map((row) => row.nativeId).sort(), ["duplicate", "freshVideo"]);
      const terminal = events.find((event) => event.type === "target_completed").receipt;
      assert.equal(terminal.sourceExhausted, false);
      assert.equal(terminal.coverageExtent, "recent_atom_feed_collected_full_history_queued");
      assert.equal(terminal.requiredCredential, "YOUTUBE_API_KEY");
    });
  });

  it("exhausts paginated Product Hunt API history with exact dedupe and redacted credentials", async () => {
    await withTempDirectory(async (outputDir) => {
      let calls = 0;
      const token = "ph-secret-token";
      const summary = await runHistoricalDepthBackfill({
        outputDir,
        catalogs: fixtureCatalogs({ companyAccounts: [verified("product_hunt", "https://producthunt.com/products/acme")] }),
        platforms: ["product_hunt"],
        credentials: { productHuntToken: token },
        fetch: async (_url, init) => {
          calls += 1;
          assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
          const after = JSON.parse(init.body).variables.after;
          return jsonResponse(after == null
            ? productHuntConnection([
                productHuntPost("1", "acme-one", "2025-01-01T00:00:00Z")
              ], true, "NEXT", 2)
            : productHuntConnection([
                productHuntPost("1", "acme-one", "2025-01-01T00:00:00Z"),
                productHuntPost("2", "acme-two", "2024-01-01T00:00:00Z")
              ], false, null, 2));
        },
        limits: testLimits({ productHuntMaxPages: 3 })
      });
      assert.equal(calls, 2);
      assert.equal(summary.totals.collected, 1);
      assert.equal(summary.totals.sourceExhausted, 1);
      assert.equal(summary.totals.accepted, 2);
      assert.equal(summary.totals.duplicates, 1);
      const journalText = await readFile(join(outputDir, "pages.ndjson"), "utf8");
      assert.equal(journalText.includes(token), false, "credentials must never enter resumable artifacts");
    });
  });

  it("does not treat an empty exact-URL Product Hunt query as proof that verified account history is absent", async () => {
    await withTempDirectory(async (outputDir) => {
      const summary = await runHistoricalDepthBackfill({
        outputDir,
        catalogs: fixtureCatalogs({ companyAccounts: [verified("product_hunt", "https://producthunt.com/products/acme")] }),
        platforms: ["product_hunt"],
        credentials: { productHuntToken: "token" },
        fetch: async () => jsonResponse(productHuntConnection([], false, null, 0)),
        limits: testLimits()
      });
      assert.equal(summary.totals.manualReview, 1);
      assert.equal(summary.totals.verifiedNoHistory, 0);
      assert.equal(summary.totals.sourceExhausted, 1, "the exact query was exhausted, not the account's possible aliases");
      const terminal = (await journalEvents(outputDir)).find((event) => event.type === "target_completed").receipt;
      assert.equal(terminal.blocker, "verified_product_hunt_mapping_but_exact_official_url_query_empty");
      assert.match(terminal.nextAction, /URL aliases and launch slugs/);
    });
  });

  it("records Reddit access walls as blockers, never as no-history", async () => {
    await withTempDirectory(async (outputDir) => {
      const summary = await runHistoricalDepthBackfill({
        outputDir,
        catalogs: fixtureCatalogs({ companyAccounts: [verified("reddit", "https://reddit.com/r/acme")] }),
        platforms: ["reddit"],
        fetch: async () => new Response("Access denied", { status: 403 }),
        limits: testLimits({ requestAttempts: 1 })
      });
      assert.equal(summary.totals.accessBlocked, 1);
      assert.equal(summary.totals.verifiedNoHistory, 0);
      assert.equal(summary.totals.sourceExhausted, 0);
      const terminal = (await journalEvents(outputDir)).find((event) => event.type === "target_completed").receipt;
      assert.match(terminal.blocker, /^http_403:reddit:/);
      assert.equal(terminal.sourceExhausted, false);
    });
  });

  it("resumes YouTube uploads from the committed cursor without replay or duplicate evidence", async () => {
    await withTempDirectory(async (outputDir) => {
      const catalogs = fixtureCatalogs({
        companyAccounts: [verified("youtube", "https://youtube.com/channel/UCAbC123")]
      });
      const credentials = { youtubeApiKey: "yt-secret-key" };
      let interrupted = false;
      await assert.rejects(
        runHistoricalDepthBackfill({
          outputDir,
          catalogs,
          platforms: ["youtube"],
          credentials,
          fetch: firstYouTubeApiRunFetch,
          limits: testLimits({ youtubeApiMaxPages: 3 }),
          onPageCommitted({ receipt }) {
            if (!interrupted && receipt.pageType === "youtube_uploads_playlist_page") {
              interrupted = true;
              throw new DOMException("test interruption", "AbortError");
            }
          }
        }),
        (error) => error?.name === "AbortError"
      );

      const resumeCalls = [];
      const summary = await runHistoricalDepthBackfill({
        outputDir,
        catalogs,
        platforms: ["youtube"],
        credentials,
        resume: true,
        fetch: async (url) => {
          resumeCalls.push(String(url));
          assert.match(String(url), /playlistItems/);
          assert.match(String(url), /pageToken=PAGE2/);
          return jsonResponse({
            items: [youtubeApiItem("oldestVideo", "2018-01-01T00:00:00Z")],
            pageInfo: { totalResults: 3 }
          });
        },
        limits: testLimits({ youtubeApiMaxPages: 3 })
      });
      assert.equal(resumeCalls.length, 1, "resume must start at the durable page cursor");
      assert.equal(summary.totals.collected, 1);
      assert.equal(summary.totals.sourceExhausted, 1);
      assert.equal(summary.totals.accepted, 4);
      assert.equal(summary.totals.duplicates, 1);
      const journalText = await readFile(join(outputDir, "pages.ndjson"), "utf8");
      assert.equal(journalText.includes(credentials.youtubeApiKey), false);
      const events = journalText.trim().split("\n").map(JSON.parse);
      const ids = events.flatMap((event) => event.evidence ?? []).map((row) => row.nativeId);
      assert.deepEqual(ids, ["freshVideo", "duplicate", "historicalVideo", "oldestVideo"]);
      assert.equal(new Set(ids).size, ids.length);
    });
  });
});

function fixtureCatalogs({ companyAccounts = [], founderAccounts = [] } = {}) {
  return [{
    slug: "TEST",
    companies: [{
      entityType: "company",
      sourceKey: "company-acme",
      name: "Acme",
      websiteUrl: "https://acme.example/",
      accounts: companyAccounts,
      founders: [{
        entityType: "founder",
        sourceKey: "founder-acme-one",
        name: "One Founder",
        companySourceKey: "company-acme",
        accounts: founderAccounts
      }]
    }]
  }];
}

function verified(platform, url) {
  return {
    sourceKey: `account:${platform}:${url}`,
    platform,
    url,
    verified: true,
    reviewState: "verified",
    matchReason: "fixture verified mapping"
  };
}

function sourceTarget(platform, accountUrl) {
  return {
    targetKey: `TEST:company:company-acme:${platform}`,
    batchSlug: "TEST",
    entityType: "company",
    entityId: "company-acme",
    entityName: "Acme",
    companyId: "company-acme",
    companyName: "Acme",
    officialWebsite: "https://acme.example/",
    officialDomain: "acme.example",
    platform,
    accountUrl,
    accountSourceKey: `account:${platform}`
  };
}

function youtubeFeedFixture() {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <yt:channelId>AbC123</yt:channelId>
      <entry>
        <yt:videoId>freshVideo</yt:videoId><title>Fresh</title>
        <published>2026-07-20T10:11:12Z</published><author><name>Acme</name></author>
        <media:group><media:description>Fresh description</media:description><media:statistics views="123" /></media:group>
      </entry>
      <entry>
        <yt:videoId>duplicate</yt:videoId><title>Duplicate</title>
        <published>2026-07-19T10:11:12Z</published><author><name>Acme</name></author>
      </entry>
      <entry><yt:videoId>missingTime</yt:videoId><title>Missing timestamp</title></entry>
    </feed>`;
}

function youtubeApiItem(videoId, publishedAt, ownerId = "UCAbC123") {
  return {
    contentDetails: { videoId, videoPublishedAt: publishedAt },
    snippet: {
      title: videoId,
      description: `${videoId} description`,
      videoOwnerChannelId: ownerId,
      videoOwnerChannelTitle: "Acme"
    }
  };
}

function productHuntPost(id, slug, createdAt) {
  return {
    id,
    slug,
    name: slug,
    tagline: `${slug} tagline`,
    description: `${slug} description`,
    url: `https://www.producthunt.com/posts/${slug}`,
    website: "https://acme.example/",
    createdAt,
    votesCount: 10,
    commentsCount: 2,
    makers: [{ id: "maker-1", username: "maker", name: "Maker", url: "https://producthunt.com/@maker" }]
  };
}

function productHuntConnection(nodes, hasNextPage, endCursor, totalCount) {
  return { data: { posts: { nodes, totalCount, pageInfo: { hasNextPage, endCursor } } } };
}

function redditPost(name, author, subreddit, createdUtc) {
  return {
    kind: "t3",
    data: {
      name,
      id: name.replace(/^t3_/, ""),
      author,
      subreddit,
      created_utc: createdUtc,
      permalink: `/r/${subreddit}/comments/${name.replace(/^t3_/, "")}/fixture/`,
      title: name,
      selftext: `${name} text`,
      score: 5,
      num_comments: 2
    }
  };
}

function testLimits(overrides = {}) {
  return {
    globalConcurrency: 2,
    hostConcurrency: 1,
    hostPaceMs: 0,
    redditPaceMs: 0,
    requestTimeoutMs: 1_000,
    requestAttempts: 1,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 100,
    maxResponseBytes: 1_000_000,
    maxLineBytes: 1_000_000,
    youtubePublicMaxPages: 2,
    youtubeApiPageSize: 50,
    youtubeApiMaxPages: 2,
    productHuntPageSize: 20,
    productHuntMaxPages: 2,
    redditPageSize: 100,
    redditMaxPages: 2,
    maxItemsPerTarget: 500,
    ...overrides
  };
}

async function firstYouTubeApiRunFetch(url) {
  const value = String(url);
  if (value.includes("youtube.com/channel/UCAbC123/videos")) {
    return new Response('<meta itemprop="channelId" content="UCAbC123">', { status: 200 });
  }
  if (value.includes("feeds/videos.xml")) {
    return new Response(youtubeFeedFixture(), { status: 200 });
  }
  if (value.includes("youtube/v3/channels")) {
    return jsonResponse({
      items: [{
        id: "UCAbC123",
        snippet: { title: "Acme" },
        contentDetails: { relatedPlaylists: { uploads: "UUAbC123" } }
      }]
    });
  }
  if (value.includes("playlistItems")) {
    return jsonResponse({
      items: [
        youtubeApiItem("freshVideo", "2026-07-20T10:11:12Z"),
        youtubeApiItem("historicalVideo", "2020-01-01T00:00:00Z")
      ],
      nextPageToken: "PAGE2",
      pageInfo: { totalResults: 3 }
    });
  }
  throw new Error(`unexpected URL ${url}`);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function journalEvents(outputDir) {
  const text = await readFile(join(outputDir, "pages.ndjson"), "utf8");
  return text.trim().split("\n").map(JSON.parse);
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "historical-depth-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
