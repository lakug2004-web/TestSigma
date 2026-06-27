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
    "You extract testable product requirements from product docs. "
    "For the given section, return ONLY a JSON object:\n"
    '{"requirements": [{"title": "...", "user_action": "...", '
    '"expected_outcome": "...", "priority": "high|medium|low"}]}\n'
    "A requirement must be observable in a UI (a user does X, system does Y). "
    "Skip prose that states no testable behavior; return an empty list then."
)


async def _extract_requirements(
    heading: str, body: str, llm
) -> list[Requirement]:
    if llm is None:
        # No key: the section heading itself becomes a coarse requirement.
        return [Requirement(req_id="", title=heading, source_anchor=heading)]
    prompt = f"Section heading: {heading}\n\nSection body:\n{body[:4000]}"
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
                    user_action=r.get("user_action", "").strip(),
                    expected_outcome=r.get("expected_outcome", "").strip(),
                    priority=r.get("priority", "medium").strip() or "medium",
                    source_anchor=heading,
                )
            )
        return out
    except Exception as exc:  # noqa: BLE001 - one bad section shouldn't kill ingest
        logger.warning("requirement extraction failed for %r: %s", heading, exc)
        return []


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
    )


async def ingest_doc(req: IngestRequest) -> IngestResult:
    raw = await _fetch_source(req)
    sections = _split_sections(raw)
    logger.info("ingest %s: %d sections", req.source, len(sections))

    llm = _build_llm()
    requirements: list[Requirement] = []
    for heading, body in sections:
        requirements.extend(await _extract_requirements(heading, body, llm))

    # Assign stable ids in document order.
    for i, r in enumerate(requirements, start=1):
        r.req_id = f"R{i}"

    return IngestResult(
        source=req.source,
        source_type=req.source_type,
        requirement_count=len(requirements),
        requirements=requirements,
        excerpt=raw[:1000],
    )
