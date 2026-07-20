import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GraphEdgeLegend } from "@/components/GraphEdgeLegend";
import type { EdgeType, GraphEdge } from "@/lib/graph/types";

describe("graph edge legend", () => {
  it("renders every present edge type, omits absent types, and exposes edge explanations", () => {
    render(<GraphEdgeLegend edges={[
      edge("industry_similarity", "Shared tags produced a 42% similarity score."),
      edge("same_group_partner", "Both public records list YC group partner Example Partner.")
    ]} />);

    expect(screen.getByText("Industry similarity")).toBeInTheDocument();
    expect(screen.getByText("Same group partner")).toBeInTheDocument();
    expect(screen.queryByText("Top Voice attention")).not.toBeInTheDocument();
    expect(screen.queryByText("Founder of")).not.toBeInTheDocument();
    expect(screen.getByText("Shared tags produced a 42% similarity score.")).toBeInTheDocument();
    expect(screen.getByText(/does not mean one company interacted/i)).toBeInTheDocument();
    expect(screen.getByText(/never score points/i)).toBeInTheDocument();
  });

  it("returns no legend when the response contains no edges", () => {
    const { container } = render(<GraphEdgeLegend edges={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

function edge(edgeType: EdgeType, explanation: string): GraphEdge {
  return {
    id: `edge-${edgeType}`,
    source: "company:a",
    target: "company:b",
    edgeType,
    weight: 0.5,
    label: edgeType,
    explanation
  };
}
