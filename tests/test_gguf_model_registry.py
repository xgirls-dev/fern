from __future__ import annotations

import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from text_model_download import model_files, model_spec
from text_model_registry import TextModelRegistry, inspect_model


def write_gguf(path: Path, **metadata: str) -> None:
    def string(value: str) -> bytes:
        encoded = value.encode()
        return struct.pack("<Q", len(encoded)) + encoded

    entries = b"".join(string(key) + struct.pack("<I", 8) + string(value) for key, value in metadata.items())
    path.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 1, len(metadata)) + entries)


class GGUFRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.model, self.projector = model_files(self.root, model_spec("gemma-4-e4b-gguf"))
        write_gguf(self.model, **{
            "general.architecture": "gemma4",
            "general.name": "Gemma 4",
            "tokenizer.chat_template": "{% if enable_thinking %}<|think|>{% endif %}",
        })
        write_gguf(self.projector, **{"general.architecture": "clip"})
        self.registry = TextModelRegistry(self.root / "registry.json")

    def test_add_projector_preserves_model_identity_and_persists_capabilities(self) -> None:
        text_model = self.registry.add(str(self.model))
        self.assertTrue(text_model["supportsReasoning"])
        self.assertFalse(text_model["supportsVision"])
        vision_model = self.registry.add(str(self.model), str(self.projector))
        self.assertEqual(vision_model["id"], text_model["id"])
        self.assertTrue(vision_model["supportsVision"])
        self.assertEqual(self.registry.snapshot()[0]["projectorPath"], str(self.projector.resolve()))
        self.projector.unlink()
        self.assertFalse(self.registry.snapshot()[0]["installed"])

    def test_reject_projector_as_model_and_incomplete_metadata(self) -> None:
        with self.assertRaisesRegex(ValueError, "language model GGUF"):
            inspect_model(self.projector)
        invalid = self.root / "truncated.gguf"
        invalid.write_bytes(b"GGUF" + struct.pack("<IQQQ", 3, 1, 1, 99))
        with self.assertRaisesRegex(ValueError, "metadata is incomplete"):
            inspect_model(invalid)


if __name__ == "__main__":
    unittest.main()
