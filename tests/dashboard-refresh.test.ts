import { describe, expect, it } from "vitest";
import type { DashboardCandidate, DashboardMetrics, DashboardPublicSnapshot } from "@/lib/dashboard/contracts";
import { enrichDashboardCandidatesWithPriorSnapshotMetrics } from "@/lib/dashboard/refresh";
import { velocityScore } from "@/lib/dashboard/scoring";

const PRIOR_GENERATED_AT = "2026-08-15T11:00:00.000Z";
const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("dashboard worker metric-history enrichment", () => {
  it("uses a prior published source reading plus the current worker reading for the exact canonical source", () => {
    const candidate = dashboardCandidate({
      canonicalKey: "reddit:post:abc123",
      observedAt: "2026-08-15T12:00:00.050Z",
      metrics: { upvotes: 110, comments: 20 }
    });
    const [enriched] = enrichDashboardCandidatesWithPriorSnapshotMetrics(
      [candidate],
      priorSnapshot("reddit:post:abc123", { upvotes: 10, comments: 2 }),
      NOW
    );

    expect(enriched).not.toBe(candidate);
    expect(enriched.metricHistory).toEqual([
      { observedAt: PRIOR_GENERATED_AT, metrics: { upvotes: 10, comments: 2 } },
      { observedAt: "2026-08-15T12:00:00.050Z", metrics: { upvotes: 110, comments: 20 } }
    ]);
    expect(velocityScore(enriched, NOW)).toBeGreaterThan(0);
  });

  it("leaves a one-scrape source unchanged when no safely ordered prior/current pair exists", () => {
    const prior = priorSnapshot("reddit:post:abc123", { upvotes: 10 });
    const unmatched = dashboardCandidate({ canonicalKey: "reddit:post:other", observedAt: NOW.toISOString() });
    const sameTimestamp = dashboardCandidate({ id: "same-timestamp", observedAt: PRIOR_GENERATED_AT });
    const noCurrentMetrics = dashboardCandidate({ id: "no-current-metrics", observedAt: NOW.toISOString(), metrics: {} });
    const materiallyFuture = dashboardCandidate({
      id: "future-reading",
      observedAt: "2026-08-15T12:31:00.000Z"
    });

    const enriched = enrichDashboardCandidatesWithPriorSnapshotMetrics(
      [unmatched, sameTimestamp, noCurrentMetrics, materiallyFuture],
      prior,
      NOW
    );

    expect(enriched).toEqual([unmatched, sameTimestamp, noCurrentMetrics, materiallyFuture]);
    expect(enriched.every((candidate, index) => candidate === [unmatched, sameTimestamp, noCurrentMetrics, materiallyFuture][index])).toBe(true);
    expect(enriched.map((candidate) => velocityScore(candidate, NOW))).toEqual([0, 0, 0, 0]);
  });

  it("does not treat a casing-only key difference as the same physical source", () => {
    const candidate = dashboardCandidate({ canonicalKey: "rss:url:https://example.com/Release" });
    const [enriched] = enrichDashboardCandidatesWithPriorSnapshotMetrics(
      [candidate],
      priorSnapshot("rss:url:https://example.com/release", { views: 20 }),
      NOW
    );

    expect(enriched).toBe(candidate);
    expect(enriched.metricHistory).toBeUndefined();
  });
});

function dashboardCandidate(overrides: Partial<DashboardCandidate> = {}): DashboardCandidate {
  const id = overrides.id ?? "candidate";
  return {
    id,
    canonicalKey: "reddit:post:abc123",
    platform: "reddit",
    sourceKind: "discussion",
    url: `https://www.reddit.com/comments/${id}`,
    title: "A technology discussion",
    publishedAt: "2026-08-15T10:00:00.000Z",
    observedAt: NOW.toISOString(),
    metrics: { upvotes: 100, comments: 10 },
    ...overrides
  };
}

function priorSnapshot(canonicalKey: string, metrics: DashboardMetrics): DashboardPublicSnapshot {
  // The worker needs only the generated time and source readings. Keeping the
  // fixture intentionally narrow makes clear that it derives history from the
  // already-published projection rather than another discovery call.
  return {
    generatedAt: PRIOR_GENERATED_AT,
    stories: [{ sources: [{ canonicalKey, metrics }] }]
  } as unknown as DashboardPublicSnapshot;
}
