"""In-memory job store + the async pipeline runner.

A job goes: pending -> running (fetch -> parse -> describe) -> done | error.
The frontend polls GET /analyze/{job_id} until the result is ready.

The GitHub token is passed into `run_job` and used only locally; it is never
written onto the JobStatus.

Note: single-process, in-memory only. Fine for this scope; swap for Redis if
the service is scaled horizontally.
"""

from __future__ import annotations

import logging
import time
import uuid

from src.config import get_settings
from src.models.schemas import (
    CrawlRequest,
    IngestRequest,
    JobState,
    JobStatus,
)
from src.services.ast_parser import build_tree
from src.services.crawler import crawl_app
from src.services.describer import describe_tree
from src.services.github_fetch import download_tarball
from src.services.github_app import fetch_pr_context, installation_token, upsert_pr_comment
from src.services.graph import build_knowledge_graph
from src.services.ingest import ingest_doc
from src.services.pr_review import MARK_BEGIN, RepoContext, render_comment, review_pr

logger = logging.getLogger("jobs")


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, JobStatus] = {}
        self._created: dict[str, float] = {}

    def create(self) -> JobStatus:
        job_id = uuid.uuid4().hex
        status = JobStatus(job_id=job_id, state=JobState.pending, message="queued")
        self._jobs[job_id] = status
        self._created[job_id] = time.time()
        self._evict_expired()
        return status

    def get(self, job_id: str) -> JobStatus | None:
        return self._jobs.get(job_id)

    def _evict_expired(self) -> None:
        ttl = get_settings().job_ttl_seconds
        now = time.time()
        stale = [j for j, t in self._created.items() if now - t > ttl]
        for j in stale:
            self._jobs.pop(j, None)
            self._created.pop(j, None)


store = JobStore()


async def run_job(
    job_id: str,
    token: str,
    full_name: str,
    ref: str,
    build_graph: bool = True,
) -> None:
    status = store.get(job_id)
    if status is None:
        return

    async def progress(value: float, message: str) -> None:
        status.progress = round(min(max(value, 0.0), 1.0), 3)
        status.message = message

    try:
        logger.info("job %s START %s (ref=%r)", job_id, full_name, ref or "default")
        status.state = JobState.running
        await progress(0.05, "Fetching repository tarball")
        fetched = await download_tarball(token, full_name, ref)
        del token  # drop the token as soon as the fetch is done
        logger.info(
            "job %s fetched: %d total files, %d python files",
            job_id,
            fetched.total_file_count,
            len(fetched.sources),
        )

        await progress(0.35, "Parsing Python sources into AST")
        tree = build_tree(full_name, ref, fetched.sources, fetched.total_file_count)

        await progress(0.4, "Generating descriptions")
        tree = await describe_tree(tree, fetched.sources, progress)

        # Build the Neo4j Aura knowledge graph from the described tree (only when
        # requested). A graph failure must not discard the AST/descriptions we
        # already produced, so it is caught and surfaced as a warning instead.
        if build_graph:
            await progress(0.96, "Building Neo4j knowledge graph")
            try:
                tree.graph = await build_knowledge_graph(tree)
                if tree.graph:
                    logger.info(
                        "job %s graph ready: %d nodes at %s",
                        job_id,
                        tree.graph.nodes_written,
                        tree.graph.console_url,
                    )
            except Exception as exc:  # noqa: BLE001 - graph is best-effort
                logger.exception("job %s graph step failed: %s", job_id, exc)
                status.message = f"graph step failed: {exc}"

        status.result = tree
        status.state = JobState.done
        status.progress = 1.0
        if status.message.startswith("graph step failed"):
            pass  # keep the warning visible
        else:
            status.message = "complete"
        logger.info("job %s DONE — %s", job_id, tree.summary)
    except Exception as exc:  # noqa: BLE001
        logger.exception("job %s FAILED: %s", job_id, exc)
        status.state = JobState.error
        status.error = str(exc)
        status.message = "failed"


async def run_crawl_job(job_id: str, req: CrawlRequest) -> None:
    """Crawl a live app into persisted DOM/screenshot/a11y artifacts."""
    status = store.get(job_id)
    if status is None:
        return

    async def progress(value: float, message: str) -> None:
        status.progress = round(min(max(value, 0.0), 1.0), 3)
        status.message = message

    try:
        logger.info("crawl job %s START %s", job_id, req.base_url)
        status.state = JobState.running
        await progress(0.02, "Launching browser")
        result = await crawl_app(req, progress)
        status.crawl_result = result
        status.state = JobState.done
        status.progress = 1.0
        status.message = f"crawled {result.screen_count} screens"
        logger.info("crawl job %s DONE — %d screens", job_id, result.screen_count)
    except Exception as exc:  # noqa: BLE001
        logger.exception("crawl job %s FAILED: %s", job_id, exc)
        status.state = JobState.error
        status.error = str(exc)
        status.message = "failed"


async def run_reason_job(
    full_name: str, pr_number: int, ctx: RepoContext
) -> None:
    """Webhook-triggered: review one PR and post the verdict back onto it.

    Detached from the HTTP request. Mints an installation token, takes the
    repo's cached AST + knowledge graph + browser-use crawl supplied by the
    caller (the frontend, which owns persistence), adds the live PR diff +
    issues, runs the Gemini reviewer, and upserts a single PullGuard comment on
    the PR. Best-effort: failures are logged, not raised.
    """
    try:
        logger.info("reason START %s#%d", full_name, pr_number)
        token = await installation_token(full_name)
        pr = await fetch_pr_context(token, full_name, pr_number)
        verdict, tree = await review_pr(token, pr, ctx)
        graph_url = tree.graph.console_url if tree and tree.graph else None
        body = render_comment(pr, verdict, ctx, graph_url)
        url = await upsert_pr_comment(token, full_name, pr_number, body, MARK_BEGIN)
        logger.info(
            "reason DONE %s#%d — verdict=%s posted=%s",
            full_name,
            pr_number,
            verdict.verdict,
            url,
        )
    except Exception as exc:  # noqa: BLE001 - webhook path must never raise
        logger.exception("reason FAILED %s#%d: %s", full_name, pr_number, exc)


async def run_ingest_job(job_id: str, req: IngestRequest) -> None:
    """Parse a PRD/README into structured requirements."""
    status = store.get(job_id)
    if status is None:
        return

    try:
        logger.info("ingest job %s START %s (%s)", job_id, req.source, req.source_type)
        status.state = JobState.running
        status.progress = 0.1
        status.message = "Fetching and parsing document"
        result = await ingest_doc(req)
        status.ingest_result = result
        status.state = JobState.done
        status.progress = 1.0
        status.message = f"extracted {result.requirement_count} requirements"
        logger.info(
            "ingest job %s DONE — %d requirements", job_id, result.requirement_count
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("ingest job %s FAILED: %s", job_id, exc)
        status.state = JobState.error
        status.error = str(exc)
        status.message = "failed"
