import { Injectable } from '@nestjs/common';
import type {
  ConversationGraphState,
  ExtractedQuery,
  ResolvedEntity,
  RetrievalPlanStep,
} from './graph-agent.types';
import { createStepId } from './graph-agent.utils';

@Injectable()
export class RetrievalPlannerService {
  plan(params: {
    query: string;
    extractedQuery: ExtractedQuery;
    resolvedEntities: ResolvedEntity[];
    state: ConversationGraphState;
    selectedNodeContext: Array<{ id: string; label: string }>;
  }): RetrievalPlanStep[] {
    const { query, extractedQuery, resolvedEntities, state, selectedNodeContext } = params;
    const normalized = query.toLowerCase();

    const explicitEntities = resolvedEntities.filter((entity) => entity.source !== 'concept');
    const conceptResolvedEntities = resolvedEntities.filter((entity) => entity.source === 'concept');
    const primary = explicitEntities[0] ?? conceptResolvedEntities[0] ?? state.activeEntities[0];
    const secondary = this.pickSecondaryEntity(explicitEntities, state, selectedNodeContext);

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

    if (
      extractedQuery.intent.operation === 'path-search' &&
      primary &&
      secondary &&
      primary.id !== secondary.id
    ) {
      return [
        {
          id: createStepId('shortest-path'),
          intent: 'shortest-path',
          tool: 'shortestPath',
          description: `Find the shortest path between ${primary.displayName} and ${secondary.displayName}.`,
          params: {
            sourceId: primary.id,
            targetId: secondary.id,
            maxDepth: 6,
          },
        },
      ];
    }

    if (primary && extractedQuery.intent.operation === 'guideline-search') {
      return [
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

    if (primary && normalized.includes('drug') && normalized.includes('pathway')) {
      return [
        {
          id: createStepId('drug-path'),
          intent: 'disease-protein-pathway-drug',
          tool: 'getRelatedEntities',
          description: `Traverse from ${primary.displayName} to proteins, pathways, and drugs.`,
          params: {
            startId: primary.id,
            typeSequences: [
              ['Protein', 'Pathway', 'Drug'],
              ['Gene', 'Pathway', 'Drug'],
              ['Protein', 'Drug'],
            ],
            limit: 12,
          },
        },
      ];
    }

    if (primary && extractedQuery.intent.requestedEntityTypes.includes('Gene')) {
      return [
        {
          id: createStepId('disease-genes'),
          intent: 'disease-genes',
          tool: 'getRelatedEntities',
          description: `Retrieve genes related to ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            nodeTypes: ['Gene'],
            limit: 20,
          },
        },
      ];
    }

    if (extractedQuery.intent.operation === 'graph-expansion' && primary) {
      return [
        {
          id: createStepId('expand-neighborhood'),
          intent: 'neighborhood',
          tool: 'retrieveSubgraph',
          description: `Load a bounded neighborhood around ${primary.displayName}.`,
          params: {
            nodeId: primary.id,
            radius: extractedQuery.intent.radius ?? 2,
            maxNodes: 160,
            degreeLimit: 24,
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
          radius: extractedQuery.intent.radius ?? 1,
          maxNodes: 80,
          degreeLimit: 12,
        },
      },
    ];
  }

  private pickSecondaryEntity(
    explicitEntities: ResolvedEntity[],
    state: ConversationGraphState,
    selectedNodeContext: Array<{ id: string; label: string }>,
  ) {
    if (explicitEntities.length >= 2) {
      return explicitEntities[1];
    }

    const selectedContextEntity = selectedNodeContext
      .map((node) => state.activeEntities.find((entity) => entity.id === node.id))
      .find((entity) => Boolean(entity));
    if (selectedContextEntity) {
      return selectedContextEntity;
    }

    return state.activeEntities.find((entity) => entity.id !== explicitEntities[0]?.id);
  }
}
