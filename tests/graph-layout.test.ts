import { describe, expect, it } from "vitest";
import { buildGraphResponse } from "@/lib/graph/graph-builder";
import { buildClusterPositions, buildLabelPlacements, collisionRadius } from "@/lib/graph/layout";
import { ycSpring2026GraphDataset } from "@/lib/graph/yc-spring-2026-dataset";

describe("graph layout", () => {
  it("places the Spring 2026 company circles without visual overlap", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const positions = buildClusterPositions(graph.nodes);

    expect(graph.nodes).toHaveLength(197);
    expect(positions.size).toBe(197);

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
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "HeyClicky") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, 12);

    expect(labels.has(selected.id)).toBe(true);
    expect(labels.size).toBeGreaterThan(1);
    expect(labels.size).toBeLessThanOrEqual(12);
  });

  it("keeps same group-partner companies visibly clustered", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
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
});

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}
