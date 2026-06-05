import type EventEmitter from 'events';
import type Graph from 'graphology';
import type Sigma from 'sigma';
import { fitViewportToNodes } from '@sigma/utils';
import { applyKnowledgeGraphStyling, kgStatisticsGenerator } from '@/lib/graph';
import { useKGStore, useStore } from '@/lib/hooks';
import { NETWORK_STORAGE_KEYS } from '@/lib/interface/knowledge-graph';
import type { EdgeAttributes, NodeAttributes } from '@/lib/interface';
import { envURL, openDB } from '@/lib/utils';

export interface OptimusSearchResult {
  id: string;
  typeCode: string;
  typeName: string;
  displayName: string;
  matchedOn: string[];
}

export interface OptimusNodeSummary {
  id: string;
  typeCode: string;
  typeName: string;
  displayName: string;
  degree: number;
  properties: Record<string, unknown>;
}

export interface SerializedGraphPayload {
  attributes: Record<string, unknown>;
  options: {
    type: 'mixed';
    multi: true;
    allowSelfLoops: true;
  };
  nodes: Array<{
    key: string;
    attributes: Record<string, unknown>;
  }>;
  edges: Array<{
    key: string;
    source: string;
    target: string;
    attributes: Record<string, unknown>;
    undirected?: boolean;
  }>;
}

export interface OptimusPathResponse {
  found: boolean;
  graph: SerializedGraphPayload;
}

export interface OptimusGraphStats {
  nodeCount: number;
  edgeCount: number;
  nodeTypes: Array<{
    typeCode: string;
    typeName: string;
    count: number;
  }>;
  relationshipTypes: Array<{
    relation: string;
    count: number;
  }>;
}

const OPTIMUS_PATH_NODE_COLOR = '#f97316';
const OPTIMUS_PATH_EDGE_COLOR = '#ea580c';
const OPTIMUS_PREVIEW_NODE_COLOR = '#0ea5e9';
const OPTIMUS_PREVIEW_BORDER_COLOR = '#0369a1';
const VALID_NODE_TYPES = new Set<NodeAttributes['type']>(['circle', 'border', 'highlight', 'normal']);
const SIGMA_SAFE_NODE_TYPES = new Set<NodeAttributes['type']>(['border', 'highlight', 'normal']);

function apiBaseUrl() {
  return envURL(process.env.NEXT_PUBLIC_BACKEND_URL);
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`);
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`,
    );
  }

  if (responseText.trim().length === 0) {
    return null as T;
  }

  return JSON.parse(responseText) as T;
}

function mergeNode(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  key: string,
  attributes: Record<string, unknown>,
) {
  const normalizedAttributes = normalizeOptimusNodeAttributes(attributes);
  if (graph.hasNode(key)) {
    graph.mergeNodeAttributes(key, normalizedAttributes);
    return;
  }

  graph.addNode(key, normalizedAttributes);
}

function ensureVisibleNodePositions(graph: Graph<NodeAttributes, EdgeAttributes>) {
  const nodeIds = graph.nodes();
  if (nodeIds.length === 0) {
    return;
  }

  const positionedNodes = nodeIds.filter((nodeId) => {
    const x = graph.getNodeAttribute(nodeId, 'x');
    const y = graph.getNodeAttribute(nodeId, 'y');
    return Number.isFinite(x) && Number.isFinite(y);
  });

  const baseCenter =
    positionedNodes.length > 0
      ? positionedNodes.reduce(
          (acc, nodeId) => ({
            x: acc.x + Number(graph.getNodeAttribute(nodeId, 'x')),
            y: acc.y + Number(graph.getNodeAttribute(nodeId, 'y')),
          }),
          { x: 0, y: 0 },
        )
      : { x: 0, y: 0 };

  const centerX = positionedNodes.length > 0 ? baseCenter.x / positionedNodes.length : 0;
  const centerY = positionedNodes.length > 0 ? baseCenter.y / positionedNodes.length : 0;
  const radius = Math.max(8, Math.sqrt(nodeIds.length) * 6);

  nodeIds.forEach((nodeId, index) => {
    const x = graph.getNodeAttribute(nodeId, 'x');
    const y = graph.getNodeAttribute(nodeId, 'y');
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return;
    }

    const angle = (index / Math.max(nodeIds.length, 1)) * Math.PI * 2;
    graph.setNodeAttribute(nodeId, 'x', centerX + Math.cos(angle) * radius);
    graph.setNodeAttribute(nodeId, 'y', centerY + Math.sin(angle) * radius);
  });
}

