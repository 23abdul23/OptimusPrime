# ADR-008: Retrieval Operations Layer

- Status: Accepted and implemented in Phase 7
- Phase: 7

## Context

The old `GraphRetrieverService` mixed together:

- plan execution
- retrieval-operation choice
- Cypher queries
- result shaping
- graph action generation

That made the execution layer too broad and obscured which queries were reusable graph operations.

## Decision

Introduce `RetrievalOperationsService` as the entity-centric retrieval layer.

It owns reusable graph operations such as:

- `load-node-details`
- `get-related-genes`
- `get-related-pathways`
- `get-related-drugs`
- `get-drug-indications`
- `retrieve-relationship-evidence`
- `find-shortest-path`
- `retrieve-neighborhood`
- `expand-network`

`GraphRetrieverService` remains as a coordinator that dispatches to:

- graph analysis
- retrieval operations
- cypher agent

## Consequences

- execution logic is more modular
- planner outputs can stay semantic while operations own Cypher/OptimusKG access
- future retrieval operations can be added without rewriting the planner

## Implementation Notes

Phase 7 introduces `RetrievalOperationsService` and reduces `GraphRetrieverService` to orchestration.

Changed files:

- `backend/src/graph-agent/retrieval-operations.service.ts`
- `backend/src/graph-agent/graph-retriever.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
