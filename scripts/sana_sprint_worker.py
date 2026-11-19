"""Prepare and serve Fern's SANA-Sprint OpenVINO image pipeline on Intel GPU."""

import json
import os
import shutil
import sys
import time
from pathlib import Path

EVENT = "FERN_SANA_EVENT:"
PROGRESS = "FERN_SANA_PROGRESS:"


def progress(message):
    print(PROGRESS + message, flush=True)


def intel_device(core):
    for device in core.available_devices:
        if device.startswith("GPU") and "intel" in core.get_property(device, "FULL_DEVICE_NAME").lower():
            return device
    raise RuntimeError("SANA-Sprint needs a supported Intel GPU and current OpenVINO GPU drivers.")


def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def prepare(root):
    import nncf
    import openvino as ov

    core = ov.Core()
    intel_device(core)
    source = root / "source"
    stage = root / ".prepared"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir()
    for name in ("model_index.json", "scheduler", "transformer", "vae_encoder", "vae_decoder", "source/tokenizer"):
        origin = root / name
        target = stage / origin.name
        if origin.is_file():
            link_or_copy(origin, target)
        else:
            shutil.copytree(origin, target, copy_function=link_or_copy)
    encoder = stage / "text_encoder"
    encoder.mkdir()
    link_or_copy(source / "text_encoder/config.json", encoder / "config.json")
    progress("Compressing the Gemma text encoder on this computer…")
    model = core.read_model(source / "text_encoder/openvino_model.xml")
    compressed = nncf.compress_weights(
        model, mode=nncf.CompressWeightsMode.INT4_SYM, group_size=64, ratio=1.0, all_layers=True,
    )
    ov.save_model(compressed, encoder / "openvino_model.xml", compress_to_fp16=True)
    stage.rename(root / "prepared")


def serve(model_root):
    import openvino as ov
    from optimum.intel.openvino import OVSanaSprintPipeline
    import torch

    device = intel_device(ov.Core())
    progress(f"Loading SANA-Sprint on Intel {device}…")
    pipe = OVSanaSprintPipeline.from_pretrained(
        model_root, device=device, compile=False, local_files_only=True,
        ov_config={"INFERENCE_PRECISION_HINT": "f16"},
    )
    for name, precision in (("text_encoder", "f16"), ("transformer", "f16"), ("vae_decoder", "f32")):
        progress(f"Compiling {name.replace('_', ' ')} on Intel GPU…")
        part = getattr(pipe, name)
        part.ov_config = {**part.ov_config, "INFERENCE_PRECISION_HINT": precision}
        part.compile()
        compiled = part.request if isinstance(part.request, ov.CompiledModel) else part.request.get_compiled_model()
        devices = compiled.get_property("EXECUTION_DEVICES")
        if not devices or any(not name.startswith("GPU") for name in devices):
            raise RuntimeError(f"Unexpected OpenVINO execution devices for {name}: {devices}.")
    pipe.set_progress_bar_config(disable=True)
    progress("SANA-Sprint is ready on Intel GPU.")
    for line in sys.stdin:
        try:
            request = json.loads(line)
            output = Path(request["output"])
            before = time.perf_counter()
            image = pipe(
                prompt=request["prompt"], height=request["height"], width=request["width"],
                guidance_scale=request["guidance"], num_inference_steps=request["steps"],
                use_resolution_binning=False, generator=torch.Generator().manual_seed(request["seed"]),
            ).images[0]
            image.save(output, format="PNG")
            result = {"path": str(output), "generationTime": time.perf_counter() - before}
        except Exception as error:
            result = {"error": str(error)}
        print(EVENT + json.dumps(result), flush=True)


if __name__ == "__main__":
    operation, folder = sys.argv[1:]
    try:
        (prepare if operation == "prepare" else serve)(Path(folder).resolve())
    except Exception as error:
        print(EVENT + json.dumps({"error": str(error)}), flush=True)
        raise
