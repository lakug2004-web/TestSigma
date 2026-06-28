"""Connect the three knowledge-graph layers in Neo4j.

`graph.py` writes the CODE layer (Repo/File/Function/Class). This module adds the
other two layers onto the same per-repo subgraph and links them:

    Requirements (intended)   (:Repo)-[:SPECIFIES]->(:Requirement)
    DOM/UI       (built)      (:Repo)-[:HAS_SCREEN]->(:Screen)
                              (:Screen)-[:NAVIGATES_TO]->(:Screen)   # flows
    cross-layer               (:Requirement)-[:COVERED_BY]->(:Screen)
                              (:Requirement)-[:IMPLEMENTED_BY]->(:File)
                              (:Screen)-[:RENDERED_BY]->(:File)

Absence — the question the assignment calls out — is modelled as a first-class
state, not a missing row: every Requirement carries `covered_by_ui` /
`implemented_in_code` booleans, and an uncovered requirement gets an explicit
`(:Requirement)-[:MISSING_UI_COVERAGE]->(:CoverageGap)` edge. That makes the
absence query trivial and visible in the graph:

    MATCH (r:Requirement {full_name:$repo})-[:MISSING_UI_COVERAGE]->(:CoverageGap)
    RETURN r.req_id, r.title

The requirement->screen and requirement->file mappings are semantic, so a single
structured LLM call produces them (deterministic graph writes around an LLM
mapping step — the LLM decides links, Cypher decides truth). With no LLM key the
layers are still written, just without cross-layer edges (so everything reads as
uncovered — the honest default).
"""

from __future__ import annotations

import json
import logging

from neo4j import AsyncGraphDatabase
from pydantic import BaseModel, Field, ValidationError

from src.config import get_settings
from src.services.describer import _extract_json
from src.services.pr_review import _build_reviewer_llm

logger = logging.getLogger("graph_layers")


# --- LLM mapping contract ----------------------------------------------------
class ReqMapping(BaseModel):
    req_id: str
    covered_by_screens: list[str] = Field(default_factory=list, description="screen urls/labels")
    implemented_by_files: list[str] = Field(default_factory=list, description="repo file paths")


class LayerMapping(BaseModel):
    mappings: list[ReqMapping] = Field(default_factory=list)


_MAP_SYSTEM = (
    "You connect product requirements to the UI screens that satisfy them and the "
    "code files that implement them. For EACH requirement, list the screen "
    "urls/labels that a user would use to exercise it (empty if none of the "
    "captured screens cover it — that is a real and important answer), and the "
    "repo file paths that most likely implement it. Only use ids/paths from the "
    "provided lists. Respond with ONLY JSON: "
    '{"mappings":[{"req_id":"R1","covered_by_screens":["..."],"implemented_by_files":["..."]}]}'
)

# --- Cypher (per-repo namespaced, MERGE-idempotent) --------------------------
_REQS = """
MERGE (r:Repo {full_name: $full_name})
WITH r
UNWIND $reqs AS q
  MERGE (req:Requirement {key: q.key})
  SET req.req_id = q.req_id,
      req.full_name = $full_name,
      req.title = q.title,
      req.user_action = q.user_action,
      req.expected_outcome = q.expected_outcome,
      req.priority = q.priority,
      req.covered_by_ui = q.covered_by_ui,
      req.implemented_in_code = q.implemented_in_code
  MERGE (r)-[:SPECIFIES]->(req)
"""

_SCREENS = """
MERGE (r:Repo {full_name: $full_name})
WITH r
UNWIND $screens AS s
  MERGE (sc:Screen {key: s.key})
  SET sc.full_name = $full_name,
      sc.url = s.url,
      sc.title = s.title,
      sc.label = s.label,
      sc.authenticated = s.authenticated
  MERGE (r)-[:HAS_SCREEN]->(sc)
"""

_FLOWS = """
UNWIND $edges AS e
  MATCH (a:Screen {key: e.src})
  MATCH (b:Screen {key: e.dst})
  MERGE (a)-[:NAVIGATES_TO]->(b)
"""

_COVERED_BY = """
UNWIND $rels AS x
  MATCH (req:Requirement {key: x.req_key})
  MATCH (sc:Screen {key: x.screen_key})
  MERGE (req)-[:COVERED_BY]->(sc)
"""

_IMPL_BY = """
UNWIND $rels AS x
  MATCH (req:Requirement {key: x.req_key})
  MATCH (f:File {key: x.file_key})
  MERGE (req)-[:IMPLEMENTED_BY]->(f)
"""

# Absence as a first-class node + edge so it shows up in the graph view.
_GAPS = """
UNWIND $reqs AS q
  MATCH (req:Requirement {key: q.key})
  WHERE q.covered_by_ui = false
  MERGE (g:CoverageGap {key: q.key + '::gap'})
    ON CREATE SET g.full_name = $full_name, g.reason = 'no captured UI exercises this requirement'
  MERGE (req)-[:MISSING_UI_COVERAGE]->(g)
"""


def _screen_key(repo: str, screen_id: str) -> str:
    return f"{repo}::screen::{screen_id}"


