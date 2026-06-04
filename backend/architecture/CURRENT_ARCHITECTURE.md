# Current Architecture

## Summary

The current OptimusKG graph agent is a single backend orchestrator built as a sequential planner/executor pipeline.

The backend entrypoint is `GraphAgentService`, which coordinates:

1. request parsing
2. entity extraction
3. entity resolution
4. retrieval planning
5. graph retrieval
6. evidence selection
7. response synthesis
8. Redis-backed state updates

The frontend sends the latest user message plus graph-derived context:

- `selectedNodeContext`
- `selectedEdgeContext`
- `networkContext`

The backend then decides what graph operations to run.

## Current Request Flow

```text
Frontend KGChat
  -> GraphAgentController
  -> GraphAgentService
      -> ConversationGraphStateService.getConversationGraphState()
      -> EntityExtractionService.extractQuery()
      -> EntityResolutionService.resolveEntities()
      -> RetrievalPlannerService.plan()
      -> GraphRetrieverService.executePlan()
      -> EvidenceSelectionService.buildBundle()
      -> ConversationGraphStateService.saveConversationGraphState()
      -> ResponseSynthesisService.streamAnswer()
```

## Current Properties

- Orchestration is centralized in one service.
- Most intelligence is heuristic and rule-driven.
- The planner is static per request.
- Retrieval uses predefined operations plus guarded Cypher execution.
- Graph context is available, but not yet a first-class planning model.

## Current Weaknesses

- Intent detection and entity extraction are still too tightly coupled.
- Graph-only queries can still fall into entity-centric code paths.
- Selected graph context is merged conditionally instead of being authoritative.
- Retrieval planning still relies on a strong `primary` anchor assumption.
- The generic neighborhood fallback is overused.
- There is no explicit re-planning loop.
