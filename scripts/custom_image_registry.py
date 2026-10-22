"""Registry for user-added OpenVINO GenAI text-to-image exports."""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from pathlib import Path
from typing import Any

from defusedxml import ElementTree


FAMILIES: dict[str, dict[str, Any]] = {
    "stable-diffusion": {"label": "Stable Diffusion 1.x / 2.x", "classes": {"StableDiffusionPipeline"}, "steps": 30, "guidance": 7.0, "width": 512, "height": 512, "multiple": 8, "minimum": 256, "maximum": 1920},
    "sdxl": {"label": "Stable Diffusion XL", "classes": {"StableDiffusionXLPipeline"}, "steps": 30, "guidance": 7.0, "width": 1024, "height": 1024, "multiple": 8, "minimum": 512, "maximum": 1536},
    "sd3": {"label": "Stable Diffusion 3", "classes": {"StableDiffusion3Pipeline"}, "steps": 28, "guidance": 4.5, "width": 1024, "height": 1024, "multiple": 16, "minimum": 256, "maximum": 1920},
    "flux": {"label": "FLUX.1", "classes": {"FluxPipeline"}, "steps": 28, "guidance": 3.5, "width": 1024, "height": 1024, "multiple": 16, "minimum": 256, "maximum": 1920},
    "flux2-klein": {"label": "FLUX.2 Klein", "classes": {"FluxPipeline", "Flux2Pipeline", "Flux2KleinPipeline"}, "steps": 4, "guidance": 1.0, "width": 1024, "height": 1024, "multiple": 16, "minimum": 256, "maximum": 1920},
    "lcm": {"label": "Latent Consistency Model", "classes": {"LatentConsistencyModelPipeline"}, "steps": 4, "guidance": 1.0, "width": 512, "height": 512, "multiple": 8, "minimum": 256, "maximum": 1920},
}


