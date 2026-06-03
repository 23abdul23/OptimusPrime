import { Injectable } from '@nestjs/common';
import { OptimusKgService } from '@/optimuskg/optimuskg.service';
import type { ExtractedConcept, ExtractedMention, ResolvedEntity } from './graph-agent.types';
import { matchesType } from './graph-agent.utils';

@Injectable()
export class EntityResolutionService {
  constructor(private readonly optimusKgService: OptimusKgService) {}

  async resolveEntities(
    mentions: ExtractedMention[],
    concepts: ExtractedConcept[] = [],
  ): Promise<ResolvedEntity[]> {
    const resolved: ResolvedEntity[] = [];

    for (const mention of mentions) {
      const candidates = await this.searchCandidatesForMention(mention);
      const filteredCandidates = candidates.filter((candidate) => matchesType(candidate.typeName, mention.typeHints));
      const candidate = this.pickBestCandidate(mention.text, filteredCandidates[0] ? filteredCandidates : candidates);
      if (!candidate) {
        continue;
      }

      const exactMatch = candidate.displayName.toLowerCase() === mention.text.toLowerCase();
      resolved.push({
        id: candidate.id,
        query: mention.text,
        displayName: candidate.displayName,
        typeCode: candidate.typeCode,
        typeName: candidate.typeName,
        confidence: exactMatch ? 0.95 : filteredCandidates.length <= 1 ? 0.8 : 0.65,
        matchedOn: candidate.matchedOn,
        source: mention.source,
      });
    }

    if (resolved.length === 0) {
      for (const concept of concepts) {
        const candidates = await this.searchCandidatesForConcept(concept);
        const candidate = this.pickBestCandidate(concept.text, candidates);
        if (!candidate) {
          continue;
        }

        resolved.push({
          id: candidate.id,
          query: concept.text,
          displayName: candidate.displayName,
          typeCode: candidate.typeCode,
          typeName: candidate.typeName,
          confidence: 0.55,
          matchedOn: candidate.matchedOn,
          source: 'concept',
        });
      }
    }

    const deduped = new Map<string, ResolvedEntity>();
    for (const entity of resolved) {
      const existing = deduped.get(entity.id);
      if (!existing || entity.confidence > existing.confidence) {
        deduped.set(entity.id, entity);
      }
    }

    return [...deduped.values()];
  }

  private async searchCandidatesForMention(mention: ExtractedMention) {
    const seen = new Map<string, Awaited<ReturnType<OptimusKgService['searchNodes']>>[number]>();
    for (const variant of this.buildSearchVariants(mention.text, mention.typeHints)) {
      const results = await this.optimusKgService.searchNodes(variant, 5, mention.typeHints);
      for (const result of results) {
        if (!seen.has(result.id)) {
          seen.set(result.id, result);
        }
      }
      if (seen.size >= 5) {
        break;
      }
    }

    return [...seen.values()];
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

    variants.add(normalizedWhitespace);
    variants.add(withoutGenericLead);
    variants.add(this.toTitleCase(withoutGenericLead));

    const diseaseMatch = withoutGenericLead.match(/([A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+){0,2}\s+disease)$/i);
    if (diseaseMatch) {
      variants.add(diseaseMatch[1]);
      variants.add(this.toTitleCase(diseaseMatch[1]));
    }

    if (typeHints.some((hint) => hint.toLowerCase() === 'disease') && !/\bdisease\b/i.test(withoutGenericLead)) {
      variants.add(`${withoutGenericLead} disease`);
      variants.add(this.toTitleCase(`${withoutGenericLead} disease`));
    }

    return [...variants].filter((variant) => variant.trim().length >= 2);
  }

  private pickBestCandidate(
    mentionText: string,
    candidates: Awaited<ReturnType<OptimusKgService['searchNodes']>>[number][],
  ) {
    const normalizedMention = mentionText.trim().toLowerCase();

    return [...candidates].sort((a, b) => {
      const aName = a.displayName.toLowerCase();
      const bName = b.displayName.toLowerCase();
      const aExact = aName === normalizedMention ? 2 : aName.includes(normalizedMention) ? 1 : 0;
      const bExact = bName === normalizedMention ? 2 : bName.includes(normalizedMention) ? 1 : 0;
      return bExact - aExact || a.displayName.length - b.displayName.length;
    })[0] ?? null;
  }

  private toTitleCase(value: string) {
    return value.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
  }
}
