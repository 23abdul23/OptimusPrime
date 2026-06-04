# Current Architecture

## Summary

Optimus Explorer currently uses a server-side graph-agent architecture built on NestJS, Neo4j, Redis, and a Next.js frontend. The frontend is responsible for graph rendering, user interaction, and packaging the current graph context. The backend is responsible for routing, planning, retrieval, graph analysis, evidence construction, memory, and grounded answer generation.

## Runtime Stack

### Frontend

- Next.js application
- Sigma.js graph rendering
- graph selection state in the KG store
- KG chat UI that sends:
  - latest user message
  - selected node context
  - selected edge context
  - visible graph context
  - session id

### Backend

- NestJS `GraphAgentModule`
- Neo4j as graph source of truth
- Redis for throttling and conversation graph state
- OpenAI-compatible reasoning path with deterministic fallback

## Main Request Path

```text
Frontend KG Chat
        ↓
POST /graph-agent/chat
        ↓
GraphAgentController
        ↓
GraphAgentService
        ↓
Query Router
        ↓
Graph Context Agent
        ↓
Intent Agent
        ↓
Optional Extraction / Resolution
        ↓
Retrieval Planning
        ↓
Graph Analysis / Retrieval Operations / Cypher
        ↓
Evidence Agent
        ↓
Optional Replanning
        ↓
Reasoning Agent
        ↓
Streamed answer + graph evidence + graph actions + graph state
```

## Architectural Priorities

### Source of Truth

- Neo4j / OptimusKG is the source of truth for entity existence and graph structure
- the visible graph in the UI is the source of truth for the user’s current analysis context
- the LLM is not the source of truth for biomedical facts

### Graph Context Priority

When deciding what graph the user means, the system should prefer:

```text
Selected Nodes / Edges
        ↓
Visible Graph
        ↓
Session Graph
```

### Execution Priority

- graph-subject questions should use graph-analysis directly
- entity-subject questions should use retrieval operations
- Cypher is fallback only

## Implemented Backend Components

- `GraphAgentController`
- `GraphAgentService`
- `QueryRouterService`
- `GraphContextAgentService`
- `IntentAgentService`
- `EntityExtractionService`
- `EntityResolutionAgentService`
- `RetrievalPlanningAgentService`
- `RetrievalOperationsService`
- `CypherAgentService`
- `GraphAnalysisService`
- `GraphRetrieverService`
- `EvidenceAgentService`
- `ReplanningAgentService`
- `ReasoningAgentService`
- `ConversationGraphStateService`

## Implemented Graph Analysis Capabilities

The current graph-analysis layer supports:

- summarizing selected nodes and selected subgraphs
- summarizing visible graphs
- node comparison
- shared pathways
- shared diseases
- shared genes
- common neighbors
- hub detection
- bridge detection
- connection explanation
- cluster analysis
- topology analysis
- node-type distribution
- relationship distribution
- ontology diagnostics

## Visible-Graph Analysis

The current system is designed to answer graph-wide questions without requiring explicit anchor-node selection. The frontend sends visible graph ids and visible node metadata so the backend can analyze the rendered graph directly.

Examples that should use the visible graph as the active subject:

- `Summarize the network`
- `What biological relationships dominate this network?`
- `What molecular functions are present in the graph?`
- `Which nodes are the main hubs in this graph?`

## Memory Model

Conversation graph state stores:

- active entities
- resolved node ids
- retrieved node ids
- frontier node ids
- selected node ids
- selected edge ids
- visible node ids
- visible edge ids
- evidence cache
- prior queries
- last retrieval plan

## Current Limitations

- backend typecheck still has unrelated missing dataloader / clickhouse files outside the graph-agent path
- some graph-analysis paths still depend on what node and edge metadata are available in serialized OptimusKG records
- the backend does not yet execute a full autonomous graph-analysis workflow planner for every graph-wide analytic variant; it still uses heuristics within the retrieval planning stage
