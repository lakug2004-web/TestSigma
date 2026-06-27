"""HTTP API: start an analysis job and poll its status."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from src.models.schemas import AnalyzeRequest, JobCreated, JobStatus
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
        run_job(status.job_id, req.token, req.full_name, req.ref)
    )
    return JobCreated(job_id=status.job_id, state=status.state)


@router.get("/analyze/{job_id}", response_model=JobStatus)
async def get_status(job_id: str) -> JobStatus:
    status = store.get(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="job not found or expired")
    return status
