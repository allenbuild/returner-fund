import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Dashboard,
  recordResumeRevalidationAt,
  RESUME_REVALIDATION_SCOPE_MAX_ENTRIES
} from "@/components/Dashboard";
import { COMPANY_VERTICALS } from "@/lib/graph/company-verticals";
import {
  clearRankedPostsSidecarLoaderCache,
  rankedPostsSidecarLoaderInFlightCount
} from "@/lib/graph/ranked-posts-sidecar-loader";
import { validateStaticGraphSnapshotContract } from "@/lib/graph/static-graph-snapshot-contract.mjs";
import { TOPIC_FACET_SNAPSHOT_VERSION } from "@/lib/graph/topic-facets";
import { TRACTION_SCORING_CONFIG } from "@/lib/scoring/traction-config";
import type { InsiderConfigurationResponse } from "@/lib/social/user-insiders";
import { defaultInsiderMembers } from "@/lib/social/top-voices";
import type {
  EvidenceItem,
  GraphNode,
  GraphResponse,
  Platform,
  ScoreBreakdown,
  TopVoiceAudienceId
} from "@/lib/graph/types";

const insiderAuthHarness = vi.hoisted(() => ({
  token: null as string | null,
  userId: null as string | null,
  listeners: new Set<(change: {
    event: "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED";
    userId: string | null;
  }) => void>()
}));

vi.mock("@/lib/social/user-insiders-client", () => ({
  insiderAccessToken: vi.fn(async () => insiderAuthHarness.token),
  insiderApiFetch: vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (insiderAuthHarness.token) {
      headers.set("authorization", `Bearer ${insiderAuthHarness.token}`);
    }
    return fetch(input, { ...init, headers });
  }),
  requestInsiderSignInLink: vi.fn(async () => undefined),
  subscribeToInsiderAuth: (
    handler: (change: {
      event: "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED";
      userId: string | null;
    }) => void,
    options: { emitInitial?: boolean } = {}
  ) => {
    insiderAuthHarness.listeners.add(handler);
    if (options.emitInitial) {
      handler({
        event: "INITIAL_SESSION",
        userId: insiderAuthHarness.userId
      });
    }
    return () => insiderAuthHarness.listeners.delete(handler);
  }
}));

const V4_MODEL_ID = "returner-traction";
const V4_MODEL_VERSION = "4.2.0";

function insiderConfigurationResponse(version = 0, paulGrahamWeight = 5): InsiderConfigurationResponse {
  const defaults = defaultInsiderMembers();
  return {
    authenticated: true,
    defaultsCount: defaults.length,
    defaultMembers: defaults,
    effectiveMembers: defaults.map((member) =>
      member.personId === "paul-graham"
        ? { ...member, weight: paulGrahamWeight }
        : member
    ),
    configuration: {
      version,
      excludedDefaultIds: [],
      weightOverrides: paulGrahamWeight === 5 ? {} : { "paul-graham": paulGrahamWeight },
      addedInsiders: [],
      createdAt: null,
      updatedAt: null
    }
  };
}

vi.mock("@/components/CytoscapeGraph", () => ({
  CytoscapeGraph: ({
    nodes,
    focus
  }: {
    nodes: GraphNode[];
    focus: { active: boolean; companyNodeIds: string[]; signature: string };
  }) => (
    <div
      data-testid="graph-canvas"
      data-focus-active={focus.active ? "true" : "false"}
      data-focused-company-ids={focus.companyNodeIds.join("|")}
      data-focus-signature={focus.signature}
      data-node-scores={nodes.map((node) => `${node.entityId}:${node.score}`).join("|")}
    >
      {nodes.map((node) => (
        <span key={node.id}>{node.label}</span>
      ))}
    </div>
  )
}));

vi.mock("@/components/InsightsTabs", () => ({
  InsightsTabs: ({ graph, onSelectNode }: { graph: GraphResponse; onSelectNode: (nodeId: string) => void }) => {
    const leader = graph.leaderboard[0];
    return (
      <div data-testid="insights-tabs">
        {leader && <output data-testid="leaderboard-score">{leader.score}</output>}
        <output data-testid="topic-facet-post-keys">{(graph.topicFacetRows ?? []).map((row) => row.postKey).join("|")}</output>
        {leader && (
          <button type="button" onClick={() => onSelectNode(`company:${leader.companyId}`)}>
            Open leaderboard {leader.companyName}
          </button>
        )}
      </div>
    );
  }
}));

vi.mock("@/components/NodePanel", () => ({
  NodePanel: ({ node, evidence }: { node: GraphNode | null; evidence: EvidenceItem[] }) => (
    <aside data-testid="node-panel" data-evidence-ids={evidence.map((item) => item.id).join("|")}>
      {node && <button type="button">Open profile {node.label}</button>}
    </aside>
  )
}));

