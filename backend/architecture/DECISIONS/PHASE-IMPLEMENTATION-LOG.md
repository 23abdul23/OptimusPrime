# Phase Implementation Log

## Phase 0: Architecture Documentation

Completed:

- `backend/architecture/CURRENT_ARCHITECTURE.md`
- `backend/architecture/TARGET_ARCHITECTURE.md`
- `backend/architecture/EXECUTION_FLOW.md`
- `backend/architecture/AGENTS.md`
- `backend/architecture/TOOLS.md`
- `backend/architecture/GRAPH_CONTEXT_MODEL.md`
- `backend/architecture/RETRIEVAL_OPERATIONS.md`
- `backend/architecture/MEMORY_MODEL.md`
- `backend/architecture/DECISIONS/ADR-001-query-router.md`
- `backend/architecture/DECISIONS/ADR-002-graph-context-agent.md`
- `backend/architecture/DECISIONS/ADR-003-planner.md`
- `backend/architecture/DECISIONS/ADR-004-graph-analysis-layer.md`

Purpose:

- establish the baseline architecture record before code refactoring
- define the target specialized-agent model
- prevent future responsibility re-coupling

## Phase 1: Query Router

Completed:

- introduced `QueryRouterService`
- added `QueryCategory` and `QueryRoute` types
- integrated query routing before entity resolution
- added an initial graph-query planner branch for graph-selected-node summaries/details

Changed files:

- `backend/src/graph-agent/query-router.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/architecture/DECISIONS/ADR-001-query-router.md`

## Phase 2: Graph Context Agent

Completed:

- introduced `GraphContextAgentService`
- added graph-context types:
  - `GraphReferenceResolution`
  - `GraphScope`
  - `GraphContextResult`
- compute structured graph context from:
  - selected nodes
  - selected edges
  - visible graph
  - session graph state
  - query route
- promote `activeAnchors` into orchestration and planner inputs

Changed files:

- `backend/src/graph-agent/graph-context-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/architecture/DECISIONS/ADR-002-graph-context-agent.md`
- `backend/architecture/DECISIONS/ADR-003-planner.md`

## Phase 3: Graph Analysis Layer

Completed:

- introduced `GraphAnalysisService`
- added graph-analysis operations for:
  - selected-node summaries
  - visible-subgraph summaries
  - node comparison
  - shared-pathway, shared-disease, shared-gene, and common-neighbor analysis
  - hub-node and bridge-node analysis
  - connection explanation
  - cluster analysis
- routed graph-only planning paths into graph-analysis tools instead of generic neighborhood retrieval
- wired graph-analysis execution through `GraphRetrieverService`

Changed files:

- `backend/src/graph-agent/graph-analysis.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/src/graph-agent/graph-retriever.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/architecture/DECISIONS/ADR-004-graph-analysis-layer.md`

## Phase 4: Intent Agent

Completed:

- introduced `IntentAgentService`
- removed intent classification from `EntityExtractionService`
- rewired orchestration and planner inputs to consume `QueryIntentClassification`
- narrowed the extraction schema so extraction returns explicit mentions and concepts only

Changed files:

- `backend/src/graph-agent/intent-agent.service.ts`
- `backend/src/graph-agent/entity-extraction.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/architecture/DECISIONS/ADR-003-planner.md`
- `backend/architecture/DECISIONS/ADR-005-intent-agent.md`

## Phase 5: Entity Resolution Agent

Completed:

- introduced `EntityResolutionAgentService`
- replaced the blended resolution path in graph-agent orchestration
- implemented staged resolution order:
  - exact
  - alias
  - synonym
  - identifier
  - semantic
- persisted `resolutionStage` on resolved entities

Changed files:

- `backend/src/graph-agent/entity-resolution-agent.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/architecture/DECISIONS/ADR-006-entity-resolution-agent.md`

## Phase 6: Retrieval Planning Agent

Completed:

- introduced `RetrievalPlanningAgentService`
- changed planner output from tool-first steps to operation-first plan steps
- added explicit `operation` and `executor` fields to the retrieval plan contract
- kept the legacy `tool` field only for compatibility with current response/debug payloads

Changed files:

- `backend/src/graph-agent/retrieval-planning-agent.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/architecture/DECISIONS/ADR-007-retrieval-planning-agent.md`

## Phase 7: Retrieval Operations Layer

Completed:

- introduced `RetrievalOperationsService`
- moved entity-centric retrieval logic out of `GraphRetrieverService`
- kept `GraphRetrieverService` as an execution coordinator over:
  - graph analysis
  - retrieval operations
  - cypher agent
- defined reusable retrieval operations for node details, related-entity lookups, shortest paths, evidence retrieval, neighborhoods, and graph expansion

Changed files:

- `backend/src/graph-agent/retrieval-operations.service.ts`
- `backend/src/graph-agent/graph-retriever.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/architecture/DECISIONS/ADR-008-retrieval-operations-layer.md`

