# Current Architecture

## Scope
The OptimusKG graph agent is implemented as a single NestJS module with specialized services. It is not a free-form multi-agent runtime. It is a typed orchestrator that routes each query through graph-context resolution, intent classification, retrieval planning, graph execution, evidence assessment, optional replanning, and grounded answer synthesis.

## Runtime Shape
- Frontend: Next.js knowledge-graph UI, Sigma graph canvas, chat window, selection state, visible-graph context, follow-up suggestions, answer-to-graph linking.
- Backend: `GraphAgentModule` inside the main NestJS API.
- Data stores: Neo4j for graph truth, Redis for session graph memory and caching.
- LLM usage: limited to extraction/intention/reasoning boundaries; graph existence and graph facts come from OptimusKG and Neo4j.

## Implemented Backend Services
- `QueryRouterService`
  Decides query category, graph-vs-entity strategy, and whether extraction and resolution are required.
- `GraphContextAgentService`
  Resolves the active graph subject from selected graph, visible graph, or session graph.
- `EntityExtractionService`
  Extracts explicit mentions, concepts, selection references, and operator signals.
- `IntentAgentService`
  Classifies the request into operational intent families.
- `EntityResolutionAgentService`
  Resolves explicit mentions against OptimusKG metadata and aliases.
- `RetrievalPlanningAgentService`
  Emits typed plan steps with executor, operation, tool, and parameters.
- `GraphAnalysisService`
  Primary executor for graph-wide analysis, visible-network analysis, selected-subgraph analysis, topology analysis, ontology traversal, enrichment, community detection, and graph explanation.
- `RetrievalOperationsService`
  Primary executor for entity-anchored typed retrieval operations and guarded traversal helpers.
- `CypherAgentService`
  Validates and executes explicit read-only Cypher when the request is intentionally Cypher-oriented.
- `GraphRetrieverService`
  Runs the typed plan and merges evidence, graph deltas, graph actions, and warnings.
- `EvidenceAgentService`
  Scores the retrieved evidence, computes confidence, and decides whether replanning is needed.
- `ReplanningAgentService`
  Appends bounded follow-up plan steps when the first pass is insufficient.
- `ReasoningAgentService`
  Produces the final grounded response, follow-up suggestions, and UI-facing answer text.
- `ConversationGraphStateService`
  Persists per-session graph context in Redis.

## Execution Model
1. Frontend sends:
   - latest user message
   - `selectedNodeContext`
   - `selectedEdgeContext`
   - `networkContext`
2. Router classifies the request and decides whether extraction and resolution should run.
3. Graph context agent determines the active graph subject with this priority:
   - selected graph
   - visible graph
   - session graph
4. Extraction and resolution run only when the router requires them.
5. Planner emits typed plan steps.
6. Retriever executes those steps through one of:
   - `graph-analysis`
   - `retrieval-operations`
   - `cypher-agent`
7. Evidence agent bundles results and may request bounded replanning.
8. Reasoning agent writes the answer and graph actions.
9. Session graph state is updated in Redis.

## Current Query Families
- Graph summary and graph explanation
- Schema analysis and node-type analysis
- Relationship analysis and cross-type connection analysis
- Network statistics and topology inspection
- Community detection and module analysis
- Ontology traversal
- Enrichment analysis
- Exposure analysis
- Drug discovery and drug-centric typed retrieval
- Entity neighborhood and shortest-path analysis
- Explicit Cypher execution

## Current Design Decisions
- The graph is the source of truth.
- Graph-wide analysis no longer requires explicit node selection when a visible graph exists.
- Query routing can skip extraction and resolution entirely for graph-subject queries.
- Selected graph context is treated as primary planning context.
- Generic neighborhood loading is now the fallback, not the default.

## Current Limitations
- Community detection is currently topology-based and approximates communities via connected components; it does not yet use Neo4j GDS algorithms.
- Enrichment is support-ranked graph enrichment, not full statistical enrichment with p-values.
- Cypher generation is intentionally constrained; the system mainly supports guarded execution of explicit Cypher requests.
- Backend repository typecheck still contains unrelated pre-existing dataloader/clickhouse breakage outside the graph-agent module.
