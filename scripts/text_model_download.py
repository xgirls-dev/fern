"""Pinned installer for Fern's recommended Xgirls OpenVINO text model."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Callable

from text_model_registry import inspect_model

CATALOG_PATH = Path(__file__).with_name("text_model_catalog.json")
DEFAULT_MODEL_ID = "qwen3-4b-instruct-2507"
REQUIRED_MODEL_FILES = (
    "config.json",
    "generation_config.json",
    "openvino_model.bin",
    "openvino_model.xml",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
)
MINIMUM_FREE_BYTES = 512 * 1024 * 1024


def catalog() -> dict:
    data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or DEFAULT_MODEL_ID not in data:
        raise RuntimeError("Fern's recommended text model catalog is invalid.")
    return data


def model_spec(model_id: str) -> dict:
    spec = catalog().get(model_id)
    if not isinstance(spec, dict):
        raise ValueError("Choose a supported recommended text model.")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", spec.get("repo", "")):
        raise ValueError("The text model repository ID is invalid.")
    if not re.fullmatch(r"[a-f0-9]{40}", spec.get("revision", "")):
        raise RuntimeError("The text model revision is not pinned.")
    folder = PurePosixPath(spec.get("folder", ""))
    if folder.is_absolute() or len(folder.parts) != 1 or folder.name in ("", ".", ".."):
        raise ValueError("The text model install directory is invalid.")
    seen = set()
    for file in spec.get("files", []):
        path = PurePosixPath(file.get("path", ""))
        if path.is_absolute() or ".." in path.parts or "\\" in file.get("path", "") or path.as_posix() != file.get("path"):
            raise ValueError("The text model manifest contains an invalid path.")
        if file["path"] in seen or not isinstance(file.get("size"), int) or file["size"] <= 0:
            raise ValueError("The text model manifest contains a duplicate or invalid file.")
        algorithm = file.get("algorithm")
        expected_length = 64 if algorithm == "sha256" else 40 if algorithm == "git-sha1" else 0
        if not expected_length or not re.fullmatch(rf"[a-f0-9]{{{expected_length}}}", file.get("digest", "")):
            raise ValueError("The text model manifest contains an invalid checksum.")
        seen.add(file["path"])
    if not set(REQUIRED_MODEL_FILES).issubset(seen):
        raise ValueError("The text model manifest is missing required files.")
    return spec


def digest(path: Path, file: dict) -> str:
    algorithm = file["algorithm"]
    hasher = hashlib.sha256() if algorithm == "sha256" else hashlib.sha1()
    if algorithm == "git-sha1":
        hasher.update(f"blob {file['size']}\0".encode("ascii"))
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def verified(path: Path, file: dict) -> bool:
    try:
        return path.is_file() and path.stat().st_size == file["size"] and digest(path, file) == file["digest"]
    except OSError:
        return False


def download_file(url: str, target: Path, file: dict, progress: Callable[[str], None]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    if verified(target, file):
        return
    if target.exists():
        target.unlink()
    offset = partial.stat().st_size if partial.is_file() else 0
    if offset > file["size"]:
        partial.unlink()
        offset = 0
    if offset == file["size"]:
        if verified(partial, file):
            os.replace(partial, target)
            return
        partial.unlink()
        offset = 0
    headers = {"User-Agent": "Fern-Text-Model-Installer/1", "Accept-Encoding": "identity"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=90)
    except (OSError, urllib.error.URLError) as error:
        raise RuntimeError(f"Could not download {file['path']}: {error}. Retry to resume.") from error
    with response:
        status = response.getcode()
        if status == 200:
            offset = 0
        elif status == 206:
            content_range = response.headers.get("Content-Range", "")
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if not match or int(match.group(1)) != offset or int(match.group(3)) != file["size"]:
                raise RuntimeError("Hugging Face returned an invalid or incomplete download range. Retry the download.")
        else:
            raise RuntimeError(f"Unexpected download response for {file['path']}: HTTP {status}.")
        downloaded = offset
        last_update = 0.0
        with partial.open("ab" if offset else "wb") as stream:
            while block := response.read(1024 * 1024):
                downloaded += len(block)
                if downloaded > file["size"]:
                    raise RuntimeError(f"Download exceeded the expected size for {file['path']}.")
                stream.write(block)
                now = time.monotonic()
                if now - last_update >= 1.5:
                    progress(f"Downloading {file['path']} · {downloaded / file['size']:.0%}")
                    last_update = now
    if partial.stat().st_size != file["size"]:
        raise RuntimeError(f"Download of {file['path']} was interrupted. Retry to resume.")
    progress(f"Verifying {file['path']}…")
    if not verified(partial, file):
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum verification failed for {file['path']}. Retry the download.")
    os.replace(partial, target)


def convert_tokenizers(folder: Path, progress: Callable[[str], None]) -> None:
    progress("Converting the tokenizer and detokenizer for Fern…")
    try:
        import openvino as ov
        import openvino_tokenizers
        from transformers import AutoTokenizer
    except Exception as error:
        raise RuntimeError(f"Tokenizer conversion dependencies are unavailable: {error}") from error
    try:
        tokenizer = AutoTokenizer.from_pretrained(str(folder), local_files_only=True, trust_remote_code=False)
        if not getattr(tokenizer, "chat_template", None):
            raise ValueError("The export does not include a chat template.")
        tokenizer_model, detokenizer_model = openvino_tokenizers.convert_tokenizer(tokenizer, with_detokenizer=True)
        ov.serialize(tokenizer_model, str(folder / "openvino_tokenizer.xml"), str(folder / "openvino_tokenizer.bin"))
        ov.serialize(detokenizer_model, str(folder / "openvino_detokenizer.xml"), str(folder / "openvino_detokenizer.bin"))
        tokenizer_config_path = folder / "tokenizer_config.json"
        config = json.loads(tokenizer_config_path.read_text(encoding="utf-8-sig"))
        if not config.get("chat_template"):
            config["chat_template"] = tokenizer.chat_template
        tokenizer_config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as error:
        raise RuntimeError(f"Could not prepare this export's tokenizer for OpenVINO GenAI: {error}") from error


def _install_model(model_id: str, model_root: str | Path, progress: Callable[[str], None]) -> Path:
    spec = model_spec(model_id)
    root = Path(model_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / spec["folder"]
    stage = root / (spec["folder"] + ".download")
    if folder.parent != root or stage.parent != root:
        raise ValueError("Invalid text model installation path.")
    marker = folder / ".fern-text-model.json"
    if marker.is_file():
        try:
            current = json.loads(marker.read_text(encoding="utf-8"))
            if current.get("revision") == spec["revision"]:
                inspect_model(folder)
                progress("Recommended OpenVINO text model is already installed.")
                return folder
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    stage.mkdir(exist_ok=True)
    files = spec["files"]
    required_missing = sum(
        max(0, item["size"] - ((stage / item["path"]).with_name(Path(item["path"]).name + ".part").stat().st_size
                              if (stage / item["path"]).with_name(Path(item["path"]).name + ".part").is_file()
                              else 0))
        for item in files if not verified(stage / item["path"], item)
    )
    if shutil.disk_usage(root).free < required_missing + MINIMUM_FREE_BYTES:
        needed_gb = (required_missing + MINIMUM_FREE_BYTES) / 1024**3
        raise RuntimeError(f"Free at least {needed_gb:.1f} GiB before installing this text model.")
    progress(f"Downloading {spec['name']} from {spec['repo']} · {sum(file['size'] for file in files) / 1024**3:.2f} GiB.")
    for file in files:
        url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{file['path']}"
        download_file(url, stage / file["path"], file, progress)
    convert_tokenizers(stage, progress)
    try:
        inspect_model(stage, validate_ir=True)
    except ValueError as error:
        raise RuntimeError(f"The downloaded export failed Fern's model validation: {error}") from error
    metadata = {
        "modelId": model_id,
        "name": spec["name"],
        "repo": spec["repo"],
        "revision": spec["revision"],
        "format": spec["format"],
        "tokenizersConvertedByFern": True,
        "verifiedChecksums": True,
    }
    (stage / ".fern-text-model.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    previous = None
    if folder.exists():
        previous = root / (spec["folder"] + f".previous-{time.time_ns()}")
        os.replace(folder, previous)
    try:
        os.replace(stage, folder)
    except BaseException:
        if previous is not None:
            os.replace(previous, folder)
        raise
    progress("Recommended OpenVINO text model installed and verified.")
    return folder


def install_model(model_id: str, model_root: str | Path, progress: Callable[[str], None] = print) -> Path:
    spec = model_spec(model_id)
    root = Path(model_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / (spec["folder"] + ".install.lock")
    with lock_path.open("a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"0")
            lock_file.flush()
        try:
            if sys.platform == "win32":
                import msvcrt
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, ImportError) as error:
            raise RuntimeError("This text model is already being installed by another Fern process.") from error
        try:
            return _install_model(model_id, root, progress)
        finally:
            if sys.platform == "win32":
                import msvcrt
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def installed_model(model_id: str, model_root: str | Path) -> bool:
    spec = model_spec(model_id)
    folder = Path(model_root).resolve() / spec["folder"]
    try:
        metadata = json.loads((folder / ".fern-text-model.json").read_text(encoding="utf-8"))
        return metadata.get("modelId") == model_id and metadata.get("revision") == spec["revision"] and all(
            (folder / name).is_file() and (folder / name).stat().st_size > 0
            for name in REQUIRED_MODEL_FILES + (
                "openvino_tokenizer.xml", "openvino_tokenizer.bin",
                "openvino_detokenizer.xml", "openvino_detokenizer.bin",
            )
        )
    except (OSError, ValueError, json.JSONDecodeError):
        return False
