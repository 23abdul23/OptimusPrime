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

    if (
      /\b(ontology|hierarchy|ancestor|ancestors|descendant|descendants|parent|parents|child|children|root|roots)\b/.test(
        normalized,
      )
    ) {
      return {
        primary: 'ontology-analysis',
        operation: 'ontology-analysis',
        requestedEntityTypes,
        allowContextFallback: true,
      };
    }

    if (
      /\benrich(?:ed|ment)?\b/.test(normalized) ||
      /\bover-?represent(?:ed|ation)?\b/.test(normalized) ||
      /\boverrepresented\b/.test(normalized)
    ) {
      return {
        primary: 'enrichment-analysis',
        operation: 'enrichment-analysis',
        requestedEntityTypes,
        allowContextFallback: true,
      };
    }

    if (/\bcommunit(?:y|ies)\b|\bmodules?\b/.test(normalized)) {
      return {
        primary: 'community-detection',
        operation: 'community-detection',
        requestedEntityTypes,
        allowContextFallback: false,
      };
    }

    if (
      /\brelationship types?\b/.test(normalized) ||
      /\brelationships?\b.*\bdominat/.test(normalized) ||
      /\bdominant\b.*\brelationships?\b/.test(normalized) ||
      /\bhow are\b.*\bconnected\b/.test(normalized)
    ) {
      return {
        primary: 'graph-relationship-analysis',
        operation: 'graph-relationship-analysis',
        requestedEntityTypes,
        allowContextFallback: true,
      };
    }

    if (
      /\bschema\b/.test(normalized) ||
      /\bnode types?\b/.test(normalized) ||
      /\bwhat .* are present\b/.test(normalized) ||
      /\bpresent in (?:the )?(?:graph|network|subgraph)\b/.test(normalized)
    ) {
      return {
        primary: 'schema-analysis',
        operation: 'schema-analysis',
        requestedEntityTypes,
        allowContextFallback: false,
      };
    }

    if (
      /\bmetrics?\b/.test(normalized) ||
      /\bstatistics?\b/.test(normalized) ||
      /\bhubs?\b/.test(normalized) ||
      /\bcentral\b/.test(normalized) ||
      /\bclusters?\b/.test(normalized) ||
      /\bcomponents?\b/.test(normalized) ||
      /\bdensity\b/.test(normalized) ||
      /\btopology\b/.test(normalized)
    ) {
      return {
        primary: 'network-statistics',
        operation: 'network-statistics',
        requestedEntityTypes,
        allowContextFallback: false,
      };
    }

    if (/\bexposures?\b|\benvironmental\b|\btoxicant\b/.test(normalized)) {
      return {
        primary: 'exposure-analysis',
        operation: 'exposure-analysis',
        requestedEntityTypes: requestedEntityTypes.length > 0 ? requestedEntityTypes : ['Exposure'],
        allowContextFallback: true,
      };
    }

    if (
      /\bdrug targets?\b/.test(normalized) ||
      /\bmechanisms?\b/.test(normalized) ||
      /\bcontraindications?\b/.test(normalized) ||
      /\boff-?label\b/.test(normalized) ||
      /\bapproved drugs?\b/.test(normalized)
    ) {
      return {
        primary: 'drug-discovery',
        operation: 'drug-discovery',
        requestedEntityTypes,
        allowContextFallback: true,
      };
    }

    if (
      /\binterpret\b/.test(normalized) ||
      /\bgraph theme\b/.test(normalized) ||
      /\bbiological narrative\b/.test(normalized) ||
      /\bcentral concepts?\b/.test(normalized)
    ) {
      return {
        primary: 'graph-explanation',
        operation: 'graph-explanation',
        requestedEntityTypes,
        allowContextFallback: false,
      };
    }

    if (queryRoute.category === 'GRAPH_QUERY' || queryRoute.category === 'MIXED_QUERY') {
      if (
        /\bsummariz(?:e|ing)\b|\bdescribe\b|\bexplain this subgraph\b|\bexplain these nodes\b/.test(normalized) ||
        this.isGraphWideAnalysisQuery(normalized)
      ) {
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

    if (queryRoute.category === 'GRAPH_DISCOVERY_QUERY') {
      return {
        primary: 'graph-discovery',
        operation: 'graph-discovery',
        requestedEntityTypes,
        allowContextFallback: true,
        radius,
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
    if (/\bbiological processes?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('BiologicalProcess');
    }
    if (/\bmolecular functions?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('MolecularFunction');
    }
    if (/\bcellular components?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('CellularComponent');
    }
    if (/\banatom(y|ical)\b|\borgans?\b|\btissues?\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Anatomy');
    }
    if (/\bexposures?\b|\benvironmental\b|\btoxicant\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Exposure');
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

  private isGraphWideAnalysisQuery(normalizedQuery: string) {
    return (
      /\bnetwork\b|\bgraph\b|\bsubgraph\b/.test(normalizedQuery) &&
      (
        /\brelationships?\b.*\bdominat/.test(normalizedQuery) ||
        /\bdominant\b.*\brelationships?\b/.test(normalizedQuery) ||
        /\bhubs?\b/.test(normalizedQuery) ||
        /\bcentral\b/.test(normalizedQuery) ||
        /\bclusters?\b/.test(normalizedQuery) ||
        /\bcomponents?\b/.test(normalizedQuery) ||
        /\btopology\b/.test(normalizedQuery) ||
        /\bnode types?\b/.test(normalizedQuery) ||
        /\bschema\b/.test(normalizedQuery) ||
        /\brelationship types?\b/.test(normalizedQuery) ||
        /\bmetrics?\b/.test(normalizedQuery) ||
        /\bstatistics?\b/.test(normalizedQuery) ||
        /\bcommunities?\b/.test(normalizedQuery) ||
        /\bmodules?\b/.test(normalizedQuery) ||
        /\bontology\b/.test(normalizedQuery) ||
        /\benrich(?:ed|ment)?\b/.test(normalizedQuery) ||
        /\bwhat .* are present\b/.test(normalizedQuery) ||
        /\bmolecular functions?\b/.test(normalizedQuery) ||
        /\bcellular components?\b/.test(normalizedQuery) ||
        /\banatom(y|ical)\b/.test(normalizedQuery) ||
        /\bphenotypes?\b/.test(normalizedQuery)
      )
    );
  }
}
