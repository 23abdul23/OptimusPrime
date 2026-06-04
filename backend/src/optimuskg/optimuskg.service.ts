import { Injectable } from '@nestjs/common';
import { Neo4jService } from '@/neo4j/neo4j.service';
import { RedisService } from '@/redis/redis.service';
import neo4j, { type Node as Neo4jNode, type Relationship as Neo4jRelationship } from 'neo4j-driver';

export interface OptimusNodeSummary {
  id: string;
  typeCode: string;
  typeName: string;
  displayName: string;
  degree: number;
  properties: Record<string, unknown>;
}

export interface OptimusEdgeSummary {
  id: string;
  from: string;
  to: string;
  relation: string;
  labelCode: string;
  undirected: boolean;
  properties: Record<string, unknown>;
}

interface SerializedNode {
  key: string;
  attributes: Record<string, unknown>;
}

interface SerializedEdge {
  key: string;
  source: string;
  target: string;
  attributes: Record<string, unknown>;
  undirected?: boolean;
}

export interface SerializedGraphPayload {
  attributes: Record<string, unknown>;
  options: {
    type: 'mixed';
    multi: true;
    allowSelfLoops: true;
  };
  nodes: SerializedNode[];
  edges: SerializedEdge[];
}

export interface OptimusSearchResult {
  id: string;
  typeCode: string;
  typeName: string;
  displayName: string;
  matchedOn: string[];
}

export interface OptimusResolutionCandidate extends OptimusSearchResult {
  score: number;
  description?: string;
  symbol?: string;
  aliases: string[];
  sourceIds: string[];
  sourceNames: string[];
}

export interface OptimusGraphStats {
  nodeCount: number;
  edgeCount: number;
  nodeTypes: Array<{
    typeCode: string;
    typeName: string;
    count: number;
  }>;
  relationshipTypes: Array<{
    relation: string;
    count: number;
  }>;
}

const FULLTEXT_INDEX = 'entitySearch';
const MAX_SUBGRAPH_RADIUS = 3;
const MAX_EXPANSION_SEED_COUNT = 5;
const DEFAULT_SUBGRAPH_HARD_LIMIT = 1500;
const DEFAULT_DEGREE_LIMIT = 24;
const FRONTIER_BATCH_LIMIT = 150;
const QUERY_TIMEOUT_MS = 15000;
const CACHE_TTL_STATS_SECONDS = 300;
const CACHE_TTL_RANDOM_SECONDS = 60;
const CACHE_TTL_SEARCH_SECONDS = 120;
const CACHE_TTL_NODE_DETAILS_SECONDS = 300;
const SHORTEST_PATH_QUERY_TIMEOUT_MS = 8000;

function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function compactProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildFulltextQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[+\-!(){}\[\]^"~*?:\\/]/g, ''))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return query.trim();
  }

  return tokens.map((token) => `${token.toLowerCase()}*`).join(' AND ');
}

function normalizeSearchInput(query: string): string {
  return query.trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
}

function parseArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function mapNode(node: Neo4jNode, degree = 0): OptimusNodeSummary {
  const props = node.properties as Record<string, unknown>;
  return {
    id: String(props.id),
    typeCode: String(props.typeCode),
    typeName: String(props.typeName),
    displayName: String(props.displayName),
    degree,
    properties: compactProperties({
      id: typeof props.id === 'string' ? props.id : undefined,
      typeCode: typeof props.typeCode === 'string' ? props.typeCode : undefined,
      typeName: typeof props.typeName === 'string' ? props.typeName : undefined,
      name: typeof props.name === 'string' ? props.name : undefined,
      symbol: typeof props.symbol === 'string' ? props.symbol : undefined,
      approvalStatus: typeof props.approvalStatus === 'string' ? props.approvalStatus : undefined,
      description: typeof props.description === 'string' ? props.description : undefined,
      sourceIds: parseArray(props.sourceIds),
      sourceNames: parseArray(props.sourceNames),
      sourceDirect: parseArray(props.sourceDirect),
      sourceIndirect: parseArray(props.sourceIndirect),
      searchTerms: parseArray(props.searchTerms),
      extra: parseJsonRecord(props.extraJson),
    }),
  };
}

