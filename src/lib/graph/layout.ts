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

export interface LayoutCircle {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface LabelOption {
  placement: LabelPlacement;
  box: LabelBox;
  priority: number;
}

export const LABEL_TEXT_MAX_WIDTH = 104;
const LABEL_MARGIN = 7;
const MIN_CENTER_LABEL_WIDTH = 46;
const LABEL_BOX_PADDING_X = 18;
const LABEL_BOX_PADDING_Y = 14;
const LABEL_WIDTH_FACTOR = 0.82;
const LABEL_LINE_HEIGHT = 1.22;
const LABEL_CIRCLE_CLEARANCE = 4;
const FALLBACK_CIRCLE_COLLISION_WEIGHT = 18;
const FALLBACK_LABEL_COLLISION_WEIGHT = 2.4;

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

  placeNonCompanyNodes(nodes, positions);
  resolveCircleCollisions(nodes, positions);
  pullClustersTogether(nodes, positions);
  resolveCircleCollisions(nodes, positions, 150);
  return positions;
}

export function buildLabelPlacements(
  nodes: GraphNode[],
  positions: Map<string, GraphLayoutPosition>,
  selectedNodeId: string | null,
  maxLabels = 52,
  allowFallbackCompanyLabels = false
): Map<string, LabelPlacement> {
  const placements = new Map<string, LabelPlacement>();
  const placedBoxes: LabelBox[] = [];
  const circles = nodes
    .map((node) => {
      const position = positions.get(node.id);
      return position ? { id: node.id, x: position.x, y: position.y, radius: node.radius + LABEL_CIRCLE_CLEARANCE } : null;
    })
    .filter((circle): circle is LayoutCircle => Boolean(circle));
  const scoreCutoff = Math.max(30, percentile(nodes.map((node) => node.score), 0.68));
  const candidates = [...nodes]
    .sort((left, right) => {
      if (left.id === selectedNodeId) return -1;
      if (right.id === selectedNodeId) return 1;
      if (left.entityType !== right.entityType) {
        return left.entityType === "company" ? -1 : 1;
      }
      return right.score - left.score || right.radius - left.radius || left.label.localeCompare(right.label);
    });
  const strictCandidates = candidates.filter((node) => node.score >= scoreCutoff || node.id === selectedNodeId);

  if (selectedNodeId) {
    const selectedNode = nodes.find((node) => node.id === selectedNodeId);
    if (selectedNode) {
      addLabelIfPossible(selectedNode, positions, placements, placedBoxes, circles, true);
    }
  }

  for (const node of strictCandidates) {
    if (placements.size >= maxLabels) break;
    addLabelIfPossible(node, positions, placements, placedBoxes, circles, false);
  }

  for (const node of candidates) {
    if (placements.size >= maxLabels) break;
    addLabelIfPossible(node, positions, placements, placedBoxes, circles, false);
  }

  if (allowFallbackCompanyLabels) {
    for (const node of candidates) {
      if (placements.size >= maxLabels) break;
      if (node.entityType !== "company") continue;
      addLabelIfPossible(node, positions, placements, placedBoxes, circles, true);
    }
  }

  return placements;
}

export function labelSizeForNode(node: GraphNode): number {
  return Math.max(10, Math.min(16, node.radius * 0.28));
}

export function labelMaxWidthForNode(node: GraphNode, placement?: LabelPlacement): number {
  if (placement?.halign === "center" && placement.valign === "center") {
    return Math.max(MIN_CENTER_LABEL_WIDTH, Math.min(LABEL_TEXT_MAX_WIDTH, node.radius * 1.78));
  }

  return LABEL_TEXT_MAX_WIDTH;
}

