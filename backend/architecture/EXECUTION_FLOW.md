# Execution Flow

## End-To-End Flow

```text
User Query
+ Selected Graph Context
+ Visible Graph Context
+ Session Id
        ↓
Frontend KG Chat Payload Builder
        ↓
POST /graph-agent/chat
        ↓
GraphAgentController
        ↓
GraphAgentService
        ↓
Load ConversationGraphState
        ↓
QueryRouterService
        ↓
GraphContextAgentService
        ↓
IntentAgentService
        ↓
Optional EntityExtractionService
        ↓
Optional local visible-graph resolution
        ↓
Optional EntityResolutionAgentService
        ↓
RetrievalPlanningAgentService
        ↓
GraphRetrieverService
    ├─ GraphAnalysisService
    ├─ RetrievalOperationsService
    └─ CypherAgentService
        ↓
EvidenceAgentService
        ↓
Optional ReplanningAgentService
        ↓
ReasoningAgentService
        ↓
Save ConversationGraphState
        ↓
Stream answer + evidence + graph actions + graph state
```

## Stage Details

### 1. Frontend Context Packaging

The frontend KG chat request contains:

- latest user message only
- `selectedNodeContext`
- `selectedEdgeContext`
- `networkContext`
  - visible node ids
  - visible edge ids
  - visible node labels and types
  - visible node-type distribution
  - selected ids
  - total visible node and edge counts

### 2. Query Routing

`QueryRouterService` decides:

- what category the query belongs to
- whether extraction is required
- whether resolution is required
- whether graph context is required
- which executor family is preferred

This allows graph-subject queries to bypass unnecessary entity-centric steps.

### 3. Graph Context Build

`GraphContextAgentService` determines the effective graph subject using:

```text
Selected Nodes / Edges
        ↓
Visible Graph
        ↓
Session Graph
```

It returns:

- active anchors
- visible node ids
- visible edge ids
- selected node and edge types
- graph scope
- graph reference flags

### 4. Intent Classification

`IntentAgentService` classifies the task into operations such as:

- graph summary
- graph comparison
- graph commonality
- graph connections
- relationship analysis
- pathway search
- drug search
- graph expansion
- network summary
- guarded Cypher

### 5. Optional Extraction And Resolution

If the route requires it:

- `EntityExtractionService` extracts explicit mentions and concepts
- `GraphAgentService` first attempts local matching against visible graph nodes
- `EntityResolutionAgentService` resolves remaining mentions against OptimusKG

If the route does not require extraction or resolution, the system moves directly to planning.

### 6. Retrieval Planning

`RetrievalPlanningAgentService` emits `RetrievalPlanStep[]`.

Graph-wide analysis should plan directly against the active graph subject, especially when:

- the user selected nodes or edges
- the visible graph is the subject

Examples:

- `summarize-selected-nodes`
- `summarize-visible-subgraph`
- `find-hub-nodes`
- `analyze-cluster`

### 7. Plan Execution

`GraphRetrieverService` dispatches steps to:

- `GraphAnalysisService` for graph-native analysis
- `RetrievalOperationsService` for entity-centric retrieval
- `CypherAgentService` for guarded Cypher

The retriever returns:

- evidence items
- graph actions
- warnings

### 8. Evidence Assessment

`EvidenceAgentService` builds a `GraphEvidenceBundle` containing:

- ranked evidence items
- confidence
- insufficiency flag
- provenance highlights
- replan signal

### 9. Replanning

If evidence is weak and the budget allows it, `ReplanningAgentService` may append more steps and rerun retrieval.

### 10. Reasoning

`ReasoningAgentService` generates the answer from the evidence bundle and graph context. If model access is unavailable, it emits a deterministic fallback answer.

### 11. Memory Update

`ConversationGraphStateService` stores the updated session graph state for follow-up turns.

## Important Runtime Rules

### Graph-Wide Queries

Graph-wide questions should not fail just because no nodes are selected. If the visible graph is populated, it is the active graph subject.

### Ambiguous Mentions

If multiple visible-graph candidates match an explicit mention, the backend should ask for clarification instead of arbitrarily choosing one.

### Reasoning Boundaries

- graph evidence drives answers
- unresolved explicit mentions can block retrieval when necessary
- graph actions are produced as structured outputs, not inferred in the frontend
