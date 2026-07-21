import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode } from "@/lib/graph/types";

interface RenderedElement {
  data: { id: string; source?: string; target?: string; [key: string]: unknown };
  classes?: string;
}

class FakeNode {
  private coordinates = { x: 0, y: 0 };

  constructor(readonly element: RenderedElement) {}

  id() {
    return this.element.data.id;
  }

  hasClass(className: string) {
    return (this.element.classes ?? "").split(/\s+/).includes(className);
  }

  unlock() {
    return this;
  }

  lock() {
    return this;
  }

  unselect() {
    return this;
  }

  position(next?: { x: number; y: number } | "x" | "y") {
    if (typeof next === "string") return this.coordinates[next];
    if (next) this.coordinates = next;
    return this.coordinates;
  }
}

class FakeCollection {
  constructor(readonly items: FakeNode[]) {}

  get length() {
    return this.items.length;
  }

  forEach(callback: (node: FakeNode) => void) {
    this.items.forEach(callback);
  }

  toArray() {
    return [...this.items];
  }

  lock() {
    this.items.forEach((node) => node.lock());
    return this;
  }

  unselect() {
    this.items.forEach((node) => node.unselect());
    return this;
  }
}

class FakeCore {
  elements: RenderedElement[] = [];
  nodesById = new Map<string, FakeNode>();
  animateCalls: Array<{ ids: string[]; padding: number; duration: number }> = [];
  fitCalls: Array<{ ids: string[]; padding: number }> = [];
  resizeCalls = 0;
  private maximumZoom = 4;
  private minimumZoom = 0.1;

  setElements(elements: RenderedElement[]) {
    this.elements = elements;
    this.nodesById = new Map(
      elements
        .filter((element) => !element.data.source && !element.data.target)
        .map((element) => [element.data.id, new FakeNode(element)])
    );
  }

  destroyed() {
    return false;
  }

  nodes(selector?: string) {
    const nodes = [...this.nodesById.values()];
    if (!selector) return new FakeCollection(nodes);
    const className = selector.replace(/^\./, "");
    return new FakeCollection(nodes.filter((node) => node.hasClass(className)));
  }

  batch(callback: () => void) {
    callback();
  }

  stop() {
    return this;
  }

  autoungrabify() {
    return this;
  }

  fit(collection?: FakeCollection, padding = 0) {
    this.fitCalls.push({ ids: collection?.toArray().map((node) => node.id()) ?? [], padding });
    return this;
  }

  animate(
    properties: { fit?: { eles: FakeCollection; padding: number } },
    options: { duration: number }
  ) {
    if (properties.fit) {
      this.animateCalls.push({
        ids: properties.fit.eles.toArray().map((node) => node.id()),
        padding: properties.fit.padding,
        duration: options.duration
      });
    }
    return this;
  }

  resize() {
    this.resizeCalls += 1;
    return this;
  }

  maxZoom(value?: number) {
    if (typeof value === "number") this.maximumZoom = value;
    return this.maximumZoom;
  }

  minZoom(value?: number) {
    if (typeof value === "number") this.minimumZoom = value;
    return this.minimumZoom;
  }

  removeListener() {
    return this;
  }

  on() {
    return this;
  }
}

const harness = vi.hoisted(() => ({
  core: null as FakeCore | null
}));

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: () => function FakeCytoscapeComponent(props: {
      elements: RenderedElement[];
      cy: (core: FakeCore) => void;
    }) {
      const { elements, cy } = props;
      React.useLayoutEffect(() => {
        harness.core?.setElements(elements);
        if (harness.core) cy(harness.core);
      }, [cy, elements]);
      return <div data-testid="fake-cytoscape" />;
    }
  };
});

import { CytoscapeGraph } from "@/components/CytoscapeGraph";

