import { Injectable } from '@nestjs/common';
import { createUIMessageStream, type UIMessageStreamWriter } from 'ai';
import { DEFAULT_MODEL, type ModelId } from '@/llm/model.constants';
import { ConversationGraphStateService } from './conversation-graph-state.service';
import { EntityExtractionService } from './entity-extraction.service';
import { EntityResolutionAgentService } from './entity-resolution-agent.service';
import { EvidenceAgentService } from './evidence-agent.service';
import { GraphContextAgentService } from './graph-context-agent.service';
import { GraphRetrieverService } from './graph-retriever.service';
import type { GraphAgentChatRequestDto } from './graph-agent.dto';
import type {
  ConversationGraphState,
  GraphAction,
  GraphAgentUIMessage,
  ExtractedQuery,
  GraphEvidenceItem,
  GraphNetworkContext,
  GraphSelectionEdgeContext,
  GraphSelectionNodeContext,
  ResolvedEntity,
} from './graph-agent.types';
import { extractLatestUserText } from './graph-agent.utils';
import { IntentAgentService } from './intent-agent.service';
import { ReasoningAgentService } from './reasoning-agent.service';
import { RetrievalPlanningAgentService } from './retrieval-planning-agent.service';
import type { GraphEvidenceBundle, RetrievalPlanStep } from './graph-agent.types';
import { QueryRouterService } from './query-router.service';
import { ReplanningAgentService } from './replanning-agent.service';

const MAX_REPLAN_ATTEMPTS = 2;

