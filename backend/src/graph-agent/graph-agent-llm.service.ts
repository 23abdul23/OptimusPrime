import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import {
  createProviderRegistry,
  generateObject,
  type ProviderRegistryProvider,
} from 'ai';
import { DEFAULT_MODEL, type ModelId } from '@/llm/model.constants';
import type { ZodType } from 'zod';

@Injectable()
export class GraphAgentLlmService {
  private readonly modelRegistry?: ProviderRegistryProvider<
    { openai: OpenAICompatibleProvider },
    ':'
  >;

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

  isAvailable() {
    return Boolean(this.modelRegistry);
  }

  async generateStructuredObject<T>(params: {
    schema: ZodType<T>;
    system: string;
    prompt: string;
    functionId: string;
    model?: ModelId;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<T | undefined> {
    if (!this.modelRegistry) {
      return undefined;
    }

    try {
      const { object } = await generateObject({
        model: this.modelRegistry.languageModel(params.model || DEFAULT_MODEL),
        schema: params.schema,
        system: params.system,
        prompt: params.prompt,
        temperature: params.temperature ?? 0.1,
        maxOutputTokens: params.maxOutputTokens ?? 900,
        experimental_telemetry: {
          isEnabled: true,
          functionId: params.functionId,
        },
      });

      return object;
    } catch {
      return undefined;
    }
  }
}
