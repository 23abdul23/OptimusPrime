# ADR-003: Planner

- Status: Accepted with incremental implementation in Phases 1-4
- Phase: 4

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

Phase 1 through Phase 4 keep the existing planner service, but expand its inputs and behavior.

Implemented changes so far:

- planner now consumes `QueryRoute`
- planner now consumes `GraphContextResult`
- planner now consumes `QueryIntentClassification` from `IntentAgentService`
- graph-only selected-node requests can branch into explicit graph-analysis operations instead of generic neighborhood loading
- graph commonality and graph connection prompts can map to dedicated graph-analysis tools
- entity-centric prompts continue to emit retrieval operations while graph-only prompts use graph-analysis tools

Changed files:

- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/intent-agent.service.ts`

Deferred work:

- split planner from retrieval operations fully
- replace heuristic planner branches with typed graph-operation planning
- introduce iterative re-planning
