import { Injectable } from '@nestjs/common';
import type {
  GraphEvidenceAssessment,
  GraphEvidenceBundle,
  GraphEvidenceItem,
  RetrievalOperation,
  RetrievalPlanStep,
  ResolvedEntity,
} from './graph-agent.types';

@Injectable()
export class EvidenceAgentService {
  buildBundle(params: {
    query: string;
    items: GraphEvidenceItem[];
    resolvedEntities: ResolvedEntity[];
    plan: RetrievalPlanStep[];
    warnings: string[];
    selectedNodeIds?: string[];
    visibleNodeIds?: string[];
    replanAttempts?: number;
  }): GraphEvidenceBundle {
    const resolvedNodeIds = new Set(params.resolvedEntities.map((entity) => entity.id));
    const selectedNodeIds = new Set(params.selectedNodeIds ?? []);
    const visibleNodeIds = new Set(params.visibleNodeIds ?? []);
    const rankedItems = [...params.items]
      .map((item) => ({
        item,
        rank: this.rankItem(item, resolvedNodeIds, selectedNodeIds, visibleNodeIds),
      }))
      .sort((a, b) => b.rank - a.rank || b.item.score - a.item.score || a.item.title.localeCompare(b.item.title))
      .map(({ item }) => item)
      .slice(0, 12);
    const assessment = this.assessEvidence({
      items: rankedItems,
      plan: params.plan,
      warnings: params.warnings,
      replanAttempts: params.replanAttempts ?? 0,
    });

    return {
      query: params.query,
      resolvedEntities: params.resolvedEntities,
      plan: params.plan,
      items: rankedItems,
      insufficientEvidence: rankedItems.length === 0 || assessment.isInsufficient,
      warnings: params.warnings,
      confidence: assessment.confidence,
      confidenceLabel: assessment.confidenceLabel,
      provenanceHighlights: this.extractProvenanceHighlights(rankedItems),
      assessment,
    };
  }

  private assessEvidence(params: {
    items: GraphEvidenceItem[];
    plan: RetrievalPlanStep[];
    warnings: string[];
    replanAttempts: number;
  }): GraphEvidenceAssessment {
    const analyticalOperations = params.plan.filter((step) =>
      [
        'get-related-entities',
        'get-related-diseases',
        'get-related-genes',
        'get-related-proteins',
        'get-related-pathways',
        'get-related-drugs',
        'get-drug-indications',
        'retrieve-clinical-guidelines',
        'retrieve-relationship-evidence',
        'find-shortest-path',
        'find-common-neighbors',
        'find-shared-pathways',
        'find-shared-diseases',
        'find-shared-genes',
        'explain-connections',
      ].includes(step.operation),
    );
    const analyticalEvidenceItems = params.items.filter((item) => ['relation', 'path', 'guideline'].includes(item.kind));
    const analyticalCoverage =
      analyticalOperations.length === 0
        ? params.items.length > 0
          ? 1
          : 0
        : Math.min(1, analyticalEvidenceItems.length / analyticalOperations.length);
    const provenanceCoverage = this.computeProvenanceCoverage(params.items);
    const topScore = params.items[0]?.score ?? 0;
    const averageTopScore =
      params.items.slice(0, 3).reduce((sum, item) => sum + item.score, 0) / Math.max(1, Math.min(3, params.items.length));
    const warningPenalty = Math.min(0.24, params.warnings.length * 0.05);
    const confidence = this.clamp01(
      topScore * 0.4 +
        averageTopScore * 0.25 +
        analyticalCoverage * 0.2 +
        provenanceCoverage * 0.15 -
        warningPenalty,
    );
    const confidenceLabel = confidence >= 0.78 ? 'high' : confidence >= 0.55 ? 'medium' : 'low';
    const matchedOperations = this.inferMatchedOperations(params.plan, params.items);
    const isInsufficient =
      params.items.length === 0 ||
      (analyticalOperations.length > 0 && analyticalEvidenceItems.length === 0) ||
      confidence < 0.55;
    const needsReplan =
      isInsufficient &&
      params.replanAttempts < 2 &&
      this.hasRemainingCoverageGap(analyticalCoverage, params.plan);

    return {
      confidence,
      confidenceLabel,
      isInsufficient,
      needsReplan,
      rationale: this.buildAssessmentRationale({
        confidenceLabel,
        analyticalCoverage,
        provenanceCoverage,
        warningCount: params.warnings.length,
        itemCount: params.items.length,
        isInsufficient,
        needsReplan,
      }),
      analyticalCoverage,
      provenanceCoverage,
      matchedOperations,
      replanAttempts: params.replanAttempts,
    };
  }

  private inferMatchedOperations(plan: RetrievalPlanStep[], items: GraphEvidenceItem[]): RetrievalOperation[] {
    const availableKinds = new Set(items.map((item) => item.kind));

    return plan
      .filter((step) => {
        if (availableKinds.size === 0) {
          return false;
        }

        if (
          [
            'retrieve-relationship-evidence',
            'find-shortest-path',
            'find-common-neighbors',
            'find-shared-pathways',
            'find-shared-diseases',
            'find-shared-genes',
            'explain-connections',
            'get-related-entities',
            'get-related-diseases',
            'get-related-genes',
            'get-related-proteins',
            'get-related-pathways',
            'get-related-drugs',
            'get-drug-indications',
            'retrieve-clinical-guidelines',
          ].includes(step.operation)
        ) {
          return availableKinds.has('relation') || availableKinds.has('path') || availableKinds.has('guideline');
        }

        if (
          ['summarize-selected-nodes', 'summarize-visible-subgraph', 'compare-nodes', 'analyze-cluster'].includes(
            step.operation,
          )
        ) {
          return availableKinds.has('query') || availableKinds.has('entity') || availableKinds.has('path');
        }

        return items.length > 0;
      })
      .map((step) => step.operation);
  }

