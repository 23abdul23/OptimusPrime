# Memory Model

## Current Memory

Conversation graph state is stored in Redis through `ConversationGraphStateService`.

Current tracked fields:

- active entities
- resolved node ids
- frontier node ids
- retrieved node ids
- evidence cache
- prior queries
- last plan
- selected node ids
- selected edge ids
- visible node ids
- visible edge ids

## Current Role

Memory is primarily used as lightweight follow-up context and fallback anchoring.

## Limitation

The state exists, but planning does not yet consume it through a structured graph-context abstraction.

## Target Role

Memory should become an explicit input to:

- Graph Context Agent
- Retrieval Planning Agent
- Re-planning loop

## Phase 0-2

Phase 2 starts using session graph state as an input to graph-context interpretation instead of treating it as a late fallback only.
