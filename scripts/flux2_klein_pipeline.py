from __future__ import annotations

import gc
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import storage_manager
from device_adapters import (
    AUTO,
    CPU,
    INTEL_GPU,
    NVIDIA_GPU,
    detect_nvidia_gpus,
    device_label,
    normalize_device,
    select_auto_device,
)


MODEL_ID = "xgirls/FLUX.2-klein-9B-ov-int4"
MODEL_FOLDER = "flux2-klein-9b-circulus-int4"
PIPELINE_CLASS = "Flux2KleinPipeline"
DEFAULT_DEVICE = AUTO
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024
DEFAULT_STEPS = 4
DEFAULT_GUIDANCE = 1.0


def _resolve_root() -> Path:
    configured = (
        os.environ.get("FERN_ROOT", "").strip()
        or os.environ.get("INTEL_IRIS_ROOT", "").strip()
    )
    return Path(configured).resolve() if configured else Path(__file__).resolve().parents[1]


ROOT = _resolve_root()
MODELS_ROOT = Path(
    os.environ.get("FERN_MODELS_ROOT")
    or os.environ.get("INTEL_IRIS_MODELS_ROOT")
    or ROOT / "models"
).resolve()
MODEL_DIR = MODELS_ROOT / MODEL_FOLDER
OPENVINO_CACHE_DIR = ROOT / ".cache" / "openvino" / "flux2-klein-9b"

_PIPELINE_CACHE: dict[str, Any] = {"key": None, "pipeline": None}
_OPENVINO_DEPENDENCY_STATUS: dict[str, Any] | None = None
_NVIDIA_DEPENDENCY_STATUS: dict[str, Any] | None = None


class Flux2KleinNotReady(RuntimeError):
    pass


def _log(log: Callable[[str], None] | None, message: str) -> None:
    if log:
        log(message)


def _display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def save_image_atomic(image: Any, output_path: Path) -> None:
    """Write a completed PNG into the output directory in one visible step.

    The API polls the output directory while a render is running. Saving directly
    to the final filename lets the browser read a partially-written PNG, which
    can leave the preview looking cropped until the user opens it separately.
    A same-directory temporary file keeps the final filename invisible until the
    image is complete, and os.replace is atomic on Windows when the volume is
    unchanged.
    """
    temporary_path = output_path.with_name(
        f".{output_path.name}.{os.getpid()}.{time.time_ns()}.tmp"
    )
    try:
        image.save(temporary_path, format="PNG")
        os.replace(temporary_path, output_path)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def _openvino_dependency_status() -> dict[str, Any]:
    global _OPENVINO_DEPENDENCY_STATUS
    if _OPENVINO_DEPENDENCY_STATUS is not None:
        return dict(_OPENVINO_DEPENDENCY_STATUS)
    try:
        import openvino as ov
        from optimum.intel import OVFlux2KleinPipeline  # noqa: F401

        devices = [str(device) for device in ov.Core().available_devices]
        _OPENVINO_DEPENDENCY_STATUS = {
            "installed": True,
            "devices": devices,
            "hasGpu": any(device == "GPU" or device.startswith("GPU.") for device in devices),
            "message": "OpenVINO Flux.2 Klein runtime is available.",
        }
    except Exception as exc:
        _OPENVINO_DEPENDENCY_STATUS = {
            "installed": False,
            "devices": [],
            "hasGpu": False,
            "message": (
                "The OpenVINO Flux.2 Klein runtime is not installed. "
                "Run .\\scripts\\install-flux2-klein-deps.ps1."
            ),
            "error": str(exc),
        }
    return dict(_OPENVINO_DEPENDENCY_STATUS)


