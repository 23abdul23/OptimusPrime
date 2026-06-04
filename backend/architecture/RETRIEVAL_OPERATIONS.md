# Retrieval Operations

## Current State

Current retrieval planning emits tool steps directly, and the retriever executes them step by step.

Examples already present:

- node metadata lookup
- direct relation lookup
- shortest path lookup
- typed path traversal
- neighborhood retrieval
- graph expansion

## Current Limitation

Planner logic and retrieval-operation choice are still coupled. This makes graph-query routing and graph-context-aware planning harder to evolve.

## Target Direction

The planner should emit reusable graph operations such as:

- `getRelatedDiseases`
- `getRelatedGenes`
- `getRelatedProteins`
- `getRelatedPathways`
- `getRelatedDrugs`
- `getDrugIndications`
- `findShortestPath`
- `findCommonNeighbors`
- `retrieveEvidence`

Those operations then map to Neo4j/OptimusKG queries in a dedicated layer.

## Phase 0-2

No dedicated retrieval-operations layer is added yet. Existing retrieval steps remain in place while routing and graph-context handling are refactored first.
