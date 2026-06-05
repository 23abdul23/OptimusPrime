# LLM Usage Map

This document explains how much each backend service or agent currently depends on an LLM in the **implemented codebase**, not in an idealized target architecture.

## What The Percentage Means

- `100%` = the service's core job is an LLM call
- `50%` = the service mixes deterministic logic with LLM-backed behavior in a material way
- `0%` = no direct LLM dependency in the current implementation

These percentages represent **architectural dependence**, not CPU time, latency, or token spend.

## High-Level Finding

The architecture notes say LLMs are used for extraction, intent classification, planning support, evidence interpretation, and response synthesis.

That is only **partly true in the current code**:

- `backend/src/llm/llm.service.ts` is fully LLM-backed
- `backend/src/graph-agent/reasoning-agent.service.ts` is LLM-backed
- most other graph-agent stages are currently **rule-based, graph-based, or Redis/Neo4j-based**

So the current backend is better described as:

- **LLM-heavy at the final answer layer**
- **deterministic in routing, extraction, planning, retrieval, and evidence scoring**

## Service-Level LLM Usage

| Service / Agent | LLM Usage | Why |
| --- | ---: | --- |
| `LlmService` | `100%` | Direct OpenAI-compatible streaming chat service for `/llm/*` |
| `ReasoningAgentService` | `100%` | Final grounded answer synthesis is generated with the model |
| `GraphAgentService` | `20%` | Mostly orchestration, but it calls `ReasoningAgentService` for the final response |
| `QueryRouterService` | `0%` | Regex and rule-based route classification |
| `GraphContextAgentService` | `0%` | Selection/visible-graph/session-state logic only |
| `EntityExtractionService` | `0%` | Pattern-based extraction, no model call |
| `IntentAgentService` | `0%` | Deterministic intent classification rules |
| `EntityResolutionAgentService` | `0%` | OptimusKG candidate lookup and ranking, no LLM |
| `RetrievalPlanningAgentService` | `0%` | Typed plan construction from rules |
| `GraphRetrieverService` | `0%` | Dispatches plan steps to executors |
| `GraphAnalysisService` | `0%` | Neo4j/graph-topology/statistical analysis |
| `RetrievalOperationsService` | `0%` | Graph retrieval and Cypher-backed data loading |
| `EvidenceAgentService` | `0%` | Heuristic ranking and confidence scoring |
| `ReplanningAgentService` | `0%` | Rule-based bounded retry planning |
| `ConversationGraphStateService` | `0%` | Redis state persistence |
| `CypherAgentService` | `0%` | Guarded Cypher handling, validation, and execution |
| `ResponseSynthesisService` | `100%` | LLM-backed by implementation, but appears unused right now |

## Grouped By Layer

### 1. Pure LLM Services

These services directly instantiate an OpenAI-compatible provider and stream model output:

- `LlmService` -> `100%`
- `ReasoningAgentService` -> `100%`
- `ResponseSynthesisService` -> `100%` but currently appears unused

### 2. Mixed / Indirect LLM Use

- `GraphAgentService` -> `20%`

Reason:

- it does not do model reasoning internally
- but the end of the graph-agent pipeline depends on the reasoning model for the final natural-language answer

### 3. Deterministic Agents

These are currently non-LLM:

- `QueryRouterService`
- `GraphContextAgentService`
- `EntityExtractionService`
- `IntentAgentService`
- `EntityResolutionAgentService`
- `RetrievalPlanningAgentService`
- `GraphRetrieverService`
- `GraphAnalysisService`
- `RetrievalOperationsService`
- `EvidenceAgentService`
- `ReplanningAgentService`
- `ConversationGraphStateService`
- `CypherAgentService`

All of them are currently closer to:

- regex/rules
- graph queries
- scoring heuristics
- Redis/Neo4j state and retrieval

## End-To-End Route View

### `/llm/*`

LLM usage: `100%`

Reason:

- request enters an LLM-specific controller
- response generation is directly model-streamed

### `/graph-agent/chat`

Approximate LLM usage: `20%`

Reason:

1. routing is deterministic
2. graph context building is deterministic
3. extraction is deterministic
4. intent classification is deterministic
5. entity resolution is graph lookup based
6. planning is deterministic
7. retrieval is Neo4j / graph operation based
8. evidence scoring is deterministic
9. final answer synthesis is LLM-based

So the graph-agent pipeline uses an LLM mainly for the **last-mile narrative generation**, not for the core graph execution path.

## Practical Interpretation

If you explain this architecture to someone quickly:

- the standalone `llm` module is **fully LLM-driven**
- the `graph-agent` pipeline is **mostly graph-native and rule-driven**
- the graph agent becomes LLM-dependent mainly at the **final explanation/synthesis step**

## Recommended One-Line Summary

Current backend LLM usage is concentrated in `LlmService` and `ReasoningAgentService`; most other services in the graph-agent architecture are deterministic support layers around Neo4j, Redis, and typed graph-retrieval logic.
