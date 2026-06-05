import { Injectable } from '@nestjs/common';
import type {
  ConversationGraphState,
  ExtractedQuery,
  GraphContextResult,
  QueryIntentClassification,
  QueryRoute,
  ResolvedEntity,
  RetrievalExecutor,
  RetrievalOperation,
  RetrievalPlanStep,
} from './graph-agent.types';
import { createStepId } from './graph-agent.utils';

@Injectable()
export class RetrievalPlanningAgentService {
  plan(params: {
    query: string;
    queryRoute: QueryRoute;
    graphContext: GraphContextResult;
    intent: QueryIntentClassification;
    extractedQuery: ExtractedQuery;
    resolvedEntities: ResolvedEntity[];
    state: ConversationGraphState;
  }): RetrievalPlanStep[] {
    const { query, queryRoute, graphContext, intent, extractedQuery, resolvedEntities, state } = params;
    const normalized = query.toLowerCase();
    const explicitEntities = resolvedEntities.filter((entity) => entity.source !== 'concept');
    const conceptResolvedEntities = resolvedEntities.filter((entity) => entity.source === 'concept');
    const seedEntities = this.pickSeedEntities(explicitEntities, extractedQuery, queryRoute);
    const aggregateMode = this.pickAggregateMode(query, extractedQuery);
    const contextAnchors = this.pickContextAnchors({
      query,
      intent,
      extractedQuery,
      explicitEntities,
      conceptResolvedEntities,
      state,
      selectedIds: new Set(graphContext.activeAnchors.map((node) => node.id)),
    });
    const primary = explicitEntities[0] ?? conceptResolvedEntities[0] ?? contextAnchors[0];
    const secondary = this.pickSecondaryEntity({
      query,
      intent,
      explicitEntities,
      primary,
      contextAnchors,
    });
    const detailNodeIds = Array.from(
      new Set([primary?.id, secondary?.id].filter((nodeId): nodeId is string => Boolean(nodeId))),
    );
    const expansionSeedNodeIds = this.pickExpansionSeeds(resolvedEntities, primary, state, graphContext);
    const expansionNodeTypes = this.pickExpansionNodeTypes(query, intent, resolvedEntities);
    const graphNodeIds = seedEntities.map((entity) => entity.id).slice(0, 120);
    const mixedGraphNodeIds = Array.from(
      new Set(
        [
          ...graphNodeIds,
          ...explicitEntities.map((entity) => entity.id),
          ...conceptResolvedEntities.map((entity) => entity.id),
          ...contextAnchors.map((entity) => entity.id),
        ].filter((nodeId) => nodeId.length > 0),
      ),
    ).slice(0, 120);
    const graphAnalysisNodeIds = queryRoute.category === 'MIXED_QUERY' ? mixedGraphNodeIds : graphNodeIds;
    const graphAnalysisEdgeIds = graphContext.selectedEdges.map((edge) => edge.id).slice(0, 240);
    const visibleGraphNodeIds = graphContext.visibleNodeIds.slice(0, 2000);
    const visibleGraphEdgeIds = graphContext.visibleEdgeIds.slice(0, 5000);
    const graphAnalysisScope = this.pickGraphAnalysisScope({
      selectedNodeIds: graphAnalysisNodeIds,
      selectedEdgeIds: graphAnalysisEdgeIds,
      visibleNodeIds: visibleGraphNodeIds,
      visibleEdgeIds: visibleGraphEdgeIds,
      state,
    });
    const ontologyRootId =
      primary?.id ??
      graphContext.activeAnchors[0]?.id ??
      graphContext.visibleNodes[0]?.id ??
      state.activeEntities[0]?.id;
    const enrichmentSeedNodeIds = Array.from(
      new Set(
        [
          ...graphAnalysisScope.nodeIds,
          ...seedEntities.map((entity) => entity.id),
          ...explicitEntities.map((entity) => entity.id),
          ...contextAnchors.map((entity) => entity.id),
        ].filter((nodeId) => nodeId.length > 0),
      ),
    ).slice(0, 64);

    if (normalized.includes('cypher') || normalized.includes('query language')) {
      return [
        this.createStep({
          prefix: 'guarded-cypher',
          intent: 'guarded-cypher',
          operation: 'execute-custom-cypher',
          executor: 'cypher-agent',
          tool: 'executeGuardedCypher',
          description: 'Run a validated read-only Cypher query.',
          params: { userQuery: query },
        }),
      ];
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'schema-analysis' &&
      graphAnalysisScope.nodeIds.length > 0
    ) {
      const schemaOperation = this.pickSchemaAnalysisOperation(query, intent);
      return [
        this.createStep({
          prefix: 'schema-analysis',
          intent: 'schema-analysis',
          operation: schemaOperation.operation,
          executor: 'graph-analysis',
          tool: schemaOperation.tool,
          description: `${schemaOperation.description} using the ${graphAnalysisScope.label}.`,
          params: {
            nodeIds: graphAnalysisScope.nodeIds,
            edgeIds: graphAnalysisScope.edgeIds,
            targetTypes: schemaOperation.targetTypes,
            title: schemaOperation.title,
          },
        }),
      ];
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'graph-relationship-analysis' &&
      graphAnalysisScope.nodeIds.length > 0
    ) {
      const relationshipOperation = this.pickRelationshipAnalysisOperation(query, intent);
      return [
        this.createStep({
          prefix: 'relationship-analysis',
          intent: 'graph-relationship-analysis',
          operation: relationshipOperation.operation,
          executor: 'graph-analysis',
          tool: relationshipOperation.tool,
          description: `${relationshipOperation.description} within the ${graphAnalysisScope.label}.`,
          params: {
            nodeIds: graphAnalysisScope.nodeIds,
            edgeIds: graphAnalysisScope.edgeIds,
            sourceTypes: relationshipOperation.sourceTypes,
            targetTypes: relationshipOperation.targetTypes,
            title: relationshipOperation.title,
          },
        }),
      ];
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'network-statistics' &&
      graphAnalysisScope.nodeIds.length > 0
    ) {
      const operations = this.pickNetworkStatisticsOperations(query);
      return operations.map((operation) =>
        this.createStep({
          prefix: `network-statistics-${operation.operation}`,
          intent: 'network-statistics',
          operation: operation.operation,
          executor: 'graph-analysis',
          tool: operation.tool,
          description: `${operation.description} for the ${graphAnalysisScope.label}.`,
          params: {
            nodeIds: graphAnalysisScope.nodeIds,
            edgeIds: graphAnalysisScope.edgeIds,
          },
        }),
      );
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'community-detection' &&
      graphAnalysisScope.nodeIds.length > 0
    ) {
      const communityOperation = this.pickCommunityDetectionOperation(query, intent);
      return [
        this.createStep({
          prefix: 'community-detection',
          intent: 'community-detection',
          operation: communityOperation.operation,
          executor: 'graph-analysis',
          tool: communityOperation.tool,
          description: `${communityOperation.description} in the ${graphAnalysisScope.label}.`,
          params: {
            nodeIds: graphAnalysisScope.nodeIds,
            edgeIds: graphAnalysisScope.edgeIds,
            focusTypes: communityOperation.focusTypes,
            title: communityOperation.title,
          },
        }),
      ];
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'graph-explanation' &&
      graphAnalysisScope.nodeIds.length > 0
    ) {
      const explanationOperation = this.pickGraphExplanationOperation(query);
      return [
        this.createStep({
          prefix: 'graph-explanation',
          intent: 'graph-explanation',
          operation: explanationOperation.operation,
          executor: 'graph-analysis',
          tool: explanationOperation.tool,
          description: `${explanationOperation.description} for the ${graphAnalysisScope.label}.`,
          params: {
            nodeIds: graphAnalysisScope.nodeIds,
            edgeIds: graphAnalysisScope.edgeIds,
          },
        }),
      ];
    }

    if (intent.operation === 'ontology-analysis' && ontologyRootId) {
      const ontologyOperation = this.pickOntologyOperation(query);
      return [
        this.createStep({
          prefix: 'ontology-analysis',
          intent: 'ontology-analysis',
          operation: ontologyOperation.operation,
          executor: 'graph-analysis',
          tool: ontologyOperation.tool,
          description: `${ontologyOperation.description} starting from the ontology anchor.`,
          params: {
            rootId: ontologyRootId,
            maxDepth: ontologyOperation.maxDepth,
            direction: ontologyOperation.direction,
            title: ontologyOperation.title,
          },
        }),
      ];
    }

    if (intent.operation === 'enrichment-analysis' && enrichmentSeedNodeIds.length > 0) {
      const enrichmentOperation = this.pickEnrichmentOperation(query, intent);
      return [
        this.createStep({
          prefix: 'enrichment-analysis',
          intent: 'enrichment-analysis',
          operation: enrichmentOperation.operation,
          executor: 'graph-analysis',
          tool: enrichmentOperation.tool,
          description: `${enrichmentOperation.description} from the current seed set.`,
          params: {
            nodeIds: enrichmentSeedNodeIds,
            limit: 20,
          },
        }),
      ];
    }

    if (intent.operation === 'exposure-analysis') {
      if (primary) {
        const exposureOperation = this.pickExposureOperation(query, intent);
        return [
          this.createStep({
            prefix: 'entity-details',
            intent: 'exposure-analysis',
            operation: 'load-node-details',
            executor: 'retrieval-operations',
            tool: 'getNodeDetails',
            description: `Load metadata for ${primary.displayName}.`,
            params: {
              nodeIds: [primary.id],
            },
          }),
          this.createStep({
            prefix: 'exposure-analysis',
            intent: 'exposure-analysis',
            operation: exposureOperation.operation,
            executor: 'retrieval-operations',
            tool: exposureOperation.tool,
            description: exposureOperation.description.replace('{entity}', primary.displayName),
            params: {
              nodeId: primary.id,
              relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
              limit: 20,
            },
          }),
        ];
      }

      if (graphAnalysisScope.nodeIds.length > 0) {
        return [
          this.createStep({
            prefix: 'exposure-node-analysis',
            intent: 'exposure-analysis',
            operation: 'analyze-exposures',
            executor: 'graph-analysis',
            tool: 'analyzeExposures',
            description: `Analyze exposure nodes present in the ${graphAnalysisScope.label}.`,
            params: {
              nodeIds: graphAnalysisScope.nodeIds,
              edgeIds: graphAnalysisScope.edgeIds,
            },
          }),
        ];
      }
    }

    if (intent.operation === 'drug-discovery') {
      if (seedEntities.length > 0 && seedEntities.every((entity) => /(gene|protein)/i.test(entity.typeName))) {
        return [
          this.createStep({
            prefix: 'entity-details',
            intent: 'drug-discovery',
            operation: 'load-node-details',
            executor: 'retrieval-operations',
            tool: 'getNodeDetails',
            description: `Load metadata for ${seedEntities.length} selected or resolved entities.`,
            params: {
              nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
            },
          }),
          this.createStep({
            prefix: 'drug-discovery-related',
            intent: 'drug-discovery',
            operation: 'get-related-drugs',
            executor: 'retrieval-operations',
            tool: 'getRelatedEntities',
            description: `Find drug candidates connected to ${seedEntities.map((entity) => entity.displayName).join(', ')}.`,
            params: {
              nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
              aggregateMode,
              minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
              relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
              limit: 20,
            },
          }),
        ];
      }

      if (primary) {
        const drugDiscoveryOperation = this.pickDrugDiscoveryOperation(query, primary);
        return [
          this.createStep({
            prefix: 'entity-details',
            intent: 'drug-discovery',
            operation: 'load-node-details',
            executor: 'retrieval-operations',
            tool: 'getNodeDetails',
            description: `Load metadata for ${primary.displayName}.`,
            params: {
              nodeIds: [primary.id],
            },
          }),
          this.createStep({
            prefix: 'drug-discovery',
            intent: 'drug-discovery',
            operation: drugDiscoveryOperation.operation,
            executor: 'retrieval-operations',
            tool: drugDiscoveryOperation.tool,
            description: drugDiscoveryOperation.description.replace('{entity}', primary.displayName),
            params: {
              nodeId: primary.id,
              relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
              limit: 20,
            },
          }),
        ];
      }
    }

    if ((queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') && intent.operation === 'graph-summary') {
      if (graphAnalysisNodeIds.length > 0) {
        const steps: RetrievalPlanStep[] = [
          this.createStep({
            prefix: 'graph-summary',
            intent: 'graph-summary',
            operation: 'summarize-selected-nodes',
            executor: 'graph-analysis',
            tool: 'summarizeNodes',
            description:
              graphAnalysisEdgeIds.length > 0
                ? `Summarize the selected graph with ${graphAnalysisNodeIds.length} node${graphAnalysisNodeIds.length === 1 ? '' : 's'} and ${graphAnalysisEdgeIds.length} edge${graphAnalysisEdgeIds.length === 1 ? '' : 's'}.`
                : `Summarize ${graphAnalysisNodeIds.length} graph-selected or graph-referenced node${graphAnalysisNodeIds.length === 1 ? '' : 's'}.`,
            params: {
              nodeIds: graphAnalysisNodeIds,
              edgeIds: graphAnalysisEdgeIds,
              selectedNodeCount: graphContext.graphScope.selectedNodeCount,
              selectedEdgeCount: graphContext.graphScope.selectedEdgeCount,
            },
          }),
        ];

        if (/\bhubs?\b|\bcentral\b/.test(normalized)) {
          steps.push(
            this.createStep({
              prefix: 'graph-hubs',
              intent: 'graph-summary',
              operation: 'find-hub-nodes',
              executor: 'graph-analysis',
              tool: 'findHubNodes',
              description: 'Identify hub and central nodes in the current graph context.',
              params: {
                nodeIds: graphAnalysisNodeIds,
              },
            }),
          );
        }

        if (/\bclusters?\b|\bcomponents?\b|\btopology\b/.test(normalized)) {
          steps.push(
            this.createStep({
              prefix: 'graph-clusters',
              intent: 'graph-summary',
              operation: 'analyze-cluster',
              executor: 'graph-analysis',
              tool: 'analyzeCluster',
              description: 'Analyze cluster structure and component topology in the current graph context.',
              params: {
                nodeIds: graphAnalysisNodeIds,
              },
            }),
          );
        }

        return steps;
      }

      if (
        graphContext.graphScope.mode === 'visible-subgraph' ||
        visibleGraphNodeIds.length > 0 ||
        state.visibleNodeIds.length > 0
      ) {
        const nodeIds = visibleGraphNodeIds.length > 0 ? visibleGraphNodeIds : state.visibleNodeIds;
        const edgeIds = visibleGraphEdgeIds.length > 0 ? visibleGraphEdgeIds : state.visibleEdgeIds;
        const steps: RetrievalPlanStep[] = [
          this.createStep({
            prefix: 'subgraph-summary',
            intent: 'graph-summary',
            operation: 'summarize-visible-subgraph',
            executor: 'graph-analysis',
            tool: 'summarizeSubgraph',
            description: 'Summarize the currently visible subgraph.',
            params: {
              nodeIds,
              edgeIds,
            },
          }),
        ];

        if (/\bhubs?\b|\bcentral\b|\bdominant\b/.test(normalized)) {
          steps.push(
            this.createStep({
              prefix: 'visible-graph-hubs',
              intent: 'graph-summary',
              operation: 'find-hub-nodes',
              executor: 'graph-analysis',
              tool: 'findHubNodes',
              description: 'Identify hub and central nodes in the visible graph.',
              params: {
                nodeIds,
              },
            }),
          );
        }

        if (/\bclusters?\b|\bcomponents?\b|\btopology\b/.test(normalized)) {
          steps.push(
            this.createStep({
              prefix: 'visible-graph-clusters',
              intent: 'graph-summary',
              operation: 'analyze-cluster',
              executor: 'graph-analysis',
              tool: 'analyzeCluster',
              description: 'Analyze cluster structure and components in the visible graph.',
              params: {
                nodeIds,
              },
            }),
          );
        }

        return steps;
      }
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'graph-comparison' &&
      graphAnalysisNodeIds.length >= 2
    ) {
      return [
        this.createStep({
          prefix: 'graph-comparison',
          intent: 'graph-comparison',
          operation: 'compare-nodes',
          executor: 'graph-analysis',
          tool: 'compareNodes',
          description: `Compare ${graphAnalysisNodeIds.length} selected or graph-referenced nodes.`,
          params: {
            nodeIds: graphAnalysisNodeIds.slice(0, 6),
          },
        }),
      ];
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'graph-commonality' &&
      graphAnalysisNodeIds.length >= 2
    ) {
      const operation = this.pickCommonalityOperation(query, seedEntities, intent);
      return [
        this.createStep({
          prefix: 'graph-commonality',
          intent: 'graph-commonality',
          operation,
          executor: 'graph-analysis',
          tool: this.mapGraphAnalysisTool(operation),
          description: `Find shared graph structure across ${graphAnalysisNodeIds.length} selected or graph-referenced anchors.`,
          params: {
            nodeIds: graphAnalysisNodeIds.slice(0, 8),
            targetTypes: intent.requestedEntityTypes,
            minSupport: this.pickMinimumSupport(graphAnalysisNodeIds.length, 'shared'),
            limit: 20,
          },
        }),
      ];
    }

    if (
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') &&
      intent.operation === 'graph-connections' &&
      graphAnalysisNodeIds.length >= 2
    ) {
      return [
        this.createStep({
          prefix: 'graph-connections',
          intent: 'graph-connections',
          operation: 'explain-connections',
          executor: 'graph-analysis',
          tool: 'explainConnections',
          description: `Explain how ${graphAnalysisNodeIds.length} selected or graph-referenced nodes are connected.`,
          params: {
            nodeIds: graphAnalysisNodeIds.slice(0, 6),
            maxDepth: 5,
          },
        }),
      ];
    }

    if (queryRoute.category === 'GRAPH_QUERY' && graphNodeIds.length > 0) {
      return [
        this.createStep({
          prefix: 'graph-selection-details',
          intent: 'graph-summary',
          operation: 'summarize-selected-nodes',
          executor: 'graph-analysis',
          tool: 'summarizeNodes',
            description: `Summarize ${graphNodeIds.length} graph-selected node${graphNodeIds.length === 1 ? '' : 's'}.`,
            params: {
              nodeIds: graphNodeIds,
              edgeIds: graphAnalysisEdgeIds,
              selectedNodeCount: graphContext.graphScope.selectedNodeCount,
              selectedEdgeCount: graphContext.graphScope.selectedEdgeCount,
            },
          }),
        ];
    }

    if (intent.operation === 'path-search' && primary && secondary && primary.id !== secondary.id) {
      return [
        this.createStep({
          prefix: 'entity-details',
          intent: 'relationship-analysis',
          operation: 'load-node-details',
          executor: 'retrieval-operations',
          tool: 'getNodeDetails',
          description: `Load metadata for ${detailNodeIds.length} resolved entities.`,
          params: {
            nodeIds: detailNodeIds,
          },
        }),
        this.createStep({
          prefix: 'relationship-evidence',
          intent: 'relationship-analysis',
          operation: 'retrieve-relationship-evidence',
          executor: 'retrieval-operations',
          tool: 'retrieveEvidence',
          description: `Retrieve direct and shared graph evidence between ${primary.displayName} and ${secondary.displayName}.`,
          params: {
            sourceId: primary.id,
            targetId: secondary.id,
            commonNeighborTypes: ['Gene', 'Protein', 'Pathway', 'Drug', 'Disease', 'Phenotype'],
            limit: 8,
          },
        }),
        this.createStep({
          prefix: 'shortest-path',
          intent: 'shortest-path',
          operation: 'find-shortest-path',
          executor: 'retrieval-operations',
          tool: 'shortestPath',
          description: `Find the shortest explanatory path between ${primary.displayName} and ${secondary.displayName}.`,
          params: {
            sourceId: primary.id,
            targetId: secondary.id,
            maxDepth: 6,
          },
        }),
      ];
    }

    if (intent.operation === 'comparison' && primary && secondary && primary.id !== secondary.id) {
      return [
        this.createStep({
          prefix: 'entity-comparison',
          intent: 'comparison',
          operation: 'compare-nodes',
          executor: 'graph-analysis',
          tool: 'compareNodes',
          description: `Compare ${primary.displayName} and ${secondary.displayName}.`,
          params: {
            nodeIds: [primary.id, secondary.id],
          },
        }),
      ];
    }

    if (primary && intent.operation === 'drug-indications') {
      return [
        this.createStep({
          prefix: 'entity-details',
          intent: 'drug-search',
          operation: 'load-node-details',
          executor: 'retrieval-operations',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        }),
        this.createStep({
          prefix: 'drug-indications',
          intent: 'drug-search',
          operation: 'get-drug-indications',
          executor: 'retrieval-operations',
          tool: 'getRelatedEntities',
          description: `Retrieve diseases indicated for ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
            limit: 20,
          },
        }),
      ];
    }

    if (primary && intent.operation === 'guideline-search') {
      return [
        this.createStep({
          prefix: 'entity-details',
          intent: 'guideline-search',
          operation: 'load-node-details',
          executor: 'retrieval-operations',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        }),
        this.createStep({
          prefix: 'guidelines',
          intent: 'guidelines',
          operation: 'retrieve-clinical-guidelines',
          executor: 'retrieval-operations',
          tool: 'retrieveClinicalGuidelines',
          description: `Retrieve clinical guideline nodes linked to ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            limit: 10,
          },
        }),
      ];
    }

    if (
      intent.operation === 'pathway-search' &&
      seedEntities.length > 1 &&
      seedEntities.every((entity) => /(gene|protein)/i.test(entity.typeName))
    ) {
      return [
        this.createStep({
          prefix: 'entity-details',
          intent: 'pathway-search',
          operation: 'load-node-details',
          executor: 'retrieval-operations',
          tool: 'getNodeDetails',
          description: `Load metadata for ${seedEntities.length} selected or resolved entities.`,
          params: {
            nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
          },
        }),
        aggregateMode === 'shared'
          ? this.createStep({
              prefix: 'shared-pathways',
              intent: 'pathway-search',
              operation: 'find-shared-pathways',
              executor: 'graph-analysis',
              tool: 'findSharedPathways',
              description: `Find shared pathways connected to ${seedEntities.map((entity) => entity.displayName).join(', ')}.`,
              params: {
                nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
                minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
                limit: 20,
              },
            })
          : this.createStep({
              prefix: 'pathway-set',
              intent: 'pathway-search',
              operation: 'get-related-pathways',
              executor: 'retrieval-operations',
              tool: 'getRelatedEntities',
              description: `Find pathways connected to ${seedEntities.map((entity) => entity.displayName).join(', ')} and rank them by support.`,
              params: {
                nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
                aggregateMode,
                minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
                relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
                limit: 20,
              },
            }),
      ];
    }

    if (primary && intent.operation === 'drug-search') {
      if (seedEntities.length > 1 && seedEntities.every((entity) => /(gene|protein)/i.test(entity.typeName))) {
        return [
          this.createStep({
            prefix: 'entity-details',
            intent: 'drug-search',
            operation: 'load-node-details',
            executor: 'retrieval-operations',
            tool: 'getNodeDetails',
            description: `Load metadata for ${seedEntities.length} selected or resolved entities.`,
            params: {
              nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
            },
          }),
          this.createStep({
            prefix: aggregateMode === 'shared' ? 'shared-drugs' : 'drug-set',
            intent: 'disease-protein-pathway-drug',
            operation: 'get-related-drugs',
            executor: 'retrieval-operations',
            tool: 'getRelatedEntities',
            description:
              aggregateMode === 'shared'
                ? `Find drugs shared across ${seedEntities.map((entity) => entity.displayName).join(', ')}.`
                : `Find drugs connected to ${seedEntities.map((entity) => entity.displayName).join(', ')} and rank them by support.`,
            params: {
              nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
              aggregateMode,
              minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
              relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
              limit: 20,
            },
          }),
        ];
      }

      return [
        this.createStep({
          prefix: 'entity-details',
          intent: 'drug-search',
          operation: 'load-node-details',
          executor: 'retrieval-operations',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        }),
        this.createStep({
          prefix: 'drug-path',
          intent: 'disease-protein-pathway-drug',
          operation: 'get-related-drugs',
          executor: 'retrieval-operations',
          tool: 'getRelatedEntities',
          description: `Traverse from ${primary.displayName} to genes, proteins, pathways, and drugs.`,
          params: {
            startId: primary.id,
            typeSequences: [
              ['Gene', 'Protein', 'Drug'],
              ['Protein', 'Pathway', 'Drug'],
              ['Gene', 'Pathway', 'Drug'],
              ['Protein', 'Drug'],
            ],
            limit: 12,
          },
        }),
      ];
    }

    if (primary && (intent.primary === 'disease-genes' || intent.requestedEntityTypes.includes('Gene'))) {
      return [
        this.createStep({
          prefix: 'entity-details',
          intent: 'disease-genes',
          operation: 'load-node-details',
          executor: 'retrieval-operations',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        }),
        this.createStep({
          prefix: 'disease-genes',
          intent: 'disease-genes',
          operation: 'get-related-genes',
          executor: 'retrieval-operations',
          tool: 'getRelatedEntities',
          description: `Retrieve genes related to ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
            limit: 20,
          },
        }),
      ];
    }

    if (intent.operation === 'pathway-search' && primary) {
      return [
        this.createStep({
          prefix: 'entity-details',
          intent: 'pathway-search',
          operation: 'load-node-details',
          executor: 'retrieval-operations',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        }),
        this.createStep({
          prefix: 'pathway-traversal',
          intent: 'pathway-search',
          operation: 'get-related-pathways',
          executor: 'retrieval-operations',
          tool: 'getRelatedEntities',
          description: `Traverse from ${primary.displayName} to relevant pathways.`,
          params: {
            startId: primary.id,
            typeSequences: [['Gene', 'Pathway'], ['Protein', 'Pathway'], ['Pathway']],
            limit: 12,
          },
        }),
      ];
    }

    if (intent.operation === 'graph-expansion' && expansionSeedNodeIds.length > 0) {
      return [
        this.createStep({
          prefix: 'expand-current-network',
          intent: 'graph-expansion',
          operation: 'expand-network',
          executor: 'retrieval-operations',
          tool: 'expandSubgraph',
          description: 'Expand the current graph state from active anchors and explicitly mentioned entities.',
          params: {
            nodeIds: expansionSeedNodeIds,
            hops: intent.radius ?? 2,
            maxNodes: 200,
            degreeLimit: 24,
            nodeTypes: expansionNodeTypes,
            relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
          },
        }),
      ];
    }

    if (intent.operation === 'graph-expansion' && primary) {
      return [
        this.createStep({
          prefix: 'expand-neighborhood',
          intent: 'graph-expansion',
          operation: 'retrieve-neighborhood',
          executor: 'retrieval-operations',
          tool: 'retrieveSubgraph',
          description: `Load a bounded neighborhood around ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            radius: intent.radius ?? 2,
            maxNodes: 160,
            degreeLimit: 24,
            nodeTypes: expansionNodeTypes,
            relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
          },
        }),
      ];
    }

