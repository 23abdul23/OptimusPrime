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
  PendingClarificationState,
  GraphSelectionEdgeContext,
  GraphSelectionNodeContext,
  QueryIntentClassification,
  QueryRoute,
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
        const clarificationResolution = this.resolvePendingClarification(
          previousState.pendingClarification,
          query,
        );

        if (previousState.pendingClarification && !clarificationResolution) {
          const pendingClarification = previousState.pendingClarification;
          const evidenceBundle = this.evidenceAgentService.buildBundle({
            query: pendingClarification.originalQuery,
            items: [
              {
                id: `pending-clarification-${Date.now()}`,
                kind: 'query',
                title: `Clarification still required: ${pendingClarification.unresolvedEntity}`,
                summary: `I still need you to choose how to resolve "${pendingClarification.unresolvedEntity}" before I can continue the original request. Available candidates: ${pendingClarification.candidateEntities.map((candidate) => `${candidate.displayName} (${candidate.typeName})`).join(', ')}.`,
                score: 0.6,
                nodeIds: pendingClarification.candidateEntities.map((candidate) => candidate.id),
                edgeIds: [],
                metadata: {
                  unresolvedEntity: pendingClarification.unresolvedEntity,
                  candidates: pendingClarification.candidateEntities.map((candidate) => ({
                    id: candidate.id,
                    displayName: candidate.displayName,
                    typeName: candidate.typeName,
                  })),
                },
              },
            ],
            resolvedEntities: pendingClarification.resolvedEntities,
            plan: [
              {
                id: `resume-pending-clarification-${Date.now()}`,
                intent: pendingClarification.pendingIntent,
                operation: 'resolve-explicit-mentions',
                executor: 'resolution-agent',
                tool: 'resolveEntity',
                description:
                  'Wait for a clarification response before resuming the previously requested graph operation.',
                params: {
                  unresolvedEntity: pendingClarification.unresolvedEntity,
                  candidates: pendingClarification.candidateEntities.map((candidate) => ({
                    id: candidate.id,
                    displayName: candidate.displayName,
                    typeName: candidate.typeName,
                  })),
                },
              },
            ],
            warnings: [
              `A pending clarification for "${pendingClarification.unresolvedEntity}" must be resolved before the original request can continue.`,
            ],
            selectedNodeIds: promptDto.networkContext?.selectedNodeIds ?? previousState.selectedNodeIds,
            visibleNodeIds: promptDto.networkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
            replanAttempts: 0,
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
              state: previousState,
            },
          });
          this.writeText(
            writer,
            `I still need you to clarify "${pendingClarification.unresolvedEntity}" before I continue "${pendingClarification.originalQuery}". You can reply with "all of them", "the first one", or a candidate name such as "${pendingClarification.candidateEntities[0]?.displayName ?? pendingClarification.unresolvedEntity}".`,
          );
          return;
        }

        const effectiveQuery = clarificationResolution?.originalQuery ?? query;
        const queryRoute = clarificationResolution?.queryRoute ?? this.queryRouterService.route({
          query: effectiveQuery,
          selectedNodeContext: promptDto.selectedNodeContext ?? [],
          selectedEdgeContext: promptDto.selectedEdgeContext ?? [],
          networkContext: promptDto.networkContext,
        });
        const graphContext = this.graphContextAgentService.build({
          query: effectiveQuery,
          queryRoute,
          selectedNodeContext: promptDto.selectedNodeContext ?? [],
          selectedEdgeContext: promptDto.selectedEdgeContext ?? [],
          networkContext: promptDto.networkContext,
          state: previousState,
        });
        const isDiscoveryMode =
          queryRoute.category === 'GRAPH_DISCOVERY_QUERY' || graphContext.graphScope.mode === 'discovery';
        const extractedQuery = clarificationResolution?.extractedQuery
          ? clarificationResolution.extractedQuery
          : queryRoute.requiresEntityExtraction
            ? this.entityExtractionService.extractQuery({ query: effectiveQuery })
            : this.createEmptyExtractedQuery(effectiveQuery);
        const intent = clarificationResolution?.intent ?? this.intentAgentService.classify({
          query: effectiveQuery,
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
            query: effectiveQuery,
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
            pendingClarification: undefined,
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

        if (
          !clarificationResolution &&
          queryRoute.requiresEntityResolution &&
          localResolution.ambiguous.length > 0
        ) {
          const evidenceBundle = this.evidenceAgentService.buildBundle({
            query: effectiveQuery,
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
              pendingClarification: this.createPendingClarificationState({
                kind: 'visible-graph-ambiguity',
                originalQuery: effectiveQuery,
                intent,
                queryRoute,
                extractedQuery,
                resolvedEntities: [...selectedEntities],
                ambiguity: {
                  mention: localResolution.ambiguous[0]?.mention ?? '',
                  candidates: localResolution.ambiguous[0]?.candidates.map((candidate) => ({
                    id: candidate.id,
                    query: localResolution.ambiguous[0]?.mention ?? candidate.label,
                    displayName: candidate.label,
                    typeCode: candidate.nodeType ?? 'Entity',
                    typeName: candidate.nodeType ?? 'Entity',
                    confidence: 0.95,
                    matchedOn: ['visible-graph-ambiguity'],
                    resolutionStage: 'exact',
                    source: 'selected',
                  })),
                },
              }),
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
        const resolvedQueryEntities = clarificationResolution?.resolvedEntities
          ? clarificationResolution.resolvedEntities
          : queryRoute.requiresEntityResolution
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
        const unresolvedMentions = clarificationResolution
          ? []
          : queryRoute.requiresEntityResolution
            ? this.getUnresolvedMentionTexts(extractedQuery.mentions, resolvedQueryEntities)
            : [];

        if (isDiscoveryMode) {
          const discoveryAssessment = this.assessDiscoveryQueryBroadness({
            query: effectiveQuery,
            extractedQuery,
            resolvedEntities,
          });
          if (discoveryAssessment.shouldClarify) {
            const evidenceBundle = this.evidenceAgentService.buildBundle({
              query: effectiveQuery,
              items: [
                {
                  id: `discovery-broad-${Date.now()}`,
                  kind: 'query',
                  title: 'Discovery query needs a narrower anchor',
                  summary: discoveryAssessment.summary,
                  score: 0.58,
                  nodeIds: [],
                  edgeIds: [],
                  metadata: {
                    suggestions: discoveryAssessment.suggestions,
                    broadnessReason: discoveryAssessment.reason,
                  },
                },
              ],
              resolvedEntities,
              plan: [
                {
                  id: `clarify-discovery-${Date.now()}`,
                  intent: 'graph-discovery',
                  operation: 'discover-graph',
                  executor: 'retrieval-operations',
                  tool: 'discoverGraph',
                  description: 'Clarify the initial graph anchor before generating a discovery graph.',
                  params: {
                    suggestions: discoveryAssessment.suggestions,
                    broadnessReason: discoveryAssessment.reason,
                  },
                },
              ],
              warnings: [
                'The current graph is empty, and the query is too broad to generate a useful initial network safely.',
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
              `${discoveryAssessment.summary} Try one of these narrower starting points: ${discoveryAssessment.suggestions.join('; ')}.`,
            );
            return;
          }

          const discoveryAmbiguities = await this.findDiscoveryAmbiguities(extractedQuery, unresolvedMentions);
          if (discoveryAmbiguities.length > 0) {
            const evidenceBundle = this.evidenceAgentService.buildBundle({
              query: effectiveQuery,
              items: discoveryAmbiguities.map((ambiguity, index) => ({
                id: `discovery-ambiguity-${index}`,
                kind: 'query' as const,
                title: `Ambiguous discovery seed: ${ambiguity.mention}`,
                summary: `I found ${ambiguity.candidates.length} OptimusKG candidates for "${ambiguity.mention}": ${ambiguity.candidates.map((candidate) => `${candidate.displayName} (${candidate.typeName})`).join(', ')}.`,
                score: 0.66,
                nodeIds: ambiguity.candidates.map((candidate) => candidate.id),
                edgeIds: [],
                metadata: {
                  mention: ambiguity.mention,
                  candidates: ambiguity.candidates.map((candidate) => ({
                    id: candidate.id,
                    displayName: candidate.displayName,
                    typeName: candidate.typeName,
                    matchedOn: candidate.matchedOn,
                    score: candidate.score,
                  })),
                },
              })),
              resolvedEntities,
              plan: [
                {
                  id: `clarify-discovery-ambiguity-${Date.now()}`,
                  intent: 'graph-discovery',
                  operation: 'find-candidate-entities',
                  executor: 'retrieval-operations',
                  tool: 'findCandidateEntities',
                  description: 'Clarify the intended discovery seed before generating a graph.',
                  params: {
                    ambiguities: discoveryAmbiguities.map((ambiguity) => ({
                      mention: ambiguity.mention,
                      candidates: ambiguity.candidates.map((candidate) => ({
                        id: candidate.id,
                        displayName: candidate.displayName,
                        typeName: candidate.typeName,
                      })),
                    })),
                  },
                },
              ],
              warnings: discoveryAmbiguities.map(
                (ambiguity) =>
                  `The empty-canvas graph request is ambiguous for "${ambiguity.mention}". Refine which OptimusKG entity should seed the graph.`,
              ),
              selectedNodeIds: [],
              visibleNodeIds: promptDto.networkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
              replanAttempts: 0,
            });

            const nextState = await this.conversationStateService.saveConversationGraphState(
              this.buildNextState({
                previousState,
                sessionId,
                resolvedEntities,
                evidenceBundle,
                selectedNodeIds: [],
                selectedEdgeIds: [],
                networkContext: promptDto.networkContext,
                pendingClarification: this.createPendingClarificationState({
                  kind: 'discovery-ambiguity',
                  originalQuery: effectiveQuery,
                  intent,
                  queryRoute,
                  extractedQuery,
                  resolvedEntities,
                  ambiguity: {
                    mention: discoveryAmbiguities[0]?.mention ?? '',
                    candidates: (discoveryAmbiguities[0]?.candidates ?? []).map((candidate) => ({
                      id: candidate.id,
                      query: discoveryAmbiguities[0]?.mention ?? candidate.displayName,
                      displayName: candidate.displayName,
                      typeCode: candidate.typeName,
                      typeName: candidate.typeName,
                      confidence: candidate.score,
                      matchedOn: candidate.matchedOn,
                      resolutionStage: 'semantic',
                      source: 'query',
                    })),
                  },
                }),
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
              discoveryAmbiguities
                .map(
                  (ambiguity) =>
                    `I found ${ambiguity.candidates.length} OptimusKG candidates for "${ambiguity.mention}": ${ambiguity.candidates.map((candidate) => `${candidate.displayName} (${candidate.typeName})`).join(', ')}. Which one should I use to seed the graph?`,
                )
                .join(' '),
            );
            return;
          }
        }

        if (
          queryRoute.requiresEntityResolution &&
          this.shouldBlockOnUnresolvedMentions(extractedQuery.mentions.length, intent.operation, unresolvedMentions)
        ) {
          const evidenceBundle = this.evidenceAgentService.buildBundle({
            query: effectiveQuery,
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
            isDiscoveryMode
              ? `I could not confidently resolve these explicit mentions in OptimusKG to seed a new graph: ${unresolvedMentions.join(', ')}. Refine the names or ask for a narrower graph topic and try again.`
              : `I could not confidently resolve these explicit mentions in OptimusKG: ${unresolvedMentions.join(', ')}. Refine the names or select the intended nodes in the graph and ask again.`,
          );
          return;
        }

        let accumulatedPlan = this.retrievalPlanningAgentService.plan({
          query: effectiveQuery,
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
            query: effectiveQuery,
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
            query: effectiveQuery,
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
            query: effectiveQuery,
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
            pendingClarification: undefined,
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
          query: effectiveQuery,
          evidence: evidenceBundle,
          resolvedEntities,
          graphContext,
          graphActions: this.deduplicateGraphActions(accumulatedGraphActions),
        });

        if (!synthesisStream) {
          this.writeText(
            writer,
            this.reasoningAgentService.createFallbackAnswer(effectiveQuery, evidenceBundle),
          );
          return;
        }

        writer.merge(
          synthesisStream.toUIMessageStream<GraphAgentUIMessage>({
            onError: () => this.reasoningAgentService.createFallbackAnswer(effectiveQuery, evidenceBundle),
          }),
        );
      },
      onError: (error) => {
        return error instanceof Error ? error.message : 'Graph-agent request failed';
      },
    });
  }

  private resolvePendingClarification(
    pendingClarification: PendingClarificationState | undefined,
    query: string,
  ):
    | {
        originalQuery: string;
        queryRoute: QueryRoute;
        extractedQuery: ExtractedQuery;
        intent: QueryIntentClassification;
        resolvedEntities: ResolvedEntity[];
      }
    | undefined {
    if (!pendingClarification) {
      return undefined;
    }

    const selectedCandidates = this.selectClarificationCandidates(pendingClarification, query);
    if (selectedCandidates.length === 0) {
      return undefined;
    }

    return {
      originalQuery: pendingClarification.originalQuery,
      queryRoute: {
        category: pendingClarification.pendingCategory,
        intent: pendingClarification.pendingOperation,
        requiresEntityExtraction: false,
        requiresEntityResolution: false,
        requiresGraphContext: pendingClarification.kind === 'visible-graph-ambiguity',
        preferredExecutor:
          pendingClarification.pendingCategory === 'CYPHER_QUERY' ? 'cypher' : 'mixed',
        reasons: ['resumed-pending-clarification'],
        signals: {
          hasGraphReference: pendingClarification.kind === 'visible-graph-ambiguity',
          hasExplicitEntitySignal: true,
          hasCypherSignal: pendingClarification.pendingCategory === 'CYPHER_QUERY',
          hasSelectionContext: pendingClarification.kind === 'visible-graph-ambiguity',
          hasDiscoveryTrigger: pendingClarification.pendingCategory === 'GRAPH_DISCOVERY_QUERY',
        },
      },
      extractedQuery: pendingClarification.extractedQuery,
      intent: {
        primary: pendingClarification.pendingIntent,
        operation: pendingClarification.pendingOperation,
        requestedEntityTypes: [],
        allowContextFallback: true,
      },
      resolvedEntities: this.mergeResolvedEntityLists(
        pendingClarification.resolvedEntities,
        selectedCandidates,
      ),
    };
  }

  private selectClarificationCandidates(
    pendingClarification: PendingClarificationState,
    query: string,
  ) {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    if (
      /^(all|all of them|use all|show everything|everything|all candidates|include all|all of those)$/i.test(
        normalizedQuery,
      )
    ) {
      return pendingClarification.candidateEntities;
    }

    const ordinalMatch =
      normalizedQuery.match(/\b(first|1st|one|1)\b/) ??
      normalizedQuery.match(/\b(second|2nd|two|2)\b/) ??
      normalizedQuery.match(/\b(third|3rd|three|3)\b/) ??
      normalizedQuery.match(/\b(fourth|4th|four|4)\b/);
    if (ordinalMatch) {
      const ordinalMap: Record<string, number> = {
        first: 0,
        '1st': 0,
        one: 0,
        '1': 0,
        second: 1,
        '2nd': 1,
        two: 1,
        '2': 1,
        third: 2,
        '3rd': 2,
        three: 2,
        '3': 2,
        fourth: 3,
        '4th': 3,
        four: 3,
        '4': 3,
      };
      const candidateIndex = ordinalMap[ordinalMatch[1].toLowerCase()];
      const candidate = pendingClarification.candidateEntities[candidateIndex];
      return candidate ? [candidate] : [];
    }

    return pendingClarification.candidateEntities.filter((candidate) =>
      this.matchesClarificationCandidate(candidate, normalizedQuery),
    );
  }

  private matchesClarificationCandidate(candidate: ResolvedEntity, normalizedQuery: string) {
    const candidateTerms = new Set<string>();
    candidateTerms.add(candidate.displayName.trim().toLowerCase());
    candidateTerms.add(candidate.query.trim().toLowerCase());
    candidate.matchedOn.forEach((term) => candidateTerms.add(term.trim().toLowerCase()));

    for (const term of candidateTerms) {
      if (!term) {
        continue;
      }

      if (term === normalizedQuery || term.includes(normalizedQuery) || normalizedQuery.includes(term)) {
        return true;
      }
    }

    return false;
  }

  private mergeResolvedEntityLists(primary: ResolvedEntity[], secondary: ResolvedEntity[]) {
    const merged = new Map<string, ResolvedEntity>();
    for (const entity of [...primary, ...secondary]) {
      const existing = merged.get(entity.id);
      if (!existing || entity.confidence > existing.confidence) {
        merged.set(entity.id, entity);
      }
    }

    return [...merged.values()];
  }

  private createPendingClarificationState(params: {
    kind: PendingClarificationState['kind'];
    originalQuery: string;
    intent: QueryIntentClassification;
    queryRoute: QueryRoute;
    extractedQuery: ExtractedQuery;
    resolvedEntities: ResolvedEntity[];
    ambiguity: {
      mention: string;
      candidates: ResolvedEntity[] | undefined;
    };
  }): PendingClarificationState | undefined {
    const candidateEntities = (params.ambiguity.candidates ?? []).filter(
      (candidate) => candidate.id.trim().length > 0,
    );
    if (!params.ambiguity.mention.trim() || candidateEntities.length === 0) {
      return undefined;
    }

    return {
      kind: params.kind,
      originalQuery: params.originalQuery,
      pendingIntent: params.intent.primary,
      pendingOperation: params.intent.operation,
      pendingCategory: params.queryRoute.category,
      extractedQuery: params.extractedQuery,
      resolvedEntities: params.resolvedEntities,
      unresolvedEntity: params.ambiguity.mention,
      candidateEntities,
      createdAt: new Date().toISOString(),
    };
  }

  private buildNextState(params: {
    previousState: ConversationGraphState;
    sessionId: string;
    resolvedEntities: ConversationGraphState['activeEntities'];
    evidenceBundle: ReturnType<EvidenceAgentService['buildBundle']>;
    selectedNodeIds: string[];
    selectedEdgeIds: string[];
    networkContext?: GraphNetworkContext;
    pendingClarification?: PendingClarificationState;
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
      pendingClarification: params.pendingClarification,
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

  private async findDiscoveryAmbiguities(extractedQuery: ExtractedQuery, unresolvedMentions: string[]) {
    const unresolvedMentionLookup = new Set(unresolvedMentions.map((mention) => mention.trim().toLowerCase()));
    const ambiguities: Array<{
      mention: string;
      candidates: Awaited<ReturnType<EntityResolutionAgentService['findEntityCandidates']>>;
    }> = [];

    for (const mention of extractedQuery.mentions) {
      const normalizedMention = mention.text.trim().toLowerCase();
      if (!unresolvedMentionLookup.has(normalizedMention)) {
        continue;
      }

      const candidates = await this.entityResolutionAgentService.findEntityCandidates(mention.text, mention.typeHints, 6);
      if (candidates.length > 1) {
        ambiguities.push({
          mention: mention.text,
          candidates,
        });
      }
    }

    return ambiguities;
  }

  private assessDiscoveryQueryBroadness(params: {
    query: string;
    extractedQuery: ExtractedQuery;
    resolvedEntities: ResolvedEntity[];
  }) {
    const { query, extractedQuery, resolvedEntities } = params;
    if (resolvedEntities.length > 0) {
      return {
        shouldClarify: false,
        reason: '',
        summary: '',
        suggestions: [] as string[],
      };
    }

    const normalized = query.trim().toLowerCase();
    const broadTokens = [
      'cancer',
      'oncology',
      'tumor',
      'heart disease',
      'cardiovascular disease',
      'dementia',
      'neurodegeneration',
      'inflammation',
      'genes',
      'proteins',
      'drugs',
      'pathways',
      'biomarkers',
      'phenotypes',
    ];
    const isVeryShort = normalized.split(/\s+/).filter((token) => token.length > 0).length <= 3;
    const hasOnlyGenericConcepts =
      extractedQuery.mentions.length === 0 &&
      extractedQuery.concepts.length > 0 &&
      extractedQuery.concepts.every((concept) => ['disease-area', 'entity-class', 'general'].includes(concept.category));
    const lacksConcreteEntitySignal =
      extractedQuery.mentions.length === 0 &&
      !/\b[A-Z0-9-]{2,12}\b/.test(query) &&
      !/\bdisease\b|\bsyndrome\b|\bdisorder\b|\bdementia\b|\bcancer\b|\bphenotype\b|\bpathway\b/i.test(query);

    const shouldClarify =
      (extractedQuery.mentions.length === 0 && extractedQuery.concepts.length === 0 && isVeryShort) ||
      (hasOnlyGenericConcepts && isVeryShort) ||
      (lacksConcreteEntitySignal && broadTokens.some((token) => normalized.includes(token)));

    if (!shouldClarify) {
      return {
        shouldClarify: false,
        reason: '',
        summary: '',
        suggestions: [] as string[],
      };
    }

    const suggestions = this.buildDiscoverySuggestions(normalized);
    return {
      shouldClarify: true,
      reason: 'broad-or-generic-empty-canvas-query',
      summary:
        'The graph is empty, and this request is too broad to choose a safe starting set of seed nodes automatically.',
      suggestions,
    };
  }

  private buildDiscoverySuggestions(normalizedQuery: string) {
    if (normalizedQuery.includes('cancer')) {
      return [
        'Show me a compact network for breast cancer genes',
        'Build a graph around EGFR signaling in lung cancer',
        'Create a network of approved drugs for colorectal cancer',
      ];
    }
    if (normalizedQuery.includes('dementia') || normalizedQuery.includes('neurodegeneration')) {
      return [
        'Build a graph for genes associated with Alzheimer disease',
        'Show a compact Parkinson disease pathway network',
        'Create a network for APOE and amyloid beta in Alzheimer disease',
      ];
    }
    if (normalizedQuery.includes('gene')) {
      return [
        'Build a graph for genes associated with Alzheimer disease',
        'Show a compact network around MAPT',
        'Create a network linking APOE and Parkinson disease',
      ];
    }
    if (normalizedQuery.includes('drug')) {
      return [
        'Build a graph for Metformin indications and targets',
        'Show approved drugs for Alzheimer disease',
        'Create a network for EGFR-targeting drugs',
      ];
    }

    return [
      'Build a graph for APOE and Alzheimer disease',
      'Show a compact network around MAPT',
      'Create a network of approved drugs for Parkinson disease',
    ];
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
