"""Regression coverage for text admission, cancellation and external model safety."""
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import api_server as api
from text_model_registry import TextModelRegistry, REQUIRED_FILES
from text_generation_process import TextGenerationProcess
from text_generation_worker import resolve_text_device


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

    def test_auto_never_falls_back_to_cpu(self):
        import types
        with patch.dict(sys.modules, {'openvino': types.SimpleNamespace(Core=lambda: types.SimpleNamespace(available_devices=['CPU']))}):
            with self.assertRaisesRegex(ValueError, "Choose CPU explicitly"):
                resolve_text_device('AUTO')
            self.assertEqual(resolve_text_device('CPU'), 'CPU')

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
                self.assertEqual(post([{'role': role, 'content': 'hi'} for role in ['user', 'user', 'assistant']], 'invalid'), 400)
                self.assertEqual(post([{'role':'user','content':'hi'}], 'bad-seed', seed=-1), 400)
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


if __name__ == '__main__':
    unittest.main()
