import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import type { CompanyRecord, DemoGraphDataset, EvidenceItem, GraphResponse } from "@/lib/graph/types";
import type { LiveEvidenceRecord } from "@/lib/ingestion/live-source-refresh";

describe("GET /api/graph recomputation order", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/graph/yc-spring-2026-dataset");
    vi.doUnmock("@/lib/ingestion/live-source-refresh");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("overlays the full batch before applying score, industry, and platform display filters", async () => {
    const dataset = routeDataset();
    const liveRecord = liveXRecord();
    vi.doMock("@/lib/graph/yc-spring-2026-dataset", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/yc-spring-2026-dataset")>()),
      YC_SPRING_2026_BATCH_SLUG: "S2026",
      yc2026GraphDataset: dataset,
      ycSpring2026GraphDataset: dataset
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      loadLiveEvidenceRecords: vi.fn(async () => [liveRecord])
    }));

    const { clearGraphResponseCache } = await import("@/lib/graph/graph-response-cache");
    const { GET } = await import("@/app/api/graph/route");
    clearGraphResponseCache();

    const full = await graphResponse(GET, "http://localhost/api/graph?batch=S2026");
    const industry = await graphResponse(
      GET,
      "http://localhost/api/graph?batch=S2026&industries=keep"
    );
    const minScore = await graphResponse(
      GET,
      "http://localhost/api/graph?batch=S2026&minScore=1"
    );
    const platform = await graphResponse(
      GET,
      "http://localhost/api/graph?batch=S2026&platforms=x"
    );

    const fullAlpha = full.nodes.find((node) => node.entityId === "alpha");
    const industryAlpha = industry.nodes.find((node) => node.entityId === "alpha");
    expect(fullAlpha).toBeDefined();
    expect(industry.nodes.map((node) => node.entityId)).toEqual(["alpha"]);
    expect(industryAlpha?.score).toBe(fullAlpha?.score);
    expect(industryAlpha?.scoreBreakdown).toEqual(fullAlpha?.scoreBreakdown);
    expect(industryAlpha?.scoreBreakdown?.calibration.cohortSize).toBe(3);

    expect(minScore.nodes.map((node) => node.entityId).sort()).toEqual(
      full.nodes.map((node) => node.entityId).sort()
    );

    const expectedPlatform = applyClientGraphFilters(full, {
      platforms: ["x"],
      industries: [],
      groupPartners: [],
      minScore: 0
    });
    expect(platformProjection(platform)).toEqual(platformProjection(expectedPlatform));
    expect(platform.nodes.some((node) => node.entityId === "gamma")).toBe(true);
    expect(platform.evidence.some((item) => item.sourceUrl === liveRecord.sourceUrl)).toBe(true);
    expect(platform.fastestGaining.length).toBeGreaterThan(0);
    expect(
      platform.fastestGaining.every(
        (row) =>
          row.dod.baselineScore === null &&
          row.dod.baselineRank === null &&
          row.wow.baselineScore === null &&
          row.wow.baselineRank === null
      )
    ).toBe(true);
  });

  it("keeps canonical company scoring and momentum identical across Top Voice audiences after live updates", async () => {
    const dataset = routeDataset();
    const liveRecords = [
      topVoiceLiveXRecord("sama", "Sam Altman", "1000000000000000004"),
      topVoiceLiveXRecord("garrytan", "Garry Tan", "1000000000000000005")
    ];
    vi.doMock("@/lib/graph/yc-spring-2026-dataset", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/graph/yc-spring-2026-dataset")>()),
      YC_SPRING_2026_BATCH_SLUG: "S2026",
      yc2026GraphDataset: dataset,
      ycSpring2026GraphDataset: dataset
    }));
    vi.doMock("@/lib/ingestion/live-source-refresh", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ingestion/live-source-refresh")>()),
      loadLiveEvidenceRecords: vi.fn(async () => liveRecords)
    }));

    const { clearGraphResponseCache } = await import("@/lib/graph/graph-response-cache");
    const { GET } = await import("@/app/api/graph/route");
    clearGraphResponseCache();

    const [base, insiders, ycPartners] = await Promise.all([
      graphResponse(GET, "http://localhost/api/graph?batch=S2026"),
      graphResponse(GET, "http://localhost/api/graph?batch=S2026&topVoices=insiders"),
      graphResponse(GET, "http://localhost/api/graph?batch=S2026&topVoices=yc_partners")
    ]);
    const canonical = canonicalCompanyProjection(base, "alpha");

    expect(base.evidence.map((item) => item.sourceUrl)).toEqual(
      expect.arrayContaining(liveRecords.map((record) => record.sourceUrl))
    );
    expect(insiders.evidence).toHaveLength(1);
    expect(insiders.evidence[0]?.topVoice?.audienceId).toBe("insiders");
    expect(ycPartners.evidence).toHaveLength(1);
    expect(ycPartners.evidence[0]?.topVoice?.audienceId).toBe("yc_partners");
    expect(canonicalCompanyProjection(insiders, "alpha")).toEqual(canonical);
    expect(canonicalCompanyProjection(ycPartners, "alpha")).toEqual(canonical);
  });
});

