import { Injectable } from '@nestjs/common';
import neo4j, { type Node as Neo4jNode, type Relationship as Neo4jRelationship } from 'neo4j-driver';
import { Neo4jService } from '@/neo4j/neo4j.service';
import { OptimusKgService, type SerializedGraphPayload } from '@/optimuskg/optimuskg.service';
import type { GraphEvidenceItem } from './graph-agent.types';
import { compactRecord, parseStringArray, serializeGraphFromRecords, toNumber } from './graph-agent.utils';

const GRAPH_ANALYSIS_QUERY_TIMEOUT_MS = 8000;
const DEFAULT_GRAPH_ANALYSIS_NODE_LIMIT = 2000;
const DEFAULT_GRAPH_ANALYSIS_EDGE_LIMIT = 5000;
const HIERARCHY_RELATION_TYPES = ['PARENT', 'IS_A'];
const NODE_TYPE_ALIASES: Record<string, string[]> = {
  Gene: ['gene', 'genes'],
  Protein: ['protein', 'proteins'],
  Disease: ['disease', 'diseases', 'disorder', 'disorders', 'syndrome', 'syndromes', 'dementia', 'cancer'],
  Drug: ['drug', 'drugs', 'compound', 'compounds', 'therapeutic', 'therapeutics'],
  Pathway: ['pathway', 'pathways'],
  Phenotype: ['phenotype', 'phenotypes', 'symptom', 'symptoms'],
  Anatomy: ['anatomy', 'anatomical', 'organ', 'organs', 'tissue', 'tissues'],
  MolecularFunction: ['molecular function', 'molecular functions'],
  CellularComponent: ['cellular component', 'cellular components'],
  Exposure: ['exposure', 'exposures'],
  BiologicalProcess: ['biological process', 'biological processes', 'process', 'processes'],
};

interface GraphAnalysisResult {
  items: GraphEvidenceItem[];
  graph?: SerializedGraphPayload;
  highlightNodeIds?: string[];
  warnings?: string[];
}

interface GraphTopologySummary {
  selectedNodeCount: number;
  analyzedNodeCount: number;
  selectedEdgeCount: number;
  analyzedEdgeCount: number;
  graphShape: 'single-node' | 'star graph' | 'hub-and-spoke graph' | 'path' | 'tree' | 'cluster' | 'mixed';
  connectedComponents: Array<{
    size: number;
    nodeIds: string[];
  }>;
  hubNodes: Array<{
    id: string;
    label: string;
    degree: number;
    nodeType: string;
  }>;
  centralNodes: Array<{
    id: string;
    label: string;
    degree: number;
    relationDiversity: number;
    nodeType: string;
  }>;
  relationshipCounts: Array<{
    relation: string;
    count: number;
  }>;
  nodeTypeDistribution: Array<{
    type: string;
    count: number;
    sampleLabels: string[];
  }>;
  dominantRelationships: Array<{
    relation: string;
    count: number;
    coverage: number;
  }>;
  prominentComponents: Array<{
    size: number;
    dominantNodeTypes: string[];
  }>;
  density: number;
  ontologyDiagnostics: Array<{
    nodeId: string;
    label: string;
    nodeType: string;
    reason: string;
  }>;
}

@Injectable()
export class GraphAnalysisService {
  constructor(
    private readonly neo4jService: Neo4jService,
    private readonly optimusKgService: OptimusKgService,
  ) {}

  async summarizeNodes(nodeIds: string[], edgeIds: string[] = []): Promise<GraphAnalysisResult> {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 120);
    const dedupedEdgeIds = this.dedupeIds(edgeIds).slice(0, 240);
    if (dedupedNodeIds.length === 0 && dedupedEdgeIds.length === 0) {
      return { items: [], warnings: ['No graph-selected nodes or edges were available to summarize.'] };
    }

