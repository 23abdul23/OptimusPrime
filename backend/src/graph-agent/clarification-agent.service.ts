import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PendingClarificationState, ResolvedEntity } from './graph-agent.types';
import { GraphAgentLlmService } from './graph-agent-llm.service';
import type { ModelId } from '@/llm/model.constants';
import { GRAPH_AGENT_CLARIFICATION_SELECTION_SYSTEM_PROMPT } from '@/llm/system-prompts';

const CLARIFICATION_SELECTION_SCHEMA = z.object({
  mode: z.enum(['none', 'all', 'indices']),
  indices: z.array(z.number().int().min(1).max(8)).max(8),
});

@Injectable()
export class ClarificationAgentService {
  constructor(private readonly graphAgentLlmService: GraphAgentLlmService) {}

  async selectCandidates(params: {
    pendingClarification: PendingClarificationState;
    query: string;
    model?: ModelId;
  }): Promise<ResolvedEntity[]> {
    const deterministic = this.selectDeterministically(params.pendingClarification, params.query);
    if (deterministic.length > 0) {
      return deterministic;
    }

    const llmSelection = await this.graphAgentLlmService.generateStructuredObject({
      schema: CLARIFICATION_SELECTION_SCHEMA,
      model: params.model,
      functionId: 'graph-agent-clarification-selection',
      temperature: 0,
      maxOutputTokens: 250,
      system: GRAPH_AGENT_CLARIFICATION_SELECTION_SYSTEM_PROMPT,
      prompt: [
        `Original query: ${params.pendingClarification.originalQuery}`,
        `Unresolved mention: ${params.pendingClarification.unresolvedEntity}`,
        `User clarification reply: ${params.query}`,
        'Candidates:',
        ...params.pendingClarification.candidateEntities.map(
          (candidate, index) =>
            `${index + 1}. ${candidate.displayName} (${candidate.typeName})`,
        ),
      ].join('\n'),
    });

    if (!llmSelection) {
      return [];
    }

    if (llmSelection.mode === 'all') {
      return params.pendingClarification.candidateEntities;
    }

    if (llmSelection.mode === 'indices') {
      return Array.from(
        new Set(llmSelection.indices),
      )
        .map((index) => params.pendingClarification.candidateEntities[index - 1])
        .filter((candidate): candidate is ResolvedEntity => Boolean(candidate));
    }

    return [];
  }

  private selectDeterministically(
    pendingClarification: PendingClarificationState,
    query: string,
  ) {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    if (
      /^(all|all of them|use all|show everything|everything|all candidates|include all|all of those)$/i.test(
        normalizedQuery,
      )
    ) {
      return pendingClarification.candidateEntities;
    }

    const ordinalMatch =
      normalizedQuery.match(/\b(first|1st|one|1)\b/) ??
      normalizedQuery.match(/\b(second|2nd|two|2)\b/) ??
      normalizedQuery.match(/\b(third|3rd|three|3)\b/) ??
      normalizedQuery.match(/\b(fourth|4th|four|4)\b/);
    if (ordinalMatch) {
      const ordinalMap: Record<string, number> = {
        first: 0,
        '1st': 0,
        one: 0,
        '1': 0,
        second: 1,
        '2nd': 1,
        two: 1,
        '2': 1,
        third: 2,
        '3rd': 2,
        three: 2,
        '3': 2,
        fourth: 3,
        '4th': 3,
        four: 3,
        '4': 3,
      };
      const candidateIndex = ordinalMap[ordinalMatch[1].toLowerCase()];
      const candidate = pendingClarification.candidateEntities[candidateIndex];
      return candidate ? [candidate] : [];
    }

    if (/^(yes|yeah|yep|sure|ok|okay|go ahead)$/i.test(normalizedQuery)) {
      return pendingClarification.candidateEntities[0]
        ? [pendingClarification.candidateEntities[0]]
        : [];
    }

    return pendingClarification.candidateEntities.filter((candidate) =>
      this.matchesClarificationCandidate(candidate, normalizedQuery),
    );
  }

  private matchesClarificationCandidate(candidate: ResolvedEntity, normalizedQuery: string) {
    const candidateTerms = new Set<string>();
    candidateTerms.add(candidate.displayName.trim().toLowerCase());
    candidateTerms.add(candidate.query.trim().toLowerCase());
    candidate.matchedOn.forEach((term) => candidateTerms.add(term.trim().toLowerCase()));

    for (const term of candidateTerms) {
      if (!term) {
        continue;
      }

      if (term === normalizedQuery || term.includes(normalizedQuery) || normalizedQuery.includes(term)) {
        return true;
      }
    }

    return false;
  }
}
