import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceContentFingerprint,
  canonicalEvidenceDedupeKey,
  deriveNativeEvidenceId,
  normalizeCanonicalEvidence,
  normalizeCanonicalEvidenceUrl,
  validateCanonicalEvidence,
  type CanonicalEvidenceInput
} from "@/lib/ingestion/canonical-evidence";

describe("canonical evidence URL normalization", () => {
  it.each([
    {
      platform: "twitter",
      url: "http://mobile.twitter.com/Some_User/status/12345/photo/1?utm_source=feed&s=20#reply",
      canonicalUrl: "https://x.com/some_user/status/12345",
      nativeId: "12345",
      objectType: "post"
    },
    {
      platform: "youtube",
      url: "https://youtu.be/AbC_123-xYz?si=tracking&t=30#comments",
      canonicalUrl: "https://youtube.com/watch?v=AbC_123-xYz",
      nativeId: "AbC_123-xYz",
      objectType: "video"
    },
    {
      platform: "github",
      url: "https://www.github.com/ExampleOrg/Returner.git/tree/main?utm_campaign=launch#readme",
      canonicalUrl: "https://github.com/exampleorg/returner",
      nativeId: "exampleorg/returner",
      objectType: "repository"
    },
    {
      platform: "reddit",
      url: "https://old.reddit.com/r/startups/comments/AbC123/product_launch/?utm_medium=social#thing_t1_comment",
      canonicalUrl: "https://reddit.com/comments/abc123",
      nativeId: "abc123",
      objectType: "post"
    },
    {
      platform: "producthunt",
      url: "https://www.producthunt.com/posts/Returner-Fund?ref=homepage#discussion",
      canonicalUrl: "https://producthunt.com/posts/returner-fund",
      nativeId: "posts/returner-fund",
      objectType: "launch"
    },
    {
      platform: "hn",
      url: "https://news.ycombinator.com/item?utm_source=digest&id=44200123#44200124",
      canonicalUrl: "https://news.ycombinator.com/item?id=44200123",
      nativeId: "44200123",
      objectType: "story"
    },
    {
      platform: "instagram",
      url: "https://m.instagram.com/reels/C0dE_123/?igshid=abc#comments",
      canonicalUrl: "https://instagram.com/reel/C0dE_123",
      nativeId: "C0dE_123",
      objectType: "post"
    },
    {
      platform: "linkedin",
      url: "https://m.linkedin.com/posts/person_launch-activity-7312345678901234567-abcd?trk=public_post#comments",
      canonicalUrl: "https://linkedin.com/feed/update/urn:li:activity:7312345678901234567",
      nativeId: "7312345678901234567",
      objectType: "post"
    },
    {
      platform: "bluesky",
      url: "https://bsky.app/profile/Founder.Example/post/3lxyzABC?utm_source=share#thread",
      canonicalUrl: "https://bsky.app/profile/founder.example/post/3lxyzABC",
      nativeId: "founder.example/post/3lxyzABC",
      objectType: "post"
    },
    {
      platform: "tiktok",
      url: "https://m.tiktok.com/@Founder.Name/video/7491234567890123456?utm_medium=share#comments",
      canonicalUrl: "https://tiktok.com/@founder.name/video/7491234567890123456",
      nativeId: "7491234567890123456",
      objectType: "video"
    },
    {
      platform: "bilibili",
      url: "https://m.bilibili.com/video/BV1Ab411c7De/?from=search&utm_source=feed#reply",
      canonicalUrl: "https://bilibili.com/video/BV1Ab411c7De",
      nativeId: "BV1Ab411c7De",
      objectType: "video"
    }
  ])("normalizes a $platform native object", ({ platform, url, canonicalUrl, nativeId, objectType }) => {
    const result = normalizeCanonicalEvidenceUrl(platform, url);

    expect(result).toMatchObject({
      canonicalUrl,
      nativeId,
      objectType,
      classification: "native_object",
      reason: null
    });
    expect(deriveNativeEvidenceId(platform, url)).toBe(nativeId);
  });

  it.each([
    "https://youtube.com/watch?v=AbC_123-xYz&utm_source=feed",
    "https://m.youtube.com/shorts/AbC_123-xYz?feature=share",
    "https://youtube.com/embed/AbC_123-xYz#player",
    "https://youtu.be/AbC_123-xYz?si=share"
  ])("collapses a YouTube variant to one object identity: %s", (url) => {
    expect(normalizeCanonicalEvidenceUrl("youtube", url)).toMatchObject({
      canonicalUrl: "https://youtube.com/watch?v=AbC_123-xYz",
      nativeId: "AbC_123-xYz",
      classification: "native_object"
    });
  });

  it("normalizes short Reddit and alternate X URLs without network resolution", () => {
    expect(normalizeCanonicalEvidenceUrl("reddit", "https://redd.it/AbC123?utm_source=share")).toMatchObject({
      canonicalUrl: "https://reddit.com/comments/abc123",
      nativeId: "abc123"
    });
    expect(normalizeCanonicalEvidenceUrl("x", "https://x.com/i/web/status/12345?t=10")).toMatchObject({
      canonicalUrl: "https://x.com/i/status/12345",
      nativeId: "12345"
    });
  });
});

