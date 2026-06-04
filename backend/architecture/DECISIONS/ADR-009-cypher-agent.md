# ADR-009: Cypher Agent

- Status: Accepted and implemented in Phase 8
- Phase: 8

## Context

Guarded Cypher execution previously lived inside `GraphRetrieverService`.

That left read-only validation, cost estimation, and execution policy coupled to the generic retrieval executor.

## Decision

Introduce `CypherAgentService` as the dedicated Cypher boundary.

Responsibilities:

- extract explicit Cypher from user input
- validate read-only Cypher
- estimate query cost heuristically
- execute validated queries safely
- provide template execution for backend retrieval operations

## Consequences

- Cypher safety policy is centralized
- retrieval operations can execute validated Cypher templates through one boundary
- explicit user Cypher stays isolated from the normal retrieval-operation path

## Implementation Notes

Phase 8 introduces `CypherAgentService` and routes both explicit guarded Cypher requests and retrieval-operation template execution through it.

Changed files:

- `backend/src/graph-agent/cypher-agent.service.ts`
- `backend/src/graph-agent/retrieval-operations.service.ts`
- `backend/src/graph-agent/graph-retriever.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
