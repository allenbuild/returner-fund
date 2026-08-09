import { describe, expect, it } from "vitest";
import { buildDatabaseStats } from "@/lib/graph/database-stats";
import { buildEvidenceStats } from "@/lib/graph/evidence-stats";
import type { EvidenceItem, GraphResponse } from "@/lib/graph/types";

describe("published graph database stats", () => {
  it("publishes only attributable full-snapshot evidence and excludes foreign unscoped rows", () => {
    const stats = buildEvidenceStats([
      evidence("company-a", "company", "2026-08-09T01:00:00.000Z"),
      evidence("founder-a", "founder", "2026-08-08T01:00:00.000Z", "company-a"),
      evidence("company-b", "company", "not-a-date"),
      evidence("founder-b", "founder", "2026-08-09T02:00:00.000Z"),
      evidence("outside-company", "company", "2026-08-07T01:00:00.000Z"),
      evidence("outside-founder", "founder", "2026-08-07T02:00:00.000Z"),
      evidence("attached-foreign-founder", "founder", "2026-08-07T03:00:00.000Z", "company-a"),
      evidence("company-a", "company", "2026-08-06T01:00:00.000Z", "outside-company")
    ], {
      companyIds: new Set(["company-a", "company-b"]),
      founderIds: new Set(["founder-a", "founder-b"])
    });

    expect(stats.totalCount).toBe(5);
    expect(stats.byPlatform.x).toBe(5);
    expect(stats.firstSeenByDay).toEqual({
      "2026-08-07": 1,
      "2026-08-08": 1,
      "2026-08-09": 2
    });
    expect(stats.entityCoverage).toEqual({
      company: {
        withSourcesCount: 2,
        firstSeenByDay: { "2026-08-07": 1 }
      },
      founder: {
        withSourcesCount: 2,
        firstSeenByDay: { "2026-08-08": 1, "2026-08-09": 1 }
      }
    });
  });

  it("uses compact full-snapshot entity aggregates instead of the capped evidence preview", () => {
    const stats = buildDatabaseStats(publishedGraphWithCappedEvidence());

    expect(stats.sourceCount).toBe(36_663);
    expect(stats.sourcesToday).toBe(7);
    expect(stats.sourcesLast7Days).toBe(17);
    expect(stats.companyCount).toBe(3);
    expect(stats.founderCount).toBe(4);
    expect(stats.companyCoverage).toBe(67);
    expect(stats.founderCoverage).toBe(75);
    expect(stats.dailyGrowth.find((point) => point.dayKey === "2026-08-08")).toMatchObject({
      sources: 10,
      companies: 1,
      founders: 2
    });
    expect(stats.dailyGrowth.find((point) => point.dayKey === "2026-08-09")).toMatchObject({
      sources: 7,
      companies: 0,
      founders: 0
    });
  });

  it("retains preview-derived coverage for snapshots published before the aggregate rollout", () => {
    const graph = publishedGraphWithCappedEvidence();
    graph.evidenceStats = { ...graph.evidenceStats!, entityCoverage: undefined };

    const stats = buildDatabaseStats(graph);

    expect(stats.sourceCount).toBe(36_663);
    expect(stats.companyCoverage).toBe(33);
    expect(stats.founderCoverage).toBe(25);
  });
});

function publishedGraphWithCappedEvidence(): GraphResponse {
  return {
    nodes: [
      companyNode("company-a", ["founder-a", "founder-b"]),
      companyNode("company-b", ["founder-c"]),
      companyNode("company-c", ["founder-d"])
    ],
    evidence: [
      evidence("founder-a", "founder", "2026-08-09T03:00:00.000Z", "company-a")
    ],
    evidenceStats: {
      totalCount: 36_663,
      scoringEligibleCount: 15_563,
      byPlatform: { x: 28_649 },
      byTopic: {},
      firstSeenByDay: {
        "2026-01-01": 36_646,
        "2026-08-08": 10,
        "2026-08-09": 7
      },
      entityCoverage: {
        company: {
          withSourcesCount: 2,
          firstSeenByDay: { "2026-08-07": 1, "2026-08-08": 1 }
        },
        founder: {
          withSourcesCount: 3,
          firstSeenByDay: { "2026-08-06": 1, "2026-08-08": 2 }
        }
      }
    },
    generatedAt: "2026-08-09T12:09:54.800Z"
  } as unknown as GraphResponse;
}

function companyNode(entityId: string, founderIds: string[]): GraphResponse["nodes"][number] {
  return {
    entityType: "company",
    entityId,
    founders: founderIds.map((id) => ({ id }))
  } as GraphResponse["nodes"][number];
}

function evidence(
  entityId: string,
  entityType: EvidenceItem["entityType"],
  firstSeenAt: string,
  attachedCompanyId?: string
): EvidenceItem {
  return {
    id: `${entityType}:${entityId}:${firstSeenAt}`,
    entityType,
    entityId,
    platform: "x",
    authorName: entityId,
    authorHandle: entityId,
    postedAt: firstSeenAt,
    observedAt: firstSeenAt,
    first_seen_at: firstSeenAt,
    text: entityId,
    mediaType: "text",
    metrics: {},
    contributionScore: 1,
    tractionStatus: "scored",
    sourceUrl: `https://x.com/${entityId}`,
    why: "fixture",
    attachedCompanyId
  };
}
