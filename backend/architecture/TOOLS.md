# Tools

## Summary

This document describes the current backend tool surface used by the graph agent. The system is operation-first, but each planned operation still maps to a concrete internal tool or service method.

## Current Internal Tool Surface

### Graph Analysis Tools

Executed through `GraphAnalysisService`:

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

### Retrieval Tools

Executed through `RetrievalOperationsService`:

- `getNodeDetails`
- `getRelatedEntities`
- `retrieveEvidence`
- `retrieveClinicalGuidelines`
- `retrieveSubgraph`
- `expandSubgraph`
- `shortestPath`

### Cypher Tool

Executed through `CypherAgentService`:

- `executeGuardedCypher`

### State / Resolution Tools

Used indirectly by orchestration:

- `resolveEntity`
- `getConversationGraphState`
- `pruneConversationGraphState`

## Current Characteristics

- all tools are bounded
- graph actions are structured outputs, not free-form UI instructions
- evidence is emitted together with tool execution
- tools are executed server-side; the frontend is not the reasoning engine

## Graph-Wide Analysis Behavior

Graph-wide analysis should use:

```text
Selected Nodes / Edges
        ↓
Visible Graph
        ↓
Session Graph
```

That means graph-analysis tools can operate without explicit entity resolution when the visible graph is already the user’s subject.

## Schema Awareness

Graph-analysis tools should not assume only a narrow subset of biomedical node types. They should work across whatever node types are currently present in the graph, including:

- Gene
- Protein
- Disease
- Drug
- Pathway
- Phenotype
- Anatomy
- MolecularFunction
- CellularComponent
- additional ontology-backed types exposed by OptimusKG

## Tool Selection Guidance

- use graph-analysis for graph-subject queries
- use retrieval operations for entity-subject queries
- use Cypher only as a guarded fallback
