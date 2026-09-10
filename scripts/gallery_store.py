from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

CONFIGURED_ROOT = (
    os.environ.get("FERN_ROOT", "").strip()
    or os.environ.get("INTEL_IRIS_ROOT", "").strip()
)
ROOT = Path(CONFIGURED_ROOT).resolve() if CONFIGURED_ROOT else Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
GALLERY_PATH = DATA_DIR / "flux2_gallery.json"
GALLERY_LOCK = threading.Lock()
SEED_PATTERN = re.compile(r"-seed(\d+)", re.IGNORECASE)


def _empty_gallery() -> dict[str, Any]:
    return {"images": {}}


def _read_unlocked() -> dict[str, Any]:
    if not GALLERY_PATH.exists():
        return _empty_gallery()
    try:
        raw = json.loads(GALLERY_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("images"), dict):
            return raw
    except Exception:
        pass
    return _empty_gallery()


def _write_unlocked(data: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = GALLERY_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temp.replace(GALLERY_PATH)


def save_image_metadata(name: str, metadata: dict[str, Any]) -> None:
    filename = Path(name).name
    with GALLERY_LOCK:
        data = _read_unlocked()
        images = data.setdefault("images", {})
        images[filename] = {**images.get(filename, {}), **metadata, "name": filename}
        _write_unlocked(data)


def get_image_metadata(name: str) -> dict[str, Any] | None:
    filename = Path(name).name
    with GALLERY_LOCK:
        entry = _read_unlocked().get("images", {}).get(filename)
        return dict(entry) if isinstance(entry, dict) else None


def clear_gallery() -> None:
    with GALLERY_LOCK:
        if GALLERY_PATH.exists():
            GALLERY_PATH.unlink()


def parse_seed_from_name(name: str) -> int | None:
    match = SEED_PATTERN.search(name)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def enrich_image_record(record: dict[str, Any], metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    name = str(record.get("name", ""))
    meta = (metadata.get(name) or {}) if metadata is not None else (get_image_metadata(name) or {})
    enriched = {**record}

    for key in (
        "referenceUsed",
        "referenceUrl",
        "threadId",
        "prompt",
        "negativePrompt",
        "seed",
        "width",
        "height",
        "steps",
        "guidance",
        "device",
        "modelPath",
        "generationTime",
    ):
        if key in meta and meta[key] is not None:
            enriched[key] = meta[key]

    if enriched.get("seed") is None:
        parsed = parse_seed_from_name(name)
        if parsed is not None:
            enriched["seed"] = parsed

    return enriched


def metadata_snapshot() -> dict[str, Any]:
    with GALLERY_LOCK:
        return _read_unlocked().get("images", {})


def remove_image_metadata(names) -> None:
    with GALLERY_LOCK:
        data = _read_unlocked()
        for name in names:
            data["images"].pop(name, None)
        _write_unlocked(data)
