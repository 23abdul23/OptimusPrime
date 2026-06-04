import { Injectable } from '@nestjs/common';
import { createUIMessageStream, type UIMessageStreamWriter } from 'ai';
import { DEFAULT_MODEL, type ModelId } from '@/llm/model.constants';
import { ConversationGraphStateService } from './conversation-graph-state.service';
import { EntityExtractionService } from './entity-extraction.service';
import { EntityResolutionService } from './entity-resolution.service';
import { EvidenceSelectionService } from './evidence-selection.service';
import { GraphRetrieverService } from './graph-retriever.service';
import type { GraphAgentChatRequestDto } from './graph-agent.dto';
import type {
  ConversationGraphState,
  GraphAgentUIMessage,
  GraphEvidenceItem,
  GraphNetworkContext,
  GraphSelectionEdgeContext,
  GraphSelectionNodeContext,
  ResolvedEntity,
} from './graph-agent.types';
import { extractLatestUserText } from './graph-agent.utils';
import { ResponseSynthesisService } from './response-synthesis.service';
import { RetrievalPlannerService } from './retrieval-planner.service';
import type { GraphEvidenceBundle, RetrievalPlanStep } from './graph-agent.types';

@Injectable()
export class GraphAgentService {
  constructor(
    private readonly conversationStateService: ConversationGraphStateService,
    private readonly entityExtractionService: EntityExtractionService,
    private readonly entityResolutionService: EntityResolutionService,
    private readonly retrievalPlannerService: RetrievalPlannerService,
    private readonly graphRetrieverService: GraphRetrieverService,
    private readonly evidenceSelectionService: EvidenceSelectionService,
    private readonly responseSynthesisService: ResponseSynthesisService,
  ) {}

