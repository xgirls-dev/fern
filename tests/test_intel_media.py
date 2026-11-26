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
from intel_media import IntelMedia, VIDEO_ID, verify_vulkan_residency
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

    def test_video_completion_is_persistent_and_removable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = Mock()

            def render(request, stage, event, progress):
                self.assertEqual(request["frames"], 161)
                source = stage / "video.webm"
                source.write_bytes(b"rendered")
                return source, 25.41

            runtime.generate_video.side_effect = render
            jobs = VideoJobs(runtime, root / "cache", root / "data", root / "outputs")
            job = jobs.start({"prompt": "A fox turns.", "seed": 42, "frames": 161,
                              "reference": Image.new("RGB", (8, 8))}, lambda: None)
            # Join the thread captured at admission, if it has not already finished.
            with jobs.lock:
                worker = jobs.worker
            if worker:
                worker.join(timeout=5)
            self.assertEqual(jobs.snapshot()["status"], "complete")
            restored = VideoJobs(runtime, root / "cache", root / "data", root / "outputs")
            record, = restored.history()
            self.assertEqual(record["id"], job["id"])
            self.assertEqual((record["frames"], record["duration"]), (161, 161 / 16))
            self.assertEqual(record["device"], "INTEL_GPU")
            restored.remove(record["id"])
            self.assertEqual(restored.history(), [])

    def test_video_publication_recovers_after_any_interrupted_move(self):
        replace = Path.replace
        for destination in ("outputs", "references", "videos"):
            with self.subTest(destination=destination), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                runtime = Mock()

                def render(request, stage, event, progress):
                    source = stage / "render.webm"
                    source.write_bytes(b"rendered")
                    return source, 25.41

                def interrupt(source, target):
                    if target.parent.name == destination:
                        raise OSError("Publication interrupted")
                    return replace(source, target)

                runtime.generate_video.side_effect = render
                paths = (root / "cache", root / "data", root / "outputs")
                jobs = VideoJobs(runtime, *paths)
                request = {"prompt": "A fox turns.", "seed": 42, "frames": 65, "reference": Image.new("RGB", (8, 8))}
                with patch.object(Path, "replace", interrupt):
                    job = jobs.start(request, lambda: None)
                    with jobs.lock:
                        worker = jobs.worker
                    if worker:
                        worker.join(timeout=5)
                self.assertEqual(jobs.snapshot()["status"], "failed")
                self.assertEqual(jobs.history(), [])

                restored = VideoJobs(runtime, *paths)
                record, = restored.history()
                self.assertEqual(record["id"], job["id"])
                self.assertEqual(record["prompt"], request["prompt"])
                self.assertEqual((record["frames"], record["duration"]), (65, 65 / 16))
                self.assertEqual((root / "outputs" / record["name"]).read_bytes(), b"rendered")
                with Image.open(root / "data" / record["posterUrl"].lstrip("/")) as poster:
                    self.assertEqual(poster.size, (8, 8))
                self.assertFalse((root / "cache" / f"video-{job['id']}").exists())
                self.assertEqual(VideoJobs(runtime, *paths).history(), [record])

    def test_video_cancellation_does_not_publish_staging_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = Mock()
            started = threading.Event()

            def render(request, stage, event, progress):
                self.assertEqual(request["frames"], 21)
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

    def test_video_advertises_and_validates_its_duration_choices(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = IntelMedia(root)
            spec = runtime.status(VIDEO_ID, "AUTO")["videoFormat"]
            self.assertEqual(spec, {"width": 544, "height": 704, "fps": 16, "defaultFrames": 21,
                                    "frameOptions": [21, 65, 81, 97, 113, 129, 145, 161]})
            jobs = VideoJobs(runtime, root / "cache", root / "data", root / "outputs")
            for frames in (True, None, "65", 64, 165):
                with self.subTest(frames=frames), self.assertRaisesRegex(ValueError, "video durations"):
                    jobs.start({"frames": frames}, Mock())
            self.assertFalse(jobs.running())

    def test_video_runtime_receives_long_frame_count_without_a_fixed_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            runtime = IntelMedia(stage)
            runtime.arguments = Mock(return_value=[])

            def render(command, event, log, *, cwd, timeout, update):
                self.assertEqual(command[command.index("--video-frames") + 1], "161")
                self.assertEqual(command[command.index("--fps") + 1], "16")
                self.assertIsNone(timeout)
                content = "total params memory size = 6393.71MB (VRAM 6393.71MB, RAM 0.00MB)\n"
                for entry in ("  |==> | 1/4 - unrelated\n", "[V] sample 34x44x41\n  |==> | 1/4 - 17s/it\n",
                              "[V] decode_video_outputs latent 34x44x41x48\n", "generate_video completed\n"):
                    content += entry
                    log.write_text(content, encoding="utf-8")
                    update(log)
                (stage / "video.webm").write_bytes(b"\x1a\x45\xdf\xa3")
                return content + "decoded 544x704x161x3"

            request = {"prompt": "A fox turns.", "seed": 42, "frames": 161,
                       "reference": Image.new("RGB", (8, 8))}
            log = Mock()
            with patch("intel_media.run_process", side_effect=render):
                output, _elapsed = runtime.generate_video(request, stage, threading.Event(), log)
            self.assertEqual(output, stage / "video.webm")
            self.assertEqual([call.args[0] for call in log.call_args_list], [
                "Loading Wan 2.2 on Intel GPU…", "Generating frames on Intel GPU…",
                "Generating frames on Intel GPU… Step 1 of 4 complete", "Decoding the clip…", "Writing WebM…",
            ])

    def test_video_recovery_ignores_uncommitted_and_invalid_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            for name, metadata in (
                ("video-1234567890123-abcdef00", "video.json"),
                ("video-1234567890123-abcdef01", "publish.json"),
            ):
                stage = cache / name
                stage.mkdir(parents=True)
                (stage / "video.webm").write_bytes(b"private")
                (stage / metadata).write_text("{}", encoding="utf-8")
            jobs = VideoJobs(Mock(), cache, root / "data", root / "outputs")
            self.assertEqual(jobs.history(), [])
            self.assertEqual(len(list(cache.glob("video-*/video.webm"))), 2)
            self.assertFalse((root / "outputs").exists())