describe("CytoscapeGraph filter focus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.core = new FakeCore();
    window.sessionStorage.setItem("yc-network-map-intro-played-v1", "1");
  });

  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
    document.body.classList.remove("graph-fullscreen-open");
    harness.core = null;
  });

  it("keeps the full baseline dimmed around a stable focused fit across graph growth and fullscreen", async () => {
    const focus = {
      active: true,
      companyNodeIds: ["company:focused"],
      signature: "platforms:x;companies:company:focused"
    };
    const baselineNodes = [
      makeNode("company:focused", "Focused"),
      makeNode("company:dimmed", "Dimmed")
    ];
    const view = render(
      <CytoscapeGraph
        nodes={baselineNodes}
        edges={[]}
        batch={batch}
        selectedNodeId={null}
        focusRevision={0}
        focus={focus}
        onSelectNode={vi.fn()}
      />
    );

    expect(classesFor("company:focused")).toContain("partner-focused");
    expect(classesFor("company:focused")).not.toContain("partner-dimmed");
    expect(classesFor("company:dimmed")).toContain("partner-dimmed");
    expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fullscreen/i })).toBeInTheDocument();
    expect(screen.queryByText(/map connections/i)).not.toBeInTheDocument();

    await advanceFocusTimers();
    expect(lastFocusedAnimation()).toEqual({ ids: ["company:focused"], padding: 96, duration: 520 });

    const animationsBeforeGrowth = harness.core!.animateCalls.length;
    view.rerender(
      <CytoscapeGraph
        nodes={[...baselineNodes, makeNode("company:extra", "Extra baseline node")]}
        edges={[]}
        batch={batch}
        selectedNodeId={null}
        focusRevision={0}
        focus={focus}
        onSelectNode={vi.fn()}
      />
    );
    expect(classesFor("company:extra")).toContain("partner-dimmed");

    await advanceFocusTimers();
    expect(harness.core!.animateCalls.length).toBeGreaterThan(animationsBeforeGrowth);
    expect(lastFocusedAnimation()).toEqual({ ids: ["company:focused"], padding: 96, duration: 520 });

    const animationsBeforeFullscreen = harness.core!.animateCalls.length;
    fireEvent.click(screen.getByRole("button", { name: /fullscreen/i }));
    await advanceFocusTimers();

    expect(harness.core!.animateCalls.length).toBeGreaterThan(animationsBeforeFullscreen);
    expect(lastFocusedAnimation()).toEqual({ ids: ["company:focused"], padding: 96, duration: 520 });
    expect(classesFor("company:focused")).toContain("partner-focused");
    expect(classesFor("company:extra")).toContain("partner-dimmed");
    expect(screen.getByRole("button", { name: /exit/i })).toBeInTheDocument();
  });
});

const batch = {
  slug: "S2026",
  label: "YC Spring 2026 (P26)",
  companyCountExpected: 3,
  companyCountObserved: 3
};

function makeNode(id: string, label: string): GraphNode {
  const entityId = id.replace(/^company:/, "");
  return {
    id,
    entityType: "company",
    entityId,
    label,
    batchSlug: "S2026",
    score: 50,
    previousScore: 50,
    scoreDelta: 0,
    radius: 20,
    topPlatform: "x",
    platformScores: { x: 50 },
    socialAccounts: [],
    evidenceIds: [],
    ycProfileUrl: "",
    websiteUrl: null,
    tagline: null,
    description: null,
    groupPartner: "Partner A",
    primaryIndustry: "b2b",
    businessModel: "b2b",
    review_state: "verified",
    sourceUrl: "",
    visual: {
      industryColor: "#7dd3fc",
      shape: "ellipse",
      borderStyle: "solid",
      borderColor: "#2563eb",
      groupRegion: "Partner A"
    },
    industries: ["b2b"],
    relatedEntityIds: [],
    founders: [],
    review_state_counts: { verified: 0, needs_review: 0, rejected: 0 }
  };
}

function classesFor(nodeId: string) {
  return harness.core!.elements.find((element) => element.data.id === nodeId)?.classes?.split(/\s+/) ?? [];
}

async function advanceFocusTimers() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

function lastFocusedAnimation() {
  return harness.core!.animateCalls.at(-1);
}
