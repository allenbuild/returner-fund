import { describe, expect, it } from "vitest";
import { graphInteractionMode, relatedNodeDragPosition } from "@/lib/graph/interaction";

describe("graph interaction mode", () => {
  it("locks graph circles by default", () => {
    expect(graphInteractionMode(false)).toEqual({
      lockNodes: true,
      autoungrabify: true
    });
  });

  it("enables dragging only when move-nodes mode is on", () => {
    expect(graphInteractionMode(true)).toEqual({
      lockNodes: false,
      autoungrabify: false
    });
  });

  it("lets related nodes follow a dragged node subtly", () => {
    const moved = relatedNodeDragPosition({ x: 100, y: 50 }, { dx: 80, dy: -40 });

    expect(moved.x).toBeCloseTo(109.6);
    expect(moved.y).toBeCloseTo(45.2);
  });

  it("caps related-node follow strength so drag mode stays stable", () => {
    const moved = relatedNodeDragPosition({ x: 0, y: 0 }, { dx: 100, dy: 100 }, 1);

    expect(moved).toEqual({ x: 35, y: 35 });
  });
});
