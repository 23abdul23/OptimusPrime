# ADR-011: Replanning Loop

- Status: Accepted and implemented in Phase 10
- Phase: 10

## Context

The previous graph-agent flow was still effectively:

`plan -> retrieve -> answer`

That meant the backend could stop after a weak first retrieval even when a second bounded retrieval pass was still plausible.

## Decision

Introduce a bounded `ReplanningAgentService` and wire an explicit:

`plan -> retrieve -> evidence assessment -> replan if needed`

loop into `GraphAgentService`.

The loop remains deterministic and capped rather than becoming an open-ended autonomous search.

## Consequences

- relationship queries can escalate from direct/path evidence to shared-pathway or shared-disease evidence
- the backend can stop early when evidence is sufficient
- retrieval remains bounded and predictable

## Implementation Notes

Phase 10 introduces `ReplanningAgentService` and adds a capped replanning loop to orchestration.

Changed files:

- `backend/src/graph-agent/replanning-agent.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
