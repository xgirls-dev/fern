"""Resumable, integrity-checked downloader for Fern's pinned Qwen Turbo export."""
from __future__ import annotations

import hashlib
import json
import shutil
import threading
import time
import urllib.request
from pathlib import Path
from typing import Callable


CHUNK_SIZE = 1024 * 1024
MINIMUM_FREE_BYTES = 1024**3


def load_catalog(catalog_path: Path) -> dict:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8-sig"))
    if (
        not isinstance(catalog, dict)
        or not isinstance(catalog.get("repo"), str)
        or not isinstance(catalog.get("revision"), str)
        or not catalog["repo"]
        or not catalog["revision"]
        or not isinstance(catalog.get("files"), list)
        or not catalog["files"]
    ):
        raise RuntimeError("The pinned Qwen Turbo download catalog is missing or invalid.")
    total = 0
    paths: set[str] = set()
    for item in catalog["files"]:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("path"), str)
            or not isinstance(item.get("size"), int)
            or item["size"] <= 0
            or not isinstance(item.get("sha256"), str)
            or len(item["sha256"]) != 64
            or any(char not in "0123456789abcdef" for char in item["sha256"])
        ):
            raise RuntimeError("The pinned Qwen Turbo download catalog contains an invalid file entry.")
        rel = Path(item["path"])
        if rel.is_absolute() or rel.drive or ".." in rel.parts or "model_cache" in rel.parts:
            raise RuntimeError("The pinned Qwen Turbo download catalog contains an unsafe file path.")
        path_key = rel.as_posix()
        if path_key in paths:
            raise RuntimeError("The pinned Qwen Turbo download catalog contains a duplicate path.")
        paths.add(path_key)
        total += item["size"]
    if catalog.get("bytes") != total:
        raise RuntimeError("The pinned Qwen Turbo download catalog total does not match its file list.")
    required = {
        ".fern-qwen21-turbo-openvino.json", ".fern-sample-sigmas.json",
        ".fern-validation.json", ".fern-validation.png", "LICENSE", "NOTICE",
        "README.md", "model_index.json",
        *(f"{component}/openvino_model.{extension}"
          for component in ("transformer", "text_encoder", "text_encoder_i2i", "vision_encoder", "vae_encoder", "vae_decoder")
          for extension in ("xml", "bin")),
    }
    if not required.issubset(paths):
        raise RuntimeError("The pinned Qwen Turbo catalog omits model, provenance, validation, or license files.")
    return catalog


def _sha256(path: Path, cancel_event: threading.Event) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(4 * 1024 * 1024):
            if cancel_event.is_set():
                raise InterruptedError()
            digest.update(chunk)
    return digest.hexdigest()


def download_model(
    catalog_path: Path,
    stage: Path,
    cancel_event: threading.Event,
    progress: Callable[[int, int, str], None],
) -> dict:
    catalog = load_catalog(catalog_path)
    stage = stage.resolve()
    stage.mkdir(parents=True, exist_ok=True)
    total = catalog["bytes"]
    completed = 0
    remaining_total = 0
    for item in catalog["files"]:
        target = (stage / Path(item["path"])).resolve()
        if not target.is_relative_to(stage):
            raise RuntimeError("A Qwen Turbo download path escaped its staging directory.")
        current_size = target.stat().st_size if target.is_file() else 0
        if current_size > item["size"]:
            target.unlink()
            current_size = 0
        remaining_total += item["size"] - current_size
    if shutil.disk_usage(stage).free < remaining_total + MINIMUM_FREE_BYTES:
        raise RuntimeError(
            "Not enough free disk space to download Qwen Turbo; "
            "leave at least 1 GB free after installation."
        )
    for item in catalog["files"]:
        if cancel_event.is_set():
            raise InterruptedError()
        rel_path = Path(item["path"])
        target = (stage / rel_path).resolve()
        if not target.is_relative_to(stage):
            raise RuntimeError("A Qwen Turbo download path escaped its staging directory.")
        target.parent.mkdir(parents=True, exist_ok=True)
        offset = target.stat().st_size if target.is_file() else 0
        if offset > item["size"]:
            target.unlink()
            offset = 0
        if offset == item["size"]:
            if _sha256(target, cancel_event) == item["sha256"]:
                completed += item["size"]
                progress(completed, total, rel_path.as_posix())
                continue
            target.unlink()
            offset = 0

        remaining = item["size"] - offset
        if shutil.disk_usage(stage).free < remaining + MINIMUM_FREE_BYTES:
            raise RuntimeError(
                "Not enough free disk space to finish the Qwen Turbo download; "
                "leave at least 1 GB free after installation."
            )
        url = (
            f"https://huggingface.co/{catalog['repo']}/resolve/"
            f"{catalog['revision']}/{rel_path.as_posix()}"
        )
        headers = {"User-Agent": "Fern-Qwen-Model-Installer/1.0"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)
        last_reported = 0
        last_report_time = time.monotonic()
        with urllib.request.urlopen(request, timeout=60) as response:
            append = offset > 0 and response.status == 206
            if offset and not append:
                offset = 0
            mode = "ab" if append else "wb"
            with target.open(mode) as output:
                while True:
                    if cancel_event.is_set():
                        raise InterruptedError()
                    chunk = response.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    output.write(chunk)
                    offset += len(chunk)
                    now = time.monotonic()
                    if offset - last_reported >= 32 * CHUNK_SIZE or now - last_report_time >= 2:
                        progress(completed + offset, total, rel_path.as_posix())
                        last_reported = offset
                        last_report_time = now
        if cancel_event.is_set():
            raise InterruptedError()
        if target.stat().st_size != item["size"]:
            raise RuntimeError(f"Downloaded file has the wrong size: {rel_path.as_posix()}")
        if _sha256(target, cancel_event) != item["sha256"]:
            target.unlink()
            raise RuntimeError(
                f"Download integrity check failed for {rel_path.as_posix()}; retry to download it again."
            )
        completed += item["size"]
        progress(completed, total, rel_path.as_posix())

    return catalog
