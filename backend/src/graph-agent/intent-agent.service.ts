import { Injectable } from '@nestjs/common';
import type { GraphContextResult, QueryIntentClassification, QueryRoute } from './graph-agent.types';

@Injectable()
export class IntentAgentService {
  classify(params: {
    query: string;
    queryRoute: QueryRoute;
    graphContext: GraphContextResult;
  }): QueryIntentClassification {
    const { query, queryRoute, graphContext } = params;
    const normalized = query.toLowerCase();
    const radiusMatch = normalized.match(/\bradius\s+of\s+(\d+)\b/);
    const radius = radiusMatch ? Number.parseInt(radiusMatch[1], 10) : undefined;
    const requestedEntityTypes = this.inferRequestedEntityTypes(normalized);

    if (queryRoute.category === 'CYPHER_QUERY') {
      return {
        primary: 'guarded-cypher',
        operation: 'guarded-cypher',
        requestedEntityTypes,
        allowContextFallback: false,
      };
    }

    if (
      normalized.includes('how many nodes') ||
      normalized.includes('how many edges') ||
      normalized.includes('node count') ||
      normalized.includes('edge count') ||
      normalized.includes('current network') ||
      normalized.includes('current graph')
    ) {
      return {
        primary: 'network-summary',
        operation: 'network-summary',
        requestedEntityTypes,
        allowContextFallback: false,
      };
    }

    if (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') {
      if (/\bsummariz(?:e|ing)\b|\bdescribe\b|\bexplain this subgraph\b|\bexplain these nodes\b/.test(normalized)) {
        return {
          primary: 'graph-summary',
          operation: 'graph-summary',
          requestedEntityTypes,
          allowContextFallback: false,
        };
      }

      if (/\bcompare\b/.test(normalized) && graphContext.activeAnchors.length > 0) {
        return {
          primary: 'graph-comparison',
          operation: 'graph-comparison',
          requestedEntityTypes,
          allowContextFallback: false,
        };
      }

      if (
        /\bwhat do\b.*\bhave in common\b/.test(normalized) ||
        /\bshared\b/.test(normalized) ||
        /\bcommon\b/.test(normalized)
      ) {
        return {
          primary: 'graph-commonality',
          operation: 'graph-commonality',
          requestedEntityTypes,
          allowContextFallback: false,
        };
      }

      if (
        /\bwhy are\b.*\bconnected\b/.test(normalized) ||
        /\bexplain connections\b/.test(normalized) ||
        /\bhow do\b.*\brelate\b/.test(normalized)
      ) {
        return {
          primary: 'graph-connections',
          operation: 'graph-connections',
          requestedEntityTypes,
          allowContextFallback: true,
        };
      }
    }

    if (normalized.includes('guideline')) {
      return {
        primary: 'guideline-search',
        operation: 'guideline-search',
        requestedEntityTypes: requestedEntityTypes.length > 0 ? requestedEntityTypes : ['Guideline'],
        allowContextFallback: true,
      };
    }

    if (
      normalized.includes('indicated') ||
      normalized.includes('approved for') ||
      normalized.includes('indication')
    ) {
      return {
        primary: 'drug-search',
        operation: 'drug-indications',
        requestedEntityTypes: requestedEntityTypes.length > 0 ? requestedEntityTypes : ['Disease'],
        allowContextFallback: true,
      };
    }

    if (normalized.includes('drug')) {
      return {
        primary: 'drug-search',
        operation: 'drug-search',
        requestedEntityTypes: requestedEntityTypes.length > 0 ? requestedEntityTypes : ['Drug'],
        allowContextFallback: true,
      };
    }

    if (normalized.includes('pathway')) {
      return {
        primary: 'pathway-search',
        operation: 'pathway-search',
        requestedEntityTypes: requestedEntityTypes.length > 0 ? requestedEntityTypes : ['Pathway'],
        allowContextFallback: true,
      };
    }

    if (
      normalized.includes('gene') &&
      (normalized.includes('associated') ||
        normalized.includes('related') ||
        normalized.includes('linked') ||
        normalized.includes('involved'))
    ) {
      return {
        primary: 'disease-genes',
        operation: 'entity-search',
        requestedEntityTypes: requestedEntityTypes.length > 0 ? requestedEntityTypes : ['Gene'],
        allowContextFallback: true,
      };
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
      return {
        primary: 'graph-expansion',
        operation: 'graph-expansion',
        requestedEntityTypes,
        allowContextFallback: true,
        radius,
      };
    }

    if (normalized.includes('compare')) {
      return {
        primary: 'comparison',
        operation: 'comparison',
        requestedEntityTypes,
        allowContextFallback: true,
      };
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
      return {
        primary: 'relationship-analysis',
        operation: 'path-search',
        requestedEntityTypes,
        allowContextFallback: true,
      };
    }

    return {
      primary: 'entity-neighborhood',
      operation: 'neighborhood',
      requestedEntityTypes,
      allowContextFallback: true,
      radius,
    };
  }

  private inferRequestedEntityTypes(normalizedQuery: string) {
    const requestedEntityTypes = new Set<string>();

    if (/\bgenes?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Gene');
    }
    if (/\bproteins?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Protein');
    }
    if (/\bpathways?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Pathway');
    }
    if (/\bdrugs?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Drug');
    }
    if (/\bguidelines?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Guideline');
    }
    if (/\bphenotypes?\b|\bsymptoms?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Phenotype');
    }
    if (/\bdisease\b|\bdementia\b|\balzheimer(?:'s)?\b|\bcancer\b|\bsyndrome\b|\bdisorder\b|\bparkinson\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Disease');
    }

    return [...requestedEntityTypes];
  }
}
