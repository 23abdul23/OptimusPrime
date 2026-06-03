import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createProviderRegistry,
  type ProviderRegistryProvider,
  streamText,
} from 'ai';
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { DEFAULT_MODEL, type ModelId } from '@/llm/model.constants';
import type { GraphEvidenceBundle, ResolvedEntity } from './graph-agent.types';

@Injectable()
export class ResponseSynthesisService {
  private readonly modelRegistry?: ProviderRegistryProvider<{ openai: OpenAICompatibleProvider }, ':'>;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      return;
    }

    this.modelRegistry = createProviderRegistry({
      openai: createOpenAICompatible({
        name: 'openai',
        apiKey,
        baseURL: 'https://api.openai.com/v1',
      }),
    });
  }

  streamAnswer(params: {
    model?: ModelId;
    query: string;
    evidence: GraphEvidenceBundle;
    resolvedEntities: ResolvedEntity[];
  }) {
    if (!this.modelRegistry) {
      return null;
    }

    return streamText({
      model: this.modelRegistry.languageModel(params.model || DEFAULT_MODEL),
      system: [
        'You are the Optimus Explorer graph reasoning agent.',
        'Use only the provided graph evidence as the source of truth.',
        'Do not invent biomedical facts, entities, mechanisms, or relationships.',
        'Prioritize direct relations over shared neighbors, and shared neighbors over generic path evidence.',
        'Use node metadata and relationship provenance when available.',
        'If a mention could not be resolved or the evidence is weak, say that explicitly.',
        'Do not claim causality or mechanism unless it is directly supported by the retrieved evidence.',
        'If the evidence is insufficient, say so explicitly.',
        'Do not recite long exploratory node chains from a generic neighborhood unless they directly answer the question.',
        'Prefer concise, evidence-backed explanations that name the resolved entities, the strongest relation or path evidence, and the key provenance.',
        'Keep the answer concise, factual, and grounded in the retrieved entities, relations, and paths.',
      ].join(' '),
      messages: [
        {
          role: 'user',
          content: [
            `User question: ${params.query}`,
            `Resolved entities: ${this.serializeResolvedEntities(params.resolvedEntities)}`,
            `Plan: ${params.evidence.plan.map((step) => step.description).join(' | ') || 'none'}`,
            `Evidence summary:\n${this.serializeEvidence(params.evidence)}`,
            `Warnings: ${params.evidence.warnings.join(' | ') || 'none'}`,
          ].join('\n\n'),
        },
      ],
      temperature: 0.1,
      topP: 0.9,
      maxOutputTokens: 1200,
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'graph-agent-response-synthesis',
      },
    });
  }

  createFallbackAnswer(query: string, evidence: GraphEvidenceBundle) {
    if (evidence.items.length === 0) {
      return `I could not find enough graph-grounded evidence in OptimusKG to answer "${query}" confidently. ${evidence.warnings.join(' ')}`.trim();
    }

    const relations = evidence.items.filter((item) => item.kind === 'relation').slice(0, 2);
    const paths = evidence.items.filter((item) => item.kind === 'path').slice(0, 1);
    const entities = evidence.items.filter((item) => item.kind === 'entity').slice(0, 2);
    const detail = [...relations, ...paths, ...entities]
      .slice(0, 4)
      .map((item) => item.summary)
      .join(' ');
    const lead =
      relations.length > 0
        ? relations.map((item) => item.title).join('; ')
        : paths.length > 0
          ? paths.map((item) => item.title).join('; ')
          : evidence.items
              .slice(0, 3)
              .map((item) => item.title)
              .join(', ');

    const warningText = evidence.warnings.length > 0 ? ` Warnings: ${evidence.warnings.join(' ')}` : '';
    return `Graph-grounded summary for "${query}": ${lead}. ${detail}${warningText}`;
  }

  private serializeResolvedEntities(resolvedEntities: ResolvedEntity[]) {
    if (resolvedEntities.length === 0) {
      return 'none';
    }

    return resolvedEntities
      .map((entity) => {
        const matchSummary = entity.matchedOn.slice(0, 3).join(', ');
        return `${entity.displayName} [${entity.typeName}] confidence=${entity.confidence.toFixed(2)} matchedOn=${matchSummary || 'n/a'}`;
      })
      .join(' | ');
  }

  private serializeEvidence(evidence: GraphEvidenceBundle) {
    if (evidence.items.length === 0) {
      return 'No evidence items were retrieved.';
    }

    return evidence.items
      .slice(0, 8)
      .map((item, index) => {
        const metadata = this.serializeMetadata(item.metadata);
        return [
          `${index + 1}. [${item.kind}] ${item.title}`,
          `Summary: ${item.summary}`,
          metadata ? `Metadata: ${metadata}` : '',
        ]
          .filter((line) => line.length > 0)
          .join('\n');
      })
      .join('\n\n');
  }

  private serializeMetadata(metadata: Record<string, unknown> | undefined) {
    if (!metadata) {
      return '';
    }

    return Object.entries(metadata)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || Array.isArray(value))
      .slice(0, 6)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.slice(0, 5).join(', ') : String(value)}`)
      .join('; ');
  }
}