  createChatStream(promptDto: GraphAgentChatRequestDto) {
    const messages = (promptDto.messages as GraphAgentUIMessage[] | undefined) ?? [];
    const query = extractLatestUserText(messages);
    const sessionId = promptDto.sessionId || `graph-agent-${Date.now()}`;

    return createUIMessageStream<GraphAgentUIMessage>({
      originalMessages: messages,
      execute: async ({ writer }) => {
        if (!query) {
          this.writeText(writer, 'Please provide a biomedical graph question to analyze.');
          return;
        }

        const responseId = `${sessionId}-${Date.now()}`;

        const previousState = await this.conversationStateService.getConversationGraphState(sessionId);
        const extractedQuery = this.entityExtractionService.extractQuery({ query });
        const selectedEntities = this.buildSelectedContextEntities(promptDto.selectedNodeContext ?? []);
        const selectedEdgeEvidence = this.buildSelectedEdgeContextEvidence(
          promptDto.selectedEdgeContext ?? [],
          promptDto.selectedNodeContext ?? [],
          extractedQuery.selectionReferences.length > 0,
        );

        if (extractedQuery.intent.operation === 'network-summary' && promptDto.networkContext) {
          const evidenceBundle = this.buildNetworkSummaryBundle(query, promptDto.networkContext);
          const nextState = await this.conversationStateService.saveConversationGraphState({
            ...previousState,
            sessionId,
            selectedNodeIds: promptDto.networkContext.selectedNodeIds ?? previousState.selectedNodeIds,
            visibleNodeIds: promptDto.networkContext.visibleNodeIds ?? previousState.visibleNodeIds,
            visibleEdgeIds: promptDto.networkContext.visibleEdgeIds ?? previousState.visibleEdgeIds,
            updatedAt: new Date().toISOString(),
          });

          writer.write({
            type: 'data-graphEvidence',
            id: `graph-evidence-${responseId}`,
            data: evidenceBundle,
          });
          writer.write({
            type: 'data-graphActions',
            id: `graph-actions-${responseId}`,
            data: [],
          });
          writer.write({
            type: 'data-graphState',
            id: `graph-state-${responseId}`,
            data: {
              sessionId,
              state: nextState,
            },
          });
          this.writeText(
            writer,
            `Your current network contains ${promptDto.networkContext.totalNodes} nodes and ${promptDto.networkContext.totalEdges} edges.`,
          );
          return;
        }

        const resolvedQueryEntities = await this.entityResolutionService.resolveEntities(
          extractedQuery.mentions,
          extractedQuery.concepts,
        );
        const resolvedEntities = this.combineResolvedEntities({
          resolvedQueryEntities,
          selectedEntities,
          extractedQuery,
        });
        const unresolvedMentions = this.getUnresolvedMentionTexts(extractedQuery.mentions, resolvedQueryEntities);

        if (this.shouldBlockOnUnresolvedMentions(extractedQuery.mentions.length, extractedQuery.intent.operation, unresolvedMentions)) {
          const evidenceBundle = this.evidenceSelectionService.buildBundle({
            query,
            items: selectedEdgeEvidence,
            resolvedEntities,
            plan: [
              {
                id: `resolve-mentions-${Date.now()}`,
                intent: 'relationship-analysis',
                tool: 'resolveEntity',
                description: 'Resolve all explicit biomedical mentions before retrieval continues.',
                params: {
                  unresolvedMentions,
                },
              },
            ],
            warnings: [
              `I could not confidently resolve these explicit mentions from OptimusKG metadata: ${unresolvedMentions.join(', ')}.`,
            ],
            selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
            visibleNodeIds: promptDto.networkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
          });

          const nextState = await this.conversationStateService.saveConversationGraphState(
            this.buildNextState({
              previousState,
              sessionId,
              resolvedEntities,
              evidenceBundle,
              selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
              selectedEdgeIds: (promptDto.selectedEdgeContext ?? []).map((edge) => edge.id),
              networkContext: promptDto.networkContext,
            }),
          );

          writer.write({
            type: 'data-graphEvidence',
            id: `graph-evidence-${responseId}`,
            data: evidenceBundle,
          });
          writer.write({
            type: 'data-graphActions',
            id: `graph-actions-${responseId}`,
            data: [],
          });
          writer.write({
            type: 'data-graphState',
            id: `graph-state-${responseId}`,
            data: {
              sessionId,
              state: nextState,
            },
          });
          this.writeText(
            writer,
            `I could not confidently resolve these explicit mentions in OptimusKG: ${unresolvedMentions.join(', ')}. Refine the names or select the intended nodes in the graph and ask again.`,
          );
          return;
        }

        const plan = this.retrievalPlannerService.plan({
          query,
          extractedQuery,
          resolvedEntities,
          state: previousState,
          selectedNodeContext: promptDto.selectedNodeContext ?? [],
        });
        const retrieval = await this.graphRetrieverService.executePlan(plan, resolvedEntities);
        const evidenceBundle = this.evidenceSelectionService.buildBundle({
          query,
          items: [...selectedEdgeEvidence, ...retrieval.evidence],
          resolvedEntities,
          plan,
          warnings: retrieval.warnings,
          selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
          visibleNodeIds: promptDto.networkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
        });

        const nextState = await this.conversationStateService.saveConversationGraphState(
          this.buildNextState({
            previousState,
            sessionId,
            resolvedEntities,
            evidenceBundle,
            selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
            selectedEdgeIds: (promptDto.selectedEdgeContext ?? []).map((edge) => edge.id),
            networkContext: promptDto.networkContext,
          }),
        );

        writer.write({
          type: 'data-graphEvidence',
          id: `graph-evidence-${responseId}`,
          data: evidenceBundle,
        });
        writer.write({
          type: 'data-graphActions',
          id: `graph-actions-${responseId}`,
          data: retrieval.graphActions,
        });
        writer.write({
          type: 'data-graphState',
          id: `graph-state-${responseId}`,
          data: {
            sessionId,
            state: nextState,
          },
        });

        const synthesisStream = this.responseSynthesisService.streamAnswer({
          model: (promptDto.model as ModelId | undefined) ?? DEFAULT_MODEL,
          query,
          evidence: evidenceBundle,
          resolvedEntities,
        });

        if (!synthesisStream) {
          this.writeText(writer, this.responseSynthesisService.createFallbackAnswer(query, evidenceBundle));
          return;
        }

        writer.merge(
          synthesisStream.toUIMessageStream<GraphAgentUIMessage>({
            onError: () => this.responseSynthesisService.createFallbackAnswer(query, evidenceBundle),
          }),
        );
      },
      onError: (error) => {
        return error instanceof Error ? error.message : 'Graph-agent request failed';
      },
    });
  }

