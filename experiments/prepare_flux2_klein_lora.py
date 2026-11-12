"""Prepare a local GenAI proof using Fern's Klein components and a compatible transformer.

This is an experimental preparation tool; it does not modify the installed model.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import openvino as ov
from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_flux2_lora_to_diffusers
from safetensors.torch import load_file, save_file


def prepare_encoder(source: Path, destination: Path) -> None:
    model = ov.Core().read_model(str(source / "openvino_model.xml"))
    if len(model.outputs) != 1 or str(model.output(0).partial_shape[-1]) != "7680":
        raise ValueError("Expected the Klein 4B encoder's concatenated 7680-wide output")
    embedded = model.output(0).get_node().input_value(0)
    split = ov.opset13.split(embedded, ov.opset13.constant(np.array(2, dtype=np.int64)), 3)
    outputs = []
    for index, layer in enumerate((9, 18, 27)):
        output = split.output(index)
        output.get_tensor().set_names({f"hidden_states.{layer}"})
        outputs.append(output)
    model.add_outputs(outputs)
    destination.mkdir()
    shutil.copy2(source / "config.json", destination / "config.json")
    ov.save_model(model, str(destination / "openvino_model.xml"), compress_to_fp16=False)


def prepare_transformer(source: Path, destination: Path) -> set[str]:
    model = ov.Core().read_model(str(source / "openvino_model.xml"))
    axis = ov.opset13.constant(np.array(0, dtype=np.int64))
    for name in ("img_ids", "txt_ids"):
        parameter = model.input(name).get_node()
        if parameter.get_partial_shape().rank.get_length() != 2:
            raise ValueError(f"Expected rank-two {name} input")
        output = parameter.output(0)
        targets = list(output.get_target_inputs())
        squeezed = ov.opset13.squeeze(output, axis)
        for target in targets:
            target.replace_source_output(squeezed.output(0))
        parameter.set_partial_shape(ov.PartialShape([-1, -1, 4]))
    bridges = 0
    modules = set()
    for node in model.get_ordered_ops():
        if node.get_type_name() == "MatMul" and "/ov_ext::linear/MatMul" in node.friendly_name:
            modules.add(node.friendly_name.split("__module.", 1)[-1].split("/ov_ext::linear/MatMul", 1)[0])
        if node.get_type_name() != "VariadicSplit":
            continue
        for output in node.outputs():
            for target in list(output.get_target_inputs()):
                if target.get_node().get_type_name() != "MatMul":
                    continue
                identity = ov.opset13.convert(output, output.get_element_type())
                identity.set_friendly_name(target.get_node().friendly_name + "/lora_input")
                target.replace_source_output(identity.output(0))
                bridges += 1
    if bridges != 10:
        raise ValueError(f"Expected 10 Klein 4B split connections, found {bridges}")
    model.validate_nodes_and_infer_types()
    destination.mkdir()
    shutil.copy2(source / "config.json", destination / "config.json")
    ov.save_model(model, str(destination / "openvino_model.xml"), compress_to_fp16=False)
    return modules


def convert_adapter(source: Path, destination: Path, modules: set[str]) -> None:
    state = load_file(str(source), device="cpu")
    if state and all(key.startswith("diffusion_model.") for key in state):
        state = _convert_non_diffusers_flux2_lora_to_diffusers(state)
    if not state:
        raise ValueError("Adapter has no tensors")
    targets = {}
    for key in state:
        prefix = "transformer."
        if not key.startswith(prefix) or not key.endswith((".lora_A.weight", ".lora_B.weight")):
            raise ValueError(f"Unsupported adapter tensor: {key}")
        module, side = key[len(prefix):].rsplit(".lora_", 1)
        targets.setdefault(module, set()).add(side)
    invalid = sorted(module for module, sides in targets.items()
                     if sides != {"A.weight", "B.weight"} or module not in modules)
    if invalid:
        raise ValueError(f"Unmatched or incomplete LoRA targets: {invalid[:10]}")
    save_file(state, str(destination))
    print(f"Prepared {len(targets)} complete LoRA targets", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fern-model", type=Path, required=True)
    parser.add_argument("--transformer", type=Path, required=True,
                        help="Directory containing the fresh INT4 transformer export")
    parser.add_argument("--lora", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # Never replace an existing model directory, even after a failed run.
    args.output.mkdir(parents=True, exist_ok=False)
    for part in ("scheduler", "tokenizer", "vae_encoder", "vae_decoder"):
        shutil.copytree(args.fern_model / part, args.output / part)
    shutil.copy2(args.fern_model / "model_index.json", args.output / "model_index.json")
    stats = np.load(args.fern_model / "vae_bn_stats.npz")
    config_path = args.output / "vae_decoder" / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config.update(bn_running_mean_data=stats["running_mean"].tolist(),
                  bn_running_var_data=stats["running_var"].tolist(),
                  bn_eps=float(stats["batch_norm_eps"]))
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    prepare_encoder(args.fern_model / "text_encoder", args.output / "text_encoder")
    modules = prepare_transformer(args.transformer, args.output / "transformer")
    convert_adapter(args.lora, args.output / "adapter.safetensors", modules)
    print(f"Prepared model and adapter in {args.output}", flush=True)


if __name__ == "__main__":
    main()
