import { describe, expect, it } from "vitest";
import {
  buildGraphEdges,
  buildGraphResponse,
  getNodeRadius,
  nodeId
} from "@/lib/graph/graph-builder";
import { demoGraphDataset } from "@/lib/graph/demo-data";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { CompanyRecord, DemoGraphDataset, EvidenceItem, FounderRecord } from "@/lib/graph/types";

describe("graph builder", () => {
  it("sizes company and founder nodes relative to peers with caps", () => {
    const smallCompany = getNodeRadius(10, [10, 40, 90], "company");
    const largeCompany = getNodeRadius(90, [10, 40, 90], "company");
    const smallFounder = getNodeRadius(10, [10, 40, 90], "founder");
    const largeFounder = getNodeRadius(90, [10, 40, 90], "founder");

    expect(largeCompany).toBeGreaterThan(smallCompany);
    expect(largeFounder).toBeGreaterThan(smallFounder);
    expect(smallCompany).toBe(5);
    expect(largeCompany).toBe(68);
    expect(smallFounder).toBe(4);
    expect(largeFounder).toBe(38);
  });

  it("keeps founders out of the rendered graph edge set", () => {
    const companies = demoGraphDataset.companies.filter((company) => company.batchSlug === "S2026");
    const founders = demoGraphDataset.founders.filter((founder) => founder.batchSlug === "S2026");
    const edges = buildGraphEdges(companies, founders);

    expect(edges.some((edge) => edge.edgeType === "founder_of")).toBe(false);
    expect(edges.every((edge) => edge.source.startsWith("company:") && edge.target.startsWith("company:"))).toBe(true);
  });

  it("only creates same-group-partner edges when both companies have the same public value", () => {
    const source = makeCompany({
      id: "company-a",
      groupPartner: "Public Partner",
      industries: ["fintech"]
    });
    const target = makeCompany({
      id: "company-b",
      groupPartner: "Public Partner",
      industries: ["healthcare"]
    });
    const missing = makeCompany({
      id: "company-c",
      groupPartner: null,
      industries: ["fintech"]
    });

    const edges = buildGraphEdges([source, target, missing], [], { similarityThreshold: 1 });

    expect(edges.filter((edge) => edge.edgeType === "same_group_partner")).toHaveLength(1);
    expect(edges[0]).toEqual(
      expect.objectContaining({
        source: nodeId("company", "company-a"),
        target: nodeId("company", "company-b")
      })
    );
  });

  it("creates weighted industry-similarity edges above threshold", () => {
    const source = makeCompany({
      id: "company-a",
      industries: ["developer tools", "ai infrastructure"],
      description: "Evaluation tests for AI product teams"
    });
    const target = makeCompany({
      id: "company-b",
      industries: ["developer tools", "llm evals"],
      description: "Regression evaluation tools for AI teams"
    });

    const edges = buildGraphEdges([source, target], [], { similarityThreshold: 0.1 });
    const similarityEdge = edges.find((edge) => edge.edgeType === "industry_similarity");

    expect(similarityEdge).toBeDefined();
    expect(similarityEdge?.weight).toBeGreaterThan(0.1);
    expect(similarityEdge?.explanation).toContain("similarity score");
  });

  it("applies platform and founder-name query filters in the graph response", () => {
    const graph = buildGraphResponse(
      {
        batchSlug: "S2026",
        platforms: ["github"],
        query: "Luca"
      },
      demoGraphDataset
    );

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.label).toBe("PromptForge");
    expect(graph.nodes[0]?.founders.map((founder) => founder.name)).toContain("Luca Martin");
    expect(graph.edges.some((edge) => edge.edgeType === "founder_of")).toBe(false);
    expect(graph.evidence.every((item) => item.platform === "github")).toBe(true);
  });

  it("uses fuzzy company/founder matching for graph query filters", () => {
    const companyGraph = buildGraphResponse({ batchSlug: "S26", query: "Conifr" }, ycSpring2026GraphDataset);
    const founderGraph = buildGraphResponse({ batchSlug: "S2026", query: "Lukka Martn" }, demoGraphDataset);

    expect(companyGraph.nodes.map((node) => node.label)).toContain("Conifer");
    expect(founderGraph.nodes.map((node) => node.label)).toContain("PromptForge");
  });

  it("uses the Summer 2026 batch contract without numeric identity-quality fields", () => {
    const graph = buildGraphResponse();
    const bannedIdentityQualityField = ["con", "fidence"].join("");

    expect(graph.batch.label).toBe("YC Summer 2026");
    expect(graph.batch.companyCountExpected).toBe(83);
    expect(JSON.stringify(graph)).not.toContain(bannedIdentityQualityField);
    expect(graph.nodes[0]).toEqual(
      expect.objectContaining({
        review_state: expect.stringMatching(/^(verified|needs_review|rejected)$/),
        visual: expect.objectContaining({
          industryColor: expect.any(String),
          borderStyle: expect.any(String)
        })
      })
    );
    expect(graph.needsReview.every((item) => "review_state" in item)).toBe(true);
  });

  it("uses industry for node color and group partner for graph region", () => {
    const dataset = {
      ...demoGraphDataset,
      companies: [
        makeCompany({
          id: "b2b-a",
          name: "B2B A",
          primaryIndustry: "B2B",
          groupPartner: "Partner C"
        }),
        makeCompany({
          id: "fintech-a",
          name: "Fintech A",
          primaryIndustry: "Fintech",
          groupPartner: "Partner A"
        }),
        makeCompany({
          id: "fintech-b",
          name: "Fintech B",
          primaryIndustry: "Fintech",
          groupPartner: "Partner B"
        }),
        makeCompany({
          id: "healthcare-a",
          name: "Healthcare A",
          primaryIndustry: "Healthcare",
          groupPartner: "Partner A"
        })
      ],
      founders: [],
      evidence: [],
      needsReview: []
    };
    const graph = buildGraphResponse({ batchSlug: "S2026" }, dataset);

    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const fintechA = nodes.get(nodeId("company", "fintech-a"));
    const fintechB = nodes.get(nodeId("company", "fintech-b"));
    const healthcareA = nodes.get(nodeId("company", "healthcare-a"));
    const b2bA = nodes.get(nodeId("company", "b2b-a"));

    expect(b2bA?.visual.industryColor).toBe("#F6CA94");
    expect(b2bA?.visual.borderColor).toBe("#9A4B00");
    expect(fintechA?.visual.industryColor).toBe(fintechB?.visual.industryColor);
    expect(fintechA?.visual.industryColor).not.toBe(healthcareA?.visual.industryColor);
    expect(fintechA?.visual.groupRegion).toBe("Partner A");
    expect(fintechB?.visual.groupRegion).toBe("Partner B");

    const partnerAGraph = buildGraphResponse({ batchSlug: "S2026", groupPartners: ["Partner A"] }, dataset);
    expect(partnerAGraph.nodes.map((node) => node.label).sort()).toEqual(["Fintech A", "Healthcare A"]);
    expect(partnerAGraph.nodes.every((node) => node.groupPartner === "Partner A")).toBe(true);
  });

  it("preserves default scoring when Top Voices is off", () => {
    const dataset = topVoiceDataset();
    const graph = buildGraphResponse({ batchSlug: "S2026" }, dataset);

    expect(graph.selectedTopVoiceAudience.id).toBe("off");
    expect(graph.leaderboard.map((row) => [row.companyId, row.score])).toEqual([
      ["company-partner-backed", 50],
      ["company-founder-backed", 50],
      ["company-insider-backed", 50],
      ["company-outsider-backed", 50]
    ]);
    expect(graph.edges.some((edge) => edge.edgeType === "top_voice_attention")).toBe(false);
  });

  it("filters YC Partners mode to partner-authored traction only", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, topVoiceDataset());

    expect(graph.selectedTopVoiceAudience.displayName).toBe("YC Partners");
    expect(graph.leaderboard.map((row) => row.companyId)).toEqual(["company-partner-backed"]);
    expect(graph.leaderboard[0]?.topVoiceConnectionCount).toBe(1);
    expect(graph.leaderboard[0]?.topVoiceConnections?.[0]?.displayName).toBe("Garry Tan");
    expect(graph.evidence).toHaveLength(1);
    expect(graph.evidence[0]?.authorName).toBe("Garry Tan");
    expect(graph.nodes.some((node) => node.isTopVoiceNode && node.label === "Garry Tan")).toBe(true);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        edgeType: "top_voice_attention",
        label: "Garry Tan",
        target: "company:company-partner-backed"
      })
    ]);
  });

  it("weights YC Batch Circle partners above current-batch founders", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_batch_circle" }, topVoiceDataset());

    const partnerBacked = graph.leaderboard.find((row) => row.companyId === "company-partner-backed");
    const founderBacked = graph.leaderboard.find((row) => row.companyId === "company-founder-backed");

    expect(partnerBacked?.topVoiceConnections?.[0]).toEqual(expect.objectContaining({ displayName: "Garry Tan", weight: 2 }));
    expect(founderBacked?.topVoiceConnections?.[0]).toEqual(expect.objectContaining({ displayName: "Maya Chen", weight: 1 }));
    expect(partnerBacked?.score ?? 0).toBeGreaterThan(founderBacked?.score ?? 0);
    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-outsider-backed");
  });

  it("uses the curated Insiders seed without admitting non-members", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "insiders" }, topVoiceDataset());

    expect(graph.leaderboard.map((row) => row.companyId).sort()).toEqual([
      "company-insider-backed",
      "company-partner-backed"
    ]);
    expect(graph.leaderboard.find((row) => row.companyId === "company-insider-backed")?.topVoiceConnections?.[0])
      .toEqual(expect.objectContaining({ displayName: "Sam Altman" }));
    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-outsider-backed");
  });
});