def _nvidia_dependency_status() -> dict[str, Any]:
    global _NVIDIA_DEPENDENCY_STATUS
    if _NVIDIA_DEPENDENCY_STATUS is not None:
        return dict(_NVIDIA_DEPENDENCY_STATUS)
    hardware_names = detect_nvidia_gpus()
    try:
        # The contrib package registers the OpenVINO device named NVIDIA.
        # Import it before creating Core(), as required by the plugin README.
        import openvino_nvidia  # noqa: F401
        import openvino as ov

        devices = [str(device) for device in ov.Core().available_devices]
        nvidia_devices = [
            device for device in devices if device == "NVIDIA" or device.startswith("NVIDIA.")
        ]
        _NVIDIA_DEPENDENCY_STATUS = {
            "installed": True,
            "devices": devices,
            "cudaAvailable": bool(nvidia_devices),
            "deviceName": nvidia_devices[0] if nvidia_devices else "",
            "hardwareDetected": bool(hardware_names),
            "hardwareNames": list(hardware_names),
            "message": (
                f"OpenVINO NVIDIA plugin is available on {nvidia_devices[0]}."
                if nvidia_devices
                else "OpenVINO NVIDIA plugin is installed, but no NVIDIA device is available."
            ),
        }
    except Exception as exc:
        _NVIDIA_DEPENDENCY_STATUS = {
            "installed": False,
            "devices": [],
            "cudaAvailable": False,
            "deviceName": "",
            "hardwareDetected": bool(hardware_names),
            "hardwareNames": list(hardware_names),
            "message": (
                f"NVIDIA GPU detected ({hardware_names[0]}), but the OpenVINO NVIDIA plugin "
                "is not available. Build/install openvino_contrib/modules/nvidia_plugin "
                "and its CUDA dependencies."
                if hardware_names
                else "The OpenVINO NVIDIA plugin is not available. "
                "Build/install openvino_contrib/modules/nvidia_plugin and its CUDA dependencies."
            ),
            "error": str(exc),
        }
    return dict(_NVIDIA_DEPENDENCY_STATUS)


def _openvino_model_ready() -> bool:
    expected = [
        MODEL_DIR / "model_index.json",
        MODEL_DIR / "transformer" / "openvino_model.xml",
        MODEL_DIR / "transformer" / "openvino_model.bin",
        MODEL_DIR / "text_encoder" / "openvino_model.xml",
        MODEL_DIR / "text_encoder" / "openvino_model.bin",
        MODEL_DIR / "vae_decoder" / "openvino_model.xml",
        MODEL_DIR / "vae_decoder" / "openvino_model.bin",
    ]
    return all(path.exists() for path in expected)


def pipeline_class_name(device: str = DEFAULT_DEVICE) -> str:
    index_path = MODEL_DIR / "model_index.json"
    if not index_path.exists():
        return ""
    try:
        return str(json.loads(index_path.read_text(encoding="utf-8")).get("_class_name", "")).strip()
    except (OSError, ValueError, TypeError):
        return ""


def model_dir_for(device: str = DEFAULT_DEVICE) -> Path:
    return MODEL_DIR