async function graphResponse(
  GET: (request: Request) => Promise<Response>,
  url: string
): Promise<GraphResponse> {
  const response = await GET(new Request(url));
  expect(response.status).toBe(200);
  return response.json() as Promise<GraphResponse>;
}

function platformProjection(graph: GraphResponse) {
  return {
    nodes: graph.nodes.map((node) => ({
      entityId: node.entityId,
      score: node.score,
      topPlatform: node.topPlatform,
      platformScores: node.platformScores
    })),
    leaderboard: graph.leaderboard.map((row) => ({
      companyId: row.companyId,
      rank: row.rank,
      score: row.score,
      topPlatform: row.topPlatform
    })),
    evidence: graph.evidence.map((item) => ({
      sourceUrl: item.sourceUrl,
      contributionScore: item.contributionScore
    })),
    scoringContext: graph.scoringContext
      ? {
          modelId: graph.scoringContext.modelId,
          modelVersion: graph.scoringContext.modelVersion,
          modelName: graph.scoringContext.modelName,
          scoreScope: graph.scoringContext.scoreScope,
          selectedPlatforms: graph.scoringContext.selectedPlatforms,
          evidenceAsOf: graph.scoringContext.evidenceAsOf
        }
      : null
  };
}

function canonicalCompanyProjection(graph: GraphResponse, companyId: string) {
  const node = graph.nodes.find((candidate) => candidate.entityId === companyId);
  const leaderboard = graph.leaderboard.find((candidate) => candidate.companyId === companyId);
  const momentum = graph.fastestGaining.find((candidate) => candidate.companyId === companyId);
  expect(node).toBeDefined();
  expect(leaderboard).toBeDefined();
  expect(momentum).toBeDefined();

  return {
    node: {
      score: node!.score,
      radius: node!.radius,
      scoreBreakdown: node!.scoreBreakdown
    },
    leaderboard: {
      score: leaderboard!.score,
      rank: leaderboard!.rank
    },
    momentum
  };
}

function routeDataset(): DemoGraphDataset {
  return {
    mode: "demo",
    batches: [{ slug: "S2026", label: "Route fixture", companyCountExpected: 3, companyCountObserved: 3 }],
    companies: [
      company({ id: "alpha", name: "Alpha", totalScore: 95, primaryIndustry: "keep" }),
      company({ id: "beta", name: "Beta", totalScore: 0, primaryIndustry: "hide" }),
      company({ id: "gamma", name: "Gamma", totalScore: 0, primaryIndustry: "hide" })
    ],
    founders: [],
    evidence: [
      evidence({
        id: "alpha-x",
        entityId: "alpha",
        sourceUrl: "https://x.com/alpha/status/1000000000000000001",
        metrics: { views: 1_000_000, likes: 10_000 }
      }),
      evidence({
        id: "beta-x",
        entityId: "beta",
        sourceUrl: "https://x.com/beta/status/1000000000000000002",
        metrics: { views: 10_000, likes: 100 }
      }),
      evidence({
        id: "gamma-github",
        entityId: "gamma",
        platform: "github",
        sourceUrl: "https://github.com/example/gamma",
        metrics: { stars: 500, forks: 25 }
      })
    ],
    needsReview: [],
    platformStatus: []
  };
}