def inspect_model(path: str | Path, family: str) -> dict[str, Any]:
    if family not in FAMILIES:
        raise ValueError("Choose a supported OpenVINO image model family.")
    try:
        folder = Path(path).expanduser().resolve(strict=True)
    except OSError as error:
        raise ValueError("The model folder is missing or cannot be read. Choose the export folder again.") from error
    if not folder.is_dir():
        raise ValueError("Choose a folder containing an OpenVINO image model export.")
    index_path = folder / "model_index.json"
    if not index_path.is_file() or index_path.stat().st_size <= 0:
        raise ValueError("This folder is missing model_index.json. Select the OpenVINO GenAI export folder itself.")
    try:
        index = json.loads(index_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("The model_index.json file could not be read.") from error
    if not isinstance(index, dict):
        raise ValueError("The model_index.json file has an invalid format.")
    class_name = index.get("_class_name") or index.get("pipeline_class")
    if class_name not in FAMILIES[family]["classes"]:
        available = ", ".join(sorted(FAMILIES[family]["classes"]))
        raise ValueError(f"The selected family expects {available}; this export declares {class_name or 'an unknown pipeline'}.")
    # GenAI exports use component subfolders containing paired OpenVINO IR files.
    ir_pairs = []
    for xml_path in folder.rglob("*.xml"):
        if xml_path.is_symlink():
            continue
        bin_path = xml_path.with_suffix(".bin")
        if bin_path.is_file() and not bin_path.is_symlink() and xml_path.stat().st_size and bin_path.stat().st_size:
            try:
                if ElementTree.parse(xml_path).getroot().tag == "net":
                    ir_pairs.append((xml_path, bin_path))
            except Exception:
                continue
    if not ir_pairs:
        raise ValueError("No valid OpenVINO IR XML/BIN component pairs were found in this folder.")
    identity = os.path.normcase(str(folder)).encode("utf-8")
    model_id = "custom-" + hashlib.sha256(identity).hexdigest()[:16]
    label = re.sub(r"[\r\n\t]+", " ", folder.name).strip()[:100] or "Custom image model"
    try:
        size = sum(item.stat().st_size for pair in ir_pairs for item in pair)
    except OSError:
        size = 0
    return {"id": model_id, "label": label, "path": str(folder), "family": family, "pipelineClass": class_name, "irFiles": [str(path.relative_to(folder)) for pair in ir_pairs for path in pair], "bytes": size}


class CustomImageRegistry:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lock = threading.RLock()

    def _read(self) -> list[dict[str, Any]]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8-sig"))
            if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("models"), list):
                raise ValueError("The custom image model registry has an unsupported format; it has been preserved.")
            return [item for item in value["models"] if isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("path"), str)]
        except FileNotFoundError:
            return []
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("The custom image model registry could not be read; it has been preserved.") from error

    def snapshot(self) -> list[dict[str, Any]]:
        return [self.get(item["id"]) for item in self._read() if isinstance(item.get("id"), str)]

    def add(
        self,
        path: str,
        family: str,
        *,
        source_type: str = "local",
        repo_id: str | None = None,
        label: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            model = inspect_model(path, family)
            if source_type not in ("local", "huggingface"):
                raise ValueError("The custom model source is not supported.")
            if source_type == "huggingface" and not repo_id:
                raise ValueError("The Hugging Face repository name is missing.")
            if label:
                model["label"] = re.sub(r"[\r\n\t]+", " ", label).strip()[:100] or model["label"]
            model["sourceType"] = source_type
            if repo_id:
                model["repoId"] = repo_id
            models = self._read()
            existing = next((index for index, item in enumerate(models) if item.get("id") == model["id"]), None)
            if existing is None:
                models.append(model)
            else:
                previous = models[existing]
                if source_type == "local" and previous.get("sourceType") == "huggingface":
                    model["sourceType"] = "huggingface"
                    model["repoId"] = previous.get("repoId")
                    model["label"] = previous.get("label") or model["label"]
                models[existing] = model
            self._write(models)
            return {**model, "familyLabel": FAMILIES[family]["label"], "defaultSteps": FAMILIES[family]["steps"], "defaultGuidance": FAMILIES[family]["guidance"], "defaultWidth": FAMILIES[family]["width"], "defaultHeight": FAMILIES[family]["height"], "installed": True, "state": "installed", "downloaded": model["bytes"], "runtimeReady": True, "supportsReferenceImage": False}

    def remove(self, model_id: str) -> None:
        with self._lock:
            models = self._read()
            updated = [item for item in models if item.get("id") != model_id]
            if len(updated) == len(models):
                raise ValueError("That custom image model is no longer in the library.")
            self._write(updated)

    def get(self, model_id: str) -> dict[str, Any] | None:
        item = next((item for item in self._read() if item.get("id") == model_id), None)
        if item is None:
            return None
        try:
            if isinstance(item.get("irFiles"), list) and item["irFiles"]:
                folder = Path(item["path"]).resolve(strict=True)
                paths = [(folder / relative).resolve(strict=True) for relative in item["irFiles"]]
                if not folder.is_dir() or any(not path.is_relative_to(folder) or not path.is_file() or path.stat().st_size <= 0 for path in paths):
                    raise ValueError("Registered OpenVINO IR files are missing. Add the export folder again.")
                index = json.loads((folder / "model_index.json").read_text(encoding="utf-8-sig"))
                if not isinstance(index, dict) or index.get("_class_name") != item.get("pipelineClass"):
                    raise ValueError("The registered model configuration changed. Add the export folder again.")
                inspected = {**item, "label": item.get("label") or re.sub(r"[\r\n\t]+", " ", folder.name).strip()[:100] or "Custom image model"}
            else:
                inspected = inspect_model(item["path"], item["family"])
            family = FAMILIES[item["family"]]
            return {**item, **inspected, "familyLabel": family["label"], "defaultSteps": family["steps"], "defaultGuidance": family["guidance"], "defaultWidth": family["width"], "defaultHeight": family["height"], "installed": True, "state": "installed", "downloaded": inspected["bytes"], "runtimeReady": True, "supportsReferenceImage": False}
        except (KeyError, OSError, TypeError, ValueError) as error:
            family = FAMILIES.get(item.get("family"), {})
            return {**item, "familyLabel": family.get("label", "Unsupported family"), "installed": False, "state": "repair-needed", "downloaded": 0, "runtimeReady": False, "supportsReferenceImage": False, "error": str(error)}

    def contains(self, model_id: str) -> bool:
        return any(item.get("id") == model_id for item in self._read())

    def _write(self, models: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps({"schemaVersion": 1, "models": models}, indent=2), encoding="utf-8")
        temp.replace(self.path)


_root = Path(os.environ.get("FERN_ROOT") or Path(__file__).resolve().parents[1])
MODEL_REGISTRY = CustomImageRegistry(Path(os.environ.get("FERN_CUSTOM_IMAGE_REGISTRY", _root / "data" / "custom-image-models.json")))
