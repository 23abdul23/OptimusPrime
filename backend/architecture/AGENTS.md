# Agents

## Overview

The backend graph-agent runtime is implemented as a single NestJS module with explicit service boundaries. It is not a free-form multi-agent swarm. `GraphAgentService` is the orchestrator and delegates to specialized agents/services with typed inputs and outputs.

## Runtime Roles

### GraphAgentService

- role: top-level orchestrator for a single `/graph-agent/chat` request
- responsibilities:
  - load prior conversation graph state
  - build graph context from the request
  - run query routing
  - conditionally run extraction and resolution
  - invoke planning, retrieval, evidence assessment, replanning, and reasoning
  - stream `graphEvidence`, `graphActions`, `graphState`, and answer text

### QueryRouterService

- role: execution gatekeeper
- inputs:
  - query text
  - selected node context
  - selected edge context
- outputs:
  - `category`
  - `intent`
  - `requiresEntityExtraction`
  - `requiresEntityResolution`
  - `requiresGraphContext`
  - `preferredExecutor`
- notes:
  - graph-subject queries can bypass entity extraction and entity resolution
  - visible-graph questions such as `Summarize the network` should route into graph analysis

### GraphContextAgentService

- role: graph-context interpreter
- inputs:
  - selected nodes
  - selected edges
  - visible graph context from the frontend
  - session graph state
  - routed query
- outputs:
  - active anchors
  - selected node and edge types
  - visible node and edge ids
  - graph scope
  - graph reference flags
- priority:
  1. selected nodes and edges
  2. visible graph
  3. session graph

### IntentAgentService

- role: task classifier
- inputs:
  - query text
  - routed query
  - graph context
- outputs:
  - `primary`
  - `operation`
  - `requestedEntityTypes`
  - `allowContextFallback`
  - optional radius
- notes:
  - classifies graph-wide analysis, graph expansion, relationship queries, pathway/drug/guideline requests, and guarded Cypher requests

### EntityExtractionService

- role: explicit mention and concept extractor
- inputs:
  - query text
- outputs:
  - explicit mention spans
  - explicit concept spans
  - graph-reference phrases
  - operator signals
- constraints:
  - extracts only explicit user text
  - does not invent or normalize biomedical entities

### EntityResolutionAgentService

- role: OptimusKG-backed mention resolver
- inputs:
  - extracted mentions
  - extracted concepts
- outputs:
  - resolved entities with confidence and resolution stage
- resolution stages:
  - exact
  - alias
  - synonym
  - identifier
  - semantic
- notes:
  - graph-visible local resolution is attempted earlier in `GraphAgentService` before global KG resolution

### RetrievalPlanningAgentService

- role: operation planner
- inputs:
  - routed query
  - intent
  - graph context
  - extracted query
  - resolved entities
  - conversation graph state
- outputs:
  - ordered `RetrievalPlanStep[]`
- behavior:
  - emits operation-first steps
  - prefers graph-analysis for graph-subject queries
  - uses visible graph as the active subject when nothing is selected and the query targets the rendered network

### RetrievalOperationsService

- role: entity-centric retrieval layer
- responsibilities:
  - node detail loading
  - related-entity traversals
  - drug indication lookup
  - guideline retrieval
  - relationship evidence
  - shortest path
  - neighborhood loading
  - bounded expansion

### CypherAgentService

- role: read-only Cypher boundary
- responsibilities:
  - validate explicit Cypher
  - estimate heuristic query cost
  - execute guarded read-only Cypher
- notes:
  - fallback only
  - planner does not treat Cypher as the default path

### GraphAnalysisService

- role: graph-native analytics over selected graphs or visible graphs
- responsibilities:
  - selected-node summaries
  - visible-subgraph summaries
  - node comparison
  - shared-pathway, shared-disease, shared-gene, and common-neighbor analysis
  - hub and bridge detection
  - component and cluster analysis
  - connection explanation
  - topology analysis
  - ontology diagnostics
  - schema-aware node-type summaries across all visible node types
- outputs:
  - graph evidence items
  - graph payloads for UI updates
  - highlight node ids

### GraphRetrieverService

- role: execution coordinator
- responsibilities:
  - execute `graph-analysis`, `retrieval-operations`, and `cypher-agent` steps
  - collect evidence and warnings
  - emit graph actions
- notes:
  - does not own planning logic
  - does not own entity-centric retrieval logic

### EvidenceAgentService

- role: evidence bundler and assessor
- responsibilities:
  - rank evidence items
  - build `GraphEvidenceBundle`
  - compute confidence, insufficiency, provenance highlights, and replan signals

### ReplanningAgentService

- role: bounded replan controller
- responsibilities:
  - inspect current evidence
  - request additional retrieval when evidence is weak or incomplete
- constraints:
  - bounded by a small retry limit

### ReasoningAgentService

- role: grounded answer generator
- inputs:
  - query
  - graph context
  - evidence bundle
  - graph actions
- outputs:
  - streamed answer text
  - fallback answer when model access is unavailable
- constraints:
  - use graph evidence as the source of truth
  - avoid inventing unsupported biomedical claims

### ConversationGraphStateService

- role: session memory and caching layer
- backing store:
  - Redis
- responsibilities:
  - persist selected ids
  - persist visible graph ids
  - persist active entities
  - persist frontier and retrieved ids
  - persist evidence cache and prior queries

## Supporting Types

The main runtime contracts live in `backend/src/graph-agent/graph-agent.types.ts`:

- `QueryRoute`
- `GraphContextResult`
- `QueryIntentClassification`
- `ResolvedEntity`
- `RetrievalPlanStep`
- `GraphEvidenceBundle`
- `ConversationGraphState`
- `GraphAction`

## What The System Is

The current implementation is:

- a modular sequential planner/executor
- tool-orchestrated
- graph-context-aware
- stateful across turns
- specialized by service boundary rather than by autonomous agents

It is not:

- a monolithic single-prompt graph chatbot
- a free-form multi-agent debate system
- a frontend-driven reasoning architecture
