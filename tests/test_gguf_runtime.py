from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gguf_runtime import CompletionCancellation, GGUFServer, VulkanDriverError, _StartupLog, ensure_runtime, runtime_supported
from text_runtime_errors import OUT_OF_MEMORY, TextRuntimeMemoryError, text_runtime_error_code


class GGUFCompletionTests(unittest.TestCase):
    def test_load_reports_memory_pressure_even_if_the_marker_is_outside_the_error_excerpt(self) -> None:
        server = GGUFServer.__new__(GGUFServer)
        server.process = Mock()
        server.process.poll.return_value = 1
        server.backend, server.device = "vulkan", "GPU"
        with tempfile.TemporaryDirectory() as directory:
            server.log_path = Path(directory) / "runtime.log"
            server.log_path.write_text("vk::Device::allocateMemory: ErrorOutOfDeviceMemory\n" + "diagnostic\n" * 900)
            with self.assertRaises(TextRuntimeMemoryError) as failure:
                server._wait_ready()
            self.assertEqual(text_runtime_error_code(failure.exception), OUT_OF_MEMORY)
            self.assertNotIn("ErrorOutOfDeviceMemory", str(failure.exception))
            server.log_path.write_text("The GGUF file is malformed.")
            with self.assertRaisesRegex(RuntimeError, "GGUF file is malformed") as invalid_model:
                server._wait_ready()
            self.assertIsNone(text_runtime_error_code(invalid_model.exception))
        self.assertEqual(text_runtime_error_code(MemoryError()), OUT_OF_MEMORY)
        self.assertEqual(text_runtime_error_code(RuntimeError("CL_MEM_OBJECT_ALLOCATION_FAILURE")), OUT_OF_MEMORY)
        self.assertIsNone(text_runtime_error_code(RuntimeError("CL_OUT_OF_RESOURCES")))

    def test_runtime_readiness_polls_quickly_then_backs_off(self) -> None:
        server = GGUFServer.__new__(GGUFServer)
        server.process = Mock()
        server.process.poll.return_value = None
        server.http = Mock()
        server._request = Mock(return_value="/health")
        now = 0.0
        waits = []

        def sleep(seconds: float) -> None:
            nonlocal now
            waits.append(seconds)
            now += seconds

        def health(*_args, **_kwargs):
            nonlocal now
            if not waits:
                raise OSError("The server has not opened its listening socket.")
            if len(waits) == 1:
                now = 5.0
                return io.BytesIO(b'{"status":"loading model"}')
            return io.BytesIO(b'{"status":"ok"}')

        server.http.open.side_effect = health
        with patch("gguf_runtime.time.monotonic", side_effect=lambda: now), patch("gguf_runtime.time.sleep", side_effect=sleep):
            server._wait_ready()
        self.assertEqual(waits, [0.05, 0.4])
        self.assertEqual(server.http.open.call_count, 3)

    def test_startup_log_keeps_the_latest_completed_phase_and_measures_seen_boundaries(self) -> None:
        on_phase = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "startup.log"
            startup = _StartupLog(path, on_phase)
            startup.read()
            self.assertEqual(startup.timings(), {})
            path.write_bytes(b"0.00.890.000 I srv  llama_server: initializing ...\n"
                             b"0.01.010.000 I cmn  common_fit_a: fitting params to device memory ...\n"
                             b"0.02.000.000 I cmn  common_fit_params: fitting params to free memory took 0.99 seconds\n"
                             b"0.02.200.000 I load_tensors: loading model tensors,")
            startup.read()
            startup.read()
            on_phase.assert_called_once_with("loading-model", "Checking model memory…")
            self.assertEqual(startup.timings(), {"engineInitializationMs": 890, "memoryFitMs": 990})
            with path.open("ab") as output:
                output.write(b" this can take a while...\n"
                             b"0.03.200.000 I llama_context: constructing llama_context\n")
            startup.read()
            on_phase.assert_called_with("loading-model", "Preparing model context…")
            self.assertEqual(startup.timings(), {"engineInitializationMs": 890, "memoryFitMs": 990, "weightLoadMs": 1000})
            with path.open("ab") as output:
                output.write(b"0.03.500.000 I cmn  common_init_: warming up the model with an empty run\n"
                             b"0.05.700.000 I srv  server_run_i: model loaded\n")
            startup.read(notify=False)
            self.assertEqual(on_phase.call_count, 2)
            self.assertEqual(startup.timings(), {"engineInitializationMs": 890, "memoryFitMs": 990, "weightLoadMs": 1000,
                                               "contextSetupMs": 300, "postContextSetupMs": 2200})

    def test_image_context_names_match_the_encoded_model_request(self) -> None:
        server = GGUFServer.__new__(GGUFServer)
        server.context_size, server.device, server.backend = 4096, "GPU", "vulkan"
        server.history, server.load_options = {}, {}
        server._prompt_tokens = Mock(return_value=16)
        server._completion = Mock(return_value=io.BytesIO(b"data: [DONE]\n"))

        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ("older.png", "recent.png", "selected.png")]
            for path in paths:
                path.write_bytes(path.name.encode())
            history = [
                {"role": "user", "content": "Previous image.", "imagePath": str(paths[0])},
                {"role": "assistant", "content": "Previous reply.", "imagePath": str(paths[2])},
                {"role": "user", "content": "Recent image.", "imagePath": str(paths[1])},
                {"role": "assistant", "content": "Recent reply."},
                {"role": "user", "content": "Use the selected image again.", "imagePath": str(paths[2])},
            ]
            document = {"name": "Poster notes.txt", "location": "Section 1", "text": "The print border is coral.",
                        "documentId": "doc-" + "a" * 64, "passageIndex": 0}
            report = server.generate({"messages": history, "maxNewTokens": 16, "temperature": 0,
                                      "topP": 1, "seed": 0, "documentPassages": [document]}, Mock())
        wire = server._completion.call_args.args[0]["messages"]
        self.assertEqual([index for index, turn in enumerate(wire) if isinstance(turn["content"], list)], [2, 4])
        self.assertEqual(report["context"]["imageNames"], ["recent.png", "selected.png"])
        self.assertEqual(report["context"]["images"], 2)
        self.assertIn(document["text"], wire[-1]["content"][1]["text"])
        source, = report["documentSources"]
        self.assertEqual(source["excerpt"], document["text"])
        self.assertEqual(source["name"], document["name"])
        self.assertEqual(source["location"], document["location"])
        self.assertEqual(source["reference"]["documentId"], document["documentId"])
        self.assertEqual(source["reference"]["passageIndex"], 0)
        self.assertEqual(source["reference"]["quotedCharacters"], len(document["text"]))

    def test_compaction_reuses_only_the_same_transcript_in_one_engine(self) -> None:
        transcript = "user: Use the blue workshop poster."
        edited = "user: Use the red workshop poster."
        server = GGUFServer.__new__(GGUFServer)
        server.context_size, server.compaction_summaries = 2048, {}

        def complete(body, *_args, **_options):
            chunk = {"choices": [{"delta": {"content": body["messages"][-1]["content"]}}]}
            return io.BytesIO(b"data: " + json.dumps(chunk).encode() + b"\n\ndata: [DONE]\n\n")

        server._post = Mock(return_value={"tokens": []})
        server._completion = Mock(side_effect=complete)

        def summarize(content):
            cancellation = CompletionCancellation()
            result = server._summarize(content, Mock(), cancellation)
            self.assertFalse(cancellation.streaming)
            self.assertFalse(cancellation.summary_streaming)
            return result

        self.assertEqual(summarize(transcript), transcript)
        self.assertEqual(summarize(transcript), transcript)
        server._post.assert_called_once()
        server._completion.assert_called_once()

        self.assertEqual(summarize(edited), edited)
        for index in range(8):
            summarize(f"Earlier transcript {index}")
        self.assertEqual(len(server.compaction_summaries), 8)
        self.assertEqual(summarize(transcript), transcript)
        self.assertEqual(server._completion.call_count, 11)

    def test_stream_result_retains_the_reported_finish_reason(self) -> None:
        server = GGUFServer.__new__(GGUFServer)
        server.context_size = 4096
        server.load_options = {}
        server.device = "CPU"
        server.backend = "cpu"
        server.history = {}
        server._prompt_tokens = Mock(return_value=16)
        server._completion = Mock()
        request = {"messages": [{"role": "user", "content": "Explain."}], "maxNewTokens": 64,
                   "temperature": 0.5, "topP": 0.9, "seed": 11}

        for reason in ("length", "stop", None):
            with self.subTest(reason=reason):
                chunks = [
                    {"choices": [{"delta": {"role": "assistant"}}]},
                    {"choices": [{"delta": {"content": "The answer"}}]},
                    {"choices": [{"delta": {}, "finish_reason": reason}]},
                    {"choices": [], "usage": {"prompt_tokens": 16, "completion_tokens": 64}},
                ]
                encoded = b"".join(b"data: " + json.dumps(chunk).encode() + b"\n\n" for chunk in chunks)
                server._completion.return_value = io.BytesIO(encoded + b"data: [DONE]\n\n")
                cancellation = CompletionCancellation()
                result = server.generate(request, Mock(), cancellation)
                self.assertTrue(cancellation.streaming)
                self.assertEqual(result["text"], "The answer")
                self.assertEqual(result["outputTokens"], 64)
                self.assertEqual(result["finishReason"], reason)


    def test_stream_reports_engine_timings_without_counting_the_role_header_as_output(self) -> None:
        server = GGUFServer.__new__(GGUFServer)
        server.context_size, server.backend, server.device = 4096, "cpu", "CPU"
        server.history, server.load_options = {}, {}
        server._prompt_tokens = Mock(return_value=16)
        request = {"messages": [{"role": "user", "content": "Explain."}], "maxNewTokens": 32,
                   "temperature": 0, "topP": 1, "seed": 0}
        chunks = [
            {"choices": [{"delta": {"role": "assistant"}}],
             "prompt_progress": {"total": 1800, "cache": 700, "processed": 700}},
            {"prompt_progress": {"total": 1800, "cache": 700, "processed": 1260}},
            {"prompt_progress": {"total": 1800, "cache": 700, "processed": 1275}},
            {"prompt_progress": {"total": 1800, "cache": 700, "processed": 1100}},
            {"prompt_progress": {"total": 1800, "cache": 700, "processed": "1300"}},
            {"prompt_progress": {"total": 1800, "cache": 700, "processed": 1800}},
            {"choices": [{"delta": {"content": "A reply"}}]},
            {"prompt_progress": {"total": 1800, "cache": 700, "processed": 1300}},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 16, "completion_tokens": 3},
             "timings": {"prompt_ms": 95.5, "predicted_ms": 200, "prompt_n": 6, "cache_n": 10}},
        ]
        invalid_timing = {"prompt_ms": -1, "predicted_ms": float("inf"), "prompt_n": 6.5, "cache_n": True}

        for raw, expected in (
            (chunks[-1]["timings"], {"prefillMs": 95.5, "decodeMs": 200, "evaluatedPromptTokens": 6, "cachedPromptTokens": 10}),
            (invalid_timing, {}),
            (None, {}),
        ):
            with self.subTest(raw=raw):
                chunks[-1]["timings"] = raw
                encoded = b"".join(b"data: " + json.dumps(chunk).encode() + b"\n\n" for chunk in chunks)
                server._completion = Mock(return_value=io.BytesIO(encoded + b"data: [DONE]\n\n"))
                emit = Mock()
                with patch("gguf_runtime.time.perf_counter", side_effect=[10, 10.25, 10.75, 11]):
                    result = server.generate(request, emit)
                self.assertTrue(server._completion.call_args.args[0]["return_progress"])
                self.assertEqual([call.args[0] for call in emit.call_args_list], [
                    {"type": "phase", "text": "Processing prompt…"},
                    {"type": "phase", "text": "Processing prompt · 50%"},
                    {"type": "token", "text": "A reply"},
                ])
                self.assertEqual(result["runtimeTiming"], {
                    "contextPreparationMs": 250, "firstOutputChunkMs": 500, **expected,
                })
                self.assertEqual(result["generationSeconds"], 0.75)
                self.assertEqual(result["outputTokens"], 3)

    def test_interrupted_startup_kills_the_server_without_waiting_for_graceful_shutdown(self) -> None:
        process = Mock()
        process.poll.return_value = None
        with (
            patch("gguf_runtime.subprocess.Popen", return_value=process),
            patch.object(GGUFServer, "_wait_ready", side_effect=SystemExit(0)),
            self.assertRaises(SystemExit),
        ):
            GGUFServer(Path("llama-server"), Path("model.gguf"), None, "CPU", "cpu")
        process.kill.assert_called_once_with()
        process.terminate.assert_not_called()
        process.wait.assert_called_once()

    def test_metal_startup_loads_and_verifies_placement_without_a_separate_probe(self) -> None:
        process = Mock()
        process.poll.return_value = 0
        on_phase = Mock()

        def launch(command, **options):
            on_phase.assert_called_once_with("selecting-device", "Preparing Apple GPU…")
            self.assertEqual(command[command.index("--device") + 1], "MTL0")
            self.assertIn("--mmproj-offload", command)
            self.assertIn("--log-timestamps", command)
            options["stdout"].write(b"offloaded 38/38 layers to GPU\nmtmd_backends: using MTL0 backend\n")
            return process

        with (
            patch("gguf_runtime.subprocess.run") as probe,
            patch.object(GGUFServer, "_wait_ready"),
            patch("gguf_runtime.subprocess.Popen", side_effect=launch),
            patch("gguf_runtime.time.perf_counter", side_effect=[2, 2.5, 3, 3.125]),
        ):
            server = GGUFServer(
                Path("llama-server"), Path("model.gguf"), Path("projector.gguf"), "GPU", "metal",
                gpu_projector=True, on_phase=on_phase,
            )
        self.addCleanup(server.close)
        probe.assert_not_called()
        self.assertEqual(server.startup_timing, {"serverReadyMs": 500, "placementVerificationMs": 125})

    def test_worker_reports_setup_and_model_ready_only_when_loading(self) -> None:
        from text_generation_worker import run_gguf
        requests = [
            {"op": "generate", "contextSize": 4096, "messages": [{"role": "user", "content": "Hello."}]}
            for _ in range(2)
        ]
        requests.append({"op": "shutdown"})
        stream = io.StringIO("".join(json.dumps(request) + "\n" for request in requests))
        phases = []
        engine = Mock(backend="openvino",
                      context_size=4096, gpu_projector=False, load_options={}, startup_timing={"serverReadyMs": 500})
        engine.process.poll.return_value = None
        engine.process.pid = 42
        engine.generate.side_effect = lambda *_args: {"type": "result", "runtimeTiming": {"prefillMs": 10}}

        def start_engine(*_args, on_phase, **_options):
            on_phase("loading-model", "Loading model…")
            return engine

        with (
            patch.dict(os.environ, {"FERN_GGUF_RUNTIME_ROOT": "scratch"}),
            patch("text_generation_worker.sys.platform", "win32"),
            patch("text_generation_worker.sys.stdin", stream),
            patch("text_generation_worker.resolve_text_device") as python_probe,
            patch("text_generation_worker.emit", side_effect=phases.append),
            patch("text_generation_worker.time.perf_counter", side_effect=[10, 10.125, 10.25, 10.875]),
            patch("gguf_runtime.ensure_runtime", return_value=Path("llama-server")) as setup,
            patch("gguf_runtime.GGUFServer", side_effect=start_engine),
        ):
            self.assertEqual(run_gguf(Path("model.gguf"), "AUTO", None), 0)
        python_probe.assert_not_called()
        setup.assert_called_once()
        self.assertEqual(setup.call_args.args[1], "openvino")
        self.assertEqual([event["text"] for event in phases if event["type"] == "phase" and "text" in event],
                         ["Loading model…", "Preparing conversation…", "Preparing conversation…"])
        self.assertEqual([event["model"] for event in phases if event["type"] == "residency"],
                         [{"backend": engine.backend, "device": "GPU", "enginePid": 42,
                           "gguf": {"contextSize": 4096, "loadOptions": {}}}])
        self.assertEqual([event["runtimeTiming"] for event in phases if event["type"] == "result"], [
            {"prefillMs": 10, "runtimeSetupMs": 125, "modelReadyMs": 625, "serverReadyMs": 500},
            {"prefillMs": 10},
        ])

    def test_worker_loads_a_missing_projector_and_reuses_it_for_follow_up(self) -> None:
        from text_generation_worker import run_gguf
        requests = [
            {"op": "generate", "contextSize": 4096, "messages": [{"role": "user", "content": "Hello."}]},
            {"op": "generate", "contextSize": 4096, "messages": [{"role": "user", "imagePath": "fixture.png"}]},
            {"op": "generate", "contextSize": 4096, "messages": [{"role": "user", "content": "Another question."}]},
            {"op": "shutdown"},
        ]
        for platform, device, backends in (
            ("darwin", "CPU", ["cpu", "cpu"]),
            ("linux", "CPU", ["cpu", "cpu"]),
            ("win32", "AUTO", ["openvino", "vulkan"]),
        ):
            with self.subTest(platform=platform, device=device):
                stream = io.StringIO("".join(json.dumps(request) + "\n" for request in requests))
                engines = [
                    Mock(backend=backend, context_size=4096, gpu_projector=False, load_options={}, startup_timing={})
                    for backend in backends
                ]
                for pid, engine in enumerate(engines, start=42):
                    engine.process.poll.return_value = None
                    engine.process.pid = pid
                    engine.generate.side_effect = lambda *_args: {"type": "result", "runtimeTiming": {}}
                with (
                    patch.dict(os.environ, {"FERN_GGUF_RUNTIME_ROOT": "scratch"}),
                    patch("text_generation_worker.sys.platform", platform),
                    patch("text_generation_worker.sys.stdin", stream),
                    patch("text_generation_worker.emit") as emit,
                    patch("gguf_runtime.ensure_runtime", return_value=Path("llama-server")),
                    patch("gguf_runtime.GGUFServer", side_effect=engines) as load,
                ):
                    projector = Path("projector.gguf")
                    self.assertEqual(run_gguf(Path("model.gguf"), device, projector), 0)
                self.assertEqual([(call.args[2], call.args[4]) for call in load.call_args_list],
                                 list(zip([None, projector], backends)))
                self.assertEqual([engine.generate.call_count for engine in engines], [1, 2])
                residents = [
                    call.args[0]["model"] for call in emit.call_args_list if call.args[0]["type"] == "residency"
                ]
                self.assertEqual([record and record["enginePid"] for record in residents], [42, None, 43])

    def test_windows_arc_probe_requires_the_tested_pci_adapter(self) -> None:
        import subprocess
        from gguf_runtime import windows_arc_b390

        adapter = rb"Instance ID: PCI\VEN_8086&DEV_B080&SUBSYS_22128086\3&11583659&0&10"
        with patch("gguf_runtime.sys.platform", "win32"), patch("gguf_runtime.subprocess.run") as run:
            run.return_value.stdout = adapter
            self.assertTrue(windows_arc_b390())
            run.return_value.stdout = adapter + b"\n" + rb"Instance ID: PCI\VEN_10DE&DEV_1234\1&0"
            self.assertFalse(windows_arc_b390())
            run.return_value.stdout = adapter.replace(b"B080", b"46A6")
            self.assertFalse(windows_arc_b390())
            run.side_effect = subprocess.TimeoutExpired("pnputil", 1)
            self.assertFalse(windows_arc_b390())

    def test_worker_prefers_vulkan_for_gemma_on_arc_and_falls_back_when_setup_fails(self) -> None:
        from gguf_runtime import VulkanDriverError
        from text_generation_worker import run_gguf

        cases = (
            ("win32", "AUTO", "gemma4", True, False, ["vulkan"]),
            ("win32", "GPU", "gemma4", True, True, ["vulkan", "openvino"]),
            ("win32", "GPU", "gemma4", False, False, ["openvino"]),
            ("win32", "GPU", "qwen3", True, False, ["openvino"]),
            ("win32", "CPU", "gemma4", True, False, ["openvino"]),
            ("linux", "GPU", "gemma4", True, False, ["openvino"]),
        )
        for platform, device, architecture, adapter, driver_failure, expected in cases:
            with self.subTest(platform=platform, device=device, architecture=architecture, driver_failure=driver_failure):
                request = {"op": "generate", "ggufArchitecture": architecture,
                           "messages": [{"role": "user", "content": "Hello."}]}
                stream = io.StringIO("".join(json.dumps(item) + "\n" for item in (request, request, {"op": "shutdown"})))
                engine = Mock(backend=expected[-1], context_size=8192, load_options={}, startup_timing={})
                engine.process.poll.return_value = None
                engine.generate.side_effect = lambda *_args: {"type": "result", "runtimeTiming": {}}
                with (
                    patch.dict(os.environ, {"FERN_GGUF_RUNTIME_ROOT": "scratch"}),
                    patch("text_generation_worker.sys.platform", platform),
                    patch("text_generation_worker.sys.stdin", stream),
                    patch("text_generation_worker.emit") as emit,
                    patch("gguf_runtime.windows_arc_b390", return_value=adapter) as probe,
                    patch("gguf_runtime.ensure_runtime", return_value=Path("llama-server")) as setup,
                    patch("gguf_runtime.GGUFServer",
                          side_effect=[VulkanDriverError("Driver unavailable"), engine] if driver_failure else [engine]),
                ):
                    engine.process.pid = 42
                    self.assertEqual(run_gguf(Path("model.gguf"), device, None), 0)
                self.assertEqual([call.args[1] for call in setup.call_args_list], expected)
                self.assertEqual(probe.call_count, int(platform == "win32" and device != "CPU" and architecture == "gemma4"))
                self.assertEqual(engine.generate.call_count, 2)
                self.assertEqual(sum(call.args[0]["type"] == "result" for call in emit.call_args_list), 2)

    def test_worker_recovers_one_openvino_gpu_shape_error_before_streaming(self) -> None:
        from gguf_runtime import GGUFComputeError
        from text_generation_worker import run_gguf

        first = {"op": "generate", "contextSize": 4096, "messages": [{"role": "user", "content": "A long prompt."}]}
        follow_up = {**first, "messages": [{"role": "user", "content": "Another question."}]}
        cases = (
            ("GPU", False, "Argument shapes are inconsistent.", ["openvino", "vulkan"], 2),
            ("GPU", True, "Argument shapes are inconsistent.", ["openvino"], 0),
            ("GPU", False, "An unrelated compute error.", ["openvino"], 0),
            ("CPU", False, "Argument shapes are inconsistent.", ["openvino"], 0),
        )

        for device, streaming, detail, expected, recovered in cases:
            with self.subTest(device=device, streaming=streaming, detail=detail):
                requests = [first, *([follow_up] if recovered else []), {"op": "shutdown"}]
                stream = io.StringIO("".join(json.dumps(request) + "\n" for request in requests))
                engines = [
                    Mock(backend=backend, context_size=4096, load_options={}, startup_timing={})
                    for backend in ("openvino", "vulkan")
                ]
                openvino, vulkan = engines
                for pid, engine in enumerate(engines, 51):
                    engine.process.poll.return_value = None
                    engine.process.pid = pid
                    engine.log_path.stat.return_value.st_size = 22

                def reject(_request, _emit, cancellation):
                    cancellation.streaming = streaming
                    raise GGUFComputeError("Compute error.")

                openvino.generate.side_effect = reject
                openvino.runtime_log_tail.return_value = detail
                vulkan.generate.side_effect = lambda *_args: {"type": "result", "runtimeTiming": {}}
                with (
                    patch.dict(os.environ, {"FERN_GGUF_RUNTIME_ROOT": "scratch"}),
                    patch("text_generation_worker.sys.platform", "win32"),
                    patch("text_generation_worker.sys.stdin", stream),
                    patch("text_generation_worker.emit") as emit,
                    patch("gguf_runtime.ensure_runtime", return_value=Path("llama-server")) as setup,
                    patch("gguf_runtime.GGUFServer", side_effect=engines),
                ):
                    self.assertEqual(run_gguf(Path("model.gguf"), device, None), 0)
                self.assertEqual([call.args[1] for call in setup.call_args_list], expected)
                self.assertEqual(vulkan.generate.call_count, recovered)
                event_types = [call.args[0]["type"] for call in emit.call_args_list]
                self.assertEqual(event_types.count("result"), recovered)
                self.assertEqual(event_types.count("error"), int(not recovered))
                if recovered:
                    openvino.close.assert_called_once_with(force=True)
                    self.assertEqual([call.args[0] for call in vulkan.generate.call_args_list], [first, follow_up])
                    openvino.runtime_log_tail.assert_called_once_with(after=22)

    def test_worker_reuses_engine_for_reply_settings_and_reloads_for_load_settings(self) -> None:
        from text_generation_worker import run_gguf
        base = {"op": "generate", "contextSize": 8192, "messages": [{"role": "user", "content": "Hello."}]}
        requests = [
            base,
            {**base, "systemPrompt": "Keep the answer short.", "temperature": 0.35, "maxNewTokens": 80},
            {**base, "loadOptions": {"flashAttention": "on"}},
            {**base, "contextSize": 4096, "loadOptions": {"flashAttention": "on"}},
            {"op": "shutdown"},
        ]
        stream = io.StringIO("".join(json.dumps(request) + "\n" for request in requests))
        engines = []

        def load(_executable, _model, _projector, _device, backend, context_size, **options):
            engine = Mock(backend=backend, context_size=context_size, startup_timing={}, **options)
            engine.process.poll.return_value = None
            engine.process.pid = len(engines) + 42
            engine.generate.side_effect = lambda *_args: {"type": "result", "runtimeTiming": {}}
            engines.append(engine)
            return engine

        with (
            patch.dict(os.environ, {"FERN_GGUF_RUNTIME_ROOT": "scratch"}),
            patch("text_generation_worker.sys.stdin", stream),
            patch("text_generation_worker.emit") as emit,
            patch("gguf_runtime.ensure_runtime", return_value=Path("llama-server")),
            patch("gguf_runtime.GGUFServer", side_effect=load),
        ):
            self.assertEqual(run_gguf(Path("model.gguf"), "CPU", None), 0)
        self.assertEqual([engine.generate.call_count for engine in engines], [2, 1, 1])
        self.assertEqual(engines[0].generate.call_args.args[0], requests[1])
        self.assertEqual(
            [call.args[0]["model"]["gguf"] for call in emit.call_args_list
             if call.args[0]["type"] == "residency" and call.args[0]["model"]],
            [
                {"contextSize": 8192, "loadOptions": {}},
                {"contextSize": 8192, "loadOptions": {"flashAttention": "on"}},
                {"contextSize": 4096, "loadOptions": {"flashAttention": "on"}},
            ],
        )

    def test_cancel_disconnects_a_completion_waiting_for_more_tokens(self) -> None:
        streaming = threading.Event()
        release = threading.Event()

        class DelayedCompletion(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                release.wait(5)

        with ThreadingHTTPServer(("127.0.0.1", 0), DelayedCompletion) as upstream:
            serving = threading.Thread(target=upstream.serve_forever, daemon=True)
            serving.start()
            server = GGUFServer.__new__(GGUFServer)
            server.base = f"http://127.0.0.1:{upstream.server_port}"
            server.key = "test"
            cancellation = CompletionCancellation()

            def stream():
                with server._completion({}, Mock(), cancellation) as response:
                    streaming.set()
                    return response.read()

            try:
                with ThreadPoolExecutor(1) as pool:
                    result = pool.submit(stream)
                    try:
                        self.assertTrue(streaming.wait(3))
                        cancellation.cancel()
                        with self.assertRaises(InterruptedError):
                            result.result(timeout=2)
                    finally:
                        release.set()
            finally:
                upstream.shutdown()
                serving.join()

    def test_cancel_disconnects_a_private_summary_without_caching_partial_text(self) -> None:
        chunk = b'data: {"choices":[{"delta":{"content":"Partial private summary"}}]}\n\n'
        release = threading.Event()

        class DelayedSummary(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(chunk)
                self.wfile.flush()
                release.wait(5)

        with ThreadingHTTPServer(("127.0.0.1", 0), DelayedSummary) as upstream:
            serving = threading.Thread(target=upstream.serve_forever, daemon=True)
            serving.start()
            engine = GGUFServer.__new__(GGUFServer)
            engine.base, engine.key = f"http://127.0.0.1:{upstream.server_port}", "test"
            engine.context_size, engine.compaction_summaries = 2048, {}
            engine._post = Mock(return_value={"tokens": []})
            cancellation = CompletionCancellation()
            emit = Mock()
            try:
                with ThreadPoolExecutor(1) as pool:
                    result = pool.submit(engine._summarize, "Old chat", emit, cancellation)
                    try:
                        deadline = time.monotonic() + 3
                        while not cancellation.summary_streaming and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertTrue(cancellation.summary_streaming)
                        cancellation.cancel()
                        with self.assertRaises(InterruptedError):
                            result.result(timeout=2)
                    finally:
                        release.set()
            finally:
                upstream.shutdown()
                serving.join()

        emit.assert_called_once_with({"type": "cancellable"})
        self.assertFalse(cancellation.streaming)
        self.assertEqual(engine.compaction_summaries, {})

    def test_worker_keeps_engine_after_stopping_summary_decode_but_reloads_after_prefill(self) -> None:
        from text_generation_worker import run_gguf

        requests = [
            {"op": "generate", "contextSize": 2048, "messages": [{"role": "user", "content": question}]}
            for question in ("First", "Next")
        ]
        for summary_streaming in (False, True):
            with self.subTest(summary_streaming=summary_streaming):
                stream = io.StringIO("".join(json.dumps(request) + "\n" for request in [*requests, {"op": "shutdown"}]))
                engines = [
                    Mock(backend="cpu", context_size=2048, load_options={}, startup_timing={})
                    for _ in range(2)
                ]
                for pid, engine in enumerate(engines, start=42):
                    engine.process.pid = pid
                    engine.process.poll.return_value = None

                answer = {"type": "result", "text": "Next", "runtimeTiming": {}}

                def generate(request, _emit, cancellation):
                    if request["messages"][0]["content"] == "First":
                        cancellation.summary_streaming = summary_streaming
                        raise InterruptedError("Generation stopped.")
                    return answer

                engines[0].generate.side_effect = generate
                engines[1].generate.return_value = answer

                with (
                    patch.dict(os.environ, {"FERN_GGUF_RUNTIME_ROOT": "scratch"}),
                    patch("text_generation_worker.sys.platform", "linux"),
                    patch("text_generation_worker.sys.stdin", stream),
                    patch("text_generation_worker.emit") as emit,
                    patch("gguf_runtime.ensure_runtime", return_value=Path("llama-server")),
                    patch("gguf_runtime.GGUFServer", side_effect=engines) as load,
                ):
                    self.assertEqual(run_gguf(Path("model.gguf"), "CPU", None), 0)

                self.assertEqual(load.call_count, 1 if summary_streaming else 2)
                self.assertEqual(engines[0].generate.call_count, 2 if summary_streaming else 1)
                self.assertIn({"type": "cancelled"}, [call.args[0] for call in emit.call_args_list])
                if not summary_streaming:
                    engines[0].close.assert_called_once_with(force=True)

    def test_force_close_kills_the_runtime_without_waiting_for_graceful_shutdown(self) -> None:
        server = GGUFServer.__new__(GGUFServer)
        server.process = Mock()
        server.process.poll.return_value = None
        server.diagnostics = Mock()
        server.close(force=True)
        server.process.kill.assert_called_once_with()
        server.process.terminate.assert_not_called()
        server.diagnostics.cleanup.assert_called_once_with()


class VulkanRuntimeTests(unittest.TestCase):
    def test_gguf_output_can_use_more_than_half_of_the_available_context(self) -> None:
        server = object.__new__(GGUFServer)
        server.backend, server.device, server.context_size = "vulkan", "GPU", 4096
        server.history, server.load_options = {}, {}
        server._prompt_tokens = Mock()
        server._completion = Mock()
        request = {"messages": [{"role": "user", "content": "Hello."}],
                   "temperature": 0, "topP": 1, "seed": 0}
        for prompt, requested, expected in ((768, 512, 512), (768, 2450, 2450), (768, 4096, 3072), (2200, 4096, 1640)):
            with self.subTest(prompt=prompt, requested=requested):
                server._prompt_tokens.return_value = prompt
                server._completion.return_value = io.BytesIO(b"data: [DONE]\n")
                result = server.generate({**request, "maxNewTokens": requested}, Mock())
                self.assertEqual(server._completion.call_args.args[0]["max_tokens"], expected)
                self.assertEqual(result["maxNewTokens"], expected)

    def test_download_reuse_and_repair_missing_backend_dll(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def download(url, target, spec, progress):
                self.assertTrue(url.endswith("-bin-win-vulkan-x64.zip"))
                self.assertEqual(spec["algorithm"], "sha256")
                with zipfile.ZipFile(target, "w") as archive:
                    archive.writestr("llama-server.exe", b"server")
                    archive.writestr("ggml-vulkan.dll", b"backend")
                    archive.writestr("mtmd.dll", b"vision")

            with patch("gguf_runtime.sys.platform", "win32"), \
                 patch("gguf_runtime.runtime_supported", return_value=True), \
                 patch("gguf_runtime.download_file", side_effect=download) as fetch:
                executable = ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(ensure_runtime(root, "vulkan", Mock()), executable)
                self.assertEqual(fetch.call_count, 1)
                (executable.parent / "ggml-vulkan.dll").unlink()
                self.assertEqual(ensure_runtime(root, "vulkan", Mock()), executable)
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual((executable.parent / "ggml-vulkan.dll").read_bytes(), b"backend")
                (executable.parent / "mtmd.dll").write_bytes(b"")
                ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(fetch.call_count, 3)
                self.assertEqual((executable.parent / "mtmd.dll").read_bytes(), b"vision")

    @unittest.skipIf(os.name == "nt", "requires Unix permissions and symlinks")
    def test_linux_tar_preserves_executable_and_repairs_shared_library(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "assets"
            assets.mkdir()
            server = assets / "llama-server"
            server.write_bytes(b"server")
            server.chmod(0o755)
            (assets / "libggml-vulkan.so.1").write_bytes(b"backend")
            (assets / "libggml-vulkan.so").symlink_to("libggml-vulkan.so.1")

            def download(url, target, spec, progress):
                self.assertTrue(url.endswith("-bin-ubuntu-vulkan-x64.tar.gz"))
                with tarfile.open(target, "w:gz") as archive:
                    archive.add(assets, arcname="llama-b12498")

            with patch("gguf_runtime.sys.platform", "linux"), \
                 patch("gguf_runtime.runtime_supported", return_value=True), \
                 patch("gguf_runtime.download_file", side_effect=download) as fetch:
                executable = ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(executable.stat().st_mode & 0o100, 0o100)
                self.assertEqual(ensure_runtime(root, "vulkan", Mock()), executable)
                self.assertEqual(fetch.call_count, 1)
                (executable.parent / "libggml-vulkan.so.1").unlink()
                ensure_runtime(root, "vulkan", Mock())
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual((executable.parent / "libggml-vulkan.so").read_bytes(), b"backend")

    @unittest.skipIf(os.name == "nt", "requires Unix executable permissions")
    def test_mac_uses_one_verified_arm64_archive_for_metal_and_cpu(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "assets"
            assets.mkdir()
            for name in ("llama-server", "libggml-metal.dylib", "libllama-server-impl.dylib", "libmtmd.dylib"):
                (assets / name).write_bytes(b"fixture")
            (assets / "llama-server").chmod(0o755)

            def download(url, target, spec, progress):
                self.assertTrue(url.endswith("-bin-macos-arm64.tar.gz"))
                self.assertEqual(spec["algorithm"], "sha256")
                with tarfile.open(target, "w:gz") as archive:
                    archive.add(assets, arcname="llama-b12498")

            with (
                patch("gguf_runtime.sys.platform", "darwin"),
                patch("gguf_runtime.platform.machine", return_value="arm64") as machine,
                patch("gguf_runtime.download_file", side_effect=download) as fetch,
            ):
                executable = ensure_runtime(root, "metal", Mock())
                self.assertEqual(ensure_runtime(root, "cpu", Mock()), executable)
                self.assertEqual(fetch.call_count, 1)
                (executable.parent / "libmtmd.dylib").unlink()
                ensure_runtime(root, "metal", Mock())
                self.assertEqual(fetch.call_count, 2)
                machine.return_value = "x86_64"
                self.assertFalse(runtime_supported())

    @unittest.skipIf(os.name == "nt", "requires Unix executable permissions")
    def test_mac_prefers_complete_packaged_metal_without_replacing_the_downloaded_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            resources = root / "Fern.app/Contents/Resources"
            packaged = resources / "runtime/llama-b12498-macos-arm64-precompiled"
            cache = root / "cache"
            upstream = cache / "llama-b12498-macos-arm64"
            needed = ("llama-server", "libggml-metal.dylib", "libllama-server-impl.dylib", "libmtmd.dylib")
            for folder, names in ((upstream, needed), (packaged, (*needed, "default.metallib", "libllama.1.dylib"))):
                folder.mkdir(parents=True)
                for name in names:
                    (folder / name).write_bytes(b"fixture")
                (folder / "llama-server").chmod(0o755)
                manifest = "runtime.json" if folder == packaged else ".fern-runtime.json"
                (folder / manifest).write_text(json.dumps(dict.fromkeys(names, len(b"fixture"))), encoding="utf-8")
            # Signing may change the sizes of packaged Mach-O files.
            (packaged / "libllama.1.dylib").write_bytes(b"signed fixture")
            with (
                patch("gguf_runtime.__file__", str(resources / "scripts/gguf_runtime.py")),
                patch("gguf_runtime.sys.platform", "darwin"),
                patch("gguf_runtime.platform.machine", return_value="arm64"),
                patch("gguf_runtime.download_file") as fetch,
            ):
                self.assertEqual(ensure_runtime(cache, "metal", Mock()), packaged.resolve() / "llama-server")
                self.assertEqual(ensure_runtime(cache, "cpu", Mock()), upstream / "llama-server")
                (packaged / "libllama.1.dylib").unlink()
                self.assertEqual(ensure_runtime(cache, "metal", Mock()), upstream / "llama-server")
                fetch.assert_not_called()

    def test_metal_rejects_a_missing_gpu_without_falling_back_to_cpu(self) -> None:
        process = Mock()
        process.poll.return_value = 1

        def launch(_command, **options):
            options["stdout"].write(b"error while handling argument \"--device\": invalid device: MTL0\n")
            return process

        with (
            patch("gguf_runtime.subprocess.Popen", side_effect=launch) as server,
            self.assertRaisesRegex(RuntimeError, "could not find an Apple GPU"),
        ):
            GGUFServer(Path("llama-server"), Path("model.gguf"), None, "GPU", "metal")
        server.assert_called_once()

    def test_missing_windows_vulkan_loader_requests_driver(self) -> None:
        server = object.__new__(GGUFServer)
        server.backend = "vulkan"
        server.device = "GPU"
        with patch("gguf_runtime.sys.platform", "win32"), patch("gguf_runtime.ctypes.WinDLL", side_effect=OSError, create=True):
            with self.assertRaisesRegex(VulkanDriverError, "could not load Vulkan") as error:
                server._select_device(Path("llama-server.exe"), {}, 0)
        self.assertEqual(error.exception.code, "intel-vulkan-driver")

    def test_missing_intel_adapter_requests_driver(self) -> None:
        server = object.__new__(GGUFServer)
        server.backend = "vulkan"
        server.device = "GPU"
        result = subprocess.CompletedProcess([], 1, stdout="Available devices:\n", stderr="")
        with patch("gguf_runtime.sys.platform", "win32"), patch("gguf_runtime.ctypes.WinDLL", create=True), \
             patch("gguf_runtime.subprocess.run", return_value=result):
            with self.assertRaisesRegex(VulkanDriverError, "compatible Intel GPU"):
                server._select_device(Path("llama-server.exe"), {}, 0)
