import { describe, expect, it } from "vitest";
import { selectRankedPosts } from "@/lib/graph/ranked-posts";
import type { RankedPostsSidecarScope } from "@/lib/graph/ranked-posts-sidecar";
import type { EvidenceItem, GraphNode, GraphResponse } from "@/lib/graph/types";

describe("ranked posts", () => {
  it("includes eligible company and founder evidence and physically deduplicates attachment rows", () => {
    const physicalCompanyCopy = evidence({ id: "company-copy", entityId: "company-1", contributionScore: 80 });
    const physicalFounderCopy = evidence({
      id: "founder-copy",
      entityType: "founder",
      entityId: "founder-1",
      attachedCompanyId: "company-1",
      contributionScore: 80
    });
    const founderOnly = evidence({
      id: "founder-only",
      entityType: "founder",
      entityId: "founder-1",
      sourceUrl: "https://x.com/founder/status/222",
      platformPostId: "222",
      contributionScore: 70
    });

    const ranked = selectRankedPosts(graph([physicalFounderCopy, founderOnly, physicalCompanyCopy]), {
      period: "all_time"
    });

    expect(ranked).toHaveLength(2);
    expect(ranked.map((item) => item.evidence.id)).toEqual(["company-copy", "founder-only"]);
    expect(ranked.filter((item) => item.canonicalPostKey === "x:post:111")).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      companyId: "company-1",
      companyName: "Example Company",
      sourceKind: "company",
      canonicalPostKey: "x:post:111"
    });
    expect(ranked[1]).toMatchObject({ companyId: "company-1", sourceKind: "founder" });
  });

  it("excludes unsupported, rejected, blocked, zero-score, malformed, and unscored evidence", () => {
    const candidates = [
      evidence({ id: "eligible" }),
      evidence({ id: "unsupported", platform: "web", sourceUrl: "https://example.com/post" }),
      evidence({ id: "rejected", review_state: "rejected" }),
      evidence({ id: "blocked", linkStatus: "blocked" }),
      evidence({ id: "zero", contributionScore: 0, normalizedScore: 0 }),
      evidence({ id: "malformed", sourceUrl: "https://x.com/profile" }),
      evidence({ id: "unscored", tractionStatus: "unscored", contributionScore: 50, normalizedScore: 50 })
    ];

    expect(selectRankedPosts(graph(candidates), { period: "all_time" }).map((item) => item.evidence.id))
      .toEqual(["eligible"]);
  });

  it("caps results at exactly 100 after eligibility and dedupe", () => {
    const candidates = Array.from({ length: 101 }, (_, index) =>
      evidence({
        id: `post-${index + 1}`,
        sourceUrl: `https://x.com/company/status/${index + 100}`,
        platformPostId: String(index + 100),
        contributionScore: 100 - index,
        normalizedScore: 100 - index
      })
    );

    const ranked = selectRankedPosts(graph(candidates), { period: "all_time" });
    expect(ranked).toHaveLength(100);
    expect(ranked.at(-1)?.evidence.id).toBe("post-100");
    expect(ranked.some((item) => item.evidence.id === "post-101")).toBe(false);
  });

  it("uses competition ranking for equal scores", () => {
    const ranked = selectRankedPosts(graph([
      evidence({ id: "first", normalizedScore: 90, sourceUrl: "https://x.com/c/status/901", platformPostId: "901" }),
      evidence({ id: "second", normalizedScore: 90, sourceUrl: "https://x.com/c/status/902", platformPostId: "902" }),
      evidence({ id: "third", normalizedScore: 80, sourceUrl: "https://x.com/c/status/903", platformPostId: "903" })
    ]), { period: "all_time" });

    expect(ranked.map((item) => item.rank)).toEqual([1, 1, 3]);
  });

  it("uses deterministic canonical tie ordering under shuffled input", () => {
    const candidates = [
      evidence({ id: "b", sourceUrl: "https://x.com/company/status/502", platformPostId: "502" }),
      evidence({ id: "a", sourceUrl: "https://x.com/company/status/501", platformPostId: "501" }),
      evidence({ id: "c", sourceUrl: "https://x.com/company/status/503", platformPostId: "503" })
    ];
    const forward = selectRankedPosts(graph(candidates), { period: "all_time" });
    const reversed = selectRankedPosts(graph([...candidates].reverse()), { period: "all_time" });

    expect(forward.map((item) => item.evidence.id)).toEqual(["a", "b", "c"]);
    expect(reversed.map((item) => item.evidence.id)).toEqual(forward.map((item) => item.evidence.id));
  });

  it("ranks by normalized score, raw engagement, publication time, URL, and stable ID", () => {
    const ranked = selectRankedPosts(graph([
      evidence({ id: "contribution-only", normalizedScore: undefined, contributionScore: 89, rawEngagement: 10, sourceUrl: "https://x.com/c/status/611", platformPostId: "611" }),
      evidence({ id: "normalized", normalizedScore: 90, contributionScore: 1, rawEngagement: 1, sourceUrl: "https://x.com/c/status/612", platformPostId: "612" }),
      evidence({ id: "engagement", normalizedScore: 89, rawEngagement: 20, sourceUrl: "https://x.com/c/status/613", platformPostId: "613" }),
      evidence({ id: "newer", normalizedScore: 89, rawEngagement: 10, postedAt: "2026-07-19T12:00:00.000Z", sourceUrl: "https://x.com/c/status/614", platformPostId: "614" })
    ]), { period: "all_time" });

    expect(ranked.map((item) => item.evidence.id)).toEqual([
      "normalized",
      "engagement",
      "newer",
      "contribution-only"
    ]);
  });

  it("never lets an unknown observation fallback outrank a genuine publication date", () => {
    const ranked = selectRankedPosts(graph([
      evidence({
        id: "unknown-newer-observation",
        postedAt: "2026-07-20T11:59:59.000Z",
        publishedAtPrecision: "unknown",
        sourceUrl: "https://x.com/c/status/621",
        platformPostId: "621"
      }),
      evidence({
        id: "genuine-older-publication",
        postedAt: "2026-07-01T12:00:00.000Z",
        publishedAtPrecision: "exact",
        sourceUrl: "https://x.com/c/status/622",
        platformPostId: "622"
      })
    ]), { period: "all_time" });

    expect(ranked.map((item) => item.evidence.id)).toEqual([
      "genuine-older-publication",
      "unknown-newer-observation"
    ]);
  });

  it("uses the America/Chicago publication day on both sides of midnight", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const ranked = selectRankedPosts(graph([
      evidence({ id: "before-midnight", postedAt: "2026-07-20T04:59:59.999Z", sourceUrl: "https://x.com/c/status/701", platformPostId: "701" }),
      evidence({ id: "at-midnight", postedAt: "2026-07-20T05:00:00.000Z", sourceUrl: "https://x.com/c/status/702", platformPostId: "702" }),
      evidence({ id: "later-today", postedAt: "2026-07-21T04:59:59.999Z", sourceUrl: "https://x.com/c/status/703", platformPostId: "703" }),
      evidence({ id: "unknown", postedAt: "unknown", sourceUrl: "https://x.com/c/status/704", platformPostId: "704" })
    ]), { period: "today", now });

    expect(ranked.map((item) => item.evidence.id)).toEqual(["at-midnight"]);
  });

  it("handles the Central daylight-saving boundary by calendar day", () => {
    const now = new Date("2026-03-08T18:00:00.000Z");
    const ranked = selectRankedPosts(graph([
      evidence({ id: "prior", postedAt: "2026-03-08T05:59:59.999Z", sourceUrl: "https://x.com/c/status/801", platformPostId: "801" }),
      evidence({ id: "start", postedAt: "2026-03-08T06:00:00.000Z", sourceUrl: "https://x.com/c/status/802", platformPostId: "802" }),
      evidence({ id: "later-today", postedAt: "2026-03-09T04:59:59.999Z", sourceUrl: "https://x.com/c/status/803", platformPostId: "803" })
    ]), { period: "today", now });

    expect(ranked.map((item) => item.evidence.id)).toEqual(["start"]);
  });

  it("fails closed for both missing and explicitly unknown publication precision", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const ranked = selectRankedPosts(graph([
      evidence({
        id: "legacy-missing-precision",
        postedAt: "2026-07-20T10:00:00.000Z",
        publishedAtPrecision: undefined,
        sourceUrl: "https://x.com/c/status/851",
        platformPostId: "851"
      }),
      evidence({
        id: "explicitly-unknown-precision",
        postedAt: "2026-07-20T11:00:00.000Z",
        publishedAtPrecision: "unknown",
        sourceUrl: "https://x.com/c/status/852",
        platformPostId: "852"
      })
    ]), { period: "today", now });

    expect(ranked).toEqual([]);
  });

  it("does not use refresh or observation clocks as the publication date", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const ranked = selectRankedPosts(graph([
      evidence({
        id: "refreshed-today",
        postedAt: "",
        publishedAtPrecision: "unknown",
        observedAt: "2026-07-20T10:00:00.000Z",
        metricsCheckedAt: "2026-07-20T10:00:00.000Z",
        first_seen_at: "2026-07-20T10:00:00.000Z",
        last_checked_at: "2026-07-20T10:00:00.000Z",
        last_updated_at: "2026-07-20T10:00:00.000Z",
        sourceUrl: "https://x.com/c/status/853",
        platformPostId: "853"
      })
    ]), { period: "today", now });

    expect(ranked).toEqual([]);
  });

  it("limits Month to the inclusive rolling 30-day window ending at now", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const ranked = selectRankedPosts(graph([
      evidence({
        id: "before-window",
        postedAt: "2026-06-20T11:59:59.999Z",
        sourceUrl: "https://x.com/c/status/901",
        platformPostId: "901"
      }),
      evidence({
        id: "window-start",
        postedAt: "2026-06-20T12:00:00.000Z",
        sourceUrl: "https://x.com/c/status/902",
        platformPostId: "902"
      }),
      evidence({
        id: "at-now",
        postedAt: "2026-07-20T12:00:00.000Z",
        sourceUrl: "https://x.com/c/status/903",
        platformPostId: "903"
      }),
      evidence({
        id: "future",
        postedAt: "2026-07-20T12:00:00.001Z",
        sourceUrl: "https://x.com/c/status/904",
        platformPostId: "904"
      }),
      evidence({
        id: "unknown-precision",
        postedAt: "2026-07-19T12:00:00.000Z",
        publishedAtPrecision: "unknown",
        sourceUrl: "https://x.com/c/status/905",
        platformPostId: "905"
      }),
      evidence({
        id: "missing-precision",
        postedAt: "2026-07-19T12:00:00.000Z",
        publishedAtPrecision: undefined,
        sourceUrl: "https://x.com/c/status/906",
        platformPostId: "906"
      })
    ]), { period: "month", now });

    expect(ranked.map((item) => item.evidence.id)).toEqual(["at-now", "window-start"]);
  });

  it("merges rankable full-corpus overflow beyond the published graph preview", () => {
    const preview = evidence({
      id: "preview-post",
      normalizedScore: 70,
      contributionScore: 70,
      sourceUrl: "https://x.com/company/status/970",
      platformPostId: "970"
    });
    const overflow = evidence({
      id: "overflow-post",
      normalizedScore: 95,
      contributionScore: 95,
      sourceUrl: "https://x.com/company/status/971",
      platformPostId: "971"
    });

    const ranked = selectRankedPosts(graph([preview]), {
      period: "all_time",
      sidecarScope: sidecarScope([overflow], { "company-1": 1 })
    });

    expect(ranked.map((item) => item.evidence.id)).toEqual(["overflow-post", "preview-post"]);
  });

  it("fails closed on overflow when an evidence facet has reduced preview coverage", () => {
    const preview = evidence({ id: "visible-preview" });
    const overflow = evidence({
      id: "must-not-leak",
      sourceUrl: "https://x.com/company/status/972",
      platformPostId: "972"
    });

    const ranked = selectRankedPosts(graph([preview]), {
      period: "all_time",
      sidecarScope: sidecarScope([overflow], { "company-1": 2 })
    });

    expect(ranked.map((item) => item.evidence.id)).toEqual(["visible-preview"]);
  });
});

