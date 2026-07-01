import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import type { GraphNode, GraphResponse } from "@/lib/graph/types";

vi.mock("@/components/CytoscapeGraph", () => ({
  CytoscapeGraph: () => <div data-testid="graph-canvas" />
}));

vi.mock("@/components/InsightsTabs", () => ({
  InsightsTabs: () => <div data-testid="insights-tabs" />
}));

vi.mock("@/components/NodePanel", () => ({
  NodePanel: () => <aside data-testid="node-panel" />
}));

describe("dashboard filters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows platform, industry, and group partner filters without model or edge controls", async () => {
    const fullGraph = graphResponse([
      makeNode("company:b2b-a", "B2B A", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:b2b-b", "B2B B", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:fintech-a", "Fintech A", "fintech", "#2563eb", "Partner B")
    ]);
    const industryFilteredGraph = graphResponse([makeNode("company:fintech-a", "Fintech A", "fintech", "#2563eb", "Partner B")]);
    const groupFilteredGraph = graphResponse([makeNode("company:fintech-a", "Fintech A", "fintech", "#2563eb", "Partner B")]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return {
          ok: true,
          json: async () =>
            url.includes("groupPartners=Partner+B")
              ? groupFilteredGraph
              : url.includes("industries=fintech")
                ? industryFilteredGraph
                : fullGraph
        };
      })
    );

    render(<Dashboard />);

    expect(await screen.findByText("Platform")).toBeInTheDocument();
    const industryGroup = (await screen.findByText("Industry")).closest(".filter-dropdown") as HTMLElement;
    const groupPartnerGroup = (await screen.findByText("Group partner")).closest(".filter-dropdown") as HTMLElement;
    expect(industryGroup).toBeInTheDocument();
    expect(groupPartnerGroup).toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("Edges")).not.toBeInTheDocument();

    fireEvent.click(within(industryGroup).getByRole("button", { name: /all industries/i }));
    expect(within(industryGroup).getByRole("menuitemcheckbox", { name: /all industries/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(within(industryGroup).getByRole("menuitemcheckbox", { name: /B2B\s*\(2\)/i })).toBeInTheDocument();
    const fintechButton = within(industryGroup).getByRole("menuitemcheckbox", { name: /Fintech\s*\(1\)/i });
    fireEvent.click(fintechButton);

    await waitFor(() => {
      expect(within(industryGroup).getByRole("button", { name: /Fintech/i })).toBeInTheDocument();
      expect(within(industryGroup).getByRole("menuitemcheckbox", { name: /Fintech\s*\(1\)/i })).toHaveAttribute(
        "aria-checked",
        "true"
      );
    });

    fireEvent.click(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i }));
    expect(within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner A\s*\(2\)/i })).toBeInTheDocument();
    const partnerBButton = within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner B\s*\(1\)/i });
    fireEvent.click(partnerBButton);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("groupPartners=Partner+B"), expect.any(Object));
    });
  });

  it("renders the initial graph immediately without waiting for the first client fetch", () => {
    const fullGraph = graphResponse([
      makeNode("company:heyclicky", "HeyClicky", "b2b", "#7dd3fc", "Partner A")
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined))
    );

    render(<Dashboard initialGraph={fullGraph} />);

    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("insights-tabs")).toBeInTheDocument();
    expect(screen.queryByText("Loading YC map...")).not.toBeInTheDocument();
    expect(screen.queryByText("Graph unavailable")).not.toBeInTheDocument();
  });
});

function graphResponse(nodes: GraphNode[]): GraphResponse {
  return {
    batch: { slug: "S2026", label: "YC Spring 2026", companyCountExpected: 197, companyCountObserved: 197 },
    batches: [{ slug: "S2026", label: "YC Spring 2026", companyCountExpected: 197, companyCountObserved: 197 }],
    nodes,
    edges: [],
    leaderboard: nodes.map((node, index) => ({
      rank: index + 1,
      companyId: node.entityId,
      companyName: node.label,
      score: node.score,
      topPlatform: node.topPlatform,
      biggestContribution: null
    })),
    fastestGaining: [],
    needsReview: [],
    evidence: [],
    platformStatus: [],
    generatedAt: "2026-06-29T00:00:00.000Z",
    mode: "official_snapshot"
  };
}

function makeNode(id: string, label: string, industry: string, color: string, groupPartner = "Partner"): GraphNode {
  const entityId = id.replace("company:", "");
  return {
    id,
    entityType: "company",
    entityId,
    label,
    batchSlug: "S2026",
    score: 50,
    previousScore: 45,
    scoreDelta: 5,
    radius: 20,
    topPlatform: "github",
    platformScores: { github: 50 },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl: `https://www.ycombinator.com/companies/${entityId}`,
    websiteUrl: "https://example.com",
    tagline: "Demo company",
    description: "Demo company",
    groupPartner,
    primaryIndustry: industry,
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://www.ycombinator.com/companies?batch=S2026",
    visual: {
      industryColor: color,
      shape: "ellipse",
      borderStyle: "solid",
      borderColor: "#ffffff",
      groupRegion: groupPartner
    },
    industries: [industry],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 0, needs_review: 0, rejected: 0 }
  };
}
