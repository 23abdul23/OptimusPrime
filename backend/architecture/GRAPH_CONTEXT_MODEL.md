# Graph Context Model

## Purpose

Graph context is a first-class input to the graph agent. It is independent from entity extraction and entity resolution.

The user can express intent through the rendered graph itself, not only through text. Because of that, the backend must reason over:

- selected nodes
- selected edges
- visible graph
- remembered session graph

without reconstructing those inputs indirectly from natural language.

## Core Principle

Graph context priority is:

```text
Selected Nodes / Edges
        ↓
Visible Graph
        ↓
Session Graph
```

## Current Request Shape

The frontend sends:

```ts
{
  selectedNodeContext: Array<{
    id: string;
    label: string;
    nodeType?: string;
  }>;
  selectedEdgeContext: Array<{
    id: string;
    source: string;
    target: string;
    relation?: string;
  }>;
  networkContext?: {
    totalNodes: number;
    totalEdges: number;
    selectedNodeIds?: string[];
    selectedEdgeIds?: string[];
    visibleNodeIds?: string[];
    visibleEdgeIds?: string[];
    visibleNodeContext?: Array<{
      id: string;
      label: string;
      nodeType?: string;
    }>;
    topNodeTypes?: Array<{
      type: string;
      count: number;
    }>;
  };
}
```

## Backend Graph Context Result

`GraphContextAgentService` produces:

```ts
{
  activeAnchors: GraphSelectionNodeContext[];
  selectedNodes: GraphSelectionNodeContext[];
  selectedEdges: GraphSelectionEdgeContext[];
  visibleNodes: GraphSelectionNodeContext[];
  visibleNodeIds: string[];
  visibleEdgeIds: string[];
  graphScope: {
    mode: "selection" | "visible-subgraph" | "session" | "none";
    selectedNodeCount: number;
    selectedEdgeCount: number;
    visibleNodeCount: number;
    visibleEdgeCount: number;
  };
  graphReferences: {
    referencesSelection: boolean;
    referencesNodes: boolean;
    referencesEdges: boolean;
    referencesVisibleGraph: boolean;
    referencesSessionGraph: boolean;
  };
  selectedNodeTypes: string[];
  selectedEdgeTypes: string[];
}
```

## Required Behaviors

### Selection-Specific

- single selected node should become an active anchor
- selected edges should contribute both relation context and endpoint context
- multi-select should remain intact across the request lifecycle
- selected graph queries should not require entity resolution

### Visible-Graph-Specific

- if the user asks about `the graph`, `the network`, `this subgraph`, or similar graph-wide context and nothing is selected, the visible graph becomes the active subject
- the backend should be able to summarize the visible graph directly
- graph-wide analysis should use full visible graph ids and visible node metadata, not a tiny sample

### Session-Specific

- if neither selection nor visible graph provides the subject, the session graph is the last fallback

## Why This Matters

Without a strong graph-context model, the system makes wrong assumptions such as:

- trying to resolve imperative verbs as biomedical entities
- claiming no anchor entity exists when the visible graph itself is the subject
- ignoring selected edges and relationship structure
- failing graph-wide analysis queries when no nodes are explicitly selected

## Current Design Direction

The current implementation treats graph context as a planner input, an evidence-ranking input, and a reasoning input. It is not just a UI convenience payload.
