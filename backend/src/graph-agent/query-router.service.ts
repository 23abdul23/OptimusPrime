import { Injectable } from '@nestjs/common';
import type { GraphSelectionEdgeContext, GraphSelectionNodeContext, QueryRoute } from './graph-agent.types';

const CYPHER_PATTERNS = [
  /^\s*(match|optional match|with|call|return|unwind)\b/i,
  /```cypher/i,
];

const GRAPH_REFERENCE_PATTERNS = [
  /\bthis node\b/i,
  /\bthese nodes\b/i,
  /\bthis edge\b/i,
  /\bthese edges\b/i,
  /\bthis relationship\b/i,
  /\bthese relationships\b/i,
  /\bthese genes\b/i,
  /\bthese proteins\b/i,
  /\bthese diseases\b/i,
  /\bthese pathways\b/i,
  /\bthese drugs\b/i,
  /\bselected nodes\b/i,
  /\bselected edges\b/i,
  /\bselected proteins\b/i,
  /\bselected genes\b/i,
  /\bselected graph\b/i,
  /\bcurrent graph\b/i,
  /\bcurrent network\b/i,
  /\bthis subgraph\b/i,
  /\bthose\b/i,
  /\bthem\b/i,
];

const GRAPH_OPERATION_PATTERNS = [
  /\bsummariz(?:e|ing)\b/i,
  /\bcompare\b/i,
  /\bexplain\b/i,
  /\banaly[sz]e\b/i,
  /\bdescribe\b/i,
  /\bcurrent graph\b/i,
  /\bcurrent network\b/i,
  /\bselected graph\b/i,
  /\bsubgraph\b/i,
  /\bnetwork\b/i,
];

const ENTITY_SIGNAL_PATTERNS = [
  /\b[A-Z0-9-]{2,12}\b/,
  /\b[A-Za-z0-9'-]+(?:\s+[A-Za-z0-9'-]+){0,4}\s+(?:disease|syndrome|disorder|dementia|cancer|phenotype|guideline|pathway)\b/i,
  /\bamyloid beta\b/i,
];

@Injectable()
export class QueryRouterService {
  route(params: {
    query: string;
    selectedNodeContext?: GraphSelectionNodeContext[];
    selectedEdgeContext?: GraphSelectionEdgeContext[];
  }): QueryRoute {
    const query = params.query.trim();
    const selectedNodeCount = params.selectedNodeContext?.length ?? 0;
    const selectedEdgeCount = params.selectedEdgeContext?.length ?? 0;
    const hasSelectionContext = selectedNodeCount > 0 || selectedEdgeCount > 0;
    const reasons: string[] = [];

    const hasCypherSignal = CYPHER_PATTERNS.some((pattern) => pattern.test(query));
    if (hasCypherSignal) {
      reasons.push('query-matches-cypher-pattern');
      return {
        category: 'CYPHER_QUERY',
        reasons,
        signals: {
          hasGraphReference: false,
          hasExplicitEntitySignal: false,
          hasCypherSignal: true,
          hasSelectionContext,
        },
      };
    }

    const hasGraphReference = GRAPH_REFERENCE_PATTERNS.some((pattern) => pattern.test(query));
    const hasGraphOperationSignal = GRAPH_OPERATION_PATTERNS.some((pattern) => pattern.test(query));
    const hasExplicitEntitySignal = ENTITY_SIGNAL_PATTERNS.some((pattern) => pattern.test(query));

    if (hasGraphReference) {
      reasons.push('query-references-graph-context');
    }
    if (hasGraphOperationSignal) {
      reasons.push('query-uses-graph-operation-verb');
    }
    if (hasSelectionContext) {
      reasons.push('request-carries-selection-context');
    }
    if (hasExplicitEntitySignal) {
      reasons.push('query-contains-entity-like-signal');
    }

    if ((hasGraphReference || hasGraphOperationSignal) && hasExplicitEntitySignal && hasSelectionContext) {
      return {
        category: 'MIXED_QUERY',
        reasons,
        signals: {
          hasGraphReference: true,
          hasExplicitEntitySignal: true,
          hasCypherSignal: false,
          hasSelectionContext: true,
        },
      };
    }

    if ((hasGraphReference || hasGraphOperationSignal) && hasSelectionContext) {
      return {
        category: 'GRAPH_QUERY',
        reasons,
        signals: {
          hasGraphReference: true,
          hasExplicitEntitySignal,
          hasCypherSignal: false,
          hasSelectionContext: true,
        },
      };
    }

    if (hasGraphReference && hasExplicitEntitySignal) {
      return {
        category: 'MIXED_QUERY',
        reasons,
        signals: {
          hasGraphReference: true,
          hasExplicitEntitySignal: true,
          hasCypherSignal: false,
          hasSelectionContext,
        },
      };
    }

    if (hasExplicitEntitySignal) {
      return {
        category: 'ENTITY_QUERY',
        reasons,
        signals: {
          hasGraphReference,
          hasExplicitEntitySignal: true,
          hasCypherSignal: false,
          hasSelectionContext,
        },
      };
    }

    if (hasGraphReference || hasGraphOperationSignal) {
      return {
        category: 'GRAPH_QUERY',
        reasons,
        signals: {
          hasGraphReference: hasGraphReference || hasGraphOperationSignal,
          hasExplicitEntitySignal: false,
          hasCypherSignal: false,
          hasSelectionContext,
        },
      };
    }

    return {
      category: 'UNKNOWN',
      reasons: reasons.length > 0 ? reasons : ['no-strong-route-signal'],
      signals: {
        hasGraphReference,
        hasExplicitEntitySignal,
        hasCypherSignal: false,
        hasSelectionContext,
      },
    };
  }
}