function normalizeOptimusNodeAttributes(attributes: Record<string, unknown>) {
  const normalizedAttributes = { ...attributes };
  const nodeType = normalizedAttributes.type as NodeAttributes['type'] | undefined;
  if (!nodeType || !VALID_NODE_TYPES.has(nodeType)) {
    normalizedAttributes.type = 'border';
    return normalizedAttributes;
  }

  if (!SIGMA_SAFE_NODE_TYPES.has(nodeType)) {
    normalizedAttributes.type = 'border';
  }

  return normalizedAttributes;
}

function focusCameraOnNodes(
  sigma: Sigma<NodeAttributes, EdgeAttributes>,
  graph: Graph<NodeAttributes, EdgeAttributes>,
  nodeIds: string[],
) {
  const targetNodeIds = nodeIds.length > 0 ? nodeIds.filter((nodeId) => graph.hasNode(nodeId)) : graph.nodes();
  if (targetNodeIds.length === 0) {
    return;
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let sumX = 0;
  let sumY = 0;

  for (const nodeId of targetNodeIds) {
    const x = Number(graph.getNodeAttribute(nodeId, 'x'));
    const y = Number(graph.getNodeAttribute(nodeId, 'y'));

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    sumX += x;
    sumY += y;
  }

  const span = Math.max(maxX - minX, maxY - minY);
  const ratio = span > 0 ? Math.min(1.8, Math.max(0.25, span / 120)) : 0.6;

  sigma.getCamera().animate(
    {
      x: sumX / targetNodeIds.length,
      y: sumY / targetNodeIds.length,
      ratio,
    },
    { duration: 500 },
  );
}

export function focusOptimusNodes(
  sigma: Sigma<NodeAttributes, EdgeAttributes>,
  nodeIds: string[],
) {
  focusCameraOnNodes(sigma, sigma.getGraph(), nodeIds);
}

export function resetOptimusViewport(sigma: Sigma<NodeAttributes, EdgeAttributes>) {
  const graph = sigma.getGraph();
  const visibleNodes = graph.filterNodes((nodeId, attr) => !attr.hidden && graph.hasNode(nodeId));
  if (visibleNodes.length === 0) {
    return;
  }

  try {
    fitViewportToNodes(sigma, visibleNodes, { animate: true });
    return;
  } catch {
    focusCameraOnNodes(sigma, graph, visibleNodes);
  }
}

export function previewOptimusNode(
  sigma: Sigma<NodeAttributes, EdgeAttributes>,
  nodeId: string,
) {
  const graph = sigma.getGraph();
  if (!graph.hasNode(nodeId)) {
    return;
  }

  graph.updateNodeAttributes(nodeId, (attrs) => ({
    ...attrs,
    previewHighlighted: true,
    previewOriginalColor:
      typeof attrs.previewOriginalColor === 'string' ? attrs.previewOriginalColor : attrs.color,
    previewOriginalBorderColor:
      typeof attrs.previewOriginalBorderColor === 'string' ? attrs.previewOriginalBorderColor : attrs.borderColor,
    previewOriginalBorderSize:
      typeof attrs.previewOriginalBorderSize === 'number' ? attrs.previewOriginalBorderSize : attrs.borderSize,
    previewOriginalType:
      typeof attrs.previewOriginalType === 'string' ? attrs.previewOriginalType : attrs.type,
    color: OPTIMUS_PREVIEW_NODE_COLOR,
    borderColor: OPTIMUS_PREVIEW_BORDER_COLOR,
    borderSize: Math.max(Number(attrs.borderSize ?? 0.15), 0.22),
    type: 'border',
    highlighted: true,
    zIndex: Math.max(Number(attrs.zIndex ?? 0), 180),
  }));

  sigma.refresh();
}

export function clearPreviewOptimusNode(
  sigma: Sigma<NodeAttributes, EdgeAttributes>,
  nodeId: string,
) {
  const graph = sigma.getGraph();
  if (!graph.hasNode(nodeId)) {
    return;
  }

  graph.updateNodeAttributes(nodeId, (attrs) => ({
    ...attrs,
    color:
      typeof attrs.previewOriginalColor === 'string' ? attrs.previewOriginalColor : attrs.color,
    borderColor:
      typeof attrs.previewOriginalBorderColor === 'string'
        ? attrs.previewOriginalBorderColor
        : attrs.borderColor,
    borderSize:
      typeof attrs.previewOriginalBorderSize === 'number'
        ? attrs.previewOriginalBorderSize
        : attrs.borderSize,
    type:
      typeof attrs.previewOriginalType === 'string'
        ? (attrs.previewOriginalType as NodeAttributes['type'])
        : attrs.type,
    previewHighlighted: undefined,
    previewOriginalColor: undefined,
    previewOriginalBorderColor: undefined,
    previewOriginalBorderSize: undefined,
    previewOriginalType: undefined,
  }));

  sigma.refresh();
}

function mergeEdge(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  key: string,
  source: string,
  target: string,
  attributes: Record<string, unknown>,
  undirected = false,
) {
  if (graph.hasEdge(key)) {
    graph.mergeEdgeAttributes(key, attributes);
    return;
  }

  if (undirected) {
    graph.addUndirectedEdgeWithKey(key, source, target, attributes);
    return;
  }

  graph.addEdgeWithKey(key, source, target, attributes);
}

async function persistGraph(graph: Graph<NodeAttributes, EdgeAttributes>) {
  const store = await openDB('network', 'readwrite');
  if (!store) {
    return;
  }

  store.put(graph.export(), NETWORK_STORAGE_KEYS.KNOWLEDGE_GRAPH);
}

function resetKnowledgeGraphState() {
  useKGStore.setState((state) => ({
    activePropertyNodeTypes: [],
    nodePropertyData: {},
    kgPropertyOptions: {},
    selectedNodes: [],
    selectedEdges: [],
    inspectedNodeId: null,
    inspectedEdgeId: null,
    selectedNodeColorProperty: '',
    selectedNodeSizeProperty: '',
    selectedRadioNodeColor: undefined,
    selectedRadioNodeSize: undefined,
    nodeSearchQuery: '',
    nodeSuggestions: [],
    networkStatistics: {
      ...state.networkStatistics,
      totalNodes: 0,
      totalEdges: 0,
      avgDegree: 0,
      density: 0,
      diameter: 0,
      averageClusteringCoefficient: 0,
      degreeDistribution: null,
      edgeScoreDistribution: null,
      top10ByDegree: null,
      top10ByBetweenness: null,
      top10ByCloseness: null,
      top10ByEigenvector: null,
      top10ByPageRank: null,
    },
    statisticsComputed: false,
  }));

  useStore.setState({
    selectedRadioNodeColor: undefined,
    selectedRadioNodeSize: undefined,
    selectedNodeColorProperty: '',
    selectedNodeSizeProperty: '',
  });
}

async function finalizeGraph(
  sigma: Sigma<NodeAttributes, EdgeAttributes>,
  graph: Graph<NodeAttributes, EdgeAttributes>,
  highlightNodeIds: string[] = [],
) {
  ensureVisibleNodePositions(graph);
  await applyKnowledgeGraphStyling(graph);
  const statistics = kgStatisticsGenerator(graph);

  useKGStore.setState({
    statisticsComputed: true,
    nodeSearchQuery: highlightNodeIds.join(', '),
    networkStatistics: {
      ...useKGStore.getState().networkStatistics,
      totalNodes: graph.order,
      totalEdges: graph.size,
      ...statistics,
    },
  });

  sigma.refresh();
  if (highlightNodeIds.length > 0) {
    focusCameraOnNodes(sigma, graph, highlightNodeIds);
  } else {
    resetOptimusViewport(sigma);
  }
  (sigma as Sigma<NodeAttributes, EdgeAttributes> & EventEmitter).emit('loaded');
  await persistGraph(graph);
}

function clearPathHighlight(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  preserveNodeIds: Set<string> = new Set(),
  preserveEdgeIds: Set<string> = new Set(),
) {
  graph.forEachNode((nodeId, attrs) => {
    if (!attrs.pathHighlighted || preserveNodeIds.has(nodeId)) {
      return;
    }

    graph.updateNodeAttributes(nodeId, (nodeAttrs) => {
      const restoredType = VALID_NODE_TYPES.has(nodeAttrs.pathOriginalType as NodeAttributes['type'])
        ? (nodeAttrs.pathOriginalType as NodeAttributes['type'])
        : undefined;

      return {
        ...nodeAttrs,
        color:
          typeof nodeAttrs.pathOriginalColor === 'string'
            ? nodeAttrs.pathOriginalColor
            : nodeAttrs.color,
        borderColor:
          typeof nodeAttrs.pathOriginalBorderColor === 'string'
            ? nodeAttrs.pathOriginalBorderColor
            : undefined,
        borderSize:
          typeof nodeAttrs.pathOriginalBorderSize === 'number'
            ? nodeAttrs.pathOriginalBorderSize
            : undefined,
        size:
          typeof nodeAttrs.pathOriginalSize === 'number'
            ? nodeAttrs.pathOriginalSize
            : nodeAttrs.size,
        zIndex:
          typeof nodeAttrs.pathOriginalZIndex === 'number'
            ? nodeAttrs.pathOriginalZIndex
            : undefined,
        type: restoredType,
        highlighted: Boolean(nodeAttrs.originalHighlightedState),
        pathHighlighted: undefined,
        pathOriginalColor: undefined,
        pathOriginalBorderColor: undefined,
        pathOriginalBorderSize: undefined,
        pathOriginalSize: undefined,
        pathOriginalZIndex: undefined,
        pathOriginalType: undefined,
        originalHighlightedState: undefined,
      };
    });
  });

  graph.forEachEdge((edgeId, attrs) => {
    if (!attrs.pathHighlighted || preserveEdgeIds.has(edgeId)) {
      return;
    }

    graph.updateEdgeAttributes(edgeId, (edgeAttrs) => ({
      ...edgeAttrs,
      color:
        typeof edgeAttrs.pathOriginalColor === 'string'
          ? edgeAttrs.pathOriginalColor
          : edgeAttrs.color,
      size:
        typeof edgeAttrs.pathOriginalSize === 'number'
          ? edgeAttrs.pathOriginalSize
          : edgeAttrs.size,
      zIndex:
        typeof edgeAttrs.pathOriginalZIndex === 'number'
          ? edgeAttrs.pathOriginalZIndex
          : undefined,
      pathHighlighted: undefined,
      pathOriginalColor: undefined,
      pathOriginalSize: undefined,
      pathOriginalZIndex: undefined,
    }));
  });
}

export async function applyOptimusGraph(
  sigma: Sigma<NodeAttributes, EdgeAttributes>,
  payload: SerializedGraphPayload,
  mode: 'replace' | 'merge',
  highlightNodeIds: string[] = [],
) {
  const graph = sigma.getGraph();
  clearPathHighlight(graph);

  if (mode === 'replace') {
    graph.clear();
    resetKnowledgeGraphState();
    graph.replaceAttributes(payload.attributes);
  } else {
    graph.mergeAttributes(payload.attributes);
  }

  for (const node of payload.nodes) {
    mergeNode(graph, node.key, node.attributes);
  }

  for (const edge of payload.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      continue;
    }

    mergeEdge(graph, edge.key, edge.source, edge.target, edge.attributes, edge.undirected);
  }

  await finalizeGraph(sigma, graph, highlightNodeIds);
}

