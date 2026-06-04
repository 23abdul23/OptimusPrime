import { Injectable } from '@nestjs/common';
import neo4j, { type Node as Neo4jNode, type Relationship as Neo4jRelationship } from 'neo4j-driver';
import { Neo4jService } from '@/neo4j/neo4j.service';
import { OptimusKgService, type SerializedGraphPayload } from '@/optimuskg/optimuskg.service';
import type { GraphAction, GraphEvidenceItem, GraphToolResult, RetrievalPlanStep, ResolvedEntity } from './graph-agent.types';
import { compactRecord, parseJsonRecord, parseStringArray, serializeGraphFromRecords, toNumber } from './graph-agent.utils';
import { GraphAnalysisService } from './graph-analysis.service';

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
    private readonly graphAnalysisService: GraphAnalysisService,
  ) {}

  async executePlan(plan: RetrievalPlanStep[], resolvedEntities: ResolvedEntity[]): Promise<GraphToolResult> {
    const evidence: GraphEvidenceItem[] = [];
    const graphActions: GraphAction[] = [];
    let graphDelta: SerializedGraphPayload | undefined;
    const warnings: string[] = [];

    for (const step of plan) {
      switch (step.tool) {
        case 'summarizeNodes': {
          const result = await this.graphAnalysisService.summarizeNodes((step.params.nodeIds as string[] | undefined) ?? []);
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'summarizeSubgraph': {
          const result = await this.graphAnalysisService.summarizeSubgraph(
            (step.params.nodeIds as string[] | undefined) ?? [],
            (step.params.edgeIds as string[] | undefined) ?? [],
          );
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'compareNodes': {
          const result = await this.graphAnalysisService.compareNodes((step.params.nodeIds as string[] | undefined) ?? []);
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'findSharedPathways': {
          const result = await this.graphAnalysisService.findSharedPathways(
            (step.params.nodeIds as string[] | undefined) ?? [],
            Number(step.params.minSupport ?? 2),
            Number(step.params.limit ?? 20),
          );
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'findSharedDiseases': {
          const result = await this.graphAnalysisService.findSharedDiseases(
            (step.params.nodeIds as string[] | undefined) ?? [],
            Number(step.params.minSupport ?? 2),
            Number(step.params.limit ?? 20),
          );
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'findSharedGenes': {
          const result = await this.graphAnalysisService.findSharedGenes(
            (step.params.nodeIds as string[] | undefined) ?? [],
            Number(step.params.minSupport ?? 2),
            Number(step.params.limit ?? 20),
          );
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'findCommonNeighbors': {
          const result = await this.graphAnalysisService.findCommonNeighbors(
            (step.params.nodeIds as string[] | undefined) ?? [],
            (step.params.targetTypes as string[] | undefined) ?? [],
            Number(step.params.minSupport ?? 2),
            Number(step.params.limit ?? 20),
          );
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'findHubNodes': {
          const result = await this.graphAnalysisService.findHubNodes((step.params.nodeIds as string[] | undefined) ?? []);
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'findBridgingNodes': {
          const result = await this.graphAnalysisService.findBridgingNodes((step.params.nodeIds as string[] | undefined) ?? []);
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'explainConnections': {
          const result = await this.graphAnalysisService.explainConnections(
            (step.params.nodeIds as string[] | undefined) ?? [],
            Number(step.params.maxDepth ?? 5),
          );
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          if (result.graph && result.graph.nodes.length > 1 && result.graph.edges.length > 0) {
            graphActions.push({
              id: `${step.id}-path`,
              type: 'highlight-path',
              nodeIds: result.graph.nodes.map((node) => node.key),
              edgeIds: result.graph.edges.map((edge) => edge.key),
            });
          }
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'analyzeCluster': {
          const result = await this.graphAnalysisService.analyzeCluster((step.params.nodeIds as string[] | undefined) ?? []);
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          break;
        }

        case 'getNodeDetails': {
          const details = await this.getNodeDetails((step.params.nodeIds as string[] | undefined) ?? []);
          evidence.push(...details.items);
          break;
        }

        case 'retrieveEvidence': {
          const result = await this.retrieveEvidenceBetweenNodes(
            String(step.params.sourceId),
            String(step.params.targetId),
            (step.params.commonNeighborTypes as string[] | undefined) ?? [],
            Number(step.params.limit ?? 8),
          );

          if (result.items.length === 0) {
            warnings.push('No direct relationships or shared-neighbor evidence was found for the requested entities.');
            break;
          }

          graphDelta = result.graph;
          graphActions.push({
            id: step.id,
            type: 'load-subgraph',
            mode: 'merge',
            graph: result.graph,
            highlightNodeIds: result.highlightNodeIds,
          });
          graphActions.push({
            id: `${step.id}-focus`,
            type: 'focus-nodes',
            nodeIds: result.highlightNodeIds,
          });
          evidence.push(...result.items);
          break;
        }

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

          const relatedNodeIds = Array.isArray(step.params.nodeIds)
            ? (step.params.nodeIds as string[]).map((nodeId) => String(nodeId)).filter((nodeId) => nodeId.length > 0)
            : [];
          const related = relatedNodeIds.length > 1
              ? await this.getRelatedEntitiesForNodeSet(
                  relatedNodeIds,
                  (step.params.nodeTypes as string[] | undefined) ?? [],
                  (step.params.relationshipTypes as string[] | undefined) ?? [],
                  String(step.params.aggregateMode ?? 'union') === 'shared' ? 'shared' : 'union',
                  Number(step.params.minSupport ?? 1),
                  Number(step.params.limit ?? 20),
                )
            : await this.getRelatedEntities(
                String(step.params.nodeId ?? relatedNodeIds[0]),
                (step.params.nodeTypes as string[] | undefined) ?? [],
                (step.params.relationshipTypes as string[] | undefined) ?? [],
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
            (step.params.relationshipTypes as string[] | undefined) ?? [],
            (step.params.nodeTypes as string[] | undefined) ?? [],
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

        case 'expandSubgraph': {
          const nodeIds = (step.params.nodeIds as string[] | undefined) ?? [];
          if (nodeIds.length === 0) {
            warnings.push('No seed nodes were available for graph expansion.');
            break;
          }

          const graph = await this.optimusKgService.expandSubgraph(
            nodeIds,
            Number(step.params.hops ?? 1),
            Number(step.params.maxNodes ?? 160),
            Number(step.params.degreeLimit ?? 24),
            (step.params.relationshipTypes as string[] | undefined) ?? [],
            (step.params.nodeTypes as string[] | undefined) ?? [],
          );

          graphDelta = graph;
          graphActions.push({
            id: step.id,
            type: 'load-subgraph',
            mode: 'merge',
            graph,
            highlightNodeIds: graph.nodes.map((node) => node.key).slice(0, 16),
          });
          graphActions.push({
            id: `${step.id}-focus`,
            type: 'focus-nodes',
            nodeIds: graph.nodes.map((node) => node.key).slice(0, 16),
          });
          evidence.push(this.graphToEvidence(step.id, 'relation', step.description, graph, 0.82));
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

  private async getNodeDetails(nodeIds: string[]) {
    const items: GraphEvidenceItem[] = [];

    for (const nodeId of Array.from(new Set(nodeIds.filter((value) => value.trim().length > 0))).slice(0, 6)) {
      try {
        const node = await this.optimusKgService.nodeDetails(nodeId);
        const aliases = parseStringArray(node.properties.searchTerms).slice(0, 5);
        const sourceIds = parseStringArray(node.properties.sourceIds).slice(0, 5);
        const sourceNames = parseStringArray(node.properties.sourceNames).slice(0, 5);
        const description =
          typeof node.properties.description === 'string'
            ? node.properties.description
            : `${node.displayName} is represented in OptimusKG as a ${node.typeName} node.`;
        const summaryParts = [description];
        if (aliases.length > 0) {
          summaryParts.push(`Aliases: ${aliases.join(', ')}.`);
        }
        if (sourceNames.length > 0 || sourceIds.length > 0) {
          summaryParts.push(
            `Sources: ${[...sourceNames, ...sourceIds].slice(0, 5).join(', ')}.`,
          );
        }

        items.push({
          id: `entity-${node.id}`,
          kind: 'entity',
          title: `${node.displayName} (${node.typeName})`,
          summary: summaryParts.join(' '),
          score: 0.72,
          nodeIds: [node.id],
          edgeIds: [],
          metadata: compactRecord({
            typeCode: node.typeCode,
            typeName: node.typeName,
            degree: node.degree,
            aliases,
            sourceIds,
            sourceNames,
          }),
        });
      } catch {
        // Ignore missing node details; resolution already filtered candidates.
      }
    }

    return { items };
  }

  private async retrieveEvidenceBetweenNodes(
    sourceId: string,
    targetId: string,
    commonNeighborTypes: string[],
    limit: number,
  ) {
    const session = this.neo4jService.getSession();
    const boundedLimit = neo4j.int(Math.max(1, Math.trunc(toNumber(limit))));

    try {
      const directResult = await session.run(
        `
          MATCH (source:Entity {id: $sourceId})-[rel]-(target:Entity {id: $targetId})
          RETURN source, rel, target
          ORDER BY coalesce(rel.score, 0) DESC, type(rel)
          LIMIT $limit
        `,
        { sourceId, targetId, limit: boundedLimit },
      );

      const commonNeighborResult = await session.run(
        `
          MATCH (source:Entity {id: $sourceId})-[r1]-(neighbor:Entity)-[r2]-(target:Entity {id: $targetId})
          WHERE neighbor.id <> $sourceId
            AND neighbor.id <> $targetId
            AND (size($commonNeighborTypes) = 0 OR neighbor.typeName IN $commonNeighborTypes OR neighbor.typeCode IN $commonNeighborTypes)
          RETURN source, r1, neighbor, r2, target, coalesce(r1.score, 0) + coalesce(r2.score, 0) AS combinedScore
          ORDER BY combinedScore DESC, neighbor.displayName
          LIMIT $limit
        `,
        {
          sourceId,
          targetId,
          commonNeighborTypes,
          limit: boundedLimit,
        },
      );

      const nodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];
      const items: GraphEvidenceItem[] = [];
      const highlightNodeIds = new Set<string>([sourceId, targetId]);

      for (const record of directResult.records) {
        const source = record.get('source') as Neo4jNode;
        const target = record.get('target') as Neo4jNode;
        const relationship = record.get('rel') as Neo4jRelationship;
        const relProps = relationship.properties as Record<string, unknown>;
        const provenance = [...parseStringArray(relProps.sourceDirect), ...parseStringArray(relProps.sourceIndirect)];
        const relationDetails = parseJsonRecord(relProps.propertiesJson);

        nodes.push(source, target);
        relationships.push(relationship);
        items.push({
          id: String(relProps.edgeKey ?? relationship.elementId),
          kind: 'relation',
          title: `${String(source.properties.displayName)} ${relationship.type} ${String(target.properties.displayName)}`,
          summary: this.buildRelationSummary(
            String(source.properties.displayName),
            relationship.type,
            String(target.properties.displayName),
            provenance,
            relationDetails,
          ),
          score: Math.min(0.99, 0.86 + Number(relProps.score ?? 0) * 0.1),
          nodeIds: [String(source.properties.id), String(target.properties.id)],
          edgeIds: [String(relProps.edgeKey ?? relationship.elementId)],
          metadata: compactRecord({
            relation: relationship.type,
            confidence: relProps.score,
            provenance: provenance.slice(0, 6),
            details: relationDetails,
          }),
        });
      }

      for (const [index, record] of commonNeighborResult.records.entries()) {
        const source = record.get('source') as Neo4jNode;
        const target = record.get('target') as Neo4jNode;
        const neighbor = record.get('neighbor') as Neo4jNode;
        const left = record.get('r1') as Neo4jRelationship;
        const right = record.get('r2') as Neo4jRelationship;
        const combinedScore = toNumber(record.get('combinedScore'));
        const leftProps = left.properties as Record<string, unknown>;
        const rightProps = right.properties as Record<string, unknown>;
        const neighborDescription =
          typeof neighbor.properties.description === 'string' ? String(neighbor.properties.description) : undefined;

        nodes.push(source, target, neighbor);
        relationships.push(left, right);
        highlightNodeIds.add(String(neighbor.properties.id));

        items.push({
          id: `shared-neighbor-${index}-${String(neighbor.properties.id)}`,
          kind: 'path',
          title: `Shared connector: ${String(neighbor.properties.displayName)}`,
          summary: [
            `${String(source.properties.displayName)} and ${String(target.properties.displayName)} are both connected to ${String(neighbor.properties.displayName)}.`,
            `Relations: ${left.type} and ${right.type}.`,
            neighborDescription ? `Neighbor description: ${neighborDescription}` : '',
          ]
            .filter((part) => part.length > 0)
            .join(' '),
          score: Math.min(0.92, 0.68 + combinedScore * 0.12),
          nodeIds: [
            String(source.properties.id),
            String(neighbor.properties.id),
            String(target.properties.id),
          ],
          edgeIds: [
            String(leftProps.edgeKey ?? left.elementId),
            String(rightProps.edgeKey ?? right.elementId),
          ],
          metadata: compactRecord({
            sharedNeighborType: String(neighbor.properties.typeName ?? neighbor.properties.typeCode ?? 'Entity'),
            leftRelation: left.type,
            rightRelation: right.type,
            combinedScore,
            provenance: [
              ...parseStringArray(leftProps.sourceDirect),
              ...parseStringArray(leftProps.sourceIndirect),
              ...parseStringArray(rightProps.sourceDirect),
              ...parseStringArray(rightProps.sourceIndirect),
            ].slice(0, 8),
          }),
        });
      }

      return {
        graph: serializeGraphFromRecords(nodes, relationships, {
          sourceId,
          targetId,
          retrieval: 'pair-evidence',
        }),
        items,
        highlightNodeIds: [...highlightNodeIds],
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private async getRelatedEntities(
    nodeId: string,
    nodeTypes: string[],
    relationshipTypes: string[],
    limit: number,
  ) {
    const session = this.neo4jService.getSession();

    try {
      const result = await session.run(
        `
          MATCH (start:Entity {id: $nodeId})-[rel]-(neighbor:Entity)
          WHERE (size($nodeTypes) = 0 OR neighbor.typeName IN $nodeTypes OR neighbor.typeCode IN $nodeTypes)
            AND (
              size($relationshipTypes) = 0
              OR type(rel) IN $relationshipTypes
              OR coalesce(rel.labelCode, '') IN $relationshipTypes
            )
          RETURN start, rel, neighbor
          ORDER BY
            coalesce(rel.score, 0) DESC,
            size(coalesce(rel.sourceDirect, [])) + size(coalesce(rel.sourceIndirect, [])) DESC,
            neighbor.displayName
          LIMIT $limit
        `,
        {
          nodeId,
          nodeTypes,
          relationshipTypes,
          limit: neo4j.int(Math.max(1, Math.trunc(toNumber(limit)))),
        },
      );

      const nodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];
      const items: GraphEvidenceItem[] = [];

      for (const record of result.records) {
        const start = record.get('start') as Neo4jNode;
        const neighbor = record.get('neighbor') as Neo4jNode;
        const relationship = record.get('rel') as Neo4jRelationship;
        const relProps = relationship.properties as Record<string, unknown>;
        const provenance = [...parseStringArray(relProps.sourceDirect), ...parseStringArray(relProps.sourceIndirect)];
        const relationDetails = parseJsonRecord(relProps.propertiesJson);
        const neighborDescription =
          typeof neighbor.properties.description === 'string' ? String(neighbor.properties.description) : undefined;
        nodes.push(start, neighbor);
        relationships.push(relationship);
        items.push({
          id: String(relationship.properties.edgeKey ?? relationship.elementId),
          kind: 'relation',
          title: `${String(start.properties.displayName)} -> ${String(neighbor.properties.displayName)}`,
          summary: this.buildRelationSummary(
            String(start.properties.displayName),
            relationship.type,
            String(neighbor.properties.displayName),
            provenance,
            {
              ...(relationDetails ?? {}),
              neighborType: String(neighbor.properties.typeName ?? neighbor.properties.typeCode ?? 'Entity'),
              neighborDescription,
            },
          ),
          score: Math.min(0.95, 0.7 + toNumber(relProps.score) * 0.18 + Math.min(0.06, provenance.length * 0.01)),
          nodeIds: [String(start.properties.id), String(neighbor.properties.id)],
          edgeIds: [String(relationship.properties.edgeKey ?? relationship.elementId)],
          metadata: compactRecord({
            relation: relationship.type,
            confidence: relProps.score,
            provenance: provenance.slice(0, 8),
            neighborType: String(neighbor.properties.typeName ?? neighbor.properties.typeCode ?? 'Entity'),
            neighborDescription,
            details: relationDetails,
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

  private async getRelatedEntitiesForNodeSet(
    nodeIds: string[],
    nodeTypes: string[],
    relationshipTypes: string[],
    aggregateMode: 'shared' | 'union',
    minSupport: number,
    limit: number,
  ) {
    const session = this.neo4jService.getSession();
    const dedupedNodeIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));

    try {
      const result = await session.run(
        `
          MATCH (start:Entity)-[rel]-(neighbor:Entity)
          WHERE start.id IN $nodeIds
            AND (size($nodeTypes) = 0 OR neighbor.typeName IN $nodeTypes OR neighbor.typeCode IN $nodeTypes)
            AND (
              size($relationshipTypes) = 0
              OR type(rel) IN $relationshipTypes
              OR coalesce(rel.labelCode, '') IN $relationshipTypes
            )
          WITH neighbor, collect(DISTINCT start) AS starts, collect(rel) AS rels
          WHERE size(starts) >= $minSupport
          RETURN neighbor, starts, rels,
            size(starts) AS support,
            reduce(total = 0.0, relationship IN rels | total + coalesce(relationship.score, 0.0)) AS totalScore
          ORDER BY support DESC, totalScore DESC, neighbor.displayName
          LIMIT $limit
        `,
        {
          nodeIds: dedupedNodeIds,
          nodeTypes,
          relationshipTypes,
          minSupport: neo4j.int(Math.max(1, Math.trunc(toNumber(minSupport)))),
          limit: neo4j.int(Math.max(1, Math.trunc(toNumber(limit)))),
        },
      );

      const nodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];
      const items: GraphEvidenceItem[] = [];
      const highlightNodeIds = new Set<string>(dedupedNodeIds);

      for (const [index, record] of result.records.entries()) {
        const neighbor = record.get('neighbor') as Neo4jNode;
        const starts = record.get('starts') as Neo4jNode[];
        const rels = record.get('rels') as Neo4jRelationship[];
        const support = toNumber(record.get('support'));
        const totalScore = toNumber(record.get('totalScore'));
        const provenance = rels.flatMap((relationship) => {
          const relProps = relationship.properties as Record<string, unknown>;
          return [...parseStringArray(relProps.sourceDirect), ...parseStringArray(relProps.sourceIndirect)];
        });
        const relationTypes = Array.from(new Set(rels.map((relationship) => relationship.type)));
        const startNames = starts.map((start) => String(start.properties.displayName));
        const neighborDescription =
          typeof neighbor.properties.description === 'string' ? String(neighbor.properties.description) : undefined;

        nodes.push(neighbor, ...starts);
        relationships.push(...rels);
        highlightNodeIds.add(String(neighbor.properties.id));

        items.push({
          id: `shared-related-${index}-${String(neighbor.properties.id)}`,
          kind: 'path',
          title: `${aggregateMode === 'shared' ? 'Shared' : 'Ranked'} ${String(neighbor.properties.typeName ?? neighbor.properties.typeCode ?? 'entity')}: ${String(neighbor.properties.displayName)}`,
          summary: [
            aggregateMode === 'shared'
              ? `${String(neighbor.properties.displayName)} is shared across ${support} selected anchors: ${startNames.join(', ')}.`
              : `${String(neighbor.properties.displayName)} is connected to ${support} selected anchors: ${startNames.join(', ')}.`,
            relationTypes.length > 0 ? `Relations: ${relationTypes.join(', ')}.` : '',
            neighborDescription ? `Description: ${neighborDescription}` : '',
            provenance.length > 0 ? `Sources: ${Array.from(new Set(provenance)).slice(0, 6).join(', ')}.` : '',
          ]
            .filter((part) => part.length > 0)
            .join(' '),
          score: Math.min(0.97, 0.66 + support * 0.08 + Math.min(0.12, totalScore * 0.04)),
          nodeIds: [...starts.map((start) => String(start.properties.id)), String(neighbor.properties.id)],
          edgeIds: rels.map((relationship) => String(relationship.properties.edgeKey ?? relationship.elementId)),
          metadata: compactRecord({
            support,
            supportNodeIds: starts.map((start) => String(start.properties.id)),
            supportNodeLabels: startNames,
            relationTypes,
            provenance: Array.from(new Set(provenance)).slice(0, 8),
            neighborType: String(neighbor.properties.typeName ?? neighbor.properties.typeCode ?? 'Entity'),
            neighborDescription,
            aggregateMode,
          }),
        });
      }

      return {
        graph: serializeGraphFromRecords(nodes, relationships, {
          sourceIds: dedupedNodeIds,
          retrieval: 'shared-related-entities',
        }),
        items,
        highlightNodeIds: [...highlightNodeIds],
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private async retrieveClinicalGuidelines(nodeId: string, limit: number) {
    return this.getRelatedEntities(nodeId, ['Clinical Guideline', 'Guideline'], [], limit);
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
        const provenance = pathRelationships.flatMap((relationship) => {
          const relProps = relationship.properties as Record<string, unknown>;
          return [...parseStringArray(relProps.sourceDirect), ...parseStringArray(relProps.sourceIndirect)];
        });
        const terminalNode = pathNodes[pathNodes.length - 1];
        const terminalDescription =
          typeof terminalNode?.properties?.description === 'string'
            ? String(terminalNode.properties.description)
            : undefined;
        nodes.push(...pathNodes);
        relationships.push(...pathRelationships);

        items.push({
          id: `typed-path-${index}`,
          kind: 'path',
          title: pathNodes.map((node) => String(node.properties.displayName)).join(' -> '),
          summary: [
            `Path relations: ${pathRelationships.map((relationship) => relationship.type).join(' -> ')}.`,
            terminalDescription ? `Terminal node: ${terminalDescription}` : '',
            provenance.length > 0 ? `Sources: ${Array.from(new Set(provenance)).slice(0, 5).join(', ')}.` : '',
          ]
            .filter((part) => part.length > 0)
            .join(' '),
          score: 0.9 - index * 0.05,
          nodeIds: pathNodes.map((node) => String(node.properties.id)),
          edgeIds: pathRelationships.map((relationship) => String(relationship.properties.edgeKey ?? relationship.elementId)),
          metadata: {
            typeSequence: sequence,
            provenance: Array.from(new Set(provenance)).slice(0, 8),
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
    const { topNodeTypes, typeSummary } = this.summarizeNodeTypes(graph);
    const centerNodeId =
      typeof graph.attributes.centerNodeId === 'string' ? String(graph.attributes.centerNodeId) : undefined;
    const centerNodeLabel =
      centerNodeId && graph.nodes.find((node) => node.key === centerNodeId)
        ? String(graph.nodes.find((node) => node.key === centerNodeId)?.attributes.label ?? centerNodeId)
        : undefined;
    const expandedFromNodeIds = Array.isArray(graph.attributes.expandedFromNodeIds)
      ? graph.attributes.expandedFromNodeIds.map((nodeId) => String(nodeId))
      : [];
    const seedLabels = expandedFromNodeIds
      .map((nodeId) => graph.nodes.find((node) => node.key === nodeId))
      .filter((node): node is SerializedGraphPayload['nodes'][number] => Boolean(node))
      .map((node) => String(node.attributes.label ?? node.key));
    const summary = centerNodeLabel
      ? `Retrieved ${graph.nodes.length} nodes and ${graph.edges.length} edges around ${centerNodeLabel}. ${typeSummary}`
      : seedLabels.length > 0
        ? `Expanded a graph from ${seedLabels.slice(0, 4).join(', ')} with ${graph.nodes.length} nodes and ${graph.edges.length} edges. ${typeSummary}`
        : `Retrieved a subgraph with ${graph.nodes.length} nodes and ${graph.edges.length} edges. ${typeSummary}`;

    return {
      id,
      kind,
      title,
      summary,
      score,
      nodeIds: graph.nodes.map((node) => node.key),
      edgeIds: graph.edges.map((edge) => edge.key),
      metadata: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        topNodeTypes,
      },
    };
  }

  private buildRelationSummary(
    sourceName: string,
    relationType: string,
    targetName: string,
    provenance: string[],
    relationDetails?: Record<string, unknown>,
  ) {
    const parts = [`${relationType} between ${sourceName} and ${targetName}.`];
    if (provenance.length > 0) {
      parts.push(`Sources: ${provenance.slice(0, 5).join(', ')}.`);
    }
    if (relationDetails) {
      const detailEntries = Object.entries(relationDetails)
        .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${String(value)}`);
      if (detailEntries.length > 0) {
        parts.push(`Details: ${detailEntries.join('; ')}.`);
      }
    }
    return parts.join(' ');
  }

  private summarizeNodeTypes(graph: SerializedGraphPayload) {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      const nodeType = String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity');
      counts.set(nodeType, (counts.get(nodeType) ?? 0) + 1);
    }

    const topNodeTypes = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([type, count]) => ({ type, count }));

    const typeSummary =
      topNodeTypes.length > 0
        ? `Top node types: ${topNodeTypes.map(({ type, count }) => `${type} (${count})`).join(', ')}.`
        : 'Top node types were not available.';

    return {
      topNodeTypes,
      typeSummary,
    };
  }

  private buildGraphActionsFromResult(
    stepId: string,
    graph?: SerializedGraphPayload,
    highlightNodeIds: string[] = [],
  ): GraphAction[] {
    if (!graph) {
      return [];
    }

    const nodeIds =
      highlightNodeIds.length > 0
        ? highlightNodeIds
        : graph.nodes.map((node) => node.key).slice(0, Math.min(16, graph.nodes.length));

    return [
      {
        id: stepId,
        type: 'load-subgraph',
        mode: 'merge',
        graph,
        highlightNodeIds: nodeIds,
      },
      {
        id: `${stepId}-focus`,
        type: 'focus-nodes',
        nodeIds,
      },
    ];
  }

  private mergeGraphDelta(
    currentGraph: SerializedGraphPayload | undefined,
    nextGraph: SerializedGraphPayload | undefined,
  ) {
    if (!nextGraph) {
      return currentGraph;
    }

    return nextGraph;
  }
}
