# PullGuard AST Service

FastAPI backend that, given a GitHub repo and an OAuth token, downloads the repo
tarball, parses every Python file into an AST, flattens it into a T-format tree
(repo → file → class → function), and uses LangChain + LangGraph over OpenRouter
to describe each file, class, and function. It then mirrors the described tree
into a **Neo4j Aura knowledge graph** and returns the Aura console URL so the
graph can be browsed. Results are returned as JSON.

## Layout

```
src/
  main.py              FastAPI app + CORS
  config.py            Settings (env / .env)
  models/schemas.py    Pydantic request + RepoTree models
  core/tree.py         ast visitor -> Function/Class info
  services/
    github_fetch.py    download + extract repo tarball
    ast_parser.py      build RepoTree from sources
    describer.py       LangGraph + OpenRouter description pipeline
    graph.py           write the described tree into Neo4j Aura
    jobs.py            in-memory job store + pipeline runner
  api/routes.py        POST /analyze, GET /analyze/{job_id}, GET /health
```

## Environment

Create `.env` (or export):

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `OPENROUTER_API_KEY` | for descriptions | — | empty = AST only, no LLM calls |
| `OPENROUTER_MODEL` | no | `openai/gpt-4o-mini` | must be a live slug for your key — see https://openrouter.ai/models |
| `LOG_LEVEL` | no | `INFO` | set `DEBUG` to log raw LLM responses |
| `FRONTEND_ORIGIN` | no | `http://localhost:3000` | CORS allow-list |
| `MAX_PYTHON_FILES` | no | `200` | per-repo cap |
| `LLM_CONCURRENCY` | no | `5` | parallel describe calls |
| `NEO4J_URI` | for graph | — | empty = graph step skipped; e.g. `neo4j+s://xxxx.databases.neo4j.io` |
| `NEO4J_USERNAME` | for graph | — | Aura instance user |
| `NEO4J_PASSWORD` | for graph | — | Aura instance password |
| `NEO4J_DATABASE` | no | `neo4j` | Aura database name |
| `AURA_INSTANCENAME` | no | — | shown back in the result |
| `NEO4J_CONSOLE_URL` | no | `https://console.neo4j.io` | URL returned for browsing the graph |

The GitHub token is **never** read from env — it arrives per-request and is held
in memory only for the tarball fetch.

## Run

```bash
uv sync
uv run uvicorn src.main:app --reload --port 8000
```

## API

- `POST /analyze` `{ full_name, owner, repo, ref?, token, build_graph? }` → `{ job_id, state }` (`build_graph` default `true` — set `false` for AST/descriptions only, no Aura write)
- `POST /graph` `{ tree }` → `GraphInfo` — build the Neo4j graph from an already-analysed `RepoTree` (no refetch/LLM); returns the console URL
- `GET /analyze/{job_id}` → `JobStatus` (`result` is the `RepoTree` when `state == "done"`)
- `GET /health` → `{ status: "ok" }`

When `state == "done"`, `result.graph` holds the knowledge-graph result:

```json
{
  "console_url": "https://console.neo4j.io",
  "instance_name": "Free instance",
  "database": "neo4j",
  "nodes_written": 42,
  "relationships_written": 57,
  "sample_query": "MATCH (r:Repo {full_name: \"owner/repo\"})-[*1..3]->(n) RETURN r, n"
}
```

`result.graph` also carries `connector_name` (the repo) and `queries` — a set
of ready-to-run, repo-scoped Cypher queries (Overview, Call graph, Imports,
Inheritance, Decorators, Everything) that act as that codebase's dashboard.
Open `console_url`, sign in, pick the instance, open **Query**, and paste one.

The graph model:

```
structure  (:Repo)-[:CONTAINS]->(:File)-[:DEFINES]->(:Function|:Class)
           (:Class)-[:HAS_METHOD]->(:Function:Method)
deps       (:File)-[:DEPENDS_ON]->(:File)        # internal imports, resolved
           (:File)-[:IMPORTS]->(:Library)         # third-party / stdlib packages
           (:File)-[:USES]->(:Function|:Class)    # imported repo symbols
behaviour  (:Function)-[:CALLS]->(:Function)            # resolved in-repo
           (:Function)-[:INSTANTIATES]->(:Class)        # constructs a class
           (:Class)-[:INHERITS_FROM]->(:Class)
           (:Function|:Class)-[:DECORATED_BY]->(:Decorator)
```

Every node is **namespaced per repo**, so each codebase is its own isolated
subgraph (its own "connector") inside the shared Free-tier instance —
rebuilding one repo never touches another. Each structural node carries its LLM
`description`. The graph step is best-effort: if Aura is unreachable, the AST +
descriptions are still returned and the failure is reported in
`JobStatus.message`.
