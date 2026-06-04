import { Injectable } from '@nestjs/common';
import type { Record as Neo4jRecord } from 'neo4j-driver';
import { Neo4jService } from '@/neo4j/neo4j.service';

export type CypherRow = Record<string, unknown>;

const UNSAFE_CYPHER_PATTERNS = [
  /\bcreate\b/i,
  /\bmerge\b/i,
  /\bdelete\b/i,
  /\bdetach\b/i,
  /\bset\b/i,
  /\bremove\b/i,
  /\bdrop\b/i,
  /\bload\s+csv\b/i,
  /\bapoc\./i,
  /;/,
];

@Injectable()
export class CypherAgentService {
  constructor(private readonly neo4jService: Neo4jService) {}

  extractExplicitCypher(userQuery: string) {
    return (
      userQuery.match(/```cypher\s*([\s\S]+?)```/i)?.[1]?.trim() ??
      userQuery.match(/`([^`]+)`/)?.[1]?.trim() ??
      ''
    );
  }

  estimateCost(query: string) {
    const normalized = query.toLowerCase();
    const usesVariableLength = /-\[[^\]]*\*\d*\.\.?\d*\]-/.test(normalized) || /shortestpath\s*\(/i.test(normalized);
    const hasCall = /\bcall\b/i.test(normalized);
    const hasAggregation = /\bcollect\b|\breduce\b|\bcount\b|\bsum\b/i.test(normalized);
    const hasLimit = /\blimit\b/i.test(normalized);
    const complexityScore =
      (usesVariableLength ? 2 : 0) + (hasCall ? 2 : 0) + (hasAggregation ? 1 : 0) + (hasLimit ? 0 : 1);

    return {
      usesVariableLength,
      hasCall,
      hasAggregation,
      hasLimit,
      complexity: complexityScore >= 4 ? 'high' : complexityScore >= 2 ? 'medium' : 'low',
    } as const;
  }

  validateReadOnlyCypher(query: string) {
    for (const pattern of UNSAFE_CYPHER_PATTERNS) {
      if (pattern.test(query)) {
        throw new Error('Unsafe Cypher query rejected by graph-agent guardrails.');
      }
    }

    const trimmed = query.trim();
    if (!/^(match|optional match|with|call|unwind|return)\b/i.test(trimmed)) {
      throw new Error('Only read-only Cypher queries are allowed.');
    }

    return trimmed;
  }

  async executeGuardedCypher(query: string, params: Record<string, unknown> = {}, defaultLimit?: number) {
    const trimmed = this.validateReadOnlyCypher(query);
    const cost = this.estimateCost(trimmed);
    const limitedQuery =
      defaultLimit && !/\blimit\b/i.test(trimmed) ? `${trimmed}\nLIMIT ${defaultLimit}` : trimmed;
    const session = this.neo4jService.getSession();

    try {
      const result = await session.run(limitedQuery, params);
      return {
        rows: result.records.map((record) => this.recordToRow(record)),
        cost,
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  async executeTemplate(query: string, params: Record<string, unknown>) {
    const validated = this.validateReadOnlyCypher(query);
    const session = this.neo4jService.getSession();

    try {
      const result = await session.run(validated, params);
      return result.records;
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private recordToRow(record: Neo4jRecord): CypherRow {
    return record.keys.reduce<CypherRow>((acc, key) => {
      acc[String(key)] = record.get(key);
      return acc;
    }, {});
  }
}
