# Memory Model

## Storage
Conversation graph memory is stored in Redis through `ConversationGraphStateService`.

## Current State Shape
Each session stores:
- `sessionId`
- `activeEntities`
- `resolvedNodeIds`
- `frontierNodeIds`
- `retrievedNodeIds`
- `evidenceCache`
- `priorQueries`
- `lastPlan`
- `selectedNodeIds`
- `selectedEdgeIds`
- `visibleNodeIds`
- `visibleEdgeIds`
- `updatedAt`

## Meaning Of The Fields
### `activeEntities`
The current entity anchors most relevant to the active conversation.

### `resolvedNodeIds`
Resolved entity ids accumulated across turns.

### `frontierNodeIds`
Candidate expansion anchors for follow-up graph exploration.

### `retrievedNodeIds`
Nodes already touched by prior retrieval steps.

### `evidenceCache`
Bounded cache of recent evidence items used for follow-up reasoning and replanning.

### `priorQueries`
Recent user questions in the current graph session.

### `lastPlan`
The last typed retrieval plan executed for the session.

### `selectedNodeIds` and `selectedEdgeIds`
The last known selected graph context.

### `visibleNodeIds` and `visibleEdgeIds`
The last known visible graph context.

## How Memory Is Used
- Router does not rely on memory for mention extraction.
- Graph context agent can fall back to session graph when frontend context is absent.
- Planner can reuse active entities and graph frontier for follow-up questions.
- Evidence agent uses recent evidence to detect insufficiency and to avoid repeating weak retrieval.
- Reasoning agent can refer to ongoing graph context without re-querying all prior turns.

## Write Policy
After each request, the backend persists:
- the latest active entities
- selected and visible graph ids
- the latest evidence bundle items
- the latest plan
- updated timestamps

The service also deduplicates and truncates arrays so memory stays bounded.

## Current Limits
- `activeEntities` is trimmed to a small working set.
- node-id lists are deduplicated and capped.
- `evidenceCache` is bounded.
- selection ids are capped more aggressively than visible graph ids.

## Design Principle
Memory is graph-context memory, not free-form long-form chat memory. It exists to preserve graph anchors, graph scope, prior evidence, and plan continuity across turns.
