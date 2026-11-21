from __future__ import annotations

import base64
import io
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import api_server
import gallery_store


class UxWorkflowTests(unittest.TestCase):
    def test_chat_catalog_exposes_installed_models_and_their_own_defaults(self):
        pony = api_server.model_spec(api_server.tame_pony.MODEL_KEY)
        custom = {"id": "custom-example", "label": "My SDXL", "installed": True, "family": "sdxl",
                  "defaultWidth": 1024, "defaultHeight": 768, "defaultSteps": 28, "defaultGuidance": 7}
        with (
            patch.object(api_server, "apple_silicon", return_value=False),
            patch.object(api_server.MODEL_MANAGER, "snapshot", return_value=[
                {**pony, "installed": True}, {"id": "4b", "label": "Klein", "installed": True},
                {"id": "flux3-klein", "label": "Flux.3", "installed": True},
            ]),
            patch.object(api_server.custom_image_registry.MODEL_REGISTRY, "snapshot", return_value=[custom]),
            patch.object(api_server, "qwen_turbo_model_ready", return_value=True),
            patch.object(api_server, "qwen_turbo_runtime_status", return_value=(True, {"GPU"})),
        ):
            result = api_server.chat_image_catalog()
        self.assertEqual([item["id"] for item in result], ["4b", pony["id"], api_server.QWEN_TURBO_MODEL_ID, custom["id"]])
        self.assertEqual(result[1]["defaultSteps"], pony["steps"])
        self.assertEqual(result[2]["defaultSteps"], 8)
        self.assertEqual(result[3]["dimensionMultiple"], api_server.custom_image_registry.FAMILIES["sdxl"]["multiple"])

    def test_chat_renders_additional_image_families_with_gpu_and_catalog_defaults(self):
        model = api_server.tame_pony.MODEL_KEY
        record = {"name": "test.png", "width": 1024, "height": 1024, "modelLabel": "Pony", "prompt": "test"}
        status = {"runtimeReady": True, "selectedDevice": "INTEL_GPU", "modelRevision": "test",
                  "defaultWidth": 1024, "defaultHeight": 1024, "defaultSteps": 25, "defaultGuidance": 5}
        with (
            patch.object(api_server, "apple_silicon", return_value=False),
            patch.object(api_server, "model_snapshot", return_value=status) as snapshot,
            patch.object(api_server, "run_flux_generation", return_value=record) as render,
        ):
            api_server.generate_chat_image(model, "test", "thread", "job", threading.Event(), {"height": 768})
        snapshot.assert_called_once_with("INTEL_GPU", model)
        payload = render.call_args.args[1]
        self.assertEqual([payload[key] for key in ("width", "height", "steps", "guidance", "device")], [1024, 768, 25, 5, "INTEL_GPU"])

    def test_text_sampling_keeps_model_defaults_and_validates_overrides(self):
        self.assertEqual(api_server.validate_text_sampling(None), {})
        options = {"topK": 32, "minP": 0.07, "repeatPenalty": 1.15, "stopSequences": ["END", "User:"]}
        self.assertEqual(api_server.validate_text_sampling(options), options)
        for invalid in ({"topK": True}, {"minP": 1}, {"repeatPenalty": float("inf")}, {"stopSequences": ["  "]}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                api_server.validate_text_sampling(invalid)

    def test_deleted_last_output_is_not_reintroduced_by_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.png"
            image.write_bytes(b"fixture")
            with patch.object(api_server, "OUTPUTS", root), patch.dict(api_server.FLUX_JOB, {"output": {"name": image.name}}):
                self.assertIsNotNone(api_server.flux_job_snapshot()["output"])
                image.unlink()
                self.assertIsNone(api_server.flux_job_snapshot()["output"])

    def test_requested_presets_are_accepted_without_rounding(self):
        for width, height in [(720, 1280), (1280, 720), (1920, 1088), (1088, 1920)]:
            result = api_server.validate_flux_payload({"prompt": "test", "width": width, "height": height})
            self.assertEqual((result["width"], result["height"]), (width, height))
        with self.assertRaises(ValueError):
            api_server.validate_flux_payload({"prompt": "test", "width": 1080})

    def test_kromoss_preserves_custom_canvas_and_steps(self):
        request = {"prompt": "A fox", "model": "kromoss-opd-dmd2", "device": "INTEL_GPU"}
        default = api_server.validate_flux_payload(request)
        self.assertEqual((default["width"], default["height"], default["steps"], default["guidance"]), (512, 512, 8, 1))
        custom = api_server.validate_flux_payload({**request, "width": 4096, "height": 768, "steps": 60})
        self.assertEqual((custom["width"], custom["height"], custom["steps"], custom["guidance"]), (4096, 768, 60, 1))
        for invalid in ({"width": 4112}, {"height": 777}, {"steps": 0}, {"steps": 7.5}, {"steps": True}, {"steps": 2_147_483_647}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                api_server.validate_flux_payload({**request, **invalid})

    def test_kromoss_chat_tool_keeps_the_recommended_step_count(self):
        model = "kromoss-opd-dmd2"
        record = {"name": "fox.png", "width": 512, "height": 512, "modelLabel": "Kromoss", "prompt": "A fox"}
        with (
            patch.object(api_server, "model_snapshot", return_value={
                "runtimeReady": True, "selectedDevice": "INTEL_GPU", "modelRevision": "test",
            }),
            patch.object(api_server, "run_flux_generation", return_value=record) as generate,
        ):
            api_server.generate_chat_image(model, "A fox", "thread-one", "job-one", threading.Event())
            default_payload = generate.call_args.args[1]
            api_server.generate_chat_image(model, "A fox", "thread-one", "job-one", threading.Event(), {
                "width": 2064, "height": 768, "steps": 60, "seed": 123,
            })
        payload = generate.call_args.args[1]
        self.assertEqual((default_payload["width"], default_payload["height"], default_payload["steps"]), (512, 512, 8))
        self.assertEqual((payload["width"], payload["height"], payload["steps"], payload["seed"]), (2064, 768, 60, 123))

    def test_mac_image_preset_requires_apple_gpu_and_enforces_its_canvas(self):
        request = {"prompt": "A fox", "model": api_server.APPLE_IMAGE_ID, "device": "APPLE_GPU"}
        with patch.object(api_server, "apple_silicon", return_value=True):
            resolved = api_server.validate_flux_payload({**request, "steps": 30, "guidance": 7})
            self.assertEqual((resolved["width"], resolved["height"], resolved["steps"], resolved["guidance"]), (512, 512, 4, 1))
            with self.assertRaisesRegex(ValueError, "Select Available GPU"):
                api_server.validate_flux_payload({**request, "device": "CPU"})
            with self.assertRaisesRegex(ValueError, "Choose 512"):
                api_server.validate_flux_payload({**request, "width": 1024})
        with patch.object(api_server, "apple_silicon", return_value=False):
            with self.assertRaisesRegex(ValueError, "requires Apple Silicon"):
                api_server.validate_flux_payload(request)

    def test_chat_reference_order_and_loras_reach_the_image_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attachment, explicit, adapter = root / "attachment.png", root / "explicit.png", root / "adapter.safetensors"
            Image.new("RGB", (16, 16), "red").save(attachment)
            Image.new("RGB", (16, 16), "blue").save(explicit)
            adapter.touch()
            saved = {"name": "result.png", "width": 512, "height": 512, "modelLabel": "Klein", "prompt": "test"}
            with (
                patch.object(api_server, "model_snapshot", return_value={
                    "runtimeReady": True, "selectedDevice": "INTEL_GPU", "modelRevision": "test",
                }),
                patch.object(api_server, "chat_image_path", return_value=str(explicit)),
                patch.object(api_server, "run_flux_generation", return_value=saved) as render,
            ):
                api_server.generate_chat_image("4b-lora", "A fox.", "thread", "job", threading.Event(), {
                    "referenceImages": ["chat-image-" + "a" * 32 + ".png"],
                    "useMessageImage": True,
                    "promptSuffix": "cinematic lighting",
                    "loras": [{"path": str(adapter), "strength": 0.65, "enabled": True}],
                }, message_image=str(attachment))
            payload = render.call_args.args[1]
            self.assertEqual(payload["prompt"], "A fox. cinematic lighting")
            self.assertEqual([image.getpixel((0, 0)) for image in payload["reference_images"]], [(255, 0, 0), (0, 0, 255)])
            self.assertEqual(payload["loras"], [{"path": str(adapter.resolve()), "strength": 0.65, "enabled": True}])

    def test_qwen_requires_dimensions_on_its_32_pixel_grid(self):
        with (
            patch.object(api_server, "qwen_turbo_runtime_ready", return_value=True),
            patch.object(api_server, "qwen_turbo_model_ready", return_value=True),
        ):
            result = api_server.validate_flux_payload({
                "prompt": "test", "model": api_server.QWEN_TURBO_MODEL_ID,
                "width": 736, "height": 1280,
            })
            self.assertEqual((result["width"], result["height"]), (736, 1280))
            with self.assertRaisesRegex(ValueError, "divisible by 32"):
                api_server.validate_flux_payload({
                    "prompt": "test", "model": api_server.QWEN_TURBO_MODEL_ID,
                    "width": 720, "height": 1280,
                })

    def test_reference_provenance_survives_batch_and_preserves_original_bytes(self):
        buffer = io.BytesIO()
        Image.new("RGB", (32, 32), "green").save(buffer, format="JPEG")
        raw = buffer.getvalue()
        source = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = root / "outputs"
            outputs.mkdir()
            sequence = 0

            def generate(**kwargs):
                nonlocal sequence
                sequence += 1
                self.assertIsNotNone(kwargs["reference_image"])
                path = outputs / f"image-{sequence}.png"
                Image.new("RGB", (32, 32)).save(path)
                return path, 1.0

            with (
                patch.object(api_server, "OUTPUTS", outputs),
                patch.object(api_server, "DATA_DIR", root / "data"),
                patch.object(gallery_store, "DATA_DIR", root / "data"),
                patch.object(gallery_store, "GALLERY_PATH", root / "data" / "gallery.json"),
                patch.object(api_server.GENERATION_WORKER, "generate", side_effect=generate),
                patch.object(api_server.flux2, "model_dir_for", return_value=root / "model"),
                patch.object(api_server.storage_manager, "cleanup_cache"),
                patch.dict(api_server.FLUX_JOB, {"id": "test", "threadId": "original", "status": "running", "logs": [], "output": None, "startedAt": None, "finishedAt": None, "error": None}, clear=True),
            ):
                payload = api_server.validate_flux_payload({"prompt": "reference test", "thread_id": "original", "batch_size": 2, "reference_image": source})
                api_server.run_flux_generation("test", payload, threading.Event())
                self.assertEqual(api_server.flux_job_snapshot()["status"], "complete")
                with patch.object(gallery_store, "_read_unlocked", wraps=gallery_store._read_unlocked) as read:
                    images = api_server.latest_images()
                    self.assertEqual(read.call_count, 1, "Gallery metadata must be read once per listing, not once per image")
                self.assertEqual(len(images), 2)
                for image in images:
                    self.assertTrue(image["referenceUsed"])
                    self.assertEqual(image["threadId"], "original")
                    reference = root / "data" / "references" / image["referenceUrl"].split("/")[-1]
                    self.assertEqual(reference.read_bytes(), raw)


if __name__ == "__main__":
    unittest.main()
