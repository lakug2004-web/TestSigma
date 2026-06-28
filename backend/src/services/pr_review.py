"""Turn a PR + the whole-app context into a posted review verdict.

This is the piece that makes the app behave like CodeRabbit. It assembles every
signal the dashboard already produced for the repo — the AST + LLM descriptions,
the knowledge graph, and the browser-use crawl — supplied by the frontend on the
request, adds the live PR diff + linked issues from GitHub, and asks one Gemini
2.5 Flash call to judge the PR and describe its impact. The result is rendered as
Markdown and posted back onto the PR as its own section by the caller.

If the frontend supplies no cached AST, the reviewer falls back to fetching and
analysing the PR head on the fly so it still produces a verdict.
"""

from __future__ import annotations

import json
import logging

from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field, ValidationError

from src.config import get_settings
from src.models.schemas import RepoTree
from src.services.ast_parser import build_tree
from src.services.describer import _extract_json, describe_tree
from src.services.github_app import PRContext
from src.services.github_fetch import download_tarball

logger = logging.getLogger("pr_review")


class RepoContext:
    """The three reasoning layers for a repo, supplied by the frontend.

    The backend keeps no database; the frontend reads its own store and passes
    these in on the /reason request. Any may be None/empty and the reviewer
    degrades: missing `tree` -> live AST of the PR head, missing `crawl` /
    `requirements` -> that layer is simply absent from the prompt.
    """

    def __init__(
        self,
        tree: dict | None = None,
        crawl: dict | None = None,
        requirements: list[dict] | None = None,
    ):
        self.tree = tree  # RepoTree JSON (incl. .graph) -> Code + Graph layer
        self.crawl = crawl  # {base_url, screen_count, screens, edges} -> DOM/UI
        self.requirements = requirements or []  # [{req_id,...}] -> Requirements


class PRVerdict(BaseModel):
    verdict: str = Field(..., description="'approve' | 'request_changes' | 'comment'")
    summary: str = Field(..., description="2-3 plain-English sentences for a non-engineer")
    good_enough: bool = Field(..., description="is it mergeable as-is")
    risk: str = Field(default="low", description="low | medium | high")
    changes_made: list[str] = Field(default_factory=list, description="what the code change does")
    ui_at_risk: list[str] = Field(
        default_factory=list, description="UI elements/screens that could be affected"
    )
    flows_affected: list[str] = Field(
        default_factory=list, description="discovered user flows that could break"
    )
    requirements_at_risk: list[str] = Field(
        default_factory=list, description="requirements that may lose coverage"
    )
    issues_addressed: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


_SYSTEM = (
    "You are the reasoning layer of a testing-intelligence system. Given a real "
    "Pull Request and the three-layer knowledge built for this app — REQUIREMENTS "
    "(what the product intended, from the ingested spec), DOM/UI (what was built, "
    "from a browser crawl of the live app's screens and flows), and CODE (how it "
    "was built: files, functions, the knowledge graph of how they connect) — "
    "produce the BLAST RADIUS of the change.\n\n"
    "Reason across layers: trace the changed code to the screens that render it "
    "and the user flows through those screens, then to the requirements those "
    "flows satisfy. Call out coverage that goes at risk — including requirements "
    "that SHOULD be testable but map to no captured UI (absence). Write for a QA "
    "lead who knows the product but not the code: name screens, flows and "
    "requirements in plain language, not just file names. Be honest when a link "
    "is uncertain rather than inventing one.\n\n"
    "Respond with ONLY a JSON object of the form:\n"
    '{"verdict": "approve|request_changes|comment", "summary": "...", '
    '"good_enough": true, "risk": "low|medium|high", '
    '"changes_made": ["..."], "ui_at_risk": ["..."], "flows_affected": ["..."], '
    '"requirements_at_risk": ["..."], "issues_addressed": ["..."], '
    '"suggestions": ["..."]}'
)


def _build_reviewer_llm() -> ChatOpenAI | None:
    """Gemini 2.5 Flash (via OpenRouter) for the PR-reasoning step."""
    settings = get_settings()
    if not settings.openrouter_api_key:
        logger.warning("OPENROUTER_API_KEY not set — cannot run PR review")
        return None
    logger.info("Reviewer LLM ready: model=%s", settings.reviewer_model)
    return ChatOpenAI(
        base_url=settings.openrouter_base_url,
        api_key=settings.openrouter_api_key,
        model=settings.reviewer_model,
        temperature=0.2,
        max_retries=2,
        default_headers={
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "PullGuard PR Review",
        },
    )


