import { describe, expect, it } from "vitest";
import { applyClientGraphFilters } from "@/lib/graph/client-filters";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import {
  buildClusterPositions,
  buildLabelPlacements,
  collisionRadius,
  estimateLabelBoxForNode,
  labelBoxOverlapsCircle
} from "@/lib/graph/layout";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("graph layout", () => {
  it("places the Summer 2026 company circles without visual overlap", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const positions = buildClusterPositions(graph.nodes);

    expect(graph.nodes).toHaveLength(83);
    expect(positions.size).toBe(83);

    for (let leftIndex = 0; leftIndex < graph.nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < graph.nodes.length; rightIndex += 1) {
        const left = graph.nodes[leftIndex];
        const right = graph.nodes[rightIndex];
        const leftPosition = positions.get(left.id);
        const rightPosition = positions.get(right.id);

        expect(leftPosition).toBeDefined();
        expect(rightPosition).toBeDefined();

        const distance = Math.hypot(
          (rightPosition?.x ?? 0) - (leftPosition?.x ?? 0),
          (rightPosition?.y ?? 0) - (leftPosition?.y ?? 0)
        );
        const requiredDistance = collisionRadius(left) + collisionRadius(right) - 0.25;

        expect(distance).toBeGreaterThanOrEqual(requiredDistance);
      }
    }
  }, 20_000);

  it("always labels the selected company even when most labels are decluttered", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "HeyClicky") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, 12);

    expect(labels.has(selected.id)).toBe(true);
    expect(labels.size).toBeGreaterThan(1);
    expect(labels.size).toBeLessThanOrEqual(12);
  });

  it("keeps a16z Instagram labels off neighboring company circles", () => {
    const graph = buildGraphResponse({ batchSlug: "A16ZSR006", platforms: ["instagram"] }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "Clair Health") ?? graph.nodes[0];
    const labels = assertNoLabelCircleOverlap(graph.nodes, selected.id, 52);
    const hammock = graph.nodes.find((node) => node.label === "Hammock");
    const sun = graph.nodes.find((node) => node.label === "SUN");

    expect(hammock).toBeDefined();
    expect(sun).toBeDefined();
    expect(labels.size).toBeGreaterThan(0);
  }, 20_000);

  it("shows most A16Z company names on the graph", () => {
    const graph = buildGraphResponse({ batchSlug: "A16ZSR006" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "Acceler8") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, graph.nodes.length);

    expect(graph.nodes).toHaveLength(59);
    expect(labels.size).toBeGreaterThanOrEqual(44);
    expect(labels.has(selected.id)).toBe(true);
  }, 20_000);

  it("shows substantially more YC Spring company names on the dense graph", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "HeyClicky") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, 128);

    expect(graph.nodes).toHaveLength(197);
    expect(labels.size).toBeGreaterThanOrEqual(90);
    expect(labels.has(selected.id)).toBe(true);
  }, 20_000);

  it("can place every Summer 2026 company name for the rendered map", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "HeyClicky") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, graph.nodes.length, true);

    expect(labels.size).toBe(graph.nodes.length);
    for (const node of graph.nodes) {
      expect(labels.has(node.id), `${node.label} should have a graph label placement`).toBe(true);
    }
  }, 20_000);

  it("keeps same group-partner companies visibly clustered", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const positions = buildClusterPositions(graph.nodes);
    const pairDistances: number[] = [];
    const sameGroupDistances: number[] = [];

    for (let leftIndex = 0; leftIndex < graph.nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < graph.nodes.length; rightIndex += 1) {
        const left = graph.nodes[leftIndex];
        const right = graph.nodes[rightIndex];
        const leftPosition = positions.get(left.id);
        const rightPosition = positions.get(right.id);
        if (!leftPosition || !rightPosition) {
          continue;
        }

        const distance = Math.hypot(rightPosition.x - leftPosition.x, rightPosition.y - leftPosition.y);
        pairDistances.push(distance);

        if (left.visual.groupRegion && left.visual.groupRegion === right.visual.groupRegion) {
          sameGroupDistances.push(distance);
        }
      }
    }

    expect(average(sameGroupDistances)).toBeLessThan(average(pairDistances) * 0.72);
  }, 20_000);

  it("returns to a non-overlapping full layout after a minimum-score filter cycle", () => {
    const graph = buildGraphResponse({ batchSlug: "S26" }, ycSpring2026GraphDataset);
    const filtered = applyClientGraphFilters(graph, {
      platforms: [],
      industries: [],
      groupPartners: [],
      minScore: 80
    });
    const restored = applyClientGraphFilters(graph, {
      platforms: [],
      industries: [],
      groupPartners: [],
      minScore: 0
    });

    expect(filtered.nodes.length).toBeLessThan(restored.nodes.length);
    expect(restored.nodes).toHaveLength(83);

    assertNoCircleOverlap(restored.nodes);
  }, 20_000);
});

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function assertNoCircleOverlap(nodes: ReturnType<typeof buildGraphResponse>["nodes"]): void {
  const positions = buildClusterPositions(nodes);

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const leftPosition = positions.get(left.id);
      const rightPosition = positions.get(right.id);

      expect(leftPosition).toBeDefined();
      expect(rightPosition).toBeDefined();

      const distance = Math.hypot(
        (rightPosition?.x ?? 0) - (leftPosition?.x ?? 0),
        (rightPosition?.y ?? 0) - (leftPosition?.y ?? 0)
      );
      expect(distance).toBeGreaterThanOrEqual(collisionRadius(left) + collisionRadius(right) - 0.25);
    }
  }
}

function assertNoLabelCircleOverlap(
  nodes: ReturnType<typeof buildGraphResponse>["nodes"],
  selectedNodeId: string | null,
  maxLabels: number
) {
  const positions = buildClusterPositions(nodes);
  const labels = buildLabelPlacements(nodes, positions, selectedNodeId, maxLabels);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const circles = nodes
    .map((node) => {
      const position = positions.get(node.id);
      return position
        ? {
            id: node.id,
            label: node.label,
            x: position.x,
            y: position.y,
            radius: node.radius + 4
          }
        : null;
    })
    .filter((circle): circle is { id: string; label: string; x: number; y: number; radius: number } => Boolean(circle));

  for (const [nodeId, placement] of labels) {
    const node = nodeById.get(nodeId);
    const position = positions.get(nodeId);
    expect(node).toBeDefined();
    expect(position).toBeDefined();
    if (!node || !position) {
      continue;
    }
    if (node.id === selectedNodeId) {
      continue;
    }

    const box = estimateLabelBoxForNode(node, position, placement);
    for (const circle of circles) {
      if (circle.id === node.id) {
        continue;
      }
      expect(
        labelBoxOverlapsCircle(box, circle),
        `${node.label} label should not overlap ${circle.label} circle`
      ).toBe(false);
    }
  }

  return labels;
}
