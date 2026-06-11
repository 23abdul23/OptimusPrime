import type { UIMessage } from 'ai';
import type { SerializedGraphPayload } from '@/optimuskg/optimuskg.service';

export type GraphIntent =
  | 'graph-discovery'
  | 'graph-summary'
  | 'schema-analysis'
  | 'graph-relationship-analysis'
  | 'ontology-analysis'
  | 'enrichment-analysis'
  | 'network-statistics'
  | 'community-detection'
  | 'exposure-analysis'
  | 'drug-discovery'
  | 'graph-explanation'
  | 'graph-comparison'
  | 'graph-commonality'
  | 'graph-connections'
  | 'relationship-analysis'
  | 'drug-search'
  | 'pathway-search'
  | 'guideline-search'
  | 'entity-neighborhood'
  | 'network-summary'
  | 'graph-expansion'
  | 'comparison'
  | 'concept-discovery'
  | 'disease-genes'
  | 'disease-protein-pathway-drug'
  | 'shortest-path'
  | 'guidelines'
  | 'neighborhood'
  | 'guarded-cypher';

export interface ExtractedMention {
  text: string;
  span: {
    start: number;
    end: number;
  };
  typeHints: string[];
  source: 'query';
}

export interface ExtractedConcept {
  text: string;
  span: {
    start: number;
    end: number;
  };
  category:
    | 'disease-area'
    | 'biological-process'
    | 'therapeutic-area'
    | 'entity-class'
    | 'phenotype'
    | 'anatomy'
    | 'general';
  source: 'query';
}

export interface QueryIntentClassification {
  primary: GraphIntent;
  operation:
    | 'graph-discovery'
    | 'graph-summary'
    | 'schema-analysis'
    | 'graph-relationship-analysis'
    | 'ontology-analysis'
    | 'enrichment-analysis'
    | 'network-statistics'
    | 'community-detection'
    | 'exposure-analysis'
    | 'drug-discovery'
    | 'graph-explanation'
    | 'graph-comparison'
    | 'graph-commonality'
    | 'graph-connections'
    | 'relationship-analysis'
    | 'path-search'
    | 'entity-search'
    | 'drug-search'
    | 'drug-indications'
    | 'pathway-search'
    | 'guideline-search'
    | 'graph-expansion'
    | 'neighborhood'
    | 'comparison'
    | 'network-summary'
    | 'guarded-cypher';
  requestedEntityTypes: string[];
  allowContextFallback: boolean;
  radius?: number;
  constraints?: string[];
  requestedOutputs?: string[];
  llmAssisted?: boolean;
}

export type QueryCategory =
  | 'GRAPH_DISCOVERY_QUERY'
  | 'ENTITY_QUERY'
  | 'GRAPH_QUERY'
  | 'MIXED_QUERY'
  | 'CYPHER_QUERY'
  | 'UNKNOWN';

export type QueryRouteIntent =
  | QueryIntentClassification['operation']
  | 'resolve-explicit-mentions'
  | 'unknown';

export type PreferredQueryExecutor =
  | 'graph_analysis'
  | 'retrieval'
  | 'mixed'
  | 'cypher';

export interface QueryRoute {
  category: QueryCategory;
  intent: QueryRouteIntent;
  requiresEntityExtraction: boolean;
  requiresEntityResolution: boolean;
  requiresGraphContext: boolean;
  preferredExecutor: PreferredQueryExecutor;
  reasons: string[];
  signals: {
    hasGraphReference: boolean;
    hasExplicitEntitySignal: boolean;
    hasCypherSignal: boolean;
    hasSelectionContext: boolean;
    hasDiscoveryTrigger: boolean;
  };
}

export interface GraphReferenceResolution {
  referencesSelection: boolean;
  referencesNodes: boolean;
  referencesEdges: boolean;
  referencesVisibleGraph: boolean;
  referencesSessionGraph: boolean;
}

export interface ExtractedQuery {
  query: string;
  mentions: ExtractedMention[];
  concepts: ExtractedConcept[];
  selectionReferences: string[];
  operatorSignals: string[];
  constraints: string[];
  requestedOutputs: string[];
  semanticOperations: string[];
  decomposition?: QueryDecomposition;
  llmAssisted?: boolean;
}

