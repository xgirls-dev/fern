import sys
import time
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from generation_worker import GenerationWorker, GenerationCancelled
import api_server
import gallery_store


def stalled_inference(connection):
    count = 0
    while True:
        request = connection.recv()
        count += 1
        if request.get("stall"):
            connection.send(("log", "Inside an uninterruptible model operation"))
            time.sleep(120)
        connection.send(("result", (f"image-{count}.png", 1.0)))


class GenerationLifecycleTests(unittest.TestCase):
    def test_cancelled_result_is_not_published_to_gallery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = root / "outputs"
            outputs.mkdir()
            cancel = threading.Event()
            def finish_at_cancel(**request):
                image = request["output_dir"] / "cancelled.png"
                image.write_bytes(b"unpublished fixture")
                cancel.set()
                return image, 1.0
            with patch.object(api_server, "CACHE_DIR", root / "cache"), patch.object(api_server, "OUTPUTS", outputs), patch.object(api_server.GENERATION_WORKER, "generate", side_effect=finish_at_cancel), patch.dict(api_server.FLUX_JOB, {"status": "running", "logs": []}):
                payload = api_server.validate_flux_payload({"prompt": "fixture", "device": "CPU"})
                api_server.run_flux_generation("cancel-race", payload, cancel)
                self.assertEqual(api_server.flux_job_snapshot()["status"], "cancelled")
                self.assertEqual(list(outputs.iterdir()), [])
                self.assertEqual(list((root / "cache").iterdir()), [])

    def test_stop_interrupts_callback_free_work_and_worker_restarts_then_reuses(self):
        worker = GenerationWorker(target=stalled_inference)
        self.assertIsNone(worker.process, "Startup must not load an inference worker")
        cancel = threading.Event()
        started = threading.Event()
        outcome = []
        def generate():
            try:
                worker.generate(cancel_event=cancel, log=lambda _: started.set(), stall=True)
            except GenerationCancelled:
                outcome.append("cancelled")
        server = ThreadingHTTPServer(("127.0.0.1", 0), api_server.Handler)
        serving = threading.Thread(target=server.serve_forever, daemon=True)
        serving.start()
        try:
            with patch.object(api_server, "FLUX_CANCEL_EVENT", cancel), patch.dict(api_server.FLUX_JOB, {"status": "running"}):
                task = threading.Thread(target=generate)
                task.start()
                self.assertTrue(started.wait(15))
                before = time.monotonic()
                base = f"http://127.0.0.1:{server.server_port}"
                self.assertEqual(urllib.request.urlopen(base + "/api/health").status, 200)
                self.assertEqual(urllib.request.urlopen(urllib.request.Request(base + "/api/flux2/stop", method="POST")).status, 202)
                task.join(5)
                self.assertEqual(outcome, ["cancelled"])
                self.assertLess(time.monotonic() - before, 5)
                self.assertIsNone(worker.process)
            first = worker.generate(cancel_event=threading.Event(), log=lambda _: None)
            process = worker.process.pid
            second = worker.generate(cancel_event=threading.Event(), log=lambda _: None)
            self.assertEqual(first[0].name, "image-1.png")
            self.assertEqual(second[0].name, "image-2.png")
            self.assertEqual(worker.process.pid, process)
        finally:
            worker.close()
            server.shutdown()
            server.server_close()

    def test_thread_deletion_removes_owned_assets_and_records_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = root / "outputs"
            references = root / "data" / "references"
            outputs.mkdir()
            references.mkdir(parents=True)
            with patch.object(api_server, "OUTPUTS", outputs), patch.object(api_server, "DATA_DIR", root / "data"), patch.object(gallery_store, "DATA_DIR", root / "data"), patch.object(gallery_store, "GALLERY_PATH", root / "data" / "gallery.json"):
                for name, owner in [("owned.png", "a"), ("other.png", "b")]:
                    (outputs / name).write_bytes(b"fixture")
                    gallery_store.save_image_metadata(name, {"threadId": owner, "prompt": "private prompt", "seed": 1})
                (references / "owned.png.jpg").write_bytes(b"reference")
                self.assertEqual(api_server.delete_thread_assets("a", ["other.png"]), ["owned.png"])
                self.assertFalse((outputs / "owned.png").exists())
                self.assertFalse((references / "owned.png.jpg").exists())
                self.assertIsNone(gallery_store.get_image_metadata("owned.png"))
                self.assertTrue((outputs / "other.png").exists())
                with self.assertRaises(ValueError):
                    api_server.delete_thread_assets("a", ["../outside.png"])


if __name__ == "__main__":
    unittest.main()
