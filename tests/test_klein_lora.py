import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import api_server
import gallery_store


class KleinLoraPayloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.adapter = Path(self.temp.name) / "style.safetensors"
        self.adapter.write_bytes(b"fixture")
        self.payload = {"model": "4b-lora", "prompt": "A blue robot", "width": 512,
                        "height": 512, "guidance": 1, "steps": 4, "seed": 1,
                        "loras": [{"path": str(self.adapter), "strength": 1.9}]}

    def test_selected_adapter_is_carried_to_worker(self):
        result = api_server.validate_flux_payload(self.payload)
        self.assertEqual(result["loras"], [{"path": str(self.adapter.resolve()), "strength": 1.9, "enabled": True}])

    def test_rejects_incompatible_model_strength_and_missing_file(self):
        for changes in (
            {"model": "4b"},
            {"loras": [{"path": str(self.adapter), "strength": float("nan")}]},
            {"loras": [{"path": str(self.adapter) + ".missing", "strength": 1}]},
            {"guidance": 2},
        ):
            with self.subTest(changes=changes), self.assertRaises((ValueError, OSError)):
                api_server.validate_flux_payload({**self.payload, **changes})

    def test_metadata_exposes_adapter_names_and_weights(self):
        metadata = {"image.png": {"loras": [{"name": "style.safetensors", "strength": 1.9}]}}
        record = gallery_store.enrich_image_record({"name": "image.png"}, metadata)
        self.assertEqual(record["loras"], metadata["image.png"]["loras"])

    def test_model_status_keeps_lora_model_selection(self):
        expected = {"selectedModel": "4b-lora", "runtimeReady": True, "runtimeNote": "ready"}
        with patch.object(api_server, "MODEL_CHECK_STARTED", True), \
             patch.object(api_server, "MODEL_CHECK_RESULTS", {("AUTO", "4b-lora"): expected}), \
             patch.object(api_server.flux2, "model_status", return_value=expected) as status:
            result = api_server.model_snapshot("AUTO", "4b-lora")
        self.assertEqual(result["selectedModel"], "4b-lora")
        status.assert_called_once_with("AUTO", "4b-lora")


if __name__ == "__main__":
    unittest.main()