## Phase 8: Cypher Agent

Completed:

- introduced `CypherAgentService`
- centralized read-only Cypher validation
- added heuristic Cypher cost estimation
- moved explicit guarded Cypher execution out of `GraphRetrieverService`
- routed retrieval-operation template execution through the Cypher agent

Changed files:

- `backend/src/graph-agent/cypher-agent.service.ts`
- `backend/src/graph-agent/retrieval-operations.service.ts`
- `backend/src/graph-agent/graph-retriever.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/architecture/DECISIONS/ADR-009-cypher-agent.md`

## Phase 9: Evidence Agent

Completed:

- introduced `EvidenceAgentService`
- replaced evidence ranking with an explicit evidence assessment boundary
- added bundle-level confidence, provenance highlights, and replan signaling
- extended the graph-evidence payload with structured assessment metadata

Changed files:

- `backend/src/graph-agent/evidence-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `frontend/lib/graph-agent-types.ts`
- `backend/architecture/DECISIONS/ADR-010-evidence-agent.md`

## Phase 10: Replanning Loop

Completed:

- introduced `ReplanningAgentService`
- added a bounded retrieval replan loop to `GraphAgentService`
- enabled the backend to evaluate “enough evidence?” before final answer generation
- added follow-up retrieval escalation for weak relationship and path-based evidence

Changed files:

- `backend/src/graph-agent/replanning-agent.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/architecture/DECISIONS/ADR-011-replanning-loop.md`

## Phase 11: Reasoning Agent

Completed:

- introduced `ReasoningAgentService`
- moved final grounded answer generation onto an explicit reasoning boundary
- passed evidence assessment, provenance highlights, graph context, and graph actions into the final reasoning step
- replaced the old synthesis-only orchestration path with reasoning-agent usage

Changed files:

- `backend/src/graph-agent/reasoning-agent.service.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/architecture/DECISIONS/ADR-012-reasoning-agent.md`

## Post-Phase 11 Hardening And Verification

Completed:

- added a local integration smoke harness at `backend/scripts/graph_agent_phase11_smoke.ts`
- added bounded execution timeouts for:
  - guarded Cypher execution
  - retrieval-operation Cypher templates
  - shortest-path queries
  - graph-analysis Neo4j queries
- made `GraphRetrieverService` fail open at the step level so a slow or failed retrieval step becomes a warning instead of crashing the whole turn
- tightened query routing and extraction for graph-referential phrases such as:
  - `these genes`
  - `these proteins`
  - `these pathways`
  - `these drugs`
- tightened mention extraction so imperative graph verbs like `Summarize` are not treated as biomedical mentions
- expanded deterministic resolution variants for entity-class suffixes and amyloid-beta spelling variants
- extended mixed graph+entity planning so graph-connection queries can route into graph-analysis instead of falling back incorrectly
- simplified visible-subgraph graph-analysis loading to avoid unnecessary edge-key scans during subgraph explanation
- upgraded `QueryRouterService` from category-only routing to execution-strategy routing with:
  - `intent`
  - `requiresEntityExtraction`
  - `requiresEntityResolution`
  - `requiresGraphContext`
  - `preferredExecutor`
- changed orchestration so graph-subject queries can bypass extraction and resolution entirely when the router marks them unnecessary
- refined graph-summary execution so selected-subgraph summaries use the full selected node/edge context instead of truncating to 12 nodes before analysis
- upgraded `GraphAnalysisService` graph-summary output to compute graph topology, relationship distributions, central nodes, and ontology-typing diagnostics before reasoning
- changed graph-summary fallback reasoning so summary answers are structured as:
  - Graph Overview
  - Key Entities
  - Graph Structure
  - Major Relationship Types
  - Central Nodes
  - Biological Interpretation

Changed files:

- `backend/scripts/graph_agent_phase11_smoke.ts`
- `backend/src/graph-agent/cypher-agent.service.ts`
- `backend/src/graph-agent/graph-analysis.service.ts`
- `backend/src/graph-agent/graph-retriever.service.ts`
- `backend/src/graph-agent/entity-extraction.service.ts`
- `backend/src/graph-agent/entity-resolution-agent.service.ts`
- `backend/src/graph-agent/query-router.service.ts`
- `backend/src/graph-agent/retrieval-planning-agent.service.ts`

## Post-Phase 11 Visible-Graph Analysis Hardening

Completed:

- changed the KG chat payload builder to send full visible-graph context rather than a small sampled subset for graph-wide analysis
- changed graph-wide intent classification so visible-network analytical questions such as:
  - `Summarize the network`
  - `What biological relationships dominate this network?`
  - `What molecular functions are present in the graph?`
  route into graph-analysis instead of falling through to neighborhood retrieval
- changed retrieval planning so graph-summary questions over the visible graph can emit direct graph-analysis steps without requiring explicit selected anchors
- expanded visible-graph graph-analysis to compute and expose:
  - node-type distribution
  - per-type sample entities
  - relationship distribution
  - dominant relationship coverage
  - hub and central nodes
  - component / cluster summaries
  - schema-aware ontology diagnostics
- removed small-node / small-edge caps from visible-subgraph analysis so the backend can analyze the currently rendered graph at practical KG sizes

Changed files:

- `frontend/components/chat/KGChat.tsx`
- `backend/src/graph-agent/intent-agent.service.ts`
- `backend/src/graph-agent/retrieval-planning-agent.service.ts`
- `backend/src/graph-agent/graph-analysis.service.ts`
- `backend/architecture/TOOLS.md`
- `backend/architecture/GRAPH_CONTEXT_MODEL.md`
- `backend/architecture/RETRIEVAL_OPERATIONS.md`
- `backend/architecture/AGENTS.md`
- `backend/architecture/EXECUTION_FLOW.md`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-context-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/optimuskg/optimuskg.service.ts`
- `backend/architecture/DECISIONS/ADR-001-query-router.md`
- `frontend/components/chat/KGChat.tsx`

