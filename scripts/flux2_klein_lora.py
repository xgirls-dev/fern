"""LoRA-enabled OpenVINO GenAI inference for dedicated Klein models."""
from __future__ import annotations

import gc
import json
import os
import shutil
import tempfile
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

_cache: dict[str, Any] = {"key": None, "pipeline": None, "temporary": None, "adapters": []}


def _model_with_optional_encoder(model_dir: Path, encoder_dir: Path, target: Path) -> Path:
    """Build a temporary GenAI view, sharing the large model files by hard link."""
    import numpy as np
    import openvino as ov

    for name in ("config.json", "openvino_model.xml", "openvino_model.bin"):
        if not (encoder_dir / name).is_file():
            raise ValueError("The optional Klein text encoder is incomplete. Download it again in Models.")
    required = (encoder_dir / "openvino_model.bin").stat().st_size
    if shutil.disk_usage(target.parent).free < required + 1024**3:
        raise ValueError("Not enough free disk space to prepare the optional text encoder.")
    target.mkdir()
    for source in model_dir.iterdir():
        if source.name == "text_encoder":
            continue
        destination = target / source.name
        if source.is_dir():
            shutil.copytree(source, destination, copy_function=os.link)
        else:
            os.link(source, destination)
    destination = target / "text_encoder"
    destination.mkdir()
    shutil.copy2(encoder_dir / "config.json", destination / "config.json")
    graph = ov.Core().read_model(str(encoder_dir / "openvino_model.xml"))
    if len(graph.outputs) != 1 or str(graph.output(0).partial_shape[-1]) != "7680":
        raise ValueError("The optional encoder has an unexpected output and cannot be used by the LoRA model.")
    embedded = graph.output(0).get_node().input_value(0)
    split = ov.opset13.split(embedded, ov.opset13.constant(np.array(2, dtype=np.int64)), 3)
    for index, layer in enumerate((9, 18, 27)):
        output = split.output(index)
        output.get_tensor().set_names({f"hidden_states.{layer}"})
        graph.add_outputs([output])
    ov.save_model(graph, str(destination / "openvino_model.xml"), compress_to_fp16=False)
    return target


def release() -> None:
    temporary = _cache.get("temporary")
    _cache.update(key=None, pipeline=None, temporary=None, adapters=[])
    gc.collect()
    if temporary is not None:
        temporary.cleanup()


def _normalize_adapter_keys(state: dict[str, Any], name: str) -> dict[str, Any]:
    normalized = {}
    for key, value in state.items():
        target = key
        if key.endswith(".lora.down.weight"):
            target = key.removesuffix(".lora.down.weight") + ".lora_A.weight"
        elif key.endswith(".lora.up.weight"):
            target = key.removesuffix(".lora.up.weight") + ".lora_B.weight"
        if target in normalized:
            raise ValueError(f"{name} has more than one tensor for {target}.")
        normalized[target] = value
    return normalized


def _prepare_adapters(model_dir: Path, selections: list[dict[str, Any]], output_dir: Path):
    import openvino as ov
    import openvino_genai as genai
    from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_flux2_lora_to_diffusers
    from safetensors import SafetensorError
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
        try:
            state = load_file(str(path), device="cpu")
        except SafetensorError as exc:
            raise ValueError(f"{path.name} is an incomplete or invalid safetensors file. Download it again.") from exc
        if state and all(key.startswith("base_model.model.") for key in state):
            state = {"diffusion_model." + key[len("base_model.model."):]: value for key, value in state.items()}
        if state and all(key.startswith("diffusion_model.") for key in state):
            state = _convert_non_diffusers_flux2_lora_to_diffusers(state)
        state = _normalize_adapter_keys(state, path.name)
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


def _active_adapters(genai, adapters, selections, *, static: bool = False):
    config = genai.AdapterConfig(genai.AdapterConfig.Mode.MODE_STATIC) if static else genai.AdapterConfig()
    for adapter, selection in zip(adapters, selections):
        if selection.get("enabled", True):
            config.add(adapter, float(selection["strength"]))
    return config


def _multi_image_pipeline(model_dir: Path, adapters, selections):
    """Use Klein's existing multi-reference pipeline with the GenAI LoRA transformer."""
    import openvino as ov
    import openvino_genai as genai
    import torch
    from optimum.intel import OVFlux2KleinPipeline

    pipeline = OVFlux2KleinPipeline.from_pretrained(str(model_dir), device="GPU", compile=False, dynamic_shapes=False)
    config = json.loads((model_dir / "vae_decoder" / "config.json").read_text(encoding="utf-8"))
    pipeline.vae.bn = SimpleNamespace(
        running_mean=torch.tensor(config["bn_running_mean_data"], dtype=torch.float32),
        running_var=torch.tensor(config["bn_running_var_data"], dtype=torch.float32),
    )
    pipeline.vae.config.batch_norm_eps = config["bn_eps"]

    # GenAI's full Image2ImagePipeline takes one image. Its standalone
    # transformer accepts the combined reference latents and IDs from Diffusers.
    # The standalone transformer sets adapter strengths at compile time.
    transformer = genai.Flux2Transformer2DModel(model_dir / "transformer")
    if any(selection.get("enabled", True) for selection in selections):
        transformer.compile("GPU", adapters=_active_adapters(genai, adapters, selections, static=True))
    else:
        transformer.compile("GPU")

    def ov_tensor(value):
        return ov.Tensor(value.detach().cpu().float().contiguous().numpy())

    def forward(*, hidden_states, timestep, encoder_hidden_states, img_ids, txt_ids, **_kwargs):
        transformer.set_hidden_states("encoder_hidden_states", ov_tensor(encoder_hidden_states))
        transformer.set_hidden_states("img_ids", ov_tensor(img_ids))
        transformer.set_hidden_states("txt_ids", ov_tensor(txt_ids))
        noise = transformer.infer(ov_tensor(hidden_states), ov_tensor(timestep))
        return (torch.from_numpy(noise.data.copy()),)

    pipeline.transformer.forward = forward
    pipeline.set_progress_bar_config(disable=True)
    return pipeline


