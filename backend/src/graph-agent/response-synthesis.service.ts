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
        'If the evidence is insufficient, say so explicitly.',
        'Keep the answer concise, factual, and grounded in the retrieved entities, relations, and paths.',
      ].join(' '),
      messages: [
        {
          role: 'user',
          content: [
            `User question: ${params.query}`,
            `Resolved entities: ${params.resolvedEntities.map((entity) => `${entity.displayName} [${entity.typeName}]`).join(', ') || 'none'}`,
            `Plan: ${params.evidence.plan.map((step) => step.description).join(' | ') || 'none'}`,
            `Evidence JSON: ${JSON.stringify(params.evidence.items)}`,
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
      return `I could not find enough graph evidence in OptimusKG to answer "${query}" confidently.`;
    }

    const lead = evidence.items.slice(0, 5).map((item) => item.title).join(', ');
    const detail = evidence.items
      .slice(0, 3)
      .map((item) => item.summary)
      .join(' ');

    const warningText = evidence.warnings.length > 0 ? ` Warnings: ${evidence.warnings.join(' ')}` : '';
    return `Graph-grounded summary for "${query}": ${lead}. ${detail}${warningText}`;
  }
}
