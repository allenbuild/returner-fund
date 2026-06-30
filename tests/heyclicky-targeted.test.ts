import { describe, expect, it } from "vitest";
import { selectedNodeEvidence } from "@/lib/graph/evidence-selection";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("HeyClicky targeted traction checks", () => {
  it("rolls targeted Instagram post evidence into HeyClicky's company feed and score", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const heyClicky = graph.nodes.find((node) => node.label === "HeyClicky");

    expect(heyClicky).toBeDefined();
    const evidence = selectedNodeEvidence(graph, heyClicky!);
    const instagramEvidence = evidence.filter((item) => item.platform === "instagram");

    expect(instagramEvidence.some((item) => item.sourceUrl === "https://www.instagram.com/reel/DXxrDscJsL2/")).toBe(true);
    expect(instagramEvidence.some((item) => item.contributionScore > 0)).toBe(true);
    expect(heyClicky?.score).toBeGreaterThan(0);
  });

  it("captures HeyClicky's company X timeline metrics from the read-only browser extractor", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);

    const heyClicky = graph.nodes.find((node) => node.label === "HeyClicky");
    const evidence = selectedNodeEvidence(graph, heyClicky!);
    const xEvidence = evidence.filter((item) => item.platform === "x");

    expect(xEvidence.some((item) => item.sourceUrl === "https://x.com/heyclicky/status/2070992648870178935")).toBe(true);
    expect(xEvidence.some((item) => item.metrics.views && item.metrics.views > 30_000)).toBe(true);
  });

  it("rolls Farza's founder X and Instagram traction into HeyClicky", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const heyClicky = graph.nodes.find((node) => node.label === "HeyClicky");

    expect(heyClicky).toBeDefined();
    expect(heyClicky?.founders.some((founder) => founder.name === "Farza Majeed")).toBe(true);
    expect(heyClicky?.score).toBeGreaterThanOrEqual(70);
    expect(heyClicky?.platformScores.x).toBeGreaterThanOrEqual(75);

    const evidence = selectedNodeEvidence(graph, heyClicky!);
    const farzaViralX = evidence.find((item) => item.sourceUrl === "https://x.com/FarzaTV/status/2060865350036750847");
    const farzaViralInstagram = evidence.find((item) => item.sourceUrl === "https://www.instagram.com/reel/DXk3VriDylM/");

    expect(farzaViralX?.entityType).toBe("founder");
    expect(farzaViralX?.metrics.views).toBeGreaterThan(3_000_000);
    expect(farzaViralX?.contributionScore).toBe(100);
    expect(farzaViralInstagram?.entityType).toBe("founder");
    expect(farzaViralInstagram?.metrics.likes).toBeGreaterThan(100_000);
  });
});
