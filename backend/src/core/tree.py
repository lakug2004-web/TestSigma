"""AST visitor that turns Python source into structured node info.

Pure stdlib `ast`; no descriptions are produced here — that is the
describer's job. Top-level functions and classes (plus methods inside
classes) are captured. Nested/inner functions are intentionally ignored to
keep the tree readable.
"""

from __future__ import annotations

import ast

from src.models.schemas import ClassInfo, FunctionInfo, ImportInfo


def _decorator_name(node: ast.expr) -> str:
    """Best-effort source-like name for a decorator expression."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{_decorator_name(node.value)}.{node.attr}"
    if isinstance(node, ast.Call):
        return _decorator_name(node.func)
    try:
        return ast.unparse(node)
    except Exception:
        return "<decorator>"


def _base_name(node: ast.expr) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return getattr(node, "id", "<base>")


def _called_name(node: ast.Call) -> str | None:
    """Simple name of a call target: `foo(...)`->foo, `obj.bar(...)`->bar."""
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _calls(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    """Distinct call-target names inside a function body (order-preserving)."""
    seen: dict[str, None] = {}
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            name = _called_name(child)
            if name:
                seen.setdefault(name, None)
    return list(seen)


def _func_info(node: ast.FunctionDef | ast.AsyncFunctionDef) -> FunctionInfo:
    args = [a.arg for a in node.args.args]
    if node.args.vararg:
        args.append("*" + node.args.vararg.arg)
    for a in node.args.kwonlyargs:
        args.append(a.arg)
    if node.args.kwarg:
        args.append("**" + node.args.kwarg.arg)
    return FunctionInfo(
        name=node.name,
        args=args,
        lineno=node.lineno,
        end_lineno=getattr(node, "end_lineno", node.lineno) or node.lineno,
        is_async=isinstance(node, ast.AsyncFunctionDef),
        decorators=[_decorator_name(d) for d in node.decorator_list],
        calls=_calls(node),
    )


def extract_imports(tree: ast.Module) -> list[ImportInfo]:
    """Structured import statements from a module (top-level only).

    `import a.b.c` -> ImportInfo(module="a.b.c"); `from x import y` ->
    ImportInfo(module="x", names=["y"]). Relative imports keep their `level`.
    """
    records: list[ImportInfo] = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                records.append(ImportInfo(module=alias.name))
        elif isinstance(node, ast.ImportFrom):
            records.append(
                ImportInfo(
                    module=node.module or "",
                    names=[a.name for a in node.names],
                    level=node.level or 0,
                )
            )
    return records


def _class_info(node: ast.ClassDef) -> ClassInfo:
    methods: list[FunctionInfo] = []
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            methods.append(_func_info(child))
    return ClassInfo(
        name=node.name,
        lineno=node.lineno,
        end_lineno=getattr(node, "end_lineno", node.lineno) or node.lineno,
        bases=[_base_name(b) for b in node.bases],
        decorators=[_decorator_name(d) for d in node.decorator_list],
        methods=methods,
    )


def extract_symbols(tree: ast.Module) -> tuple[list[FunctionInfo], list[ClassInfo]]:
    """Return (top-level functions, top-level classes) from a parsed module."""
    functions: list[FunctionInfo] = []
    classes: list[ClassInfo] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(_func_info(node))
        elif isinstance(node, ast.ClassDef):
            classes.append(_class_info(node))
    return functions, classes
