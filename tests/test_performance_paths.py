"""Regression checks for warm inference and cheap status polling."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import api_server
import gallery_store
from tts_generation_worker import TtsGenerationWorker


class PerformancePathsTest(unittest.TestCase):
    def test_tts_process_is_reused_for_same_model_and_restarted_for_another(self):
        script = (
            "import json,os,sys\n"
            "count=0\n"
            "for line in sys.stdin:\n"
            "  count+=1\n"
            "  print('FERN_TTS_EVENT:'+json.dumps({'url':'/test.wav','count':count,'pid':os.getpid()}),flush=True)\n"
        )
        worker = TtsGenerationWorker()
        try:
            args = dict(command=[sys.executable, "-u", "-c", script], request={"text": "test"},
                        cwd=Path.cwd(), env=os.environ.copy(), log=lambda _: None)
            first = worker.generate(key=("custom-0.6b", "CPU"), **args)
            second = worker.generate(key=("custom-0.6b", "CPU"), **args)
            changed = worker.generate(key=("custom-1.7b", "CPU"), **args)
            self.assertEqual((first["count"], second["count"], changed["count"]), (1, 2, 1))
            self.assertEqual(first["pid"], second["pid"])
            self.assertNotEqual(first["pid"], changed["pid"])
        finally:
            worker.close()

    def test_image_listing_reuses_cache_and_detects_new_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            outputs = root / "outputs"
            outputs.mkdir()
            metadata_path = root / "gallery.json"
            (outputs / "first.png").write_bytes(b"png")
            with patch.object(api_server, "OUTPUTS", outputs), patch.object(gallery_store, "GALLERY_PATH", metadata_path), \
                 patch.object(gallery_store, "metadata_snapshot", return_value={}) as metadata:
                api_server.IMAGE_LIST_CACHE.update(key=None, checkedAt=0.0, records=[])
                self.assertEqual(len(api_server.latest_images()), 1)
                self.assertEqual(len(api_server.latest_images()), 1)
                self.assertEqual(metadata.call_count, 1)
                (outputs / "second.png").write_bytes(b"png")
                os.utime(outputs, ns=(outputs.stat().st_atime_ns, outputs.stat().st_mtime_ns + 1_000_000_000))
                self.assertEqual(len(api_server.latest_images()), 2)
                self.assertEqual(metadata.call_count, 2)
        api_server.IMAGE_LIST_CACHE.update(key=None, checkedAt=0.0, records=[])

    def test_tts_worker_releases_idle_model(self):
        script = (
            "import json,sys\n"
            "count=0\n"
            "for line in sys.stdin:\n"
            "  count+=1\n"
            "  print('FERN_TTS_EVENT:'+json.dumps({'url':'/test.wav','count':count}),flush=True)\n"
        )
        worker = TtsGenerationWorker(idle_timeout_seconds=0.1)
        try:
            args = dict(key=("custom-0.6b", "CPU"), command=[sys.executable, "-u", "-c", script],
                        request={}, cwd=Path.cwd(), env=os.environ.copy(), log=lambda _: None)
            self.assertEqual(worker.generate(**args)["count"], 1)
            time.sleep(0.2)
            self.assertEqual(worker.generate(**args)["count"], 1)
        finally:
            worker.close()

    def test_api_generation_uses_persistent_worker(self):
        with api_server.TTS_JOB_LOCK:
            before = dict(api_server.TTS_JOB)
            api_server.TTS_JOB.update(id="perf-test", status="running", output=None, error=None)
        try:
            with patch.object(api_server.TTS_GENERATION_WORKER, "generate", return_value={"url": "/outputs/test.wav", "name": "test.wav"}) as generate:
                api_server.run_tts_generation({"model": "custom-0.6b", "device": "CPU", "text": "Hello"}, "perf-test")
            self.assertEqual(generate.call_args.kwargs["key"], ("custom-0.6b", "CPU"))
            self.assertIn("serve", generate.call_args.kwargs["command"])
            self.assertEqual(api_server.TTS_JOB["status"], "complete")
        finally:
            with api_server.TTS_JOB_LOCK:
                api_server.TTS_JOB.clear()
                api_server.TTS_JOB.update(before)

    def test_closing_tts_worker_interrupts_active_inference(self):
        script = "import sys,time\nfor line in sys.stdin: time.sleep(30)\n"
        worker = TtsGenerationWorker()
        failures: list[Exception] = []
        def run():
            try:
                worker.generate(key=("custom-0.6b", "CPU"), command=[sys.executable, "-u", "-c", script],
                                request={}, cwd=Path.cwd(), env=os.environ.copy(), log=lambda _: None)
            except Exception as error:
                failures.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 2
        while worker._process is None and time.monotonic() < deadline:
            time.sleep(0.01)
        worker.close()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive(), "Closing the app should not wait for inference to finish.")
        self.assertTrue(failures)

    def test_stop_interrupts_active_tts_inference_without_request_lock(self):
        script = "import sys,time\nfor line in sys.stdin: time.sleep(30)\n"
        worker = TtsGenerationWorker()
        failures: list[Exception] = []
        def run():
            try:
                worker.generate(key=("custom-0.6b", "CPU"), command=[sys.executable, "-u", "-c", script],
                                request={}, cwd=Path.cwd(), env=os.environ.copy(), log=lambda _: None)
            except Exception as error:
                failures.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 2
        while worker._process is None and time.monotonic() < deadline:
            time.sleep(0.01)
        try:
            worker.interrupt()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive(), "Stop should release a blocked inference read.")
            self.assertTrue(failures)
        finally:
            worker.close()



if __name__ == "__main__":
    unittest.main()