export interface ResolvedEntity {
  id: string;
  query: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  confidence: number;
  matchedOn: string[];
  resolutionStage?: 'exact' | 'alias' | 'synonym' | 'identifier' | 'semantic';
  source: ExtractedMention['source'] | 'concept' | 'selected' | 'memory';
  aliases?: string[];
  identifiers?: string[];
  sourceNames?: string[];
  seedTerms?: string[];
}

export interface GraphSelectionNodeContext {
  id: string;
  label: string;
  nodeType?: string;
}

export interface GraphSelectionEdgeContext {
  id: string;
  source: string;
  target: string;
  relation?: string;
}

export interface GraphNetworkContext {
  totalNodes: number;
  totalEdges: number;
  selectedNodeIds?: string[];
  selectedEdgeIds?: string[];
  visibleNodeIds?: string[];
  visibleEdgeIds?: string[];
  visibleNodeContext?: GraphSelectionNodeContext[];
  topNodeTypes?: Array<{
    type: string;
    count: number;
  }>;
}

export interface GraphScope {
  mode: 'selection' | 'visible-subgraph' | 'session' | 'discovery' | 'none';
  selectedNodeCount: number;
  selectedEdgeCount: number;
  visibleNodeCount: number;
  visibleEdgeCount: number;
}

export interface GraphContextResult {
  activeAnchors: GraphSelectionNodeContext[];
  selectedNodes: GraphSelectionNodeContext[];
  selectedEdges: GraphSelectionEdgeContext[];
  visibleNodes: GraphSelectionNodeContext[];
  visibleNodeIds: string[];
  visibleEdgeIds: string[];
  graphScope: GraphScope;
  graphReferences: GraphReferenceResolution;
  selectedNodeTypes: string[];
  selectedEdgeTypes: string[];
}

export interface QueryDecomposition {
  summary: string;
  tasks: string[];
  constraints: string[];
  outputs: string[];
  traversalHints: string[];
  requiresMultiHop: boolean;
  source: 'llm';
}

export interface GraphInterpretation {
  theme: string;
  dominantConcepts: string[];
  dominantRelationships: string[];
  networkType: string;
  summary: string;
}

export type GraphDebugStage =
  | 'clarification'
  | 'routing'
  | 'graph-context'
  | 'decomposition'
  | 'extraction'
  | 'intent'
  | 'resolution'
  | 'planning'
  | 'retrieval'
  | 'replanning'
  | 'interpretation'
  | 'answer';

export type GraphDebugStatus = 'info' | 'success' | 'warning';

export interface GraphDebugStep {
  id: string;
  stage: GraphDebugStage;
  title: string;
  summary: string;
  status: GraphDebugStatus;
  createdAt: string;
  details?: Record<string, unknown>;
  llm?: {
    used: boolean;
    mode: 'direct' | 'assisted';
    deductions: string[];
  };
}

export type RetrievalExecutor =
  | 'graph-analysis'
  | 'retrieval-operations'
  | 'cypher-agent'
  | 'state'
  | 'resolution-agent';

