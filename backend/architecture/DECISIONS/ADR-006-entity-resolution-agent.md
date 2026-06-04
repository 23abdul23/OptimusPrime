# ADR-006: Entity Resolution Agent

- Status: Accepted and implemented in Phase 5
- Phase: 5

## Context

The previous entity-resolution path used one blended candidate-ranking pass.

That made it harder to reason about:

- why a candidate won
- whether an exact or alias match existed
- when semantic matching was being used too early

## Decision

Introduce a staged `EntityResolutionAgentService` with explicit resolution order:

1. exact
2. alias
3. synonym
4. identifier
5. semantic

The knowledge graph remains the source of truth for resolution.

## Consequences

- resolution behavior becomes easier to audit
- semantic matching becomes a fallback rather than the default
- resolved entities now carry `resolutionStage`

## Implementation Notes

Phase 5 introduces `EntityResolutionAgentService` and rewires graph-agent orchestration to use it.

Changed files:

- `backend/src/graph-agent/entity-resolution-agent.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
