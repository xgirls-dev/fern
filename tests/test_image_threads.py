from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import api_server
import gallery_store


class ImageThreadTests(unittest.TestCase):
    def test_thread_id_validation_and_legacy_requests(self) -> None:
        self.assertIsNone(api_server.validate_flux_payload({"prompt": "A forest"})["thread_id"])
        self.assertEqual(
            api_server.validate_flux_payload({"prompt": "A forest", "thread_id": "thread-abc_123"})["thread_id"],
            "thread-abc_123",
        )
        for value in ("", "../other", "line\nbreak", "x" * 129, {}, 7):
            with self.subTest(value=value), self.assertRaises(ValueError):
                api_server.validate_flux_payload({"prompt": "A forest", "thread_id": value})

    def test_batch_outputs_keep_the_originating_thread_after_later_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = root / "outputs"
            outputs.mkdir()
            sequence = 0

            def generate_stub(**_kwargs):
                nonlocal sequence
                sequence += 1
                path = outputs / f"render-{sequence}.png"
                path.write_bytes(b"fixture output")
                return path, 1.0

            with (
                patch.object(api_server, "OUTPUTS", outputs),
                patch.object(gallery_store, "DATA_DIR", root / "data"),
                patch.object(gallery_store, "GALLERY_PATH", root / "data" / "gallery.json"),
                patch.object(api_server.flux2, "generate_image", side_effect=generate_stub),
                patch.object(api_server.flux2, "model_dir_for", return_value=root / "model"),
                patch.object(api_server.storage_manager, "cleanup_cache"),
                patch.dict(api_server.FLUX_JOB, {"id": None, "threadId": None, "status": "idle", "logs": [], "startedAt": None, "finishedAt": None, "output": None, "error": None}, clear=True),
            ):
                for thread_id, batch_size in (("thread-a", 2), ("thread-b", 1)):
                    payload = api_server.validate_flux_payload({"prompt": thread_id, "thread_id": thread_id, "batch_size": batch_size})
                    api_server.mark_flux_job(id=thread_id, threadId=thread_id, status="running")
                    api_server.run_flux_generation(thread_id, payload, threading.Event())
                    self.assertEqual(api_server.flux_job_snapshot()["status"], "complete")
                    self.assertEqual(api_server.flux_job_snapshot()["output"]["threadId"], thread_id)

                # Read persisted gallery metadata again, independently of the last job.
                records = {record["name"]: record for record in api_server.latest_images()}
                self.assertEqual(records["render-1.png"]["threadId"], "thread-a")
                self.assertEqual(records["render-2.png"]["threadId"], "thread-a")
                self.assertEqual(records["render-3.png"]["threadId"], "thread-b")
                self.assertEqual(api_server.flux_job_snapshot()["threadId"], "thread-b")


if __name__ == "__main__":
    unittest.main()
