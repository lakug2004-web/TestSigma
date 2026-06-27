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
    # When True, the job also writes the described tree to the Neo4j knowledge
    # graph. False = AST + descriptions only (no Aura write).
    build_graph: bool = True


class FunctionInfo(BaseModel):
    name: str
    args: list[str] = []
    lineno: int = 0
    end_lineno: int = 0
    is_async: bool = False
    decorators: list[str] = []
    # Names of functions/methods this one calls (best-effort, by simple name).
    calls: list[str] = []
    description: str = ""


class ClassInfo(BaseModel):
    name: str
    lineno: int = 0
    end_lineno: int = 0
    bases: list[str] = []
    decorators: list[str] = []
    methods: list[FunctionInfo] = []
    description: str = ""


class ImportInfo(BaseModel):
    """One import statement, enough to resolve it to a repo file or library.

    `import a.b.c`        -> module="a.b.c", names=[],       level=0
    `from a.b import x,y`  -> module="a.b",   names=["x","y"], level=0
    `from .util import z`  -> module="util",  names=["z"],     level=1
    """

    module: str = ""
    names: list[str] = []
    level: int = 0


class FileInfo(BaseModel):
    path: str
    language: str = "python"
    loc: int = 0
    parsed: bool = True
    parse_error: str | None = None
    # Top-level module names this file imports (e.g. "os", "fastapi") — display.
    imports: list[str] = []
    # Structured imports used to resolve internal deps / used symbols.
    import_records: list[ImportInfo] = []
    functions: list[FunctionInfo] = []
    classes: list[ClassInfo] = []
    description: str = ""


class GraphQuery(BaseModel):
    """A named, ready-to-run Cypher query scoped to one repo."""

    name: str
    cypher: str


class GraphInfo(BaseModel):
    """Result of writing the repo's knowledge graph to Neo4j Aura."""

    console_url: str = ""
    instance_name: str = ""
    database: str = ""
    nodes_written: int = 0
    relationships_written: int = 0
    # A ready-to-run Cypher query the user can paste into the Aura console to
    # see the whole graph for this repo.
    sample_query: str = ""
    # The per-repo "connector": a label and a set of scoped queries that act as
    # this codebase's own dashboard inside the shared instance.
    connector_name: str = ""
    queries: list[GraphQuery] = []


class RepoTree(BaseModel):
    """The full T-format result returned to the frontend."""

    full_name: str
    ref: str = ""
    summary: str = ""
    file_count: int = 0
    python_file_count: int = 0
    files: list[FileInfo] = []
    # Populated by the Neo4j knowledge-graph step (None if Aura not configured).
    graph: GraphInfo | None = None


class GraphRequest(BaseModel):
    """Build the Neo4j graph from an already-analysed tree (no refetch/LLM)."""

    tree: RepoTree


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
