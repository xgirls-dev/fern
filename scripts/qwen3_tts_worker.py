"""Isolated Qwen3-TTS OpenVINO download and inference entry point."""
from __future__ import annotations

import argparse
import base64
import gc
import io
import json
import os
import sys
import time
import traceback
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")


MODEL_IDS = {
    "custom-0.6b": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    "custom-1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "base-0.6b": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    "base-1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    "voice-design-1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
}
EVENT_PREFIX = "FERN_TTS_EVENT:"
PROGRESS_PREFIX = "FERN_TTS_PROGRESS:"


def progress(message: str) -> None:
    print(PROGRESS_PREFIX + message, flush=True)
_PIPELINE_KEY = None
_PIPELINE = None


def load_pipeline(model_dir: Path, device: str):
    global _PIPELINE_KEY, _PIPELINE
    if device.upper() == "AUTO":
        import openvino as ov

        available = {name.upper() for name in ov.Core().available_devices}
        if not any(name.startswith("GPU") for name in available):
            raise RuntimeError("No supported Intel GPU is available. Install the Intel graphics driver or choose CPU explicitly in Device settings.")
        device = "GPU"
        progress("Auto selected Intel GPU.")
    key = (str(model_dir.resolve()), device.upper())
    if _PIPELINE_KEY == key and _PIPELINE is not None:
        progress("Model is warm and ready.")
        return _PIPELINE
    _PIPELINE = None
    _PIPELINE_KEY = None
    gc.collect()
    runtime_dir = Path(__file__).with_name("tts_runtime")
    sys.path.insert(0, str(runtime_dir))
    progress(f"Loading speech runtime for {device}. First load can take several minutes.")
    from qwen_3_tts_helper import OVQwen3TTSModel

    started = time.monotonic()
    progress(f"Compiling voice model and speech tokenizer on {device}.")
    pipeline = OVQwen3TTSModel.from_pretrained(model_dir=str(model_dir), device=device)
    progress(f"Model ready on {device} · loaded in {time.monotonic() - started:.1f}s.")
    _PIPELINE_KEY, _PIPELINE = key, pipeline
    return pipeline


def setup(model_key: str, model_root: Path) -> None:
    from tts_model_download import install_model

    install_model(model_key, model_root, progress)


def generate(request: dict, model_root: Path, outputs: Path) -> dict:
    import numpy as np
    import soundfile as sf

    model_key = request["model"]
    model_dir = model_root / f"{model_key}-OV"
    pipeline = load_pipeline(model_dir, request.get("device", "AUTO"))
    started = time.monotonic()
    text = request["text"].strip()
    language = request.get("language") or None
    kind = pipeline.tts_model_type
    kwargs = {"max_new_tokens": min(max(int(request.get("max_new_tokens", 2048)), 16), 4096), "non_streaming_mode": True}
    if kind == "custom_voice":
        progress("Synthesizing speech with the preset voice.")
        wavs, sample_rate = pipeline.generate_custom_voice(
            text, speaker=request.get("speaker", "vivian").lower().replace(" ", "_"),
            language=language, instruct=request.get("instruction") or None, **kwargs,
        )
    elif kind == "voice_design":
        progress("Designing voice and synthesizing speech.")
        wavs, sample_rate = pipeline.generate_voice_design(
            text, language=language, instruct=request.get("instruction") or "A natural, clear speaking voice.", **kwargs,
        )
    elif kind == "base":
        reference = request.get("referenceAudio")
        if not reference:
            raise ValueError("Voice cloning requires a reference audio clip.")
        raw = base64.b64decode(reference, validate=True)
        waveform, sample_rate_in = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
        if waveform.ndim > 1:
            waveform = waveform.mean(axis=1)
        if not waveform.size or not np.isfinite(waveform).all():
            raise ValueError("The reference clip is empty or contains invalid audio. Choose another WAV or FLAC.")
        progress(f"Cloning reference voice · {len(waveform) / sample_rate_in:.1f}s clip. Synthesizing speech.")
        wavs, sample_rate = pipeline.generate_voice_clone(
            text, language=language, ref_audio=(waveform, sample_rate_in),
            ref_text=request.get("referenceText") or None,
            x_vector_only_mode=not bool(request.get("referenceText")), **kwargs,
        )
    else:
        raise RuntimeError(f"Unsupported Qwen3-TTS model type: {kind}")
    if not wavs:
        raise RuntimeError("Qwen3-TTS returned no audio.")
    audio = np.asarray(wavs[0], dtype=np.float32).squeeze()
    if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all():
        raise RuntimeError("Qwen3-TTS returned an empty or invalid audio waveform.")
    output = outputs / request["outputName"]
    progress(f"Speech synthesized in {time.monotonic() - started:.1f}s. Saving WAV.")
    sf.write(str(output), audio, int(sample_rate), format="WAV", subtype="PCM_16")
    return {"name": output.name, "url": f"/outputs/{output.name}", "sampleRate": int(sample_rate), "duration": float(len(audio) / sample_rate)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("setup", "generate", "serve"))
    parser.add_argument("--model", required=True, choices=tuple(MODEL_IDS))
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--outputs", type=Path)
    parser.add_argument("--device", default="AUTO")
    args = parser.parse_args()
    try:
        tts_hf_cache = args.model_root / "huggingface-cache"
        os.environ.setdefault("HF_HOME", str(tts_hf_cache))
        os.environ.setdefault("HF_HUB_CACHE", str(tts_hf_cache / "hub"))
        if args.operation == "setup":
            setup(args.model, args.model_root)
            print(json.dumps({"complete": True}), flush=True)
        elif args.operation == "generate":
            request = json.load(sys.stdin)
            print(json.dumps(generate(request, args.model_root, args.outputs)), flush=True)
        else:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    if request.get("model") != args.model:
                        raise ValueError("The running TTS worker received a different model.")
                    result = generate(request, args.model_root, args.outputs)
                except Exception as error:
                    result = {"error": str(error), "traceback": traceback.format_exc()}
                print(EVENT_PREFIX + json.dumps(result), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error), "traceback": traceback.format_exc()}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
