# Current Architecture

This folder now serves two jobs:

1. explain the current implementation accurately
2. give you slide-ready architecture diagrams for presentations

> Presentation note: the two Mermaid blocks in this file are the best "overall architecture" visuals for a PPT.

## System Overview

```mermaid
flowchart LR
    U[User / Researcher]
    F[Frontend UI\nNext.js static export\nserved by Nginx]
    B[NestJS Backend API]
    GA[Graph Agent Pipeline\n/graph-agent/chat\n+ /graph-agent/explore/*]
    OKG[OptimusKG REST Layer\n/optimus/*]
    GQL[GraphQL API\n/graphql]
    LLM[LLM Chat Layer\n/llm/*]
    SPR[Shared System Prompt Registry\nbackend/src/llm/system-prompts.ts]
    ALG[Algorithm Layer\n/algorithm/*]
    N[(Neo4j\nKnowledge Graph)]
    R[(Redis\nSession + Cache + Throttling)]
    M[LLM Provider\nOpenAI-compatible]

    U --> F
    F --> B
    B --> GA
    B --> OKG
    B --> GQL
    B --> LLM
    B --> ALG
    GA --> SPR
    LLM --> SPR
    GA --> N
    GA --> R
    GA --> M
    OKG --> N
    GQL --> N
    ALG --> N
    ALG --> R
    LLM --> M
```

## Runtime Layers

```mermaid
flowchart TD
    subgraph Frontend
        FE1[Explore page\nanswer-first chat]
        FE2[Knowledge graph workspace]
        FE3[Graph chat UI]
        FE4[Selection + visible graph context]
        FE5[Background network preparation]
    end

    subgraph Backend["NestJS application"]
        BE1[AppModule]
        BE2[GraphAgentModule]
        BE3[OptimusKgModule]
        BE4[GraphqlModule]
        BE5[LlmModule]
        BE6[AlgorithmModule]
        BE7[Neo4jModule]
        BE8[RedisModule]
    end

    subgraph Data
        D1[(Neo4j)]
        D2[(Redis)]
        D3[LLM provider]
    end

    FE1 --> FE5
    FE1 --> BE5
    FE5 --> BE2
    FE1 --> FE2
    FE2 --> FE3
    FE2 --> FE4
    FE3 --> BE2
    FE2 --> BE3
    FE2 --> BE4
    FE2 --> BE6
    BE1 --> BE2
    BE1 --> BE3
    BE1 --> BE4
    BE1 --> BE5
    BE1 --> BE6
    BE1 --> BE7
    BE1 --> BE8
    BE2 --> D1
    BE2 --> D2
    BE2 --> D3
    BE3 --> D1
    BE4 --> D1
    BE6 --> D1
    BE6 --> D2
    BE5 --> D3
```

## What Is Running Today

### Frontend

- Static Next.js export, packaged into an Nginx image for deployment.
- Main exploration entry lives at the explore page.
- `/explore` now runs an answer-first biomedical chat against the LLM layer, then starts background extraction, concept detection, intent inference, candidate ranking, and seed acceptance for an optional `View Network` action.
- The knowledge graph workspace still uses the graph-aware agent at `/knowledge-graph`.
- The browser sends graph-aware request context:
  - `selectedNodeContext`
  - `selectedEdgeContext`
  - `networkContext`

### Backend

- Single NestJS service boundary.
- Current major modules:
  - `GraphAgentModule`
  - `OptimusKgModule`
  - `GraphqlModule`
  - `LlmModule`
  - `AlgorithmModule`
  - `Neo4jModule`
  - `RedisModule`

### Data Plane

- Neo4j is the source of truth for graph entities, relationships, and graph traversal.
- Redis stores conversation graph memory, cache-like state, and throttling data.
- Redis also stores prepared `/explore` answer-to-network handoff state keyed by preparation id, including extracted items, intent, candidate groups, accepted/rejected seeds, and build telemetry.
- LLMs are used for extraction, intent classification, planning support, evidence interpretation, and response synthesis, but not for graph truth.
- All backend system prompts are centralized in `backend/src/llm/system-prompts.ts` so prompt tuning happens in one place.

## Centralized System Prompts

The shared prompt registry now covers these prompt-bearing stages:

- `/llm/chat` general biomedical answering
- `/llm/kg-chat` graph-aware tool-calling chat
- graph-agent clarification selection
- graph-agent extraction refinement
- graph-agent query decomposition
- graph-agent intent classification
- graph-agent reasoning
- graph-agent response synthesis
- `/graph-agent/explore/prepare-network` answer extraction, concept detection, and intent inference

These are the places from the current architecture where a dedicated system prompt is useful, because each stage has a different contract, risk profile, and output shape.

## Public Backend Surface

| Layer | Route family | Purpose |
| --- | --- | --- |
| OptimusKG | `/optimus/stats`, `/optimus/search`, `/optimus/subgraph`, `/optimus/expand`, `/optimus/path`, `/optimus/nodes/:id` | direct graph exploration and graph payload APIs |
| Graph agent | `/graph-agent/chat`, `/graph-agent/explore/prepare-network`, `/graph-agent/explore/build-network` | streamed graph-aware assistant plus deferred `/explore` extraction, decisioned seed preparation, and graph build |
| GraphQL | `/graphql` | typed read/query surface |
| LLM | `/llm/*` | general LLM-backed features, including answer-first `/explore` chat |
| Algorithm | `/algorithm/*` | graph algorithms and session-linked analysis |

## Why This Architecture Works

- It keeps one backend deployment unit instead of splitting graph logic across many services.
- It separates direct graph APIs from agentic orchestration.
- It separates answer-first exploration from graph-building, so users get an immediate biomedical answer without paying the graph-construction cost up front.
- It treats graph context as a first-class request input instead of reconstructing it from chat history.
- It keeps Neo4j queries and graph actions grounded in the knowledge graph rather than in free-form LLM guesses.

## Slide-Ready Summary

- **Frontend**: answer-first explore chat, optional graph handoff, graph UI, graph-selection context.
- **Backend**: NestJS app with LLM chat for first response plus a specialized graph-agent pipeline for graph preparation/build and graph-native follow-up chat.
- **Data**: Neo4j for graph truth, Redis for session/memory, LLM provider for language tasks.
- **Core pattern**: answer first -> extract items + infer intent -> rank candidates -> accept seeds -> optional graph build -> graph-native continuation.
