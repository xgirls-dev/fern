import sys
import tempfile
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

    def test_cached_pipeline_decode_progress_is_wrapped_only_once(self):
        import numpy as np

        class FakeSpeechTokenizer:
            def __init__(self):
                self.decode_calls = 0

            def decode(self, encoded):
                self.decode_calls += 1
                return encoded

        class FakePipeline:
            device = "GPU"
            tts_model_type = "custom_voice"

            def __init__(self):
                self.speech_tokenizer = FakeSpeechTokenizer()

            def generate_custom_voice(self, *_args, **_kwargs):
                self.speech_tokenizer.decode([[1, 2, 3]])
                return [np.array([0.1, 0.2, 0.3], dtype=np.float32)], 24000

        pipeline = FakePipeline()
        phases = []
        fake_soundfile = types.SimpleNamespace(
            write=lambda path, *_args, **_kwargs: Path(path).write_bytes(b"test wav")
        )
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            sys.modules, {"soundfile": fake_soundfile}
        ), patch.object(
            qwen3_tts_worker, "load_pipeline", return_value=pipeline
        ), patch.object(qwen3_tts_worker, "progress", side_effect=phases.append):
            outputs = Path(directory)
            for index in range(2):
                qwen3_tts_worker.generate(
                    {
                        "model": "custom-0.6b",
                        "text": "Hello.",
                        "outputName": f"take-{index}.wav",
                    },
                    outputs,
                    outputs,
                )

        self.assertEqual(pipeline.speech_tokenizer.decode_calls, 2)
        self.assertEqual(
            phases.count("Speech codes generated. Decoding the audio waveform."), 2
        )
        self.assertEqual(phases.count("Audio waveform decoded."), 2)