@Injectable()
export class GraphAgentService {
  constructor(
    private readonly conversationStateService: ConversationGraphStateService,
    private readonly graphContextAgentService: GraphContextAgentService,
    private readonly entityExtractionService: EntityExtractionService,
    private readonly intentAgentService: IntentAgentService,
    private readonly entityResolutionAgentService: EntityResolutionAgentService,
    private readonly queryRouterService: QueryRouterService,
    private readonly retrievalPlanningAgentService: RetrievalPlanningAgentService,
    private readonly graphRetrieverService: GraphRetrieverService,
    private readonly evidenceAgentService: EvidenceAgentService,
    private readonly replanningAgentService: ReplanningAgentService,
    private readonly reasoningAgentService: ReasoningAgentService,
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
        const queryRoute = this.queryRouterService.route({
          query,
          selectedNodeContext: promptDto.selectedNodeContext ?? [],
          selectedEdgeContext: promptDto.selectedEdgeContext ?? [],
          networkContext: promptDto.networkContext,
        });
        const graphContext = this.graphContextAgentService.build({
          query,
          queryRoute,
          selectedNodeContext: promptDto.selectedNodeContext ?? [],
          selectedEdgeContext: promptDto.selectedEdgeContext ?? [],
          networkContext: promptDto.networkContext,
          state: previousState,
        });
        const extractedQuery = queryRoute.requiresEntityExtraction
          ? this.entityExtractionService.extractQuery({ query })
          : this.createEmptyExtractedQuery(query);
        const intent = this.intentAgentService.classify({
          query,
          queryRoute,
          graphContext,
        });
        const selectedEntities = this.buildSelectedContextEntities(graphContext.activeAnchors);
        const selectedEdgeEvidence = this.buildSelectedEdgeContextEvidence(
          promptDto.selectedEdgeContext ?? [],
          graphContext.activeAnchors,
          (promptDto.selectedEdgeContext ?? []).length > 0 ||
            graphContext.graphReferences.referencesEdges ||
            graphContext.graphReferences.referencesSelection,
        );

        if (intent.operation === 'network-summary' && promptDto.networkContext) {
          const evidenceBundle = this.evidenceAgentService.buildBundle({
            query,
            items: [
              {
                id: `network-summary-item-${Date.now()}`,
                kind: 'query',
                title: 'Visible network summary',
                summary: `The current visible network has ${promptDto.networkContext.totalNodes} nodes and ${promptDto.networkContext.totalEdges} edges.`,
                score: 1,
                nodeIds: promptDto.networkContext.selectedNodeIds ?? [],
                edgeIds: [],
                metadata: {
                  totalNodes: promptDto.networkContext.totalNodes,
                  totalEdges: promptDto.networkContext.totalEdges,
                  topNodeTypes: promptDto.networkContext.topNodeTypes ?? [],
                },
              },
            ],
            resolvedEntities: [],
            plan: [
              {
                id: `network-summary-${Date.now()}`,
                intent: 'network-summary',
                operation: 'network-summary',
                executor: 'state',
                tool: 'getConversationGraphState',
                description: 'Summarize the currently visible frontend network.',
                params: {
                  totalNodes: promptDto.networkContext.totalNodes,
                  totalEdges: promptDto.networkContext.totalEdges,
                },
              },
            ],
            warnings: [],
            selectedNodeIds: promptDto.networkContext.selectedNodeIds ?? [],
            visibleNodeIds: promptDto.networkContext.visibleNodeIds ?? previousState.visibleNodeIds,
            replanAttempts: 0,
          });
          const nextState = await this.conversationStateService.saveConversationGraphState({
            ...previousState,
            sessionId,
            selectedNodeIds: promptDto.networkContext.selectedNodeIds ?? previousState.selectedNodeIds,
            selectedEdgeIds: promptDto.networkContext.selectedEdgeIds ?? previousState.selectedEdgeIds,
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

        const localResolution = this.resolveVisibleGraphMentions(
          extractedQuery.mentions,
          graphContext.selectedNodes.length > 0 ? graphContext.selectedNodes : graphContext.visibleNodes,
        );

        if (queryRoute.requiresEntityResolution && localResolution.ambiguous.length > 0) {
          const evidenceBundle = this.evidenceAgentService.buildBundle({
            query,
            items: [
              ...selectedEdgeEvidence,
              ...localResolution.ambiguous.map((ambiguity, index) => ({
                id: `ambiguous-visible-mention-${index}`,
                kind: 'query' as const,
                title: `Ambiguous graph-visible entity: ${ambiguity.mention}`,
                summary: `I found ${ambiguity.candidates.length} graph-visible matches for "${ambiguity.mention}": ${ambiguity.candidates.map((candidate) => candidate.label).join(', ')}. Please refine which one you mean.`,
                score: 0.68,
                nodeIds: ambiguity.candidates.map((candidate) => candidate.id),
                edgeIds: [],
                metadata: {
                  ambiguousMention: ambiguity.mention,
                  candidateCount: ambiguity.candidates.length,
                  candidates: ambiguity.candidates,
                },
              })),
            ],
            resolvedEntities: [...selectedEntities],
            plan: [
              {
                id: `clarify-visible-entity-${Date.now()}`,
                intent: 'relationship-analysis',
                operation: 'resolve-explicit-mentions',
                executor: 'resolution-agent',
                tool: 'resolveEntity',
                description: 'Clarify the intended graph-visible entity before retrieval continues.',
                params: {
                  ambiguities: localResolution.ambiguous.map((ambiguity) => ({
                    mention: ambiguity.mention,
                    candidates: ambiguity.candidates,
                  })),
                },
              },
            ],
            warnings: localResolution.ambiguous.map(
              (ambiguity) =>
                `The current graph contains multiple matches for "${ambiguity.mention}": ${ambiguity.candidates.map((candidate) => candidate.label).join(', ')}.`,
            ),
            selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
            visibleNodeIds: promptDto.networkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
            replanAttempts: 0,
          });

          const nextState = await this.conversationStateService.saveConversationGraphState(
            this.buildNextState({
              previousState,
              sessionId,
              resolvedEntities: [...selectedEntities],
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
            localResolution.ambiguous
              .map(
                (ambiguity) =>
                  `I found ${ambiguity.candidates.length} ${ambiguity.mention}-related node${ambiguity.candidates.length === 1 ? '' : 's'} in the current graph: ${ambiguity.candidates.map((candidate) => candidate.label).join(', ')}. Which one do you mean?`,
              )
              .join(' '),
          );
          return;
        }

        const unresolvedLocalMentions = extractedQuery.mentions.filter(
          (mention) => !localResolution.resolvedMentionTexts.has(mention.text.trim().toLowerCase()),
        );
        const resolvedQueryEntities = queryRoute.requiresEntityResolution
          ? [
              ...localResolution.resolvedEntities,
              ...(await this.entityResolutionAgentService.resolveEntities(
                unresolvedLocalMentions,
                localResolution.resolvedEntities.length > 0 ? [] : extractedQuery.concepts,
              )),
            ]
          : [];
        const resolvedEntities = this.combineResolvedEntities({
          resolvedQueryEntities,
          selectedEntities,
          queryRoute,
        });
        const unresolvedMentions = queryRoute.requiresEntityResolution
          ? this.getUnresolvedMentionTexts(extractedQuery.mentions, resolvedQueryEntities)
          : [];

        if (
          queryRoute.requiresEntityResolution &&
          this.shouldBlockOnUnresolvedMentions(extractedQuery.mentions.length, intent.operation, unresolvedMentions)
        ) {
          const evidenceBundle = this.evidenceAgentService.buildBundle({
            query,
            items: selectedEdgeEvidence,
            resolvedEntities,
            plan: [
              {
                id: `resolve-mentions-${Date.now()}`,
                intent: 'relationship-analysis',
                operation: 'resolve-explicit-mentions',
                executor: 'resolution-agent',
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
            replanAttempts: 0,
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

        let accumulatedPlan = this.retrievalPlanningAgentService.plan({
          query,
          queryRoute,
          graphContext,
          intent,
          extractedQuery,
          resolvedEntities,
          state: previousState,
        });
        const accumulatedEvidence: GraphEvidenceItem[] = [...selectedEdgeEvidence];
        const accumulatedWarnings: string[] = [];
        const accumulatedGraphActions: GraphAction[] = [];
        let evidenceBundle!: GraphEvidenceBundle;
        let currentPlanBatch = accumulatedPlan;
        let replanAttempts = 0;

        while (currentPlanBatch.length > 0) {
          const retrieval = await this.graphRetrieverService.executePlan(currentPlanBatch, resolvedEntities);
          accumulatedEvidence.push(...retrieval.evidence);
          accumulatedWarnings.push(...retrieval.warnings);
          accumulatedGraphActions.push(...retrieval.graphActions);

          evidenceBundle = this.evidenceAgentService.buildBundle({
            query,
            items: accumulatedEvidence,
            resolvedEntities,
            plan: accumulatedPlan,
            warnings: Array.from(new Set(accumulatedWarnings)),
            selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
            visibleNodeIds: promptDto.networkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
            replanAttempts,
          });

          if (!evidenceBundle.assessment.needsReplan || replanAttempts >= MAX_REPLAN_ATTEMPTS) {
            break;
          }

          const replan = this.replanningAgentService.replan({
            query,
            intent,
            graphContext,
            extractedQuery,
            resolvedEntities,
            state: previousState,
            plan: accumulatedPlan,
            evidence: evidenceBundle,
          });

          if (replan.length === 0) {
            break;
          }

          replanAttempts += 1;
          accumulatedPlan = [...accumulatedPlan, ...replan];
          currentPlanBatch = replan;
        }

        if (
          evidenceBundle.items.length === 0 &&
          intent.operation === 'graph-summary' &&
          promptDto.networkContext &&
          promptDto.networkContext.totalNodes > 0
        ) {
          evidenceBundle = this.evidenceAgentService.buildBundle({
            query,
            items: [
              {
                id: `visible-network-fallback-${Date.now()}`,
                kind: 'query',
                title: 'Visible network summary',
                summary: this.buildVisibleNetworkSummary(promptDto.networkContext),
                score: 0.52,
                nodeIds: promptDto.networkContext.visibleNodeIds ?? [],
                edgeIds: promptDto.networkContext.visibleEdgeIds ?? [],
                metadata: {
                  totalNodes: promptDto.networkContext.totalNodes,
                  totalEdges: promptDto.networkContext.totalEdges,
                  topNodeTypes: promptDto.networkContext.topNodeTypes ?? [],
                  summarySource: 'frontend-visible-network-context',
                },
              },
            ],
            resolvedEntities,
            plan: accumulatedPlan,
            warnings: Array.from(
              new Set([
                ...accumulatedWarnings,
                'Detailed backend graph-summary retrieval was unavailable, so this summary was derived from the current visible network context.',
              ]),
            ),
            selectedNodeIds: (promptDto.selectedNodeContext ?? []).map((node) => node.id),
            visibleNodeIds: promptDto.networkContext.visibleNodeIds ?? previousState.visibleNodeIds,
            replanAttempts,
          });
        }

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
          data: this.deduplicateGraphActions(accumulatedGraphActions),
        });
        writer.write({
          type: 'data-graphState',
          id: `graph-state-${responseId}`,
          data: {
            sessionId,
            state: nextState,
          },
        });

        const synthesisStream = this.reasoningAgentService.streamAnswer({
          model: (promptDto.model as ModelId | undefined) ?? DEFAULT_MODEL,
          query,
          evidence: evidenceBundle,
          resolvedEntities,
          graphContext,
          graphActions: this.deduplicateGraphActions(accumulatedGraphActions),
        });

        if (!synthesisStream) {
          this.writeText(writer, this.reasoningAgentService.createFallbackAnswer(query, evidenceBundle));
          return;
        }

        writer.merge(
          synthesisStream.toUIMessageStream<GraphAgentUIMessage>({
            onError: () => this.reasoningAgentService.createFallbackAnswer(query, evidenceBundle),
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
    evidenceBundle: ReturnType<EvidenceAgentService['buildBundle']>;
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

  private createEmptyExtractedQuery(query: string): ExtractedQuery {
    return {
      query,
      mentions: [],
      concepts: [],
      selectionReferences: [],
      operatorSignals: [],
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
        resolutionStage: 'exact',
        source: 'selected',
      }));
  }

  private resolveVisibleGraphMentions(
    mentions: Array<{ text: string; typeHints?: string[] }>,
    visibleNodes: GraphSelectionNodeContext[],
  ) {
    const resolvedEntities: ResolvedEntity[] = [];
    const resolvedMentionTexts = new Set<string>();
    const ambiguous: Array<{ mention: string; candidates: GraphSelectionNodeContext[] }> = [];
    const uniqueVisibleNodes = visibleNodes.filter(
      (node, index, nodes) => nodes.findIndex((candidate) => candidate.id === node.id) === index,
    );

    for (const mention of mentions) {
      const normalizedMention = this.normalizeEntityLikeText(mention.text);
      if (normalizedMention.length < 3) {
        continue;
      }

      const candidates = uniqueVisibleNodes.filter((node) => {
        const normalizedLabel = this.normalizeEntityLikeText(node.label);
        if (normalizedLabel.length === 0) {
          return false;
        }

        if (!this.matchesTypeHint(node.nodeType, mention.typeHints ?? [])) {
          return false;
        }

        return (
          normalizedLabel === normalizedMention ||
          normalizedLabel.includes(normalizedMention) ||
          normalizedMention.includes(normalizedLabel)
        );
      });

      if (candidates.length === 1) {
        resolvedEntities.push({
          id: candidates[0].id,
          query: mention.text,
          displayName: candidates[0].label,
          typeCode: candidates[0].nodeType ?? 'Entity',
          typeName: candidates[0].nodeType ?? 'Entity',
          confidence: 0.99,
          matchedOn: ['visible-graph'],
          resolutionStage: 'exact',
          source: 'selected',
        });
        resolvedMentionTexts.add(mention.text.trim().toLowerCase());
        continue;
      }

      const exactMatches = candidates.filter(
        (candidate) => this.normalizeEntityLikeText(candidate.label) === normalizedMention,
      );
      if (exactMatches.length === 1) {
        resolvedEntities.push({
          id: exactMatches[0].id,
          query: mention.text,
          displayName: exactMatches[0].label,
          typeCode: exactMatches[0].nodeType ?? 'Entity',
          typeName: exactMatches[0].nodeType ?? 'Entity',
          confidence: 1,
          matchedOn: ['visible-graph-exact'],
          resolutionStage: 'exact',
          source: 'selected',
        });
        resolvedMentionTexts.add(mention.text.trim().toLowerCase());
        continue;
      }

      if (candidates.length > 1) {
        ambiguous.push({
          mention: mention.text,
          candidates: candidates.slice(0, 8),
        });
      }
    }

    return {
      resolvedEntities,
      resolvedMentionTexts,
      ambiguous,
    };
  }

  private normalizeEntityLikeText(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/\s+(gene|protein|drug|pathway|disease|syndrome|disorder|phenotype|guideline)s?\b/g, '')
      .replace(/^(which|what|how|does|do|the|this|these|those|selected|connected|related|associated|linked|involved)\s+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private matchesTypeHint(nodeType: string | undefined, typeHints: string[]) {
    if (!nodeType || typeHints.length === 0) {
      return true;
    }

    const normalizedNodeType = nodeType.toLowerCase();
    return typeHints.some((hint) => normalizedNodeType.includes(hint.toLowerCase()));
  }

  private combineResolvedEntities(params: {
    resolvedQueryEntities: ResolvedEntity[];
    selectedEntities: ResolvedEntity[];
    queryRoute: ReturnType<QueryRouterService['route']>;
  }) {
    const { resolvedQueryEntities, selectedEntities, queryRoute } = params;
    const shouldIncludeSelected =
      selectedEntities.length > 0 &&
      (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY');

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

  private deduplicateGraphActions(actions: GraphAction[]) {
    const seen = new Set<string>();
    return actions.filter((action) => {
      if (seen.has(action.id)) {
        return false;
      }
      seen.add(action.id);
      return true;
    });
  }

  private buildVisibleNetworkSummary(networkContext: GraphNetworkContext) {
    const topNodeTypes = (networkContext.topNodeTypes ?? [])
      .slice(0, 5)
      .map(({ type, count }) => `${type} (${count})`)
      .join(', ');

    const keyEntityPreview = (networkContext.visibleNodeContext ?? [])
      .slice(0, 6)
      .map((node) => `${node.label}${node.nodeType ? ` [${node.nodeType}]` : ''}`)
      .join(', ');

    return [
      `Graph Overview: The visible network contains ${networkContext.totalNodes} nodes and ${networkContext.totalEdges} edges.`,
      `Key Entities: ${keyEntityPreview || 'Visible node previews were not provided in the request context.'}.`,
      `Graph Structure: This is a visible-network summary derived from the current frontend graph context because no explicit node selection was provided.`,
      `Major Relationship Types: Relationship-type distribution was not available in the fallback context.`,
      `Central Nodes: Centrality was not computed in the fallback context.`,
      `Biological Interpretation: The current visible graph is dominated by ${topNodeTypes || 'mixed node types'}, but a full topology-backed interpretation requires successful backend subgraph analysis.`,
    ].join('\n\n');
  }
}