  private buildNextState(params: {
    previousState: ConversationGraphState;
    sessionId: string;
    resolvedEntities: ConversationGraphState['activeEntities'];
    evidenceBundle: ReturnType<EvidenceSelectionService['buildBundle']>;
    selectedNodeIds: string[];
    selectedEdgeIds: string[];
    networkContext?: GraphNetworkContext;
  }): ConversationGraphState {
    return {
      ...params.previousState,
      sessionId: params.sessionId,
      activeEntities: this.mergeActiveEntities(params.resolvedEntities, params.previousState.activeEntities),
      resolvedNodeIds: [
        ...params.resolvedEntities.map((entity) => entity.id),
        ...params.previousState.resolvedNodeIds,
      ],
      frontierNodeIds: [
        ...params.evidenceBundle.items.flatMap((item) => item.nodeIds),
        ...params.previousState.frontierNodeIds,
      ],
      retrievedNodeIds: [
        ...params.evidenceBundle.items.flatMap((item) => item.nodeIds),
        ...params.previousState.retrievedNodeIds,
      ],
      evidenceCache: [...params.evidenceBundle.items, ...params.previousState.evidenceCache],
      priorQueries: [params.evidenceBundle.query, ...params.previousState.priorQueries],
      lastPlan: params.evidenceBundle.plan,
      selectedNodeIds: params.selectedNodeIds,
      selectedEdgeIds: params.selectedEdgeIds,
      visibleNodeIds: params.networkContext?.visibleNodeIds ?? params.previousState.visibleNodeIds,
      visibleEdgeIds: params.networkContext?.visibleEdgeIds ?? params.previousState.visibleEdgeIds,
      updatedAt: new Date().toISOString(),
    };
  }

  private mergeActiveEntities(
    currentEntities: ConversationGraphState['activeEntities'],
    previousEntities: ConversationGraphState['activeEntities'],
  ) {
    const merged = new Map<string, ConversationGraphState['activeEntities'][number]>();

    for (const entity of [...currentEntities, ...previousEntities]) {
      const existing = merged.get(entity.id);
      if (!existing || entity.confidence > existing.confidence) {
        merged.set(entity.id, entity);
      }
    }

    return [...merged.values()].sort(
      (a, b) =>
        this.rankActiveEntity(b, currentEntities) - this.rankActiveEntity(a, currentEntities) ||
        b.confidence - a.confidence ||
        a.displayName.localeCompare(b.displayName),
    );
  }

  private writeText(writer: UIMessageStreamWriter<GraphAgentUIMessage>, text: string) {
    const id = `text-${Date.now()}`;
    writer.write({ type: 'text-start', id });
    writer.write({ type: 'text-delta', id, delta: text });
    writer.write({ type: 'text-end', id });
  }

  private buildNetworkSummaryBundle(
    query: string,
    networkContext: GraphNetworkContext,
  ): GraphEvidenceBundle {
    const plan: RetrievalPlanStep[] = [
      {
        id: `network-summary-${Date.now()}`,
        intent: 'network-summary',
        tool: 'getConversationGraphState',
        description: 'Summarize the currently visible frontend network.',
        params: {
          totalNodes: networkContext.totalNodes,
          totalEdges: networkContext.totalEdges,
        },
      },
    ];

    return {
      query,
      resolvedEntities: [],
      plan,
      items: [
        {
          id: `network-summary-item-${Date.now()}`,
          kind: 'query',
          title: 'Visible network summary',
          summary: `The current visible network has ${networkContext.totalNodes} nodes and ${networkContext.totalEdges} edges.`,
          score: 1,
          nodeIds: networkContext.selectedNodeIds ?? [],
          edgeIds: [],
          metadata: {
            totalNodes: networkContext.totalNodes,
            totalEdges: networkContext.totalEdges,
            topNodeTypes: networkContext.topNodeTypes ?? [],
          },
        },
      ],
      insufficientEvidence: false,
      warnings: [],
    };
  }

