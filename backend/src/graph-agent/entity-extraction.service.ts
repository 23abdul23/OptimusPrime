import { Injectable } from '@nestjs/common';
import type {
  ExtractedConcept,
  ExtractedMention,
  ExtractedQuery,
  QueryIntentClassification,
} from './graph-agent.types';

const CAPTURED_PHRASE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'various',
  'current',
  'all',
  'new',
  'also',
]);

const CONCEPT_PATTERNS: Array<{ pattern: RegExp; category: ExtractedConcept['category'] }> = [
  { pattern: /\b(cancer|oncology|tumou?r|carcinoma)\b/gi, category: 'disease-area' },
  { pattern: /\b(alzheimer(?:'s)?|dementia|neurodegeneration|neurodegenerative)\b/gi, category: 'disease-area' },
  { pattern: /\b(inflammation|immune response|oxidative stress|apoptosis)\b/gi, category: 'biological-process' },
  { pattern: /\b(phenotype|symptom|biomarker)\b/gi, category: 'phenotype' },
  { pattern: /\b(pathway|gene|genes|protein|proteins|drug|drugs)\b/gi, category: 'entity-class' },
];

const PAIR_MENTION_PATTERNS: Array<{
  pattern: RegExp;
  leftHints?: string[];
  rightHints?: string[];
}> = [
  {
    pattern: /\bwhat role does\s+(.+?)\s+play in\s+(.+?)(?:\?|$)/i,
    rightHints: ['Disease'],
  },
  {
    pattern: /\bhow is\s+(.+?)\s+(?:related|connected|linked)\s+to\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bcompare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bwhich pathways connect\s+(.+?)\s+(?:and|to)\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\brelationship(?:\s+between)?\s+(.+?)\s+(?:and|to)\s+(.+?)(?:\?|$)/i,
  },
];

const SINGLE_MENTION_PATTERNS: Array<{
  pattern: RegExp;
  typeHints?: string[];
}> = [
  {
    pattern: /\b(?:approved\s+)?drugs?\s+(?:for|in)\s+(.+?)(?:\?|$)/i,
    typeHints: ['Disease'],
  },
  {
    pattern: /\bgenes?\s+(?:associated|related|linked)\s+(?:with|to)\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bgenes?\s+involved\s+in\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bpathways?\s+(?:associated|related|linked)\s+(?:with|to)\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bproteins?\s+associated\s+with\s+(.+?)(?:\?|$)/i,
  },
];

export const GRAPH_AGENT_EXTRACTION_SYSTEM_PROMPT = `
You are a biomedical query extractor for a knowledge graph.

Rules:
- Extract only explicit text spans that appear verbatim in the user's latest message.
- Never invent, infer, normalize, expand, alias, or rewrite biomedical entities.
- If the user wrote "MAPT", output "MAPT" only. Do not add COMETT, tau, microtubule associated protein tau, or any related concept.
- Do not use conversation memory, selected graph nodes, or prior answers as extracted entities.
- Separate explicit entity mentions from broader concepts and from user intent.
- If a query contains no explicit entity mention, return an empty mentions array.
- Concepts must also be explicit spans from the user's text.
- The knowledge graph is the only source of truth for entity existence and resolution.

Return strict JSON only.
`.trim();

export const GRAPH_AGENT_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mentions', 'concepts', 'intent'],
  properties: {
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'span', 'typeHints', 'source'],
        properties: {
          text: { type: 'string' },
          span: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'end'],
            properties: {
              start: { type: 'integer', minimum: 0 },
              end: { type: 'integer', minimum: 0 },
            },
          },
          typeHints: {
            type: 'array',
            items: { type: 'string' },
          },
          source: { type: 'string', enum: ['query'] },
        },
      },
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'span', 'category', 'source'],
        properties: {
          text: { type: 'string' },
          span: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'end'],
            properties: {
              start: { type: 'integer', minimum: 0 },
              end: { type: 'integer', minimum: 0 },
            },
          },
          category: { type: 'string' },
          source: { type: 'string', enum: ['query'] },
        },
      },
    },
    intent: {
      type: 'object',
      additionalProperties: false,
      required: ['primary', 'operation', 'requestedEntityTypes', 'allowContextFallback'],
      properties: {
        primary: { type: 'string' },
        operation: { type: 'string' },
        requestedEntityTypes: { type: 'array', items: { type: 'string' } },
        allowContextFallback: { type: 'boolean' },
        radius: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

@Injectable()
export class EntityExtractionService {
  extractQuery(params: { query: string }): ExtractedQuery {
    const { query } = params;
    const mentions = this.extractMentions(query);
    const concepts = this.extractConcepts(query, mentions);
    const intent = this.classifyIntent(query);

    return {
      query,
      mentions,
      concepts,
      intent,
    };
  }

  private extractMentions(query: string): ExtractedMention[] {
    const mentions: ExtractedMention[] = [];
    const seenRanges = new Set<string>();

    const addMention = (text: string, start: number, end: number, typeHints: string[] = []) => {
      const normalized = this.normalizeCapturedPhrase(text);
      if (normalized.length < 2) {
        return;
      }

      if (this.shouldDiscardMention(normalized)) {
        return;
      }

      if (this.shouldTreatAsConceptOnly(normalized)) {
        return;
      }

      const key = `${start}:${end}:${normalized.toLowerCase()}`;
      if (seenRanges.has(key)) {
        return;
      }

      seenRanges.add(key);
      mentions.push({
        text: normalized,
        span: { start, end },
        typeHints,
        source: 'query',
      });
    };

    for (const match of query.matchAll(/"([^"]+)"/g)) {
      const text = match[1]?.trim();
      if (!text || match.index === undefined) {
        continue;
      }
      const start = match.index + match[0].indexOf(text);
      addMention(text, start, start + text.length, this.inferTypeHints(text));
    }

    for (const { pattern, leftHints = [], rightHints = [] } of PAIR_MENTION_PATTERNS) {
      const match = pattern.exec(query);
      if (!match || match.index === undefined) {
        continue;
      }

      const left = match[1];
      const right = match[2];
      if (!left || !right) {
        continue;
      }

      const leftOffset = match.index + match[0].indexOf(left);
      const rightOffset = match.index + match[0].indexOf(right, match[0].indexOf(left) + left.length);

      addMention(left, leftOffset, leftOffset + left.length, [...this.inferTypeHints(left), ...leftHints]);
      addMention(right, rightOffset, rightOffset + right.length, [...this.inferTypeHints(right), ...rightHints]);
    }

    for (const { pattern, typeHints = [] } of SINGLE_MENTION_PATTERNS) {
      const match = pattern.exec(query);
      if (!match || match.index === undefined) {
        continue;
      }

      const text = match[1];
      if (!text) {
        continue;
      }

      const offset = match.index + match[0].indexOf(text);
      addMention(text, offset, offset + text.length, [...this.inferTypeHints(text), ...typeHints]);
    }

    for (const match of query.matchAll(/\b([A-Z0-9-]{2,12})\s+(gene|protein|drug|pathway)\b/g)) {
      if (match.index === undefined) {
        continue;
      }
      addMention(match[1], match.index, match.index + match[1].length, [this.toEntityType(match[2])]);
    }

    for (const match of query.matchAll(/\b(gene|protein|drug|pathway)\s+([A-Z0-9-]{2,12}|[A-Za-z][A-Za-z0-9-]*)\b/gi)) {
      if (match.index === undefined) {
        continue;
      }
      const text = match[2];
      if (!/^[A-Z0-9]/.test(text) && !text.includes('-')) {
        continue;
      }
      const start = match.index + match[0].lastIndexOf(text);
      addMention(text, start, start + text.length, [this.toEntityType(match[1])]);
    }

    for (const match of query.matchAll(/\b([A-Z0-9-]{2,12})\b/g)) {
      if (match.index === undefined) {
        continue;
      }
      addMention(match[1], match.index, match.index + match[1].length, ['Gene', 'Protein']);
    }

    for (const match of query.matchAll(
      /\b([A-Za-z0-9'-]+(?:\s+[A-Za-z0-9'-]+){0,4}\s+(?:disease|syndrome|disorder|cancer|dementia|phenotype|guideline|pathway))\b/gi,
    )) {
      if (match.index === undefined) {
        continue;
      }
      addMention(match[1], match.index, match.index + match[1].length, this.inferTypeHints(match[1]));
    }

    for (const match of query.matchAll(/\b([A-Z][A-Za-z0-9'-]{1,}(?:\s+[A-Za-z0-9'-]+){0,3})\b/g)) {
      const text = match[1]?.trim();
      if (!text || match.index === undefined) {
        continue;
      }

      if (CAPTURED_PHRASE_STOPWORDS.has(text.toLowerCase())) {
        continue;
      }

      if (/^(?:what|how|which|show|give|expand|compare|find)$/i.test(text)) {
        continue;
      }

      addMention(text, match.index, match.index + text.length, this.inferTypeHints(text));
    }

    return mentions.sort((a, b) => a.span.start - b.span.start);
  }

  private extractConcepts(query: string, mentions: ExtractedMention[]): ExtractedConcept[] {
    const mentionRanges = mentions.map((mention) => `${mention.span.start}:${mention.span.end}`);
    const concepts: ExtractedConcept[] = [];
    const seen = new Set<string>();

    for (const { pattern, category } of CONCEPT_PATTERNS) {
      for (const match of query.matchAll(pattern)) {
        if (match.index === undefined) {
          continue;
        }

        const text = match[0].trim();
        const start = match.index;
        const end = start + text.length;
        const rangeKey = `${start}:${end}`;

        if (mentionRanges.includes(rangeKey)) {
          continue;
        }

        const key = `${rangeKey}:${category}:${text.toLowerCase()}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        concepts.push({
          text,
          span: { start, end },
          category,
          source: 'query',
        });
      }
    }

    return concepts.sort((a, b) => a.span.start - b.span.start);
  }

  private classifyIntent(query: string): QueryIntentClassification {
    const normalized = query.toLowerCase();
    const radiusMatch = normalized.match(/\bradius\s+of\s+(\d+)\b/);
    const radius = radiusMatch ? Number.parseInt(radiusMatch[1], 10) : undefined;
    const requestedEntityTypes = this.inferRequestedEntityTypes(normalized);

    if (normalized.includes('cypher') || normalized.includes('query language')) {
      return {
        primary: 'guarded-cypher',
        operation: 'guarded-cypher',
        requestedEntityTypes,
        allowContextFallback: false,
      };
    }

    if (normalized.includes('guideline')) {
      return {
        primary: 'guideline-search',
        operation: 'guideline-search',
        requestedEntityTypes: requestedEntityTypes.length > 0 ? requestedEntityTypes : ['Guideline'],
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
      normalized.includes('network including') ||
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

  private inferTypeHints(input: string) {
    const normalized = input.toLowerCase();
    const hints: string[] = [];

    if (normalized.includes('disease') || normalized.includes('syndrome') || normalized.includes('disorder') || normalized.includes('dementia') || normalized.includes('cancer')) {
      hints.push('Disease');
    }
    if (normalized.includes('gene')) {
      hints.push('Gene');
    }
    if (normalized.includes('protein')) {
      hints.push('Protein');
    }
    if (normalized.includes('pathway')) {
      hints.push('Pathway');
    }
    if (normalized.includes('drug')) {
      hints.push('Drug');
    }
    if (normalized.includes('guideline')) {
      hints.push('Guideline');
    }
    if (normalized.includes('phenotype')) {
      hints.push('Phenotype');
    }

    return hints;
  }

  private toEntityType(value: string) {
    const normalized = value.toLowerCase();
    if (normalized === 'gene') return 'Gene';
    if (normalized === 'protein') return 'Protein';
    if (normalized === 'drug') return 'Drug';
    return 'Pathway';
  }

  private normalizeCapturedPhrase(value: string) {
    return value
      .trim()
      .replace(/^[`"'([{]+|[`"')\]}!?.,;:]+$/g, '')
      .replace(/\s+/g, ' ')
      .replace(
        /^(?:a|an|the|this|that|these|those|various|current|all|new|also|of|for|to|in|on)\s+/i,
        '',
      )
      .replace(/\s+(?:please|also|too)$/i, '');
  }

  private shouldTreatAsConceptOnly(value: string) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return true;
    }

    if (/[A-Z]/.test(value) || /[0-9]/.test(value) || value.includes("'")) {
      return false;
    }

    return CONCEPT_PATTERNS.some(({ pattern }) => {
      pattern.lastIndex = 0;
      return pattern.test(normalized);
    });
  }

  private shouldDiscardMention(value: string) {
    return /^(?:what|how|which|does|do|show|give|expand|compare|find|tell|load|retrieve|approved|genes?|proteins?|pathways?|drugs?)\b/i.test(
      value,
    );
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
    if (/\bdisease\b|\bdementia\b|\balzheimer(?:'s)?\b|\bcancer\b|\bsyndrome\b|\bdisorder\b/.test(normalizedQuery)) {
      requestedEntityTypes.add('Disease');
    }

    return [...requestedEntityTypes];
  }
}
