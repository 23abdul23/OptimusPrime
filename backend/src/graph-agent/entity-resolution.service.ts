import { Injectable } from '@nestjs/common';
import { OptimusKgService, type OptimusResolutionCandidate } from '@/optimuskg/optimuskg.service';
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

      const exactMatch = this.hasExactMetadataMatch(candidate);
      resolved.push({
        id: candidate.id,
        query: mention.text,
        displayName: candidate.displayName,
        typeCode: candidate.typeCode,
        typeName: candidate.typeName,
        confidence: exactMatch ? 0.98 : candidate.score >= 120 ? 0.9 : candidate.score >= 90 ? 0.8 : 0.68,
        matchedOn: candidate.matchedOn,
        source: mention.source,
      });
    }

    if (resolved.length === 0) {
      for (const concept of concepts) {
        const candidates = await this.searchCandidatesForConcept(concept);
        const candidate = this.pickBestCandidate(concept.text, candidates, { allowWeakContains: true });
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
    return this.optimusKgService.resolveNodes(this.buildSearchVariants(mention.text, mention.typeHints), 8, mention.typeHints);
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
    variants.add(withoutGenericLead.replace(/-/g, ' '));
    variants.add(withoutGenericLead.replace(/\s+/g, '-'));
    variants.add(withoutGenericLead.replace(/'s\b/gi, ''));
    variants.add(this.expandGreekVariants(withoutGenericLead));
    variants.add(this.expandGreekVariants(withoutGenericLead.replace(/-/g, ' ')));

    const diseaseMatch = withoutGenericLead.match(/([A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+){0,2}\s+disease)$/i);
    if (diseaseMatch) {
      variants.add(diseaseMatch[1]);
      variants.add(this.toTitleCase(diseaseMatch[1]));
    }

    if (typeHints.some((hint) => hint.toLowerCase() === 'disease') && !/\bdisease\b/i.test(withoutGenericLead)) {
      variants.add(`${withoutGenericLead} disease`);
      variants.add(this.toTitleCase(`${withoutGenericLead} disease`));
      variants.add(`${withoutGenericLead.replace(/'s\b/gi, '')} disease`);
    }

    return [...variants].map((variant) => variant.trim()).filter((variant) => variant.length >= 2);
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
    if (candidate.matchedOn.includes('identifier:exact')) return 6;
    if (candidate.matchedOn.includes('name:exact')) return 5;
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