    return [
      this.createStep({
        prefix: 'neighborhood',
        intent: primary ? 'neighborhood' : 'concept-discovery',
        operation: 'retrieve-neighborhood',
        executor: 'retrieval-operations',
        tool: 'retrieveSubgraph',
        description: primary
          ? `Load a bounded neighborhood around ${primary.displayName}.`
          : extractedQuery.concepts.length > 0
            ? `Attempt a graph lookup for the concept "${extractedQuery.concepts[0].text}".`
            : 'Load a small graph neighborhood for the active conversation state.',
        params: {
          nodeId: primary?.id,
          radius: intent.radius ?? 1,
          maxNodes: 80,
          degreeLimit: 12,
          nodeTypes: expansionNodeTypes,
          relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
        },
      }),
    ];
  }

  private createStep(params: {
    prefix: string;
    intent: RetrievalPlanStep['intent'];
    operation: RetrievalOperation;
    executor: RetrievalExecutor;
    tool: RetrievalPlanStep['tool'];
    description: string;
    params: Record<string, unknown>;
  }): RetrievalPlanStep {
    return {
      id: createStepId(params.prefix),
      intent: params.intent,
      operation: params.operation,
      executor: params.executor,
      tool: params.tool,
      description: params.description,
      params: params.params,
    };
  }

  private mapGraphAnalysisTool(operation: RetrievalOperation): RetrievalPlanStep['tool'] {
    switch (operation) {
      case 'find-shared-pathways':
        return 'findSharedPathways';
      case 'find-shared-diseases':
        return 'findSharedDiseases';
      case 'find-shared-genes':
        return 'findSharedGenes';
      case 'find-common-neighbors':
      default:
        return 'findCommonNeighbors';
    }
  }

  private pickGraphAnalysisScope(params: {
    selectedNodeIds: string[];
    selectedEdgeIds: string[];
    visibleNodeIds: string[];
    visibleEdgeIds: string[];
    state: ConversationGraphState;
  }) {
    const { selectedNodeIds, selectedEdgeIds, visibleNodeIds, visibleEdgeIds, state } = params;
    const sessionNodeIds =
      state.visibleNodeIds.length > 0
        ? state.visibleNodeIds.slice(0, 2000)
        : state.activeEntities.map((entity) => entity.id).slice(0, 2000);
    const sessionEdgeIds = state.visibleEdgeIds.slice(0, 5000);

    if (selectedNodeIds.length > 0 || selectedEdgeIds.length > 0) {
      return {
        mode: 'selection' as const,
        label: 'selected graph',
        nodeIds: selectedNodeIds,
        edgeIds: selectedEdgeIds,
      };
    }

    if (visibleNodeIds.length > 0 || visibleEdgeIds.length > 0) {
      return {
        mode: 'visible-subgraph' as const,
        label: 'visible graph',
        nodeIds: visibleNodeIds,
        edgeIds: visibleEdgeIds,
      };
    }

    if (sessionNodeIds.length > 0 || sessionEdgeIds.length > 0) {
      return {
        mode: 'session' as const,
        label: 'session graph',
        nodeIds: sessionNodeIds,
        edgeIds: sessionEdgeIds,
      };
    }

    return {
      mode: 'none' as const,
      label: 'active graph context',
      nodeIds: [] as string[],
      edgeIds: [] as string[],
    };
  }

  private pickSchemaAnalysisOperation(query: string, intent: QueryIntentClassification) {
    const normalized = query.toLowerCase();
    const requestedTypes = new Set(intent.requestedEntityTypes);

    if (requestedTypes.has('MolecularFunction')) {
      return {
        operation: 'analyze-molecular-functions' as const,
        tool: 'analyzeMolecularFunctions' as const,
        description: 'Analyze molecular function nodes present',
        title: 'Molecular function analysis',
      };
    }
    if (requestedTypes.has('CellularComponent')) {
      return {
        operation: 'analyze-cellular-components' as const,
        tool: 'analyzeCellularComponents' as const,
        description: 'Analyze cellular component nodes present',
        title: 'Cellular component analysis',
      };
    }
    if (requestedTypes.has('Anatomy')) {
      return {
        operation: 'analyze-anatomy' as const,
        tool: 'analyzeAnatomy' as const,
        description: 'Analyze anatomy nodes present',
        title: 'Anatomy analysis',
      };
    }
    if (requestedTypes.has('Phenotype')) {
      return {
        operation: 'analyze-phenotypes' as const,
        tool: 'analyzePhenotypes' as const,
        description: 'Analyze phenotype nodes present',
        title: 'Phenotype analysis',
      };
    }
    if (requestedTypes.has('Exposure')) {
      return {
        operation: 'analyze-exposures' as const,
        tool: 'analyzeExposures' as const,
        description: 'Analyze exposure nodes present',
        title: 'Exposure analysis',
      };
    }
    if (requestedTypes.has('Gene')) {
      return {
        operation: 'analyze-genes' as const,
        tool: 'analyzeGenes' as const,
        description: 'Analyze gene nodes present',
        title: 'Gene analysis',
      };
    }
    if (requestedTypes.has('Disease')) {
      return {
        operation: 'analyze-diseases' as const,
        tool: 'analyzeDiseases' as const,
        description: 'Analyze disease nodes present',
        title: 'Disease analysis',
      };
    }
    if (requestedTypes.has('Drug')) {
      return {
        operation: 'analyze-drugs' as const,
        tool: 'analyzeDrugs' as const,
        description: 'Analyze drug nodes present',
        title: 'Drug analysis',
      };
    }
    if (requestedTypes.has('Pathway')) {
      return {
        operation: 'analyze-pathways' as const,
        tool: 'analyzePathways' as const,
        description: 'Analyze pathway nodes present',
        title: 'Pathway analysis',
      };
    }
    if (requestedTypes.has('BiologicalProcess')) {
      return {
        operation: 'analyze-node-types' as const,
        tool: 'analyzeNodeTypes' as const,
        description: 'Analyze biological process nodes present',
        title: 'Biological process analysis',
        targetTypes: ['BiologicalProcess'],
      };
    }
    if (/\brelationship types?\b/.test(normalized)) {
      return {
        operation: 'find-available-relationship-types' as const,
        tool: 'findAvailableRelationshipTypes' as const,
        description: 'List relationship types available',
        title: 'Available relationship types',
      };
    }
    if (/\bnode types?\b/.test(normalized) || /\bwhat .* are present\b/.test(normalized)) {
      return {
        operation: 'find-available-node-types' as const,
        tool: 'findAvailableNodeTypes' as const,
        description: 'List node types available',
        title: 'Available node types',
      };
    }

    return {
      operation: 'analyze-schema' as const,
      tool: 'analyzeSchema' as const,
      description: 'Analyze the graph schema',
      title: 'Schema analysis',
    };
  }

  private pickRelationshipAnalysisOperation(query: string, intent: QueryIntentClassification) {
    const normalized = query.toLowerCase();
    const requestedTypes = intent.requestedEntityTypes;
    const sourceTypes = requestedTypes.length > 0 ? [requestedTypes[0]] : [];
    const targetTypes = requestedTypes.length > 1 ? [requestedTypes[1]] : requestedTypes.slice(0, 1);

    if (
      /\bhow are\b.*\bconnected\b/.test(normalized) ||
      /\bbetween\b/.test(normalized) ||
      /\bcross[- ]type\b/.test(normalized)
    ) {
      return {
        operation: 'analyze-cross-type-connections' as const,
        tool: 'analyzeCrossTypeConnections' as const,
        description: 'Analyze cross-type connections',
        title: 'Cross-type connections',
        sourceTypes,
        targetTypes,
      };
    }

    if (/\bdominant\b.*\brelationships?\b/.test(normalized) || /\brelationships?\b.*\bdominat/.test(normalized)) {
      return {
        operation: 'find-dominant-relationships' as const,
        tool: 'findDominantRelationships' as const,
        description: 'Identify dominant relationship types',
        title: 'Dominant relationships',
      };
    }

    if (/\bdensity\b/.test(normalized)) {
      return {
        operation: 'analyze-relationship-density' as const,
        tool: 'analyzeRelationshipDensity' as const,
        description: 'Analyze relationship density',
        title: 'Relationship density',
      };
    }

    if (/\bpatterns?\b/.test(normalized)) {
      return {
        operation: 'analyze-relationship-patterns' as const,
        tool: 'analyzeRelationshipPatterns' as const,
        description: 'Analyze relationship patterns',
        title: 'Relationship patterns',
      };
    }

    if (/\brelationship types?\b/.test(normalized) || /\bdistribution\b/.test(normalized)) {
      return {
        operation: 'compute-relationship-distribution' as const,
        tool: 'computeRelationshipDistribution' as const,
        description: 'Compute relationship distribution',
        title: 'Relationship distribution',
      };
    }

    return {
      operation: 'analyze-relationship-types' as const,
      tool: 'analyzeRelationshipTypes' as const,
      description: 'Analyze relationship types',
      title: 'Relationship analysis',
      sourceTypes,
      targetTypes,
    };
  }

  private pickNetworkStatisticsOperations(query: string) {
    const normalized = query.toLowerCase();
    const operations: Array<{
      operation: RetrievalOperation;
      tool: RetrievalPlanStep['tool'];
      description: string;
    }> = [];

    operations.push({
      operation: 'compute-graph-metrics',
      tool: 'computeGraphMetrics',
      description: 'Compute overall graph metrics',
    });

    if (/\bnode types?\b/.test(normalized)) {
      operations.push({
        operation: 'compute-node-type-distribution',
        tool: 'computeNodeTypeDistribution',
        description: 'Compute node-type distribution',
      });
    }

    if (/\brelationships?\b/.test(normalized) || /\bdistribution\b/.test(normalized)) {
      operations.push({
        operation: 'compute-relationship-distribution',
        tool: 'computeRelationshipDistribution',
        description: 'Compute relationship distribution',
      });
    }

    if (/\bhubs?\b|\bcentral\b/.test(normalized)) {
      operations.push({
        operation: 'compute-centrality-metrics',
        tool: 'computeCentralityMetrics',
        description: 'Compute centrality and hub metrics',
      });
    }

    if (/\bdensity\b/.test(normalized)) {
      operations.push({
        operation: 'compute-density-metrics',
        tool: 'computeDensityMetrics',
        description: 'Compute density metrics',
      });
    }

    if (/\bclusters?\b|\bcomponents?\b|\btopology\b/.test(normalized)) {
      operations.push({
        operation: 'compute-component-statistics',
        tool: 'computeComponentStatistics',
        description: 'Compute component and topology statistics',
      });
    }

    if (operations.length === 1) {
      operations.push({
        operation: 'compute-centrality-metrics',
        tool: 'computeCentralityMetrics',
        description: 'Compute centrality and hub metrics',
      });
      operations.push({
        operation: 'compute-component-statistics',
        tool: 'computeComponentStatistics',
        description: 'Compute component and topology statistics',
      });
    }

    return operations;
  }

  private pickCommunityDetectionOperation(query: string, intent: QueryIntentClassification) {
    const normalized = query.toLowerCase();
    const requestedTypes = new Set(intent.requestedEntityTypes);

    if (requestedTypes.has('Disease') || /\bdisease modules?\b/.test(normalized)) {
      return {
        operation: 'detect-disease-modules' as const,
        tool: 'detectDiseaseModules' as const,
        description: 'Detect disease-dominated communities',
        title: 'Disease modules',
        focusTypes: ['Disease'],
      };
    }

    if (
      requestedTypes.has('Gene') ||
      requestedTypes.has('Protein') ||
      /\bgene modules?\b/.test(normalized) ||
      /\bprotein modules?\b/.test(normalized)
    ) {
      return {
        operation: 'detect-gene-modules' as const,
        tool: 'detectGeneModules' as const,
        description: 'Detect gene and protein modules',
        title: 'Gene modules',
        focusTypes: ['Gene', 'Protein'],
      };
    }

    if (
      requestedTypes.has('Pathway') ||
      requestedTypes.has('BiologicalProcess') ||
      requestedTypes.has('MolecularFunction') ||
      requestedTypes.has('CellularComponent') ||
      /\bfunctional modules?\b/.test(normalized)
    ) {
      return {
        operation: 'detect-functional-modules' as const,
        tool: 'detectFunctionalModules' as const,
        description: 'Detect functional communities and modules',
        title: 'Functional modules',
        focusTypes: ['Pathway', 'BiologicalProcess', 'MolecularFunction', 'CellularComponent'],
      };
    }

    return {
      operation: 'detect-communities' as const,
      tool: 'detectCommunities' as const,
      description: 'Detect major graph communities',
      title: 'Detected communities',
      focusTypes: intent.requestedEntityTypes,
    };
  }

  private pickGraphExplanationOperation(query: string) {
    const normalized = query.toLowerCase();
    if (/\btheme\b/.test(normalized)) {
      return {
        operation: 'identify-graph-theme' as const,
        tool: 'identifyGraphTheme' as const,
        description: 'Identify the dominant graph theme',
      };
    }
    if (/\bcentral concepts?\b/.test(normalized)) {
      return {
        operation: 'identify-central-concepts' as const,
        tool: 'identifyCentralConcepts' as const,
        description: 'Identify the central concepts in the graph',
      };
    }
    if (/\bbiological narrative\b/.test(normalized) || /\bnarrative\b/.test(normalized)) {
      return {
        operation: 'summarize-biological-narrative' as const,
        tool: 'summarizeBiologicalNarrative' as const,
        description: 'Summarize the biological narrative of the graph',
      };
    }

    return {
      operation: 'interpret-subgraph' as const,
      tool: 'interpretSubgraph' as const,
      description: 'Interpret the active subgraph',
    };
  }

  private pickOntologyOperation(query: string) {
    const normalized = query.toLowerCase();
    if (/\bparents?\b/.test(normalized) && !/\bancestors?\b/.test(normalized)) {
      return {
        operation: 'find-parents' as const,
        tool: 'findParents' as const,
        description: 'Find ontology parents',
        title: 'Ontology parents',
        direction: 'parents' as const,
        maxDepth: 1,
      };
    }
    if (/\bchildren\b/.test(normalized) && !/\bdescendants?\b/.test(normalized)) {
      return {
        operation: 'find-children' as const,
        tool: 'findChildren' as const,
        description: 'Find ontology children',
        title: 'Ontology children',
        direction: 'children' as const,
        maxDepth: 1,
      };
    }
    if (/\bancestors?\b/.test(normalized)) {
      return {
        operation: 'find-ancestors' as const,
        tool: 'findAncestors' as const,
        description: 'Find ontology ancestors',
        title: 'Ontology ancestors',
        direction: 'ancestors' as const,
        maxDepth: 4,
      };
    }
    if (/\broots?\b/.test(normalized)) {
      return {
        operation: 'find-ontology-roots' as const,
        tool: 'findOntologyRoots' as const,
        description: 'Find ontology roots',
        title: 'Ontology roots',
        direction: 'roots' as const,
        maxDepth: 6,
      };
    }
    if (/\bhierarchy\b/.test(normalized)) {
      return {
        operation: 'explore-ontology-hierarchy' as const,
        tool: 'exploreOntologyHierarchy' as const,
        description: 'Explore the ontology hierarchy',
        title: 'Ontology hierarchy',
        direction: 'descendants' as const,
        maxDepth: 4,
      };
    }

    return {
      operation: 'find-descendants' as const,
      tool: 'findDescendants' as const,
      description: 'Find ontology descendants',
      title: 'Ontology descendants',
      direction: 'descendants' as const,
      maxDepth: 4,
    };
  }

  private pickEnrichmentOperation(query: string, intent: QueryIntentClassification) {
    const normalized = query.toLowerCase();
    const requestedTypes = new Set(intent.requestedEntityTypes);

    if (requestedTypes.has('Disease') || /\bdiseases?\b/.test(normalized)) {
      return {
        operation: 'enrich-diseases' as const,
        tool: 'enrichDiseases' as const,
        description: 'Find enriched diseases',
      };
    }
    if (requestedTypes.has('Phenotype') || /\bphenotypes?\b|\bsymptoms?\b/.test(normalized)) {
      return {
        operation: 'enrich-phenotypes' as const,
        tool: 'enrichPhenotypes' as const,
        description: 'Find enriched phenotypes',
      };
    }
    if (requestedTypes.has('BiologicalProcess') || /\bbiological processes?\b/.test(normalized)) {
      return {
        operation: 'enrich-biological-processes' as const,
        tool: 'enrichBiologicalProcesses' as const,
        description: 'Find enriched biological processes',
      };
    }
    if (requestedTypes.has('MolecularFunction') || /\bmolecular functions?\b/.test(normalized)) {
      return {
        operation: 'enrich-molecular-functions' as const,
        tool: 'enrichMolecularFunctions' as const,
        description: 'Find enriched molecular functions',
      };
    }
    if (requestedTypes.has('CellularComponent') || /\bcellular components?\b/.test(normalized)) {
      return {
        operation: 'enrich-cellular-components' as const,
        tool: 'enrichCellularComponents' as const,
        description: 'Find enriched cellular components',
      };
    }
    if (requestedTypes.has('Anatomy') || /\banatom(y|ical)\b/.test(normalized)) {
      return {
        operation: 'enrich-anatomy' as const,
        tool: 'enrichAnatomy' as const,
        description: 'Find enriched anatomy terms',
      };
    }

    return {
      operation: 'enrich-pathways' as const,
      tool: 'enrichPathways' as const,
      description: 'Find enriched pathways',
    };
  }

  private pickExposureOperation(query: string, intent: QueryIntentClassification) {
    const normalized = query.toLowerCase();
    if (
      intent.requestedEntityTypes.includes('Disease') ||
      /\bdiseases?\b|\bphenotypes?\b|\boutcomes?\b/.test(normalized)
    ) {
      return {
        operation: 'get-exposure-diseases' as const,
        tool: 'getExposureDiseases' as const,
        description: 'Retrieve diseases linked to {entity}.',
      };
    }
    if (
      intent.requestedEntityTypes.includes('Pathway') ||
      intent.requestedEntityTypes.includes('BiologicalProcess') ||
      intent.requestedEntityTypes.includes('MolecularFunction') ||
      intent.requestedEntityTypes.includes('CellularComponent') ||
      /\bprocess(?:es)?\b|\bpathways?\b|\bfunctions?\b/.test(normalized)
    ) {
      return {
        operation: 'get-exposure-processes' as const,
        tool: 'getExposureProcesses' as const,
        description: 'Retrieve pathways and processes linked to {entity}.',
      };
    }

    return {
      operation: 'get-exposure-genes' as const,
      tool: 'getExposureGenes' as const,
      description: 'Retrieve genes and proteins linked to {entity}.',
    };
  }

  private pickDrugDiscoveryOperation(query: string, primary: ResolvedEntity) {
    const normalized = query.toLowerCase();
    const isDrugAnchor = /drug|compound|therapeutic/i.test(primary.typeName);

    if (/\bcontraindications?\b/.test(normalized) && isDrugAnchor) {
      return {
        operation: 'get-drug-contraindications' as const,
        tool: 'getDrugContraindications' as const,
        description: 'Retrieve contraindications for {entity}.',
      };
    }
    if (/\boff-?label\b/.test(normalized) && isDrugAnchor) {
      return {
        operation: 'find-off-label-uses' as const,
        tool: 'findOffLabelUses' as const,
        description: 'Retrieve off-label uses for {entity}.',
      };
    }
    if (/\bmechanisms?\b/.test(normalized) && isDrugAnchor) {
      return {
        operation: 'get-drug-mechanisms' as const,
        tool: 'getDrugMechanisms' as const,
        description: 'Retrieve mechanisms connected to {entity}.',
      };
    }
    if (/\btargets?\b/.test(normalized) && isDrugAnchor) {
      return {
        operation: 'get-drug-targets' as const,
        tool: 'getDrugTargets' as const,
        description: 'Retrieve molecular targets linked to {entity}.',
      };
    }

    return {
      operation: 'get-related-drugs' as const,
      tool: 'getRelatedEntities' as const,
      description: 'Retrieve drug candidates linked to {entity}.',
    };
  }

  private pickContextAnchors(params: {
    query: string;
    intent: QueryIntentClassification;
    extractedQuery: ExtractedQuery;
    explicitEntities: ResolvedEntity[];
    conceptResolvedEntities: ResolvedEntity[];
    state: ConversationGraphState;
    selectedIds: Set<string>;
  }) {
    const { query, intent, extractedQuery, explicitEntities, conceptResolvedEntities, state, selectedIds } = params;
    const explicitIds = new Set(explicitEntities.map((entity) => entity.id));

    const candidates = [...state.activeEntities, ...conceptResolvedEntities]
      .filter((entity) => !explicitIds.has(entity.id))
      .filter((entity, index, entities) => entities.findIndex((candidate) => candidate.id === entity.id) === index);

    return candidates.sort(
      (a, b) =>
        this.scoreContextAnchor(b, query, intent, extractedQuery, selectedIds) -
          this.scoreContextAnchor(a, query, intent, extractedQuery, selectedIds) ||
        b.confidence - a.confidence ||
        a.displayName.localeCompare(b.displayName),
    );
  }

  private pickSecondaryEntity(params: {
    query: string;
    intent: QueryIntentClassification;
    explicitEntities: ResolvedEntity[];
    primary: ResolvedEntity | undefined;
    contextAnchors: ResolvedEntity[];
  }) {
    const { query, intent, explicitEntities, primary, contextAnchors } = params;
    if (explicitEntities.length >= 2) {
      return explicitEntities[1];
    }

    if (!primary || !intent.allowContextFallback) {
      return undefined;
    }

    const typeName = primary.typeName.toLowerCase();
    const preferDiseaseContext = typeName.includes('gene') || typeName.includes('protein');
    const preferMechanisticContext =
      query.toLowerCase().includes('role') ||
      query.toLowerCase().includes('connected') ||
      query.toLowerCase().includes('relationship');

    if (preferDiseaseContext) {
      const diseaseAnchor = contextAnchors.find(
        (entity) =>
          entity.id !== primary.id &&
          /(disease|phenotype|syndrome|disorder|drug|pathway)/i.test(entity.typeName),
      );
      if (diseaseAnchor) {
        return diseaseAnchor;
      }
    }

    if (preferMechanisticContext) {
      const pathwayAnchor = contextAnchors.find(
        (entity) =>
          entity.id !== primary.id &&
          /(pathway|disease|drug|phenotype|protein|gene)/i.test(entity.typeName),
      );
      if (pathwayAnchor) {
        return pathwayAnchor;
      }
    }

    return contextAnchors.find((entity) => entity.id !== primary.id);
  }

  private pickExpansionSeeds(
    resolvedEntities: ResolvedEntity[],
    primary: ResolvedEntity | undefined,
    state: ConversationGraphState,
    graphContext: GraphContextResult,
  ) {
    const selectedIds = graphContext.activeAnchors.map((node) => node.id).filter((nodeId) => nodeId.length > 0);
    if (selectedIds.length > 0) {
      return Array.from(new Set(selectedIds)).slice(0, 5);
    }

    const activeIds = state.activeEntities.map((entity) => entity.id).filter((nodeId) => nodeId.length > 0);
    const frontierIds = state.frontierNodeIds.filter((nodeId) => nodeId.length > 0);
    const resolvedIds = state.resolvedNodeIds.filter((nodeId) => nodeId.length > 0);
    const explicitIds = resolvedEntities.map((entity) => entity.id).filter((nodeId) => nodeId.length > 0);

    return Array.from(
      new Set(
        [primary?.id, ...explicitIds, ...activeIds, ...state.selectedNodeIds, ...frontierIds, ...resolvedIds].filter(
          Boolean,
        ),
      ),
    ).slice(0, 5) as string[];
  }

  private pickExpansionNodeTypes(query: string, intent: QueryIntentClassification, resolvedEntities: ResolvedEntity[]) {
    const normalized = query.toLowerCase();
    const nodeTypes = new Set<string>(intent.requestedEntityTypes);

    for (const entity of resolvedEntities) {
      if (entity.typeName) {
        nodeTypes.add(entity.typeName);
      }
    }

    if (normalized.includes('gene')) {
      ['Gene', 'Protein', 'Disease', 'Pathway'].forEach((type) => nodeTypes.add(type));
    }
    if (normalized.includes('protein')) {
      ['Protein', 'Gene', 'Pathway', 'Disease'].forEach((type) => nodeTypes.add(type));
    }
    if (normalized.includes('pathway')) {
      ['Pathway', 'Protein', 'Gene', 'Disease', 'Drug'].forEach((type) => nodeTypes.add(type));
    }
    if (normalized.includes('drug')) {
      ['Drug', 'Protein', 'Gene', 'Pathway', 'Disease'].forEach((type) => nodeTypes.add(type));
    }
    if (normalized.includes('disease') || normalized.includes('alzheimer') || normalized.includes('dementia')) {
      nodeTypes.add('Disease');
    }

    return [...nodeTypes].slice(0, 8);
  }

  private pickRelationshipTypes(query: string, intent: QueryIntentClassification, extractedQuery: ExtractedQuery) {
    const normalized = query.toLowerCase();
    const relationshipTypes = new Set<string>();

    if (intent.operation === 'drug-search') {
      ['TARGETS', 'TARGET_OF', 'ASSOCIATED_WITH', 'TREATS', 'INDICATED_FOR'].forEach((type) =>
        relationshipTypes.add(type),
      );
    }

    if (intent.operation === 'drug-indications') {
      ['INDICATED_FOR', 'TREATS', 'APPROVED_FOR', 'HAS_INDICATION', 'ASSOCIATED_WITH'].forEach((type) =>
        relationshipTypes.add(type),
      );
    }

    if (normalized.includes('pathway')) {
      ['INVOLVED_IN', 'PART_OF', 'ASSOCIATED_WITH', 'PARTICIPATES_IN'].forEach((type) =>
        relationshipTypes.add(type),
      );
    }

    if (normalized.includes('target')) {
      ['TARGETS', 'TARGET_OF', 'INTERACTS_WITH', 'ASSOCIATED_WITH'].forEach((type) =>
        relationshipTypes.add(type),
      );
    }

    if (
      normalized.includes('related') ||
      normalized.includes('linked') ||
      normalized.includes('role') ||
      extractedQuery.operatorSignals.includes('connected')
    ) {
      ['ASSOCIATED_WITH', 'INTERACTS_WITH', 'PARTICIPATES_IN', 'INVOLVED_IN'].forEach((type) =>
        relationshipTypes.add(type),
      );
    }

    return [...relationshipTypes];
  }

  private scoreContextAnchor(
    entity: ResolvedEntity,
    query: string,
    intent: QueryIntentClassification,
    extractedQuery: ExtractedQuery,
    selectedIds: Set<string>,
  ) {
    const normalizedType = entity.typeName.toLowerCase();
    let score = entity.confidence;

    if (selectedIds.has(entity.id)) {
      score += 2;
    }
    if (/(disease|phenotype|syndrome|disorder)/i.test(normalizedType)) {
      score += 1.6;
    }
    if (/(pathway|drug)/i.test(normalizedType)) {
      score += 1.1;
    }
    if (/(gene|protein)/i.test(normalizedType)) {
      score += 0.7;
    }
    if (query.toLowerCase().includes('drug') && /drug/i.test(normalizedType)) {
      score += 0.5;
    }
    if (query.toLowerCase().includes('pathway') && /pathway/i.test(normalizedType)) {
      score += 0.5;
    }
    if (intent.operation === 'path-search' && /(disease|pathway|phenotype)/i.test(normalizedType)) {
      score += 0.35;
    }
    if (extractedQuery.selectionReferences.length > 0 && selectedIds.has(entity.id)) {
      score += 0.4;
    }

    return score;
  }

  private pickSeedEntities(
    explicitEntities: ResolvedEntity[],
    extractedQuery: ExtractedQuery,
    queryRoute: QueryRoute,
  ) {
    const selectedEntities = explicitEntities.filter((entity) => entity.source === 'selected');

    if (
      selectedEntities.length > 0 &&
      (extractedQuery.selectionReferences.length > 0 ||
        queryRoute.category === 'GRAPH_QUERY' ||
        queryRoute.category === 'MIXED_QUERY')
    ) {
      return selectedEntities;
    }

    return explicitEntities;
  }

  private pickAggregateMode(query: string, extractedQuery: ExtractedQuery) {
    const normalized = query.toLowerCase();
    if (
      extractedQuery.operatorSignals.includes('shared') ||
      extractedQuery.operatorSignals.includes('common') ||
      /\bshared\b/.test(normalized) ||
      /\bcommon\b/.test(normalized) ||
      /\ball of\b/.test(normalized) ||
      /\beach of\b/.test(normalized)
    ) {
      return 'shared' as const;
    }

    return 'union' as const;
  }

  private pickMinimumSupport(seedCount: number, aggregateMode: 'shared' | 'union') {
    if (aggregateMode === 'shared') {
      return Math.max(2, seedCount);
    }

    return 1;
  }

  private pickCommonalityOperation(query: string, seedEntities: ResolvedEntity[], intent: QueryIntentClassification) {
    const normalized = query.toLowerCase();
    const selectedTypes = new Set(seedEntities.map((entity) => entity.typeName.toLowerCase()));

    if (normalized.includes('pathway') || [...selectedTypes].every((type) => /(gene|protein)/.test(type))) {
      return 'find-shared-pathways' as const;
    }

    if (normalized.includes('disease')) {
      return 'find-shared-diseases' as const;
    }

    if (
      normalized.includes('gene') ||
      [...selectedTypes].every((type) => /(disease|phenotype|syndrome|disorder)/.test(type))
    ) {
      return 'find-shared-genes' as const;
    }

    if (intent.requestedEntityTypes.length > 0) {
      return 'find-common-neighbors' as const;
    }

    return 'find-common-neighbors' as const;
  }
}