def _tree_digest(tree: RepoTree, changed: list[str]) -> str:
    """Compact text map of the repo, emphasising the files the PR touches."""
    changed_set = set(changed)
    lines: list[str] = [f"Repo: {tree.full_name} — {tree.summary}"]
    for bucket, only_changed in (("CHANGED FILES", True), ("OTHER FILES", False)):
        lines.append(f"\n## {bucket}")
        for f in tree.files:
            if (f.path in changed_set) != only_changed:
                continue
            if only_changed:
                lines.append(f"\n### {f.path} — {f.description}")
                if f.imports:
                    lines.append(f"  imports: {', '.join(f.imports[:20])}")
                for fn in f.functions:
                    calls = f" -> calls {', '.join(fn.calls)}" if fn.calls else ""
                    lines.append(f"  - fn {fn.name}({', '.join(fn.args)}): {fn.description}{calls}")
                for c in f.classes:
                    lines.append(f"  - class {c.name}: {c.description}")
                    for m in c.methods:
                        lines.append(f"      - {c.name}.{m.name}: {m.description}")
            else:
                lines.append(f"- {f.path}: {f.description}")
    return "\n".join(lines)


def _graph_block(tree: RepoTree) -> str:
    g = tree.graph
    if not g:
        return "(no knowledge graph built for this repo)"
    out = [f"Knowledge graph: {g.nodes_written} nodes, {g.relationships_written} relationships."]
    if g.console_url:
        out.append(f"Console: {g.console_url}")
    for q in g.queries[:6]:
        out.append(f"- {q.name}: {q.cypher}")
    return "\n".join(out)


def _crawl_block(crawl: dict | None) -> str:
    if not crawl:
        return "(no browser-use crawl on record for this app)"
    lines = [f"Live app crawl of {crawl['base_url']} — {crawl['screen_count']} screens:"]
    for s in crawl["screens"][:40]:
        auth = "🔒" if s.get("authenticated") else ""
        lines.append(
            f"- {auth}{s.get('label') or s.get('title') or s['url']} "
            f"({s['url']}, {s.get('interactiveCount', 0)} controls)"
        )
    edges = crawl.get("edges") or []
    if edges:
        lines.append(f"Screen transitions: {len(edges)} edges")
    return "\n".join(lines)


def _requirements_block(requirements: list[dict]) -> str:
    if not requirements:
        return "(no ingested product spec on record — requirements layer unavailable)"
    lines = [f"{len(requirements)} requirements from the ingested spec:"]
    for r in requirements[:40]:
        rid = r.get("req_id", "?")
        title = r.get("title", "")
        action = r.get("user_action", "")
        outcome = r.get("expected_outcome", "")
        prio = r.get("priority", "")
        lines.append(f"- [{rid}] ({prio}) {title}")
        if action or outcome:
            lines.append(f"    user: {action} -> expect: {outcome}")
    return "\n".join(lines)


def _issues_block(pr: PRContext) -> str:
    if not pr.issues:
        return "(no linked issues found in the PR body)"
    return "\n".join(
        f"- #{i['number']} {i['title']}\n  {(i['body'] or '')[:600]}" for i in pr.issues
    )


async def _resolve_tree(token: str, pr: PRContext, ctx: RepoContext) -> RepoTree | None:
    """Prefer the dashboard's cached tree; else analyse the PR head live."""
    if ctx.tree:
        try:
            return RepoTree.model_validate(ctx.tree)
        except ValidationError as exc:
            logger.warning("cached tree invalid, will re-analyse: %s", exc)
    try:
        fetched = await download_tarball(token, pr.full_name, pr.head_sha)
        tree = build_tree(pr.full_name, pr.head_sha, fetched.sources, fetched.total_file_count)
        return await describe_tree(tree, fetched.sources)
    except Exception as exc:  # noqa: BLE001 - reviewer still works off the diff
        logger.warning("live AST context unavailable: %s", exc)
        return None


