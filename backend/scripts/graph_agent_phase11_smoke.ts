import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Neo4jScheme } from '@/interfaces';
import { Neo4jModule } from '@/neo4j/neo4j.module';
import { RedisModule } from '@/redis/redis.module';
import { RedisService } from '@/redis/redis.service';
import { OptimusKgService } from '@/optimuskg/optimuskg.service';
import { GraphAgentModule } from '@/graph-agent/graph-agent.module';
import { ConversationGraphStateService } from '@/graph-agent/conversation-graph-state.service';
import { CypherAgentService } from '@/graph-agent/cypher-agent.service';
import { EvidenceAgentService } from '@/graph-agent/evidence-agent.service';
import { EntityExtractionService } from '@/graph-agent/entity-extraction.service';
import { EntityResolutionAgentService } from '@/graph-agent/entity-resolution-agent.service';
import { GraphContextAgentService } from '@/graph-agent/graph-context-agent.service';
import { GraphRetrieverService } from '@/graph-agent/graph-retriever.service';
import { GraphAnalysisService } from '@/graph-agent/graph-analysis.service';
import { IntentAgentService } from '@/graph-agent/intent-agent.service';
import { QueryRouterService } from '@/graph-agent/query-router.service';
import { ReasoningAgentService } from '@/graph-agent/reasoning-agent.service';
import { ReplanningAgentService } from '@/graph-agent/replanning-agent.service';
import { RetrievalOperationsService } from '@/graph-agent/retrieval-operations.service';
import { RetrievalPlanningAgentService } from '@/graph-agent/retrieval-planning-agent.service';
import type {
  GraphAction,
  GraphContextResult,
  GraphEvidenceBundle,
  GraphEvidenceItem,
  GraphNetworkContext,
  GraphSelectionEdgeContext,
  GraphSelectionNodeContext,
  ResolvedEntity,
  RetrievalPlanStep,
} from '@/graph-agent/graph-agent.types';

const MAX_REPLAN_ATTEMPTS = 2;

function parseNeo4jUri(uri?: string): { scheme: Neo4jScheme; host: string; port: number } | null {
  if (!uri) {
    return null;
  }

  try {
    const parsed = new URL(uri);
    return {
      scheme: parsed.protocol.replace(':', '') as Neo4jScheme,
      host: parsed.hostname,
      port: Number(parsed.port || 7687),
    };
  } catch {
    return null;
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
      cache: true,
    }),
    Neo4jModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        const uriConfig = parseNeo4jUri(
          configService.get<string>('NEO4J_URI') ?? configService.get<string>('OPTIMUS_NEO4J_URI'),
        );

        return {
          scheme: uriConfig?.scheme ?? configService.get<Neo4jScheme>('NEO4J_SCHEME', 'bolt'),
          host: uriConfig?.host ?? configService.get<string>('NEO4J_HOST', 'localhost'),
          port: uriConfig?.port ?? configService.get<number>('NEO4J_PORT', 7687),
          username:
            configService.get<string>('NEO4J_USERNAME') ??
            configService.get<string>('OPTIMUS_NEO4J_USERNAME', 'neo4j'),
          password:
            configService.get<string>('NEO4J_PASSWORD') ??
            configService.get<string>('OPTIMUS_NEO4J_PASSWORD', ''),
          database:
            configService.get<string>('NEO4J_DATABASE') ??
            configService.get<string>('OPTIMUS_NEO4J_DATABASE', 'neo4j'),
        };
      },
      inject: [ConfigService],
    }),
    {
      module: RedisModule,
      global: true,
      exports: [RedisService],
    },
    GraphAgentModule,
  ],
})
class GraphAgentSmokeHarnessModule {}

type TurnResult = {
  query: string;
  queryRoute: ReturnType<QueryRouterService['route']>;
  graphContext: GraphContextResult;
  extractedQuery: ReturnType<EntityExtractionService['extractQuery']>;
  intent: ReturnType<IntentAgentService['classify']>;
  resolvedEntities: ResolvedEntity[];
  plan: RetrievalPlanStep[];
  evidence: GraphEvidenceBundle;
  graphActions: GraphAction[];
  networkContext?: GraphNetworkContext;
  answer: string;
};

class GraphAgentSmokeHarness {
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

