import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ModelId } from '@/llm/model.constants';
import type {
  ExtractedConcept,
  ExtractedMention,
  ExtractedQuery,
  QueryDecomposition,
  QueryRoute,
} from './graph-agent.types';
import { GraphAgentLlmService } from './graph-agent-llm.service';

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

const HYBRID_EXTRACTION_SCHEMA = z.object({
  mentions: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(120),
        typeHints: z.array(z.string().trim().min(1).max(40)).max(4),
      }),
    )
    .max(8),
  concepts: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(120),
        category: z.enum([
          'disease-area',
          'biological-process',
          'therapeutic-area',
          'entity-class',
          'phenotype',
          'anatomy',
          'general',
        ]),
      }),
    )
    .max(8),
  constraints: z.array(z.string().trim().min(1).max(80)).max(8),
  requestedOutputs: z.array(z.string().trim().min(1).max(40)).max(8),
  operations: z.array(z.string().trim().min(1).max(80)).max(8),
});

@Injectable()
export class EntityExtractionService {
  constructor(private readonly graphAgentLlmService: GraphAgentLlmService) {}

  async extractQuery(params: {
    query: string;
    model?: ModelId;
    queryRoute?: QueryRoute;
    decomposition?: QueryDecomposition;
  }): Promise<ExtractedQuery> {
    const { query } = params;
    const baseMentions = this.extractMentions(query);
    const baseConcepts = this.extractConcepts(query, baseMentions);
    const selectionReferences = this.extractSelectionReferences(query);
    const operatorSignals = this.extractOperatorSignals(query);
    const llmRefinement =
      this.shouldUseLlmRefinement(query, params.queryRoute, params.decomposition) &&
      this.graphAgentLlmService.isAvailable()
        ? await this.graphAgentLlmService.generateStructuredObject({
            schema: HYBRID_EXTRACTION_SCHEMA,
            model: params.model,
            functionId: 'graph-agent-entity-extraction',
            temperature: 0,
            maxOutputTokens: 700,
            system: [
              'You extract explicit biomedical spans from the latest user query for a graph agent.',
              'Return only spans that appear verbatim in the query.',
              'Do not invent aliases, normalized entities, or graph facts.',
              'Put qualifiers such as FDA-approved, shared, shortest path, compare, or most affected into constraints.',
              'Put requested result classes such as drugs, proteins, pathways, diseases, phenotypes, or biological processes into requestedOutputs.',
            ].join(' '),
            prompt: [
              `Query: ${query}`,
              `Existing deterministic mentions: ${baseMentions.map((mention) => mention.text).join(', ') || 'none'}`,
              `Existing deterministic concepts: ${baseConcepts.map((concept) => concept.text).join(', ') || 'none'}`,
              `Existing decomposition summary: ${params.decomposition?.summary ?? 'none'}`,
            ].join('\n'),
          })
        : undefined;
    const mentions = this.mergeMentions(
      baseMentions,
      (llmRefinement?.mentions ?? [])
        .map((mention) => this.toMention(query, mention.text, mention.typeHints))
        .filter((mention): mention is ExtractedMention => Boolean(mention)),
    );
    const concepts = this.mergeConcepts(
      baseConcepts,
      (llmRefinement?.concepts ?? [])
        .map((concept) => this.toConcept(query, concept.text, concept.category))
        .filter((concept): concept is ExtractedConcept => Boolean(concept)),
    );
    const constraints = this.mergeStringLists(
      params.decomposition?.constraints ?? [],
      llmRefinement?.constraints ?? [],
    );
    const requestedOutputs = this.mergeStringLists(
      params.decomposition?.outputs ?? [],
      llmRefinement?.requestedOutputs ?? [],
    );
    const semanticOperations = this.mergeStringLists(
      params.decomposition?.tasks ?? [],
      llmRefinement?.operations ?? [],
    );

    return {
      query,
      mentions,
      concepts,
      selectionReferences,
      operatorSignals,
      constraints,
      requestedOutputs,
      semanticOperations,
      decomposition: params.decomposition,
      llmAssisted: Boolean(llmRefinement),
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

  private shouldUseLlmRefinement(
    query: string,
    queryRoute: QueryRoute | undefined,
    decomposition: QueryDecomposition | undefined,
  ) {
    const normalized = query.trim().toLowerCase();
    const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
    const hasConstraintSignal =
      /\bfda-approved\b|\bapproved\b|\bshared\b|\bcommon\b|\bmost affected\b|\bthrough which\b|\bcompare\b/i.test(
        query,
      );

    return (
      Boolean(decomposition) ||
      tokens.length >= 10 ||
      hasConstraintSignal ||
      queryRoute?.category === 'MIXED_QUERY' ||
      queryRoute?.category === 'GRAPH_DISCOVERY_QUERY'
    );
  }

  private toMention(query: string, text: string, typeHints: string[]) {
    const span = this.findSpan(query, text);
    if (!span || this.shouldDiscardMention(text.trim())) {
      return undefined;
    }

    return {
      text: text.trim(),
      span,
      typeHints: Array.from(new Set([...this.inferTypeHints(text), ...typeHints])),
      source: 'query' as const,
    };
  }

  private toConcept(
    query: string,
    text: string,
    category: ExtractedConcept['category'],
  ) {
    const span = this.findSpan(query, text);
    if (!span) {
      return undefined;
    }

    return {
      text: text.trim(),
      span,
      category,
      source: 'query' as const,
    };
  }

  private findSpan(query: string, text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const exactIndex = query.indexOf(trimmed);
    if (exactIndex >= 0) {
      return {
        start: exactIndex,
        end: exactIndex + trimmed.length,
      };
    }

    const caseInsensitiveIndex = query.toLowerCase().indexOf(trimmed.toLowerCase());
    if (caseInsensitiveIndex >= 0) {
      return {
        start: caseInsensitiveIndex,
        end: caseInsensitiveIndex + trimmed.length,
      };
    }

    return undefined;
  }

  private mergeMentions(primary: ExtractedMention[], secondary: ExtractedMention[]) {
    const merged = new Map<string, ExtractedMention>();

    for (const mention of [...primary, ...secondary]) {
      const key = `${mention.span.start}:${mention.span.end}:${mention.text.trim().toLowerCase()}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...mention,
          typeHints: Array.from(new Set(mention.typeHints)),
        });
        continue;
      }

      merged.set(key, {
        ...existing,
        typeHints: Array.from(new Set([...existing.typeHints, ...mention.typeHints])),
      });
    }

    return [...merged.values()].sort((a, b) => a.span.start - b.span.start);
  }

  private mergeConcepts(primary: ExtractedConcept[], secondary: ExtractedConcept[]) {
    const merged = new Map<string, ExtractedConcept>();

    for (const concept of [...primary, ...secondary]) {
      const key = `${concept.span.start}:${concept.span.end}:${concept.category}:${concept.text.trim().toLowerCase()}`;
      if (!merged.has(key)) {
        merged.set(key, concept);
      }
    }

    return [...merged.values()].sort((a, b) => a.span.start - b.span.start);
  }

  private mergeStringLists(...lists: string[][]) {
    return Array.from(
      new Set(
        lists
          .flat()
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    );
  }
}
