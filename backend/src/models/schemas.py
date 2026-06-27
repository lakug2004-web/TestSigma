"""Pydantic models shared across the service.

These define the request contract and the "T-format" tree
(repo -> file -> class -> function) that is returned to the frontend.
The same shape is mirrored in the frontend's `lib/analyze.ts`.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    """Payload from the Next.js proxy to start an analysis.

    `token` is a GitHub OAuth access token with `repo` scope. It is used only
    in-memory to fetch the tarball and is never persisted on the job.
    """

    full_name: str = Field(..., description="owner/repo")
    owner: str
    repo: str
    ref: str = Field(default="", description="branch/tag/sha; empty = default branch")
    token: str = Field(..., repr=False)


class FunctionInfo(BaseModel):
    name: str
    args: list[str] = []
    lineno: int = 0
    end_lineno: int = 0
    is_async: bool = False
    decorators: list[str] = []
    description: str = ""


class ClassInfo(BaseModel):
    name: str
    lineno: int = 0
    end_lineno: int = 0
    bases: list[str] = []
    decorators: list[str] = []
    methods: list[FunctionInfo] = []
    description: str = ""


class FileInfo(BaseModel):
    path: str
    language: str = "python"
    loc: int = 0
    parsed: bool = True
    parse_error: str | None = None
    functions: list[FunctionInfo] = []
    classes: list[ClassInfo] = []
    description: str = ""


class RepoTree(BaseModel):
    """The full T-format result returned to the frontend."""

    full_name: str
    ref: str = ""
    summary: str = ""
    file_count: int = 0
    python_file_count: int = 0
    files: list[FileInfo] = []


class JobState(str, Enum):
    pending = "pending"
    running = "running"
    done = "done"
    error = "error"


class JobStatus(BaseModel):
    job_id: str
    state: JobState = JobState.pending
    progress: float = 0.0  # 0..1
    message: str = ""
    error: str | None = None
    result: RepoTree | None = None


class JobCreated(BaseModel):
    job_id: str
    state: JobState
