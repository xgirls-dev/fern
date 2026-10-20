"""Persistent OpenVINO GenAI worker with a line-oriented JSON protocol."""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any


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


def run(model_path: str, device: str) -> int:
    try:
        import openvino_genai as genai
    except Exception as error:
        emit({"type": "error", "error": f"OpenVINO GenAI is unavailable: {error}"})
        return 1

    try:
        device = resolve_text_device(device)
    except Exception as error:
        emit({"type": "error", "error": str(error)})
        return 1

    folder = Path(model_path).resolve(strict=True)
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
            prompt = tokenizer.apply_chat_template(messages, True)

            config = pipeline.get_generation_config()
            config.apply_chat_template = False
            config.max_new_tokens = int(request["maxNewTokens"])
            config.temperature = max(float(request["temperature"]), 0.01)
            config.top_p = float(request["topP"])
            config.do_sample = float(request["temperature"]) > 0
            config.rng_seed = int(request.get("seed", 0))

            parts: list[str] = []
            started = time.perf_counter()

            def stream(token: str) -> bool:
                parts.append(token)
                emit({"type": "token", "text": token})
                return False

            # A one-element batch returns DecodedResults (single strings return
            # only text in supported release runtimes), retaining true metrics.
            result = pipeline.generate([prompt], config, stream)
            elapsed = max(time.perf_counter() - started, 0.001)
            output = result.texts[0] if result.texts else "".join(parts)
            input_tokens = result.perf_metrics.get_num_input_tokens()
            output_tokens = result.perf_metrics.get_num_generated_tokens()
            emit({
                "type": "result",
                "device": device,
                "text": output,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "generationSeconds": elapsed,
                "tokensPerSecond": output_tokens / elapsed,
            })
        except Exception as error:
            emit({"type": "error", "error": str(error), "traceback": traceback.format_exc()})


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: text_generation_worker.py MODEL_PATH DEVICE")
    raise SystemExit(run(sys.argv[1], sys.argv[2]))
