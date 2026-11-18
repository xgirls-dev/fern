from __future__ import annotations

import ast
import runpy
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
BUNDLE_SCRIPT = SCRIPTS / "audit-release-resources.py"


class PackagedScriptsTests(unittest.TestCase):
    def test_bundled_backend_includes_local_python_imports(self) -> None:
        bundle_files = runpy.run_path(str(BUNDLE_SCRIPT))["ALLOWED_BACKEND"]
        self.assertIn("model_catalog.json", bundle_files)
        self.assertTrue((SCRIPTS / "model_catalog.json").is_file())
        bundled_files = {name for name in bundle_files if name.endswith(".py")}
        local_modules = {path.stem for path in SCRIPTS.glob("*.py")}

        missing: set[str] = set()
        for filename in bundled_files:
            tree = ast.parse((SCRIPTS / filename).read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported = {alias.name.split(".", 1)[0] for alias in node.names}
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported = {node.module.split(".", 1)[0]}
                else:
                    continue

                for module in imported & local_modules:
                    dependency = f"{module}.py"
                    if dependency not in bundled_files:
                        missing.add(dependency)

        self.assertFalse(
            missing,
            f"Packaged backend is missing local imports: {sorted(missing)}",
        )


if __name__ == "__main__":
    unittest.main()
