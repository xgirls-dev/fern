"""Model identity and installation checks; no runtime imports or downloads."""

import json
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name("model_catalog.json").read_text())


def model_spec(model="9b"):
    if model not in CATALOG:
        raise ValueError("Choose Auto, Klein 9B or Klein 4B.")
    return CATALOG[model]


def installed(root, model):
    folder = Path(root) / model_spec(model)["folder"]
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