describe("dashboard filters", () => {
  it("bounds resume-revalidation scopes with least-recently-used eviction", () => {
    const cache = new Map<string, number>();
    for (let index = 0; index < RESUME_REVALIDATION_SCOPE_MAX_ENTRIES; index += 1) {
      recordResumeRevalidationAt(cache, `scope-${index}`, index);
    }

    recordResumeRevalidationAt(cache, "scope-0", 0);
    recordResumeRevalidationAt(cache, "overflow-scope", 99);

    expect(cache).toHaveLength(RESUME_REVALIDATION_SCOPE_MAX_ENTRIES);
    expect(cache.has("scope-0")).toBe(true);
    expect(cache.has("scope-1")).toBe(false);
    expect(cache.get("overflow-scope")).toBe(99);
  });

  afterEach(() => {
    clearRankedPostsSidecarLoaderCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    insiderAuthHarness.token = null;
    insiderAuthHarness.userId = null;
    insiderAuthHarness.listeners.clear();
    window.history.replaceState(null, "", "/");
    document.title = "YC Network Map";
  });

  it("aborts ranked sidecar requests on graph scope changes and unmount", async () => {
    const initial = graphResponse([
      makeNode("company:initial-sidecar", "Initial Sidecar", "b2b", "#7dd3fc", "Partner A", 40)
    ]);
    initial.generatedAt = "2031-04-15T12:00:00.000Z";
    initial.scoringContext = {
      ...initial.scoringContext!,
      responseBuiltAt: initial.generatedAt
    };

    const speedrunGraph = staticGraphFixture(graphResponse(
      [makeNode("company:speedrun-sidecar", "Speedrun Sidecar", "consumer", "#88CCF6", "Partner A", 80)],
      { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
    ));
    speedrunGraph.generatedAt = "2031-04-15T13:00:00.000Z";
    speedrunGraph.scoringContext = {
      ...speedrunGraph.scoringContext!,
      responseBuiltAt: speedrunGraph.generatedAt
    };

    const sidecarSignals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/ranked-posts-sidecar")) {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected the ranked sidecar request to carry an abort signal.");
        sidecarSignals.push(signal);
        return await new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) rejectAbort();
          else signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      if (url.includes("/graph/a16zsr006") || url === "/api/graph?batch=A16ZSR006") {
        return new Response(JSON.stringify(speedrunGraph), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<Dashboard initialGraph={initial} />);
    await waitFor(() => expect(sidecarSignals).toHaveLength(1));

    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), {
      target: { value: "A16ZSR006" }
    });
    await waitFor(() => {
      expect(sidecarSignals[0]?.aborted).toBe(true);
      expect(sidecarSignals).toHaveLength(2);
    });
    expect(rankedPostsSidecarLoaderInFlightCount()).toBe(1);

    unmount();
    expect(sidecarSignals[1]?.aborted).toBe(true);
    expect(rankedPostsSidecarLoaderInFlightCount()).toBe(0);
  });

  it("renders filters in the requested order without Topic subtext", () => {
    const fullGraph = graphResponse([
      makeNode("company:ordered", "Ordered Co", "b2b", "#7dd3fc", "Partner A")
    ]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    const { container } = render(<Dashboard initialGraph={fullGraph} />);
    const labels = [...container.querySelectorAll(".filter-band > .filter-dropdown > .filter-dropdown-label")]
      .map((element) => element.textContent?.trim());

    expect(labels).toEqual(["Platform", "Industry", "Vertical", "Top Voices", "Group partner", "Topics"]);
    const topicGroup = screen.getByText("Topics").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topicGroup).getByRole("button", { name: /all topics/i }));
    expect(within(topicGroup).getByRole("menuitemcheckbox", { name: /Product Launch/i })).toBeInTheDocument();
    expect(within(topicGroup).queryByText(/major offering has launched/i)).not.toBeInTheDocument();
  });

  it("groups and searches canonical Topics with sticky reset controls and accessible keyboard focus", async () => {
    const fullGraph = graphResponse([
      makeNode("company:launch", "Launch Co", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:customer", "Customer Co", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:showcase", "Showcase Co", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:research", "Research Co", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:culture", "Culture Co", "b2b", "#7dd3fc", "Partner A")
    ]);
    fullGraph.evidence = fullGraph.evidence.map((item) => ({
      ...item,
      text: item.entityId === "launch"
        ? "We just launched our public beta and it is available today."
        : item.entityId === "customer"
          ? "Our customer selected us after a successful paid pilot."
          : item.entityId === "showcase"
            ? "Watch our product demo in action."
            : item.entityId === "research"
              ? "Our benchmark results show the new evaluation outperforms prior models."
              : "Expectation vs reality: the deployment meme of the week.",
      topics: item.entityId === "launch"
        ? ["product-launch"]
        : item.entityId === "customer"
          ? ["customer-partnership-deployment"]
          : item.entityId === "showcase"
            ? ["product-demo-showcase"]
        : item.entityId === "research"
          ? ["research-benchmark-technical-insight"]
          : ["humor-culture"]
    }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} />);

    const topicGroup = screen.getByText("Topics").closest(".filter-dropdown") as HTMLElement;
    const trigger = within(topicGroup).getByRole("button", { name: /all topics/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });

    const menu = within(topicGroup).getByRole("menu", { name: "Topics filter" });
    const allTopics = within(menu).getByRole("menuitemcheckbox", { name: "All topics" });
    await waitFor(() => expect(allTopics).toHaveFocus());
    expect(within(menu).getByText("Business progress")).toBeInTheDocument();
    expect(within(menu).getByText("Product & technical")).toBeInTheDocument();
    expect(within(menu).getByText("Company narrative")).toBeInTheDocument();
    expect(within(menu).getByText("Ecosystem")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitemcheckbox", { name: /^Other(?:\s|$)/i })).not.toBeInTheDocument();

    fireEvent.keyDown(allTopics, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Customers & Partners\s*\(1\)/i })).toHaveFocus();

    const launch = within(menu).getByRole("menuitemcheckbox", { name: /Product Launch\s*\(1\)/i });
    expect(launch).toHaveAttribute("data-filter-value", "product-launch");
    fireEvent.click(launch);
    expect(within(menu).getByText("Clear")).toBeInTheDocument();
    expect(allTopics).toHaveAttribute("aria-checked", "false");

    const search = within(menu).getByRole("searchbox", { name: "Search Topics" });
    fireEvent.change(search, { target: { value: "open source" } });
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Research & Technical/i })).toHaveAttribute(
      "data-filter-value",
      "research-benchmark-technical-insight"
    );
    expect(within(menu).queryByRole("menuitemcheckbox", { name: /Product Launch/i })).not.toBeInTheDocument();
    expect(within(menu).queryByText("Business progress")).not.toBeInTheDocument();
    expect(within(menu).queryByText(/engineering explanation/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/confidence|classifier|automatic/i)).not.toBeInTheDocument();

    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("shows only the selected topic's posts in the selected company panel", async () => {
    const node = makeNode("company:mixed-posts", "Mixed Posts", "b2b", "#7dd3fc", "Partner A");
    const fullGraph = graphResponse([node]);
    const launchEvidence = {
      ...fullGraph.evidence[0]!,
      id: "launch-post",
      platformPostId: "launch-post",
      sourceUrl: "https://x.com/mixed/status/launch-post",
      text: "We just launched our public beta and it is available today.",
      topics: ["product-launch"] as EvidenceItem["topics"]
    };
    const tractionEvidence = {
      ...fullGraph.evidence[0]!,
      id: "traction-post",
      platformPostId: "traction-post",
      sourceUrl: "https://x.com/mixed/status/traction-post",
      text: "We crossed 10,000 paid customers this quarter.",
      topics: ["traction-growth"] as EvidenceItem["topics"]
    };
    fullGraph.evidence = [launchEvidence, tractionEvidence];
    fullGraph.nodes = fullGraph.nodes.map((candidate) => candidate.id === node.id
      ? { ...candidate, evidenceIds: [launchEvidence.id, tractionEvidence.id] }
      : candidate);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} />);
    expect(screen.getByTestId("node-panel")).toHaveAttribute(
      "data-evidence-ids",
      "launch-post|traction-post"
    );

    const topicGroup = screen.getByText("Topics").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topicGroup).getByRole("button", { name: /all topics/i }));
    fireEvent.click(within(topicGroup).getByRole("menuitemcheckbox", { name: /Product Launch/i }));

    await waitFor(() => {
      expect(screen.getByTestId("node-panel")).toHaveAttribute("data-evidence-ids", "launch-post");
    });
  });

  it("updates Topic post counts from active filters without collapsing the Topic OR facet", async () => {
    const fullGraph = graphResponse([
      makeNode("company:x-launch", "X Launch", "b2b", "#7dd3fc", "Partner A", 90, "x"),
      makeNode("company:x-traction", "X Traction", "b2b", "#7dd3fc", "Partner A", 70, "x"),
      makeNode("company:github-launch", "GitHub Launch", "fintech", "#2563eb", "Partner B", 85, "github")
    ]);
    fullGraph.evidence = fullGraph.evidence.map((item) => ({
      ...item,
      text: item.entityId.endsWith("launch")
        ? "We just launched our new product and it is now live."
        : "We crossed 10,000 paid customers."
    }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} />);

    const topicGroup = screen.getByText("Topics").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topicGroup).getByRole("button", { name: /all topics/i }));
    expect(within(topicGroup).getByRole("menuitemcheckbox", { name: /Product Launch\s*\(2\)/i })).toBeEnabled();
    expect(within(topicGroup).getByRole("menuitemcheckbox", { name: /Traction & Growth\s*\(1\)/i })).toBeEnabled();

    const platformGroup = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(platformGroup).getByRole("button", { name: /all platforms/i }));
    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /^X$/i }));

    fireEvent.click(within(topicGroup).getByRole("button", { name: /all topics/i }));
    await waitFor(() => {
      expect(within(topicGroup).getByRole("menuitemcheckbox", { name: /Product Launch\s*\(1\)/i })).toBeEnabled();
      expect(within(topicGroup).getByRole("menuitemcheckbox", { name: /Traction & Growth\s*\(1\)/i })).toBeEnabled();
    });

    fireEvent.click(within(topicGroup).getByRole("menuitemcheckbox", { name: /Traction & Growth\s*\(1\)/i }));
    expect(within(topicGroup).getByRole("menuitemcheckbox", { name: /Product Launch\s*\(1\)/i })).toBeEnabled();
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
      expect(within(screen.getByTestId("graph-canvas")).getByText("B2B A")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("B2B B")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech A")).toBeInTheDocument();
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:fintech-a");
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focus-active", "true");
      expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("industries:fintech");
    });

    fireEvent.click(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i }));
    expect(within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner A\s*\(2\)/i })).toBeInTheDocument();
    const partnerBButton = within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner B\s*\(1\)/i });
    fireEvent.click(partnerBButton);

    await waitFor(() => {
      expect(within(screen.getByTestId("graph-canvas")).getByText("B2B B")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech A")).toBeInTheDocument();
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:fintech-a");
      expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("groupPartners:Partner B");
    });
  });

  it("composes Topic, Platform, and Vertical filters locally and persists canonical URL values", async () => {
    const launchNode = {
      ...makeNode("company:launch-co", "Launch Co", "b2b", "#7dd3fc", "Partner A", 72, "x"),
      verticals: ["ai-agents"] as GraphNode["verticals"]
    };
    const fintechNode = {
      ...makeNode("company:fintech-co", "Fintech Co", "fintech", "#2563eb", "Partner B", 68, "github"),
      verticals: ["fintech"] as GraphNode["verticals"]
    };
    const fullGraph = graphResponse([launchNode, fintechNode]);
    fullGraph.evidence = fullGraph.evidence.map((item) => ({
      ...item,
      text: item.entityId === "launch-co"
        ? "We just launched our public beta and it is available today."
        : "We crossed 10,000 paid customers."
    }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} />);

    const topicGroup = screen.getByText("Topics").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topicGroup).getByRole("button", { name: /all topics/i }));
    fireEvent.click(within(topicGroup).getByRole("menuitemcheckbox", { name: /Product Launch/i }));

    await waitFor(() => {
      expect(within(screen.getByTestId("graph-canvas")).getByText("Launch Co")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech Co")).toBeInTheDocument();
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:launch-co");
      expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("topics:product-launch");
      expect(window.location.search).toContain("topics=product-launch");
    });

    const platformGroup = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(platformGroup).getByRole("button", { name: /all platforms/i }));
    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /GitHub/i }));
    await waitFor(() => {
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "");
      expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("platforms:github");
      expect(within(screen.getByTestId("graph-canvas")).getByText("Launch Co")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech Co")).toBeInTheDocument();
    });

    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /all platforms/i }));
    const verticalGroup = screen.getByText("Vertical").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(verticalGroup).getByRole("button", { name: /all verticals/i }));
    const search = within(verticalGroup).getByRole("searchbox", { name: /search vertical/i });
    fireEvent.change(search, { target: { value: "AI Agents" } });
    const aiAgents = within(verticalGroup).getByRole("menuitemcheckbox", { name: /AI Agents/i });
    expect(aiAgents).toBeEnabled();
    fireEvent.click(aiAgents);

    await waitFor(() => {
      expect(within(screen.getByTestId("graph-canvas")).getByText("Launch Co")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech Co")).toBeInTheDocument();
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:launch-co");
      expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("verticals:ai-agents");
      expect(window.location.search).toContain("verticals=ai-agents");
      expect(window.location.search).not.toContain("topics=bogus");
    });
  });

  it("preserves more than five explicit vertical filters instead of applying the inference cap", () => {
    const fullGraph = graphResponse([
      makeNode("company:vertical-cap", "Vertical Cap", "b2b", "#7dd3fc", "Partner A")
    ]);
    const verticals = COMPANY_VERTICALS.slice(0, 6).map(({ slug }) => slug);

    render(<Dashboard initialGraph={fullGraph} initialFilters={{ verticals }} />);

    const verticalGroup = screen.getByText("Vertical").closest(".filter-dropdown") as HTMLElement;
    expect(within(verticalGroup).getByRole("button", { name: "6 selected" })).toBeInTheDocument();
  });

  it("copies and rehydrates multiple Topics and more than five Verticals without truncation, then resets them", async () => {
    const topics = ["traction-growth", "product-launch"] as const;
    const verticals = COMPANY_VERTICALS.slice(0, 6).map(({ slug }) => slug);
    const node = {
      ...makeNode("company:shared-view", "Shared View", "b2b", "#7dd3fc", "Partner A", 88, "x"),
      verticals: [verticals[0]]
    };
    const fullGraph = graphResponse([node]);
    fullGraph.evidence = fullGraph.evidence.map((item) => ({ ...item, text: "We crossed 10,000 paid customers." }));
    const writeText = vi.fn(async (value: string) => {
      void value;
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    window.history.replaceState(
      null,
      "",
      `/?topics=${topics.join(",")}&verticals=${verticals.join(",")}&minScore=80`
    );

    const firstView = render(
      <Dashboard
        initialGraph={fullGraph}
        initialFilters={{ topics: [...topics], verticals, minScore: 80 }}
      />
    );

    expect(screen.getByText("Topics").closest(".filter-dropdown")).toHaveTextContent("2 selected");
    expect(screen.getByText("Vertical").closest(".filter-dropdown")).toHaveTextContent("6 selected");
    expect(screen.getByLabelText("Minimum score value")).toHaveValue(80);
    expect(within(screen.getByTestId("graph-canvas")).getByText("Shared View")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedUrl = new URL(writeText.mock.calls[0]![0]);
    expect(copiedUrl.searchParams.get("topics")?.split(",")).toEqual([...topics]);
    expect(copiedUrl.searchParams.get("verticals")?.split(",")).toEqual(verticals);
    expect(copiedUrl.searchParams.get("verticals")?.split(",")).toHaveLength(6);
    expect(copiedUrl.searchParams.get("minScore")).toBe("80");

    firstView.unmount();
    window.history.replaceState(null, "", `${copiedUrl.pathname}${copiedUrl.search}`);
    render(
      <Dashboard
        initialGraph={fullGraph}
        initialFilters={{ topics: [...topics], verticals, minScore: 80 }}
      />
    );

    const topicGroup = screen.getByText("Topics").closest(".filter-dropdown") as HTMLElement;
    const verticalGroup = screen.getByText("Vertical").closest(".filter-dropdown") as HTMLElement;
    expect(within(topicGroup).getByRole("button", { name: "2 selected" })).toBeInTheDocument();
    expect(within(verticalGroup).getByRole("button", { name: "6 selected" })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum score value")).toHaveValue(80);
    expect(within(screen.getByTestId("graph-canvas")).getByText("Shared View")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    fireEvent.click(within(topicGroup).getByRole("button", { name: "2 selected" }));
    fireEvent.click(within(topicGroup).getByRole("menuitemcheckbox", { name: /all topics/i }));
    fireEvent.click(within(verticalGroup).getByRole("button", { name: "6 selected" }));
    fireEvent.click(within(verticalGroup).getByRole("menuitemcheckbox", { name: /all verticals/i }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.has("topics")).toBe(false);
      expect(params.has("verticals")).toBe(false);
      expect(params.has("minScore")).toBe(false);
    });
    expect(within(topicGroup).getByRole("button", { name: /all topics/i })).toBeInTheDocument();
    expect(within(verticalGroup).getByRole("button", { name: /all verticals/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum score value")).toHaveValue(0);
  });

  it("wraps the searchable Vertical menu by keyboard and restores trigger focus from search Escape", async () => {
    const fullGraph = graphResponse([
      {
        ...makeNode("company:keyboard", "Keyboard Co", "b2b", "#7dd3fc", "Partner A"),
        verticals: ["ai-agents"]
      }
    ]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<Dashboard initialGraph={fullGraph} />);

    const verticalGroup = screen.getByText("Vertical").closest(".filter-dropdown") as HTMLElement;
    const trigger = within(verticalGroup).getByRole("button", { name: /all verticals/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });

    const options = await within(verticalGroup).findAllByRole("menuitemcheckbox");
    const enabledOptions = options.filter((option) => !option.hasAttribute("disabled"));
    await waitFor(() => expect(document.activeElement).toBe(enabledOptions.at(-1)));
    fireEvent.keyDown(enabledOptions.at(-1)!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0]!, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    const search = within(verticalGroup).getByRole("searchbox", { name: /search vertical/i });
    search.focus();
    fireEvent.change(search, { target: { value: "definitely-not-a-vertical" } });
    expect(within(verticalGroup).getByText("No matching verticals")).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
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

  it("aborts an in-flight initial graph request when the dashboard unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<Dashboard />);
    await waitFor(() => expect(requestSignal).toBeDefined());

    view.unmount();

    expect(requestSignal?.aborted).toBe(true);
  });

  it("marks an initial uncached load busy and disables scope-specific filters", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard />);

    expect(screen.getByRole("region", { name: "Network map results" })).toHaveAttribute("aria-busy", "true");
    const industryGroup = screen.getByText("Industry").closest(".filter-dropdown") as HTMLElement;
    const groupPartnerGroup = screen.getByText("Group partner").closest(".filter-dropdown") as HTMLElement;
    const platformGroup = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    expect(within(industryGroup).getByRole("button", { name: /all industries/i })).toBeDisabled();
    expect(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i })).toBeDisabled();
    expect(within(platformGroup).getByRole("button", { name: /all platforms/i })).toBeEnabled();
    expect(within(topVoicesGroup).getByRole("button", { name: /all voices/i })).toBeEnabled();
  });

  it("omits the manual refresh control when production refresh is unavailable", () => {
    const fullGraph = graphResponse([
      makeNode("company:heyclicky", "HeyClicky", "b2b", "#7dd3fc", "Partner A")
    ]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} manualRefreshEnabled={false} />);

    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /batch/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search companies and founders")).toHaveAttribute(
      "aria-label",
      "Search companies and founders"
    );
  });

  it("keeps the batch selector visible with Spring, Summer, and Speedrun available", () => {
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

    expect(batchSelector).toHaveValue("S2026");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent("YC Spring 2026 (P26)");
    expect(options[0]).toHaveValue("S2026");
    expect(options[1]).toHaveTextContent("YC Summer 2026 (S26)");
    expect(options[1]).toHaveValue("S26");
    expect(options[2]).toHaveTextContent("a16z speedrun 006");
    expect(options[2]).toHaveValue("A16ZSR006");
  });

  it("uses exact a16z speedrun branding in the page and browser tab", () => {
    const speedrunGraph = graphResponse(
      [makeNode("company:sun", "SUN", "consumer", "#76F7EF", "a16z speedrun")],
      { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined))
    );

    const { container } = render(<Dashboard initialGraph={speedrunGraph} />);

    expect(screen.getByRole("heading", { name: "a16z Network Map" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "YC Network Map" })).not.toBeInTheDocument();
    expect(screen.getByAltText("a16z speedrun")).toHaveAttribute("src", "/brand/a16z-speedrun-logo.png");
    const groupPartnerGroup = screen.getByText("Group partner").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i }));
    expect(
      within(groupPartnerGroup).queryByRole("menuitemcheckbox", { name: /a16z speedrun\s*\(1\)/i })
    ).not.toBeInTheDocument();
    expect(container.querySelector(".dashboard-a16z")).toBeInTheDocument();
    expect(document.title).toBe("a16z Network Map");
  });

  it("fetches only the selected Top Voices snapshot", async () => {
    const fullGraph = graphResponse([
      makeNode("company:heyclicky", "HeyClicky", "b2b", "#7dd3fc", "Partner A")
    ]);
    const partnerGraph = withTopVoiceAudience(fullGraph, "yc_partners");
    const insiderGraph = withTopVoiceAudience(fullGraph, "insiders");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return {
        ok: true,
        json: async () => String(input).includes("insiders") ? insiderGraph : partnerGraph
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} />);

    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /all voices/i }));
    await act(async () => {
      await Promise.resolve();
    });
    const initialRequestUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(initialRequestUrls.filter((url) => url.startsWith("/graph/") || url.startsWith("/api/graph?")))
      .toHaveLength(0);
    expect(initialRequestUrls).toEqual([
      expect.stringMatching(
        /^\/api\/ranked-posts-sidecar\?v=ranked-posts-full-corpus-v1&refresh=[a-z0-9]+$/u
      )
    ]);

    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /YC Partners/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/graph/s2026-yc-partners.json"))).toBe(true);
    });
    const staticCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/graph/s2026-yc-partners.json"));
    expect(staticCall?.[1]).toMatchObject({ cache: "no-store" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("s2026-insiders.json"))).toBe(false);
    expect(window.location.search).toContain("topVoices=yc_partners");
  });

  it("preserves same-batch filters and the full option catalog when Top Voices changes", async () => {
    const fullGraph = graphResponse([
      makeNode("company:b2b", "B2B Baseline", "b2b", "#7dd3fc", "Partner A", 70, "x"),
      makeNode("company:fintech", "Fintech Baseline", "fintech", "#2563eb", "Partner B", 80, "x")
    ]);
    const partnerGraph = withTopVoiceAudience(
      graphResponse([
        makeNode("company:fintech", "Fintech Baseline", "fintech", "#2563eb", "Partner B", 80, "x")
      ]),
      "yc_partners"
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => partnerGraph })));

    render(<Dashboard initialGraph={fullGraph} />);
    const industryGroup = screen.getByText("Industry").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(industryGroup).getByRole("button", { name: /all industries/i }));
    fireEvent.click(within(industryGroup).getByRole("menuitemcheckbox", { name: /Fintech/i }));

    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /all voices/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /YC Partners/i }));

    await waitFor(() => {
      expect(within(industryGroup).getByRole("button", { name: /Fintech/i })).toBeInTheDocument();
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:fintech");
      expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("topVoices:yc_partners");
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("B2B Baseline")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).getByText("Fintech Baseline")).toBeInTheDocument();

    fireEvent.click(within(industryGroup).getByRole("button", { name: /Fintech/i }));
    expect(within(industryGroup).getByRole("menuitemcheckbox", { name: /B2B\s*\(1\)/i })).toBeInTheDocument();
    const groupPartnerGroup = screen.getByText("Group partner").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i }));
    expect(within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner A\s*\(1\)/i })).toBeInTheDocument();
    expect(within(groupPartnerGroup).getByRole("menuitemcheckbox", { name: /Partner B\s*\(1\)/i })).toBeInTheDocument();
  });

  it("fetches the off-audience baseline for a direct Top Voices scope", async () => {
    const baselineGraph = graphResponse([
      makeNode("company:baseline-a", "Baseline A", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:baseline-b", "Baseline B", "fintech", "#2563eb", "Partner B")
    ]);
    const audienceGraph = withTopVoiceAudience(
      graphResponse([makeNode("company:baseline-b", "Baseline B", "fintech", "#2563eb", "Partner B")]),
      "yc_partners"
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return { ok: true, json: async () => baselineGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={audienceGraph} initialTopVoiceAudience="yc_partners" />);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/graph/s2026.json"))).toBe(true);
      expect(within(screen.getByTestId("graph-canvas")).getByText("Baseline A")).toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("Baseline B")).toBeInTheDocument();
    });
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:baseline-b");
    expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("topVoices:yc_partners");
  });

  it("retries a transient off-audience baseline failure for a direct Top Voices scope", async () => {
    vi.useFakeTimers();
    const baselineGraph = graphResponse([
      makeNode("company:baseline-a", "Baseline A", "b2b", "#7dd3fc", "Partner A"),
      makeNode("company:baseline-b", "Baseline B", "fintech", "#2563eb", "Partner B")
    ]);
    const audienceGraph = withTopVoiceAudience(
      graphResponse([makeNode("company:baseline-b", "Baseline B", "fintech", "#2563eb", "Partner B")]),
      "yc_partners"
    );
    let failedCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/ranked-posts-sidecar") || url.startsWith("/api/topic-facets/")) {
        return { ok: false, json: async () => ({}) };
      }
      if (failedCalls < 5) {
        failedCalls += 1;
        throw new Error("Temporary baseline failure");
      }
      return { ok: true, json: async () => baselineGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={audienceGraph} initialTopVoiceAudience="yc_partners" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(880);
    });
    expect(fetchMock.mock.calls.filter(([input]) => {
      const url = String(input);
      return url.includes("/graph/") || url.includes("/api/graph");
    }).length).toBe(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchMock.mock.calls.filter(([input]) => {
      const url = String(input);
      return url.includes("/graph/") || url.includes("/api/graph");
    }).length).toBeGreaterThan(5);
    expect(within(screen.getByTestId("graph-canvas")).getByText("Baseline A")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:baseline-b");
  });

  it("navigates Top Voices by keyboard and restores focus after selection", () => {
    const fullGraph = graphResponse([
      makeNode("company:heyclicky", "HeyClicky", "b2b", "#7dd3fc", "Partner A")
    ]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} />);

    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    const trigger = within(topVoicesGroup).getByRole("button", { name: /all voices/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const allVoices = within(topVoicesGroup).getByRole("menuitemradio", { name: /all voices/i });
    const partners = within(topVoicesGroup).getByRole("menuitemradio", { name: /YC Partners/i });
    const insiders = within(topVoicesGroup).getByRole("menuitemradio", { name: /Insiders/i });
    expect(allVoices).toHaveFocus();

    fireEvent.keyDown(allVoices, { key: "ArrowDown" });
    expect(partners).toHaveFocus();
    fireEvent.keyDown(partners, { key: "End" });
    expect(insiders).toHaveFocus();
    fireEvent.keyDown(insiders, { key: "Home" });
    expect(allVoices).toHaveFocus();
    fireEvent.keyDown(allVoices, { key: "ArrowUp" });
    expect(insiders).toHaveFocus();

    fireEvent.keyDown(insiders, { key: "Enter" });

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent("Insiders");
    expect(within(topVoicesGroup).queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("topVoices")).toBe("insiders");
  });

  it("falls through a fresh legacy static snapshot to the graph API", async () => {
    const generatedAt = new Date().toISOString();
    const legacyBase = graphResponse([
      makeNode("company:legacy", "Fresh Legacy Snapshot", "b2b", "#7dd3fc", "Partner A")
    ]);
    const legacyStaticGraph: GraphResponse = {
      ...legacyBase,
      generatedAt,
      scoringContext: {
        ...legacyBase.scoringContext!,
        modelId: "traction-score",
        responseBuiltAt: generatedAt
      }
    };
    const apiGraph = graphResponse([
      makeNode("company:api", "Live API Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).startsWith("/graph/") ? legacyStaticGraph : apiGraph
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard />);

    expect(await screen.findByText("Live API Graph")).toBeInTheDocument();
    expect(screen.queryByText("Fresh Legacy Snapshot")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/graph/s2026.json"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/graph?batch=S2026")).toBe(true);
  });

  it("falls through a contradictory v4 static snapshot to the graph API", async () => {
    const invalidStaticGraph = graphResponse([
      makeNode("company:invalid", "Invalid Static Snapshot", "b2b", "#7dd3fc", "Partner A")
    ]);
    invalidStaticGraph.nodes[0]!.scoreBreakdown!.totalScore = invalidStaticGraph.nodes[0]!.score + 1;
    const apiGraph = graphResponse([
      makeNode("company:api", "Canonical API Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).startsWith("/graph/") ? invalidStaticGraph : apiGraph
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard />);

    expect(await screen.findByText("Canonical API Graph")).toBeInTheDocument();
    expect(screen.queryByText("Invalid Static Snapshot")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/graph?batch=S2026")).toBe(true);
  });

  it("falls through a valid static snapshot for the wrong graph scope", async () => {
    const wrongScopeGraph = graphResponse(
      [makeNode("company:wrong", "Wrong Batch Snapshot", "consumer", "#88CCF6", "Partner B")],
      { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
    );
    const apiGraph = graphResponse([
      makeNode("company:api", "Correct Spring Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).startsWith("/graph/") ? wrongScopeGraph : apiGraph
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard />);

    expect(await screen.findByText("Correct Spring Graph")).toBeInTheDocument();
    expect(screen.queryByText("Wrong Batch Snapshot")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/graph?batch=S2026")).toBe(true);
  });

  it("keeps stale controls inert during rapid audience switches and exposes only the final scope", async () => {
    const fullGraph = graphResponse([
      makeNode("company:default", "Default Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const partnerBaseGraph = graphResponse([
      makeNode("company:partner", "Partner Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const partnerGraph = withTopVoiceAudience(
      { ...partnerBaseGraph, generatedAt: new Date().toISOString() },
      "yc_partners"
    );
    const insiderBaseGraph = graphResponse([
      makeNode("company:insider", "Insider Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const insiderGraph = withTopVoiceAudience(
      { ...insiderBaseGraph, generatedAt: new Date().toISOString() },
      "insiders"
    );
    let resolvePartnerBody!: (graph: GraphResponse) => void;
    let resolveInsiderBody!: (graph: GraphResponse) => void;
    let partnerSignal: AbortSignal | undefined;
    const partnerBody = new Promise<GraphResponse>((resolve) => {
      resolvePartnerBody = resolve;
    });
    const insiderBody = new Promise<GraphResponse>((resolve) => {
      resolveInsiderBody = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => {
          if (url.includes("s2026-yc-partners.json")) {
            partnerSignal = init?.signal ?? undefined;
            return partnerBody;
          }
          if (url.includes("s2026-insiders.json") || url.includes("topVoices=insiders")) {
            return insiderBody;
          }
          return fullGraph;
        }
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} />);
    expect(screen.getByRole("button", { name: "Open profile Default Graph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open leaderboard Default Graph" })).toBeInTheDocument();

    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /all voices/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /YC Partners/i }));
    await waitFor(() => expect(partnerSignal).toBeDefined());

    const resultsRegion = screen.getByRole("region", { name: "Network map results" });
    const resultsGrid = resultsRegion.querySelector(".dashboard-grid") as HTMLElement;
    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).getByText("Default Graph")).toBeInTheDocument();
    expect(screen.queryByText("Loading YC map...")).not.toBeInTheDocument();
    expect(screen.getByText("Refreshing graph")).toBeInTheDocument();
    expect(resultsRegion).toHaveAttribute("aria-busy", "true");
    expect(resultsGrid).toHaveAttribute("inert");
    expect(within(resultsGrid).queryByText("Open profile Default Graph")).not.toBeInTheDocument();
    expect(within(resultsGrid).queryByText("Open leaderboard Default Graph")).not.toBeInTheDocument();

    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /YC Partners/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /Insiders/i }));

    expect(partnerSignal?.aborted).toBe(true);
    expect(within(screen.getByTestId("graph-canvas")).getByText("Default Graph")).toBeInTheDocument();

    await act(async () => {
      resolvePartnerBody(partnerGraph);
      await Promise.resolve();
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Default Graph")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).queryByText("Partner Graph")).not.toBeInTheDocument();
    expect(within(resultsGrid).queryByText("Open profile Partner Graph")).not.toBeInTheDocument();
    expect(within(resultsGrid).queryByText("Open leaderboard Partner Graph")).not.toBeInTheDocument();

    await act(async () => {
      resolveInsiderBody(insiderGraph);
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Open leaderboard Insider Graph" })).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).getByText("Default Graph")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).queryByText("Insider Graph")).not.toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:insider");
    expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("topVoices:insiders");
    expect(screen.getByRole("complementary", { name: "Insiders editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open leaderboard Insider Graph" })).toBeInTheDocument();
    expect(resultsRegion).toHaveAttribute("aria-busy", "false");
    expect(resultsGrid).not.toHaveAttribute("inert");
    expect(new URLSearchParams(window.location.search).get("topVoices")).toBe("insiders");
  });

  it("switches batches through a fresh static snapshot and revalidates once", async () => {
    vi.useFakeTimers();
    const springGraph = graphResponse([
      makeNode("company:screenpipe", "screenpipe", "b2b", "#7dd3fc", "Partner A", 100)
    ]);
    const speedrunGraph = withBenchmarkDates(
      staticGraphFixture(graphResponse(
        [makeNode("company:sun", "SUN", "consumer", "#88CCF6", "Partner A", 100)],
        { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
      )),
      localDateIso(-1),
      localDateIso(-7)
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => (url.includes("a16zsr006") || url.includes("batch=A16ZSR006") ? speedrunGraph : springGraph)
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={springGraph} />);

    expect(within(screen.getByTestId("graph-canvas")).getByText("screenpipe")).toBeInTheDocument();
    expect(document.title).toBe("YC Network Map");
    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), { target: { value: "A16ZSR006" } });
    expect(document.title).toBe("a16z Network Map");

    const resultsRegion = screen.getByRole("region", { name: "Network map results" });
    expect(resultsRegion).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading a16z map...")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("SUN")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).queryByText("screenpipe")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/graph/a16zsr006.json"))).toBe(true);
    expect(
      fetchMock.mock.calls
        .some(([input]) => String(input) === "/api/graph?batch=A16ZSR006")
    ).toBe(false);
    expect(resultsRegion).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(resultsRegion).toHaveAttribute("aria-busy", "false");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(
      fetchMock.mock.calls
        .filter(([input]) => String(input) === "/api/graph?batch=A16ZSR006")
    ).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), { target: { value: "S2026" } });
    expect(screen.getByText("Loading YC map...")).toBeInTheDocument();
    expect(document.title).toBe("YC Network Map");
  });

  it("keeps the old graph and clears scope-specific filters while an uncached scope loads", async () => {
    const springGraph = graphResponse([
      makeNode("company:fintech", "Spring Fintech", "fintech", "#2563eb", "Partner A")
    ]);
    const speedrunGraph = staticGraphFixture(graphResponse(
      [makeNode("company:consumer", "Speedrun Consumer", "consumer", "#88CCF6", "Partner B")],
      { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
    ));
    let resolveSpeedrun!: (response: { ok: boolean; json: () => Promise<GraphResponse> }) => void;
    const speedrunResponse = new Promise<{ ok: boolean; json: () => Promise<GraphResponse> }>((resolve) => {
      resolveSpeedrun = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes("a16zsr006")
        ? speedrunResponse
        : new Promise<never>(() => undefined)
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={springGraph} />);
    const industryGroup = screen.getByText("Industry").closest(".filter-dropdown") as HTMLElement;
    const groupPartnerGroup = screen.getByText("Group partner").closest(".filter-dropdown") as HTMLElement;
    const platformGroup = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(industryGroup).getByRole("button", { name: /all industries/i }));
    fireEvent.click(within(industryGroup).getByRole("menuitemcheckbox", { name: /Fintech/i }));
    expect(within(screen.getByTestId("graph-canvas")).getByText("Spring Fintech")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), { target: { value: "A16ZSR006" } });

    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).getByText("Spring Fintech")).toBeInTheDocument();
    expect(screen.getByText("Loading a16z map...")).toBeInTheDocument();
    expect(within(industryGroup).getByRole("button", { name: /all industries/i })).toBeInTheDocument();
    expect(within(industryGroup).getByRole("button", { name: /all industries/i })).toBeDisabled();
    expect(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i })).toBeDisabled();
    expect(within(platformGroup).getByRole("button", { name: /all platforms/i })).toBeEnabled();
    expect(within(topVoicesGroup).getByRole("button", { name: /all voices/i })).toBeEnabled();
    expect(new URLSearchParams(window.location.search).get("batch")).toBe("A16ZSR006");
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/graph/a16zsr006.json"))).toBe(true);
    });

    await act(async () => {
      resolveSpeedrun({ ok: true, json: async () => speedrunGraph });
      await Promise.resolve();
    });

    expect(await screen.findByText("Speedrun Consumer")).toBeInTheDocument();
    expect(screen.queryByText("Spring Fintech")).not.toBeInTheDocument();
    expect(within(industryGroup).getByRole("button", { name: /all industries/i })).toBeEnabled();
    expect(within(groupPartnerGroup).getByRole("button", { name: /all group partners/i })).toBeEnabled();
    fireEvent.click(within(industryGroup).getByRole("button", { name: /all industries/i }));
    expect(within(industryGroup).getByRole("menuitemcheckbox", { name: /Consumer\s*\(1\)/i })).toBeInTheDocument();
    expect(within(industryGroup).queryByRole("menuitemcheckbox", { name: /Fintech/i })).not.toBeInTheDocument();
  });

  it("offers a direct retry after an uncached scope load fails", async () => {
    vi.useFakeTimers();
    const springGraph = graphResponse([
      makeNode("company:spring", "Spring Company", "b2b", "#7dd3fc", "Partner A")
    ]);
    const speedrunGraph = graphResponse(
      [makeNode("company:speedrun", "Recovered Speedrun", "consumer", "#88CCF6", "Partner B")],
      { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
    );
    let failTargetScope = true;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("a16zsr006") && !url.includes("batch=A16ZSR006")) {
        return new Promise<Response>(() => undefined);
      }
      if (failTargetScope) {
        return Promise.reject(new Error("Graph service unavailable"));
      }
      return Promise.resolve({ ok: true, json: async () => speedrunGraph } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={springGraph} />);
    const resultsRegion = screen.getByRole("region", { name: "Network map results" });
    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), { target: { value: "A16ZSR006" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(resultsRegion).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("Graph service unavailable")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry selected graph/i });

    failTargetScope = false;
    fireEvent.click(retry);
    expect(resultsRegion).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(within(screen.getByTestId("graph-canvas")).getByText("Recovered Speedrun")).toBeInTheDocument();
    expect(resultsRegion).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("button", { name: /retry selected graph/i })).not.toBeInTheDocument();
  });

  it("keeps the baseline graph usable when an Insiders request returns 500, then recovers on retry", async () => {
    vi.useFakeTimers();
    const baselineGraph = graphResponse([
      makeNode("company:baseline", "Baseline Company", "b2b", "#7dd3fc", "Partner A")
    ]);
    const personalizedGraph = withTopVoiceAudience(
      graphResponse([
        makeNode("company:personalized", "Personalized Company", "fintech", "#2563eb", "Partner B")
      ]),
      "insiders"
    );
    let failPersonalizedGraph = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/graph") && url.includes("topVoices=insiders")) {
        return failPersonalizedGraph
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, json: async () => personalizedGraph };
      }
      return { ok: true, json: async () => baselineGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={baselineGraph} />);
    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /all voices/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /Insiders/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const resultsRegion = screen.getByRole("region", { name: "Network map results" });
    const resultsGrid = resultsRegion.querySelector(".dashboard-grid") as HTMLElement;
    expect(screen.getByText("Graph request failed with 500")).toBeInTheDocument();
    expect(resultsRegion).toHaveAttribute("aria-busy", "false");
    expect(resultsGrid).not.toHaveAttribute("inert");
    expect(within(screen.getByTestId("graph-canvas")).getByText("Baseline Company")).toBeInTheDocument();
    const baselineRow = screen.getByRole("button", { name: "Open leaderboard Baseline Company" });
    fireEvent.click(baselineRow);
    expect(screen.getByRole("button", { name: "Open profile Baseline Company" })).toBeInTheDocument();

    failPersonalizedGraph = false;
    fireEvent.click(screen.getByRole("button", { name: /retry selected graph/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByText("Graph request failed with 500")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry selected graph/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:personalized");
    expect(screen.getByRole("button", { name: "Open leaderboard Personalized Company" })).toBeInTheDocument();
  });

  it("keeps saved insider weights truthful when recomputation fails, then retries the lightweight refresh", async () => {
    window.history.replaceState(null, "", "/?insiderIds=paul-graham");
    const baselineGraph = graphResponse([
      makeNode("company:baseline", "Baseline Company", "b2b", "#7dd3fc", "Partner A")
    ]);
    const selectedPersonalizedGraph = {
      ...withTopVoiceAudience(
        graphResponse([
          makeNode("company:selected", "Selected Insider Company", "fintech", "#2563eb", "Partner B", 76)
        ]),
        "insiders"
      ),
      selectedInsiderIds: ["paul-graham"]
    };
    const recomputedGraph = {
      ...withTopVoiceAudience(
        graphResponse([
          makeNode("company:recomputed", "Recomputed Company", "fintech", "#2563eb", "Partner B", 84)
        ]),
        "insiders"
      ),
      selectedInsiderIds: ["paul-graham"],
      insiderConfigurationVersion: 1
    };
    const initialConfiguration = insiderConfigurationResponse();
    const savedConfiguration = insiderConfigurationResponse(1, 4);
    let failRecompute = true;
    let recomputeVersion = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/insiders" && method === "PUT") {
        return new Response(JSON.stringify(savedConfiguration), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "/api/insiders") {
        return new Response(JSON.stringify(initialConfiguration), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "/api/insiders/recompute") {
        if (failRecompute) {
          return new Response(JSON.stringify({
            error: {
              code: "GRAPH_RUNTIME_FAILURE",
              message: "Personalized scoring unavailable"
            }
          }), {
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-vercel-id": "sfo1::insiders-test"
            }
          });
        }
        return new Response(JSON.stringify({
          configurationVersion: recomputeVersion,
          graph: {
            ...recomputedGraph,
            insiderConfigurationVersion: recomputeVersion
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/api/graph") && url.includes("topVoices=insiders")) {
        return new Response(JSON.stringify(selectedPersonalizedGraph), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(baselineGraph), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={baselineGraph} />);
    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /all voices/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /Insiders/i }));

    expect(await screen.findByRole("button", { name: "Open leaderboard Selected Insider Company" }))
      .toBeInTheDocument();
    const decreaseWeight = await screen.findByRole("button", { name: "Decrease Paul Graham weight" });
    await waitFor(() => expect(decreaseWeight).toBeEnabled());
    fireEvent.click(decreaseWeight);
    fireEvent.click(screen.getByRole("button", { name: "Save & recompute" }));

    expect(await screen.findByText("Weights saved; scores refresh failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Graph request failed with 500: [GRAPH_RUNTIME_FAILURE] Personalized scoring unavailable"
    );
    expect(screen.getByRole("alert")).toHaveTextContent("request ID: sfo1::insiders-test");
    const recomputeRequests = () => fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/insiders/recompute"
    );
    expect(recomputeRequests()).toHaveLength(1);
    expect(JSON.parse(String((recomputeRequests()[0]![1] as RequestInit).body))).toEqual({
      batchSlug: "S2026",
      insiderIds: ["paul-graham"]
    });
    expect(window.location.search).toContain("insiderIds=paul-graham");
    expect(fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === "/api/insiders" && (init as RequestInit | undefined)?.method === "PUT"
    )).toHaveLength(1);

    failRecompute = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry score refresh" }));

    expect(await screen.findByText("Weights saved; scores refresh failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("stale Insider configuration");
    expect(screen.queryByRole("button", { name: "Open leaderboard Recomputed Company" }))
      .not.toBeInTheDocument();

    recomputeVersion = 1;
    fireEvent.click(screen.getByRole("button", { name: "Retry score refresh" }));

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open leaderboard Recomputed Company" })).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute(
      "data-node-scores",
      "baseline:50|recomputed:84"
    );
    expect(within(screen.getByTestId("graph-canvas")).getByText("Baseline Company")).toBeInTheDocument();
    expect(screen.getByTestId("leaderboard-score")).toHaveTextContent("84");
    expect(window.location.search).toContain("insiderIds=paul-graham");
    expect(recomputeRequests()).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(
      ([input, init]) => String(input) === "/api/insiders" && (init as RequestInit | undefined)?.method === "PUT"
    )).toHaveLength(1);
  });

  it("drops personalized graph versions and caches when the authenticated user changes", async () => {
    const baselineGraph = graphResponse([
      makeNode("company:baseline", "Baseline Company", "b2b", "#7dd3fc", "Partner A", 50)
    ]);
    const userAGraph = {
      ...withTopVoiceAudience(
        graphResponse([
          makeNode("company:user-a", "User A Company", "fintech", "#2563eb", "Partner B", 96)
        ]),
        "insiders"
      ),
      insiderConfigurationVersion: 8
    };
    const anonymousGraph = {
      ...withTopVoiceAudience(
        graphResponse([
          makeNode("company:anonymous", "Anonymous Company", "b2b", "#7dd3fc", "Partner A", 61)
        ]),
        "insiders"
      ),
      insiderConfigurationVersion: 0
    };
    const userBGraph = {
      ...withTopVoiceAudience(
        graphResponse([
          makeNode("company:user-b", "User B Company", "healthcare", "#ec4899", "Partner C", 72)
        ]),
        "insiders"
      ),
      insiderConfigurationVersion: 1
    };
    insiderAuthHarness.token = "token-a";
    insiderAuthHarness.userId = "user-a";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === "/api/insiders/recompute") {
        return new Response(JSON.stringify({
          configurationVersion: 8,
          graph: userAGraph
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "/api/insiders") {
        return new Response(JSON.stringify(insiderConfigurationResponse(8)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.startsWith("/api/graph")) {
        const authorization = headers.get("authorization");
        const responseGraph = authorization === "Bearer token-b"
          ? userBGraph
          : authorization === "Bearer token-a"
            ? userAGraph
            : anonymousGraph;
        return new Response(JSON.stringify(responseGraph), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify(baselineGraph), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <Dashboard
        initialGraph={userAGraph}
        initialTopVoiceAudience="insiders"
      />
    );
    expect(await screen.findByTestId("leaderboard-score")).toHaveTextContent("96");
    await waitFor(() => expect(fetchMock.mock.calls.some(
      ([input]) => String(input) === "/api/insiders/recompute"
    )).toBe(true));

    insiderAuthHarness.token = null;
    insiderAuthHarness.userId = null;
    act(() => {
      for (const listener of insiderAuthHarness.listeners) {
        listener({ event: "SIGNED_OUT", userId: null });
      }
    });
    await waitFor(() => expect(screen.getByTestId("leaderboard-score")).toHaveTextContent("61"));

    insiderAuthHarness.token = "token-b";
    insiderAuthHarness.userId = "user-b";
    act(() => {
      for (const listener of insiderAuthHarness.listeners) {
        listener({ event: "SIGNED_IN", userId: "user-b" });
      }
    });
    await waitFor(() => expect(screen.getByTestId("leaderboard-score")).toHaveTextContent("72"));
    expect(screen.queryByText(/stale Insider scores/i)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).startsWith("/api/graph") &&
      new Headers((init as RequestInit | undefined)?.headers).get("authorization") === "Bearer token-b"
    )).toBe(true);

    const graphRequestCount = fetchMock.mock.calls.filter(
      ([input]) => String(input).startsWith("/api/graph")
    ).length;
    act(() => {
      for (const listener of insiderAuthHarness.listeners) {
        listener({ event: "USER_UPDATED", userId: "user-b" });
        listener({ event: "SIGNED_IN", userId: "user-b" });
      }
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(
      ([input]) => String(input).startsWith("/api/graph")
    )).toHaveLength(graphRequestCount);
  });

  it("renders a successful zero-company response as an empty state instead of a loading failure", async () => {
    const emptyGraph = graphResponse([]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => emptyGraph
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard />);

    expect(await screen.findByText("No companies are available in this graph.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Network map results" })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText(/Graph request failed|Graph unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry selected graph/i })).not.toBeInTheDocument();
  });

  it("renders a stale static graph immediately, then refreshes it through the API", async () => {
    vi.useFakeTimers();
    const staleGraph = withBenchmarkDates(
      staticGraphFixture(
        graphResponse([makeNode("company:stale", "Stale Snapshot", "b2b", "#7dd3fc", "Partner A")])
      ),
      localDateIso(-2),
      localDateIso(-8)
    );
    const liveGraph = withBenchmarkDates(
      graphResponse([makeNode("company:fresh", "Fresh API", "b2b", "#7dd3fc", "Partner A")]),
      localDateIso(-1),
      localDateIso(-7)
    );

    let resolveApiGraph!: (response: { ok: boolean; json: () => Promise<GraphResponse> }) => void;
    const apiGraphResponse = new Promise<{ ok: boolean; json: () => Promise<GraphResponse> }>((resolve) => {
      resolveApiGraph = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.startsWith("/graph/s2026.json")
        ? { ok: true, json: async () => staleGraph }
        : apiGraphResponse;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Stale Snapshot")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/graph/s2026.json"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/graph?batch=S2026")).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/graph?batch=S2026")).toBe(true);

    resolveApiGraph({ ok: true, json: async () => liveGraph });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Fresh API")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).queryByText("Stale Snapshot")).not.toBeInTheDocument();
  });

  it("uses a fresh static graph for filtered first paint while revalidating unfiltered", async () => {
    vi.useFakeTimers();
    const staticGraph = withBenchmarkDates(
      staticGraphFixture(graphResponse([
        makeNode("company:x-only", "Static X Only", "b2b", "#7dd3fc", "Partner A", 80, "x"),
        makeNode("company:github-only", "GitHub Only", "fintech", "#2563eb", "Partner B", 70, "github")
      ])),
      localDateIso(-1),
      localDateIso(-7)
    );
    expect(validateStaticGraphSnapshotContract(staticGraph)).toEqual({ ok: true, issues: [] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return { ok: true, json: async () => staticGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialFilters={{ platforms: ["x"] }} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Static X Only")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).getByText("GitHub Only")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:x-only");
    expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("platforms:x");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/graph/s2026.json"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/graph?batch=S2026")).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/graph?batch=S2026")
    ).toHaveLength(1);
    expect(within(screen.getByTestId("graph-canvas")).getByText("Static X Only")).toBeInTheDocument();
  });

  it("downloads a successful fresh static graph once and revalidates the API once", async () => {
    vi.useFakeTimers();
    const staticGraph = withBenchmarkDates(
      staticGraphFixture(
        graphResponse([makeNode("company:static", "Static First Paint", "b2b", "#7dd3fc", "Partner A")])
      ),
      localDateIso(-1),
      localDateIso(-7)
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return {
        ok: true,
        json: async () => staticGraph
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Static First Paint")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Static First Paint")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/graph?batch=S2026").length
    ).toBe(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/graph/s2026.json")).length
    ).toBe(1);
  });

  it("revalidates an already-open graph when the tab resumes, with a cooldown", async () => {
    vi.useFakeTimers();
    const initial = graphResponse([
      makeNode("company:cached", "Cached Graph", "b2b", "#7dd3fc", "Partner A", 40)
    ]);
    const refreshed = graphResponse([
      makeNode("company:published", "Published Graph", "b2b", "#7dd3fc", "Partner A", 90)
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/graph?batch=S2026") {
        return { ok: false, json: async () => ({}) };
      }
      return { ok: true, json: async () => refreshed };
    });
    vi.stubGlobal("fetch", fetchMock);
    const apiCallCount = () => fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/graph?batch=S2026"
    ).length;

    render(<Dashboard initialGraph={initial} />);
    expect(within(screen.getByTestId("graph-canvas")).getByText("Cached Graph")).toBeInTheDocument();
    expect(apiCallCount()).toBe(0);

    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Published Graph")).toBeInTheDocument();
    expect(apiCallCount()).toBe(1);

    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiCallCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiCallCount()).toBe(2);
  });

  it("hydrates resumed graphs from the dynamic topic facet endpoint and replaces stale rows", async () => {
    const initial = graphResponse([
      makeNode("company:cached", "Cached Graph", "b2b", "#7dd3fc", "Partner A", 40)
    ]);
    initial.topicFacetRows = [{
      topic: "product-launch",
      postKey: "stale-static-row",
      platform: "x",
      companyId: "company-cached",
      contributionScore: 12,
      audienceId: "off"
    }];
    const refreshed = graphResponse([
      makeNode("company:published", "Published Graph", "b2b", "#7dd3fc", "Partner A", 90)
    ]);
    const currentFacetSnapshot = {
      version: TOPIC_FACET_SNAPSHOT_VERSION,
      batchSlug: "S2026",
      rowCount: 1,
      rows: [{
        topic: "traction-growth",
        postKey: "fresh-dynamic-row",
        platform: "x",
        companyId: "company-published",
        contributionScore: 24,
        audienceId: "off"
      }]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/graph?batch=S2026") return { ok: true, json: async () => refreshed };
      if (url.startsWith("/api/topic-facets/S2026?")) return new Response(JSON.stringify(currentFacetSnapshot));
      if (url.startsWith("/topic-facets/")) return new Response(JSON.stringify({ rows: [] }), { status: 503 });
      return new Response(JSON.stringify({}), { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={initial} />);
    expect(screen.getByTestId("topic-facet-post-keys")).toHaveTextContent("stale-static-row");

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(screen.getByTestId("topic-facet-post-keys")).toHaveTextContent("fresh-dynamic-row");
    });
    expect(screen.getByTestId("topic-facet-post-keys")).not.toHaveTextContent("stale-static-row");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/topic-facets/S2026?"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/topic-facets/"))).toBe(false);
  });

  it("keys resume cooldown by graph scope", async () => {
    vi.useFakeTimers();
    const initial = graphResponse([
      makeNode("company:cached", "Cached Graph", "b2b", "#7dd3fc", "Partner A", 40)
    ]);
    const refreshed = graphResponse([
      makeNode("company:published", "Published Graph", "b2b", "#7dd3fc", "Partner A", 90)
    ]);
    const speedrunGraph = withBenchmarkDates(
      staticGraphFixture(graphResponse(
        [makeNode("company:speedrun", "Speedrun Graph", "consumer", "#88CCF6", "Partner A", 80)],
        { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
      )),
      localDateIso(-1),
      localDateIso(-7)
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("a16zsr006")) return { ok: true, json: async () => speedrunGraph };
      if (url === "/api/graph?batch=S2026") return { ok: true, json: async () => refreshed };
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const apiCallCount = (url: string) => fetchMock.mock.calls.filter(([input]) => String(input) === url).length;

    render(<Dashboard initialGraph={initial} />);
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiCallCount("/api/graph?batch=S2026")).toBe(1);

    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), { target: { value: "A16ZSR006" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Speedrun Graph")).toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiCallCount("/api/graph?batch=A16ZSR006")).toBe(1);
  });

  it("ignores hidden visibility changes, refreshes when visible, and removes resume listeners", async () => {
    const initial = graphResponse([
      makeNode("company:cached", "Cached Graph", "b2b", "#7dd3fc", "Partner A", 40)
    ]);
    const refreshed = graphResponse([
      makeNode("company:published", "Published Graph", "b2b", "#7dd3fc", "Partner A", 90)
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/graph?batch=S2026"
        ? { ok: true, json: async () => refreshed }
        : { ok: false, json: async () => ({}) }
    );
    vi.stubGlobal("fetch", fetchMock);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");

    const { unmount } = render(<Dashboard initialGraph={initial} />);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await Promise.resolve();
    });
    const hiddenRequestUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(hiddenRequestUrls.filter((url) => url.startsWith("/graph/") || url.startsWith("/api/graph?")))
      .toHaveLength(0);
    expect(hiddenRequestUrls).toEqual([
      expect.stringMatching(
        /^\/api\/ranked-posts-sidecar\?v=ranked-posts-full-corpus-v1&refresh=[a-z0-9]+$/u
      )
    ]);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/graph?batch=S2026")).toHaveLength(1);

    const focusRegistration = addWindowListener.mock.calls.find(([type]) => type === "focus");
    const visibilityRegistration = addDocumentListener.mock.calls.find(([type]) => type === "visibilitychange");
    expect(focusRegistration).toBeDefined();
    expect(visibilityRegistration).toBeDefined();
    unmount();

    expect(removeWindowListener).toHaveBeenCalledWith("focus", focusRegistration?.[1]);
    expect(removeDocumentListener).toHaveBeenCalledWith("visibilitychange", visibilityRegistration?.[1]);
  });

  it("switches to a cached API-revalidated Top Voices graph without another request", async () => {
    vi.useFakeTimers();
    const fullGraph = graphResponse([
      makeNode("company:default", "Default Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const partnerBaseGraph = graphResponse([
      makeNode("company:cached-partner", "Cached Partner Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const partnerGraph = withBenchmarkDates(
      withTopVoiceAudience(partnerBaseGraph, "yc_partners"),
      null,
      null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return {
        ok: true,
        json: async () => partnerGraph
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} />);
    const topVoicesGroup = screen.getByText("Top Voices").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /all voices/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /YC Partners/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Default Graph")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:cached-partner");
    const requestsAfterFirstLoad = fetchMock.mock.calls.filter(([input]) => String(input).includes("/graph/")).length;

    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /YC Partners/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /all voices/i }));
    expect(within(screen.getByTestId("graph-canvas")).getByText("Default Graph")).toBeInTheDocument();

    fireEvent.click(within(topVoicesGroup).getByRole("button", { name: /all voices/i }));
    fireEvent.click(within(topVoicesGroup).getByRole("menuitemradio", { name: /YC Partners/i }));
    expect(within(screen.getByTestId("graph-canvas")).getByText("Default Graph")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:cached-partner");
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/graph/")).length).toBe(requestsAfterFirstLoad);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/graph"))).toHaveLength(1);
  });

  it("filters minimum score locally and derives a valid selection without waiting for a graph request", async () => {
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
    expect(screen.getByRole("button", { name: "Open profile Low Score" })).toBeInTheDocument();

    const minimumScore = screen.getByLabelText("Minimum score");
    fireEvent.change(minimumScore, { target: { value: "80" } });
    fireEvent.pointerUp(minimumScore, { currentTarget: { value: "80" } });

    await waitFor(() => {
      expect(within(screen.getByTestId("graph-canvas")).queryByText("Low Score")).not.toBeInTheDocument();
      expect(within(screen.getByTestId("graph-canvas")).getByText("High Score")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open profile High Score" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open profile Low Score" })).not.toBeInTheDocument();
    });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("minScore=80"), expect.any(Object));
  });

  it("keeps the route-backed platform filter symmetric with URL state", () => {
    const fullGraph = graphResponse([
      makeNode("company:x", "X Company", "b2b", "#7dd3fc", "Partner A", 80, "x")
    ]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} />);
    const platformGroup = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(platformGroup).getByRole("button", { name: /all platforms/i }));
    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /^X$/i }));

    expect(new URLSearchParams(window.location.search).get("platforms")).toBe("x");
    expect(screen.getByTestId("graph-canvas")).toHaveAttribute("data-focused-company-ids", "company:x");
    expect(screen.getByTestId("graph-canvas").getAttribute("data-focus-signature")).toContain("platforms:x");

    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /all platforms/i }));
    expect(new URLSearchParams(window.location.search).has("platforms")).toBe(false);
  });

  it("keeps canonical search rank after a platform filter removes higher-ranked companies", () => {
    const fullGraph = graphResponse([
      makeNode("company:github", "GitHub Leader", "b2b", "#7dd3fc", "Partner A", 90, "github"),
      makeNode("company:x", "X Company", "fintech", "#2563eb", "Partner B", 80, "x")
    ]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} initialFilters={{ platforms: ["x"] }} />);
    fireEvent.change(screen.getByPlaceholderText("Search companies and founders"), {
      target: { value: "X Company" }
    });

    expect(screen.getByText("#2, Score: 80")).toBeInTheDocument();
    expect(screen.queryByText("#1, Score: 80")).not.toBeInTheDocument();
  });

  it("uses tied canonical search ranks from a Top Voice audience subset", () => {
    const audienceGraph = withTopVoiceAudience(
      graphResponse([
        makeNode("company:partner-a", "Partner Match A", "b2b", "#7dd3fc", "Partner A", 80, "x"),
        makeNode("company:partner-b", "Partner Match B", "fintech", "#2563eb", "Partner B", 80, "x")
      ]),
      "yc_partners"
    );
    audienceGraph.leaderboard = audienceGraph.leaderboard.map((row) => ({ ...row, rank: 3 }));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={audienceGraph} initialTopVoiceAudience="yc_partners" />);
    fireEvent.change(screen.getByPlaceholderText("Search companies and founders"), {
      target: { value: "Partner Match" }
    });

    expect(screen.getAllByText("#3, Score: 80")).toHaveLength(2);
    expect(screen.queryByText("#1, Score: 80")).not.toBeInTheDocument();
    expect(screen.queryByText("#2, Score: 80")).not.toBeInTheDocument();
  });

  it("shows a truthful empty state when active filters remove every company", async () => {
    const fullGraph = graphResponse([
      makeNode("company:low", "Low Score", "b2b", "#7dd3fc", "Partner A", 20)
    ]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    render(<Dashboard initialGraph={fullGraph} />);
    fireEvent.change(screen.getByLabelText("Minimum score value"), { target: { value: "80" } });
    fireEvent.blur(screen.getByLabelText("Minimum score value"));

    expect(await screen.findByText("No companies match the active filters.")).toBeInTheDocument();
    expect(screen.queryByText(/No companies have traction from this Top Voices audience/i)).not.toBeInTheDocument();
  });

  it("stores a fresh unfiltered graph after a filtered manual refresh", async () => {
    const initialGraph = graphResponse([
      makeNode("company:old", "Old Snapshot", "b2b", "#7dd3fc", "Partner A", 70, "x")
    ]);
    const filteredRefreshGraph = graphResponse([
      makeNode("company:fresh-x", "Fresh X Evidence", "fintech", "#2563eb", "Partner B", 90, "x")
    ]);
    const unfilteredFreshGraph = graphResponse([
      makeNode("company:fresh-x", "Fresh X Evidence", "fintech", "#2563eb", "Partner B", 90, "x"),
      makeNode("company:fresh-github", "Fresh GitHub Evidence", "healthcare", "#16a34a", "Partner C", 80, "github")
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/graph/refresh") {
        return {
          ok: true,
          json: async () => ({ graph: filteredRefreshGraph, status: "completed" })
        };
      }
      return { ok: true, json: async () => unfilteredFreshGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={initialGraph} />);
    const platformGroup = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(platformGroup).getByRole("button", { name: /all platforms/i }));
    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /^X$/i }));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText("Fresh X Evidence")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/graph?batch=S2026")).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("platforms=x"))).toBe(false);

    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /all platforms/i }));

    expect(await screen.findByText("Fresh GitHub Evidence")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).queryByText("Old Snapshot")).not.toBeInTheDocument();
    const industryGroup = screen.getByText("Industry").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(industryGroup).getByRole("button", { name: /all industries/i }));
    expect(within(industryGroup).getByRole("menuitemcheckbox", { name: /Healthcare\s*\(1\)/i })).toBeInTheDocument();
  });

  it("keeps fresh filtered refresh metadata when the unfiltered fetch fails", async () => {
    vi.useFakeTimers();
    const initialGraph = graphResponse([
      makeNode("company:old", "Old Snapshot", "b2b", "#7dd3fc", "Partner A", 70, "x")
    ]);
    const filteredRefreshGraph = graphResponse([
      makeNode("company:fresh", "Fresh Live Evidence", "fintech", "#2563eb", "Partner B", 95, "x")
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/graph/refresh") {
        return {
          ok: true,
          json: async () => ({ graph: filteredRefreshGraph, status: "completed" })
        };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={initialGraph} />);
    const platformGroup = screen.getByText("Platform").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(platformGroup).getByRole("button", { name: /all platforms/i }));
    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /^X$/i }));
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Fresh Live Evidence")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/graph?batch=S2026")).toHaveLength(3);

    fireEvent.click(within(platformGroup).getByRole("menuitemcheckbox", { name: /all platforms/i }));
    expect(within(screen.getByTestId("graph-canvas")).getByText("Fresh Live Evidence")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).queryByText("Old Snapshot")).not.toBeInTheDocument();

    const industryGroup = screen.getByText("Industry").closest(".filter-dropdown") as HTMLElement;
    fireEvent.click(within(industryGroup).getByRole("button", { name: /all industries/i }));
    expect(within(industryGroup).getByRole("menuitemcheckbox", { name: /Fintech\s*\(1\)/i })).toBeInTheDocument();
    expect(within(industryGroup).queryByRole("menuitemcheckbox", { name: /B2B/i })).not.toBeInTheDocument();
  });

  it("shows API-level refresh failures instead of treating every HTTP 200 as success", async () => {
    const fullGraph = graphResponse([
      makeNode("company:screenpipe", "screenpipe", "b2b", "#7dd3fc", "Partner A", 100, "x")
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/graph/refresh") {
        return {
          ok: true,
          json: async () => ({
            graph: fullGraph,
            errors: ["Live refresh finished without accepted evidence. Top reasons: no_status_ids:1."],
            refreshSummary: {
              status: "failed",
              acceptedRows: 0,
              visibleRows: 0,
              failureReasonCounts: { no_status_ids: 1 }
            }
          })
        };
      }
      return {
        ok: true,
        json: async () => fullGraph
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} initialFilters={{ platforms: ["x"] }} />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText(/Live refresh finished without accepted evidence/i)).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).getByText("screenpipe")).toBeInTheDocument();
  });

  it("surfaces structured refresh errors from non-success responses", async () => {
    const fullGraph = graphResponse([
      makeNode("company:screenpipe", "screenpipe", "b2b", "#7dd3fc", "Partner A", 100, "x")
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/graph/refresh") {
        return {
          ok: false,
          status: 503,
          json: async () => ({
            status: "failed",
            errors: ["Refresh storage is temporarily unavailable."],
            error: { code: "refresh_storage_unavailable" }
          })
        };
      }
      return { ok: true, json: async () => fullGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText("Refresh storage is temporarily unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/request failed with 503/i)).not.toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).getByText("screenpipe")).toBeInTheDocument();
  });

  it("cancels an active refresh immediately when the graph scope changes", async () => {
    const fullGraph = graphResponse([
      makeNode("company:screenpipe", "screenpipe", "b2b", "#7dd3fc", "Partner A", 100, "x")
    ]);
    let refreshSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/graph/refresh") {
        refreshSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(refreshSignal).toBeDefined());

    fireEvent.change(screen.getByRole("combobox", { name: /batch/i }), { target: { value: "A16ZSR006" } });

    expect(refreshSignal?.aborted).toBe(true);
    expect(screen.queryByText(/timed out|request failed|cancelled/i)).not.toBeInTheDocument();
  });

  it("aborts and ignores an older graph response after a fresh manual refresh", async () => {
    vi.useFakeTimers();
    const initialGraph = graphResponse([
      makeNode("company:initial", "Initial Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const staleGraph = graphResponse([
      makeNode("company:stale", "Stale Background Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    const freshGraph = graphResponse([
      makeNode("company:fresh", "Fresh Manual Graph", "b2b", "#7dd3fc", "Partner A")
    ]);
    let resolveStaleBody!: (graph: GraphResponse) => void;
    let staleRequestSignal: AbortSignal | undefined;
    const staleBody = new Promise<GraphResponse>((resolve) => {
      resolveStaleBody = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/graph?batch=S2026") {
        staleRequestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          json: async () => staleBody
        };
      }
      if (url === "/api/graph/refresh") {
        return {
          ok: true,
          json: async () => ({ graph: freshGraph, status: "completed" })
        };
      }
      return { ok: true, json: async () => initialGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={initialGraph} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(staleRequestSignal).toBeDefined();
    expect(staleRequestSignal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Fresh Manual Graph")).toBeInTheDocument();
    expect(staleRequestSignal?.aborted).toBe(true);

    await act(async () => {
      resolveStaleBody(staleGraph);
      await Promise.resolve();
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("Fresh Manual Graph")).toBeInTheDocument();
    expect(within(screen.getByTestId("graph-canvas")).queryByText("Stale Background Graph")).not.toBeInTheDocument();
  });

  it("keeps the refresh timeout active while the response body is pending", async () => {
    vi.useFakeTimers();
    const fullGraph = graphResponse([
      makeNode("company:screenpipe", "screenpipe", "b2b", "#7dd3fc", "Partner A", 100, "x")
    ]);
    let refreshSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/graph/refresh") {
        refreshSignal = init?.signal ?? undefined;
        return {
          ok: true,
          json: () => new Promise<never>(() => undefined)
        };
      }
      return { ok: true, json: async () => fullGraph };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={fullGraph} />);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(44_999);
    });
    expect(refreshSignal).toBeDefined();
    expect(refreshSignal?.aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refreshSignal?.aborted).toBe(true);
    expect(screen.getByText(/Refresh timed out and was cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText("Request timed out after 45s")).not.toBeInTheDocument();
  });

  it("cancels a timed-out manual refresh without claiming a background job or polling", async () => {
    vi.useFakeTimers();
    const staleGraph = graphResponse([
      makeNode("company:screenpipe", "screenpipe", "b2b", "#7dd3fc", "Partner A", 80, "x")
    ]);
    let graphApiCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/graph/refresh") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (url.startsWith("/api/graph")) {
        graphApiCalls += 1;
        return Promise.resolve({
          ok: true,
          json: async () => staleGraph
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => staleGraph
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Dashboard initialGraph={staleGraph} initialFilters={{ platforms: ["x"] }} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_400);
    });
    expect(within(screen.getByTestId("graph-canvas")).getByText("screenpipe")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(screen.getByText(/Refresh timed out and was cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/still running/i)).not.toBeInTheDocument();
    const callsAfterTimeout = graphApiCalls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(graphApiCalls).toBe(callsAfterTimeout);
  });
});

function graphResponse(
  nodes: GraphNode[],
  batch = { slug: "S2026", label: "YC Spring 2026 (P26)", companyCountExpected: 197, companyCountObserved: 197 }
): GraphResponse {
  const evidence = nodes.map(testEvidenceForNode);
  const batchNodes = nodes.map((node) => ({
    ...node,
    batchSlug: batch.slug,
    evidenceIds: [testEvidenceId(node)],
    scoreBreakdown: node.scoreBreakdown ?? testScoreBreakdown(node)
  }));
  const leaderboard = batchNodes.map((node, index) => ({
    rank: index + 1,
    companyId: node.entityId,
    companyName: node.label,
    score: node.score,
    topPlatform: node.topPlatform,
    socialAccounts: [],
    biggestContribution: null
  }));
  const fastestGaining = leaderboard.map((row) => ({
    rank: row.rank,
    companyId: row.companyId,
    companyName: row.companyName,
    dod: unbenchmarkedMomentum(row.score, row.rank),
    wow: unbenchmarkedMomentum(row.score, row.rank)
  }));

  return {
    batch,
    batches: [
      { slug: "S2026", label: "YC Spring 2026 (P26)", companyCountExpected: 197, companyCountObserved: 197 },
      { slug: "S26", label: "YC Summer 2026 (S26)", companyCountExpected: 83, companyCountObserved: 83 },
      { slug: "A16ZSR006", label: "a16z speedrun 006", companyCountExpected: 59, companyCountObserved: 59 }
    ],
    nodes: batchNodes,
    edges: [],
    leaderboard,
    fastestGaining,
    needsReview: [],
    evidence,
    platformStatus: [],
    selectedTopVoiceAudience: {
      id: "off",
      displayName: "All voices",
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
        displayName: "All voices",
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
      },
      {
        id: "insiders",
        displayName: "Insiders",
        description: "Curated high-signal insiders.",
        helperText: "Showing curated high-signal insiders only.",
        scoreLabel: "Top Voices score",
        scoreDescription: "Curated high-signal insiders.",
        active: true,
        memberCount: 50
      }
    ],
    generatedAt: "2026-06-29T00:00:00.000Z",
    scoringContext: {
      modelId: V4_MODEL_ID,
      modelVersion: V4_MODEL_VERSION,
      modelName: "returner-traction-v4-absolute-fixed-platform-global-best",
      scoreScope: "all_platforms",
      selectedPlatforms: [],
      responseBuiltAt: "2026-06-29T00:00:00.000Z",
      evidenceAsOf: "2026-06-29T00:00:00.000Z"
    },
    mode: "official_snapshot"
  };
}

function withTopVoiceAudience(graph: GraphResponse, audienceId: TopVoiceAudienceId): GraphResponse {
  const audience = graph.topVoiceAudiences.find((item) => item.id === audienceId)!;
  return {
    ...graph,
    selectedTopVoiceAudience: audience,
    nodes: graph.nodes.map((node) => ({ ...node, selectedTopVoiceAudience: audience })),
    evidence: graph.evidence.map((item) => ({
      ...item,
      topVoice: {
        audienceId,
        memberId: `${audienceId}-member`,
        displayName: audience.displayName,
        category: "test",
        weight: 1,
        matchedBy: "dashboard test fixture",
        originalContributionScore: item.contributionScore
      }
    })),
    scoringContext: graph.scoringContext
      ? {
          ...graph.scoringContext,
          responseBuiltAt: graph.generatedAt
        }
      : undefined
  };
}

function unbenchmarkedMomentum(currentScore: number, currentRank: number) {
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

function testScoreBreakdown(node: GraphNode): ScoreBreakdown {
  const platform = node.topPlatform ?? "github";
  const platformScore = node.platformScores[platform] ?? node.score;
  const configuredWeight = TRACTION_SCORING_CONFIG.platformWeights[platform] ?? 0;
  return {
    modelId: V4_MODEL_ID,
    modelVersion: V4_MODEL_VERSION,
    modelName: "returner-traction-v4-absolute-fixed-platform-global-best",
    totalScore: node.score,
    absoluteScore: node.score,
    weightedAvailableScore: platformScore,
    coverageFactor: configuredWeight,
    platformsWithEvidence: 1,
    totalSupportedPlatforms: 9,
    platformScores: { ...node.platformScores },
    weightedPlatforms: [{
      platform,
      score: platformScore,
      configuredWeight,
      appliedWeight: configuredWeight,
      contribution: Math.round(platformScore * configuredWeight * 100) / 100,
      evidenceCount: 1
    }],
    signalFamilyScores: {
      reach: node.score,
      engagement: node.score,
      developerAdoption: 0,
      launchAndCommunity: 0,
      momentum: 0
    },
    confidence: {
      level: "medium",
      value: 0.5,
      reasons: ["Dashboard fixture has one verified evidence row."],
      scoredEvidenceCount: 1,
      datedEvidenceCount: 1,
      verifiedLinkCount: 1
    },
    calibration: {
      method: "global_best_ratio",
      cohortSize: 1,
      percentile: null,
      inputScore: node.score,
      benchmarkScore: 100,
      scaleFactor: 1,
      benchmarkScope: "all_supported_batches",
      benchmarkPopulation: "current_company_snapshot"
    },
    limitations: [],
    evidenceAsOf: "2026-06-29T00:00:00.000Z",
    explanation: "Dashboard v4 contract fixture."
  };
}

function staticGraphFixture(graph: GraphResponse): GraphResponse {
  const nodes = graph.nodes.map((node) => {
    const platform = node.topPlatform ?? "github";
    const platformScore = node.platformScores[platform] ?? node.score;
    const configuredWeight = TRACTION_SCORING_CONFIG.platformWeights[platform] ?? 0;
    const fixedScoreValue = platformScore * configuredWeight;
    const fixedScore = fixedScoreValue > 0 ? Math.max(1, Math.round(fixedScoreValue)) : 0;
    const adjustedNode = {
      ...node,
      score: fixedScore,
      previousScore: fixedScore,
      scoreDelta: 0
    };
    return {
      ...adjustedNode,
      scoreBreakdown: testScoreBreakdown(adjustedNode)
    };
  });
  const nodesByEntityId = new Map(nodes.map((node) => [node.entityId, node]));
  const leaderboard = graph.leaderboard.map((row) => ({
    ...row,
    score: nodesByEntityId.get(row.companyId)?.score ?? row.score
  }));

  return {
    ...graph,
    nodes,
    leaderboard,
    fastestGaining: graph.fastestGaining.map((row) => {
      const leaderboardRow = leaderboard.find((candidate) => candidate.companyId === row.companyId);
      const score = leaderboardRow?.score ?? row.dod.currentScore;
      return {
        ...row,
        dod: unbenchmarkedMomentum(score, row.rank),
        wow: unbenchmarkedMomentum(score, row.rank)
      };
    })
  };
}

function testEvidenceId(node: GraphNode): string {
  return `evidence-${node.entityId}-${node.topPlatform ?? "github"}`;
}

function testEvidenceForNode(node: GraphNode): EvidenceItem {
  const platform = node.topPlatform ?? "github";
  const contributionScore = node.platformScores[platform] ?? node.score;
  return {
    id: testEvidenceId(node),
    entityType: "company",
    entityId: node.entityId,
    platform,
    authorName: node.label,
    authorHandle: node.entityId,
    postedAt: "2026-06-29T00:00:00.000Z",
    publishedAtPrecision: "exact",
    text: `${node.label} traction update`,
    mediaType: platform === "github" ? "repo" : "text",
    metrics: platform === "github" ? { stars: 100 } : { views: 10_000 },
    contributionScore,
    normalizedScore: contributionScore,
    linkStatus: "verified",
    linkCheckedAt: "2026-06-29T00:00:00.000Z",
    sourceUrl:
      platform === "github"
        ? `https://github.com/test/${node.entityId}`
        : `https://x.com/${node.entityId}/status/${Math.abs(hashText(node.entityId)) + 1}`,
    platformPostId: `${Math.abs(hashText(node.entityId)) + 1}`,
    why: "Dashboard test evidence.",
    attachedCompanyId: node.entityId,
    attachedCompanyName: node.label,
    review_state: "verified"
  };
}

function hashText(value: string): number {
  let hash = 0;
  for (const character of value) hash = Math.imul(hash, 31) + character.charCodeAt(0) | 0;
  return hash;
}

function withBenchmarkDates(graph: GraphResponse, dodBenchmarkedAt: string | null, wowBenchmarkedAt: string | null): GraphResponse {
  const generatedAt = new Date().toISOString();
  return {
    ...graph,
    generatedAt,
    scoringContext: graph.scoringContext
      ? { ...graph.scoringContext, responseBuiltAt: generatedAt }
      : undefined,
    fastestGaining: graph.leaderboard.map((row) => ({
      rank: row.rank,
      companyId: row.companyId,
      companyName: row.companyName,
      dod: {
        scoreDelta: 0,
        percentDelta: 0,
        rankDelta: 0,
        currentScore: row.score,
        currentRank: row.rank,
        baselineScore: row.score,
        baselineRank: row.rank,
        benchmarkedAt: dodBenchmarkedAt
      },
      wow: {
        scoreDelta: 0,
        percentDelta: 0,
        rankDelta: 0,
        currentScore: row.score,
        currentRank: row.rank,
        baselineScore: row.score,
        baselineRank: row.rank,
        benchmarkedAt: wowBenchmarkedAt
      }
    }))
  };
}

function localDateIso(dayOffset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function makeNode(
  id: string,
  label: string,
  industry: string,
  color: string,
  groupPartner = "Partner",
  score = 50,
  topPlatform: Platform = "github"
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
    topPlatform,
    platformScores: { [topPlatform]: 50 },
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
