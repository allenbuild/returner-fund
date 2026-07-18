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
    const positions = buildClusterPositions(graph.nodes);
    const labels = assertNoLabelCircleOverlap(graph.nodes, selected.id, 52);
    const hammock = graph.nodes.find((node) => node.label === "Hammock");
    const sun = graph.nodes.find((node) => node.label === "SUN");

    expect(hammock).toBeDefined();
    expect(sun).toBeDefined();
    expect(labels.get(selected.id)?.halign).not.toBe("left");
    expect(labels.size).toBeGreaterThan(0);

    const selectedPlacement = labels.get(selected.id);
    const hammockPlacement = hammock ? labels.get(hammock.id) : undefined;
    const selectedPosition = positions.get(selected.id);
    const hammockPosition = hammock ? positions.get(hammock.id) : undefined;
    expect(selectedPlacement).toBeDefined();
    expect(hammockPlacement).toBeDefined();
    expect(selectedPosition).toBeDefined();
    expect(hammockPosition).toBeDefined();
    if (hammock && selectedPlacement && hammockPlacement && selectedPosition && hammockPosition) {
      expect(
        boxesOverlap(
          estimateLabelBoxForNode(selected, selectedPosition, selectedPlacement),
          estimateLabelBoxForNode(hammock, hammockPosition, hammockPlacement)
        )
      ).toBe(false);
    }
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

  it("keeps larger A16Z labels visually attached inside their circles", () => {
    const graph = buildGraphResponse({ batchSlug: "A16ZSR006" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "Clair Health") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, graph.nodes.length, true);

    for (const companyName of ["Acceler8", "Antihero Studios"]) {
      const node = graph.nodes.find((item) => item.label === companyName);
      const placement = node ? labels.get(node.id) : undefined;

      expect(node).toBeDefined();
      expect(placement, `${companyName} should have a graph label placement`).toBeDefined();
      expect(placement?.halign, `${companyName} label should stay horizontally attached`).toBe("center");
      expect(
        ["center", "top", "bottom"],
        `${companyName} label should stay vertically attached`
      ).toContain(placement?.valign);
    }
  }, 20_000);

  it("keeps forced a16z company labels from hiding under neighboring circles", () => {
    const graph = buildGraphResponse({ batchSlug: "A16ZSR006" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "Clair Health") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, graph.nodes.length, true);
    const crebit = graph.nodes.find((node) => node.label === "Crebit");
    const hotbox = graph.nodes.find((node) => node.label === "Hotbox");
    const crebitPlacement = crebit ? labels.get(crebit.id) : undefined;
    const crebitPosition = crebit ? positions.get(crebit.id) : undefined;
    const hotboxPosition = hotbox ? positions.get(hotbox.id) : undefined;

    expect(crebit).toBeDefined();
    expect(hotbox).toBeDefined();
    expect(crebitPlacement).toBeDefined();
    expect(crebitPosition).toBeDefined();
    expect(hotboxPosition).toBeDefined();
    if (crebit && hotbox && crebitPlacement && crebitPosition && hotboxPosition) {
      expect(
        labelBoxOverlapsCircle(estimateLabelBoxForNode(crebit, crebitPosition, crebitPlacement), {
          id: hotbox.id,
          x: hotboxPosition.x,
          y: hotboxPosition.y,
          radius: hotbox.radius + 4
        })
      ).toBe(false);
    }
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

  it("keeps dense Spring labels separated around high-traffic clusters", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const selected = graph.nodes.find((node) => node.label === "HeyClicky") ?? graph.nodes[0];
    const positions = buildClusterPositions(graph.nodes);
    const labels = buildLabelPlacements(graph.nodes, positions, selected.id, graph.nodes.length, true);

    assertLabelBoxesDoNotOverlap(graph.nodes, positions, labels, "BioStack Platforms", "Foaster");
    assertLabelBoxesDoNotOverlap(graph.nodes, positions, labels, "Totalis", "Arlo Industries");
    assertLabelBoxesDoNotOverlap(graph.nodes, positions, labels, "InsForge", "Voquill");
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

  it("gives Spring group-partner clusters distinct centers", () => {
    const graph = buildGraphResponse({ batchSlug: "S2026" }, ycSpring2026GraphDataset);
    const positions = buildClusterPositions(graph.nodes);
    const centers = clusterCenters(graph.nodes, positions);

    expect(centers.size).toBeGreaterThan(6);
    const entries = [...centers.entries()];
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const [leftName, left] = entries[leftIndex];
        const [rightName, right] = entries[rightIndex];

        expect(
          Math.hypot(right.x - left.x, right.y - left.y),
          `${leftName} and ${rightName} should not share a cluster center`
        ).toBeGreaterThanOrEqual(150);
      }
    }
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

function clusterCenters(
  nodes: ReturnType<typeof buildGraphResponse>["nodes"],
  positions: ReturnType<typeof buildClusterPositions>
): Map<string, { x: number; y: number }> {
  const sums = new Map<string, { x: number; y: number; count: number }>();

  for (const node of nodes) {
    const groupPartner = node.visual.groupRegion;
    const position = positions.get(node.id);
    if (!groupPartner || !position) continue;
    const current = sums.get(groupPartner) ?? { x: 0, y: 0, count: 0 };
    current.x += position.x;
    current.y += position.y;
    current.count += 1;
    sums.set(groupPartner, current);
  }

  return new Map(
    [...sums.entries()].map(([name, sum]) => [name, { x: sum.x / sum.count, y: sum.y / sum.count }])
  );
}

function boxesOverlap(
  left: { left: number; right: number; top: number; bottom: number },
  right: { left: number; right: number; top: number; bottom: number }
): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function assertLabelBoxesDoNotOverlap(
  nodes: ReturnType<typeof buildGraphResponse>["nodes"],
  positions: ReturnType<typeof buildClusterPositions>,
  labels: ReturnType<typeof buildLabelPlacements>,
  leftLabel: string,
  rightLabel: string
): void {
  const leftNode = nodes.find((node) => node.label === leftLabel);
  const rightNode = nodes.find((node) => node.label === rightLabel);
  const leftPosition = leftNode ? positions.get(leftNode.id) : undefined;
  const rightPosition = rightNode ? positions.get(rightNode.id) : undefined;
  const leftPlacement = leftNode ? labels.get(leftNode.id) : undefined;
  const rightPlacement = rightNode ? labels.get(rightNode.id) : undefined;

  expect(leftNode).toBeDefined();
  expect(rightNode).toBeDefined();
  expect(leftPosition).toBeDefined();
  expect(rightPosition).toBeDefined();
  expect(leftPlacement).toBeDefined();
  expect(rightPlacement).toBeDefined();
  if (!leftNode || !rightNode || !leftPosition || !rightPosition || !leftPlacement || !rightPlacement) {
    return;
  }

  expect(
    boxesOverlap(
      estimateLabelBoxForNode(leftNode, leftPosition, leftPlacement),
      estimateLabelBoxForNode(rightNode, rightPosition, rightPlacement)
    ),
    `${leftLabel} label should not overlap ${rightLabel} label`
  ).toBe(false);
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
