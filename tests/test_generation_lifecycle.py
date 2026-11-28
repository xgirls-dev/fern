import sys
import errno
import time
import tempfile
import threading
import unittest
import urllib.request
import uuid
import wave
import json
from pathlib import Path
from unittest.mock import Mock, patch
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from generation_worker import GenerationWorker, GenerationCancelled
import api_server
import gallery_store


def stalled_inference(connection):
    count = 0
    while True:
        try:
            request = connection.recv()
        except EOFError:
            return
        count += 1
        if request.get("stall"):
            connection.send(("log", "Inside an uninterruptible model operation"))
            time.sleep(120)
        connection.send(("result", (f"image-{count}.png", 1.0)))


def inference_with_exit_marker(connection):
    request = connection.recv()
    connection.send(("result", ("image.png", 1.0)))
    try:
        connection.recv()
    except EOFError:
        Path(request["marker"]).touch()


class GenerationLifecycleTests(unittest.TestCase):
    def test_idle_worker_releases_its_runtime_before_close_returns(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "released"
            worker = GenerationWorker(target=inference_with_exit_marker)
            self.addCleanup(worker.close)
            worker.generate(cancel_event=threading.Event(), log=lambda _: None, marker=marker)
            worker.close()
            self.assertTrue(marker.exists())
            self.assertIsNone(worker.process)
            self.assertIsNone(worker.connection)

    def test_shutdown_keeps_a_live_worker_handle_until_it_can_be_reaped(self):
        worker = GenerationWorker()
        process = worker.process = Mock()
        connection = worker.connection = Mock()
        process.is_alive.return_value = True
        with self.assertRaisesRegex(RuntimeError, "still releasing GPU resources"):
            worker.close()
        connection.close.assert_called_once()
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        process.close.assert_not_called()
        self.assertIs(worker.process, process)
        self.assertIsNone(worker.connection)

        process.is_alive.return_value = False
        worker.close()
        process.close.assert_called_once()
        self.assertIsNone(worker.process)

    def test_gpu_handoff_waits_for_exit_after_the_normal_kill_timeout(self):
        worker = GenerationWorker()
        process = worker.process = Mock()
        clock = 0.0
        killed_at = None

        def kill():
            nonlocal killed_at
            killed_at = clock

        def join(*, timeout):
            nonlocal clock
            clock += timeout

        process.kill.side_effect = kill
        process.join.side_effect = join
        process.is_alive.side_effect = lambda: killed_at is None or clock - killed_at < 6
        with patch("generation_worker.monotonic", side_effect=lambda: clock):
            worker.close(cancel_event=threading.Event())
        process.kill.assert_called_once()
        process.close.assert_called_once()
        self.assertIsNone(worker.process)

    def test_gpu_handoff_cancellation_keeps_the_worker_tracked(self):
        worker = GenerationWorker()
        process = worker.process = Mock()
        connection = worker.connection = Mock()
        cancel = threading.Event()
        process.is_alive.return_value = True
        process.join.side_effect = lambda **_: cancel.set()

        with self.assertRaises(InterruptedError):
            worker.close(cancel_event=cancel)
        process.join.assert_called_once()
        connection.close.assert_called_once()
        process.close.assert_not_called()
        self.assertIs(worker.process, process)
        self.assertIsNone(worker.connection)

        process.is_alive.return_value = False
        worker.close()
        process.close.assert_called_once()
        self.assertIsNone(worker.process)

    def test_apple_chat_can_stop_during_the_image_handoff(self):
        job_id = "apple-chat-after-image"
        cancel = threading.Event()
        with (
            patch.object(api_server, "apple_silicon", return_value=True),
            patch.object(api_server.INTEL_MEDIA, "close"),
            patch.object(api_server.GENERATION_WORKER, "process", Mock()),
            patch.object(api_server.GENERATION_WORKER, "close", side_effect=InterruptedError) as release,
            patch.object(api_server.TEXT_GENERATION_WORKER, "generate") as generate,
            patch.object(api_server, "append_text_event") as phase,
            patch.object(api_server, "finish_text_job") as finish,
            patch.dict(api_server.TEXT_JOB, {"id": job_id, "status": "running"}),
        ):
            api_server.run_text_generation({"device": "GPU"}, job_id, cancel)
        phase.assert_called_once_with(job_id, phase="Releasing the image model…")
        release.assert_called_once_with(cancel_event=cancel)
        generate.assert_not_called()
        self.assertEqual(finish.call_args.kwargs["status"], "stopped")
        self.assertIsNone(finish.call_args.kwargs["error"])

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
            def save_complete(**kwargs):
                with wave.open(str(outputs / kwargs["request"]["outputName"]), "wb") as audio:
                    audio.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
                    audio.writeframes(bytes(48000))
            server = ThreadingHTTPServer(("127.0.0.1", 0), api_server.Handler)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            with api_server.TTS_JOB_LOCK:
                previous = dict(api_server.TTS_JOB)
                previous["logs"] = list(api_server.TTS_JOB["logs"])
            previous_cancel = api_server.TTS_CANCEL_EVENT
            base = f"http://127.0.0.1:{server.server_port}"
            def post(path, **extra):
                body = json.dumps({"model": "custom-0.6b", "threadId": "test-audio", "text": "Hello", "device": "CPU", **extra}).encode()
                return json.load(urllib.request.urlopen(urllib.request.Request(base + path, data=body, headers={"Content-Type": "application/json"})))
            try:
                with patch.object(api_server, "OUTPUTS", outputs), patch.object(api_server, "tts_model_ready", return_value=True), patch.object(api_server.TTS_GENERATION_WORKER, "generate", side_effect=generate), patch.object(api_server.TTS_GENERATION_WORKER, "interrupt", side_effect=interrupted.set), patch.object(api_server.TTS_GENERATION_WORKER, "close"):
                    first = str(uuid.uuid4())
                    self.assertEqual(post("/api/tts/generate", requestId=first)["job"]["id"], first)
                    self.assertTrue(started.wait(5))
                    with self.assertRaises(urllib.error.HTTPError) as duplicate:
                        post("/api/tts/generate", requestId=first)
                    self.assertEqual(duplicate.exception.code, 409)
                    duplicate.exception.close()
                    self.assertIsNone(json.load(urllib.request.urlopen(base + f"/api/tts/result?jobId={first}"))["output"])
                    with self.assertRaises(urllib.error.HTTPError) as stale_stop:
                        post("/api/tts/stop", jobId="previous")
                    self.assertEqual(stale_stop.exception.code, 409)
                    stale_stop.exception.close()
                    self.assertFalse(interrupted.is_set())
                    self.assertIn(post("/api/tts/stop", jobId=first)["job"]["status"], ("stopping", "stopped"))
                    for _ in range(50):
                        status = json.load(urllib.request.urlopen(base + "/api/tts/status"))
                        if status["status"] == "stopped":
                            break
                        time.sleep(0.02)
                    self.assertEqual(status["id"], first)
                    self.assertEqual(status["status"], "stopped")
                    self.assertEqual(status["phase"], "Audio job stopped.")
                    self.assertTrue(status["logs"][-1].endswith("Audio job stopped."))
                    self.assertEqual(status["output"], None)
                    self.assertFalse((outputs / f"qwen3-tts-{first}.wav").exists())
                    self.assertFalse(list(outputs.glob(".speech-*")))
                    with patch.object(api_server.TTS_GENERATION_WORKER, "generate", side_effect=save_complete) as completed:
                        second = post("/api/tts/generate")["job"]["id"]
                        for _ in range(50):
                            status = json.load(urllib.request.urlopen(base + "/api/tts/status"))
                            if status["status"] == "complete":
                                break
                            time.sleep(0.02)
                        self.assertEqual(status["id"], second)
                        self.assertEqual(status["status"], "complete")
                        completed.assert_called_once()
                    with api_server.TTS_JOB_LOCK:
                        api_server.TTS_JOB.update(id=None, status="idle", output=None)
                    result = json.load(urllib.request.urlopen(base + f"/api/tts/result?jobId={second}"))["output"]
                    self.assertEqual(result["name"], f"qwen3-tts-{second}.wav")
                    self.assertEqual(result["sampleRate"], 24000)
                    self.assertEqual(result["duration"], 1)
                    with self.assertRaises(urllib.error.HTTPError) as published:
                        post("/api/tts/generate", requestId=second)
                    self.assertEqual(published.exception.code, 409)
                    published.exception.close()
                    target = outputs / result["name"]
                    data = target.read_bytes()
                    target.write_bytes(data[:-1])
                    self.assertIsNone(json.load(urllib.request.urlopen(base + f"/api/tts/result?jobId={second}"))["output"])
                    target.unlink()
                    self.assertIsNone(json.load(urllib.request.urlopen(base + f"/api/tts/result?jobId={second}"))["output"])
            finally:
                server.shutdown()
                server.server_close()
                with api_server.TTS_JOB_LOCK:
                    api_server.TTS_JOB.clear()
                    api_server.TTS_JOB.update(previous)
                api_server.TTS_CANCEL_EVENT = previous_cancel

    def test_tts_reports_low_disk_without_publishing_a_take(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs = Path(directory)
            with (
                patch.object(api_server, "OUTPUTS", outputs),
                patch.dict(api_server.TTS_JOB, id="low-disk", status="running", logs=[], diagnostics=[], output=None),
                patch.object(api_server.tempfile, "TemporaryDirectory", side_effect=OSError(errno.ENOSPC, "Disk full")),
                patch.object(api_server.TTS_GENERATION_WORKER, "generate") as generate,
            ):
                api_server.run_tts_generation({"model": "custom-0.6b", "device": "CPU", "text": "Hello"}, "low-disk")
                self.assertEqual(api_server.TTS_JOB["status"], "failed")
                self.assertIn("Free up disk space", api_server.TTS_JOB["error"])
                self.assertIsNone(api_server.TTS_JOB["output"])
                self.assertEqual(list(outputs.iterdir()), [])
                generate.assert_not_called()

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
