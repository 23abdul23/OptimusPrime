import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type {
  GraphContextResult,
  QueryDecomposition,
  QueryRoute,
} from './graph-agent.types';
import { GraphAgentLlmService } from './graph-agent-llm.service';
import type { ModelId } from '@/llm/model.constants';
import { GRAPH_AGENT_QUERY_DECOMPOSITION_SYSTEM_PROMPT } from '@/llm/system-prompts';

const QUERY_DECOMPOSITION_SCHEMA = z.object({
  summary: z.string().trim().min(1).max(280),
  tasks: z.array(z.string().trim().min(1).max(120)).max(8),
  constraints: z.array(z.string().trim().min(1).max(80)).max(8),
  outputs: z.array(z.string().trim().min(1).max(40)).max(8),
  traversalHints: z.array(z.string().trim().min(1).max(60)).max(8),
  requiresMultiHop: z.boolean(),
});

@Injectable()
export class QueryDecompositionAgentService {
  constructor(private readonly graphAgentLlmService: GraphAgentLlmService) {}

  async decompose(params: {
    query: string;
    queryRoute: QueryRoute;
    graphContext: GraphContextResult;
    model?: ModelId;
  }): Promise<QueryDecomposition | undefined> {
    if (!this.shouldUseLlm(params.query, params.queryRoute)) {
      return undefined;
    }

    const result = await this.graphAgentLlmService.generateStructuredObject({
      schema: QUERY_DECOMPOSITION_SCHEMA,
      model: params.model,
      functionId: 'graph-agent-query-decomposition',
      temperature: 0,
      maxOutputTokens: 700,
      system: GRAPH_AGENT_QUERY_DECOMPOSITION_SYSTEM_PROMPT,
      prompt: [
        `Query: ${params.query}`,
        `Route category: ${params.queryRoute.category}`,
        `Route intent: ${params.queryRoute.intent}`,
        `Preferred executor: ${params.queryRoute.preferredExecutor}`,
        `Graph scope mode: ${params.graphContext.graphScope.mode}`,
        `Selected node types: ${params.graphContext.selectedNodeTypes.join(', ') || 'none'}`,
        `Selected edge types: ${params.graphContext.selectedEdgeTypes.join(', ') || 'none'}`,
      ].join('\n'),
    });

    if (!result) {
      return undefined;
    }

    return {
      ...result,
      source: 'llm',
    };
  }

  private shouldUseLlm(query: string, queryRoute: QueryRoute) {
    const normalized = query.trim().toLowerCase();
    const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
    const coordinationCount =
      (normalized.match(/\band\b/g)?.length ?? 0) +
      (normalized.match(/\bwith\b/g)?.length ?? 0) +
      (normalized.match(/\bthat\b/g)?.length ?? 0);
    const hasConstraintSignal =
      /\bfda-approved\b|\bapproved\b|\bshared\b|\bcommon\b|\bthrough which\b|\bmost affected\b|\bcompare\b|\bidentify\b|\bshow\b|\bfind\b/i.test(
        query,
      );
    const hasTraversalSignal =
      /\btarget\b|\bpathways?\b|\bproteins?\b|\bgenes?\b|\bdiseases?\b|\bbiological processes?\b|\bexposures?\b|\bshortest path\b/i.test(
        query,
      );

    return (
      tokens.length >= 10 ||
      coordinationCount >= 2 ||
      hasConstraintSignal ||
      (hasTraversalSignal && queryRoute.category !== 'GRAPH_QUERY')
    );
  }
}
