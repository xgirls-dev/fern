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
