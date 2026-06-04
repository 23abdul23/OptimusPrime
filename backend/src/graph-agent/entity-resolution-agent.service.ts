import { Injectable } from '@nestjs/common';
import { OptimusKgService, type OptimusResolutionCandidate } from '@/optimuskg/optimuskg.service';
import type { ExtractedConcept, ExtractedMention, ResolvedEntity } from './graph-agent.types';
import { matchesType } from './graph-agent.utils';

type ResolutionStage = NonNullable<ResolvedEntity['resolutionStage']>;

const STAGED_RESOLUTION_ORDER: ResolutionStage[] = ['exact', 'alias', 'synonym', 'identifier', 'semantic'];

@Injectable()
export class EntityResolutionAgentService {
  constructor(private readonly optimusKgService: OptimusKgService) {}

  async resolveEntities(
    mentions: ExtractedMention[],
    concepts: ExtractedConcept[] = [],
  ): Promise<ResolvedEntity[]> {
    const resolved: ResolvedEntity[] = [];

    for (const mention of mentions) {
      const resolvedMention = await this.resolveMention(mention);
      if (resolvedMention) {
        resolved.push(resolvedMention);
      }
    }

    if (resolved.length === 0) {
      for (const concept of concepts) {
        const resolvedConcept = await this.resolveConcept(concept);
        if (resolvedConcept) {
          resolved.push(resolvedConcept);
        }
      }
    }

    const deduped = new Map<string, ResolvedEntity>();
    for (const entity of resolved) {
      const existing = deduped.get(entity.id);
      if (
        !existing ||
        this.stagePriority(entity.resolutionStage) < this.stagePriority(existing.resolutionStage) ||
        entity.confidence > existing.confidence
      ) {
        deduped.set(entity.id, entity);
      }
    }

    return [...deduped.values()];
  }

  private async resolveMention(mention: ExtractedMention): Promise<ResolvedEntity | null> {
    const candidates = await this.searchCandidatesForMention(mention);
    const typedCandidates = candidates.filter((candidate) => matchesType(candidate.typeName, mention.typeHints));
    const rankedCandidates = typedCandidates.length > 0 ? typedCandidates : candidates;

    for (const stage of STAGED_RESOLUTION_ORDER) {
      const stagedCandidates = rankedCandidates.filter((candidate) => this.classifyStage(candidate) === stage);
      const best = this.pickBestCandidate(mention.text, stagedCandidates, {
        allowWeakContains: stage === 'semantic',
      });
      if (!best) {
        continue;
      }

      return this.toResolvedEntity(best, mention.text, mention.source, stage);
    }

    return null;
  }

  private async resolveConcept(concept: ExtractedConcept): Promise<ResolvedEntity | null> {
    const candidates = await this.searchCandidatesForConcept(concept);
    const semanticCandidates = candidates.filter((candidate) => this.classifyStage(candidate) === 'semantic');
    const best = this.pickBestCandidate(concept.text, semanticCandidates, { allowWeakContains: true });
    if (!best) {
      return null;
    }

    return this.toResolvedEntity(best, concept.text, 'concept', 'semantic', 0.55);
  }

  private toResolvedEntity(
    candidate: OptimusResolutionCandidate,
    query: string,
    source: ResolvedEntity['source'],
    stage: ResolutionStage,
    conceptConfidence?: number,
  ): ResolvedEntity {
    return {
      id: candidate.id,
      query,
      displayName: candidate.displayName,
      typeCode: candidate.typeCode,
      typeName: candidate.typeName,
      confidence: conceptConfidence ?? this.scoreConfidence(candidate, stage),
      matchedOn: candidate.matchedOn,
      resolutionStage: stage,
      source,
    };
  }

  private async searchCandidatesForMention(mention: ExtractedMention) {
    return this.optimusKgService.resolveNodes(
      this.buildSearchVariants(mention.text, mention.typeHints),
      10,
      mention.typeHints,
    );
  }

  private async searchCandidatesForConcept(concept: ExtractedConcept) {
    const typeHints =
      concept.category === 'entity-class'
        ? []
        : concept.category === 'phenotype'
          ? ['Phenotype']
          : concept.category === 'biological-process'
            ? ['Pathway', 'Biological Process']
            : ['Disease', 'Pathway'];

    return this.searchCandidatesForMention({
      text: concept.text,
      span: concept.span,
      typeHints,
      source: 'query',
    });
  }