function mapRelationship(relationship: Neo4jRelationship): OptimusEdgeSummary {
  const props = relationship.properties as Record<string, unknown>;
  return {
    id: String(props.edgeKey ?? relationship.elementId),
    from: String(props.fromId),
    to: String(props.toId),
    relation: relationship.type,
    labelCode: typeof props.labelCode === 'string' ? props.labelCode : '',
    undirected: Boolean(props.undirected),
    properties: compactProperties({
      edgeKey: typeof props.edgeKey === 'string' ? props.edgeKey : undefined,
      labelCode: typeof props.labelCode === 'string' ? props.labelCode : undefined,
      sourceDirect: parseArray(props.sourceDirect),
      sourceIndirect: parseArray(props.sourceIndirect),
      details: parseJsonRecord(props.propertiesJson),
    }),
  };
}

@Injectable()
export class OptimusKgService {
  constructor(
    private readonly neo4jService: Neo4jService,
    private readonly redisService: RedisService,
  ) {}

  private cacheKey(scope: string, input: Record<string, unknown> = {}) {
    return `optimuskg:${scope}:${JSON.stringify(input)}`;
  }

  private async getCachedValue<T>(key: string): Promise<T | undefined> {
    try {
      const cached = await this.redisService.redisClient.get(key);
      if (!cached) {
        return undefined;
      }

      return JSON.parse(cached) as T;
    } catch {
      return undefined;
    }
  }

  private async setCachedValue<T>(key: string, value: T, ttlSeconds: number) {
    try {
      await this.redisService.redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // Ignore cache write failures so Redis does not block graph reads.
    }
  }

