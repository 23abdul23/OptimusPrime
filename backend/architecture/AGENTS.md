# Agents

## Current Runtime Roles

The current backend does not yet expose these as separate agents, but the responsibilities already cluster around these roles:

- Orchestrator: `GraphAgentService`
- Extraction: `EntityExtractionService`
- Resolution: `EntityResolutionService`
- Planner: `RetrievalPlannerService`
- Retriever: `GraphRetrieverService`
- Evidence ranker: `EvidenceSelectionService`
- Reasoner/synthesizer: `ResponseSynthesisService`

## Target Specialized Agents

### Query Router
- responsibility: classify the request before entity-centric processing
- inputs: query text, lightweight graph-context summary
- outputs: `ENTITY_QUERY | GRAPH_QUERY | MIXED_QUERY | CYPHER_QUERY | UNKNOWN`

### Graph Context Agent
- responsibility: interpret graph selections and graph references
- inputs: selected nodes, selected edges, visible graph, session graph state, query
- outputs: active anchors, graph scope, reference resolution

### Intent Agent
- responsibility: determine task intent only
- inputs: query text
- outputs: intent, operation, requested target types

### Entity Mention Agent
- responsibility: extract explicit mentions only
- inputs: query text
- outputs: mention spans, concept spans

### Entity Resolution Agent
- responsibility: resolve explicit mentions against OptimusKG
- inputs: mention spans, type hints
- outputs: resolved nodes and ambiguity metadata

### Retrieval Planning Agent
- responsibility: map intent + context + entities to graph operations
- inputs: intent, graph context, entities, session state
- outputs: operation plan

### Cypher Agent
- responsibility: controlled read-only Cypher fallback
- inputs: structured retrieval goal
- outputs: validated Cypher plan step

### Graph Analysis Layer
- responsibility: graph summaries and graph-analysis workflows
- inputs: graph context or retrieved graph
- outputs: graph-analysis evidence

### Evidence Agent
- responsibility: evidence ranking and confidence scoring
- inputs: retrieved relations, paths, metadata, provenance
- outputs: ranked evidence bundle

### Reasoning Agent
- responsibility: grounded answer generation
- inputs: user query, evidence bundle, graph context
- outputs: answer text, graph actions, confidence framing
