"""Fern adapter and persistent OpenVINO runner for FLUX.3 Klein INT4."""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

from model_catalog import installed, model_spec, revision
from device_adapters import CPU, INTEL_GPU, NVIDIA_GPU, normalize_device, select_auto_device
import flux3_klein_runtime


MODEL_KEY = "flux3-klein"
MODEL_ID = "xgirls/flux-3-klein-openvino-int4-awq"
MODEL_FOLDER = model_spec(MODEL_KEY)["folder"]
DEFAULT_DEVICE = "AUTO"
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024
VALIDATED_WIDTH = 1024
VALIDATED_HEIGHT = 1024
DEFAULT_STEPS = 16
DEFAULT_GUIDANCE = 0.0
TEXT_LAYERS = (4, 8, 12, 16, 20, 24, 28, 32)
EVENT_PREFIX = "FERN_FLUX3_EVENT:"
PROGRESS_PREFIX = "FERN_FLUX3_PROGRESS:"


def _root() -> Path:
    configured = os.environ.get("FERN_ROOT", "").strip() or os.environ.get(
        "INTEL_IRIS_ROOT", ""
    ).strip()
    return Path(configured).resolve() if configured else Path(__file__).resolve().parents[1]


ROOT = _root()
MODELS_ROOT = Path(
    os.environ.get("FERN_MODELS_ROOT") or os.environ.get("INTEL_IRIS_MODELS_ROOT") or ROOT / "models"
).resolve()
MODEL_DIR = MODELS_ROOT / MODEL_FOLDER
_DEVICES_LOCK = threading.Lock()
_DEVICES_CACHE: list[str] | None = None


def _read_devices() -> list[str]:
    try:
        import openvino as ov

        devices = [str(device) for device in ov.Core().available_devices]
        if any(device == "NVIDIA" or device.startswith("NVIDIA.") for device in devices):
            return devices
        try:
            import openvino_nvidia  # noqa: F401

            devices = [str(device) for device in ov.Core().available_devices]
        except Exception:
            pass
        return devices
    except Exception:
        return []


def _devices() -> list[str]:
    global _DEVICES_CACHE
    if _DEVICES_CACHE is not None:
        return list(_DEVICES_CACHE)
    with _DEVICES_LOCK:
        if _DEVICES_CACHE is None:
            _DEVICES_CACHE = _read_devices()
        return list(_DEVICES_CACHE)


def refresh_devices() -> list[str]:
    global _DEVICES_CACHE
    with _DEVICES_LOCK:
        _DEVICES_CACHE = _read_devices()
        return list(_DEVICES_CACHE)


def _device_id(device: str) -> str:
    value = normalize_device(device)
    if value == "AUTO":
        devices = _devices()
        return select_auto_device(
            nvidia_available=any(item == "NVIDIA" or item.startswith("NVIDIA.") for item in devices),
            intel_available=any(item == "GPU" or item.startswith("GPU.") for item in devices),
            cpu_available=any(item == "CPU" or item.startswith("CPU.") for item in devices),
        )
    return value


def _openvino_device(device: str) -> str:
    return {NVIDIA_GPU: "NVIDIA", INTEL_GPU: "GPU", CPU: "CPU"}[_device_id(device)]


