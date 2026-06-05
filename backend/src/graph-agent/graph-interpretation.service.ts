import { Injectable } from '@nestjs/common';
import type {
  GraphContextResult,
  GraphEvidenceBundle,
  GraphInterpretation,
  ResolvedEntity,
} from './graph-agent.types';

@Injectable()
export class GraphInterpretationService {
  interpret(params: {
    evidence: GraphEvidenceBundle;
    graphContext: GraphContextResult;
    resolvedEntities: ResolvedEntity[];
  }): GraphInterpretation {
    const { evidence, graphContext, resolvedEntities } = params;
    const dominantConcepts = this.pickDominantConcepts(evidence, resolvedEntities);
    const dominantRelationships = this.pickDominantRelationships(evidence);
    const networkType = this.pickNetworkType(evidence, graphContext, resolvedEntities);
    const theme = this.pickTheme(evidence, dominantConcepts, dominantRelationships, networkType);

    return {
      theme,
      dominantConcepts,
      dominantRelationships,
      networkType,
      summary: [
        `Theme: ${theme}.`,
        dominantConcepts.length > 0
          ? `Dominant concepts: ${dominantConcepts.join(', ')}.`
          : 'Dominant concepts were not confidently identified.',
        dominantRelationships.length > 0
          ? `Dominant relationships: ${dominantRelationships.join(', ')}.`
          : 'Dominant relationships were not confidently identified.',
        `Network type: ${networkType}.`,
      ].join(' '),
    };
  }

  private pickDominantConcepts(
    evidence: GraphEvidenceBundle,
    resolvedEntities: ResolvedEntity[],
  ) {
    const concepts = new Set<string>();

    for (const entity of resolvedEntities.slice(0, 6)) {
      concepts.add(entity.displayName);
    }

    for (const item of evidence.items.slice(0, 6)) {
      if (item.kind !== 'entity') {
        continue;
      }

      const label = item.title.split(' (')[0]?.trim();
      if (label) {
        concepts.add(label);
      }
    }

    return [...concepts].slice(0, 6);
  }

  private pickDominantRelationships(evidence: GraphEvidenceBundle) {
    const relationships = new Map<string, number>();

    for (const item of evidence.items) {
      const relation =
        typeof item.metadata?.relation === 'string'
          ? item.metadata.relation
          : typeof item.metadata?.relationTypes?.[0] === 'string'
            ? String(item.metadata.relationTypes[0])
            : undefined;

      if (!relation) {
        continue;
      }

      relationships.set(relation, (relationships.get(relation) ?? 0) + 1);
    }

    return [...relationships.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([relation]) => relation);
  }

  private pickNetworkType(
    evidence: GraphEvidenceBundle,
    graphContext: GraphContextResult,
    resolvedEntities: ResolvedEntity[],
  ) {
    const lowerOperations = evidence.plan.map((step) => step.operation.toLowerCase());
    const typeNames = resolvedEntities.map((entity) => entity.typeName.toLowerCase());

    if (lowerOperations.some((operation) => operation.includes('shared') || operation.includes('compare'))) {
      return 'Comparative graph module';
    }
    if (lowerOperations.some((operation) => operation.includes('enrich'))) {
      return 'Enrichment-oriented graph module';
    }
    if (lowerOperations.some((operation) => operation.includes('drug'))) {
      return 'Drug-target graph module';
    }
    if (typeNames.some((type) => /disease|phenotype/.test(type)) && typeNames.some((type) => /gene|protein/.test(type))) {
      return 'Disease-gene graph module';
    }
    if (graphContext.graphScope.mode === 'selection') {
      return 'Selection-focused graph module';
    }

    return 'General biomedical graph module';
  }

  private pickTheme(
    evidence: GraphEvidenceBundle,
    dominantConcepts: string[],
    dominantRelationships: string[],
    networkType: string,
  ) {
    if (evidence.plan.some((step) => step.operation.includes('drug'))) {
      return 'Therapeutic mechanism exploration';
    }
    if (evidence.plan.some((step) => step.operation.includes('pathway'))) {
      return 'Pathway-centric mechanism exploration';
    }
    if (evidence.plan.some((step) => step.operation.includes('ontology'))) {
      return 'Ontology structure exploration';
    }
    if (dominantRelationships.some((relation) => relation.includes('TARGET'))) {
      return 'Target interaction landscape';
    }
    if (dominantConcepts.length > 0) {
      return `${dominantConcepts[0]}-centered ${networkType.toLowerCase()}`;
    }

    return networkType;
  }
}
