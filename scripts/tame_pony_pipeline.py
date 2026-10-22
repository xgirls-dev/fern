"""Fern inference adapter for the pinned Tame Pony SDXL OpenVINO export."""
from __future__ import annotations

import gc
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import storage_manager
from model_catalog import installed, model_spec, revision
import flux2_klein_pipeline as flux2
from device_adapters import CPU, INTEL_GPU, NVIDIA_GPU, device_label, normalize_device


MODEL_KEY = "tame-pony-v25-sdxl"
MODEL_KEYS = (MODEL_KEY, "tame-pony-v25-sdxl-int8")
INT8_MODEL_KEY = MODEL_KEYS[1]
SPEC = model_spec(MODEL_KEY)
DEFAULT_DEVICE = "AUTO"
DEFAULT_WIDTH = int(SPEC["width"])
DEFAULT_HEIGHT = int(SPEC["height"])
DEFAULT_STEPS = int(SPEC["steps"])
DEFAULT_GUIDANCE = float(SPEC["guidance"])
ROOT = Path(__file__).resolve().parents[1]
MODELS_ROOT = Path(os.environ.get("FERN_MODELS_ROOT") or ROOT / "models").resolve()
MODEL_DIR = MODELS_ROOT / SPEC["folder"]
CACHE_DIR = ROOT / ".cache" / "openvino" / MODEL_KEY

_PIPELINE: Any | None = None
_PIPELINE_DEVICE: str | None = None
_PIPELINE_MODEL_KEY: str | None = None


def _patch_openvino_vae_device_lookup() -> None:
    """Keep Diffusers' SDXL device helper compatible with Optimum's OVModelVae."""
    import diffusers.pipelines.stable_diffusion_xl.pipeline_stable_diffusion_xl as sdxl_pipeline

    helper = getattr(sdxl_pipeline, "get_module_execution_device", None)
    # Diffusers 0.40 moved this logic to DiffusionPipeline._execution_device.
    # Newer Optimum/OpenVINO VAE wrappers are handled by that implementation;
    # only patch older Diffusers releases that still expose the module helper.
    if helper is None:
        return
    if getattr(helper, "_fern_openvino_vae_compatible", False):
        return

    def get_openvino_aware_device(module: Any):
        if type(module).__name__ == "OVModelVae" and hasattr(module, "device"):
            return module.device
        return helper(module)

    get_openvino_aware_device._fern_openvino_vae_compatible = True
    sdxl_pipeline.get_module_execution_device = get_openvino_aware_device


def is_model(model_key: str) -> bool:
    return model_key in MODEL_KEYS


def model_dir_for(model_key: str) -> Path:
    if not is_model(model_key):
        raise ValueError("Unknown Tame Pony quantization.")
    return MODELS_ROOT / model_spec(model_key)["folder"]


def display_name(model_key: str) -> str:
    if not is_model(model_key):
        raise ValueError("Unknown Tame Pony quantization.")
    return "Tame Pony SDXL INT8" if model_key == INT8_MODEL_KEY else "Tame Pony SDXL"


def model_status(device: str = DEFAULT_DEVICE, model_key: str = MODEL_KEY) -> dict[str, Any]:
    """Reuse Fern's cached OpenVINO/hardware probe without blocking UI checks."""
    if not is_model(model_key):
        raise ValueError("Unknown Tame Pony quantization.")
    spec = model_spec(model_key)
    model_dir = MODELS_ROOT / spec["folder"]
    status = flux2.model_status(device, model_key)
    status.update(
        selectedModel=model_key,
        modelRevision=revision(MODELS_ROOT, model_key),
        modelId=spec["repo"],
        modelDir=str(model_dir),
        pipelineClass=spec["pipeline"],
        quantization="INT8" if model_key == INT8_MODEL_KEY else None,
        runtimeBackend="OpenVINO · SDXL",
        supportsReferenceImage=False,
        defaultDevice=DEFAULT_DEVICE,
        defaultWidth=DEFAULT_WIDTH,
        defaultHeight=DEFAULT_HEIGHT,
        defaultSteps=DEFAULT_STEPS,
        defaultGuidance=DEFAULT_GUIDANCE,
        sampler="EDM DPM-Solver multistep",
    )
    for adapter in status.get("adapters", []):
        adapter.update(
            modelId=spec["repo"],
            modelDir=str(model_dir),
            runtimeBackend=f"OpenVINO · {device_label(adapter['id'])}",
            supportsReferenceImage=False,
        )
    if not installed(MODELS_ROOT, model_key):
        status["runtimeReady"] = False
        status["runtimeNote"] = f"Install {display_name(model_key)} from Preferences before generating."
    return status


def release_pipeline() -> None:
    global _PIPELINE, _PIPELINE_DEVICE, _PIPELINE_MODEL_KEY
    _PIPELINE = None
    _PIPELINE_DEVICE = None
    _PIPELINE_MODEL_KEY = None
    gc.collect()