export function highlightOptimusPath(
  sigma: Sigma<NodeAttributes, EdgeAttributes>,
  nodeIds: string[],
  edgeIds: string[],
) {
  const graph = sigma.getGraph();
  const preservedNodes = new Set(nodeIds.filter((nodeId) => graph.hasNode(nodeId)));
  const preservedEdges = new Set(edgeIds.filter((edgeId) => graph.hasEdge(edgeId)));

  clearPathHighlight(graph, preservedNodes, preservedEdges);

  for (const nodeId of preservedNodes) {
    graph.updateNodeAttributes(nodeId, (attrs) => ({
      ...attrs,
      pathHighlighted: true,
      pathOriginalColor: typeof attrs.pathOriginalColor === 'string' ? attrs.pathOriginalColor : attrs.color,
      pathOriginalBorderColor:
        typeof attrs.pathOriginalBorderColor === 'string' ? attrs.pathOriginalBorderColor : attrs.borderColor,
      pathOriginalBorderSize:
        typeof attrs.pathOriginalBorderSize === 'number' ? attrs.pathOriginalBorderSize : attrs.borderSize,
      pathOriginalSize: typeof attrs.pathOriginalSize === 'number' ? attrs.pathOriginalSize : attrs.size,
      pathOriginalZIndex:
        typeof attrs.pathOriginalZIndex === 'number' ? attrs.pathOriginalZIndex : attrs.zIndex,
      pathOriginalType: typeof attrs.pathOriginalType === 'string' ? attrs.pathOriginalType : attrs.type,
      originalHighlightedState:
        typeof attrs.originalHighlightedState === 'boolean' ? attrs.originalHighlightedState : attrs.highlighted,
      color: OPTIMUS_PATH_NODE_COLOR,
      borderColor: OPTIMUS_PATH_EDGE_COLOR,
      borderSize: Math.max(Number(attrs.borderSize ?? 0.15), 0.2),
      size: Math.max(Number(attrs.size ?? 3), 5),
      type: 'border',
      highlighted: true,
      zIndex: 200,
    }));
  }

  for (const edgeId of preservedEdges) {
    graph.updateEdgeAttributes(edgeId, (attrs) => ({
      ...attrs,
      pathHighlighted: true,
      pathOriginalColor: typeof attrs.pathOriginalColor === 'string' ? attrs.pathOriginalColor : attrs.color,
      pathOriginalSize: typeof attrs.pathOriginalSize === 'number' ? attrs.pathOriginalSize : attrs.size,
      pathOriginalZIndex:
        typeof attrs.pathOriginalZIndex === 'number' ? attrs.pathOriginalZIndex : attrs.zIndex,
      color: OPTIMUS_PATH_EDGE_COLOR,
      size: Math.max(Number(attrs.size ?? 1), 3),
      zIndex: 200,
    }));
  }

  sigma.refresh();
}