    const { nodes, relationships } = await this.loadNodeSetSubgraph(
      dedupedNodeIds,
      dedupedEdgeIds,
      Math.min(480, Math.max(96, dedupedNodeIds.length * 8, dedupedEdgeIds.length * 4, 64)),
      { preferExplicitEdges: dedupedEdgeIds.length > 0 },
    );
    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: 'graph-analysis:summarize-nodes',
      nodeIds: dedupedNodeIds,
      edgeIds: dedupedEdgeIds,
    });
    const topology = this.analyzeGraphTopology(graph, {
      selectedNodeCount: dedupedNodeIds.length,
      selectedEdgeCount: dedupedEdgeIds.length,
    });
    const sections = this.buildGraphSummarySections(graph, topology);

    const items: GraphEvidenceItem[] = [
      {
        id: `summarize-nodes-${Date.now()}`,
        kind: 'query',
        title: 'Selected node summary',
        summary: sections.join('\n\n'),
        score: 0.88,
        nodeIds: graph.nodes.map((node) => node.key),
        edgeIds: graph.edges.map((edge) => edge.key),
        metadata: {
          selectedNodeCount: topology.selectedNodeCount,
          analyzedNodeCount: topology.analyzedNodeCount,
          selectedEdgeCount: topology.selectedEdgeCount,
          analyzedEdgeCount: topology.analyzedEdgeCount,
          graphShape: topology.graphShape,
          connectedComponents: topology.connectedComponents,
          hubNodes: topology.hubNodes,
          centralNodes: topology.centralNodes,
          relationshipCounts: topology.relationshipCounts,
          nodeTypeDistribution: topology.nodeTypeDistribution,
          density: topology.density,
          ontologyDiagnostics: topology.ontologyDiagnostics,
        },
      },
    ];

    for (const node of this.pickSummaryNodes(graph, topology).slice(0, 6)) {
      items.push({
        id: `node-summary-${node.key}`,
        kind: 'entity',
        title: `${String(node.attributes.label ?? node.key)} (${String(node.attributes.nodeType ?? 'Entity')})`,
        summary: this.buildNodeSummary(node, relationships, graph),
        score: 0.72,
        nodeIds: [node.key],
        edgeIds: graph.edges
          .filter((edge) => edge.source === node.key || edge.target === node.key)
          .map((edge) => edge.key),
        metadata: compactRecord({
          nodeType: String(node.attributes.nodeType ?? 'Entity'),
          description: typeof node.attributes.description === 'string' ? node.attributes.description : undefined,
          aliases: this.extractNodeAliases(node),
          ontologyCategory: String(
            node.attributes.ontologyCategory ?? node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity',
          ),
        }),
      });
    }

    return {
      items,
      graph,
      highlightNodeIds: dedupedNodeIds,
      warnings: topology.ontologyDiagnostics.length
        ? [
            `Potential ontology typing mismatches were detected for ${topology.ontologyDiagnostics.length} node${topology.ontologyDiagnostics.length === 1 ? '' : 's'} in the analyzed graph.`,
          ]
        : [],
    };
  }

  async summarizeSubgraph(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 2000);
    const dedupedEdgeIds = this.dedupeIds(edgeIds).slice(0, 5000);
    const { nodes, relationships } = await this.loadNodeSetSubgraph(
      dedupedNodeIds,
      dedupedEdgeIds,
      Math.min(
        6000,
        Math.max(
          240,
          dedupedNodeIds.length + dedupedEdgeIds.length,
          dedupedNodeIds.length * 4,
          dedupedEdgeIds.length * 2,
        ),
      ),
      { preferExplicitEdges: dedupedEdgeIds.length > 0 && dedupedNodeIds.length > 0 },
    );

    if (nodes.length === 0 && relationships.length === 0) {
      return { items: [], warnings: ['No visible subgraph data was available to summarize.'] };
    }

    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: 'graph-analysis:summarize-subgraph',
      nodeIds: dedupedNodeIds,
      edgeIds: dedupedEdgeIds,
    });
    const topology = this.analyzeGraphTopology(graph, {
      selectedNodeCount: dedupedNodeIds.length || graph.nodes.length,
      selectedEdgeCount: dedupedEdgeIds.length || graph.edges.length,
    });
    const sections = this.buildGraphSummarySections(graph, topology);

    const items: GraphEvidenceItem[] = [
      {
        id: `summarize-subgraph-${Date.now()}`,
        kind: 'query',
        title: 'Subgraph summary',
        summary: sections.join('\n\n'),
        score: 0.86,
        nodeIds: graph.nodes.map((node) => node.key),
        edgeIds: graph.edges.map((edge) => edge.key),
        metadata: {
          selectedNodeCount: topology.selectedNodeCount,
          analyzedNodeCount: topology.analyzedNodeCount,
          selectedEdgeCount: topology.selectedEdgeCount,
          analyzedEdgeCount: topology.analyzedEdgeCount,
          graphShape: topology.graphShape,
          connectedComponents: topology.connectedComponents,
          prominentComponents: topology.prominentComponents,
          hubNodes: topology.hubNodes,
          centralNodes: topology.centralNodes,
          relationshipCounts: topology.relationshipCounts,
          dominantRelationships: topology.dominantRelationships,
          nodeTypeDistribution: topology.nodeTypeDistribution,
          density: topology.density,
          ontologyDiagnostics: topology.ontologyDiagnostics,
        },
      },
      ...this.buildNodeTypeEvidenceItems(graph, topology),
      ...this.buildRelationshipEvidenceItems(topology, graph),
    ];

    return {
      items,
      graph,
      highlightNodeIds: topology.centralNodes.map((node) => node.id),
      warnings: topology.ontologyDiagnostics.length
        ? [
            `Potential ontology typing mismatches were detected for ${topology.ontologyDiagnostics.length} node${topology.ontologyDiagnostics.length === 1 ? '' : 's'} in the analyzed graph.`,
          ]
        : [],
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
          summary: this.buildNodeSummary(node, relationships, graph),
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
    const scopedNodeIds = this.dedupeIds(nodeIds).slice(0, 2000);
    const { nodes, relationships } = await this.loadNodeSetSubgraph(
      scopedNodeIds,
      [],
      Math.min(6000, Math.max(240, scopedNodeIds.length * 4)),
    );
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
    const scopedNodeIds = this.dedupeIds(nodeIds).slice(0, 2000);
    const { nodes, relationships } = await this.loadNodeSetSubgraph(
      scopedNodeIds,
      [],
      Math.min(6000, Math.max(240, scopedNodeIds.length * 4)),
    );
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

  async analyzeSchema(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:analyze-schema');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for schema analysis.'] };
    }

    const crossTypeRelationships = this.computeCrossTypeRelationshipStats(scoped.graph).slice(0, 12);
    const items: GraphEvidenceItem[] = [
      {
        id: `schema-summary-${Date.now()}`,
        kind: 'query',
        title: 'Schema summary',
        summary: [
          `The active graph contains ${scoped.graph.nodes.length} nodes and ${scoped.graph.edges.length} edges.`,
          `Available node types: ${scoped.topology.nodeTypeDistribution.map(({ type, count }) => `${type} (${count})`).join(', ') || 'none identified'}.`,
          `Available relationship types: ${scoped.topology.relationshipCounts.map(({ relation, count }) => `${relation} (${count})`).join(', ') || 'none identified'}.`,
          crossTypeRelationships.length > 0
            ? `Cross-type relationships include ${crossTypeRelationships
                .slice(0, 6)
                .map((entry) => `${entry.sourceType} -[${entry.relation}]-> ${entry.targetType} (${entry.count})`)
                .join(', ')}.`
            : 'No cross-type relationship patterns were identified.',
        ].join(' '),
        score: 0.87,
        nodeIds: scoped.graph.nodes.map((node) => node.key),
        edgeIds: scoped.graph.edges.map((edge) => edge.key),
        metadata: {
          nodeTypeDistribution: scoped.topology.nodeTypeDistribution,
          relationshipCounts: scoped.topology.relationshipCounts,
          crossTypeRelationships,
        },
      },
      ...this.buildNodeTypeEvidenceItems(scoped.graph, scoped.topology),
      ...this.buildRelationshipEvidenceItems(scoped.topology, scoped.graph),
    ];

    return {
      items,
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
      warnings: scoped.topology.ontologyDiagnostics.length > 0
        ? [`Potential ontology typing mismatches were detected for ${scoped.topology.ontologyDiagnostics.length} node${scoped.topology.ontologyDiagnostics.length === 1 ? '' : 's'} during schema analysis.`]
        : [],
    };
  }

  async analyzeNodeTypes(
    nodeIds: string[],
    edgeIds: string[],
    targetTypes: string[] = [],
    title = 'Node-type analysis',
  ): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:analyze-node-types');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for node-type analysis.'] };
    }

    const filteredTypes = targetTypes.length > 0
      ? scoped.topology.nodeTypeDistribution.filter((entry) => this.matchesRequestedType(entry.type, targetTypes))
      : scoped.topology.nodeTypeDistribution;

    if (filteredTypes.length === 0) {
      return {
        items: [],
        graph: scoped.graph,
        warnings: [`No ${targetTypes.join(', ') || 'requested'} node types were present in the active graph.`],
      };
    }

    const items: GraphEvidenceItem[] = [
      {
        id: `node-type-analysis-${Date.now()}`,
        kind: 'query',
        title,
        summary: `${filteredTypes
          .map((entry) => `${entry.type} appears ${entry.count} time${entry.count === 1 ? '' : 's'}`)
          .join('; ')}.`,
        score: 0.82,
        nodeIds: scoped.graph.nodes.map((node) => node.key),
        edgeIds: scoped.graph.edges.map((edge) => edge.key),
        metadata: {
          nodeTypeDistribution: filteredTypes,
        },
      },
      ...filteredTypes.map((entry, index) => {
        const typedNodes = scoped.graph.nodes.filter((node) =>
          this.matchesRequestedType(String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity'), [entry.type]),
        );

        return {
          id: `node-type-detail-${index}-${entry.type}`,
          kind: 'query' as const,
          title: `${entry.type} nodes in active graph`,
          summary: `${entry.type} appears ${entry.count} time${entry.count === 1 ? '' : 's'} in the active graph. Example nodes: ${entry.sampleLabels.slice(0, 6).join(', ') || 'none available'}.`,
          score: 0.76,
          nodeIds: typedNodes.slice(0, 24).map((node) => node.key),
          edgeIds: scoped.graph.edges
            .filter((edge) => typedNodes.some((node) => node.key === edge.source || node.key === edge.target))
            .slice(0, 40)
            .map((edge) => edge.key),
          metadata: {
            nodeType: entry.type,
            count: entry.count,
            sampleLabels: entry.sampleLabels,
          },
        };
      }),
    ];

    return {
      items,
      graph: scoped.graph,
      highlightNodeIds: filteredTypes
        .flatMap((entry) =>
          scoped.graph.nodes
            .filter((node) => this.matchesRequestedType(String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity'), [entry.type]))
            .slice(0, 6)
            .map((node) => node.key),
        )
        .slice(0, 24),
    };
  }

  async analyzeRelationshipTypes(
    nodeIds: string[],
    edgeIds: string[],
    sourceTypes: string[] = [],
    targetTypes: string[] = [],
    title = 'Relationship analysis',
  ): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:analyze-relationships');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for relationship analysis.'] };
    }

    const crossTypeRelationships = this.computeCrossTypeRelationshipStats(scoped.graph).filter((entry) => {
      const sourceMatch = sourceTypes.length === 0 || this.matchesRequestedType(entry.sourceType, sourceTypes);
      const targetMatch = targetTypes.length === 0 || this.matchesRequestedType(entry.targetType, targetTypes);
      return sourceMatch && targetMatch;
    });
    const dominantRelationships = scoped.topology.dominantRelationships;

    const items: GraphEvidenceItem[] = [
      {
        id: `relationship-analysis-${Date.now()}`,
        kind: 'query',
        title,
        summary: [
          dominantRelationships.length > 0
            ? `Dominant relationship types: ${dominantRelationships
                .slice(0, 8)
                .map((entry) => `${entry.relation} (${entry.count}, ${(entry.coverage * 100).toFixed(1)}%)`)
                .join(', ')}.`
            : 'No relationship types were identified in the active graph.',
          crossTypeRelationships.length > 0
            ? `Cross-type patterns include ${crossTypeRelationships
                .slice(0, 8)
                .map((entry) => `${entry.sourceType} -[${entry.relation}]-> ${entry.targetType} (${entry.count})`)
                .join(', ')}.`
            : 'No cross-type relationship patterns matched the requested filter.',
          `Overall graph density is ${scoped.topology.density.toFixed(4)}.`,
        ].join(' '),
        score: 0.83,
        nodeIds: scoped.graph.nodes.map((node) => node.key),
        edgeIds: scoped.graph.edges.map((edge) => edge.key),
        metadata: {
          dominantRelationships,
          crossTypeRelationships,
          density: scoped.topology.density,
        },
      },
      ...this.buildRelationshipEvidenceItems(scoped.topology, scoped.graph).slice(0, 12),
    ];

    return {
      items,
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
      warnings: crossTypeRelationships.length === 0 && (sourceTypes.length > 0 || targetTypes.length > 0)
        ? ['No cross-type relationships matched the requested source or target type filter.']
        : [],
    };
  }

  async findAvailableNodeTypes(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, [], 'Available node types');
  }

  async findAvailableRelationshipTypes(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipTypes(nodeIds, edgeIds, [], [], 'Available relationship types');
  }

  async findCrossTypeRelationships(
    nodeIds: string[],
    edgeIds: string[],
    sourceTypes: string[] = [],
    targetTypes: string[] = [],
  ): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipTypes(nodeIds, edgeIds, sourceTypes, targetTypes, 'Cross-type relationships');
  }

  async findDominantRelationships(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipTypes(nodeIds, edgeIds, [], [], 'Dominant relationships');
  }

  async rankRelationshipTypes(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipTypes(nodeIds, edgeIds, [], [], 'Relationship type ranking');
  }

  async analyzeRelationshipPatterns(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipTypes(nodeIds, edgeIds, [], [], 'Relationship patterns');
  }

  async analyzeCrossTypeConnections(
    nodeIds: string[],
    edgeIds: string[],
    sourceTypes: string[] = [],
    targetTypes: string[] = [],
  ): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipTypes(nodeIds, edgeIds, sourceTypes, targetTypes, 'Cross-type connections');
  }

  async analyzeRelationshipDensity(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:relationship-density');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for relationship-density analysis.'] };
    }

    return {
      items: [
        {
          id: `relationship-density-${Date.now()}`,
          kind: 'query',
          title: 'Relationship density',
          summary: `The active graph contains ${scoped.graph.edges.length} edges across ${scoped.graph.nodes.length} nodes, with density ${scoped.topology.density.toFixed(4)}. Dominant relationships: ${scoped.topology.dominantRelationships
            .slice(0, 6)
            .map((entry) => `${entry.relation} (${entry.count})`)
            .join(', ') || 'none identified'}.`,
          score: 0.78,
          nodeIds: scoped.graph.nodes.map((node) => node.key),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            density: scoped.topology.density,
            dominantRelationships: scoped.topology.dominantRelationships,
          },
        },
      ],
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
    };
  }

  async analyzeGenes(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['Gene'], 'Gene analysis');
  }

  async analyzeDiseases(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['Disease'], 'Disease analysis');
  }

  async analyzeDrugs(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['Drug'], 'Drug analysis');
  }

  async analyzePathways(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['Pathway'], 'Pathway analysis');
  }

  async analyzePhenotypes(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['Phenotype'], 'Phenotype analysis');
  }

  async analyzeAnatomy(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['Anatomy'], 'Anatomy analysis');
  }

  async analyzeMolecularFunctions(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['MolecularFunction'], 'Molecular function analysis');
  }

  async analyzeCellularComponents(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['CellularComponent'], 'Cellular component analysis');
  }

  async analyzeExposures(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, ['Exposure'], 'Exposure analysis');
  }

  async computeGraphMetrics(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:graph-metrics');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for graph-metrics analysis.'] };
    }

    return {
      items: [
        {
          id: `graph-metrics-${Date.now()}`,
          kind: 'query',
          title: 'Graph metrics',
          summary: `The active graph has ${scoped.graph.nodes.length} nodes, ${scoped.graph.edges.length} edges, density ${scoped.topology.density.toFixed(4)}, ${scoped.topology.connectedComponents.length} connected component${scoped.topology.connectedComponents.length === 1 ? '' : 's'}, and graph shape ${scoped.topology.graphShape}.`,
          score: 0.8,
          nodeIds: scoped.graph.nodes.map((node) => node.key),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            density: scoped.topology.density,
            graphShape: scoped.topology.graphShape,
            connectedComponents: scoped.topology.connectedComponents,
            nodeTypeDistribution: scoped.topology.nodeTypeDistribution,
            relationshipCounts: scoped.topology.relationshipCounts,
          },
        },
      ],
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
    };
  }

  async computeNodeTypeDistribution(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeNodeTypes(nodeIds, edgeIds, [], 'Node-type distribution');
  }

  async computeRelationshipDistribution(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipTypes(nodeIds, edgeIds, [], [], 'Relationship distribution');
  }

  async computeCentralityMetrics(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:centrality-metrics');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for centrality analysis.'] };
    }

    return {
      items: [
        {
          id: `centrality-metrics-${Date.now()}`,
          kind: 'query',
          title: 'Centrality metrics',
          summary: `Central nodes in the active graph are ${scoped.topology.centralNodes
            .slice(0, 8)
            .map((node) => `${node.label} [${node.nodeType}] degree=${node.degree}, relation diversity=${node.relationDiversity}`)
            .join(', ') || 'not available'}. Hub nodes are ${scoped.topology.hubNodes
            .slice(0, 6)
            .map((node) => `${node.label} (${node.degree})`)
            .join(', ') || 'not available'}.`,
          score: 0.82,
          nodeIds: scoped.topology.centralNodes.map((node) => node.id),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            centralNodes: scoped.topology.centralNodes,
            hubNodes: scoped.topology.hubNodes,
          },
        },
      ],
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
    };
  }

  async computeDensityMetrics(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.analyzeRelationshipDensity(nodeIds, edgeIds);
  }

  async computeComponentStatistics(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:component-statistics');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for component statistics.'] };
    }

    return {
      items: [
        {
          id: `component-statistics-${Date.now()}`,
          kind: 'query',
          title: 'Component statistics',
          summary: `The active graph contains ${scoped.topology.connectedComponents.length} connected component${scoped.topology.connectedComponents.length === 1 ? '' : 's'}. Largest component size: ${scoped.topology.connectedComponents[0]?.size ?? 0}. Prominent components: ${scoped.topology.prominentComponents
            .slice(0, 6)
            .map((component) => `${component.size} nodes with dominant types ${component.dominantNodeTypes.join(', ')}`)
            .join('; ') || 'none available'}.`,
          score: 0.78,
          nodeIds: scoped.graph.nodes.map((node) => node.key),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            connectedComponents: scoped.topology.connectedComponents,
            prominentComponents: scoped.topology.prominentComponents,
          },
        },
      ],
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
    };
  }

  async detectCommunities(
    nodeIds: string[],
    edgeIds: string[],
    focusTypes: string[] = [],
    title = 'Detected communities',
  ): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:detect-communities');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for community detection.'] };
    }

    const communities = scoped.topology.connectedComponents
      .map((component, index) => {
        const typedCounts = new Map<string, number>();
        const labels: string[] = [];

        for (const nodeId of component.nodeIds) {
          const node = scoped.graph.nodes.find((candidate) => candidate.key === nodeId);
          if (!node) {
            continue;
          }

          const nodeType = String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity');
          typedCounts.set(nodeType, (typedCounts.get(nodeType) ?? 0) + 1);
          if (labels.length < 6) {
            labels.push(String(node.attributes.label ?? node.key));
          }
        }

        const dominantTypes = [...typedCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 4)
          .map(([type]) => type);

        return {
          id: `community-${index}`,
          size: component.size,
          dominantTypes,
          labels,
          nodeIds: component.nodeIds,
        };
      })
      .filter((community) =>
        focusTypes.length === 0 || community.dominantTypes.some((type) => this.matchesRequestedType(type, focusTypes)),
      );

    if (communities.length === 0) {
      return {
        items: [],
        graph: scoped.graph,
        warnings: ['No communities matched the requested type focus.'],
      };
    }

    return {
      items: [
        {
          id: `communities-${Date.now()}`,
          kind: 'query',
          title,
          summary: `Detected ${communities.length} graph communit${communities.length === 1 ? 'y' : 'ies'}. Largest modules: ${communities
            .slice(0, 6)
            .map((community) => `${community.size} nodes dominated by ${community.dominantTypes.join(', ') || 'mixed types'}`)
            .join('; ')}.`,
          score: 0.79,
          nodeIds: scoped.graph.nodes.map((node) => node.key),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            communities: communities.slice(0, 12),
          },
        },
        ...communities.slice(0, 8).map((community, index) => ({
          id: `community-detail-${index}`,
          kind: 'query' as const,
          title: `Community ${index + 1}`,
          summary: `Community ${index + 1} contains ${community.size} nodes. Dominant node types: ${community.dominantTypes.join(', ') || 'mixed'}. Example nodes: ${community.labels.join(', ') || 'none available'}.`,
          score: 0.73,
          nodeIds: community.nodeIds.slice(0, 40),
          edgeIds: scoped.graph.edges
            .filter((edge) => community.nodeIds.includes(edge.source) && community.nodeIds.includes(edge.target))
            .slice(0, 60)
            .map((edge) => edge.key),
          metadata: {
            size: community.size,
            dominantTypes: community.dominantTypes,
            labels: community.labels,
          },
        })),
      ],
      graph: scoped.graph,
      highlightNodeIds: communities.flatMap((community) => community.nodeIds.slice(0, 2)).slice(0, 16),
    };
  }

  async detectDiseaseModules(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.detectCommunities(nodeIds, edgeIds, ['Disease'], 'Disease modules');
  }

  async detectFunctionalModules(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.detectCommunities(nodeIds, edgeIds, ['Pathway', 'BiologicalProcess', 'MolecularFunction', 'CellularComponent'], 'Functional modules');
  }

  async detectGeneModules(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    return this.detectCommunities(nodeIds, edgeIds, ['Gene', 'Protein'], 'Gene modules');
  }

  async interpretSubgraph(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:interpret-subgraph');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for subgraph interpretation.'] };
    }

    const sections = this.buildGraphSummarySections(scoped.graph, scoped.topology);
    const theme = this.inferBiologicalInterpretation(scoped.graph, scoped.topology);

    return {
      items: [
        {
          id: `interpret-subgraph-${Date.now()}`,
          kind: 'query',
          title: 'Graph interpretation',
          summary: `${sections.join('\n\n')}\n\nGraph Theme: ${theme}.`,
          score: 0.88,
          nodeIds: scoped.graph.nodes.map((node) => node.key),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            graphShape: scoped.topology.graphShape,
            theme,
            centralNodes: scoped.topology.centralNodes,
            dominantRelationships: scoped.topology.dominantRelationships,
          },
        },
      ],
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
    };
  }

  async identifyGraphTheme(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:identify-graph-theme');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for graph-theme analysis.'] };
    }

    const theme = this.inferBiologicalInterpretation(scoped.graph, scoped.topology);
    return {
      items: [
        {
          id: `graph-theme-${Date.now()}`,
          kind: 'query',
          title: 'Graph theme',
          summary: `The dominant theme of the active graph is: ${theme}.`,
          score: 0.8,
          nodeIds: scoped.graph.nodes.map((node) => node.key),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            theme,
            graphShape: scoped.topology.graphShape,
            dominantRelationships: scoped.topology.dominantRelationships,
          },
        },
      ],
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
    };
  }

  async identifyCentralConcepts(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const scoped = await this.loadScopedGraphAnalysis(nodeIds, edgeIds, 'graph-analysis:identify-central-concepts');
    if (!scoped) {
      return { items: [], warnings: ['No graph context was available for central-concept analysis.'] };
    }

    return {
      items: [
        {
          id: `central-concepts-${Date.now()}`,
          kind: 'query',
          title: 'Central concepts',
          summary: `Central concepts in the active graph are ${scoped.topology.centralNodes
            .slice(0, 8)
            .map((node) => `${node.label} [${node.nodeType}]`)
            .join(', ') || 'not available'}.`,
          score: 0.79,
          nodeIds: scoped.topology.centralNodes.map((node) => node.id),
          edgeIds: scoped.graph.edges.map((edge) => edge.key),
          metadata: {
            centralNodes: scoped.topology.centralNodes,
          },
        },
      ],
      graph: scoped.graph,
      highlightNodeIds: scoped.topology.centralNodes.map((node) => node.id),
    };
  }

  async summarizeBiologicalNarrative(nodeIds: string[], edgeIds: string[]): Promise<GraphAnalysisResult> {
    const interpreted = await this.interpretSubgraph(nodeIds, edgeIds);
    if (interpreted.items.length === 0) {
      return interpreted;
    }

    const summary = interpreted.items[0];
    return {
      ...interpreted,
      items: [
        {
          ...summary,
          id: `biological-narrative-${Date.now()}`,
          title: 'Biological narrative',
          summary: `Biological narrative: ${summary.summary}`,
          score: 0.87,
        },
      ],
    };
  }

  async enrichDiseases(nodeIds: string[], limit = 20): Promise<GraphAnalysisResult> {
    return this.enrichConcepts(nodeIds, ['Disease'], 'Disease enrichment', limit);
  }

  async enrichPathways(nodeIds: string[], limit = 20): Promise<GraphAnalysisResult> {
    return this.enrichConcepts(nodeIds, ['Pathway'], 'Pathway enrichment', limit);
  }

  async enrichPhenotypes(nodeIds: string[], limit = 20): Promise<GraphAnalysisResult> {
    return this.enrichConcepts(nodeIds, ['Phenotype'], 'Phenotype enrichment', limit);
  }

  async enrichBiologicalProcesses(nodeIds: string[], limit = 20): Promise<GraphAnalysisResult> {
    return this.enrichConcepts(nodeIds, ['BiologicalProcess'], 'Biological process enrichment', limit);
  }

  async enrichMolecularFunctions(nodeIds: string[], limit = 20): Promise<GraphAnalysisResult> {
    return this.enrichConcepts(nodeIds, ['MolecularFunction'], 'Molecular function enrichment', limit);
  }

  async enrichCellularComponents(nodeIds: string[], limit = 20): Promise<GraphAnalysisResult> {
    return this.enrichConcepts(nodeIds, ['CellularComponent'], 'Cellular component enrichment', limit);
  }

  async enrichAnatomy(nodeIds: string[], limit = 20): Promise<GraphAnalysisResult> {
    return this.enrichConcepts(nodeIds, ['Anatomy'], 'Anatomy enrichment', limit);
  }

  async findParents(rootId: string, maxDepth = 1): Promise<GraphAnalysisResult> {
    return this.exploreOntologyHierarchy(rootId, 'parents', maxDepth, 'Ontology parents');
  }

  async findChildren(rootId: string, maxDepth = 1): Promise<GraphAnalysisResult> {
    return this.exploreOntologyHierarchy(rootId, 'children', maxDepth, 'Ontology children');
  }

  async findAncestors(rootId: string, maxDepth = 4): Promise<GraphAnalysisResult> {
    return this.exploreOntologyHierarchy(rootId, 'ancestors', maxDepth, 'Ontology ancestors');
  }

  async findDescendants(rootId: string, maxDepth = 4): Promise<GraphAnalysisResult> {
    return this.exploreOntologyHierarchy(rootId, 'descendants', maxDepth, 'Ontology descendants');
  }

  async findOntologyRoots(rootId: string, maxDepth = 6): Promise<GraphAnalysisResult> {
    return this.exploreOntologyHierarchy(rootId, 'roots', maxDepth, 'Ontology roots');
  }

  async exploreOntologyHierarchy(
    rootId: string,
    direction: 'parents' | 'children' | 'ancestors' | 'descendants' | 'roots',
    maxDepth = 4,
    title = 'Ontology hierarchy',
  ): Promise<GraphAnalysisResult> {
    if (!rootId) {
      return { items: [], warnings: ['No ontology anchor node was available.'] };
    }

    const boundedMaxDepth = Math.max(1, Math.min(maxDepth, 8));
    const directions = this.pickHierarchyDirections(direction);
    let records: Array<{ get(key: string): unknown }> = [];
    let directionUsed = directions[0];

    const session = this.neo4jService.getSession();
    try {
      for (const candidateDirection of directions) {
        const pattern =
          candidateDirection === 'outgoing'
            ? `MATCH path = (root:Entity {id: $rootId})-[rels*1..${boundedMaxDepth}]->(target:Entity)`
            : `MATCH path = (root:Entity {id: $rootId})<-[rels*1..${boundedMaxDepth}]-(target:Entity)`;

        const result = await session.run(
          `
            ${pattern}
            WHERE ALL(rel IN rels WHERE type(rel) IN $hierarchyTypes)
            RETURN root, target, nodes(path) AS pathNodes, relationships(path) AS pathRelationships, length(path) AS depth
            ORDER BY depth ASC, target.displayName
            LIMIT $limit
          `,
          {
            rootId,
            hierarchyTypes: HIERARCHY_RELATION_TYPES,
            limit: neo4j.int(60),
          },
          { timeout: GRAPH_ANALYSIS_QUERY_TIMEOUT_MS },
        );

        if (result.records.length > 0) {
          records = result.records;
          directionUsed = candidateDirection;
          break;
        }
      }
    } finally {
      await this.neo4jService.releaseSession(session);
    }

    if (records.length === 0) {
      return {
        items: [],
        warnings: [`No ontology ${direction} were found for the requested concept.`],
      };
    }

    const nodes: Neo4jNode[] = [];
    const relationships: Neo4jRelationship[] = [];
    const items: GraphEvidenceItem[] = [];
    const rootTargets: Array<{ id: string; label: string; depth: number }> = [];

    for (const [index, record] of records.entries()) {
      const root = record.get('root') as Neo4jNode;
      const target = record.get('target') as Neo4jNode;
      const pathNodes = record.get('pathNodes') as Neo4jNode[];
      const pathRelationships = record.get('pathRelationships') as Neo4jRelationship[];
      const depth = toNumber(record.get('depth'));

      nodes.push(root, target, ...pathNodes);
      relationships.push(...pathRelationships);
      rootTargets.push({
        id: String(target.properties.id),
        label: String(target.properties.displayName),
        depth,
      });

      items.push({
        id: `ontology-${direction}-${index}-${String(target.properties.id)}`,
        kind: 'path',
        title: `${title}: ${String(target.properties.displayName)}`,
        summary: `${String(target.properties.displayName)} is ${depth} step${depth === 1 ? '' : 's'} away from ${String(root.properties.displayName)} in the ${direction} hierarchy.`,
        score: Math.max(0.64, 0.9 - index * 0.03),
        nodeIds: pathNodes.map((node) => String(node.properties.id)),
        edgeIds: pathRelationships.map((relationship) => String(relationship.properties.edgeKey ?? relationship.elementId)),
        metadata: {
          depth,
          direction: directionUsed,
        },
      });
    }

    return {
      items: [
        {
          id: `ontology-summary-${Date.now()}`,
          kind: 'query',
          title,
          summary: `${title} for the requested concept: ${rootTargets
            .slice(0, 10)
            .map((target) => `${target.label} (depth ${target.depth})`)
            .join(', ')}.`,
          score: 0.82,
          nodeIds: Array.from(new Set(rootTargets.map((target) => target.id))),
          edgeIds: Array.from(new Set(relationships.map((relationship) => String(relationship.properties.edgeKey ?? relationship.elementId)))),
          metadata: {
            directionUsed,
            targets: rootTargets.slice(0, 20),
          },
        },
        ...items.slice(0, 12),
      ],
      graph: serializeGraphFromRecords(nodes, relationships, {
        retrieval: `graph-analysis:ontology-${direction}`,
        rootId,
      }),
      highlightNodeIds: Array.from(new Set([rootId, ...rootTargets.map((target) => target.id)])).slice(0, 24),
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
        { timeout: GRAPH_ANALYSIS_QUERY_TIMEOUT_MS },
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

  private async loadNodeSetSubgraph(
    nodeIds: string[],
    edgeIds: string[],
    limit: number,
    options: { preferExplicitEdges?: boolean } = {},
  ) {
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
            { timeout: GRAPH_ANALYSIS_QUERY_TIMEOUT_MS },
          )
        : { records: [] as Array<{ get(key: string): Neo4jNode }> };

      const relationshipRecords: Array<{ get(key: string): Neo4jNode | Neo4jRelationship }> = [];

      if (dedupedNodeIds.length > 0 && !(options.preferExplicitEdges && dedupedEdgeIds.length > 0)) {
        const nodeScopedRelationships = await session.run(
          `
            MATCH (source:Entity)-[rel]-(target:Entity)
            WHERE source.id IN $nodeIds
              AND target.id IN $nodeIds
            RETURN source, rel, target
            LIMIT $limit
          `,
          {
            nodeIds: dedupedNodeIds,
            limit: neo4j.int(Math.max(1, limit)),
          },
          { timeout: GRAPH_ANALYSIS_QUERY_TIMEOUT_MS },
        );
        relationshipRecords.push(...nodeScopedRelationships.records);
      }

      if (dedupedEdgeIds.length > 0) {
        const edgeScopedRelationships = await session.run(
          `
            MATCH (source:Entity)-[rel]-(target:Entity)
            WHERE coalesce(rel.edgeKey, rel.elementId) IN $edgeIds OR rel.elementId IN $edgeIds
            RETURN source, rel, target
            LIMIT $limit
          `,
          {
            edgeIds: dedupedEdgeIds,
            limit: neo4j.int(Math.max(1, limit)),
          },
          { timeout: GRAPH_ANALYSIS_QUERY_TIMEOUT_MS },
        );
        relationshipRecords.push(...edgeScopedRelationships.records);
      }

      const nodes = nodeResult.records.map((record) => record.get('node') as Neo4jNode);
      const relationshipNodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];

      for (const record of relationshipRecords) {
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

  private buildNodeSummary(
    node: SerializedGraphPayload['nodes'][number],
    relationships: Neo4jRelationship[],
    graph: SerializedGraphPayload,
  ) {
    const connectedRelations = relationships.filter((relationship) => {
      const props = relationship.properties as Record<string, unknown>;
      return String(props.fromId) === node.key || String(props.toId) === node.key;
    });
    const relationTypes = Array.from(new Set(connectedRelations.map((relationship) => relationship.type)));
    const description = this.extractNodeDescription(node);
    const aliases = this.extractNodeAliases(node);
    const ontologyCategory = String(
      node.attributes.ontologyCategory ?? node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity',
    );
    const nodeDegree = graph.edges.filter((edge) => edge.source === node.key || edge.target === node.key).length;
    const aliasText = aliases.length > 0 ? ` Aliases: ${aliases.slice(0, 4).join(', ')}.` : '';
    const relationText =
      relationTypes.length > 0 ? ` Relationship types in this subgraph: ${relationTypes.slice(0, 5).join(', ')}.` : '';
    return `${String(node.attributes.label ?? node.key)} is typed as ${ontologyCategory} and has degree ${nodeDegree}.${description ? ` ${description}` : ''}${aliasText}${relationText}`;
  }

  private analyzeGraphTopology(
    graph: SerializedGraphPayload,
    counts: {
      selectedNodeCount?: number;
      selectedEdgeCount?: number;
    },
  ): GraphTopologySummary {
    const adjacency = new Map<string, Set<string>>();
    const relationByNode = new Map<string, Set<string>>();
    const typeCounts = new Map<string, { count: number; sampleLabels: string[] }>();
    const relationshipCounts = new Map<string, number>();
    const degreeByNode = new Map<string, number>();

    for (const node of graph.nodes) {
      adjacency.set(node.key, new Set());
      relationByNode.set(node.key, new Set());
      const type = String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity');
      const existingType = typeCounts.get(type) ?? { count: 0, sampleLabels: [] };
      existingType.count += 1;
      const label = String(node.attributes.label ?? node.key);
      if (existingType.sampleLabels.length < 5 && !existingType.sampleLabels.includes(label)) {
        existingType.sampleLabels.push(label);
      }
      typeCounts.set(type, existingType);
    }

    for (const edge of graph.edges) {
      const relation = String(edge.attributes.relation ?? edge.attributes.edgeType ?? edge.attributes.label ?? 'RELATED_TO');
      relationshipCounts.set(relation, (relationshipCounts.get(relation) ?? 0) + 1);
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
      relationByNode.get(edge.source)?.add(relation);
      relationByNode.get(edge.target)?.add(relation);
      degreeByNode.set(edge.source, (degreeByNode.get(edge.source) ?? 0) + 1);
      degreeByNode.set(edge.target, (degreeByNode.get(edge.target) ?? 0) + 1);
    }

    const connectedComponents = this.computeConnectedComponents(
      graph.nodes.map((node) => node.key),
      adjacency,
    );
    const hubNodes = this.rankHubNodes(graph).slice(0, 6);
    const centralNodes = graph.nodes
      .map((node) => ({
        id: node.key,
        label: String(node.attributes.label ?? node.key),
        degree: degreeByNode.get(node.key) ?? 0,
        relationDiversity: relationByNode.get(node.key)?.size ?? 0,
        nodeType: String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity'),
        descriptionBoost: this.extractNodeDescription(node).length > 0 ? 1 : 0,
      }))
      .sort(
        (a, b) =>
          b.degree * 2 +
            b.relationDiversity * 0.8 +
            b.descriptionBoost -
            (a.degree * 2 + a.relationDiversity * 0.8 + a.descriptionBoost) ||
          a.label.localeCompare(b.label),
      )
      .slice(0, 6)
      .map(({ descriptionBoost: _descriptionBoost, ...rest }) => rest);
    const density =
      graph.nodes.length > 1 ? (2 * graph.edges.length) / (graph.nodes.length * (graph.nodes.length - 1)) : 0;
    const nodeTypeDistribution = [...typeCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([type, value]) => ({ type, count: value.count, sampleLabels: value.sampleLabels }));
    const dominantRelationships = [...relationshipCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([relation, count]) => ({
        relation,
        count,
        coverage: graph.edges.length > 0 ? count / graph.edges.length : 0,
      }));

    return {
      selectedNodeCount: counts.selectedNodeCount ?? graph.nodes.length,
      analyzedNodeCount: graph.nodes.length,
      selectedEdgeCount: counts.selectedEdgeCount ?? graph.edges.length,
      analyzedEdgeCount: graph.edges.length,
      graphShape: this.inferGraphShape({
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        components: connectedComponents,
        hubNodes,
        density,
      }),
      connectedComponents,
      hubNodes,
      centralNodes,
      relationshipCounts: [...relationshipCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([relation, count]) => ({ relation, count })),
      nodeTypeDistribution,
      dominantRelationships,
      prominentComponents: this.buildProminentComponents(graph, connectedComponents, nodeTypeDistribution),
      density,
      ontologyDiagnostics: this.detectOntologyTypeIssues(graph.nodes),
    };
  }

  private buildGraphSummarySections(graph: SerializedGraphPayload, topology: GraphTopologySummary) {
    const overview =
      topology.selectedNodeCount !== topology.analyzedNodeCount || topology.selectedEdgeCount !== topology.analyzedEdgeCount
        ? `Graph Overview: The selected context contains ${topology.selectedNodeCount} node${topology.selectedNodeCount === 1 ? '' : 's'} and ${topology.selectedEdgeCount} edge${topology.selectedEdgeCount === 1 ? '' : 's'}. OptimusKG analysis loaded ${topology.analyzedNodeCount} node${topology.analyzedNodeCount === 1 ? '' : 's'} and ${topology.analyzedEdgeCount} edge${topology.analyzedEdgeCount === 1 ? '' : 's'} from that graph context.`
        : `Graph Overview: The analyzed graph contains ${topology.analyzedNodeCount} node${topology.analyzedNodeCount === 1 ? '' : 's'} and ${topology.analyzedEdgeCount} edge${topology.analyzedEdgeCount === 1 ? '' : 's'}.`;
    const keyEntities = `Key Entities: ${this.summarizeKeyEntities(graph, topology)}.`;
    const graphStructure = `Graph Structure: ${topology.graphShape} with ${topology.connectedComponents.length} connected component${topology.connectedComponents.length === 1 ? '' : 's'}${topology.connectedComponents.length > 0 ? ` (largest component size ${topology.connectedComponents[0].size})` : ''}. Node-type distribution: ${topology.nodeTypeDistribution
      .slice(0, 10)
      .map(({ type, count }) => `${type} (${count})`)
      .join(', ') || 'not available'}.`;
    const majorRelationshipTypes = `Major Relationship Types: ${topology.dominantRelationships
      .slice(0, 8)
      .map(({ relation, count, coverage }) => `${relation} (${count}, ${(coverage * 100).toFixed(1)}%)`)
      .join(', ') || 'none identified'}.`;
    const centralNodes = `Central Nodes: ${topology.centralNodes
      .slice(0, 5)
      .map((node) => `${node.label} [${node.nodeType}] degree=${node.degree}`)
      .join(', ') || 'no central nodes identified'}.`;
    const biologicalInterpretation = `Biological Interpretation: ${this.inferBiologicalInterpretation(graph, topology)}.`;

    return [overview, keyEntities, graphStructure, majorRelationshipTypes, centralNodes, biologicalInterpretation];
  }

  private summarizeKeyEntities(graph: SerializedGraphPayload, topology: GraphTopologySummary) {
    return topology.centralNodes
      .slice(0, 4)
      .map((centralNode) => {
        const node = graph.nodes.find((candidate) => candidate.key === centralNode.id);
        if (!node) {
          return `${centralNode.label} [${centralNode.nodeType}]`;
        }
        const description = this.extractNodeDescription(node);
        const aliases = this.extractNodeAliases(node);
        const aliasText = aliases.length > 0 ? `aliases ${aliases.slice(0, 3).join(', ')}` : '';
        return `${centralNode.label} [${centralNode.nodeType}]${description ? `: ${description}` : aliasText ? ` with ${aliasText}` : ''}`;
      })
      .join('; ');
  }

  private inferBiologicalInterpretation(graph: SerializedGraphPayload, topology: GraphTopologySummary) {
    const topRelation = topology.relationshipCounts[0]?.relation ?? '';
    const topCentralNode = graph.nodes.find((node) => node.key === topology.centralNodes[0]?.id);
    const topLabel = String(topCentralNode?.attributes.label ?? topology.centralNodes[0]?.label ?? '');
    const topType = String(topCentralNode?.attributes.nodeType ?? topology.centralNodes[0]?.nodeType ?? 'Entity');
    const measurementLike =
      /\bmeasurement\b|\bmetabolite\b|\bassay\b|\blevel\b/i.test(topLabel) ||
      /\bmeasurement\b|\bmetabolite\b|\bassay\b|\blevel\b/i.test(this.extractNodeDescription(topCentralNode));
    const hasGenes = topology.nodeTypeDistribution.some(({ type }) => /gene|protein/i.test(type));
    const hasDiseases = topology.nodeTypeDistribution.some(({ type }) => /disease|phenotype|syndrome|disorder/i.test(type));
    const hasPathways = topology.nodeTypeDistribution.some(({ type }) => /pathway/i.test(type));
    const hasDrugs = topology.nodeTypeDistribution.some(({ type }) => /drug/i.test(type));

    if (measurementLike && /ASSOCIATED_WITH/i.test(topRelation) && hasGenes) {
      return `the selected graph is centered on a measurement-like phenotype linked to multiple genes, with ${topology.centralNodes[0]?.label ?? 'a central measurement node'} acting as the hub`;
    }
    if (/TARGET/i.test(topRelation) && hasDrugs) {
      return 'the selected graph looks like a drug-target module connecting therapeutics to molecular targets';
    }
    if (/INTERACTS_WITH/i.test(topRelation) && hasGenes) {
      return 'the selected graph emphasizes molecular interaction structure among genes or proteins rather than disease-level associations';
    }
    if (hasDiseases && hasGenes) {
      return 'the selected graph links disease or phenotype concepts to genes or proteins and suggests a disease-mechanism module';
    }
    if (hasPathways && hasGenes) {
      return 'the selected graph mixes molecular entities with pathway context, suggesting a mechanism-oriented module';
    }
    if (topology.nodeTypeDistribution.length > 0) {
      const dominantTypes = topology.nodeTypeDistribution
        .slice(0, 3)
        .map(({ type }) => type)
        .join(', ');
      return `${topology.graphShape} graph dominated by ${dominantTypes} nodes and ${topology.dominantRelationships
        .slice(0, 3)
        .map(({ relation }) => relation)
        .join(', ') || 'graph relationships'}`;
    }

    return `${topology.graphShape} centered on ${topLabel || 'the selected entities'} with ${topType} nodes connected through ${topology.relationshipCounts
      .slice(0, 3)
      .map(({ relation }) => relation)
      .join(', ') || 'graph relationships'}`;
  }

  private computeConnectedComponents(nodeIds: string[], adjacency: Map<string, Set<string>>) {
    const visited = new Set<string>();
    const components: Array<{ size: number; nodeIds: string[] }> = [];

    for (const nodeId of nodeIds) {
      if (visited.has(nodeId)) {
        continue;
      }

      const queue = [nodeId];
      const componentNodeIds: string[] = [];
      visited.add(nodeId);

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
          continue;
        }
        componentNodeIds.push(current);

        for (const neighbor of adjacency.get(current) ?? []) {
          if (visited.has(neighbor)) {
            continue;
          }
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }

      components.push({
        size: componentNodeIds.length,
        nodeIds: componentNodeIds.sort((a, b) => a.localeCompare(b)),
      });
    }

    return components.sort((a, b) => b.size - a.size || (a.nodeIds[0] ?? '').localeCompare(b.nodeIds[0] ?? ''));
  }

  private inferGraphShape(params: {
    nodeCount: number;
    edgeCount: number;
    components: Array<{ size: number; nodeIds: string[] }>;
    hubNodes: Array<{ degree: number }>;
    density: number;
  }): GraphTopologySummary['graphShape'] {
    const { nodeCount, edgeCount, components, hubNodes, density } = params;
    if (nodeCount <= 1) {
      return 'single-node';
    }
    if (components.length > 1) {
      return 'mixed';
    }

    const maxDegree = hubNodes[0]?.degree ?? 0;
    const secondDegree = hubNodes[1]?.degree ?? 0;

    if (maxDegree >= nodeCount - 1 && secondDegree <= 2) {
      return 'star graph';
    }
    if (maxDegree >= Math.max(3, Math.ceil(nodeCount * 0.45))) {
      return 'hub-and-spoke graph';
    }
    if (edgeCount === nodeCount - 1) {
      return hubNodes.filter((hub) => hub.degree <= 2).length >= nodeCount - 2 ? 'path' : 'tree';
    }
    if (density >= 0.35) {
      return 'cluster';
    }

    return 'mixed';
  }

  private detectOntologyTypeIssues(nodes: SerializedGraphPayload['nodes']) {
    return nodes
      .flatMap((node) => {
        const label = String(node.attributes.label ?? node.key);
        const description = this.extractNodeDescription(node);
        const nodeType = String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity');
        const text = `${label} ${description}`.toLowerCase();

        if (
          /measurement|metabolite|assay|level/.test(text) &&
          /(disease|phenotype|syndrome|disorder)/i.test(nodeType)
        ) {
          return [
            {
              nodeId: node.key,
              label,
              nodeType,
              reason: 'label or description suggests a measurement-like entity but the ontology type is disease-like',
            },
          ];
        }

        return [];
      })
      .slice(0, 8);
  }

  private pickSummaryNodes(graph: SerializedGraphPayload, topology: GraphTopologySummary) {
    const summaryNodeIds = new Set(topology.centralNodes.map((node) => node.id));
    return graph.nodes
      .filter((node) => summaryNodeIds.has(node.key))
      .sort((a, b) => {
        const aIndex = topology.centralNodes.findIndex((node) => node.id === a.key);
        const bIndex = topology.centralNodes.findIndex((node) => node.id === b.key);
        return aIndex - bIndex;
      });
  }

  private extractNodeDescription(node: SerializedGraphPayload['nodes'][number] | undefined) {
    if (!node) {
      return '';
    }

    const description =
      typeof node.attributes.description === 'string'
        ? node.attributes.description
        : typeof node.attributes.name === 'string'
          ? `${node.attributes.name}`
          : '';

    return description.trim().replace(/\s+/g, ' ').slice(0, 220);
  }

  private extractNodeAliases(node: SerializedGraphPayload['nodes'][number]) {
    if (Array.isArray(node.attributes.aliases)) {
      return node.attributes.aliases.filter((value): value is string => typeof value === 'string' && value.length > 0);
    }
    if (Array.isArray(node.attributes.searchTerms)) {
      return node.attributes.searchTerms.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
    }

    return [];
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

  private buildNodeTypeEvidenceItems(graph: SerializedGraphPayload, topology: GraphTopologySummary) {
    return topology.nodeTypeDistribution.slice(0, 12).map((entry, index) => {
      const typedNodes = graph.nodes.filter((node) => {
        const nodeType = String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity');
        return nodeType === entry.type;
      });

      return {
        id: `node-type-summary-${index}-${entry.type}`,
        kind: 'query' as const,
        title: `${entry.type} nodes present in graph`,
        summary: `${entry.type} appears ${entry.count} time${entry.count === 1 ? '' : 's'} in the visible graph. Example nodes: ${entry.sampleLabels.slice(0, 6).join(', ') || 'none available'}.`,
        score: 0.74,
        nodeIds: typedNodes.slice(0, 20).map((node) => node.key),
        edgeIds: graph.edges
          .filter((edge) => typedNodes.some((node) => node.key === edge.source || node.key === edge.target))
          .slice(0, 40)
          .map((edge) => edge.key),
        metadata: {
          nodeType: entry.type,
          count: entry.count,
          sampleLabels: entry.sampleLabels,
        },
      };
    });
  }

  private buildRelationshipEvidenceItems(topology: GraphTopologySummary, graph: SerializedGraphPayload) {
    return topology.dominantRelationships.slice(0, 8).map((entry, index) => ({
      id: `relationship-summary-${index}-${entry.relation}`,
      kind: 'relation' as const,
      title: `${entry.relation} relationships in graph`,
      summary: `${entry.relation} appears ${entry.count} time${entry.count === 1 ? '' : 's'} and covers ${(entry.coverage * 100).toFixed(1)}% of the visible graph relationships.`,
      score: 0.72,
      nodeIds: graph.edges
        .filter((edge) => String(edge.attributes.relation ?? edge.attributes.edgeType ?? edge.attributes.label ?? 'RELATED_TO') === entry.relation)
        .slice(0, 20)
        .flatMap((edge) => [edge.source, edge.target]),
      edgeIds: graph.edges
        .filter((edge) => String(edge.attributes.relation ?? edge.attributes.edgeType ?? edge.attributes.label ?? 'RELATED_TO') === entry.relation)
        .slice(0, 40)
        .map((edge) => edge.key),
      metadata: {
        relation: entry.relation,
        count: entry.count,
        coverage: entry.coverage,
      },
    }));
  }

  private buildProminentComponents(
    graph: SerializedGraphPayload,
    components: Array<{ size: number; nodeIds: string[] }>,
    nodeTypeDistribution: Array<{ type: string; count: number; sampleLabels: string[] }>,
  ) {
    if (components.length === 0) {
      return [];
    }

    return components.slice(0, 6).map((component) => {
      const typeCounts = new Map<string, number>();
      for (const nodeId of component.nodeIds) {
        const node = graph.nodes.find((candidate) => candidate.key === nodeId);
        if (!node) {
          continue;
        }
        const nodeType = String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity');
        typeCounts.set(nodeType, (typeCounts.get(nodeType) ?? 0) + 1);
      }

      const dominantNodeTypes = [...typeCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([type]) => type);

      return {
        size: component.size,
        dominantNodeTypes: dominantNodeTypes.length > 0 ? dominantNodeTypes : nodeTypeDistribution.slice(0, 3).map(({ type }) => type),
      };
    });
  }

  private dedupeIds(values: string[]) {
    return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
  }

  private async loadScopedGraphAnalysis(
    nodeIds: string[],
    edgeIds: string[],
    retrievalLabel: string,
  ) {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, DEFAULT_GRAPH_ANALYSIS_NODE_LIMIT);
    const dedupedEdgeIds = this.dedupeIds(edgeIds).slice(0, DEFAULT_GRAPH_ANALYSIS_EDGE_LIMIT);

    if (dedupedNodeIds.length === 0 && dedupedEdgeIds.length === 0) {
      return null;
    }

    const { nodes, relationships } = await this.loadNodeSetSubgraph(
      dedupedNodeIds,
      dedupedEdgeIds,
      Math.min(
        8000,
        Math.max(
          320,
          dedupedNodeIds.length + dedupedEdgeIds.length,
          dedupedNodeIds.length * 4,
          dedupedEdgeIds.length * 2,
        ),
      ),
      { preferExplicitEdges: dedupedEdgeIds.length > 0 && dedupedNodeIds.length > 0 },
    );

    if (nodes.length === 0 && relationships.length === 0) {
      return null;
    }

    const graph = serializeGraphFromRecords(nodes, relationships, {
      retrieval: retrievalLabel,
      nodeIds: dedupedNodeIds,
      edgeIds: dedupedEdgeIds,
    });
    const topology = this.analyzeGraphTopology(graph, {
      selectedNodeCount: dedupedNodeIds.length || graph.nodes.length,
      selectedEdgeCount: dedupedEdgeIds.length || graph.edges.length,
    });

    return {
      graph,
      relationships,
      topology,
      dedupedNodeIds,
      dedupedEdgeIds,
    };
  }

  private computeCrossTypeRelationshipStats(graph: SerializedGraphPayload) {
    const nodeTypeById = new Map(
      graph.nodes.map((node) => [
        node.key,
        String(node.attributes.nodeType ?? node.attributes.typeCode ?? 'Entity'),
      ]),
    );
    const counts = new Map<string, { sourceType: string; relation: string; targetType: string; count: number }>();

    for (const edge of graph.edges) {
      const sourceType = nodeTypeById.get(edge.source) ?? 'Entity';
      const targetType = nodeTypeById.get(edge.target) ?? 'Entity';
      const relation = String(edge.attributes.relation ?? edge.attributes.edgeType ?? edge.attributes.label ?? 'RELATED_TO');
      const key = `${sourceType}::${relation}::${targetType}`;
      const existing = counts.get(key) ?? { sourceType, relation, targetType, count: 0 };
      existing.count += 1;
      counts.set(key, existing);
    }

    return [...counts.values()].sort(
      (a, b) =>
        b.count - a.count ||
        a.sourceType.localeCompare(b.sourceType) ||
        a.relation.localeCompare(b.relation) ||
        a.targetType.localeCompare(b.targetType),
    );
  }

  private matchesRequestedType(nodeType: string, requestedTypes: string[]) {
    const normalizedNodeType = this.normalizeType(nodeType);
    return requestedTypes.some((requestedType) => {
      const normalizedRequestedType = this.normalizeType(requestedType);
      if (normalizedNodeType === normalizedRequestedType) {
        return true;
      }

      const aliases = Object.entries(NODE_TYPE_ALIASES).find(([canonical]) => this.normalizeType(canonical) === normalizedRequestedType)?.[1] ?? [];
      if (aliases.some((alias) => normalizedNodeType.includes(this.normalizeType(alias)) || this.normalizeType(alias).includes(normalizedNodeType))) {
        return true;
      }

      const reverseAliases = NODE_TYPE_ALIASES[nodeType] ?? [];
      return reverseAliases.some((alias) => this.normalizeType(alias) === normalizedRequestedType);
    });
  }

  private normalizeType(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private pickHierarchyDirections(direction: 'parents' | 'children' | 'ancestors' | 'descendants' | 'roots') {
    switch (direction) {
      case 'parents':
      case 'ancestors':
      case 'roots':
        return ['outgoing', 'incoming'] as const;
      case 'children':
      case 'descendants':
      default:
        return ['incoming', 'outgoing'] as const;
    }
  }

  private async enrichConcepts(nodeIds: string[], targetTypes: string[], title: string, limit: number) {
    const dedupedNodeIds = this.dedupeIds(nodeIds).slice(0, 64);
    if (dedupedNodeIds.length === 0) {
      return {
        items: [],
        warnings: ['No seed nodes were available for enrichment analysis.'],
      };
    }

    const session = this.neo4jService.getSession();
    try {
      const result = await session.run(
        `
          MATCH (seed:Entity)-[rel]-(concept:Entity)
          WHERE seed.id IN $nodeIds
            AND (
              size($targetTypes) = 0
              OR concept.typeName IN $targetTypes
              OR concept.typeCode IN $targetTypes
            )
          WITH concept, collect(DISTINCT seed) AS seeds, collect(rel) AS rels
          WHERE size(seeds) >= 1
          RETURN concept, seeds, rels,
            size(seeds) AS support,
            reduce(total = 0.0, relationship IN rels | total + coalesce(relationship.score, 0.0)) AS totalScore
          ORDER BY support DESC, totalScore DESC, concept.displayName
          LIMIT $limit
        `,
        {
          nodeIds: dedupedNodeIds,
          targetTypes,
          limit: neo4j.int(Math.max(1, limit)),
        },
        { timeout: GRAPH_ANALYSIS_QUERY_TIMEOUT_MS },
      );

      const nodes: Neo4jNode[] = [];
      const relationships: Neo4jRelationship[] = [];
      const items: GraphEvidenceItem[] = [];
      const highlightNodeIds = new Set<string>(dedupedNodeIds);

      for (const [index, record] of result.records.entries()) {
        const concept = record.get('concept') as Neo4jNode;
        const seeds = record.get('seeds') as Neo4jNode[];
        const rels = record.get('rels') as Neo4jRelationship[];
        const support = toNumber(record.get('support'));
        const totalScore = toNumber(record.get('totalScore'));
        const provenance = rels.flatMap((relationship) => {
          const props = relationship.properties as Record<string, unknown>;
          return [...parseStringArray(props.sourceDirect), ...parseStringArray(props.sourceIndirect)];
        });

        nodes.push(concept, ...seeds);
        relationships.push(...rels);
        highlightNodeIds.add(String(concept.properties.id));

        items.push({
          id: `enrichment-${String(concept.properties.id)}-${index}`,
          kind: 'query',
          title: `${title}: ${String(concept.properties.displayName)}`,
          summary: `${String(concept.properties.displayName)} is connected to ${support} seed node${support === 1 ? '' : 's'}. Total support score: ${totalScore.toFixed(2)}.${provenance.length > 0 ? ` Sources: ${Array.from(new Set(provenance)).slice(0, 6).join(', ')}.` : ''}`,
          score: Math.min(0.96, 0.66 + support * 0.08 + Math.min(0.12, totalScore * 0.04)),
          nodeIds: [...seeds.map((seed) => String(seed.properties.id)), String(concept.properties.id)],
          edgeIds: rels.map((relationship) => String(relationship.properties.edgeKey ?? relationship.elementId)),
          metadata: {
            support,
            totalScore,
            conceptType: String(concept.properties.typeName ?? concept.properties.typeCode ?? 'Entity'),
            seedNodeIds: seeds.map((seed) => String(seed.properties.id)),
            provenance: Array.from(new Set(provenance)).slice(0, 8),
          },
        });
      }

      return {
        items: [
          {
            id: `enrichment-summary-${Date.now()}`,
            kind: 'query' as const,
            title,
            summary: items.length > 0
              ? `Top enriched concepts: ${items
                  .slice(0, 8)
                  .map((item) => `${item.title.replace(`${title}: `, '')}`)
                  .join(', ')}.`
              : `No ${title.toLowerCase()} results were identified for the seed set.`,
            score: 0.8,
            nodeIds: Array.from(highlightNodeIds),
            edgeIds: items.flatMap((item) => item.edgeIds).slice(0, 120),
            metadata: {
              seedCount: dedupedNodeIds.length,
              targetTypes,
            },
          },
          ...items,
        ],
        graph: serializeGraphFromRecords(nodes, relationships, {
          retrieval: `graph-analysis:${title.toLowerCase().replace(/\s+/g, '-')}`,
          seedIds: dedupedNodeIds,
          targetTypes,
        }),
        highlightNodeIds: Array.from(highlightNodeIds).slice(0, 24),
        warnings: items.length === 0 ? [`No ${title.toLowerCase()} results were found for the current node set.`] : [],
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }
}
