import { Injectable } from '@nestjs/common';
import { createUIMessageStream, type UIMessageStreamWriter } from 'ai';
import { DEFAULT_MODEL, type ModelId } from '@/llm/model.constants';
import { ConversationGraphStateService } from './conversation-graph-state.service';
import { EntityExtractionService } from './entity-extraction.service';
import { EntityResolutionService } from './entity-resolution.service';
import { EvidenceSelectionService } from './evidence-selection.service';
import { GraphRetrieverService } from './graph-retriever.service';
import type { GraphAgentChatRequestDto } from './graph-agent.dto';
import type { ConversationGraphState, GraphAgentUIMessage } from './graph-agent.types';
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

        if (extractedQuery.intent.operation === 'network-summary' && promptDto.networkContext) {
          const evidenceBundle = this.buildNetworkSummaryBundle(query, promptDto.networkContext);
          const nextState = await this.conversationStateService.saveConversationGraphState({
            ...previousState,
            sessionId,
            selectedNodeIds: promptDto.networkContext.selectedNodeIds ?? previousState.selectedNodeIds,
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

        const resolvedEntities = await this.entityResolutionService.resolveEntities(
          extractedQuery.mentions,
          extractedQuery.concepts,
        );
        const unresolvedMentions = this.getUnresolvedMentionTexts(extractedQuery.mentions, resolvedEntities);

        if (this.shouldBlockOnUnresolvedMentions(extractedQuery.mentions.length, extractedQuery.intent.operation, unresolvedMentions)) {
          const evidenceBundle = this.evidenceSelectionService.buildBundle({
            query,
            items: [],
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
          });

          const nextState = await this.conversationStateService.saveConversationGraphState(
            this.buildNextState({
              previousState,
              sessionId,
              resolvedEntities,
              evidenceBundle,
              selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
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
          items: retrieval.evidence,
          resolvedEntities,
          plan,
          warnings: retrieval.warnings,
        });

        const nextState = await this.conversationStateService.saveConversationGraphState(
          this.buildNextState({
            previousState,
            sessionId,
            resolvedEntities,
            evidenceBundle,
            selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
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
    networkContext: NonNullable<GraphAgentChatRequestDto['networkContext']>,
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
}
