"""Persistent local chat worker with a line-oriented JSON protocol."""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
import traceback
from pathlib import Path
from queue import SimpleQueue
from typing import Any

from chat_documents import add_document_context
from text_runtime_errors import OUT_OF_MEMORY, has_memory_failure, text_runtime_error_code


PREFIX = "FERN_TEXT_EVENT:"


def resolve_text_device(requested: str) -> str:
    if requested not in ("AUTO", "GPU", "CPU"):
        raise ValueError("Choose Auto, Intel GPU, or CPU.")
    import openvino as ov
    devices = {str(item).split(".", 1)[0] for item in ov.Core().available_devices}
    if requested == "AUTO":
        if "GPU" not in devices:
            raise ValueError("Auto requires a supported GPU. Choose CPU explicitly if you want CPU inference.")
        return "GPU"
    if requested not in devices:
        raise ValueError(f"The OpenVINO {requested} device is not available.")
    return requested


def emit(payload: dict[str, Any]) -> None:
    print(PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


def run_gguf(file: Path, device: str, projector: Path | None) -> int:
    from chat_context import DEFAULT_CONTEXT_SIZE
    from gguf_runtime import CompletionCancellation, GGUFComputeError, GGUFServer, ensure_runtime, windows_arc_b390

    runtime_root = Path(os.environ["FERN_GGUF_RUNTIME_ROOT"])
    requests: SimpleQueue[tuple[dict[str, Any], CompletionCancellation] | None] = SimpleQueue()

    def read_requests() -> None:
        cancellation = None
        try:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                except json.JSONDecodeError:
                    request = {}
                if not isinstance(request, dict):
                    request = {}
                if request.get("op") == "cancel":
                    if cancellation is not None:
                        cancellation.cancel()
                else:
                    cancellation = CompletionCancellation()
                    requests.put((request, cancellation))
                    if request.get("op") == "shutdown":
                        return
        finally:
            if cancellation is not None:
                cancellation.cancel()
            requests.put(None)

    threading.Thread(target=read_requests, daemon=True).start()
    server = None
    loaded_projector = None
    arc_b390 = None

    def startup_phase(stage: str, text: str) -> None:
        emit({"type": "phase", "stage": stage, "text": text})

    try:
        while pending := requests.get():
            request, cancellation = pending
            log_offset = None
            try:
                if request.get("op") == "shutdown":
                    return 0
                if request.get("op") != "generate":
                    raise ValueError("Unsupported text worker request.")
                vision = bool(request.get("tools")) or any(message.get("imagePath") for message in request["messages"])
                context_size = request.get("contextSize", DEFAULT_CONTEXT_SIZE)
                load_options = request.get("loadOptions") or {}
                if vision and not projector:
                    raise ValueError("Add the model's vision projector before sending an image.")
                if device not in ("AUTO", "GPU", "CPU"):
                    raise ValueError("Choose Auto, Intel GPU, or CPU.")
                emit({"type": "phase", "stage": "selecting-device"})
                # The GGUF engine enumerates its own devices before loading the model.
                # Importing Python OpenVINO here duplicates that check and can stall
                # the worker during NumPy initialization on Windows.
                target = "CPU" if device == "CPU" else "GPU"
                same_configuration = (
                    server is not None and server.process is not None and server.process.poll() is None
                    and server.context_size == context_size and server.load_options == load_options
                )
                preferred_vulkan = False
                if sys.platform == "darwin":
                    backend = "cpu" if target == "CPU" else "metal"
                elif vision:
                    # The pinned OpenVINO build cannot prefill Gemma 4 vision.
                    backend = "cpu" if target == "CPU" else "vulkan"
                elif same_configuration and server.backend == "vulkan":
                    # The vision runtime also handles plain text. Keep its model loaded.
                    backend = "vulkan"
                elif sys.platform == "win32" and target == "GPU" and request.get("ggufArchitecture") == "gemma4":
                    if arc_b390 is None:
                        arc_b390 = windows_arc_b390()
                    preferred_vulkan = arc_b390
                    backend = "vulkan" if preferred_vulkan else "openvino"
                else:
                    backend = "openvino"
                requested_projector = projector if vision else None

                def complete(engine: str, reuse: bool) -> dict[str, Any]:
                    nonlocal server, loaded_projector, log_offset
                    log_offset = None
                    emit({"type": "runtime", "backend": engine, "device": target})
                    gpu_projector = vision and (engine == "metal" or bool(request.get("requireGpuVision")))
                    if gpu_projector and engine not in ("vulkan", "metal"):
                        raise ValueError("This image conversation requires GPU vision. Select Available GPU in Preferences.")
                    load_timing = {}
                    if (
                        not reuse or server.backend != engine
                        or (vision and (loaded_projector != requested_projector or server.gpu_projector != gpu_projector))
                    ):
                        if server is not None:
                            emit({"type": "residency", "model": None})
                            server.close()
                            server = None

                        def setup_progress(text: str) -> None:
                            emit({"type": "phase", "text": text})

                        emit({"type": "phase", "stage": "setting-up-runtime"})
                        setup_started = time.perf_counter()
                        executable = ensure_runtime(runtime_root, engine, setup_progress)
                        load_timing["runtimeSetupMs"] = (time.perf_counter() - setup_started) * 1000
                        load_started = time.perf_counter()
                        server = GGUFServer(
                            executable, file, requested_projector, target, engine, context_size,
                            gpu_projector=gpu_projector, load_options=load_options, on_phase=startup_phase,
                        )
                        load_timing.update(server.startup_timing)
                        loaded_projector = requested_projector
                        emit({"type": "residency", "model": {
                            "backend": engine, "device": target, "enginePid": server.process.pid,
                            "gguf": {"contextSize": server.context_size, "loadOptions": server.load_options},
                        }})
                        load_timing["modelReadyMs"] = (time.perf_counter() - load_started) * 1000
                    emit({"type": "phase", "stage": "preparing-conversation", "text": "Preparing conversation…"})
                    try:
                        log_offset = server.log_path.stat().st_size
                    except OSError:
                        pass
                    result = server.generate(request, emit, cancellation)
                    result["runtimeTiming"].update(load_timing)
                    return result

                try:
                    result = complete(backend, same_configuration)
                except InterruptedError:
                    raise
                except (OSError, RuntimeError) as error:
                    if preferred_vulkan and server is None and text_runtime_error_code(error) != OUT_OF_MEMORY:
                        cancellation.check()
                        arc_b390 = False
                        startup_phase("setting-up-runtime", "Vulkan setup failed. Trying OpenVINO…")
                        result = complete("openvino", False)
                    elif (isinstance(error, GGUFComputeError) and backend == "openvino" and target == "GPU"
                          and not cancellation.streaming
                          and "argument shapes are inconsistent" in server.runtime_log_tail(after=log_offset or 0).lower()):
                        cancellation.check()
                        startup_phase("setting-up-runtime", "Switching GPU runtimes…")
                        emit({"type": "residency", "model": None})
                        server.close(force=True)
                        server = None
                        result = complete("vulkan", False)
                    else:
                        raise
                emit(result)
            except InterruptedError:
                # A disconnected prompt prefill can still hold the inference slot.
                if server is not None and not cancellation.streaming:
                    emit({"type": "residency", "model": None})
                    server.close(force=True)
                    server = None
                emit({"type": "cancelled"})
            except Exception as error:
                code = text_runtime_error_code(error)
                if (not code and log_offset is not None and server is not None and server.process is not None
                        and server.process.poll() is not None and has_memory_failure(server.runtime_log_tail(after=log_offset))):
                    code = OUT_OF_MEMORY
                emit({"type": "error", "error": str(error), "code": code,
                      "traceback": traceback.format_exc()})
        return 0
    finally:
        if server is not None:
            server.close()


def run(model_path: str, device: str, projector_path: str = "") -> int:
    folder = Path(model_path).resolve(strict=True)
    if folder.is_file() and folder.suffix.lower() == ".gguf":
        projector = Path(projector_path).resolve(strict=True) if projector_path else None
        return run_gguf(folder, device, projector)

    try:
        emit({"type": "phase", "stage": "selecting-device"})
        device = resolve_text_device(device)
    except Exception as error:
        emit({"type": "error", "error": str(error), "code": text_runtime_error_code(error)})
        return 1

    try:
        emit({"type": "runtime", "backend": "openvino", "device": device})
        emit({"type": "phase", "stage": "setting-up-runtime"})
        import openvino_genai as genai
    except Exception as error:
        emit({"type": "error", "error": f"OpenVINO GenAI is unavailable: {error}", "code": text_runtime_error_code(error)})
        return 1

    pipeline = None
    tokenizer = None
    while True:
        line = sys.stdin.readline()
        if not line:
            return 0
        try:
            request = json.loads(line)
            if request.get("op") == "shutdown":
                return 0
            if request.get("op") != "generate":
                raise ValueError("Unsupported text worker request.")
            emit({"type": "runtime", "backend": "openvino", "device": device})
            preparing = {"type": "phase", "stage": "preparing-conversation"}
            if pipeline is None:
                emit({"type": "phase", "stage": "loading-model", "text": "Loading the OpenVINO model…"})
                pipeline = genai.LLMPipeline(str(folder), device)
                tokenizer = pipeline.get_tokenizer()
                emit({"type": "residency", "model": {"backend": "openvino", "device": device}})
                preparing["text"] = "Model ready. Preparing the conversation…"

            emit(preparing)

            messages = request["messages"]
            if request.get("systemPrompt", "").strip():
                messages = [{"role": "system", "content": request["systemPrompt"].strip()}, *messages]
            sources = []
            if passages := request.get("documentPassages"):
                def characters(turns):
                    return sum(len(turn["content"]) for turn in turns)
                budget = min(80_000, characters(messages) + min(request["contextSize"] * 2, 12_000))
                messages, sources, _ = add_document_context(messages, passages, budget, characters, chars_per_unit=1)
            prompt = tokenizer.apply_chat_template(messages, True)

            config = pipeline.get_generation_config()
            config.apply_chat_template = False
            config.max_new_tokens = int(request["maxNewTokens"])
            config.temperature = max(float(request["temperature"]), 0.01)
            config.top_p = float(request["topP"])
            config.do_sample = float(request["temperature"]) > 0
            config.rng_seed = int(request.get("seed", 0))
            sampling = request.get("sampling") or {}
            for option, attribute in (("topK", "top_k"), ("minP", "min_p"), ("repeatPenalty", "repetition_penalty")):
                if option in sampling:
                    setattr(config, attribute, sampling[option])
            if "stopSequences" in sampling:
                config.stop_strings = set(sampling["stopSequences"])

            parts: list[str] = []
            started = time.perf_counter()

            def stream(token: str) -> bool:
                parts.append(token)
                emit({"type": "token", "text": token})
                return False

            # A one-element batch returns DecodedResults (single strings return
            # only text in supported release runtimes), retaining true metrics.
            emit({"type": "phase", "stage": "waiting-for-first-token", "text": "Waiting for the first token…"})
            result = pipeline.generate([prompt], config, stream)
            elapsed = max(time.perf_counter() - started, 0.001)
            output = result.texts[0] if result.texts else "".join(parts)
            input_tokens = result.perf_metrics.get_num_input_tokens()
            output_tokens = result.perf_metrics.get_num_generated_tokens()
            reasons = getattr(result, "finish_reasons", ())
            finish_reason = reasons[0].name.lower() if reasons else None
            emit({
                "type": "result",
                "device": device,
                "text": output,
                **({"documentSources": sources} if sources else {}),
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "finishReason": finish_reason,
                "generationSeconds": elapsed,
                "tokensPerSecond": output_tokens / elapsed,
            })
        except Exception as error:
            emit({"type": "error", "error": str(error), "code": text_runtime_error_code(error),
                  "traceback": traceback.format_exc()})


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("Usage: text_generation_worker.py MODEL_PATH DEVICE [PROJECTOR_PATH]")
    if os.name != "nt":
        def exit_on_terminate(_signal, _frame):
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, exit_on_terminate)
    raise SystemExit(run(*sys.argv[1:]))
