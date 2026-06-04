# ADR-007: Retrieval Planning Agent

- Status: Accepted and implemented in Phase 6
- Phase: 6

## Context

The previous planner still emitted executable tool steps directly.

That meant planning remained coupled to execution details:

- graph intent to tool mapping happened in one place
- execution concerns leaked into planning decisions
- it was difficult to insert a dedicated retrieval-operations layer

## Decision

Introduce `RetrievalPlanningAgentService` as the operation-planning boundary.

The planning agent now emits typed retrieval plan steps containing:

- `operation`
- `executor`
- `description`
- `params`

The legacy `tool` field is retained only for compatibility with existing UI/debug payloads.

## Consequences

- planning is now operation-first instead of tool-first
- retrieval execution can evolve independently from planning
- Cypher generation is no longer planned directly as a raw retriever concern

## Implementation Notes

Phase 6 replaces the old planner wiring with `RetrievalPlanningAgentService`.

Changed files:

- `backend/src/graph-agent/retrieval-planning-agent.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
