# Tools

## Current Retrieval Tools

The backend currently uses these retrieval operations through `GraphRetrieverService`:

- `getNodeDetails`
- `retrieveEvidence`
- `shortestPath`
- `getRelatedEntities`
- `retrieveClinicalGuidelines`
- `retrieveSubgraph`
- `expandSubgraph`
- `executeGuardedCypher`

## Current Tool Characteristics

- operations are predefined and bounded
- some operations use custom Cypher in service code
- graph actions are generated directly in the retriever
- evidence records are generated together with retrieval

## Target Tool Model

The long-term tool stack should be layered:

```text
Planner
  -> Retrieval Operations
      -> Neo4j / OptimusKG Services
      -> Guarded Cypher fallback
```

## Phase 1-2 Notes

- Phase 1 introduces a Query Router before tool selection.
- Phase 2 introduces a Graph Context Agent so tool selection can use graph-derived anchors.