export type RetrievalOperation =
  | 'resolve-explicit-mentions'
  | 'discover-graph'
  | 'build-disease-network'
  | 'build-gene-network'
  | 'build-drug-network'
  | 'build-pathway-network'
  | 'build-relationship-network'
  | 'build-multi-entity-network'
  | 'network-summary'
  | 'summarize-selected-nodes'
  | 'summarize-visible-subgraph'
  | 'analyze-schema'
  | 'analyze-node-types'
  | 'analyze-relationship-types'
  | 'find-cross-type-relationships'
  | 'find-available-node-types'
  | 'find-available-relationship-types'
  | 'find-dominant-relationships'
  | 'rank-relationship-types'
  | 'analyze-relationship-patterns'
  | 'analyze-cross-type-connections'
  | 'analyze-relationship-density'
  | 'analyze-genes'
  | 'analyze-diseases'
  | 'analyze-drugs'
  | 'analyze-pathways'
  | 'analyze-phenotypes'
  | 'analyze-anatomy'
  | 'analyze-molecular-functions'
  | 'analyze-cellular-components'
  | 'analyze-exposures'
  | 'find-parents'
  | 'find-children'
  | 'find-ancestors'
  | 'find-descendants'
  | 'explore-ontology-hierarchy'
  | 'find-ontology-roots'
  | 'enrich-diseases'
  | 'enrich-pathways'
  | 'enrich-phenotypes'
  | 'enrich-biological-processes'
  | 'enrich-molecular-functions'
  | 'enrich-cellular-components'
  | 'enrich-anatomy'
  | 'compute-graph-metrics'
  | 'compute-node-type-distribution'
  | 'compute-relationship-distribution'
  | 'compute-centrality-metrics'
  | 'compute-density-metrics'
  | 'compute-component-statistics'
  | 'detect-communities'
  | 'detect-disease-modules'
  | 'detect-functional-modules'
  | 'detect-gene-modules'
  | 'find-candidate-entities'
  | 'find-visible-graph-matches'
  | 'rank-entity-candidates'
  | 'interpret-subgraph'
  | 'identify-graph-theme'
  | 'identify-central-concepts'
  | 'summarize-biological-narrative'
  | 'compare-nodes'
  | 'find-shared-pathways'
  | 'find-shared-diseases'
  | 'find-shared-genes'
  | 'find-common-neighbors'
  | 'find-hub-nodes'
  | 'find-bridging-nodes'
  | 'explain-connections'
  | 'analyze-cluster'
  | 'load-node-details'
  | 'get-related-entities'
  | 'get-related-diseases'
  | 'get-related-genes'
  | 'get-related-proteins'
  | 'get-related-pathways'
  | 'get-related-drugs'
  | 'get-drug-indications'
  | 'get-drug-targets'
  | 'get-drug-contraindications'
  | 'find-off-label-uses'
  | 'get-drug-mechanisms'
  | 'get-disease-genes'
  | 'get-disease-phenotypes'
  | 'get-gene-diseases'
  | 'get-gene-pathways'
  | 'get-pathway-genes'
  | 'get-pathway-diseases'
  | 'get-anatomy-genes'
  | 'get-anatomy-diseases'
  | 'get-exposure-genes'
  | 'get-exposure-diseases'
  | 'get-exposure-processes'
  | 'retrieve-clinical-guidelines'
  | 'retrieve-relationship-evidence'
  | 'find-shortest-path'
  | 'traverse-typed-paths'
  | 'retrieve-neighborhood'
  | 'expand-network'
  | 'execute-custom-cypher';

export interface RetrievalPlanStep {
  id: string;
  intent: GraphIntent;
  operation: RetrievalOperation;
  executor: RetrievalExecutor;
  tool:
    | 'searchEntities'
    | 'resolveEntity'
    | 'discoverGraph'
    | 'buildDiseaseNetwork'
    | 'buildGeneNetwork'
    | 'buildDrugNetwork'
    | 'buildPathwayNetwork'
    | 'buildRelationshipNetwork'
    | 'buildMultiEntityNetwork'
    | 'summarizeNodes'
    | 'summarizeSubgraph'
    | 'analyzeSchema'
    | 'analyzeNodeTypes'
    | 'analyzeRelationshipTypes'
    | 'findCrossTypeRelationships'
    | 'findAvailableNodeTypes'
    | 'findAvailableRelationshipTypes'
    | 'findDominantRelationships'
    | 'rankRelationshipTypes'
    | 'analyzeRelationshipPatterns'
    | 'analyzeCrossTypeConnections'
    | 'analyzeRelationshipDensity'
    | 'analyzeGenes'
    | 'analyzeDiseases'
    | 'analyzeDrugs'
    | 'analyzePathways'
    | 'analyzePhenotypes'
    | 'analyzeAnatomy'
    | 'analyzeMolecularFunctions'
    | 'analyzeCellularComponents'
    | 'analyzeExposures'
    | 'findParents'
    | 'findChildren'
    | 'findAncestors'
    | 'findDescendants'
    | 'exploreOntologyHierarchy'
    | 'findOntologyRoots'
    | 'enrichDiseases'
    | 'enrichPathways'
    | 'enrichPhenotypes'
    | 'enrichBiologicalProcesses'
    | 'enrichMolecularFunctions'
    | 'enrichCellularComponents'
    | 'enrichAnatomy'
    | 'computeGraphMetrics'
    | 'computeNodeTypeDistribution'
    | 'computeRelationshipDistribution'
    | 'computeCentralityMetrics'
    | 'computeDensityMetrics'
    | 'computeComponentStatistics'
    | 'detectCommunities'
    | 'detectDiseaseModules'
    | 'detectFunctionalModules'
    | 'detectGeneModules'
    | 'findCandidateEntities'
    | 'findVisibleGraphMatches'
    | 'rankEntityCandidates'
    | 'interpretSubgraph'
    | 'identifyGraphTheme'
    | 'identifyCentralConcepts'
    | 'summarizeBiologicalNarrative'
    | 'compareNodes'
    | 'findSharedPathways'
    | 'findSharedDiseases'
    | 'findSharedGenes'
    | 'findCommonNeighbors'
    | 'findHubNodes'
    | 'findBridgingNodes'
    | 'explainConnections'
    | 'analyzeCluster'
    | 'getNodeDetails'
    | 'retrieveSubgraph'
    | 'expandSubgraph'
    | 'shortestPath'
    | 'getRelatedEntities'
    | 'getDrugTargets'
    | 'getDrugContraindications'
    | 'findOffLabelUses'
    | 'getDrugMechanisms'
    | 'getDiseaseGenes'
    | 'getDiseasePhenotypes'
    | 'getGeneDiseases'
    | 'getGenePathways'
    | 'getPathwayGenes'
    | 'getPathwayDiseases'
    | 'getAnatomyGenes'
    | 'getAnatomyDiseases'
    | 'getExposureGenes'
    | 'getExposureDiseases'
    | 'getExposureProcesses'
    | 'retrieveEvidence'
    | 'retrieveClinicalGuidelines'
    | 'executeGuardedCypher'
    | 'getConversationGraphState'
    | 'pruneConversationGraphState';
  description: string;
  params: Record<string, unknown>;
}

