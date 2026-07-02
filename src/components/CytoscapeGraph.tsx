"use client";

import dynamic from "next/dynamic";
import { Eye, EyeOff, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type cytoscape from "cytoscape";
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

const GRAPH_INTRO_SESSION_KEY = "yc-network-map-intro-played-v1";
const GRAPH_INTRO_NODE_BUCKETS = 22;
const GRAPH_INTRO_NODE_STAGGER_MS = 440;

type GraphIntroPhase = "idle" | "pending" | "visible" | "exiting" | "done";

function shouldPlayGraphIntro(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return false;
  }

  const navigation = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
  const isHardRefresh = navigation?.type === "reload";
  const alreadyPlayed = window.sessionStorage.getItem(GRAPH_INTRO_SESSION_KEY);

  return !alreadyPlayed || isHardRefresh;
}

function rememberGraphIntroPlayed() {
  try {
    window.sessionStorage.setItem(GRAPH_INTRO_SESSION_KEY, "1");
  } catch {
    // Session storage can be unavailable in strict privacy modes. The intro still plays once for this render.
  }
}

function deterministicIntroDelay(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = (hash >>> 0) / 4294967295;
  return 80 + normalized * GRAPH_INTRO_NODE_STAGGER_MS;
}

function targetNodeOpacity(node: cytoscape.NodeSingular): number {
  if (node.hasClass("selected")) {
    return 1;
  }
  if (node.hasClass("review-rejected")) {
    return 0.72;
  }
  if (node.hasClass("decluttered")) {
    return 0.82;
  }
  return 1;
}

function targetEdgeOpacity(edge: cytoscape.EdgeSingular): number {
  if (edge.hasClass("industry_similarity")) {
    return 0.25;
  }
  if (edge.hasClass("same_group_partner")) {
    return 0.4;
  }
  return 0.38;
}

