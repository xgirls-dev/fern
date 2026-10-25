"""Text-to-image runner for user-registered OpenVINO GenAI image exports."""
from __future__ import annotations

import gc
import json
import importlib.util
import time
import threading
from importlib import import_module
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image

import custom_image_registry as registry
import flux2_klein_pipeline as flux2


_PIPELINE: Any | None = None
_PIPELINE_KEY: tuple[str, str] | None = None
_PIPELINE_KIND: str | None = None
_DEVICE_CHECK_LOCK = threading.Lock()
_DEVICE_CHECK_RESULT: dict[str, Any] | None = None
_DEVICE_CHECK_STARTED = False


def _patch_vae_device_lookup(module_name: str) -> None:
    """Adapt Diffusers' device lookup to Optimum's OpenVINO VAE wrapper."""
    module = import_module(module_name)
    helper = getattr(module, "get_module_execution_device", None)
    # Diffusers 0.40 moved execution-device discovery to the pipeline base class.
    if helper is None:
        return
    if getattr(helper, "_fern_openvino_vae_compatible", False):
        return

    def get_openvino_aware_device(component: Any):
        if type(component).__name__ == "OVModelVae" and hasattr(component, "device"):
            return component.device
        return helper(component)

    get_openvino_aware_device._fern_openvino_vae_compatible = True
    module.get_module_execution_device = get_openvino_aware_device


def is_model(model_id: str) -> bool:
    return model_id.startswith("custom-") and registry.MODEL_REGISTRY.contains(model_id)


def model_spec(model_id: str) -> dict[str, Any]:
    item = registry.MODEL_REGISTRY.get(model_id)
    if not item or not item.get("installed"):
        raise ValueError("The custom image model folder is unavailable. Add its export folder again in Models.")
    return item


def model_status(device: str, model_id: str) -> dict[str, Any]:
    global _DEVICE_CHECK_STARTED, _DEVICE_CHECK_RESULT
    item = model_spec(model_id)
    family = registry.FAMILIES[item["family"]]
    with _DEVICE_CHECK_LOCK:
        dependency = dict(_DEVICE_CHECK_RESULT) if _DEVICE_CHECK_RESULT is not None else None
        if dependency is None and not _DEVICE_CHECK_STARTED:
            _DEVICE_CHECK_STARTED = True
            def check_devices() -> None:
                global _DEVICE_CHECK_RESULT
                try:
                    import openvino as ov

                    core = ov.Core()
                    devices = [str(device) for device in core.available_devices]
                    has_optimum = importlib.util.find_spec("optimum.intel") is not None
                    result = {
                        "installed": has_optimum,
                        "hasGpu": any(device == "GPU" or device.startswith("GPU.") for device in devices),
                        "devices": devices,
                        "message": "OpenVINO GenAI image runtime is available." if has_optimum else "The OpenVINO Optimum runtime is unavailable.",
                    }
                except Exception as error:
                    result = {"installed": False, "hasGpu": False, "message": f"Could not check OpenVINO devices: {error}"}
                with _DEVICE_CHECK_LOCK:
                    _DEVICE_CHECK_RESULT = result
            threading.Thread(target=check_devices, daemon=True, name="fern-custom-image-device-check").start()
    checking = dependency is None
    dependency = dependency or {"installed": False, "hasGpu": False, "message": "Checking OpenVINO runtime and available devices…"}
    genai_available = importlib.util.find_spec("openvino_genai") is not None
    uses_diffusers = item["family"] in ("stable-diffusion", "sdxl")
    uses_flux2_klein = item["family"] == "flux2-klein"
    optimum_available = importlib.util.find_spec("optimum.intel") is not None
    diffusers_available = importlib.util.find_spec("diffusers") is not None and optimum_available
    backend_available = diffusers_available if uses_diffusers else optimum_available if uses_flux2_klein else genai_available
    backend_label = "OpenVINO · Diffusers" if uses_diffusers else "OpenVINO · Optimum Intel" if uses_flux2_klein else "OpenVINO GenAI"
    available = {"INTEL_GPU": bool(dependency.get("installed") and dependency.get("hasGpu")), "CPU": bool(dependency.get("installed"))}
    requested = str(device).upper()
    selected = ("INTEL_GPU" if available["INTEL_GPU"] else None) if requested == "AUTO" else requested if requested in available and available[requested] else None
    adapters = [{"id": adapter_id, "label": "Intel GPU" if adapter_id == "INTEL_GPU" else "CPU", "available": ready, "runtimeReady": bool(ready and item["installed"] and backend_available), "note": "Checking OpenVINO devices…" if checking else f"{backend_label} is unavailable in this runtime." if not backend_available else None, "supportsReferenceImage": False} for adapter_id, ready in available.items()]
    return {
        "requestedDevice": device,
        "selectedModel": model_id,
        "modelId": item["label"],
        "modelDir": item["path"],
        "modelRevision": "local-custom",
        "pipelineClass": item["pipelineClass"],
        "family": item["family"],
        "familyLabel": family["label"],
        "minimumDimension": family["minimum"],
        "maximumDimension": family["maximum"],
        "dimensionMultiple": family["multiple"],
        "defaultSteps": family["steps"],
        "defaultGuidance": family["guidance"],
        "defaultWidth": family["width"],
        "defaultHeight": family["height"],
        "runtimeBackend": backend_label,
        "supportsReferenceImage": False,
        "supportsCustomModel": True,
        "selectedDevice": selected,
        "runtimeReady": bool(item["installed"] and backend_available and selected and any(a.get("id") == selected and a.get("runtimeReady") for a in adapters)),
        "checking": checking,
        "runtimeNote": item.get("error") if not item["installed"] else dependency.get("message") if checking or not dependency.get("installed") else f"{backend_label} is unavailable in this runtime." if not backend_available else "Auto-select requires an available Intel GPU. Select CPU explicitly to use CPU inference." if not selected else None,
        "systemMemory": flux2.system_memory(),
        "adapters": adapters,
    }


