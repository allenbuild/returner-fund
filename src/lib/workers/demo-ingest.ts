import type {
  EvidenceItem,
  FastestGainingRow,
  GraphEdge,
  GraphNode,
  GraphResponse,
  IngestBatchRequest,
  LeaderboardRow,
  NeedsReviewItem
} from "./types";

interface DemoCompany {
  id: string;
  name: string;
  tagline: string;
  description: string;
  websiteUrl: string;
  ycProfileUrl: string;
  industries: string[];
  groupPartner: string | null;
  score: number;
  review_state: "verified" | "needs_review" | "rejected";
  platformScores: GraphNode["platformScores"];
  founders: DemoFounder[];
  evidence: EvidenceItem[];
}

interface DemoFounder {
  id: string;
  name: string;
  score: number;
  review_state: "verified" | "needs_review" | "rejected";
  platformScores: GraphNode["platformScores"];
  evidence: EvidenceItem[];
}

export function buildDemoGraph(request: IngestBatchRequest, generatedAt = new Date().toISOString()): GraphResponse {
  const batchSlug = normalizeBatchSlug(request.batchSlug);
  const companies = getDemoCompanies(batchSlug).slice(0, request.options?.maxCompanies ?? 50);

  const companyNodes = companies.map((company) => companyToNode(batchSlug, company));

  return {
    batch: {
      slug: batchSlug,
      label: batchLabel(batchSlug),
      expectedCompanyCount: batchSlug === "S2026" ? 197 : undefined,
      observedCompanyCount: companies.length
    },
    nodes: companyNodes,
    edges: buildDemoEdges(companies),
    leaderboard: buildLeaderboard(companies),
    fastestGaining: buildFastestGaining(companies),
    needsReview: buildNeedsReview(companies),
    generatedAt,
    mode: "demo"
  };
}

export function normalizeBatchSlug(raw = "S2026"): string {
  const value = raw.trim().toUpperCase();
  const compact = value.replace(/[^A-Z0-9]/g, "");

  const direct = compact.match(/^(S|W)(20\d{2})$/);
  if (direct) {
    return `${direct[1]}${direct[2]}`;
  }

  const year = compact.match(/20\d{2}/)?.[0] ?? "2026";
  if (compact.includes("SPRING") || compact.includes("SUMMER")) {
    return `S${year}`;
  }
  if (compact.includes("WINTER")) {
    return `W${year}`;
  }

  return compact || "S2026";
}

export function batchLabel(slug: string): string {
  const season = slug.startsWith("W") ? "Winter" : "Spring";
  return `YC ${season} ${slug.slice(1)}`;
}

function companyToNode(batchSlug: string, company: DemoCompany): GraphNode {
  const founderEvidence = company.founders.flatMap((founder) => founder.evidence);
  return {
    id: company.id,
    type: "company",
    label: company.name,
    score: company.score,
    review_state: company.review_state,
    radius: radiusForScore(company.score),
    platformScores: company.platformScores,
    summary: {
      batchSlug,
      ycProfileUrl: company.ycProfileUrl,
      websiteUrl: company.websiteUrl,
      tagline: company.tagline,
      description: company.description,
      groupPartner: company.groupPartner,
      industries: company.industries,
      relatedEntityIds: company.founders.map((founder) => founder.id)
    },
    evidence: [...company.evidence, ...founderEvidence]
  };
}

function radiusForScore(score: number): number {
  return Math.round(12 + (Math.max(0, Math.min(100, score)) / 100) * 28);
}

function buildDemoEdges(companies: DemoCompany[]): GraphEdge[] {
  const similarityEdges: GraphEdge[] = [
    {
      id: "company-northstar-company-signalnest",
      source: "company-northstar",
      target: "company-signalnest",
      edgeType: "industry_similarity",
      weight: 0.72,
      explanation: {
        sharedSignals: ["developer tools", "automation", "workflow intelligence"],
        method: "demo tag overlap"
      }
    },
    {
      id: "company-ledgerloop-company-signalnest",
      source: "company-ledgerloop",
      target: "company-signalnest",
      edgeType: "same_group_partner",
      weight: 0.65,
      explanation: {
        groupPartner: "Demo Partner",
        source: "demo seed",
        warning: "Production must only create this edge from reliable public data."
      }
    }
  ];

  return similarityEdges.filter(
    (edge) =>
      companies.some((company) => company.id === edge.source) &&
      companies.some((company) => company.id === edge.target)
  );
}

function buildLeaderboard(companies: DemoCompany[]): LeaderboardRow[] {
  return [...companies]
    .sort((a, b) => b.score - a.score)
    .map((company, index) => ({
      rank: index + 1,
      entityId: company.id,
      company: company.name,
      score: company.score,
      topPlatform: topPlatform(company.platformScores),
      biggestContributingPost: company.evidence[0]?.title ?? "No evidence"
    }));
}

function buildFastestGaining(companies: DemoCompany[]): FastestGainingRow[] {
  return companies.map((company, index) => ({
    entityId: company.id,
    company: company.name,
    scoreDelta: [12.4, 7.8, 5.1][index] ?? 3.2,
    percentDelta: [18.1, 11.6, 8.5][index] ?? 4.4,
    rankDelta: [2, 1, -1][index] ?? 0,
    platformCausingJump: topPlatform(company.platformScores),
    newHighPerformingPosts: company.evidence.slice(0, 2).map((item) => item.title)
  }));
}

function buildNeedsReview(companies: DemoCompany[]): NeedsReviewItem[] {
  return [
    {
      id: "review-signalnest-linkedin",
      entityType: "company",
      entityId: companies.find((company) => company.id === "company-signalnest")?.id ?? "company-signalnest",
      entityName: "SignalNest",
      platform: "linkedin",
      candidateUrl: "https://www.linkedin.com/company/signalnest-demo-candidate",
      review_state: "needs_review",
      matchReason:
        "Name overlap exists, but the profile is not linked from the official website and the bio does not mention the YC batch."
    }
  ];
}