function company(overrides: Partial<CompanyRecord>): CompanyRecord {
  return {
    id: "company",
    batchSlug: "S2026",
    name: "Company",
    ycProfileUrl: "https://www.ycombinator.com/companies/company",
    websiteUrl: "https://example.com",
    tagline: "Route fixture",
    description: "Route fixture",
    groupPartner: null,
    primaryIndustry: "hide",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies/company",
    industries: [],
    founderIds: [],
    socialAccounts: [],
    totalScore: 0,
    previousScore: 0,
    platformScores: {},
    ...overrides
  };
}

function evidence(overrides: Partial<EvidenceItem>): EvidenceItem {
  return {
    id: "evidence",
    entityType: "company",
    entityId: "company",
    platform: "x",
    authorName: "Company",
    authorHandle: "company",
    postedAt: "2026-07-14T12:00:00.000Z",
    publishedAtPrecision: "exact",
    observedAt: "2026-07-15T12:00:00.000Z",
    metricsCheckedAt: "2026-07-15T12:00:00.000Z",
    text: "Verified traction evidence.",
    mediaType: "text",
    linkStatus: "verified",
    metrics: { likes: 1 },
    contributionScore: 1,
    sourceUrl: "https://x.com/company/status/1000000000000000000",
    first_seen_at: "2026-07-15T12:00:00.000Z",
    last_checked_at: "2026-07-15T12:00:00.000Z",
    last_updated_at: "2026-07-15T12:00:00.000Z",
    why: "Route fixture evidence.",
    review_state: "verified",
    ...overrides
  };
}

function liveXRecord(): LiveEvidenceRecord {
  return {
    id: "gamma-live-x",
    entityType: "company",
    entityId: "gamma",
    companyName: "Gamma",
    platform: "x",
    title: "Gamma launch",
    sourceUrl: "https://x.com/gamma/status/1000000000000000003",
    platformPostId: "1000000000000000003",
    text: "Gamma launch traction.",
    thumbnailUrl: null,
    thumbnailSource: null,
    rawVisibleText: "{}",
    postedAt: "2026-07-15T10:00:00.000Z",
    metrics: { views: 50_000, likes: 500, replies: 20, reposts: 10 },
    contributionScore: 1,
    review_state: "verified",
    matchReason: "Verified live route fixture.",
    first_seen_at: "2026-07-16T12:00:00.000Z",
    last_checked_at: "2026-07-16T12:00:00.000Z",
    last_updated_at: "2026-07-16T12:00:00.000Z"
  };
}

function topVoiceLiveXRecord(handle: string, displayName: string, postId: string): LiveEvidenceRecord {
  return {
    ...liveXRecord(),
    id: `alpha-live-x-${postId}`,
    entityId: "alpha",
    companyName: "Alpha",
    title: `${displayName} on Alpha traction`,
    sourceUrl: `https://x.com/${handle}/status/${postId}`,
    platformPostId: postId,
    text: `${displayName} says Alpha is seeing exceptional customer traction.`,
    rawVisibleText: JSON.stringify({
      post: { author: { screen_name: handle, name: displayName, url: `https://x.com/${handle}` } }
    }),
    metrics: { views: 50_000_000, likes: 500_000, replies: 20_000, reposts: 40_000 }
  };
}