def _adapter_statuses() -> list[dict[str, Any]]:
    nvidia = _nvidia_dependency_status()
    openvino = _openvino_dependency_status()
    openvino_model_ready = _openvino_model_ready()
    shared_model_ready = openvino_model_ready

    return [
        {
            "id": INTEL_GPU,
            "label": device_label(INTEL_GPU),
            "available": bool(openvino["installed"] and openvino["hasGpu"]),
            "runtimeReady": bool(openvino["installed"] and openvino["hasGpu"] and openvino_model_ready),
            "modelId": MODEL_ID,
            "modelDir": _display_path(MODEL_DIR),
            "runtimeBackend": "OpenVINO | Intel GPU",
            "note": (
                "Intel GPU is ready."
                if openvino["installed"] and openvino["hasGpu"] and openvino_model_ready
                else "Intel GPU model files are missing."
                if openvino["installed"] and openvino["hasGpu"]
                else "An Intel GPU was not detected by OpenVINO."
                if openvino["installed"]
                else openvino["message"]
            ),
            "supportsReferenceImage": True,
        },
        {
            "id": NVIDIA_GPU,
            "label": device_label(NVIDIA_GPU),
            "available": bool(nvidia["hardwareDetected"] or (nvidia["installed"] and nvidia["cudaAvailable"])),
            "runtimeReady": bool(nvidia["installed"] and nvidia["cudaAvailable"] and shared_model_ready),
            "modelId": MODEL_ID,
            "modelDir": _display_path(MODEL_DIR),
            "runtimeBackend": "OpenVINO | NVIDIA plugin",
            "note": (
                "OpenVINO NVIDIA plugin is ready."
                if nvidia["installed"] and nvidia["cudaAvailable"] and shared_model_ready
                else "The shared OpenVINO model files are missing."
                if nvidia["installed"] and nvidia["cudaAvailable"]
                else nvidia["message"]
            ),
            "hardwareNote": "Uses the same OpenVINO IR model as Intel GPU. Requires the OpenVINO NVIDIA plugin plus compatible CUDA libraries.",
            "supportsReferenceImage": True,
        },
        {
            "id": CPU,
            "label": device_label(CPU),
            "available": bool(openvino["installed"]),
            "runtimeReady": bool(openvino["installed"] and openvino_model_ready),
            "modelId": MODEL_ID,
            "modelDir": _display_path(MODEL_DIR),
            "runtimeBackend": "OpenVINO | CPU",
            "note": (
                "CPU fallback is ready."
                if openvino["installed"] and openvino_model_ready
                else "CPU model files are missing."
                if openvino["installed"]
                else openvino["message"]
            ),
            "supportsReferenceImage": True,
        },
    ]


def _select_device(requested: str, statuses: list[dict[str, Any]]) -> str:
    normalized = normalize_device(requested)
    if normalized != AUTO:
        return normalized
    by_id = {item["id"]: item for item in statuses}
    return select_auto_device(
        nvidia_available=bool(by_id[NVIDIA_GPU]["available"]),
        intel_available=bool(by_id[INTEL_GPU]["available"]),
        cpu_available=bool(by_id[CPU]["available"]),
    )


def model_status(device: str = DEFAULT_DEVICE) -> dict[str, Any]:
    statuses = _adapter_statuses()
    selected = _select_device(device, statuses)
    selected_status = next(item for item in statuses if item["id"] == selected)
    runtime_ready = bool(selected_status["runtimeReady"])
    return {
        "runtimeReady": runtime_ready,
        "runtimeNote": selected_status["note"],
        "modelId": selected_status["modelId"],
        "modelDir": selected_status["modelDir"],
        "pipelineClass": pipeline_class_name(selected),
        "runtimeBackend": selected_status["runtimeBackend"],
        "supportsReferenceImage": selected_status["supportsReferenceImage"],
        "requestedDevice": normalize_device(device),
        "selectedDevice": selected,
        "adapters": statuses,
        "defaultDevice": DEFAULT_DEVICE,
        "defaultWidth": DEFAULT_WIDTH,
        "defaultHeight": DEFAULT_HEIGHT,
        "defaultSteps": DEFAULT_STEPS,
        "defaultGuidance": DEFAULT_GUIDANCE,
    }


