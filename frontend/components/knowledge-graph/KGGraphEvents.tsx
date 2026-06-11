'use client';

import { useCamera, useRegisterEvents, useSigma } from '@react-sigma/core';
import type EventEmitter from 'events';
import type Graph from 'graphology';
import { useEffect, useRef, useState } from 'react';
import { HIGHLIGHTED_EDGE_COLOR } from '@/lib/data';
import { normalizeGraphSelection } from '@/lib/graph/selection-context';
import { FADED_NODE_COLOR, generateTypeColorMap } from '@/lib/graph/knowledge-graph-renderer';
import { useKGStore } from '@/lib/hooks';
import type { EdgeAttributes, NodeAttributes } from '@/lib/interface';
import type { SelectionPluginHandle } from '@/lib/plugins/react-sigma-selection';
import { Trie } from '@/lib/trie';
import { KGPopupTable } from './KGPopupTable';

// Helper: Restore node to its appropriate type based on state
const restoreNodeType = (
  graph: Graph<NodeAttributes, EdgeAttributes>,
  node: string,
  highlightedNodes: Set<string>,
  clickedNodes: Set<string>,
  activePropertyNodeTypes: string[],
) => {
  graph.updateNodeAttributes(node, attr => {
    if (highlightedNodes.has(node) || clickedNodes.has(node)) {
      attr.type = 'border';
      attr.highlighted = true;
    } else {
      // Check if border treatment should be applied based on active property node types
      const nodeType = (attr.nodeType as string) || 'Unknown';
      const shouldHaveBorderTreatment =
        activePropertyNodeTypes.length > 0 && !activePropertyNodeTypes.includes(nodeType);

      if (shouldHaveBorderTreatment) {
        // Restore border treatment (faded with colored border)
        attr.type = 'border';
        attr.color = FADED_NODE_COLOR;
        // Get original color for border
        const typeColorMap = generateTypeColorMap(graph);
        attr.borderColor = typeColorMap.get(nodeType) || attr.borderColor;
      } else {
        // Normal circle rendering
        attr.type = 'circle';
      }
      attr.highlighted = false;
    }
    return attr;
  });
};

// Helper: Highlight edge and its extremity nodes
const highlightEdge = (graph: Graph<NodeAttributes, EdgeAttributes>, edgeId: string) => {
  graph.updateEdgeAttributes(edgeId, attr => {
    if (!attr.altColor) attr.altColor = attr.color;
    attr.color = HIGHLIGHTED_EDGE_COLOR;
    return attr;
  });
  for (const node of graph.extremities(edgeId)) {
    graph.updateNodeAttributes(node, attr => {
      attr.type = 'border';
      attr.highlighted = true;
      return attr;
    });
  }
};

// Helper: Clear edge highlighting and restore extremity nodes
const clearEdgeHighlight = (
  graph: Graph<NodeAttributes, EdgeAttributes>,
  edgeId: string,
  highlightedNodes: Set<string>,
  clickedNodes: Set<string>,
  activePropertyNodeTypes: string[],
) => {
  graph.updateEdgeAttributes(edgeId, attr => {
    attr.color = attr.altColor;
    return attr;
  });
  for (const node of graph.extremities(edgeId)) {
    restoreNodeType(graph, node, highlightedNodes, clickedNodes, activePropertyNodeTypes);
  }
};

/**
 * KnowledgeGraphEvents
 * Event handling for knowledge graph visualization
 */
