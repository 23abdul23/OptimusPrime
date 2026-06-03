import { Injectable } from '@nestjs/common';
import type { GraphEvidenceBundle, GraphEvidenceItem, RetrievalPlanStep, ResolvedEntity } from './graph-agent.types';

@Injectable()
export class EvidenceSelectionService {
  buildBundle(params: {
    query: string;
    items: GraphEvidenceItem[];
    resolvedEntities: ResolvedEntity[];
    plan: RetrievalPlanStep[];
    warnings: string[];
  }): GraphEvidenceBundle {
    const resolvedNodeIds = new Set(params.resolvedEntities.map((entity) => entity.id));
    const rankedItems = [...params.items]
      .map((item) => ({
        item,
        rank: this.rankItem(item, resolvedNodeIds),
      }))
      .sort((a, b) => b.rank - a.rank || b.item.score - a.item.score || a.item.title.localeCompare(b.item.title))
      .map(({ item }) => item)
      .slice(0, 12);
    const planNeedsAnalyticalEvidence = params.plan.some((step) =>
      ['getRelatedEntities', 'retrieveEvidence', 'shortestPath', 'retrieveClinicalGuidelines'].includes(step.tool),
    );
    const hasAnalyticalEvidence = rankedItems.some((item) =>
      ['relation', 'path', 'guideline'].includes(item.kind),
    );

    return {
      query: params.query,
      resolvedEntities: params.resolvedEntities,
      plan: params.plan,
      items: rankedItems,
      insufficientEvidence: rankedItems.length === 0 || (planNeedsAnalyticalEvidence && !hasAnalyticalEvidence),
      warnings: params.warnings,
    };
  }

  private rankItem(item: GraphEvidenceItem, resolvedNodeIds: Set<string>) {
    const directResolvedCoverage =
      item.nodeIds.length > 0 ? item.nodeIds.filter((nodeId) => resolvedNodeIds.has(nodeId)).length : 0;
    const provenanceCount = this.extractArrayCount(item.metadata, ['provenance', 'sourceDirect', 'sourceIndirect', 'sourceNames']);
    const metadataRichness = item.metadata ? Object.keys(item.metadata).length : 0;
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
      Math.min(0.12, provenanceCount * 0.02) +
      Math.min(0.08, metadataRichness * 0.01) -
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
}