def release_pipeline() -> None:
    _PIPELINE_CACHE["key"] = None
    _PIPELINE_CACHE["pipeline"] = None
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def load_pipeline(*, device: str = DEFAULT_DEVICE, log: Callable[[str], None] | None = None):
    selected = _select_device(device, _adapter_statuses())
    status = model_status(selected)
    if not status["runtimeReady"]:
        raise Flux2KleinNotReady(status["runtimeNote"])

    model_dir = model_dir_for(selected)
    cache_key = (selected, str(model_dir))
    if _PIPELINE_CACHE["key"] == cache_key and _PIPELINE_CACHE["pipeline"] is not None:
        _log(log, f"Using cached Flux.2 Klein 9B pipeline on {device_label(selected)}.")
        return _PIPELINE_CACHE["pipeline"]

    release_pipeline()
    cleanup = storage_manager.cleanup_cache(ROOT, OPENVINO_CACHE_DIR)
    if cleanup["removedFiles"]:
        _log(
            log,
            f"Cleaned {cleanup['removedFiles']} expired or oversized cache file(s).",
        )
    _log(log, f"Loading Flux.2 Klein 9B: {model_dir}")
    _log(log, f"Adapter: {device_label(selected)}")

    if selected == NVIDIA_GPU:
        import openvino_nvidia  # noqa: F401
        import openvino as ov
        openvino_device = "NVIDIA"
    else:
        import openvino as ov
        openvino_device = "GPU" if selected == INTEL_GPU else "CPU"
    from optimum.intel import OVFlux2KleinPipeline

    policy = cleanup["policy"]
    cache_enabled = cleanup["freeBytes"] >= policy["reserveBytes"] + policy["maxBytes"]
    ov_config: dict[str, str] = {}
    if cache_enabled:
        OPENVINO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        ov.Core().set_property({"CACHE_DIR": str(OPENVINO_CACHE_DIR)})
        ov_config["CACHE_DIR"] = str(OPENVINO_CACHE_DIR)
    else:
        _log(log, "Generation cache disabled to protect free disk space.")

    _log(log, f"OpenVINO device: {openvino_device}")
    pipeline = OVFlux2KleinPipeline.from_pretrained(
        str(model_dir),
        device=openvino_device,
        ov_config=ov_config,
    )
    if cache_enabled:
        storage_manager.touch_cache(OPENVINO_CACHE_DIR)

    _PIPELINE_CACHE["key"] = cache_key
    _PIPELINE_CACHE["pipeline"] = pipeline
    return pipeline


def generate_image(
    *,
    prompt: str,
    output_dir: Path,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    steps: int = DEFAULT_STEPS,
    guidance: float = DEFAULT_GUIDANCE,
    seed: int = 42,
    device: str = DEFAULT_DEVICE,
    reference_image: Any | None = None,
    log: Callable[[str], None] | None = None,
) -> tuple[Path, float]:
    for label, value in (("Width", width), ("Height", height)):
        if value < 256 or value > 1920 or value % 16 != 0:
            raise ValueError(f"{label} must be 256 to 1920 and divisible by 16.")
    if steps < 1 or steps > 50:
        raise ValueError("Steps must be 1 to 50.")
    if guidance < 0 or guidance > 10:
        raise ValueError("Guidance must be 0 to 10.")
    selected = _select_device(device, _adapter_statuses())
    if selected not in {INTEL_GPU, NVIDIA_GPU, CPU}:
        raise ValueError("Device must be Auto-select, Intel GPU, NVIDIA GPU, or CPU.")

    output_dir.mkdir(parents=True, exist_ok=True)

    import torch

    pipeline = load_pipeline(device=selected, log=log)
    # OpenVINO executes the model on the selected plugin device; the pipeline
    # uses a CPU torch generator for deterministic scheduler inputs on all
    # adapters, including the NVIDIA plugin.
    generator = torch.Generator("cpu").manual_seed(int(seed))
    _log(log, f"Seed: {seed}")
    _log(log, f"Resolution: {width}x{height} | {steps} steps | guidance {guidance:.1f}")
    if reference_image is not None:
        _log(log, f"Reference image: {reference_image.width}x{reference_image.height}")

    def on_step_end(
        _pipeline: Any,
        step_index: int,
        _timestep: int,
        callback_kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        _log(log, f"Step {step_index + 1}/{steps}")
        return callback_kwargs

    pipeline.set_progress_bar_config(disable=True)
    started = time.perf_counter()
    result = pipeline(
        prompt=prompt,
        image=reference_image,
        height=height,
        width=width,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
        callback_on_step_end=on_step_end,
    )

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_path = output_dir / f"flux2-klein-9b-{stamp}-seed{seed}.png"
    save_image_atomic(result.images[0], output_path)
    elapsed = time.perf_counter() - started
    _log(log, f"Saved: {output_path}")
    _log(log, f"Elapsed: {elapsed:.1f}s")
    return output_path, elapsed

