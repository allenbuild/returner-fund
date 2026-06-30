import type { GraphNode } from "./types";

export interface GraphLayoutPosition {
  x: number;
  y: number;
}

export interface LabelPlacement {
  halign: "left" | "right" | "center";
  valign: "top" | "bottom" | "center";
  marginX: number;
  marginY: number;
}

interface LayoutCircle {
  id: string;
  x: number;
  y: number;
  radius: number;
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface LabelOption {
  placement: LabelPlacement;
  box: LabelBox;
}

export function buildClusterPositions(nodes: GraphNode[]): Map<string, GraphLayoutPosition> {
  const positions = new Map<string, GraphLayoutPosition>();
  const companies = nodes.filter((node) => node.entityType === "company");
  const clusters = new Map<string, GraphNode[]>();

  for (const company of companies) {
    const key = company.visual.groupRegion ?? company.primaryIndustry ?? "Unassigned";
    clusters.set(key, [...(clusters.get(key) ?? []), company]);
  }

  const entries = [...clusters.entries()].sort(([, leftNodes], [, rightNodes]) => rightNodes.length - leftNodes.length);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const clusterStep = Math.max(205, Math.min(300, 840 / Math.sqrt(Math.max(entries.length, 1))));

  entries.forEach(([, clusterNodes], clusterIndex) => {
    const clusterAngle = clusterIndex * goldenAngle - Math.PI / 2;
    const clusterRadius = clusterIndex === 0 ? 0 : Math.sqrt(clusterIndex) * clusterStep;
    const center = {
      x: Math.cos(clusterAngle) * clusterRadius * 1.16,
      y: Math.sin(clusterAngle) * clusterRadius * 0.88
    };
    const sortedNodes = [...clusterNodes].sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
    const maxNodeRadius = Math.max(...sortedNodes.map((node) => node.radius), 20);
    const localStep = Math.max(52, Math.min(84, maxNodeRadius * 1.05));

    sortedNodes.forEach((company, nodeIndex) => {
      const localAngle = nodeIndex * goldenAngle + seededJitter(company.id, 0.45);
      const localRadius = nodeIndex === 0 ? 0 : Math.sqrt(nodeIndex) * localStep + maxNodeRadius * 0.38;
      positions.set(company.id, {
        x: center.x + Math.cos(localAngle) * localRadius + seededJitter(`${company.id}:x`, 10),
        y: center.y + Math.sin(localAngle) * localRadius * 0.78 + seededJitter(`${company.id}:y`, 8)
      });
    });
  });

  resolveCircleCollisions(nodes, positions);
  pullClustersTogether(nodes, positions);
  resolveCircleCollisions(nodes, positions, 150);
  return positions;
}

export function buildLabelPlacements(
  nodes: GraphNode[],
  positions: Map<string, GraphLayoutPosition>,
  selectedNodeId: string | null,
  maxLabels = 52
): Map<string, LabelPlacement> {
  const placements = new Map<string, LabelPlacement>();
  const placedBoxes: LabelBox[] = [];
  const circles = nodes
    .map((node) => {
      const position = positions.get(node.id);
      return position ? { id: node.id, x: position.x, y: position.y, radius: collisionRadius(node) + 4 } : null;
    })
    .filter((circle): circle is LayoutCircle => Boolean(circle));
  const scoreCutoff = Math.max(30, percentile(nodes.map((node) => node.score), 0.68));
  const candidates = [...nodes]
    .filter((node) => node.score >= scoreCutoff)
    .sort((left, right) => {
      if (left.id === selectedNodeId) return -1;
      if (right.id === selectedNodeId) return 1;
      return right.score - left.score || right.radius - left.radius || left.label.localeCompare(right.label);
    });

  if (selectedNodeId) {
    const selectedNode = nodes.find((node) => node.id === selectedNodeId);
    if (selectedNode) {
      addLabelIfPossible(selectedNode, positions, placements, placedBoxes, circles, true);
    }
  }

  for (const node of candidates) {
    if (placements.size >= maxLabels) break;
    addLabelIfPossible(node, positions, placements, placedBoxes, circles, false);
  }

  return placements;
}

export function labelSizeForNode(node: GraphNode): number {
  return Math.max(11, Math.min(21, node.radius * 0.34));
}

export function collisionRadius(node: GraphNode): number {
  return Math.max(node.radius + 18, node.radius * 1.18 + 10);
}

function resolveCircleCollisions(
  nodes: GraphNode[],
  positions: Map<string, GraphLayoutPosition>,
  iterations = 220
): void {
  const circles = nodes
    .map((node) => {
      const position = positions.get(node.id);
      if (!position) return null;
      return {
        id: node.id,
        x: position.x,
        y: position.y,
        radius: collisionRadius(node)
      };
    })
    .filter((node): node is LayoutCircle => Boolean(node));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < circles.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < circles.length; rightIndex += 1) {
        const left = circles[leftIndex];
        const right = circles[rightIndex];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const minDistance = left.radius + right.radius;
        if (distance >= minDistance) continue;

        const push = (minDistance - distance) * 0.5;
        const nx = dx / distance;
        const ny = dy / distance;
        left.x -= nx * push;
        left.y -= ny * push;
        right.x += nx * push;
        right.y += ny * push;
        moved = true;
      }
    }

    if (!moved) break;
  }

  for (const circle of circles) {
    positions.set(circle.id, { x: circle.x, y: circle.y });
  }
}

