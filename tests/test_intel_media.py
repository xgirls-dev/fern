import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from PIL import Image

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from intel_media import verify_vulkan_residency
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