function makeCompany(overrides: Partial<CompanyRecord>): CompanyRecord {
  return {
    id: "company",
    batchSlug: "S2026",
    name: "Demo Company",
    ycProfileUrl: "https://example.com/yc/demo",
    websiteUrl: "https://example.com",
    tagline: "Demo tagline",
    description: "Demo description",
    groupPartner: null,
    primaryIndustry: "fintech",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies?batch=S2026",
    industries: [],
    founderIds: [],
    socialAccounts: [],
    totalScore: 50,
    previousScore: 45,
    platformScores: { web: 50 },
    ...overrides
  };
}

function topVoiceDataset(): DemoGraphDataset {
  const companies = [
    makeCompany({
      id: "company-partner-backed",
      name: "Partner Backed",
      founderIds: ["founder-partner-backed"]
    }),
    makeCompany({
      id: "company-founder-backed",
      name: "Founder Backed",
      founderIds: ["founder-maya-chen"]
    }),
    makeCompany({
      id: "company-insider-backed",
      name: "Insider Backed",
      founderIds: ["founder-insider-backed"]
    }),
    makeCompany({
      id: "company-outsider-backed",
      name: "Outsider Backed",
      founderIds: ["founder-outsider-backed"]
    })
  ];

  return {
    mode: "official_snapshot",
    batches: [{ slug: "S2026", label: "YC Spring 2026", companyCountExpected: 4, companyCountObserved: 4 }],
    companies,
    founders: [
      makeFounder({
        id: "founder-maya-chen",
        name: "Maya Chen",
        companyIds: ["company-founder-backed"],
        socialAccounts: [
          {
            id: "acct-maya-x",
            platform: "x",
            handle: "maya_demo",
            url: "https://x.com/maya_demo",
            review_state: "verified",
            discoveredFromUrl: "https://example.com",
            matchReason: "Test founder account."
          }
        ]
      }),
      makeFounder({ id: "founder-partner-backed", name: "Pat Partner", companyIds: ["company-partner-backed"] }),
      makeFounder({ id: "founder-insider-backed", name: "Ivy Insider", companyIds: ["company-insider-backed"] }),
      makeFounder({ id: "founder-outsider-backed", name: "Otto Outsider", companyIds: ["company-outsider-backed"] })
    ],
    evidence: [
      makeEvidence({
        id: "evidence-garry",
        entityId: "company-partner-backed",
        authorName: "Garry Tan",
        authorHandle: "garrytan",
        contributionScore: 40,
        sourceUrl: "https://x.com/garrytan/status/1"
      }),
      makeEvidence({
        id: "evidence-maya",
        entityType: "founder",
        entityId: "founder-maya-chen",
        authorName: "Maya Chen",
        authorHandle: "maya_demo",
        contributionScore: 40,
        sourceUrl: "https://x.com/maya_demo/status/2"
      }),
      makeEvidence({
        id: "evidence-sam",
        entityId: "company-insider-backed",
        authorName: "Sam Altman",
        authorHandle: "sama",
        contributionScore: 40,
        sourceUrl: "https://x.com/sama/status/3"
      }),
      makeEvidence({
        id: "evidence-outsider",
        entityId: "company-outsider-backed",
        authorName: "Helpful Outsider",
        authorHandle: "helpful_outsider",
        contributionScore: 95,
        sourceUrl: "https://x.com/helpful_outsider/status/4"
      })
    ],
    needsReview: [],
    platformStatus: []
  };
}

function makeFounder(overrides: Partial<FounderRecord>): FounderRecord {
  return {
    id: "founder",
    batchSlug: "S2026",
    name: "Demo Founder",
    ycProfileUrl: "https://example.com/yc/founder",
    personalWebsiteUrl: null,
    primaryIndustry: "fintech",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies?batch=S2026",
    companyIds: [],
    socialAccounts: [],
    totalScore: 0,
    previousScore: 0,
    platformScores: {},
    ...overrides
  };
}

function makeEvidence(overrides: Partial<EvidenceItem>): EvidenceItem {
  return {
    id: "evidence",
    entityType: "company",
    entityId: "company",
    platform: "x",
    authorName: "Demo Author",
    authorHandle: "demo",
    postedAt: "2026-06-29T00:00:00.000Z",
    title: "Demo X post",
    text: "Demo X post.",
    mediaType: "text",
    metrics: { likes: 40 },
    contributionScore: 40,
    sourceUrl: "https://x.com/demo/status/1",
    why: "Test evidence.",
    ...overrides
  };
}