## Verification

- executed the local smoke harness with local Neo4j and Redis and `OPENAI_API_KEY` cleared so reasoning stayed on the fallback grounded path
- `phaseCrossCheck` passed for all implemented architecture components:
  - query router
  - graph context agent
  - intent agent
  - entity mention agent
  - entity resolution agent
  - retrieval planning agent
  - retrieval operations layer
  - cypher agent
  - graph analysis layer
  - evidence agent
  - replanning loop
  - reasoning agent
- Plan.md DoD flow verification succeeded for:
  - `Summarize these nodes`
  - `What do these genes have in common?`
  - `How do these selected genes relate to Parkinson disease?`
  - `For which diseases is Metformin indicated?`
  - `How is APOE related to amyloid beta?` via explicit unresolved-mention blocking
  - `Find pathways shared by the selected nodes.`
  - `Explain this subgraph.`
- remaining observed validation gaps from the local DoD flow:
  - the smoke harness could not prepare a two-protein selected context from the current OptimusKG resolution/search path, so:
    - `Compare the selected proteins`
    - `Which approved drugs target these proteins?`
    were not validated against real protein selections
  - `amyloid beta` still does not resolve confidently from current OptimusKG metadata in the local verification flow
- frontend typecheck was not required for these backend-focused phases
- backend verification for Phases 3-11 remains relative to the pre-existing unrelated missing `clickhouse` / dataloader modules:
  - `src/dataloader/dataloader.service.ts`
  - `src/dataloader/index.ts`

## Post-Phase 11 UX And Graph-Context Hardening

Completed:

- promoted graph selection to a first-class frontend state with explicit:
  - selected node IDs
  - selected edge IDs
  - inspected node ID
  - inspected edge ID
- changed the KG chat payload builder to send:
  - `selectedNodeContext`
  - `selectedEdgeContext`
  - `networkContext.selectedNodeIds`
  - `networkContext.selectedEdgeIds`
  - `networkContext.visibleNodeContext`
- changed graph selection behavior so:
  - single-click node selection
  - single-click edge selection
  - ctrl/meta multi-select for nodes and edges
  - lasso / rectangle node selection with derived connecting edges
  all flow into the agent request context
- changed edge selection handling so selecting an edge automatically adds its source and target nodes to primary graph context
- changed backend graph-context handling so selected graph context is prioritized ahead of visible graph and session graph for planning and reasoning
- changed visible-graph summaries so `Summarize the graph` can analyze the current visible graph even when no nodes are selected
- added visible-graph-first local entity disambiguation before global OptimusKG resolution, with explicit ambiguity prompting when multiple graph-visible matches exist
- changed KG answer rendering to support graph-aware entity hover and click interactions:
  - hover preview highlight
  - click focus
  - click-driven graph selection / inspection sync
- changed answer rendering so reasoning, evidence, and graph actions are collapsed behind a disclosure by default
- added suggested follow-up questions that prefill the chat input without auto-sending
- changed force-layout initialization and recentering so random graph loads reinitialize layout state and recenter automatically after layout progress

Changed files:

- `frontend/lib/hooks/use-kg-store.ts`
- `frontend/lib/graph/selection-context.ts`
- `frontend/lib/graph-agent-types.ts`
- `frontend/lib/optimuskg.ts`
- `frontend/components/chat/KGChat.tsx`
- `frontend/components/knowledge-graph/KGSigmaContainer.tsx`
- `frontend/components/knowledge-graph/KGGraphEvents.tsx`
- `frontend/components/knowledge-graph/KGForceLayout.tsx`
- `frontend/components/legends/NodeTypeLegend.tsx`
- `frontend/components/kg-left-panel/OptimusGraphControls.tsx`
- `backend/src/graph-agent/graph-agent.dto.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/graph-context-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/query-router.service.ts`
- `backend/src/graph-agent/retrieval-planning-agent.service.ts`
