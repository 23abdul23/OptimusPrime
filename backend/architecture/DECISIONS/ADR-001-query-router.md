# ADR-001: Query Router

- Status: Accepted and implemented in Phase 1
- Phase: 1

## Context

The current graph agent routes almost every request through entity extraction first.

That makes graph-centric requests such as:

- `Summarize these nodes`
- `Explain this subgraph`
- `Compare the selected proteins`

look like entity-resolution problems even when the graph selection already contains the true anchors.

## Decision

Introduce a `QueryRouter` as the first backend step after request parsing.

It classifies requests into:

- `ENTITY_QUERY`
- `GRAPH_QUERY`
- `MIXED_QUERY`
- `CYPHER_QUERY`
- `UNKNOWN`

## Consequences

- graph-only requests can bypass entity-resolution-first behavior
- mixed requests can combine graph selection context with explicit entity mentions
- Cypher requests become explicit instead of accidental fallthroughs

## Implementation Notes

Phase 1 implementation introduces `QueryRouterService` and wires it into the first backend graph-agent step before entity resolution.

Implemented behavior:

- classify requests as `ENTITY_QUERY | GRAPH_QUERY | MIXED_QUERY | CYPHER_QUERY | UNKNOWN`
- bypass entity-resolution-first behavior for graph-only requests
- allow planner branches to distinguish graph-only selected-node workflows from entity-only workflows

Changed files:

- `backend/src/graph-agent/query-router.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`

Observed Phase 1 effect:

- graph-only selected-node prompts such as `Summarize these nodes` no longer need to start from entity resolution
- the system now has a typed route result available before extraction/resolution/planning