def model_status(device: str = DEFAULT_DEVICE) -> dict[str, Any]:
    requested = normalize_device(device)
    devices = _devices() if flux3_klein_runtime.runtime_ready() and installed(MODELS_ROOT, MODEL_KEY) else []
    selected = _device_id(requested) if requested == "AUTO" else requested
    available = (
        any(item == "NVIDIA" or item.startswith("NVIDIA.") for item in devices)
        if selected == NVIDIA_GPU
        else any(item == "GPU" or item.startswith("GPU.") for item in devices)
        if selected == INTEL_GPU
        else any(item == "CPU" or item.startswith("CPU.") for item in devices)
    )
    device_supported = selected in (CPU, INTEL_GPU, NVIDIA_GPU)
    model_installed = installed(MODELS_ROOT, MODEL_KEY)
    runtime_ready = flux3_klein_runtime.runtime_ready()
    return {
        "selectedModel": MODEL_KEY,
        "runtimeReady": bool(model_installed and runtime_ready and available and device_supported),
        "checking": False,
        "runtimeNote": (
            (
                "FLUX.3 Klein INT4 · OpenVINO runtime ready."
                if selected == CPU
                else "FLUX.3 Klein INT4 · GPU runtime ready; transformer uses FP32 inference precision."
            )
            if model_installed and runtime_ready and available and device_supported
            else "Install FLUX.3 Klein from Preferences to download its OpenVINO model."
            if not model_installed
            else "Preparing the isolated FLUX.3 Diffusers runtime from Preferences."
            if not runtime_ready
            else "Fern's GPU validation produced blank images. Select CPU, the only documented OpenVINO inference path for this export."
            if available and not device_supported
            else f"The selected OpenVINO device is unavailable ({selected}). Choose Auto or another available device."
        ),
        "modelId": MODEL_ID,
        "modelDir": str(MODEL_DIR),
        "modelRevision": revision(MODELS_ROOT, MODEL_KEY),
        "pipelineClass": "Flux3DistilledModularPipeline",
        "runtimeBackend": "OpenVINO · mixed INT4/INT8",
        "supportsReferenceImage": False,
        "requestedDevice": requested,
        "selectedDevice": selected if available else None,
        "adapters": [
            {
                "id": adapter,
                "label": label,
                "available": any(
                    item == target or item.startswith(target + ".") for item in devices
                ),
                "runtimeReady": bool(
                    model_installed
                    and runtime_ready
                    and adapter in (CPU, INTEL_GPU, NVIDIA_GPU)
                    and any(item == target or item.startswith(target + ".") for item in devices)
                ),
                "note": (
                    "Transformer GPU inference uses FP32 precision; Intel GPU quality is being rechecked against the updated runner."
                    if adapter == INTEL_GPU
                    else "Transformer GPU inference uses FP32 precision with the repository's NVIDIA compatibility rewrites."
                    if adapter == NVIDIA_GPU
                    else None
                ),
                "runtimeBackend": "OpenVINO · mixed INT4/INT8",
                "supportsReferenceImage": False,
            }
            for adapter, label, target in (
                (NVIDIA_GPU, "NVIDIA GPU", "NVIDIA"),
                (INTEL_GPU, "Intel GPU", "GPU"),
                (CPU, "CPU", "CPU"),
            )
        ],
        "defaultWidth": DEFAULT_WIDTH,
        "defaultHeight": DEFAULT_HEIGHT,
        "defaultSteps": DEFAULT_STEPS,
        "defaultGuidance": DEFAULT_GUIDANCE,
    }


def _emit(kind: str, **payload: Any) -> None:
    print(EVENT_PREFIX + json.dumps({"type": kind, **payload}, ensure_ascii=False), flush=True)


def _log(message: str) -> None:
    print(PROGRESS_PREFIX + message, flush=True)


def _port_array(value: Any, port: Any):
    import ml_dtypes
    import numpy as np

    value = value.detach().to(device="cpu").contiguous()
    precision = port.get_element_type()
    if precision == _openvino_type("bf16"):
        return value.to(__import__("torch").float32).numpy().astype(ml_dtypes.bfloat16, copy=False)
    if precision == _openvino_type("i64"):
        return value.numpy().astype(np.int64, copy=False)
    if precision == _openvino_type("i32"):
        return value.numpy().astype(np.int32, copy=False)
    return value.to(__import__("torch").float32).numpy()


def _openvino_type(name: str):
    import openvino as ov

    return getattr(ov.Type, name)


