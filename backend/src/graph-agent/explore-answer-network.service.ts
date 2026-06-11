import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DEFAULT_MODEL, type ModelId } from '@/llm/model.constants';
import {
  buildExploreAnswerEntityExtractionPrompt,
  EXPLORE_ANSWER_ENTITY_EXTRACTION_SYSTEM_PROMPT,
} from '@/llm/system-prompts';
import {
  OptimusKgService,
  type OptimusResolutionCandidate,
  type SerializedGraphPayload,
} from '@/optimuskg/optimuskg.service';
import { RedisService } from '@/redis/redis.service';
import type {
  ExploreAnswerNetworkBuildDto,
  ExploreAnswerNetworkPrepareDto,
} from './graph-agent.dto';
import { ConversationGraphStateService } from './conversation-graph-state.service';
import { EvidenceAgentService } from './evidence-agent.service';
import { GraphAgentLlmService } from './graph-agent-llm.service';
import type {
  ConversationGraphState,
  GraphAction,
  GraphEvidenceBundle,
  GraphEvidenceItem,
  ResolvedEntity,
  RetrievalPlanStep,
} from './graph-agent.types';
import { createStepId, matchesType } from './graph-agent.utils';

const SUPPORTED_NODE_TYPES = [
  'Gene',
  'Disease',
  'BiologicalProcess',
  'Phenotype',
  'Drug',
  'Anatomy',
  'MolecularFunction',
  'CellularComponent',
  'Pathway',
  'Exposure',
] as const;

const EXTRACTED_ITEM_KIND_VALUES = ['entity', 'concept'] as const;
const ACCEPTED_SEED_KIND_VALUES = ['primary', 'related'] as const;
const REJECTED_REASON_VALUES = ['no_match', 'below_threshold', 'ambiguous', 'deprioritized'] as const;
const CANDIDATE_STAGE_VALUES = [
  'exact-typed',
  'alias-typed',
  'synonym-typed',
  'identifier-typed',
  'exact-any',
  'alias-any',
  'synonym-any',
  'identifier-any',
  'semantic',
] as const;

type SupportedNodeType = (typeof SUPPORTED_NODE_TYPES)[number];
type ExtractedItemKind = (typeof EXTRACTED_ITEM_KIND_VALUES)[number];
type AcceptedSeedKind = (typeof ACCEPTED_SEED_KIND_VALUES)[number];
type RejectedReason = (typeof REJECTED_REASON_VALUES)[number];
type CandidateStage = (typeof CANDIDATE_STAGE_VALUES)[number];

const IntentSchema = z.object({
  primaryGoal: z.string().trim().min(1).max(80).default('General Exploration'),
  focusNodeTypes: z.array(z.enum(SUPPORTED_NODE_TYPES)).max(6).default([]),
  preferredExpansionTypes: z.array(z.enum(SUPPORTED_NODE_TYPES)).max(8).default([]),
});

const EXTRACTION_SCHEMA = z.object({
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        suggestedNodeType: z.enum(SUPPORTED_NODE_TYPES),
        confidence: z.number().min(0).max(1),
        kind: z.enum(EXTRACTED_ITEM_KIND_VALUES),
      }),
    )
    .max(24)
    .default([]),
  intent: IntentSchema.default({
    primaryGoal: 'General Exploration',
    focusNodeTypes: [],
    preferredExpansionTypes: [],
  }),
});

type ExtractedItem = {
  id: string;
  name: string;
  suggestedNodeType: SupportedNodeType;
  confidence: number;
  kind: ExtractedItemKind;
};

type ExploreIntent = z.infer<typeof IntentSchema>;

type PreparedCandidate = {
  id: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  score: number;
  confidence: number;
  matchedOn: string[];
  aliases: string[];
  sourceIds: string[];
  sourceNames: string[];
  resolutionStage: NonNullable<ResolvedEntity['resolutionStage']>;
  candidateStage: CandidateStage;
  typeMatchesExpected: boolean;
};

type CandidateGroup = {
  extractedItemId: string;
  extractedName: string;
  suggestedNodeType: SupportedNodeType;
  kind: ExtractedItemKind;
  candidates: PreparedCandidate[];
};

type AcceptedSeed = {
  extractedItemId: string;
  extractedName: string;
  kind: AcceptedSeedKind;
  id: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  score: number;
  confidence: number;
  matchedOn: string[];
  candidateStage: CandidateStage;
  typeMatchesExpected: boolean;
};

type RejectedItem = {
  extractedItemId: string;
  name: string;
  suggestedNodeType: SupportedNodeType;
  reason: RejectedReason;
  detail: string;
};

type MatchedEntityTelemetry = {
  extractedItemId: string;
  extractedName: string;
  candidateCount: number;
  topCandidateId?: string;
  topCandidateLabel?: string;
  topCandidateType?: string;
};

type ExpansionCandidateTelemetry = {
  nodeId: string;
  candidateNode: string;
  typeName: string;
  graphScore: number;
  typeBonus: number;
  anchorConnectivityBonus: number;
  queryRelevanceBonus: number;
  proximityPenalty: number;
  finalScore: number;
  distanceToNearestAnchor: number;
  anchorSupportCount: number;
  connectedAnchorIds: string[];
  selected: boolean;
  selectedViaPath: boolean;
};

type FinalNodeTypeDistributionEntry = {
  typeName: string;
  count: number;
  ratio: number;
};

type GraphValidationCoverage = {
  typeName: string;
  requiredRatio: number;
  actualRatio: number;
  satisfied: boolean;
};

type GraphValidationResult = {
  status: 'pending' | 'passed' | 'failed';
  passed: boolean;
  reranked: boolean;
  seedRetention: boolean;
  intentCoverage: boolean;
  anchorConnectivity: boolean;
  relevanceCheck: boolean;
  reasons: string[];
  coverageByType: GraphValidationCoverage[];
  connectedNodeRatio: number;
  unrelatedNodeRatio: number;
};

type GraphBuildTelemetry = {
  extractedEntities: ExtractedItem[];
  matchedEntities: MatchedEntityTelemetry[];
  primarySeeds: AcceptedSeed[];
  relatedCandidates: AcceptedSeed[];
  resolvedSeeds: AcceptedSeed[];
  survivingSeeds: AcceptedSeed[];
  droppedSeeds: AcceptedSeed[];
  focusNodeTypes: SupportedNodeType[];
  preferredExpansionTypes: SupportedNodeType[];
  expansionCandidates: ExpansionCandidateTelemetry[];
  selectedExpansionNodes: ExpansionCandidateTelemetry[];
  finalNodeTypeDistribution: FinalNodeTypeDistributionEntry[];
  graphValidationResult: GraphValidationResult;
  entitiesRejected: number;
};

type StoredPreparation = {
  preparationId: string;
  sessionId: string;
  query: string;
  answer: string;
  createdAt: string;
  extractedItems: ExtractedItem[];
  intent: ExploreIntent;
  candidateGroups: CandidateGroup[];
  primarySeeds: AcceptedSeed[];
  relatedCandidates: AcceptedSeed[];
  acceptedSeeds: AcceptedSeed[];
  rejectedItems: RejectedItem[];
  telemetry: GraphBuildTelemetry;
};

@Injectable()
export class ExploreAnswerNetworkService {
  private readonly preparationTtlSeconds = 60 * 60;

  constructor(
    private readonly graphAgentLlmService: GraphAgentLlmService,
    private readonly evidenceAgentService: EvidenceAgentService,
    private readonly conversationStateService: ConversationGraphStateService,
    private readonly redisService: RedisService,
    private readonly optimusKgService: OptimusKgService,
  ) {}