function topPlatform(scores: GraphNode["platformScores"]): LeaderboardRow["topPlatform"] {
  const sorted = Object.entries(scores).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
  return (sorted[0]?.[0] as LeaderboardRow["topPlatform"] | undefined) ?? "web";
}

function getDemoCompanies(batchSlug: string): DemoCompany[] {
  const timestamp = batchSlug.endsWith("2026") ? "2026-06-20T16:00:00.000Z" : "2026-01-20T16:00:00.000Z";

  return [
    {
      id: "company-northstar",
      name: "Northstar Robotics",
      tagline: "Warehouse robots that learn from operator corrections.",
      description:
        "Northstar Robotics is a demo YC-like company used to exercise graph, evidence, and scoring paths without credentials.",
      websiteUrl: "https://example.com/northstar",
      ycProfileUrl: "https://www.ycombinator.com/companies/northstar-robotics",
      industries: ["Robotics", "Logistics", "AI"],
      groupPartner: null,
      score: 86,
      review_state: "verified",
      platformScores: { github: 78, youtube: 72, web: 88, product_hunt: 82 },
      founders: [
        {
          id: "founder-maya-chen",
          name: "Maya Chen",
          score: 74,
          review_state: "verified",
          platformScores: { x: 71, github: 69, linkedin: 62 },
          evidence: [
            evidence("evidence-maya-demo-post", "x", "Founder launch thread", "https://example.com/maya/thread", timestamp, {
              likes: 420,
              reposts: 80,
              comments: 45
            })
          ]
        }
      ],
      evidence: [
        evidence("evidence-northstar-github", "github", "Open-source robot planner stars", "https://github.com/example/northstar-planner", timestamp, {
          stars: 1260,
          forks: 84,
          issues: 19
        }),
        evidence("evidence-northstar-web", "web", "Robotics launch coverage", "https://example.com/coverage/northstar", timestamp, {
          views: 18000,
          comments: 31
        })
      ]
    },
    {
      id: "company-ledgerloop",
      name: "LedgerLoop",
      tagline: "Real-time reconciliation for global commerce teams.",
      description:
        "LedgerLoop models a fintech startup with Product Hunt, RSS, and web evidence in the demo pipeline.",
      websiteUrl: "https://example.com/ledgerloop",
      ycProfileUrl: "https://www.ycombinator.com/companies/ledgerloop",
      industries: ["Fintech", "B2B", "Automation"],
      groupPartner: "Demo Partner",
      score: 78,
      review_state: "verified",
      platformScores: { product_hunt: 84, rss: 66, web: 76, github: 55 },
      founders: [
        {
          id: "founder-jon-park",
          name: "Jon Park",
          score: 68,
          review_state: "verified",
          platformScores: { linkedin: 73, web: 61 },
          evidence: [
            evidence("evidence-jon-podcast", "web", "Founder podcast mention", "https://example.com/podcast/ledgerloop", timestamp, {
              views: 5200,
              comments: 12
            })
          ]
        }
      ],
      evidence: [
        evidence("evidence-ledgerloop-ph", "product_hunt", "Product Hunt launch", "https://www.producthunt.com/products/ledgerloop", timestamp, {
          upvotes: 880,
          comments: 96
        }),
        evidence("evidence-ledgerloop-rss", "rss", "Engineering blog launch note", "https://example.com/ledgerloop/blog/rss", timestamp, {
          views: 7600,
          comments: 14
        })
      ]
    },
    {
      id: "company-signalnest",
      name: "SignalNest",
      tagline: "AI inbox for construction procurement.",
      description:
        "SignalNest is included to demonstrate needs-review profile matching and same-partner graph edges.",
      websiteUrl: "https://example.com/signalnest",
      ycProfileUrl: "https://www.ycombinator.com/companies/signalnest",
      industries: ["Construction", "AI", "Procurement"],
      groupPartner: "Demo Partner",
      score: 64,
      review_state: "verified",
      platformScores: { web: 70, youtube: 52, github: 43 },
      founders: [
        {
          id: "founder-ava-rivera",
          name: "Ava Rivera",
          score: 59,
          review_state: "verified",
          platformScores: { web: 64, linkedin: 51 },
          evidence: [
            evidence("evidence-ava-interview", "youtube", "Founder interview transcript", "https://www.youtube.com/watch?v=demo-signalnest", timestamp, {
              views: 3100,
              likes: 144,
              comments: 18
            })
          ]
        }
      ],
      evidence: [
        evidence("evidence-signalnest-youtube", "youtube", "Customer workflow demo", "https://www.youtube.com/watch?v=demo-signalnest-product", timestamp, {
          views: 9200,
          likes: 380,
          comments: 29
        }),
        evidence("evidence-signalnest-web", "web", "Procurement automation mention", "https://example.com/news/signalnest", timestamp, {
          views: 4400,
          comments: 6
        })
      ]
    }
  ];
}

function evidence(
  id: string,
  platform: EvidenceItem["platform"],
  title: string,
  url: string,
  timestamp: string,
  metrics: EvidenceItem["metrics"]
): EvidenceItem {
  const raw = Object.values(metrics).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    id,
    platform,
    title,
    url,
    author: "Demo source",
    timestamp,
    text: `${title} contributes to the demo traction score through normalized ${platform} metrics.`,
    metrics,
    contributionScore: Math.min(100, Math.round(Math.log1p(raw) * 10)),
    explanation:
      "Demo score uses deterministic normalized engagement so API, graph, feed, leaderboard, and refresh flows can be verified without credentials."
  };
}
