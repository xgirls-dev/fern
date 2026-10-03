import sys
import time
import tempfile
import threading
import unittest
import urllib.request
import json
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
    def test_tts_stop_discards_partial_wav_and_allows_next_job(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs = Path(directory)
            started = threading.Event()
            interrupted = threading.Event()
            def generate(**kwargs):
                name = kwargs["request"]["outputName"]
                (outputs / name).write_bytes(b"partial wav")
                started.set()
                interrupted.wait(5)
                return {"name": name, "url": f"/outputs/{name}", "duration": 1, "sampleRate": 24000}
            server = ThreadingHTTPServer(("127.0.0.1", 0), api_server.Handler)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            with api_server.TTS_JOB_LOCK:
                previous = dict(api_server.TTS_JOB)
                previous["logs"] = list(api_server.TTS_JOB["logs"])
            previous_cancel = api_server.TTS_CANCEL_EVENT
            base = f"http://127.0.0.1:{server.server_port}"
            def post(path):
                body = json.dumps({"model": "custom-0.6b", "threadId": "test-audio", "text": "Hello", "device": "CPU"}).encode()
                return json.load(urllib.request.urlopen(urllib.request.Request(base + path, data=body, headers={"Content-Type": "application/json"})))
            try:
                with patch.object(api_server, "OUTPUTS", outputs), patch.object(api_server, "tts_model_ready", return_value=True), patch.object(api_server.TTS_GENERATION_WORKER, "generate", side_effect=generate), patch.object(api_server.TTS_GENERATION_WORKER, "interrupt", side_effect=interrupted.set), patch.object(api_server.TTS_GENERATION_WORKER, "close"):
                    first = post("/api/tts/generate")["job"]["id"]
                    self.assertTrue(started.wait(5))
                    self.assertIn(post("/api/tts/stop")["job"]["status"], ("stopping", "stopped"))
                    for _ in range(50):
                        status = json.load(urllib.request.urlopen(base + "/api/tts/status"))
                        if status["status"] == "stopped":
                            break
                        time.sleep(0.02)
                    self.assertEqual(status["id"], first)
                    self.assertEqual(status["status"], "stopped")
                    self.assertEqual(status["output"], None)
                    self.assertFalse((outputs / f"qwen3-tts-{first}.wav").exists())
                    with patch.object(api_server.TTS_GENERATION_WORKER, "generate", return_value={"name": "second.wav", "url": "/outputs/second.wav", "duration": 1, "sampleRate": 24000}):
                        second = post("/api/tts/generate")["job"]["id"]
                        for _ in range(50):
                            status = json.load(urllib.request.urlopen(base + "/api/tts/status"))
                            if status["status"] == "complete":
                                break
                            time.sleep(0.02)
                        self.assertEqual(status["id"], second)
                        self.assertEqual(status["status"], "complete")
            finally:
                server.shutdown()
                server.server_close()
                with api_server.TTS_JOB_LOCK:
                    api_server.TTS_JOB.clear()
                    api_server.TTS_JOB.update(previous)
                api_server.TTS_CANCEL_EVENT = previous_cancel

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
