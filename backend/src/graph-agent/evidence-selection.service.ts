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
    const rankedItems = [...params.items]
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 12);

    return {
      query: params.query,
      resolvedEntities: params.resolvedEntities,
      plan: params.plan,
      items: rankedItems,
      insufficientEvidence: rankedItems.length === 0,
      warnings: params.warnings,
    };
  }
}
