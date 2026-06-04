# Target Architecture

## Purpose

This file describes the intended steady-state architecture for the current graph agent. It is not a speculative redesign from scratch. It is the target shape that the current implementation is already moving toward and largely reflects the implemented service boundaries.

## Target Shape

```text
Frontend Graph UI + KG Chat
        ↓
Graph-Agent API
        ↓
GraphAgentService (orchestrator)
        ↓
Query Router
        ↓
Graph Context Agent
        ↓
Intent Agent
        ↓
Optional Mention Extraction
        ↓
Optional Entity Resolution
        ↓
Retrieval Planning Agent
        ↓
Execution Coordinator
    ├─ Graph Analysis Layer
    ├─ Retrieval Operations Layer
    └─ Guarded Cypher Layer
        ↓
Evidence Agent
        ↓
Replanning Loop
        ↓
Reasoning Agent
        ↓
Streamed Answer + Graph Actions + Graph State
```

## Target Properties

### 1. Graph-First Reasoning

- the graph, not the LLM, is the primary substrate for biomedical reasoning
- visible graph context is a valid subject even without explicit selected nodes

### 2. Conditional Entity Work

- extraction should run only when needed
- resolution should run only when needed
- graph-subject queries should not be forced through entity resolution

### 3. Operation-First Planning

- the planner should emit typed operations
- execution should be delegated to the correct layer

### 4. Schema-Aware Graph Analysis

- graph analysis should work across all node types present in the graph
- summaries should use topology, node-type distribution, relationship distribution, and node metadata

### 5. Structured Outputs

The backend should stream:

- answer text
- graph evidence bundle
- graph actions
- updated graph state

### 6. Stateful Follow-Up Handling

- session graph state should support follow-up questions
- current selection and visible graph should still outrank older session memory

## Near-Term Direction

The remaining architectural work should continue to strengthen:

- visible-graph-native analysis
- schema-aware summaries across all ontology categories
- explicit graph-wide analytic intents
- planner coverage for graph-wide follow-up questions