describe("canonical evidence validation", () => {
  it.each([
    ["x", "https://x.com/founder"],
    ["youtube", "https://youtube.com/@founder"],
    ["github", "https://github.com/founder"],
    ["reddit", "https://reddit.com/r/startups"],
    ["product_hunt", "https://producthunt.com/products/example"],
    ["hacker_news", "https://news.ycombinator.com/user?id=founder"],
    ["instagram", "https://instagram.com/founder"],
    ["linkedin", "https://linkedin.com/company/example"],
    ["bluesky", "https://bsky.app/profile/founder.example"],
    ["tiktok", "https://tiktok.com/@founder"],
    ["bilibili", "https://bilibili.com/space/12345"]
  ])("retains but rejects a %s profile page", (platform, sourceUrl) => {
    const row = normalizeCanonicalEvidence({ platform, sourceUrl, metrics: { followers: 10_000 } });

    expect(row.classification).toBe("profile");
    expect(row.canonicalUrl).not.toBeNull();
    expect(row.tractionEligible).toBe(false);
    expect(row.rejectionReasons).toContain("profile_page");
  });

  it.each([
    ["x", "https://x.com/search?q=returner"],
    ["youtube", "https://youtube.com/results?search_query=returner"],
    ["github", "https://github.com/search?q=returner&type=repositories"],
    ["instagram", "https://instagram.com/explore/search/keyword/?q=returner"],
    ["linkedin", "https://linkedin.com/search/results/content/?keywords=returner"]
  ])("retains but rejects a %s search page", (platform, sourceUrl) => {
    const row = normalizeCanonicalEvidence({ platform, sourceUrl, metrics: { views: 100 } });

    expect(row.classification).toBe("search");
    expect(row.tractionEligible).toBe(false);
    expect(row.rejectionReasons).toContain("search_page");
  });

  it("requires a positive metric that was visibly observed", () => {
    const base: CanonicalEvidenceInput = {
      platform: "x",
      sourceUrl: "https://x.com/founder/status/123",
      metrics: { views: 500, likes: 0 }
    };

    expect(normalizeCanonicalEvidence(base)).toMatchObject({
      visiblePositiveMetrics: { views: 500 },
      tractionEligible: true,
      rejectionReasons: []
    });
    expect(normalizeCanonicalEvidence({ ...base, metricsVisible: false })).toMatchObject({
      visiblePositiveMetrics: {},
      tractionEligible: false,
      rejectionReasons: ["no_visible_positive_metrics"]
    });
    expect(normalizeCanonicalEvidence({ ...base, visibleMetricKeys: ["likes"] })).toMatchObject({
      visiblePositiveMetrics: {},
      tractionEligible: false,
      rejectionReasons: ["no_visible_positive_metrics"]
    });
    expect(normalizeCanonicalEvidence({ ...base, metrics: { views: 0, likes: 0 } }).tractionEligible).toBe(false);
  });

  it("rejects invalid metrics and conflicting supplied IDs", () => {
    const invalidMetric = normalizeCanonicalEvidence({
      platform: "youtube",
      sourceUrl: "https://youtu.be/video-one",
      metrics: { views: Number.NaN, likes: -1 }
    });
    expect(invalidMetric.metrics).toEqual({ likes: null, views: null });
    expect(invalidMetric.tractionEligible).toBe(false);
    expect(invalidMetric.rejectionReasons).toEqual([
      "invalid_metrics",
      "no_visible_positive_metrics"
    ]);

    const conflict = normalizeCanonicalEvidence({
      platform: "x",
      sourceUrl: "https://x.com/founder/status/123",
      nativeId: "456",
      metrics: { views: 1 }
    });
    expect(conflict.nativeId).toBe("123");
    expect(conflict.validNativeObject).toBe(false);
    expect(conflict.tractionEligible).toBe(false);
    expect(conflict.rejectionReasons).toContain("native_id_conflict");
  });

  it("retains valid Bluesky and TikTok objects as native but unscored", () => {
    for (const input of [
      {
        platform: "bluesky",
        sourceUrl: "https://bsky.app/profile/founder.example/post/3lxyz",
        metrics: { likes: 12 }
      },
      {
        platform: "tiktok",
        sourceUrl: "https://tiktok.com/@founder/video/7491234567890123456",
        metrics: { views: 500 }
      }
    ]) {
      const row = normalizeCanonicalEvidence(input);
      expect(row.validNativeObject).toBe(true);
      expect(row.tractionEligible).toBe(false);
      expect(row.rejectionReasons).toContain("traction_not_supported");
    }
  });

  it("preserves unsupported and contextual rows with reasons but never traction", () => {
    const unsupported = normalizeCanonicalEvidence({
      platform: "mastodon",
      sourceUrl: "https://social.example/@founder/123?utm_source=share#replies",
      metrics: { favourites: 50 }
    });
    expect(unsupported).toMatchObject({
      sourcePlatform: "mastodon",
      sourceUrl: "https://social.example/@founder/123?utm_source=share#replies",
      platform: null,
      canonicalUrl: "https://social.example/@founder/123",
      classification: "context",
      tractionEligible: false,
      rejectionReasons: ["unsupported_platform"]
    });

    const context = normalizeCanonicalEvidence({
      platform: "web",
      sourceUrl: "https://example.com/launch?utm_campaign=social",
      metrics: { views: 1_000 }
    });
    expect(context.canonicalUrl).toBe("https://example.com/launch");
    expect(context.tractionEligible).toBe(false);
    expect(context.rejectionReasons).toEqual(["context_only_platform"]);
  });

  it("reports malformed and platform-mismatched URLs without dropping their rows", () => {
    expect(validateCanonicalEvidence({ platform: "x", sourceUrl: "not a URL", metrics: { views: 1 } })).toEqual({
      validNativeObject: false,
      tractionEligible: false,
      rejectionReasons: ["invalid_url"]
    });
    expect(normalizeCanonicalEvidence({
      platform: "github",
      sourceUrl: "https://gitlab.com/example/repository",
      metrics: { stars: 100 }
    })).toMatchObject({
      canonicalUrl: "https://gitlab.com/example/repository",
      classification: "context",
      tractionEligible: false,
      rejectionReasons: ["platform_host_mismatch"]
    });
  });

  it("does not mutate caller-owned input or metric records", () => {
    const input: CanonicalEvidenceInput = {
      platform: "youtube",
      sourceUrl: "https://youtu.be/abc123?utm_source=share",
      author: " Founder ",
      metrics: { views: 10, likes: null },
      visibleMetricKeys: ["views"]
    };
    const before = JSON.stringify(input);

    normalizeCanonicalEvidence(input);

    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("canonical evidence dedupe keys", () => {
  it("uses native ID before URL and URL before content fingerprint", () => {
    expect(canonicalEvidenceDedupeKey({
      platform: "twitter",
      nativeId: "123",
      sourceUrl: "https://x.com/someone/status/123?utm_source=share",
      author: "Different author",
      timestamp: "different time",
      content: "Different content"
    })).toBe("x:native:123");

    expect(canonicalEvidenceDedupeKey({
      platform: "linkedin",
      sourceUrl: "https://linkedin.com/pulse/a-context-article?utm_source=share#comments",
      author: "Founder",
      content: "Launch"
    })).toBe("linkedin:url:https://linkedin.com/pulse/a-context-article");

    expect(canonicalEvidenceDedupeKey({
      platform: "x",
      author: "@Founder",
      timestamp: "2026-07-18T12:00:00-05:00",
      content: " We launched today! "
    })).toMatch(/^x:fingerprint:[0-9a-f]{16}$/);
  });

  it("derives native identity before deduping equivalent URL variants", () => {
    const twitter = canonicalEvidenceDedupeKey({
      platform: "twitter",
      sourceUrl: "https://mobile.twitter.com/Founder/status/123?utm_source=share"
    });
    const x = canonicalEvidenceDedupeKey({
      platform: "x",
      sourceUrl: "https://x.com/other_handle/status/123#replies"
    });
    expect(twitter).toBe("x:native:123");
    expect(x).toBe(twitter);
  });

  it("normalizes author, timestamp, whitespace, and case for deterministic fingerprints", () => {
    const first = canonicalEvidenceContentFingerprint({
      author: "@Founder",
      timestamp: "2026-07-18T12:00:00-05:00",
      content: "  We LAUNCHED\nToday! "
    });
    const second = canonicalEvidenceContentFingerprint({
      author: "founder",
      timestamp: "2026-07-18T17:00:00.000Z",
      text: "we launched today!"
    });

    expect(first).toBe(second);
    expect(canonicalEvidenceDedupeKey({
      platform: "x",
      author: "@Founder",
      timestamp: "2026-07-18T12:00:00-05:00",
      content: "We launched today!"
    })).toBe(`x:fingerprint:${first}`);
  });
});
