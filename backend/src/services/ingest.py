"""Ingest layer (Requirements / "what was intended").

Fetches a public PRD / README / spec and parses it into structured
`Requirement` records the graph can later join against the UI and Code layers.

Split of labor, on purpose:
  * deterministic — fetching the doc and splitting it into heading-scoped
    sections (cheap, reliable, no model needed);
  * LLM — turning prose under each heading into testable requirements
    (user_action + expected_outcome), which is genuinely a judgment task.

If no OpenRouter key is set, ingest still returns the section structure as
coarse requirements so the pipeline stays runnable without LLM cost.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from src.config import get_settings
from src.models.schemas import IngestRequest, IngestResult, Requirement
from src.services.describer import _extract_json  # reuse the tolerant JSON parser

logger = logging.getLogger("ingest")

GH_API = "https://api.github.com"


async def _fetch_source(req: IngestRequest) -> str:
    """Return raw markdown/text for the requested source."""
    if req.source_type == "text":
        return req.source
    if req.source_type == "github_readme":
        # `source` is "owner/repo"; ask the API for the rendered README.
        headers = {
            "Accept": "application/vnd.github.raw+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "pullguard-ingest",
        }
        if req.token:
            headers["Authorization"] = f"Bearer {req.token}"
        url = f"{GH_API}/repos/{req.source}/readme"
        async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                raise RuntimeError(
                    f"README fetch failed ({resp.status_code}) for {req.source}"
                )
            return resp.text
    # default: plain URL
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        resp = await client.get(req.source, headers={"User-Agent": "pullguard-ingest"})
        if resp.status_code != 200:
            raise RuntimeError(f"doc fetch failed ({resp.status_code}) for {req.source}")
        return resp.text


_HEADING = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)


def _split_sections(md: str) -> list[tuple[str, str]]:
    """Deterministic split into (heading, body) pairs by markdown heading."""
    matches = list(_HEADING.finditer(md))
    if not matches:
        return [("Document", md.strip())]
    sections: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        heading = m.group(2).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(md)
        body = md[start:end].strip()
        if body:
            sections.append((heading, body))
    return sections


_SYSTEM = (
    "You turn product documentation into a clear list of product requirements. "
    "Your reader is a non-technical product person or QA lead: they understand the "
    "product and how people use it, but NOT code. For the given section, return "
    "ONLY a JSON object:\n"
    '{"requirements": [{"title": "...", "description": "...", '
    '"user_action": "...", "expected_outcome": "..."}]}\n'
    "Rules:\n"
    "- A requirement must be something a user can see or do (the user does X, the "
    "product responds with Y).\n"
    "- `description` is the most important field: write 2-3 full paragraphs of plain, "
    "everyday English (flowing prose, NOT one sentence, NOT bullet points) that "
    "anyone could understand without a technical background. Explain what this lets "
    "the user do and why it matters to them; walk through how they would use it step "
    "by step; describe what they would expect to see; and call out the tricky "
    "situations or mistakes a person might hit and what should happen then. Talk "
    "about the product and the people using it — NOT code, files, functions, "
    "databases, APIs, or other engineering jargon. If a technical term is "
    "unavoidable, explain it in simple words. Aim for at least 80 words.\n"
    "- `user_action` and `expected_outcome` are one plain sentence each (the headline "
    "When/Then), written for a non-engineer.\n"
    "- Do NOT output a priority field.\n"
    "Skip prose that describes no user-facing behaviour; return an empty list then."
)


async def _extract_requirements(
    heading: str, body: str, llm
) -> list[Requirement]:
    if llm is None:
        # No key: the section heading itself becomes a coarse requirement.
        return [Requirement(req_id="", title=heading, source_anchor=heading)]
    prompt = f"Section heading: {heading}\n\nSection body:\n{body[:8000]}"
    try:
        resp = await llm.ainvoke([("system", _SYSTEM), ("human", prompt)])
        content = resp.content if isinstance(resp.content, str) else str(resp.content)
        data = _extract_json(content)
        out: list[Requirement] = []
        for r in data.get("requirements", []):
            out.append(
                Requirement(
                    req_id="",
                    title=r.get("title", "").strip() or heading,
                    description=r.get("description", "").strip(),
                    user_action=r.get("user_action", "").strip(),
                    expected_outcome=r.get("expected_outcome", "").strip(),
                    source_anchor=heading,
                )
            )
        return out
    except Exception as exc:  # noqa: BLE001 - one bad section shouldn't kill ingest
        logger.warning("requirement extraction failed for %r: %s", heading, exc)
        return []


_OVERVIEW_SYSTEM = (
    "You write a clear, friendly overview of a product for a non-technical reader — "
    "someone like a QA lead or product manager who understands the product and its "
    "users but does NOT read code. Given the project's documentation, write a "
    "thorough, easy-to-read description in plain English (use short markdown "
    "paragraphs and bullet lists). Cover, in depth: what the product is and the "
    "real-world problem it solves; who uses it and what they can do with it; the main "
    "features explained in everyday terms; and the typical things a person does with "
    "it from start to finish (the main user journeys). Avoid engineering jargon — do "
    "not talk about code, files, functions, databases, frameworks or APIs; if a "
    "technical term is unavoidable, explain it in simple words. Be specific and "
    "concrete using the product's real feature names from the docs. Output markdown only."
)


async def _generate_overview(raw: str, files: list[str], llm) -> str:
    """One deep LLM pass over all docs → a multi-paragraph codebase description."""
    if llm is None:
        return ""
    file_list = ("\nDoc files ingested: " + ", ".join(files)) if files else ""
    prompt = f"Project documentation:{file_list}\n\n{raw[:16000]}"
    try:
        resp = await llm.ainvoke(
            [("system", _OVERVIEW_SYSTEM), ("human", prompt)]
        )
        return resp.content if isinstance(resp.content, str) else str(resp.content)
    except Exception as exc:  # noqa: BLE001 - overview is best-effort
        logger.warning("overview generation failed: %s", exc)
        return ""


def _build_llm():
    settings = get_settings()
    if not settings.openrouter_api_key:
        logger.warning("OPENROUTER_API_KEY not set — ingest returns section headings only.")
        return None
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        base_url=settings.openrouter_base_url,
        api_key=settings.openrouter_api_key,
        model=settings.openrouter_model,
        temperature=0.1,
        max_retries=2,
        # Allow long, in-depth descriptions / overview rather than terse output.
        max_tokens=3000,
    )


async def _fetch_repo_docs(req: IngestRequest) -> tuple[str, list[str]]:
    """Pull every .md/.vdk file out of the repo tarball and stitch them into one
    markdown doc (each file becomes a top-level `# <path>` section). Returns the
    combined markdown and the sorted list of file paths that were ingested."""
    from src.services.github_fetch import download_doc_files

    docs = await download_doc_files(req.token, req.source, "", (".md", ".vdk"))
    files = sorted(docs.keys())
    if not files:
        raise RuntimeError(f"No .md/.vdk files found in {req.source}")
    parts = [f"# {path}\n\n{docs[path]}" for path in files]
    return "\n\n".join(parts), files


async def ingest_doc(req: IngestRequest) -> IngestResult:
    files: list[str] = []
    if req.source_type == "github_repo":
        raw, files = await _fetch_repo_docs(req)
    else:
        raw = await _fetch_source(req)
    sections = _split_sections(raw)
    logger.info(
        "ingest %s: %d sections from %d file(s)", req.source, len(sections), len(files)
    )

    llm = _build_llm()
    requirements: list[Requirement] = []
    for heading, body in sections:
        requirements.extend(await _extract_requirements(heading, body, llm))

    # Assign stable ids in document order.
    for i, r in enumerate(requirements, start=1):
        r.req_id = f"R{i}"

    # Deep, whole-codebase description in one pass over all the docs.
    overview = await _generate_overview(raw, files, llm)

    return IngestResult(
        source=req.source,
        source_type=req.source_type,
        requirement_count=len(requirements),
        requirements=requirements,
        overview=overview,
        excerpt=raw[:1000],
        files=files,
    )
