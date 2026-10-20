"""Registry for user-added local OpenVINO text-generation models."""
from __future__ import annotations

import hashlib
import json
import re
import os
import threading
from pathlib import Path
from typing import Any
from defusedxml import ElementTree


REQUIRED_FILES = (
    "openvino_model.xml",
    "openvino_model.bin",
    "config.json",
    "tokenizer_config.json",
    "openvino_tokenizer.xml",
    "openvino_tokenizer.bin",
    "openvino_detokenizer.xml",
    "openvino_detokenizer.bin",
)


def inspect_model(path: str | Path, *, validate_ir: bool = False) -> dict[str, Any]:
    try:
        folder = Path(path).expanduser().resolve(strict=True)
    except OSError as error:
        raise ValueError("The model folder is missing or cannot be read. Choose the export folder again.") from error
    if not folder.is_dir():
        raise ValueError("Choose a folder containing an OpenVINO text model.")
    missing = [name for name in REQUIRED_FILES if not (folder / name).is_file()]
    if missing:
        raise ValueError(
            "This folder is not a complete OpenVINO GenAI model export. Missing: "
            + ", ".join(missing) + ". Select the export directory itself, including its converted tokenizer and detokenizer."
        )
    for name in REQUIRED_FILES:
        if (folder / name).stat().st_size <= 0:
            raise ValueError(f"The model file {name} is empty.")
    if validate_ir:
        for name in ("openvino_model.xml", "openvino_tokenizer.xml", "openvino_detokenizer.xml"):
            try:
                if ElementTree.parse(folder / name).getroot().tag != "net":
                    raise ValueError("Expected an OpenVINO IR network.")
            except Exception as error:
                raise ValueError(f"{name} is not a valid OpenVINO IR XML file: {error}") from error

    try:
        config = json.loads((folder / "config.json").read_text(encoding="utf-8-sig"))
        tokenizer = json.loads((folder / "tokenizer_config.json").read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("The model configuration files could not be read.") from error
    if not isinstance(config, dict) or not isinstance(tokenizer, dict):
        raise ValueError("The model configuration files have an invalid format.")
    template = tokenizer.get("chat_template")
    if not (isinstance(template, str) and template.strip()) and not ((folder / "chat_template.jinja").is_file() and (folder / "chat_template.jinja").stat().st_size):
        raise ValueError("This model export does not include a chat template.")

    identity = os.path.normcase(str(folder)).encode("utf-8")
    model_id = hashlib.sha256(identity).hexdigest()[:16]
    marker_name = None
    try:
        metadata = json.loads((folder / ".fern-text-model.json").read_text(encoding="utf-8-sig"))
        marker_name = metadata.get("name") if isinstance(metadata, dict) else None
    except (OSError, json.JSONDecodeError):
        pass
    display_name = str(marker_name or config.get("_name_or_path") or folder.name).strip()
    display_name = re.sub(r"[\r\n\t]+", " ", display_name)[:100] or folder.name
    return {
        "id": model_id,
        "name": display_name,
        "path": str(folder),
        "architecture": ", ".join(str(value) for value in config.get("architectures", [])[:2])
        if isinstance(config.get("architectures"), list)
        else None,
        "modelType": config.get("model_type"),
    }


class TextModelRegistry:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._lock = threading.RLock()

    def _read(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
            if not isinstance(data, dict) or data.get("schemaVersion") != 1:
                raise ValueError("The text model registry has an unsupported format; it has been preserved.")
            models = data.get("models")
            if not isinstance(models, list):
                raise ValueError("The text model registry is invalid.")
            return [item for item in models if isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("path"), str)]
        except FileNotFoundError:
            return []
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("The text model registry could not be read; it has been preserved.") from error

    def snapshot(self) -> list[dict[str, Any]]:
        result = []
        for item in self._read():
            current = item
            try:
                inspected = inspect_model(item["path"])
                ready = True
                reason = None
                current = {**item, **{key: inspected[key] for key in ("name", "architecture", "modelType")}}
            except (KeyError, OSError, TypeError, ValueError) as error:
                ready = False
                reason = str(error)
            result.append({**current, "installed": ready, "error": reason})
        return result

    def add(self, path: str) -> dict[str, Any]:
        with self._lock:
            return self._add(path)

    def _add(self, path: str) -> dict[str, Any]:
        model = inspect_model(path, validate_ir=True)
        models = self._read()
        existing = next((item for item in models if item.get("id") == model["id"]), None)
        if existing:
            return next(item for item in self.snapshot() if item["id"] == model["id"])
        models.append(model)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps({"schemaVersion": 1, "models": models}, indent=2), encoding="utf-8")
        temp.replace(self.path)
        return {**model, "installed": True}

    def remove(self, model_id: str) -> None:
        with self._lock:
            self._remove(model_id)

    def _remove(self, model_id: str) -> None:
        models = self._read()
        updated = [item for item in models if item.get("id") != model_id]
        if len(updated) == len(models):
            raise ValueError("That text model is no longer in the library.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps({"schemaVersion": 1, "models": updated}, indent=2), encoding="utf-8")
        temp.replace(self.path)
