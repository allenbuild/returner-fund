import { describe, expect, it } from "vitest";
import { clusterDashboardCandidates } from "@/lib/dashboard/clustering";
import {
  DASHBOARD_MIN_SOCIAL_VIEWS,
  type DashboardCandidate
} from "@/lib/dashboard/contracts";
import {
  buildDashboardSnapshot,
  dashboardTop100Eligibility,
  dashboardTop100SurfacingScore
} from "@/lib/dashboard/pipeline";
import {
  crossPlatformConfirmationScore,
  freshnessScore,
  platformNormalizedSignificance,
  relativeViralityScore,
  sourceQualityScore,
  velocityScore
} from "@/lib/dashboard/scoring";
import { compactSentence } from "@/lib/dashboard/normalization";

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("technology dashboard pipeline", () => {
  it("uses an exact rolling 72-hour window and excludes stale, future, and invalid candidates", () => {
    const result = buildDashboardSnapshot([
      dashboardCandidate({
        id: "at-window-start",
        publishedAt: "2026-08-12T12:00:00.000Z"
      }),
      dashboardCandidate({
        id: "one-millisecond-stale",
        publishedAt: "2026-08-12T11:59:59.999Z"
      }),
      dashboardCandidate({
        id: "future",
        publishedAt: "2026-08-15T12:00:00.001Z"
      }),
      dashboardCandidate({
        id: "invalid-date",
        publishedAt: "not-a-date"
      })
    ], {
      now: NOW,
      platformFailures: ["youtube:timeout", "reddit:rate_limited", "youtube:timeout"]
    });

    expect(result.snapshot.windowStart).toBe("2026-08-12T12:00:00.000Z");
    expect(result.snapshot.windowEnd).toBe(NOW.toISOString());
    expect(result.snapshot.stories).toHaveLength(1);
    expect(result.snapshot.stories[0]?.sources.map((source) => source.id)).toEqual(["at-window-start"]);
    expect(result.snapshot.status).toMatchObject({
      candidateCount: 4,
      eligibleCandidateCount: 1,
      storyCount: 1,
      partialPlatformFailures: ["reddit:rate_limited", "youtube:timeout"]
    });
  });

  it("builds the Top 100 from 70 qualifying viral posts and 30 metricless news reports", () => {
    const socialPosts = Array.from({ length: 70 }, (_, index) => dashboardCandidate({
      id: `viral-social-${String(index).padStart(3, "0")}`,
      canonicalKey: `x:viral-social-${index}`,
      title: `Company ${index} launches an AI agent platform`,
      text: `Company ${index} launches an AI agent platform for software teams.`,
      publishedAt: "2026-08-13T12:00:00.000Z",
      metrics: { views: 2_000_000 - index, likes: 4_000 - index, reposts: 400 - index },
      trackedEntity: {
        companyId: `company-${index}`,
        name: `Company ${index}`,
        cohortLabel: "YC S26",
        batchSlug: "S26"
      },
      topics: ["launches", "ai"]
    }));
    const freshMetriclessNews = Array.from({ length: 30 }, (_, index) => dashboardCandidate({
      id: `fresh-news-${index}`,
      canonicalKey: `web:fresh-news-${index}`,
      platform: "web",
      sourceKind: "article",
      url: `https://publisher-${index}.example.com/fresh-${index}`,
      title: `Independent technology report ${index}`,
      metrics: {},
      independentlyReported: true
    }));

    const result = buildDashboardSnapshot([...freshMetriclessNews, ...socialPosts], { now: NOW });

    expect(result.snapshot.stories).toHaveLength(100);
    expect(result.snapshot.status.storyCount).toBe(100);
    expect(result.snapshot.status.viewStoryCounts.hottest).toBe(100);
    expect(result.snapshot.stories.filter((story) => story.sources[0]?.nativePlatform === "x")).toHaveLength(70);
    expect(result.snapshot.stories.filter((story) => story.sources[0]?.sourceKind === "article")).toHaveLength(30);
    expect(result.snapshot.stories.some((story) => story.sources[0]?.metrics.views === undefined)).toBe(true);
  });

  it("hard-gates stale, low-reach, unverified, imprecise, and non-technical social posts", () => {
    const personal = dashboardCandidate({
      id: "personal-founder-post",
      canonicalKey: "x:personal-founder-post",
      title: "Our founder's plants are thriving",
      text: "A weekend outside with friends and plants.",
      publishedAt: "2026-08-13T12:00:00.000Z",
      metrics: { views: 2_000_000, likes: 80_000 },
      socialBackfillEligible: true,
      trackedEntity: {
        companyId: "company-personal",
        name: "Personal Company",
        cohortLabel: "YC S26",
        batchSlug: "S26"
      }
    });
    const unverified = dashboardCandidate({
      id: "unverified-company-post",
      canonicalKey: "x:unverified-company-post",
      title: "We launched an AI agent platform",
      publishedAt: "2026-08-13T12:00:00.000Z",
      metrics: { views: 2_000_000, likes: 80_000 },
      sourceVerified: false,
      trackedEntity: {
        companyId: "company-unverified",
        name: "Unverified Company",
        cohortLabel: "YC S26",
        batchSlug: "S26"
      },
      topics: ["launches", "ai"]
    });
    const belowReach = dashboardCandidate({
      id: "below-reach",
      metrics: { views: DASHBOARD_MIN_SOCIAL_VIEWS - 1, likes: 80_000 }
    });
    const imprecise = dashboardCandidate({
      id: "imprecise",
      publicationPrecision: "unknown"
    });
    const stale = dashboardCandidate({
      id: "stale",
      publishedAt: "2026-08-12T11:59:59.999Z"
    });
    const missingVerificationProof = dashboardCandidate({
      id: "missing-verification-proof",
      sourceVerified: undefined
    });
    const uncheckedLink = dashboardCandidate({
      id: "unchecked-link",
      sourceLinkStatus: "unchecked"
    });
    const missingPrecisionProof = dashboardCandidate({
      id: "missing-precision-proof",
      publicationPrecision: undefined
    });

    expect(dashboardTop100Eligibility(personal, NOW)).toMatchObject({ eligible: false, reason: "unverified_source" });
    expect(dashboardTop100Eligibility(unverified, NOW)).toMatchObject({ eligible: false, reason: "unverified_source" });
    expect(dashboardTop100Eligibility(belowReach, NOW)).toMatchObject({ eligible: false, reason: "below_one_million_views" });
    expect(dashboardTop100Eligibility(imprecise, NOW)).toMatchObject({ eligible: false, reason: "missing_precise_publication_date" });
    expect(dashboardTop100Eligibility(stale, NOW)).toMatchObject({ eligible: false, reason: "outside_72_hour_window" });
    expect(dashboardTop100Eligibility(missingVerificationProof, NOW)).toMatchObject({ eligible: false, reason: "unverified_source" });
    expect(dashboardTop100Eligibility(uncheckedLink, NOW)).toMatchObject({ eligible: false, reason: "invalid_link" });
    expect(dashboardTop100Eligibility(missingPrecisionProof, NOW)).toMatchObject({ eligible: false, reason: "missing_precise_publication_date" });
    expect(buildDashboardSnapshot([
      personal,
      unverified,
      belowReach,
      imprecise,
      stale,
      missingVerificationProof,
      uncheckedLink,
      missingPrecisionProof
    ], { now: NOW }).snapshot.stories).toEqual([]);
  });

  it("recognizes an exact laptop signal without relaxing the reach, recency, or topic gates", () => {
    const exactUnboxLaptop = dashboardCandidate({
      id: "youtube:ip0W9lCXpio",
      canonicalKey: "youtube:video:ip0W9lCXpio",
      platform: "youtube",
      sourceKind: "video",
      url: "https://www.youtube.com/watch?v=ip0W9lCXpio",
      title: "The Snapdragon Multi-Day Battery Laptop",
      summary: "Sponsored by Snapdragon.",
      text: "The Snapdragon Multi-Day Battery Laptop Sponsored by Snapdragon.",
      topics: [],
      metrics: { views: DASHBOARD_MIN_SOCIAL_VIEWS }
    });

    expect(dashboardTop100Eligibility(exactUnboxLaptop, NOW)).toMatchObject({
      eligible: true,
      reason: "eligible"
    });

    const belowReach = dashboardCandidate({
      id: "snapdragon-below-reach",
      title: "The Snapdragon multi-day battery laptop",
      text: "Sponsored by Snapdragon.",
      topics: [],
      metrics: { views: DASHBOARD_MIN_SOCIAL_VIEWS - 1 }
    });
    const stale = dashboardCandidate({
      id: "snapdragon-stale",
      title: "The Snapdragon multi-day battery laptop",
      text: "Sponsored by Snapdragon.",
      topics: [],
      publishedAt: "2026-08-12T11:59:59.999Z",
      metrics: { views: 2_000_000 }
    });
    const ambiguousNonTechPosts = [
      dashboardCandidate({
        id: "food-processor",
        title: "My favorite food processor",
        text: "Preparing dinner for friends tonight.",
        topics: [],
        metrics: { views: 2_000_000 }
      }),
      dashboardCandidate({
        id: "ssd-disability",
        title: "Living with SSD disability",
        text: "A personal accessibility story.",
        topics: [],
        metrics: { views: 2_000_000 }
      }),
      dashboardCandidate({
        id: "snapdragon-flowers",
        title: "Snapdragon flowers are blooming",
        text: "A colorful spring garden update.",
        topics: [],
        metrics: { views: 2_000_000 }
      })
    ];

    expect(dashboardTop100Eligibility(belowReach, NOW)).toMatchObject({
      eligible: false,
      reason: "below_one_million_views"
    });
    expect(dashboardTop100Eligibility(stale, NOW)).toMatchObject({
      eligible: false,
      reason: "outside_72_hour_window"
    });
    for (const candidate of ambiguousNonTechPosts) {
      expect(dashboardTop100Eligibility(candidate, NOW)).toMatchObject({
        eligible: false,
        reason: "unverified_source"
      });
    }
  });

  it("recognizes a concrete Redmi Note product-series signal without relaxing the million-view gate", () => {
    const verifiedProductPost = dashboardCandidate({
      id: "instagram:DcZYQjeCUd1",
      canonicalKey: "instagram:post:DcZYQjeCUd1",
      platform: "instagram",
      sourceKind: "video",
      url: "https://www.instagram.com/reel/DcZYQjeCUd1",
      title: "A finish that changes with every turn of the light. See what's coming to the #REDMINote17Series.",
      text: "A finish that changes with every turn of the light. See what's coming to the #REDMINote17Series.",
      topics: [],
      metrics: { views: DASHBOARD_MIN_SOCIAL_VIEWS }
    });
    const belowReach = dashboardCandidate({
      ...verifiedProductPost,
      id: "instagram:redmi-below-reach",
      canonicalKey: "instagram:post:redmi-below-reach",
      url: "https://www.instagram.com/reel/redmi-below-reach",
      metrics: { views: DASHBOARD_MIN_SOCIAL_VIEWS - 1 }
    });

    expect(dashboardTop100Eligibility(verifiedProductPost, NOW)).toMatchObject({
      eligible: true,
      reason: "eligible"
    });
    expect(dashboardTop100Eligibility(belowReach, NOW)).toMatchObject({
      eligible: false,
      reason: "below_one_million_views"
    });
  });

  it("counts every terminal eligibility reason after physical-source deduplication", () => {
    const eligible = dashboardCandidate({ id: "eligible" });
    const result = buildDashboardSnapshot([
      eligible,
      eligible,
      dashboardCandidate({
        id: "outside-window",
        publishedAt: "2026-08-12T11:59:59.999Z"
      }),
      dashboardCandidate({
        id: "missing-precision",
        publicationPrecision: "unknown"
      }),
      dashboardCandidate({
        id: "unverified",
        sourceVerified: false
      }),
      dashboardCandidate({
        id: "invalid-link",
        sourceLinkStatus: "unchecked"
      }),
      dashboardCandidate({
        id: "missing-article-content",
        canonicalKey: "web:missing-article-content",
        platform: "web",
        sourceKind: "article",
        url: "https://publisher.example.com/empty",
        title: "",
        summary: "",
        text: "",
        metrics: {},
        independentlyReported: true
      }),
      dashboardCandidate({
        id: "below-minimum-views",
        metrics: { views: DASHBOARD_MIN_SOCIAL_VIEWS - 1 }
      }),
      dashboardCandidate({
        id: "unsupported-content",
        canonicalKey: "github:unsupported-content",
        platform: "github",
        sourceKind: "repository",
        url: "https://github.com/example/unsupported-content"
      })
    ], { now: NOW });

    expect(result.diagnostics.duplicateSourcesRemoved).toBe(1);
    expect(result.diagnostics.eligibilityReasonDistribution).toEqual({
      eligible: 1,
      outside_72_hour_window: 1,
      missing_precise_publication_date: 1,
      unverified_source: 1,
      invalid_link: 1,
      missing_article_content: 1,
      below_one_million_views: 1,
      unsupported_content: 1
    });
    expect(Object.values(result.diagnostics.eligibilityReasonDistribution).reduce((sum, count) => sum + count, 0)).toBe(8);
  });

  it("uses broad candidates for clustering but excludes them from published sources and scoring", () => {
    const qualifiedNews = dashboardCandidate({
      id: "qualified-news",
      canonicalKey: "web:qualified-news",
      platform: "web",
      sourceKind: "article",
      url: "https://publisher.example.com/shared-launch",
      destinationUrl: "https://product.example.com/shared-launch",
      title: "Publisher reports a shared AI launch",
      metrics: { comments: 25 },
      independentlyReported: true
    });
    const unqualifiedBridge = dashboardCandidate({
      id: "unqualified-bridge",
      canonicalKey: "x:unqualified-bridge",
      url: "https://x.example.com/unqualified-bridge",
      destinationUrl: "https://product.example.com/shared-launch",
      title: "Shared AI launch reaches a huge audience",
      metrics: { views: 100_000_000, likes: 5_000_000 },
      sourceVerified: undefined
    });

    const result = buildDashboardSnapshot([qualifiedNews, unqualifiedBridge], { now: NOW }).snapshot;

    expect(result.stories).toHaveLength(1);
    expect(result.stories[0]?.sources.map((source) => source.id)).toEqual(["qualified-news"]);
    expect(result.stories[0]?.sourceCount).toBe(1);
    expect(result.stories[0]?.engagement).toEqual({ comments: 25 });
    expect(result.stories[0]?.trendScore).toBe(dashboardTop100SurfacingScore([qualifiedNews], NOW).total);
  });

  it("uses auditable reach and coverage formulas for viral posts and news", () => {
    const viral = dashboardCandidate({
      id: "viral-score",
      publishedAt: "2026-08-15T00:00:00.000Z",
      metrics: { views: 4_000_000, likes: 80_000, comments: 20_000 }
    });
    const viralScore = dashboardTop100SurfacingScore([viral], NOW);

    expect(viralScore).toMatchObject({
      formula: "viral-reach-v1",
      reach: 32.5,
      velocity: 21,
      engagement: 3.8,
      freshness: 8.3
    });
    expect(viralScore.total).toBe(65.6);
    expect(viralScore.reasons).toEqual(expect.arrayContaining([
      "4,000,000 verified native views",
      "333,333 views/hour since publication"
    ]));

    const news = Array.from({ length: 5 }, (_, index) => dashboardCandidate({
      id: `news-score-${index}`,
      canonicalKey: `web:news-score-${index}`,
      platform: "web",
      sourceKind: "article",
      url: `https://news-score-${index}.example.com/report`,
      title: `Publisher ${index} reports a distinct robotics benchmark`,
      publisher: `Publisher ${index}`,
      metrics: { comments: 100 },
      independentlyReported: true
    }));
    const newsScore = dashboardTop100SurfacingScore(news, NOW);

    expect(newsScore.formula).toBe("news-coverage-v1");
    expect(newsScore.sourceCoverage).toBe(25);
    expect(newsScore.completeness).toBe(7.5);
    expect(newsScore.total).toBeCloseTo(
      newsScore.newsAttention + newsScore.sourceCoverage + newsScore.freshness + newsScore.completeness,
      5
    );
    expect(newsScore.reasons).toContain("5 distinct public sources cover this story");
  });

  it("enforces first-pass publisher and platform caps, then backfills unused capacity", () => {
    const cappedPublisher = Array.from({ length: 4 }, (_, index) => dashboardCandidate({
      id: `same-publisher-${index}`,
      canonicalKey: `web:same-publisher-${index}`,
      platform: "web",
      sourceKind: "article",
      url: `https://dominant.example.com/report-${index}`,
      title: `Dominant publisher report distinctsignal${index}`,
      metrics: { comments: 1_000_000 - index },
      independentlyReported: true
    }));
    const diverseNews = Array.from({ length: 27 }, (_, index) => dashboardCandidate({
      id: `diverse-news-${index}`,
      canonicalKey: `web:diverse-news-${index}`,
      platform: "web",
      sourceKind: "article",
      url: `https://diverse-${index}.example.com/report`,
      title: `Diverse publisher report uniquenews${index}`,
      metrics: {},
      independentlyReported: true
    }));
    const xPosts = Array.from({ length: 31 }, (_, index) => dashboardCandidate({
      id: `x-cap-${index}`,
      canonicalKey: `x:x-cap-${index}`,
      title: `X launch uniqueviralx${index} AI software`,
      metrics: { views: 50_000_000 - index, likes: 50_000 }
    }));
    const youtubePosts = Array.from({ length: 30 }, (_, index) => dashboardCandidate({
      id: `youtube-cap-${index}`,
      canonicalKey: `youtube:youtube-cap-${index}`,
      platform: "youtube",
      sourceKind: "video",
      url: `https://youtube.com/watch?v=cap-${index}`,
      title: `Video launch uniqueviraly${index} AI software`,
      metrics: { views: 2_000_000 - index, likes: 5_000 }
    }));
    const instagramPosts = Array.from({ length: 10 }, (_, index) => dashboardCandidate({
      id: `instagram-cap-${index}`,
      canonicalKey: `instagram:instagram-cap-${index}`,
      platform: "instagram",
      sourceKind: "video",
      url: `https://instagram.com/reel/cap-${index}`,
      title: `Reel launch uniqueviralinstagram${index} AI software`,
      metrics: { views: 1_500_000 - index, likes: 4_000 }
    }));

    const capped = buildDashboardSnapshot(
      [...cappedPublisher, ...diverseNews, ...xPosts, ...youtubePosts, ...instagramPosts],
      { now: NOW }
    ).snapshot;
    expect(capped.stories).toHaveLength(100);
    expect(capped.stories.filter((story) => story.sources[0]?.nativePlatform === "x")).toHaveLength(30);
    expect(capped.stories.filter((story) => story.sources[0]?.nativePlatform === "youtube")).toHaveLength(30);
    expect(capped.stories.filter((story) => story.sources[0]?.nativePlatform === "instagram")).toHaveLength(10);
    expect(capped.stories.filter((story) => story.sources[0]?.url.includes("dominant.example.com"))).toHaveLength(3);

    const underfilledViral = xPosts.slice(0, 2);
    const newsForBackfill = [...cappedPublisher, ...diverseNews];
    const backfilled = buildDashboardSnapshot([...newsForBackfill, ...underfilledViral], {
      now: NOW,
      limit: 10
    }).snapshot;
    expect(backfilled.stories).toHaveLength(10);
    expect(backfilled.stories.filter((story) => story.sources[0]?.nativePlatform === "x")).toHaveLength(2);
    expect(backfilled.stories.filter((story) => story.sources[0]?.sourceKind === "article")).toHaveLength(8);
  });

  it("clusters six independent destinations into one stable cross-platform story", () => {
    const platforms = ["x", "reddit", "hacker_news", "youtube", "web", "github"] as const;
    const sixSourceLaunch = platforms.map((platform, index) => dashboardCandidate({
      id: `orbit-${platform}`,
      canonicalKey: `${platform}:orbit-${index}`,
      platform,
      sourceKind: platform === "youtube" ? "video" : platform === "github" ? "repository" : "article",
      url: `https://${platform}.example.com/orbit-${index}`,
      destinationUrl: "https://acme.example.com/orbit?utm_source=dashboard-test",
      title: "Acme launches Orbit distributed training platform",
      entityKeys: ["company:acme", "product:orbit"],
      independentlyReported: platform !== "x"
    }));

    const forward = clusterDashboardCandidates(sixSourceLaunch);
    const reversed = clusterDashboardCandidates([...sixSourceLaunch].reverse());
    const result = buildDashboardSnapshot(sixSourceLaunch, { now: NOW });

    expect(forward).toHaveLength(1);
    expect(forward[0]?.candidates).toHaveLength(6);
    expect(reversed).toEqual(forward);
    expect(result.snapshot.stories).toHaveLength(1);
    expect(result.snapshot.stories[0]).toMatchObject({
      sourceCount: 5,
      independentSourceCount: 4
    });
    expect(result.snapshot.stories[0]?.sources.map((source) => source.id).sort()).toEqual(
      sixSourceLaunch.filter((source) => source.platform !== "github").map((source) => source.id).sort()
    );
  });

  it("keeps a story identity when later corroborating coverage adds a different adapter key or URL", () => {
    const primary = dashboardCandidate({
      id: "orbit-release",
      canonicalKey: "x:acme-orbit-release",
      platform: "x",
      sourceKind: "post",
      url: "https://x.example.com/acme/status/orbit-v1",
      destinationUrl: "https://acme.example.com/orbit/v1",
      title: "Acme launches Orbit distributed training platform",
      text: "Orbit is a distributed training platform for production AI teams.",
      entityKeys: ["company:acme", "product:orbit"],
      independentlyReported: false,
      publishedAt: "2026-08-15T10:00:00.000Z"
    });
    const corroboration = dashboardCandidate({
      id: "orbit-news",
      canonicalKey: "web:orbit-news",
      platform: "web",
      sourceKind: "article",
      url: "https://news.example.com/acme-orbit-launch",
      destinationUrl: "https://aaa.example.com/another-link",
      storyKey: "aaa-third-party-adapter-key",
      title: "Acme launches Orbit distributed training platform",
      text: "Independent coverage of Orbit, a distributed training platform for production AI teams.",
      entityKeys: ["company:acme", "product:orbit"],
      independentlyReported: true,
      publishedAt: "2026-08-15T11:00:00.000Z"
    });

    const primaryOnly = clusterDashboardCandidates([primary]);
    const withCorroboration = clusterDashboardCandidates([primary, corroboration]);
    const afterCorroborationExpires = clusterDashboardCandidates([primary]);
    const primaryStory = buildDashboardSnapshot([primary], { now: NOW }).snapshot.stories[0];
    const corroboratedStory = buildDashboardSnapshot([primary, corroboration], { now: NOW }).snapshot.stories[0];

    expect(withCorroboration).toHaveLength(1);
    expect(withCorroboration[0]?.stableKey).toBe(primaryOnly[0]?.stableKey);
    expect(afterCorroborationExpires[0]?.stableKey).toBe(primaryOnly[0]?.stableKey);
    expect(clusterDashboardCandidates([corroboration, primary])).toEqual(withCorroboration);
    expect(corroboratedStory?.stableKey).toBe(primaryStory?.stableKey);
  });

  it("keeps two nearby events from the same company separate without a shared destination", () => {
    const trackedEntity = {
      companyId: "acme",
      name: "Acme",
      cohortLabel: "YC S26",
      batchSlug: "S26"
    };
    const candidates = [
      dashboardCandidate({
        id: "orbit-launch",
        canonicalKey: "x:orbit-launch",
        title: "Acme launches Orbit database",
        text: "A new distributed database for AI applications.",
        trackedEntity,
        entityKeys: ["company:acme", "product:orbit"]
      }),
      dashboardCandidate({
        id: "series-a",
        canonicalKey: "x:series-a",
        title: "Acme raises Series A financing",
        text: "The financing supports enterprise expansion.",
        trackedEntity,
        entityKeys: ["company:acme"]
      })
    ];

    const clusters = clusterDashboardCandidates(candidates);
    const result = buildDashboardSnapshot(candidates, { now: NOW });

    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((cluster) => cluster.stableKey)).size).toBe(2);
    expect(result.snapshot.stories).toHaveLength(2);
    expect(result.snapshot.stories.every((story) => story.sourceCount === 1)).toBe(true);
  });

  it("rewards relative performance rather than raw audience size", () => {
    const smallAccountBreakout = dashboardCandidate({
      id: "small-breakout",
      metrics: { likes: 5_000 },
      accountBaseline: { likes: 100 },
      followerCount: 20_000
    });
    const largeAccountAverage = dashboardCandidate({
      id: "large-average",
      metrics: { likes: 10_000 },
      accountBaseline: { likes: 10_000 },
      followerCount: 5_000_000
    });

    expect(relativeViralityScore(smallAccountBreakout)).toBeGreaterThan(
      relativeViralityScore(largeAccountAverage)
    );
    expect(relativeViralityScore(largeAccountAverage)).toBe(50);
    expect(relativeViralityScore(dashboardCandidate({ id: "unobserved-relative", metrics: {} }))).toBe(0);
    expect(relativeViralityScore(dashboardCandidate({ id: "unbaselined-relative", metrics: { likes: 2 } }))).toBe(0);
  });

  it("normalizes absolute attention within each platform instead of comparing raw counts globally", () => {
    const candidates = [
      dashboardCandidate({ id: "x-low", platform: "x", metrics: { likes: 50 } }),
      dashboardCandidate({ id: "x-high", platform: "x", metrics: { likes: 50_000 } }),
      dashboardCandidate({ id: "reddit-low", platform: "reddit", metrics: { upvotes: 5 } }),
      dashboardCandidate({ id: "reddit-high", platform: "reddit", metrics: { upvotes: 500 } })
    ];
    const scores = platformNormalizedSignificance(candidates);

    expect(scores.get("x-high")).toBe(100);
    expect(scores.get("reddit-high")).toBe(100);
    expect(scores.get("x-low")).toBe(15);
    expect(scores.get("reddit-low")).toBe(15);
  });

  it("does not invent platform significance for metricless sources from their ID order", () => {
    const candidates = [
      dashboardCandidate({ id: "rss-no-metrics-z", platform: "rss", sourceKind: "article", metrics: {} }),
      dashboardCandidate({ id: "rss-no-metrics-a", platform: "rss", sourceKind: "article", metrics: {} }),
      dashboardCandidate({ id: "rss-observed-low", platform: "rss", sourceKind: "article", metrics: { views: 10_000 } }),
      dashboardCandidate({ id: "rss-observed-high", platform: "rss", sourceKind: "article", metrics: { views: 1_000_000 } })
    ];
    const scores = platformNormalizedSignificance(candidates);
    const allMetricless = platformNormalizedSignificance([
      dashboardCandidate({ id: "metricless-z", platform: "web", sourceKind: "article", metrics: {} }),
      dashboardCandidate({ id: "metricless-a", platform: "web", sourceKind: "article", metrics: {} })
    ]);
    const singletonHackerNews = platformNormalizedSignificance([
      dashboardCandidate({
        id: "hn-singleton-low-signal",
        platform: "hacker_news",
        sourceKind: "discussion",
        metrics: { upvotes: 2, comments: 1 }
      })
    ]);

    expect(scores.get("rss-no-metrics-z")).toBe(0);
    expect(scores.get("rss-no-metrics-a")).toBe(0);
    expect(scores.get("rss-observed-low")).toBe(15);
    expect(scores.get("rss-observed-high")).toBe(100);
    expect(allMetricless.get("metricless-z")).toBe(0);
    expect(allMetricless.get("metricless-a")).toBe(0);
    expect(singletonHackerNews.get("hn-singleton-low-signal")).toBe(15);

    const singletonHackerNewsStory = dashboardCandidate({
      id: "hn-singleton-story",
      canonicalKey: "hacker_news:hn-singleton-story",
      platform: "hacker_news",
      sourceKind: "discussion",
      url: "https://news.ycombinator.com/item?id=1234567",
      destinationUrl: "https://example.com/hn-singleton-story",
      title: "HN discussion with two upvotes",
      metrics: { upvotes: 2, comments: 1 },
      independentlyReported: true
    });
    const unmeasuredIndependentArticle = dashboardCandidate({
      id: "unmeasured-independent-article",
      canonicalKey: "rss:unmeasured-independent-article",
      platform: "rss",
      sourceKind: "article",
      url: "https://publisher.example.com/unmeasured-independent-article",
      destinationUrl: "https://publisher.example.com/unmeasured-independent-article",
      title: "Independent technology reporting without a public view counter",
      metrics: {},
      independentlyReported: true
    });
    const singletonResult = buildDashboardSnapshot([singletonHackerNewsStory, unmeasuredIndependentArticle], { now: NOW });

    expect(storyContaining(singletonResult.snapshot.stories, unmeasuredIndependentArticle.id).rank).toBe(1);
    expect(singletonResult.snapshot.stories.some((story) =>
      story.sources.some((source) => source.id === singletonHackerNewsStory.id)
    )).toBe(false);
  });

  it("uses observed velocity and decaying freshness without inventing a single-scrape trend", () => {
    const fast = dashboardCandidate({
      id: "fast",
      publishedAt: "2026-08-15T10:00:00.000Z",
      metricHistory: [
        { observedAt: "2026-08-15T10:30:00.000Z", metrics: { likes: 10 } },
        { observedAt: "2026-08-15T11:30:00.000Z", metrics: { likes: 510 } }
      ]
    });
    const slow = dashboardCandidate({
      id: "slow",
      publishedAt: "2026-08-15T10:00:00.000Z",
      metricHistory: [
        { observedAt: "2026-08-15T10:30:00.000Z", metrics: { likes: 10 } },
        { observedAt: "2026-08-15T11:30:00.000Z", metrics: { likes: 12 } }
      ]
    });

    expect(velocityScore(fast, NOW)).toBeGreaterThan(velocityScore(slow, NOW));
    expect(velocityScore(slow, NOW)).toBeGreaterThan(0);
    expect(velocityScore(dashboardCandidate({ id: "single-observation" }), NOW)).toBe(0);
    expect(freshnessScore(NOW.toISOString(), NOW)).toBeGreaterThan(
      freshnessScore("2026-08-15T03:00:00.000Z", NOW)
    );
    expect(freshnessScore("2026-08-15T03:00:00.000Z", NOW)).toBeGreaterThan(
      freshnessScore("2026-08-14T18:00:00.000Z", NOW)
    );
  });

  it("counts independent cross-platform reporting, not a company distribution blast", () => {
    const ownedDistribution = [
      dashboardCandidate({ id: "owned-x", platform: "x", independentlyReported: false }),
      dashboardCandidate({ id: "owned-linkedin", platform: "linkedin", independentlyReported: false }),
      dashboardCandidate({ id: "owned-youtube", platform: "youtube", independentlyReported: false })
    ];
    const independentCoverage = [
      dashboardCandidate({ id: "independent-x", platform: "x", independentlyReported: true }),
      dashboardCandidate({ id: "independent-reddit", platform: "reddit", independentlyReported: true })
    ];

    expect(crossPlatformConfirmationScore(ownedDistribution)).toBe(0);
    expect(crossPlatformConfirmationScore(independentCoverage)).toBeGreaterThan(0);
  });

  it("keeps a paper out of the ranking until observed discussion corroborates it", () => {
    const paper = dashboardCandidate({
      id: "paper-only",
      canonicalKey: "research:paper-only",
      platform: "research",
      sourceKind: "paper",
      url: "https://arxiv.org/abs/2608.12345",
      destinationUrl: "https://arxiv.org/abs/2608.12345",
      title: "A new robotics world-model paper",
      topics: ["research", "robotics"],
      metrics: {},
      independentlyReported: false
    });

    expect(buildDashboardSnapshot([paper], { now: NOW }).snapshot.stories).toEqual([]);

    const discussion = dashboardCandidate({
      id: "paper-hn",
      canonicalKey: "hacker_news:paper-hn",
      platform: "hacker_news",
      sourceKind: "discussion",
      url: "https://news.ycombinator.com/item?id=260812345",
      destinationUrl: "https://arxiv.org/abs/2608.12345",
      title: "HN discusses the new robotics world-model paper",
      metrics: { upvotes: 500, comments: 80 },
      independentlyReported: true
    });
    const result = buildDashboardSnapshot([paper, discussion], { now: NOW });

    expect(result.snapshot.stories).toHaveLength(1);
    expect(result.snapshot.stories[0]).toMatchObject({
      sourceCount: 1,
      topics: expect.arrayContaining(["research", "robotics"])
    });
    expect(result.snapshot.stories[0]?.sources.map((source) => source.id)).toEqual([paper.id]);
  });

  it("does not grant an otherwise-equal story a Returner boost", () => {
    const returnerCandidate = dashboardCandidate({
      id: "returner-control",
      canonicalKey: "x:returner-control",
      platform: "x",
      url: "https://x.example.com/returner-control",
      destinationUrl: "https://returner.example.com/control",
      title: "Cohort company control release",
      metrics: { views: 1_500_000, likes: 200 },
      accountBaseline: { likes: 100 },
      trackedEntity: {
        companyId: "returner-control",
        name: "Returner Control",
        cohortLabel: "YC S26",
        batchSlug: "S26"
      }
    });
    const industryCandidate = dashboardCandidate({
      id: "industry-control",
      canonicalKey: "youtube:industry-control",
      platform: "youtube",
      sourceKind: "video",
      url: "https://youtube.com/watch?v=industry-control",
      destinationUrl: "https://industry.example.com/control",
      title: "Industry control release",
      metrics: { views: 1_500_000, likes: 200 },
      accountBaseline: { likes: 100 }
    });

    const result = buildDashboardSnapshot([returnerCandidate, industryCandidate], { now: NOW });
    const returnerStory = storyContaining(result.snapshot.stories, "returner-control");
    const industryStory = storyContaining(result.snapshot.stories, "industry-control");

    expect(returnerStory.universe).toBe("returner");
    expect(industryStory.universe).toBe("industry");
    expect(returnerStory.trendScore).toBe(industryStory.trendScore);
  });

  it("publishes one canonical Top 100 instead of a union of view-specific lists", () => {
    const hottestCandidates = Array.from({ length: 100 }, (_, index) => dashboardCandidate({
      id: `hottest-${String(index).padStart(3, "0")}`,
      canonicalKey: `x:hottest-${index}`,
      title: `Hottest subject${String(index).padStart(3, "0")} release`,
      metrics: { views: 2_000_000 + index, likes: 100 },
      accountBaseline: { likes: 0.01 },
      sourceQuality: 100,
      publishedAt: NOW.toISOString()
    }));
    // This story has real, extreme short-window acceleration but a deliberately
    // low overall score. It remains discoverable to internal view-ranking
    // calculations but must not expand the public artifact past its canonical
    // Top 100.
    const breakingOnly = dashboardCandidate({
      id: "breaking-only",
      canonicalKey: "x:breaking-only",
      title: "Breaking-only velocity event",
      metrics: { views: 1_500_000, likes: 1_000 },
      accountBaseline: { likes: 1_000_000 },
      sourceQuality: 0,
      publishedAt: "2026-08-14T18:00:00.000Z",
      metricHistory: [
        { observedAt: "2026-08-15T11:00:00.000Z", metrics: { likes: 1 } },
        { observedAt: NOW.toISOString(), metrics: { likes: 1_000 } }
      ]
    });
    const candidates = [...hottestCandidates, breakingOnly];
    const initial = buildDashboardSnapshot(candidates, { now: NOW });
    const rerun = buildDashboardSnapshot([...candidates].reverse(), { now: NOW });

    expect(initial.snapshot.status.viewStoryCounts.hottest).toBe(100);
    expect(initial.snapshot.stories).toHaveLength(100);
    expect(initial.snapshot.stories.some((story) => story.sources.some((source) => source.id === "breaking-only"))).toBe(false);
    expect(initial.snapshot.stories.every((story) => story.viewRankings.hottest?.rank === story.rank)).toBe(true);
    expect(initial.rankSnapshots.every((snapshot) =>
      initial.snapshot.stories.some((story) => story.stableKey === snapshot.stableKey))).toBe(true);
    expect(rerun.snapshot).toEqual(initial.snapshot);
    expect(rerun.rankSnapshots).toEqual(initial.rankSnapshots);
  });

  it("keeps Hacker News-only discussions as corroboration instead of standalone filler", () => {
    const independentArticles = Array.from({ length: 99 }, (_, index) => dashboardCandidate({
      id: `independent-article-${String(index).padStart(3, "0")}`,
      canonicalKey: `web:independent-article-${index}`,
      platform: "web",
      sourceKind: "article",
      url: `https://publisher.example.com/report-${index}`,
      destinationUrl: `https://publisher.example.com/report-${index}`,
      title: `Independent technology report articleunique${index}`,
      metrics: { views: 2_000_000 + index },
      independentlyReported: true
    }));
    const hackerNewsOnly = Array.from({ length: 150 }, (_, index) => dashboardCandidate({
      id: `hn-only-${String(index).padStart(3, "0")}`,
      canonicalKey: `hacker_news:hn-only-${index}`,
      platform: "hacker_news",
      sourceKind: "discussion",
      url: `https://news.ycombinator.com/item?id=${100_000 + index}`,
      destinationUrl: `https://example.com/hn-only-${index}`,
      title: `Hacker News discussion hnunique${index}`,
      metrics: { upvotes: 1_000 + index, comments: 100 + index },
      metricHistory: [
        { observedAt: "2026-08-15T11:00:00.000Z", metrics: { upvotes: 1 } },
        { observedAt: NOW.toISOString(), metrics: { upvotes: 1_000 + index, comments: 100 + index } }
      ],
      independentlyReported: true
    }));

    const result = buildDashboardSnapshot([...independentArticles, ...hackerNewsOnly], { now: NOW });
    const hnOnlyStories = result.snapshot.stories.filter((story) =>
      story.sources.length > 0 && story.sources.every((source) => source.platform === "hacker_news")
    );

    expect(result.snapshot.stories).toHaveLength(99);
    expect(hnOnlyStories).toHaveLength(0);
    expect(result.snapshot.status.viewStoryCounts.hottest).toBe(99);
  });

  it("uses broad HN corroboration for clustering without publishing it as a qualified source", () => {
    const article = dashboardCandidate({
      id: "independent-news-report",
      canonicalKey: "web:independent-news-report",
      platform: "web",
      sourceKind: "article",
      url: "https://publisher.example.com/independent-report",
      destinationUrl: "https://company.example.com/new-research",
      title: "Independent reporting on a new research release",
      metrics: { views: 3_000_000 },
      independentlyReported: true
    });
    const hackerNewsDiscussion = dashboardCandidate({
      id: "hn-corroboration",
      canonicalKey: "hacker_news:hn-corroboration",
      platform: "hacker_news",
      sourceKind: "discussion",
      url: "https://news.ycombinator.com/item?id=123456",
      destinationUrl: "https://company.example.com/new-research",
      title: "HN discussion of the new research release",
      metrics: { upvotes: 10_000, comments: 2_000 },
      independentlyReported: true
    });

    const result = buildDashboardSnapshot([hackerNewsDiscussion, article], { now: NOW });
    const story = result.snapshot.stories[0];

    expect(sourceQualityScore(article)).toBeGreaterThan(sourceQualityScore(hackerNewsDiscussion));
    expect(story?.title).toBe(article.title);
    expect(story?.sources.map((source) => source.id)).toEqual([article.id]);
    expect(story?.platforms).toEqual(["news"]);
    expect(story?.sourceCount).toBe(1);
  });

  it("is stable across identical reruns and carries rank movement forward from prior snapshots", () => {
    const initialCandidates = [
      dashboardCandidate({
        id: "alpha",
        canonicalKey: "x:alpha",
        title: "Alpha database update",
        metrics: { views: 1_500_000, likes: 1_000 },
        accountBaseline: { likes: 100 }
      }),
      dashboardCandidate({
        id: "beta",
        canonicalKey: "x:beta",
        title: "Beta robotics update",
        metrics: { views: 1_500_000, likes: 100 },
        accountBaseline: { likes: 100 }
      })
    ];
    const initial = buildDashboardSnapshot(initialCandidates, { now: NOW });
    const rerun = buildDashboardSnapshot([...initialCandidates].reverse(), { now: NOW });

    expect(rerun.snapshot).toEqual(initial.snapshot);
    expect(rerun.rankSnapshots).toEqual(initial.rankSnapshots);

    const next = buildDashboardSnapshot([
      dashboardCandidate({
        ...initialCandidates[0],
        metrics: { views: 1_500_000, likes: 100 }
      }),
      dashboardCandidate({
        ...initialCandidates[1],
        metrics: { views: 1_500_000, likes: 1_000 }
      })
    ], {
      now: new Date("2026-08-15T13:00:00.000Z"),
      priorRankSnapshots: initial.rankSnapshots
    });
    const initialAlpha = storyContaining(initial.snapshot.stories, "alpha");
    const initialBeta = storyContaining(initial.snapshot.stories, "beta");
    const nextAlpha = storyContaining(next.snapshot.stories, "alpha");
    const nextBeta = storyContaining(next.snapshot.stories, "beta");

    expect(initialAlpha.rank).toBe(1);
    expect(initialBeta.rank).toBe(2);
    expect(nextBeta).toMatchObject({
      rank: 1,
      previousRank: 2,
      rankDelta: 1
    });
    expect(nextAlpha).toMatchObject({
      rank: 2,
      previousRank: 1,
      rankDelta: -1
    });
  });

  it("produces a persistable factual summary when a source only supplies a terse title", () => {
    const result = buildDashboardSnapshot([dashboardCandidate({
      id: "terse-summary",
      canonicalKey: "web:terse-summary",
      platform: "web",
      sourceKind: "article",
      url: "https://publisher.example.com/terse-summary",
      title: "Foo",
      summary: null,
      text: null
    })], { now: NOW });

    expect(result.snapshot.stories[0]?.summary).toBe("A source reports: Foo.");
    expect(result.snapshot.stories[0]?.summary.length).toBeGreaterThanOrEqual(8);
  });

  it("preserves abbreviated publisher headlines instead of treating the abbreviation as a full sentence", () => {
    const result = buildDashboardSnapshot([dashboardCandidate({
      id: "us-space-force",
      canonicalKey: "web:us-space-force",
      platform: "web",
      sourceKind: "article",
      title: "U.S. Space Force adds second surveillance sensor to Japanese constellation",
      summary: "Independent reporting on a new space surveillance sensor.",
      independentlyReported: true
    })], { now: NOW });

    expect(result.snapshot.stories[0]?.title)
      .toBe("U.S. Space Force adds second surveillance sensor to Japanese constellation");
  });

  it("does not cut source summaries at U.S. or A.I. abbreviations", () => {
    expect(compactSentence(
      "President Trump signed an order establishing the first U.S. Space Force reserve unit. A later sentence is omitted."
    )).toBe("President Trump signed an order establishing the first U.S. Space Force reserve unit.");
    expect(compactSentence(
      "Google turns on Gemini A.I. features for enterprise customers. A later sentence is omitted."
    )).toBe("Google turns on Gemini A.I. features for enterprise customers.");
  });

  it("keeps a truncated source excerpt within the persisted 300-character contract", () => {
    const result = buildDashboardSnapshot([dashboardCandidate({
      id: "long-source-summary",
      canonicalKey: "web:long-source-summary",
      platform: "web",
      sourceKind: "article",
      title: "Long source summary fixture",
      summary: "a".repeat(700),
      independentlyReported: true
    })], { now: NOW });

    const sourceSummary = result.snapshot.stories[0]?.sources[0]?.summary;
    expect(sourceSummary).not.toBeNull();
    expect(sourceSummary?.length).toBeLessThanOrEqual(300);
    expect(sourceSummary?.endsWith(".")).toBe(true);
  });
});

function dashboardCandidate(overrides: Partial<DashboardCandidate> = {}): DashboardCandidate {
  const id = overrides.id ?? "candidate";
  return {
    id,
    canonicalKey: overrides.canonicalKey ?? `x:${id}`,
    platform: "x",
    sourceKind: "post",
    url: `https://x.example.com/${id}`,
    publishedAt: "2026-08-15T11:00:00.000Z",
    title: `${id} AI software announcement`,
    metrics: { views: 1_500_000, likes: 100 },
    topics: ["ai"],
    socialBackfillEligible: true,
    sourceVerified: true,
    sourceLinkStatus: "verified",
    publicationPrecision: "exact",
    ...overrides
  };
}

function storyContaining<T extends { sources: Array<{ id: string }> }>(stories: T[], sourceId: string): T {
  const story = stories.find((candidate) => candidate.sources.some((source) => source.id === sourceId));
  if (!story) throw new Error(`Expected a story containing ${sourceId}.`);
  return story;
}
