# OptimusKG Agent Refactor Roadmap

## Goal

Transform the current vertically-scaled sequential agent into a graph-native, context-aware, planner-driven architecture that:

* Understands graph selections
* Understands graph-centric queries
* Uses rich node and edge metadata
* Supports graph analysis workflows
* Supports entity-centric workflows
* Supports dynamic retrieval planning
* Supports iterative retrieval and re-planning
* Remains maintainable as OptimusKG grows

The objective is not to build a swarm of autonomous agents.

The objective is to build a set of specialized, deterministic sub-agents under a single orchestrator.

---

# Phase 0 — Architecture Documentation

Before implementing anything, create:

```text
backend/
└── architecture/
    ├── CURRENT_ARCHITECTURE.md
    ├── TARGET_ARCHITECTURE.md
    ├── EXECUTION_FLOW.md
    ├── AGENTS.md
    ├── TOOLS.md
    ├── GRAPH_CONTEXT_MODEL.md
    ├── RETRIEVAL_OPERATIONS.md
    ├── MEMORY_MODEL.md
    └── DECISIONS/
        ├── ADR-001-query-router.md
        ├── ADR-002-graph-context-agent.md
        ├── ADR-003-planner.md
        └── ADR-004-graph-analysis-layer.md
```

Purpose:

* Architecture survives future refactors.
* New contributors understand the system.
* Agent responsibilities remain clear.
* Prevents future re-coupling.

---

# Phase 1 — Introduce Query Router

Current issue:

Everything is routed through entity extraction.

Example:

```text
Summarize these nodes
```

should not trigger entity resolution.

Create:

```text
QueryRouter
```

Output:

```ts
type QueryCategory =
  | "ENTITY_QUERY"
  | "GRAPH_QUERY"
  | "MIXED_QUERY"
  | "CYPHER_QUERY"
  | "UNKNOWN";
```

Examples:

```text
What is APOE?
```

↓

```text
ENTITY_QUERY
```

---

```text
Summarize these nodes
```

↓

```text
GRAPH_QUERY
```

---

```text
How do these genes relate to Parkinson disease?
```

↓

```text
MIXED_QUERY
```

---

```text
MATCH (n) RETURN n
```

↓

```text
CYPHER_QUERY
```

This becomes the first step after receiving a request.

---

# Phase 2 — Build Graph Context Agent

Current issue:

Graph selections are treated as optional.

They must become first-class context.

Create:

```text
GraphContextAgent
```

Inputs:

```ts
selectedNodes
selectedEdges
visibleSubgraph
sessionGraphState
query
```

Outputs:

```ts
{
  activeAnchors: [],
  graphScope: {},
  graphReferences: {},
  selectedNodeTypes: [],
  selectedEdgeTypes: []
}
```

Resolve phrases:

```text
these nodes
these genes
these proteins
this disease
them
those
selected graph
current graph
```

No entity extraction required.

---

# Phase 3 — Introduce Graph Analysis Layer

Current issue:

The system only knows retrieval.

Users frequently ask graph-analysis questions.

Create:

```text
GraphAnalysisService
```

Tools:

```ts
summarizeNodes()
summarizeSubgraph()
compareNodes()
findSharedPathways()
findSharedDiseases()
findSharedGenes()
findCommonNeighbors()
findHubNodes()
findBridgingNodes()
explainConnections()
analyzeCluster()
```

Examples:

```text
Summarize these nodes
```

↓

```ts
summarizeNodes()
```

---

```text
What do these genes have in common?
```

↓

```ts
findSharedPathways()
findSharedDiseases()
```

---

```text
Why are these nodes connected?
```

↓

```ts
explainConnections()
```

---

# Phase 4 — Split Intent From Entity Extraction

Current issue:

Intent and entity extraction are coupled.

Create:

```text
IntentAgent
```

Only outputs:

```ts
intent
operation
targetEntityTypes
```

Examples:

```text
Which diseases are associated with BRCA1?
```

↓