export async function clearRenderedKnowledgeGraph(sigma: Sigma<NodeAttributes, EdgeAttributes>) {
  const graph = sigma.getGraph();
  graph.clear();
  graph.replaceAttributes({});
  resetKnowledgeGraphState();
  sigma.refresh();
  await clearPersistedKnowledgeGraph();
}

export function clearPersistedKnowledgeGraph() {
  return openDB('network', 'readwrite').then((store) => {
    if (!store) {
      return;
    }

    store.delete(NETWORK_STORAGE_KEYS.KNOWLEDGE_GRAPH);
  });
}

export async function fetchOptimusStats() {
  return fetchJson<OptimusGraphStats>('/optimus/stats');
}

export async function fetchRandomOptimusNode() {
  return fetchJson<OptimusNodeSummary | null>('/optimus/random');
}

export async function searchOptimusNodes(query: string, limit = 10, nodeTypes: string[] = []) {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  if (nodeTypes.length > 0) {
    params.set('nodeTypes', nodeTypes.join(','));
  }

  return fetchJson<OptimusSearchResult[]>(`/optimus/search?${params.toString()}`);
}

export async function fetchOptimusSubgraph(
  nodeId: string,
  options: {
    radius: number;
    maxNodes: number;
    degreeLimit: number;
  },
) {
  const params = new URLSearchParams({
    nodeId,
    radius: String(options.radius),
    maxNodes: String(options.maxNodes),
    degreeLimit: String(options.degreeLimit),
  });

  return fetchJson<SerializedGraphPayload>(`/optimus/subgraph?${params.toString()}`);
}

export async function fetchOptimusExpansion(
  nodeIds: string[],
  options: {
    hops: number;
    maxNodes: number;
    degreeLimit: number;
  },
) {
  const params = new URLSearchParams({
    nodeIds: nodeIds.join(','),
    hops: String(options.hops),
    maxNodes: String(options.maxNodes),
    degreeLimit: String(options.degreeLimit),
  });

  return fetchJson<SerializedGraphPayload>(`/optimus/expand?${params.toString()}`);
}

export async function fetchOptimusShortestPath(
  sourceId: string,
  targetId: string,
  maxDepth: number,
) {
  const params = new URLSearchParams({
    sourceId,
    targetId,
    maxDepth: String(maxDepth),
  });

  return fetchJson<OptimusPathResponse>(`/optimus/path?${params.toString()}`);
}
