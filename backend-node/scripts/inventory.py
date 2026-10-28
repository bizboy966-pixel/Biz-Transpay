"""Static inventory only: never import or execute the Python application."""
import ast
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sources = {
    "backend/server.py": {"api": "/api", "app": ""},
    "backend/integration_api.py": {
        "router": "/api/integration", "v1": "/api/integration/v1",
    },
}
routes = []
for filename, prefixes in sources.items():
    tree = ast.parse((root / filename).read_text())
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for deco in node.decorator_list:
            if not isinstance(deco, ast.Call) or not isinstance(deco.func, ast.Attribute):
                continue
            owner, method = deco.func.value, deco.func.attr
            if (not isinstance(owner, ast.Name) or owner.id not in prefixes
                    or method not in {"get", "post", "put", "patch", "delete", "head", "options"}):
                continue
            if not deco.args or not isinstance(deco.args[0], ast.Constant):
                raise RuntimeError(f"Nonliteral route needs manual review in {filename}")
            routes.append({
                "method": method.upper(),
                "path": prefixes[owner.id] + deco.args[0].value,
                "source": filename,
                "handler": node.name,
                "status": "pending",
            })
routes.sort(key=lambda row: (row["path"], row["method"]))
target = root / "backend-node" / "route-inventory.json"
target.write_text(json.dumps({
    "description": "Python route inventory; pending means NOT implemented in Node.js.",
    "routes": routes,
}, indent=2) + "\n")
print(f"{len(routes)} routes inventoried. No application or database was accessed.")