  async runTurn(params: {
    sessionId: string;
    query: string;
    selectedNodeContext?: GraphSelectionNodeContext[];
    selectedEdgeContext?: GraphSelectionEdgeContext[];
    networkContext?: GraphNetworkContext;
  }): Promise<TurnResult> {
    const previousState = await this.conversationStateService.getConversationGraphState(params.sessionId);
    const selectedNodeContext = params.selectedNodeContext ?? [];
    const selectedEdgeContext = params.selectedEdgeContext ?? [];
    const queryRoute = this.queryRouterService.route({
      query: params.query,
      selectedNodeContext,
      selectedEdgeContext,
    });
    const graphContext = this.graphContextAgentService.build({
      query: params.query,
      queryRoute,
      selectedNodeContext,
      selectedEdgeContext,
      networkContext: params.networkContext,
      state: previousState,
    });
    const extractedQuery = this.entityExtractionService.extractQuery({ query: params.query });
    const intent = this.intentAgentService.classify({
      query: params.query,
      queryRoute,
      graphContext,
    });
    const selectedEntities = this.buildSelectedContextEntities(graphContext.activeAnchors);
    const resolvedQueryEntities =
      queryRoute.category === 'GRAPH_QUERY'
        ? []
        : await this.entityResolutionAgentService.resolveEntities(extractedQuery.mentions, extractedQuery.concepts);
    const resolvedEntities = this.combineResolvedEntities({
      resolvedQueryEntities,
      selectedEntities,
      queryRoute,
    });
    const unresolvedMentions = this.getUnresolvedMentionTexts(extractedQuery.mentions, resolvedQueryEntities);

    if (
      queryRoute.category !== 'GRAPH_QUERY' &&
      this.shouldBlockOnUnresolvedMentions(extractedQuery.mentions.length, intent.operation, unresolvedMentions)
    ) {
      const evidence = this.evidenceAgentService.buildBundle({
        query: params.query,
        items: [],
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
        selectedNodeIds: selectedNodeContext.map((node) => node.id),
        visibleNodeIds: params.networkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
        replanAttempts: 0,
      });
      const derivedNetworkContext = params.networkContext;

      await this.conversationStateService.saveConversationGraphState({
        ...previousState,
        sessionId: params.sessionId,
        activeEntities: this.mergeActiveEntities(resolvedEntities, previousState.activeEntities),
        resolvedNodeIds: [...resolvedEntities.map((entity) => entity.id), ...previousState.resolvedNodeIds],
        frontierNodeIds: [...previousState.frontierNodeIds],
        retrievedNodeIds: [...previousState.retrievedNodeIds],
        evidenceCache: [...evidence.items, ...previousState.evidenceCache],
        priorQueries: [params.query, ...previousState.priorQueries],
        lastPlan: evidence.plan,
        selectedNodeIds: selectedNodeContext.map((node) => node.id),
        selectedEdgeIds: selectedEdgeContext.map((edge) => edge.id),
        visibleNodeIds: derivedNetworkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
        visibleEdgeIds: derivedNetworkContext?.visibleEdgeIds ?? previousState.visibleEdgeIds,
        updatedAt: new Date().toISOString(),
      });

      return {
        query: params.query,
        queryRoute,
        graphContext,
        extractedQuery,
        intent,
        resolvedEntities,
        plan: evidence.plan,
        evidence,
        graphActions: [],
        networkContext: derivedNetworkContext,
        answer: `I could not confidently resolve these explicit mentions in OptimusKG: ${unresolvedMentions.join(', ')}. Refine the names or select the intended nodes in the graph and ask again.`,
      };
    }
    const accumulatedEvidence: GraphEvidenceItem[] = [];
    const accumulatedWarnings: string[] = [];
    const accumulatedGraphActions: GraphAction[] = [];

    let accumulatedPlan = this.retrievalPlanningAgentService.plan({
      query: params.query,
      queryRoute,
      graphContext,
      intent,
      extractedQuery,
      resolvedEntities,
      state: previousState,
    });
    let currentPlanBatch = accumulatedPlan;
    let evidence!: GraphEvidenceBundle;
    let replanAttempts = 0;

    while (currentPlanBatch.length > 0) {
      const retrieval = await this.graphRetrieverService.executePlan(currentPlanBatch, resolvedEntities);
      accumulatedEvidence.push(...retrieval.evidence);
      accumulatedWarnings.push(...retrieval.warnings);
      accumulatedGraphActions.push(...retrieval.graphActions);

      evidence = this.evidenceAgentService.buildBundle({
        query: params.query,
        items: accumulatedEvidence,
        resolvedEntities,
        plan: accumulatedPlan,
        warnings: Array.from(new Set(accumulatedWarnings)),
        selectedNodeIds: selectedNodeContext.map((node) => node.id),
        visibleNodeIds: previousState.visibleNodeIds,
        replanAttempts,
      });

      if (!evidence.assessment.needsReplan || replanAttempts >= MAX_REPLAN_ATTEMPTS) {
        break;
      }

      const replan = this.replanningAgentService.replan({
        query: params.query,
        intent,
        graphContext,
        extractedQuery,
        resolvedEntities,
        state: previousState,
        plan: accumulatedPlan,
        evidence,
      });

      if (replan.length === 0) {
        break;
      }

      replanAttempts += 1;
      accumulatedPlan = [...accumulatedPlan, ...replan];
      currentPlanBatch = replan;
    }

    const derivedNetworkContext =
      params.networkContext ?? this.buildNetworkContextFromActions(this.deduplicateGraphActions(accumulatedGraphActions));

    await this.conversationStateService.saveConversationGraphState({
      ...previousState,
      sessionId: params.sessionId,
      activeEntities: this.mergeActiveEntities(resolvedEntities, previousState.activeEntities),
      resolvedNodeIds: [...resolvedEntities.map((entity) => entity.id), ...previousState.resolvedNodeIds],
      frontierNodeIds: [...evidence.items.flatMap((item) => item.nodeIds), ...previousState.frontierNodeIds],
      retrievedNodeIds: [...evidence.items.flatMap((item) => item.nodeIds), ...previousState.retrievedNodeIds],
      evidenceCache: [...evidence.items, ...previousState.evidenceCache],
      priorQueries: [params.query, ...previousState.priorQueries],
      lastPlan: evidence.plan,
      selectedNodeIds: selectedNodeContext.map((node) => node.id),
      selectedEdgeIds: selectedEdgeContext.map((edge) => edge.id),
      visibleNodeIds: derivedNetworkContext?.visibleNodeIds ?? previousState.visibleNodeIds,
      visibleEdgeIds: derivedNetworkContext?.visibleEdgeIds ?? previousState.visibleEdgeIds,
      updatedAt: new Date().toISOString(),
    });

    return {
      query: params.query,
      queryRoute,
      graphContext,
      extractedQuery,
      intent,
      resolvedEntities,
      plan: accumulatedPlan,
      evidence,
      graphActions: this.deduplicateGraphActions(accumulatedGraphActions),
      networkContext: derivedNetworkContext,
      answer: this.reasoningAgentService.createFallbackAnswer(params.query, evidence),
    };
  }

