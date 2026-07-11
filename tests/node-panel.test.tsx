import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NodePanel } from "@/components/NodePanel";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("NodePanel", () => {
  it("keeps the score in the header and omits the verbose score explanation card", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    render(<NodePanel node={node!} relatedNodes={[]} evidence={selectedNodeEvidence(graph, node!)} />);

    expect(screen.getByLabelText(`Score ${node!.score}`)).toBeInTheDocument();
    expect(document.querySelector(".node-panel-header p")).not.toBeInTheDocument();
    expect(document.querySelector(".founder-chip-list")).toHaveTextContent("Michael Jeffords");
    expect(screen.queryByText(/platforms with scored evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/company evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/founder evidence/i)).not.toBeInTheDocument();
  });

  it("uses the regular traction panel when Top Voices metadata is present", () => {
    const graph = buildGraphResponse({ batchSlug: "S26", query: "Conifer" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Conifer");

    expect(node).toBeDefined();
    render(
      <NodePanel
        node={{
          ...node!,
          selectedTopVoiceAudience: {
            id: "yc_partners",
            displayName: "YC Partners",
            description: "Current YC partners and YC leadership.",
            helperText: "Showing attention from current YC partners only.",
            scoreLabel: "Top Voices score",
            scoreDescription: "Current YC partners and YC leadership.",
            active: true,
            memberCount: 18
          },
          topVoiceScore: 44,
          topVoiceConnectionCount: 1,
          topVoiceConnections: [
            {
              memberId: "grey-baker",
              displayName: "Grey Baker",
              category: "YC partner",
              weight: 2,
              contributionScore: 44,
              evidenceCount: 1,
              topEvidenceId: null,
              platforms: ["x"]
            }
          ]
        }}
        relatedNodes={[]}
        evidence={selectedNodeEvidence(graph, node!)}
      />
    );

    expect(screen.getByLabelText(`Score ${node!.score}`)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top Posts" })).toBeInTheDocument();
    expect(document.querySelector(".top-voices-panel-summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/Top Voices score/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Grey Baker/i)).not.toBeInTheDocument();
  });

  it("renders A16Z founder social accounts as native platform links", () => {
    const graph = buildGraphResponse({ batchSlug: "A16ZSR006", query: "Thirdbrain Labs" }, ycSpring2026GraphDataset);
    const node = graph.nodes.find((item) => item.label === "Thirdbrain Labs");

    expect(node).toBeDefined();
    render(<NodePanel node={node!} relatedNodes={[]} evidence={selectedNodeEvidence(graph, node!)} />);

    const founderAccountHrefs = [...document.querySelectorAll<HTMLAnchorElement>(".founder-account-chip-list a")]
      .map((link) => link.href);

    expect(screen.getByText("Founder accounts")).toBeInTheDocument();
    expect(founderAccountHrefs).toEqual(
      expect.arrayContaining([
        "https://www.linkedin.com/in/margaretczhang",
        "https://x.com/_margaretzhang",
        "https://www.linkedin.com/in/ds-huang",
        "https://x.com/latentius"
      ])
    );
    expect(founderAccountHrefs.some((href) => href.includes("speedrun.a16z.com"))).toBe(false);
  });
});
