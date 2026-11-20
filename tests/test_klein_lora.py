import sys
import base64
import io
import subprocess
import tempfile
import unittest
from textwrap import dedent
from types import SimpleNamespace
from unittest.mock import Mock, patch
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import api_server
import gallery_store
from flux2_klein_lora import _align_gpu_adapter_rank, _normalize_adapter_keys


class KleinLoraAdapterTests(unittest.TestCase):
    def test_normalizes_mixed_diffusers_attention_keys(self):
        prefix = "transformer.transformer_blocks.0.attn"
        keys = {f"{prefix}.to_k.lora.down.weight": "down", f"{prefix}.to_k.lora.up.weight": "up",
                f"{prefix}.add_k_proj.lora_A.weight": "native"}
        self.assertEqual(_normalize_adapter_keys(keys, "mixed.safetensors"), {
            f"{prefix}.to_k.lora_A.weight": "down", f"{prefix}.to_k.lora_B.weight": "up",
            f"{prefix}.add_k_proj.lora_A.weight": "native",
        })

    def test_rejects_two_weights_for_one_target(self):
        with self.assertRaisesRegex(ValueError, "more than one tensor"):
            _normalize_adapter_keys({"layer.lora_A.weight": "native", "layer.lora.down.weight": "alias"}, "duplicate.safetensors")

    def test_pads_small_gpu_rank_without_changing_the_weight_update(self):
        # Other tests replace Torch modules in-process. Use a fresh interpreter
        # to exercise real BF16 tensors, as the generation worker does.
        result = subprocess.run(
            [sys.executable, "-c", dedent("""\
                import torch
                from flux2_klein_lora import _align_gpu_adapter_rank

                a = torch.arange(24, dtype=torch.bfloat16).reshape(8, 3)
                b = torch.arange(16, dtype=torch.bfloat16).reshape(2, 8)
                padded_a, padded_b = _align_gpu_adapter_rank(a, b)

                assert padded_a.shape == (16, 3)
                assert padded_b.shape == (2, 16)
                assert padded_a.dtype == a.dtype
                assert padded_b.dtype == b.dtype
                torch.testing.assert_close(
                    padded_b.float() @ padded_a.float(), b.float() @ a.float(), rtol=0, atol=0
                )
                """)],
            cwd=Path(__file__).resolve().parents[1] / "scripts",
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_leaves_aligned_and_unsupported_ranks_unchanged(self):
        for rank in (16, 256, 257):
            with self.subTest(rank=rank):
                a = SimpleNamespace(shape=(rank, 3))
                b = SimpleNamespace(shape=(2, rank))
                padded_a, padded_b = _align_gpu_adapter_rank(a, b)
                self.assertIs(padded_a, a)
                self.assertIs(padded_b, b)


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
        for model in ("4b-lora", "9b-lora"):
            with self.subTest(model=model):
                result = api_server.validate_flux_payload({**self.payload, "model": model})
                self.assertEqual(result["model"], model)
                self.assertEqual(result["loras"], [{"path": str(self.adapter.resolve()), "strength": 1.9, "enabled": True}])

    def test_lora_model_accepts_up_to_four_reference_images(self):
        image = io.BytesIO()
        Image.new("RGB", (16, 16), "blue").save(image, format="PNG")
        reference = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
        for model in ("4b-lora", "9b-lora"):
            with self.subTest(model=model):
                payload = {**self.payload, "model": model}
                result = api_server.validate_flux_payload({**payload, "reference_images": [reference] * 4})
                self.assertEqual(result["reference_image"].size, (16, 16))
                self.assertEqual(len(result["reference_images"]), 4)
                with self.assertRaises(ValueError):
                    api_server.validate_flux_payload({**payload, "reference_images": [reference] * 5})

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
