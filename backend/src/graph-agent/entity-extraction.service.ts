import { Injectable } from '@nestjs/common';
import type {
  ExtractedConcept,
  ExtractedMention,
  ExtractedQuery,
} from './graph-agent.types';

const CAPTURED_PHRASE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'for',
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

const SELECTION_REFERENCE_PATTERNS = [
  /\bthis node\b/gi,
  /\bthese nodes\b/gi,
  /\bthis gene\b/gi,
  /\bthis protein\b/gi,
  /\bthis disease\b/gi,
  /\bthis relationship\b/gi,
  /\bthis edge\b/gi,
  /\bthese genes\b/gi,
  /\bthese proteins\b/gi,
  /\bthese diseases\b/gi,
  /\bthese pathways\b/gi,
  /\bthese drugs\b/gi,
  /\bthese relationships\b/gi,
  /\bthese edges\b/gi,
  /\bthem\b/gi,
  /\bthose\b/gi,
  /\bselected nodes\b/gi,
  /\bselected edges\b/gi,
  /\bhighlighted nodes\b/gi,
  /\bhighlighted edges\b/gi,
  /\bcurrent graph\b/gi,
  /\bselected graph\b/gi,
];

const OPERATOR_SIGNAL_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /\bindicated\b/gi, signal: 'indicated' },
  { pattern: /\bapproved\b/gi, signal: 'approved' },
  { pattern: /\bassociated\b/gi, signal: 'associated' },
  { pattern: /\bcompare\b/gi, signal: 'compare' },
  { pattern: /\binvolved\b/gi, signal: 'involved' },
  { pattern: /\bparticipat(?:e|es)\b/gi, signal: 'participates' },
  { pattern: /\btarget(?:s)?\b/gi, signal: 'target' },
  { pattern: /\brelated\b/gi, signal: 'related' },
  { pattern: /\blinked\b/gi, signal: 'linked' },
  { pattern: /\bconnected\b/gi, signal: 'connected' },
  { pattern: /\bshared\b/gi, signal: 'shared' },
  { pattern: /\bcommon\b/gi, signal: 'common' },
  { pattern: /\ball\b/gi, signal: 'all' },
];

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
    pattern: /\bfor which diseases is\s+(.+?)\s+(?:indicated|approved|used)(?:\?|$)/i,
    typeHints: ['Drug'],
  },
  {
    pattern: /\bgenes?\s+(?:associated|related|linked)\s+(?:with|to)\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bgenes?\s+involved\s+in\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bwhich pathways?\s+(?:involve|include|contain)\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bwhat pathways?\s+do\s+(.+?)\s+participate\s+in(?:\?|$)/i,
  },
  {
    pattern: /\bpathways?\s+(?:associated|related|linked)\s+(?:with|to)\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bproteins?\s+associated\s+with\s+(.+?)(?:\?|$)/i,
  },
  {
    pattern: /\bwhich\s+(?:approved\s+)?drugs?\s+target\s+(.+?)(?:\?|$)/i,
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
  required: ['mentions', 'concepts'],
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
  },
} as const;

@Injectable()
export class EntityExtractionService {
  extractQuery(params: { query: string }): ExtractedQuery {
    const { query } = params;
    const mentions = this.extractMentions(query);
    const concepts = this.extractConcepts(query, mentions);
    const selectionReferences = this.extractSelectionReferences(query);
    const operatorSignals = this.extractOperatorSignals(query);

    return {
      query,
      mentions,
      concepts,
      selectionReferences,
      operatorSignals,
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

    for (const match of query.matchAll(/\b([A-Z][A-Za-z0-9'-]{2,})\b/g)) {
      const text = match[1]?.trim();
      if (!text || match.index === undefined) {
        continue;
      }

      const trailingPhrase = query.slice(match.index);
      if (
        /^[A-Z][A-Za-z0-9'-]{2,}(?:\s+[A-Za-z0-9'-]+){0,4}\s+(?:disease|syndrome|disorder|dementia|cancer|phenotype|guideline|pathway)\b/i.test(
          trailingPhrase,
        )
      ) {
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
    return /^(?:what|how|which|does|do|show|give|expand|compare|find|tell|load|retrieve|summariz(?:e|ing)|describe|explain|analy[sz]e|approved|genes?|proteins?|pathways?|drugs?|for|is|are|them|those|selected|highlighted|current|indicated|participat(?:e|es)|target(?:s)?|related|linked|connected|associated|involved)\b/i.test(
      value,
    );
  }

  private extractSelectionReferences(query: string) {
    const references = new Set<string>();

    for (const pattern of SELECTION_REFERENCE_PATTERNS) {
      for (const match of query.matchAll(pattern)) {
        references.add(match[0].toLowerCase());
      }
    }

    return [...references];
  }

  private extractOperatorSignals(query: string) {
    const signals = new Set<string>();

    for (const { pattern, signal } of OPERATOR_SIGNAL_PATTERNS) {
      if (pattern.test(query)) {
        signals.add(signal);
      }
      pattern.lastIndex = 0;
    }

    return [...signals];
  }

}