def _load_pipeline(device: str, log: Callable[[str], None] | None, model_key: str) -> Any:
    global _PIPELINE, _PIPELINE_DEVICE, _PIPELINE_MODEL_KEY
    if not is_model(model_key):
        raise ValueError("Unknown Tame Pony quantization.")
    spec = model_spec(model_key)
    model_dir = MODELS_ROOT / spec["folder"]
    cache_dir = ROOT / ".cache" / "openvino" / model_key
    selected = normalize_device(device)
    if selected == "AUTO":
        selected = model_status(DEFAULT_DEVICE)["selectedDevice"]
    if selected not in (INTEL_GPU, NVIDIA_GPU, CPU):
        raise ValueError("Tame Pony requires a supported OpenVINO device.")
    if not installed(MODELS_ROOT, model_key):
        raise RuntimeError("Tame Pony model files are incomplete. Repair the model in Preferences.")
    if _PIPELINE is not None and _PIPELINE_DEVICE == selected and _PIPELINE_MODEL_KEY == model_key:
        return _PIPELINE

    release_pipeline()
    cleanup = storage_manager.cleanup_cache(ROOT, cache_dir)
    if cleanup["removedFiles"] and log:
        log(f"Cleaned {cleanup['removedFiles']} expired OpenVINO cache file(s).")

    import openvino as ov

    openvino_device = {INTEL_GPU: "GPU", NVIDIA_GPU: "NVIDIA", CPU: "CPU"}[selected]
    if selected == NVIDIA_GPU:
        import openvino_nvidia  # noqa: F401
    cache_enabled = cleanup["freeBytes"] >= cleanup["policy"]["reserveBytes"] + cleanup["policy"]["maxBytes"]
    # Always direct Optimum's per-component compiler cache to Fern's managed
    # cache directory. If omitted, Optimum defaults to <model>/unet/model_cache,
    # which can fail for installed model folders and writes into model artifacts.
    cache_dir.mkdir(parents=True, exist_ok=True)
    ov_config: dict[str, str] = {"CACHE_DIR": str(cache_dir)}
    if cache_enabled:
        ov.Core().set_property({"CACHE_DIR": str(cache_dir)})
    elif log:
        log("Using the Fern-managed model cache; the shared OpenVINO cache threshold was not met.")
    if log:
        log(f"Loading {display_name(model_key)} on {device_label(selected)}…")
    from optimum.intel import OVStableDiffusionXLPipeline

    # Keep the scheduler from the export's model_index and scheduler_config.
    # The upstream Pony pipeline uses the checkpoint's EDMDPMSolver scheduler;
    # swapping it for a different sampler can turn valid inference into noise.
    pipeline = OVStableDiffusionXLPipeline.from_pretrained(
        str(model_dir), device=openvino_device, ov_config=ov_config
    )
    # The pinned SDXL exports declare force_upcast=false. Keep Diffusers from
    # calling torch.nn.Module-only VAE upcasting on Optimum's OVModelVae.
    pipeline.vae.config.force_upcast = False
    # Optimum selects the concrete SDXL implementation from model metadata, so
    # catalog pipeline classes may still be recorded as OVDiffusionPipeline.
    _patch_openvino_vae_device_lookup()
    pipeline.set_progress_bar_config(disable=True)
    if cache_enabled:
        storage_manager.touch_cache(cache_dir)
    _PIPELINE = pipeline
    _PIPELINE_DEVICE = selected
    _PIPELINE_MODEL_KEY = model_key
    if log:
        log(f"{display_name(model_key)} is ready.")
    return pipeline


def generate_image(
    *,
    model_key: str = MODEL_KEY,
    prompt: str,
    output_dir: Path,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    steps: int = DEFAULT_STEPS,
    guidance: float = DEFAULT_GUIDANCE,
    seed: int = 42,
    device: str = DEFAULT_DEVICE,
    output_name: str,
    log: Callable[[str], None] | None = None,
) -> tuple[Path, float]:
    if not 512 <= width <= 1536 or width % 8:
        raise ValueError("Tame Pony width must be 512–1536 pixels and divisible by 8.")
    if not 512 <= height <= 1536 or height % 8:
        raise ValueError("Tame Pony height must be 512–1536 pixels and divisible by 8.")
    if not 1 <= steps <= 50:
        raise ValueError("Steps must be 1 to 50.")
    if not 0 <= guidance <= 10:
        raise ValueError("Guidance must be 0 to 10.")
    if not is_model(model_key):
        raise ValueError("Unknown Tame Pony quantization.")
    if not output_name.startswith("tame-pony-") or not output_name.endswith(".png") or Path(output_name).name != output_name:
        raise ValueError("Invalid Tame Pony output filename.")
    output_dir = output_dir.resolve()
    if not output_dir.is_dir() or not output_dir.is_relative_to((ROOT / ".cache").resolve()):
        raise ValueError("Tame Pony output must be inside Fern's generation workspace.")

    import torch

    pipeline = _load_pipeline(device, log, model_key)
    generator = torch.Generator(device="cpu").manual_seed(int(seed))

    def on_step_end(_pipe: Any, step: int, _timestep: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
        if log:
            log(f"Step {step + 1}/{steps}")
        return kwargs

    output_path = (output_dir / output_name).resolve()
    if output_path.parent != output_dir or output_path.exists():
        raise ValueError("Tame Pony output path is invalid or already exists.")
    started = time.perf_counter()
    result = pipeline(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
        callback_on_step_end=on_step_end,
    )
    image = result.images[0]
    if image.size != (width, height):
        raise RuntimeError(f"Tame Pony returned {image.width}×{image.height}; expected {width}×{height}.")
    temporary = output_path.with_name(f".{output_path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        image.save(temporary, format="PNG")
        os.replace(temporary, output_path)
    finally:
        temporary.unlink(missing_ok=True)
    elapsed = time.perf_counter() - started
    return output_path, elapsed
