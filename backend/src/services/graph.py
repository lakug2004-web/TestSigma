"""Write the analysed repo's knowledge graph into Neo4j Aura.

This runs as the last stage of the pipeline, after the AST tree has been built
and described. It mirrors the T-format tree into a property graph and enriches
it with the "deep" edges that make it a real knowledge graph — structure,
dependencies, and behaviour:

    structure   (:Repo)-[:CONTAINS]->(:File)-[:DEFINES]->(:Function|:Class)
                (:Class)-[:HAS_METHOD]->(:Function:Method)
    deps        (:File)-[:DEPENDS_ON]->(:File)     # internal imports, resolved
                (:File)-[:IMPORTS]->(:Library)      # third-party packages
                (:File)-[:USES]->(:Function|:Class) # imported repo symbols
    behaviour   (:Function)-[:CALLS]->(:Function)         # resolved in-repo
                (:Function)-[:INSTANTIATES]->(:Class)     # constructs a class
                (:Class)-[:INHERITS_FROM]->(:Class)
                (:Function|:Class)-[:DECORATED_BY]->(:Decorator)

Every node is namespaced by the repo `full_name`, so each codebase is its own
isolated subgraph inside the shared (Free-tier) instance — its own "connector".
Deleting/rebuilding one repo never touches another. The result carries a set of
ready-to-run, repo-scoped Cypher queries that act as that codebase's dashboard.

The Cypher follows the Aura developer-hub patterns: parameterised
`execute_query` (no string-concatenated values), MERGE for idempotency, and
connectivity verified up front. If `NEO4J_URI` is unset the step is skipped.
"""

from __future__ import annotations

import logging

from neo4j import AsyncGraphDatabase

from src.config import get_settings
from src.models.schemas import GraphInfo, GraphQuery, ImportInfo, RepoTree

logger = logging.getLogger("graph")

# Remove the entire prior subgraph reachable from this repo (nodes are
# per-repo namespaced, so this never touches another codebase). Keeps re-runs
# clean and makes the create counters reflect reality.
_DELETE = """
MATCH (r:Repo {full_name: $full_name})
CALL (r) {
  MATCH (r)-[*0..]->(n)
  RETURN collect(DISTINCT n) AS nodes
}
UNWIND nodes AS n
DETACH DELETE n
"""

# Structural pass: Repo/File/Function/Class/Method plus CONTAINS/DEFINES/
# HAS_METHOD. Properties (incl. decorators/bases/calls/imports) are stored on
# the nodes too, so the data survives even if a later edge pass is skipped.
_INGEST = """
MERGE (r:Repo {full_name: $full_name})
SET r.ref = $ref, r.summary = $summary,
    r.name = $full_name, r.description = $summary
WITH r
UNWIND $files AS f
  MERGE (file:File {key: f.key})
  SET file.path = f.path,
      file.name = f.path,
      file.loc = f.loc,
      file.parsed = f.parsed,
      file.description = f.description,
      file.imports = f.imports
  MERGE (r)-[:CONTAINS]->(file)
  WITH file, f
  CALL (file, f) {
    UNWIND f.functions AS fn
      MERGE (func:Function {key: fn.key})
      SET func.name = fn.name,
          func.args = fn.args,
          func.is_async = fn.is_async,
          func.decorators = fn.decorators,
          func.calls = fn.calls,
          func.description = fn.description
      MERGE (file)-[:DEFINES]->(func)
  }
  CALL (file, f) {
    UNWIND f.classes AS cl
      MERGE (cls:Class {key: cl.key})
      SET cls.name = cl.name,
          cls.bases = cl.bases,
          cls.decorators = cl.decorators,
          cls.description = cl.description
      MERGE (file)-[:DEFINES]->(cls)
      WITH cls, cl
      UNWIND cl.methods AS m
        MERGE (meth:Function:Method {key: m.key})
        SET meth.name = m.name,
            meth.args = m.args,
            meth.is_async = m.is_async,
            meth.decorators = m.decorators,
            meth.calls = m.calls,
            meth.description = m.description
        MERGE (cls)-[:HAS_METHOD]->(meth)
  }
"""

# File -[:DEPENDS_ON]-> File: an internal import resolved to another repo file.
_DEPENDS = """
UNWIND $rels AS x
MATCH (a:File {key: x.src})
MATCH (b:File {key: x.dst})
MERGE (a)-[:DEPENDS_ON]->(b)
"""

