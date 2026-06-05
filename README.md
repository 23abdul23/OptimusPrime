# Optimus Explorer

Optimus Explorer is a Knowledge Graph explorer and visualization tool built over the TBEP workflow and adapted for the `optimusKG/` dataset. It provides a local stack for loading biomedical graph data into Neo4j, querying it through a backend API, and exploring the graph through an interactive web UI.

## What It Does

- explore biomedical entities and relationships as an interactive knowledge graph
- search nodes, load random neighborhoods, and expand subgraphs
- inspect shortest paths between entities
- visualize graph structure in a Sigma.js canvas
- import and validate data from the `optimusKG/` parquet files
- run the full local stack with Neo4j, Redis, backend, and frontend

## Repository Layout

- `backend/`: Apollo Server, import pipeline, Neo4j bridge, BullMQ worker, dataset discovery, and graph query services
- `frontend/`: Next.js application for graph exploration and visualization
- `packages/shared/`: shared types, enums, defaults, and utilities used across apps
- `optimusKG/`: source parquet dataset used for import and lookup
- `compose.yml`: local infrastructure for Optimus Neo4j, Redis, backend, and frontend
- `docs/`: architecture notes, generated schema output, and supporting documentation
- `reports/`: generated reports and analysis outputs

## Quick Start

### Docker

1. Copy `.env.example` to `.env` and use these Optimus Neo4j settings:

```env
OPTIMUS_NEO4J_USERNAME=neo4j
OPTIMUS_NEO4J_PASSWORD=optimus-password
OPTIMUS_NEO4J_DATABASE=optimusKG
REDIS_PASSWORD=test1234
```

The backend container connects to Neo4j over the internal Docker network at `bolt://neo4j:7687`.
On a server, only change the exposed host ports in `.env` to avoid clashes:

```env
OPTIMUS_FRONTEND_PORT=4000
OPTIMUS_BACKEND_PORT=4500
OPTIMUS_NEO4J_HTTP_PORT=8474
OPTIMUS_NEO4J_BOLT_PORT=8687
```

If you need the backend to use an external Neo4j instead of the compose-managed one, set:

```env
OPTIMUS_BACKEND_NEO4J_URI=bolt://your-host:your-port
```

2. Load the dump into the Neo4j Docker volume:

```bash
docker stop optimus-neo4j
docker cp .\neo4j.dump optimus-neo4j:/data/neo4j.dump
docker run --rm --volumes-from optimus-neo4j neo4j:5.26-community rm -rf /data/databases/neo4j /data/transactions/neo4j
docker run --rm --volumes-from optimus-neo4j neo4j:5.26-community neo4j-admin database load neo4j --from-path=/data --overwrite-destination=true
docker start optimus-neo4j
docker exec optimus-neo4j cypher-shell -u neo4j -p optimus-password "MATCH (n) RETURN count(n) AS total_nodes;"
```

3. Start the stack:

```bash
pnpm install
docker compose up --build
```

Open:

- Frontend: `http://localhost:${OPTIMUS_FRONTEND_PORT}`
- GraphQL API: `http://localhost:${OPTIMUS_BACKEND_PORT}/graphql`
- Neo4j Browser: `http://localhost:${OPTIMUS_NEO4J_HTTP_PORT}`

Bolt runs on `bolt://localhost:${OPTIMUS_NEO4J_BOLT_PORT}`.
The Neo4j credentials are `neo4j` / `optimus-password`, and the database name is `optimusKG`.
If you run the backend outside Docker against the compose-managed Neo4j instance, point `backend/.env` `NEO4J_URI` at `bolt://host.docker.internal:${OPTIMUS_NEO4J_BOLT_PORT}`.

### Local Development

```bash
pnpm install
pnpm --filter @optimus/backend generate-schema
pnpm dev
```

For the full local workflow you will usually also want Optimus Neo4j and Redis running through Docker:

```bash
docker compose up neo4j redis
```

## Core Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm test:backend
pnpm analyze
pnpm import
pnpm import:parallel
pnpm worker
pnpm --filter @optimus/backend generate-schema
```

## Environment

### Backend

The backend reads:

- `PORT`
- `FRONTEND_ORIGIN`
- `OPTIMUSKG_ROOT`
- `REPORTS_DIR`
- `IMPORT_LOG_DIR`
- `PYTHON_BIN`
- `NEO4J_URI`
- `NEO4J_USERNAME`
- `NEO4J_PASSWORD`
- `REDIS_URL`
- `IMPORT_BATCH_SIZE_NODES`
- `IMPORT_BATCH_SIZE_EDGES`
- `SUBGRAPH_DEFAULT_MAX_NODES`
- `SUBGRAPH_HARD_MAX_NODES`

### Frontend

The frontend reads:

- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_API_BASE_URL`

## Architecture Summary

1. parquet data from `optimusKG/` is discovered and imported through the backend pipeline
2. Neo4j stores the graph used for exploration queries
3. Redis supports caching and queue-backed operations
4. the backend exposes GraphQL and graph query endpoints
5. the frontend renders the graph, node details, subgraphs, and shortest-path views

