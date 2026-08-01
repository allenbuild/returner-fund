import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeOwnedXTweetObservations,
  mergeOwnedXTweets,
  prioritizeXTargets,
  xCircuitStateTransition,
  xCollectionAttemptState,
  xFailureKind,
  xTimelinePageState,
  xTweetBelongsToHandle,
  xTweetId,
  xTweetIngestionDecision,
  xTweetPublicationDate
} from "../scripts/lib/logged-in-x-collection.mjs";

describe("logged-in X collection", () => {
  it("fails closed when the adapter author or native status author differs from the requested account", () => {
    assert.equal(
      xTweetBelongsToHandle(
        {
          author: "founder",
          url: "https://x.com/founder/status/123"
        },
        "Founder"
      ),
      true
    );
    assert.equal(
      xTweetBelongsToHandle(
        {
          author: "third_party",
          url: "https://x.com/founder/status/123"
        },
        "founder"
      ),
      false
    );
    assert.equal(
      xTweetBelongsToHandle(
        {
          author: "founder",
          url: "https://x.com/third_party/status/123"
        },
        "founder"
      ),
      false
    );
  });

  it("merges browser and adapter observations by native status ID without losing richer metrics", () => {
    const merged = mergeOwnedXTweets(
      [
        [
          {
            id: "123",
            author: "Founder",
            text: "Short browser text",
            likes: 5,
            retweets: 1,
            replies: 2,
            views: 100,
            created_at: "2h",
            url: "https://x.com/Founder/status/123",
            media_urls: ["https://pbs.twimg.com/browser.jpg"]
          }
        ],
        [
          {
            id: "123",
            author: "founder",
            text: "Longer exact adapter text for the same native post.",
            likes: 7,
            retweets: 1,
            replies: 1,
            views: 150,
            created_at: "Wed Jul 29 03:27:14 +0000 2026",
            url: "https://x.com/founder/status/123",
            media_urls: ["https://pbs.twimg.com/adapter.jpg"]
          }
        ]
      ],
      { handle: "founder", limit: 10 }
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "123");
    assert.equal(merged[0].url, "https://x.com/founder/status/123");
    assert.equal(merged[0].text, "Longer exact adapter text for the same native post.");
    assert.equal(merged[0].likes, 7);
    assert.equal(merged[0].replies, 2);
    assert.equal(merged[0].views, 150);
    assert.equal(merged[0].created_at, "Wed Jul 29 03:27:14 +0000 2026");
    assert.deepEqual(merged[0].media_urls, [
      "https://pbs.twimg.com/browser.jpg",
      "https://pbs.twimg.com/adapter.jpg"
    ]);
  });

  it("drops retweets by default, accepts URL-derived IDs, and sorts newest native IDs first", () => {
    const merged = mergeOwnedXTweets(
      [[
        {
          author: "founder",
          text: "Older",
          url: "https://x.com/founder/status/123",
          is_retweet: false,
          created_at: "2026-07-27T12:00:00.000Z",
          views: 10
        },
        {
          author: "founder",
          text: "Newest",
          url: "https://x.com/founder/status/125",
          is_retweet: false,
          created_at: "2026-07-29T12:00:00.000Z",
          views: 20
        },
        {
          author: "founder",
          text: "Retweet",
          url: "https://x.com/founder/status/124",
          is_retweet: true,
          created_at: "2026-07-28T12:00:00.000Z",
          views: 30
        }
      ]],
      { handle: "founder", limit: 2 }
    );

    assert.deepEqual(merged.map((tweet) => tweet.id), ["125", "123"]);
    assert.equal(xTweetId({ url: "https://x.com/founder/status/123?s=20" }), "123");
  });

  it("rejects metricless, stale, invalid-date, and RT wrappers even when browser metadata says false", () => {
    const tweetGroups = [[
        {
          id: "200",
          author: "founder",
          text: "Visible native traction",
          url: "https://x.com/founder/status/200",
          created_at: "2026-07-29T12:00:00.000Z",
          views: 25
        },
        {
          id: "201",
          author: "founder",
          text: "No visible traction",
          url: "https://x.com/founder/status/201",
          created_at: "2026-07-29T12:00:00.000Z",
          likes: 0,
          retweets: 0,
          replies: 0,
          views: 0
        },
        {
          id: "202",
          author: "founder",
          text: "Too old",
          url: "https://x.com/founder/status/202",
          created_at: "2024-12-31T23:59:59.999Z",
          likes: 5
        },
        {
          id: "203",
          author: "founder",
          text: "Unknown date",
          url: "https://x.com/founder/status/203",
          created_at: "not-a-date",
          likes: 5
        },
        {
          id: "204",
          author: "founder",
          text: "RT @thirdparty copied wrapper",
          rawText: "RT @thirdparty copied wrapper",
          url: "https://x.com/founder/status/204",
          created_at: "2026-07-29T12:00:00.000Z",
          views: 50,
          is_retweet: false
        }
      ]];
    const merged = mergeOwnedXTweets(
      tweetGroups,
      { handle: "founder", limit: 10 }
    );

    assert.deepEqual(merged.map((tweet) => tweet.id), ["200"]);
    const decisions = new Map(
      mergeOwnedXTweetObservations(tweetGroups, { handle: "founder" }).map(
        (tweet) => [
          tweet.id,
          xTweetIngestionDecision(tweet, { handle: "founder" }).reason
        ]
      )
    );
    assert.equal(decisions.get("200"), "verified_recent_native_post");
    assert.equal(decisions.get("201"), "no_positive_visible_metric");
    assert.equal(decisions.get("202"), "publication_before_cutoff");
    assert.equal(decisions.get("203"), "invalid_publication_date");
    assert.equal(decisions.get("204"), "retweet_wrapper");
  });

  it("accepts a valid relative browser date only when visible traction is positive", () => {
    const merged = mergeOwnedXTweets(
      [[
        {
          id: "300",
          author: "founder",
          text: "Recent browser observation",
          url: "https://x.com/founder/status/300",
          created_at: "2h",
          replies: 1
        }
      ]],
      { handle: "founder", limit: 10 }
    );

    assert.deepEqual(merged.map((tweet) => tweet.id), ["300"]);
  });

  it("never promotes relative X labels to exact native publication timestamps", () => {
    assert.deepEqual(
      xTweetPublicationDate("2h", Date.parse("2026-08-01T06:30:00.000Z")),
      { postedAt: null, publishedAtPrecision: "unknown" }
    );
    assert.deepEqual(
      xTweetPublicationDate("1 day ago", Date.parse("2026-08-01T06:30:00.000Z")),
      { postedAt: null, publishedAtPrecision: "unknown" }
    );
  });

  it("preserves native day and exact X date precision without inventing a timezone", () => {
    assert.deepEqual(
      xTweetPublicationDate("Jul 31", Date.parse("2026-08-01T06:30:00.000Z")),
      { postedAt: "2026-07-31", publishedAtPrecision: "day" }
    );
    assert.deepEqual(
      xTweetPublicationDate("Wed Jul 29 03:27:14 +0000 2026"),
      { postedAt: "2026-07-29T03:27:14.000Z", publishedAtPrecision: "exact" }
    );
    assert.deepEqual(
      xTweetPublicationDate("2026-07-31T03:27:14"),
      { postedAt: null, publishedAtPrecision: "unknown" }
    );
  });

  it("keeps successful empty reads done but leaves command failures retryable", () => {
    assert.deepEqual(
      xCollectionAttemptState({
        tweetCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 1
      }),
      {
        status: "done",
        collectionFailed: false
      }
    );
    assert.deepEqual(
      xCollectionAttemptState({
        tweetCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 1,
        failedSourceCount: 1
      }),
      {
        status: "failed",
        collectionFailed: true
      }
    );
    assert.deepEqual(
      xCollectionAttemptState({
        tweetCount: 12,
        attemptedSourceCount: 2,
        completedSourceCount: 1,
        failedSourceCount: 1
      }),
      {
        status: "done",
        collectionFailed: false
      }
    );
    assert.deepEqual(
      xCollectionAttemptState({
        tweetCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 0
      }),
      {
        status: "failed",
        collectionFailed: true
      }
    );
    assert.deepEqual(
      xCollectionAttemptState({
        tweetCount: 12,
        attemptedSourceCount: 2,
        completedSourceCount: 1
      }),
      {
        status: "done",
        collectionFailed: false
      }
    );
  });

  it("prioritizes untouched zero-coverage X targets before failed retries and routine refreshes", () => {
    const targets = [
      { platform: "instagram", entityId: "instagram-first" },
      { platform: "x", batchSlug: "S2026", entityId: "many", url: "https://x.com/many" },
      { platform: "x", batchSlug: "S2026", entityId: "never-b", url: "https://x.com/never_b" },
      { platform: "x", batchSlug: "S2026", entityId: "failed-no-date", url: "https://x.com/failed_no_date" },
      { platform: "x", batchSlug: "S2026", entityId: "old", url: "https://x.com/old" },
      { platform: "x", batchSlug: "S2026", entityId: "never-a", url: "https://x.com/never_a" },
      { platform: "linkedin", entityId: "linkedin-last" }
    ];
    const prioritized = prioritizeXTargets(targets, {
      evidence: [
        {
          platform: "x",
          batchSlug: "S2026",
          entityId: "many",
          platformPostId: "201"
        },
        {
          platform: "x",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl: "https://x.com/many/status/202"
        },
        {
          platform: "x",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl: "https://x.com/many/status/202?s=20"
        },
        {
          platform: "x",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl: "https://x.com/many"
        }
      ],
      attempts: new Map([
        ["many", { checkedAt: "2026-07-01T00:00:00.000Z" }],
        ["failed-no-date", { status: "failed" }],
        ["old", { checkedAt: "2026-06-01T00:00:00.000Z" }]
      ]),
      attemptKey: (target) => target.entityId
    });

    assert.deepEqual(
      prioritized.map((target) => target.entityId),
      [
        "instagram-first",
        "never-a",
        "never-b",
        "failed-no-date",
        "old",
        "many",
        "linkedin-last"
      ]
    );
  });

  it("distinguishes a legitimate empty timeline from an auth or outage page", () => {
    assert.equal(xTimelinePageState("This account hasn’t posted yet", 0), "empty");
    assert.equal(xTimelinePageState("Something went wrong. Try reloading.", 0), "failed");
    assert.equal(xTimelinePageState("Log in to see posts", 0), "failed");
    assert.equal(xTimelinePageState("Any page text", 1), "healthy");
  });

  it("stops quota hammering immediately and only accumulates infrastructure failures", () => {
    assert.equal(xFailureKind("HTTP 429 Too Many Requests"), "rate_limited");
    assert.equal(xFailureKind("Log in to continue"), "auth");
    assert.equal(
      xFailureKind("X native post 123 omitted: native_owner_mismatch."),
      "target_specific"
    );
    assert.equal(
      xFailureKind("X browser DOM extractor failed: connection dropped"),
      "transport"
    );
    assert.equal(
      xFailureKind("X authenticated adapter failed: connection dropped"),
      "transport"
    );
    assert.equal(
      xFailureKind(
        "X authenticated adapter failed: connection dropped | No scored recent original X posts found"
      ),
      "transport"
    );
    assert.equal(
      xFailureKind(
        "X authenticated adapter failed: unexpected response | No scored recent original X posts found"
      ),
      "system"
    );
    assert.deepEqual(
      xCircuitStateTransition({
        previousConsecutiveFailures: 0,
        collectionFailed: false,
        failureKind: "rate_limited"
      }),
      { consecutiveFailures: 1, open: true, reason: "rate_limited" }
    );
    assert.deepEqual(
      xCircuitStateTransition({
        previousConsecutiveFailures: 7,
        collectionFailed: true,
        maxConsecutiveFailures: 8,
        failureKind: "target_specific"
      }),
      { consecutiveFailures: 0, open: false, reason: null }
    );
    assert.deepEqual(
      xCircuitStateTransition({
        previousConsecutiveFailures: 7,
        collectionFailed: true,
        maxConsecutiveFailures: 8,
        failureKind: "system"
      }),
      {
        consecutiveFailures: 8,
        open: true,
        reason: "consecutive_failures"
      }
    );
  });
});