export interface GraphEvidenceItem {
  id: string;
  kind: 'entity' | 'relation' | 'path' | 'guideline' | 'query';
  title: string;
  summary: string;
  score: number;
  nodeIds: string[];
  edgeIds: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphEvidenceAssessment {
  confidence: number;
  confidenceLabel: 'low' | 'medium' | 'high';
  isInsufficient: boolean;
  needsReplan: boolean;
  rationale: string;
  analyticalCoverage: number;
  provenanceCoverage: number;
  matchedOperations: RetrievalOperation[];
  replanAttempts: number;
}

export interface GraphEvidenceBundle {
  query: string;
  resolvedEntities: ResolvedEntity[];
  plan: RetrievalPlanStep[];
  items: GraphEvidenceItem[];
  insufficientEvidence: boolean;
  warnings: string[];
  confidence: number;
  confidenceLabel: GraphEvidenceAssessment['confidenceLabel'];
  provenanceHighlights: string[];
  assessment: GraphEvidenceAssessment;
}

export interface PendingClarificationState {
  kind: 'discovery-ambiguity' | 'visible-graph-ambiguity';
  originalQuery: string;
  pendingIntent: GraphIntent;
  pendingOperation: QueryIntentClassification['operation'];
  pendingCategory: QueryCategory;
  extractedQuery: ExtractedQuery;
  resolvedEntities: ResolvedEntity[];
  unresolvedEntity: string;
  candidateEntities: ResolvedEntity[];
  createdAt: string;
}

export interface ConversationGraphState {
  sessionId: string;
  activeEntities: ResolvedEntity[];
  resolvedNodeIds: string[];
  frontierNodeIds: string[];
  retrievedNodeIds: string[];
  evidenceCache: GraphEvidenceItem[];
  priorQueries: string[];
  lastPlan: RetrievalPlanStep[];
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  visibleNodeIds: string[];
  visibleEdgeIds: string[];
  pendingClarification?: PendingClarificationState;
  updatedAt: string;
}

export type GraphAction =
  | {
      id: string;
      type: 'load-subgraph';
      mode: 'replace' | 'merge';
      graph: SerializedGraphPayload;
      highlightNodeIds?: string[];
      focusMode?: 'highlighted' | 'fit-viewport';
    }
  | {
      id: string;
      type: 'highlight-path';
      nodeIds: string[];
      edgeIds: string[];
    }
  | {
      id: string;
      type: 'focus-nodes';
      nodeIds: string[];
    };

export interface GraphToolResult<T = Record<string, unknown>> {
  evidence: GraphEvidenceItem[];
  graphDelta?: SerializedGraphPayload;
  graphActions: GraphAction[];
  citations: string[];
  confidence: number;
  truncated: boolean;
  warnings: string[];
  payload?: T;
}

export interface GraphAgentDataParts {
  [key: string]: unknown;
  graphEvidence: GraphEvidenceBundle;
  graphActions: GraphAction[];
  graphDebug: GraphDebugStep[];
  graphState: {
    sessionId: string;
    state: ConversationGraphState;
  };
}

export type GraphAgentUIMessage = UIMessage<never, GraphAgentDataParts>;
