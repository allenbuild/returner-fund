import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import { trackAnalyticsEvent } from "@/lib/analytics";
import type { GraphNode, GraphResponse, Platform } from "@/lib/graph/types";

vi.mock("@/lib/analytics", () => ({
  trackAnalyticsEvent: vi.fn()
}));

vi.mock("@/components/CytoscapeGraph", () => ({
  CytoscapeGraph: ({
    nodes,
    onSelectNode
  }: {
    nodes: GraphNode[];
    onSelectNode: (nodeId: string) => void;
  }) => (
    <div data-testid="graph-canvas">
      {nodes.map((node) => (
        <button type="button" key={node.id} onClick={() => onSelectNode(node.id)}>
          Graph {node.label}
        </button>
      ))}
    </div>
  )
}));

vi.mock("@/components/InsightsTabs", () => ({
  InsightsTabs: ({ graph, onSelectNode }: { graph: GraphResponse; onSelectNode: (nodeId: string) => void }) => (
    <button type="button" onClick={() => onSelectNode(`company:${graph.leaderboard[0].companyId}`)}>
      Leaderboard result
    </button>
  )
}));

vi.mock("@/components/NodePanel", () => ({
  NodePanel: ({ node }: { node: GraphNode | null }) => <aside data-testid="selected-node">{node?.id}</aside>
}));

const trackEvent = vi.mocked(trackAnalyticsEvent);

describe("dashboard analytics and shareable URL state", () => {
  beforeEach(() => {
    trackEvent.mockClear();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("restores and persists every dashboard view parameter", async () => {
    window.history.replaceState(
      null,
      "",
      "/?industries=fintech&groupPartners=Partner%20B&minScore=25&node=company%3Abeta"
    );

    render(<Dashboard initialGraph={graphFixture()} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Minimum score value")).toHaveValue(25);
      expect(screen.getByTestId("selected-node")).toHaveTextContent("company:beta");
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get("industries")).toBe("fintech");
    expect(params.get("groupPartners")).toBe("Partner B");
    expect(params.get("minScore")).toBe("25");
    expect(params.get("node")).toBe("company:beta");

    const platformFilter = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(platformFilter).getByRole("button", { name: /all platforms/i }));
    fireEvent.click(within(platformFilter).getByRole("menuitemcheckbox", { name: /^X$/i }));

    await waitFor(() => expect(new URLSearchParams(window.location.search).get("platforms")).toBe("x"));
  });

  it("tracks coarse interaction context without raw dashboard values", async () => {
    const clipboardWrite = vi.fn(async () => undefined);
    const nativeShare = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite }
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: nativeShare
    });

    render(<Dashboard initialGraph={graphFixture()} />);

    const search = screen.getByPlaceholderText("Search companies and founders");
    fireEvent.change(search, { target: { value: "Beta Secret Query" } });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByText("#2, Score: 70").closest("button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Graph Alpha Private" }));
    fireEvent.click(screen.getByRole("button", { name: "Leaderboard result" }));

    const industryFilter = screen.getByText("Industry").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(industryFilter).getByRole("button", { name: /all industries/i }));
    fireEvent.click(within(industryFilter).getByRole("menuitemcheckbox", { name: /Fintech/i }));

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    fireEvent.click(screen.getByRole("button", { name: "Share view" }));

    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
      expect(nativeShare).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith("share_copied", {
        method: "clipboard",
        included_filters: true,
        included_node: true
      });
      expect(trackEvent).toHaveBeenCalledWith("social_share", {
        method: "native",
        included_filters: true,
        included_node: true
      });
    });

    expect(trackEvent).toHaveBeenCalledWith("search_submitted", {
      result_count: 1,
      has_results: true
    });
    expect(trackEvent).toHaveBeenCalledWith("result_opened", {
      result_type: "company",
      position: 1
    });
    expect(trackEvent).toHaveBeenCalledWith("graph_node_opened", {
      node_type: "company",
      source: "search"
    });
    expect(trackEvent).toHaveBeenCalledWith("graph_node_opened", {
      node_type: "company",
      source: "graph"
    });
    expect(trackEvent).toHaveBeenCalledWith("graph_node_opened", {
      node_type: "company",
      source: "leaderboard"
    });
    expect(trackEvent).toHaveBeenCalledWith("filter_changed", {
      filter: "industry",
      action: "added",
      selection_count: 1
    });

    const serializedEvents = JSON.stringify(trackEvent.mock.calls);
    expect(serializedEvents).not.toContain("Beta Secret Query");
    expect(serializedEvents).not.toContain("Alpha Private");
    expect(serializedEvents).not.toContain("company:");
    expect(serializedEvents).not.toContain("http");
  });
});

function graphFixture(): GraphResponse {
  const nodes = [
    nodeFixture("company:alpha", "Alpha Private", "b2b", "Partner A", 80, "github"),
    nodeFixture("company:beta", "Beta Secret Query", "fintech", "Partner B", 70, "x")
  ];
  const leaderboard = nodes.map((node, index) => ({
    rank: index + 1,
    companyId: node.entityId,
    companyName: node.label,
    score: node.score,
    topPlatform: node.topPlatform,
    socialAccounts: [],
    biggestContribution: null
  }));
  const audience = {
    id: "off" as const,
    displayName: "All voices",
    description: "All signals",
    helperText: "All signals",
    scoreLabel: "Score",
    scoreDescription: "All signals",
    active: true,
    memberCount: 0
  };

  return {
    batch: { slug: "S2026", label: "YC Spring 2026 (P26)" },
    batches: [{ slug: "S2026", label: "YC Spring 2026 (P26)" }],
    nodes,
    edges: [],
    leaderboard,
    fastestGaining: leaderboard.map((row) => ({
      rank: row.rank,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: momentum(row.score, row.rank),
      wow: momentum(row.score, row.rank)
    })),
    needsReview: [],
    evidence: [],
    platformStatus: [],
    selectedTopVoiceAudience: audience,
    topVoiceAudiences: [audience],
    generatedAt: "2026-07-18T00:00:00.000Z",
    mode: "official_snapshot"
  };
}

function nodeFixture(
  id: string,
  label: string,
  primaryIndustry: string,
  groupPartner: string,
  score: number,
  topPlatform: Platform
): GraphNode {
  return {
    id,
    entityType: "company",
    entityId: id.replace("company:", ""),
    label,
    batchSlug: "S2026",
    score,
    previousScore: score,
    scoreDelta: 0,
    radius: 20,
    topPlatform,
    platformScores: { [topPlatform]: score },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl: "https://example.invalid/profile",
    websiteUrl: null,
    tagline: null,
    description: null,
    groupPartner,
    primaryIndustry,
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "https://example.invalid/source",
    visual: {
      industryColor: "#000000",
      shape: "ellipse",
      borderStyle: "solid",
      borderColor: "#ffffff",
      groupRegion: groupPartner
    },
    industries: [primaryIndustry],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 1, needs_review: 0, rejected: 0 }
  };
}

function momentum(currentScore: number, currentRank: number) {
  return {
    scoreDelta: 0,
    percentDelta: 0,
    rankDelta: 0,
    currentScore,
    currentRank,
    baselineScore: null,
    baselineRank: null,
    benchmarkedAt: null
  };
}
