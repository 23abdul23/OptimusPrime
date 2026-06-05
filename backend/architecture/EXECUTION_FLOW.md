# Execution Flow

> Presentation note: use the sequence diagram for a detailed slide and the branch diagram for a simplified "decision tree" slide.

## End-To-End Sequence

```mermaid
sequenceDiagram
    participant UI as Frontend UI
    participant GA as GraphAgentService
    participant CG as ConversationGraphStateService
    participant QR as QueryRouterService
    participant GC as GraphContextAgentService
    participant EX as EntityExtractionService
    participant IN as IntentAgentService
    participant ER as EntityResolutionAgentService
    participant PL as RetrievalPlanningAgentService
    participant RT as GraphRetrieverService
    participant EV as EvidenceAgentService
    participant RP as ReplanningAgentService
    participant RS as ReasoningAgentService
    participant Redis as Redis
    participant Neo4j as Neo4j

    UI->>GA: POST /graph-agent/chat\nmessages + selectedNodeContext + selectedEdgeContext + networkContext
    GA->>CG: load session state
    CG->>Redis: get state
    Redis-->>CG: prior graph state
    CG-->>GA: state
    GA->>QR: route query
    QR-->>GA: route + gating flags
    GA->>GC: build graph context
    GC-->>GA: graph scope + anchors
    opt extraction required
        GA->>EX: extract mentions/concepts
        EX-->>GA: extracted query
    end
    GA->>IN: classify intent
    IN-->>GA: intent
    opt resolution required
        GA->>ER: resolve entities / find candidates
        ER->>Neo4j: search + resolve
        Neo4j-->>ER: matches
        ER-->>GA: resolved entities or ambiguities
    end
    GA->>PL: build typed plan
    PL-->>GA: RetrievalPlanStep[]
    GA->>RT: execute plan
    RT->>Neo4j: graph analysis / retrieval / cypher
    Neo4j-->>RT: graph results
    RT-->>GA: evidence + graph actions
    GA->>EV: assess evidence
    EV-->>GA: evidence bundle
    opt insufficient and bounded retry remains
        GA->>RP: append recovery steps
        RP-->>GA: updated plan
        GA->>RT: execute appended steps
        RT->>Neo4j: additional retrieval
        Neo4j-->>RT: additional results
        RT-->>GA: augmented evidence
        GA->>EV: reassess
        EV-->>GA: updated evidence bundle
    end
    GA->>RS: synthesize grounded answer
    RS-->>GA: final answer text
    GA->>CG: save session state
    CG->>Redis: persist graph memory
    GA-->>UI: streamed text + graphEvidence + graphActions + graphState
```

## Request Branching Model

```mermaid
flowchart TD
    S[Incoming graph-agent request]
    R[Route query]
    C[Build graph context]
    D{What kind of request is this?}

    G1[GRAPH_QUERY\nselected or visible graph is the subject]
    G2[MIXED_QUERY\ngraph context plus explicit entities]
    G3[ENTITY_QUERY\nexplicit entity lookup]
    G4[GRAPH_DISCOVERY_QUERY\nempty canvas, build first graph]
    G5[CYPHER_QUERY\nexplicit guarded Cypher]

    E[Optional extraction]
    X[Optional resolution]
    P[Plan typed operations]
    T[Execute]
    V[Evidence assessment]
    Q{Need clarification\nor bounded replan?}
    A[Answer + graph actions + state]

    S --> R --> C --> D
    D --> G1 --> P
    D --> G2 --> E
    D --> G3 --> E
    D --> G4 --> E
    D --> G5 --> P
    E --> X --> P --> T --> V --> Q
    Q -->|clarification| A
    Q -->|replan| T
    Q -->|good enough| A
```

## Context Priority

The planner and executors use this precedence:

1. selected graph
2. visible graph
3. session graph
4. discovery mode

That rule is what makes follow-up questions like "summarize these nodes" or "expand this graph" work without re-specifying all entities.

## Important Runtime Behaviors

### Clarification path

- The system can stop before planning when:
  - the visible graph contains multiple matching nodes for a mention
  - discovery-mode seed resolution is ambiguous
  - the empty-canvas query is too broad to seed safely
- Clarification state is persisted in Redis so the next user turn can resume the original request.

### Discovery path

- If there is no useful current graph, the pipeline can build a compact first network.
- This is a deliberate branch, not an accidental fallback.

### Streamed response contract

The backend streams four UI-facing outputs:

- assistant text
- `graphEvidence`
- `graphActions`
- `graphState`

## Slide-Ready Summary

- **Input**: user question + live graph context.
- **Middle**: route -> context -> extract -> resolve -> plan -> execute.
- **Quality gate**: evidence assessment plus bounded replanning.
- **Output**: grounded answer plus graph updates the UI can apply immediately.