def _shim_bf16_mvn_for_nvidia(model: Any) -> None:
    """Lower BF16 MVN and Slice nodes to operations supported by OpenVINO NVIDIA."""
    import numpy as np
    import openvino as ov

    patched_mvn = 0
    patched_slice = 0
    for node in list(model.get_ordered_ops()):
        if node.get_input_size() == 0 or node.get_input_element_type(0) != ov.Type.bf16:
            continue
        if node.get_type_name() == "MVN":
            compatible_type = ov.Type.f32
            patched_mvn += 1
        elif node.get_type_name() == "Slice":
            compatible_type = ov.Type.f16
            patched_slice += 1
        else:
            continue
        output = node.output(0)
        consumers = list(output.get_target_inputs())
        compatible_input = ov.opset13.convert(node.input_value(0), compatible_type)
        if node.get_type_name() == "MVN":
            scale = np.float32(1.0 / 1024.0)
            scaled_input = ov.opset13.multiply(compatible_input, ov.opset13.constant(scale))
            no_nan = ov.opset13.equal(scaled_input, scaled_input)
            bounded = ov.opset13.less(
                ov.opset13.abs(scaled_input), ov.opset13.constant(np.float32(1e30))
            )
            finite = ov.opset13.logical_and(no_nan, bounded)
            safe_input = ov.opset13.select(
                finite, scaled_input, ov.opset13.constant(np.float32(0.0))
            )
            node.set_eps(float(node.get_eps()) * float(scale) * float(scale))
            node.input(0).replace_source_output(safe_input.output(0))
        else:
            node.input(0).replace_source_output(compatible_input.output(0))
        node.validate_and_infer_types()
        bf16_output = ov.opset13.convert(output, ov.Type.bf16)
        for consumer in consumers:
            consumer.replace_source_output(bf16_output.output(0))
    print(
        f"NVIDIA compatibility shims: {patched_mvn} FP32 MVN, {patched_slice} FP16 Slice",
        flush=True,
    )


