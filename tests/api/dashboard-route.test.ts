import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardPublicFeedSnapshot,
  type DashboardStorySourceDetail
} from "@/lib/dashboard/contracts";

const dashboardStore = vi.hoisted(() => ({
  loadPublicDashboardFeedSnapshot: vi.fn(),
  loadPublicDashboardStorySourceDetail: vi.fn()
}));

vi.mock("@/lib/dashboard/store", () => dashboardStore);

import { GET as getDashboardFeed } from "@/app/api/dashboard/route";
import { GET as getDashboardStorySources } from "@/app/api/dashboard/stories/[stableKey]/sources/route";

describe("dashboard public API routes", () => {
  beforeEach(() => {
    dashboardStore.loadPublicDashboardFeedSnapshot.mockReset();
    dashboardStore.loadPublicDashboardStorySourceDetail.mockReset();
  });

  it("serves only the compact feed projection from the list endpoint", async () => {
    const feed = compactFeed();
    dashboardStore.loadPublicDashboardFeedSnapshot.mockResolvedValue(feed);

    const response = await getDashboardFeed();
    const payload = await response.json();

    expect(dashboardStore.loadPublicDashboardFeedSnapshot).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=60");
    expect(payload.stories[0]).toMatchObject({
      stableKey: "story-route-test",
      primarySource: { id: "route-source" }
    });
    expect(payload.stories[0]).not.toHaveProperty("sources");
    expect(payload.stories[0]).not.toHaveProperty("score");
  });

  it("serves bounded display-safe sources for exactly one valid stable key", async () => {
    const detail: DashboardStorySourceDetail = {
      stableKey: "story-route-test",
      sourceCount: 2,
      truncated: true,
      sources: [{
        id: "route-source",
        url: "https://example.com/route-source",
        title: "Route source",
        publisher: "Example",
        platform: "news",
        sourceKind: "article",
        publishedAt: "2026-08-15T11:00:00.000Z",
        metrics: { views: 10 }
      }]
    };
    dashboardStore.loadPublicDashboardStorySourceDetail.mockResolvedValue(detail);

    const response = await getDashboardStorySources(
      new Request("https://returner.fund/api/dashboard/stories/story-route-test/sources"),
      { params: Promise.resolve({ stableKey: "story-route-test" }) }
    );
    const payload = await response.json();

    expect(dashboardStore.loadPublicDashboardStorySourceDetail).toHaveBeenCalledWith("story-route-test");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dashboard-source-detail-limited")).toBe("1");
    expect(payload.sources[0]).toEqual(detail.sources[0]);
    expect(payload.sources[0]).toHaveProperty("metrics", { views: 10 });

    const invalidResponse = await getDashboardStorySources(
      new Request("https://returner.fund/api/dashboard/stories/not-a-story/sources"),
      { params: Promise.resolve({ stableKey: "not-a-story" }) }
    );
    expect(invalidResponse.status).toBe(404);
    expect(dashboardStore.loadPublicDashboardStorySourceDetail).toHaveBeenCalledTimes(1);
  });
});

function compactFeed(): DashboardPublicFeedSnapshot {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    sourceSnapshotFingerprint: "dsh-route-test",
    generatedAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    windowStart: "2026-08-12T12:00:00.000Z",
    windowEnd: "2026-08-15T12:00:00.000Z",
    todayInTech: [],
    stories: [{
      id: "story-route-test",
      stableKey: "story-route-test",
      rank: 1,
      previousRank: null,
      rankDelta: null,
      trendStatus: "new",
      viewRankings: {
        hottest: { rank: 1, previousRank: null, rankDelta: null, trendStatus: "new" }
      },
      title: "Route test story",
      summary: "A compact dashboard route test story.",
      thumbnailUrl: null,
      thumbnailAlt: null,
      universe: "industry",
      labels: [],
      topics: ["other"],
      platforms: ["news"],
      publishedAt: "2026-08-15T11:00:00.000Z",
      updatedAt: "2026-08-15T12:00:00.000Z",
      trendScore: 80,
      sourceCount: 1,
      independentSourceCount: 1,
      engagement: { views: 10 },
      primarySource: {
        id: "route-source",
        url: "https://example.com/route-source",
        title: "Route source",
        publisher: "Example",
        platform: "news",
        sourceKind: "article",
        publishedAt: "2026-08-15T11:00:00.000Z",
        metrics: { views: 10 }
      }
    }],
    availableFilters: { topics: ["other"], platforms: ["news"] },
    status: {
      candidateCount: 1,
      eligibleCandidateCount: 1,
      storyCount: 1,
      viewStoryCounts: { hottest: 1, breaking: 0, emerging: 0 },
      partialPlatformFailures: []
    }
  };
}
