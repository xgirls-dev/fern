import sys
import base64
import io
import tempfile
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from PIL import Image

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

    def test_lora_model_accepts_one_reference_image(self):
        image = io.BytesIO()
        Image.new("RGB", (16, 16), "blue").save(image, format="PNG")
        reference = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
        result = api_server.validate_flux_payload({**self.payload, "reference_images": [reference]})
        self.assertEqual(result["reference_image"].size, (16, 16))
        with self.assertRaises(ValueError):
            api_server.validate_flux_payload({**self.payload, "reference_images": [reference, reference]})

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

    def test_shared_encoder_is_available_when_only_lora_model_is_installed(self):
        models = [{"id": "4b", "installed": False}, {"id": "4b-lora", "installed": True}]
        with patch.object(api_server.MODEL_MANAGER, "snapshot", return_value=models), \
             patch.object(api_server.KLEIN_TEXT_ENCODER_MANAGER, "snapshot", return_value={"installed": True, "enabled": True}) as encoder, \
             patch.object(api_server.custom_image_registry.MODEL_REGISTRY, "snapshot", return_value=[]):
            result = api_server.model_library_snapshot()
        self.assertTrue(next(item for item in result if item["id"] == "4b-lora")["uncensoredTextEncoder"]["enabled"])
        encoder.assert_any_call(True)

    def test_model_remove_endpoint_invokes_manager(self):
        handler = object.__new__(api_server.Handler)
        handler.path = "/api/models/remove"
        handler.read_json_body = Mock(return_value={"model": "9b"})
        handler.send_json = Mock()
        with patch.object(api_server, "MODEL_MANAGER") as manager, \
             patch.object(api_server, "GENERATION_WORKER") as worker, \
             patch.object(api_server, "model_library_snapshot", return_value=[]), \
             patch.dict(api_server.FLUX_JOB, {"status": "idle"}):
            handler.handle_post()
        manager.remove.assert_called_once_with("9b")
        worker.close.assert_called_once()
        handler.send_json.assert_called_once_with(200, {"models": []})


if __name__ == "__main__":
    unittest.main()
