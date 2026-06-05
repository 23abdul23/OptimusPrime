# Graph Context Model

## Purpose
Graph context tells the backend what part of the graph the user is talking about before any retrieval happens.

## Context Sources
### Selected graph
Comes from:
- single-click node selection
- single-click edge selection
- ctrl/meta multi-select
- box selection
- lasso selection

Payload fields:
- `selectedNodeContext`
- `selectedEdgeContext`
- `networkContext.selectedNodeIds`
- `networkContext.selectedEdgeIds`

Rule:
- selected nodes and edges are the primary subject whenever the query refers to `these nodes`, `selected nodes`, `these edges`, `them`, or similar graph references

### Visible graph
Comes from the currently rendered network.

Payload fields:
- `networkContext.totalNodes`
- `networkContext.totalEdges`
- `networkContext.visibleNodeIds`
- `networkContext.visibleEdgeIds`
- `networkContext.visibleNodeContext`
- `networkContext.topNodeTypes`

Rule:
- if nothing is selected, the visible graph becomes the active graph subject for graph-wide analysis queries

### Session graph
Comes from Redis conversation state.

Stored fields:
- `selectedNodeIds`
- `selectedEdgeIds`
- `visibleNodeIds`
- `visibleEdgeIds`
- `activeEntities`
- `resolvedNodeIds`
- `frontierNodeIds`

Rule:
- session graph is the fallback only when neither selected graph nor visible graph is available

## Graph Scope Modes
### `selection`
Used when the request is anchored to selected nodes or edges.

### `visible-subgraph`
Used when the user refers to the graph/network and no stronger selection anchor exists.

### `session`
Used when the user refers to prior graph context and current frontend graph context is absent.

### `none`
Used when no graph context is available.

## Graph Context Agent Output
`GraphContextAgentService` returns:
- `activeAnchors`
- `selectedNodes`
- `selectedEdges`
- `visibleNodes`
- `visibleNodeIds`
- `visibleEdgeIds`
- `graphScope`
- `graphReferences`
- `selectedNodeTypes`
- `selectedEdgeTypes`

## Planner Rules
- Selected graph takes priority over visible graph.
- Visible graph takes priority over session graph.
- Graph-wide analysis uses graph ids directly; it does not require explicit anchor entity resolution.
- Entity queries may still use graph context for disambiguation and ranking.
- Mixed queries combine selected or visible graph context with resolved explicit entities.

## Ambiguity Rules
- If explicit mention matching is ambiguous inside the visible graph, visible-graph matches are preferred before global OptimusKG resolution.
- If a graph-subject query has enough selected or visible graph context, the system should not manufacture entity mentions from verbs such as `summarize`, `compare`, or `describe`.

## Current Frontend Contract
For correct graph-aware planning, the frontend is expected to send:
- `selectedNodeContext`
- `selectedEdgeContext`
- `networkContext.selectedNodeIds`
- `networkContext.selectedEdgeIds`
- `networkContext.visibleNodeIds`
- `networkContext.visibleEdgeIds`
- `networkContext.visibleNodeContext`