function pullClustersTogether(nodes: GraphNode[], positions: Map<string, GraphLayoutPosition>): void {
  const clusterCenters = new Map<string, { x: number; y: number; count: number }>();

  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const key = node.visual.groupRegion ?? node.primaryIndustry ?? "Unassigned";
    const center = clusterCenters.get(key) ?? { x: 0, y: 0, count: 0 };
    center.x += position.x;
    center.y += position.y;
    center.count += 1;
    clusterCenters.set(key, center);
  }

  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const key = node.visual.groupRegion ?? node.primaryIndustry ?? "Unassigned";
    const center = clusterCenters.get(key);
    if (!center || center.count <= 1) continue;
    const cx = center.x / center.count;
    const cy = center.y / center.count;
    positions.set(node.id, {
      x: position.x + (cx - position.x) * 0.05,
      y: position.y + (cy - position.y) * 0.05
    });
  }
}

function addLabelIfPossible(
  node: GraphNode,
  positions: Map<string, GraphLayoutPosition>,
  placements: Map<string, LabelPlacement>,
  placedBoxes: LabelBox[],
  circles: LayoutCircle[],
  force: boolean
): void {
  if (placements.has(node.id)) return;
  const position = positions.get(node.id);
  if (!position) return;

  const fontSize = labelSizeForNode(node);
  const labelWidth = Math.min(118, Math.max(44, node.label.length * fontSize * 0.48));
  const lineCount = Math.max(1, Math.ceil(labelWidth >= 82 ? node.label.length / 15 : node.label.length / 10));
  const labelHeight = fontSize * (lineCount * 1.16 + 0.3);
  const gap = collisionRadius(node) + 8;
  const options: LabelOption[] = [
    {
      placement: { halign: "left", valign: "center", marginX: 8, marginY: 0 },
      box: {
        left: position.x + gap,
        right: position.x + gap + labelWidth,
        top: position.y - labelHeight / 2,
        bottom: position.y + labelHeight / 2
      }
    },
    {
      placement: { halign: "right", valign: "center", marginX: -8, marginY: 0 },
      box: {
        left: position.x - gap - labelWidth,
        right: position.x - gap,
        top: position.y - labelHeight / 2,
        bottom: position.y + labelHeight / 2
      }
    },
    {
      placement: { halign: "center", valign: "top", marginX: 0, marginY: 8 },
      box: {
        left: position.x - labelWidth / 2,
        right: position.x + labelWidth / 2,
        top: position.y + gap,
        bottom: position.y + gap + labelHeight
      }
    },
    {
      placement: { halign: "center", valign: "bottom", marginX: 0, marginY: -8 },
      box: {
        left: position.x - labelWidth / 2,
        right: position.x + labelWidth / 2,
        top: position.y - gap - labelHeight,
        bottom: position.y - gap
      }
    }
  ];

  const match =
    options.find((option) => labelBoxFits(option.box, placedBoxes, circles, node.id)) ??
    (force ? bestFallbackLabelOption(options, placedBoxes, circles, node.id) : null);
  if (!match) {
    return;
  }

  placements.set(node.id, match.placement);
  placedBoxes.push(expandBox(match.box, 9));
}

function bestFallbackLabelOption(
  options: LabelOption[],
  placedBoxes: LabelBox[],
  circles: LayoutCircle[],
  ownerId: string
): LabelOption {
  const [bestOption] = [...options].sort(
    (left, right) =>
      labelCollisionPenalty(left.box, placedBoxes, circles, ownerId) -
      labelCollisionPenalty(right.box, placedBoxes, circles, ownerId)
  );
  return bestOption ?? options[0]!;
}

function labelCollisionPenalty(
  box: LabelBox,
  placedBoxes: LabelBox[],
  circles: LayoutCircle[],
  ownerId: string
): number {
  const expandedBox = expandBox(box, 6);
  const labelPenalty = placedBoxes.reduce((sum, placedBox) => sum + boxOverlapArea(expandedBox, placedBox), 0);
  const circlePenalty = circles.reduce((sum, circle) => {
    if (circle.id === ownerId) {
      return sum;
    }
    return sum + circleBoxOverlapPenalty(expandedBox, circle);
  }, 0);

  return labelPenalty + circlePenalty * 1.5;
}

function labelBoxFits(box: LabelBox, placedBoxes: LabelBox[], circles: LayoutCircle[], ownerId: string): boolean {
  if (placedBoxes.some((placedBox) => boxesOverlap(expandBox(box, 9), placedBox))) {
    return false;
  }

  return !circles.some((circle) => circle.id !== ownerId && boxOverlapsCircle(expandBox(box, 6), circle));
}

function expandBox(box: LabelBox, amount: number): LabelBox {
  return {
    left: box.left - amount,
    right: box.right + amount,
    top: box.top - amount,
    bottom: box.bottom + amount
  };
}

function boxesOverlap(left: LabelBox, right: LabelBox): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function boxOverlapArea(left: LabelBox, right: LabelBox): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function boxOverlapsCircle(box: LabelBox, circle: LayoutCircle): boolean {
  const closestX = Math.max(box.left, Math.min(circle.x, box.right));
  const closestY = Math.max(box.top, Math.min(circle.y, box.bottom));
  return Math.hypot(circle.x - closestX, circle.y - closestY) < circle.radius;
}

function circleBoxOverlapPenalty(box: LabelBox, circle: LayoutCircle): number {
  const closestX = Math.max(box.left, Math.min(circle.x, box.right));
  const closestY = Math.max(box.top, Math.min(circle.y, box.bottom));
  const overlap = circle.radius - Math.hypot(circle.x - closestX, circle.y - closestY);
  return overlap > 0 ? overlap * overlap : 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
}

function seededJitter(value: string, range: number): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 33 + char.charCodeAt(0)) % 1009;
  }
  return (hash / 1009 - 0.5) * range;
}
