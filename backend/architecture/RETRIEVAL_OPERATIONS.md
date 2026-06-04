# Retrieval Operations

## Summary

The graph agent uses operation-first retrieval planning. The planner emits typed operations, and `GraphRetrieverService` dispatches them to either graph analysis, retrieval operations, or guarded Cypher.

## Execution Layers

```text
RetrievalPlanningAgentService
        ↓
GraphRetrieverService
    ├─ GraphAnalysisService
    ├─ RetrievalOperationsService
    └─ CypherAgentService
```

## Retrieval Executors

### graph-analysis

Used when the subject is the selected graph, visible graph, or another graph-native structure.

Supported operations:

- `summarize-selected-nodes`
- `summarize-visible-subgraph`
- `compare-nodes`
- `find-shared-pathways`
- `find-shared-diseases`
- `find-shared-genes`
- `find-common-neighbors`
- `find-hub-nodes`
- `find-bridging-nodes`
- `explain-connections`
- `analyze-cluster`

### retrieval-operations

Used for entity-centric retrieval and bounded graph traversal.

Supported operations:

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

### cypher-agent

Used only for guarded explicit Cypher execution.

Supported operation:

- `execute-custom-cypher`

## Planning Rules

### Graph-Subject Queries

If the user’s subject is the graph itself, the planner should prefer graph-analysis directly.

Examples:

- `Summarize the network`
- `What biological relationships dominate this network?`
- `Which nodes are the main hubs in this graph?`
- `What molecular functions are present in the graph?`

These should not require entity anchors if the visible graph is available.

### Entity-Subject Queries

If the subject is a resolved biomedical entity, the planner should use retrieval operations.

Examples:

- `For which diseases is Metformin indicated?`
- `Which genes are associated with Alzheimer disease?`
- `How is APOE related to amyloid beta?`

### Mixed Queries

If the query combines graph context with explicit entity mentions, the planner can mix graph analysis and entity-centric retrieval.

Example:

- `How do these selected genes relate to Parkinson disease?`

## Current Constraints

- planning is heuristic but typed
- visible-graph analysis depends on the frontend sending full visible graph context
- graph-analysis relies on the node and edge metadata available in serialized graph payloads
