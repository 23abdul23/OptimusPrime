# Graph Context Model

## Purpose

Graph context must be modeled independently from entity extraction.

The graph itself provides explicit user inputs:

- selected nodes
- selected edges
- visible subgraph
- current graph/session state

These inputs should not be reconstructed indirectly through entity extraction.

## Target Shape

```ts
{
  activeAnchors: [],
  graphScope: {},
  graphReferences: {},
  selectedNodeTypes: [],
  selectedEdgeTypes: []
}
```

## Required Behaviors

- resolve phrases like `these nodes`, `these genes`, `them`, `selected graph`
- distinguish selection-scoped queries from entity-only queries
- expose selected node and edge types to the planner
- carry visible graph scope for network-aware questions

## Phase 2

Phase 2 introduces `GraphContextAgent` as the first implementation of this model.
