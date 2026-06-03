import neo4j, { type Node as Neo4jNode, type Relationship as Neo4jRelationship } from 'neo4j-driver';
import type { GraphAgentUIMessage } from './graph-agent.types';
import type { SerializedGraphPayload } from '@/optimuskg/optimuskg.service';

export function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }

  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
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

export function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function serializeGraphFromRecords(
  nodes: Neo4jNode[],
  relationships: Neo4jRelationship[],
  attributes: Record<string, unknown> = {},
): SerializedGraphPayload {
  const uniqueNodes = new Map<string, Neo4jNode>();
  for (const node of nodes) {
    uniqueNodes.set(String(node.properties.id), node);
  }

  const uniqueRelationships = new Map<string, Neo4jRelationship>();
  for (const relationship of relationships) {
    const edgeId = String(relationship.properties.edgeKey ?? relationship.elementId);
    uniqueRelationships.set(edgeId, relationship);
  }

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
    nodes: [...uniqueNodes.values()].map((node) => {
      const props = node.properties as Record<string, unknown>;
      return {
        key: String(props.id),
        attributes: compactRecord({
          ID: String(props.id),
          label: String(props.displayName ?? props.name ?? props.symbol ?? props.id),
          nodeType: String(props.typeName ?? props.typeCode ?? 'Entity'),
          typeCode: typeof props.typeCode === 'string' ? props.typeCode : undefined,
          description: typeof props.description === 'string' ? props.description : undefined,
          symbol: typeof props.symbol === 'string' ? props.symbol : undefined,
          aliases: parseStringArray(props.searchTerms),
          extra: parseJsonRecord(props.extraJson),
          ...props,
        }),
      };
    }),
    edges: [...uniqueRelationships.values()].map((relationship) => {
      const props = relationship.properties as Record<string, unknown>;
      return {
        key: String(props.edgeKey ?? relationship.elementId),
        source: String(props.fromId),
        target: String(props.toId),
        undirected: Boolean(props.undirected),
        attributes: compactRecord({
          relation: relationship.type,
          label: relationship.type,
          edgeType: relationship.type,
          labelCode: typeof props.labelCode === 'string' ? props.labelCode : undefined,
          sourceDirect: parseStringArray(props.sourceDirect),
          sourceIndirect: parseStringArray(props.sourceIndirect),
          details: parseJsonRecord(props.propertiesJson),
          ...props,
        }),
      };
    }),
  };
}

export function normalizeNodeType(value: string) {
  return value.trim().toLowerCase();
}

export function matchesType(typeName: string, hints: string[]) {
  if (hints.length === 0) {
    return true;
  }

  const normalized = normalizeNodeType(typeName);
  return hints.some((hint) => normalized.includes(normalizeNodeType(hint)));
}

export function extractLatestUserText(messages: GraphAgentUIMessage[] | undefined) {
  if (!messages?.length) {
    return '';
  }

  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUserMessage) {
    return '';
  }

  return lastUserMessage.parts
    .filter((part): part is Extract<(typeof lastUserMessage.parts)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function createStepId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
