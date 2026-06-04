import { Injectable } from '@nestjs/common';
import type {
  GraphSelectionEdgeContext,
  GraphSelectionNodeContext,
  PreferredQueryExecutor,
  QueryRoute,
  QueryRouteIntent,
} from './graph-agent.types';

const CYPHER_PATTERNS = [/^\s*(match|optional match|with|call|return|unwind)\b/i, /```cypher/i];

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
  /\bhighlighted nodes\b/i,
  /\bhighlighted edges\b/i,
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
  /\bwhat do\b.*\bhave in common\b/i,
  /\bshared\b/i,
  /\bcommon\b/i,
  /\bcurrent graph\b/i,
  /\bcurrent network\b/i,
  /\bselected graph\b/i,
  /\bsubgraph\b/i,
  /\bnetwork\b/i,
];

const SELECTION_SUBJECT_PATTERNS = [
  /\bthese nodes\b/i,
  /\bthese genes\b/i,
  /\bthese proteins\b/i,
  /\bthese diseases\b/i,
  /\bthese pathways\b/i,
  /\bthese drugs\b/i,
  /\bselected nodes\b/i,
  /\bselected genes\b/i,
  /\bselected proteins\b/i,
  /\bselected diseases\b/i,
  /\bselected pathways\b/i,
  /\bselected drugs\b/i,
  /\bhighlighted nodes\b/i,
  /\bthis graph\b/i,
  /\bcurrent graph\b/i,
  /\bthis subgraph\b/i,
  /\bthem\b/i,
  /\bthose\b/i,
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
    const normalized = query.toLowerCase();
    const selectedNodeCount = params.selectedNodeContext?.length ?? 0;
    const selectedEdgeCount = params.selectedEdgeContext?.length ?? 0;
    const hasSelectionContext = selectedNodeCount > 0 || selectedEdgeCount > 0;
    const reasons: string[] = [];

    const hasCypherSignal = CYPHER_PATTERNS.some((pattern) => pattern.test(query));
    if (hasCypherSignal) {
      reasons.push('query-matches-cypher-pattern');
      return this.createRoute({
        category: 'CYPHER_QUERY',
        intent: 'guarded-cypher',
        requiresEntityExtraction: false,
        requiresEntityResolution: false,
        requiresGraphContext: false,
        preferredExecutor: 'cypher',
        reasons,
        hasGraphReference: false,
        hasExplicitEntitySignal: false,
        hasCypherSignal: true,
        hasSelectionContext,
      });
    }

    const hasGraphReference = GRAPH_REFERENCE_PATTERNS.some((pattern) => pattern.test(query));
    const hasGraphOperationSignal = GRAPH_OPERATION_PATTERNS.some((pattern) => pattern.test(query));
    const hasExplicitEntitySignal = ENTITY_SIGNAL_PATTERNS.some((pattern) => pattern.test(query));
    const referencesSelectionSubject = hasSelectionContext && SELECTION_SUBJECT_PATTERNS.some((pattern) => pattern.test(query));
    const routeIntent = this.inferIntent(normalized, hasSelectionContext);

    if (hasGraphReference) {
      reasons.push('query-references-graph-context');
    }
    if (hasGraphOperationSignal) {
      reasons.push('query-uses-graph-operation-verb');
    }
    if (hasSelectionContext) {
      reasons.push('request-carries-selection-context');
    }
    if (referencesSelectionSubject) {
      reasons.push('selected-graph-context-is-primary-subject');
    }
    if (hasExplicitEntitySignal) {
      reasons.push('query-contains-entity-like-signal');
    }

    const isGraphSubjectQuery = referencesSelectionSubject || ((hasGraphReference || hasGraphOperationSignal) && hasSelectionContext);
    const requiresEntityWork = this.requiresEntityWork(routeIntent, isGraphSubjectQuery, hasExplicitEntitySignal);

    if (isGraphSubjectQuery && requiresEntityWork) {
      return this.createRoute({
        category: 'MIXED_QUERY',
        intent: routeIntent,
        requiresEntityExtraction: true,
        requiresEntityResolution: true,
        requiresGraphContext: true,
        preferredExecutor: 'mixed',
        reasons,
        hasGraphReference: true,
        hasExplicitEntitySignal,
        hasCypherSignal: false,
        hasSelectionContext: true,
      });
    }

    if (isGraphSubjectQuery) {
      return this.createRoute({
        category: 'GRAPH_QUERY',
        intent: routeIntent,
        requiresEntityExtraction: false,
        requiresEntityResolution: false,
        requiresGraphContext: true,
        preferredExecutor: 'graph_analysis',
        reasons,
        hasGraphReference: true,
        hasExplicitEntitySignal: false,
        hasCypherSignal: false,
        hasSelectionContext: true,
      });
    }

    if (hasGraphReference && hasExplicitEntitySignal) {
      return this.createRoute({
        category: 'MIXED_QUERY',
        intent: routeIntent,
        requiresEntityExtraction: true,
        requiresEntityResolution: true,
        requiresGraphContext: true,
        preferredExecutor: 'mixed',
        reasons,
        hasGraphReference: true,
        hasExplicitEntitySignal: true,
        hasCypherSignal: false,
        hasSelectionContext,
      });
    }

    if (hasExplicitEntitySignal) {
      return this.createRoute({
        category: 'ENTITY_QUERY',
        intent: routeIntent === 'unknown' ? 'neighborhood' : routeIntent,
        requiresEntityExtraction: true,
        requiresEntityResolution: true,
        requiresGraphContext: false,
        preferredExecutor: 'retrieval',
        reasons,
        hasGraphReference,
        hasExplicitEntitySignal: true,
        hasCypherSignal: false,
        hasSelectionContext,
      });
    }

    if (hasGraphReference || hasGraphOperationSignal) {
      return this.createRoute({
        category: 'GRAPH_QUERY',
        intent: routeIntent,
        requiresEntityExtraction: false,
        requiresEntityResolution: false,
        requiresGraphContext: true,
        preferredExecutor: 'graph_analysis',
        reasons,
        hasGraphReference: true,
        hasExplicitEntitySignal: false,
        hasCypherSignal: false,
        hasSelectionContext,
      });
    }

    return this.createRoute({
      category: 'UNKNOWN',
      intent: routeIntent === 'unknown' ? 'neighborhood' : routeIntent,
      requiresEntityExtraction: true,
      requiresEntityResolution: true,
      requiresGraphContext: hasSelectionContext,
      preferredExecutor: hasSelectionContext ? 'mixed' : 'retrieval',
      reasons: reasons.length > 0 ? reasons : ['no-strong-route-signal'],
      hasGraphReference,
      hasExplicitEntitySignal,
      hasCypherSignal: false,
      hasSelectionContext,
    });
  }

  private inferIntent(normalized: string, hasSelectionContext: boolean): QueryRouteIntent {
    if (
      normalized.includes('how many nodes') ||
      normalized.includes('how many edges') ||
      normalized.includes('node count') ||
      normalized.includes('edge count') ||
      normalized.includes('current network') ||
      normalized.includes('current graph')
    ) {
      return 'network-summary';
    }

    if (/\bsummariz(?:e|ing)\b|\bdescribe\b|\bexplain this subgraph\b|\bexplain these nodes\b/.test(normalized)) {
      return 'graph-summary';
    }

    if (/\bcompare\b/.test(normalized) && hasSelectionContext) {
      return 'graph-comparison';
    }

    if (/\bwhat do\b.*\bhave in common\b/.test(normalized) || /\bshared\b/.test(normalized) || /\bcommon\b/.test(normalized)) {
      return 'graph-commonality';
    }

    if (/\bwhy are\b.*\bconnected\b/.test(normalized) || /\bexplain connections\b/.test(normalized) || /\bhow do\b.*\brelate\b/.test(normalized)) {
      return 'graph-connections';
    }

    if (normalized.includes('guideline')) {
      return 'guideline-search';
    }

    if (normalized.includes('indicated') || normalized.includes('approved for') || normalized.includes('indication')) {
      return 'drug-indications';
    }

    if (normalized.includes('drug')) {
      return 'drug-search';
    }

    if (normalized.includes('pathway')) {
      return 'pathway-search';
    }

    if (
      /\bwhich diseases?\b/.test(normalized) &&
      (normalized.includes('associated') || normalized.includes('related') || normalized.includes('linked'))
    ) {
      return 'entity-search';
    }

    if (
      normalized.includes('gene') &&
      (normalized.includes('associated') || normalized.includes('related') || normalized.includes('linked') || normalized.includes('involved'))
    ) {
      return 'entity-search';
    }

    if (
      normalized.includes('expand') ||
      normalized.includes('radius') ||
      normalized.includes('network include') ||
      normalized.includes('network including') ||
      normalized.includes('graph include') ||
      normalized.includes('graph including') ||
      normalized.includes('comprising') ||
      normalized.includes('comprise') ||
      normalized.includes('add to the network') ||
      normalized.includes('add to the graph') ||
      normalized.includes('bring into the network') ||
      normalized.includes('show the network') ||
      normalized.includes('show me a network') ||
      normalized.includes('update the graph') ||
      normalized.includes('update the network')
    ) {
      return 'graph-expansion';
    }

    if (normalized.includes('compare')) {
      return 'comparison';
    }

    if (
      normalized.includes('role') ||
      normalized.includes('related to') ||
      normalized.includes('linked to') ||
      normalized.includes('shortest path') ||
      normalized.includes('come into the picture') ||
      normalized.includes('connected') ||
      normalized.includes('relationship')
    ) {
      return 'path-search';
    }

    return 'unknown';
  }

  private requiresEntityWork(
    intent: QueryRouteIntent,
    isGraphSubjectQuery: boolean,
    hasExplicitEntitySignal: boolean,
  ) {
    if (!hasExplicitEntitySignal) {
      return false;
    }

    if (!isGraphSubjectQuery) {
      return true;
    }

    return ['path-search', 'relationship-analysis', 'graph-connections', 'drug-search', 'drug-indications', 'pathway-search', 'guideline-search', 'entity-search', 'comparison', 'graph-expansion'].includes(intent);
  }

  private createRoute(params: {
    category: QueryRoute['category'];
    intent: QueryRouteIntent;
    requiresEntityExtraction: boolean;
    requiresEntityResolution: boolean;
    requiresGraphContext: boolean;
    preferredExecutor: PreferredQueryExecutor;
    reasons: string[];
    hasGraphReference: boolean;
    hasExplicitEntitySignal: boolean;
    hasCypherSignal: boolean;
    hasSelectionContext: boolean;
  }): QueryRoute {
    return {
      category: params.category,
      intent: params.intent,
      requiresEntityExtraction: params.requiresEntityExtraction,
      requiresEntityResolution: params.requiresEntityResolution,
      requiresGraphContext: params.requiresGraphContext,
      preferredExecutor: params.preferredExecutor,
      reasons: params.reasons,
      signals: {
        hasGraphReference: params.hasGraphReference,
        hasExplicitEntitySignal: params.hasExplicitEntitySignal,
        hasCypherSignal: params.hasCypherSignal,
        hasSelectionContext: params.hasSelectionContext,
      },
    };
  }
}
