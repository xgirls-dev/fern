"""Prepare a GenAI-compatible Klein 4B or 9B OpenVINO export.

This is an experimental preparation tool; it does not modify the installed model.
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

import numpy as np
import openvino as ov


def prepare_encoder(source: Path, destination: Path, embedding_width: int) -> None:
    model = ov.Core().read_model(str(source / "openvino_model.xml"))
    if len(model.outputs) != 1 or model.output(0).partial_shape[-1].get_length() != embedding_width:
        raise ValueError(f"Expected one concatenated Klein encoder output of width {embedding_width}")
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


def prepare_transformer(source: Path, destination: Path, expected_bridges: int) -> set[str]:
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
    if bridges != expected_bridges:
        raise ValueError(f"Expected {expected_bridges} Klein split connections, found {bridges}")
    model.validate_nodes_and_infer_types()
    destination.mkdir()
    shutil.copy2(source / "config.json", destination / "config.json")
    ov.save_model(model, str(destination / "openvino_model.xml"), compress_to_fp16=False)
    return modules


def convert_adapter(source: Path, destination: Path, modules: set[str]) -> None:
    from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_flux2_lora_to_diffusers
    from safetensors.torch import load_file, save_file

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


def prepare_model(fern_model: Path, transformer: Path, output: Path) -> set[str]:
    config = json.loads((transformer / "config.json").read_text(encoding="utf-8"))
    embedding_width = config["joint_attention_dim"]
    if (embedding_width, config["num_layers"]) not in {(7680, 5), (12288, 8)}:
        raise ValueError("Expected a distilled Klein 4B or 9B transformer")
    for part in ("scheduler", "tokenizer", "vae_encoder", "vae_decoder"):
        shutil.copytree(fern_model / part, output / part)
    shutil.copy2(fern_model / "model_index.json", output / "model_index.json")
    config_path = output / "vae_decoder" / "config.json"
    decoder_config = json.loads(config_path.read_text(encoding="utf-8"))
    with np.load(fern_model / "vae_bn_stats.npz") as stats:
        decoder_config.update(bn_running_mean_data=stats["running_mean"].tolist(),
                              bn_running_var_data=stats["running_var"].tolist(),
                              bn_eps=float(stats["batch_norm_eps"]))
    config_path.write_text(json.dumps(decoder_config, indent=2) + "\n", encoding="utf-8")
    prepare_encoder(fern_model / "text_encoder", output / "text_encoder", embedding_width)
    return prepare_transformer(transformer, output / "transformer", 2 * config["num_layers"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fern-model", type=Path, required=True)
    parser.add_argument("--transformer", type=Path, required=True,
                        help="Directory containing the fresh INT4 transformer export")
    parser.add_argument("--lora", type=Path, help="Optional adapter to convert for a local proof")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error(f"Output already exists: {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".klein-prepare-", dir=args.output.parent) as staging:
        prepared = Path(staging) / "model"
        prepared.mkdir()
        modules = prepare_model(args.fern_model, args.transformer, prepared)
        if args.lora is not None:
            convert_adapter(args.lora, prepared / "adapter.safetensors", modules)
        prepared.rename(args.output)
    print(f"Prepared Klein LoRA model in {args.output}", flush=True)


if __name__ == "__main__":
    main()
