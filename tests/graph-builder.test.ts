import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGraphEdges,
  buildGraphResponse,
  getNodeRadius,
  nodeId
} from "@/lib/graph/graph-builder";
import { demoGraphDataset } from "@/lib/graph/demo-data";
import { TRACTION_SCORING_CONFIG } from "@/lib/graph/traction-scoring-config";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";
import type { CompanyRecord, DemoGraphDataset, EvidenceItem, FounderRecord } from "@/lib/graph/types";

const graphBuilderBenchmark = process.env.RUN_GRAPH_BUILDER_BENCHMARK === "1" ? it : it.skip;

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

  it("matches the legacy all-pairs similarity edge semantics", () => {
    const companies = [
      makeCompany({
        id: "company-a",
        name: "Company A",
        industries: ["Developer Tools", "AI Infrastructure", "developer tools"],
        tagline: "Fast, reliable evals!",
        description: "Evaluation tests for AI product teams."
      }),
      makeCompany({
        id: "company-b",
        name: "Company B",
        industries: ["developer tools", "LLM Evals"],
        tagline: "Regression evaluation tools",
        description: "Evaluation workflows for reliable AI teams."
      }),
      makeCompany({
        id: "company-c",
        name: "Company C",
        industries: ["Healthcare", "Clinical AI"],
        tagline: "Clinical workflow automation",
        description: "AI assistants for clinical operations teams."
      }),
      makeCompany({
        id: "company-d",
        name: "Company D",
        industries: ["healthcare", "Developer Tools"],
        tagline: "Clinical model evaluation",
        description: "Reliable evaluation tests for clinical AI models."
      }),
      makeCompany({
        id: "company-e",
        name: "Company E",
        industries: [],
        tagline: "The company builds for teams",
        description: "And gives the teams a workflow."
      })
    ];
    const threshold = 0.05;

    expect(
      buildGraphEdges(companies, [], {
        selectedEdgeTypes: ["industry_similarity"],
        similarityThreshold: threshold
      })
    ).toEqual(buildLegacySimilarityEdges(companies, threshold));
  });

  graphBuilderBenchmark("reports graph-builder CPU benchmark timings and semantic hashes", () => {
    const similarityCompanies = makeSimilarityBenchmarkCompanies(420);
    const evidenceDataset = makeEvidenceBenchmarkDataset(500, 12);
    const similarity = measureMedian(() =>
      buildGraphEdges(similarityCompanies, [], {
        selectedEdgeTypes: ["industry_similarity"],
        similarityThreshold: 0
      })
    );
    const response = measureMedian(() =>
      buildGraphResponse(
        {
          batchSlug: "S2026",
          edgeTypes: ["same_group_partner"],
          platforms: ["x"]
        },
        evidenceDataset
      )
    );
    const normalizedResponse = {
      ...response.result,
      generatedAt: "<generated-at>",
      scoringContext: {
        ...response.result.scoringContext,
        responseBuiltAt: "<generated-at>"
      }
    };
    const benchmarkResult = {
      similarityMedianMs: similarity.medianMs,
      responseMedianMs: response.medianMs,
      similarityEdgeCount: similarity.result.length,
      responseNodeCount: response.result.nodes.length,
      responseEvidenceCount: response.result.evidence.length,
      similaritySha256: sha256(similarity.result),
      responseSha256: sha256(normalizedResponse)
    };

    console.info(`GRAPH_BUILDER_BENCHMARK ${JSON.stringify(benchmarkResult)}`);
    expect(benchmarkResult).toEqual(
      expect.objectContaining({
        similarityEdgeCount: expect.any(Number),
        responseNodeCount: 500,
        responseEvidenceCount: 6_000,
        similaritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
  }, 120_000);

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

  it("filters platform evidence without changing canonical company or founder score state", () => {
    const dataset: DemoGraphDataset = {
      mode: "demo",
      batches: [{ slug: "S2026", label: "Test batch", companyCountExpected: 3, companyCountObserved: 3 }],
      companies: [
        makeCompany({
          id: "stored-high",
          name: "Stored High",
          founderIds: ["founder-stored-high"],
          totalScore: 95,
          previousScore: 90,
          platformScores: { github: 95 }
        }),
        makeCompany({
          id: "selected-high-a",
          name: "Selected High A",
          totalScore: 5,
          previousScore: 4,
          platformScores: { github: 5 }
        }),
        makeCompany({
          id: "selected-high-b",
          name: "Selected High B",
          totalScore: 4,
          previousScore: 3,
          platformScores: { github: 4 }
        })
      ],
      founders: [
        makeFounder({
          id: "founder-stored-high",
          companyIds: ["stored-high"],
          totalScore: 95,
          previousScore: 90,
          platformScores: { github: 95 }
        })
      ],
      evidence: [
        makeEvidence({
          id: "x-founder-low",
          entityType: "founder",
          entityId: "founder-stored-high",
          contributionScore: 20,
          metricsCheckedAt: "2026-07-14T10:00:00.000Z"
        }),
        makeEvidence({
          id: "x-company-high-a",
          entityId: "selected-high-a",
          contributionScore: 80,
          metricsCheckedAt: "2026-07-16T12:00:00.000Z"
        }),
        makeEvidence({
          id: "x-company-high-b",
          entityId: "selected-high-b",
          contributionScore: 80,
          metricsCheckedAt: "2026-07-15T12:00:00.000Z"
        })
      ],
      needsReview: [],
      platformStatus: []
    };

    const canonicalGraph = buildGraphResponse({ batchSlug: "S2026" }, dataset);
    const graph = buildGraphResponse({ batchSlug: "S2026", platforms: ["x"] }, dataset);
    const storedHigh = graph.nodes.find((node) => node.entityId === "stored-high");

    expect(graph.leaderboard.map((row) => [row.companyId, row.rank])).toEqual([
      ["stored-high", 1],
      ["selected-high-a", 2],
      ["selected-high-b", 3]
    ]);
    expect(graph.leaderboard.map(({ companyId, score, rank }) => ({ companyId, score, rank })))
      .toEqual(canonicalGraph.leaderboard.map(({ companyId, score, rank }) => ({ companyId, score, rank })));
    expect(graph.fastestGaining).toEqual(canonicalGraph.fastestGaining);
    expect(graph.evidence.every((item) => item.platform === "x")).toBe(true);
    expect(graph.nodes.map((node) => ({
      entityId: node.entityId,
      score: node.score,
      previousScore: node.previousScore,
      radius: node.radius,
      topPlatform: node.topPlatform,
      platformScores: node.platformScores,
      scoreBreakdown: node.scoreBreakdown
    }))).toEqual(canonicalGraph.nodes.map((node) => ({
      entityId: node.entityId,
      score: node.score,
      previousScore: node.previousScore,
      radius: node.radius,
      topPlatform: node.topPlatform,
      platformScores: node.platformScores,
      scoreBreakdown: node.scoreBreakdown
    })));
    expect(storedHigh?.score).toBe(95);
    expect(storedHigh?.topPlatform).toBe("github");
    expect(storedHigh?.founders[0]?.platformScores).toEqual({ github: 95 });
    expect(graph.scoringContext).toEqual({
      modelId: TRACTION_SCORING_CONFIG.modelId,
      modelVersion: TRACTION_SCORING_CONFIG.version,
      modelName: TRACTION_SCORING_CONFIG.name,
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: graph.generatedAt,
      evidenceAsOf: "2026-07-16T12:00:00.000Z"
    });
  });

  it("preserves legacy company evidence ownership, ordering, and tied ranks", () => {
    const companies = [
      makeCompany({ id: "company-alpha", name: "Alpha", founderIds: ["founder-alpha"] }),
      makeCompany({ id: "company-beta", name: "Beta", founderIds: ["founder-shared"] }),
      makeCompany({ id: "company-gamma", name: "Gamma", founderIds: ["founder-shared"] })
    ];
    const evidence = [
      makeEvidence({ id: "evidence-alpha", entityId: "company-alpha", contributionScore: 70 }),
      makeEvidence({
        id: "evidence-attached-alpha",
        entityType: "founder",
        entityId: "founder-shared",
        attachedCompanyId: "company-alpha",
        contributionScore: 90
      }),
      makeEvidence({
        id: "evidence-shared",
        entityType: "founder",
        entityId: "founder-shared",
        contributionScore: 55
      }),
      makeEvidence({ id: "evidence-beta", entityId: "company-beta", contributionScore: 40 }),
      makeEvidence({ id: "evidence-gamma", entityId: "company-gamma", contributionScore: 40 })
    ];
    const dataset: DemoGraphDataset = {
      mode: "demo",
      batches: [{ slug: "S2026", label: "Test batch", companyCountExpected: 3, companyCountObserved: 3 }],
      companies,
      founders: [
        makeFounder({ id: "founder-alpha", companyIds: ["company-alpha"] }),
        makeFounder({ id: "founder-shared", companyIds: ["company-beta", "company-gamma"] })
      ],
      evidence,
      needsReview: [],
      platformStatus: []
    };

    const graph = buildGraphResponse(
      { batchSlug: "S2026", edgeTypes: ["same_group_partner"], platforms: ["x"] },
      dataset
    );
    const legacyEvidenceByCompany = legacyGroupCompanyRollupEvidence(companies, evidence);
    const expectedRanks = legacyTiedRanks(
      graph.nodes.map((node) => ({ id: node.entityId, score: node.score }))
    );

    expect(graph.evidence.map((item) => item.id)).toEqual([
      "evidence-attached-alpha",
      "evidence-alpha",
      "evidence-shared",
      "evidence-beta",
      "evidence-gamma"
    ]);
    expect(graph.leaderboard.map((row) => [row.companyId, row.rank, row.biggestContribution?.id])).toEqual(
      graph.leaderboard.map((row) => [
        row.companyId,
        expectedRanks.get(row.companyId),
        legacyEvidenceByCompany.get(row.companyId)?.[0]?.id
      ])
    );
    expect(graph.leaderboard.find((row) => row.companyId === "company-beta")?.rank).toBe(
      graph.leaderboard.find((row) => row.companyId === "company-gamma")?.rank
    );
    expect(legacyEvidenceByCompany.get("company-alpha")?.map((item) => item.id)).toEqual([
      "evidence-attached-alpha",
      "evidence-alpha"
    ]);
    expect(legacyEvidenceByCompany.get("company-beta")?.map((item) => item.id)).toEqual([
      "evidence-shared",
      "evidence-beta"
    ]);
    expect(legacyEvidenceByCompany.get("company-gamma")?.map((item) => item.id)).toEqual([
      "evidence-shared",
      "evidence-gamma"
    ]);
  });

  it("orders tied leaderboard rows canonically regardless of company input order", () => {
    const companies = [
      makeCompany({ id: "company-z", name: "Zulu", totalScore: 50 }),
      makeCompany({ id: "company-b", name: "Alpha", totalScore: 50 }),
      makeCompany({ id: "company-a", name: "Alpha", totalScore: 50 })
    ];
    const buildDataset = (orderedCompanies: CompanyRecord[]): DemoGraphDataset => ({
      mode: "demo",
      batches: [{ slug: "S2026", label: "Test batch", companyCountExpected: 3, companyCountObserved: 3 }],
      companies: orderedCompanies,
      founders: [],
      evidence: [],
      needsReview: [],
      platformStatus: []
    });
    const leaderboardIdentity = (orderedCompanies: CompanyRecord[]) =>
      buildGraphResponse(
        { batchSlug: "S2026", edgeTypes: ["same_group_partner"] },
        buildDataset(orderedCompanies)
      ).leaderboard.map((row) => [row.companyId, row.companyName, row.rank]);
    const expected = [
      ["company-a", "Alpha", 1],
      ["company-b", "Alpha", 1],
      ["company-z", "Zulu", 1]
    ];

    expect(leaderboardIdentity(companies)).toEqual(expected);
    expect(leaderboardIdentity([...companies].reverse())).toEqual(expected);
  });

  it("uses fuzzy company/founder matching for graph query filters", () => {
    const companyGraph = buildGraphResponse({ batchSlug: "S26", query: "Conifr" }, ycSpring2026GraphDataset);
    const founderGraph = buildGraphResponse({ batchSlug: "S2026", query: "Lukka Martn" }, demoGraphDataset);

    expect(companyGraph.nodes.map((node) => node.label)).toContain("Conifer");
    expect(founderGraph.nodes.map((node) => node.label)).toContain("PromptForge");
  });

  it("uses the Summer 2026 batch contract without numeric identity-quality fields", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" });
    const bannedIdentityQualityField = ["con", "fidence"].join("");

    expect(graph.batch.label).toBe("YC Summer 2026 (S26)");
    expect(graph.batch.companyCountExpected).toBe(83);
    expect(graph.nodes.every((node) => !(bannedIdentityQualityField in node))).toBe(true);
    expect(
      graph.nodes.every((node) =>
        [...node.socialAccounts, ...node.founders.flatMap((founder) => founder.socialAccounts)]
          .every((account) => !(bannedIdentityQualityField in account))
      )
    ).toBe(true);
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
      ["company-founder-backed", 50],
      ["company-insider-backed", 50],
      ["company-outsider-backed", 50],
      ["company-partner-backed", 50]
    ]);
    expect(graph.fastestGaining.every((row) =>
      row.dod.baselineScore === 45 &&
      row.dod.baselineRank === 1 &&
      row.dod.benchmarkedAt === null &&
      row.wow.baselineScore === 45 &&
      row.wow.baselineRank === 1 &&
      row.wow.benchmarkedAt === null
    )).toBe(true);
    expect(graph.edges.some((edge) => edge.edgeType === "top_voice_attention")).toBe(false);
  });

  it("filters YC Partners mode to partner-authored traction only", () => {
    const dataset = topVoiceDataset();
    const canonicalGraph = buildGraphResponse({ batchSlug: "S2026" }, dataset);
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, dataset);
    const canonicalNode = canonicalGraph.nodes.find((node) => node.entityId === "company-partner-backed");
    const audienceNode = graph.nodes[0];

    expect(graph.selectedTopVoiceAudience.displayName).toBe("YC Partners");
    expect(graph.leaderboard.map((row) => row.companyId)).toEqual(["company-partner-backed"]);
    expect(graph.leaderboard[0]).toEqual(expect.objectContaining({ score: 50, rank: 1 }));
    expect(graph.leaderboard[0]?.topVoiceConnectionCount).toBe(1);
    expect(graph.leaderboard[0]?.topVoiceConnections?.[0]?.displayName).toBe("Garry Tan");
    expect(graph.leaderboard[0]?.topVoiceConnections?.[0]?.contributionScore).toBe(40);
    expect(graph.evidence).toHaveLength(1);
    expect(graph.evidence[0]?.authorName).toBe("Garry Tan");
    expect(graph.evidence[0]?.topVoice?.displayName).toBe("Garry Tan");
    expect(graph.evidence[0]?.topVoice?.weight).toEqual(expect.any(Number));
    expect(graph.leaderboard[0]?.topVoiceConnections?.[0]?.weight)
      .toBe(graph.evidence[0]?.topVoice?.weight);
    expect(graph.evidence[0]?.topVoice?.originalContributionScore).toBe(40);
    expect(graph.evidence[0]?.contributionScore).toBe(40);
    expect(audienceNode).toEqual(expect.objectContaining({
      score: canonicalNode?.score,
      previousScore: canonicalNode?.previousScore,
      radius: canonicalNode?.radius,
      topPlatform: canonicalNode?.topPlatform,
      platformScores: canonicalNode?.platformScores,
      scoreBreakdown: canonicalNode?.scoreBreakdown
    }));
    expect(graph.nodes.some((node) => node.isTopVoiceNode)).toBe(false);
    expect(graph.edges.some((edge) => edge.edgeType === "top_voice_attention")).toBe(false);
    expect(graph.nodes.map((node) => node.id)).toEqual(["company:company-partner-backed"]);
    expect(graph.scoringContext).toEqual(
      expect.objectContaining({
        scoreScope: "all_platforms",
        selectedPlatforms: [],
        responseBuiltAt: graph.generatedAt
      })
    );
  });

  it("preserves full-cohort canonical momentum in a filtered Top Voice response", () => {
    const dataset = topVoiceDataset();
    const canonicalGraph = buildGraphResponse({ batchSlug: "S2026" }, dataset);
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, dataset);
    const canonicalRow = canonicalGraph.fastestGaining.find(
      (row) => row.companyId === "company-partner-backed"
    );

    expect(graph.fastestGaining).toHaveLength(1);
    expect(graph.fastestGaining[0]).toEqual(canonicalRow);
    expect(graph.fastestGaining[0]?.dod).toEqual(expect.objectContaining({
      currentScore: 50,
      currentRank: 1,
      baselineScore: 45,
      baselineRank: 1,
      scoreDelta: 5,
      benchmarkedAt: null
    }));
  });

  it("keeps empty Top Voice audiences free of fabricated momentum rows", () => {
    const dataset = topVoiceDataset();
    dataset.evidence = [];

    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, dataset);

    expect(graph.selectedTopVoiceAudience.id).toBe("yc_partners");
    expect(graph.nodes).toEqual([]);
    expect(graph.leaderboard).toEqual([]);
    expect(graph.fastestGaining).toEqual([]);
  });

  it("treats removed batch-circle audience URLs as the default all-voices graph", () => {
    const staleAudience = ["yc", "batch", "circle"].join("_") as never;
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: staleAudience }, topVoiceDataset());

    expect(graph.selectedTopVoiceAudience.id).toBe("off");
    expect(graph.leaderboard.map((row) => row.companyId)).toEqual([
      "company-founder-backed",
      "company-insider-backed",
      "company-outsider-backed",
      "company-partner-backed"
    ]);
  });

  it("does not count organization accounts as YC Partner attention", () => {
    const dataset = topVoiceDataset();
    dataset.companies = [
      ...dataset.companies,
      makeCompany({
        id: "company-yc-quoted",
        name: "YC Quoted",
        founderIds: ["founder-yc-quoted"]
      })
    ];
    dataset.founders = [
      ...dataset.founders,
      makeFounder({ id: "founder-yc-quoted", name: "Quinn Quote", companyIds: ["company-yc-quoted"] })
    ];
    dataset.evidence = [
      ...dataset.evidence,
      makeEvidence({
        id: "evidence-yc-quote",
        entityId: "company-yc-quoted",
        authorName: "Quinn Quote",
        authorHandle: "quinnquote",
        contributionScore: 35,
        sourceUrl: "https://x.com/quinnquote/status/5",
        rawVisibleText: JSON.stringify({
          author: "quinnquote",
          rawText: "Quinn Quote\n@quinnquote\n·\nJun 12\nWe launched today.\nQuote\nY Combinator\n@ycombinator\n·\nJun 12\nYC post about YC Quoted"
        })
      })
    ];

    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, dataset);

    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-yc-quoted");
    expect(graph.evidence.find((item) => item.id === "evidence-yc-quote")).toBeUndefined();
  });

  it("does not count repost markers as native Top Voice posts", () => {
    const dataset = topVoiceDataset();
    dataset.companies = [
      ...dataset.companies,
      makeCompany({
        id: "company-garry-reposted",
        name: "Garry Reposted",
        founderIds: ["founder-garry-reposted"]
      }),
      makeCompany({
        id: "company-founder-reposted-yc",
        name: "Founder Reposted YC",
        founderIds: ["founder-founder-reposted-yc"]
      })
    ];
    dataset.founders = [
      ...dataset.founders,
      makeFounder({ id: "founder-garry-reposted", name: "Pierre Founder", companyIds: ["company-garry-reposted"] }),
      makeFounder({ id: "founder-founder-reposted-yc", name: "Riley Founder", companyIds: ["company-founder-reposted-yc"] })
    ];
    dataset.evidence = [
      ...dataset.evidence,
      makeEvidence({
        id: "evidence-garry-reposted",
        entityId: "company-garry-reposted",
        authorName: "Pierre Founder",
        authorHandle: "pierrefounder",
        contributionScore: 35,
        sourceUrl: "https://x.com/pierrefounder/status/6",
        rawVisibleText: "Garry Tan reposted\nPierre Founder\n@pierrefounder\nWe hit 2,200 paying customers."
      }),
      makeEvidence({
        id: "evidence-founder-reposted-yc",
        entityId: "company-founder-reposted-yc",
        authorName: "Riley Founder",
        authorHandle: "rileyfounder",
        contributionScore: 35,
        sourceUrl: "https://x.com/rileyfounder/status/7",
        rawVisibleText: "Riley Founder reposted this Y Combinator\nY Combinator\n@ycombinator\nGeneral YC advice."
      })
    ];

    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, dataset);

    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-garry-reposted");
    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-founder-reposted-yc");
  });

  it("does not count X retweet JSON as native Top Voice posts", () => {
    const dataset = topVoiceDataset();
    dataset.companies = [
      ...dataset.companies,
      makeCompany({
        id: "company-garry-retweet-json",
        name: "Garry Retweet JSON",
        founderIds: ["founder-garry-retweet-json"]
      })
    ];
    dataset.founders = [
      ...dataset.founders,
      makeFounder({ id: "founder-garry-retweet-json", name: "Rory Founder", companyIds: ["company-garry-retweet-json"] })
    ];
    dataset.evidence = [
      ...dataset.evidence,
      makeEvidence({
        id: "evidence-garry-retweet-json",
        entityId: "company-garry-retweet-json",
        authorName: "Garry Tan",
        authorHandle: "garrytan",
        contributionScore: 60,
        sourceUrl: "https://x.com/garrytan/status/8",
        text: "RT @roryfounder: Garry Retweet JSON is live",
        rawVisibleText: JSON.stringify({
          post: {
            is_retweet: true,
            retweeted_status: {
              author: { screen_name: "roryfounder" },
              text: "Garry Retweet JSON is live"
            }
          }
        })
      })
    ];

    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, dataset);

    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-garry-retweet-json");
    expect(graph.evidence.find((item) => item.id === "evidence-garry-retweet-json")).toBeUndefined();
  });

  it("does not match Top Voice identity from spoofed social hosts", () => {
    const dataset = topVoiceDataset();
    dataset.companies = [
      ...dataset.companies,
      makeCompany({
        id: "company-spoof-host",
        name: "Spoof Host",
        founderIds: ["founder-spoof-host"]
      })
    ];
    dataset.founders = [
      ...dataset.founders,
      makeFounder({ id: "founder-spoof-host", name: "Hana Founder", companyIds: ["company-spoof-host"] })
    ];
    dataset.evidence = [
      ...dataset.evidence,
      makeEvidence({
        id: "evidence-spoof-host",
        entityId: "company-spoof-host",
        authorName: "Not Garry",
        authorHandle: null,
        contributionScore: 60,
        sourceUrl: "https://x.com.evil.test/garrytan/status/9",
        text: "Spoof Host is live."
      })
    ];

    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "yc_partners" }, dataset);

    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-spoof-host");
    expect(graph.evidence.find((item) => item.id === "evidence-spoof-host")).toBeUndefined();
  });

  it("does not let generated author fields override a different native post author", () => {
    const dataset = topVoiceDataset();
    dataset.companies = [
      ...dataset.companies,
      makeCompany({
        id: "company-generated-author-spoof",
        name: "Generated Author Spoof",
        founderIds: ["founder-generated-author-spoof"]
      })
    ];
    dataset.founders = [
      ...dataset.founders,
      makeFounder({
        id: "founder-generated-author-spoof",
        name: "Gina Founder",
        companyIds: ["company-generated-author-spoof"]
      })
    ];
    dataset.evidence = [
      ...dataset.evidence,
      makeEvidence({
        id: "evidence-generated-author-spoof",
        entityId: "company-generated-author-spoof",
        authorName: "Sam Altman",
        authorHandle: "sama",
        contributionScore: 60,
        sourceUrl: "https://x.com/not_sama/status/10",
        text: "Generated Author Spoof is live.",
        rawVisibleText: JSON.stringify({
          post: {
            authorName: "Not Sam",
            authorHandle: "not_sama",
            text: "Generated Author Spoof is live."
          }
        })
      })
    ];

    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "insiders" }, dataset);

    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-generated-author-spoof");
    expect(graph.evidence.find((item) => item.id === "evidence-generated-author-spoof")).toBeUndefined();
  });

  it("does not match Top Voice identity from nested repost or detail author fields", () => {
    const dataset = topVoiceDataset();
    dataset.companies = [
      ...dataset.companies,
      makeCompany({
        id: "company-nested-detail-spoof",
        name: "Nested Detail Spoof",
        founderIds: ["founder-nested-detail-spoof"]
      })
    ];
    dataset.founders = [
      ...dataset.founders,
      makeFounder({
        id: "founder-nested-detail-spoof",
        name: "Nia Founder",
        companyIds: ["company-nested-detail-spoof"]
      })
    ];
    dataset.evidence = [
      ...dataset.evidence,
      makeEvidence({
        id: "evidence-nested-detail-spoof",
        entityId: "company-nested-detail-spoof",
        platform: "linkedin",
        authorName: "Company Page",
        authorHandle: "company-page",
        contributionScore: 60,
        sourceUrl: "https://www.linkedin.com/posts/company-page_nested-detail-spoof-activity-7470000000000000000-test",
        title: "Company Page reshared Taro Fukuyama",
        text: "Nested Detail Spoof is live.",
        rawVisibleText: JSON.stringify({
          post: {
            authorName: "Company Page",
            authorHandle: "company-page",
            rawText: "Nested Detail Spoof is live."
          },
          detail: {
            authorName: "Taro Fukuyama",
            authorHandle: "tarof",
            rawText: "Taro Fukuyama mentioned Nested Detail Spoof."
          }
        })
      })
    ];

    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "insiders" }, dataset);

    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-nested-detail-spoof");
    expect(graph.evidence.find((item) => item.id === "evidence-nested-detail-spoof")).toBeUndefined();
  });

  it("uses the curated Insiders seed without admitting non-members", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", topVoices: "insiders" }, topVoiceDataset());

    expect(graph.leaderboard.map((row) => row.companyId)).toEqual(["company-insider-backed"]);
    expect(graph.leaderboard.find((row) => row.companyId === "company-insider-backed")?.topVoiceConnections?.[0])
      .toEqual(expect.objectContaining({ displayName: "Sam Altman" }));
    expect(graph.leaderboard.map((row) => row.companyId)).not.toContain("company-partner-backed");
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
    batches: [{ slug: "S2026", label: "YC Spring 2026 (P26)", companyCountExpected: 4, companyCountObserved: 4 }],
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
        sourceUrl: "https://x.com/garrytan/status/1",
        title: "Garry Tan says Partner Backed is worth watching",
        text: "Partner Backed has strong founder-market fit."
      }),
      makeEvidence({
        id: "evidence-maya",
        entityType: "founder",
        entityId: "founder-maya-chen",
        authorName: "Maya Chen",
        authorHandle: "maya_demo",
        contributionScore: 40,
        sourceUrl: "https://x.com/maya_demo/status/2",
        title: "Maya Chen posted about Founder Backed",
        text: "Founder Backed is live."
      }),
      makeEvidence({
        id: "evidence-sam",
        entityId: "company-insider-backed",
        authorName: "Sam Altman",
        authorHandle: "sama",
        contributionScore: 40,
        sourceUrl: "https://x.com/sama/status/3",
        title: "Sam Altman mentioned Insider Backed",
        text: "Insider Backed is doing interesting work."
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
    linkStatus: "verified",
    metrics: { likes: 40 },
    contributionScore: 40,
    tractionStatus: "scored",
    sourceUrl: "https://x.com/demo/status/1",
    why: "Test evidence.",
    review_state: "verified",
    ...overrides
  };
}

