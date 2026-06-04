# ADR-010: Evidence Agent

- Status: Accepted and implemented in Phase 9
- Phase: 9

## Context

The earlier evidence layer ranked items but did not expose an explicit evidence assessment boundary.

That made it hard to answer:

- how confident the backend is in the current evidence
- whether more retrieval is needed
- how provenance and analytical coverage affect the final answer

## Decision

Introduce `EvidenceAgentService` as the dedicated evidence boundary.

Responsibilities:

- rank evidence items
- score evidence items
- estimate bundle confidence
- summarize provenance coverage
- decide whether another retrieval pass is warranted

## Consequences

- the orchestration layer can make a bounded “enough evidence?” decision
- reasoning receives explicit confidence framing instead of inferring it indirectly
- evidence quality becomes inspectable in the response payload

## Implementation Notes

Phase 9 introduces `EvidenceAgentService` and extends `GraphEvidenceBundle` with assessment metadata.

Changed files:

- `backend/src/graph-agent/evidence-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `frontend/lib/graph-agent-types.ts`
