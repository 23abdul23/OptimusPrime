import type { UIMessage } from 'ai';
import type { SerializedGraphPayload } from '@/optimuskg/optimuskg.service';

export type GraphIntent =
  | 'graph-summary'
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
    | 'graph-summary'
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
}

export type QueryCategory =
  | 'ENTITY_QUERY'
  | 'GRAPH_QUERY'
  | 'MIXED_QUERY'
  | 'CYPHER_QUERY'
  | 'UNKNOWN';

export interface QueryRoute {
  category: QueryCategory;
  reasons: string[];
  signals: {
    hasGraphReference: boolean;
    hasExplicitEntitySignal: boolean;
    hasCypherSignal: boolean;
    hasSelectionContext: boolean;
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
  visibleNodeIds?: string[];
  visibleEdgeIds?: string[];
  topNodeTypes?: Array<{
    type: string;
    count: number;
  }>;
}

export interface GraphScope {
  mode: 'selection' | 'visible-subgraph' | 'session' | 'none';
  selectedNodeCount: number;
  selectedEdgeCount: number;
  visibleNodeCount: number;
  visibleEdgeCount: number;
}

export interface GraphContextResult {
  activeAnchors: GraphSelectionNodeContext[];
  graphScope: GraphScope;
  graphReferences: GraphReferenceResolution;
  selectedNodeTypes: string[];
  selectedEdgeTypes: string[];
}

export type RetrievalExecutor =
  | 'graph-analysis'
  | 'retrieval-operations'
  | 'cypher-agent'
  | 'state'
  | 'resolution-agent';

export type RetrievalOperation =
  | 'resolve-explicit-mentions'
  | 'network-summary'
  | 'summarize-selected-nodes'
  | 'summarize-visible-subgraph'
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
    | 'summarizeNodes'
    | 'summarizeSubgraph'
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
  updatedAt: string;
}

export type GraphAction =
  | {
      id: string;
      type: 'load-subgraph';
      mode: 'replace' | 'merge';
      graph: SerializedGraphPayload;
      highlightNodeIds?: string[];
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
  graphState: {
    sessionId: string;
    state: ConversationGraphState;
  };
}

export type GraphAgentUIMessage = UIMessage<never, GraphAgentDataParts>;
