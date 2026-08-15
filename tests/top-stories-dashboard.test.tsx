import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopStoriesDashboard } from "@/components/dashboard/TopStoriesDashboard";
import {
  DASHBOARD_SCHEMA_VERSION,
  type DashboardPublicFeedSnapshot,
  type DashboardStoryCard,
  type DashboardStoryPrimarySource,
  type DashboardStorySource,
  type DashboardViewRanking
} from "@/lib/dashboard/contracts";

describe("TopStoriesDashboard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders one consolidated Top 100 card grid and lazily fetches sources on expansion", async () => {
    const fetchSources = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stableKey: "story-atlas",
        sourceCount: 2,
        truncated: false,
        sources: [
          primarySource(source("atlas-x", "x", "Atlas Runtime launch", "https://example.com/atlas-launch")),
          primarySource(source("atlas-hn", "hacker_news", "Show HN: Atlas Runtime", "https://news.ycombinator.com/item?id=atlas"))
        ]
      })
    });
    vi.stubGlobal("fetch", fetchSources);

    render(<TopStoriesDashboard snapshot={snapshotFixture()} />);

    expect(screen.getByRole("heading", { name: "Top 100 in Tech", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent direct-source technology coverage" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Top 100 technology stories" })).toBeInTheDocument();
    expect(screen.getByText("Atlas launches an agent runtime")).toBeInTheDocument();
    expect(screen.getByText("Industry research paper rises")).toBeInTheDocument();
    expect(screen.queryByText("Breaking security release accelerates")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hottest" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Breaking" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Emerging" })).not.toBeInTheDocument();
    expect(screen.queryByText("Universe")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Item 4")).toBeInTheDocument();
    expect(screen.getByLabelText("Atlas launches an agent runtime thumbnail")).toBeInTheDocument();
    expect(fetchSources).not.toHaveBeenCalled();

    const details = screen.getByText("View 2 underlying sources").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(within(details).getByText("View 2 underlying sources"));
    expect(details.open).toBe(true);
    await waitFor(() => expect(fetchSources).toHaveBeenCalledWith(
      "/api/dashboard/stories/story-atlas/sources",
      { headers: { Accept: "application/json" } }
    ));
    expect(await within(details).findByRole("link", { name: /Atlas Runtime launch/i })).toHaveAttribute(
      "href",
      "https://example.com/atlas-launch"
    );
  });

  it("recovers a stale empty server render with one current public feed request", async () => {
    const emptySnapshot = unavailableSnapshotFixture();
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => currentSnapshotFixture()
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={emptySnapshot} />);

    expect(screen.getByText("The Top 100 is being prepared.")).toBeInTheDocument();
    expect(await screen.findByText("Atlas launches an agent runtime")).toBeInTheDocument();
    expect(fetchDashboard).toHaveBeenCalledTimes(1);
    expect(fetchDashboard).toHaveBeenCalledWith(
      "/api/dashboard",
      expect.objectContaining({
        cache: "no-store",
        headers: { Accept: "application/json" }
      })
    );
    expect(screen.queryByText("The Top 100 is being prepared.")).not.toBeInTheDocument();
  });

  it("rejects a stale nonempty recovery response", async () => {
    const emptySnapshot = unavailableSnapshotFixture();
    const staleSnapshot = currentSnapshotFixture(new Date(Date.now() - 3 * 60 * 60 * 1_000));
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => staleSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={emptySnapshot} />);

    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(screen.getByText("The Top 100 is being prepared.")).toBeInTheDocument();
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("rejects an unavailable nonempty recovery response", async () => {
    const unavailableSnapshot = currentSnapshotFixture();
    unavailableSnapshot.status = {
      ...unavailableSnapshot.status,
      partialPlatformFailures: ["snapshot_unavailable"]
    };
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => unavailableSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={unavailableSnapshotFixture()} />);

    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(screen.getByText("The Top 100 is being prepared.")).toBeInTheDocument();
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("rejects a malformed recovery response", async () => {
    const malformedSnapshot = {
      ...currentSnapshotFixture(),
      sourceSnapshotFingerprint: ""
    };
    const fetchDashboard = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => malformedSnapshot
    });
    vi.stubGlobal("fetch", fetchDashboard);

    render(<TopStoriesDashboard snapshot={unavailableSnapshotFixture()} />);

    await waitFor(() => expect(fetchDashboard).toHaveBeenCalledTimes(1));
    expect(screen.getByText("The Top 100 is being prepared.")).toBeInTheDocument();
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("keeps the safe empty state when the recovery feed has no published stories", async () => {
    const emptySnapshot = unavailableSnapshotFixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => emptySnapshot
    }));

    render(<TopStoriesDashboard snapshot={emptySnapshot} />);

    expect(screen.getByText("The Top 100 is being prepared.")).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Atlas launches an agent runtime")).not.toBeInTheDocument();
  });

  it("uses the published snapshot generatedAt timestamp for freshness", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:30:00.000Z"));
    const snapshot = snapshotFixture();
    snapshot.generatedAt = "2026-08-15T12:00:00.000Z";
    snapshot.updatedAt = "2026-08-15T12:30:00.000Z";

    render(<TopStoriesDashboard snapshot={snapshot} />);

    const freshness = screen.getByText("Updated 30 min ago");
    expect(freshness).toHaveAttribute("dateTime", snapshot.generatedAt);
    expect(screen.queryByText("Updated just now")).not.toBeInTheDocument();
  });

  it("labels a stale safe snapshot without rendering it as fresh", () => {
    const snapshot = snapshotFixture();
    snapshot.stories = [];
    snapshot.status = {
      ...snapshot.status,
      storyCount: 0,
      viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
      partialPlatformFailures: ["snapshot_stale"]
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => null
    }));

    render(<TopStoriesDashboard snapshot={snapshot} />);

    expect(screen.getByText("Latest index is stale")).toBeInTheDocument();
    expect(screen.queryByText("Updated just now")).not.toBeInTheDocument();
  });

  it("uses canonical hottest ranks as the sole Top 100 ordering", () => {
    render(<TopStoriesDashboard snapshot={snapshotFixture()} />);

    expect(screen.getByText("Atlas launches an agent runtime")).toBeInTheDocument();
    expect(screen.getByText("Industry research paper rises")).toBeInTheDocument();
    expect(screen.queryByText("Breaking security release accelerates")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Item 4")).toBeInTheDocument();
    expect(screen.getByLabelText("Item 12")).toBeInTheDocument();
  });
});