  private buildSearchVariants(text: string, typeHints: string[]) {
    const variants = new Set<string>();
    const trimmed = text.trim();
    const normalizedWhitespace = trimmed.replace(/\s+/g, ' ');
    const withoutGenericLead = normalizedWhitespace
      .replace(/^(?:various|the|relationship of|study of|relationship between)\s+/i, '')
      .replace(/^(?:genes?|proteins?|drugs?|pathways?)\s+(?:associated|related|linked)\s+with\s+/i, '')
      .replace(/^(?:genes?|proteins?|drugs?|pathways?)\s+/i, '');
    const withoutTrailingEntityClass = withoutGenericLead.replace(
      /\s+(?:gene|protein|drug|pathway|disease|syndrome|disorder|phenotype|guideline)s?\b/gi,
      '',
    );
    const normalizedCore = withoutTrailingEntityClass.trim().length > 0 ? withoutTrailingEntityClass : withoutGenericLead;

    variants.add(normalizedWhitespace);
    variants.add(withoutGenericLead);
    variants.add(normalizedCore);
    variants.add(this.toTitleCase(normalizedCore));
    variants.add(normalizedCore.replace(/-/g, ' '));
    variants.add(normalizedCore.replace(/\s+/g, '-'));
    variants.add(normalizedCore.replace(/'s\b/gi, ''));
    variants.add(this.expandGreekVariants(normalizedCore));
    variants.add(this.expandGreekVariants(normalizedCore.replace(/-/g, ' ')));
    variants.add(this.expandAmyloidVariants(normalizedCore));

    const diseaseMatch = normalizedCore.match(/([A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+){0,2}\s+disease)$/i);
    if (diseaseMatch) {
      variants.add(diseaseMatch[1]);
      variants.add(this.toTitleCase(diseaseMatch[1]));
    }

    if (typeHints.some((hint) => hint.toLowerCase() === 'disease') && !/\bdisease\b/i.test(normalizedCore)) {
      variants.add(`${normalizedCore} disease`);
      variants.add(this.toTitleCase(`${normalizedCore} disease`));
      variants.add(`${normalizedCore.replace(/'s\b/gi, '')} disease`);
    }

    return [...variants].map((variant) => variant.trim()).filter((variant) => variant.length >= 2);
  }

  private classifyStage(candidate: OptimusResolutionCandidate): ResolutionStage {
    if (
      candidate.matchedOn.some((match) =>
        ['displayName:exact', 'symbol:exact', 'id:exact', 'name:exact'].includes(match),
      )
    ) {
      return 'exact';
    }

    if (candidate.matchedOn.some((match) => ['alias:exact'].includes(match))) {
      return 'alias';
    }

    if (candidate.matchedOn.some((match) => ['sourceName:exact', 'alias:contains', 'displayName:contains'].includes(match))) {
      return 'synonym';
    }

    if (candidate.matchedOn.some((match) => ['identifier:exact'].includes(match))) {
      return 'identifier';
    }

    return 'semantic';
  }

  private pickBestCandidate(
    mentionText: string,
    candidates: OptimusResolutionCandidate[],
    options: {
      allowWeakContains?: boolean;
    } = {},
  ) {
    const ranked = [...candidates].sort(
      (a, b) =>
        b.score - a.score ||
        this.matchPriority(b) - this.matchPriority(a) ||
        a.displayName.length - b.displayName.length ||
        a.displayName.localeCompare(b.displayName),
    );
    const best = ranked[0];
    if (!best) {
      return null;
    }

    const threshold = this.minimumScoreThreshold(mentionText, options.allowWeakContains === true);
    if (best.score < threshold) {
      return null;
    }

    const second = ranked[1];
    if (
      !this.hasExactMetadataMatch(best) &&
      second &&
      Math.abs(best.score - second.score) <= 8 &&
      this.matchPriority(best) === this.matchPriority(second)
    ) {
      return null;
    }

    return best;
  }

  private scoreConfidence(candidate: OptimusResolutionCandidate, stage: ResolutionStage) {
    if (stage === 'exact') return 0.98;
    if (stage === 'alias') return candidate.score >= 110 ? 0.92 : 0.87;
    if (stage === 'synonym') return candidate.score >= 96 ? 0.84 : 0.76;
    if (stage === 'identifier') return 0.8;
    return candidate.score >= 90 ? 0.72 : 0.64;
  }

  private stagePriority(stage: ResolvedEntity['resolutionStage']) {
    if (!stage) {
      return STAGED_RESOLUTION_ORDER.length;
    }

    return STAGED_RESOLUTION_ORDER.indexOf(stage);
  }

  private toTitleCase(value: string) {
    return value.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  }

  private hasExactMetadataMatch(candidate: OptimusResolutionCandidate) {
    return candidate.matchedOn.some((match) => match.endsWith(':exact'));
  }

  private matchPriority(candidate: OptimusResolutionCandidate) {
    if (candidate.matchedOn.includes('displayName:exact')) return 8;
    if (candidate.matchedOn.includes('symbol:exact')) return 7;
    if (candidate.matchedOn.includes('id:exact')) return 7;
    if (candidate.matchedOn.includes('alias:exact')) return 6;
    if (candidate.matchedOn.includes('identifier:exact')) return 5;
    if (candidate.matchedOn.includes('sourceName:exact')) return 4;
    if (candidate.matchedOn.includes('displayName:contains')) return 3;
    if (candidate.matchedOn.includes('alias:contains')) return 2;
    if (candidate.matchedOn.includes('fulltext')) return 1;
    return 0;
  }

  private minimumScoreThreshold(mentionText: string, allowWeakContains: boolean) {
    if (allowWeakContains) {
      return 55;
    }

    const trimmed = mentionText.trim();
    const isShortToken = trimmed.length <= 4 || /^[A-Z0-9-]{2,12}$/.test(trimmed);
    if (isShortToken) {
      return 120;
    }

    if (trimmed.split(/\s+/).length >= 2) {
      return 78;
    }

    return 90;
  }

  private expandAmyloidVariants(value: string) {
    if (!/\bamyloid beta\b/i.test(value)) {
      return value;
    }

    return value
      .replace(/\bamyloid beta\b/gi, 'amyloid-beta')
      .replace(/\bamyloid-beta\b/gi, 'amyloid β')
      .replace(/\bamyloid β\b/gi, 'beta amyloid');
  }

  private expandGreekVariants(value: string) {
    return value
      .replace(/\balpha\b/gi, 'α')
      .replace(/\bbeta\b/gi, 'β')
      .replace(/\bgamma\b/gi, 'γ')
      .replace(/\bdelta\b/gi, 'δ')
      .replace(/\bkappa\b/gi, 'κ')
      .replace(/\blambda\b/gi, 'λ')
      .replace(/\bomega\b/gi, 'ω');
  }
}
