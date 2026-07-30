import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  withOpenCliBrowserSession
} from "../scripts/lib/opencli-browser-session.mjs";
import {
  linkedinAdapterSupportsAccountUrl,
  linkedinCircuitDecision,
  linkedinCircuitStateTransition,
  linkedinCollectionAttemptState,
  linkedinFailureKind,
  linkedinPostIsExplicitRepost,
  linkedinPostStrictlyBelongsToAccount,
  mergeOwnedLinkedInPosts,
  prioritizeLinkedInTargets
} from "../scripts/lib/logged-in-linkedin-collection.mjs";

describe("OpenCLI browser session cleanup", () => {
  it("releases the exact browser session lease after successful collection", async () => {
    const calls = [];
    const result = await withOpenCliBrowserSession({
      session: "linkedin-worker-3",
      runOpenCli: async (args, options) => {
        calls.push({ args, options });
        return "closed";
      },
      operation: async () => "collected"
    });

    assert.equal(result, "collected");
    assert.deepEqual(calls, [
      {
        args: ["browser", "linkedin-worker-3", "close"],
        options: { timeoutMs: 12_000 }
      }
    ]);
  });

  it("preserves the collection error when releasing the lease also fails", async () => {
    const collectionError = new Error("page extraction failed");
    let closeAttempts = 0;

    await assert.rejects(
      withOpenCliBrowserSession({
        session: "linkedin-worker-4",
        runOpenCli: async () => {
          closeAttempts += 1;
          throw new Error("browser close failed");
        },
        operation: async () => {
          throw collectionError;
        }
      }),
      (error) => error === collectionError
    );
    assert.equal(closeAttempts, 1);
  });

  it("preserves a successful result when releasing the lease fails", async () => {
    const result = await withOpenCliBrowserSession({
      session: "linkedin-worker-5",
      runOpenCli: async () => {
        throw new Error("browser close failed");
      },
      operation: async () => ["native-post"]
    });

    assert.deepEqual(result, ["native-post"]);
  });
});

