# Target Architecture

## Goal

Move from a vertically-scaled sequential graph agent to a graph-native orchestration model built from specialized deterministic sub-agents under a single orchestrator.

The target system is **not** a swarm of autonomous agents.

It is a horizontally-specialized architecture with typed interfaces and deterministic routing.

## Target Components

```text
Query Router
Graph Context Agent
Intent Agent
Entity Mention Agent
Entity Resolution Agent
Retrieval Planning Agent
Retrieval Operations Layer
Cypher Agent
Graph Analysis Layer
Evidence Agent
Reasoning Agent
```

## Design Principles

- Graph context is a first-class input modality.
- Entity mentions are extracted without normalization or inference.
- Intent is identified before retrieval planning.
- Planner emits graph operations, not raw Cypher.
- Retrieval operations are reusable and testable.
- Cypher is a controlled fallback, not the default interface.
- Evidence ranking is separate from graph retrieval.
- Answer generation is grounded in retrieved evidence only.

## Migration Plan

- Phase 0: architecture documentation
- Phase 1: Query Router
- Phase 2: Graph Context Agent
- Later phases:
  - graph analysis layer
  - intent split
  - entity resolution refactor
  - retrieval planning refactor
  - retrieval operations layer
  - Cypher agent
  - evidence agent hardening
  - re-planning loop
  - reasoning agent
