"""HTTP API: start an analysis job and poll its status."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging

from fastapi import APIRouter, HTTPException, Request

from src.config import get_settings
from src.models.schemas import (
    AnalyzeRequest,
    CrawlRequest,
    GraphConnectRequest,
    GraphInfo,
    GraphRequest,
    IngestRequest,
    JobCreated,
    JobStatus,
    ReasonRequest,
)
from src.services.graph import build_knowledge_graph
from src.services.jobs import (
    run_crawl_job,
    run_ingest_job,
    run_job,
    run_reason_job,
    store,
)
from src.services.pr_review import RepoContext

logger = logging.getLogger("routes")

router = APIRouter()


def _verify_signature(secret: str, body: bytes, header: str | None) -> bool:
    """Constant-time check of GitHub's X-Hub-Signature-256 over the raw body."""
    if not header or not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/analyze", response_model=JobCreated)
async def analyze(req: AnalyzeRequest) -> JobCreated:
    if not req.token:
        raise HTTPException(status_code=400, detail="missing token")
    status = store.create()
    # Fire-and-forget; progress is tracked on the JobStatus in the store.
    asyncio.create_task(
        run_job(
            status.job_id, req.token, req.full_name, req.ref, req.build_graph
        )
    )
    return JobCreated(job_id=status.job_id, state=status.state)


@router.post("/graph", response_model=GraphInfo)
async def graph(req: GraphRequest) -> GraphInfo:
    """Build the Neo4j knowledge graph from an already-analysed tree.

    Lets the frontend turn a cached/just-built AST into a graph without
    re-fetching the repo or re-running the LLM. Returns the Aura console URL.
    """
    result = await build_knowledge_graph(req.tree)
    if result is None:
        raise HTTPException(
            status_code=503,
            detail="Neo4j is not configured (set NEO4J_URI).",
        )
    return result


@router.post("/graph/connect")
async def graph_connect(req: GraphConnectRequest) -> dict:
    """Connect the three knowledge-graph layers for a repo in Neo4j.

    Takes the repo's cached AST (code), crawl (DOM/UI) and ingested requirements
    supplied by the frontend, then writes the Requirement + Screen nodes and the
    cross-layer edges (COVERED_BY / IMPLEMENTED_BY) plus absence
    (MISSING_UI_COVERAGE) onto the existing per-repo code subgraph. Returns a
    coverage summary.
    """
    from src.services.graph_layers import connect_layers

    file_paths = [f.get("path", "") for f in (req.tree or {}).get("files", [])]
    return await connect_layers(req.full_name, req.requirements, req.crawl, file_paths)


@router.post("/crawl", response_model=JobCreated)
async def crawl(req: CrawlRequest) -> JobCreated:
    """Start a hybrid browser crawl of a live application.

    Poll GET /analyze/{job_id}; the result lands on `crawl_result`.
    """
    if not req.base_url:
        raise HTTPException(status_code=400, detail="missing base_url")
    status = store.create()
    asyncio.create_task(run_crawl_job(status.job_id, req))
    return JobCreated(job_id=status.job_id, state=status.state)


@router.post("/ingest", response_model=JobCreated)
async def ingest(req: IngestRequest) -> JobCreated:
    """Parse a PRD/README/spec into structured requirements.

    Poll GET /analyze/{job_id}; the result lands on `ingest_result`.
    """
    if not req.source:
        raise HTTPException(status_code=400, detail="missing source")
    status = store.create()
    asyncio.create_task(run_ingest_job(status.job_id, req))
    return JobCreated(job_id=status.job_id, state=status.state)


@router.post("/reason", status_code=202)
async def reason(req: ReasonRequest) -> dict[str, str]:
    """Review a PR (called by the frontend webhook after it verifies the HMAC).

    Takes the repo's AST + knowledge graph + browser-use crawl supplied by the
    frontend (which owns persistence), adds the live PR diff + issues, runs the
    Gemini reviewer, and posts a single PullGuard section onto the PR. Returns
    202 immediately; the work is detached.
    """
    ctx = RepoContext(req.tree, req.crawl, req.requirements)
    asyncio.create_task(run_reason_job(req.full_name, req.pr_number, ctx))
    return {"status": "accepted", "repo": req.full_name, "pr": str(req.pr_number)}


@router.post("/webhook/github", status_code=202)
async def github_webhook(request: Request) -> dict[str, str]:
    """Direct GitHub webhook entry (alternative to the frontend forwarder).

    Verifies the HMAC signature itself, then fires the same review job as
    /reason for `opened`/`reopened`/`synchronize` pull_request events.
    """
    settings = get_settings()
    if not settings.github_webhook_secret:
        raise HTTPException(status_code=503, detail="webhook not configured")

    raw = await request.body()
    if not _verify_signature(
        settings.github_webhook_secret, raw, request.headers.get("X-Hub-Signature-256")
    ):
        raise HTTPException(status_code=401, detail="invalid signature")

    event = request.headers.get("X-GitHub-Event", "")
    if event == "ping":
        return {"status": "pong"}
    if event != "pull_request":
        return {"status": "ignored", "event": event}

    import json

    payload = json.loads(raw)
    action = payload.get("action", "")
    if action not in {"opened", "reopened", "synchronize", "ready_for_review"}:
        return {"status": "ignored", "action": action}

    full_name = payload["repository"]["full_name"]
    number = payload["pull_request"]["number"]
    logger.info("webhook: pull_request.%s %s#%d", action, full_name, number)
    # Direct webhook carries no cached context (the frontend isn't in the loop
    # here); the reviewer degrades to a live AST of the PR head.
    asyncio.create_task(run_reason_job(full_name, number, RepoContext()))
    return {"status": "accepted", "repo": full_name, "pr": str(number)}


@router.get("/analyze/{job_id}", response_model=JobStatus)
async def get_status(job_id: str) -> JobStatus:
    status = store.get(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="job not found or expired")
    return status
