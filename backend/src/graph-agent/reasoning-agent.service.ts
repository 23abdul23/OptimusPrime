import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createProviderRegistry,
  type ProviderRegistryProvider,
  streamText,
} from 'ai';
import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { DEFAULT_MODEL, type ModelId } from '@/llm/model.constants';
import { GRAPH_AGENT_REASONING_SYSTEM_PROMPT } from '@/llm/system-prompts';
import type {
  GraphAction,
  GraphContextResult,
  GraphEvidenceBundle,
  GraphInterpretation,
  ResolvedEntity,
} from './graph-agent.types';

@Injectable()
export class ReasoningAgentService {
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
    graphContext: GraphContextResult;
    graphActions: GraphAction[];
    graphInterpretation?: GraphInterpretation;
  }) {
    if (!this.modelRegistry) {
      return null;
    }

    return streamText({
      model: this.modelRegistry.languageModel(params.model || DEFAULT_MODEL),
      system: GRAPH_AGENT_REASONING_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            `User question: ${params.query}`,
            `Resolved entities: ${this.serializeResolvedEntities(params.resolvedEntities)}`,
            `Graph context: ${this.serializeGraphContext(params.graphContext)}`,
            `Graph interpretation: ${this.serializeGraphInterpretation(params.graphInterpretation)}`,
            `Plan: ${params.evidence.plan.map((step) => `${step.operation}: ${step.description}`).join(' | ') || 'none'}`,
            `Evidence assessment: ${params.evidence.assessment.rationale}`,
            `Provenance highlights: ${params.evidence.provenanceHighlights.join(' | ') || 'none'}`,
            `Graph actions: ${params.graphActions.map((action) => action.type).join(' | ') || 'none'}`,
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
        functionId: 'graph-agent-reasoning-agent',
      },
    });
  }

  createFallbackAnswer(query: string, evidence: GraphEvidenceBundle) {
    const confidenceFrame = `${evidence.confidenceLabel.toUpperCase()} confidence (${(evidence.confidence * 100).toFixed(0)}%).`;

    if (evidence.items.length === 0) {
      return `${confidenceFrame} I could not find enough graph-grounded evidence in OptimusKG to answer "${query}" confidently. ${evidence.warnings.join(' ')}`.trim();
    }

    const isGraphSummary = evidence.plan.some((step) =>
      ['summarize-selected-nodes', 'summarize-visible-subgraph'].includes(step.operation),
    );
    const graphSummaryItem = evidence.items.find(
      (item) =>
        item.kind === 'query' &&
        typeof item.metadata?.graphShape === 'string' &&
        typeof item.summary === 'string' &&
        item.summary.includes('Graph Overview:'),
    );
    if (isGraphSummary && graphSummaryItem) {
      const warningText = evidence.warnings.length > 0 ? `\n\nWarnings: ${evidence.warnings.join(' ')}` : '';
      const provenanceText =
        evidence.provenanceHighlights.length > 0
          ? `\n\nProvenance: ${evidence.provenanceHighlights.slice(0, 4).join(', ')}.`
          : '';
      return `${graphSummaryItem.summary}\n\nConfidence: ${confidenceFrame}.${provenanceText}${warningText}`.trim();
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
    const provenanceText =
      evidence.provenanceHighlights.length > 0
        ? ` Provenance: ${evidence.provenanceHighlights.slice(0, 4).join(', ')}.`
        : '';
    const warningText = evidence.warnings.length > 0 ? ` Warnings: ${evidence.warnings.join(' ')}` : '';
    return `${confidenceFrame} Graph-grounded summary for "${query}": ${lead}. ${detail}${provenanceText}${warningText}`.trim();
  }

  private serializeResolvedEntities(resolvedEntities: ResolvedEntity[]) {
    if (resolvedEntities.length === 0) {
      return 'none';
    }

    return resolvedEntities
      .map((entity) => {
        const matchSummary = entity.matchedOn.slice(0, 3).join(', ');
        const stage = entity.resolutionStage ?? 'unknown';
        return `${entity.displayName} [${entity.typeName}] confidence=${entity.confidence.toFixed(2)} stage=${stage} matchedOn=${matchSummary || 'n/a'}`;
      })
      .join(' | ');
  }

  private serializeGraphContext(graphContext: GraphContextResult) {
    return [
      `scope=${graphContext.graphScope.mode}`,
      `selectedNodes=${graphContext.graphScope.selectedNodeCount}`,
      `selectedEdges=${graphContext.graphScope.selectedEdgeCount}`,
      `selectedNodeTypes=${graphContext.selectedNodeTypes.join(', ') || 'none'}`,
      `selectedEdgeTypes=${graphContext.selectedEdgeTypes.join(', ') || 'none'}`,
    ].join(' | ');
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

  private serializeGraphInterpretation(graphInterpretation: GraphInterpretation | undefined) {
    if (!graphInterpretation) {
      return 'none';
    }

    return [
      `theme=${graphInterpretation.theme}`,
      `networkType=${graphInterpretation.networkType}`,
      `dominantConcepts=${graphInterpretation.dominantConcepts.join(', ') || 'none'}`,
      `dominantRelationships=${graphInterpretation.dominantRelationships.join(', ') || 'none'}`,
      `summary=${graphInterpretation.summary}`,
    ].join(' | ');
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