  async randomNode(nodeTypes: string[] = []): Promise<OptimusNodeSummary | null> {
    const cacheKey = this.cacheKey('random', { nodeTypes });
    const cached = await this.getCachedValue<OptimusNodeSummary | null>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const session = this.neo4jService.getSession();

    try {
      const result = await session.run(
        `
          MATCH (n:Entity)
          WHERE size($nodeTypes) = 0 OR n.typeName IN $nodeTypes OR n.typeCode IN $nodeTypes
          WITH n, COUNT { (n)--() } AS degree, rand() AS sortKey
          ORDER BY sortKey
          LIMIT 1
          RETURN n, degree
        `,
        { nodeTypes },
      );

      const record = result.records[0];
      if (!record) {
        await this.setCachedValue(cacheKey, null, CACHE_TTL_RANDOM_SECONDS);
        return null;
      }

      const node = mapNode(record.get('n') as Neo4jNode, toNumber(record.get('degree')));
      await this.setCachedValue(cacheKey, node, CACHE_TTL_RANDOM_SECONDS);
      return node;
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  async searchNodes(query: string, limit: number, nodeTypes: string[] = []): Promise<OptimusSearchResult[]> {
    const boundedLimit = clampInteger(limit, 1, 50);
    const cacheKey = this.cacheKey('search', {
      query: query.trim().toLowerCase(),
      limit: boundedLimit,
      nodeTypes,
    });
    const cached = await this.getCachedValue<OptimusSearchResult[]>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const session = this.neo4jService.getSession();
    const fulltextQuery = buildFulltextQuery(query);

    try {
      const result = await session.run(
        `
          CALL db.index.fulltext.queryNodes($indexName, $query) YIELD node, score
          WHERE size($nodeTypes) = 0 OR node.typeName IN $nodeTypes OR node.typeCode IN $nodeTypes
          RETURN node, score
          ORDER BY score DESC
          LIMIT $limit
        `,
        {
          indexName: FULLTEXT_INDEX,
          query: fulltextQuery,
          limit: neo4j.int(boundedLimit),
          nodeTypes,
        },
      );

      const payload = result.records.map((record) => {
        const node = record.get('node') as Neo4jNode;
        const props = node.properties as Record<string, unknown>;
        return {
          id: String(props.id),
          typeCode: String(props.typeCode),
          typeName: String(props.typeName),
          displayName: String(props.displayName),
          matchedOn: String(props.searchText ?? '')
            .split(' ')
            .filter((token) => token.includes(query.trim().toLowerCase()))
            .slice(0, 5),
        };
      });
      await this.setCachedValue(cacheKey, payload, CACHE_TTL_SEARCH_SECONDS);
      return payload;
    } catch {
      const fallback = await session.run(
        `
          MATCH (n:Entity)
          WHERE (size($nodeTypes) = 0 OR n.typeName IN $nodeTypes OR n.typeCode IN $nodeTypes)
            AND (
              toLower(n.displayName) CONTAINS toLower($query)
              OR toLower(coalesce(n.name, '')) CONTAINS toLower($query)
              OR toLower(coalesce(n.symbol, '')) CONTAINS toLower($query)
              OR toLower(coalesce(n.searchText, '')) CONTAINS toLower($query)
            )
          RETURN n
          ORDER BY n.displayName
          LIMIT $limit
        `,
        {
          query,
          limit: neo4j.int(boundedLimit),
          nodeTypes,
        },
      );

      const payload = fallback.records.map((record) => {
        const node = record.get('n') as Neo4jNode;
        const props = node.properties as Record<string, unknown>;
        return {
          id: String(props.id),
          typeCode: String(props.typeCode),
          typeName: String(props.typeName),
          displayName: String(props.displayName),
          matchedOn: ['displayName'],
        };
      });
      await this.setCachedValue(cacheKey, payload, CACHE_TTL_SEARCH_SECONDS);
      return payload;
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  async resolveNodes(
    queries: string[],
    limit: number,
    nodeTypes: string[] = [],
  ): Promise<OptimusResolutionCandidate[]> {
    const boundedLimit = clampInteger(limit, 1, 25);
    const normalizedQueries = Array.from(new Set(queries.map(normalizeSearchInput).filter((value) => value.length > 0)));
    const primaryQuery = normalizedQueries[0];

    if (!primaryQuery) {
      return [];
    }

    const cacheKey = this.cacheKey('resolve', {
      queries: normalizedQueries,
      limit: boundedLimit,
      nodeTypes,
    });
    const cached = await this.getCachedValue<OptimusResolutionCandidate[]>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const session = this.neo4jService.getSession();
    const fulltextQuery = buildFulltextQuery(primaryQuery);

    try {
      const metadataResult = await session.run(
        `
          MATCH (n:Entity)
          WHERE size($nodeTypes) = 0 OR n.typeName IN $nodeTypes OR n.typeCode IN $nodeTypes
          WITH
            n,
            [match IN [
              CASE WHEN toLower(trim(coalesce(n.displayName, ''))) IN $exactVariants THEN 'displayName:exact' END,
              CASE WHEN toLower(trim(coalesce(n.name, ''))) IN $exactVariants THEN 'name:exact' END,
              CASE WHEN toLower(trim(coalesce(n.symbol, ''))) IN $exactVariants THEN 'symbol:exact' END,
              CASE WHEN toLower(trim(coalesce(n.id, ''))) IN $exactVariants THEN 'id:exact' END,
              CASE WHEN any(term IN coalesce(n.searchTerms, []) WHERE toLower(trim(term)) IN $exactVariants) THEN 'alias:exact' END,
              CASE WHEN any(term IN coalesce(n.sourceIds, []) WHERE toLower(trim(term)) IN $exactVariants) THEN 'identifier:exact' END,
              CASE WHEN any(term IN coalesce(n.sourceNames, []) WHERE toLower(trim(term)) IN $exactVariants) THEN 'sourceName:exact' END,
              CASE WHEN toLower(coalesce(n.displayName, '')) CONTAINS $primaryQuery THEN 'displayName:contains' END,
              CASE WHEN toLower(coalesce(n.name, '')) CONTAINS $primaryQuery THEN 'name:contains' END,
              CASE WHEN toLower(coalesce(n.symbol, '')) CONTAINS $primaryQuery THEN 'symbol:contains' END,
              CASE WHEN any(term IN coalesce(n.searchTerms, []) WHERE toLower(term) CONTAINS $primaryQuery) THEN 'alias:contains' END,
              CASE WHEN any(term IN coalesce(n.sourceIds, []) WHERE toLower(term) CONTAINS $primaryQuery) THEN 'identifier:contains' END,
              CASE WHEN any(term IN coalesce(n.sourceNames, []) WHERE toLower(term) CONTAINS $primaryQuery) THEN 'sourceName:contains' END,
              CASE WHEN toLower(coalesce(n.description, '')) CONTAINS $primaryQuery THEN 'description:contains' END,
              CASE WHEN toLower(coalesce(n.searchText, '')) CONTAINS $primaryQuery THEN 'searchText:contains' END,
              CASE WHEN toLower(coalesce(n.extraJson, '')) CONTAINS $primaryQuery THEN 'extra:contains' END
            ] WHERE match IS NOT NULL] AS matchedOn
          WITH
            n,
            matchedOn,
            reduce(score = 0, match IN matchedOn |
              score + CASE
                WHEN match = 'displayName:exact' THEN 180
                WHEN match = 'symbol:exact' THEN 170
                WHEN match = 'id:exact' THEN 170
                WHEN match = 'alias:exact' THEN 165
                WHEN match = 'identifier:exact' THEN 165
                WHEN match = 'name:exact' THEN 155
                WHEN match = 'sourceName:exact' THEN 145
                WHEN match = 'displayName:contains' THEN 90
                WHEN match = 'symbol:contains' THEN 88
                WHEN match = 'alias:contains' THEN 84
                WHEN match = 'identifier:contains' THEN 82
                WHEN match = 'name:contains' THEN 78
                WHEN match = 'sourceName:contains' THEN 70
                WHEN match = 'searchText:contains' THEN 45
                WHEN match = 'description:contains' THEN 35
                WHEN match = 'extra:contains' THEN 30
                ELSE 0
              END
            ) AS score
          WHERE score > 0
          RETURN n, matchedOn, score
          ORDER BY score DESC, size(matchedOn) DESC, size(coalesce(n.searchTerms, [])) DESC, coalesce(n.displayName, n.id)
          LIMIT $limit
        `,
        {
          exactVariants: normalizedQueries,
          primaryQuery,
          nodeTypes,
          limit: neo4j.int(boundedLimit),
        },
      );

      const merged = new Map<string, OptimusResolutionCandidate>();

      for (const record of metadataResult.records) {
        const node = record.get('n') as Neo4jNode;
        const props = node.properties as Record<string, unknown>;
        const candidate: OptimusResolutionCandidate = {
          id: String(props.id),
          typeCode: String(props.typeCode),
          typeName: String(props.typeName),
          displayName: String(props.displayName),
          matchedOn: parseArray(record.get('matchedOn')),
          score: toNumber(record.get('score')),
          description: typeof props.description === 'string' ? props.description : undefined,
          symbol: typeof props.symbol === 'string' ? props.symbol : undefined,
          aliases: parseArray(props.searchTerms),
          sourceIds: parseArray(props.sourceIds),
          sourceNames: parseArray(props.sourceNames),
        };
        merged.set(candidate.id, candidate);
      }

      try {
        const fulltextResult = await session.run(
          `
            CALL db.index.fulltext.queryNodes($indexName, $query) YIELD node, score
            WHERE size($nodeTypes) = 0 OR node.typeName IN $nodeTypes OR node.typeCode IN $nodeTypes
            RETURN node, score
            ORDER BY score DESC
            LIMIT $limit
          `,
          {
            indexName: FULLTEXT_INDEX,
            query: fulltextQuery,
            nodeTypes,
            limit: neo4j.int(boundedLimit),
          },
        );

        for (const record of fulltextResult.records) {
          const node = record.get('node') as Neo4jNode;
          const props = node.properties as Record<string, unknown>;
          const id = String(props.id);
          const fulltextScore = Math.max(1, Math.round(toNumber(record.get('score')) * 20));
          const existing = merged.get(id);

          if (existing) {
            existing.score = Math.max(existing.score, fulltextScore);
            existing.matchedOn = Array.from(new Set([...existing.matchedOn, 'fulltext']));
            continue;
          }

          merged.set(id, {
            id,
            typeCode: String(props.typeCode),
            typeName: String(props.typeName),
            displayName: String(props.displayName),
            matchedOn: ['fulltext'],
            score: fulltextScore,
            description: typeof props.description === 'string' ? props.description : undefined,
            symbol: typeof props.symbol === 'string' ? props.symbol : undefined,
            aliases: parseArray(props.searchTerms),
            sourceIds: parseArray(props.sourceIds),
            sourceNames: parseArray(props.sourceNames),
          });
        }
      } catch {
        // Ignore fulltext failures when exact metadata search succeeded.
      }

      const payload = [...merged.values()]
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.matchedOn.length - a.matchedOn.length ||
            a.displayName.length - b.displayName.length ||
            a.displayName.localeCompare(b.displayName),
        )
        .slice(0, boundedLimit);

      await this.setCachedValue(cacheKey, payload, CACHE_TTL_SEARCH_SECONDS);
      return payload;
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  async graphStats(): Promise<OptimusGraphStats> {
    const cacheKey = this.cacheKey('stats');
    const cached = await this.getCachedValue<OptimusGraphStats>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const session = this.neo4jService.getSession();

    try {
      const countsResult = await session.run('MATCH (n:Entity) RETURN count(n) AS nodeCount');
      const typesResult = await session.run(
        'MATCH (n:Entity) RETURN n.typeCode AS typeCode, n.typeName AS typeName, count(*) AS count ORDER BY typeName',
      );
      const relationsResult = await session.run(
        'MATCH (:Entity)-[r]-(:Entity) RETURN type(r) AS relation, count(*) AS count ORDER BY relation',
      );

      const payload = {
        nodeCount: toNumber(countsResult.records[0]?.get('nodeCount')),
        edgeCount: relationsResult.records.reduce((sum, record) => sum + toNumber(record.get('count')), 0),
        nodeTypes: typesResult.records.map((record) => ({
          typeCode: String(record.get('typeCode')),
          typeName: String(record.get('typeName')),
          count: toNumber(record.get('count')),
        })),
        relationshipTypes: relationsResult.records.map((record) => ({
          relation: String(record.get('relation')),
          count: toNumber(record.get('count')),
        })),
      };
      await this.setCachedValue(cacheKey, payload, CACHE_TTL_STATS_SECONDS);
      return payload;
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  async nodeDetails(nodeId: string): Promise<OptimusNodeSummary> {
    const cacheKey = this.cacheKey('node-details', { nodeId });
    const cached = await this.getCachedValue<OptimusNodeSummary>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const session = this.neo4jService.getSession();

    try {
      const result = await session.run(
        `
          MATCH (n:Entity {id: $nodeId})
          OPTIONAL MATCH (n)-[r]-()
          RETURN n, count(r) AS degree
          LIMIT 1
        `,
        { nodeId },
      );

      const record = result.records[0];
      if (!record) {
        throw new Error(`OptimusKG node ${nodeId} not found`);
      }

      const payload = mapNode(record.get('n') as Neo4jNode, toNumber(record.get('degree')));
      await this.setCachedValue(cacheKey, payload, CACHE_TTL_NODE_DETAILS_SECONDS);
      return payload;
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  async subgraph(
    nodeId: string,
    radius: number,
    maxNodes: number,
    degreeLimit: number,
    relationshipTypes: string[] = [],
    nodeTypes: string[] = [],
  ): Promise<SerializedGraphPayload> {
    const session = this.neo4jService.getSession();
    const boundedRadius = clampInteger(radius, 1, MAX_SUBGRAPH_RADIUS);
    const boundedDegreeLimit = clampInteger(degreeLimit, 1, DEFAULT_DEGREE_LIMIT);
    const boundedMaxNodes = clampInteger(maxNodes, 1, DEFAULT_SUBGRAPH_HARD_LIMIT);

    try {
      const centerResult = await session.run(
        `
          MATCH (center:Entity {id: $nodeId})
          RETURN center
        `,
        { nodeId },
      );

      const centerRecord = centerResult.records[0];
      if (!centerRecord) {
        return this.serializeGraph([], [], { centerNodeId: nodeId, radius: boundedRadius, truncated: false });
      }

      const center = centerRecord.get('center') as Neo4jNode;
      const nodesById = new Map<string, Neo4jNode>([[String(center.properties.id), center]]);
      const edgesById = new Map<string, OptimusEdgeSummary>();
      const visited = new Set<string>([String(center.properties.id)]);
      let frontier = [String(center.properties.id)];
      let truncated = false;

      for (let depth = 0; depth < boundedRadius && frontier.length > 0; depth += 1) {
        if (nodesById.size >= boundedMaxNodes) {
          truncated = true;
          break;
        }

        const remainingCapacity = Math.max(1, boundedMaxNodes - nodesById.size);
        const frontierBatchSize = Math.max(1, Math.min(frontier.length, remainingCapacity, FRONTIER_BATCH_LIMIT));
        const frontierBatch = frontier.slice(0, frontierBatchSize);
        if (frontier.length > frontierBatchSize) {
          truncated = true;
        }

        const expansionResult = await session.run(
          `
            UNWIND $frontier AS currentId
            MATCH (source:Entity {id: currentId})
            CALL {
              WITH source
              MATCH (source)-[rel]-(target:Entity)
              WHERE (size($relationshipTypes) = 0 OR type(rel) IN $relationshipTypes)
                AND (
                  size($nodeTypes) = 0
                  OR target.typeName IN $nodeTypes
                  OR target.typeCode IN $nodeTypes
                  OR target.id = $centerNodeId
                )
              RETURN rel, target
              ORDER BY coalesce(rel.score, 0) DESC, coalesce(target.displayName, target.id)
              LIMIT $perNodeLimit
            }
            RETURN source, rel, target
          `,
          {
            frontier: frontierBatch,
            centerNodeId: nodeId,
            nodeTypes,
            relationshipTypes,
            perNodeLimit: neo4j.int(boundedDegreeLimit),
          },
          { timeout: QUERY_TIMEOUT_MS },
        );

        const nextFrontier: string[] = [];
        const nextFrontierSet = new Set<string>();

        for (const record of expansionResult.records) {
          const source = record.get('source') as Neo4jNode;
          const target = record.get('target') as Neo4jNode;
          const relationship = record.get('rel') as Neo4jRelationship;
          const targetId = String(target.properties.id);
          const sourceId = String(source.properties.id);
          nodesById.set(sourceId, source);

          const edgeSummary = mapRelationship(relationship);
          edgesById.set(edgeSummary.id, edgeSummary);

          if (!nodesById.has(targetId)) {
            if (nodesById.size >= boundedMaxNodes) {
              truncated = true;
              continue;
            }

            nodesById.set(targetId, target);
          }

          if (!visited.has(targetId) && !nextFrontierSet.has(targetId)) {
            visited.add(targetId);
            nextFrontierSet.add(targetId);
            nextFrontier.push(targetId);
          }
        }

        frontier = nextFrontier;
      }

      const degreeResult = await session.run(
        `
          UNWIND $nodeIds AS candidateId
          MATCH (n:Entity {id: candidateId})
          OPTIONAL MATCH (n)-[r]-()
          RETURN n.id AS nodeId, count(r) AS degree
        `,
        {
          nodeIds: [...nodesById.keys()],
        },
      );

      const degreeByNodeId = new Map<string, number>(
        degreeResult.records.map((record) => [String(record.get('nodeId')), toNumber(record.get('degree'))]),
      );

      const nodes = [...nodesById.values()].map((node) => mapNode(node, degreeByNodeId.get(String(node.properties.id)) ?? 0));
      const edges = [...edgesById.values()].filter((edge) => nodesById.has(edge.from) && nodesById.has(edge.to));

      return this.serializeGraph(nodes, edges, {
        centerNodeId: nodeId,
        radius: boundedRadius,
        truncated,
      });
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  async expandSubgraph(
    nodeIds: string[],
    hops: number,
    maxNodes: number,
    degreeLimit: number,
    relationshipTypes: string[] = [],
    nodeTypes: string[] = [],
  ): Promise<SerializedGraphPayload> {
    const mergedNodes = new Map<string, OptimusNodeSummary>();
    const mergedEdges = new Map<string, OptimusEdgeSummary>();
    const boundedNodeIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0))).slice(
      0,
      MAX_EXPANSION_SEED_COUNT,
    );
    const boundedMaxNodes = clampInteger(maxNodes, 1, DEFAULT_SUBGRAPH_HARD_LIMIT);
    const perSeedBudget =
      boundedNodeIds.length > 0
        ? Math.max(24, Math.min(boundedMaxNodes, Math.ceil(boundedMaxNodes / boundedNodeIds.length)))
        : boundedMaxNodes;
    let truncated = false;

    for (const nodeId of boundedNodeIds) {
      const remainingCapacity = boundedMaxNodes - mergedNodes.size;
      if (remainingCapacity <= 0) {
        truncated = true;
        break;
      }

      const seedBudget = Math.max(1, Math.min(remainingCapacity, perSeedBudget));
      const subgraph = await this.subgraph(nodeId, hops, seedBudget, degreeLimit, relationshipTypes, nodeTypes);

      for (const node of subgraph.nodes) {
        if (!mergedNodes.has(node.key) && mergedNodes.size >= boundedMaxNodes) {
          truncated = true;
          continue;
        }

        mergedNodes.set(node.key, {
          id: node.key,
          typeCode: String(node.attributes.typeCode ?? ''),
          typeName: String(node.attributes.nodeType ?? ''),
          displayName: String(node.attributes.label ?? node.key),
          degree: toNumber(node.attributes.degree),
          properties: node.attributes,
        });
      }

      for (const edge of subgraph.edges) {
        if (!mergedNodes.has(edge.source) || !mergedNodes.has(edge.target)) {
          truncated = true;
          continue;
        }

        mergedEdges.set(edge.key, {
          id: edge.key,
          from: edge.source,
          to: edge.target,
          relation: String(edge.attributes.relation ?? ''),
          labelCode: String(edge.attributes.labelCode ?? ''),
          undirected: Boolean(edge.undirected),
          properties: edge.attributes,
        });
      }

      if (subgraph.attributes.truncated === true) {
        truncated = true;
      }
    }

    return this.serializeGraph([...mergedNodes.values()], [...mergedEdges.values()], {
      expandedFromNodeIds: boundedNodeIds,
      radius: clampInteger(hops, 1, MAX_SUBGRAPH_RADIUS),
      expansionSeedLimitApplied: nodeIds.length > boundedNodeIds.length,
      truncated,
    });
  }

  async shortestPath(
    sourceId: string,
    targetId: string,
    maxDepth: number,
    relationshipTypes: string[] = [],
    nodeTypes: string[] = [],
  ): Promise<{ found: boolean; graph: SerializedGraphPayload }> {
    const session = this.neo4jService.getSession();
    const boundedMaxDepth = clampInteger(maxDepth, 1, 12);

    try {
      const result = await session.run(
        `
          MATCH (source:Entity {id: $sourceId}), (target:Entity {id: $targetId})
          MATCH path = shortestPath((source)-[*..${boundedMaxDepth}]-(target))
          WHERE path IS NOT NULL
            AND ALL(node IN nodes(path) WHERE size($nodeTypes) = 0 OR node.typeName IN $nodeTypes OR node.typeCode IN $nodeTypes)
            AND ALL(rel IN relationships(path) WHERE size($relationshipTypes) = 0 OR type(rel) IN $relationshipTypes)
          RETURN nodes(path) AS nodes, relationships(path) AS relationships
        `,
        {
          sourceId,
          targetId,
          relationshipTypes,
          nodeTypes,
        },
        { timeout: SHORTEST_PATH_QUERY_TIMEOUT_MS },
      );

      const record = result.records[0];
      if (!record) {
        return {
          found: false,
          graph: this.serializeGraph([], [], { sourceId, targetId, maxDepth: boundedMaxDepth }),
        };
      }

      const nodes = (record.get('nodes') as Neo4jNode[]).map((node) => mapNode(node));
      const edges = (record.get('relationships') as Neo4jRelationship[]).map(mapRelationship);

      return {
        found: true,
        graph: this.serializeGraph(nodes, edges, {
          sourceId,
          targetId,
          maxDepth: boundedMaxDepth,
          pathFound: true,
        }),
      };
    } finally {
      await this.neo4jService.releaseSession(session);
    }
  }

  private serializeGraph(
    nodes: OptimusNodeSummary[],
    edges: OptimusEdgeSummary[],
    attributes: Record<string, unknown> = {},
  ): SerializedGraphPayload {
    return {
      attributes: {
        source: 'OptimusKG',
        generatedAt: new Date().toISOString(),
        ...attributes,
      },
      options: {
        type: 'mixed',
        multi: true,
        allowSelfLoops: true,
      },
      nodes: nodes.map((node) => ({
        key: node.id,
        attributes: compactProperties({
          ID: node.id,
          label: node.displayName,
          nodeType: node.typeName,
          typeCode: node.typeCode,
          degree: node.degree,
          description:
            typeof node.properties.description === 'string' ? node.properties.description : undefined,
          ...node.properties,
        }),
      })),
      edges: edges.map((edge) => ({
        key: edge.id,
        source: edge.from,
        target: edge.to,
        undirected: edge.undirected,
        attributes: compactProperties({
          relation: edge.relation,
          label: edge.relation,
          edgeType: edge.relation,
          labelCode: edge.labelCode,
          undirected: edge.undirected,
          ...edge.properties,
        }),
      })),
    };
  }
}