function snapshotFixture(): DashboardPublicFeedSnapshot {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    sourceSnapshotFingerprint: "dsh-test-snapshot",
    generatedAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    windowStart: "2026-08-14T12:00:00.000Z",
    windowEnd: "2026-08-15T12:00:00.000Z",
    todayInTech: ["A new agent runtime is attracting developer discussion."],
    stories: [
      story({
        id: "atlas",
        rank: 4,
        universe: "returner",
        labels: ["YC S26"],
        title: "Atlas launches an agent runtime",
        summary: "Atlas released an orchestration runtime that is drawing independent discussion across X, Hacker News, and YouTube.",
        topics: ["ai", "launches"],
        platforms: ["x", "hacker_news", "youtube"],
        sourceCount: 2,
        primarySource: primarySource(source("atlas-x", "x", "Atlas Runtime launch", "https://example.com/atlas-launch"))
      }),
      story({
        id: "paper",
        rank: 12,
        universe: "industry",
        title: "Industry research paper rises",
        summary: "A visual world-model paper is gaining attention after researchers shared its robotics results.",
        topics: ["research", "robotics"],
        platforms: ["research", "news"],
        sourceCount: 1,
        primarySource: primarySource(source("paper-source", "research", "Visual world-model paper", "https://arxiv.org/abs/1234.5678"))
      }),
      story({
        id: "breaking-release",
        rank: 56,
        universe: "industry",
        title: "Breaking security release accelerates",
        summary: "A security release is receiving rapid discussion after independent developers flagged its newly published remediation guidance.",
        topics: ["open_source"],
        platforms: ["github", "hacker_news"],
        sourceCount: 1,
        viewRankings: {
          breaking: viewRanking(1, { rankDelta: 9, trendStatus: "rising_fast" })
        },
        primarySource: primarySource(source("breaking-release-source", "github", "Security release", "https://example.com/security-release"))
      })
    ],
    availableFilters: {
      topics: ["ai", "launches", "research", "robotics"],
      platforms: ["x", "hacker_news", "youtube", "research", "news"]
    },
    status: {
      candidateCount: 3,
      eligibleCandidateCount: 3,
      storyCount: 3,
      viewStoryCounts: { hottest: 2, breaking: 1, emerging: 0 },
      partialPlatformFailures: []
    }
  };
}

