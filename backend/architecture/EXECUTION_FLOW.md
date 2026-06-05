# Execution Flow

## End-To-End Request Flow
1. The frontend sends the latest user message plus:
   - `selectedNodeContext`
   - `selectedEdgeContext`
   - `networkContext`
2. `QueryRouterService` decides:
   - query category
   - operational intent
   - whether entity extraction should run
   - whether entity resolution should run
   - whether graph context is required
3. `GraphContextAgentService` resolves the active graph subject.
4. `EntityExtractionService` runs only when the router requires it.
5. `IntentAgentService` classifies the request family.
6. `EntityResolutionAgentService` runs only when the router requires it.
7. `RetrievalPlanningAgentService` creates typed plan steps.
8. `GraphRetrieverService` dispatches each step to:
   - `GraphAnalysisService`
   - `RetrievalOperationsService`
   - `CypherAgentService`
9. `EvidenceAgentService` builds the evidence bundle and decides whether bounded replanning is needed.
10. `ReplanningAgentService` optionally appends follow-up steps.
11. `ReasoningAgentService` writes the final grounded answer.
12. `ConversationGraphStateService` persists the new session state.

## Graph Context Priority
The planner and graph-analysis executor use this order:
1. Selected graph
2. Visible graph
3. Session graph

## Stage Gating
### Graph-subject query
Example: `Summarize these selected nodes`
- Router marks the request as `GRAPH_QUERY`
- Extraction is skipped
- Resolution is skipped
- Planner uses selected graph ids directly
- Graph analysis executes immediately

### Mixed query
Example: `How do these selected genes relate to Parkinson disease?`
- Router marks the request as `MIXED_QUERY`
- Graph context is primary
- Extraction resolves explicit non-graph mentions only
- Planner mixes selected graph anchors with resolved disease anchors

### Entity query
Example: `Which diseases are associated with APOE?`
- Router marks the request as `ENTITY_QUERY`
- Extraction and resolution both run
- Planner emits entity-anchored retrieval steps

## Execution Paths
### Graph analysis path
Used for:
- graph summaries
- schema analysis
- relationship analysis
- node-type analysis
- network statistics
- community detection
- ontology traversal
- enrichment
- graph explanation

### Retrieval operations path
Used for:
- node details
- shortest path
- typed entity traversals
- drug, disease, gene, pathway, anatomy, and exposure lookups
- candidate ranking and ambiguity support

### Cypher path
Used only for explicit Cypher-style requests after validation.

## Replanning
Replanning is bounded.
- Maximum attempts: 2
- Trigger: evidence bundle marks the first pass as insufficient
- Effect: append targeted steps, do not restart the whole pipeline

## Frontend Response Contract
The stream can emit:
- assistant text
- `graphEvidence`
- `graphActions`
- `graphState`

Typical graph actions:
- `load-subgraph`
- `focus-nodes`
- `highlight-path`
