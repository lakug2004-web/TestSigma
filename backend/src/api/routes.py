"""HTTP API: start an analysis job and poll its status."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from src.models.schemas import (
    AnalyzeRequest,
    GraphInfo,
    GraphRequest,
    JobCreated,
    JobStatus,
)
from src.services.graph import build_knowledge_graph
from src.services.jobs import run_job, store

router = APIRouter()


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


@router.get("/analyze/{job_id}", response_model=JobStatus)
async def get_status(job_id: str) -> JobStatus:
    status = store.get(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="job not found or expired")
    return status