export function collisionRadius(node: GraphNode): number {
  return Math.max(node.radius + 26, node.radius * 1.24 + 16);
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

function placeNonCompanyNodes(nodes: GraphNode[], positions: Map<string, GraphLayoutPosition>): void {
  const nonCompanies = nodes.filter((node) => node.entityType !== "company");
  if (!nonCompanies.length) {
    return;
  }

  const fallbackRadius = Math.max(260, 130 + Math.sqrt(nodes.length) * 36);
  nonCompanies.forEach((node, index) => {
    const anchors = node.relatedEntityIds
      .map((entityId) => positions.get(`company:${entityId}`))
      .filter((position): position is GraphLayoutPosition => Boolean(position));
    const center = anchors.length
      ? anchors.reduce(
          (sum, position) => ({
            x: sum.x + position.x / anchors.length,
            y: sum.y + position.y / anchors.length
          }),
          { x: 0, y: 0 }
        )
      : {
          x: Math.cos(index * 2.399963) * fallbackRadius,
          y: Math.sin(index * 2.399963) * fallbackRadius * 0.78
        };
    const localAngle = index * 2.399963 + seededJitter(`${node.id}:voice-angle`, 0.7);
    const localRadius = anchors.length ? 76 + seededJitter(`${node.id}:voice-radius`, 18) : 0;

    positions.set(node.id, {
      x: center.x + Math.cos(localAngle) * localRadius,
      y: center.y + Math.sin(localAngle) * localRadius * 0.82
    });
  });
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

  const options = labelOptionsForNode(node, position);

  const match =
    options.find((option) => labelBoxFits(option.box, placedBoxes, circles, node.id)) ??
    (force ? bestFallbackLabelOption(options, placedBoxes, circles, node.id) : null);
  if (!match) {
    return;
  }

  placements.set(node.id, match.placement);
  placedBoxes.push(expandBox(match.box, 12));
}

function labelOptionsForNode(node: GraphNode, position: GraphLayoutPosition): LabelOption[] {
  const placements: Array<LabelPlacement & { priority: number }> = [
    { halign: "left", valign: "center", marginX: LABEL_MARGIN, marginY: 0, priority: 10 },
    { halign: "right", valign: "center", marginX: -LABEL_MARGIN, marginY: 0, priority: 10 },
    { halign: "center", valign: "top", marginX: 0, marginY: LABEL_MARGIN, priority: 12 },
    { halign: "center", valign: "bottom", marginX: 0, marginY: -LABEL_MARGIN, priority: 12 },
    { halign: "left", valign: "top", marginX: LABEL_MARGIN, marginY: LABEL_MARGIN, priority: 34 },
    { halign: "left", valign: "bottom", marginX: LABEL_MARGIN, marginY: -LABEL_MARGIN, priority: 34 },
    { halign: "right", valign: "top", marginX: -LABEL_MARGIN, marginY: LABEL_MARGIN, priority: 34 },
    { halign: "right", valign: "bottom", marginX: -LABEL_MARGIN, marginY: -LABEL_MARGIN, priority: 34 }
  ];
  if (labelFitsInsideNode(node)) {
    placements.unshift({ halign: "center", valign: "center", marginX: 0, marginY: 0, priority: -80 });
  }

  return placements.map(({ priority, ...placement }) => ({
    placement,
    box: estimateLabelBoxForNode(node, position, placement),
    priority
  }));
}

export function estimateLabelBoxForNode(
  node: GraphNode,
  position: GraphLayoutPosition,
  placement: LabelPlacement
): LabelBox {
  const { width, height } = estimateLabelDimensions(node, labelMaxWidthForNode(node, placement));
  const horizontalGap = node.radius + Math.abs(placement.marginX);
  const verticalGap = node.radius + Math.abs(placement.marginY);
  const centerX =
    placement.halign === "left"
      ? position.x - horizontalGap - width / 2
      : placement.halign === "right"
        ? position.x + horizontalGap + width / 2
        : position.x + placement.marginX;
  const centerY =
    placement.valign === "top"
      ? position.y - verticalGap - height / 2
      : placement.valign === "bottom"
        ? position.y + verticalGap + height / 2
        : position.y + placement.marginY;

  return {
    left: centerX - width / 2,
    right: centerX + width / 2,
    top: centerY - height / 2,
    bottom: centerY + height / 2
  };
}

function estimateLabelDimensions(node: GraphNode, maxTextWidth = LABEL_TEXT_MAX_WIDTH): { width: number; height: number } {
  const fontSize = labelSizeForNode(node);
  const estimatedTextWidth = Math.max(42, node.label.length * fontSize * LABEL_WIDTH_FACTOR);
  const lineCount = Math.max(1, Math.ceil(estimatedTextWidth / maxTextWidth));
  const width = Math.min(maxTextWidth, estimatedTextWidth) + LABEL_BOX_PADDING_X;
  const height = fontSize * lineCount * LABEL_LINE_HEIGHT + LABEL_BOX_PADDING_Y;

  return { width, height };
}

function labelFitsInsideNode(node: GraphNode): boolean {
  const { width, height } = estimateLabelDimensions(node, labelMaxWidthForNode(node, { halign: "center", valign: "center", marginX: 0, marginY: 0 }));
  return width <= node.radius * 2.35 && height <= node.radius * 1.62 && Math.hypot(width / 2, height / 2) <= node.radius * 1.42;
}

function bestFallbackLabelOption(
  options: LabelOption[],
  placedBoxes: LabelBox[],
  circles: LayoutCircle[],
  ownerId: string
): LabelOption {
  const [bestOption] = [...options].sort(
    (left, right) =>
      fallbackLabelOptionScore(left, placedBoxes, circles, ownerId) -
      fallbackLabelOptionScore(right, placedBoxes, circles, ownerId)
  );
  return bestOption ?? options[0]!;
}

function fallbackLabelOptionScore(
  option: LabelOption,
  placedBoxes: LabelBox[],
  circles: LayoutCircle[],
  ownerId: string
): number {
  return labelCollisionPenalty(option.box, placedBoxes, circles, ownerId) + option.priority * 180;
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

  return labelPenalty * FALLBACK_LABEL_COLLISION_WEIGHT + circlePenalty * FALLBACK_CIRCLE_COLLISION_WEIGHT;
}

function labelBoxFits(box: LabelBox, placedBoxes: LabelBox[], circles: LayoutCircle[], ownerId: string): boolean {
  if (placedBoxes.some((placedBox) => boxesOverlap(expandBox(box, 12), placedBox))) {
    return false;
  }

  return !circles.some((circle) => circle.id !== ownerId && labelBoxOverlapsCircle(expandBox(box, 8), circle));
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

export function labelBoxOverlapsCircle(box: LabelBox, circle: LayoutCircle): boolean {
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
