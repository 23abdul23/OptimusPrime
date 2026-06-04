# ADR-005: Intent Agent

- Status: Accepted and implemented in Phase 4
- Phase: 4

## Context

Intent classification was previously coupled to entity extraction.

That coupling caused:

- entity extraction to overreach into planning concerns
- prompt changes for intent to destabilize mention extraction
- graph-query classification to happen too late

## Decision

Introduce a dedicated `IntentAgentService` that classifies:

- primary intent
- operation
- requested entity types
- context-fallback allowance

Entity extraction remains limited to explicit mentions, concepts, selection references, and operator signals.

## Consequences

- intent can evolve without mutating mention extraction rules
- extraction becomes narrower and less hallucinatory
- planner inputs become explicit and typed

## Implementation Notes

Phase 4 introduces `IntentAgentService` and rewires orchestration and planning to consume `QueryIntentClassification`.

Changed files:

- `backend/src/graph-agent/intent-agent.service.ts`
- `backend/src/graph-agent/entity-extraction.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
