# ADR-004: Graph Analysis Layer

- Status: Proposed in Phase 0
- Phase: 0

## Context

The current system is retrieval-centric and lacks an explicit graph-analysis layer.

Graph queries such as:

- `Summarize these nodes`
- `What do these genes have in common?`
- `Explain this subgraph`

should map to graph analysis operations rather than generic retrieval fallbacks.

## Decision

Introduce a dedicated graph-analysis layer after graph context and retrieval planning are in place.

## Consequences

- graph-query behavior becomes explicit
- graph-centric workflows become testable independently from entity resolution

## Implementation Notes

- Not implemented in Phase 0-2.
- Phase 0 establishes the record so future changes do not collapse back into generic retrieval fallbacks.