## Notes

- The current system is positioned as a Knowledge Graph explorer and visualization layer, not only a raw importer.
- The project inherits its workflow shape from TBEP, but is now focused on interactive graph exploration over OptimusKG.
- The importer uses the per-type parquet files under `optimusKG/nodes/` and `optimusKG/edges/` because they preserve nested property structures.
- Raw node payloads can be retrieved on demand instead of copying every source field wholesale into Neo4j.
- Large graph scans are handled as streamed or bounded operations where possible to avoid loading the biggest files fully into memory.

## Graph-Agent Extraction Contract

The graph-agent now treats the knowledge graph as the only source of truth for entity existence and resolution.

### Extraction prompt

```text
You are a biomedical query extractor for a knowledge graph.

Rules:
- Extract only explicit text spans that appear verbatim in the user's latest message.
- Never invent, infer, normalize, expand, alias, or rewrite biomedical entities.
- If the user wrote "MAPT", output "MAPT" only. Do not add COMETT, tau, microtubule associated protein tau, or any related concept.
- Do not use conversation memory, selected graph nodes, or prior answers as extracted entities.
- Separate explicit entity mentions from broader concepts and from user intent.
- If a query contains no explicit entity mention, return an empty mentions array.
- Concepts must also be explicit spans from the user's text.
- The knowledge graph is the only source of truth for entity existence and resolution.

Return strict JSON only.
```

### JSON schema

```json
{
  "type": "object",
  "required": ["mentions", "concepts", "intent"],
  "properties": {
    "mentions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["text", "span", "typeHints", "source"],
        "properties": {
          "text": { "type": "string" },
          "span": {
            "type": "object",
            "required": ["start", "end"],
            "properties": {
              "start": { "type": "integer" },
              "end": { "type": "integer" }
            }
          },
          "typeHints": { "type": "array", "items": { "type": "string" } },
          "source": { "type": "string", "enum": ["query"] }
        }
      }
    },
    "concepts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["text", "span", "category", "source"],
        "properties": {
          "text": { "type": "string" },
          "span": {
            "type": "object",
            "required": ["start", "end"],
            "properties": {
              "start": { "type": "integer" },
              "end": { "type": "integer" }
            }
          },
          "category": { "type": "string" },
          "source": { "type": "string", "enum": ["query"] }
        }
      }
    },
    "intent": {
      "type": "object",
      "required": ["primary", "operation", "requestedEntityTypes", "allowContextFallback"],
      "properties": {
        "primary": { "type": "string" },
        "operation": { "type": "string" },
        "requestedEntityTypes": { "type": "array", "items": { "type": "string" } },
        "allowContextFallback": { "type": "boolean" },
        "radius": { "type": "integer" }
      }
    }
  }
}
```

### Intent taxonomy

- `relationship-analysis`: explain how an explicit entity relates to current graph anchors
- `path-search`: shortest-path or connection-finding queries
- `entity-search`: find genes, proteins, drugs, or pathways linked to a resolved anchor
- `drug-search`: approved or relevant drug lookup
- `pathway-search`: pathway-oriented lookup
- `guideline-search`: clinical guideline retrieval
- `graph-expansion`: expand or redraw the visible graph
- `neighborhood`: bounded local neighborhood retrieval
- `comparison`: compare entities when explicitly named
- `guarded-cypher`: execute validated read-only Cypher

### Entity resolution workflow

1. Extract only explicit mentions from the latest user text.
2. Extract explicit concepts separately when the query is broad, such as `cancer` or `neurodegeneration`.
3. Resolve mentions against OptimusKG search over names, aliases, synonyms, descriptions, and identifiers.
4. Use concept resolution only when no explicit entity mentions were resolved.
5. Use selected nodes or prior graph state only as planning context, never as extracted entities.
6. If nothing resolves, return a graph-grounded partial answer instead of inventing entities.

### Fallback handling for concept-only queries

- `cancer genes`: no entity mention, concept is `cancer`, intent requests `Gene`
- `approved drugs for Alzheimer's`: entity mention is `Alzheimer's`, intent requests `Drug`
- `genes involved in neurodegeneration`: no entity mention, concept is `neurodegeneration`, intent requests `Gene`

For concept-only queries, the system attempts KG-backed concept resolution. If the graph does not contain a usable anchor, the response must say that explicitly instead of fabricating one.

### Biomedical KG examples

- `How does MAPT gene come into the picture?`
  Mention: `MAPT`
  Intent: `relationship-analysis`
  Context: prior resolved disease or selected graph anchor may be used only in planning

- `approved drugs for Alzheimer's`
  Mention: `Alzheimer's`
  Intent: `drug-search`

- `genes involved in neurodegeneration`
  Mention: none
  Concept: `neurodegeneration`
  Intent: `entity-search`

- `show the network including these genes also`
  Mention: none
  Intent: `graph-expansion`
  Context fallback allowed from current graph state
