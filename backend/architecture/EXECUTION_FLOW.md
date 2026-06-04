# Execution Flow

## Current Flow

```text
User Query + UI Graph Context
        |
        v
GraphAgentService
        |
        +--> EntityExtractionService
        +--> EntityResolutionService
        +--> RetrievalPlannerService
        +--> GraphRetrieverService
        +--> EvidenceSelectionService
        +--> ResponseSynthesisService
```

## Target Flow

```text
User Query
+ Graph Selection Context
+ Visible Graph Context
+ Session Graph State
        |
        v
Query Router
        |
        v
Graph Context Agent
        |
        v
Intent Agent
        |
        v
Entity Mention Agent
        |
        v
Entity Resolution Agent
        |
        v
Retrieval Planning Agent
        |
        v
Retrieval Operations Layer ----> Cypher Agent (fallback only)
        |
        v
Graph Analysis Layer
        |
        v
Evidence Agent
        |
        v
Re-planning Loop
        |
        v
Reasoning Agent
        |
        v
Answer + Graph Actions + Updated Memory
```

## Phase 0-2 Focus

The first implemented steps are:

1. document the current and target architecture
2. add a Query Router before entity-centric processing
3. introduce a Graph Context Agent that turns graph selections into structured planning inputs
