import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { OptimusKgService } from './optimuskg.service';

function parseList(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

@Controller('optimus')
export class OptimusKgController {
  constructor(private readonly optimusKgService: OptimusKgService) {}

  @Get('stats')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300')
  async graphStats() {
    return this.optimusKgService.graphStats();
  }

  @Get('random')
  async randomNode(@Query('nodeTypes') nodeTypes?: string) {
    return this.optimusKgService.randomNode(parseList(nodeTypes));
  }

  @Get('search')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=60')
  async searchNodes(
    @Query('q') query = '',
    @Query('limit') limit?: string,
    @Query('nodeTypes') nodeTypes?: string,
  ) {
    return this.optimusKgService.searchNodes(query, parseInteger(limit, 10), parseList(nodeTypes));
  }

  @Get('subgraph')
  async subgraph(
    @Query('nodeId') nodeId: string,
    @Query('radius') radius?: string,
    @Query('maxNodes') maxNodes?: string,
    @Query('degreeLimit') degreeLimit?: string,
    @Query('relationshipTypes') relationshipTypes?: string,
    @Query('nodeTypes') nodeTypes?: string,
  ) {
    return this.optimusKgService.subgraph(
      nodeId,
      parseInteger(radius, 1),
      parseInteger(maxNodes, 250),
      parseInteger(degreeLimit, 12),
      parseList(relationshipTypes),
      parseList(nodeTypes),
    );
  }

  @Get('expand')
  async expandSubgraph(
    @Query('nodeIds') nodeIds: string,
    @Query('hops') hops?: string,
    @Query('maxNodes') maxNodes?: string,
    @Query('degreeLimit') degreeLimit?: string,
    @Query('relationshipTypes') relationshipTypes?: string,
    @Query('nodeTypes') nodeTypes?: string,
  ) {
    return this.optimusKgService.expandSubgraph(
      parseList(nodeIds),
      parseInteger(hops, 1),
      parseInteger(maxNodes, 250),
      parseInteger(degreeLimit, 12),
      parseList(relationshipTypes),
      parseList(nodeTypes),
    );
  }

  @Get('path')
  async shortestPath(
    @Query('sourceId') sourceId: string,
    @Query('targetId') targetId: string,
    @Query('maxDepth') maxDepth?: string,
    @Query('relationshipTypes') relationshipTypes?: string,
    @Query('nodeTypes') nodeTypes?: string,
  ) {
    return this.optimusKgService.shortestPath(
      sourceId,
      targetId,
      parseInteger(maxDepth, 6),
      parseList(relationshipTypes),
      parseList(nodeTypes),
    );
  }

  @Get('nodes/:id')
  async nodeDetails(@Param('id') nodeId: string) {
    return this.optimusKgService.nodeDetails(nodeId);
  }
}
