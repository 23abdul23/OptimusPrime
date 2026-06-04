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

Phase 1 introduced `QueryRouterService` and later hardening extended it into an execution-strategy gatekeeper before extraction and resolution.

Implemented behavior:

- classify requests as `ENTITY_QUERY | GRAPH_QUERY | MIXED_QUERY | CYPHER_QUERY | UNKNOWN`
- return route-level execution strategy fields:
  - `intent`
  - `requiresEntityExtraction`
  - `requiresEntityResolution`
  - `requiresGraphContext`
  - `preferredExecutor`
- allow graph-subject requests such as `Summarize these selected nodes` to bypass extraction and resolution entirely
- allow mixed requests to combine selected graph context with explicit entity resolution only when needed
- prevent imperative graph-operation verbs such as `summarize`, `compare`, `explain`, `analyze`, and `describe` from being treated as reasons to force entity work

Changed files:

- `backend/src/graph-agent/query-router.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`

Observed effect after routing hardening:

- graph-only selected-node prompts such as `Summarize these nodes` no longer start extraction or resolution
- the system now has a typed route result that gates downstream stages before orchestration continues