def _build_wrappers(repo_dir: Path, device: str):
    import ml_dtypes  # noqa: F401
    import numpy as np
    import openvino as ov
    import torch
    from diffusers import ModularPipeline

    pipe = ModularPipeline.from_pretrained(str(repo_dir))
    for spec in pipe._component_specs.values():
        spec.pretrained_model_name_or_path = str(repo_dir)
    pipe.load_components(names=["tokenizer"])
    pipe.to("cuda" if torch.cuda.is_available() else "cpu")

    core = ov.Core()
    openvino_device = _openvino_device(device)
    _log(f"Compiling FLUX.3 OpenVINO components on {device}…")
    compiled = {
        "text": core.compile_model(
            core.read_model(str(repo_dir / "text_encoder/openvino_model.xml")), openvino_device
        )
    }
    transformer_model = core.read_model(str(repo_dir / "transformer/openvino_model.xml"))
    if openvino_device == "NVIDIA":
        _shim_bf16_mvn_for_nvidia(transformer_model)
    transformer_properties = (
        {"INFERENCE_PRECISION_HINT": ov.Type.f32}
        if openvino_device == "NVIDIA" or openvino_device.startswith("GPU")
        else {}
    )
    compiled["transformer"] = core.compile_model(
        transformer_model, openvino_device, transformer_properties
    )
    # Text-to-image generation only decodes latents, so compiling the VAE encoder
    # wastes startup time and can fail on devices where that graph is unsupported.
    compiled["vae_decoder"] = core.compile_model(
        core.read_model(str(repo_dir / "vae_decoder/openvino_model.xml")), openvino_device
    )

    class OpenVINOFlux3TextEncoder(torch.nn.Module):
        def __init__(self, compiled_model):
            super().__init__()
            self.compiled_model = compiled_model
            self.dtype = torch.float32
            self.device = torch.device("cpu")

        def to(self, device=None, dtype=None, **kwargs):
            if device is not None:
                self.device = torch.device(device)
            return self

        def forward(self, input_ids, attention_mask=None, position_ids=None, **kwargs):
            values = {
                "input_ids": input_ids,
                "attention_mask": attention_mask,
                "position_ids": position_ids,
            }
            inputs = {}
            for port in self.compiled_model.inputs:
                name = port.get_any_name()
                value = values.get(name)
                if value is not None:
                    inputs[name] = _port_array(value, port)
            result = self.compiled_model(inputs)
            embeddings = np.asarray(result[self.compiled_model.output(0)], dtype=np.float32)
            embeddings = torch.from_numpy(embeddings).to(device=input_ids.device)
            chunks = embeddings.split(2560, dim=-1)
            states = [None] * 37
            for layer, hidden in zip(TEXT_LAYERS, chunks):
                states[layer] = hidden
            return SimpleNamespace(hidden_states=tuple(states))

    class OpenVINOFlux3Transformer(torch.nn.Module):
        def __init__(self, compiled_model):
            super().__init__()
            self.compiled_model = compiled_model
            self.config = SimpleNamespace(in_channels=128)
            self.dtype = torch.bfloat16

        def forward(
            self,
            hidden_states,
            encoder_hidden_states,
            timestep,
            img_ids,
            txt_ids,
            image_cond_hidden_states=None,
            image_cond_ids=None,
            target_timestep=None,
            attention_kwargs=None,
            return_dict=True,
        ):
            if image_cond_hidden_states is not None or image_cond_ids is not None:
                raise NotImplementedError(
                    "This FLUX.3 Klein OpenVINO quant supports text-to-image only; image editing is not included."
                )
            values = {
                "hidden_states": hidden_states,
                "encoder_hidden_states": encoder_hidden_states,
                "333": timestep,
                "503": img_ids,
                "430": txt_ids,
                "392": target_timestep,
            }
            inputs = {}
            for port in self.compiled_model.inputs:
                name = port.get_any_name()
                value = values.get(name)
                if value is not None:
                    inputs[name] = _port_array(value, port)
            result = self.compiled_model(inputs)
            prediction = torch.from_numpy(
                np.asarray(result[self.compiled_model.output(0)], dtype=np.float32)
            ).to(device=hidden_states.device, dtype=hidden_states.dtype)
            return (prediction,) if not return_dict else SimpleNamespace(sample=prediction)

    class LatentDistribution:
        def __init__(self, mean):
            self._mean = mean

        def mode(self):
            return self._mean

    class OpenVINOFlux3VAE(torch.nn.Module):
        def __init__(self, encoder, decoder):
            super().__init__()
            self.encoder = encoder
            self.decoder = decoder
            stats = np.load(repo_dir / "vae_bn_stats.npz")
            self.bn = SimpleNamespace(
                running_mean=torch.from_numpy(stats["mean"].astype(np.float32)),
                running_var=torch.from_numpy(stats["var"].astype(np.float32)),
            )
            self.config = SimpleNamespace(**json.loads((repo_dir / "vae/config.json").read_text()))
            self.dtype = torch.float32
            self._device = torch.device("cpu")

        @property
        def device(self):
            return self._device

        def to(self, device=None, dtype=None, **kwargs):
            if device is not None:
                self._device = torch.device(device)
                self.bn.running_mean = self.bn.running_mean.to(self._device)
                self.bn.running_var = self.bn.running_var.to(self._device)
            return self

        @staticmethod
        def _run(compiled_model, tensor):
            value = tensor.detach().to(device="cpu", dtype=torch.float32).contiguous().numpy()
            result = compiled_model({compiled_model.input(0): value})
            return torch.from_numpy(np.asarray(result[compiled_model.output(0)], dtype=np.float32))

        def encode(self, image, return_dict=True):
            latents = self._run(self.encoder, image).to(device=image.device)
            output = SimpleNamespace(latent_dist=LatentDistribution(latents))
            return output if return_dict else (output,)

        def decode(self, latents, return_dict=True):
            image = self._run(self.decoder, latents).to(device=latents.device)
            output = SimpleNamespace(sample=image)
            return output if return_dict else (image,)

    pipe.text_encoder = OpenVINOFlux3TextEncoder(compiled["text"])
    pipe.transformer = OpenVINOFlux3Transformer(compiled["transformer"])
    pipe.vae = OpenVINOFlux3VAE(
        None, compiled["vae_decoder"]
    ).to("cuda" if torch.cuda.is_available() else "cpu")
    _log("FLUX.3 OpenVINO pipeline is ready.")
    return pipe


