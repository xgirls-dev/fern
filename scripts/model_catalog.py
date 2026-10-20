"""Model identity and installation checks; no runtime imports or downloads."""

import json
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("model_catalog.json").read_text())
FLUX3_CATALOG = json.loads(
    Path(__file__).with_name("flux3_klein_model_catalog.json").read_text()
)
TAME_PONY_CATALOG = json.loads(
    Path(__file__).with_name("tame_pony_model_catalog.json").read_text()
)
MODEL_CATALOG = {**CATALOG, **FLUX3_CATALOG, **TAME_PONY_CATALOG}


def model_spec(model="9b"):
    if model not in MODEL_CATALOG:
        raise ValueError("Choose an installed Fern image model.")
    return MODEL_CATALOG[model]


def installed(root, model):
    spec = model_spec(model)
    folder = Path(root) / spec["folder"]
    if model in ("tame-pony-v25-sdxl", "tame-pony-v25-sdxl-int8"):
        required = [
            "model_index.json",
            "scheduler/scheduler_config.json",
            "text_encoder/config.json",
            "text_encoder/openvino_model.bin",
            "text_encoder/openvino_model.xml",
            "text_encoder_2/config.json",
            "text_encoder_2/openvino_model.bin",
            "text_encoder_2/openvino_model.xml",
            "unet/config.json",
            "unet/openvino_model.bin",
            "unet/openvino_model.xml",
            "vae_decoder/config.json",
            "vae_decoder/openvino_model.bin",
            "vae_decoder/openvino_model.xml",
            "vae_encoder/config.json",
            "vae_encoder/openvino_model.bin",
            "vae_encoder/openvino_model.xml",
        ]
        if model == "tame-pony-v25-sdxl-int8":
            required.extend([
                "openvino_config.json",
                "tokenizer/tokenizer_config.json",
                "tokenizer/merges.txt",
                "tokenizer/vocab.json",
                "tokenizer_2/tokenizer_config.json",
                "tokenizer_2/merges.txt",
                "tokenizer_2/vocab.json",
            ])
        else:
            required.extend([
                "tokenizer/tokenizer_config.json",
                "tokenizer/tokenizer.json",
                "tokenizer_2/tokenizer_config.json",
                "tokenizer_2/tokenizer.json",
            ])
        return all(
            (folder / name).is_file() and (folder / name).stat().st_size > 0
            for name in required
        )
    if model == "flux3-klein":
        required = [
            "model_index.json",
            "modular_model_index.json",
            "openvino_config.json",
            "quantization_config.json",
            "scheduler/scheduler_config.json",
            "text_encoder/config.json",
            "text_encoder/openvino_model.bin",
            "text_encoder/openvino_model.xml",
            "tokenizer/tokenizer_config.json",
            "tokenizer/tokenizer.json",
            "tokenizer/openvino_tokenizer.bin",
            "tokenizer/openvino_tokenizer.xml",
            "tokenizer/openvino_detokenizer.bin",
            "tokenizer/openvino_detokenizer.xml",
            "transformer/config.json",
            "transformer/openvino_model.bin",
            "transformer/openvino_model.xml",
            "vae/config.json",
            "vae_bn_stats.npz",
            "vae_encoder/openvino_model.bin",
            "vae_encoder/openvino_model.xml",
            "vae_decoder/openvino_model.bin",
            "vae_decoder/openvino_model.xml",
            "LICENSE.md",
            "NOTICE.md",
        ]
        return all(
            (folder / name).is_file() and (folder / name).stat().st_size > 0
            for name in required
        )
    # Legacy exports can differ in byte size. Preserve them, but require all
    # generation/edit components rather than confusing a partial install with ready.
    required = [
        "model_index.json",
        "scheduler/scheduler_config.json",
        "tokenizer/tokenizer_config.json",
    ]
    required += [
        f"{part}/openvino_model.{ext}"
        for part in ["transformer", "text_encoder", "vae_decoder", "vae_encoder"]
        for ext in ["bin", "xml"]
    ]
    return all(
        (folder / name).is_file() and (folder / name).stat().st_size > 0
        for name in required
    )


def revision(root, model):
    try:
        return json.loads(
            (Path(root) / model_spec(model)["folder"] / ".fern-model.json").read_text()
        )["revision"]
    except (OSError, ValueError, KeyError):
        return "legacy-unverified"
