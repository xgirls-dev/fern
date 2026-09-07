from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
TEXT_ROOTS = (
    ROOT / "apps" / "desktop" / "src",
    ROOT / "scripts",
)
TEXT_SUFFIXES = {".ts", ".tsx", ".py", ".html", ".css"}
MOJIBAKE_MARKERS = ("\u00c2", "\u00c3", "\u00e2", "\u00f0")


class TextEncodingTests(unittest.TestCase):
    def test_source_has_no_mojibake_markers(self) -> None:
        failures: list[str] = []
        for root in TEXT_ROOTS:
            for path in root.rglob("*"):
                if not path.is_file() or path.suffix not in TEXT_SUFFIXES:
                    continue
                text = path.read_text(encoding="utf-8")
                for marker in MOJIBAKE_MARKERS:
                    if marker in text:
                        failures.append(f"{path.relative_to(ROOT)} contains {marker!r}")
        self.assertEqual([], failures, "Mojibake markers must not ship in source text")


if __name__ == "__main__":
    unittest.main()