  async prepare(dto: ExploreAnswerNetworkPrepareDto) {
    const sessionId = dto.sessionId?.trim() || `explore-answer-${Date.now()}`;
    const query = dto.query.trim();
    const answer = dto.answer.trim();
    const extraction = await this.extractAnswerPreparation(query, answer, dto.model as ModelId | undefined);
    const candidateGroups = await this.prepareCandidateGroups(extraction.items);
    const { primarySeeds, relatedCandidates, acceptedSeeds, rejectedItems } = this.decideSeeds(
      extraction.items,
      extraction.intent,
      candidateGroups,
    );
    const telemetry = this.buildTelemetry(
      extraction.items,
      extraction.intent,
      candidateGroups,
      primarySeeds,
      relatedCandidates,
      rejectedItems,
    );
    const preparationId = createStepId('explore-preparation');

    const stored: StoredPreparation = {
      preparationId,
      sessionId,
      query,
      answer,
      createdAt: new Date().toISOString(),
      extractedItems: extraction.items,
      intent: extraction.intent,
      candidateGroups,
      primarySeeds,
      relatedCandidates,
      acceptedSeeds,
      rejectedItems,
      telemetry,
    };

    await this.redisService.redisClient.set(
      this.cacheKey(preparationId),
      JSON.stringify(stored),
      'EX',
      this.preparationTtlSeconds,
    );

    return {
      preparationId,
      sessionId,
      extractedItems: extraction.items,
      intent: extraction.intent,
      candidateGroups,
      primarySeeds,
      relatedCandidates,
      acceptedSeeds,
      rejectedItems,
      telemetry,
      candidateCount: candidateGroups.reduce((sum, group) => sum + group.candidates.length, 0),
      topCandidates: candidateGroups
        .map((group) => group.candidates[0])
        .filter((candidate): candidate is PreparedCandidate => Boolean(candidate))
        .slice(0, 12),
    };
  }

  async build(dto: ExploreAnswerNetworkBuildDto) {
    const loaded = await this.loadPreparation(dto.preparationId);
    if (!loaded) {
      throw new NotFoundException('Prepared network state was not found or has expired.');
    }
    const stored = this.normalizeStoredPreparation(loaded);

    const sessionId = dto.sessionId?.trim() || stored.sessionId;
    const resolvedEntities = this.toResolvedEntities(stored.primarySeeds);
    if (resolvedEntities.length === 0) {
      throw new UnprocessableEntityException('No prepared graph seeds were available for this answer.');
    }

    const preferredExpansionTypes =
      stored.intent.preferredExpansionTypes.length > 0
        ? stored.intent.preferredExpansionTypes
        : Array.from(new Set(resolvedEntities.map((entity) => entity.typeName as SupportedNodeType))).slice(0, 8);
    const primarySeedCount = stored.primarySeeds.length;
    const plan: RetrievalPlanStep[] = [
      {
        id: createStepId('explore-build-network'),
        intent: 'graph-discovery',
        operation: 'build-multi-entity-network',
        executor: 'retrieval-operations',
        tool: 'buildMultiEntityNetwork',
        description: `Build an intent-aware network from accepted answer seeds: ${resolvedEntities
          .map((entity) => entity.displayName)
          .join(', ')}.`,
        params: {
          nodeIds: resolvedEntities.map((entity) => entity.id),
          nodeTypes: preferredExpansionTypes,
          aggregateMode: 'union',
          minSupport: primarySeedCount > 2 ? 2 : 1,
          limit: 28,
          maxNodes: 160,
        },
      },
    ];

    const buildResult = await this.buildIntentAwareGraph(stored);
    const graph = buildResult.graph;
    if (!graph || graph.nodes.length === 0) {
      throw new UnprocessableEntityException('The prepared answer entities did not produce a graph.');
    }

    stored.telemetry = buildResult.telemetry;
    await this.redisService.redisClient.set(
      this.cacheKey(stored.preparationId),
      JSON.stringify(stored),
      'EX',
      this.preparationTtlSeconds,
    );

    const highlightNodeIds = buildResult.highlightNodeIds;
    const graphActions = this.normalizeGraphActions([], graph, highlightNodeIds);
    const evidenceItems = this.ensureEvidenceItems(
      [],
      graph,
      resolvedEntities,
      stored,
      highlightNodeIds,
    );
    const evidenceBundle = this.evidenceAgentService.buildBundle({
      query: stored.query,
      items: evidenceItems,
      resolvedEntities,
      plan,
      warnings: buildResult.warnings,
      selectedNodeIds: highlightNodeIds,
      visibleNodeIds: graph.nodes.map((node) => node.key),
      replanAttempts: 0,
    });

    const previousState = await this.conversationStateService.getConversationGraphState(sessionId);
    const nextState = await this.conversationStateService.saveConversationGraphState(
      this.buildConversationState({
        sessionId,
        query: stored.query,
        previousState,
        resolvedEntities,
        evidenceBundle,
        plan,
        graph,
        highlightNodeIds,
      }),
    );

    return {
      sessionId,
      preparationId: stored.preparationId,
      graphEvidence: evidenceBundle,
      graphActions,
      graphState: nextState,
      seedNodeIds: resolvedEntities.map((entity) => entity.id),
      graphBuildTelemetry: buildResult.telemetry,
    };
  }

  private async extractAnswerPreparation(query: string, answer: string, model?: ModelId) {
    const structured =
      (await this.runAnswerExtraction(query, answer, model)) ??
      (model && model !== DEFAULT_MODEL
        ? await this.runAnswerExtraction(query, answer, DEFAULT_MODEL)
        : undefined);
    const llmItems = (structured?.items ?? []).map((item, index) => ({
      id: `llm-item-${index}`,
      name: this.cleanEntityName(item.name),
      suggestedNodeType: item.suggestedNodeType as SupportedNodeType,
      confidence: this.clampConfidence(item.confidence),
      kind: item.kind as ExtractedItemKind,
    }));
    const heuristicItems = this.extractHeuristicItems(answer);
    const items = this.mergeExtractedItems([...llmItems, ...heuristicItems]);
    const heuristicIntent = this.inferHeuristicIntent(query, items);
    const intent = this.mergeIntent(structured?.intent, heuristicIntent, items);

    return {
      items: items.slice(0, 20),
      intent,
    };
  }

  private runAnswerExtraction(query: string, answer: string, model?: ModelId) {
    return this.graphAgentLlmService.generateStructuredObject({
      schema: EXTRACTION_SCHEMA,
      system: EXPLORE_ANSWER_ENTITY_EXTRACTION_SYSTEM_PROMPT,
      prompt: buildExploreAnswerEntityExtractionPrompt(answer, query),
      functionId: 'explore-answer-network-extraction',
      model,
      temperature: 0,
      maxOutputTokens: 1400,
    });
  }

  private extractHeuristicItems(answer: string): ExtractedItem[] {
    const segments = answer
      .split(/\r?\n|[;,]/)
      .map((segment) => this.cleanEntityName(segment.replace(/^[-*•\d.)\s]+/, '')))
      .filter((segment) => segment.length >= 2 && segment.length <= 100);
    const items: ExtractedItem[] = [];

    for (const segment of segments) {
      const suggestedNodeType = this.inferNodeTypeFromText(segment);
      if (!suggestedNodeType) {
        continue;
      }

      items.push({
        id: `heuristic-${items.length}`,
        name: segment,
        suggestedNodeType,
        confidence: this.inferHeuristicConfidence(segment, suggestedNodeType),
        kind: this.inferItemKind(segment, suggestedNodeType),
      });
    }