# File -[:USES]-> (Function|Class): `from m import sym` where sym is a top-level
# symbol defined in the imported repo file. Shows which functionality is pulled
# in across files.
_USES = """
UNWIND $rels AS x
MATCH (b:File {key: x.dst})-[:DEFINES]->(s)
WHERE s.name = x.name
MATCH (a:File {key: x.src})
MERGE (a)-[:USES]->(s)
"""

# File -[:IMPORTS]-> Library: a third-party / stdlib package (per-repo node).
_LIBS = """
UNWIND $rels AS x
MATCH (file:File {key: x.file_key})
MERGE (lib:Library {key: x.lib_key})
  ON CREATE SET lib.name = x.name, lib.external = true
MERGE (file)-[:IMPORTS]->(lib)
"""

# Function -[:CALLS]-> Function, resolved to functions/methods defined in THIS
# repo by simple name. Calls to builtins/external libs are intentionally
# dropped (they resolve to nothing) to keep the call graph meaningful.
_CALLS = """
UNWIND $rels AS x
MATCH (caller {key: x.caller_key})
MATCH (callee:Function {name: x.callee_name})
WHERE callee.key STARTS WITH $prefix
MERGE (caller)-[:CALLS]->(callee)
"""

# Function -[:INSTANTIATES]-> Class: a call whose name matches a repo class.
_INSTANTIATES = """
UNWIND $rels AS x
MATCH (caller {key: x.caller_key})
MATCH (cls:Class {name: x.callee_name})
WHERE cls.key STARTS WITH $prefix AND coalesce(cls.external, false) = false
MERGE (caller)-[:INSTANTIATES]->(cls)
"""

# Class -[:INHERITS_FROM]-> Class. Links to the real base class when it is
# defined in the repo; otherwise creates an external reference node so the
# inheritance is still visible.
_INHERITS = """
UNWIND $rels AS x
MATCH (cls:Class {key: x.class_key})
OPTIONAL MATCH (real:Class {name: x.base_name})
  WHERE real.key STARTS WITH $prefix AND coalesce(real.external, false) = false
WITH cls, x, collect(real)[0] AS real
FOREACH (_ IN CASE WHEN real IS NOT NULL THEN [1] ELSE [] END |
  MERGE (cls)-[:INHERITS_FROM]->(real)
)
FOREACH (_ IN CASE WHEN real IS NULL THEN [1] ELSE [] END |
  MERGE (base:Class {key: x.base_key})
    ON CREATE SET base.name = x.base_name, base.external = true
  MERGE (cls)-[:INHERITS_FROM]->(base)
)
"""

# (Function|Class) -[:DECORATED_BY]-> Decorator (per-repo namespaced).
_DECORATED = """
UNWIND $rels AS x
MATCH (s {key: x.symbol_key})
MERGE (dec:Decorator {key: x.dec_key})
  ON CREATE SET dec.name = x.name
MERGE (s)-[:DECORATED_BY]->(dec)
"""


def _module_and_package(path: str) -> tuple[str, str]:
    """Map a repo file path to its (importable module, containing package).

    "app/util.py"     -> ("app.util", "app")
    "app/__init__.py" -> ("app", "app")
    "main.py"         -> ("main", "")
    """
    p = path[:-3] if path.endswith(".py") else path
    parts = [x for x in p.split("/") if x]
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
        module = ".".join(parts)
        return module, module
    return ".".join(parts), ".".join(parts[:-1])


def _resolve(importing_pkg: str, rec: ImportInfo) -> str:
    """Resolve an import record to an absolute dotted module name."""
    if rec.level == 0:
        return rec.module
    base_parts = importing_pkg.split(".") if importing_pkg else []
    up = rec.level - 1
    if up:
        base_parts = base_parts[:-up] if up <= len(base_parts) else []
    base = ".".join(base_parts)
    if rec.module:
        return f"{base}.{rec.module}" if base else rec.module
    return base