def _save_atomic(image: Any, output_path: Path) -> None:
    temporary = output_path.with_name(f".{output_path.name}.{os.getpid()}.tmp")
    try:
        image.save(temporary, format="PNG")
        os.replace(temporary, output_path)
    finally:
        temporary.unlink(missing_ok=True)


def serve(model_dir: Path, device: str) -> None:
    import torch

    model_dir = model_dir.resolve()
    expected = (MODELS_ROOT / MODEL_FOLDER).resolve()
    if model_dir != expected or not installed(MODELS_ROOT, MODEL_KEY):
        raise ValueError("The installed FLUX.3 Klein model package is incomplete or outside Fern's model folder.")
    pipe = _build_wrappers(model_dir, device)
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            output_dir = Path(request["outputDir"]).resolve()
            if not output_dir.is_dir() or not output_dir.is_relative_to((ROOT / ".cache").resolve()):
                raise ValueError("FLUX.3 output directory must be inside Fern's generation workspace.")
            name = str(request.get("outputName", ""))
            if not re.fullmatch(r"flux3-[A-Za-z0-9_-]+\.png", name):
                raise ValueError("Invalid FLUX.3 output filename.")
            if request.get("referencePath"):
                raise ValueError("This FLUX.3 quant currently supports text-to-image only.")
            width, height = int(request["width"]), int(request["height"])
            steps = int(request.get("steps", DEFAULT_STEPS))
            if not (256 <= width <= 1920 and 256 <= height <= 1920):
                raise ValueError("Image dimensions must be from 256 through 1920 pixels.")
            if width != VALIDATED_WIDTH or height != VALIDATED_HEIGHT:
                raise ValueError("This FLUX.3 quant is currently validated at 1024×1024 only.")
            if steps != DEFAULT_STEPS:
                raise ValueError("This distilled FLUX.3 Klein model uses exactly 16 steps.")
            output_path = (output_dir / name).resolve()
            if output_path.parent != output_dir:
                raise ValueError("Invalid FLUX.3 output path.")
            generator_device = "cuda" if torch.cuda.is_available() else "cpu"
            generator = torch.Generator(device=generator_device).manual_seed(int(request["seed"]))
            start = time.monotonic()
            _log(f"Generating {width}×{height} at 16 steps on {device}…")
            with torch.inference_mode():
                images = pipe(
                    prompt=str(request["prompt"]),
                    height=height,
                    width=width,
                    num_inference_steps=steps,
                    generator=generator,
                    output="images",
                )
            image = images[0]
            if image.size != (width, height):
                raise RuntimeError(f"FLUX.3 returned {image.width}×{image.height}; expected {width}×{height}.")
            _save_atomic(image, output_path)
            _log(f"Completed in {time.monotonic() - start:.1f}s.")
            _emit("result", path=str(output_path), generationTime=time.monotonic() - start)
        except Exception as error:
            _emit("error", error=str(error))


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("serve", choices=("serve",))
    parser.add_argument("model_dir", type=Path)
    parser.add_argument("--device", default="CPU", choices=("CPU", "GPU", "NVIDIA"))
    args = parser.parse_args()
    serve(args.model_dir, args.device)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        _emit("error", error=str(exc))
        raise
