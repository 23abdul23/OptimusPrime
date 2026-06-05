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
   - whether the request should enter empty-canvas discovery mode
3. `GraphContextAgentService` resolves the active graph subject.
4. `EntityExtractionService` runs only when the router requires it.
5. `IntentAgentService` classifies the request family.
6. `EntityResolutionAgentService` runs only when the router requires it.
7. For discovery-mode requests with no active graph, the orchestrator can ask for clarification before planning if:
   - the request is too broad
   - the seed mention is ambiguous in OptimusKG
8. `RetrievalPlanningAgentService` creates typed plan steps.
9. `GraphRetrieverService` dispatches each step to:
   - `GraphAnalysisService`
   - `RetrievalOperationsService`
   - `CypherAgentService`
10. `EvidenceAgentService` builds the evidence bundle and decides whether bounded replanning is needed.
11. `ReplanningAgentService` optionally appends follow-up steps.
12. `ReasoningAgentService` writes the final grounded answer.
13. `ConversationGraphStateService` persists the new session state.

## Graph Context Priority
The planner and graph-analysis executor use this order:
1. Selected graph
2. Visible graph
3. Session graph
4. Discovery mode when no graph context exists

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

### Discovery query
Example: `Build a graph for genes associated with Alzheimer disease`
- Router marks the request as `GRAPH_DISCOVERY_QUERY`
- The active graph scope is `discovery`
- Extraction and resolution run because the graph does not yet exist
- The orchestrator may stop for broad-query or ambiguity clarification
- Planner emits a compact network-build step such as:
  - `build-disease-network`
  - `build-gene-network`
  - `build-relationship-network`
  - `build-multi-entity-network`

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
- empty-canvas graph discovery and compact initial network generation

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