```json
{
  "intent": "disease_lookup"
}
```

---

Entity extraction should only return:

```json
{
  "mentions": ["BRCA1"]
}
```

Nothing else.

No normalization.

No resolution.

---

# Phase 5 — Refactor Entity Resolution

Create:

```text
EntityResolutionAgent
```

Responsibilities:

* exact match
* alias match
* synonym match
* identifier match
* ontology match

Resolution order:

```text
Exact
↓
Alias
↓
Synonym
↓
Identifier
↓
Semantic
```

Never:

```text
Semantic
↓
Everything else
```

---

# Phase 6 — Introduce Retrieval Planning Agent

Current issue:

Planner is tightly coupled to retrieval.

Create:

```text
RetrievalPlanningAgent
```

Inputs:

```text
Intent
Graph Context
Entities
Session State
```

Outputs:

```json
{
  "operations": []
}
```

Example:

```text
Which approved drugs target these proteins?
```

↓

```json
[
  {
    "operation": "protein_to_drug"
  },
  {
    "operation": "filter_approved"
  }
]
```

Planner should never generate Cypher directly.

Planner generates graph operations.

---

# Phase 7 — Create Retrieval Operations Layer

Create:

```text
RetrievalOperations
```

Examples:

```ts
getRelatedDiseases()
getRelatedGenes()
getRelatedProteins()
getRelatedPathways()
getRelatedDrugs()
getDrugIndications()
findShortestPath()
findCommonNeighbors()
retrieveEvidence()
```

Planner uses operations.

Operations use Cypher.

---

# Phase 8 — Add Cypher Agent

Only when operations cannot satisfy intent.

Responsibilities:

```text
Generate read-only Cypher
Validate Cypher
Estimate Cost
Execute Safely
```

Never allow unrestricted Cypher generation.

---

# Phase 9 — Introduce Evidence Agent

Responsibilities:

* rank evidence
* score evidence
* confidence estimation
* provenance ranking

Use:

```text
confidence
evidence
source
metadata
relationship strength
```

to prioritize results.

---

# Phase 10 — Add Re-Planning Loop

Current:

```text
Plan
↓
Retrieve
↓
Answer
```

Target:

```text
Plan
↓
Retrieve
↓
Enough Evidence?
```

If no:

```text
Replan
↓
Retrieve More
```

Example:

```text
How is APOE related to amyloid beta?
```

Try:

```text
Direct Relationship
```

No result.

↓

```text
Shortest Path
```

No result.

↓

```text
Shared Pathways
```

No result.

↓

```text
Shared Diseases
```

Answer.

---

# Phase 11 — Build Reasoning Agent

Responsibilities:

* grounded synthesis
* graph explanation
* evidence citation
* graph action generation

Inputs:

```text
Evidence
Graph Context
User Question
```

Outputs:

```text
Answer
Graph Actions
Confidence
```

---

# Final Architecture

```text
User Query
+
Selected Graph Context

        │
        ▼

    Query Router

        │
        ▼

 Graph Context Agent

        │
        ▼

    Intent Agent

        │
        ▼

 Entity Mention Agent

        │
        ▼

Entity Resolution Agent

        │
        ▼

Retrieval Planning Agent

        │
        ▼

  Retrieval Operations
         │
         ├─────────────► Cypher Agent
         │
         ▼

 Graph Analysis Layer

         ▼

   Evidence Agent

         ▼

 Replanning Loop

         ▼

   Reasoning Agent

         ▼

Answer + Graph Actions
```

---

# Definition of Done

The refactor is complete when all of the following work:

```text
Summarize these nodes
```

```text
What do these genes have in common?
```

```text
Compare the selected proteins
```

```text
Which approved drugs target these proteins?
```

```text
How do these selected genes relate to Parkinson disease?
```

```text
For which diseases is Metformin indicated?
```

```text
How is APOE related to amyloid beta?
```

```text
Find pathways shared by the selected nodes.
```

```text
Explain this subgraph.
```

without requiring special-case logic or manual intervention.
