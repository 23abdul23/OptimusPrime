# ADR-004: Graph Analysis Layer

- Status: Accepted and implemented in Phase 3
- Phase: 3

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

Phase 3 introduces `GraphAnalysisService` and wires graph-analysis operations into the planner and retriever.

Implemented behavior:

- `summarizeNodes`
- `summarizeSubgraph`
- `compareNodes`
- `findSharedPathways`
- `findSharedDiseases`
- `findSharedGenes`
- `findCommonNeighbors`
- `findHubNodes`
- `findBridgingNodes`
- `explainConnections`
- `analyzeCluster`

Changed files:

- `backend/src/graph-agent/graph-analysis.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/src/graph-agent/graph-retriever.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`

Observed Phase 3 effect:

- graph-only prompts no longer need to fall back to generic neighborhood retrieval
- selected-node summaries and graph-commonality prompts can execute against explicit graph-analysis tools
- graph-analysis behavior becomes independently testable from entity resolution
