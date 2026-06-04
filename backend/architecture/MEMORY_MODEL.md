# Memory Model

## Summary

The graph agent maintains lightweight session memory in Redis so follow-up questions can refer to prior graph context without resending the entire conversation history.

## Storage Layer

- service: `ConversationGraphStateService`
- backend store: Redis
- scope: per `sessionId`

## Stored State

The session model is:

```ts
{
  sessionId: string;
  activeEntities: ResolvedEntity[];
  resolvedNodeIds: string[];
  frontierNodeIds: string[];
  retrievedNodeIds: string[];
  evidenceCache: GraphEvidenceItem[];
  priorQueries: string[];
  lastPlan: RetrievalPlanStep[];
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  visibleNodeIds: string[];
  visibleEdgeIds: string[];
  updatedAt: string;
}
```

## Meaning Of Each Field

### activeEntities

- the currently important resolved entities for follow-up reasoning
- includes selected-context entities when the graph selection is part of the subject

### resolvedNodeIds

- ids that were explicitly resolved in prior turns

### frontierNodeIds

- ids surfaced by retrieved evidence that may be useful for expansion or follow-up questions

### retrievedNodeIds

- ids already loaded through retrieval or graph-analysis results

### evidenceCache

- prior evidence items for session continuity and debugging

### priorQueries

- previous user queries in the session

### lastPlan

- the last retrieval plan emitted by the planner

### selectedNodeIds / selectedEdgeIds

- the last explicit graph selection stored for the session

### visibleNodeIds / visibleEdgeIds

- the last visible graph boundary known to the backend

## What Memory Is Used For

- context fallback for follow-up questions
- graph expansion planning
- ranking active entities
- preserving session graph identity
- backend debugging and inspection

## What Memory Does Not Do

- it is not the source of truth for the actual graph structure
- it does not replace Neo4j retrieval
- it does not permit unsupported reasoning without fresh evidence

## Current Constraints

- memory is intentionally compact
- the backend still prefers current selection and current visible graph over stale session state
- visible graph is session memory, but not a substitute for explicit current request context when the frontend can provide it
