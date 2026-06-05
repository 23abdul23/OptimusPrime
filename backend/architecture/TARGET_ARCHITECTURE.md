# Target Architecture

## Direction
Keep the current single NestJS orchestrator, but continue to strengthen the specialized-service boundaries. The target is not a loose autonomous swarm. The target is a horizontally specialized, typed graph-agent architecture inside one service boundary.

## What Is Already In Place
- router-gated extraction and resolution
- graph-context-first planning
- dedicated graph analysis executor
- dedicated typed retrieval executor
- guarded Cypher boundary
- evidence assessment
- bounded replanning
- grounded reasoning
- Redis-backed session graph memory

## Near-Term Target
### Stronger graph analytics
- statistical enrichment rather than support-only enrichment
- GDS-backed community detection where available
- better centrality and module scoring

### Better ambiguity handling
- explicit clarification plans as first-class planner outputs
- richer visible-graph matching and grouped answers for ambiguous labels

### Stronger retrieval planning
- more explicit executor scoring before the plan is emitted
- richer operation composition for multi-step graph-wide questions
- better planner verification against actual graph scope

### Better evidence grounding
- provenance-aware scoring across more tool families
- stronger partial-evidence messaging
- evaluation suites for graph-summary, ontology, enrichment, and drug-discovery flows

### Multi-source support
- keep OptimusKG as the current source of truth
- evolve the retrieval and graph-analysis layers so other KGs can be added behind the same contracts

## Architecture Shape
### Keep
- one orchestrator
- specialized services
- typed plan steps
- bounded replanning

### Avoid
- free-form multi-agent debate loops
- planner-generated Cypher as the default path
- LLM-only entity existence checks

## Desired End State
The graph agent should answer most KG questions through:
1. graph context resolution
2. typed intent classification
3. typed operation planning
4. graph-native execution
5. explicit evidence assessment
6. grounded response synthesis

The visible graph and selected graph should remain first-class subjects throughout that flow.