function unavailableSnapshotFixture(): DashboardPublicFeedSnapshot {
  const snapshot = snapshotFixture();
  snapshot.stories = [];
  snapshot.status = {
    ...snapshot.status,
    storyCount: 0,
    viewStoryCounts: { hottest: 0, breaking: 0, emerging: 0 },
    partialPlatformFailures: ["snapshot_unavailable"]
  };
  return snapshot;
}

function currentSnapshotFixture(now = new Date()): DashboardPublicFeedSnapshot {
  const snapshot = snapshotFixture();
  const windowEnd = now.toISOString();
  snapshot.generatedAt = windowEnd;
  snapshot.updatedAt = windowEnd;
  snapshot.windowEnd = windowEnd;
  snapshot.windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  return snapshot;
}

function story(overrides: Pick<DashboardStoryCard, "id" | "rank" | "universe" | "title" | "summary" | "topics" | "platforms" | "sourceCount" | "primarySource"> & {
  labels?: string[];
  viewRankings?: DashboardStoryCard["viewRankings"];
}): DashboardStoryCard {
  return {
    id: overrides.id,
    stableKey: "story-" + overrides.id,
    rank: overrides.rank,
    previousRank: null,
    rankDelta: null,
    trendStatus: "rising",
    viewRankings: overrides.viewRankings ?? { hottest: viewRanking(overrides.rank) },
    title: overrides.title,
    summary: overrides.summary,
    thumbnailUrl: null,
    thumbnailAlt: null,
    universe: overrides.universe,
    labels: overrides.labels ?? [],
    topics: overrides.topics,
    platforms: overrides.platforms,
    publishedAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    trendScore: 88,
    sourceCount: overrides.sourceCount,
    independentSourceCount: overrides.sourceCount,
    engagement: { views: 125_000, likes: 6_000 },
    primarySource: overrides.primarySource
  };
}

function viewRanking(rank: number, overrides: Partial<DashboardViewRanking> = {}): DashboardViewRanking {
  return {
    rank,
    previousRank: null,
    rankDelta: null,
    trendStatus: "rising",
    ...overrides
  };
}

function primarySource(sourceValue: DashboardStorySource): DashboardStoryPrimarySource {
  return {
    id: sourceValue.id,
    url: sourceValue.url,
    title: sourceValue.title,
    publisher: sourceValue.publisher,
    platform: sourceValue.platform,
    publishedAt: sourceValue.publishedAt
  };
}

function source(
  id: string,
  platform: DashboardStorySource["platform"],
  title: string,
  url: string
): DashboardStorySource {
  return {
    id,
    canonicalKey: platform + ":" + id,
    platform,
    nativePlatform: platform === "research" || platform === "news" ? platform : platform,
    sourceKind: platform === "research" ? "paper" : "post",
    url,
    destinationUrl: null,
    title,
    summary: null,
    authorName: null,
    publisher: null,
    publishedAt: "2026-08-15T10:00:00.000Z",
    metrics: { views: 20_000 },
    thumbnailUrl: null,
    thumbnailAlt: null,
    trackedEntity: null,
    signals: []
  };
}
