import { Injectable } from '@nestjs/common';
import type {
  ConversationGraphState,
  ExtractedQuery,
  GraphContextResult,
  QueryIntentClassification,
  QueryRoute,
  ResolvedEntity,
  RetrievalPlanStep,
} from './graph-agent.types';
import { createStepId } from './graph-agent.utils';

@Injectable()
export class RetrievalPlannerService {
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
    const graphNodeIds = seedEntities.map((entity) => entity.id).slice(0, 12);

    if (normalized.includes('cypher') || normalized.includes('query language')) {
      return [
        {
          id: createStepId('guarded-cypher'),
          intent: 'guarded-cypher',
          tool: 'executeGuardedCypher',
          description: 'Run a validated read-only Cypher query.',
          params: { userQuery: query },
        },
      ];
    }

    if (queryRoute.category === 'GRAPH_QUERY' && intent.operation === 'graph-summary') {
      if (graphNodeIds.length > 0) {
        return [
          {
            id: createStepId('graph-summary'),
            intent: 'graph-summary',
            tool: 'summarizeNodes',
            description: `Summarize ${graphNodeIds.length} graph-selected node${graphNodeIds.length === 1 ? '' : 's'}.`,
            params: {
              nodeIds: graphNodeIds,
            },
          },
        ];
      }

      if (graphContext.graphScope.mode === 'visible-subgraph' || state.visibleNodeIds.length > 0) {
        return [
          {
            id: createStepId('subgraph-summary'),
            intent: 'graph-summary',
            tool: 'summarizeSubgraph',
            description: 'Summarize the currently visible subgraph.',
            params: {
              nodeIds: state.visibleNodeIds.slice(0, 120),
              edgeIds: state.visibleEdgeIds.slice(0, 240),
            },
          },
        ];
      }
    }

    if (queryRoute.category === 'GRAPH_QUERY' && intent.operation === 'graph-comparison' && graphNodeIds.length >= 2) {
      return [
        {
          id: createStepId('graph-comparison'),
          intent: 'graph-comparison',
          tool: 'compareNodes',
          description: `Compare ${graphNodeIds.length} selected graph nodes.`,
          params: {
            nodeIds: graphNodeIds.slice(0, 6),
          },
        },
      ];
    }

    if (queryRoute.category === 'GRAPH_QUERY' && intent.operation === 'graph-commonality' && graphNodeIds.length >= 2) {
      return [
        {
          id: createStepId('graph-commonality'),
          intent: 'graph-commonality',
          tool: this.pickCommonalityTool(query, seedEntities, intent),
          description: `Find shared graph structure across ${graphNodeIds.length} selected anchors.`,
          params: {
            nodeIds: graphNodeIds.slice(0, 8),
            targetTypes: intent.requestedEntityTypes,
            minSupport: this.pickMinimumSupport(graphNodeIds.length, 'shared'),
            limit: 20,
          },
        },
      ];
    }

    if (queryRoute.category === 'GRAPH_QUERY' && intent.operation === 'graph-connections' && graphNodeIds.length >= 2) {
      return [
        {
          id: createStepId('graph-connections'),
          intent: 'graph-connections',
          tool: 'explainConnections',
          description: `Explain how ${graphNodeIds.length} selected graph nodes are connected.`,
          params: {
            nodeIds: graphNodeIds.slice(0, 6),
            maxDepth: 5,
          },
        },
      ];
    }

    if (queryRoute.category === 'GRAPH_QUERY' && graphNodeIds.length > 0) {
      return [
        {
          id: createStepId('graph-selection-details'),
          intent: 'graph-summary',
          tool: 'summarizeNodes',
          description: `Summarize ${graphNodeIds.length} graph-selected node${graphNodeIds.length === 1 ? '' : 's'}.`,
          params: {
            nodeIds: graphNodeIds.slice(0, 8),
          },
        },
      ];
    }