def generate(*, model_dir: Path, selections: list[dict[str, Any]], prompt: str,
             output_dir: Path, width: int, height: int, steps: int, seed: int,
             reference_image: Any | None = None,
             reference_images: list[Any] | None = None,
             model_size: str = "4b",
             optional_encoder_dir: Path | None = None,
             log: Callable[[str], None] | None = None) -> tuple[Path, float]:
    from PIL import Image
    import openvino_genai as genai

    log = log or (lambda _message: None)
    images = reference_images if reference_images is not None else [reference_image] if reference_image is not None else []
    if len(images) > 4:
        raise ValueError("FLUX.2 Klein supports up to 4 reference images in Fern.")
    multiple_references = len(images) > 1
    encoder_key = None
    if optional_encoder_dir is not None:
        encoder_files = [optional_encoder_dir / name for name in ("config.json", "openvino_model.xml", "openvino_model.bin")]
        if not all(path.is_file() for path in encoder_files):
            raise ValueError("The optional Klein text encoder is incomplete. Download it again in Models.")
        encoder_key = (str(optional_encoder_dir), *(path.stat().st_mtime_ns for path in encoder_files))
    adapter_files = []
    for selection in selections:
        path = Path(selection["path"]).expanduser().resolve(strict=True)
        stat = path.stat()
        adapter_files.append((str(path), stat.st_mtime_ns, stat.st_size))
    static_strengths = tuple(
        (selection.get("enabled", True), float(selection["strength"])) for selection in selections
    ) if multiple_references else ()
    key = (str(model_dir), min(len(images), 2), encoder_key, tuple(adapter_files), static_strengths)
    if _cache["key"] != key or _cache["pipeline"] is None:
        release()
        temporary = tempfile.TemporaryDirectory(prefix="fern-lora-", dir=model_dir.parent)
        try:
            config, adapters = _prepare_adapters(model_dir, selections, Path(temporary.name)) if selections else (genai.AdapterConfig(), [])
            pipeline_dir = model_dir
            if optional_encoder_dir is not None:
                log("Preparing the optional Klein text encoder for LoRA generation…")
                pipeline_dir = _model_with_optional_encoder(model_dir, optional_encoder_dir, Path(temporary.name) / "model")
            log(f"Loading Klein {model_size.upper()} LoRA model on Intel GPU…")
            if multiple_references:
                pipeline = _multi_image_pipeline(pipeline_dir, adapters, selections)
            else:
                pipeline_class = genai.Image2ImagePipeline if images else genai.Text2ImagePipeline
                pipeline = pipeline_class(str(pipeline_dir), "GPU", adapters=config)
        except BaseException:
            temporary.cleanup()
            raise
        _cache.update(key=key, pipeline=pipeline, temporary=temporary, adapters=adapters)
    else:
        pipeline = _cache["pipeline"]
    log(f"Seed: {seed}")
    for index, image in enumerate(images, start=1):
        log(f"Reference {index}: {image.width}x{image.height}")

    def callback(step, total, _latent):
        log(f"Step {step + 1}/{total}")
        return False

    started = time.perf_counter()
    options = dict(width=width, height=height, num_inference_steps=steps, guidance_scale=1.0)
    if multiple_references:
        import torch

        def on_step_end(_pipeline, step, _timestep, tensors):
            callback(step, steps, None)
            return tensors

        result = pipeline(prompt=prompt, image=images, generator=torch.Generator("cpu").manual_seed(int(seed)),
                          callback_on_step_end=on_step_end, **options)
        image = result.images[0]
    else:
        options.update(rng_seed=int(seed), callback=callback,
                       adapters=_active_adapters(genai, _cache["adapters"], selections))
        if images:
            import numpy as np
            import openvino as ov

            pixels = np.ascontiguousarray(np.asarray(images[0].convert("RGB"), dtype=np.uint8)[None, ...])
            result = pipeline.generate(prompt, ov.Tensor(pixels), **options)
        else:
            result = pipeline.generate(prompt, **options)
        image = Image.fromarray(result.data[0])
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"flux2-klein-{model_size}-lora-{datetime.now().strftime('%Y%m%d-%H%M%S')}-seed{seed}.png"
    from flux2_klein_pipeline import save_image_atomic
    save_image_atomic(image, path)
    elapsed = time.perf_counter() - started
    log(f"Saved: {path}")
    return path, elapsed
