import { describe, expect, it } from "vitest";

import {
  DASHBOARD_SOURCE_DETAIL_LIMIT,
  type DashboardCandidate
} from "@/lib/dashboard/contracts";
import { buildDashboardSnapshot } from "@/lib/dashboard/pipeline";
import {
  DASHBOARD_MAX_SNAPSHOT_AGE_MS,
  DASHBOARD_STALE_FALLBACK_MAX_AGE_MS,
  isDashboardSnapshotWithinRetention,
  isCurrentDashboardSnapshot,
  isDashboardPublicFeedSnapshot,
  isDashboardPublicSnapshot,
  resolveCurrentDashboardSnapshot,
  selectDashboardStorySourceDetail,
  toDashboardPublicFeedSnapshot
} from "@/lib/dashboard/store";

describe("dashboard public snapshot validation", () => {
  it("accepts a generated snapshot and rejects malformed per-view ranking metadata", () => {
    const snapshot = buildDashboardSnapshot([dashboardCandidate()], {
      now: new Date("2026-08-15T12:00:00.000Z")
    }).snapshot;

    expect(isDashboardPublicSnapshot(snapshot)).toBe(true);

    const zeroRank = clone(snapshot) as {
      stories: Array<{ viewRankings: Record<string, { rank: number }> }>;
    };
    zeroRank.stories[0]!.viewRankings.hottest!.rank = 0;
    expect(isDashboardPublicSnapshot(zeroRank)).toBe(false);

    const unknownView = clone(snapshot) as {
      stories: Array<{ viewRankings: Record<string, unknown> }>;
    };
    unknownView.stories[0]!.viewRankings.unknown = { rank: 1 };
    expect(isDashboardPublicSnapshot(unknownView)).toBe(false);

    const inconsistentStatus = clone(snapshot) as {
      status: { storyCount: number; viewStoryCounts: Record<string, number> };
    };
    inconsistentStatus.status.storyCount += 1;
    inconsistentStatus.status.viewStoryCounts.breaking = -1;
    expect(isDashboardPublicSnapshot(inconsistentStatus)).toBe(false);

    const malformedStoryShape = clone(snapshot) as unknown as {
      stories: Array<Record<string, unknown>>;
    };
    malformedStoryShape.stories[0]!.engagement = null;
    malformedStoryShape.stories[0]!.platforms = ["not-a-dashboard-platform"];
    expect(isDashboardPublicSnapshot(malformedStoryShape)).toBe(false);
  });

  it("bounds raw social display fields and drops local recovery thumbnails before persistence", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const snapshot = buildDashboardSnapshot([{
      ...dashboardCandidate(new Date(now.getTime() - 60 * 60 * 1_000).toISOString()),
      title: "t".repeat(700),
      authorName: "a".repeat(400),
      thumbnailAlt: "d".repeat(400),
      thumbnailUrl: "/evidence-thumbnails/x/local-recovery.svg"
    }], { now }).snapshot;
    const story = snapshot.stories[0];
    const source = story?.sources[0];
    if (!story || !source) throw new Error("Expected a sanitized dashboard story source.");

    expect(isDashboardPublicSnapshot(snapshot)).toBe(true);
    expect(story.thumbnailUrl).toBeNull();
    expect(story.thumbnailAlt?.length).toBeLessThanOrEqual(240);
    expect(source.thumbnailUrl).toBeNull();
    expect(source.thumbnailAlt?.length).toBeLessThanOrEqual(240);
    expect(source.title?.length).toBeLessThanOrEqual(500);
    expect(source.authorName?.length).toBeLessThanOrEqual(300);
  });

  it("requires a current exact rolling window before a valid snapshot is public", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const current = dashboardSnapshotAt(now);
    expect(isDashboardPublicSnapshot(current)).toBe(true);
    expect(isCurrentDashboardSnapshot(current, now)).toBe(true);

    const stale = dashboardSnapshotAt(new Date(now.getTime() - DASHBOARD_MAX_SNAPSHOT_AGE_MS - 1));
    expect(isDashboardPublicSnapshot(stale)).toBe(true);
    expect(isCurrentDashboardSnapshot(stale, now)).toBe(false);
    expect(isDashboardSnapshotWithinRetention(stale, now)).toBe(true);

    const expiredFallback = dashboardSnapshotAt(new Date(now.getTime() - DASHBOARD_STALE_FALLBACK_MAX_AGE_MS - 1));
    expect(isDashboardSnapshotWithinRetention(expiredFallback, now)).toBe(false);

    const future = dashboardSnapshotAt(new Date(now.getTime() + 6 * 60 * 1_000));
    expect(isCurrentDashboardSnapshot(future, now)).toBe(false);

    const mismatchedPublicationClock = clone(current);
    mismatchedPublicationClock.generatedAt = new Date(now.getTime() - 1).toISOString();
    expect(isDashboardPublicSnapshot(mismatchedPublicationClock)).toBe(true);
    expect(isCurrentDashboardSnapshot(mismatchedPublicationClock, now)).toBe(false);
  });

  it("projects source arrays out of the public feed and bounds one-story source detail", () => {
    const snapshot = dashboardSnapshotAt(new Date("2026-08-15T12:00:00.000Z"));
    const source = snapshot.stories[0]?.sources[0];
    const story = snapshot.stories[0];
    if (!source || !story) throw new Error("Expected a dashboard story source fixture.");
    const allSources = Array.from({ length: DASHBOARD_SOURCE_DETAIL_LIMIT + 1 }, (_value, index) => ({
      ...source,
      canonicalKey: `${source.canonicalKey}-${index}`,
      id: `${source.id}-${index}`
    }));
    const sourceRichSnapshot = {
      ...snapshot,
      stories: [{ ...story, sourceCount: allSources.length, sources: allSources }]
    };

    const feed = toDashboardPublicFeedSnapshot(sourceRichSnapshot);
    expect(isDashboardPublicFeedSnapshot(feed)).toBe(true);
    expect(feed.stories[0]).not.toHaveProperty("sources");
    expect(feed.stories[0]).not.toHaveProperty("summaryFingerprint");
    expect(feed.stories[0]).not.toHaveProperty("score");
    expect(feed.stories[0]).not.toHaveProperty("breakingScore");
    expect(feed.stories[0]).not.toHaveProperty("emergingScore");
    expect(JSON.stringify(feed)).not.toContain('"sources"');

    const unsafeThumbnailFeed = toDashboardPublicFeedSnapshot({
      ...snapshot,
      stories: [{ ...story, thumbnailUrl: "https://unapproved-images.example.test/card.jpg" }]
    });
    expect(unsafeThumbnailFeed.stories[0]?.thumbnailUrl).toBeNull();

    const leakedArray = clone(feed) as { stories: Array<Record<string, unknown>> };
    leakedArray.stories[0]!.sources = [];
    expect(isDashboardPublicFeedSnapshot(leakedArray)).toBe(false);

    const leakedScore = clone(feed) as { stories: Array<Record<string, unknown>> };
    leakedScore.stories[0]!.score = { velocity: 100 };
    expect(isDashboardPublicFeedSnapshot(leakedScore)).toBe(false);

    const detail = selectDashboardStorySourceDetail(sourceRichSnapshot, story.stableKey);
    expect(detail).toMatchObject({
      stableKey: story.stableKey,
      sourceCount: DASHBOARD_SOURCE_DETAIL_LIMIT + 1,
      truncated: true
    });
    expect(detail?.sources).toHaveLength(DASHBOARD_SOURCE_DETAIL_LIMIT);
    expect(detail?.sources[0]).not.toHaveProperty("canonicalKey");
    expect(detail?.sources[0]).toEqual({
      id: `${source.id}-0`,
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      platform: source.platform,
      publishedAt: source.publishedAt,
      metrics: source.metrics
    });
    expect(selectDashboardStorySourceDetail(sourceRichSnapshot, "not-a-story-key")).toBeNull();
  });

  it("selects the newest current projection and returns an explicit safe stale state", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const olderDatabase = dashboardSnapshotAt(new Date(now.getTime() - 60 * 60 * 1_000));
    const newerArtifact = dashboardSnapshotAt(now);

    const newest = resolveCurrentDashboardSnapshot([newerArtifact, olderDatabase], now);
    expect(newest).toEqual({ snapshot: newerArtifact, availability: "current" });

    const stale = dashboardSnapshotAt(new Date(now.getTime() - DASHBOARD_MAX_SNAPSHOT_AGE_MS - 1));
    expect(resolveCurrentDashboardSnapshot([stale], now)).toEqual({ snapshot: null, availability: "stale" });
    expect(resolveCurrentDashboardSnapshot([null], now)).toEqual({ snapshot: null, availability: "unavailable" });
  });
});

function dashboardSnapshotAt(now: Date) {
  const publishedAt = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
  return buildDashboardSnapshot([dashboardCandidate(publishedAt)], { now }).snapshot;
}

function dashboardCandidate(publishedAt = "2026-08-15T11:00:00.000Z"): DashboardCandidate {
  return {
    id: "store-validation",
    canonicalKey: "x:store-validation",
    platform: "x",
    sourceKind: "post",
    url: "https://x.example.com/store-validation",
    title: "Store validation fixture",
    publishedAt,
    metrics: { likes: 100 },
    accountBaseline: { likes: 10 }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
