"use client";

import dynamic from "next/dynamic";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type cytoscape from "cytoscape";
import { buildClusterPositions, buildLabelPlacements, labelMaxWidthForNode, labelSizeForNode } from "@/lib/graph/layout";
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
  same_group_partner: "#146b58",
  top_voice_attention: "#0369a1"
};

const GRAPH_INTRO_SESSION_KEY = "yc-network-map-intro-played-v1";
const GRAPH_INTRO_REVEAL_WINDOW_MS = 1150;
const GRAPH_INTRO_AUTOPLAY = true;

function shouldPlayGraphIntro(): boolean {
  if (!GRAPH_INTRO_AUTOPLAY) {
    return false;
  }
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
  if (edge.hasClass("top_voice_attention")) {
    return 0.56;
  }
  return 0.38;
}

function isUsableCy(cy: cytoscape.Core | null): cy is cytoscape.Core {
  if (!cy) {
    return false;
  }
  try {
    return typeof cy.destroyed !== "function" || !cy.destroyed();
  } catch {
    return false;
  }
}

export function CytoscapeGraph({
  nodes,
  edges,
  selectedNodeId,
  focusRevision,
  onSelectNode
}: CytoscapeGraphProps) {
  const cyRef = useRef<cytoscape.Core | null>(null);
  const graphShellRef = useRef<HTMLDivElement | null>(null);
  const cyReadyNotifiedRef = useRef(false);
  const introStartedRef = useRef(false);
  const introAnimatingRef = useRef(false);
  const introHasSettledRef = useRef(false);
  const introTimersRef = useRef<number[]>([]);
  const lastFitSignatureRef = useRef<string | null>(null);
  const suppressSelectedZoomUntilRef = useRef(0);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const [decluttered] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cyReadyRevision, setCyReadyRevision] = useState(0);

  const positions = useMemo(() => {
    return buildClusterPositions(nodes);
  }, [nodes]);
  const companyNodeCount = useMemo(() => nodes.filter((node) => node.entityType === "company").length, [nodes]);
  const maxVisibleLabels = Math.min(nodes.length, companyNodeCount);
  const labelPlacements = useMemo(
    () => buildLabelPlacements(nodes, positions, selectedNodeId, maxVisibleLabels, true),
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
      fit: false,
      padding: decluttered ? 42 : 64,
      positions: (node: cytoscape.NodeSingular) => positions.get(node.id()) ?? { x: 0, y: 0 }
    }),
    [decluttered, positions]
  );

  const elements = useMemo(
    () => [
      ...nodes.map((node) => {
        const labelPlacement = labelPlacements.get(node.id);
        const labelInside = labelPlacement?.halign === "center" && labelPlacement.valign === "center";
        return {
          data: {
            id: node.id,
            label: labelPlacement ? node.label : "",
            fullLabel: node.label,
            labelInside,
            labelHalign: labelPlacement?.halign ?? "center",
            labelValign: labelPlacement?.valign ?? "bottom",
            labelMarginX: labelPlacement?.marginX ?? 0,
            labelMarginY: labelPlacement?.marginY ?? 0,
            entityType: node.entityType,
            score: node.score,
            size: node.radius * 2,
            labelSize: labelSizeForNode(node),
            labelMaxWidth: labelMaxWidthForNode(node, labelPlacement),
            topPlatform: node.topPlatform ?? "none",
            color: node.visual.industryColor,
            borderColor: node.visual.borderColor
          },
          position: positions.get(node.id),
          classes: [
            node.entityType,
            labelPlacement ? "labeled" : "",
            labelInside ? "label-inside" : "",
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
          width:
            edge.edgeType === "same_group_partner"
              ? 1.22
              : edge.edgeType === "top_voice_attention"
                ? Math.max(1.2, edge.weight * 2.4)
                : Math.max(0.66, edge.weight * 0.86)
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
  const visibleEdgeSignature = useMemo(
    () =>
      visibleEdges
        .map((edge) => edge.id)
        .sort()
        .join("|"),
    [visibleEdges]
  );
  const graphFitSignature = `${nodePositionSignature}|${visibleEdgeSignature}|${layout.padding}`;

  const applyCanonicalPositions = useCallback((options: { fit?: boolean; stop?: boolean } = {}) => {
    const cy = cyRef.current;
    if (!isUsableCy(cy)) {
      return;
    }
    const shouldFit = options.fit ?? true;
    const shouldStop = options.stop ?? shouldFit;
    if (shouldStop) {
      cy.stop(true);
    }
    try {
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
    } catch (error) {
      if (cy.destroyed?.()) {
        return;
      }
      throw error;
    }
    cy.autoungrabify(true);
    if (shouldFit) {
      cy.fit(undefined, Number(layout.padding));
    }
  }, [layout.padding, positions]);

  const resetLayout = useCallback(() => {
    window.setTimeout(() => {
      applyCanonicalPositions({ fit: true });
    }, 0);
  }, [applyCanonicalPositions]);

  useLayoutEffect(() => {
    const shouldFit = lastFitSignatureRef.current !== graphFitSignature;
    const timeoutId = window.setTimeout(() => {
      applyCanonicalPositions({ fit: shouldFit && !introAnimatingRef.current });
      if (shouldFit) {
        lastFitSignatureRef.current = graphFitSignature;
      }
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [applyCanonicalPositions, graphFitSignature]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!isUsableCy(cy)) return;
    cy.nodes().lock();
    cy.autoungrabify(true);
  }, [elements]);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  useEffect(() => {
    const cy = cyRef.current;
    const nodeId = selectedNodeIdRef.current;
    if (!isUsableCy(cy) || !nodeId || focusRevision <= 0) return;
    if (introStartedRef.current && !introHasSettledRef.current) {
      return;
    }
    if (introAnimatingRef.current || performance.now() < suppressSelectedZoomUntilRef.current) {
      return;
    }
    const selected = cy.$id(nodeId);
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
  }, [focusRevision]);

  useEffect(() => {
    return () => {
      introTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      introTimersRef.current = [];
      cyRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const cy = cyRef.current;
    if (!isUsableCy(cy) || introStartedRef.current || nodes.length === 0) {
      return;
    }

    if (!shouldPlayGraphIntro()) {
      return;
    }

    introStartedRef.current = true;
    introAnimatingRef.current = true;
    introHasSettledRef.current = false;
    graphShellRef.current?.setAttribute("data-graph-intro-state", "running");
    suppressSelectedZoomUntilRef.current = performance.now() + 4300;
    rememberGraphIntroPlayed();

    cy.stop(true);
    cy.resize();
    cy.maxZoom(Math.max(cy.maxZoom(), 8));
    cy.minZoom(Math.min(cy.minZoom(), 0.02));
    applyCanonicalPositions({ fit: true });
    lastFitSignatureRef.current = graphFitSignature;

    const finalZoom = cy.zoom();
    const finalPan = { ...cy.pan() };
    const introNodes = cy
      .nodes()
      .toArray()
      .sort((left, right) => Number(right.data("score") ?? 0) - Number(left.data("score") ?? 0));
    const scoredNodeRank = new Map<string, number>();
    introNodes.forEach((node, index) => {
      scoredNodeRank.set(node.id(), index);
    });
    const priorityNodeIds = new Set(introNodes.slice(0, Math.min(18, introNodes.length)).map((node) => node.id()));
    const edgeCandidates = cy
      .edges()
      .toArray()
      .map((edge) => {
        const source = edge.source();
        const target = edge.target();
        const dx = target.position("x") - source.position("x");
        const dy = target.position("y") - source.position("y");
        const sourceScore = Number(source.data("score") ?? 0);
        const targetScore = Number(target.data("score") ?? 0);
        return {
          edge,
          source,
          target,
          distance: Math.hypot(dx, dy),
          topScore: Math.max(sourceScore, targetScore),
          bestRank: Math.min(
            scoredNodeRank.get(source.id()) ?? Number.POSITIVE_INFINITY,
            scoredNodeRank.get(target.id()) ?? Number.POSITIVE_INFINITY
          ),
          hasPriorityNode: priorityNodeIds.has(source.id()) || priorityNodeIds.has(target.id())
        };
      })
      .filter((candidate) => candidate.source.length > 0 && candidate.target.length > 0);
    const sortedDistances = edgeCandidates.map((candidate) => candidate.distance).sort((left, right) => left - right);
    const closeDistanceCutoff =
      sortedDistances[Math.min(sortedDistances.length - 1, Math.max(0, Math.floor(sortedDistances.length * 0.28)))] ??
      Number.POSITIVE_INFINITY;
    const closeEdgeCandidates = edgeCandidates.filter((candidate) => candidate.distance <= closeDistanceCutoff);
    const closePriorityEdgeCandidates = closeEdgeCandidates.filter((candidate) => candidate.hasPriorityNode);
    const priorityEdgeCandidates = edgeCandidates.filter((candidate) => candidate.hasPriorityNode);
    const seedCandidates = closePriorityEdgeCandidates.length
      ? closePriorityEdgeCandidates
      : closeEdgeCandidates.length
        ? closeEdgeCandidates
        : priorityEdgeCandidates.length
          ? priorityEdgeCandidates
          : edgeCandidates;
    const seedConnection = seedCandidates.sort(
      (left, right) => left.bestRank - right.bestRank || left.distance - right.distance || right.topScore - left.topScore
    )[0];
    const firstNode =
      seedConnection == null
        ? introNodes[0]
        : Number(seedConnection.source.data("score") ?? 0) >= Number(seedConnection.target.data("score") ?? 0)
          ? seedConnection.source
          : seedConnection.target;
    const secondNode =
      seedConnection == null ? undefined : seedConnection.source.id() === firstNode?.id() ? seedConnection.target : seedConnection.source;
    if (!firstNode || (edgeCandidates.length > 0 && !secondNode)) {
      return;
    }

    const spotlightNodes = [firstNode, secondNode].filter(Boolean) as cytoscape.NodeSingular[];
    let spotlightCollection = cy.collection();
    spotlightNodes.forEach((node) => {
      spotlightCollection = spotlightCollection.merge(node);
    });
    const pairDistance = secondNode
      ? Math.hypot(secondNode.position("x") - firstNode.position("x"), secondNode.position("y") - firstNode.position("y"))
      : 0;
    const pairZoom = pairDistance > 0 ? Math.min(cy.width() * 0.28, cy.height() * 0.32) / pairDistance : finalZoom * 3.2;
    const desiredStartZoom = Math.max(pairZoom * 1.2, finalZoom * 3.35, 1.65);
    if (cy.maxZoom() < desiredStartZoom * 1.08) {
      cy.maxZoom(desiredStartZoom * 1.12);
    }
    const startZoom = Math.min(desiredStartZoom, cy.maxZoom());
    const desiredSecondZoom = Math.max(pairZoom * 1.02, finalZoom * 2.25, 1.18);
    const secondZoom = Math.min(desiredSecondZoom, startZoom * 0.92, cy.maxZoom());
    const panForNode = (node: cytoscape.NodeSingular, zoom: number) => ({
      x: cy.width() / 2 - node.position("x") * zoom,
      y: cy.height() / 2 - node.position("y") * zoom
    });

    if (firstNode) {
      cy.zoom(startZoom);
      cy.pan(panForNode(firstNode, startZoom));
    }
    const popStartScale = 0.92;
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const nodeSize = Number(node.data("size") ?? 1);
        node.style("transition-duration", "0ms");
        node.style("opacity", 0);
        node.style("width", Math.max(1, nodeSize * popStartScale));
        node.style("height", Math.max(1, nodeSize * popStartScale));
      });
      cy.edges().forEach((edge) => {
        edge.style("opacity", 0);
      });
    });

    const addTimer = (callback: () => void, delay: number) => {
      const timerId = window.setTimeout(callback, delay);
      introTimersRef.current.push(timerId);
    };
    const revealNode = (node: cytoscape.NodeSingular, duration = 320) => {
      const nodeSize = Number(node.data("size") ?? 1);
      node.animate(
        {
          style: {
            opacity: targetNodeOpacity(node),
            width: nodeSize,
            height: nodeSize
          }
        },
        { duration, easing: "ease-in-out" }
      );
    };

    const revealedNodeIds = new Set<string>([firstNode.id()]);
    const revealedEdgeIds = new Set<string>();
    const animateEdgeCollection = (edgeCollection: cytoscape.CollectionReturnValue, duration = 360, boosted = false) => {
      const edgeGroups = new Map<number, cytoscape.EdgeSingular[]>();
      edgeCollection.forEach((edge) => {
        if (!edge.isEdge()) {
          return;
        }
        const targetOpacity = boosted ? Math.max(targetEdgeOpacity(edge), 0.58) : targetEdgeOpacity(edge);
        edgeGroups.set(targetOpacity, [...(edgeGroups.get(targetOpacity) ?? []), edge]);
      });
      edgeGroups.forEach((edgeGroup, opacity) => {
        let opacityCollection = cy.collection();
        edgeGroup.forEach((edge) => {
          opacityCollection = opacityCollection.merge(edge);
        });
        opacityCollection.animate(
          { style: { opacity } },
          { duration, easing: "ease-in-out" }
        );
      });
    };
    const revealVisibleEdgesForNode = (node: cytoscape.NodeSingular, duration = 320) => {
      let edgeCollection = cy.collection();
      node.connectedEdges().forEach((edge) => {
        if (revealedEdgeIds.has(edge.id())) {
          return;
        }
        const sourceId = edge.source().id();
        const targetId = edge.target().id();
        if (!revealedNodeIds.has(sourceId) || !revealedNodeIds.has(targetId)) {
          return;
        }
        revealedEdgeIds.add(edge.id());
        edgeCollection = edgeCollection.merge(edge);
      });
      if (edgeCollection.length) {
        animateEdgeCollection(edgeCollection, duration);
      }
    };

    addTimer(() => {
      revealNode(firstNode, 420);
    }, 0);

    if (secondNode) {
      addTimer(() => {
        revealedNodeIds.add(secondNode.id());
        revealNode(secondNode, 380);
        if (seedConnection) {
          revealedEdgeIds.add(seedConnection.edge.id());
          const originalWidth = Number(seedConnection.edge.data("width") ?? 1);
          let seedEdgeCollection = cy.collection();
          seedEdgeCollection = seedEdgeCollection.merge(seedConnection.edge);
          seedConnection.edge.style("width", Math.max(originalWidth * 1.6, 2));
          animateEdgeCollection(seedEdgeCollection, 380, true);
        } else {
          revealVisibleEdgesForNode(secondNode, 340);
        }
        cy.animate(
          {
            center: { eles: spotlightCollection },
            zoom: secondZoom
          },
          { duration: 620, easing: "ease-in-out" }
        );
      }, 520);
    }

    const adjacency = new Map<string, cytoscape.NodeSingular[]>();
    cy.nodes().forEach((node) => {
      adjacency.set(node.id(), []);
    });
    cy.edges().forEach((edge) => {
      const source = edge.source();
      const target = edge.target();
      adjacency.get(source.id())?.push(target);
      adjacency.get(target.id())?.push(source);
    });
    const distanceFromSeed = new Map<string, number>();
    const queue = [...spotlightNodes];
    spotlightNodes.forEach((node) => {
      distanceFromSeed.set(node.id(), 0);
    });
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      const currentDistance = distanceFromSeed.get(current.id()) ?? 0;
      for (const neighbor of adjacency.get(current.id()) ?? []) {
        if (distanceFromSeed.has(neighbor.id())) {
          continue;
        }
        distanceFromSeed.set(neighbor.id(), currentDistance + 1);
        queue.push(neighbor);
      }
    }
    const seedCenter = spotlightNodes.length
      ? spotlightNodes.reduce(
          (center, node) => ({
            x: center.x + node.position("x") / spotlightNodes.length,
            y: center.y + node.position("y") / spotlightNodes.length
          }),
          { x: 0, y: 0 }
        )
      : { x: firstNode.position("x"), y: firstNode.position("y") };
    const remainingNodes = cy
      .nodes()
      .toArray()
      .filter((node) => node.id() !== firstNode.id() && node.id() !== secondNode?.id())
      .sort((left, right) => {
        const leftDistance = distanceFromSeed.get(left.id()) ?? Number.POSITIVE_INFINITY;
        const rightDistance = distanceFromSeed.get(right.id()) ?? Number.POSITIVE_INFINITY;
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }
        const leftDx = left.position("x") - seedCenter.x;
        const leftDy = left.position("y") - seedCenter.y;
        const rightDx = right.position("x") - seedCenter.x;
        const rightDy = right.position("y") - seedCenter.y;
        return Math.hypot(leftDx, leftDy) - Math.hypot(rightDx, rightDy) || left.id().localeCompare(right.id());
      });
    const earlyRevealCount = Math.min(26, remainingNodes.length);
    const earlyRevealSpacing = 46;
    const lateRevealStart = 860 + Math.max(0, earlyRevealCount - 1) * earlyRevealSpacing + 72;
    const lateRevealCount = Math.max(remainingNodes.length - earlyRevealCount, 0);
    const lateRevealSpacing = lateRevealCount
      ? Math.max(4, Math.min(10, (GRAPH_INTRO_REVEAL_WINDOW_MS - earlyRevealCount * earlyRevealSpacing) / lateRevealCount))
      : 0;

    remainingNodes.forEach((node, index) => {
      const delay =
        index < earlyRevealCount
          ? 860 + index * earlyRevealSpacing
          : lateRevealStart + (index - earlyRevealCount) * lateRevealSpacing;
      addTimer(() => {
        revealedNodeIds.add(node.id());
        revealNode(node, index < earlyRevealCount ? 280 : 220);
        revealVisibleEdgesForNode(node, 300);
      }, delay);
    });

    addTimer(() => {
      let unrevealedEdges = cy.collection();
      cy.edges().forEach((edge) => {
        if (!revealedEdgeIds.has(edge.id())) {
          unrevealedEdges = unrevealedEdges.merge(edge);
        }
      });
      animateEdgeCollection(unrevealedEdges, 540);
    }, 2860);

    const cameraPullbackDelay = secondNode ? 1120 : 560;
    const cameraPullbackDuration = 1750;

    addTimer(() => {
      cy.animate(
        {
          zoom: finalZoom,
          pan: finalPan
        },
        { duration: cameraPullbackDuration, easing: "ease-in-out" }
      );
    }, cameraPullbackDelay);

    const settleCamera = () => {
      cy.stop(true);
      cy.zoom(finalZoom);
      cy.pan(finalPan);
      cy.elements().removeStyle("opacity transition-duration width height");
      introAnimatingRef.current = false;
      introHasSettledRef.current = true;
      graphShellRef.current?.setAttribute("data-graph-intro-state", "settled");
      suppressSelectedZoomUntilRef.current = performance.now() + 3000;
      lastFitSignatureRef.current = graphFitSignature;
      requestAnimationFrame(() => {
        cy.stop(true);
        cy.zoom(finalZoom);
        cy.pan(finalPan);
        requestAnimationFrame(() => {
          cy.zoom(finalZoom);
          cy.pan(finalPan);
        });
      });
    };

    addTimer(settleCamera, cameraPullbackDelay + cameraPullbackDuration + 280);
  }, [applyCanonicalPositions, cyReadyRevision, graphFitSignature, nodes.length]);

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
      if (!isUsableCy(cy)) return;
      if (introAnimatingRef.current || performance.now() < suppressSelectedZoomUntilRef.current) {
        return;
      }
      cy.resize();
      cy.fit(undefined, Number(layout.padding));
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, [isFullscreen, layout.padding]);

  const graphShellClassName = [
    "graph-shell",
    isFullscreen ? "graph-shell-fullscreen" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={graphShellClassName} data-graph-intro-autoplay={GRAPH_INTRO_AUTOPLAY ? "true" : "false"} ref={graphShellRef}>
      <div className="graph-toolbar">
        <div className="graph-toolbar-main">
          <div className="legend">
            {industryLegend.map((item) => (
              <span className="legend-item" key={item.industry}>
                <span className="legend-dot" style={{ backgroundColor: item.color }} />
                <span className="legend-label">{formatIndustry(item.industry)}</span>
                {" "}
                <small>({item.count})</small>
              </span>
            ))}
          </div>
          <div className="graph-toolbar-actions">
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
              "text-max-width": "data(labelMaxWidth)",
              "text-valign": "data(labelValign)",
              "text-halign": "data(labelHalign)",
              "text-margin-x": "data(labelMarginX)",
              "text-margin-y": "data(labelMarginY)",
              "text-background-color": "#ffffff",
              "text-background-opacity": 0,
              "text-background-padding": 0,
              "text-border-color": "#d7dee8",
              "text-border-opacity": 0,
              "text-border-width": 0,
              "text-outline-color": "#f8fafc",
              "text-outline-opacity": 0.92,
              "text-outline-width": 3,
              color: "#172033",
              "background-color": "data(color)",
              "border-color": "data(borderColor)",
              "border-style": "solid",
              "border-width": 3,
              "overlay-opacity": 0,
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
            selector: "node.label-inside",
            style: {
              "text-outline-width": 0,
              "text-outline-opacity": 0
            }
          },
          {
            selector: "node.hovered",
            style: {
              label: "data(fullLabel)",
              "text-background-opacity": 0,
              "text-background-padding": 0,
              "text-border-opacity": 0,
              "text-outline-width": 4,
              "z-index": 900
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
              "text-background-opacity": 0,
              "text-background-padding": 0,
              "text-border-opacity": 0,
              "text-outline-width": 4,
              "z-index": 1000,
              opacity: 1
            }
          },
          {
            selector: "node.label-inside.hovered, node.label-inside.selected",
            style: {
              "text-outline-width": 0,
              "text-outline-opacity": 0
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
          },
          {
            selector: "edge.top_voice_attention",
            style: {
              "line-style": "dotted",
              opacity: 0.56
            }
          }
        ]}
        cy={(cy: cytoscape.Core) => {
          const isInitialCyReady = !cyReadyNotifiedRef.current;
          cyRef.current = cy;
          cy.maxZoom(Math.max(cy.maxZoom(), 8));
          cy.minZoom(Math.min(cy.minZoom(), 0.02));
          const willPlayIntro = !introStartedRef.current && shouldPlayGraphIntro();
          if (willPlayIntro) {
            cy.batch(() => {
              cy.nodes().forEach((node) => {
                const nodeSize = Number(node.data("size") ?? 1);
                node.style("transition-duration", "0ms");
                node.style("opacity", 0);
                node.style("width", Math.max(1, nodeSize * 0.92));
                node.style("height", Math.max(1, nodeSize * 0.92));
              });
              cy.edges().forEach((edge) => {
                edge.style("opacity", 0);
              });
            });
          }
          if (!cyReadyNotifiedRef.current) {
            cyReadyNotifiedRef.current = true;
            setCyReadyRevision((current) => current + 1);
          }
          cy.removeListener("tap", "node");
          cy.removeListener("mouseover", "node");
          cy.removeListener("mouseout", "node");
          cy.on("tap", "node", (event) => {
            onSelectNode(event.target.id());
          });
          cy.on("mouseover", "node", (event) => {
            event.target.addClass("hovered");
          });
          cy.on("mouseout", "node", (event) => {
            event.target.removeClass("hovered");
          });
          cy.nodes().lock();
          cy.autoungrabify(true);
          window.setTimeout(() => {
            applyCanonicalPositions({ fit: isInitialCyReady && !willPlayIntro });
          }, 0);
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
