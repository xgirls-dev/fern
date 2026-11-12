"""LoRA-enabled OpenVINO GenAI inference for the dedicated Klein 4B model."""
from __future__ import annotations

import gc
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

_cache: dict[str, Any] = {"key": None, "pipeline": None, "temporary": None, "adapters": []}


def release() -> None:
    temporary = _cache.get("temporary")
    _cache.update(key=None, pipeline=None, temporary=None, adapters=[])
    gc.collect()
    if temporary is not None:
        temporary.cleanup()


def _prepare_adapters(model_dir: Path, selections: list[dict[str, Any]], output_dir: Path):
    import openvino as ov
    import openvino_genai as genai
    from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_flux2_lora_to_diffusers
    from safetensors.torch import load_file, save_file

    graph = ov.Core().read_model(str(model_dir / "transformer" / "openvino_model.xml"))
    modules = {}
    for node in graph.get_ordered_ops():
        if node.get_type_name() == "MatMul" and "/ov_ext::linear/MatMul" in node.friendly_name:
            name = node.friendly_name.split("__module.", 1)[-1].split("/ov_ext::linear/MatMul", 1)[0]
            modules[name] = tuple(node.input_value(1).get_shape())
    registered = genai.AdapterConfig()
    adapters = []
    for index, selection in enumerate(selections):
        path = Path(selection["path"]).expanduser().resolve(strict=True)
        if path.suffix.lower() != ".safetensors" or not path.is_file():
            raise ValueError("Choose a local .safetensors LoRA file.")
        state = load_file(str(path), device="cpu")
        if state and all(key.startswith("base_model.model.") for key in state):
            state = {"diffusion_model." + key[len("base_model.model."):]: value for key, value in state.items()}
        if state and all(key.startswith("diffusion_model.") for key in state):
            state = _convert_non_diffusers_flux2_lora_to_diffusers(state)
        if not state:
            raise ValueError(f"{path.name} contains no LoRA tensors.")
        targets: dict[str, dict[str, Any]] = {}
        for key, value in state.items():
            if not key.startswith("transformer.") or not key.endswith((".lora_A.weight", ".lora_B.weight")):
                raise ValueError(f"{path.name} has an unsupported tensor: {key}")
            name, side = key[len("transformer."):].rsplit(".lora_", 1)
            targets.setdefault(name, {})[side] = value
        for name, pair in targets.items():
            if name not in modules or set(pair) != {"A.weight", "B.weight"}:
                raise ValueError(f"{path.name} has an unmatched or incomplete target: {name}")
            a, b = pair["A.weight"], pair["B.weight"]
            out_features, in_features = modules[name]
            if a.ndim != 2 or b.ndim != 2 or a.shape[1] != in_features or b.shape != (out_features, a.shape[0]):
                raise ValueError(f"{path.name} has incompatible dimensions for {name}.")
        converted = output_dir / f"adapter-{index}.safetensors"
        save_file(state, str(converted))
        adapter = genai.Adapter(str(converted))
        adapters.append(adapter)
        registered.add(adapter, 1.0)
    return registered, adapters


def generate(*, model_dir: Path, selections: list[dict[str, Any]], prompt: str,
             output_dir: Path, width: int, height: int, steps: int, seed: int,
             log: Callable[[str], None] | None = None) -> tuple[Path, float]:
    from PIL import Image
    import openvino_genai as genai

    log = log or (lambda _message: None)
    key = (str(model_dir), tuple((str(Path(x["path"]).resolve()), Path(x["path"]).stat().st_mtime_ns,
                                  Path(x["path"]).stat().st_size) for x in selections))
    if _cache["key"] != key or _cache["pipeline"] is None:
        release()
        temporary = tempfile.TemporaryDirectory(prefix="fern-lora-")
        try:
            config, adapters = _prepare_adapters(model_dir, selections, Path(temporary.name)) if selections else (genai.AdapterConfig(), [])
            log("Loading Klein 4B LoRA model on Intel GPU…")
            pipeline = genai.Text2ImagePipeline(str(model_dir), "GPU", adapters=config)
        except BaseException:
            temporary.cleanup()
            raise
        _cache.update(key=key, pipeline=pipeline, temporary=temporary, adapters=adapters)
    else:
        pipeline = _cache["pipeline"]
    log(f"Seed: {seed}")
    def callback(step, total, _latent):
        log(f"Step {step + 1}/{total}")
        return False
    started = time.perf_counter()
    active = genai.AdapterConfig()
    for adapter, selection in zip(_cache["adapters"], selections):
        if selection.get("enabled", True):
            active.add(adapter, float(selection["strength"]))
    result = pipeline.generate(prompt, width=width, height=height, num_inference_steps=steps,
                               guidance_scale=1.0, rng_seed=int(seed), callback=callback, adapters=active)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"flux2-klein-4b-lora-{datetime.now().strftime('%Y%m%d-%H%M%S')}-seed{seed}.png"
    image = Image.fromarray(result.data[0])
    from flux2_klein_pipeline import save_image_atomic
    save_image_atomic(image, path)
    elapsed = time.perf_counter() - started
    log(f"Saved: {path}")
    return path, elapsed
