from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from flux2_klein_pipeline import save_image_atomic


class FakeImage:
    def save(self, path: Path, format: str) -> None:
        self.assert_format(format)
        path.write_bytes(b"complete png payload")

    @staticmethod
    def assert_format(format: str) -> None:
        if format != "PNG":
            raise AssertionError(f"unexpected image format: {format}")


class PipelineOutputTests(unittest.TestCase):
    def test_image_is_published_only_after_png_write_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "render.png"
            save_image_atomic(FakeImage(), output_path)

            self.assertTrue(output_path.is_file())
            self.assertEqual(output_path.read_bytes(), b"complete png payload")
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()