    return items;
  }

  private async prepareCandidateGroups(extractedItems: ExtractedItem[]) {
    return Promise.all(
      extractedItems.map(async (item) => {
        const variants = this.buildSearchVariants(item.name, item.suggestedNodeType);
        const [typedCandidates, anyTypeCandidates] = await Promise.all([
          this.optimusKgService.resolveNodes(variants, 12, [item.suggestedNodeType]),
          this.optimusKgService.resolveNodes(variants, 16, []),
        ]);

        const candidates = this.rankCandidates(item, typedCandidates, anyTypeCandidates);
        return {
          extractedItemId: item.id,
          extractedName: item.name,
          suggestedNodeType: item.suggestedNodeType,
          kind: item.kind,
          candidates,
        } satisfies CandidateGroup;
      }),
    );
  }

  private rankCandidates(
    item: ExtractedItem,
    typedCandidates: OptimusResolutionCandidate[],
    anyTypeCandidates: OptimusResolutionCandidate[],
  ) {
    const merged = new Map<string, PreparedCandidate & { priority: number }>();

    for (const candidate of [...typedCandidates, ...anyTypeCandidates]) {
      const prepared = this.toPreparedCandidate(candidate, item.suggestedNodeType);
      const priority = this.candidatePriority(prepared);
      const existing = merged.get(prepared.id);
      if (!existing || priority > existing.priority || prepared.score > existing.score) {
        merged.set(prepared.id, {
          ...prepared,
          priority,
        });
      }
    }

    return [...merged.values()]
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          b.score - a.score ||
          b.confidence - a.confidence ||
          a.displayName.localeCompare(b.displayName),
      )
      .slice(0, 8)
      .map(({ priority: _priority, ...candidate }) => candidate);
  }

  private decideSeeds(
    extractedItems: ExtractedItem[],
    intent: ExploreIntent,
    candidateGroups: CandidateGroup[],
  ) {
    const primarySeeds: AcceptedSeed[] = [];
    const relatedCandidates: AcceptedSeed[] = [];
    const rejectedItems: RejectedItem[] = [];

    for (const item of extractedItems) {
      const group = candidateGroups.find((entry) => entry.extractedItemId === item.id);
      if (!group || group.candidates.length === 0) {
        rejectedItems.push({
          extractedItemId: item.id,
          name: item.name,
          suggestedNodeType: item.suggestedNodeType,
          reason: 'no_match',
          detail: 'No candidates were returned for this extracted item.',
        });
        continue;
      }

      const topCandidate = group.candidates[0];
      const secondCandidate = group.candidates[1];
      const acceptanceThreshold = this.minimumAcceptanceConfidence(item);
      if (
        secondCandidate &&
        topCandidate.candidateStage === secondCandidate.candidateStage &&
        Math.abs(topCandidate.score - secondCandidate.score) <= 8 &&
        Math.abs(topCandidate.confidence - secondCandidate.confidence) <= 0.05
      ) {
        rejectedItems.push({
          extractedItemId: item.id,
          name: item.name,
          suggestedNodeType: item.suggestedNodeType,
          reason: 'ambiguous',
          detail: `Top candidates "${topCandidate.displayName}" and "${secondCandidate.displayName}" were too close to choose safely.`,
        });
        continue;
      }

      if (topCandidate.confidence < acceptanceThreshold) {
        rejectedItems.push({
          extractedItemId: item.id,
          name: item.name,
          suggestedNodeType: item.suggestedNodeType,
          reason: 'below_threshold',
          detail: `Best candidate confidence ${topCandidate.confidence.toFixed(2)} was below ${acceptanceThreshold.toFixed(2)}.`,
        });
        continue;
      }

      primarySeeds.push(this.toAcceptedSeed(item, topCandidate, 'primary'));

      const relatedCandidate = group.candidates.find(
        (candidate) =>
          candidate.id !== topCandidate.id &&
          candidate.confidence >= 0.72 &&
          (
            intent.preferredExpansionTypes.includes(candidate.typeName as SupportedNodeType) ||
            candidate.typeName !== topCandidate.typeName
          ),
      );
      if (relatedCandidate) {
        relatedCandidates.push(this.toAcceptedSeed(item, relatedCandidate, 'related'));
      }
    }

    const dedupeSeeds = (seeds: AcceptedSeed[]) => {
      const deduped = new Map<string, AcceptedSeed>();
      for (const seed of seeds) {
        const key = `${seed.id}:${seed.kind}`;
        if (!deduped.has(key)) {
          deduped.set(key, seed);
        }
      }
      return [...deduped.values()];
    };

    const dedupedPrimarySeeds = dedupeSeeds(primarySeeds);
    const dedupedRelatedCandidates = dedupeSeeds(
      relatedCandidates.filter((candidate) => !dedupedPrimarySeeds.some((seed) => seed.id === candidate.id)),
    );

    return {
      primarySeeds: dedupedPrimarySeeds,
      relatedCandidates: dedupedRelatedCandidates,
      acceptedSeeds: [...dedupedPrimarySeeds, ...dedupedRelatedCandidates],
      rejectedItems,
    };
  }

  private buildTelemetry(
    extractedItems: ExtractedItem[],
    intent: ExploreIntent,
    candidateGroups: CandidateGroup[],
    primarySeeds: AcceptedSeed[],
    relatedCandidates: AcceptedSeed[],
    rejectedItems: RejectedItem[],
  ): GraphBuildTelemetry {
    return {
      extractedEntities: extractedItems,
      matchedEntities: candidateGroups.map((group) => ({
        extractedItemId: group.extractedItemId,
        extractedName: group.extractedName,
        candidateCount: group.candidates.length,
        topCandidateId: group.candidates[0]?.id,
        topCandidateLabel: group.candidates[0]?.displayName,
        topCandidateType: group.candidates[0]?.typeName,
      })),
      primarySeeds,
      relatedCandidates,
      resolvedSeeds: primarySeeds,
      survivingSeeds: [],
      droppedSeeds: [],
      focusNodeTypes: intent.focusNodeTypes,
      preferredExpansionTypes: intent.preferredExpansionTypes,
      expansionCandidates: [],
      selectedExpansionNodes: [],
      finalNodeTypeDistribution: [],
      graphValidationResult: {
        status: 'pending',
        passed: false,
        reranked: false,
        seedRetention: false,
        intentCoverage: false,
        anchorConnectivity: false,
        relevanceCheck: false,
        reasons: ['Graph has not been built yet.'],
        coverageByType: [],
        connectedNodeRatio: 0,
        unrelatedNodeRatio: 0,
      },
      entitiesRejected: rejectedItems.length,
    };
  }

  private async buildIntentAwareGraph(stored: StoredPreparation) {
    const anchorNodeIds = stored.primarySeeds.map((seed) => seed.id);
    const expansionSeedIds = this.mergeUnique(
      anchorNodeIds,
      stored.relatedCandidates.map((seed) => seed.id),
    );
    const initialRadius = expansionSeedIds.length >= 3 ? 3 : 2;
    let radius = initialRadius;
    let rawGraph = await this.optimusKgService.expandSubgraph(expansionSeedIds, radius, 480, 26, [], []);
    rawGraph = await this.ensureAnchorNodesInGraph(rawGraph, stored.primarySeeds);

    if (rawGraph.nodes.length < stored.primarySeeds.length + 12 && radius < 4) {
      radius = Math.max(radius + 1, 4);
      rawGraph = await this.optimusKgService.expandSubgraph(expansionSeedIds, radius, 640, 30, [], []);
      rawGraph = await this.ensureAnchorNodesInGraph(rawGraph, stored.primarySeeds);
    }

    const rankingContext = this.createGraphRankingContext(rawGraph, anchorNodeIds);
    const rankedCandidates = this.rankExpansionCandidates(rawGraph, stored, rankingContext);

    let selection = this.selectExpansionNodes(rawGraph, rankedCandidates, stored.intent, rankingContext, false);
    let graph = this.filterGraphToSelection(rawGraph, selection.selectedNodeIds, radius);
    let validation = this.validateGraphBuild(graph, stored.primarySeeds, stored.intent, false);

    if (!validation.passed && (!validation.intentCoverage || !validation.relevanceCheck)) {
      selection = this.selectExpansionNodes(rawGraph, rankedCandidates, stored.intent, rankingContext, true);
      graph = this.filterGraphToSelection(rawGraph, selection.selectedNodeIds, radius);
      validation = this.validateGraphBuild(graph, stored.primarySeeds, stored.intent, true);
    }

    const survivingSeeds = stored.primarySeeds.filter((seed) => graph.nodes.some((node) => node.key === seed.id));
    const droppedSeeds = stored.primarySeeds.filter((seed) => !graph.nodes.some((node) => node.key === seed.id));
    if (droppedSeeds.length > 0 && process.env.NODE_ENV !== 'production') {
      throw new Error('Anchor node removed during graph construction');
    }

    const selectedCandidateIds = new Set(selection.selectedCandidateIds);
    const selectedViaPathIds = new Set(selection.selectedViaPathIds);
    const expansionCandidates = rankedCandidates.map((candidate) => ({
      ...candidate,
      selected: selectedCandidateIds.has(candidate.nodeId),
      selectedViaPath: selectedViaPathIds.has(candidate.nodeId),
    }));
    const finalNodeTypeDistribution = this.computeNodeTypeDistribution(graph);
    const highlightNodeIds = survivingSeeds.map((seed) => seed.id).slice(0, 12);

    return {
      graph,
      highlightNodeIds,
      warnings: validation.passed ? [] : validation.reasons,
      telemetry: {
        ...stored.telemetry,
        primarySeeds: stored.primarySeeds,
        relatedCandidates: stored.relatedCandidates,
        resolvedSeeds: stored.primarySeeds,
        survivingSeeds,
        droppedSeeds,
        focusNodeTypes: stored.intent.focusNodeTypes,
        preferredExpansionTypes: stored.intent.preferredExpansionTypes,
        expansionCandidates,
        selectedExpansionNodes: expansionCandidates.filter((candidate) => candidate.selected),
        finalNodeTypeDistribution,
        graphValidationResult: validation,
      } satisfies GraphBuildTelemetry,
    };
  }

  private async ensureAnchorNodesInGraph(graph: SerializedGraphPayload, seeds: AcceptedSeed[]) {
    const missingSeeds = seeds.filter((seed) => !graph.nodes.some((node) => node.key === seed.id));
    if (missingSeeds.length === 0) {
      return graph;
    }

    const missingNodes = await Promise.all(
      missingSeeds.map(async (seed) => {
        try {
          const details = await this.optimusKgService.nodeDetails(seed.id);
          return {
            key: details.id,
            attributes: {
              ID: details.id,
              label: details.displayName,
              nodeType: details.typeName,
              typeCode: details.typeCode,
              degree: details.degree,
              ...details.properties,
            },
          };
        } catch {
          return {
            key: seed.id,
            attributes: {
              ID: seed.id,
              label: seed.displayName,
              nodeType: seed.typeName,
              typeCode: seed.typeCode,
              degree: 0,
            },
          };
        }
      }),
    );

    return {
      ...graph,
      nodes: [...graph.nodes, ...missingNodes],
    };
  }

  private createGraphRankingContext(graph: SerializedGraphPayload, anchorNodeIds: string[]) {
    const adjacency = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
      adjacency.set(node.key, new Set<string>());
    }
    for (const edge of graph.edges) {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }

    const nearestAnchor = this.computeNearestAnchorTree(adjacency, anchorNodeIds);
    const perAnchorDistances = new Map<string, Map<string, number>>();
    for (const anchorNodeId of anchorNodeIds) {
      perAnchorDistances.set(anchorNodeId, this.computeDistancesFromAnchor(adjacency, anchorNodeId, 3));
    }

    return {
      adjacency,
      nearestDistances: nearestAnchor.distances,
      nearestParents: nearestAnchor.parents,
      perAnchorDistances,
      anchorNodeIds,
    };
  }

  private rankExpansionCandidates(
    graph: SerializedGraphPayload,
    stored: StoredPreparation,
    context: ReturnType<ExploreAnswerNetworkService['createGraphRankingContext']>,
  ) {
    const anchorNodeIdSet = new Set(context.anchorNodeIds);
    const relevanceTerms = this.buildRelevanceTerms(stored);

    return graph.nodes
      .filter((node) => !anchorNodeIdSet.has(node.key))
      .map((node) => {
        const typeName = this.nodeTypeName(node);
        const distanceToNearestAnchor = context.nearestDistances.get(node.key) ?? Number.POSITIVE_INFINITY;
        const connectedAnchorIds = context.anchorNodeIds.filter((anchorId) => {
          const distance = context.perAnchorDistances.get(anchorId)?.get(node.key);
          return typeof distance === 'number' && distance <= 2;
        });
        const anchorSupportCount = connectedAnchorIds.length;
        const graphScore = Math.min(90, this.localGraphDegree(context.adjacency, node.key) * 18 + (distanceToNearestAnchor === 1 ? 12 : 0));
        const typeBonus = this.typeBonus(typeName, stored.intent);
        const queryRelevanceBonus = this.queryRelevanceBonus(node, relevanceTerms, stored.relatedCandidates);
        const proximityPenalty =
          distanceToNearestAnchor <= 1
            ? 0
            : distanceToNearestAnchor === 2
              ? -20
              : distanceToNearestAnchor === 3
                ? -50
                : -999;
        const finalScore = graphScore + typeBonus + anchorSupportCount * 50 + queryRelevanceBonus + proximityPenalty;
        const candidate = {
          nodeId: node.key,
          candidateNode: this.nodeLabel(node),
          typeName,
          graphScore,
          typeBonus,
          anchorConnectivityBonus: anchorSupportCount * 50,
          queryRelevanceBonus,
          proximityPenalty,
          finalScore,
          distanceToNearestAnchor,
          anchorSupportCount,
          connectedAnchorIds,
          selected: false,
          selectedViaPath: false,
        } satisfies ExpansionCandidateTelemetry;

        return candidate;
      })
      .filter((candidate) => {
        if (candidate.distanceToNearestAnchor <= 3) {
          return true;
        }

        return (
          stored.intent.preferredExpansionTypes.includes(candidate.typeName as SupportedNodeType) &&
          candidate.queryRelevanceBonus >= 18
        );
      })
      .sort(
        (a, b) =>
          b.finalScore - a.finalScore ||
          b.anchorSupportCount - a.anchorSupportCount ||
          a.distanceToNearestAnchor - b.distanceToNearestAnchor ||
          a.candidateNode.localeCompare(b.candidateNode),
      );
  }

  private selectExpansionNodes(
    graph: SerializedGraphPayload,
    rankedCandidates: ExpansionCandidateTelemetry[],
    intent: ExploreIntent,
    context: ReturnType<ExploreAnswerNetworkService['createGraphRankingContext']>,
    strictIntent: boolean,
  ) {
    const selectedNodeIds = new Set<string>(context.anchorNodeIds);
    const selectedCandidateIds = new Set<string>();
    const selectedViaPathIds = new Set<string>();
    const targetNodeCount = Math.min(
      Math.max(context.anchorNodeIds.length + 40, 60),
      Math.max(context.anchorNodeIds.length, Math.min(120, graph.nodes.length)),
    );
    const candidates = strictIntent
      ? rankedCandidates.filter(
          (candidate) =>
            intent.focusNodeTypes.includes(candidate.typeName as SupportedNodeType) ||
            intent.preferredExpansionTypes.includes(candidate.typeName as SupportedNodeType) ||
            candidate.anchorSupportCount > 1 ||
            candidate.queryRelevanceBonus >= 20,
        )
      : rankedCandidates;

    if (strictIntent && intent.focusNodeTypes.length > 0) {
      for (const focusType of intent.focusNodeTypes) {
        const requiredCount = this.requiredCoverageCount(focusType, targetNodeCount);
        for (const candidate of candidates) {
          if (candidate.typeName !== focusType) {
            continue;
          }
          if (this.countNodesOfType(graph, selectedNodeIds, focusType) >= requiredCount) {
            break;
          }
          this.addCandidatePath(candidate, selectedNodeIds, selectedCandidateIds, selectedViaPathIds, context);
          if (selectedNodeIds.size >= targetNodeCount) {
            break;
          }
        }
      }
    }

    for (const candidate of candidates) {
      if (selectedNodeIds.size >= targetNodeCount) {
        break;
      }
      this.addCandidatePath(candidate, selectedNodeIds, selectedCandidateIds, selectedViaPathIds, context);
    }

    return {
      selectedNodeIds: [...selectedNodeIds],
      selectedCandidateIds: [...selectedCandidateIds],
      selectedViaPathIds: [...selectedViaPathIds],
    };
  }

  private addCandidatePath(
    candidate: ExpansionCandidateTelemetry,
    selectedNodeIds: Set<string>,
    selectedCandidateIds: Set<string>,
    selectedViaPathIds: Set<string>,
    context: ReturnType<ExploreAnswerNetworkService['createGraphRankingContext']>,
  ) {
    const anchorNodeIdSet = new Set(context.anchorNodeIds);
    const pathNodeIds = this.pathToNearestAnchor(candidate.nodeId, context.nearestParents, anchorNodeIdSet);
    selectedCandidateIds.add(candidate.nodeId);
    for (const pathNodeId of pathNodeIds) {
      if (!selectedNodeIds.has(pathNodeId) && pathNodeId !== candidate.nodeId) {
        selectedViaPathIds.add(pathNodeId);
      }
      selectedNodeIds.add(pathNodeId);
    }
    selectedNodeIds.add(candidate.nodeId);
  }

  private filterGraphToSelection(graph: SerializedGraphPayload, selectedNodeIds: string[], radius: number) {
    const selectedNodeIdSet = new Set(selectedNodeIds);
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => selectedNodeIdSet.has(node.key)),
      edges: graph.edges.filter((edge) => selectedNodeIdSet.has(edge.source) && selectedNodeIdSet.has(edge.target)),
      attributes: {
        ...graph.attributes,
        radius,
      },
    };
  }

  private validateGraphBuild(
    graph: SerializedGraphPayload,
    primarySeeds: AcceptedSeed[],
    intent: ExploreIntent,
    reranked: boolean,
  ): GraphValidationResult {
    const anchorNodeIds = primarySeeds.map((seed) => seed.id);
    const anchorNodeIdSet = new Set(anchorNodeIds);
    const distribution = this.computeNodeTypeDistribution(graph);
    const distributionMap = new Map(distribution.map((entry) => [entry.typeName, entry.ratio]));
    const coverageByType = intent.focusNodeTypes.map((focusType) => {
      const requiredRatio = this.requiredCoverageRatio(focusType);
      const actualRatio = distributionMap.get(focusType) ?? 0;
      return {
        typeName: focusType,
        requiredRatio,
        actualRatio,
        satisfied: actualRatio >= requiredRatio,
      };
    });
    const seedRetention = primarySeeds.every((seed) => graph.nodes.some((node) => node.key === seed.id));
    const intentCoverage = coverageByType.every((coverage) => coverage.satisfied);
    const adjacency = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
      adjacency.set(node.key, new Set<string>());
    }
    for (const edge of graph.edges) {
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }

    const connectedToAnchors = this.computeConnectedNodes(adjacency, anchorNodeIds);
    const connectedNodeRatio = graph.nodes.length === 0 ? 0 : connectedToAnchors.size / graph.nodes.length;
    const anchorConnectivity = graph.nodes.length === 0 ? false : connectedNodeRatio >= 0.5;

    const nonAnchorNodes = graph.nodes.filter((node) => !anchorNodeIdSet.has(node.key));
    const unrelatedNodeCount = nonAnchorNodes.filter((node) => {
      const typeName = this.nodeTypeName(node);
      return (
        !intent.focusNodeTypes.includes(typeName as SupportedNodeType) &&
        !intent.preferredExpansionTypes.includes(typeName as SupportedNodeType)
      );
    }).length;
    const suspiciousLabelCount = nonAnchorNodes.filter((node) =>
      /(cartilage|skeletal|chondrocyte|facial|morphogenesis|craniofacial|limb|bone)/i.test(
        `${this.nodeLabel(node)} ${String(node.attributes.description ?? '')}`,
      ),
    ).length;
    const unrelatedNodeRatio = nonAnchorNodes.length === 0 ? 0 : unrelatedNodeCount / nonAnchorNodes.length;
    const relevanceCheck =
      suspiciousLabelCount <= Math.max(1, Math.floor(nonAnchorNodes.length * 0.18)) && unrelatedNodeRatio <= 0.45;

    const reasons: string[] = [];
    if (!seedRetention) {
      reasons.push('One or more anchor nodes were removed during graph construction.');
    }
    if (!intentCoverage) {
      reasons.push('The final graph does not satisfy the requested focus-node coverage thresholds.');
    }
    if (!anchorConnectivity) {
      reasons.push('Too many returned nodes are not connected to an anchor in the final graph.');
    }
    if (!relevanceCheck) {
      reasons.push('The final graph is dominated by off-intent or biologically unrelated regions.');
    }

    return {
      status: reasons.length === 0 ? 'passed' : 'failed',
      passed: reasons.length === 0,
      reranked,
      seedRetention,
      intentCoverage,
      anchorConnectivity,
      relevanceCheck,
      reasons,
      coverageByType,
      connectedNodeRatio,
      unrelatedNodeRatio,
    };
  }

  private computeNodeTypeDistribution(graph: SerializedGraphPayload): FinalNodeTypeDistributionEntry[] {
    if (graph.nodes.length === 0) {
      return [];
    }

    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      const typeName = this.nodeTypeName(node);
      counts.set(typeName, (counts.get(typeName) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([typeName, count]) => ({
        typeName,
        count,
        ratio: Number((count / graph.nodes.length).toFixed(3)),
      }))
      .sort((a, b) => b.count - a.count || a.typeName.localeCompare(b.typeName));
  }

  private computeNearestAnchorTree(adjacency: Map<string, Set<string>>, anchorNodeIds: string[]) {
    const distances = new Map<string, number>();
    const parents = new Map<string, string>();
    const queue: string[] = [];

    for (const anchorNodeId of anchorNodeIds) {
      if (!adjacency.has(anchorNodeId)) {
        adjacency.set(anchorNodeId, new Set<string>());
      }
      distances.set(anchorNodeId, 0);
      queue.push(anchorNodeId);
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const currentDistance = distances.get(nodeId) ?? 0;
      for (const neighborNodeId of adjacency.get(nodeId) ?? []) {
        if (distances.has(neighborNodeId)) {
          continue;
        }
        distances.set(neighborNodeId, currentDistance + 1);
        parents.set(neighborNodeId, nodeId);
        queue.push(neighborNodeId);
      }
    }

    return { distances, parents };
  }

  private computeDistancesFromAnchor(adjacency: Map<string, Set<string>>, anchorNodeId: string, maxDepth: number) {
    const distances = new Map<string, number>([[anchorNodeId, 0]]);
    const queue: Array<{ nodeId: string; distance: number }> = [{ nodeId: anchorNodeId, distance: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.distance >= maxDepth) {
        continue;
      }
      for (const neighborNodeId of adjacency.get(current.nodeId) ?? []) {
        if (distances.has(neighborNodeId)) {
          continue;
        }
        distances.set(neighborNodeId, current.distance + 1);
        queue.push({ nodeId: neighborNodeId, distance: current.distance + 1 });
      }
    }

    return distances;
  }

  private pathToNearestAnchor(nodeId: string, parents: Map<string, string>, anchorNodeIdSet: Set<string>) {
    const pathNodeIds: string[] = [];
    let currentNodeId = nodeId;
    let guard = 0;

    while (!anchorNodeIdSet.has(currentNodeId) && guard < 8) {
      pathNodeIds.push(currentNodeId);
      const parentNodeId = parents.get(currentNodeId);
      if (!parentNodeId) {
        break;
      }
      currentNodeId = parentNodeId;
      guard += 1;
    }

    return pathNodeIds.reverse();
  }

  private computeConnectedNodes(adjacency: Map<string, Set<string>>, anchorNodeIds: string[]) {
    const visited = new Set<string>();
    const queue = [...anchorNodeIds];

    for (const anchorNodeId of anchorNodeIds) {
      visited.add(anchorNodeId);
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      for (const neighborNodeId of adjacency.get(nodeId) ?? []) {
        if (visited.has(neighborNodeId)) {
          continue;
        }
        visited.add(neighborNodeId);
        queue.push(neighborNodeId);
      }
    }

    return visited;
  }

  private buildRelevanceTerms(stored: StoredPreparation) {
    const stopWords = new Set([
      'what',
      'which',
      'with',
      'that',
      'this',
      'from',
      'into',
      'about',
      'associated',
      'association',
      'disease',
      'genes',
      'gene',
      'pathway',
      'pathways',
      'and',
      'the',
      'for',
    ]);

    return Array.from(
      new Set(
        [
          ...stored.query.toLowerCase().split(/[^a-z0-9-]+/),
          ...stored.extractedItems.flatMap((item) => item.name.toLowerCase().split(/[^a-z0-9-]+/)),
        ].filter((term) => term.length >= 4 && !stopWords.has(term)),
      ),
    );
  }

  private typeBonus(typeName: string, intent: ExploreIntent) {
    if (intent.focusNodeTypes.includes(typeName as SupportedNodeType)) {
      return 100;
    }

    const preferredIndex = intent.preferredExpansionTypes.indexOf(typeName as SupportedNodeType);
    if (preferredIndex >= 0) {
      return [50, 45, 40, 30, 20][preferredIndex] ?? 15;
    }

    switch (typeName) {
      case 'BiologicalProcess':
        return 20;
      case 'Disease':
        return 15;
      case 'Phenotype':
        return 10;
      default:
        return 8;
    }
  }

  private queryRelevanceBonus(node: SerializedGraphPayload['nodes'][number], relevanceTerms: string[], relatedCandidates: AcceptedSeed[]) {
    const label = this.nodeLabel(node).toLowerCase();
    const description = String(node.attributes.description ?? '').toLowerCase();
    const aliases = Array.isArray(node.attributes.aliases)
      ? (node.attributes.aliases as unknown[]).filter((value): value is string => typeof value === 'string')
      : [];
    const haystack = `${label} ${description} ${aliases.join(' ').toLowerCase()}`;
    let bonus = 0;

    for (const term of relevanceTerms) {
      if (haystack.includes(term)) {
        bonus += term.length >= 8 ? 8 : 5;
      }
    }

    if (relatedCandidates.some((candidate) => candidate.id === node.key)) {
      bonus += 12;
    } else if (relatedCandidates.some((candidate) => haystack.includes(candidate.displayName.toLowerCase()))) {
      bonus += 8;
    }

    return Math.min(40, bonus);
  }

  private localGraphDegree(adjacency: Map<string, Set<string>>, nodeId: string) {
    return adjacency.get(nodeId)?.size ?? 0;
  }

  private countNodesOfType(graph: SerializedGraphPayload, selectedNodeIds: Set<string>, typeName: string) {
    return graph.nodes.filter((node) => selectedNodeIds.has(node.key) && this.nodeTypeName(node) === typeName).length;
  }

  private requiredCoverageRatio(typeName: string) {
    switch (typeName) {
      case 'Gene':
        return 0.3;
      case 'Pathway':
        return 0.15;
      case 'BiologicalProcess':
        return 0.12;
      case 'Disease':
      case 'Drug':
        return 0.1;
      default:
        return 0.08;
    }
  }

  private requiredCoverageCount(typeName: string, targetNodeCount: number) {
    return Math.max(1, Math.ceil(targetNodeCount * this.requiredCoverageRatio(typeName)));
  }

  private nodeLabel(node: SerializedGraphPayload['nodes'][number]) {
    return String(node.attributes.label ?? node.attributes.displayName ?? node.key);
  }

  private nodeTypeName(node: SerializedGraphPayload['nodes'][number]) {
    return String(node.attributes.nodeType ?? node.attributes.typeName ?? node.attributes.typeCode ?? 'Entity');
  }

  private toPreparedCandidate(
    candidate: OptimusResolutionCandidate,
    expectedNodeType: SupportedNodeType,
  ): PreparedCandidate {
    const resolutionStage = this.classifyStage(candidate);
    const typeMatchesExpected = matchesType(candidate.typeName, [expectedNodeType]);
    const candidateStage = this.toCandidateStage(resolutionStage, typeMatchesExpected);
    return {
      id: candidate.id,
      displayName: candidate.displayName,
      typeCode: candidate.typeCode,
      typeName: candidate.typeName,
      score: candidate.score,
      confidence: this.scoreCandidateConfidence(candidate, candidateStage),
      matchedOn: candidate.matchedOn,
      aliases: candidate.aliases,
      sourceIds: candidate.sourceIds,
      sourceNames: candidate.sourceNames,
      resolutionStage,
      candidateStage,
      typeMatchesExpected,
    };
  }

  private toAcceptedSeed(
    item: ExtractedItem,
    candidate: PreparedCandidate,
    kind: AcceptedSeedKind,
  ): AcceptedSeed {
    return {
      extractedItemId: item.id,
      extractedName: item.name,
      kind,
      id: candidate.id,
      displayName: candidate.displayName,
      typeCode: candidate.typeCode,
      typeName: candidate.typeName,
      score: candidate.score,
      confidence: candidate.confidence,
      matchedOn: candidate.matchedOn,
      candidateStage: candidate.candidateStage,
      typeMatchesExpected: candidate.typeMatchesExpected,
    };
  }

  private toResolvedEntities(acceptedSeeds: AcceptedSeed[]): ResolvedEntity[] {
    const deduped = new Map<string, ResolvedEntity>();

    for (const seed of acceptedSeeds) {
      if (deduped.has(seed.id)) {
        continue;
      }

      deduped.set(seed.id, {
        id: seed.id,
        query: seed.extractedName,
        displayName: seed.displayName,
        typeCode: seed.typeCode,
        typeName: seed.typeName,
        confidence: seed.confidence,
        matchedOn: seed.matchedOn,
        resolutionStage: this.stageFromCandidateStage(seed.candidateStage),
        source: 'query',
        seedTerms: [seed.extractedName, seed.displayName],
      });
    }

    return [...deduped.values()];
  }

  private ensureEvidenceItems(
    items: GraphEvidenceItem[],
    graph: SerializedGraphPayload,
    resolvedEntities: ResolvedEntity[],
    stored: StoredPreparation,
    highlightNodeIds: string[],
  ): GraphEvidenceItem[] {
    if (items.length > 0) {
      return items;
    }

    return [
      {
        id: createStepId('explore-graph-evidence'),
        kind: 'query',
        title: 'Prepared answer network',
        summary: `Built an intent-aware graph from accepted answer seeds for "${stored.query}".`,
        score: 0.84,
        nodeIds: highlightNodeIds,
        edgeIds: graph.edges.map((edge) => edge.key).slice(0, 40),
        metadata: {
          resolvedEntities: resolvedEntities.map((entity) => ({
            id: entity.id,
            displayName: entity.displayName,
            typeName: entity.typeName,
          })),
          intent: stored.intent,
          telemetry: stored.telemetry,
        },
      },
    ];
  }

  private buildConversationState(params: {
    sessionId: string;
    query: string;
    previousState: ConversationGraphState;
    resolvedEntities: ResolvedEntity[];
    evidenceBundle: GraphEvidenceBundle;
    plan: RetrievalPlanStep[];
    graph: SerializedGraphPayload;
    highlightNodeIds: string[];
  }): ConversationGraphState {
    const visibleNodeIds = params.graph.nodes.map((node) => node.key);
    const visibleEdgeIds = params.graph.edges.map((edge) => edge.key);

    return {
      ...params.previousState,
      sessionId: params.sessionId,
      activeEntities: params.resolvedEntities,
      resolvedNodeIds: this.mergeUnique(
        params.previousState.resolvedNodeIds,
        params.resolvedEntities.map((entity) => entity.id),
      ),
      frontierNodeIds: visibleNodeIds,
      retrievedNodeIds: visibleNodeIds,
      evidenceCache: [...params.evidenceBundle.items, ...params.previousState.evidenceCache],
      priorQueries: this.mergeUnique([params.query], params.previousState.priorQueries),
      lastPlan: params.plan,
      selectedNodeIds: params.highlightNodeIds,
      selectedEdgeIds: [],
      visibleNodeIds,
      visibleEdgeIds,
      pendingClarification: undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  private collectHighlightNodeIds(graphActions: GraphAction[], fallbackNodeIds: string[]) {
    const highlighted = graphActions.flatMap((action) => {
      if (action.type === 'load-subgraph') {
        return action.highlightNodeIds ?? [];
      }
      if (action.type === 'focus-nodes') {
        return action.nodeIds;
      }
      return action.type === 'highlight-path' ? action.nodeIds : [];
    });

    return this.mergeUnique(highlighted, fallbackNodeIds).slice(0, 12);
  }

  private normalizeGraphActions(
    graphActions: GraphAction[],
    graph: SerializedGraphPayload,
    highlightNodeIds: string[],
  ) {
    if (graphActions.length === 0) {
      return [
        {
          id: createStepId('explore-load-subgraph'),
          type: 'load-subgraph' as const,
          mode: 'replace' as const,
          graph,
          highlightNodeIds,
          focusMode: 'fit-viewport' as const,
        },
      ];
    }

    return graphActions.map((action) =>
      action.type === 'load-subgraph'
        ? {
            ...action,
            mode: 'replace',
            highlightNodeIds: action.highlightNodeIds?.length ? action.highlightNodeIds : highlightNodeIds,
            focusMode: 'fit-viewport' as const,
          }
        : action,
    );
  }

  private buildSearchVariants(text: string, suggestedNodeType: SupportedNodeType) {
    const trimmed = text.trim();
    const normalized = trimmed.replace(/\s+/g, ' ');
    const variants = new Set<string>([
      normalized,
      normalized.replace(/-/g, ' '),
      normalized.replace(/\s+/g, '-'),
      normalized.replace(/'s\b/gi, ''),
      this.toTitleCase(normalized),
    ]);

    if (suggestedNodeType === 'Disease' && !/\bdisease\b/i.test(normalized)) {
      variants.add(`${normalized} disease`);
      variants.add(this.toTitleCase(`${normalized} disease`));
    }

    if (/\bamyloid beta\b/i.test(normalized)) {
      variants.add(normalized.replace(/\bamyloid beta\b/gi, 'amyloid-beta'));
      variants.add(normalized.replace(/\bamyloid beta\b/gi, 'beta amyloid'));
    }

    return [...variants].map((variant) => variant.trim()).filter((variant) => variant.length >= 2);
  }

  private mergeExtractedItems(items: ExtractedItem[]) {
    const deduped = new Map<string, ExtractedItem>();

    for (const item of items) {
      const name = this.cleanEntityName(item.name);
      if (name.length < 2) {
        continue;
      }

      const normalizedItem: ExtractedItem = {
        ...item,
        name,
        confidence: this.clampConfidence(item.confidence),
      };
      const key = `${normalizedItem.name.toLowerCase()}:${normalizedItem.suggestedNodeType}:${normalizedItem.kind}`;
      const existing = deduped.get(key);
      if (
        !existing ||
        normalizedItem.confidence > existing.confidence ||
        (normalizedItem.kind === 'entity' && existing.kind === 'concept')
      ) {
        deduped.set(key, normalizedItem);
      }
    }

    return [...deduped.values()];
  }

  private mergeIntent(
    llmIntent: ExploreIntent | undefined,
    heuristicIntent: ExploreIntent,
    items: ExtractedItem[],
  ): ExploreIntent {
    const focusNodeTypes = this.uniqueNodeTypes([
      ...(llmIntent?.focusNodeTypes ?? []),
      ...heuristicIntent.focusNodeTypes,
    ]).slice(0, 6);
    const preferredExpansionTypes = this.uniqueNodeTypes([
      ...(llmIntent?.preferredExpansionTypes ?? []),
      ...heuristicIntent.preferredExpansionTypes,
      ...focusNodeTypes,
    ]).slice(0, 8);
    const primaryGoal =
      llmIntent?.primaryGoal?.trim().length
        ? llmIntent.primaryGoal.trim()
        : heuristicIntent.primaryGoal;

    if (preferredExpansionTypes.length === 0 && items.some((item) => item.suggestedNodeType === 'Disease')) {
      preferredExpansionTypes.push('Disease');
    }

    return {
      primaryGoal,
      focusNodeTypes,
      preferredExpansionTypes,
    };
  }

  private inferHeuristicIntent(query: string, items: ExtractedItem[]): ExploreIntent {
    const normalizedQuery = query.toLowerCase();
    const focusNodeTypes = new Set<SupportedNodeType>();

    if (/\bgenes?\b|\bproteins?\b/.test(normalizedQuery)) {
      focusNodeTypes.add('Gene');
    }
    if (/\bpathways?\b/.test(normalizedQuery)) {
      focusNodeTypes.add('Pathway');
    }
    if (/\bbiological processes?\b|\bmechanisms?\b|\bmetabolism\b|\binflammation\b/.test(normalizedQuery)) {
      focusNodeTypes.add('BiologicalProcess');
    }
    if (/\bdrugs?\b|\btherap(?:y|ies)\b/.test(normalizedQuery)) {
      focusNodeTypes.add('Drug');
    }
    if (/\bphenotypes?\b|\bsymptoms?\b/.test(normalizedQuery)) {
      focusNodeTypes.add('Phenotype');
    }

    const hasDiseaseSeed =
      /\bdisease\b|\bdementia\b|\balzheimer(?:'s)?\b|\bparkinson(?:'s)?\b|\bcancer\b/.test(normalizedQuery) ||
      items.some((item) => item.suggestedNodeType === 'Disease');
    const preferredExpansionTypes = new Set<SupportedNodeType>();

    if (hasDiseaseSeed) {
      preferredExpansionTypes.add('Disease');
    }
    focusNodeTypes.forEach((type) => preferredExpansionTypes.add(type));
    if (hasDiseaseSeed && !preferredExpansionTypes.has('Gene')) {
      preferredExpansionTypes.add('Gene');
    }
    if (hasDiseaseSeed && !preferredExpansionTypes.has('Pathway')) {
      preferredExpansionTypes.add('Pathway');
    }
    if (hasDiseaseSeed && !preferredExpansionTypes.has('BiologicalProcess')) {
      preferredExpansionTypes.add('BiologicalProcess');
    }

    const primaryGoal = hasDiseaseSeed
      ? 'Disease Exploration'
      : focusNodeTypes.has('Drug')
        ? 'Drug Discovery'
        : focusNodeTypes.has('Pathway')
          ? 'Pathway Exploration'
          : focusNodeTypes.has('Gene')
            ? 'Gene Exploration'
            : 'General Exploration';

    return {
      primaryGoal,
      focusNodeTypes: [...focusNodeTypes],
      preferredExpansionTypes: [...preferredExpansionTypes],
    };
  }

  private inferNodeTypeFromText(value: string): SupportedNodeType | undefined {
    if (/^[A-Z0-9-]{2,12}$/.test(value)) {
      return 'Gene';
    }
    if (/\bdisease\b|\bdementia\b|\bsyndrome\b|\bdisorder\b|\bcancer\b/i.test(value)) {
      return 'Disease';
    }
    if (/\bpathway\b|\bcascade\b/i.test(value)) {
      return 'Pathway';
    }
    if (/\bmetabolism\b|\binflammation\b|\bpathology\b|\bdysfunction\b|\bprocess\b|\bsignaling\b|\bsignalling\b|\bresponse\b/i.test(value)) {
      return 'BiologicalProcess';
    }
    if (/\bphenotype\b|\bstatus\b|\bimpairment\b|\bdeficit\b/i.test(value)) {
      return 'Phenotype';
    }
    if (/\bdrug\b|\binhibitor\b|\bagonist\b|\bantibody\b/i.test(value)) {
      return 'Drug';
    }
    if (/\banatomy\b|\bbrain\b|\bhippocamp(?:us|al)\b|\bcortex\b/i.test(value)) {
      return 'Anatomy';
    }

    return undefined;
  }

  private inferItemKind(value: string, suggestedNodeType: SupportedNodeType): ExtractedItemKind {
    if (suggestedNodeType === 'BiologicalProcess' || /pathology|dysfunction|metabolism|inflammation/i.test(value)) {
      return 'concept';
    }

    return 'entity';
  }

  private inferHeuristicConfidence(value: string, suggestedNodeType: SupportedNodeType) {
    if (suggestedNodeType === 'Gene' && /^[A-Z0-9-]{2,12}$/.test(value)) {
      return 0.86;
    }
    if (suggestedNodeType === 'Disease') {
      return 0.8;
    }
    if (suggestedNodeType === 'BiologicalProcess' || suggestedNodeType === 'Pathway') {
      return 0.72;
    }

    return 0.68;
  }

  private classifyStage(candidate: OptimusResolutionCandidate): NonNullable<ResolvedEntity['resolutionStage']> {
    if (
      candidate.matchedOn.some((match) =>
        ['displayName:exact', 'symbol:exact', 'id:exact', 'name:exact'].includes(match),
      )
    ) {
      return 'exact';
    }

    if (candidate.matchedOn.includes('alias:exact')) {
      return 'alias';
    }

    if (
      candidate.matchedOn.some((match) =>
        ['sourceName:exact', 'alias:contains', 'displayName:contains'].includes(match),
      )
    ) {
      return 'synonym';
    }

    if (candidate.matchedOn.includes('identifier:exact')) {
      return 'identifier';
    }

    return 'semantic';
  }

  private toCandidateStage(
    resolutionStage: NonNullable<ResolvedEntity['resolutionStage']>,
    typeMatchesExpected: boolean,
  ): CandidateStage {
    if (resolutionStage === 'semantic') {
      return 'semantic';
    }
    if (resolutionStage === 'identifier') {
      return typeMatchesExpected ? 'identifier-typed' : 'identifier-any';
    }
    if (resolutionStage === 'synonym') {
      return typeMatchesExpected ? 'synonym-typed' : 'synonym-any';
    }
    if (resolutionStage === 'alias') {
      return typeMatchesExpected ? 'alias-typed' : 'alias-any';
    }

    return typeMatchesExpected ? 'exact-typed' : 'exact-any';
  }

  private stageFromCandidateStage(candidateStage: CandidateStage): NonNullable<ResolvedEntity['resolutionStage']> {
    if (candidateStage.startsWith('exact')) return 'exact';
    if (candidateStage.startsWith('alias')) return 'alias';
    if (candidateStage.startsWith('synonym')) return 'synonym';
    if (candidateStage.startsWith('identifier')) return 'identifier';
    return 'semantic';
  }

  private candidatePriority(candidate: PreparedCandidate) {
    switch (candidate.candidateStage) {
      case 'exact-typed':
        return 900;
      case 'alias-typed':
        return 800;
      case 'synonym-typed':
        return 700;
      case 'identifier-typed':
        return 650;
      case 'exact-any':
        return 550;
      case 'alias-any':
        return 450;
      case 'synonym-any':
        return 350;
      case 'identifier-any':
        return 300;
      default:
        return 200;
    }
  }

  private scoreCandidateConfidence(candidate: OptimusResolutionCandidate, candidateStage: CandidateStage) {
    const base =
      candidateStage === 'exact-typed'
        ? 0.98
        : candidateStage === 'alias-typed'
          ? 0.92
          : candidateStage === 'synonym-typed'
            ? 0.84
            : candidateStage === 'identifier-typed'
              ? 0.8
              : candidateStage === 'exact-any'
                ? 0.78
                : candidateStage === 'alias-any'
                  ? 0.72
                  : candidateStage === 'synonym-any'
                    ? 0.66
                    : candidateStage === 'identifier-any'
                      ? 0.62
                      : 0.58;

    return this.clampConfidence(base + Math.min(0.06, candidate.score / 600));
  }

  private minimumAcceptanceConfidence(item: ExtractedItem) {
    if (item.kind === 'concept') {
      return item.confidence >= 0.75 ? 0.58 : 0.55;
    }

    return item.confidence >= 0.8 ? 0.62 : 0.58;
  }

  private cleanEntityName(value: string) {
    return value
      .trim()
      .replace(/^[`"'([{<\s]+|[`"',.;:)\]}>]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  private clampConfidence(value: number) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  }

  private uniqueNodeTypes(values: SupportedNodeType[]) {
    return Array.from(new Set(values.filter((value) => SUPPORTED_NODE_TYPES.includes(value))));
  }

  private toTitleCase(value: string) {
    return value.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  }

  private mergeUnique(primary: string[], secondary: string[]) {
    return Array.from(new Set([...primary, ...secondary].filter((value) => value.trim().length > 0)));
  }

  private cacheKey(preparationId: string) {
    return `graph-agent:explore-preparation:${preparationId}`;
  }

  private normalizeStoredPreparation(stored: StoredPreparation): StoredPreparation {
    const primarySeeds = stored.primarySeeds ?? stored.acceptedSeeds.filter((seed) => seed.kind === 'primary');
    const relatedCandidates =
      stored.relatedCandidates ?? stored.acceptedSeeds.filter((seed) => seed.kind === 'related');
    const telemetry =
      stored.telemetry ??
      this.buildTelemetry(
        stored.extractedItems,
        stored.intent,
        stored.candidateGroups ?? [],
        primarySeeds,
        relatedCandidates,
        stored.rejectedItems ?? [],
      );

    return {
      ...stored,
      primarySeeds,
      relatedCandidates,
      acceptedSeeds: stored.acceptedSeeds ?? [...primarySeeds, ...relatedCandidates],
      telemetry: {
        ...telemetry,
        primarySeeds: telemetry.primarySeeds ?? primarySeeds,
        relatedCandidates: telemetry.relatedCandidates ?? relatedCandidates,
        resolvedSeeds: telemetry.resolvedSeeds ?? primarySeeds,
      },
    };
  }

  private async loadPreparation(preparationId: string) {
    const raw = await this.redisService.redisClient.get(this.cacheKey(preparationId));
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as StoredPreparation;
  }
}
