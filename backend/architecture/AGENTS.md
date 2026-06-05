# Agents And Services

## Overview
The current implementation uses specialized services under one orchestrator. Each service has a narrow responsibility, explicit inputs, explicit outputs, and a fixed tool surface.

## Orchestrator
### `GraphAgentService`
- Responsibility: end-to-end request execution.
- Inputs:
  - latest user query
  - selected nodes and edges
  - visible network context
  - session id
- Outputs:
  - assistant text
  - evidence bundle
  - graph actions
  - updated conversation state
- Owns:
  - orchestration order
  - unresolved-mention blocking
  - replanning loop
  - stream payload emission

## Routing And Context
### `QueryRouterService`
- Responsibility: classify the request before downstream execution begins.
- Inputs:
  - query text
  - selected graph context
  - visible graph presence
- Outputs:
  - category
  - intent
  - `requiresEntityExtraction`
  - `requiresEntityResolution`
  - `requiresGraphContext`
  - preferred executor
- Owns:
  - graph query vs entity query vs mixed query gating

### `GraphContextAgentService`
- Responsibility: determine what graph the user is talking about.
- Inputs:
  - query text
  - router decision
  - selected nodes and edges
  - visible graph context
  - session state
- Outputs:
  - active anchors
  - selected graph context
  - visible graph context
  - graph scope mode
  - graph-reference flags
- Owns:
  - graph context priority
  - selected-vs-visible-vs-session fallback

## Extraction And Resolution
### `EntityExtractionService`
- Responsibility: extract explicit mentions and concepts only.
- Inputs:
  - user query
- Outputs:
  - mentions
  - concepts
  - selection references
  - operator signals
- Owns:
  - mention extraction schema
  - no-invention extraction boundary

### `IntentAgentService`
- Responsibility: classify operational intent.
- Inputs:
  - query text
  - router output
  - graph context
- Outputs:
  - primary intent family
  - operation family
  - requested entity types
  - context-fallback allowance
- Owns:
  - classification of summary, schema, relationship, ontology, enrichment, community, exposure, drug-discovery, and neighborhood intents

### `EntityResolutionAgentService`
- Responsibility: resolve explicit mentions against OptimusKG.
- Inputs:
  - extracted mentions
  - extracted concepts
- Outputs:
  - resolved entities
  - staged resolution confidence
- Owns:
  - exact
  - alias
  - synonym
  - identifier
  - semantic fallback ranking

## Planning And Execution
### `RetrievalPlanningAgentService`
- Responsibility: convert intent plus context into typed plan steps.
- Inputs:
  - router output
  - graph context
  - intent
  - extracted query
  - resolved entities
  - session state
- Outputs:
  - ordered `RetrievalPlanStep[]`
- Owns:
  - tool selection
  - graph-analysis scope selection
  - typed traversal planning
  - operation-specific branching

### `GraphAnalysisService`
- Responsibility: analyze selected graphs, visible graphs, and ontology/enrichment/topology structure.
- Inputs:
  - scoped node ids
  - scoped edge ids
  - optional type filters
  - optional ontology root id
- Outputs:
  - evidence items
  - graph payload
  - highlight nodes
  - warnings
- Owns:
  - summaries
  - schema inspection
  - relationship analysis
  - node-type analysis
  - topology metrics
  - community detection
  - ontology traversal
  - enrichment
  - graph explanation

### `RetrievalOperationsService`
- Responsibility: perform entity-anchored retrieval and typed relation lookup.
- Inputs:
  - typed plan step
  - resolved entities
- Outputs:
  - evidence items
  - graph payload
  - path highlights
  - warnings
- Owns:
  - node details
  - shortest path
  - related-entity retrieval
  - typed multi-hop traversals
  - drug, disease, gene, pathway, anatomy, and exposure retrieval helpers
  - ambiguity candidate lookup

### `CypherAgentService`
- Responsibility: enforce read-only Cypher safety and execute explicit Cypher requests.
- Inputs:
  - user Cypher
  - validated parameters
- Outputs:
  - rows
  - cost metadata
- Owns:
  - read-only guardrails
  - unsafe-clause rejection

### `GraphRetrieverService`
- Responsibility: run the plan and collect executor outputs.
- Inputs:
  - plan steps
  - resolved entities
- Outputs:
  - unified evidence
  - graph delta
  - graph actions
  - warnings
- Owns:
  - executor dispatch
  - graph-action creation

## Evidence And Response
### `EvidenceAgentService`
- Responsibility: assess evidence quality and bundle the result.
- Inputs:
  - evidence items
  - resolved entities
  - plan
  - warnings
  - graph context ids
- Outputs:
  - evidence bundle
  - confidence assessment
  - replan signal
- Owns:
  - evidence scoring
  - insufficiency detection

### `ReplanningAgentService`
- Responsibility: add bounded recovery steps when evidence is weak.
- Inputs:
  - current evidence bundle
  - current plan
  - graph context
  - intent
- Outputs:
  - appended plan steps
- Owns:
  - bounded replanning only

### `ReasoningAgentService`
- Responsibility: produce the final answer from the evidence bundle.
- Inputs:
  - query
  - evidence bundle
  - resolved entities
  - graph actions
- Outputs:
  - grounded text
  - suggestions
- Owns:
  - graph-grounded synthesis
  - fallback wording when evidence is partial

## Memory
### `ConversationGraphStateService`
- Responsibility: persist the graph conversation state in Redis.
- Inputs:
  - current session state
  - latest evidence bundle
  - selected and visible graph ids
- Outputs:
  - bounded persisted state
- Owns:
  - trimming
  - session restore
  - state persistence
