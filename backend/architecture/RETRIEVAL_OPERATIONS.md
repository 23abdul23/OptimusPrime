# Retrieval Operations

## Overview
The graph agent now uses two primary execution families:
- `graph-analysis`
- `retrieval-operations`

The planner chooses between them instead of defaulting to generic neighborhood loading.

## Scope Selection
For graph-wide operations, the planner resolves scope in this order:
1. selected graph
2. visible graph
3. session graph

This scope is then passed to `GraphAnalysisService`.

## Graph Analysis Operations
Owned by `GraphAnalysisService`.

### Graph summary and explanation
- `summarize-selected-nodes`
- `summarize-visible-subgraph`
- `interpret-subgraph`
- `identify-graph-theme`
- `identify-central-concepts`
- `summarize-biological-narrative`

### Schema and node-type analysis
- `analyze-schema`
- `analyze-node-types`
- `find-available-node-types`
- `find-available-relationship-types`
- `analyze-genes`
- `analyze-diseases`
- `analyze-drugs`
- `analyze-pathways`
- `analyze-phenotypes`
- `analyze-anatomy`
- `analyze-molecular-functions`
- `analyze-cellular-components`
- `analyze-exposures`

### Relationship analysis
- `analyze-relationship-types`
- `find-cross-type-relationships`
- `find-dominant-relationships`
- `rank-relationship-types`
- `analyze-relationship-patterns`
- `analyze-cross-type-connections`
- `analyze-relationship-density`

### Network statistics and topology
- `compute-graph-metrics`
- `compute-node-type-distribution`
- `compute-relationship-distribution`
- `compute-centrality-metrics`
- `compute-density-metrics`
- `compute-component-statistics`
- `find-hub-nodes`
- `find-bridging-nodes`
- `analyze-cluster`

### Commonality and connection analysis
- `compare-nodes`
- `find-shared-pathways`
- `find-shared-diseases`
- `find-shared-genes`
- `find-common-neighbors`
- `explain-connections`

### Community detection
- `detect-communities`
- `detect-disease-modules`
- `detect-functional-modules`
- `detect-gene-modules`

### Enrichment
- `enrich-diseases`
- `enrich-pathways`
- `enrich-phenotypes`
- `enrich-biological-processes`
- `enrich-molecular-functions`
- `enrich-cellular-components`
- `enrich-anatomy`

### Ontology exploration
- `find-parents`
- `find-children`
- `find-ancestors`
- `find-descendants`
- `find-ontology-roots`
- `explore-ontology-hierarchy`

## Retrieval Operations
Owned by `RetrievalOperationsService`.

### Core retrieval
- `load-node-details`
- `retrieve-relationship-evidence`
- `find-shortest-path`
- `traverse-typed-paths`
- `retrieve-neighborhood`
- `expand-network`

### General typed retrieval
- `get-related-entities`
- `get-related-diseases`
- `get-related-genes`
- `get-related-proteins`
- `get-related-pathways`
- `get-related-drugs`
- `find-common-neighbors`
- `retrieve-clinical-guidelines`

### Drug discovery
- `get-drug-indications`
- `get-drug-targets`
- `get-drug-contraindications`
- `find-off-label-uses`
- `get-drug-mechanisms`

### Disease, gene, and pathway retrieval
- `get-disease-genes`
- `get-disease-phenotypes`
- `get-gene-diseases`
- `get-gene-pathways`
- `get-pathway-genes`
- `get-pathway-diseases`

### Anatomy retrieval
- `get-anatomy-genes`
- `get-anatomy-diseases`

### Exposure retrieval
- `get-exposure-genes`
- `get-exposure-diseases`
- `get-exposure-processes`

### Ambiguity support
- `find-candidate-entities`
- `find-visible-graph-matches`
- `rank-entity-candidates`

## Cypher
Owned by `CypherAgentService`.

### Explicit Cypher only
- `execute-custom-cypher`

The current implementation supports guarded execution of explicit read-only Cypher. It does not use free-form generated Cypher as the normal retrieval path.

## Planner Intent Mapping
### Graph-wide analysis families
- `graph-summary`
- `schema-analysis`
- `graph-relationship-analysis`
- `network-statistics`
- `community-detection`
- `ontology-analysis`
- `enrichment-analysis`
- `graph-explanation`

### Entity-anchored families
- `drug-search`
- `drug-discovery`
- `pathway-search`
- `guideline-search`
- `entity-search`
- `path-search`
- `exposure-analysis`

## Fallback Policy
- Use a typed graph-analysis operation when the subject is the selected graph, visible graph, or session graph.
- Use typed retrieval when the subject is a resolved entity or resolved set of entities.
- Use neighborhood loading only when no more specific operation is appropriate.