describe("logged-in LinkedIn collection", () => {
  it("uses the adapter only for supported personal profile URLs", () => {
    assert.equal(
      linkedinAdapterSupportsAccountUrl("https://www.linkedin.com/in/founder/"),
      true
    );
    assert.equal(
      linkedinAdapterSupportsAccountUrl("https://www.linkedin.com/company/acme/"),
      false
    );
    assert.equal(linkedinAdapterSupportsAccountUrl("https://example.com/in/founder"), false);
  });

  it("fails closed on a native post URL or author that differs from the target", () => {
    const accountUrl = "https://www.linkedin.com/in/founder/";
    const valid = {
      url: "https://www.linkedin.com/posts/founder_launch-activity-7475000000000000001-good",
      author: "Founder Name",
      rawText: "Founder Name\\n2h\\nWe launched.",
      authorUrls: ["https://www.linkedin.com/in/founder/"]
    };
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(valid, accountUrl, "Founder Name"),
      true
    );
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        {
          ...valid,
          url: "https://www.linkedin.com/posts/third-party_launch-activity-7475000000000000001-bad"
        },
        accountUrl,
        "Founder Name"
      ),
      false
    );
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        {
          ...valid,
          url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000001/",
          authorUrls: []
        },
        accountUrl,
        "Founder Name"
      ),
      false
    );
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        { ...valid, author: "Someone Else", rawText: "Someone Else\\n2h\\nWe launched." },
        accountUrl,
        "Founder Name"
      ),
      false
    );
  });

  it("rejects repost wrappers even when a long adapter body precedes DOM text", () => {
    const repost = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000005/",
      author: "Founder Name",
      authorUrls: ["https://www.linkedin.com/in/founder/"],
      body: "adapter body ".repeat(100),
      rawText: "Feed post number 3 Founder Name reposted this Someone Else 2h Original body"
    };

    assert.equal(linkedinPostIsExplicitRepost(repost, "Founder Name"), true);
    assert.equal(
      linkedinPostStrictlyBelongsToAccount(
        repost,
        "https://www.linkedin.com/in/founder/",
        "Founder Name"
      ),
      false
    );
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[repost]], {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }),
      []
    );
  });

  it("quarantines an entire activity when DOM proves the adapter copy is a repost", () => {
    const postId = "7475000000000000006";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url: `https://www.linkedin.com/posts/founder_launch-activity-${postId}-good`,
            author: "Founder Name",
            authorUrls: ["https://www.linkedin.com/in/founder/"],
            body: "Rich adapter body without a wrapper marker.",
            raw_text: "Founder Name 2h Rich adapter body without a wrapper marker.",
            reactions: 25
          }
        ],
        [
          {
            url: `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/`,
            author: "Founder Name",
            authorUrls: ["https://www.linkedin.com/in/founder/"],
            body: "Someone else's original post.",
            rawText:
              "Feed post number 2 Founder Name reposted this Someone Else 2h Original body"
          }
        ]
      ],
      {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }
    );

    assert.deepEqual(merged, []);
  });

  it("does not confuse ordinary native prose containing shared this with a wrapper", () => {
    const original = {
      url: "https://www.linkedin.com/posts/founder_analysis-activity-7475000000000000007-good",
      author: "Founder Name",
      authorUrls: ["https://www.linkedin.com/in/founder/"],
      body: "I shared this analysis with our customers before publishing it.",
      rawText:
        "Feed post number 1 Founder Name • 1st Founder at Acme 2h I shared this analysis with our customers before publishing it."
    };

    assert.equal(linkedinPostIsExplicitRepost(original, "Founder Name"), false);
    assert.equal(
      mergeOwnedLinkedInPosts([[original]], {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }).length,
      1
    );
  });

  it("rejects nested reshare cards that expose the embedded parent's activity id", () => {
    const nested = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000008/",
      author: "Founder Name",
      authorUrls: [
        "https://www.linkedin.com/in/founder/",
        "https://www.linkedin.com/in/embedded-author/"
      ],
      body: "The embedded author's original post body.",
      rawText:
        "Feed post number 4 Founder Name • 2nd Founder at Acme 2w • Follow " +
        "Proud to support this launch. Embedded Author • 2nd CEO at Other 2w • Follow " +
        "The embedded author's original post body. 14 reactions 2 comments"
    };

    assert.equal(linkedinPostIsExplicitRepost(nested, "Founder Name"), true);
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[nested]], {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }),
      []
    );
  });

  it("rejects one-Follow founder wrappers around an embedded organization activity", () => {
    const wrapper = {
      url:
        "https://www.linkedin.com/feed/update/urn:li:activity:7479927233340702722/",
      author: "Eric Taylor",
      authorUrls: ["https://www.linkedin.com/in/eric-taylor/"],
      body: "Baud is building high-performance AI infrastructure.",
      rawText:
        "Feed post number 1 Eric Taylor • 2nd Founder at Baud 2d • Follow " +
        "Today we are coming out of stealth. Y Combinator 1,736,380 followers " +
        "2d • Baud is building high-performance AI infrastructure."
    };

    assert.equal(linkedinPostIsExplicitRepost(wrapper, "Eric Taylor"), true);
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[wrapper]], {
        accountUrl: "https://www.linkedin.com/in/eric-taylor/",
        targetName: "Eric Taylor",
        limit: 5
      }),
      []
    );
  });

  it("does not reject a native organization card whose follower header precedes Follow", () => {
    const native = {
      url:
        "https://www.linkedin.com/posts/acme_launch-activity-7479927233340702723-good",
      author: "Acme",
      authorUrls: ["https://www.linkedin.com/company/acme/"],
      body: "We launched today.",
      rawText:
        "Feed post number 1 Acme 12,340 followers 2d • Follow We launched today."
    };

    assert.equal(linkedinPostIsExplicitRepost(native, "Acme"), false);
  });

  it("rejects compact reshare headers that omit the feed-post prefix", () => {
    const nested = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7487596571207815168/",
      author: "Alexandre Labreche",
      authorUrls: ["https://www.linkedin.com/in/alexandrelabreche/"],
      body: "The embedded company's original post body.",
      rawText:
        "Alexandre Labreche Alexandre Labreche 1d Alexandre Labreche shared this " +
        "The embedded company's original post body."
    };

    assert.equal(
      linkedinPostIsExplicitRepost(nested, "Alexandre Labreche"),
      true
    );
    assert.equal(linkedinPostIsExplicitRepost(nested), true);
    assert.equal(
      linkedinPostIsExplicitRepost({
        rawText:
          "Alexandre Labreche Alexandre Labreche 1d I shared this analysis with our customers."
      }),
      false
    );
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[nested]], {
        accountUrl: "https://www.linkedin.com/in/alexandrelabreche/",
        targetName: "Alexandre Labreche",
        limit: 5
      }),
      []
    );
  });

  it("unions adapter and DOM observations by native activity ID", () => {
    const url =
      "https://www.linkedin.com/posts/founder_launch-activity-7475000000000000001-good";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url,
            author: "Founder Name",
            authorUrls: ["https://www.linkedin.com/in/founder/"],
            body: "Short DOM body",
            rawText: "Founder Name\\n2h\\nShort DOM body",
            reactions: 10,
            comments: 4,
            reposts: 1,
            impressions: 100,
            mediaUrls: ["https://media.licdn.com/dom.jpg"]
          }
        ],
        [
          {
            url,
            author: "Founder Name",
            body: "Longer adapter body for the same native post.",
            raw_text: "Founder Name 2h Longer adapter body for the same native post.",
            reactions: 12,
            comments: 3,
            reposts: 2,
            impressions: 150,
            media_urls: "https://media.licdn.com/adapter.jpg",
            posted_at: "2026-07-29T10:00:00.000Z"
          }
        ]
      ],
      {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 10
      }
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "7475000000000000001");
    assert.equal(merged[0].body, "Longer adapter body for the same native post.");
    assert.equal(merged[0].reactions, 12);
    assert.equal(merged[0].comments, 4);
    assert.equal(merged[0].reposts, 2);
    assert.equal(merged[0].impressions, 150);
    assert.deepEqual(merged[0].mediaUrls, [
      "https://media.licdn.com/dom.jpg",
      "https://media.licdn.com/adapter.jpg"
    ]);
  });

  it("uses exact DOM author proof to authorize metrics from an opaque adapter activity", () => {
    const accountUrl = "https://www.linkedin.com/in/founder/";
    const opaqueUrl =
      "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000002/";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url: opaqueUrl,
            author: "Founder Name",
            authorUrls: [accountUrl],
            body: "DOM body",
            rawText: "Founder Name\\n2h\\nDOM body",
            reactions: 3
          }
        ],
        [
          {
            url: opaqueUrl,
            author: "Founder Name",
            body: "Longer adapter body for the opaque native activity.",
            raw_text: "Founder Name 2h Longer adapter body for the opaque native activity.",
            reactions: 19,
            comments: 4,
            reposts: 2,
            posted_at: "2026-07-29T11:00:00.000Z"
          }
        ]
      ],
      { accountUrl, targetName: "Founder Name", limit: 5 }
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "7475000000000000002");
    assert.equal(merged[0].reactions, 19);
    assert.equal(merged[0].comments, 4);
    assert.equal(merged[0].reposts, 2);
  });

  it("rejects an opaque adapter activity without exact DOM owner proof", () => {
    const accountUrl = "https://www.linkedin.com/in/founder/";
    const opaque = {
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000003/",
      author: "Founder Name",
      body: "Adapter-only body",
      raw_text: "Founder Name 2h Adapter-only body",
      reactions: 21
    };
    assert.deepEqual(
      mergeOwnedLinkedInPosts([[opaque]], {
        accountUrl,
        targetName: "Founder Name",
        limit: 5
      }),
      []
    );
  });

  it("does not let mismatched DOM identity authorize opaque adapter metrics", () => {
    const opaqueUrl =
      "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000004/";
    const merged = mergeOwnedLinkedInPosts(
      [
        [
          {
            url: opaqueUrl,
            author: "Someone Else",
            authorUrls: ["https://www.linkedin.com/in/someone-else/"],
            body: "DOM body from another profile",
            rawText: "Someone Else\\n2h\\nDOM body from another profile"
          }
        ],
        [
          {
            url: opaqueUrl,
            author: "Founder Name",
            body: "Adapter body",
            raw_text: "Founder Name 2h Adapter body",
            reactions: 50
          }
        ]
      ],
      {
        accountUrl: "https://www.linkedin.com/in/founder/",
        targetName: "Founder Name",
        limit: 5
      }
    );
    assert.deepEqual(merged, []);
  });

  it("distinguishes successful empty reads from command failures", () => {
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 1
      }),
      { status: "done", collectionFailed: false }
    );
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 1,
        failedSourceCount: 1
      }),
      { status: "failed", collectionFailed: true }
    );
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 2,
        attemptedSourceCount: 2,
        completedSourceCount: 1,
        failedSourceCount: 1
      }),
      { status: "done", collectionFailed: false }
    );
    assert.deepEqual(
      linkedinCollectionAttemptState({
        postCount: 0,
        attemptedSourceCount: 1,
        completedSourceCount: 0
      }),
      { status: "failed", collectionFailed: true }
    );
  });

  it("exhausts untouched zero-coverage targets before failed retries and low-coverage refreshes", () => {
    const targets = [
      { platform: "x", entityId: "x-first" },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "many",
        url: "https://www.linkedin.com/in/many/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "never",
        url: "https://www.linkedin.com/in/never/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "failed",
        url: "https://www.linkedin.com/in/failed/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "old-low",
        url: "https://www.linkedin.com/in/old-low/"
      },
      {
        platform: "linkedin",
        batchSlug: "S2026",
        entityId: "new-low",
        url: "https://www.linkedin.com/in/new-low/"
      }
    ];
    const prioritized = prioritizeLinkedInTargets(targets, {
      evidence: [
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          platformPostId: "7475000000000000010"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl:
            "https://www.linkedin.com/posts/many_activity-7475000000000000011-good"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl:
            "https://www.linkedin.com/feed/update/urn:li:activity:7475000000000000011/"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "many",
          sourceUrl: "https://www.linkedin.com/in/many/"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "old-low",
          platformPostId: "7475000000000000012"
        },
        {
          platform: "linkedin",
          batchSlug: "S2026",
          entityId: "new-low",
          platformPostId: "7475000000000000013"
        }
      ],
      attempts: new Map([
        ["failed", { status: "failed", checkedAt: "2026-07-28T00:00:00.000Z" }],
        ["old-low", { status: "done", checkedAt: "2026-07-27T00:00:00.000Z" }],
        ["new-low", { status: "done", checkedAt: "2026-07-29T00:00:00.000Z" }]
      ]),
      attemptKey: (target) => target.entityId
    });
    assert.deepEqual(
      prioritized.map((target) => target.entityId),
      ["x-first", "never", "failed", "old-low", "new-low", "many"]
    );
  });

  it("opens the circuit immediately for auth/rate limiting or after repeated infrastructure failures", () => {
    assert.equal(linkedinFailureKind("HTTP 429 too many requests"), "rate_limited");
    assert.equal(linkedinFailureKind("Sign in to continue"), "auth");
    assert.equal(
      linkedinFailureKind(
        "No attributable original LinkedIn posts were visible in browser mode."
      ),
      "target_specific"
    );
    assert.equal(
      linkedinFailureKind("LinkedIn browser DOM extractor failed: connection dropped"),
      "transport"
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 1,
        maxConsecutiveFailures: 5,
        failureKind: "auth"
      }),
      { open: true, reason: "auth" }
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 5,
        maxConsecutiveFailures: 5,
        failureKind: "transport"
      }),
      { open: true, reason: "consecutive_failures" }
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 50,
        maxConsecutiveFailures: 5,
        failureKind: "target_specific"
      }),
      { open: false, reason: null }
    );
    assert.deepEqual(
      linkedinCircuitDecision({
        consecutiveFailures: 50,
        maxConsecutiveFailures: 5,
        failureKind: "empty"
      }),
      { open: false, reason: null }
    );
  });

  it("keeps target-specific misses retryable without advancing the global circuit", () => {
    assert.deepEqual(
      linkedinCircuitStateTransition({
        previousConsecutiveFailures: 4,
        collectionFailed: true,
        maxConsecutiveFailures: 5,
        failureKind: "target_specific"
      }),
      { consecutiveFailures: 0, open: false, reason: null }
    );
    assert.deepEqual(
      linkedinCircuitStateTransition({
        previousConsecutiveFailures: 4,
        collectionFailed: true,
        maxConsecutiveFailures: 5,
        failureKind: "system"
      }),
      {
        consecutiveFailures: 5,
        open: true,
        reason: "consecutive_failures"
      }
    );
    assert.deepEqual(
      linkedinCircuitStateTransition({
        previousConsecutiveFailures: 0,
        collectionFailed: true,
        maxConsecutiveFailures: 5,
        failureKind: "auth"
      }),
      { consecutiveFailures: 1, open: true, reason: "auth" }
    );
  });
});
