import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import api_server
import qwen3_tts_worker


class TtsProgressTests(unittest.TestCase):
    def test_warnings_stay_out_of_activity_timeline(self):
        before = dict(api_server.TTS_JOB)
        try:
            api_server.TTS_JOB.update(logs=[], diagnostics=[], startedAt=time.time()-5)
            api_server.append_tts_log("WARNING: optional flash attention is unavailable")
            api_server.append_tts_log("FERN_TTS_PROGRESS:Compiling voice model on GPU.")
            self.assertEqual(len(api_server.TTS_JOB["logs"]), 1)
            self.assertIn("+5.", api_server.TTS_JOB["logs"][0])
            self.assertEqual(api_server.TTS_JOB["phase"], "Compiling voice model on GPU.")
            self.assertIn("flash attention", api_server.TTS_JOB["diagnostics"][0])
        finally:
            api_server.TTS_JOB.clear()
            api_server.TTS_JOB.update(before)

    def test_tts_auto_requires_gpu_before_importing_runtime(self):
        fake = types.SimpleNamespace(Core=lambda: types.SimpleNamespace(available_devices=["CPU"]))
        with patch.dict(sys.modules, {"openvino": fake}), self.assertRaisesRegex(RuntimeError, "No supported Intel GPU"):
            qwen3_tts_worker.load_pipeline(Path("unused"), "AUTO")
