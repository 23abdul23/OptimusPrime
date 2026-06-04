# ADR-003: Planner

- Status: Accepted with incremental implementation in Phases 1-2
- Phase: 2

## Context

The current planner already exists, but it is tightly coupled to:

- heuristic intent interpretation
- primary/secondary anchor selection
- direct retrieval-step emission

## Decision

Keep the current planner temporarily, but evolve it toward a context-aware retrieval-planning agent that consumes:

- query route
- graph context
- resolved entities
- session state

## Consequences

- early phases can improve routing and graph-context behavior without replacing the entire planner
- later phases can extract retrieval operations cleanly

## Implementation Notes

Phase 1 and Phase 2 keep the existing planner service, but expand its inputs and behavior.

Implemented changes so far:

- planner now consumes `QueryRoute`
- planner now consumes `GraphContextResult`
- graph-only selected-node requests can branch into a graph-summary planner path instead of generic neighborhood loading

Changed files:

- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`

Deferred work:

- split planner from retrieval operations fully
- replace heuristic planner branches with typed graph-operation planning
- introduce iterative re-planning