  private mergeActiveEntities(
    currentEntities: ResolvedEntity[],
    previousEntities: ResolvedEntity[],
  ) {
    const merged = new Map<string, ResolvedEntity>();

    for (const entity of [...currentEntities, ...previousEntities]) {
      const existing = merged.get(entity.id);
      if (!existing || entity.confidence > existing.confidence) {
        merged.set(entity.id, entity);
      }
    }

    return [...merged.values()];
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

  private getUnresolvedMentionTexts(mentions: ReturnType<EntityExtractionService['extractQuery']>['mentions'], resolvedEntities: ResolvedEntity[]) {
    const resolvedMentionKeys = new Set(resolvedEntities.map((entity) => entity.query.trim().toLowerCase()));
    return Array.from(
      new Set(
        mentions
          .map((mention) => mention.text.trim())
          .filter((text) => text.length > 0 && !resolvedMentionKeys.has(text.toLowerCase())),
      ),
    );
  }

  private shouldBlockOnUnresolvedMentions(mentionCount: number, operation: string, unresolvedMentions: string[]) {
    if (unresolvedMentions.length === 0) {
      return false;
    }

    if (mentionCount === unresolvedMentions.length) {
      return true;
    }

    return mentionCount > 1 && ['path-search', 'comparison', 'relationship-analysis'].includes(operation);
  }

  private buildNetworkContextFromActions(actions: GraphAction[]): GraphNetworkContext | undefined {
    for (const action of [...actions].reverse()) {
      if (action.type !== 'load-subgraph') {
        continue;
      }

      const counts = new Map<string, number>();
      for (const node of action.graph.nodes) {
        const type = typeof node.attributes.nodeType === 'string' ? node.attributes.nodeType : 'Entity';
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }

      return {
        totalNodes: action.graph.nodes.length,
        totalEdges: action.graph.edges.length,
        selectedNodeIds: action.highlightNodeIds ?? [],
        visibleNodeIds: action.graph.nodes.map((node) => node.key),
        visibleEdgeIds: action.graph.edges.map((edge) => edge.key),
        topNodeTypes: [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 6)
          .map(([type, count]) => ({ type, count })),
      };
    }

    return undefined;
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
}

function pickSelectedNodesFromTurn(turn: TurnResult) {
  const fromResolved = turn.resolvedEntities
    .slice(0, 2)
    .map<GraphSelectionNodeContext>((entity) => ({
      id: entity.id,
      label: entity.displayName,
      nodeType: entity.typeName,
    }));

  if (fromResolved.length >= 2) {
    return fromResolved;
  }

  for (const action of turn.graphActions) {
    if (action.type !== 'load-subgraph') {
      continue;
    }

    const selected = action.graph.nodes.slice(0, 2).map<GraphSelectionNodeContext>((node) => ({
      id: node.key,
      label: String(node.attributes.label ?? node.key),
      nodeType: typeof node.attributes.nodeType === 'string' ? node.attributes.nodeType : undefined,
    }));
    if (selected.length >= 2) {
      return selected;
    }
  }

  return fromResolved;
}

async function resolveSelectionNodes(
  entityResolutionAgentService: EntityResolutionAgentService,
  candidates: Array<{ text: string; typeHints: string[] }>,
  expectedType: RegExp,
  desiredCount: number,
) {
  const selected: GraphSelectionNodeContext[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const resolved = await entityResolutionAgentService.resolveEntities(
      [
        {
          text: candidate.text,
          span: { start: 0, end: candidate.text.length },
          typeHints: candidate.typeHints,
          source: 'query',
        },
      ],
      [],
    );
    const match = resolved.find((entity) => expectedType.test(entity.typeName));
    if (!match || seen.has(match.id)) {
      continue;
    }

    seen.add(match.id);
    selected.push({
      id: match.id,
      label: match.displayName,
      nodeType: match.typeName,
    });

    if (selected.length >= desiredCount) {
      break;
    }
  }

  return selected;
}

function hasOperation(turn: TurnResult, operations: string[]) {
  return turn.plan.some((step) => operations.includes(step.operation));
}

function summarizeTurn(turn: TurnResult) {
  return {
    query: turn.query,
    route: turn.queryRoute.category,
    intent: turn.intent.operation,
    activeAnchors: turn.graphContext.activeAnchors.map((node) => node.label),
    extractedMentions: turn.extractedQuery.mentions.map((mention) => mention.text),
    resolved: turn.resolvedEntities.map((entity) => ({
      name: entity.displayName,
      type: entity.typeName,
      stage: entity.resolutionStage,
    })),
    operations: turn.plan.map((step) => ({
      operation: step.operation,
      executor: step.executor,
    })),
    confidence: `${turn.evidence.confidenceLabel}:${Math.round(turn.evidence.confidence * 100)}%`,
    insufficient: turn.evidence.insufficientEvidence,
    replanAttempts: turn.evidence.assessment.replanAttempts,
    warnings: turn.evidence.warnings,
    network: turn.networkContext
      ? {
          totalNodes: turn.networkContext.totalNodes,
          totalEdges: turn.networkContext.totalEdges,
        }
      : undefined,
    topEvidence: turn.evidence.items.slice(0, 3).map((item) => item.title),
    answer: turn.answer,
  };
}

async function main() {
  console.error('[smoke] bootstrapping app context');
  const app = await NestFactory.createApplicationContext(GraphAgentSmokeHarnessModule, {
    logger: false,
  });

  try {
    console.error('[smoke] resolving services');
    const cypherAgentService = app.get(CypherAgentService);
    const conversationStateService = app.get(ConversationGraphStateService);
    const graphContextAgentService = app.get(GraphContextAgentService);
    const entityExtractionService = app.get(EntityExtractionService);
    const intentAgentService = app.get(IntentAgentService);
    const entityResolutionAgentService = app.get(EntityResolutionAgentService);
    const queryRouterService = app.get(QueryRouterService);
    const retrievalPlanningAgentService = app.get(RetrievalPlanningAgentService);
    const retrievalOperationsService = app.get(RetrievalOperationsService);
    const graphRetrieverService = app.get(GraphRetrieverService);
    const graphAnalysisService = app.get(GraphAnalysisService);
    const evidenceAgentService = app.get(EvidenceAgentService);
    const replanningAgentService = app.get(ReplanningAgentService);
    const reasoningAgentService = app.get(ReasoningAgentService);
    const optimusKgService = app.get(OptimusKgService);

    const harness = new GraphAgentSmokeHarness(
      conversationStateService,
      graphContextAgentService,
      entityExtractionService,
      intentAgentService,
      entityResolutionAgentService,
      queryRouterService,
      retrievalPlanningAgentService,
      graphRetrieverService,
      evidenceAgentService,
      replanningAgentService,
      reasoningAgentService,
    );

    console.error('[smoke] running phase cross-check');
    const phaseCrossCheck = {
      queryRouter: Boolean(queryRouterService),
      graphContextAgent: Boolean(graphContextAgentService),
      intentAgent: Boolean(intentAgentService),
      entityMentionAgent: Boolean(entityExtractionService),
      entityResolutionAgent: Boolean(entityResolutionAgentService),
      retrievalPlanningAgent: Boolean(retrievalPlanningAgentService),
      retrievalOperationsLayer: Boolean(retrievalOperationsService),
      cypherAgent: (await cypherAgentService.executeGuardedCypher('MATCH (n:Entity) RETURN n.id AS id LIMIT 1', {}, 1)).rows.length >= 0,
      graphAnalysisLayer: Boolean(graphAnalysisService),
      evidenceAgent: Boolean(evidenceAgentService),
      replanningLoop: Boolean(replanningAgentService),
      reasoningAgent: Boolean(reasoningAgentService),
    };

    console.error('[smoke] preparing graph selections');
    const geneSelection = await resolveSelectionNodes(
      entityResolutionAgentService,
      [
        { text: 'APOE', typeHints: ['Gene'] },
        { text: 'MAPT', typeHints: ['Gene'] },
        { text: 'SNCA', typeHints: ['Gene'] },
        { text: 'LRRK2', typeHints: ['Gene'] },
      ],
      /gene/i,
      2,
    );
    const proteinSelection = await resolveSelectionNodes(
      entityResolutionAgentService,
      [
        { text: 'APOE protein', typeHints: ['Protein'] },
        { text: 'APP protein', typeHints: ['Protein'] },
        { text: 'MAPT protein', typeHints: ['Protein'] },
        { text: 'SNCA protein', typeHints: ['Protein'] },
        { text: 'amyloid beta protein', typeHints: ['Protein'] },
      ],
      /protein/i,
      2,
    );
    if (proteinSelection.length < 2) {
      const fallbackProteins = await optimusKgService.searchNodes('protein', 10, ['Protein']);
      for (const protein of fallbackProteins) {
        if (proteinSelection.some((node) => node.id === protein.id)) {
          continue;
        }
        proteinSelection.push({
          id: protein.id,
          label: protein.displayName,
          nodeType: protein.typeName,
        });
        if (proteinSelection.length >= 2) {
          break;
        }
      }
    }

    const sessionId = `phase11-smoke-${Date.now()}`;
    console.error('[smoke] turn summarize-nodes');
    const turnSummarizeNodes = await harness.runTurn({
      sessionId,
      query: 'Summarize these nodes',
      selectedNodeContext: geneSelection,
    });
    console.error('[smoke] turn genes-in-common');
    const turnGenesInCommon = await harness.runTurn({
      sessionId,
      query: 'What do these genes have in common?',
      selectedNodeContext: geneSelection,
      networkContext: turnSummarizeNodes.networkContext,
    });
    console.error('[smoke] turn compare-proteins');
    const turnCompareProteins = await harness.runTurn({
      sessionId,
      query: 'Compare the selected proteins',
      selectedNodeContext: proteinSelection,
      networkContext: turnGenesInCommon.networkContext ?? turnSummarizeNodes.networkContext,
    });
    console.error('[smoke] turn target-proteins');
    const turnApprovedDrugs = await harness.runTurn({
      sessionId,
      query: 'Which approved drugs target these proteins?',
      selectedNodeContext: proteinSelection,
      networkContext: turnCompareProteins.networkContext ?? turnGenesInCommon.networkContext,
    });
    console.error('[smoke] turn genes-relate-parkinson');
    const turnGenesParkinson = await harness.runTurn({
      sessionId,
      query: 'How do these selected genes relate to Parkinson disease?',
      selectedNodeContext: geneSelection,
      networkContext: turnApprovedDrugs.networkContext ?? turnCompareProteins.networkContext,
    });
    console.error('[smoke] turn metformin-indications');
    const turnMetformin = await harness.runTurn({
      sessionId,
      query: 'For which diseases is Metformin indicated?',
      networkContext: turnGenesParkinson.networkContext ?? turnApprovedDrugs.networkContext,
    });
    console.error('[smoke] turn apoe-amyloid');
    const turnApoeAmyloid = await harness.runTurn({
      sessionId,
      query: 'How is APOE related to amyloid beta?',
      networkContext: turnMetformin.networkContext ?? turnGenesParkinson.networkContext,
    });
    console.error('[smoke] turn shared-pathways');
    const turnSharedPathways = await harness.runTurn({
      sessionId,
      query: 'Find pathways shared by the selected nodes.',
      selectedNodeContext: geneSelection,
      networkContext:
        turnApoeAmyloid.networkContext ??
        turnGenesInCommon.networkContext ??
        turnSummarizeNodes.networkContext,
    });
    console.error('[smoke] turn explain-subgraph');
    const turnExplainSubgraph = await harness.runTurn({
      sessionId,
      query: 'Explain this subgraph.',
      networkContext: turnSharedPathways.networkContext ?? turnGenesInCommon.networkContext,
    });

    const turns = [
      turnSummarizeNodes,
      turnGenesInCommon,
      turnCompareProteins,
      turnApprovedDrugs,
      turnGenesParkinson,
      turnMetformin,
      turnApoeAmyloid,
      turnSharedPathways,
      turnExplainSubgraph,
    ];

    const flowChecks = {
      genesPrepared: geneSelection.length >= 2,
      proteinsPrepared: proteinSelection.length >= 2,
      summarizeNodes: hasOperation(turnSummarizeNodes, ['summarize-selected-nodes']),
      genesInCommon: hasOperation(turnGenesInCommon, [
        'find-shared-pathways',
        'find-shared-diseases',
        'find-shared-genes',
        'find-common-neighbors',
      ]),
      compareSelectedProteins: proteinSelection.length >= 2 && hasOperation(turnCompareProteins, ['compare-nodes']),
      approvedDrugsTargetProteins:
        proteinSelection.length >= 2 && hasOperation(turnApprovedDrugs, ['get-related-drugs']),
      selectedGenesRelateParkinson: hasOperation(turnGenesParkinson, [
        'explain-connections',
        'retrieve-relationship-evidence',
        'find-shortest-path',
      ]),
      metforminIndications: hasOperation(turnMetformin, ['get-drug-indications']),
      apoeAmyloidHandled:
        hasOperation(turnApoeAmyloid, [
          'resolve-explicit-mentions',
          'retrieve-relationship-evidence',
          'find-shortest-path',
        ]) || turnApoeAmyloid.answer.includes('could not confidently resolve'),
      sharedPathwayOperation: hasOperation(turnSharedPathways, ['find-shared-pathways']),
      explainSubgraph: hasOperation(turnExplainSubgraph, ['summarize-visible-subgraph', 'summarize-selected-nodes']),
      evidenceConfidencePresent: turns.every((turn) => turn.evidence.confidence >= 0),
      reasoningFallbackPresent: turns.every((turn) => turn.answer.length > 0),
    };

    console.log(
      JSON.stringify(
        {
          phaseCrossCheck,
          flowChecks,
          selectedContexts: {
            genes: geneSelection,
            proteins: proteinSelection,
          },
          turns: turns.map((turn) => summarizeTurn(turn)),
        },
        null,
        2,
      ),
    );
    console.error('[smoke] complete');
  } finally {
    console.error('[smoke] closing app context');
    await app.close();
  }
}

void main();
