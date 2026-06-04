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
