from __future__ import annotations

import argparse
import json
import sys
import time
from model_catalog import model_spec
from model_manager import ModelManager
from pathlib import Path


MODEL_ID = "xgirls/FLUX.2-klein-9B-ov-int4"
MODEL_FOLDER = "flux2-klein-9b-circulus-int4"

MODEL_FILES = (
    "model_index.json",
    "transformer/openvino_model.xml",
    "transformer/openvino_model.bin",
    "text_encoder/openvino_model.xml",
    "text_encoder/openvino_model.bin",
    "vae_decoder/openvino_model.xml",
    "vae_decoder/openvino_model.bin",
)


def emit(stage: str, message: str) -> None:
    print(json.dumps({"stage": stage, "message": message}), flush=True)


def openvino_model_ready(model_dir: Path) -> bool:
    return all((model_dir / relative).exists() for relative in MODEL_FILES)


def nvidia_available() -> bool:
    try:
        # Importing this package registers the NVIDIA device with OpenVINO.
        import openvino_nvidia  # noqa: F401
        import openvino as ov

        return any(
            str(device) == "NVIDIA" or str(device).startswith("NVIDIA.")
            for device in ov.Core().available_devices
        )
    except Exception:
        return False


def intel_gpu_available() -> bool:
    try:
        import openvino as ov

        return any(
            str(device) == "GPU" or str(device).startswith("GPU.")
            for device in ov.Core().available_devices
        )
    except Exception:
        return False


def resolve_adapter(adapter: str) -> str:
    if adapter != "auto":
        return adapter
    if nvidia_available():
        return "nvidia"
    if intel_gpu_available():
        return "intel"
    return "cpu"


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare Fern for first use.")
    parser.add_argument(
        "--adapter",
        choices=("auto", "intel", "nvidia", "cpu"),
        default="auto",
        help="Runtime device to prepare; auto prefers OpenVINO NVIDIA, then Intel, then CPU.",
    )
    parser.add_argument("--model", choices=("9b", "4b"), default="9b")
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--models-root", default="")
    args = parser.parse_args()

    spec = model_spec(args.model)
    adapter = resolve_adapter(args.adapter)
    if args.model_dir:
        model_dir = Path(args.model_dir).resolve()
    elif args.models_root:
        model_dir = (Path(args.models_root) / spec["folder"]).resolve()
    else:
        parser.error("one of --model-dir or --models-root is required")
    model_dir.parent.mkdir(parents=True, exist_ok=True)

    emit("runtime", f"Verifying the Fern {adapter} runtime...")
    import openvino  # noqa: F401
    from optimum.intel import OVFlux2KleinPipeline  # noqa: F401

    if adapter == "nvidia":
        if not nvidia_available():
            raise RuntimeError(
                "NVIDIA was selected, but the OpenVINO NVIDIA plugin/device is not available. "
                "Build/install openvino_contrib/modules/nvidia_plugin with its CUDA dependencies."
            )
        emit("runtime", "OpenVINO NVIDIA plugin is available. Preparing the shared Flux.2 Klein model...")
    elif adapter == "intel" and not intel_gpu_available():
        raise RuntimeError("An Intel GPU was not detected by OpenVINO.")

    if openvino_model_ready(model_dir):
        emit("complete", f"The shared {adapter} OpenVINO model is ready.")
        return 0

    if model_dir.name != spec["folder"]:
        raise ValueError("Use the catalog model folder under --models-root.")
    manager = ModelManager(model_dir.parent)
    manager.start(args.model)
    while True:
        status = next(item for item in manager.snapshot() if item["id"] == args.model)
        emit(status["state"], f"{spec['label']}: {status['downloaded'] / 1e9:.2f} GB downloaded")
        if status["state"] == "installed": break
        if status["state"] in ("failed", "paused"): raise RuntimeError(status.get("error", "Download paused."))
        time.sleep(1)

    emit("complete", "Setup complete. Starting Fern...")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        emit("error", str(exc))
        print(str(exc), file=sys.stderr, flush=True)
        raise

