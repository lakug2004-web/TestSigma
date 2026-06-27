# PullGuard AST Service

FastAPI backend that, given a GitHub repo and an OAuth token, downloads the repo
tarball, parses every Python file into an AST, flattens it into a T-format tree
(repo → file → class → function), and uses LangChain + LangGraph over OpenRouter
to describe each file, class, and function. Results are returned as JSON.

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

The GitHub token is **never** read from env — it arrives per-request and is held
in memory only for the tarball fetch.

## Run

```bash
uv sync
uv run uvicorn src.main:app --reload --port 8000
```

## API

- `POST /analyze` `{ full_name, owner, repo, ref?, token }` → `{ job_id, state }`
- `GET /analyze/{job_id}` → `JobStatus` (`result` is the `RepoTree` when `state == "done"`)
- `GET /health` → `{ status: "ok" }`
