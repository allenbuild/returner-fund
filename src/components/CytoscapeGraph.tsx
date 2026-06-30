"use client";

import dynamic from "next/dynamic";
import { Eye, EyeOff, Maximize2, Minimize2, Move, RotateCcw } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type cytoscape from "cytoscape";
import { graphInteractionMode, relatedNodeDragPosition } from "@/lib/graph/interaction";
import { buildClusterPositions, buildLabelPlacements, labelSizeForNode } from "@/lib/graph/layout";
import type { BatchSummary, EdgeType, GraphEdge, GraphNode } from "@/lib/graph/types";

const CytoscapeComponent = dynamic(
  () => import("react-cytoscapejs").then((module) => module.default),
  {
    ssr: false,
    loading: () => <div className="graph-loading">Loading graph</div>
  }
) as ComponentType<Record<string, unknown>>;

interface CytoscapeGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  batch: BatchSummary;
  selectedNodeId: string | null;
  focusRevision: number;
  onSelectNode: (nodeId: string) => void;
}

const edgeColors: Record<EdgeType, string> = {
  founder_of: "#334155",
  industry_similarity: "#835a08",
  same_group_partner: "#146b58"
};

export function CytoscapeGraph({
  nodes,
  edges,
  selectedNodeId,
  focusRevision,
  onSelectNode
}: CytoscapeGraphProps) {
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [decluttered, setDecluttered] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [moveNodes, setMoveNodes] = useState(false);
  const [manualPositions, setManualPositions] = useState<Map<string, { x: number; y: number }>>(() => new Map());

  const positions = useMemo(() => {
    const layoutPositions = buildClusterPositions(nodes);
    for (const [id, position] of manualPositions.entries()) {
      if (layoutPositions.has(id)) {
        layoutPositions.set(id, position);
      }
    }
    return layoutPositions;
  }, [manualPositions, nodes]);
  const maxVisibleLabels = isFullscreen ? (decluttered ? 88 : 120) : decluttered ? 52 : 68;
  const labelPlacements = useMemo(
    () => buildLabelPlacements(nodes, positions, selectedNodeId, maxVisibleLabels),
    [nodes, positions, selectedNodeId, maxVisibleLabels]
  );
  const visibleEdges = useMemo(
    () =>
      decluttered
        ? edges.filter((edge) => edge.edgeType !== "industry_similarity" || edge.weight >= 0.34)
        : edges,
    [decluttered, edges]
  );

  const layout = useMemo(
    () => ({
      name: "preset",
      animate: false,
      fit: true,
      padding: decluttered ? 42 : 64,
      positions: (node: cytoscape.NodeSingular) => positions.get(node.id()) ?? { x: 0, y: 0 }
    }),
    [decluttered, positions]
  );

  const elements = useMemo(
    () => [
      ...nodes.map((node) => {
        const labelPlacement = labelPlacements.get(node.id);
        return {
          data: {
            id: node.id,
            label: labelPlacement ? node.label : "",
            fullLabel: node.label,
            labelHalign: labelPlacement?.halign ?? "center",
            labelValign: labelPlacement?.valign ?? "bottom",
            labelMarginX: labelPlacement?.marginX ?? 0,
            labelMarginY: labelPlacement?.marginY ?? 0,
            entityType: node.entityType,
            score: node.score,
            size: node.radius * 2,
            labelSize: labelSizeForNode(node),
            topPlatform: node.topPlatform ?? "none",
            color: node.visual.industryColor,
            borderColor: node.visual.borderColor
          },
          position: positions.get(node.id),
          classes: [
            node.entityType,
            labelPlacement ? "labeled" : "",
            `review-${node.review_state}`,
            decluttered && selectedNodeId !== node.id ? "decluttered" : "",
            selectedNodeId === node.id ? "selected" : ""
          ]
            .filter(Boolean)
            .join(" ")
        };
      }),
      ...visibleEdges.map((edge) => ({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          weight: edge.weight,
          edgeType: edge.edgeType,
          color: edgeColors[edge.edgeType],
          width: edge.edgeType === "same_group_partner" ? 1.22 : Math.max(0.66, edge.weight * 0.86)
        },
        classes: edge.edgeType
      }))
    ],
    [decluttered, nodes, positions, selectedNodeId, visibleEdges, labelPlacements]
  );

  const industryLegend = useMemo(() => {
    const counts = new Map<string, { industry: string; color: string; count: number }>();
    for (const node of nodes) {
      if (node.entityType !== "company") {
        continue;
      }
      const current = counts.get(node.primaryIndustry) ?? {
        industry: node.primaryIndustry,
        color: node.visual.industryColor,
        count: 0
      };
      current.count += 1;
      counts.set(node.primaryIndustry, current);
    }
    return [...counts.values()].sort((left, right) => right.count - left.count || left.industry.localeCompare(right.industry));
  }, [nodes]);

  const applyLayout = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.layout(layout).run();
    cy.fit(undefined, Number(layout.padding));
  }, [layout]);

  const resetLayout = useCallback(() => {
    setManualPositions(new Map());
    window.setTimeout(() => {
      const cy = cyRef.current;
      if (!cy) {
        return;
      }
      cy.layout(layout).run();
      cy.fit(undefined, Number(layout.padding));
    }, 0);
  }, [layout]);

  useEffect(() => {
    applyLayout();
  }, [applyLayout]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const mode = graphInteractionMode(moveNodes);
    if (mode.lockNodes) {
      cy.nodes().lock();
    } else {
      cy.nodes().unlock();
    }
    cy.autoungrabify(mode.autoungrabify);
  }, [moveNodes, elements]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedNodeId) return;
    const selected = cy.$id(selectedNodeId);
    if (!selected.length) return;
    cy.nodes().unselect();
    selected.select();
    cy.animate(
      {
        center: { eles: selected },
        zoom: Math.min(1.45, Math.max(cy.zoom(), 0.88))
      },
      { duration: 240 }
    );
  }, [focusRevision, selectedNodeId]);

  useEffect(() => {
    document.body.classList.toggle("graph-fullscreen-open", isFullscreen);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.classList.remove("graph-fullscreen-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.resize();
      cy.fit(undefined, Number(layout.padding));
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, [isFullscreen, layout.padding]);

  return (
    <div className={`graph-shell${isFullscreen ? " graph-shell-fullscreen" : ""}`}>
      <div className="graph-toolbar">
        <div className="graph-toolbar-main">
          <div className="legend">
            {industryLegend.map((item) => (
              <span className="legend-item" key={item.industry}>
                <span className="legend-dot" style={{ backgroundColor: item.color }} />
                {formatIndustry(item.industry)}
                {" "}
                <small>({item.count})</small>
              </span>
            ))}
          </div>
          <div className="graph-toolbar-actions">
            <button
              type="button"
              className={decluttered ? "active" : ""}
              onClick={() => setDecluttered((current) => !current)}
              title={decluttered ? "Show full graph" : "Declutter graph"}
            >
              {decluttered ? <Eye size={15} /> : <EyeOff size={15} />}
              {decluttered ? "Full graph" : "Declutter"}
            </button>
            <button
              type="button"
              className={moveNodes ? "active" : ""}
              onClick={() => setMoveNodes((current) => !current)}
              title={moveNodes ? "Lock nodes" : "Move nodes"}
            >
              <Move size={15} />
              Move nodes
            </button>
            <button type="button" onClick={resetLayout} title="Reset layout">
              <RotateCcw size={15} />
              Reset
            </button>
            <button
              type="button"
              className={isFullscreen ? "active" : ""}
              onClick={() => setIsFullscreen((current) => !current)}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen graph"}
            >
              {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              {isFullscreen ? "Exit" : "Fullscreen"}
            </button>
          </div>
        </div>
      </div>
      <CytoscapeComponent
        elements={elements}
        className="cytoscape-canvas"
        layout={layout}
        stylesheet={[
          {
            selector: "node",
            style: {
              width: "data(size)",
              height: "data(size)",
              label: "",
              shape: "ellipse",
              "font-size": "data(labelSize)",
              "font-family": "Poppins, Inter, Arial, sans-serif",
              "font-weight": 800,
              "text-wrap": "wrap",
              "text-max-width": 104,
              "text-valign": "data(labelValign)",
              "text-halign": "data(labelHalign)",
              "text-margin-x": "data(labelMarginX)",
              "text-margin-y": "data(labelMarginY)",
              "text-background-color": "#ffffff",
              "text-background-opacity": 0.9,
              "text-background-padding": 2,
              "text-border-color": "#d7dee8",
              "text-border-opacity": 0.45,
              "text-border-width": 1,
              "text-outline-color": "#ffffff",
              "text-outline-width": 3,
              color: "#172033",
              "background-color": "data(color)",
              "border-color": "data(borderColor)",
              "border-style": "solid",
              "border-width": 3,
              "overlay-opacity": 0,
              "shadow-blur": 10,
              "shadow-color": "#0f172a",
              "shadow-opacity": 0.14,
              "shadow-offset-x": 0,
              "shadow-offset-y": 2,
              "transition-property": "border-width, opacity, width, height",
              "transition-duration": "120ms"
            }
          },
          {
            selector: "node.labeled",
            style: {
              label: "data(fullLabel)",
              "z-index": 18
            }
          },
          {
            selector: "node:hover",
            style: {
              label: "data(fullLabel)",
              "z-index": 24
            }
          },
          {
            selector: "node.review-needs_review",
            style: {
              "border-color": "#b7791f",
              "border-width": 4
            }
          },
          {
            selector: "node.review-rejected",
            style: {
              "border-color": "#b83232",
              "border-width": 4,
              opacity: 0.72
            }
          },
          {
            selector: "node.decluttered",
            style: {
              opacity: 0.82
            }
          },
          {
            selector: "node.selected",
            style: {
              label: "data(fullLabel)",
              "border-color": "#101828",
              "border-width": 4,
              "z-index": 20,
              opacity: 1
            }
          },
          {
            selector: "edge",
            style: {
              width: "data(width)",
              "line-color": "data(color)",
              "target-arrow-shape": "none",
              "source-arrow-shape": "none",
              "curve-style": "bezier",
              opacity: 0.38
            }
          },
          {
            selector: "edge.industry_similarity",
            style: {
              width: 0.68,
              "line-style": "solid",
              opacity: 0.25
            }
          },
          {
            selector: "edge.same_group_partner",
            style: {
              "line-style": "dashed",
              opacity: 0.4
            }
          }
        ]}
        cy={(cy: cytoscape.Core) => {
          cyRef.current = cy;
          cy.removeListener("tap", "node");
          cy.removeListener("drag", "node");
          cy.removeListener("dragfree", "node");
          cy.on("tap", "node", (event) => {
            onSelectNode(event.target.id());
          });
          cy.on("drag", "node", (event) => {
            if (!moveNodes) return;
            const dragged = event.target;
            const scratch = dragged.scratch("_lastPosition") as { x: number; y: number } | undefined;
            const current = dragged.position();
            if (!scratch) {
              dragged.scratch("_lastPosition", { ...current });
              return;
            }
            const dx = current.x - scratch.x;
            const dy = current.y - scratch.y;
            dragged.connectedEdges().connectedNodes().difference(dragged).forEach((neighbor: cytoscape.NodeSingular) => {
              const position = neighbor.position();
              neighbor.position(relatedNodeDragPosition(position, { dx, dy }));
            });
            dragged.scratch("_lastPosition", { ...current });
          });
          cy.on("dragfree", "node", (event) => {
            event.target.removeScratch("_lastPosition");
            setManualPositions((current) => {
              const next = new Map(current);
              cy.nodes().forEach((node) => {
                next.set(node.id(), { ...node.position() });
              });
              return next;
            });
          });
          const mode = graphInteractionMode(moveNodes);
          if (mode.lockNodes) {
            cy.nodes().lock();
          } else {
            cy.nodes().unlock();
          }
          cy.autoungrabify(mode.autoungrabify);
        }}
      />
    </div>
  );
}

function formatIndustry(industry: string): string {
  const labels: Record<string, string> = {
    b2b: "B2B",
    industrials: "Industrials",
    fintech: "Fintech",
    healthcare: "Healthcare",
    consumer: "Consumer",
    "real estate and construction": "Real Estate and Construction",
    government: "Government"
  };
  return labels[industry.toLowerCase()] ?? industry.replace(/\b\w/g, (char) => char.toUpperCase());
}
