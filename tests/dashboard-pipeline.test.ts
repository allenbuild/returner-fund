import { describe, expect, it } from "vitest";
import { clusterDashboardCandidates } from "@/lib/dashboard/clustering";
import type { DashboardCandidate } from "@/lib/dashboard/contracts";
import { buildDashboardSnapshot } from "@/lib/dashboard/pipeline";
import {
  crossPlatformConfirmationScore,
  freshnessScore,
  platformNormalizedSignificance,
  relativeViralityScore,
  velocityScore
} from "@/lib/dashboard/scoring";

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("technology dashboard pipeline", () => {
  it("uses an exact rolling 24-hour window and excludes stale, future, and invalid candidates", () => {
    const result = buildDashboardSnapshot([
      dashboardCandidate({
        id: "at-window-start",
        publishedAt: "2026-08-14T12:00:00.000Z"
      }),
      dashboardCandidate({
        id: "one-millisecond-stale",
        publishedAt: "2026-08-14T11:59:59.999Z"
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

    expect(result.snapshot.windowStart).toBe("2026-08-14T12:00:00.000Z");
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
      sourceCount: 6,
      independentSourceCount: 5
    });
    expect(result.snapshot.stories[0]?.sources.map((source) => source.id).sort()).toEqual(
      sixSourceLaunch.map((source) => source.id).sort()
    );
  });

  it("keeps a story identity when later corroborating coverage adds a different adapter key or URL", () => {
    const primary = dashboardCandidate({
      id: "orbit-release",
      canonicalKey: "github:acme-orbit-release",
      platform: "github",
      sourceKind: "release",
      url: "https://github.example.com/acme/orbit/releases/v1",
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
      sourceCount: 2,
      topics: expect.arrayContaining(["research", "robotics"])
    });
  });

  it("does not grant an otherwise-equal story a Returner boost", () => {
    const returnerCandidate = dashboardCandidate({
      id: "returner-control",
      canonicalKey: "x:returner-control",
      platform: "x",
      url: "https://x.example.com/returner-control",
      destinationUrl: "https://returner.example.com/control",
      title: "Cohort company control release",
      metrics: { likes: 200 },
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
      canonicalKey: "reddit:industry-control",
      platform: "reddit",
      url: "https://reddit.example.com/industry-control",
      destinationUrl: "https://industry.example.com/control",
      title: "Industry control release",
      metrics: { likes: 200 },
      accountBaseline: { likes: 100 }
    });

    const result = buildDashboardSnapshot([returnerCandidate, industryCandidate], { now: NOW });
    const returnerStory = storyContaining(result.snapshot.stories, "returner-control");
    const industryStory = storyContaining(result.snapshot.stories, "industry-control");

    expect(returnerStory.universe).toBe("returner");
    expect(industryStory.universe).toBe("industry");
    expect(returnerStory.trendScore).toBe(industryStory.trendScore);
  });

  it("stores the union of independently ranked Top 100 views with view-keyed history", () => {
    const hottestCandidates = Array.from({ length: 100 }, (_, index) => dashboardCandidate({
      id: `hottest-${String(index).padStart(3, "0")}`,
      canonicalKey: `x:hottest-${index}`,
      title: `Hottest subject${String(index).padStart(3, "0")} release`,
      metrics: { likes: 100 },
      accountBaseline: { likes: 0.01 },
      sourceQuality: 100,
      publishedAt: NOW.toISOString()
    }));
    // This story has real, extreme short-window acceleration but a deliberately
    // low relative-performance and freshness score. It must not disappear just
    // because it falls outside Hottest's 100-story slice.
    const breakingOnly = dashboardCandidate({
      id: "breaking-only",
      canonicalKey: "x:breaking-only",
      title: "Breaking-only velocity event",
      metrics: { likes: 1_000 },
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
    const breakingStory = storyContaining(initial.snapshot.stories, "breaking-only");

    expect(initial.snapshot.status.viewStoryCounts).toEqual({
      hottest: 100,
      breaking: 100,
      emerging: 100
    });
    expect(initial.snapshot.stories).toHaveLength(101);
    expect(breakingStory.viewRankings.hottest).toBeUndefined();
    expect(breakingStory.viewRankings.emerging).toBeUndefined();
    expect(breakingStory.viewRankings.breaking).toMatchObject({
      rank: 1,
      previousRank: null,
      rankDelta: null,
      trendStatus: "new"
    });
    expect(initial.rankSnapshots.filter((snapshot) => snapshot.stableKey === breakingStory.stableKey))
      .toEqual([expect.objectContaining({ view: "breaking", rank: 1 })]);
    expect(rerun.snapshot).toEqual(initial.snapshot);
    expect(rerun.rankSnapshots).toEqual(initial.rankSnapshots);

    const next = buildDashboardSnapshot(candidates.map((candidate) =>
      candidate.id === "hottest-000"
        ? {
          ...candidate,
          metrics: { likes: 10_000 },
          metricHistory: [
            { observedAt: "2026-08-15T11:00:00.000Z", metrics: { likes: 1 } },
            { observedAt: NOW.toISOString(), metrics: { likes: 10_000 } }
          ]
        }
        : candidate
    ), {
      now: new Date("2026-08-15T13:00:00.000Z"),
      priorRankSnapshots: initial.rankSnapshots
    });
    const movedBreakingStory = storyContaining(next.snapshot.stories, "breaking-only");

    expect(movedBreakingStory.viewRankings.hottest).toBeUndefined();
    expect(movedBreakingStory.viewRankings.breaking).toMatchObject({
      rank: 2,
      previousRank: 1,
      rankDelta: -1
    });
    expect(next.rankSnapshots).toContainEqual(expect.objectContaining({
      stableKey: breakingStory.stableKey,
      view: "breaking",
      rank: 2
    }));
  });

  it("is stable across identical reruns and carries rank movement forward from prior snapshots", () => {
    const initialCandidates = [
      dashboardCandidate({
        id: "alpha",
        canonicalKey: "x:alpha",
        title: "Alpha database update",
        metrics: { likes: 1_000 },
        accountBaseline: { likes: 100 }
      }),
      dashboardCandidate({
        id: "beta",
        canonicalKey: "x:beta",
        title: "Beta robotics update",
        metrics: { likes: 100 },
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
        metrics: { likes: 100 }
      }),
      dashboardCandidate({
        ...initialCandidates[1],
        metrics: { likes: 1_000 }
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
      canonicalKey: "github:terse-summary",
      platform: "github",
      sourceKind: "repository",
      title: "Foo",
      summary: null,
      text: null
    })], { now: NOW });

    expect(result.snapshot.stories[0]?.summary).toBe("A source reports: Foo.");
    expect(result.snapshot.stories[0]?.summary.length).toBeGreaterThanOrEqual(8);
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
    title: `${id} announcement`,
    metrics: { likes: 100 },
    ...overrides
  };
}

function storyContaining<T extends { sources: Array<{ id: string }> }>(stories: T[], sourceId: string): T {
  const story = stories.find((candidate) => candidate.sources.some((source) => source.id === sourceId));
  if (!story) throw new Error(`Expected a story containing ${sourceId}.`);
  return story;
}
