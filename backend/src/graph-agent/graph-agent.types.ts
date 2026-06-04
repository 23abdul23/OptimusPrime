import type { UIMessage } from 'ai';
import type { SerializedGraphPayload } from '@/optimuskg/optimuskg.service';

export type GraphIntent =
  | 'graph-summary'
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
  intent: QueryIntentClassification;
}

export interface ResolvedEntity {
  id: string;
  query: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  confidence: number;
  matchedOn: string[];
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

export interface RetrievalPlanStep {
  id: string;
  intent: GraphIntent;
  tool:
    | 'searchEntities'
    | 'resolveEntity'
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

export interface GraphEvidenceBundle {
  query: string;
  resolvedEntities: ResolvedEntity[];
  plan: RetrievalPlanStep[];
  items: GraphEvidenceItem[];
  insufficientEvidence: boolean;
  warnings: string[];
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
