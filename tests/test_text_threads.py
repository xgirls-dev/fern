"""Regression coverage for text admission, cancellation and external model safety."""
import base64
import hashlib
import io
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, Mock, patch
from http.server import ThreadingHTTPServer

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import api_server as api
import text_model_download as download
from text_model_registry import TextModelRegistry, REQUIRED_FILES
from text_generation_process import TextGenerationProcess, TextWorkerError
from text_generation_worker import resolve_text_device, run as run_text_worker
from text_model_download import INSTALL_MARKER, MINIMUM_FREE_BYTES, model_spec
from text_model_download import PREPARING_MODEL_FILES, check_download_pause


class TextThreadsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.folder = self.root / "external-model"
        self.folder.mkdir()
        for name in REQUIRED_FILES:
            (self.folder / name).write_text('<net version="11"/>')
        (self.folder / "config.json").write_text(json.dumps({"model_type": "qwen2", "architectures": ["Qwen2ForCausalLM"]}))
        (self.folder / "tokenizer_config.json").write_text(json.dumps({"chat_template": "{{messages}}"}))
        self.registry = TextModelRegistry(self.root / "data" / "models.json")
        self.model = self.registry.add(str(self.folder))

    def tearDown(self):
        self.temp.cleanup()

    def test_registration_is_idempotent_and_never_removes_external_files(self):
        self.assertEqual(self.model["id"], self.registry.add(str(self.folder))["id"])
        self.assertEqual(len(self.registry.snapshot()), 1)
        self.registry.remove(self.model["id"])
        self.assertEqual(self.registry.snapshot(), [])
        self.assertTrue(all((self.folder / name).exists() for name in REQUIRED_FILES))

    def test_missing_and_malformed_exports(self):
        (self.folder / "openvino_detokenizer.xml").unlink()
        self.assertFalse(self.registry.snapshot()[0]["installed"])
        with self.assertRaisesRegex(ValueError, "detokenizer"):
            self.registry.add(str(self.folder))
        (self.folder / "openvino_detokenizer.xml").write_text('<net/>')
        (self.folder / "config.json").write_text('broken')
        self.assertFalse(self.registry.snapshot()[0]["installed"])

    def test_invalid_ir_is_rejected_before_registration(self):
        (self.folder / 'openvino_model.xml').write_text('not XML')
        with self.assertRaisesRegex(ValueError, 'valid OpenVINO IR'):
            self.registry.add(str(self.folder))

    def test_status_never_initializes_native_runtime_in_http_thread(self):
        with patch.object(api, 'TEXT_MODEL_REGISTRY', self.registry), patch.object(api.importlib.util, 'find_spec', return_value=object()):
            self.assertTrue(api.text_runtime_snapshot()['runtimeAvailable'])
        with patch.object(api, 'TEXT_MODEL_REGISTRY', self.registry), patch.object(api.importlib.util, 'find_spec', return_value=None):
            self.assertFalse(api.text_runtime_snapshot()['runtimeAvailable'])

    def test_chat_runtime_only_reports_resident_live_engines(self):
        script = self.root / "engine_fixture.py"
        script.write_text("""import json, subprocess, sys
def emit(**data):
    print("FERN_TEXT_EVENT:" + json.dumps(data), flush=True)

engine = None
try:
    for line in sys.stdin:
        action = json.loads(line)["action"]
        if action == "gguf":
            engine = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
            emit(type="residency", model={"backend": "cpu", "device": "CPU", "enginePid": engine.pid,
                                         "gguf": {"contextSize": 4096, "loadOptions": {"flashAttention": "on"}}})
        elif action == "engine-exit":
            engine.terminate()
            engine.wait()
            engine = None
        else:
            emit(type="residency", model={"backend": "openvino", "device": "GPU"})
        emit(type="result")
finally:
    if engine is not None:
        engine.terminate()
        engine.wait()
""", encoding="utf-8")
        worker = TextGenerationProcess()
        model_id = self.model["id"]

        def generate(action):
            worker.generate(model_path=str(self.folder), device="GPU", command=[sys.executable, "-u", str(script)],
                            request={"action": action, "modelId": model_id}, cwd=self.root, env=dict(os.environ),
                            on_token=lambda _: None, on_phase=lambda _: None)

        try:
            with patch.object(api, "TEXT_GENERATION_WORKER", worker), patch.object(api, "TEXT_MODEL_REGISTRY", self.registry):
                self.assertIsNone(api.text_runtime_snapshot()["residentModel"])
                generate("gguf")
                self.assertEqual(api.text_runtime_snapshot()["residentModel"],
                                 {"modelId": model_id, "backend": "cpu", "device": "CPU",
                                  "gguf": {"contextSize": 4096, "loadOptions": {"flashAttention": "on"}}})
                generate("engine-exit")
                self.assertIsNone(api.text_runtime_snapshot()["residentModel"])
                generate("openvino")
                self.assertEqual(api.text_runtime_snapshot()["residentModel"],
                                 {"modelId": model_id, "backend": "openvino", "device": "GPU"})
                worker.close()
                self.assertIsNone(api.text_runtime_snapshot()["residentModel"])
        finally:
            worker.close()

    def test_openvino_reuses_pipeline_for_system_prompt_and_sampling_changes(self):
        base = {"op": "generate", "messages": [{"role": "user", "content": "Hello."}],
                "systemPrompt": "Keep it short.", "temperature": 0.8, "topP": 0.95, "maxNewTokens": 64}
        follow_up = {**base, "systemPrompt": "Explain the details.", "temperature": 0.25, "topP": 0.8,
                     "maxNewTokens": 120, "sampling": {"topK": 16}}
        stream = io.StringIO("".join(json.dumps(request) + "\n" for request in (base, follow_up, {"op": "shutdown"})))
        pipeline = Mock()
        pipeline.get_generation_config.side_effect = SimpleNamespace
        pipeline.generate.return_value = SimpleNamespace(
            texts=["Done."], perf_metrics=Mock(get_num_input_tokens=Mock(return_value=12), get_num_generated_tokens=Mock(return_value=2)),
        )
        load = Mock(return_value=pipeline)
        with (
            patch.dict(sys.modules, {"openvino_genai": SimpleNamespace(LLMPipeline=load)}),
            patch("text_generation_worker.resolve_text_device", return_value="CPU"),
            patch("text_generation_worker.sys.stdin", stream),
            patch("text_generation_worker.emit") as emit,
        ):
            self.assertEqual(run_text_worker(str(self.folder), "CPU"), 0)
        load.assert_called_once()
        self.assertEqual([call.args[0][0]["content"] for call in pipeline.get_tokenizer.return_value.apply_chat_template.call_args_list],
                         [base["systemPrompt"], follow_up["systemPrompt"]])
        self.assertEqual([call.args[1].temperature for call in pipeline.generate.call_args_list], [0.8, 0.25])
        self.assertEqual([call.args[1].max_new_tokens for call in pipeline.generate.call_args_list], [64, 120])
        self.assertEqual(pipeline.generate.call_args.args[1].top_k, 16)
        self.assertEqual([call.args[0]["type"] for call in emit.call_args_list].count("residency"), 1)

    def test_text_model_status_surfaces_fresh_install_disk_and_companion_requirements(self):
        with patch.object(api, "TEXT_MODEL_REGISTRY", self.registry), patch.object(api, "apple_silicon", return_value=False):
            recommendations = {item["id"]: item for item in api.text_runtime_snapshot()["recommendedModels"]}
        gemma = recommendations["gemma-4-e4b-gguf"]
        self.assertEqual(gemma["bytes"], 5_150_682_240)
        self.assertEqual(gemma["minimumFreeBytes"], gemma["bytes"] + MINIMUM_FREE_BYTES)
        self.assertEqual(gemma["projectorBytes"], 559_874_848)
        self.assertNotIn("projectorBytes", recommendations[api.DEFAULT_TEXT_MODEL_ID])

    def test_managed_removal_and_legacy_unlink_through_the_api(self):
        root = (self.root / "downloads").resolve()
        spec = model_spec(api.DEFAULT_TEXT_MODEL_ID)
        downloaded = root / spec["folder"]
        downloaded.mkdir(parents=True)
        for name in set(REQUIRED_FILES).union(file["path"] for file in spec["files"]):
            source = self.folder / name
            (downloaded / name).write_bytes(source.read_bytes() if source.exists() else b"fixture")
        marker = {"modelId": api.DEFAULT_TEXT_MODEL_ID, "verifiedChecksums": True,
                  **{key: spec[key] for key in ("name", "repo", "revision", "format")}}
        marker_path = downloaded / INSTALL_MARKER
        marker_path.write_text(json.dumps(marker), encoding="utf-8")
        extra = downloaded / "my-notes.txt"
        extra.write_text("Personal notes", encoding="utf-8")
        managed = self.registry.add(str(downloaded))

        with (
            patch.object(api, "TEXT_MODEL_ROOT", root),
            patch.object(api, "TEXT_MODEL_REGISTRY", self.registry),
            patch.object(api, "apple_silicon", return_value=False),
            patch.object(api.TEXT_GENERATION_WORKER, "close") as close_worker,
            ThreadingHTTPServer(("127.0.0.1", 0), api.Handler) as server,
        ):
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}/api/text"

            def remove(model_id, **options):
                request = urllib.request.Request(f"{base}/models/remove",
                    data=json.dumps({"modelId": model_id, **options}).encode(),
                    headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    return json.load(response)

            try:
                with urllib.request.urlopen(f"{base}/status", timeout=5) as response:
                    status = json.load(response)
                self.assertEqual({item["id"]: item["ownership"] for item in status["models"]},
                                 {self.model["id"]: "linked", managed["id"]: "managed"})
                original = next(item for item in status["recommendedModels"] if item["id"] == api.DEFAULT_TEXT_MODEL_ID)
                self.assertEqual(original["repairModelId"], managed["id"])
                with self.assertRaises(urllib.error.HTTPError) as refused:
                    remove(self.model["id"], action="remove-download")
                with refused.exception as response:
                    self.assertEqual(response.code, 400)
                    self.assertIn("could not verify this download", json.load(response)["error"])
                self.assertTrue((self.folder / "openvino_model.bin").is_file())
                marker_path.write_text(json.dumps({**marker, "revision": "0" * 40}), encoding="utf-8")
                with self.assertRaises(urllib.error.HTTPError) as mismatched:
                    remove(managed["id"], action="remove-download")
                with mismatched.exception as response:
                    self.assertEqual(response.code, 400)
                repair = urllib.request.Request(f"{base}/models/install",
                    data=json.dumps({"modelId": api.DEFAULT_TEXT_MODEL_ID, "repair": True}).encode(),
                    headers={"Content-Type": "application/json"})
                with self.assertRaises(urllib.error.HTTPError) as unverified_repair:
                    urllib.request.urlopen(repair, timeout=5)
                with unverified_repair.exception as response:
                    self.assertEqual(response.code, 400)
                    self.assertIn("own verified downloads", json.load(response)["error"])
                self.assertTrue((downloaded / "openvino_model.bin").is_file())
                marker_path.write_text(json.dumps(marker), encoding="utf-8")
                close_worker.reset_mock()
                deleted = remove(managed["id"], action="remove-download")
                close_worker.assert_called_once()
                self.assertEqual([item["id"] for item in deleted["models"]], [self.model["id"]])
                recommendation = next(item for item in deleted["recommendedModels"] if item["id"] == api.DEFAULT_TEXT_MODEL_ID)
                self.assertFalse(recommendation["installed"])
                self.assertEqual(list(downloaded.iterdir()), [extra])
                self.assertEqual(extra.read_text(encoding="utf-8"), "Personal notes")
                self.assertEqual(remove(self.model["id"])["models"], [])
                self.assertTrue(all((self.folder / name).is_file() for name in REQUIRED_FILES))
            finally:
                server.shutdown()
                worker.join(timeout=5)

    def test_openvino_repair_rebuilds_missing_tokenizer_at_the_registered_path(self):
        root = (self.root / "downloads").resolve()
        model_id = api.DEFAULT_TEXT_MODEL_ID
        spec = model_spec(model_id)
        folder = root / spec["folder"]
        folder.mkdir(parents=True)
        for name in set(REQUIRED_FILES).union(item["path"] for item in spec["files"]):
            source = self.folder / name
            (folder / name).write_bytes(source.read_bytes() if source.exists() else b"fixture")
        manifest = []
        for item in spec["files"]:
            data = (folder / item["path"]).read_bytes()
            manifest.append({"path": item["path"], "size": len(data), "algorithm": "sha256", "digest": hashlib.sha256(data).hexdigest()})
        spec = {**spec, "files": manifest}
        (folder / INSTALL_MARKER).write_text(json.dumps({"modelId": model_id, "verifiedChecksums": True,
            **{key: spec[key] for key in ("name", "repo", "revision", "format")}}), encoding="utf-8")
        registered = self.registry.add(str(folder))
        missing = "openvino_detokenizer.xml"
        (folder / missing).unlink()
        self.assertFalse(self.registry.snapshot()[-1]["installed"])
        finished = threading.Event()
        install = api.run_text_model_install
        fetch = Mock(side_effect=AssertionError("Verified OpenVINO files should be reused."))
        request_api = SimpleNamespace(Request=urllib.request.Request, urlopen=fetch)

        def complete(*args):
            try:
                install(*args)
            finally:
                finished.set()

        def convert(stage, _progress):
            for name in ("openvino_tokenizer.xml", "openvino_tokenizer.bin", missing, "openvino_detokenizer.bin"):
                (stage / name).write_bytes((self.folder / name).read_bytes())

        with (
            patch.object(api, "TEXT_MODEL_ROOT", root),
            patch.object(api, "TEXT_MODEL_REGISTRY", self.registry),
            patch.object(api, "apple_silicon", return_value=False),
            patch.object(api, "TEXT_MODEL_DOWNLOAD_PAUSE", None),
            patch.dict(api.TEXT_MODEL_INSTALL, {"id": None, "status": "idle"}, clear=True),
            patch.object(api, "run_text_model_install", side_effect=complete),
            patch.object(api.TEXT_GENERATION_WORKER, "close"),
            patch.object(download, "model_spec", return_value=spec),
            patch.object(download, "convert_tokenizers", side_effect=convert),
            patch.object(download, "urllib", SimpleNamespace(request=request_api)),
            ThreadingHTTPServer(("127.0.0.1", 0), api.Handler) as server,
        ):
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/api/text/models/install",
                    data=json.dumps({"modelId": model_id, "repair": True}).encode(),
                    headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 202)
                    self.assertEqual(json.load(response)["modelInstall"]["operation"], "repair")
                self.assertTrue(finished.wait(5))
                self.assertEqual(api.TEXT_MODEL_INSTALL["status"], "complete", api.TEXT_MODEL_INSTALL.get("error"))
                self.assertEqual(api.TEXT_MODEL_INSTALL["phase"], "Repaired and verified.")
                fetch.assert_not_called()
                record = next(item for item in self.registry.snapshot() if item["id"] == registered["id"])
                self.assertEqual(record["path"], str(folder))
                self.assertTrue(record["installed"])
                self.assertTrue((folder / missing).is_file())
            finally:
                server.shutdown()
                worker.join(timeout=5)

    def test_pause_is_job_scoped_and_finishes_before_resume_or_local_install(self):
        downloading = threading.Event()
        allow_pause = threading.Event()
        preparing = threading.Event()
        allow_install = threading.Event()
        pauses = []

        def install(_model, _root, progress, *, pause, repair=False):
            self.assertFalse(repair)
            pauses.append(pause)
            if len(pauses) == 1:
                progress("Downloading model weights…")
                downloading.set()
                if not allow_pause.wait(5):
                    raise RuntimeError("The pause fixture did not release.")
                check_download_pause(pause)
                raise AssertionError("The first install should be paused.")
            progress(PREPARING_MODEL_FILES)
            preparing.set()
            if not allow_install.wait(5):
                raise RuntimeError("The install fixture did not release.")
            return self.folder

        def await_status(expected):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with api.TEXT_MODEL_INSTALL_LOCK:
                    if api.TEXT_MODEL_INSTALL["status"] == expected:
                        return
                time.sleep(0.01)
            self.fail(f"Expected the download to reach {expected}.")

        with ThreadingHTTPServer(("127.0.0.1", 0), api.Handler) as server:
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            base = f"http://127.0.0.1:{server.server_port}/api/text/models/install"

            def post(payload, suffix=""):
                request = urllib.request.Request(base + suffix, data=json.dumps(payload).encode(),
                                                 headers={"Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    with error:
                        return error.code, json.load(error)

            with (patch.object(api, "TEXT_MODEL_REGISTRY", self.registry),
                  patch.object(self.registry, "add", return_value=self.model) as register,
                  patch.object(api, "TEXT_MODEL_ROOT", self.root),
                  patch.object(api, "apple_silicon", return_value=False),
                  patch.object(api, "TEXT_MODEL_DOWNLOAD_PAUSE", None),
                  patch.object(api, "install_text_model", side_effect=install),
                  patch.object(api.TEXT_GENERATION_WORKER, "close"),
                  patch.dict(api.TEXT_MODEL_INSTALL, {"id": None, "status": "idle", "phase": None, "error": None}, clear=True)):
                try:
                    model = {"modelId": api.DEFAULT_TEXT_MODEL_ID}
                    code, initial = post(model)
                    self.assertEqual(code, 202)
                    self.assertTrue(downloading.wait(5))
                    first = initial["modelInstall"]["id"]
                    self.assertEqual(post({"jobId": "older-job"}, "/pause")[1]["modelInstall"]["status"], "downloading")
                    self.assertEqual(post({"jobId": first}, "/pause")[1]["modelInstall"]["status"], "pausing")
                    self.assertEqual(post(model)[0], 400)
                    register.assert_not_called()
                    allow_pause.set()
                    await_status("paused")
                    self.assertFalse(api.text_model_install_running())
                    register.assert_not_called()

                    code, resumed = post(model)
                    self.assertEqual(code, 202)
                    self.assertTrue(preparing.wait(5))
                    second = resumed["modelInstall"]["id"]
                    self.assertNotEqual(first, second)
                    self.assertEqual(post({"jobId": second}, "/pause")[1]["modelInstall"]["status"], "preparing")
                    self.assertFalse(pauses[-1].is_set())
                    allow_install.set()
                    await_status("complete")
                    register.assert_called_once()
                finally:
                    allow_pause.set()
                    allow_install.set()
                    server.shutdown()
                    serving.join(5)

    def test_simultaneous_chat_image_uploads_share_one_file_without_blocking_stop(self):
        image = io.BytesIO()
        Image.new("RGB", (16, 16), "green").save(image, format="PNG")
        data = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode("ascii")
        both_decoding = threading.Barrier(3, timeout=5)
        resume_decode = threading.Event()
        cancel = threading.Event()
        decode = api.decode_flux_reference_image

        def decode_together(value):
            both_decoding.wait()
            if not resume_decode.wait(timeout=7):
                raise TimeoutError("Timed out waiting for Stop.")
            return decode(value)

        with ThreadingHTTPServer(("127.0.0.1", 0), api.Handler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}/api/text"

            def post(endpoint, payload):
                request = urllib.request.Request(f"{base}/{endpoint}", data=json.dumps(payload).encode(),
                                                 headers={"Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    with error:
                        return error.code, json.load(error)

            try:
                with (
                    patch.object(api, "DATA_DIR", self.root),
                    patch.object(api, "decode_flux_reference_image", side_effect=decode_together),
                    patch.dict(api.TEXT_JOB, {"id": "attach-running", "threadId": "text-thread-attach", "status": "running"}),
                    patch.object(api, "TEXT_CANCEL_EVENT", cancel),
                    patch.object(api.TEXT_GENERATION_WORKER, "request_stop") as request_stop,
                    patch.object(api.INTEL_MEDIA, "interrupt"),
                    ThreadPoolExecutor(max_workers=2) as uploads,
                ):
                    first = uploads.submit(post, "images", {"image": data})
                    second = uploads.submit(post, "images", {"image": data})
                    try:
                        both_decoding.wait()
                        status, receipt = post("stop", {"requestId": "attach-running", "threadId": "text-thread-attach"})
                        self.assertEqual(status, 202, receipt)
                        self.assertTrue(cancel.is_set())
                        request_stop.assert_called_once_with(cancel)
                    finally:
                        resume_decode.set()
                    responses = [first.result(), second.result()]
                    self.assertEqual([status for status, _ in responses], [201, 201], responses)
                    name = responses[0][1]["image"]
                    self.assertEqual(responses[1][1]["image"], name)
                    with Image.open(api.chat_image_path(name)) as stored:
                        self.assertEqual(stored.size, (16, 16))
                        self.assertEqual(stored.getpixel((0, 0)), (0, 128, 0))
                    self.assertEqual(list((self.root / "references").iterdir()), [self.root / "references" / name])
            finally:
                server.shutdown()
                worker.join(timeout=5)

    def test_upload_admitted_before_a_local_data_reset_cannot_publish_after_it(self):
        revision = api.CHAT_IMAGE_STORAGE_REVISION
        with (
            patch.object(api, "DATA_DIR", self.root),
            patch.object(api, "decode_flux_reference_image", return_value=Image.new("RGB", (16, 16), "green")),
            patch.object(api, "CHAT_IMAGE_STORAGE_REVISION", revision + 1),
            self.assertRaisesRegex(ValueError, "Local data was cleared"),
        ):
            api.store_chat_image("fixture", revision)
        self.assertFalse((self.root / "references").exists())

    def test_subprocess_reuse_switch_and_interrupt(self):
        script = self.root / 'fake_worker.py'
        script.write_text('''import sys,json,time
for line in sys.stdin:
    request=json.loads(line)
    print('FERN_TEXT_EVENT:'+json.dumps({'type':'phase','text':'ready'}),flush=True)
    if request.get('block'): time.sleep(60)
    print('FERN_TEXT_EVENT:'+json.dumps({'type':'result','text':'ok'}),flush=True)
''')
        worker = TextGenerationProcess()
        started = threading.Event()
        def generate(device='GPU', block=False):
            return worker.generate(model_path=str(self.folder), device=device, command=[sys.executable, '-u', str(script)], request={'block':block}, cwd=self.root, env=dict(os.environ), on_token=lambda _: None, on_phase=lambda _: started.set())
        try:
            self.assertEqual(generate()['text'], 'ok')
            first = worker._process
            generate()
            self.assertIs(worker._process, first)
            generate('CPU')
            self.assertIsNot(worker._process, first)
            self.assertIsNotNone(first.poll())
            started.clear()
            with ThreadPoolExecutor(1) as pool:
                request = pool.submit(generate, 'CPU', True)
                self.assertTrue(started.wait(5))
                worker.interrupt()
                with self.assertRaises((RuntimeError, OSError)):
                    request.result(timeout=8)
            self.assertEqual(generate()['text'], 'ok')
        finally:
            worker.close()

    def test_worker_exit_with_memory_failure_retains_tokens_and_allows_a_fresh_request(self):
        script = self.root / "memory_worker.py"
        script.write_text(
            "import json, sys\n"
            "request = json.loads(sys.stdin.readline())\n"
            "def emit(**event): print('FERN_TEXT_EVENT:' + json.dumps(event), flush=True)\n"
            "if request['fail']:\n"
            "    emit(type='token', text='A partial answer')\n"
            "    print('OpenVINO: CL_MEM_OBJECT_ALLOCATION_FAILURE', flush=True)\n"
            "    sys.exit(1)\n"
            "emit(type='result', text='Recovered')\n",
            encoding="utf-8",
        )
        worker = TextGenerationProcess()
        tokens = []

        def generate(fail):
            return worker.generate(model_path=str(self.folder), device="GPU", command=[sys.executable, "-u", str(script)],
                                   request={"fail": fail}, cwd=self.root, env=dict(os.environ),
                                   on_token=tokens.append, on_phase=lambda _: None)

        try:
            with self.assertRaises(TextWorkerError) as error:
                generate(True)
            self.assertEqual(error.exception.code, "out-of-memory")
            self.assertEqual(tokens, ["A partial answer"])
            self.assertEqual(generate(False)["text"], "Recovered")
        finally:
            worker.close()

    def test_stream_stop_preserves_worker_and_falls_back_for_a_stall(self):
        script = self.root / "cancellable_worker.py"
        script.write_text('''import json, sys, time
def emit(kind, **fields):
    print("FERN_TEXT_EVENT:" + json.dumps({"type": kind, **fields}), flush=True)
for line in sys.stdin:
    mode = json.loads(line).get("mode")
    if mode in ("cancel", "stall", "prefill"):
        if mode != "prefill":
            emit("cancellable")
        emit("phase", text="ready to cancel")
        if mode != "cancel":
            time.sleep(60)
        else:
            assert json.loads(sys.stdin.readline()) == {"op": "cancel"}
            emit("token", text="Ignore this late token.")
            emit("cancelled")
            continue
    if mode == "after-stop":
        time.sleep(1.1)
    emit("result", text="ok")
''')
        worker = TextGenerationProcess()
        ready = threading.Event()
        tokens = []

        def generate(mode, cancel_event=None):
            return worker.generate(
                model_path=str(self.folder), device="GPU", command=[sys.executable, "-u", str(script)],
                request={"mode": mode}, cwd=self.root, env=dict(os.environ), cancel_event=cancel_event,
                on_token=tokens.append, on_phase=lambda phase: ready.set() if phase == "ready to cancel" else None,
            )

        try:
            self.assertEqual(generate("warmup")["text"], "ok")
            first = worker._process
            with ThreadPoolExecutor(1) as pool:
                for mode, error in (("cancel", InterruptedError), ("stall", RuntimeError), ("prefill", RuntimeError)):
                    ready.clear()
                    cancel = threading.Event()
                    future = pool.submit(generate, mode, cancel)
                    try:
                        self.assertTrue(ready.wait(5))
                        worker.request_stop(threading.Event())
                        self.assertFalse(future.done())
                        cancel.set()
                        worker.request_stop(cancel)
                        worker.request_stop(cancel)
                        with self.assertRaises(error):
                            future.result(timeout=6)
                    finally:
                        if not future.done():
                            worker.interrupt()
                    if mode == "cancel":
                        self.assertEqual(generate("after-stop")["text"], "ok")
                        self.assertIs(worker._process, first)
                        self.assertEqual(tokens, [])
            self.assertIsNotNone(first.poll())
            self.assertEqual(generate("next")["text"], "ok")
            self.assertIsNot(worker._process, first)
        finally:
            worker.close()

    def test_corrupt_registry_is_not_silently_overwritten(self):
        self.registry.path.write_text('broken')
        with self.assertRaisesRegex(ValueError, "preserved"):
            self.registry.add(str(self.folder))
        self.assertEqual(self.registry.path.read_text(), 'broken')

    def test_cancel_before_worker_launch(self):
        event = threading.Event()
        event.set()
        with patch('text_generation_process.subprocess.Popen') as launch:
            with self.assertRaises(InterruptedError):
                TextGenerationProcess().generate(model_path=str(self.folder), device="GPU", command=[], request={}, cwd=self.root, env={}, on_token=lambda _: None, on_phase=lambda _: None, cancel_event=event)
            launch.assert_not_called()

    def test_eof_after_stop_preserves_partial_output(self):
        event = threading.Event()
        def terminate(**kwargs):
            api.append_text_event("cancel-test", token="partial output")
            event.set()
            raise RuntimeError("The text worker exited before returning a result.")
        with patch.object(api, 'TEXT_MODEL_REGISTRY', self.registry), patch.object(api.TEXT_GENERATION_WORKER, 'generate', side_effect=terminate), patch.object(api.GENERATION_WORKER, 'close'), patch.object(api.QWEN_GENERATION_WORKER, 'close'), patch.object(api.TTS_GENERATION_WORKER, 'close'), patch.object(api.flux2, 'release_pipeline'), patch.dict(api.TEXT_JOB, {'id': 'cancel-test', 'status': 'running', 'partialText': ''}, clear=True):
            api.run_text_generation({'modelId': self.model['id'], 'device': 'AUTO'}, 'cancel-test', event)
            self.assertEqual(api.TEXT_JOB['status'], 'stopped')
            self.assertEqual(api.TEXT_JOB['partialText'], 'partial output')
            self.assertIsNone(api.TEXT_JOB['error'])
            self.assertIsNone(api.TEXT_JOB['failureDiagnostics'])

    def test_text_failure_keeps_the_structured_stage_after_worker_logs(self):
        script = self.root / "failing_worker.py"
        script.write_text(
            "import json, sys\n"
            "def emit(**event): print('FERN_TEXT_EVENT:' + json.dumps(event), flush=True)\n"
            "sys.stdin.readline()\n"
            "emit(type='runtime', backend='openvino', device='GPU')\n"
            "emit(type='phase', stage='loading-model', text='Loading the OpenVINO model…')\n"
            "print('Private runtime log: /local/model.xml', flush=True)\n"
            "emit(type='error', error='Could not allocate GPU memory.', traceback='Private traceback')\n",
            encoding="utf-8",
        )
        worker = TextGenerationProcess()

        def load_worker(**kwargs):
            return worker.generate(**{**kwargs, "command": [sys.executable, "-X", "utf8", str(script)]})

        try:
            with (patch.object(api, "TEXT_MODEL_REGISTRY", self.registry),
                  patch.object(api.TEXT_GENERATION_WORKER, "generate", side_effect=load_worker),
                  patch.object(api.flux2, "release_pipeline"),
                  patch.dict(api.TEXT_JOB, {"id": "failure-test", "status": "running"}, clear=True)):
                api.run_text_generation({"modelId": self.model["id"], "device": "AUTO"}, "failure-test", threading.Event())
                job = api.text_job_snapshot()
                self.assertEqual(job["status"], "failed")
                self.assertEqual(job["error"], "Could not allocate GPU memory.")
                self.assertEqual(job["failureDiagnostics"], {
                    "stage": "loading-model", "runtime": "openvino", "backend": "openvino",
                    "requestedDevice": "AUTO", "device": "GPU",
                })
        finally:
            worker.close()

    def test_auto_never_falls_back_to_cpu(self):
        import types
        with patch.dict(sys.modules, {'openvino': types.SimpleNamespace(Core=lambda: types.SimpleNamespace(available_devices=['CPU']))}):
            with self.assertRaisesRegex(ValueError, "Choose CPU explicitly"):
                resolve_text_device('AUTO')
            self.assertEqual(resolve_text_device('CPU'), 'CPU')

    def test_chat_image_tool_returns_an_artifact_to_the_same_text_worker(self):
        event = threading.Event()
        call = {"id": "image-call", "type": "function", "function": {"name": "generate_image", "arguments": '{"prompt":"red teapot"}'}}
        image = {"name": "teapot.png", "width": 512, "height": 512}
        image_settings = {"width": 768, "height": 512, "steps": 6, "guidance": 1, "seed": 19}
        metrics = {"device": "GPU", "text": "", "outputTokens": 8, "inputTokens": 12, "generationSeconds": 0.3}
        with patch.object(api, 'TEXT_MODEL_REGISTRY', self.registry), \
             patch.object(api.TEXT_GENERATION_WORKER, 'generate', side_effect=[
                 {**metrics, "toolCalls": [call]}, {**metrics, "text": "The image is ready."},
             ]) as reply, patch.object(api.TEXT_GENERATION_WORKER, 'close') as close_text, \
             patch.object(api.GENERATION_WORKER, 'close') as close_image, \
             patch.object(api, 'generate_chat_image', return_value=image) as generate_image, \
             patch.dict(api.TEXT_JOB, {'id': 'test-tool', 'status': 'running', 'partialText': ''}, clear=True):
            api.run_text_generation({
                "modelId": self.model["id"], "device": "AUTO", "imageModel": "4b-lora", "imageSettings": image_settings,
                "threadId": "text-thread-test", "messages": [{"role": "user", "content": "Draw a teapot."}],
                "maxNewTokens": 512, "seed": 1, "temperature": 0, "topP": 0.9,
            }, "test-tool", event)
            self.assertEqual(api.TEXT_JOB["status"], "complete")
            self.assertEqual(api.TEXT_JOB["image"], image)
            self.assertEqual(api.TEXT_JOB["partialText"], "The image is ready.")
            generate_image.assert_called_once_with("4b-lora", "red teapot", "text-thread-test", "test-tool", event, image_settings,
                                                   message_image=None, on_image=ANY)
            first, resumed = (item.kwargs["request"] for item in reply.call_args_list)
            self.assertEqual(first["tools"][0]["function"]["name"], "generate_image")
            self.assertEqual(resumed["toolChoice"], "none")
            self.assertEqual(resumed["maxNewTokens"], 96)
            self.assertEqual(resumed["messages"][-2]["tool_call_id"], "image-call")
            self.assertTrue(resumed["messages"][-1]["imagePath"].endswith("teapot.png"))
            self.assertTrue(api.TEXT_JOB["result"]["visionChecked"])
            close_text.assert_not_called()
            close_image.assert_not_called()

    def test_saved_chat_image_survives_restart_and_can_be_inspected_without_rendering(self):
        (self.root / "poster.png").write_bytes(b"fixture artifact")
        image = {"name": "poster.png", "width": 512, "height": 512, "modelLabel": "Klein 4B", "prompt": "Red circle"}
        thread_id = "text-thread-poster"
        metadata = {**image, "source": "chat", "threadId": thread_id, "chatJobId": "original"}
        vision_model = {**self.model, "supportsVision": True, "format": "gguf", "maxContextSize": 65536}
        with patch.object(api, "OUTPUTS", self.root), \
             patch.object(self.registry, "snapshot", return_value=[vision_model]), \
             patch.object(api, "TEXT_MODEL_REGISTRY", self.registry), \
             patch.object(api, "gguf_runtime_supported", return_value=True), \
             patch.object(api.gallery_store, "get_image_metadata", return_value=metadata), \
             patch.object(api.gallery_store, "metadata_snapshot", return_value={"poster.png": metadata}), \
             patch.object(api.TEXT_GENERATION_WORKER, "generate", return_value={"text": "A red circle."}) as inspect, \
             patch.object(api, "generate_chat_image") as render, \
             patch.dict(api.TEXT_JOB, {"id": "inspection", "status": "running"}, clear=True):
            self.assertEqual(api.recover_chat_images(thread_id, "original"), [image])
            self.assertEqual(api.recover_chat_images("text-thread-other", "original"), [])
            attempt = {"threadId": thread_id, "image": "poster.png", "modelId": self.model["id"]}
            with self.assertRaisesRegex(ValueError, "saved image from this conversation"):
                api.prepare_image_inspection({**attempt, "threadId": "text-thread-other"})
            loading = {"contextSize": 12_288, "loadOptions": {"flashAttention": "off", "promptBatch": 1024}}
            with self.assertRaisesRegex(ValueError, "Prompt batch size"):
                api.prepare_image_inspection({**attempt, "contextSize": 1024, "loadOptions": {"promptBatch": 2048}})
            generation = api.prepare_image_inspection({**attempt, **loading, "threadId": "text-thread-fork", "imageThreadId": thread_id})
            self.assertEqual(generation["threadId"], "text-thread-fork")
            api.run_text_generation(generation, "inspection", threading.Event())
            self.assertEqual(api.TEXT_JOB["status"], "complete")
            self.assertTrue(api.TEXT_JOB["result"]["visionChecked"])
            self.assertEqual(inspect.call_args.kwargs["request"]["messages"][0]["imagePath"], str(self.root.resolve() / "poster.png"))
            self.assertEqual({key: inspect.call_args.kwargs["request"][key] for key in loading}, loading)
            self.assertNotIn("tools", inspect.call_args.kwargs["request"])
            render.assert_not_called()
            self.assertEqual(len(list(self.root.glob("*.png"))), 1)

    def test_http_admission_and_role_validation(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), api.Handler)
        serving = threading.Thread(target=server.serve_forever, daemon=True)
        serving.start()
        def post(messages, request_id, path='/api/text/generate', **extra):
            data = {'requestId': request_id, 'threadId': 'text-thread-test', 'modelId': self.model['id'], 'messages': messages}
            data.update(extra)
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}{path}', data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request) as response:
                    return response.status
            except urllib.error.HTTPError as error:
                return error.code
        try:
            with patch.object(api, 'TEXT_MODEL_REGISTRY', self.registry), patch.object(api, 'run_text_generation'), patch.object(api, 'text_runtime_snapshot', return_value={}), patch.object(api, 'start_qwen_turbo_setup') as start_qwen_setup, patch.dict(api.TEXT_JOB, {'status': 'idle'}, clear=True), patch.dict(api.TTS_JOB, {'status': 'idle'}), patch.dict(api.FLUX_JOB, {'status': 'idle', 'output': None}), patch.dict(api.QWEN_JOB, {'status': 'idle'}):
                gguf_model = {**self.model, "format": "gguf", "maxContextSize": 65_536, "installed": True}
                long_turn = {"role": "user", "content": "long input " * 2_000}
                history = [{"role": role, "content": "History"} for role in ("user", "assistant")]
                with (
                    patch.object(self.registry, "snapshot", return_value=[gguf_model]),
                    patch.object(api, "gguf_runtime_supported", return_value=True),
                    patch.object(api, "start_text_job", return_value=None) as start,
                ):
                    self.assertEqual(post(history * 160 + [long_turn], "long-gguf", contextSize=24_789, maxNewTokens=15_100), 202)
                    payload = start.call_args.args[0]
                    self.assertEqual(payload["contextSize"], 24_789)
                    self.assertEqual(payload["maxNewTokens"], 15_100)
                    self.assertEqual(payload["messages"][-1], long_turn)
                    self.assertEqual(len(payload["messages"]), 321)
                    self.assertEqual(post([long_turn], "oversized-output", contextSize=24_789, maxNewTokens=24_790), 400)
                self.assertEqual(post([{'role': role, 'content': 'hi'} for role in ['user', 'user', 'assistant']], 'invalid'), 400)
                self.assertEqual(post([{'role':'user','content':'hi'}], 'bad-seed', seed=-1), 400)
                self.assertEqual(post([{'role': 'user', 'content': 'hi'}], 'expired', admitBefore=1), 400)
                self.assertEqual(api.TEXT_JOB['status'], 'idle')
                with ThreadPoolExecutor(2) as pool:
                    results = list(pool.map(lambda i: post([{'role': 'user', 'content': 'hello'}], str(i)), range(2)))
                self.assertEqual(sorted(results), [202, 400])
                self.assertEqual(post([], 'image', '/api/flux2/generate'), 409)
                self.assertEqual(post([], 'audio', '/api/tts/generate'), 400)
                self.assertEqual(post([], 'remove', '/api/text/models/remove'), 400)
                api.TEXT_JOB['status'] = 'idle'
                api.QWEN_JOB['status'] = 'setting_up'
                self.assertEqual(post([{'role':'user','content':'hi'}], 'qwen-busy'), 400)
                self.assertEqual(post([], 'tts-qwen-busy', '/api/tts/setup', model='qwen3-tts-12hz-0.6b-base'), 400)
                api.QWEN_JOB['status'] = 'idle'
                api.TEXT_JOB['status'] = 'running'
                self.assertEqual(post([], 'qwen-start-busy', '/api/models/install', model=api.QWEN_TURBO_MODEL_ID), 400)
                start_qwen_setup.assert_not_called()
                api.TEXT_JOB['status'] = 'idle'
                api.FLUX_JOB['status'] = 'running'
                self.assertEqual(post([{'role':'user','content':'hi'}], 'image-busy'), 400)
                api.FLUX_JOB['status'] = 'idle'
                api.TTS_JOB['status'] = 'running'
                self.assertEqual(post([{'role':'user','content':'hi'}], 'audio-busy'), 400)
        finally:
            server.shutdown()
            server.server_close()

    def test_http_reincludes_only_a_saved_image_owned_by_the_chat(self):
        path = self.root / "selected.png"
        path.write_bytes(b"fixture artifact")
        server = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        thread_id = "text-thread-check"
        model = {**self.model, "supportsVision": True}
        library = {"selected.png": {"source": "chat", "threadId": thread_id}}

        def submit(request_id, name, owner=thread_id, source=None):
            payload = {"requestId": request_id, "threadId": owner, "modelId": model["id"],
                       "messages": [{"role": "user", "content": "Describe the picture.", "includedImage": name}]}
            if source:
                payload["messages"][0]["imageThreadId"] = source
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/text/generate",
                data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"},
            )
            return urllib.request.urlopen(request)

        try:
            with patch.object(api, "OUTPUTS", self.root), \
                 patch.object(self.registry, "snapshot", return_value=[model]), \
                 patch.object(api, "TEXT_MODEL_REGISTRY", self.registry), \
                 patch.object(api.gallery_store, "metadata_snapshot", return_value=library), \
                 patch.object(api, "text_runtime_snapshot", return_value={}), \
                 patch.object(api, "run_text_generation") as generate, \
                 patch.dict(api.TEXT_JOB, {"status": "idle"}, clear=True):
                with self.assertRaisesRegex(urllib.error.HTTPError, "400"):
                    submit("wrong", path.name, "text-thread-another")
                with self.assertRaisesRegex(urllib.error.HTTPError, "400"):
                    submit("path", "../selected.png")
                with self.assertRaisesRegex(urllib.error.HTTPError, "400"):
                    submit("wrong-source", path.name, "text-thread-fork", "text-thread-another")
                with submit("valid", path.name, "text-thread-fork", thread_id) as response:
                    self.assertEqual(response.status, 202)
                self.assertEqual(generate.call_args.args[0]["messages"][0]["imagePath"], str(path.resolve()))
                api.TEXT_JOB["status"] = "idle"
                with submit("copy", path.name, "text-thread-copy", source=thread_id) as response:
                    self.assertEqual(response.status, 202)
                self.assertEqual(generate.call_args.args[0]["messages"][0]["imagePath"], str(path.resolve()))
        finally:
            server.shutdown()
            server.server_close()

    def test_job_only_status_and_targeted_stop(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}/api/text"
        cancel = threading.Event()

        def stop(request_id, **extra):
            payload = {"requestId": request_id, "jobOnly": True, **extra}
            request = urllib.request.Request(f"{base}/stop", data=json.dumps(payload).encode())
            with urllib.request.urlopen(request) as response:
                return json.load(response)["textJob"]

        try:
            with patch.dict(api.TEXT_JOB, {"id": "running", "threadId": "text-thread-running", "status": "running", "partialText": "Partial"}, clear=True), \
                 patch.object(api, "TEXT_CANCEL_EVENT", cancel), \
                 patch.object(api.TEXT_GENERATION_WORKER, "request_stop") as request_stop, \
                 patch.object(api.INTEL_MEDIA, "interrupt"), \
                 patch.object(api, "text_runtime_snapshot", side_effect=AssertionError("Job polling must skip the catalog")):
                with urllib.request.urlopen(f"{base}/job") as response:
                    self.assertEqual(json.load(response)["partialText"], "Partial")
                self.assertEqual(stop("stale")["id"], "running")
                self.assertFalse(cancel.is_set())
                request_stop.assert_not_called()
                self.assertEqual(stop("running", threadId="text-thread-running")["phase"], "Stopping generation…")
                self.assertTrue(cancel.is_set())
                request_stop.assert_called_once_with(cancel)
        finally:
            server.shutdown()
            server.server_close()

    def test_stop_before_admission_does_not_start_or_interrupt_a_job(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}/api/text"
        identity = {"requestId": "pending", "threadId": "text-thread-pending", "jobOnly": True}
        other_job = {"id": "pending", "threadId": "text-thread-other", "status": "running", "partialText": "Keep this reply"}

        def post(path, payload):
            request = urllib.request.Request(f"{base}/{path}", data=json.dumps(payload).encode())
            with urllib.request.urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 202)
                return json.load(response)

        try:
            with patch.dict(api.TEXT_JOB, other_job, clear=True), \
                 patch.dict(api.TEXT_PENDING_STOPS, clear=True), \
                 patch.object(api, "TEXT_MODEL_REGISTRY", self.registry), \
                 patch.object(api, "run_text_generation") as generate, \
                 patch.object(api.TEXT_GENERATION_WORKER, "request_stop") as request_stop, \
                 patch.object(api.INTEL_MEDIA, "interrupt") as interrupt_media:
                with api.JOB_ADMISSION_LOCK:
                    self.assertEqual(post("stop", identity), {"cancelledBeforeStart": True})
                payload = {**identity, "modelId": self.model["id"], "messages": [{"role": "user", "content": "Cancelled."}]}
                for _ in range(2):
                    stopped = post("generate", payload)["textJob"]
                    self.assertEqual((stopped["id"], stopped["threadId"], stopped["status"]),
                                     (identity["requestId"], identity["threadId"], "stopped"))
                self.assertEqual(api.text_job_snapshot(), other_job)
                generate.assert_not_called()
                request_stop.assert_not_called()
                interrupt_media.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()

    def test_job_event_stream_delivers_deltas_and_the_authoritative_final_reply(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}/api/text"
        def read_frame(response):
            line = response.readline()
            self.assertTrue(line.startswith(b"data: "), line)
            self.assertEqual(response.readline(), b"\n")
            return json.loads(line[6:])

        job = {"id": "reply", "threadId": "text-thread-reply", "status": "running",
               "partialText": "Start ☕", "partialReasoning": "", "phase": "Loading model…"}
        result = {"device": "GPU", "text": "The final reply.", "inputTokens": 5, "outputTokens": 4, "generationSeconds": 0.2}
        payload = {"modelId": self.model["id"], "device": "AUTO", "seed": 1, "temperature": 0, "topP": 1, "maxNewTokens": 30}
        endpoint = f"{base}/job/events?jobId=reply&threadId="
        try:
            with patch.dict(api.TEXT_JOB, job, clear=True), \
                 patch.object(api, "TEXT_MODEL_REGISTRY", self.registry), \
                 patch.object(api.TEXT_GENERATION_WORKER, "generate", return_value=result), \
                 patch.object(api.INTEL_MEDIA, "close"), patch.object(api.flux2, "release_pipeline"), \
                 patch.object(api, "TEXT_JOB_STREAM_HEARTBEAT", 0.2):
                with urllib.request.urlopen(endpoint + "text-thread-other", timeout=2) as other:
                    self.assertEqual(read_frame(other), {"job": None})
                    self.assertEqual(other.read(), b"")
                with urllib.request.urlopen(endpoint + job["threadId"], timeout=2) as events:
                    self.assertEqual(events.headers.get_content_type(), "text/event-stream")
                    self.assertEqual(read_frame(events), {"job": job})
                    self.assertEqual(read_frame(events), {"heartbeat": True})
                    api.append_text_event(job["id"], phase="Generating…", token=" café", reasoning="Review")
                    self.assertEqual(read_frame(events), {"append": {
                        "phase": "Generating…", "text": " café", "reasoning": "Review",
                    }})
                    with urllib.request.urlopen(f"{base}/job", timeout=2) as polled:
                        self.assertEqual(json.load(polled)["partialText"], "Start ☕ café")
                    api.run_text_generation(payload, job["id"], threading.Event())
                    completed = read_frame(events)["job"]
                    self.assertEqual((completed["status"], completed["partialText"]), ("complete", result["text"]))
                    self.assertEqual(events.read(), b"")
                with urllib.request.urlopen(endpoint + job["threadId"], timeout=2) as finished:
                    self.assertEqual(read_frame(finished)["job"], completed)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
