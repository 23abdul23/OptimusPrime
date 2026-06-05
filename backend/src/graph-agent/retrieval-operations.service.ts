import { Injectable } from '@nestjs/common';
import neo4j, { type Node as Neo4jNode, type Relationship as Neo4jRelationship } from 'neo4j-driver';
import { OptimusKgService, type SerializedGraphPayload } from '@/optimuskg/optimuskg.service';
import type { GraphEvidenceItem, RetrievalPlanStep, ResolvedEntity } from './graph-agent.types';
import { compactRecord, parseJsonRecord, parseStringArray, serializeGraphFromRecords, toNumber } from './graph-agent.utils';
import { CypherAgentService } from './cypher-agent.service';

export interface RetrievalOperationResult {
  items: GraphEvidenceItem[];
  graph?: SerializedGraphPayload;
  highlightNodeIds?: string[];
  highlightPath?: {
    nodeIds: string[];
    edgeIds: string[];
  };
  warnings?: string[];
}

@Injectable()
export class RetrievalOperationsService {
  constructor(
    private readonly optimusKgService: OptimusKgService,
    private readonly cypherAgentService: CypherAgentService,
  ) {}

  async execute(step: RetrievalPlanStep, resolvedEntities: ResolvedEntity[]): Promise<RetrievalOperationResult> {
    switch (step.operation) {
      case 'discover-graph':
        return this.discoverGraph(step);

      case 'build-disease-network':
        return this.buildDiseaseNetwork(step);

      case 'build-gene-network':
        return this.buildGeneNetwork(step);

      case 'build-drug-network':
        return this.buildDrugNetwork(step);

      case 'build-pathway-network':
        return this.buildPathwayNetwork(step);

      case 'build-relationship-network':
        return this.buildRelationshipNetwork(step);

      case 'build-multi-entity-network':
        return this.buildMultiEntityNetwork(step);

      case 'load-node-details':
        return this.getNodeDetails((step.params.nodeIds as string[] | undefined) ?? []);

      case 'retrieve-relationship-evidence':
        return this.retrieveEvidenceBetweenNodes(
          String(step.params.sourceId),
          String(step.params.targetId),
          (step.params.commonNeighborTypes as string[] | undefined) ?? [],
          Number(step.params.limit ?? 8),
        );

      case 'find-shortest-path':
        return this.findShortestPath(
          String(step.params.sourceId),
          String(step.params.targetId),
          Number(step.params.maxDepth ?? 6),
        );

      case 'get-drug-indications':
        return this.getRelatedEntities(
          String(step.params.nodeId),
          ['Disease'],
          (step.params.relationshipTypes as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );

      case 'get-drug-targets':
        return this.executeTypedRelatedOperation(step, ['Gene', 'Protein'], {
          defaultRelationshipTypes: ['TARGETS', 'TARGET_OF', 'INTERACTS_WITH', 'ASSOCIATED_WITH'],
        });

      case 'get-drug-contraindications':
        return this.executeTypedRelatedOperation(step, ['Disease', 'Phenotype'], {
          defaultRelationshipTypes: ['CONTRAINDICATED_FOR', 'AVOID_IN', 'ASSOCIATED_WITH'],
        });

      case 'find-off-label-uses':
        return this.executeTypedRelatedOperation(step, ['Disease'], {
          defaultRelationshipTypes: ['OFF_LABEL_FOR', 'TREATS', 'ASSOCIATED_WITH'],
        });

      case 'get-drug-mechanisms':
        return this.executeTypedRelatedOperation(step, ['Protein', 'Gene', 'Pathway', 'BiologicalProcess'], {
          defaultRelationshipTypes: ['TARGETS', 'TARGET_OF', 'INTERACTS_WITH', 'PARTICIPATES_IN', 'INVOLVED_IN'],
          defaultTypeSequences: [
            ['Protein'],
            ['Gene'],
            ['Protein', 'Pathway'],
            ['Gene', 'Pathway'],
            ['Protein', 'BiologicalProcess'],
            ['Gene', 'BiologicalProcess'],
          ],
        });

      case 'get-disease-genes':
        return this.executeTypedRelatedOperation(step, ['Gene', 'Protein'], {
          defaultRelationshipTypes: ['ASSOCIATED_WITH', 'CAUSAL_TO', 'INTERACTS_WITH', 'PARTICIPATES_IN'],
        });

      case 'get-disease-phenotypes':
        return this.executeTypedRelatedOperation(step, ['Phenotype'], {
          defaultRelationshipTypes: ['ASSOCIATED_WITH', 'HAS_PHENOTYPE', 'PRESENTS_WITH'],
        });

      case 'get-gene-diseases':
        return this.executeTypedRelatedOperation(step, ['Disease', 'Phenotype'], {
          defaultRelationshipTypes: ['ASSOCIATED_WITH', 'CAUSAL_TO', 'INTERACTS_WITH'],
        });

      case 'get-gene-pathways':
        return this.executeTypedRelatedOperation(step, ['Pathway', 'BiologicalProcess'], {
          defaultRelationshipTypes: ['PARTICIPATES_IN', 'INVOLVED_IN', 'ASSOCIATED_WITH'],
          defaultTypeSequences: [['Pathway'], ['BiologicalProcess']],
        });

      case 'get-pathway-genes':
        return this.executeTypedRelatedOperation(step, ['Gene', 'Protein'], {
          defaultRelationshipTypes: ['PARTICIPATES_IN', 'INVOLVED_IN', 'ASSOCIATED_WITH'],
        });

      case 'get-pathway-diseases':
        return this.executeTypedRelatedOperation(step, ['Disease', 'Phenotype'], {
          defaultRelationshipTypes: ['ASSOCIATED_WITH', 'INVOLVED_IN', 'PARTICIPATES_IN'],
        });

      case 'get-anatomy-genes':
        return this.executeTypedRelatedOperation(step, ['Gene', 'Protein'], {
          defaultRelationshipTypes: ['EXPRESSED_IN', 'LOCALIZED_TO', 'ASSOCIATED_WITH'],
        });

      case 'get-anatomy-diseases':
        return this.executeTypedRelatedOperation(step, ['Disease', 'Phenotype'], {
          defaultRelationshipTypes: ['ASSOCIATED_WITH', 'LOCALIZED_TO', 'AFFECTS'],
        });

      case 'get-exposure-genes':
        return this.executeTypedRelatedOperation(step, ['Gene', 'Protein'], {
          defaultRelationshipTypes: ['ASSOCIATED_WITH', 'AFFECTS', 'INTERACTS_WITH'],
        });

      case 'get-exposure-diseases':
        return this.executeTypedRelatedOperation(step, ['Disease', 'Phenotype'], {
          defaultRelationshipTypes: ['ASSOCIATED_WITH', 'AFFECTS', 'CAUSES'],
        });

      case 'get-exposure-processes':
        return this.executeTypedRelatedOperation(
          step,
          ['Pathway', 'BiologicalProcess', 'MolecularFunction', 'CellularComponent'],
          {
            defaultRelationshipTypes: ['ASSOCIATED_WITH', 'AFFECTS', 'PARTICIPATES_IN', 'INVOLVED_IN'],
          },
        );

      case 'get-related-diseases':
        return this.executeRelatedOperation(step, ['Disease']);

      case 'get-related-genes':
        return this.executeRelatedOperation(step, ['Gene']);

      case 'get-related-proteins':
        return this.executeRelatedOperation(step, ['Protein']);

      case 'get-related-pathways':
        return this.executeRelatedOperation(step, ['Pathway']);

      case 'get-related-drugs':
        return this.executeRelatedOperation(step, ['Drug']);

      case 'get-related-entities':
        return this.executeRelatedOperation(step, []);

      case 'find-common-neighbors':
        return this.getRelatedEntitiesForNodeSet(
          ((step.params.nodeIds as string[] | undefined) ?? []).map((nodeId) => String(nodeId)),
          (step.params.targetTypes as string[] | undefined) ?? [],
          (step.params.relationshipTypes as string[] | undefined) ?? [],
          'shared',
          Number(step.params.minSupport ?? 2),
          Number(step.params.limit ?? 20),
        );

      case 'retrieve-clinical-guidelines':
        return this.getRelatedEntities(String(step.params.nodeId), ['Clinical Guideline', 'Guideline'], [], Number(step.params.limit ?? 10));

      case 'find-candidate-entities':
        return this.findCandidateEntities(
          String(step.params.query ?? ''),
          (step.params.nodeTypes as string[] | undefined) ?? [],
          Number(step.params.limit ?? 10),
          'Candidate entities',
        );

      case 'find-visible-graph-matches':
        return this.findVisibleGraphMatches(
          String(step.params.query ?? ''),
          (step.params.visibleNodes as Array<Record<string, unknown>> | undefined) ?? [],
          Number(step.params.limit ?? 10),
        );

      case 'rank-entity-candidates':
        return this.findCandidateEntities(
          String(step.params.query ?? ''),
          (step.params.nodeTypes as string[] | undefined) ?? [],
          Number(step.params.limit ?? 10),
          'Ranked entity candidates',
        );

      case 'traverse-typed-paths':
        return (
          (await this.traverseTypedPaths(
          String(step.params.startId),
          (step.params.typeSequences as string[][] | undefined) ?? [],
          Number(step.params.limit ?? 12),
          )) ?? {
            items: [],
            warnings: ['No typed path chain matched the requested traversal.'],
          }
        );

      case 'retrieve-neighborhood': {
        const nodeId = step.params.nodeId ? String(step.params.nodeId) : resolvedEntities[0]?.id;
        if (!nodeId) {
          return {
            items: [],
            warnings: ['No anchor entity was available for subgraph retrieval.'],
          };
        }

        const graph = await this.optimusKgService.subgraph(
          nodeId,
          Number(step.params.radius ?? 1),
          Number(step.params.maxNodes ?? 80),
          Number(step.params.degreeLimit ?? 12),
          (step.params.relationshipTypes as string[] | undefined) ?? [],
          (step.params.nodeTypes as string[] | undefined) ?? [],
        );

        return {
          items: [this.graphToEvidence(step.id, 'relation', step.description, graph, 0.7)],
          graph,
          highlightNodeIds: graph.nodes.map((node) => node.key).slice(0, 8),
        };
      }

      case 'expand-network': {
        const nodeIds = (step.params.nodeIds as string[] | undefined) ?? [];
        if (nodeIds.length === 0) {
          return {
            items: [],
            warnings: ['No seed nodes were available for graph expansion.'],
          };
        }

        const graph = await this.optimusKgService.expandSubgraph(
          nodeIds,
          Number(step.params.hops ?? 1),
          Number(step.params.maxNodes ?? 160),
          Number(step.params.degreeLimit ?? 24),
          (step.params.relationshipTypes as string[] | undefined) ?? [],
          (step.params.nodeTypes as string[] | undefined) ?? [],
        );

        return {
          items: [this.graphToEvidence(step.id, 'relation', step.description, graph, 0.82)],
          graph,
          highlightNodeIds: graph.nodes.map((node) => node.key).slice(0, 16),
        };
      }

      default:
        return {
          items: [],
          warnings: [`Retrieval operation "${step.operation}" is not implemented.`],
        };
    }
  }

  private async executeRelatedOperation(step: RetrievalPlanStep, defaultNodeTypes: string[]) {
    if (Array.isArray(step.params.typeSequences)) {
      const traversed = await this.traverseTypedPaths(
        String(step.params.startId),
        step.params.typeSequences as string[][],
        Number(step.params.limit ?? 10),
      );

      if (!traversed) {
        return {
          items: [],
          warnings: ['No typed path chain matched the requested traversal.'],
        };
      }

      return traversed;
    }

    const nodeIds = Array.isArray(step.params.nodeIds)
      ? (step.params.nodeIds as string[]).map((nodeId) => String(nodeId)).filter((nodeId) => nodeId.length > 0)
      : [];
    const nodeTypes = ((step.params.nodeTypes as string[] | undefined) ?? []).length > 0
      ? ((step.params.nodeTypes as string[] | undefined) ?? [])
      : defaultNodeTypes;

    if (nodeIds.length > 1) {
      return this.getRelatedEntitiesForNodeSet(
        nodeIds,
        nodeTypes,
        (step.params.relationshipTypes as string[] | undefined) ?? [],
        String(step.params.aggregateMode ?? 'union') === 'shared' ? 'shared' : 'union',
        Number(step.params.minSupport ?? 1),
        Number(step.params.limit ?? 20),
      );
    }

    return this.getRelatedEntities(
      String(step.params.nodeId ?? nodeIds[0] ?? step.params.startId ?? ''),
      nodeTypes,
      (step.params.relationshipTypes as string[] | undefined) ?? [],
      Number(step.params.limit ?? 20),
    );
  }

  private async executeTypedRelatedOperation(
    step: RetrievalPlanStep,
    defaultNodeTypes: string[],
    options: {
      defaultRelationshipTypes?: string[];
      defaultTypeSequences?: string[][];
    } = {},
  ): Promise<RetrievalOperationResult> {
    const typeSequences = Array.isArray(step.params.typeSequences)
      ? (step.params.typeSequences as string[][])
      : options.defaultTypeSequences;
    const relationshipTypes =
      ((step.params.relationshipTypes as string[] | undefined) ?? []).length > 0
        ? ((step.params.relationshipTypes as string[] | undefined) ?? [])
        : (options.defaultRelationshipTypes ?? []);
    const nodeIds = Array.isArray(step.params.nodeIds)
      ? (step.params.nodeIds as string[]).map((nodeId) => String(nodeId)).filter((nodeId) => nodeId.length > 0)
      : [];
    const nodeId = String(step.params.nodeId ?? nodeIds[0] ?? step.params.startId ?? '');
    const limit = Number(step.params.limit ?? 20);

    if (typeSequences && typeSequences.length > 0 && nodeId.length > 0) {
      return (
        (await this.traverseTypedPaths(nodeId, typeSequences, limit)) ?? {
          items: [],
          warnings: ['No typed path chain matched the requested traversal.'],
        }
      );
    }

    if (nodeIds.length > 1) {
      return this.getRelatedEntitiesForNodeSet(
        nodeIds,
        defaultNodeTypes,
        relationshipTypes,
        String(step.params.aggregateMode ?? 'union') === 'shared' ? 'shared' : 'union',
        Number(step.params.minSupport ?? 1),
        limit,
      );
    }

    return this.getRelatedEntities(nodeId, defaultNodeTypes, relationshipTypes, limit);
  }

  private async discoverGraph(step: RetrievalPlanStep): Promise<RetrievalOperationResult> {
    const nodeIds = this.extractStepNodeIds(step);
    if (nodeIds.length === 0) {
      return {
        items: [],
        warnings: ['No resolved seed entities were available for graph discovery.'],
      };
    }

    const details = await this.getNodeDetails(nodeIds.slice(0, 4));
    const graph = await this.optimusKgService.expandSubgraph(
      nodeIds,
      Number(step.params.hops ?? 1),
      Number(step.params.maxNodes ?? 80),
      18,
      (step.params.relationshipTypes as string[] | undefined) ?? [],
      (step.params.nodeTypes as string[] | undefined) ?? [],
    );

    return this.mergeOperationResults([
      details,
      {
        items: [this.graphToEvidence(step.id, 'query', step.description, graph, 0.78)],
        graph,
        highlightNodeIds: nodeIds,
      },
    ]);
  }

  private async buildDiseaseNetwork(step: RetrievalPlanStep): Promise<RetrievalOperationResult> {
    const nodeId = this.extractStepNodeIds(step)[0];
    if (!nodeId) {
      return {
        items: [],
        warnings: ['No disease seed entity was available for disease-network construction.'],
      };
    }

    const relationshipTypes =
      ((step.params.relationshipTypes as string[] | undefined) ?? []).length > 0
        ? ((step.params.relationshipTypes as string[] | undefined) ?? [])
        : ['ASSOCIATED_WITH', 'CAUSAL_TO', 'INTERACTS_WITH', 'PARTICIPATES_IN', 'INVOLVED_IN'];

    const [details, genes, phenotypes] = await Promise.all([
      this.getNodeDetails([nodeId]),
      this.getRelatedEntities(nodeId, ['Gene', 'Protein'], relationshipTypes, Number(step.params.limit ?? 16)),
      this.getRelatedEntities(nodeId, ['Phenotype', 'Pathway', 'Drug'], relationshipTypes, 12),
    ]);
    const graph = await this.optimusKgService.expandSubgraph(
      [nodeId],
      2,
      Number(step.params.maxNodes ?? 96),
      18,
      relationshipTypes,
      (step.params.nodeTypes as string[] | undefined) ?? [],
    );

    return this.mergeOperationResults([
      details,
      genes,
      phenotypes,
      {
        items: [this.graphToEvidence(step.id, 'query', step.description, graph, 0.84)],
        graph,
        highlightNodeIds: [nodeId],
      },
    ]);
  }

  private async buildGeneNetwork(step: RetrievalPlanStep): Promise<RetrievalOperationResult> {
    const nodeId = this.extractStepNodeIds(step)[0];
    if (!nodeId) {
      return {
        items: [],
        warnings: ['No gene or protein seed entity was available for gene-network construction.'],
      };
    }

    const relationshipTypes =
      ((step.params.relationshipTypes as string[] | undefined) ?? []).length > 0
        ? ((step.params.relationshipTypes as string[] | undefined) ?? [])
        : ['ASSOCIATED_WITH', 'INTERACTS_WITH', 'PARTICIPATES_IN', 'INVOLVED_IN', 'TARGET_OF'];

    const [details, diseases, pathways] = await Promise.all([
      this.getNodeDetails([nodeId]),
      this.getRelatedEntities(nodeId, ['Disease', 'Phenotype'], relationshipTypes, 12),
      this.getRelatedEntities(
        nodeId,
        ['Pathway', 'BiologicalProcess', 'MolecularFunction', 'CellularComponent'],
        relationshipTypes,
        Number(step.params.limit ?? 16),
      ),
    ]);
    const graph = await this.optimusKgService.expandSubgraph(
      [nodeId],
      2,
      Number(step.params.maxNodes ?? 88),
      18,
      relationshipTypes,
      (step.params.nodeTypes as string[] | undefined) ?? [],
    );

    return this.mergeOperationResults([
      details,
      diseases,
      pathways,
      {
        items: [this.graphToEvidence(step.id, 'query', step.description, graph, 0.84)],
        graph,
        highlightNodeIds: [nodeId],
      },
    ]);
  }

  private async buildDrugNetwork(step: RetrievalPlanStep): Promise<RetrievalOperationResult> {
    const nodeId = this.extractStepNodeIds(step)[0];
    if (!nodeId) {
      return {
        items: [],
        warnings: ['No drug or therapeutic seed entity was available for drug-network construction.'],
      };
    }

    const relationshipTypes =
      ((step.params.relationshipTypes as string[] | undefined) ?? []).length > 0
        ? ((step.params.relationshipTypes as string[] | undefined) ?? [])
        : ['TARGETS', 'TARGET_OF', 'TREATS', 'INDICATED_FOR', 'ASSOCIATED_WITH', 'INTERACTS_WITH'];

    const [details, targets, indications] = await Promise.all([
      this.getNodeDetails([nodeId]),
      this.getRelatedEntities(nodeId, ['Gene', 'Protein', 'Pathway'], relationshipTypes, Number(step.params.limit ?? 14)),
      this.getRelatedEntities(nodeId, ['Disease', 'Phenotype'], relationshipTypes, 12),
    ]);
    const graph = await this.optimusKgService.expandSubgraph(
      [nodeId],
      2,
      Number(step.params.maxNodes ?? 88),
      18,
      relationshipTypes,
      (step.params.nodeTypes as string[] | undefined) ?? [],
    );

    return this.mergeOperationResults([
      details,
      targets,
      indications,
      {
        items: [this.graphToEvidence(step.id, 'query', step.description, graph, 0.84)],
        graph,
        highlightNodeIds: [nodeId],
      },
    ]);
  }

  private async buildPathwayNetwork(step: RetrievalPlanStep): Promise<RetrievalOperationResult> {
    const nodeId = this.extractStepNodeIds(step)[0];
    if (!nodeId) {
      return {
        items: [],
        warnings: ['No pathway or process seed entity was available for pathway-network construction.'],
      };
    }

    const relationshipTypes =
      ((step.params.relationshipTypes as string[] | undefined) ?? []).length > 0
        ? ((step.params.relationshipTypes as string[] | undefined) ?? [])
        : ['PARTICIPATES_IN', 'INVOLVED_IN', 'ASSOCIATED_WITH', 'INTERACTS_WITH'];

    const [details, genes, diseases] = await Promise.all([
      this.getNodeDetails([nodeId]),
      this.getRelatedEntities(nodeId, ['Gene', 'Protein'], relationshipTypes, Number(step.params.limit ?? 14)),
      this.getRelatedEntities(nodeId, ['Disease', 'Drug', 'Phenotype'], relationshipTypes, 12),
    ]);
    const graph = await this.optimusKgService.expandSubgraph(
      [nodeId],
      2,
      Number(step.params.maxNodes ?? 88),
      18,
      relationshipTypes,
      (step.params.nodeTypes as string[] | undefined) ?? [],
    );

    return this.mergeOperationResults([
      details,
      genes,
      diseases,
      {
        items: [this.graphToEvidence(step.id, 'query', step.description, graph, 0.84)],
        graph,
        highlightNodeIds: [nodeId],
      },
    ]);
  }

  private async buildRelationshipNetwork(step: RetrievalPlanStep): Promise<RetrievalOperationResult> {
    const sourceId = String(step.params.sourceId ?? '');
    const targetId = String(step.params.targetId ?? '');
    if (!sourceId || !targetId) {
      return {
        items: [],
        warnings: ['Two resolved seed entities are required for relationship-network construction.'],
      };
    }

    const relationshipTypes = (step.params.relationshipTypes as string[] | undefined) ?? [];
    const [details, directEvidence, shortestPath] = await Promise.all([
      this.getNodeDetails([sourceId, targetId]),
      this.retrieveEvidenceBetweenNodes(sourceId, targetId, [], 8),
      this.findShortestPath(sourceId, targetId, 6),
    ]);
    const graph = await this.optimusKgService.expandSubgraph(
      [sourceId, targetId],
      1,
      Number(step.params.maxNodes ?? 96),
      16,
      relationshipTypes,
      (step.params.nodeTypes as string[] | undefined) ?? [],
    );

    return this.mergeOperationResults([
      details,
      directEvidence,
      shortestPath,
      {
        items: [this.graphToEvidence(step.id, 'query', step.description, graph, 0.88)],
        graph,
        highlightNodeIds: [sourceId, targetId],
      },
    ]);
  }

  private async buildMultiEntityNetwork(step: RetrievalPlanStep): Promise<RetrievalOperationResult> {
    const nodeIds = this.extractStepNodeIds(step);
    if (nodeIds.length === 0) {
      return {
        items: [],
        warnings: ['No resolved seed entities were available for multi-entity network construction.'],
      };
    }

    const relationshipTypes = (step.params.relationshipTypes as string[] | undefined) ?? [];
    const nodeTypes = (step.params.nodeTypes as string[] | undefined) ?? [];
    const aggregateMode = String(step.params.aggregateMode ?? 'union') === 'shared' ? 'shared' : 'union';
    const [details, related] = await Promise.all([
      this.getNodeDetails(nodeIds.slice(0, 6)),
      this.getRelatedEntitiesForNodeSet(
        nodeIds,
        nodeTypes,
        relationshipTypes,
        aggregateMode,
        Number(step.params.minSupport ?? 1),
        Number(step.params.limit ?? 20),
      ),
    ]);
    const graph = await this.optimusKgService.expandSubgraph(
      nodeIds,
      1,
      Number(step.params.maxNodes ?? 120),
      18,
      relationshipTypes,
      nodeTypes,
    );

    return this.mergeOperationResults([
      details,
      related,
      {
        items: [this.graphToEvidence(step.id, 'query', step.description, graph, 0.86)],
        graph,
        highlightNodeIds: nodeIds.slice(0, 8),
      },
    ]);
  }

  private extractStepNodeIds(step: RetrievalPlanStep) {
    const explicitNodeIds = Array.isArray(step.params.nodeIds)
      ? (step.params.nodeIds as string[]).map((nodeId) => String(nodeId)).filter((nodeId) => nodeId.trim().length > 0)
      : [];
    const sourceId = typeof step.params.sourceId === 'string' ? step.params.sourceId.trim() : '';
    const targetId = typeof step.params.targetId === 'string' ? step.params.targetId.trim() : '';

    return Array.from(new Set([...explicitNodeIds, sourceId, targetId].filter((nodeId) => nodeId.length > 0)));
  }

  private mergeOperationResults(results: RetrievalOperationResult[]): RetrievalOperationResult {
    const items = results.flatMap((result) => result.items);
    const warnings = Array.from(new Set(results.flatMap((result) => result.warnings ?? [])));
    const graphs = results.map((result) => result.graph).filter((graph): graph is SerializedGraphPayload => Boolean(graph));
    const highlightNodeIds = Array.from(
      new Set(results.flatMap((result) => result.highlightNodeIds ?? [])),
    ).slice(0, 20);
    const highlightPath = results.find((result) => result.highlightPath)?.highlightPath;

    return {
      items,
      graph: this.mergeSerializedGraphs(graphs),
      highlightNodeIds: highlightNodeIds.length > 0 ? highlightNodeIds : undefined,
      highlightPath,
      warnings,
    };
  }

  private mergeSerializedGraphs(graphs: SerializedGraphPayload[]) {
    if (graphs.length === 0) {
      return undefined;
    }

    const nodeMap = new Map<string, SerializedGraphPayload['nodes'][number]>();
    const edgeMap = new Map<string, SerializedGraphPayload['edges'][number]>();
    let truncated = false;
    const expandedFromNodeIds = new Set<string>();
    let centerNodeId: string | undefined;
    let radius = 1;

    for (const graph of graphs) {
      for (const node of graph.nodes) {
        if (!nodeMap.has(node.key)) {
          nodeMap.set(node.key, node);
        }
      }
      for (const edge of graph.edges) {
        if (!edgeMap.has(edge.key)) {
          edgeMap.set(edge.key, edge);
        }
      }
      truncated = truncated || graph.attributes.truncated === true;
      if (!centerNodeId && typeof graph.attributes.centerNodeId === 'string') {
        centerNodeId = String(graph.attributes.centerNodeId);
      }
      if (typeof graph.attributes.radius === 'number') {
        radius = Math.max(radius, Math.trunc(graph.attributes.radius));
      }
      if (Array.isArray(graph.attributes.expandedFromNodeIds)) {
        for (const nodeId of graph.attributes.expandedFromNodeIds) {
          expandedFromNodeIds.add(String(nodeId));
        }
      }
    }

    return {
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
      attributes: compactRecord({
        centerNodeId,
        radius,
        expandedFromNodeIds: [...expandedFromNodeIds],
        truncated,
      }),
      options: {
        type: 'mixed' as const,
        multi: true as const,
        allowSelfLoops: true as const,
      },
    };
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
          summaryParts.push(`Sources: ${[...sourceNames, ...sourceIds].slice(0, 5).join(', ')}.`);
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
        // Resolution already filtered candidates. Skip missing node details.
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
    const boundedLimit = neo4j.int(Math.max(1, Math.trunc(toNumber(limit))));
    const directRecords = await this.cypherAgentService.executeTemplate(
      `
        MATCH (source:Entity {id: $sourceId})-[rel]-(target:Entity {id: $targetId})
        RETURN source, rel, target
        ORDER BY coalesce(rel.score, 0) DESC, type(rel)
        LIMIT $limit
      `,
      { sourceId, targetId, limit: boundedLimit },
    );
    const commonNeighborRecords = await this.cypherAgentService.executeTemplate(
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

    for (const record of directRecords) {
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

    for (const [index, record] of commonNeighborRecords.entries()) {
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
        nodeIds: [String(source.properties.id), String(neighbor.properties.id), String(target.properties.id)],
        edgeIds: [String(leftProps.edgeKey ?? left.elementId), String(rightProps.edgeKey ?? right.elementId)],
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
      items,
      graph: serializeGraphFromRecords(nodes, relationships, {
        sourceId,
        targetId,
        retrieval: 'pair-evidence',
      }),
      highlightNodeIds: [...highlightNodeIds],
      warnings: items.length === 0 ? ['No direct relationships or shared-neighbor evidence was found for the requested entities.'] : [],
    };
  }

  private async findShortestPath(sourceId: string, targetId: string, maxDepth: number) {
    const result = await this.optimusKgService.shortestPath(sourceId, targetId, maxDepth);

    return {
      items: result.found
        ? [this.graphToEvidence(`shortest-path-${Date.now()}`, 'path', 'Shortest path', result.graph, 0.95)]
        : [],
      graph: result.graph,
      highlightNodeIds: result.graph.nodes.map((node) => node.key),
      highlightPath: {
        nodeIds: result.graph.nodes.map((node) => node.key),
        edgeIds: result.graph.edges.map((edge) => edge.key),
      },
      warnings: result.found ? [] : ['No shortest path was found between the requested entities.'],
    };
  }

  private async getRelatedEntities(
    nodeId: string,
    nodeTypes: string[],
    relationshipTypes: string[],
    limit: number,
  ) {
    if (!nodeId) {
      return {
        items: [],
        warnings: ['No anchor node was available for related-entity retrieval.'],
      };
    }

    const result = await this.cypherAgentService.executeTemplate(
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

    for (const record of result) {
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
      items,
      graph: serializeGraphFromRecords(nodes, relationships, {
        centerNodeId: nodeId,
        retrieval: 'related-entities',
      }),
      highlightNodeIds: items.length > 0 ? Array.from(new Set(items.flatMap((item) => item.nodeIds))).slice(0, 16) : [],
      warnings: items.length === 0 ? ['No directly related entities matched the requested type filter.'] : [],
    };
  }

  private async getRelatedEntitiesForNodeSet(
    nodeIds: string[],
    nodeTypes: string[],
    relationshipTypes: string[],
    aggregateMode: 'shared' | 'union',
    minSupport: number,
    limit: number,
  ) {
    const dedupedNodeIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (dedupedNodeIds.length === 0) {
      return {
        items: [],
        warnings: ['No seed nodes were available for set-based related-entity retrieval.'],
      };
    }

    const result = await this.cypherAgentService.executeTemplate(
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

    for (const [index, record] of result.entries()) {
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
      items,
      graph: serializeGraphFromRecords(nodes, relationships, {
        sourceIds: dedupedNodeIds,
        retrieval: 'shared-related-entities',
      }),
      highlightNodeIds: [...highlightNodeIds],
      warnings: items.length === 0 ? ['No directly related entities matched the requested type filter.'] : [],
    };
  }

  private async traverseTypedPaths(
    startId: string,
    typeSequences: string[][],
    limit: number,
  ): Promise<RetrievalOperationResult | null> {
    for (const sequence of typeSequences) {
      const result = await this.runTypedPathQuery(startId, sequence, limit);
      if (result.items.length > 0) {
        return result;
      }
    }

    return null;
  }

  private async runTypedPathQuery(startId: string, sequence: string[], limit: number) {
    const nodeVars = ['n0', ...sequence.map((_, index) => `n${index + 1}`)];
    const relationshipVars = sequence.map((_, index) => `r${index + 1}`);
    const matchPath = sequence.map((_, index) => `-[${relationshipVars[index]}]-(${nodeVars[index + 1]}:Entity)`).join('');
    const whereClause = sequence.map((_, index) => `${nodeVars[index + 1]}.typeName IN $type${index + 1}`).join(' AND ');
    const result = await this.cypherAgentService.executeTemplate(
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

    for (const [index, record] of result.entries()) {
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
      items,
      graph: serializeGraphFromRecords(nodes, relationships, {
        startId,
        retrieval: 'typed-path',
        typeSequence: sequence,
      }),
      highlightNodeIds: items.length > 0 ? Array.from(new Set(items.flatMap((item) => item.nodeIds))).slice(0, 16) : [],
    };
  }

  private async findCandidateEntities(
    query: string,
    nodeTypes: string[],
    limit: number,
    title: string,
  ): Promise<RetrievalOperationResult> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return {
        items: [],
        warnings: ['No query text was provided for candidate entity lookup.'],
      };
    }

    const candidates = await this.optimusKgService.resolveNodes([trimmedQuery], Math.max(1, Math.trunc(toNumber(limit))), nodeTypes);
    const items = candidates.slice(0, Math.max(1, Math.trunc(toNumber(limit)))).map((candidate, index) => ({
      id: `candidate-${candidate.id}-${index}`,
      kind: 'entity' as const,
      title: `${candidate.displayName} (${candidate.typeName})`,
      summary: [
        `Matched "${trimmedQuery}" against ${candidate.displayName}.`,
        candidate.description ? `Description: ${candidate.description}` : '',
        candidate.aliases.length > 0 ? `Aliases: ${candidate.aliases.slice(0, 6).join(', ')}.` : '',
        candidate.matchedOn.length > 0 ? `Matched on: ${candidate.matchedOn.join(', ')}.` : '',
      ]
        .filter((part) => part.length > 0)
        .join(' '),
      score: Math.min(0.95, 0.5 + candidate.score / 220),
      nodeIds: [candidate.id],
      edgeIds: [],
      metadata: compactRecord({
        typeCode: candidate.typeCode,
        typeName: candidate.typeName,
        matchedOn: candidate.matchedOn,
        rawScore: candidate.score,
        aliases: candidate.aliases.slice(0, 10),
        sourceIds: candidate.sourceIds.slice(0, 10),
        sourceNames: candidate.sourceNames.slice(0, 10),
      }),
    }));

    return {
      items: [
        {
          id: `candidate-summary-${Date.now()}`,
          kind: 'query' as const,
          title,
          summary:
            items.length > 0
              ? `Top candidates for "${trimmedQuery}": ${items
                  .slice(0, 8)
                  .map((item) => item.title)
                  .join(', ')}.`
              : `No candidate entities matched "${trimmedQuery}".`,
          score: items.length > 0 ? 0.78 : 0.45,
          nodeIds: items.flatMap((item) => item.nodeIds),
          edgeIds: [],
          metadata: {
            query: trimmedQuery,
            nodeTypes,
            candidateCount: items.length,
          },
        },
        ...items,
      ],
      highlightNodeIds: items.flatMap((item) => item.nodeIds).slice(0, 12),
      warnings: items.length === 0 ? [`No entity candidates were found for "${trimmedQuery}".`] : [],
    };
  }

  private async findVisibleGraphMatches(
    query: string,
    visibleNodes: Array<Record<string, unknown>>,
    limit: number,
  ): Promise<RetrievalOperationResult> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return {
        items: [],
        warnings: ['No query text was provided for visible-graph matching.'],
      };
    }

    const normalizedQuery = this.normalizeText(trimmedQuery);
    const queryTokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 0);
    const matches = visibleNodes
      .map((node) => {
        const label = typeof node.label === 'string' ? node.label : '';
        const nodeType = typeof node.nodeType === 'string' ? node.nodeType : 'Entity';
        const normalizedLabel = this.normalizeText(label);
        const score =
          normalizedLabel === normalizedQuery
            ? 100
            : normalizedLabel.includes(normalizedQuery)
              ? 80
              : queryTokens.every((token) => normalizedLabel.includes(token))
                ? 60
                : 0;

        return {
          id: String(node.id ?? ''),
          label,
          nodeType,
          score,
        };
      })
      .filter((match) => match.id.length > 0 && match.score > 0)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
      .slice(0, Math.max(1, Math.trunc(toNumber(limit))));

    return {
      items: [
        {
          id: `visible-match-summary-${Date.now()}`,
          kind: 'query' as const,
          title: 'Visible graph matches',
          summary:
            matches.length > 0
              ? `Visible graph matches for "${trimmedQuery}": ${matches
                  .slice(0, 8)
                  .map((match) => `${match.label} (${match.nodeType})`)
                  .join(', ')}.`
              : `No visible graph nodes matched "${trimmedQuery}".`,
          score: matches.length > 0 ? 0.76 : 0.4,
          nodeIds: matches.map((match) => match.id),
          edgeIds: [],
          metadata: {
            query: trimmedQuery,
            matchCount: matches.length,
            matches,
          },
        },
        ...matches.map((match, index) => ({
          id: `visible-match-${match.id}-${index}`,
          kind: 'entity' as const,
          title: `${match.label} (${match.nodeType})`,
          summary: `Matched visible graph node "${match.label}" as a ${match.nodeType}.`,
          score: Math.min(0.92, 0.52 + match.score / 160),
          nodeIds: [match.id],
          edgeIds: [],
          metadata: {
            query: trimmedQuery,
            matchScore: match.score,
            nodeType: match.nodeType,
          },
        })),
      ],
      highlightNodeIds: matches.map((match) => match.id),
      warnings: matches.length === 0 ? [`No visible graph matches were found for "${trimmedQuery}".`] : [],
    };
  }

  private normalizeText(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
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
}