  private hasRemainingCoverageGap(analyticalCoverage: number, plan: RetrievalPlanStep[]) {
    return analyticalCoverage < 0.75 && plan.some((step) => step.executor !== 'state' && step.executor !== 'resolution-agent');
  }

  private buildAssessmentRationale(params: {
    confidenceLabel: GraphEvidenceAssessment['confidenceLabel'];
    analyticalCoverage: number;
    provenanceCoverage: number;
    warningCount: number;
    itemCount: number;
    isInsufficient: boolean;
    needsReplan: boolean;
  }) {
    const parts = [
      `${params.itemCount} ranked evidence item${params.itemCount === 1 ? '' : 's'} were retained.`,
      `Analytical coverage is ${(params.analyticalCoverage * 100).toFixed(0)}%.`,
      `Provenance coverage is ${(params.provenanceCoverage * 100).toFixed(0)}%.`,
      params.warningCount > 0 ? `${params.warningCount} warning${params.warningCount === 1 ? '' : 's'} were raised.` : '',
      params.needsReplan
        ? 'Evidence is still incomplete enough to justify another retrieval pass.'
        : params.isInsufficient
          ? 'Evidence remains partial after the current retrieval budget.'
          : 'Evidence is sufficient for grounded synthesis.',
    ].filter((part) => part.length > 0);

    return `${params.confidenceLabel.toUpperCase()} confidence. ${parts.join(' ')}`;
  }

  private extractProvenanceHighlights(items: GraphEvidenceItem[]) {
    const highlights = new Set<string>();

    for (const item of items.slice(0, 6)) {
      const metadata = item.metadata;
      if (!metadata) {
        continue;
      }

      for (const key of ['provenance', 'sourceNames', 'sourceDirect', 'sourceIndirect']) {
        const value = metadata[key];
        if (!Array.isArray(value)) {
          continue;
        }

        for (const entry of value) {
          if (typeof entry === 'string' && entry.trim().length > 0) {
            highlights.add(entry.trim());
          }
        }
      }
    }

    return [...highlights].slice(0, 8);
  }

  private computeProvenanceCoverage(items: GraphEvidenceItem[]) {
    if (items.length === 0) {
      return 0;
    }

    const provenanceWeight = items
      .slice(0, 6)
      .reduce((sum, item) => sum + Math.min(1, this.extractArrayCount(item.metadata, ['provenance', 'sourceDirect', 'sourceIndirect', 'sourceNames']) / 5), 0);

    return this.clamp01(provenanceWeight / Math.min(6, items.length));
  }

  private rankItem(
    item: GraphEvidenceItem,
    resolvedNodeIds: Set<string>,
    selectedNodeIds: Set<string>,
    visibleNodeIds: Set<string>,
  ) {
    const directResolvedCoverage =
      item.nodeIds.length > 0 ? item.nodeIds.filter((nodeId) => resolvedNodeIds.has(nodeId)).length : 0;
    const selectedCoverage =
      item.nodeIds.length > 0 ? item.nodeIds.filter((nodeId) => selectedNodeIds.has(nodeId)).length : 0;
    const visibleCoverage =
      item.nodeIds.length > 0 ? item.nodeIds.filter((nodeId) => visibleNodeIds.has(nodeId)).length : 0;
    const provenanceCount = this.extractArrayCount(item.metadata, [
      'provenance',
      'sourceDirect',
      'sourceIndirect',
      'sourceNames',
    ]);
    const metadataRichness = item.metadata ? Object.keys(item.metadata).length : 0;
    const support = this.extractNumericValue(item.metadata, ['support']);
    const confidence = this.extractNumericValue(item.metadata, ['confidence']);
    const descriptionBoost =
      item.metadata &&
      (typeof item.metadata.neighborDescription === 'string' || typeof item.metadata.description === 'string')
        ? 0.03
        : 0;
    const pathPenalty = item.kind === 'path' ? Math.max(0, item.nodeIds.length - 3) * 0.03 : 0;
    const kindBoost =
      item.kind === 'relation'
        ? 0.22
        : item.kind === 'path'
          ? 0.16
          : item.kind === 'entity'
            ? 0.1
            : item.kind === 'guideline'
              ? 0.14
              : 0.05;

    return (
      item.score +
      kindBoost +
      directResolvedCoverage * 0.08 +
      selectedCoverage * 0.1 +
      Math.min(0.08, visibleCoverage * 0.015) +
      Math.min(0.1, support * 0.03) +
      Math.min(0.08, confidence * 0.04) +
      Math.min(0.12, provenanceCount * 0.02) +
      Math.min(0.08, metadataRichness * 0.01) +
      descriptionBoost -
      pathPenalty
    );
  }

  private extractArrayCount(metadata: Record<string, unknown> | undefined, keys: string[]) {
    if (!metadata) {
      return 0;
    }

    return keys.reduce((count, key) => {
      const value = metadata[key];
      return count + (Array.isArray(value) ? value.length : 0);
    }, 0);
  }

  private extractNumericValue(metadata: Record<string, unknown> | undefined, keys: string[]) {
    if (!metadata) {
      return 0;
    }

    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }

    return 0;
  }

  private clamp01(value: number) {
    return Math.max(0, Math.min(1, value));
  }
}
