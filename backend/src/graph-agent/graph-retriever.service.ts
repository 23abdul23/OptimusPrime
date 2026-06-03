import { Injectable } from '@nestjs/common';
import neo4j, { type Node as Neo4jNode, type Relationship as Neo4jRelationship } from 'neo4j-driver';
import { Neo4jService } from '@/neo4j/neo4j.service';
import { OptimusKgService, type SerializedGraphPayload } from '@/optimuskg/optimuskg.service';
import type { GraphAction, GraphEvidenceItem, GraphToolResult, RetrievalPlanStep, ResolvedEntity } from './graph-agent.types';
import { compactRecord, serializeGraphFromRecords, toNumber } from './graph-agent.utils';

type CypherRow = Record<string, unknown>;

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
export class GraphRetrieverService {
  constructor(
    private readonly optimusKgService: OptimusKgService,
    private readonly neo4jService: Neo4jService,
  ) {}

  async executePlan(plan: RetrievalPlanStep[], resolvedEntities: ResolvedEntity[]): Promise<GraphToolResult> {
    const evidence: GraphEvidenceItem[] = [];
    const graphActions: GraphAction[] = [];
    let graphDelta: SerializedGraphPayload | undefined;
    const warnings: string[] = [];

    for (const step of plan) {
      switch (step.tool) {
        case 'shortestPath': {
          const result = await this.optimusKgService.shortestPath(
            String(step.params.sourceId),
            String(step.params.targetId),
            Number(step.params.maxDepth ?? 6),
          );

          graphDelta = result.graph;
          graphActions.push({
            id: step.id,
            type: 'load-subgraph',
            mode: 'merge',
            graph: result.graph,
            highlightNodeIds: result.graph.nodes.map((node) => node.key),
          });
          graphActions.push({
            id: `${step.id}-focus`,
            type: 'focus-nodes',
            nodeIds: result.graph.nodes.map((node) => node.key),
          });
          graphActions.push({
            id: `${step.id}-path`,
            type: 'highlight-path',
            nodeIds: result.graph.nodes.map((node) => node.key),
            edgeIds: result.graph.edges.map((edge) => edge.key),
          });

          if (!result.found) {
            warnings.push('No shortest path was found between the requested entities.');
            break;
          }

          evidence.push(this.graphToEvidence(step.id, 'path', 'Shortest path', result.graph, 0.95));
          break;
        }

        case 'getRelatedEntities': {
          if (Array.isArray(step.params.typeSequences)) {
            const traversed = await this.traverseTypedPaths(
              String(step.params.startId),
              step.params.typeSequences as string[][],
              Number(step.params.limit ?? 10),
            );

            if (!traversed) {
              warnings.push('No typed path chain matched the requested traversal.');
              break;
            }

            graphDelta = traversed.graph;
            graphActions.push({
              id: step.id,
              type: 'load-subgraph',
              mode: 'merge',
              graph: traversed.graph,
              highlightNodeIds: traversed.graph.nodes.map((node) => node.key),
            });
            graphActions.push({
              id: `${step.id}-focus`,
              type: 'focus-nodes',
              nodeIds: traversed.graph.nodes.map((node) => node.key),
            });
            evidence.push(
              ...traversed.items.map((item, index) => ({
                ...item,
                id: `${step.id}-${index}`,
              })),
            );
            break;
          }

          const related = await this.getRelatedEntities(
            String(step.params.nodeId),
            (step.params.nodeTypes as string[] | undefined) ?? [],
            Number(step.params.limit ?? 20),
          );

          if (related.items.length === 0) {
            warnings.push('No directly related entities matched the requested type filter.');
            break;
          }

          graphDelta = related.graph;
          graphActions.push({
            id: step.id,
            type: 'load-subgraph',
            mode: 'merge',
            graph: related.graph,
            highlightNodeIds: related.graph.nodes.map((node) => node.key),
          });
          graphActions.push({
            id: `${step.id}-focus`,
            type: 'focus-nodes',
            nodeIds: related.graph.nodes.map((node) => node.key),
          });
          evidence.push(...related.items);
          break;
        }

        case 'retrieveClinicalGuidelines': {
          const guidelines = await this.retrieveClinicalGuidelines(
            String(step.params.nodeId),
            Number(step.params.limit ?? 10),
          );

          if (guidelines.items.length === 0) {
            warnings.push('No clinical guideline nodes were found for the requested entity.');
            break;
          }

          graphDelta = guidelines.graph;
          graphActions.push({
            id: step.id,
            type: 'load-subgraph',
            mode: 'merge',
            graph: guidelines.graph,
            highlightNodeIds: guidelines.graph.nodes.map((node) => node.key),
          });
          graphActions.push({
            id: `${step.id}-focus`,
            type: 'focus-nodes',
            nodeIds: guidelines.graph.nodes.map((node) => node.key),
          });
          evidence.push(...guidelines.items);
          break;
        }

        case 'retrieveSubgraph': {
          const nodeId = step.params.nodeId ? String(step.params.nodeId) : resolvedEntities[0]?.id;
          if (!nodeId) {
            warnings.push('No anchor entity was available for subgraph retrieval.');
            break;
          }

          const graph = await this.optimusKgService.subgraph(
            nodeId,
            Number(step.params.radius ?? 1),
            Number(step.params.maxNodes ?? 80),
            Number(step.params.degreeLimit ?? 12),
          );

          graphDelta = graph;
          graphActions.push({
            id: step.id,
            type: 'load-subgraph',
            mode: 'merge',
            graph,
            highlightNodeIds: graph.nodes.map((node) => node.key).slice(0, 8),
          });
          graphActions.push({
            id: `${step.id}-focus`,
            type: 'focus-nodes',
            nodeIds: graph.nodes.map((node) => node.key),
          });
          evidence.push(this.graphToEvidence(step.id, 'relation', step.description, graph, 0.7));
          break;
        }

        case 'executeGuardedCypher': {
          const userQuery = String(step.params.userQuery ?? '');
          const cypher =
            userQuery.match(/```cypher\s*([\s\S]+?)```/i)?.[1]?.trim() ??
            userQuery.match(/`([^`]+)`/)?.[1]?.trim() ??
            '';

          if (!cypher) {
            warnings.push('No explicit Cypher query was provided in the request.');
            break;
          }

          const rows = await this.executeGuardedCypher(cypher);
          evidence.push({
            id: step.id,
            kind: 'query',
            title: 'Guarded Cypher result',
            summary: `Returned ${rows.length} row(s) from the validated Cypher query.`,
            score: 0.6,
            nodeIds: [],
            edgeIds: [],
            metadata: { rows },
          });
          break;
        }

        default:
          warnings.push(`Graph retrieval step "${step.tool}" is not implemented.`);
          break;
      }
    }

    return {
      evidence,
      graphDelta,
      graphActions,
      citations: [],
      confidence: evidence.length > 0 ? Math.max(...evidence.map((item) => item.score)) : 0,
      truncated: evidence.length > 12,
      warnings,
    };
  }

  async executeGuardedCypher(query: string) {
    for (const pattern of UNSAFE_CYPHER_PATTERNS) {
      if (pattern.test(query)) {
        throw new Error('Unsafe Cypher query rejected by graph-agent guardrails.');
      }
    }

    const trimmed = query.trim();
    if (!/^(match|optional match|with|call|unwind|return)\b/i.test(trimmed)) {
      throw new Error('Only read-only Cypher queries are allowed.');
    }

    const limitedQuery = /\blimit\b/i.test(trimmed) ? trimmed : `${trimmed}\nLIMIT 25`;
    const session = this.neo4jService.getSession();

    try {
      const result = await session.run(limitedQuery, {});
      return result.records.map((record) =>
        record.keys.reduce<CypherRow>((acc, key) => {
          acc[String(key)] = record.get(key);
          return acc;
        }, {}),
      );
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private async getRelatedEntities(nodeId: string, nodeTypes: string[], limit: number) {
    const session = this.neo4jService.getSession();

    try {
      const result = await session.run(
        `
          MATCH (start:Entity {id: $nodeId})-[rel]-(neighbor:Entity)
          WHERE size($nodeTypes) = 0 OR neighbor.typeName IN $nodeTypes OR neighbor.typeCode IN $nodeTypes
          RETURN start, rel, neighbor
          ORDER BY coalesce(rel.score, 0) DESC, neighbor.displayName
          LIMIT $limit
        `,
        { nodeId, nodeTypes, limit: neo4j.int(Math.max(1, Math.trunc(toNumber(limit)))) },
      );

      const nodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];
      const items: GraphEvidenceItem[] = [];

      for (const record of result.records) {
        const start = record.get('start') as Neo4jNode;
        const neighbor = record.get('neighbor') as Neo4jNode;
        const relationship = record.get('rel') as Neo4jRelationship;
        nodes.push(start, neighbor);
        relationships.push(relationship);
        items.push({
          id: String(relationship.properties.edgeKey ?? relationship.elementId),
          kind: 'relation',
          title: `${String(start.properties.displayName)} -> ${String(neighbor.properties.displayName)}`,
          summary: `${relationship.type} between ${String(start.properties.displayName)} and ${String(neighbor.properties.displayName)}.`,
          score: Number(relationship.properties.score ?? 0.75),
          nodeIds: [String(start.properties.id), String(neighbor.properties.id)],
          edgeIds: [String(relationship.properties.edgeKey ?? relationship.elementId)],
          metadata: compactRecord({
            relation: relationship.type,
            details: relationship.properties,
          }),
        });
      }

      return {
        graph: serializeGraphFromRecords(nodes, relationships, {
          centerNodeId: nodeId,
          retrieval: 'related-entities',
        }),
        items,
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private async retrieveClinicalGuidelines(nodeId: string, limit: number) {
    return this.getRelatedEntities(nodeId, ['Clinical Guideline', 'Guideline'], limit);
  }

  private async traverseTypedPaths(startId: string, typeSequences: string[][], limit: number) {
    for (const sequence of typeSequences) {
      const result = await this.runTypedPathQuery(startId, sequence, limit);
      if (result.items.length > 0) {
        return result;
      }
    }

    return null;
  }

  private async runTypedPathQuery(startId: string, sequence: string[], limit: number) {
    const session = this.neo4jService.getSession();
    const nodeVars = ['n0', ...sequence.map((_, index) => `n${index + 1}`)];
    const relationshipVars = sequence.map((_, index) => `r${index + 1}`);
    const matchPath = sequence
      .map((_, index) => `-[${relationshipVars[index]}]-(${nodeVars[index + 1]}:Entity)`)
      .join('');
    const whereClause = sequence.map((_, index) => `${nodeVars[index + 1]}.typeName IN $type${index + 1}`).join(' AND ');

    try {
      const result = await session.run(
        `
          MATCH (${nodeVars[0]}:Entity {id: $startId})${matchPath}
          WHERE ${whereClause}
          RETURN [${nodeVars.join(', ')}] AS nodes, [${relationshipVars.join(', ')}] AS relationships
          LIMIT $limit
        `,
        sequence.reduce<Record<string, unknown>>(
          (acc, typeName, index) => {
            acc[`type${index + 1}`] = [typeName];
            return acc;
          },
          { startId, limit: neo4j.int(Math.max(1, Math.trunc(toNumber(limit)))) },
        ),
      );

      const items: GraphEvidenceItem[] = [];
      const nodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];

      for (const [index, record] of result.records.entries()) {
        const pathNodes = record.get('nodes') as Neo4jNode[];
        const pathRelationships = record.get('relationships') as Neo4jRelationship[];
        nodes.push(...pathNodes);
        relationships.push(...pathRelationships);

        items.push({
          id: `typed-path-${index}`,
          kind: 'path',
          title: pathNodes.map((node) => String(node.properties.displayName)).join(' -> '),
          summary: pathRelationships.map((relationship) => relationship.type).join(' -> '),
          score: 0.9 - index * 0.05,
          nodeIds: pathNodes.map((node) => String(node.properties.id)),
          edgeIds: pathRelationships.map((relationship) => String(relationship.properties.edgeKey ?? relationship.elementId)),
          metadata: {
            typeSequence: sequence,
          },
        });
      }

      return {
        graph: serializeGraphFromRecords(nodes, relationships, {
          startId,
          retrieval: 'typed-path',
          typeSequence: sequence,
        }),
        items,
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private graphToEvidence(
    id: string,
    kind: GraphEvidenceItem['kind'],
    title: string,
    graph: SerializedGraphPayload,
    score: number,
  ): GraphEvidenceItem {
    const nodeLabels = graph.nodes.map((node) => String(node.attributes.label ?? node.key));
    return {
      id,
      kind,
      title,
      summary: nodeLabels.join(' -> '),
      score,
      nodeIds: graph.nodes.map((node) => node.key),
      edgeIds: graph.edges.map((edge) => edge.key),
      metadata: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
      },
    };
  }
}
