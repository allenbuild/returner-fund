import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceKey,
  canonicalEvidenceUrl,
  canonicalPostKey,
  contextEvidenceContentUrl,
  dedupePublishedContextEvidence,
  dedupeEvidenceForScoring,
  dedupeEvidenceItems,
  hasEvidenceIdentityConflict,
  nativeEvidenceIdentityFromUrl
} from "@/lib/graph/dedupe";
import type { EvidenceItem } from "@/lib/graph/types";

describe("evidence dedupe", () => {
  it("canonicalizes social URL variants", () => {
    expect(canonicalEvidenceUrl("https://twitter.com/AllenXTech/status/12345?s=20&utm_source=x")).toBe(
      "https://x.com/allenxtech/status/12345"
    );
    expect(canonicalEvidenceUrl("https://mobile.twitter.com/AllenXTech/status/12345?ref_src=twsrc")).toBe(
      "https://x.com/allenxtech/status/12345"
    );
    expect(canonicalEvidenceUrl("https://www.instagram.com/reel/ABC123/?igshid=test&utm_campaign=x")).toBe(
      "https://instagram.com/reel/ABC123"
    );
  });

  it("keeps distinct articles discovered through the same sitemap or feed", () => {
    const context = [
      {
        ...evidence("article-a", "https://example.com/sitemap.xml", 0),
        platform: "web" as const,
        platformPostId: "web:https://example.com/blog/a"
      },
      {
        ...evidence("article-b", "https://example.com/sitemap.xml", 0),
        platform: "web" as const,
        platformPostId: "web:https://example.com/blog/b"
      },
      {
        ...evidence("feed-a", "https://example.com/feed", 0),
        platform: "rss" as const,
        platformPostId: "url:https://example.com/news/a"
      }
    ];

    expect(contextEvidenceContentUrl("web", context[0].platformPostId)).toBe(
      "https://example.com/blog/a"
    );
    expect(contextEvidenceContentUrl("rss", context[2].platformPostId)).toBe(
      "https://example.com/news/a"
    );
    expect(new Set(context.map(canonicalPostKey)).size).toBe(3);
    expect(dedupeEvidenceItems(context)).toHaveLength(3);
  });

  it("publishes one deterministic rich receipt for the same verified web and RSS article", () => {
    const web = {
      ...evidence("web-alias", "https://example.com/sitemap.xml", 0),
      batchSlug: "S2026",
      platform: "web" as const,
      platformPostId: "web:https://example.com/blog/launch?utm_source=site",
      review_state: "verified" as const,
      linkStatus: "verified" as const,
      tractionStatus: "unscored" as const,
      metrics: {},
      title: "Untitled",
      text: "Article",
      publishedAtPrecision: "day" as const,
      last_checked_at: "2026-08-02T00:00:00.000Z"
    };
    const rss = {
      ...web,
      id: "rss-rich",
      platform: "rss" as const,
      platformPostId: "url:https://example.com/blog/launch",
      title: "Acme launches its production platform",
      text: "The Acme team announced its production platform and shared customer results.",
      publishedAtPrecision: "exact" as const,
      last_checked_at: "2026-08-01T00:00:00.000Z"
    };

    expect(dedupePublishedContextEvidence([web, rss], "S2026").map((item) => item.id)).toEqual([
      "rss-rich"
    ]);
    expect(dedupePublishedContextEvidence([rss, web], "S2026").map((item) => item.id)).toEqual([
      "rss-rich"
    ]);
  });

  it("keeps context articles separate across owners and cohorts", () => {
    const base = {
      ...evidence("context-a", "https://example.com/feed", 0),
      batchSlug: "S2026",
      platform: "rss" as const,
      platformPostId: "https://example.com/blog/shared",
      review_state: "verified" as const,
      linkStatus: "verified" as const,
      tractionStatus: "unscored" as const,
      metrics: {},
      title: "Shared article",
      text: "A verified first-party article."
    };
    const differentOwner = { ...base, id: "context-b", entityId: "company-other", platform: "web" as const };
    const differentCohort = { ...base, id: "context-c", batchSlug: "S26", platform: "web" as const };

    expect(
      dedupePublishedContextEvidence([base, differentOwner, differentCohort], "S2026").map(
        (item) => item.id
      )
    ).toEqual(["context-a", "context-b", "context-c"]);
  });

  it("fails closed instead of hiding scored or ambiguously owned context aliases", () => {
    const base = {
      ...evidence("context-safe", "https://example.com/feed", 0),
      batchSlug: "S2026",
      platform: "rss" as const,
      platformPostId: "https://example.com/blog/shared",
      review_state: "verified" as const,
      linkStatus: "verified" as const,
      tractionStatus: "unscored" as const,
      metrics: {},
      title: "Shared article",
      text: "A verified first-party article."
    };
    const scored = {
      ...base,
      id: "context-scored",
      platform: "web" as const,
      contributionScore: 1,
      tractionStatus: "scored" as const
    };
    const ambiguous = {
      ...base,
      id: "context-ambiguous",
      attachedCompanyId: "company-other"
    };

    expect(() => dedupePublishedContextEvidence([base, scored], "S2026")).toThrow(
      /Refusing to collapse scored context evidence aliases/
    );
    expect(() => dedupePublishedContextEvidence([ambiguous], "S2026")).toThrow(
      /ambiguous or missing company ownership/
    );
  });

  it("accepts LinkedIn locale subdomains without accepting lookalike hosts", () => {
    const postPath =
      "/posts/vereda.agro_vereda-agro-activity-7485423404670521345-HjKU";

    expect(
      nativeEvidenceIdentityFromUrl("linkedin", `https://pt.linkedin.com${postPath}`)
    ).toBe("7485423404670521345");
    expect(
      nativeEvidenceIdentityFromUrl("linkedin", `https://regional.pt.linkedin.com${postPath}`)
    ).toBe("7485423404670521345");
    expect(
      nativeEvidenceIdentityFromUrl("linkedin", `https://pt.linkedin.com.evil.example${postPath}`)
    ).toBeNull();
    expect(
      nativeEvidenceIdentityFromUrl("linkedin", `https://notlinkedin.com${postPath}`)
    ).toBeNull();
  });

  it("keeps only the strongest duplicate evidence row", () => {
    const items = [
      evidence("low", "https://x.com/allenxtech/status/12345?utm_source=one", 20),
      evidence("high", "https://twitter.com/allenxtech/status/12345?s=20", 90)
    ];

    expect(dedupeEvidenceItems(items).map((item) => item.id)).toEqual(["high"]);
  });

  it("keeps the latest duplicate metric snapshot even when an older row was stronger", () => {
    const items = [
      {
        ...evidence("older-high", "https://x.com/allenxtech/status/12345?utm_source=one", 95),
        platformPostId: "12345",
        last_checked_at: "2026-06-01T00:00:00Z"
      },
      {
        ...evidence("newer-lower", "https://twitter.com/allenxtech/status/12345?s=20", 72),
        platformPostId: "12345",
        last_checked_at: "2026-06-28T00:00:00Z"
      }
    ];

    expect(dedupeEvidenceItems(items).map((item) => item.id)).toEqual(["newer-lower"]);
    expect(dedupeEvidenceItems([...items].reverse()).map((item) => item.id)).toEqual(["newer-lower"]);
  });

  it("coalesces an explicit post ID with the same URL-derived identity", () => {
    const idOnly = {
      ...evidence("id-only", "https://x.com/allenxtech", 40),
      platformPostId: "12345",
      last_checked_at: "2026-06-20T00:00:00Z"
    };
    const urlOnly = {
      ...evidence("url-only", "https://twitter.com/allenxtech/status/12345?s=20", 48),
      platformPostId: null,
      last_checked_at: "2026-06-21T00:00:00Z"
    };

    expect(canonicalEvidenceKey(idOnly)).toBe(canonicalEvidenceKey(urlOnly));
    expect(canonicalPostKey(idOnly)).toBe(canonicalPostKey(urlOnly));
    expect(dedupeEvidenceItems([idOnly, urlOnly]).map((item) => item.id)).toEqual(["url-only"]);
  });

  it("prefers explicit post ID and URL agreement before completeness or freshness", () => {
    const agreed = {
      ...evidence("agreed", "https://x.com/allenxtech/status/12345", 20),
      platformPostId: "12345",
      metrics: { views: 2_000 },
      last_checked_at: "2026-06-20T00:00:00Z"
    };
    const urlOnly = {
      ...evidence("url-only", "https://twitter.com/allenxtech/status/12345", 99),
      platformPostId: null,
      metrics: { views: 9_000, likes: 900, replies: 90 },
      last_checked_at: "2026-06-28T00:00:00Z"
    };

    expect(dedupeEvidenceItems([agreed, urlOnly]).map((item) => item.id)).toEqual(["agreed"]);
    expect(dedupeEvidenceItems([urlOnly, agreed]).map((item) => item.id)).toEqual(["agreed"]);
  });

  it("prefers metric completeness before freshness for equivalent parent observations", () => {
    const complete = {
      ...evidence("complete", "https://x.com/allenxtech/status/12345", 20),
      platformPostId: "12345",
      metrics: { views: 2_000, likes: 200, replies: 20 },
      last_checked_at: "2026-06-20T00:00:00Z"
    };
    const sparse = {
      ...evidence("sparse", "https://twitter.com/allenxtech/status/12345", 99),
      platformPostId: "12345",
      metrics: { views: 9_000 },
      last_checked_at: "2026-06-28T00:00:00Z"
    };

    expect(dedupeEvidenceItems([complete, sparse]).map((item) => item.id)).toEqual(["complete"]);
    expect(dedupeEvidenceItems([sparse, complete]).map((item) => item.id)).toEqual(["complete"]);
  });

  it("keeps opaque platform IDs case-sensitive", () => {
    const items = [
      {
        ...evidence("upper", "https://instagram.com/allenxtech", 40),
        platform: "instagram" as const,
        platformPostId: "ABC123"
      },
      {
        ...evidence("lower", "https://instagram.com/allenxtech", 48),
        platform: "instagram" as const,
        platformPostId: "abc123"
      }
    ];

    expect(canonicalPostKey(items[0])).not.toBe(canonicalPostKey(items[1]));
    expect(dedupeEvidenceItems(items).map((item) => item.id)).toEqual(["upper", "lower"]);
  });

  it("keeps case-sensitive opaque IDs distinct when they come from native URLs", () => {
    const upper = {
      ...evidence("upper-url", "https://youtube.com/watch?v=AbC_123", 40),
      platform: "youtube" as const,
      platformPostId: null
    };
    const lower = {
      ...evidence("lower-url", "https://youtube.com/watch?v=abc_123", 48),
      platform: "youtube" as const,
      platformPostId: null
    };

    expect(canonicalPostKey(upper)).not.toBe(canonicalPostKey(lower));
    expect(dedupeEvidenceItems([upper, lower]).map((item) => item.id)).toEqual(["upper-url", "lower-url"]);
  });

  it("treats GitHub owner and repo identity as case-insensitive", () => {
    const mixedCase = {
      ...evidence("github-mixed-case", "https://github.com/OpenAI/Returner", 40),
      platform: "github" as const,
      platformPostId: "OpenAI/Returner"
    };
    const lowerCase = {
      ...evidence("github-lower-case", "https://github.com/openai/returner", 50),
      platform: "github" as const,
      platformPostId: "openai/returner"
    };

    expect(hasEvidenceIdentityConflict(mixedCase)).toBe(false);
    expect(canonicalPostKey(mixedCase)).toBe(canonicalPostKey(lowerCase));
    expect(dedupeEvidenceForScoring([mixedCase, lowerCase]).map((item) => item.id)).toEqual([
      "github-lower-case"
    ]);
  });

  it("deduplicates a renamed or shared GitHub repository by immutable repository ID", () => {
    const companyProjection = {
      ...evidence("github-company", "https://github.com/acme/original-name", 40),
      platform: "github" as const,
      platformPostId: "acme/original-name",
      platformObjectId: "123456789"
    };
    const founderProjection = {
      ...evidence("github-founder", "https://github.com/acme-inc/renamed-repo", 50),
      platform: "github" as const,
      platformPostId: "acme-inc/renamed-repo",
      platformObjectId: "123456789"
    };

    expect(canonicalPostKey(companyProjection)).toBe("github:repository-object:123456789");
    expect(canonicalPostKey(founderProjection)).toBe("github:repository-object:123456789");
    expect(dedupeEvidenceForScoring([companyProjection, founderProjection]).map((item) => item.id)).toEqual([
      "github-founder"
    ]);
  });

  it("does not collapse different immutable GitHub repositories that reused one URL", () => {
    const original = {
      ...evidence("github-original", "https://github.com/acme/reused-name", 40),
      platform: "github" as const,
      platformPostId: "acme/reused-name",
      platformObjectId: "123456789"
    };
    const recreated = {
      ...evidence("github-recreated", "https://github.com/acme/reused-name", 50),
      platform: "github" as const,
      platformPostId: "acme/reused-name",
      platformObjectId: "987654321"
    };
    const legacyUrlOnly = {
      ...evidence("github-legacy", "https://github.com/acme/reused-name", 30),
      platform: "github" as const,
      platformPostId: "acme/reused-name",
      platformObjectId: null
    };

    expect(dedupeEvidenceForScoring([original, legacyUrlOnly, recreated]).map((item) => item.id)).toEqual([
      "github-original",
      "github-recreated"
    ]);
  });

  it("quarantines URL and explicit-ID conflicts from physical scoring", () => {
    const valid = {
      ...evidence("github-valid", "https://github.com/openai/returner", 50),
      platform: "github" as const,
      platformPostId: "openai/returner"
    };
    const conflicted = {
      ...evidence("github-conflicted", "https://github.com/openai/returner", 99),
      platform: "github" as const,
      platformPostId: "openai/different-repo"
    };

    expect(hasEvidenceIdentityConflict(conflicted)).toBe(true);
    expect(canonicalPostKey(conflicted)).not.toBe(canonicalPostKey(valid));
    expect(dedupeEvidenceForScoring([conflicted])).toEqual([]);
    expect(dedupeEvidenceForScoring([valid, conflicted]).map((item) => item.id)).toEqual(["github-valid"]);
  });

  it("accepts equivalent canonical and flattened Product Hunt IDs", () => {
    const canonicalId = {
      ...evidence(
        "product-hunt-canonical-id",
        "https://www.producthunt.com/products/insforge-alpha/launches/insforge-3",
        50
      ),
      platform: "product_hunt" as const,
      platformPostId: "products/insforge-alpha/launches/insforge-3"
    };
    const flattenedId = {
      ...canonicalId,
      id: "product-hunt-flattened-id",
      platformPostId: "insforge-alpha-insforge-3"
    };

    expect(hasEvidenceIdentityConflict(canonicalId)).toBe(false);
    expect(hasEvidenceIdentityConflict(flattenedId)).toBe(false);
    expect(canonicalPostKey(canonicalId)).toBe(canonicalPostKey(flattenedId));
  });

  it("prefers an eligible observation over a fresher blocked duplicate", () => {
    const eligible = {
      ...evidence("eligible", "https://x.com/allenxtech/status/12345", 20),
      platformPostId: "12345",
      linkStatus: "verified" as const,
      review_state: "verified" as const,
      observedAt: "2026-06-01T00:00:00Z",
      metricsCheckedAt: "2026-06-01T00:00:00Z"
    };
    const blocked = {
      ...evidence("blocked", "https://twitter.com/allenxtech/status/12345", 99),
      platformPostId: "12345",
      linkStatus: "blocked" as const,
      review_state: "verified" as const,
      metrics: { views: 99_000, likes: 9_000, replies: 900 },
      observedAt: "2100-01-01T00:00:00Z",
      metricsCheckedAt: "2100-01-01T00:00:00Z"
    };

    expect(dedupeEvidenceForScoring([eligible, blocked]).map((item) => item.id)).toEqual(["eligible"]);
    expect(dedupeEvidenceForScoring([blocked, eligible]).map((item) => item.id)).toEqual(["eligible"]);
    expect(dedupeEvidenceItems([eligible, blocked]).map((item) => item.id)).toEqual(["eligible"]);
  });

  it("keeps a fresher LinkedIn comment fragment from replacing its native parent", () => {
    const parentPostId = "7473269455783948288";
    const parentUrl =
      "https://www.linkedin.com/posts/lukasz-reszczynski-bio_pango-yc-s26-is-joining-y-combinator-today-activity-7473269455783948288-S_GE";
    const parent = {
      ...evidence("pango-parent", parentUrl, 80),
      entityType: "founder" as const,
      entityId: "founder-pango-lukasz-reszczynski",
      platform: "linkedin" as const,
      platformPostId: parentPostId,
      authorName: "Lukasz Reszczynski",
      authorHandle: "lukasz-reszczynski-bio",
      text: "Pango is joining Y Combinator",
      metrics: { reactions: 319, comments: 43, reposts: 0 },
      last_checked_at: "2026-07-15T23:15:00Z"
    };
    const comment = {
      ...evidence(
        "pango-comment",
        `${parentUrl}?commentUrn=urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A${parentPostId}%2C7473616064967266304%29`,
        99
      ),
      entityId: "company-pango",
      platform: "linkedin" as const,
      platformPostId: "7473616064967266304",
      authorName: "Pete Koomen",
      authorHandle: "petekoomen",
      text: "congrats, guys :)",
      metrics: { reactions: 3 },
      last_checked_at: "2026-07-16T01:50:22Z"
    };

    expect(canonicalPostKey(parent)).toBe(canonicalPostKey(comment));
    expect(dedupeEvidenceItems([parent, comment]).map((item) => item.id)).toEqual([
      "pango-parent",
      "pango-comment"
    ]);
    expect(dedupeEvidenceForScoring([parent, comment]).map((item) => item.id)).toEqual(["pango-parent"]);
    expect(dedupeEvidenceForScoring([comment, parent]).map((item) => item.id)).toEqual(["pango-parent"]);

    const sameEntityComment = { ...comment, entityType: parent.entityType, entityId: parent.entityId };
    expect(dedupeEvidenceItems([parent, sameEntityComment]).map((item) => item.id)).toEqual(["pango-parent"]);
  });

  it("keeps the same post attached to separate entities", () => {
    const items = [
      {
        ...evidence("company-a", "https://www.linkedin.com/posts/tarof_demo-activity-123", 50),
        platform: "linkedin" as const,
        platformPostId: "123",
        entityId: "company-a"
      },
      {
        ...evidence("company-b", "https://www.linkedin.com/posts/tarof_demo-activity-123", 50),
        platform: "linkedin" as const,
        platformPostId: "123",
        entityId: "company-b"
      }
    ];

    expect(dedupeEvidenceItems(items).map((item) => item.id)).toEqual(["company-a", "company-b"]);
  });
});

function evidence(id: string, sourceUrl: string, contributionScore: number): EvidenceItem {
  return {
    id,
    entityType: "company",
    entityId: "company-test",
    platform: "x",
    authorName: "Test",
    authorHandle: "test",
    postedAt: "2026-06-01T00:00:00Z",
    text: "Launch post",
    mediaType: "text",
    metrics: { views: contributionScore * 100 },
    contributionScore,
    sourceUrl,
    why: "test"
  };
}