export function KGGraphEvents({
  clickedNodesRef,
  highlightedNodesRef,
  selectionPluginRef,
}: {
  clickedNodesRef: React.RefObject<Set<string>>;
  highlightedNodesRef: React.RefObject<Set<string>>;
  selectionPluginRef?: React.RefObject<SelectionPluginHandle | null>;
}) {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();
  const registerEvents = useRegisterEvents();
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [clickedNode, setClickedNode] = useState<string | null>(null);
  const [clickedEdge, setClickedEdge] = useState<string | null>(null);
  const clickedEdgeRef = useRef<string | null>(null);
  const dragHappenedRef = useRef(false);
  const deferredSelectionFrameRef = useRef<number | null>(null);
  const nodeSearchQuery = useKGStore(state => state.nodeSearchQuery);
  const skipNextNodeSearchNavigation = useKGStore(state => state.skipNextNodeSearchNavigation);
  const activePropertyNodeTypes = useKGStore(state => state.activePropertyNodeTypes);
  const highlightNeighborNodes = useKGStore(state => state.highlightNeighborNodes);
  const nodeNameToIdTrie = useKGStore(state => state.nodeNameToIdTrie);
  const inspectedNodeId = useKGStore(state => state.inspectedNodeId);
  const inspectedEdgeId = useKGStore(state => state.inspectedEdgeId);
  const selectedNodes = useKGStore(state => state.selectedNodes);
  const selectedEdges = useKGStore(state => state.selectedEdges);
  const setGraphSelection = useKGStore(state => state.setGraphSelection);
  const setInspectedNodeId = useKGStore(state => state.setInspectedNodeId);
  const setInspectedEdgeId = useKGStore(state => state.setInspectedEdgeId);

  const { gotoNode } = useCamera();

  const syncSelection = (nodeIds: string[], edgeIds: string[] = []) => {
    const graph = sigma.getGraph();
    const normalized = normalizeGraphSelection(graph, { nodeIds, edgeIds });
    const previousEdgeIds = new Set(useKGStore.getState().selectedEdges);
    const nextEdgeIds = new Set(normalized.edgeIds);

    for (const edgeId of previousEdgeIds) {
      if (nextEdgeIds.has(edgeId) || !graph.hasEdge(edgeId)) {
        continue;
      }
      clearEdgeHighlight(
        graph,
        edgeId,
        highlightedNodesRef.current,
        clickedNodesRef.current,
        activePropertyNodeTypes,
      );
    }

    for (const edgeId of nextEdgeIds) {
      if (previousEdgeIds.has(edgeId) || !graph.hasEdge(edgeId)) {
        continue;
      }
      highlightEdge(graph, edgeId);
    }

    if (deferredSelectionFrameRef.current !== null) {
      window.cancelAnimationFrame(deferredSelectionFrameRef.current);
    }
    deferredSelectionFrameRef.current = window.requestAnimationFrame(() => {
      deferredSelectionFrameRef.current = null;
      setGraphSelection(normalized);
    });
    return normalized;
  };

  // Helper: Clear clicked node state and restore visual state
  const clearClickedNode = (nodeId: string) => {
    const graph = sigma.getGraph();
    clickedNodesRef.current.delete(nodeId);
    // Clear neighbors from clicked set and restore their state
    graph.forEachNeighbor(nodeId, (neighbor, _attr) => {
      clickedNodesRef.current.delete(neighbor);
      // Don't restore if it's in highlighted/searched nodes
      if (highlightedNodesRef.current.has(neighbor)) return;
      // Restore to appropriate type
      restoreNodeType(graph, neighbor, highlightedNodesRef.current, clickedNodesRef.current, activePropertyNodeTypes);
    });
    restoreNodeType(graph, nodeId, highlightedNodesRef.current, clickedNodesRef.current, activePropertyNodeTypes);
    setClickedNode(null);
    setInspectedNodeId(null);
    syncSelection([], []);
    sigma.refresh();
  };

  const applyManualSelection = (nodeIds: string[], edgeIds: string[] = []) => {
    const graph = sigma.getGraph();
    const normalized = syncSelection(nodeIds, edgeIds);
    const nextSelection = new Set(
      normalized.nodeIds.filter((nodeId) => graph.hasNode(nodeId) && !graph.getNodeAttribute(nodeId, 'hidden')),
    );
    const previousSelection = new Set(clickedNodesRef.current);

    for (const nodeId of previousSelection) {
      if (nextSelection.has(nodeId) || !graph.hasNode(nodeId)) {
        continue;
      }
      clickedNodesRef.current.delete(nodeId);
      restoreNodeType(graph, nodeId, highlightedNodesRef.current, clickedNodesRef.current, activePropertyNodeTypes);
    }

    for (const nodeId of nextSelection) {
      clickedNodesRef.current.add(nodeId);
      graph.updateNodeAttributes(nodeId, (attrs) => ({
        ...attrs,
        type: 'border',
        highlighted: true,
        zIndex: 120,
      }));
    }

    sigma.refresh();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: sigma is stable
  useEffect(() => {
    (sigma as EventEmitter).once('loaded', () => {
      if (graph.order === 0) return; // Graph not yet populated
      const nodeArr = graph.mapNodes((node, attributes) => ({
        key: attributes.label || node,
        value: node,
      })) as { key: string; value: string }[];
      if (!Array.isArray(nodeArr) || nodeArr.length === 0) return;
      useKGStore.setState({ nodeNameToIdTrie: Trie.fromArray(nodeArr, 'key') });
    });
  }, [sigma]);

  useEffect(() => {
    return () => {
      if (deferredSelectionFrameRef.current !== null) {
        window.cancelAnimationFrame(deferredSelectionFrameRef.current);
        deferredSelectionFrameRef.current = null;
      }
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: not needed
  useEffect(() => {
    const prefix = nodeSearchQuery.split(/[\n,]/).pop()?.trim() || '';
    if (prefix.length === 0) return;
    const suggestions = nodeNameToIdTrie.search(prefix).map(s => s.key);
    useKGStore.setState({ nodeSuggestions: suggestions });
  }, [nodeSearchQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nodeSearchQuery only needed
  useEffect(() => {
    const graph = sigma.getGraph();
    if (nodeNameToIdTrie.size === 0) return;
    const nodeIds = new Set(
      nodeSearchQuery
        .toUpperCase()
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => nodeNameToIdTrie.get(s)?.value || s)
        .filter(s => graph.hasNode(s)),
    ) as Set<string>;

    const previousHighlightedNodes = highlightedNodesRef.current;
    for (const node of previousHighlightedNodes) {
      if (nodeIds.has(node) || !graph.hasNode(node)) continue;
      graph.removeNodeAttribute(node, 'highlighted');
      if (!activePropertyNodeTypes.includes(graph.getNodeAttribute(node, 'nodeType') || 'Unknown')) {
        continue;
      }
      graph.setNodeAttribute(node, 'type', 'circle');
    }
    let lastValidNode: string | null = null;
    for (const node of nodeIds) {
      if (previousHighlightedNodes.has(node) || !graph.hasNode(node) || graph.getNodeAttribute(node, 'hidden') === true)
        continue;
      graph.setNodeAttribute(node, 'type', 'border');
      graph.setNodeAttribute(node, 'highlighted', true);
      lastValidNode = node;
    }

    // Navigate to the last successfully highlighted node
    if (lastValidNode && nodeIds.size === 1 && !skipNextNodeSearchNavigation) {
      gotoNode(lastValidNode, { duration: 100 });
    }
    highlightedNodesRef.current = nodeIds;
    if (skipNextNodeSearchNavigation) {
      useKGStore.setState({ skipNextNodeSearchNavigation: false });
    }
    // Force sigma refresh to update nodeReducer with new highlighted nodes
    sigma.refresh();
  }, [gotoNode, nodeSearchQuery, sigma, skipNextNodeSearchNavigation]);

  useEffect(() => {
    const graph = sigma.getGraph();
    if (!inspectedNodeId || !graph.hasNode(inspectedNodeId)) {
      return;
    }

    clickedEdgeRef.current = null;
    setClickedEdge(null);
    setClickedNode(inspectedNodeId);
    const nextNodeIds = selectedNodes.includes(inspectedNodeId) ? selectedNodes : [...selectedNodes, inspectedNodeId];
    applyManualSelection(nextNodeIds, selectedEdges);
  }, [inspectedNodeId, selectedNodes, selectedEdges, sigma]);

  useEffect(() => {
    const graph = sigma.getGraph();
    if (!inspectedEdgeId || !graph.hasEdge(inspectedEdgeId)) {
      return;
    }

    setClickedNode(null);
    clickedEdgeRef.current = inspectedEdgeId;
    setClickedEdge(inspectedEdgeId);
    const nextEdgeIds = selectedEdges.includes(inspectedEdgeId) ? selectedEdges : [...selectedEdges, inspectedEdgeId];
    applyManualSelection(selectedNodes, nextEdgeIds);
  }, [inspectedEdgeId, selectedNodes, selectedEdges, sigma]);

  // Register event handlers
  // biome-ignore lint/correctness/useExhaustiveDependencies: activePropertyNodeTypes read from store in callbacks
  useEffect(() => {
    const graph = sigma.getGraph();

    registerEvents({
      // Edge hover effects
      enterEdge: e => {
        highlightEdge(graph, e.edge);
      },
      leaveEdge: e => {
        if (clickedEdgeRef.current === e.edge) return;
        clearEdgeHighlight(
          graph,
          e.edge,
          highlightedNodesRef.current,
          clickedNodesRef.current,
          activePropertyNodeTypes,
        );
      },

      // Node drag and drop
      downNode: e => {
        // If selection mode active, don't allow node drag
        if (selectionPluginRef?.current?.isActive()) {
          return;
        }
        setDraggedNode(e.node);
      },

      mousemovebody: e => {
        // Handle selection plugin events first (if active)
        const selectionHandlers = selectionPluginRef?.current?.getEventHandlers();
        if (selectionHandlers) {
          dragHappenedRef.current = true; // Mark that drag happened
          selectionHandlers.mousemovebody(e);
          return; // Don't handle other events during selection
        }

        if (!draggedNode) return;

        // Update node position
        const pos = sigma.viewportToGraph(e);
        graph.setNodeAttribute(draggedNode, 'x', pos.x);
        graph.setNodeAttribute(draggedNode, 'y', pos.y);

        // Prevent camera movement
        e.preventSigmaDefault();
        e.original.preventDefault();
        e.original.stopPropagation();
      },

      mousedown: e => {
        // Handle selection plugin events (if active)
        const selectionHandlers = selectionPluginRef?.current?.getEventHandlers();
        if (selectionHandlers) {
          dragHappenedRef.current = false; // Reset drag flag
          selectionHandlers.mousedown(e);
          return; // Don't handle other events during selection
        }
      },

      mouseup: () => {
        // Handle selection plugin events first
        const selectionHandlers = selectionPluginRef?.current?.getEventHandlers();
        if (selectionHandlers) {
          selectionHandlers.mouseup();
          return; // Don't handle other events during selection
        }

        if (draggedNode) {
          setDraggedNode(null);
        }
      },

      clickStage: () => {
        const selectionHandlers = selectionPluginRef?.current?.getEventHandlers();
        if (selectionHandlers && dragHappenedRef.current) {
          dragHappenedRef.current = false;
          return;
        }

        if (clickedNode) {
          clearClickedNode(clickedNode);
          return;
        }

        const currentSelection = useKGStore.getState();
        if (clickedNodesRef.current.size > 0 || currentSelection.selectedEdges.length > 0) {
          applyManualSelection([], []);
          setInspectedNodeId(null);
          setInspectedEdgeId(null);
          clickedEdgeRef.current = null;
          setClickedEdge(null);
        }
      },

      // Node click - show popup with properties and connected edges
      clickNode: e => {
        // Prevent click if drag just happened during selection
        if (dragHappenedRef.current) {
          dragHappenedRef.current = false;
          return;
        }

        const appendSelection = e.event.original.ctrlKey || e.event.original.metaKey;

        clickedEdgeRef.current = null;
        setClickedEdge(null);
        setInspectedEdgeId(null);

        if (appendSelection) {
          setClickedNode(null);
          const { selectedNodes, selectedEdges } = useKGStore.getState();
          const nextSelection = selectedNodes.includes(e.node)
            ? selectedNodes.filter((nodeId) => nodeId !== e.node)
            : [...selectedNodes, e.node];
          applyManualSelection(nextSelection, selectedEdges);
          setInspectedNodeId(e.node);
          return;
        }

        setClickedNode((prevNode) => {
          if (prevNode === e.node) {
            applyManualSelection([], []);
            setInspectedNodeId(null);
            return null;
          }

          applyManualSelection([e.node], []);
          setInspectedNodeId(e.node);

          if (highlightNeighborNodes) {
            graph.forEachNeighbor(e.node, (neighbor, attr) => {
              clickedNodesRef.current.add(neighbor);
              attr.type = 'border';
              attr.highlighted = true;
            });
          }

          return e.node;
        });
      },

      // Edge click - show popup with source, edge, and target properties
      clickEdge: e => {
        setClickedNode(null);
        setInspectedNodeId(null);
        const appendSelection = e.event.original.ctrlKey || e.event.original.metaKey;
        const { selectedNodes, selectedEdges } = useKGStore.getState();

        if (appendSelection) {
          const nextEdges = selectedEdges.includes(e.edge)
            ? selectedEdges.filter((edgeId) => edgeId !== e.edge)
            : [...selectedEdges, e.edge];
          applyManualSelection(selectedNodes, nextEdges);
          if (nextEdges.includes(e.edge)) {
            clickedEdgeRef.current = e.edge;
            setClickedEdge(e.edge);
            setInspectedEdgeId(e.edge);
          } else {
            clickedEdgeRef.current = null;
            setClickedEdge(null);
            setInspectedEdgeId(null);
          }
        } else if (clickedEdgeRef.current === e.edge) {
          applyManualSelection([], []);
          clickedEdgeRef.current = null;
          setClickedEdge(null);
          setInspectedEdgeId(null);
        } else {
          applyManualSelection([], [e.edge]);
          clickedEdgeRef.current = e.edge;
          setClickedEdge(e.edge);
          setInspectedEdgeId(e.edge);
        }
      },
    });
  }, [registerEvents, sigma, draggedNode, clickedNode, clickedNodesRef]);

  // Prepare data for popups
  const graph = sigma.getGraph();

  const nodePopupData = clickedNode
    ? {
        id: clickedNode,
        attributes: graph.getNodeAttributes(clickedNode),
        connectedEdges: graph.edges(clickedNode).map(edge => ({
          edge,
          source: graph.source(edge),
          target: graph.target(edge),
          attributes: graph.getEdgeAttributes(edge),
        })),
      }
    : undefined;

  const edgePopupData = clickedEdge
    ? {
        edge: clickedEdge,
        source: graph.source(clickedEdge),
        target: graph.target(clickedEdge),
        sourceAttributes: graph.getNodeAttributes(graph.source(clickedEdge)),
        targetAttributes: graph.getNodeAttributes(graph.target(clickedEdge)),
        edgeAttributes: graph.getEdgeAttributes(clickedEdge),
      }
    : undefined;

  return (
    <>
      {clickedNode && nodePopupData && (
        <KGPopupTable
          type='node'
          nodeData={nodePopupData}
          onClose={() => {
            clearClickedNode(clickedNode);
            setInspectedNodeId(null);
          }}
        />
      )}
      {clickedEdge && edgePopupData && (
        <KGPopupTable
          type='edge'
          edgeData={edgePopupData}
          onClose={() => {
            applyManualSelection([], []);
            clickedEdgeRef.current = null;
            setClickedEdge(null);
            setInspectedEdgeId(null);
          }}
        />
      )}
    </>
  );
}
