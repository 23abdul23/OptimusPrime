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

- Frontend: `http://localhost:3000`
- GraphQL API: `http://localhost:4000/graphql`
- Neo4j Browser: `http://localhost:17474`

Bolt runs on `bolt://localhost:17687` by default.
The Neo4j credentials are `neo4j` / `optimus-password`, and the database name is `optimusKG`.

### Local Development

```bash
pnpm install
pnpm --filter @optimus/backend generate-schema
pnpm dev
```

For the full local workflow you will usually also want Optimus Neo4j and Redis running through Docker:

```bash
docker compose up optimus-neo4j redis
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
