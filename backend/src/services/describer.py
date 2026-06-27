"""LLM description pipeline built with LangChain + LangGraph over OpenRouter.

A LangGraph `StateGraph` orchestrates the flow: load -> describe_files -> assemble.
The describe node fans out one structured-output LLM call per file (each call
returns a description for the file plus every function/class in it), bounded by a
semaphore. Descriptions are written back onto the RepoTree in place.

If no OpenRouter key is configured, descriptions are left empty and the pipeline
still returns a valid tree (so the AST is usable without LLM cost).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Awaitable, Callable, TypedDict

from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field, ValidationError

from src.config import get_settings
from src.models.schemas import FileInfo, RepoTree

ProgressCb = Callable[[float, str], Awaitable[None]]

logger = logging.getLogger("describer")


# --- Structured output the LLM must return for a single file -----------------
class SymbolDescription(BaseModel):
    name: str = Field(..., description="function, class, or method name")
    kind: str = Field(default="", description="optional: function/class/method")
    description: str = Field(default="", description="one or two sentence summary")


class FileDescription(BaseModel):
    file_description: str = Field(..., description="what this file/module does")
    symbols: list[SymbolDescription] = []


class DescribeState(TypedDict):
    tree: RepoTree


_SYSTEM = (
    "You are a senior engineer documenting a Python codebase. "
    "Given a file's source, write a concise, accurate description of the file, "
    "and of each listed function, class, and method. Be specific about behavior; "
    "avoid filler. Keep each description to 1-2 sentences.\n\n"
    "Respond with ONLY a JSON object (no markdown, no prose) of the form:\n"
    '{"file_description": "...", '
    '"symbols": [{"name": "fn_or_class_or_method_name", "description": "..."}]}\n'
    "Use the exact symbol names provided. For methods use the name shown "
    "(e.g. ClassName.method)."
)


def _build_llm() -> ChatOpenAI | None:
    settings = get_settings()
    if not settings.openrouter_api_key:
        logger.warning(
            "OPENROUTER_API_KEY not set — descriptions will be skipped (AST only)."
        )
        return None
    logger.info(
        "LLM ready: model=%s base_url=%s key=***%s",
        settings.openrouter_model,
        settings.openrouter_base_url,
        settings.openrouter_api_key[-4:],
    )
    return ChatOpenAI(
        base_url=settings.openrouter_base_url,
        api_key=settings.openrouter_api_key,
        model=settings.openrouter_model,
        temperature=0.2,
        max_retries=2,
        # OpenRouter-recommended attribution headers.
        default_headers={
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "PullGuard AST",
        },
    )


def _file_prompt(file: FileInfo, source: str) -> str:
    symbols = [f"- function {f.name}({', '.join(f.args)})" for f in file.functions]
    for c in file.classes:
        symbols.append(f"- class {c.name}")
        symbols += [f"- method {c.name}.{m.name}" for m in c.methods]
    sym_block = "\n".join(symbols) or "(no top-level functions or classes)"
    # Bound the source we send to keep token cost predictable.
    snippet = source[:8000]
    return (
        f"File path: {file.path}\n\n"
        f"Symbols to describe:\n{sym_block}\n\n"
        f"Source:\n```python\n{snippet}\n```"
    )


def _extract_json(content: str) -> dict:
    """Pull a JSON object out of an LLM response that may be fenced or chatty."""
    text = content.strip()
    # strip ```json ... ``` fences if present
    fence = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    # else fall back to the outermost { ... }
    if not text.startswith("{"):
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1:
            text = text[start : end + 1]
    return json.loads(text)


def _apply_descriptions(file: FileInfo, result: FileDescription) -> None:
    file.description = result.file_description
    by_name = {s.name: s.description for s in result.symbols}
    for fn in file.functions:
        fn.description = by_name.get(fn.name, fn.description)
    for cls in file.classes:
        cls.description = by_name.get(cls.name, cls.description)
        for m in cls.methods:
            m.description = by_name.get(f"{cls.name}.{m.name}") or by_name.get(
                m.name, m.description
            )


async def _describe_one(
    llm: ChatOpenAI,
    file: FileInfo,
    source: str,
    sem: asyncio.Semaphore,
) -> None:
    async with sem:
        n_sym = len(file.functions) + sum(1 + len(c.methods) for c in file.classes)
        logger.info("LLM describe START %s (%d symbols)", file.path, n_sym)
        try:
            resp = await llm.ainvoke(
                [
                    ("system", _SYSTEM),
                    ("human", _file_prompt(file, source)),
                ]
            )
            content = resp.content if isinstance(resp.content, str) else str(resp.content)
            logger.debug("LLM raw response for %s:\n%s", file.path, content[:1500])
            result = FileDescription.model_validate(_extract_json(content))
            _apply_descriptions(file, result)
            logger.info(
                "LLM describe OK %s — file desc %d chars, %d symbols described",
                file.path,
                len(file.description),
                len(result.symbols),
            )
        except (ValidationError, json.JSONDecodeError, ValueError) as exc:
            # Model returned something unparseable — keep the file usable.
            logger.warning(
                "LLM parse FAILED %s: %s | raw=%r",
                file.path,
                exc,
                locals().get("content", "<no response>")[:500],
            )
            file.description = file.description or f"(could not parse description: {exc})"
        except Exception as exc:  # noqa: BLE001 - one bad file shouldn't kill the job
            logger.exception("LLM call FAILED %s: %s", file.path, exc)
            file.description = file.description or f"(description unavailable: {exc})"


async def describe_tree(
    tree: RepoTree,
    sources: dict[str, str],
    progress: ProgressCb | None = None,
) -> RepoTree:
    """Run the LangGraph pipeline to enrich `tree` with LLM descriptions."""
    from langgraph.graph import END, START, StateGraph

    llm = _build_llm()
    settings = get_settings()

    async def load(state: DescribeState) -> DescribeState:
        return state

    async def describe_files(state: DescribeState) -> DescribeState:
        t = state["tree"]
        if llm is None:
            t.summary = "LLM descriptions skipped (no OPENROUTER_API_KEY configured)."
            return state

        sem = asyncio.Semaphore(settings.llm_concurrency)
        total = len(t.files) or 1
        done = 0
        logger.info("Describing %d files (concurrency=%d)", total, settings.llm_concurrency)

        async def run(file: FileInfo) -> None:
            nonlocal done
            await _describe_one(llm, file, sources.get(file.path, ""), sem)
            done += 1
            if progress:
                await progress(0.4 + 0.55 * (done / total), f"Described {file.path}")

        await asyncio.gather(*(run(f) for f in t.files))
        return state

    async def assemble(state: DescribeState) -> DescribeState:
        t = state["tree"]
        n_fn = sum(len(f.functions) for f in t.files)
        n_cls = sum(len(f.classes) for f in t.files)
        if not t.summary:
            t.summary = (
                f"{t.python_file_count} Python files, {n_cls} classes, "
                f"{n_fn} top-level functions."
            )
        return state

    graph = StateGraph(DescribeState)
    graph.add_node("load", load)
    graph.add_node("describe_files", describe_files)
    graph.add_node("assemble", assemble)
    graph.add_edge(START, "load")
    graph.add_edge("load", "describe_files")
    graph.add_edge("describe_files", "assemble")
    graph.add_edge("assemble", END)
    app = graph.compile()

    final = await app.ainvoke({"tree": tree})
    return final["tree"]