function buildLegacySimilarityEdges(companies: CompanyRecord[], threshold: number) {
  const candidates: ReturnType<typeof buildGraphEdges> = [];

  for (let i = 0; i < companies.length; i += 1) {
    for (let j = i + 1; j < companies.length; j += 1) {
      const source = companies[i];
      const target = companies[j];
      const industrySimilarity = legacyJaccard(source.industries, target.industries);
      const descriptionSimilarity = legacyJaccard(
        legacyTokenize(`${source.tagline} ${source.description}`),
        legacyTokenize(`${target.tagline} ${target.description}`)
      );
      const similarity = roundToHundredths(industrySimilarity * 0.75 + descriptionSimilarity * 0.25);

      if (similarity >= threshold) {
        candidates.push({
          id: `edge-industry-${source.id}-${target.id}`,
          source: nodeId("company", source.id),
          target: nodeId("company", target.id),
          edgeType: "industry_similarity",
          weight: roundToHundredths(similarity),
          label: "Industry similarity",
          explanation: `Shared tags or description terms produced a ${Math.round(
            similarity * 100
          )}% similarity score.`
        });
      }
    }
  }

  const perCompany = new Map<string, number>();
  const limited: ReturnType<typeof buildGraphEdges> = [];
  for (const candidate of [...candidates].sort((left, right) => right.weight - left.weight)) {
    const sourceCount = perCompany.get(candidate.source) ?? 0;
    const targetCount = perCompany.get(candidate.target) ?? 0;
    if (limited.length >= 140 || sourceCount >= 2 || targetCount >= 2) {
      continue;
    }
    limited.push(candidate);
    perCompany.set(candidate.source, sourceCount + 1);
    perCompany.set(candidate.target, targetCount + 1);
  }

  return limited;
}