def _build_payload(tree: RepoTree) -> dict:
    """Flatten the RepoTree into the parameter shapes the queries expect.

    Returns the nested `files` payload plus flat edge lists for every deep pass.
    Keys are namespaced by repo so two repos never collide on MERGE.
    """
    repo = tree.full_name

    # Index every repo module so internal imports can be resolved to a file.
    index: dict[str, str] = {}
    for file in tree.files:
        mod, _pkg = _module_and_package(file.path)
        if mod:
            index[mod] = f"{repo}:{file.path}"

    files: list[dict] = []
    calls_rel: list[dict] = []
    inherits_rel: list[dict] = []
    decorated_rel: list[dict] = []
    depends: set[tuple[str, str]] = set()
    uses: set[tuple[str, str, str]] = set()
    libs: set[tuple[str, str]] = set()  # (file_key, top-level package name)

    for file in tree.files:
        fkey = f"{repo}:{file.path}"
        _mod, pkg = _module_and_package(file.path)

        for rec in file.import_records:
            absolute = _resolve(pkg, rec)
            if absolute and absolute in index and index[absolute] != fkey:
                # `import pkg.mod` or `from pkg.mod import name`
                depends.add((fkey, index[absolute]))
                for name in rec.names:
                    sub = f"{absolute}.{name}"
                    if sub in index and index[sub] != fkey:
                        depends.add((fkey, index[sub]))  # imported a submodule
                    else:
                        uses.add((fkey, index[absolute], name))  # imported a symbol
            else:
                # Maybe `from pkg import submodule` where pkg has no file.
                hit = False
                for name in rec.names:
                    sub = f"{absolute}.{name}" if absolute else name
                    if sub in index and index[sub] != fkey:
                        depends.add((fkey, index[sub]))
                        hit = True
                if not hit:
                    top = (absolute or rec.module).split(".")[0]
                    if top:
                        libs.add((fkey, top))

        functions: list[dict] = []
        for fn in file.functions:
            fnkey = f"{fkey}::fn::{fn.name}::{fn.lineno}"
            functions.append(
                {
                    "key": fnkey,
                    "name": fn.name,
                    "args": fn.args,
                    "is_async": fn.is_async,
                    "decorators": fn.decorators,
                    "calls": fn.calls,
                    "description": fn.description,
                }
            )
            for callee in fn.calls:
                calls_rel.append({"caller_key": fnkey, "callee_name": callee})
            for dec in fn.decorators:
                decorated_rel.append(
                    {"symbol_key": fnkey, "name": dec, "dec_key": f"{repo}::dec::{dec}"}
                )

        classes: list[dict] = []
        for cls in file.classes:
            ckey = f"{fkey}::cls::{cls.name}::{cls.lineno}"
            methods: list[dict] = []
            for m in cls.methods:
                mkey = f"{ckey}::m::{m.name}::{m.lineno}"
                methods.append(
                    {
                        "key": mkey,
                        "name": m.name,
                        "args": m.args,
                        "is_async": m.is_async,
                        "decorators": m.decorators,
                        "calls": m.calls,
                        "description": m.description,
                    }
                )
                for callee in m.calls:
                    calls_rel.append({"caller_key": mkey, "callee_name": callee})
                for dec in m.decorators:
                    decorated_rel.append(
                        {"symbol_key": mkey, "name": dec, "dec_key": f"{repo}::dec::{dec}"}
                    )
            for base in cls.bases:
                inherits_rel.append(
                    {
                        "class_key": ckey,
                        "base_name": base,
                        "base_key": f"{repo}::baseref::{base}",
                    }
                )
            for dec in cls.decorators:
                decorated_rel.append(
                    {"symbol_key": ckey, "name": dec, "dec_key": f"{repo}::dec::{dec}"}
                )
            classes.append(
                {
                    "key": ckey,
                    "name": cls.name,
                    "bases": cls.bases,
                    "decorators": cls.decorators,
                    "description": cls.description,
                    "methods": methods,
                }
            )

        files.append(
            {
                "key": fkey,
                "path": file.path,
                "loc": file.loc,
                "parsed": file.parsed,
                "description": file.description,
                "imports": file.imports,
                "functions": functions,
                "classes": classes,
            }
        )

    return {
        "files": files,
        "calls_rel": calls_rel,
        "inherits_rel": inherits_rel,
        "decorated_rel": decorated_rel,
        "depends_rel": [{"src": s, "dst": d} for s, d in depends],
        "uses_rel": [{"src": s, "dst": d, "name": n} for s, d, n in uses],
        "lib_rel": [
            {"file_key": fk, "name": nm, "lib_key": f"{repo}::lib::{nm}"}
            for fk, nm in libs
        ],
    }