  private getUnresolvedMentionTexts(
    mentions: Array<{ text: string }>,
    resolvedEntities: Array<{ query: string }>,
  ) {
    const resolvedMentionKeys = new Set(
      resolvedEntities.map((entity) => entity.query.trim().toLowerCase()).filter((value) => value.length > 0),
    );

    return Array.from(
      new Set(
        mentions
          .map((mention) => mention.text.trim())
          .filter((text) => text.length > 0 && !resolvedMentionKeys.has(text.toLowerCase())),
      ),
    );
  }

  private shouldBlockOnUnresolvedMentions(
    mentionCount: number,
    operation: string,
    unresolvedMentions: string[],
  ) {
    if (unresolvedMentions.length === 0) {
      return false;
    }

    if (mentionCount === unresolvedMentions.length) {
      return true;
    }

    return mentionCount > 1 && ['path-search', 'comparison', 'relationship-analysis'].includes(operation);
  }

  private rankActiveEntity(
    entity: ConversationGraphState['activeEntities'][number],
    currentEntities: ConversationGraphState['activeEntities'],
  ) {
    const currentIds = new Set(currentEntities.map((current) => current.id));
    const normalizedType = entity.typeName.toLowerCase();
    let score = entity.confidence;

    if (currentIds.has(entity.id)) {
      score += 2;
    }
    if (/(disease|phenotype|syndrome|disorder)/i.test(normalizedType)) {
      score += 1.2;
    }
    if (/(drug|pathway)/i.test(normalizedType)) {
      score += 0.8;
    }
    if (/(gene|protein)/i.test(normalizedType)) {
      score += 0.5;
    }

    return score;
  }

  private buildSelectedContextEntities(selectedNodeContext: GraphSelectionNodeContext[]) {
    return selectedNodeContext
      .filter((node) => node.id.trim().length > 0)
      .map<ResolvedEntity>((node) => ({
        id: node.id,
        query: node.label,
        displayName: node.label,
        typeCode: node.nodeType ?? 'Entity',
        typeName: node.nodeType ?? 'Entity',
        confidence: 1,
        matchedOn: ['selected-context'],
        source: 'selected',
      }));
  }

  private combineResolvedEntities(params: {
    resolvedQueryEntities: ResolvedEntity[];
    selectedEntities: ResolvedEntity[];
    extractedQuery: ReturnType<EntityExtractionService['extractQuery']>;
  }) {
    const { resolvedQueryEntities, selectedEntities, extractedQuery } = params;
    const shouldIncludeSelected =
      selectedEntities.length > 0 &&
      (extractedQuery.selectionReferences.length > 0 || extractedQuery.intent.operation === 'graph-expansion');

    const merged = new Map<string, ResolvedEntity>();
    const orderedEntities = shouldIncludeSelected
      ? [...resolvedQueryEntities, ...selectedEntities]
      : resolvedQueryEntities;

    for (const entity of orderedEntities) {
      const existing = merged.get(entity.id);
      if (!existing || entity.confidence > existing.confidence) {
        merged.set(entity.id, entity);
      }
    }

    return [...merged.values()];
  }

  private buildSelectedEdgeContextEvidence(
    selectedEdges: GraphSelectionEdgeContext[],
    selectedNodes: GraphSelectionNodeContext[],
    shouldInclude: boolean,
  ): GraphEvidenceItem[] {
    if (!shouldInclude || selectedEdges.length === 0) {
      return [];
    }

    const nodeLabels = new Map(selectedNodes.map((node) => [node.id, node.label]));

    return selectedEdges.slice(0, 8).map((edge, index) => {
      const sourceLabel = nodeLabels.get(edge.source) ?? edge.source;
      const targetLabel = nodeLabels.get(edge.target) ?? edge.target;
      const relation = edge.relation?.trim() || 'CONNECTED_TO';

      return {
        id: `selected-edge-${edge.id}-${index}`,
        kind: 'relation',
        title: `Selected relationship: ${sourceLabel} ${relation} ${targetLabel}`,
        summary: `This relationship is currently selected in the graph and was included as explicit graph context for the query.`,
        score: 0.62,
        nodeIds: [edge.source, edge.target],
        edgeIds: [edge.id],
        metadata: {
          relation,
          selectedContext: true,
        },
      };
    });
  }
}