async def connect_layers(
    full_name: str,
    requirements: list[dict],
    crawl: dict | None,
    code_file_paths: list[str],
) -> dict:
    """Write the Requirements + UI layers and cross-layer links into Neo4j.

    Returns a small summary (counts + absence list). No-op-safe: if Neo4j isn't
    configured it returns a skipped marker.
    """
    settings = get_settings()
    if not settings.neo4j_uri:
        return {"skipped": "NEO4J_URI not configured"}
    if not requirements and not crawl:
        return {"skipped": "no requirements or crawl to connect"}

    repo = full_name
    screens = (crawl or {}).get("screens", [])
    # screen_id may not be stored on the crawl row; fall back to url as identity.
    screen_payload = [
        {
            "key": _screen_key(repo, s.get("screenId") or s.get("url", "")),
            "url": s.get("url", ""),
            "title": s.get("title", ""),
            "label": s.get("label", ""),
            "authenticated": bool(s.get("authenticated")),
        }
        for s in screens
    ]
    # index screens by both url and label for LLM-name resolution
    screen_by_name: dict[str, str] = {}
    for s, p in zip(screens, screen_payload):
        for name in (s.get("url"), s.get("label"), s.get("title")):
            if name:
                screen_by_name[name.strip()] = p["key"]

    files_set = set(code_file_paths)

    # --- semantic cross-layer mapping (LLM) ---------------------------------
    cover_rels: list[dict] = []
    impl_rels: list[dict] = []
    covered_ids: set[str] = set()
    implemented_ids: set[str] = set()

    llm = _build_reviewer_llm()
    if llm and requirements:
        req_lines = "\n".join(
            f"- {r.get('req_id')}: {r.get('title')} | user: {r.get('user_action','')} "
            f"-> {r.get('expected_outcome','')}"
            for r in requirements
        )
        screen_lines = "\n".join(
            f"- {p['label'] or p['title'] or p['url']} ({p['url']})" for p in screen_payload
        ) or "(no screens captured)"
        file_lines = "\n".join(f"- {p}" for p in code_file_paths[:200]) or "(no code files)"
        human = (
            f"Requirements:\n{req_lines}\n\nCaptured screens:\n{screen_lines}\n\n"
            f"Code files:\n{file_lines}"
        )
        try:
            resp = await llm.ainvoke([("system", _MAP_SYSTEM), ("human", human)])
            content = resp.content if isinstance(resp.content, str) else str(resp.content)
            mapping = LayerMapping.model_validate(_extract_json(content))
            by_id = {m.req_id: m for m in mapping.mappings}
            for r in requirements:
                rid = r.get("req_id")
                m = by_id.get(rid)
                if not m:
                    continue
                req_key = f"{repo}::req::{rid}"
                for name in m.covered_by_screens:
                    key = screen_by_name.get(name.strip())
                    if key:
                        cover_rels.append({"req_key": req_key, "screen_key": key})
                        covered_ids.add(rid)
                for path in m.implemented_by_files:
                    p = path.strip()
                    fk = f"{repo}:{p}"
                    if p in files_set:
                        impl_rels.append({"req_key": req_key, "file_key": fk})
                        implemented_ids.add(rid)
        except (ValidationError, json.JSONDecodeError, ValueError) as exc:
            logger.warning("layer mapping LLM unparseable: %s", exc)

    req_payload = [
        {
            "key": f"{repo}::req::{r.get('req_id')}",
            "req_id": r.get("req_id", ""),
            "title": r.get("title", ""),
            "user_action": r.get("user_action", ""),
            "expected_outcome": r.get("expected_outcome", ""),
            "priority": r.get("priority", ""),
            "covered_by_ui": r.get("req_id") in covered_ids,
            "implemented_in_code": r.get("req_id") in implemented_ids,
        }
        for r in requirements
    ]

    flow_edges = []
    for e in (crawl or {}).get("edges", []):
        src = e.get("from_screen") or e.get("from")
        dst = e.get("to_screen") or e.get("to")
        if src and dst:
            flow_edges.append(
                {"src": _screen_key(repo, src), "dst": _screen_key(repo, dst)}
            )

    auth = (settings.neo4j_username, settings.neo4j_password)
    db = settings.neo4j_database or "neo4j"
    nodes = rels = 0
    async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=auth) as driver:
        await driver.verify_connectivity()
        passes = [
            (_REQS, {"full_name": repo, "reqs": req_payload}),
            (_SCREENS, {"full_name": repo, "screens": screen_payload}),
            (_FLOWS, {"edges": flow_edges}),
            (_COVERED_BY, {"rels": cover_rels}),
            (_IMPL_BY, {"rels": impl_rels}),
            (_GAPS, {"full_name": repo, "reqs": req_payload}),
        ]
        for query, params in passes:
            _, summary, _ = await driver.execute_query(query, database_=db, **params)
            nodes += summary.counters.nodes_created
            rels += summary.counters.relationships_created

    uncovered = [r["req_id"] for r in req_payload if not r["covered_by_ui"]]
    logger.info(
        "layers connected for %s: %d reqs, %d screens, %d covered, %d uncovered",
        repo,
        len(req_payload),
        len(screen_payload),
        len(covered_ids),
        len(uncovered),
    )
    return {
        "requirements": len(req_payload),
        "screens": len(screen_payload),
        "covered_by_ui": sorted(covered_ids),
        "implemented_in_code": sorted(implemented_ids),
        "uncovered_requirements": uncovered,
        "nodes_created": nodes,
        "relationships_created": rels,
        "absence_query": (
            f'MATCH (r:Requirement {{full_name:"{repo}"}})-[:MISSING_UI_COVERAGE]->'
            "(:CoverageGap) RETURN r.req_id, r.title"
        ),
    }
