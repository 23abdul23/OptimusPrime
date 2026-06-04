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

## Phase 7 Implementation

Phase 7 introduces `RetrievalOperationsService`.

Implemented operations include:

- `load-node-details`
- `get-related-diseases`
- `get-related-genes`
- `get-related-proteins`
- `get-related-pathways`
- `get-related-drugs`
- `get-drug-indications`
- `retrieve-clinical-guidelines`
- `retrieve-relationship-evidence`
- `find-shortest-path`
- `retrieve-neighborhood`
- `expand-network`

Execution notes:

- retrieval planning is now operation-first
- `GraphRetrieverService` coordinates execution but does not own entity-centric retrieval logic
- Neo4j-backed retrieval operations execute through `CypherAgentService` when Cypher templates are required
