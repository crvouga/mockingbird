"""Exact-source loading without importing gateway startup or inference."""
import ast
import hashlib
import json
import sys
import types
from pathlib import Path

LOCK = json.loads(Path(__file__).with_name("source-lock.json").read_text())


def verify(directory):
    directory = Path(directory)
    for name, expected in LOCK["sources"].items():
        data = (directory / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected["sha256"]:
            raise ValueError(f"Pinned source hash mismatch: {name}")
    return LOCK


def definitions(path, roots, namespace):
    """Compile original AST nodes and their local definition dependencies.

    Imports are explicitly supplied by the harness. No function body is rewritten;
    future annotations avoid loading unrelated annotation-only dependencies.
    Return selected names so provenance can disclose the exact loading boundary.
    """
    tree = ast.parse(Path(path).read_text(), filename=str(path))
    definitions_by_name = {}
    for node in tree.body:
        candidates = node.body if isinstance(node, ast.ClassDef) and node.name == "APIServerAdapter" else [node]
        for candidate in candidates:
            if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                definitions_by_name[candidate.name] = candidate
            elif isinstance(candidate, (ast.Assign, ast.AnnAssign)):
                targets = candidate.targets if isinstance(candidate, ast.Assign) else [candidate.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        definitions_by_name[target.id] = candidate
    selected = set()
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in selected or name in namespace:
            continue
        node = definitions_by_name.get(name)
        if node is None:
            if name in roots:
                raise ValueError(f"Missing pinned definition: {name}")
            continue
        selected.add(name)
        pending.extend(n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load))
    nodes = {id(definitions_by_name[name]): definitions_by_name[name] for name in selected}
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *sorted(nodes.values(), key=lambda node: node.lineno)], type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(path), "exec"), namespace)
    return sorted(selected)


def load_module(path, name):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(Path(path).read_text(), str(path), "exec"), module.__dict__)
    return module


if __name__ == "__main__":
    import sys
    manifest = verify(sys.argv[1])
    print(json.dumps({"commit": manifest["commit"], "verified_files": len(manifest["sources"])}))
