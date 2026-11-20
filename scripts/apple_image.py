"""Klein 4B inference on Apple Silicon with the pinned MLX model."""
from __future__ import annotations

import os
import time
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from device_adapters import APPLE_GPU
from gguf_runtime import apple_silicon
from model_catalog import APPLE_IMAGE_ID, APPLE_IMAGE_SPEC, installed


@lru_cache(maxsize=1)
def device_available() -> bool:
    if not apple_silicon():
        return False
    try:
        import mlx.core as mx

        return mx.metal.is_available()
    except (ImportError, OSError, RuntimeError):
        return False


def status(root: Path, model: str, device: str) -> dict[str, Any]:
    available = device_available()
    model_ready = model == APPLE_IMAGE_ID and installed(root, model)
    selected = APPLE_GPU if available and device in ("AUTO", APPLE_GPU) else None
    note = (
        "This Mac needs a working Apple GPU and the bundled MLX runtime." if not available else
        "Select Available GPU in Preferences to use Klein 4B on this Mac." if selected is None else
        "Install Klein 4B · MLX from Models." if not model_ready else
        "Ready on Apple GPU."
    )
    return {
        "selectedModel": model, "selectedDevice": selected, "requestedDevice": device,
        "runtimeReady": bool(selected and model_ready), "runtimeNote": note,
        "runtimeBackend": "MLX · INT4", "modelRevision": APPLE_IMAGE_SPEC["revision"],
        "supportsReferenceImage": False,
        "adapters": [{
            "id": APPLE_GPU, "label": "Apple GPU", "available": available,
            "runtimeReady": available and model_ready, "supportsReferenceImage": False,
        }],
    }


@lru_cache(maxsize=1)
def _pipeline(folder: Path):
    # Downloads are handled by ModelManager. Fail on missing model data instead
    # of allowing a library to fetch a fallback checkpoint during generation.
    os.environ["HF_HUB_OFFLINE"] = "1"
    import mlx.core as mx
    from mflux.models.common.config import ModelConfig
    from mflux.models.flux2.variants import Flux2Klein

    mx.set_default_device(mx.gpu)
    pipeline = Flux2Klein(model_config=ModelConfig.flux2_klein_4b(), model_path=str(folder))
    if pipeline.bits != 4:
        raise RuntimeError("Fern expected the verified 4-bit Klein checkpoint.")
    return pipeline


def generate_image(
    *,
    root: Path,
    prompt: str,
    width: int,
    height: int,
    steps: int,
    seed: int,
    output_dir: Path,
    log: Callable[[str], None],
) -> tuple[Path, float]:
    if not device_available():
        raise RuntimeError("The Apple GPU is unavailable for MLX image generation.")
    if not installed(root, APPLE_IMAGE_ID):
        raise RuntimeError("Install Klein 4B · MLX before generating.")
    size = APPLE_IMAGE_SPEC["defaultWidth"]
    if (width, height, steps) != (size, size, APPLE_IMAGE_SPEC["defaultSteps"]):
        raise ValueError("Choose the 512 × 512, four-step Klein 4B preset.")
    log("Loading Klein 4B on Apple GPU…")
    pipeline = _pipeline(root / APPLE_IMAGE_SPEC["folder"])
    log("Generating on Apple GPU…")
    started = time.perf_counter()
    image = pipeline.generate_image(seed=seed, prompt=prompt, width=width, height=height, num_inference_steps=steps)
    path = output_dir / f"{APPLE_IMAGE_ID}-{uuid.uuid4().hex}.png"
    image.save(str(path))
    return path, time.perf_counter() - started
