export interface Point {
  x: number;
  y: number;
}

export interface DragDelta {
  dx: number;
  dy: number;
}

export function graphInteractionMode(moveNodes: boolean): { lockNodes: boolean; autoungrabify: boolean } {
  return {
    lockNodes: !moveNodes,
    autoungrabify: !moveNodes
  };
}

export function relatedNodeDragPosition(position: Point, delta: DragDelta, followFactor = 0.12): Point {
  const factor = Math.max(0, Math.min(followFactor, 0.35));

  return {
    x: position.x + delta.dx * factor,
    y: position.y + delta.dy * factor
  };
}
