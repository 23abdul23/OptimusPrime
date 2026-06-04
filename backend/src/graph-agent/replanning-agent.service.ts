import { Injectable } from '@nestjs/common';
import type {
  ConversationGraphState,
  ExtractedQuery,
  GraphContextResult,
  GraphEvidenceBundle,
  QueryIntentClassification,
  ResolvedEntity,
  RetrievalPlanStep,
} from './graph-agent.types';
import { createStepId } from './graph-agent.utils';

@Injectable()
export class ReplanningAgentService {
  replan(params: {
    query: string;
    intent: QueryIntentClassification;
    graphContext: GraphContextResult;
    extractedQuery: ExtractedQuery;
    resolvedEntities: ResolvedEntity[];
    state: ConversationGraphState;
    plan: RetrievalPlanStep[];
    evidence: GraphEvidenceBundle;
  }): RetrievalPlanStep[] {
    const { query, intent, graphContext, extractedQuery, resolvedEntities, state, plan, evidence } = params;
    if (!evidence.assessment.needsReplan) {
      return [];
    }

    const attempted = new Set(plan.map((step) => step.operation));
    const anchorIds = this.pickAnchorIds(resolvedEntities, graphContext, state);
    const queryLower = query.toLowerCase();
    const nextSteps: RetrievalPlanStep[] = [];

    if (
      (intent.operation === 'path-search' || intent.operation === 'graph-connections' || intent.primary === 'relationship-analysis') &&
      anchorIds.length >= 2
    ) {
      if (!attempted.has('find-shared-pathways')) {
        nextSteps.push({
          id: createStepId('replan-shared-pathways'),
          intent: 'pathway-search',
          operation: 'find-shared-pathways',
          executor: 'graph-analysis',
          tool: 'findSharedPathways',
          description: 'Replan: look for shared pathways across the active anchors.',
          params: {
            nodeIds: anchorIds.slice(0, 8),
            minSupport: Math.max(2, Math.min(anchorIds.length, 3)),
            limit: 12,
          },
        });
      }

      if (!attempted.has('find-shared-diseases')) {
        nextSteps.push({
          id: createStepId('replan-shared-diseases'),
          intent: 'relationship-analysis',
          operation: 'find-shared-diseases',
          executor: 'graph-analysis',
          tool: 'findSharedDiseases',
          description: 'Replan: look for shared diseases across the active anchors.',
          params: {
            nodeIds: anchorIds.slice(0, 8),
            minSupport: Math.max(2, Math.min(anchorIds.length, 3)),
            limit: 12,
          },
        });
      }

      if (!attempted.has('find-common-neighbors')) {
        nextSteps.push({
          id: createStepId('replan-common-neighbors'),
          intent: 'relationship-analysis',
          operation: 'find-common-neighbors',
          executor: 'graph-analysis',
          tool: 'findCommonNeighbors',
          description: 'Replan: look for common neighbors across the active anchors.',
          params: {
            nodeIds: anchorIds.slice(0, 8),
            targetTypes: intent.requestedEntityTypes,
            minSupport: Math.max(2, Math.min(anchorIds.length, 3)),
            limit: 12,
          },
        });
      }
    }

    if (intent.operation === 'pathway-search' && anchorIds.length >= 2 && !attempted.has('find-shared-pathways')) {
      nextSteps.push({
        id: createStepId('replan-pathways'),
        intent: 'pathway-search',
        operation: 'find-shared-pathways',
        executor: 'graph-analysis',
        tool: 'findSharedPathways',
        description: 'Replan: search for shared pathways across the active anchors.',
        params: {
          nodeIds: anchorIds.slice(0, 8),
          minSupport: Math.max(2, Math.min(anchorIds.length, 3)),
          limit: 16,
        },
      });
    }

    if (
      intent.operation === 'drug-search' &&
      anchorIds.length >= 2 &&
      !attempted.has('get-related-drugs')
    ) {
      nextSteps.push({
        id: createStepId('replan-drugs'),
        intent: 'drug-search',
        operation: 'get-related-drugs',
        executor: 'retrieval-operations',
        tool: 'getRelatedEntities',
        description: 'Replan: retrieve drugs linked across the active anchors.',
        params: {
          nodeIds: anchorIds.slice(0, 8),
          aggregateMode: queryLower.includes('shared') || extractedQuery.operatorSignals.includes('shared') ? 'shared' : 'union',
          minSupport: Math.max(1, Math.min(anchorIds.length, 2)),
          relationshipTypes: [],
          limit: 16,
        },
      });
    }

    if (
      (intent.primary === 'disease-genes' || intent.operation === 'entity-search') &&
      anchorIds.length >= 1 &&
      !attempted.has('retrieve-neighborhood')
    ) {
      nextSteps.push({
        id: createStepId('replan-neighborhood'),
        intent: 'neighborhood',
        operation: 'retrieve-neighborhood',
        executor: 'retrieval-operations',
        tool: 'retrieveSubgraph',
        description: 'Replan: load a bounded neighborhood around the primary anchor.',
        params: {
          nodeId: anchorIds[0],
          radius: 1,
          maxNodes: 60,
          degreeLimit: 10,
          nodeTypes: ['Gene', 'Protein', 'Disease', 'Pathway'],
          relationshipTypes: [],
        },
      });
    }

    return nextSteps.slice(0, 2);
  }

  private pickAnchorIds(
    resolvedEntities: ResolvedEntity[],
    graphContext: GraphContextResult,
    state: ConversationGraphState,
  ) {
    const selectedIds = graphContext.activeAnchors.map((node) => node.id).filter((nodeId) => nodeId.length > 0);
    const resolvedIds = resolvedEntities.map((entity) => entity.id).filter((nodeId) => nodeId.length > 0);
    const activeIds = state.activeEntities.map((entity) => entity.id).filter((nodeId) => nodeId.length > 0);

    return Array.from(new Set([...selectedIds, ...resolvedIds, ...activeIds])).slice(0, 8);
  }
}
