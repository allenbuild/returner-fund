import { describe, expect, it } from "vitest";
import { dashboardCandidatesFromGraph } from "@/lib/dashboard/returner-candidates";
import type { EvidenceItem, GraphResponse } from "@/lib/graph/types";

describe("Returner dashboard candidates", () => {
  it("derives a source-local baseline from earlier posts and carries a known follower count", () => {
    const candidates = dashboardCandidatesFromGraph({
      batch: { slug: "S26", label: "YC S26" },
      nodes: [],
      evidence: [
        evidence("one", "2026-08-10T09:00:00.000Z", 8),
        evidence("two", "2026-08-11T09:00:00.000Z", 10),
        evidence("three", "2026-08-12T09:00:00.000Z", 12),
        evidence("breakout", "2026-08-15T09:00:00.000Z", 240)
      ]
    } as unknown as GraphResponse);

    const breakout = candidates.find((candidate) => candidate.id.endsWith(":breakout"));
    expect(breakout).toMatchObject({
      followerCount: 12_000,
      accountBaseline: { likes: 10, views: 100 }
    });
  });
});

function evidence(id: string, postedAt: string, likes: number): EvidenceItem {
  return {
    id,
    entityType: "founder",
    entityId: "founder-1",
    platform: "x",
    authorName: "Maya Li",
    authorHandle: "mayali",
    postedAt,
    text: `Post ${id}`,
    mediaType: "text",
    metrics: { likes, views: 100, followers: 12_000 },
    contributionScore: 10,
    sourceUrl: `https://x.com/mayali/status/${id}`,
    why: ""
  };
}
