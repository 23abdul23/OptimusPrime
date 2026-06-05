import { Injectable } from '@nestjs/common';
import type { GraphAction, GraphToolResult, RetrievalPlanStep, ResolvedEntity } from './graph-agent.types';
import type { SerializedGraphPayload } from '@/optimuskg/optimuskg.service';
import { GraphAnalysisService } from './graph-analysis.service';
import { RetrievalOperationsService } from './retrieval-operations.service';
import { CypherAgentService } from './cypher-agent.service';

@Injectable()
export class GraphRetrieverService {
  constructor(
    private readonly graphAnalysisService: GraphAnalysisService,
    private readonly retrievalOperationsService: RetrievalOperationsService,
    private readonly cypherAgentService: CypherAgentService,
  ) {}

  async executePlan(plan: RetrievalPlanStep[], resolvedEntities: ResolvedEntity[]): Promise<GraphToolResult> {
    const evidence: GraphToolResult['evidence'] = [];
    const graphActions: GraphAction[] = [];
    let graphDelta: SerializedGraphPayload | undefined;
    const warnings: string[] = [];

    for (const step of plan) {
      try {
        if (step.executor === 'graph-analysis') {
          const result = await this.executeGraphAnalysis(step);
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          if (result.graph && result.graph.nodes.length > 1 && step.operation === 'explain-connections') {
            graphActions.push({
              id: `${step.id}-path`,
              type: 'highlight-path',
              nodeIds: result.graph.nodes.map((node) => node.key),
              edgeIds: result.graph.edges.map((edge) => edge.key),
            });
          }
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          continue;
        }

        if (step.executor === 'retrieval-operations') {
          const result = await this.retrievalOperationsService.execute(step, resolvedEntities);
          graphDelta = this.mergeGraphDelta(graphDelta, result.graph);
          graphActions.push(...this.buildGraphActionsFromResult(step.id, result.graph, result.highlightNodeIds));
          if (result.highlightPath) {
            graphActions.push({
              id: `${step.id}-path`,
              type: 'highlight-path',
              nodeIds: result.highlightPath.nodeIds,
              edgeIds: result.highlightPath.edgeIds,
            });
          }
          evidence.push(...result.items);
          warnings.push(...(result.warnings ?? []));
          continue;
        }

        if (step.executor === 'cypher-agent') {
          const userQuery = String(step.params.userQuery ?? '');
          const cypher = this.cypherAgentService.extractExplicitCypher(userQuery);
          if (!cypher) {
            warnings.push('No explicit Cypher query was provided in the request.');
            continue;
          }

          const result = await this.cypherAgentService.executeGuardedCypher(cypher, {}, 25);
          evidence.push({
            id: step.id,
            kind: 'query',
            title: 'Guarded Cypher result',
            summary: `Returned ${result.rows.length} row(s) from the validated Cypher query.`,
            score: 0.6,
            nodeIds: [],
            edgeIds: [],
            metadata: {
              rows: result.rows,
              cost: result.cost,
            },
          });
          continue;
        }

        warnings.push(`Graph retrieval executor "${step.executor}" is not implemented.`);
      } catch (error) {
        warnings.push(this.formatStepError(step, error));
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

  private async executeGraphAnalysis(step: RetrievalPlanStep) {
    switch (step.operation) {
      case 'summarize-selected-nodes':
        return this.graphAnalysisService.summarizeNodes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'summarize-visible-subgraph':
        return this.graphAnalysisService.summarizeSubgraph(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-schema':
        return this.graphAnalysisService.analyzeSchema(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-node-types':
        return this.graphAnalysisService.analyzeNodeTypes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
          (step.params.targetTypes as string[] | undefined) ?? [],
          String(step.params.title ?? 'Node-type analysis'),
        );
      case 'analyze-relationship-types':
        return this.graphAnalysisService.analyzeRelationshipTypes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
          (step.params.sourceTypes as string[] | undefined) ?? [],
          (step.params.targetTypes as string[] | undefined) ?? [],
          String(step.params.title ?? 'Relationship analysis'),
        );
      case 'find-cross-type-relationships':
        return this.graphAnalysisService.findCrossTypeRelationships(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
          (step.params.sourceTypes as string[] | undefined) ?? [],
          (step.params.targetTypes as string[] | undefined) ?? [],
        );
      case 'find-available-node-types':
        return this.graphAnalysisService.findAvailableNodeTypes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'find-available-relationship-types':
        return this.graphAnalysisService.findAvailableRelationshipTypes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'find-dominant-relationships':
        return this.graphAnalysisService.findDominantRelationships(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'rank-relationship-types':
        return this.graphAnalysisService.rankRelationshipTypes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-relationship-patterns':
        return this.graphAnalysisService.analyzeRelationshipPatterns(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-cross-type-connections':
        return this.graphAnalysisService.analyzeCrossTypeConnections(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
          (step.params.sourceTypes as string[] | undefined) ?? [],
          (step.params.targetTypes as string[] | undefined) ?? [],
        );
      case 'analyze-relationship-density':
        return this.graphAnalysisService.analyzeRelationshipDensity(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-genes':
        return this.graphAnalysisService.analyzeGenes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-diseases':
        return this.graphAnalysisService.analyzeDiseases(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-drugs':
        return this.graphAnalysisService.analyzeDrugs(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-pathways':
        return this.graphAnalysisService.analyzePathways(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-phenotypes':
        return this.graphAnalysisService.analyzePhenotypes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-anatomy':
        return this.graphAnalysisService.analyzeAnatomy(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-molecular-functions':
        return this.graphAnalysisService.analyzeMolecularFunctions(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-cellular-components':
        return this.graphAnalysisService.analyzeCellularComponents(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'analyze-exposures':
        return this.graphAnalysisService.analyzeExposures(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'compute-graph-metrics':
        return this.graphAnalysisService.computeGraphMetrics(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'compute-node-type-distribution':
        return this.graphAnalysisService.computeNodeTypeDistribution(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'compute-relationship-distribution':
        return this.graphAnalysisService.computeRelationshipDistribution(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'compute-centrality-metrics':
        return this.graphAnalysisService.computeCentralityMetrics(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'compute-density-metrics':
        return this.graphAnalysisService.computeDensityMetrics(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'compute-component-statistics':
        return this.graphAnalysisService.computeComponentStatistics(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'detect-communities':
        return this.graphAnalysisService.detectCommunities(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
          (step.params.focusTypes as string[] | undefined) ?? [],
          String(step.params.title ?? 'Detected communities'),
        );
      case 'detect-disease-modules':
        return this.graphAnalysisService.detectDiseaseModules(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'detect-functional-modules':
        return this.graphAnalysisService.detectFunctionalModules(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'detect-gene-modules':
        return this.graphAnalysisService.detectGeneModules(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'interpret-subgraph':
        return this.graphAnalysisService.interpretSubgraph(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'identify-graph-theme':
        return this.graphAnalysisService.identifyGraphTheme(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'identify-central-concepts':
        return this.graphAnalysisService.identifyCentralConcepts(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'summarize-biological-narrative':
        return this.graphAnalysisService.summarizeBiologicalNarrative(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.edgeIds as string[] | undefined) ?? [],
        );
      case 'enrich-diseases':
        return this.graphAnalysisService.enrichDiseases(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );
      case 'enrich-pathways':
        return this.graphAnalysisService.enrichPathways(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );
      case 'enrich-phenotypes':
        return this.graphAnalysisService.enrichPhenotypes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );
      case 'enrich-biological-processes':
        return this.graphAnalysisService.enrichBiologicalProcesses(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );
      case 'enrich-molecular-functions':
        return this.graphAnalysisService.enrichMolecularFunctions(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );
      case 'enrich-cellular-components':
        return this.graphAnalysisService.enrichCellularComponents(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );
      case 'enrich-anatomy':
        return this.graphAnalysisService.enrichAnatomy(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.limit ?? 20),
        );
      case 'find-parents':
        return this.graphAnalysisService.findParents(
          String(step.params.rootId ?? step.params.nodeId ?? ((step.params.nodeIds as string[] | undefined) ?? [])[0] ?? ''),
          Number(step.params.maxDepth ?? 1),
        );
      case 'find-children':
        return this.graphAnalysisService.findChildren(
          String(step.params.rootId ?? step.params.nodeId ?? ((step.params.nodeIds as string[] | undefined) ?? [])[0] ?? ''),
          Number(step.params.maxDepth ?? 1),
        );
      case 'find-ancestors':
        return this.graphAnalysisService.findAncestors(
          String(step.params.rootId ?? step.params.nodeId ?? ((step.params.nodeIds as string[] | undefined) ?? [])[0] ?? ''),
          Number(step.params.maxDepth ?? 4),
        );
      case 'find-descendants':
        return this.graphAnalysisService.findDescendants(
          String(step.params.rootId ?? step.params.nodeId ?? ((step.params.nodeIds as string[] | undefined) ?? [])[0] ?? ''),
          Number(step.params.maxDepth ?? 4),
        );
      case 'find-ontology-roots':
        return this.graphAnalysisService.findOntologyRoots(
          String(step.params.rootId ?? step.params.nodeId ?? ((step.params.nodeIds as string[] | undefined) ?? [])[0] ?? ''),
          Number(step.params.maxDepth ?? 6),
        );
      case 'explore-ontology-hierarchy':
        return this.graphAnalysisService.exploreOntologyHierarchy(
          String(step.params.rootId ?? step.params.nodeId ?? ((step.params.nodeIds as string[] | undefined) ?? [])[0] ?? ''),
          (step.params.direction as 'parents' | 'children' | 'ancestors' | 'descendants' | 'roots' | undefined) ?? 'descendants',
          Number(step.params.maxDepth ?? 4),
          String(step.params.title ?? 'Ontology hierarchy'),
        );
      case 'compare-nodes':
        return this.graphAnalysisService.compareNodes((step.params.nodeIds as string[] | undefined) ?? []);
      case 'find-shared-pathways':
        return this.graphAnalysisService.findSharedPathways(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.minSupport ?? 2),
          Number(step.params.limit ?? 20),
        );
      case 'find-shared-diseases':
        return this.graphAnalysisService.findSharedDiseases(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.minSupport ?? 2),
          Number(step.params.limit ?? 20),
        );
      case 'find-shared-genes':
        return this.graphAnalysisService.findSharedGenes(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.minSupport ?? 2),
          Number(step.params.limit ?? 20),
        );
      case 'find-common-neighbors':
        return this.graphAnalysisService.findCommonNeighbors(
          (step.params.nodeIds as string[] | undefined) ?? [],
          (step.params.targetTypes as string[] | undefined) ?? [],
          Number(step.params.minSupport ?? 2),
          Number(step.params.limit ?? 20),
        );
      case 'find-hub-nodes':
        return this.graphAnalysisService.findHubNodes((step.params.nodeIds as string[] | undefined) ?? []);
      case 'find-bridging-nodes':
        return this.graphAnalysisService.findBridgingNodes((step.params.nodeIds as string[] | undefined) ?? []);
      case 'explain-connections':
        return this.graphAnalysisService.explainConnections(
          (step.params.nodeIds as string[] | undefined) ?? [],
          Number(step.params.maxDepth ?? 5),
        );
      case 'analyze-cluster':
        return this.graphAnalysisService.analyzeCluster((step.params.nodeIds as string[] | undefined) ?? []);
      default:
        return {
          items: [],
          warnings: [`Graph-analysis operation "${step.operation}" is not implemented.`],
        };
    }
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

  private formatStepError(step: RetrievalPlanStep, error: unknown) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : 'Unknown graph retrieval failure.';

    return `Step "${step.operation}" failed: ${message}`;
  }
}