function legacyJaccard(sourceValues: string[], targetValues: string[]): number {
  const sourceSet = new Set(sourceValues.map((value) => value.toLowerCase()));
  const targetSet = new Set(targetValues.map((value) => value.toLowerCase()));
  const intersection = [...sourceSet].filter((value) => targetSet.has(value)).length;
  const union = new Set([...sourceSet, ...targetSet]).size;
  return union ? intersection / union : 0;
}

function legacyTokenize(text: string): string[] {
  const stopWords = new Set([
    "and",
    "the",
    "for",
    "with",
    "that",
    "from",
    "into",
    "teams",
    "company",
    "builds",
    "gives"
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

function legacyGroupCompanyRollupEvidence(companies: CompanyRecord[], evidence: EvidenceItem[]) {
  const grouped = new Map<string, EvidenceItem[]>();

  for (const company of companies) {
    const allowedEntityIds = new Set([company.id, ...company.founderIds]);
    grouped.set(
      company.id,
      evidence
        .filter((item) =>
          item.attachedCompanyId
            ? item.attachedCompanyId === company.id
            : allowedEntityIds.has(item.entityId)
        )
        .sort((left, right) => right.contributionScore - left.contributionScore)
    );
  }

  return grouped;
}

function legacyTiedRanks(companies: Array<{ id: string; score: number }>): Map<string, number> {
  const ranked = [...companies].sort((left, right) => right.score - left.score);
  let tiedRank = 0;
  let previousScore: number | null = null;

  return new Map(
    ranked.map((company, index) => {
      if (previousScore === null || company.score !== previousScore) {
        tiedRank = index + 1;
      }
      previousScore = company.score;
      return [company.id, tiedRank];
    })
  );
}

function makeSimilarityBenchmarkCompanies(count: number): CompanyRecord[] {
  return Array.from({ length: count }, (_, index) =>
    makeCompany({
      id: `benchmark-company-${index}`,
      name: `Benchmark Company ${index}`,
      industries: [`Industry ${index % 17}`, `Sector ${index % 29}`],
      tagline: `Operational analytics workflow ${index % 31}`,
      description: `Reliable evaluation and reporting for product operations segment ${index % 43} cohort ${index}`
    })
  );
}

function makeEvidenceBenchmarkDataset(companyCount: number, evidencePerCompany: number): DemoGraphDataset {
  const companies = Array.from({ length: companyCount }, (_, index) =>
    makeCompany({
      id: `evidence-company-${index}`,
      name: `Evidence Company ${index}`,
      founderIds: [`evidence-founder-${index}`],
      totalScore: index % 100,
      previousScore: index % 100
    })
  );
  const founders = companies.map((company, index) =>
    makeFounder({
      id: `evidence-founder-${index}`,
      name: `Evidence Founder ${index}`,
      companyIds: [company.id]
    })
  );
  const evidence = companies.flatMap((company, companyIndex) =>
    Array.from({ length: evidencePerCompany }, (_, evidenceIndex) => {
      const founderEvidence = evidenceIndex % 2 === 1;
      return makeEvidence({
        id: `benchmark-evidence-${companyIndex}-${evidenceIndex}`,
        entityType: founderEvidence ? "founder" : "company",
        entityId: founderEvidence ? `evidence-founder-${companyIndex}` : company.id,
        attachedCompanyId: evidenceIndex % 4 === 0 ? company.id : undefined,
        contributionScore: 20 + ((companyIndex + evidenceIndex) % 70),
        metrics: { likes: 40 + ((companyIndex * 3 + evidenceIndex) % 200) },
        sourceUrl: `https://x.com/benchmark/status/${companyIndex}-${evidenceIndex}`
      });
    })
  );

  return {
    mode: "demo",
    batches: [{
      slug: "S2026",
      label: "Benchmark batch",
      companyCountExpected: companyCount,
      companyCountObserved: companyCount
    }],
    companies,
    founders,
    evidence,
    needsReview: [],
    platformStatus: []
  };
}

function measureMedian<T>(operation: () => T): { medianMs: number; result: T } {
  operation();
  const durations: number[] = [];
  let result!: T;

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const startedAt = performance.now();
    result = operation();
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);
  return {
    medianMs: Math.round(durations[Math.floor(durations.length / 2)] * 100) / 100,
    result
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function roundToHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
