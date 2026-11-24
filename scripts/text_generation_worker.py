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
    from gguf_runtime import CompletionCancellation, GGUFServer, ensure_runtime

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
    try:
        while pending := requests.get():
            request, cancellation = pending
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
                if sys.platform == "darwin":
                    target = "CPU" if device == "CPU" else "GPU"
                    backend = "cpu" if target == "CPU" else "metal"
                elif vision:
                    # The pinned OpenVINO build cannot prefill Gemma 4 vision.
                    target = "CPU" if device == "CPU" else "GPU"
                    backend = "cpu" if target == "CPU" else "vulkan"
                else:
                    target, backend = resolve_text_device(device), "openvino"
                gpu_projector = vision and (backend == "metal" or bool(request.get("requireGpuVision")))
                if gpu_projector and backend not in ("vulkan", "metal"):
                    raise ValueError("This image conversation requires GPU vision. Select Available GPU in Preferences.")
                load_timing = {}
                if (
                    server is None or server.backend != backend or server.context_size != context_size
                    or server.gpu_projector != gpu_projector or server.load_options != load_options
                ):
                    if server is not None:
                        server.close()
                        server = None
                    phase = lambda text: emit({"type": "phase", "text": text})
                    setup_started = time.perf_counter()
                    executable = ensure_runtime(runtime_root, backend, phase)
                    load_timing["runtimeSetupMs"] = (time.perf_counter() - setup_started) * 1000
                    phase(f"Loading the GGUF model with {backend}…")
                    load_started = time.perf_counter()
                    server = GGUFServer(
                        executable, file, projector if vision else None, target, backend, context_size,
                        gpu_projector=gpu_projector, load_options=load_options,
                    )
                    load_timing["modelReadyMs"] = (time.perf_counter() - load_started) * 1000
                result = server.generate(request, emit, cancellation)
                result["runtimeTiming"].update(load_timing)
                emit(result)
            except InterruptedError:
                # A disconnected prompt prefill can still hold the inference slot.
                if server is not None and not cancellation.streaming:
                    server.close(force=True)
                    server = None
                emit({"type": "cancelled"})
            except Exception as error:
                emit({"type": "error", "error": str(error), "code": getattr(error, "code", None),
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
        device = resolve_text_device(device)
    except Exception as error:
        emit({"type": "error", "error": str(error)})
        return 1

    try:
        import openvino_genai as genai
    except Exception as error:
        emit({"type": "error", "error": f"OpenVINO GenAI is unavailable: {error}"})
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
            if pipeline is None:
                emit({"type": "phase", "text": "Loading the OpenVINO model…"})
                pipeline = genai.LLMPipeline(str(folder), device)
                tokenizer = pipeline.get_tokenizer()
                emit({"type": "phase", "text": "Model ready. Preparing the conversation…"})

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
            emit({"type": "phase", "text": "Waiting for the first token…"})
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
            emit({"type": "error", "error": str(error), "traceback": traceback.format_exc()})


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("Usage: text_generation_worker.py MODEL_PATH DEVICE [PROJECTOR_PATH]")
    if os.name != "nt":
        def exit_on_terminate(_signal, _frame):
            raise SystemExit(0)

        signal.signal(signal.SIGTERM, exit_on_terminate)
    raise SystemExit(run(*sys.argv[1:]))