    if (intent.operation === 'path-search' && primary && secondary && primary.id !== secondary.id) {
      return [
        {
          id: createStepId('entity-details'),
          intent: 'relationship-analysis',
          tool: 'getNodeDetails',
          description: `Load metadata for ${detailNodeIds.length} resolved entities.`,
          params: {
            nodeIds: detailNodeIds,
          },
        },
        {
          id: createStepId('relationship-evidence'),
          intent: 'relationship-analysis',
          tool: 'retrieveEvidence',
          description: `Retrieve direct and shared graph evidence between ${primary.displayName} and ${secondary.displayName}.`,
          params: {
            sourceId: primary.id,
            targetId: secondary.id,
            commonNeighborTypes: ['Gene', 'Protein', 'Pathway', 'Drug', 'Disease', 'Phenotype'],
            limit: 8,
          },
        },
        {
          id: createStepId('shortest-path'),
          intent: 'shortest-path',
          tool: 'shortestPath',
          description: `Find the shortest explanatory path between ${primary.displayName} and ${secondary.displayName}.`,
          params: {
            sourceId: primary.id,
            targetId: secondary.id,
            maxDepth: 6,
          },
        },
      ];
    }

    if (intent.operation === 'comparison' && primary && secondary && primary.id !== secondary.id) {
      return [
        {
          id: createStepId('entity-comparison'),
          intent: 'comparison',
          tool: 'compareNodes',
          description: `Compare ${primary.displayName} and ${secondary.displayName}.`,
          params: {
            nodeIds: [primary.id, secondary.id],
          },
        },
      ];
    }

