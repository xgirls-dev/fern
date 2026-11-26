import base64
from io import BytesIO
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from intel_media import IntelMedia, Z_IMAGE_ID, verify_vulkan_residency
from model_catalog import INTEL_MEDIA_CATALOG
from video_jobs import VideoJobs


class IntelMediaTests(unittest.TestCase):
    def test_vulkan_requires_gpu_weights(self):
        verify_vulkan_residency("total params memory size = 6393.71MB (VRAM 6393.71MB, RAM 0.00MB)")
        for placement in (
            "total params memory size = 15MB (VRAM 5MB, RAM 10MB)",
            "total params memory size = 0MB (VRAM 0MB, RAM 0MB)",
            "backend could not load",
        ):
            with self.assertRaisesRegex(RuntimeError, "keep all model weights"):
                verify_vulkan_residency(placement)

    def test_kromoss_requires_the_complete_pinned_adapter_for_each_render(self):
        model = "kromoss-opd-dmd2"
        preset = INTEL_MEDIA_CATALOG[model]["preset"]["lora"]
        adapter = {"path": Path(preset["path"]).name, "multiplier": preset["strength"]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = IntelMedia(root)
            worker.server = Mock()
            worker.server.poll.return_value = None
            worker.server_model = model
            worker.server_adapter = adapter
            worker.server_log = root / "server.log"
            worker.server_log.write_text("", encoding="utf-8")
            image = BytesIO()
            Image.new("RGB", (640, 768)).save(image, format="PNG")
            response = {"images": [base64.b64encode(image.getvalue()).decode("ascii")]}
            def render_with(count):
                def request(endpoint, settings, timeout):
                    self.assertEqual(endpoint, "/sdapi/v1/txt2img")
                    self.assertIsNone(timeout, "Production renders must not have a socket deadline")
                    self.assertEqual((settings["width"], settings["height"], settings["steps"]), (640, 768, 12))
                    self.assertEqual(settings["lora"], [adapter])
                    with worker.server_log.open("a", encoding="utf-8") as log:
                        log.write(f"({count} / 756) LoRA tensors have been applied\n")
                    return response
                return request
            request = {"model": model, "prompt": "A fox.", "seed": 1,
                       "width": 640, "height": 768, "guidance": 1.0, "steps": 12}
            event = threading.Event()
            with patch("intel_media.threading.Timer"):
                worker.request = render_with(756)
                worker.generate_image(request, root / "complete.png", event, Mock())
                self.assertTrue((root / "complete.png").is_file())
                worker.request = render_with(755)
                with self.assertRaisesRegex(RuntimeError, "did not apply completely"):
                    worker.generate_image(request, root / "incomplete.png", event, Mock())
                self.assertFalse((root / "incomplete.png").exists())

    def test_z_image_reuses_the_server_for_strength_changes_and_rejects_partial_loras(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = IntelMedia(root)
            worker.arguments = Mock(return_value=[])
            first = root / "first.safetensors"
            first.write_bytes(b"adapter weights")
            disabled = root / "disabled.safetensors"
            image = BytesIO()
            Image.new("RGB", (512, 512)).save(image, format="PNG")
            response = {"images": [base64.b64encode(image.getvalue()).decode("ascii")]}
            spawned = []
            submitted = []
            counts = "(24 / 24)"

            def spawn(arguments, *, stdout, **kwargs):
                if "--lora-model-dir" in arguments:
                    prepared = Path(arguments[arguments.index("--lora-model-dir") + 1])
                    self.assertEqual((prepared / "adapter-1.safetensors").read_bytes(), first.read_bytes())
                    self.assertEqual(len(list(prepared.iterdir())), 1)
                stdout.write(b"total params memory size = 100MB (VRAM 100MB, RAM 0.00MB)\n")
                stdout.flush()
                process = Mock()
                process.poll.return_value = None
                spawned.append(process)
                return process

            def request(endpoint, settings=None, timeout=3):
                if endpoint == "/sdcpp/v1/capabilities":
                    return {}
                if endpoint == "/sdapi/v1/loras":
                    return [{"path": "adapter-1.safetensors"}]
                self.assertEqual(endpoint, "/sdapi/v1/txt2img")
                submitted.append(settings.get("lora"))
                with worker.server_log.open("a", encoding="utf-8") as log:
                    log.write(f"{counts} LoRA tensors have been applied\n")
                return response

            worker.request = request
            local = {"path": str(first), "enabled": True, "strength": 0.5}
            payload = {"model": Z_IMAGE_ID, "prompt": "A fox.", "seed": 42, "steps": 8, "guidance": 1,
                       "width": 512, "height": 512, "loras": [local, {"path": str(disabled), "enabled": False, "strength": 1}]}
            event = threading.Event()
            with patch("intel_media.subprocess.Popen", side_effect=spawn), patch("intel_media.threading.Timer"):
                worker.generate_image(payload, root / "first.png", event, Mock())
                local["strength"] = 0.8
                worker.generate_image(payload, root / "warm.png", event, Mock())
                self.assertEqual(len(spawned), 1)
                self.assertEqual(submitted, [[{"path": "adapter-1.safetensors", "multiplier": strength}] for strength in (0.5, 0.8)])
                counts = "(23 / 24)"
                with self.assertRaisesRegex(RuntimeError, "did not apply completely"):
                    worker.generate_image(payload, root / "partial.png", event, Mock())
                self.assertFalse((root / "partial.png").exists())
                self.assertFalse(list((root / ".cache").glob("sd-loras-*")))

    def test_video_completion_is_persistent_and_removable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = Mock()

            def render(request, stage, event, progress):
                source = stage / "video.webm"
                source.write_bytes(b"rendered")
                return source, 25.41

            runtime.generate_video.side_effect = render
            jobs = VideoJobs(runtime, root / "cache", root / "data", root / "outputs")
            job = jobs.start({"prompt": "A fox turns.", "seed": 42, "reference": Image.new("RGB", (8, 8))}, lambda: None)
            # Join the thread captured at admission, if it has not already finished.
            with jobs.lock:
                worker = jobs.worker
            if worker:
                worker.join(timeout=5)
            self.assertEqual(jobs.snapshot()["status"], "complete")
            restored = VideoJobs(runtime, root / "cache", root / "data", root / "outputs")
            record, = restored.history()
            self.assertEqual(record["id"], job["id"])
            self.assertEqual(record["duration"], 21 / 16)
            self.assertEqual(record["device"], "INTEL_GPU")
            restored.remove(record["id"])
            self.assertEqual(restored.history(), [])

    def test_video_cancellation_does_not_publish_staging_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = Mock()
            started = threading.Event()

            def render(request, stage, event, progress):
                source = stage / "video.webm"
                source.write_bytes(b"partial")
                started.set()
                event.wait(timeout=5)
                return source, 0.05

            runtime.generate_video.side_effect = render
            jobs = VideoJobs(runtime, root / "cache", root / "data", root / "outputs")
            jobs.start({"prompt": "A fox turns.", "seed": 42, "reference": Image.new("RGB", (8, 8))}, lambda: None)
            self.assertTrue(started.wait(timeout=3))
            self.assertEqual(jobs.stop()["status"], "stopping")
            jobs.close()
            self.assertEqual(jobs.snapshot()["status"], "cancelled")
            self.assertEqual(jobs.history(), [])
            self.assertFalse(list((root / "outputs").glob("*.webm")))
