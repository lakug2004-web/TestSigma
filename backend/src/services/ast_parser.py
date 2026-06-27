"""Turn fetched source files into a RepoTree (the T-format structure).

Each `.py` file is parsed with stdlib `ast`; symbols come from
`core.tree.extract_symbols`. Files that fail to parse are still included as
file nodes flagged with `parsed=False` so the frontend can show them.
"""

from __future__ import annotations

import ast
import warnings

from src.core.tree import extract_imports, extract_symbols
from src.models.schemas import FileInfo, RepoTree


def parse_file(path: str, source: str) -> FileInfo:
    loc = source.count("\n") + 1
    try:
        # Client code may contain invalid escape sequences ("\%" etc.) that emit
        # SyntaxWarning during parse — silence them; we only care about structure.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            module = ast.parse(source)
    except SyntaxError as exc:
        return FileInfo(
            path=path,
            loc=loc,
            parsed=False,
            parse_error=f"{exc.msg} (line {exc.lineno})",
        )

    functions, classes = extract_symbols(module)
    records = extract_imports(module)
    # Display names: dotted module, with leading dots for relative imports.
    display = [("." * r.level + r.module) if r.module else "." * r.level for r in records]
    return FileInfo(
        path=path,
        loc=loc,
        parsed=True,
        imports=display,
        import_records=records,
        functions=functions,
        classes=classes,
    )


def build_tree(
    full_name: str,
    ref: str,
    sources: dict[str, str],
    total_file_count: int,
) -> RepoTree:
    """Build the RepoTree from a {path: source} map of Python files."""
    files = [parse_file(path, src) for path, src in sorted(sources.items())]
    return RepoTree(
        full_name=full_name,
        ref=ref,
        file_count=total_file_count,
        python_file_count=len(files),
        files=files,
    )
