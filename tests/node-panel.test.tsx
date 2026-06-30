import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NodePanel } from "@/components/NodePanel";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("NodePanel", () => {
  it("keeps the score in the header and omits the verbose score explanation card", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026", query: "HeyClicky" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "HeyClicky");

    expect(node).toBeDefined();
    render(<NodePanel node={node!} relatedNodes={[]} evidence={selectedNodeEvidence(graph, node!)} />);

    expect(screen.getByLabelText(`Score ${node!.score}`)).toBeInTheDocument();
    expect(document.querySelector(".node-panel-header p")).not.toBeInTheDocument();
    expect(document.querySelector(".founder-chip-list")).toHaveTextContent("Farza Majeed");
    expect(screen.queryByText(/platforms with scored evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/company evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/founder evidence/i)).not.toBeInTheDocument();
  });
});