def release_pipeline() -> None:
    global _PIPELINE, _PIPELINE_KEY, _PIPELINE_KIND
    _PIPELINE = None
    _PIPELINE_KEY = None
    _PIPELINE_KIND = None
    gc.collect()


def _load_pipeline(model_id: str, device: str, log: Callable[[str], None] | None) -> Any:
    global _PIPELINE, _PIPELINE_KEY, _PIPELINE_KIND
    item = model_spec(model_id)
    status = model_status(device, model_id)
    if status.get("checking"):
        if log:
            log("Checking OpenVINO runtime and available devices…")
        deadline = time.monotonic() + 60
        while status.get("checking") and time.monotonic() < deadline:
            time.sleep(0.25)
            status = model_status(device, model_id)
        if status.get("checking"):
            raise RuntimeError("Timed out while checking the OpenVINO runtime and available devices.")
    selected = status.get("selectedDevice")
    if not selected:
        raise RuntimeError(status.get("runtimeNote") or "Auto-select requires an available Intel GPU. Select CPU explicitly to use CPU inference.")
    key = (model_id, selected)
    if _PIPELINE is not None and _PIPELINE_KEY == key:
        return _PIPELINE
    release_pipeline()
    openvino_device = "GPU" if selected == "INTEL_GPU" else "CPU"
    if log:
        log(f"Loading {item['label']} ({item['familyLabel']}) on {openvino_device}…")
    if item["family"] in ("stable-diffusion", "sdxl"):
        from optimum.intel import OVStableDiffusionPipeline, OVStableDiffusionXLPipeline

        cache_dir = flux2.ROOT / ".cache" / "openvino" / model_id
        cache_dir.mkdir(parents=True, exist_ok=True)
        ov_config = {"CACHE_DIR": str(cache_dir)}
        if item["family"] == "sdxl":
            _patch_vae_device_lookup("diffusers.pipelines.stable_diffusion_xl.pipeline_stable_diffusion_xl")
            pipeline = OVStableDiffusionXLPipeline.from_pretrained(item["path"], device=openvino_device, ov_config=ov_config)
            metadata = json.loads((Path(item["path"]) / "model_index.json").read_text(encoding="utf-8"))
            if metadata.get("_name_or_path") == "John6666/tame-pony-the-authenticity-machine-v25-sdxl":
                from tame_pony_pipeline import configure_pony_scheduler
                configure_pony_scheduler(pipeline, log)
        else:
            _patch_vae_device_lookup("diffusers.pipelines.stable_diffusion.pipeline_stable_diffusion")
            pipeline = OVStableDiffusionPipeline.from_pretrained(item["path"], device=openvino_device, ov_config=ov_config)
        # SD/SDXL exports include their intended scheduler in model_index.json
        # and scheduler/scheduler_config.json. Preserve it for inference.
        if hasattr(pipeline.vae, "config") and hasattr(pipeline.vae.config, "force_upcast"):
            pipeline.vae.config.force_upcast = False
        pipeline.set_progress_bar_config(disable=True)
        _PIPELINE_KIND = "diffusers"
    elif item["family"] == "flux2-klein":
        from optimum.intel import OVFlux2KleinPipeline

        # Klein exports are Diffusers-compatible OpenVINO IR. OpenVINO GenAI's
        # generic Text2ImagePipeline cannot load their VAE configuration.
        pipeline = OVFlux2KleinPipeline.from_pretrained(item["path"], device=openvino_device, ov_config={})
        pipeline.set_progress_bar_config(disable=True)
        _PIPELINE_KIND = "flux2-klein"
    else:
        import openvino_genai as genai

        pipeline = genai.Text2ImagePipeline(item["path"], openvino_device)
        _PIPELINE_KIND = "genai"
    _PIPELINE = pipeline
    _PIPELINE_KEY = key
    if log:
        log("OpenVINO image pipeline is ready.")
    return _PIPELINE


