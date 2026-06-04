import { Injectable } from '@nestjs/common';
import neo4j, { type Node as Neo4jNode, type Relationship as Neo4jRelationship } from 'neo4j-driver';
import { Neo4jService } from '@/neo4j/neo4j.service';
import { OptimusKgService, type SerializedGraphPayload } from '@/optimuskg/optimuskg.service';
import type { GraphEvidenceItem } from './graph-agent.types';
import { compactRecord, parseStringArray, serializeGraphFromRecords, toNumber } from './graph-agent.utils';

interface GraphAnalysisResult {
  items: GraphEvidenceItem[];
  graph?: SerializedGraphPayload;
  highlightNodeIds?: string[];
  warnings?: string[];
}

@Injectable()
export class GraphAnalysisService {
  constructor(
    private readonly neo4jService: Neo4jService,
    private readonly optimusKgService: OptimusKgService,
  ) {}

  async summarizeNodes(nodeIds: string[]): Promise<GraphAnalysisResult> {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 12);
    if (dedupedNodeIds.length === 0) {
      return { items: [], warnings: ['No graph-selected nodes were available to summarize.'] };
    }

    const { nodes, relationships } = await this.loadNodeSetSubgraph(dedupedNodeIds, [], 64);
    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: 'graph-analysis:summarize-nodes',
      nodeIds: dedupedNodeIds,
    });
    const typeSummary = this.summarizeNodeTypes(graph);
    const labels = graph.nodes.map((node) => String(node.attributes.label ?? node.key));

    const items: GraphEvidenceItem[] = [
      {
        id: `summarize-nodes-${Date.now()}`,
        kind: 'query',
        title: 'Selected node summary',
        summary: `Summarized ${graph.nodes.length} selected nodes with ${graph.edges.length} relationships in the induced subgraph. ${typeSummary}`,
        score: 0.88,
        nodeIds: graph.nodes.map((node) => node.key),
        edgeIds: graph.edges.map((edge) => edge.key),
        metadata: {
          labels: labels.slice(0, 12),
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          topNodeTypes: this.topNodeTypes(graph),
        },
      },
    ];

    for (const node of graph.nodes.slice(0, 8)) {
      items.push({
        id: `node-summary-${node.key}`,
        kind: 'entity',
        title: `${String(node.attributes.label ?? node.key)} (${String(node.attributes.nodeType ?? 'Entity')})`,
        summary: this.buildNodeSummary(node, relationships),
        score: 0.72,
        nodeIds: [node.key],
        edgeIds: graph.edges
          .filter((edge) => edge.source === node.key || edge.target === node.key)
          .map((edge) => edge.key),
        metadata: compactRecord({
          nodeType: String(node.attributes.nodeType ?? 'Entity'),
          description: typeof node.attributes.description === 'string' ? node.attributes.description : undefined,
          aliases: Array.isArray(node.attributes.aliases) ? node.attributes.aliases : undefined,
        }),
      });
    }

    return {
      items,
      graph,
      highlightNodeIds: dedupedNodeIds,
    };
  }

  async summarizeSubgraph(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 120);
    const dedupedEdgeIds = this.dedupeIds(edgeIds).slice(0, 240);
    const { nodes, relationships } = await this.loadNodeSetSubgraph(dedupedNodeIds, dedupedEdgeIds, 240);

    if (nodes.length === 0 && relationships.length === 0) {
      return { items: [], warnings: ['No visible subgraph data was available to summarize.'] };
    }

    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: 'graph-analysis:summarize-subgraph',
      nodeIds: dedupedNodeIds,
      edgeIds: dedupedEdgeIds,
    });
    const typeSummary = this.summarizeNodeTypes(graph);
    const hubs = this.rankHubNodes(graph).slice(0, 5);

    return {
      items: [
        {
          id: `summarize-subgraph-${Date.now()}`,
          kind: 'query',
          title: 'Subgraph summary',
          summary: `The active subgraph contains ${graph.nodes.length} nodes and ${graph.edges.length} edges. ${typeSummary}${hubs.length > 0 ? ` Most connected nodes: ${hubs.map((hub) => hub.label).join(', ')}.` : ''}`,
          score: 0.86,
          nodeIds: graph.nodes.map((node) => node.key),
          edgeIds: graph.edges.map((edge) => edge.key),
          metadata: {
            topNodeTypes: this.topNodeTypes(graph),
            hubs,
          },
        },
      ],
      graph,
      highlightNodeIds: hubs.map((hub) => hub.id),
    };
  }

  async compareNodes(nodeIds: string[]): Promise<GraphAnalysisResult> {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 6);
    const { nodes, relationships } = await this.loadNodeSetSubgraph(dedupedNodeIds, [], 80);
    if (nodes.length === 0) {
      return { items: [], warnings: ['No nodes were available for comparison.'] };
    }

    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: 'graph-analysis:compare-nodes',
      nodeIds: dedupedNodeIds,
    });
    const commonNeighbors = await this.findSharedTypedNeighbors(dedupedNodeIds, [], 2, 10);
    const typeCounts = new Map<string, number>();
    for (const node of graph.nodes) {
      const nodeType = String(node.attributes.nodeType ?? 'Entity');
      typeCounts.set(nodeType, (typeCounts.get(nodeType) ?? 0) + 1);
    }

    return {
      items: [
        {
          id: `compare-nodes-${Date.now()}`,
          kind: 'query',
          title: 'Node comparison',
          summary: `Compared ${graph.nodes.length} nodes. Type distribution: ${[...typeCounts.entries()].map(([type, count]) => `${type} (${count})`).join(', ')}.${commonNeighbors.items.length > 0 ? ` Shared neighbors were found for the compared nodes.` : ''}`,
          score: 0.83,
          nodeIds: graph.nodes.map((node) => node.key),
          edgeIds: graph.edges.map((edge) => edge.key),
          metadata: {
            typeCounts: [...typeCounts.entries()].map(([type, count]) => ({ type, count })),
            sharedNeighborCount: commonNeighbors.items.length,
          },
        },
        ...graph.nodes.map((node) => ({
          id: `compare-node-${node.key}`,
          kind: 'entity' as const,
          title: `${String(node.attributes.label ?? node.key)} (${String(node.attributes.nodeType ?? 'Entity')})`,
          summary: this.buildNodeSummary(node, relationships),
          score: 0.7,
          nodeIds: [node.key],
          edgeIds: graph.edges
            .filter((edge) => edge.source === node.key || edge.target === node.key)
            .map((edge) => edge.key),
          metadata: {
            description: typeof node.attributes.description === 'string' ? node.attributes.description : undefined,
          },
        })),
        ...commonNeighbors.items.slice(0, 6),
      ],
      graph: commonNeighbors.graph ?? graph,
      highlightNodeIds: dedupedNodeIds,
    };
  }

  async findSharedPathways(nodeIds: string[], minSupport = 2, limit = 20) {
    return this.findSharedTypedNeighbors(nodeIds, ['Pathway'], minSupport, limit, 'Shared pathways');
  }

  async findSharedDiseases(nodeIds: string[], minSupport = 2, limit = 20) {
    return this.findSharedTypedNeighbors(nodeIds, ['Disease'], minSupport, limit, 'Shared diseases');
  }

  async findSharedGenes(nodeIds: string[], minSupport = 2, limit = 20) {
    return this.findSharedTypedNeighbors(nodeIds, ['Gene', 'Protein'], minSupport, limit, 'Shared genes and proteins');
  }

  async findCommonNeighbors(nodeIds: string[], targetTypes: string[], minSupport = 2, limit = 20) {
    return this.findSharedTypedNeighbors(nodeIds, targetTypes, minSupport, limit, 'Shared neighbors');
  }

  async findHubNodes(nodeIds: string[]): Promise<GraphAnalysisResult> {
    const { nodes, relationships } = await this.loadNodeSetSubgraph(this.dedupeIds(nodeIds).slice(0, 120), [], 240);
    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: 'graph-analysis:hub-nodes',
    });
    const hubs = this.rankHubNodes(graph).slice(0, 10);

    return {
      items: [
        {
          id: `hub-nodes-${Date.now()}`,
          kind: 'query',
          title: 'Hub nodes',
          summary: hubs.length > 0 ? `Top hub nodes: ${hubs.map((hub) => `${hub.label} (${hub.degree})`).join(', ')}.` : 'No hub nodes were identified in the active subgraph.',
          score: 0.78,
          nodeIds: hubs.map((hub) => hub.id),
          edgeIds: graph.edges.map((edge) => edge.key),
          metadata: { hubs },
        },
      ],
      graph,
      highlightNodeIds: hubs.map((hub) => hub.id),
    };
  }

  async findBridgingNodes(nodeIds: string[]): Promise<GraphAnalysisResult> {
    const { nodes, relationships } = await this.loadNodeSetSubgraph(this.dedupeIds(nodeIds).slice(0, 120), [], 240);
    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: 'graph-analysis:bridging-nodes',
    });
    const bridgeCandidates = this.rankHubNodes(graph)
      .filter((hub) => hub.degree >= 2)
      .slice(0, 10);

    return {
      items: [
        {
          id: `bridging-nodes-${Date.now()}`,
          kind: 'query',
          title: 'Potential bridging nodes',
          summary: bridgeCandidates.length > 0 ? `Potential bridge nodes: ${bridgeCandidates.map((hub) => hub.label).join(', ')}.` : 'No bridging nodes were identified in the active subgraph.',
          score: 0.74,
          nodeIds: bridgeCandidates.map((hub) => hub.id),
          edgeIds: graph.edges.map((edge) => edge.key),
          metadata: { bridgeCandidates },
        },
      ],
      graph,
      highlightNodeIds: bridgeCandidates.map((hub) => hub.id),
    };
  }

  async explainConnections(nodeIds: string[], maxDepth = 5): Promise<GraphAnalysisResult> {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 6);
    if (dedupedNodeIds.length < 2) {
      return this.summarizeNodes(dedupedNodeIds);
    }

    if (dedupedNodeIds.length === 2) {
      const [sourceId, targetId] = dedupedNodeIds;
      const path = await this.optimusKgService.shortestPath(sourceId, targetId, maxDepth);
      const shared = await this.findSharedTypedNeighbors([sourceId, targetId], [], 2, 8, 'Shared connectors');
      const items: GraphEvidenceItem[] = [];

      if (path.graph.nodes.length > 0) {
        items.push({
          id: `connection-path-${Date.now()}`,
          kind: 'path',
          title: 'Shortest explanatory path',
          summary: path.found
            ? `Shortest path: ${path.graph.nodes.map((node) => String(node.attributes.label ?? node.key)).join(' -> ')}.`
            : 'No bounded shortest path was found between the selected nodes.',
          score: path.found ? 0.91 : 0.54,
          nodeIds: path.graph.nodes.map((node) => node.key),
          edgeIds: path.graph.edges.map((edge) => edge.key),
          metadata: {
            found: path.found,
            maxDepth,
          },
        });
      }

      return {
        items: [...items, ...shared.items.slice(0, 6)],
        graph: shared.graph?.nodes.length ? shared.graph : path.graph,
        highlightNodeIds: dedupedNodeIds,
        warnings: !path.found && shared.items.length === 0 ? ['No direct path or shared connectors were found for the selected nodes.'] : [],
      };
    }

    return this.findSharedTypedNeighbors(dedupedNodeIds, [], Math.max(2, Math.min(3, dedupedNodeIds.length)), 12, 'Shared connectors');
  }

  async analyzeCluster(nodeIds: string[]): Promise<GraphAnalysisResult> {
    const summary = await this.summarizeSubgraph(nodeIds, []);
    const hubs = await this.findHubNodes(nodeIds);

    return {
      items: [...summary.items, ...hubs.items],
      graph: summary.graph ?? hubs.graph,
      highlightNodeIds: hubs.highlightNodeIds ?? summary.highlightNodeIds,
      warnings: [...(summary.warnings ?? []), ...(hubs.warnings ?? [])],
    };
  }

  private async findSharedTypedNeighbors(
    nodeIds: string[],
    targetTypes: string[],
    minSupport: number,
    limit: number,
    title = 'Shared neighbors',
  ): Promise<GraphAnalysisResult> {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 8);
    if (dedupedNodeIds.length < 2) {
      return { items: [], warnings: ['At least two anchor nodes are required for shared-neighbor analysis.'] };
    }

    const session = this.neo4jService.getSession();
    try {
      const result = await session.run(
        `
          MATCH (anchor:Entity)-[rel]-(neighbor:Entity)
          WHERE anchor.id IN $nodeIds
            AND (
              size($targetTypes) = 0
              OR neighbor.typeName IN $targetTypes
              OR neighbor.typeCode IN $targetTypes
            )
          WITH neighbor, collect(DISTINCT anchor) AS anchors, collect(rel) AS rels
          WHERE size(anchors) >= $minSupport
          RETURN neighbor, anchors, rels,
            size(anchors) AS support,
            reduce(total = 0.0, relationship IN rels | total + coalesce(relationship.score, 0.0)) AS totalScore
          ORDER BY support DESC, totalScore DESC, neighbor.displayName
          LIMIT $limit
        `,
        {
          nodeIds: dedupedNodeIds,
          targetTypes,
          minSupport: neo4j.int(Math.max(1, minSupport)),
          limit: neo4j.int(Math.max(1, limit)),
        },
      );

      const nodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];
      const items: GraphEvidenceItem[] = [];
      const highlightNodeIds = new Set<string>(dedupedNodeIds);

      for (const [index, record] of result.records.entries()) {
        const neighbor = record.get('neighbor') as Neo4jNode;
        const anchors = record.get('anchors') as Neo4jNode[];
        const rels = record.get('rels') as Neo4jRelationship[];
        const support = toNumber(record.get('support'));
        const totalScore = toNumber(record.get('totalScore'));
        const provenance = rels.flatMap((rel) => {
          const props = rel.properties as Record<string, unknown>;
          return [...parseStringArray(props.sourceDirect), ...parseStringArray(props.sourceIndirect)];
        });

        nodes.push(neighbor, ...anchors);
        relationships.push(...rels);
        highlightNodeIds.add(String(neighbor.properties.id));

        items.push({
          id: `shared-neighbor-${String(neighbor.properties.id)}-${index}`,
          kind: 'path',
          title: `${title}: ${String(neighbor.properties.displayName)}`,
          summary: `${String(neighbor.properties.displayName)} is connected to ${support} anchors: ${anchors.map((anchor) => String(anchor.properties.displayName)).join(', ')}.${provenance.length > 0 ? ` Sources: ${Array.from(new Set(provenance)).slice(0, 6).join(', ')}.` : ''}`,
          score: Math.min(0.96, 0.68 + support * 0.08 + Math.min(0.12, totalScore * 0.04)),
          nodeIds: [...anchors.map((anchor) => String(anchor.properties.id)), String(neighbor.properties.id)],
          edgeIds: rels.map((rel) => String(rel.properties.edgeKey ?? rel.elementId)),
          metadata: {
            support,
            totalScore,
            neighborType: String(neighbor.properties.typeName ?? neighbor.properties.typeCode ?? 'Entity'),
            supportNodeIds: anchors.map((anchor) => String(anchor.properties.id)),
            provenance: Array.from(new Set(provenance)).slice(0, 8),
          },
        });
      }

      return {
        items,
        graph: serializeGraphFromRecords(nodes, relationships, {
          retrieval: `graph-analysis:${title.toLowerCase().replace(/\s+/g, '-')}`,
          sourceIds: dedupedNodeIds,
          targetTypes,
        }),
        highlightNodeIds: [...highlightNodeIds],
        warnings: items.length === 0 ? [`No ${title.toLowerCase()} were found for the selected anchors.`] : [],
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private async loadNodeSetSubgraph(nodeIds: string[], edgeIds: string[], limit: number) {
    const dedupedNodeIds = this.dedupeIds(nodeIds);
    const dedupedEdgeIds = this.dedupeIds(edgeIds);
    const session = this.neo4jService.getSession();

    try {
      const nodeResult = dedupedNodeIds.length
        ? await session.run(
            `
              MATCH (node:Entity)
              WHERE node.id IN $nodeIds
              RETURN node
              LIMIT $limit
            `,
            {
              nodeIds: dedupedNodeIds,
              limit: neo4j.int(Math.max(1, limit)),
            },
          )
        : { records: [] as Array<{ get(key: string): Neo4jNode }> };

      const relationshipResult =
        dedupedNodeIds.length || dedupedEdgeIds.length
          ? await session.run(
              `
                MATCH (source:Entity)-[rel]-(target:Entity)
                WHERE (
                  size($nodeIds) > 0
                  AND source.id IN $nodeIds
                  AND target.id IN $nodeIds
                )
                OR (
                  size($edgeIds) > 0
                  AND coalesce(rel.edgeKey, '') IN $edgeIds
                )
                RETURN source, rel, target
                LIMIT $limit
              `,
              {
                nodeIds: dedupedNodeIds,
                edgeIds: dedupedEdgeIds,
                limit: neo4j.int(Math.max(1, limit)),
              },
            )
          : { records: [] as Array<{ get(key: string): Neo4jNode | Neo4jRelationship }> };

      const nodes = nodeResult.records.map((record) => record.get('node') as Neo4jNode);
      const relationshipNodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];

      for (const record of relationshipResult.records) {
        relationshipNodes.push(record.get('source') as Neo4jNode, record.get('target') as Neo4jNode);
        relationships.push(record.get('rel') as Neo4jRelationship);
      }

      return {
        nodes: [...nodes, ...relationshipNodes],
        relationships,
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private rankHubNodes(graph: SerializedGraphPayload) {
    const degrees = new Map<string, number>();
    for (const edge of graph.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }

    return graph.nodes
      .map((node) => ({
        id: node.key,
        label: String(node.attributes.label ?? node.key),
        degree: degrees.get(node.key) ?? 0,
        nodeType: String(node.attributes.nodeType ?? 'Entity'),
      }))
      .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
  }

  private buildNodeSummary(node: SerializedGraphPayload['nodes'][number], relationships: Neo4jRelationship[]) {
    const connectedRelations = relationships.filter((relationship) => {
      const props = relationship.properties as Record<string, unknown>;
      return String(props.fromId) === node.key || String(props.toId) === node.key;
    });
    const relationTypes = Array.from(new Set(connectedRelations.map((relationship) => relationship.type)));
    const description =
      typeof node.attributes.description === 'string'
        ? String(node.attributes.description)
        : `${String(node.attributes.label ?? node.key)} is represented as a ${String(node.attributes.nodeType ?? 'Entity')} node in OptimusKG.`;
    return `${description}${relationTypes.length > 0 ? ` Connected relation types: ${relationTypes.slice(0, 5).join(', ')}.` : ''}`;
  }

  private summarizeNodeTypes(graph: SerializedGraphPayload) {
    const topTypes = this.topNodeTypes(graph);
    return topTypes.length > 0
      ? `Top node types: ${topTypes.map(({ type, count }) => `${type} (${count})`).join(', ')}.`
      : 'Top node types were not available.';
  }

  private topNodeTypes(graph: SerializedGraphPayload) {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      const type = String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity');
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([type, count]) => ({ type, count }));
  }

  private dedupeIds(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
  }
}