export function CytoscapeGraph({
  nodes,
  edges,
  selectedNodeId,
  focusRevision,
  onSelectNode
}: CytoscapeGraphProps) {
  const cyRef = useRef<cytoscape.Core | null>(null);
  const cyReadyNotifiedRef = useRef(false);
  const introStartedRef = useRef(false);
  const introTimersRef = useRef<number[]>([]);
  const [decluttered, setDecluttered] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cyReadyRevision, setCyReadyRevision] = useState(0);
  const [introPhase, setIntroPhase] = useState<GraphIntroPhase>("idle");

  const positions = useMemo(() => {
    return buildClusterPositions(nodes);
  }, [nodes]);
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

  const nodePositionSignature = useMemo(
    () =>
      nodes
        .map((node) => {
          const position = positions.get(node.id);
          return `${node.id}:${Math.round((position?.x ?? 0) * 10) / 10},${Math.round((position?.y ?? 0) * 10) / 10}`;
        })
        .sort()
        .join("|"),
    [nodes, positions]
  );

  const applyCanonicalPositions = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.stop(true);
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const position = positions.get(node.id());
        if (!position) {
          return;
        }
        node.unlock();
        node.position(position);
        node.lock();
      });
    });
    cy.autoungrabify(true);
    cy.fit(undefined, Number(layout.padding));
  }, [layout.padding, positions]);

  const resetLayout = useCallback(() => {
    window.setTimeout(() => {
      applyCanonicalPositions();
    }, 0);
  }, [applyCanonicalPositions]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      applyCanonicalPositions();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [applyCanonicalPositions, elements, nodePositionSignature]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().lock();
    cy.autoungrabify(true);
  }, [elements]);

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
    return () => {
      introTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      introTimersRef.current = [];
      document.body.classList.remove("graph-intro-active");
      document.documentElement.classList.remove("graph-intro-preload");
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || introStartedRef.current || nodes.length === 0) {
      return;
    }

    if (!shouldPlayGraphIntro()) {
      document.documentElement.classList.remove("graph-intro-preload");
      setIntroPhase("done");
      return;
    }

    introStartedRef.current = true;
    rememberGraphIntroPlayed();
    document.body.classList.add("graph-intro-active");
    setIntroPhase("pending");

    cy.stop(true);
    applyCanonicalPositions();

    const finalZoom = cy.zoom();
    const finalPan = { ...cy.pan() };
    const canvasCenter = {
      x: cy.width() / 2,
      y: cy.height() / 2
    };
    const startZoom = Math.min(finalZoom * 1.34, cy.maxZoom());
    const zoomRatio = startZoom / finalZoom;
    const startPan = {
      x: canvasCenter.x - (canvasCenter.x - finalPan.x) * zoomRatio,
      y: canvasCenter.y - (canvasCenter.y - finalPan.y) * zoomRatio
    };

    cy.zoom(startZoom);
    cy.pan(startPan);
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        node.style("opacity", 0);
      });
      cy.edges().forEach((edge) => {
        edge.style("opacity", 0);
      });
    });

    const addTimer = (callback: () => void, delay: number) => {
      const timerId = window.setTimeout(callback, delay);
      introTimersRef.current.push(timerId);
    };

    addTimer(() => {
      setIntroPhase("visible");
      document.documentElement.classList.remove("graph-intro-preload");
    }, 300);

    const nodeBuckets = Array.from({ length: GRAPH_INTRO_NODE_BUCKETS }, () => new Map<number, cytoscape.NodeSingular[]>());
    cy.nodes().forEach((node) => {
      const delay = deterministicIntroDelay(node.id());
      const bucketIndex = Math.min(
        GRAPH_INTRO_NODE_BUCKETS - 1,
        Math.floor((delay / (GRAPH_INTRO_NODE_STAGGER_MS + 80)) * GRAPH_INTRO_NODE_BUCKETS)
      );
      const targetOpacity = targetNodeOpacity(node);
      const bucket = nodeBuckets[bucketIndex];
      bucket.set(targetOpacity, [...(bucket.get(targetOpacity) ?? []), node]);
    });

    nodeBuckets.forEach((bucket, bucketIndex) => {
      const delay = 720 + bucketIndex * 18;
      addTimer(() => {
        bucket.forEach((bucketNodes, opacity) => {
          const bucketCollection = cy.collection();
          bucketNodes.forEach((node) => {
            bucketCollection.merge(node);
          });
          bucketCollection.animate(
            { style: { opacity } },
            { duration: 560, easing: "ease-in-out" }
          );
        });
      }, delay);
    });

    addTimer(() => {
      const edgeGroups = new Map<number, cytoscape.EdgeSingular[]>();
      cy.edges().forEach((edge) => {
        const targetOpacity = targetEdgeOpacity(edge);
        edgeGroups.set(targetOpacity, [...(edgeGroups.get(targetOpacity) ?? []), edge]);
      });
      edgeGroups.forEach((edgeGroup, opacity) => {
        const edgeCollection = cy.collection();
        edgeGroup.forEach((edge) => {
          edgeCollection.merge(edge);
        });
        edgeCollection.animate(
          { style: { opacity } },
          { duration: 760, easing: "ease-in-out" }
        );
      });
    }, 1250);

    addTimer(() => {
      cy.animate(
        {
          zoom: finalZoom,
          pan: finalPan
        },
        { duration: 2850, easing: "ease-in-out" }
      );
    }, 1850);

    addTimer(() => {
      cy.stop(false);
      cy.zoom(finalZoom);
      cy.pan(finalPan);
      cy.elements().removeStyle("opacity");
      document.body.classList.remove("graph-intro-active");
      setIntroPhase("exiting");
    }, 4800);

    addTimer(() => {
      setIntroPhase("done");
    }, 5480);
  }, [applyCanonicalPositions, cyReadyRevision, nodes.length]);

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

  const introActive = introPhase !== "idle" && introPhase !== "done";
  const graphShellClassName = [
    "graph-shell",
    isFullscreen ? "graph-shell-fullscreen" : "",
    introActive ? "graph-shell-intro" : "",
    introPhase === "visible" || introPhase === "exiting" ? "graph-shell-intro-visible" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
    {introActive ? (
      <div
        className={`graph-intro-backdrop${introPhase === "exiting" ? " graph-intro-backdrop-exiting" : ""}`}
        aria-hidden="true"
      />
    ) : null}
    <div className={graphShellClassName}>
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
          if (!cyReadyNotifiedRef.current) {
            cyReadyNotifiedRef.current = true;
            setCyReadyRevision((current) => current + 1);
          }
          cy.removeListener("tap", "node");
          cy.on("tap", "node", (event) => {
            onSelectNode(event.target.id());
          });
          cy.nodes().lock();
          cy.autoungrabify(true);
          window.setTimeout(() => {
            applyCanonicalPositions();
          }, 0);
        }}
      />
    </div>
    </>
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
