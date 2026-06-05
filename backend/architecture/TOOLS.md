# Tool Surface

## Purpose
This file lists the backend tool surface that the planner can emit through `RetrievalPlanStep.tool`.

## Graph Analysis Tools
Owned by `GraphAnalysisService`.

### Summary and explanation
- `summarizeNodes`
- `summarizeSubgraph`
- `interpretSubgraph`
- `identifyGraphTheme`
- `identifyCentralConcepts`
- `summarizeBiologicalNarrative`

### Schema and node types
- `analyzeSchema`
- `analyzeNodeTypes`
- `findAvailableNodeTypes`
- `findAvailableRelationshipTypes`
- `analyzeGenes`
- `analyzeDiseases`
- `analyzeDrugs`
- `analyzePathways`
- `analyzePhenotypes`
- `analyzeAnatomy`
- `analyzeMolecularFunctions`
- `analyzeCellularComponents`
- `analyzeExposures`

### Relationships
- `analyzeRelationshipTypes`
- `findCrossTypeRelationships`
- `findDominantRelationships`
- `rankRelationshipTypes`
- `analyzeRelationshipPatterns`
- `analyzeCrossTypeConnections`
- `analyzeRelationshipDensity`

### Topology and network statistics
- `computeGraphMetrics`
- `computeNodeTypeDistribution`
- `computeRelationshipDistribution`
- `computeCentralityMetrics`
- `computeDensityMetrics`
- `computeComponentStatistics`
- `findHubNodes`
- `findBridgingNodes`
- `analyzeCluster`

### Shared structure and connection analysis
- `compareNodes`
- `findSharedPathways`
- `findSharedDiseases`
- `findSharedGenes`
- `findCommonNeighbors`
- `explainConnections`

### Community detection
- `detectCommunities`
- `detectDiseaseModules`
- `detectFunctionalModules`
- `detectGeneModules`

### Ontology
- `findParents`
- `findChildren`
- `findAncestors`
- `findDescendants`
- `findOntologyRoots`
- `exploreOntologyHierarchy`

### Enrichment
- `enrichDiseases`
- `enrichPathways`
- `enrichPhenotypes`
- `enrichBiologicalProcesses`
- `enrichMolecularFunctions`
- `enrichCellularComponents`
- `enrichAnatomy`

## Retrieval Operation Tools
Owned by `RetrievalOperationsService`.

### Resolution and lookup support
- `searchEntities`
- `resolveEntity`
- `getNodeDetails`

### Composite discovery tools
- `discoverGraph`
- `buildDiseaseNetwork`
- `buildGeneNetwork`
- `buildDrugNetwork`
- `buildPathwayNetwork`
- `buildRelationshipNetwork`
- `buildMultiEntityNetwork`

### Core graph retrieval
- `retrieveEvidence`
- `shortestPath`
- `retrieveSubgraph`
- `expandSubgraph`
- `getRelatedEntities`

### Drug discovery
- `getDrugTargets`
- `getDrugContraindications`
- `findOffLabelUses`
- `getDrugMechanisms`

### Disease, gene, and pathway retrieval
- `getDiseaseGenes`
- `getDiseasePhenotypes`
- `getGeneDiseases`
- `getGenePathways`
- `getPathwayGenes`
- `getPathwayDiseases`

### Anatomy and exposure retrieval
- `getAnatomyGenes`
- `getAnatomyDiseases`
- `getExposureGenes`
- `getExposureDiseases`
- `getExposureProcesses`

### Candidate and ambiguity support
- `findCandidateEntities`
- `findVisibleGraphMatches`
- `rankEntityCandidates`

### Guidelines
- `retrieveClinicalGuidelines`

## Cypher Tool
Owned by `CypherAgentService`.

- `executeGuardedCypher`

## State Tool
Used by the orchestrator for network-summary and state-aware flows.

- `getConversationGraphState`

## Tool Selection Rules
- Prefer graph-analysis tools for selected graph, visible graph, or session graph analysis.
- Prefer retrieval-operation tools for resolved entity lookup and typed traversals.
- Prefer composite discovery tools when the graph is empty and the agent needs to generate the first useful network from resolved seed entities.
- Use `executeGuardedCypher` only for explicit Cypher-style requests.
- Do not route graph-subject queries through entity resolution unless explicit non-graph entities must be resolved.
