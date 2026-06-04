import type Graph from 'graphology';
import type { EdgeAttributes, NodeAttributes } from '@/lib/interface';

export interface GraphSelectionSnapshot {
  nodeIds: string[];
  edgeIds: string[];
}

const MAX_SELECTED_NODE_COUNT = 160;
const MAX_SELECTED_EDGE_COUNT = 256;

function isVisibleNode(graph: Graph<NodeAttributes, EdgeAttributes>, nodeId: string) {
  return graph.hasNode(nodeId) && graph.getNodeAttribute(nodeId, 'hidden') !== true;
}

function isVisibleEdge(graph: Graph<NodeAttributes, EdgeAttributes>, edgeId: string) {
  return graph.hasEdge(edgeId) && graph.getEdgeAttribute(edgeId, 'hidden') !== true;
}

export function deriveEdgeSelectionFromNodes(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  nodeIds: string[],
  limit = MAX_SELECTED_EDGE_COUNT,
) {
  const selectedNodeSet = new Set(nodeIds.filter((nodeId) => isVisibleNode(graph, nodeId)));
  const edgeIds: string[] = [];

  if (selectedNodeSet.size < 2) {
    return edgeIds;
  }

  graph.forEachEdge((edgeId, attributes, source, target) => {
    if (edgeIds.length >= limit || attributes.hidden === true) {
      return;
    }

    if (selectedNodeSet.has(source) && selectedNodeSet.has(target)) {
      edgeIds.push(edgeId);
    }
  });

  return edgeIds;
}

export function normalizeGraphSelection(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  selection: Partial<GraphSelectionSnapshot>,
): GraphSelectionSnapshot {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  for (const nodeId of selection.nodeIds ?? []) {
    if (isVisibleNode(graph, nodeId)) {
      nodeIds.add(nodeId);
    }
  }

  for (const edgeId of selection.edgeIds ?? []) {
    if (!isVisibleEdge(graph, edgeId)) {
      continue;
    }

    edgeIds.add(edgeId);
    const source = graph.source(edgeId);
    const target = graph.target(edgeId);

    if (isVisibleNode(graph, source)) {
      nodeIds.add(source);
    }
    if (isVisibleNode(graph, target)) {
      nodeIds.add(target);
    }
  }

  if (edgeIds.size === 0 && nodeIds.size > 1) {
    for (const edgeId of deriveEdgeSelectionFromNodes(graph, [...nodeIds], MAX_SELECTED_EDGE_COUNT)) {
      edgeIds.add(edgeId);
      if (edgeIds.size >= MAX_SELECTED_EDGE_COUNT) {
        break;
      }
    }
  }

  return {
    nodeIds: [...nodeIds].slice(0, MAX_SELECTED_NODE_COUNT),
    edgeIds: [...edgeIds].slice(0, MAX_SELECTED_EDGE_COUNT),
  };
}
