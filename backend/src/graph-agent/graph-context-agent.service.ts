import { Injectable } from '@nestjs/common';
import type {
  ConversationGraphState,
  GraphContextResult,
  GraphNetworkContext,
  GraphSelectionEdgeContext,
  GraphSelectionNodeContext,
  QueryRoute,
} from './graph-agent.types';

const SELECTION_REFERENCE_PATTERNS = [
  /\bthis node\b/i,
  /\bthese nodes\b/i,
  /\bthis gene\b/i,
  /\bthese genes\b/i,
  /\bthis protein\b/i,
  /\bthese proteins\b/i,
  /\bthis disease\b/i,
  /\bthese diseases\b/i,
  /\bthis pathway\b/i,
  /\bthese pathways\b/i,
  /\bthis drug\b/i,
  /\bthese drugs\b/i,
  /\bselected nodes\b/i,
  /\bselected graph\b/i,
  /\bselected proteins\b/i,
  /\bselected genes\b/i,
  /\bthem\b/i,
  /\bthose\b/i,
];

const EDGE_REFERENCE_PATTERNS = [
  /\bthis edge\b/i,
  /\bthese edges\b/i,
  /\bthis relationship\b/i,
  /\bthese relationships\b/i,
  /\bselected edges\b/i,
  /\bhighlighted edges\b/i,
];

const VISIBLE_GRAPH_PATTERNS = [
  /\bcurrent graph\b/i,
  /\bcurrent network\b/i,
  /\bvisible graph\b/i,
  /\bvisible network\b/i,
  /\bthis subgraph\b/i,
  /\bthe subgraph\b/i,
];

@Injectable()
export class GraphContextAgentService {
  build(params: {
    query: string;
    queryRoute: QueryRoute;
    selectedNodeContext: GraphSelectionNodeContext[];
    selectedEdgeContext: GraphSelectionEdgeContext[];
    networkContext?: GraphNetworkContext;
    state: ConversationGraphState;
  }): GraphContextResult {
    const { query, queryRoute, selectedNodeContext, selectedEdgeContext, networkContext, state } = params;
    const selectedNodeTypes = Array.from(
      new Set(selectedNodeContext.map((node) => node.nodeType).filter((value): value is string => Boolean(value))),
    ).sort((a, b) => a.localeCompare(b));
    const selectedEdgeTypes = Array.from(
      new Set(selectedEdgeContext.map((edge) => edge.relation).filter((value): value is string => Boolean(value))),
    ).sort((a, b) => a.localeCompare(b));
    const graphReferences = {
      referencesSelection: SELECTION_REFERENCE_PATTERNS.some((pattern) => pattern.test(query)),
      referencesNodes: /\bnodes?\b/i.test(query),
      referencesEdges: EDGE_REFERENCE_PATTERNS.some((pattern) => pattern.test(query)),
      referencesVisibleGraph: VISIBLE_GRAPH_PATTERNS.some((pattern) => pattern.test(query)),
      referencesSessionGraph: /\bsession graph\b|\bprevious graph\b|\bprior graph\b/i.test(query),
    };

    const activeAnchors = this.pickActiveAnchors({
      queryRoute,
      graphReferences,
      selectedNodeContext,
      state,
    });

    return {
      activeAnchors,
      graphScope: {
        mode: this.pickGraphScopeMode({
          activeAnchors,
          graphReferences,
          networkContext,
          state,
        }),
        selectedNodeCount: selectedNodeContext.length,
        selectedEdgeCount: selectedEdgeContext.length,
        visibleNodeCount: networkContext?.totalNodes ?? state.visibleNodeIds.length,
        visibleEdgeCount: networkContext?.totalEdges ?? state.visibleEdgeIds.length,
      },
      graphReferences,
      selectedNodeTypes,
      selectedEdgeTypes,
    };
  }

  private pickActiveAnchors(params: {
    queryRoute: QueryRoute;
    graphReferences: GraphContextResult['graphReferences'];
    selectedNodeContext: GraphSelectionNodeContext[];
    state: ConversationGraphState;
  }): GraphSelectionNodeContext[] {
    const { queryRoute, graphReferences, selectedNodeContext, state } = params;

    if (
      selectedNodeContext.length > 0 &&
      (
        queryRoute.category === 'GRAPH_QUERY' ||
        queryRoute.category === 'MIXED_QUERY' ||
        graphReferences.referencesSelection ||
        graphReferences.referencesNodes
      )
    ) {
      return selectedNodeContext;
    }

    if (
      selectedNodeContext.length === 0 &&
      (graphReferences.referencesSelection || graphReferences.referencesSessionGraph) &&
      state.selectedNodeIds.length > 0
    ) {
      const entityById = new Map(state.activeEntities.map((entity) => [entity.id, entity]));
      const fallbackAnchors: GraphSelectionNodeContext[] = [];

      for (const nodeId of state.selectedNodeIds) {
        const entity = entityById.get(nodeId);
        if (!entity) {
          continue;
        }

        fallbackAnchors.push({
          id: entity.id,
          label: entity.displayName,
          nodeType: entity.typeName,
        });
      }

      return fallbackAnchors.slice(0, 12);
    }

    return [];
  }

  private pickGraphScopeMode(params: {
    activeAnchors: GraphSelectionNodeContext[];
    graphReferences: GraphContextResult['graphReferences'];
    networkContext?: GraphNetworkContext;
    state: ConversationGraphState;
  }): GraphContextResult['graphScope']['mode'] {
    const { activeAnchors, graphReferences, networkContext, state } = params;

    if (activeAnchors.length > 0) {
      return 'selection';
    }
    if (graphReferences.referencesVisibleGraph && ((networkContext?.totalNodes ?? 0) > 0 || state.visibleNodeIds.length > 0)) {
      return 'visible-subgraph';
    }
    if (graphReferences.referencesSessionGraph && state.activeEntities.length > 0) {
      return 'session';
    }

    return 'none';
  }
}