def generate_image(*, model_id: str, prompt: str, output_dir: Path, width: int, height: int, steps: int, guidance: float, seed: int, device: str, output_name: str, log: Callable[[str], None] | None = None) -> tuple[Path, float]:
    item = model_spec(model_id)
    family = registry.FAMILIES[item["family"]]
    if not prompt.strip():
        raise ValueError("Prompt is required.")
    if not family["minimum"] <= width <= family["maximum"] or width % family["multiple"]:
        raise ValueError(f"Width must be {family['minimum']} to {family['maximum']} and divisible by {family['multiple']} for {family['label']}.")
    if not family["minimum"] <= height <= family["maximum"] or height % family["multiple"]:
        raise ValueError(f"Height must be {family['minimum']} to {family['maximum']} and divisible by {family['multiple']} for {family['label']}.")
    if not 1 <= steps <= 50 or not 0 <= guidance <= 20:
        raise ValueError("Steps must be 1 to 50 and guidance must be 0 to 20.")
    if Path(output_name).name != output_name or not output_name.startswith("custom-image-") or not output_name.endswith(".png"):
        raise ValueError("Invalid custom image output filename.")
    output_dir = output_dir.resolve()
    output_path = (output_dir / output_name).resolve()
    if not output_dir.is_dir() or output_path.parent != output_dir or output_path.exists():
        raise ValueError("Custom image output must be a new file inside Fern's generation workspace.")
    pipeline = _load_pipeline(model_id, device, log)

    last_step = 0
    def callback(step: int, total_steps: int, _latent: Any) -> bool:
        nonlocal last_step
        if step >= total_steps:
            return False
        last_step = step + 1
        if log:
            log(f"Step {last_step}/{total_steps}")
        return False

    started = time.perf_counter()
    if _PIPELINE_KIND in ("diffusers", "flux2-klein"):
        import torch

        generator = torch.Generator(device="cpu").manual_seed(int(seed))

        def on_step_end(_pipe: Any, step: int, _timestep: Any, callback_kwargs: dict[str, Any]) -> dict[str, Any]:
            # Some Diffusers pipelines issue a terminal callback at index
            # `steps` after the last denoising iteration. Do not display it as
            # an additional step (for example, 21/20).
            if log and step < steps:
                log(f"Step {step + 1}/{steps}")
            return callback_kwargs

        result = pipeline(prompt=prompt, width=width, height=height, num_inference_steps=steps, guidance_scale=guidance, generator=generator, callback_on_step_end=on_step_end)
        array = np.asarray(result.images[0].convert("RGB"))
    else:
        import openvino_genai as genai

        result = pipeline.generate(
            prompt,
            width=width,
            height=height,
            num_inference_steps=steps,
            num_images_per_prompt=1,
            guidance_scale=guidance,
            generator=genai.TorchGenerator(int(seed)),
            callback=callback,
        )
        array = np.asarray(result.data[0])
    if array.ndim != 3 or array.shape[0] != height or array.shape[1] != width or array.shape[2] not in (3, 4):
        raise RuntimeError(f"OpenVINO GenAI returned an unexpected image array shape: {array.shape}.")
    if array.dtype != np.uint8:
        if np.issubdtype(array.dtype, np.floating) and array.size and float(array.max()) <= 1.0:
            array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
        else:
            array = np.clip(array, 0, 255).astype(np.uint8)
    image = Image.fromarray(array, "RGB" if array.shape[2] == 3 else "RGBA").convert("RGB")
    temporary = output_path.with_name(f".{output_path.name}.{time.time_ns()}.tmp")
    try:
        image.save(temporary, format="PNG")
        temporary.replace(output_path)
    finally:
        temporary.unlink(missing_ok=True)
    if log:
        log(f"Completed in {time.perf_counter() - started:.1f}s.")
    return output_path, time.perf_counter() - started