    if (primary && intent.operation === 'drug-indications') {
      return [
        {
          id: createStepId('entity-details'),
          intent: 'drug-search',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        },
        {
          id: createStepId('drug-indications'),
          intent: 'drug-search',
          tool: 'getRelatedEntities',
          description: `Retrieve diseases indicated for ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            nodeTypes: ['Disease'],
            relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
            limit: 20,
          },
        },
      ];
    }

    if (primary && intent.operation === 'guideline-search') {
      return [
        {
          id: createStepId('entity-details'),
          intent: 'guideline-search',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        },
        {
          id: createStepId('guidelines'),
          intent: 'guidelines',
          tool: 'retrieveClinicalGuidelines',
          description: `Retrieve clinical guideline nodes linked to ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            limit: 10,
          },
        },
      ];
    }

    if (
      intent.operation === 'pathway-search' &&
      seedEntities.length > 1 &&
      seedEntities.every((entity) => /(gene|protein)/i.test(entity.typeName))
    ) {
      return [
        {
          id: createStepId('entity-details'),
          intent: 'pathway-search',
          tool: 'getNodeDetails',
          description: `Load metadata for ${seedEntities.length} selected or resolved entities.`,
          params: {
            nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
          },
        },
        {
          id: createStepId(aggregateMode === 'shared' ? 'shared-pathways' : 'pathway-set'),
          intent: 'pathway-search',
          tool: aggregateMode === 'shared' ? 'findSharedPathways' : 'getRelatedEntities',
          description:
            aggregateMode === 'shared'
              ? `Find shared pathways connected to ${seedEntities.map((entity) => entity.displayName).join(', ')}.`
              : `Find pathways connected to ${seedEntities.map((entity) => entity.displayName).join(', ')} and rank them by support.`,
          params:
            aggregateMode === 'shared'
              ? {
                  nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
                  minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
                  limit: 20,
                }
              : {
                  nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
                  nodeTypes: ['Pathway'],
                  relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
                  aggregateMode,
                  minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
                  limit: 20,
                },
        },
      ];
    }

    if (primary && intent.operation === 'drug-search') {
      if (seedEntities.length > 1 && seedEntities.every((entity) => /(gene|protein)/i.test(entity.typeName))) {
        return [
          {
            id: createStepId('entity-details'),
            intent: 'drug-search',
            tool: 'getNodeDetails',
            description: `Load metadata for ${seedEntities.length} selected or resolved entities.`,
            params: {
              nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
            },
          },
          {
            id: createStepId(aggregateMode === 'shared' ? 'shared-drugs' : 'drug-set'),
            intent: 'disease-protein-pathway-drug',
            tool: aggregateMode === 'shared' ? 'findCommonNeighbors' : 'getRelatedEntities',
            description:
              aggregateMode === 'shared'
                ? `Find drugs shared across ${seedEntities.map((entity) => entity.displayName).join(', ')}.`
                : `Find drugs connected to ${seedEntities.map((entity) => entity.displayName).join(', ')} and rank them by support.`,
            params:
              aggregateMode === 'shared'
                ? {
                    nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
                    targetTypes: ['Drug'],
                    minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
                    limit: 20,
                  }
                : {
                    nodeIds: seedEntities.map((entity) => entity.id).slice(0, 8),
                    nodeTypes: ['Drug'],
                    relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
                    aggregateMode,
                    minSupport: this.pickMinimumSupport(seedEntities.length, aggregateMode),
                    limit: 20,
                  },
          },
        ];
      }

      return [
        {
          id: createStepId('entity-details'),
          intent: 'drug-search',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        },
        {
          id: createStepId('drug-path'),
          intent: 'disease-protein-pathway-drug',
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
        },
      ];
    }

    if (primary && (intent.primary === 'disease-genes' || intent.requestedEntityTypes.includes('Gene'))) {
      return [
        {
          id: createStepId('entity-details'),
          intent: 'disease-genes',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        },
        {
          id: createStepId('disease-genes'),
          intent: 'disease-genes',
          tool: 'getRelatedEntities',
          description: `Retrieve genes related to ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            nodeTypes: ['Gene'],
            relationshipTypes: this.pickRelationshipTypes(query, intent, extractedQuery),
            limit: 20,
          },
        },
      ];
    }

    if (intent.operation === 'pathway-search' && primary) {
      return [
        {
          id: createStepId('entity-details'),
          intent: 'pathway-search',
          tool: 'getNodeDetails',
          description: `Load metadata for ${primary.displayName}.`,
          params: {
            nodeIds: [primary.id],
          },
        },
        {
          id: createStepId('pathway-traversal'),
          intent: 'pathway-search',
          tool: 'getRelatedEntities',
          description: `Traverse from ${primary.displayName} to relevant pathways.`,
          params: {
            startId: primary.id,
            typeSequences: [['Gene', 'Pathway'], ['Protein', 'Pathway'], ['Pathway']],
            limit: 12,
          },
        },
      ];
    }

    if (intent.operation === 'graph-expansion' && expansionSeedNodeIds.length > 0) {
      return [
        {
          id: createStepId('expand-current-network'),
          intent: 'graph-expansion',
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
        },
      ];
    }

    if (intent.operation === 'graph-expansion' && primary) {
      return [
        {
          id: createStepId('expand-neighborhood'),
          intent: 'graph-expansion',
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
        },
      ];
    }

    return [
      {
        id: createStepId('neighborhood'),
        intent: primary ? 'neighborhood' : 'concept-discovery',
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
      },
    ];
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

  private pickCommonalityTool(query: string, seedEntities: ResolvedEntity[], intent: QueryIntentClassification) {
    const normalized = query.toLowerCase();
    const selectedTypes = new Set(seedEntities.map((entity) => entity.typeName.toLowerCase()));

    if (normalized.includes('pathway') || [...selectedTypes].every((type) => /(gene|protein)/.test(type))) {
      return 'findSharedPathways' as const;
    }

    if (normalized.includes('disease')) {
      return 'findSharedDiseases' as const;
    }

    if (
      normalized.includes('gene') ||
      [...selectedTypes].every((type) => /(disease|phenotype|syndrome|disorder)/.test(type))
    ) {
      return 'findSharedGenes' as const;
    }

    if (intent.requestedEntityTypes.length > 0) {
      return 'findCommonNeighbors' as const;
    }

    return 'findCommonNeighbors' as const;
  }
}