async def review_pr(token: str, pr: PRContext, ctx: RepoContext) -> tuple[PRVerdict, RepoTree | None]:
    """Reason over PR diff + cached AST/graph/crawl context. Returns (verdict, tree)."""
    llm = _build_reviewer_llm()
    if llm is None:
        raise RuntimeError("OPENROUTER_API_KEY not configured — cannot review PR")

    tree = await _resolve_tree(token, pr, ctx)
    settings = get_settings()
    diff = pr.diff[: settings.max_file_bytes]  # bound token cost

    human = (
        f"PR #{pr.number}: {pr.title}\n"
        f"base: {pr.base_ref}  head: {pr.head_ref} @ {pr.head_sha[:7]}\n\n"
        f"PR description:\n{pr.body or '(empty)'}\n\n"
        f"Linked issues:\n{_issues_block(pr)}\n\n"
        f"Changed files: {', '.join(pr.changed_files) or '(none reported)'}\n\n"
        f"=== REQUIREMENTS layer (intended) ===\n{_requirements_block(ctx.requirements)}\n\n"
        f"=== DOM/UI layer (built) ===\n{_crawl_block(ctx.crawl)}\n\n"
        f"=== CODE layer (how) ===\n"
        f"{_tree_digest(tree, pr.changed_files) if tree else '(AST unavailable)'}\n\n"
        f"{_graph_block(tree) if tree else ''}\n\n"
        f"Unified diff:\n```diff\n{diff}\n```"
    )

    resp = await llm.ainvoke([("system", _SYSTEM), ("human", human)])
    content = resp.content if isinstance(resp.content, str) else str(resp.content)
    try:
        verdict = PRVerdict.model_validate(_extract_json(content))
    except (ValidationError, json.JSONDecodeError, ValueError) as exc:
        logger.warning("reviewer returned unparseable output: %s | %r", exc, content[:400])
        verdict = PRVerdict(
            verdict="comment",
            summary="Automated blast-radius analysis could not be structured; raw notes below.",
            good_enough=False,
            risk="medium",
            suggestions=[content[:1500]],
        )
    return verdict, tree


_EMOJI = {"low": "🟢", "medium": "🟡", "high": "🔴"}
_VERDICT_LABEL = {
    "approve": "✅ Looks good to merge",
    "request_changes": "🛑 Changes requested",
    "comment": "💬 Review notes",
}

# Markers let us find and update our previous comment instead of stacking new ones.
MARK_BEGIN = "<!-- pullguard:begin -->"
MARK_END = "<!-- pullguard:end -->"


def render_comment(pr: PRContext, v: PRVerdict, ctx: RepoContext, graph_url: str | None) -> str:
    """Render the verdict as the Markdown body posted onto the PR (own section)."""

    def bullets(items: list[str]) -> str:
        return "\n".join(f"- {x}" for x in items) if items else "_none_"

    # Show which of the three layers actually informed this report (honesty about
    # coverage — a missing layer is stated, not hidden).
    layers = []
    layers.append("✅ Requirements" if ctx.requirements else "⚪ Requirements (none ingested)")
    layers.append(
        f"✅ DOM/UI ({ctx.crawl['screen_count']} screens)" if ctx.crawl else "⚪ DOM/UI (no crawl)"
    )
    layers.append("✅ Code + graph" if ctx.tree else "⚪ Code (live AST only)")

    parts = [
        MARK_BEGIN,
        "## 🛡️ Blast-radius report",
        f"**{_VERDICT_LABEL.get(v.verdict, v.verdict)}** · "
        f"good enough: **{'yes' if v.good_enough else 'no'}** · "
        f"risk: {_EMOJI.get(v.risk, '')} **{v.risk}**",
        "",
        v.summary,
        "",
        "### 🎯 UI elements at risk",
        bullets(v.ui_at_risk),
        "",
        "### 🔀 User flows affected",
        bullets(v.flows_affected),
        "",
        "### 📋 Requirements losing coverage",
        bullets(v.requirements_at_risk),
        "",
        "### 🔧 What the code change does",
        bullets(v.changes_made),
        "",
        "### Issues addressed",
        bullets(v.issues_addressed),
        "",
        "### Suggestions",
        bullets(v.suggestions),
    ]
    if graph_url:
        parts += ["", f"🔗 [Knowledge graph for this repo]({graph_url})"]
    parts += [
        "",
        f"<sub>Layers used: {' · '.join(layers)} — reasoned by Gemini 2.5 Flash.</sub>",
        MARK_END,
    ]
    return "\n".join(parts)
