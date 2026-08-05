import { describe, expect, it } from "vitest";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("Summer 2026 targeted traction checks", () => {
  it("rolls Conifer's official YC-linked GitHub traction into its company feed and score", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const conifer = graph.nodes.find((node) => node.label === "Conifer");

    expect(conifer).toBeDefined();
    const evidence = selectedNodeEvidence(graph, conifer!);
    const githubEvidence = evidence.filter((item) => item.platform === "github");

    expect(conifer?.ycProfileUrl).toBe("https://www.ycombinator.com/companies/conifer");
    expect(conifer?.founders.some((founder) => founder.name === "Michael Jeffords")).toBe(true);
    expect(githubEvidence.some((item) => item.sourceUrl.startsWith("https://github.com/ConiferKit/"))).toBe(true);
    expect(githubEvidence.some((item) => item.contributionScore > 0)).toBe(true);
    expect(conifer?.score).toBeGreaterThan(0);
  });

  it("does not carry old Spring 2026 targeted HeyClicky evidence into the Summer graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);

    expect(graph.nodes.some((node) => node.label === "HeyClicky")).toBe(false);
    const leakedHeyClickyEvidence = graph.evidence.filter((item) => {
      const entityId = item.entityId.toLowerCase();
      return entityId === "company-heyclicky" ||
        entityId.startsWith("founder-heyclicky-") ||
        item.attachedCompanyId === "company-heyclicky" ||
        item.attachedCompanyName?.toLowerCase() === "heyclicky";
    });
    expect(leakedHeyClickyEvidence).toEqual([]);
  });
});
