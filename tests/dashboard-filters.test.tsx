import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import type { GraphNode, GraphResponse } from "@/lib/graph/types";

vi.mock("@/components/CytoscapeGraph", () => ({
  CytoscapeGraph: ({ nodes }: { nodes: GraphNode[] }) => (
    <div data-testid="graph-canvas">
      {nodes.map((node) => (
        <span key={node.id}>{node.label}</span>
      ))}
    </div>
  )
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
    window.history.replaceState(null, "", "/");
  });

  it("shows platform, industry, and group partner filters without model or edge controls", async () => {
    const fullGraph = graphResponse([
      makeNode("company:b2b-a", "B2B A", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:b2b-b", "B2B B", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:fintech-a", "Fintech A", "fintech", "#2563eb", "Partner B")
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).not.toContain("industries=fintech");
        expect(String(input)).not.toContain("groupPartners=Partner+B");
        return {
          ok: true,
          json: async () => fullGraph
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
      expect(within(screen.getByTestId("graph-canvas")).queryByText("B2B A")).not.toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech A")).toBeInTheDocument();
    });

    fireEvent.click(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i }));
    expect(within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner A\s*\(2\)/i })).toBeInTheDocument();
    const partnerBButton = within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner B\s*\(1\)/i });
    fireEvent.click(partnerBButton);

    await waitFor(() => {
      expect(within(screen.getByTestId("graph-canvas")).queryByText("B2B B")).not.toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech A")).toBeInTheDocument();
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

  it("keeps the batch selector visible with Summer and Spring available", () => {
    const fullGraph = graphResponse([
      makeNode("company:heyclicky", "HeyClicky", "b2b", "#7dd3fc", "Partner A")
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined))
    );

    render(<Dashboard initialGraph={fullGraph} />);

    const batchSelector = screen.getByRole("combobox", { name: /batch/i }) as HTMLSelectElement;
    const options = within(batchSelector).getAllByRole("option");

    expect(batchSelector).toHaveValue("S26");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("YC Summer 2026");
    expect(options[0]).toHaveValue("S26");
    expect(options[1]).toHaveTextContent("YC Spring 2026");
    expect(options[1]).toHaveValue("S2026");
  });

  it("fetches a URL-addressable graph when Top Voices changes", async () => {
    const fullGraph = graphResponse([
      makeNode("company:heyclicky", "HeyClicky", "b2b", "#7dd3fc", "Partner A")
    ]);
    const partnerGraph = {
      ...fullGraph,
      selectedTopVoiceAudience: fullGraph.topVoiceAudiences[1]!
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      json: async () => partnerGraph
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} />);

    fireEvent.change(screen.getByRole("combobox", { name: /top voices/i }), {
      target: { value: "yc_partners" }
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("topVoices=yc_partners"))).toBe(true);
    });
    expect(window.location.search).toContain("topVoices=yc_partners");
  });

  it("switches to a prefetched Spring graph without waiting for another graph request", async () => {
    const summerGraph = graphResponse([
      makeNode("company:screenpipe", "screenpipe", "b2b", "#7dd3fc", "Partner A", 100)
    ]);
    const springGraph = graphResponse(
      [makeNode("company:heyclicky", "HeyClicky", "b2b", "#7dd3fc", "Partner A", 100)],
      { slug: "S2026", label: "YC Spring 2026", companyCountExpected: 197, companyCountObserved: 197 }
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => (url.includes("batch=S2026") ? springGraph : summerGraph)
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={summerGraph} />);

    expect(within(screen.getByTestId("graph-canvas")).getByText("screenpipe")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("batch=S2026"))).toBe(true);
    });
    await Promise.resolve();

    const callsBeforeSwitch = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), { target: { value: "S2026" } });

    await waitFor(() => {
      expect(within(screen.getByTestId("graph-canvas")).getByText("HeyClicky")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).queryByText("screenpipe")).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeSwitch);
  });

  it("filters minimum score locally without waiting for a graph request", async () => {
    const fullGraph = graphResponse([
      makeNode("company:low", "Low Score", "b2b", "#7dd3fc", "Partner A", 20),
      makeNode("company:high", "High Score", "fintech", "#2563eb", "Partner B", 90)
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined))
    );

    render(<Dashboard initialGraph={fullGraph} />);

    const canvas = screen.getByTestId("graph-canvas");
    expect(within(canvas).getByText("Low Score")).toBeInTheDocument();
    expect(within(canvas).getByText("High Score")).toBeInTheDocument();

    const minimumScore = screen.getByLabelText("Minimum score");
    fireEvent.change(minimumScore, { target: { value: "80" } });
    fireEvent.pointerUp(minimumScore, { currentTarget: { value: "80" } });

    await waitFor(() => {
      expect(within(screen.getByTestId("graph-canvas")).queryByText("Low Score")).not.toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("High Score")).toBeInTheDocument();
    });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("minScore=80"), expect.any(Object));
  });
});

function graphResponse(
  nodes: GraphNode[],
  batch = { slug: "S26", label: "YC Summer 2026", companyCountExpected: 83, companyCountObserved: 83 }
): GraphResponse {
  const batchNodes = nodes.map((node) => ({ ...node, batchSlug: batch.slug }));

  return {
    batch,
    batches: [
      { slug: "S26", label: "YC Summer 2026", companyCountExpected: 83, companyCountObserved: 83 },
      { slug: "S2026", label: "YC Spring 2026", companyCountExpected: 197, companyCountObserved: 197 }
    ],
    nodes: batchNodes,
    edges: [],
    leaderboard: batchNodes.map((node, index) => ({
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
    selectedTopVoiceAudience: {
      id: "off",
      displayName: "Off / Everyone",
      description: "All available network traction signals.",
      helperText: "Showing all available network traction signals.",
      scoreLabel: "Traction score",
      scoreDescription: "Scored from all available GitHub and social evidence.",
      active: true,
      memberCount: 0
    },
    topVoiceAudiences: [
      {
        id: "off",
        displayName: "Off / Everyone",
        description: "All available network traction signals.",
        helperText: "Showing all available network traction signals.",
        scoreLabel: "Traction score",
        scoreDescription: "Scored from all available GitHub and social evidence.",
        active: true,
        memberCount: 0
      },
      {
        id: "yc_partners",
        displayName: "YC Partners",
        description: "Current YC partners and YC leadership.",
        helperText: "Showing attention from current YC partners only.",
        scoreLabel: "Top Voices score",
        scoreDescription: "Current YC partners and YC leadership.",
        active: true,
        memberCount: 18
      }
    ],
    generatedAt: "2026-06-29T00:00:00.000Z",
    mode: "official_snapshot"
  };
}

function makeNode(
  id: string,
  label: string,
  industry: string,
  color: string,
  groupPartner = "Partner",
  score = 50
): GraphNode {
  const entityId = id.replace("company:", "");
  return {
    id,
    entityType: "company",
    entityId,
    label,
    batchSlug: "S26",
    score,
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
    sourceUrl: "https://www.ycombinator.com/companies?batch=Summer%202026",
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
