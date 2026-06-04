import type { UIMessage } from 'ai';
import type { SerializedGraphPayload } from './optimuskg';

export interface ResolvedEntity {
  id: string;
  query: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  confidence: number;
  matchedOn: string[];
  source: 'query' | 'selected' | 'memory';
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

export interface RetrievalPlanStep {
  id: string;
  intent: string;
  tool: string;
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
