# ADR-002: Graph Context Agent

- Status: Accepted and implemented in Phase 2
- Phase: 2

## Context

Graph selections are currently optional metadata in the request rather than a primary planning input.

This causes the system to underuse:

- selected nodes
- selected edges
- visible graph context
- session graph state

## Decision

Introduce a `GraphContextAgent` that converts UI graph context into a typed planning input.

Outputs include:

- active anchors
- graph scope
- graph reference resolution
- selected node types
- selected edge types

## Consequences

- phrases like `these nodes` and `selected graph` can be resolved before entity extraction
- planning can use graph anchors directly
- graph-only workflows stop depending on entity resolution

## Implementation Notes

Phase 2 implementation introduces `GraphContextAgentService` and moves graph-selection interpretation ahead of planner execution.

Implemented behavior:

- interpret graph references such as selection references, edge references, visible-graph references, and session-graph references
- compute `activeAnchors`
- compute `graphScope`
- expose `selectedNodeTypes` and `selectedEdgeTypes`
- promote graph-selected anchors into the orchestrator before retrieval planning

Changed files:

- `backend/src/graph-agent/graph-context-agent.service.ts`
- `backend/src/graph-agent/graph-agent.types.ts`
- `backend/src/graph-agent/graph-agent.module.ts`
- `backend/src/graph-agent/graph-agent.service.ts`
- `backend/src/graph-agent/retrieval-planner.service.ts`

Observed Phase 2 effect:

- graph selection is now consumed as a structured planning input instead of a raw optional payload
- graph-only requests can bind directly to selected anchors before entity resolution
- session graph state can provide fallback anchor recovery when the request references prior graph context
