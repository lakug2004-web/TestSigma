"""Pydantic models shared across the service.

These define the request contract and the "T-format" tree
(repo -> file -> class -> function) that is returned to the frontend.
The same shape is mirrored in the frontend's `lib/analyze.ts`.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

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


# --- Crawl layer (UI / "what was built") -------------------------------------
class LoginConfig(BaseModel):
    """Selector-based login so the crawler can reach authenticated screens.

    Deterministic on purpose: the user supplies the login URL + field selectors
    and credentials. The crawler fills them once, saves the Playwright
    `storageState`, and reuses that session for every subsequent screen. No
    per-page auth guessing — see the design doc's confidence section.
    """

    login_url: str = Field(..., description="absolute URL of the login page")
    username: str = Field(..., repr=False)
    password: str = Field(..., repr=False)
    username_selector: str = Field(default="input[type=email], input[name=username]")
    password_selector: str = Field(default="input[type=password]")
    submit_selector: str = Field(default="button[type=submit]")
    # A path/substring that, when present in the URL, means "still logged out".
    logged_out_marker: str = Field(default="/login")


class RouteSpec(BaseModel):
    """One route the user wants captured, with its auth requirement.

    `authenticated=True` routes are visited in a logged-in browser context
    (the crawler logs in once via `LoginConfig` and reuses that session's
    cookies/headers); `False` routes are visited anonymously.
    """

    path: str = Field(..., description="relative path or absolute URL")
    authenticated: bool = False


class CrawlRequest(BaseModel):
    """Crawl an explicit list of routes of a live application.

    No autonomous discovery: the user supplies the exact routes, so the browser
    only navigates each one, captures it, and infers the screen-relationship
    graph from links between the captured routes.
    """

    base_url: str = Field(..., description="e.g. https://app.example.com")
    routes: list[RouteSpec] = Field(default_factory=list)
    login: LoginConfig | None = None


class InteractiveElement(BaseModel):
    kind: str = ""  # link | button | input | select | form
    role: str = ""
    text: str = ""
    selector: str = ""
    href: str = ""


class ScreenInfo(BaseModel):
    screen_id: str
    url: str
    title: str = ""
    depth: int = 0
    discovered_from: str | None = None
    authenticated: bool = False
    interactive_count: int = 0
    # Relative paths under the run's artifact dir (local copy).
    dom_path: str = ""
    screenshot_path: str = ""
    a11y_path: str = ""
    # Public URL of the screenshot in Supabase Storage (or a data: URI fallback
    # when storage isn't configured, so the frontend can still render it).
    screenshot_url: str = ""
    # Full captured artifacts inlined for persistence into Postgres.
    dom: str = ""
    a11y: str = ""
    elements: list[InteractiveElement] = []
    # Deterministically pruned semantic DOM tree (landmarks/headings/controls
    # only — no scripts/styles/wrappers). This is what we send the LLM, not raw
    # HTML. Each node: {tag, role?, name?, attrs?, children?}.
    structured_dom: list[Any] = []
    # LLM semantic read of the screen (skipped if no key). Derived from the
    # structured tree + the screen's relationships, not from raw DOM.
    label: str = ""
    purpose: str = ""
    primary_actions: list[str] = []
    key_components: list[str] = []


class Transition(BaseModel):
    from_screen: str
    to_screen: str
    action: str = "navigate"  # navigate | click
    element_text: str = ""
    selector: str = ""


class CrawlResult(BaseModel):
    run_id: str
    base_url: str
    artifact_dir: str = ""
    screen_count: int = 0
    screens: list[ScreenInfo] = []
    transitions: list[Transition] = []


# --- Ingest layer (Requirements / "what was intended") -----------------------
class IngestRequest(BaseModel):
    """Parse a public PRD/README/spec into structured requirements."""

    source_type: str = Field(
        default="url", description="url | text | github_readme | github_repo"
    )
    # For url: the doc URL. For text: the raw markdown. For github_readme/github_repo:
    # owner/repo (github_repo pulls every .md/.vdk file straight from the codebase).
    source: str
    token: str = Field(default="", repr=False, description="GitHub token if private")


class Requirement(BaseModel):
    req_id: str
    title: str
    # Deep, multi-sentence explanation of the requirement (LLM-generated).
    description: str = ""
    user_action: str = ""
    expected_outcome: str = ""
    # Kept for back-compat with the graph layer; no longer surfaced in the UI.
    priority: str = ""
    source_anchor: str = Field(default="", description="heading/section it came from")


class IngestResult(BaseModel):
    source: str
    source_type: str = ""
    requirement_count: int = 0
    requirements: list[Requirement] = []
    # Deep, multi-paragraph LLM description of the whole codebase / product,
    # synthesised from every ingested doc — what it does, its features, modules,
    # data model and user flows.
    overview: str = ""
    excerpt: str = ""
    # Repo-relative paths of the doc files ingested (github_repo source only).
    files: list[str] = []


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
    # Crawl / ingest jobs surface their output here (only one is set per job).
    crawl_result: CrawlResult | None = None
    ingest_result: IngestResult | None = None


class JobCreated(BaseModel):
    job_id: str
    state: JobState


class ReasonRequest(BaseModel):
    """Payload the frontend webhook forwards to start a PR review.

    `installation_id` is informational; the backend mints its own installation
    token from `full_name` so it never trusts a client-supplied token.

    The backend holds no database, so the frontend supplies the repo context it
    persists — the cached AST `tree`, the browser-use `crawl`, and the ingested
    `requirements`. Any layer may be omitted; the reviewer degrades gracefully
    (e.g. analysing the PR head live when `tree` is absent).
    """

    full_name: str = Field(..., description="owner/repo")
    pr_number: int
    installation_id: int | None = None
    tree: dict[str, Any] | None = None
    crawl: dict[str, Any] | None = None
    requirements: list[dict[str, Any]] = Field(default_factory=list)


class GraphConnectRequest(BaseModel):
    """Connect the three knowledge-graph layers for a repo in Neo4j.

    The frontend supplies the context (from its own store) the backend used to
    read from Postgres: the cached AST `tree`, the browser-use `crawl`, and the
    ingested `requirements`.
    """

    full_name: str = Field(..., description="owner/repo")
    tree: dict[str, Any] | None = None
    crawl: dict[str, Any] | None = None
    requirements: list[dict[str, Any]] = Field(default_factory=list)