function graph(evidenceItems: EvidenceItem[]): GraphResponse {
  const node = companyNode();
  return {
    batch: { slug: "S2026", label: "Test batch" },
    batches: [{ slug: "S2026", label: "Test batch" }],
    nodes: [node],
    edges: [],
    leaderboard: [],
    fastestGaining: [],
    needsReview: [],
    evidence: evidenceItems,
    platformStatus: [],
    selectedTopVoiceAudience: audience(),
    topVoiceAudiences: [audience()],
    generatedAt: "2026-07-20T12:00:00.000Z",
    mode: "official_snapshot"
  };
}

function companyNode(): GraphNode {
  return {
    id: "company:company-1",
    entityType: "company",
    entityId: "company-1",
    label: "Example Company",
    batchSlug: "S2026",
    score: 88,
    previousScore: 80,
    scoreDelta: 8,
    radius: 30,
    topPlatform: "x",
    platformScores: { x: 88 },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl: "https://example.com/company",
    websiteUrl: "https://example.com",
    tagline: "Example",
    description: "Example company",
    groupPartner: null,
    primaryIndustry: "b2b",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://example.com/company",
    visual: {
      industryColor: "#fff",
      shape: "ellipse",
      borderStyle: "solid",
      borderColor: "#000",
      groupRegion: null
    },
    industries: ["b2b"],
    relatedEntityIds: ["founder-1"],
    founders: [{
      id: "founder-1",
      name: "Founder One",
      ycProfileUrl: "https://example.com/founder",
      socialAccounts: [],
      evidenceIds: [],
      platformScores: { x: 70 }
    }],
    review_state_counts: { verified: 0, needs_review: 0, rejected: 0 }
  };
}

function evidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "eligible",
    entityType: "company",
    entityId: "company-1",
    platform: "x",
    authorName: "Example Company",
    authorHandle: "example",
    postedAt: "2026-07-18T12:00:00.000Z",
    publishedAtPrecision: "exact",
    text: "We reached 10,000 users.",
    mediaType: "text",
    metrics: { likes: 100 },
    contributionScore: 80,
    normalizedScore: 80,
    rawEngagement: 100,
    tractionStatus: "scored",
    sourceUrl: "https://x.com/company/status/111",
    platformPostId: "111",
    why: "Verified native evidence.",
    review_state: "verified",
    linkStatus: "verified",
    ...overrides
  };
}

function audience() {
  return {
    id: "off" as const,
    displayName: "All voices",
    description: "All evidence",
    helperText: "All evidence",
    scoreLabel: "Traction score",
    scoreDescription: "Canonical score",
    active: true,
    memberCount: 0
  };
}

function sidecarScope(
  overflow: EvidenceItem[],
  previewRankableByCompany: Record<string, number>
): RankedPostsSidecarScope {
  return {
    previewGeneratedAt: "2026-07-20T12:00:00.000Z",
    sourceEvidenceCount: overflow.length + 1,
    previewEvidenceCount: 1,
    fullRankableCount: overflow.length + 1,
    previewRankableCount: 1,
    overflowRankableCount: overflow.length,
    fullRankableDigest: "0".repeat(64),
    representedRankableDigest: "0".repeat(64),
    crossAudiencePreviewProjectionCount: 0,
    crossAudiencePreviewProjectionKeys: [],
    previewRankableByCompany,
    fullRankableByCompany: { "company-1": overflow.length + 1 },
    evidence: overflow
  };
}
