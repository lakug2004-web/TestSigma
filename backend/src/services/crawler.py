"""Crawler (UI / "what was built" layer) — powered by the browser-use cloud SDK.

We do NOT drive a browser ourselves. For each route the user supplies, we hand
browser-use one task: navigate to the page (logging in first for authenticated
routes), and return a structured summary of the screen — title, label, purpose,
primary actions, key components, and the links it contains. browser-use does the
browsing, screenshotting, and summarizing.

We keep two small deterministic pieces:
  * the screen-relationship graph, inferred from the links browser-use returns
    (an edge A->B when a link on A points at another captured route B);
  * persisting the screenshot — browser-use screenshot URLs are presigned and
    expire in ~5 min, so we download the final screenshot and re-store it via
    `store_screenshot` (Supabase Storage, or a data: URI fallback).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urldefrag, urljoin, urlparse

import httpx
from pydantic import BaseModel

from src.config import get_settings
from src.models.schemas import (
    CrawlRequest,
    CrawlResult,
    InteractiveElement,
    RouteSpec,
    ScreenInfo,
    Transition,
)
from src.services.storage import store_screenshot

ProgressCb = Callable[[float, str], Awaitable[None]]

logger = logging.getLogger("crawler")


# --- structured output browser-use returns for one screen --------------------
class _BULink(BaseModel):
    text: str = ""
    href: str = ""


class _BUScreen(BaseModel):
    title: str = ""
    label: str = ""  # 3-6 word screen name
    purpose: str = ""  # one sentence
    primary_actions: list[str] = []
    key_components: list[str] = []
    links: list[_BULink] = []


def _norm_url(url: str) -> str:
    """Drop the fragment and a trailing slash so '/x' and '/x#a' dedupe."""
    clean, _frag = urldefrag(url)
    if clean.endswith("/") and len(urlparse(clean).path) > 1:
        clean = clean[:-1]
    return clean


def _screen_id(url: str, elements: list[InteractiveElement]) -> str:
    sig = "|".join(sorted(f"{e.kind}:{e.text}" for e in elements))
    raw = f"{_norm_url(url)}::{sig}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _task_prompt(url: str, route: RouteSpec, req: CrawlRequest) -> str:
    """Build the browser-use instruction for one route."""
    prefix = ""
    if route.authenticated and req.login is not None:
        prefix = (
            f"First log in at {req.login.login_url} using username "
            f"'{req.login.username}' and password '{req.login.password}'. Then "
        )
    return (
        f"{prefix}go to {url} and analyze ONLY that page (do not click into other "
        "pages). Return the page title, a 3-6 word label, a one-sentence purpose, "
        "the primary user actions, the key UI components, and every navigation "
        "link visible on the page with its visible text and href."
    )


class Crawler:
    def __init__(self, req: CrawlRequest, run_dir: Path):
        self.req = req
        self.run_dir = run_dir
        self.settings = get_settings()
        self.screens: dict[str, ScreenInfo] = {}
        self.transitions: list[Transition] = []

    async def run(self, progress: ProgressCb | None = None) -> CrawlResult:
        from browser_use_sdk.v3 import AsyncBrowserUse

        if not self.settings.browser_use_api_key:
            raise RuntimeError(
                "BROWSER_USE_API_KEY is not set — get a key at "
                "https://cloud.browser-use.com/settings?tab=api-keys"
            )

        client = AsyncBrowserUse(api_key=self.settings.browser_use_api_key)
        routes = self.req.routes or [RouteSpec(path="")]
        sem = asyncio.Semaphore(self.settings.crawl_browseruse_concurrency)
        done = 0

        async def one(route: RouteSpec) -> None:
            nonlocal done
            async with sem:
                screen = await self._crawl_route(client, route)
            done += 1
            if screen is not None:
                self.screens[screen.screen_id] = screen
            if progress:
                await progress(
                    min(0.9, 0.1 + 0.8 * done / len(routes)),
                    f"Captured {route.path or '/'} ({done}/{len(routes)})",
                )

        try:
            await asyncio.gather(*(one(r) for r in routes))
        finally:
            await client.close()

        self._build_relationships()

        result = CrawlResult(
            run_id=self.run_dir.name,
            base_url=self.req.base_url,
            artifact_dir=str(self.run_dir),
            screen_count=len(self.screens),
            screens=list(self.screens.values()),
            transitions=self.transitions,
        )
        (self.run_dir / "manifest.json").write_text(
            result.model_dump_json(indent=2), encoding="utf-8"
        )
        logger.info(
            "crawl %s done: %d screens, %d edges",
            self.run_dir.name,
            result.screen_count,
            len(result.transitions),
        )
        return result

    async def _crawl_route(self, client, route: RouteSpec) -> ScreenInfo | None:
        url = urljoin(self.req.base_url, route.path)
        task = _task_prompt(url, route, self.req)
        logger.info("crawl route START %s (auth=%s)", url, route.authenticated)
        try:
            res = await client.run(task, output_schema=_BUScreen)
        except Exception as exc:  # noqa: BLE001 - one route failing is non-fatal
            logger.warning("browser-use run failed %s: %s", url, exc)
            return None

        out: _BUScreen = res.output or _BUScreen()
        elements = [
            InteractiveElement(kind="link", text=(l.text or "")[:120], href=l.href)
            for l in out.links
            if (l.text or l.href)
        ]
        sid = _screen_id(url, elements)
        if sid in self.screens:
            return None

        screenshot_url = await self._store_shot(
            getattr(res, "screenshot_url", None), sid
        )
        logger.info("crawl route OK %s — %d links, label=%r", url, len(elements), out.label)
        return ScreenInfo(
            screen_id=sid,
            url=url,
            title=out.title,
            authenticated=route.authenticated,
            interactive_count=len(elements),
            screenshot_url=screenshot_url,
            elements=elements,
            label=out.label[:80],
            purpose=out.purpose,
            primary_actions=[a.strip() for a in out.primary_actions][:8],
            key_components=[c.strip() for c in out.key_components][:10],
        )

    async def _store_shot(self, presigned: str | None, sid: str) -> str:
        """Download browser-use's (presigned, expiring) screenshot and re-store."""
        if not presigned:
            return ""
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as c:
                r = await c.get(presigned)
            if r.status_code != 200:
                return ""
            ctype = r.headers.get("content-type", "image/png")
            ext = "png" if "png" in ctype else "jpg"
            return await store_screenshot(
                f"{self.run_dir.name}/{sid}.{ext}", r.content, ctype
            )
        except Exception as exc:  # noqa: BLE001 - screenshot is best-effort
            logger.warning("screenshot store failed %s: %s", sid, exc)
            return ""

    def _build_relationships(self) -> None:
        """Link captured screens: edge A->B when a link on A targets route B."""
        by_url: dict[str, str] = {
            _norm_url(s.url): s.screen_id for s in self.screens.values()
        }
        seen: set[tuple[str, str]] = set()
        for s in self.screens.values():
            for el in s.elements:
                if not el.href:
                    continue
                tgt = by_url.get(_norm_url(urljoin(s.url, el.href)))
                if not tgt or tgt == s.screen_id or (s.screen_id, tgt) in seen:
                    continue
                seen.add((s.screen_id, tgt))
                self.transitions.append(
                    Transition(
                        from_screen=s.screen_id,
                        to_screen=tgt,
                        action="link",
                        element_text=el.text,
                        selector=el.selector,
                    )
                )


async def crawl_app(req: CrawlRequest, progress: ProgressCb | None = None) -> CrawlResult:
    """Entry point used by the job runner: set up the run dir and crawl."""
    settings = get_settings()
    run_id = uuid.uuid4().hex[:12]
    run_dir = Path(settings.crawl_artifact_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    logger.info(
        "crawl %s START base=%s routes=%d (browser-use)",
        run_id,
        req.base_url,
        len(req.routes),
    )
    return await Crawler(req, run_dir).run(progress)