def _connector_queries(full_name: str, prefix: str) -> list[GraphQuery]:
    """Repo-scoped Cypher that acts as this codebase's dashboard/connector."""
    return [
        GraphQuery(
            name="Overview",
            cypher=(
                f'MATCH (r:Repo {{full_name: "{full_name}"}})-[:CONTAINS]->(file)'
                "-[:DEFINES]->(s) RETURN r, file, s LIMIT 300"
            ),
        ),
        GraphQuery(
            name="Read descriptions (table)",
            cypher=(
                f'MATCH (n) WHERE n.key STARTS WITH "{prefix}" '
                'AND coalesce(n.description, "") <> "" '
                'RETURN n.name AS name, head(labels(n)) AS kind, '
                'n.description AS description ORDER BY kind, name'
            ),
        ),
        GraphQuery(
            name="File dependencies",
            cypher=(
                f'MATCH (a:File)-[d:DEPENDS_ON]->(b:File) '
                f'WHERE a.key STARTS WITH "{prefix}" RETURN a, d, b'
            ),
        ),
        GraphQuery(
            name="External libraries",
            cypher=(
                f'MATCH (file:File)-[i:IMPORTS]->(l:Library) '
                f'WHERE file.key STARTS WITH "{prefix}" RETURN file, i, l'
            ),
        ),
        GraphQuery(
            name="Used symbols",
            cypher=(
                f'MATCH (file:File)-[u:USES]->(s) '
                f'WHERE file.key STARTS WITH "{prefix}" RETURN file, u, s'
            ),
        ),
        GraphQuery(
            name="Call graph",
            cypher=(
                f'MATCH (a:Function)-[c:CALLS]->(b:Function) '
                f'WHERE a.key STARTS WITH "{prefix}" RETURN a, c, b'
            ),
        ),
        GraphQuery(
            name="Instantiations",
            cypher=(
                f'MATCH (f:Function)-[i:INSTANTIATES]->(c:Class) '
                f'WHERE f.key STARTS WITH "{prefix}" RETURN f, i, c'
            ),
        ),
        GraphQuery(
            name="Inheritance",
            cypher=(
                f'MATCH (c:Class)-[h:INHERITS_FROM]->(b:Class) '
                f'WHERE c.key STARTS WITH "{prefix}" RETURN c, h, b'
            ),
        ),
        GraphQuery(
            name="Decorators",
            cypher=(
                f'MATCH (s)-[d:DECORATED_BY]->(dec:Decorator) '
                f'WHERE s.key STARTS WITH "{prefix}" RETURN s, d, dec'
            ),
        ),
        GraphQuery(
            name="Everything",
            cypher=(
                f'MATCH (r:Repo {{full_name: "{full_name}"}})-[*1..4]->(n) '
                "RETURN r, n LIMIT 500"
            ),
        ),
    ]


async def build_knowledge_graph(tree: RepoTree) -> GraphInfo | None:
    """Mirror `tree` into Neo4j Aura as a deep knowledge graph.

    Returns None when Aura is not configured. Raises on connection/auth/query
    failure so the caller can surface it on the job.
    """
    settings = get_settings()
    if not settings.neo4j_uri:
        logger.warning("NEO4J_URI not set — knowledge graph step skipped.")
        return None

    auth = (settings.neo4j_username, settings.neo4j_password)
    db = settings.neo4j_database or "neo4j"
    prefix = f"{tree.full_name}:"
    payload = _build_payload(tree)

    logger.info(
        "graph: connecting to Aura instance=%r db=%s",
        settings.aura_instancename or settings.aura_instanceid,
        db,
    )

    nodes = 0
    rels = 0

    async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=auth) as driver:
        await driver.verify_connectivity()

        await driver.execute_query(
            _DELETE, full_name=tree.full_name, database_=db
        )

        passes = [
            (_INGEST, {
                "full_name": tree.full_name,
                "ref": tree.ref,
                "summary": tree.summary,
                "files": payload["files"],
            }),
            (_DEPENDS, {"rels": payload["depends_rel"]}),
            (_USES, {"rels": payload["uses_rel"]}),
            (_LIBS, {"rels": payload["lib_rel"]}),
            (_CALLS, {"rels": payload["calls_rel"], "prefix": prefix}),
            (_INSTANTIATES, {"rels": payload["calls_rel"], "prefix": prefix}),
            (_INHERITS, {"rels": payload["inherits_rel"], "prefix": prefix}),
            (_DECORATED, {"rels": payload["decorated_rel"]}),
        ]
        for query, params in passes:
            _, summary, _ = await driver.execute_query(query, database_=db, **params)
            nodes += summary.counters.nodes_created
            rels += summary.counters.relationships_created

    logger.info(
        "graph: wrote %d nodes, %d relationships for %s",
        nodes,
        rels,
        tree.full_name,
    )

    queries = _connector_queries(tree.full_name, prefix)
    return GraphInfo(
        console_url=settings.neo4j_console_url,
        instance_name=settings.aura_instancename or settings.aura_instanceid,
        database=db,
        nodes_written=nodes,
        relationships_written=rels,
        sample_query=queries[-1].cypher,  # "Everything"
        connector_name=tree.full_name,
        queries=queries,
    )
