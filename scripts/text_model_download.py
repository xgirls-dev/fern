"""Pinned installer for Fern's recommended chat models."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from threading import Event
from typing import Callable

from text_model_registry import REQUIRED_FILES, inspect_model

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
INSTALL_MARKER = ".fern-text-model.json"
PREPARING_MODEL_FILES = "Preparing downloaded model files…"


class TextModelDownloadPaused(Exception):
    pass


def check_download_pause(pause: Event | None) -> None:
    if pause is not None and pause.is_set():
        raise TextModelDownloadPaused()


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
    required = REQUIRED_MODEL_FILES
    if spec.get("format") == "gguf":
        model = spec.get("modelFile")
        projector = spec.get("projectorFile")
        required = (model,) if projector is None else (model, projector)
        if any(not isinstance(filename, str) or not filename.endswith(".gguf")
               or PurePosixPath(filename).name != filename for filename in required):
            raise ValueError("The GGUF catalog must specify a valid model file and any companion projector file.")
        if model == projector:
            raise ValueError("The model and projector must be separate GGUF files.")
    if not set(required).issubset(seen):
        raise ValueError("The text model manifest is missing required files.")
    return spec


def model_download_details(spec: dict) -> dict[str, int | list[str]]:
    files = spec["files"]
    size = sum(file["size"] for file in files)
    details: dict[str, int | list[str]] = {"bytes": size, "minimumFreeBytes": size + MINIMUM_FREE_BYTES}
    if devices := spec.get("recommendedDevices"):
        details["recommendedDevices"] = devices
    projector = next((file for file in files if file["path"] == spec.get("projectorFile")), None)
    if projector:
        details["projectorBytes"] = projector["size"]
    return details


def model_files(folder: Path, spec: dict) -> tuple[Path, Path | None]:
    if spec.get("format") == "gguf":
        projector = spec.get("projectorFile")
        return folder / spec["modelFile"], folder / projector if projector else None
    return folder, None


def managed_download_id(root: Path, model: dict, specs: dict) -> str | None:
    for model_id, spec in specs.items():
        folder = root / spec["folder"]
        main, _ = model_files(folder, spec)
        if Path(model["path"]) != main:
            continue
        marker = folder / INSTALL_MARKER
        try:
            if (folder.parent != root or folder.resolve() != folder or main.resolve() != main
                    or marker.resolve() != marker or not marker.is_file()):
                continue
            metadata = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError, RuntimeError):
            continue
        if (isinstance(metadata, dict) and metadata.get("modelId") == model_id
                and metadata.get("verifiedChecksums") is True
                and all(metadata.get(key) == spec[key] for key in ("repo", "revision", "format"))):
            return model_id
    return None


def model_package_files(spec: dict) -> set[str]:
    names = {file["path"] for file in spec["files"]}
    if spec["format"] != "gguf":
        names.update(REQUIRED_FILES)
    return names


def check_package_paths(folder: Path, names: set[str]) -> None:
    for name in names:
        target = folder / name
        if (not target.is_relative_to(folder) or target.resolve() != target
                or target.is_symlink() or (target.exists() and not target.is_file())):
            raise ValueError("A download file was moved or replaced. Restore its location or unlink the model.")


def remove_download(root: Path, model: dict, models: list[dict], unregister: Callable[[str], None]) -> None:
    catalog_id = managed_download_id(root, model, catalog())
    if catalog_id is None:
        raise ValueError("Fern could not verify this download. You can unlink the model and keep its files.")
    spec = model_spec(catalog_id)
    folder = root / spec["folder"]
    with model_install_lock(root, spec):
        if not managed_download_id(root, model, {catalog_id: spec}):
            raise ValueError("The download changed on disk. Refresh Models and try again.")
        for entry in models:
            if entry["id"] == model["id"]:
                continue
            references = (entry.get("path"), entry.get("projectorPath"))
            if any(path and Path(path).resolve().is_relative_to(folder) for path in references):
                raise ValueError(f'“{entry["name"]}” uses files in this download. Unlink that model first.')
        filenames = model_package_files(spec)
        check_package_paths(folder, filenames)
        for name in sorted(filenames):
            try:
                (folder / name).unlink(missing_ok=True)
            except OSError as error:
                raise ValueError(f"Could not delete {Path(name).name}. Close any app using it and retry.") from error
        unregister(model["id"])
        try:
            (folder / INSTALL_MARKER).unlink(missing_ok=True)
            folder.rmdir()
        except OSError:
            # The download is gone. Preserve any other files in its folder.
            pass


def has_partial_download(root: Path, spec: dict) -> bool:
    stage = root / (spec["folder"] + ".download")
    try:
        if stage.is_dir():
            for file in spec["files"]:
                target = stage / file["path"]
                partial = target.with_name(target.name + ".part")
                if target.is_file() or partial.is_file() and partial.stat().st_size > 0:
                    return True
    except OSError:
        pass
    return False


def digest(path: Path, file: dict, pause: Event | None = None) -> str:
    algorithm = file["algorithm"]
    hasher = hashlib.sha256() if algorithm == "sha256" else hashlib.sha1()
    if algorithm == "git-sha1":
        hasher.update(f"blob {file['size']}\0".encode("ascii"))
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            check_download_pause(pause)
            hasher.update(block)
    return hasher.hexdigest()


def verified(path: Path, file: dict, pause: Event | None = None) -> bool:
    check_download_pause(pause)
    try:
        return path.is_file() and path.stat().st_size == file["size"] and digest(path, file, pause) == file["digest"]
    except OSError:
        return False


def download_file(url: str, target: Path, file: dict, progress: Callable[[str], None], *, pause: Event | None = None) -> None:
    check_download_pause(pause)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    if verified(target, file, pause):
        return
    if target.exists():
        target.unlink()
    offset = partial.stat().st_size if partial.is_file() else 0
    if offset > file["size"]:
        partial.unlink()
        offset = 0
    if offset == file["size"]:
        if verified(partial, file, pause):
            os.replace(partial, target)
            return
        partial.unlink()
        offset = 0
    headers = {"User-Agent": "Fern-Text-Model-Installer/1", "Accept-Encoding": "identity"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    try:
        # Interactive downloads yield promptly if the peer stops sending data.
        response = urllib.request.urlopen(request, timeout=10 if pause is not None else 90)
    except (OSError, urllib.error.URLError) as error:
        check_download_pause(pause)
        raise RuntimeError(f"Could not download {file['path']}: {error}. Retry to resume.") from error
    with response:
        check_download_pause(pause)
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
            read = response.read1 if pause is not None else response.read
            while True:
                check_download_pause(pause)
                try:
                    block = read(1024 * 1024)
                except OSError as error:
                    if pause is None:
                        raise
                    check_download_pause(pause)
                    raise RuntimeError(f"Download of {file['path']} was interrupted. Retry to resume.") from error
                if not block:
                    break
                downloaded += len(block)
                if downloaded > file["size"]:
                    raise RuntimeError(f"Download exceeded the expected size for {file['path']}.")
                stream.write(block)
                now = time.monotonic()
                if now - last_update >= 1.5:
                    progress(f"Downloading {file['path']} · {downloaded / file['size']:.0%}")
                    last_update = now
    check_download_pause(pause)
    if partial.stat().st_size != file["size"]:
        raise RuntimeError(f"Download of {file['path']} was interrupted. Retry to resume.")
    progress(f"Verifying {file['path']}…")
    if not verified(partial, file, pause):
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


def _install_model(model_id: str, model_root: str | Path, progress: Callable[[str], None], *,
                   pause: Event | None = None, repair: bool = False) -> Path:
    check_download_pause(pause)
    spec = model_spec(model_id)
    root = Path(model_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / spec["folder"]
    stage = root / (spec["folder"] + ".download")
    if folder.parent != root or stage.parent != root:
        raise ValueError("Invalid text model installation path.")
    marker = folder / INSTALL_MARKER
    files = spec["files"]
    gguf = spec["format"] == "gguf"
    reused = set()
    if repair:
        model, _ = model_files(folder, spec)
        if not managed_download_id(root, {"path": str(model)}, {model_id: spec}):
            raise ValueError("Fern can repair only its own verified downloads. Import a replacement for linked files.")
        names = model_package_files(spec)
        check_package_paths(folder, names)
        check_package_paths(stage, names | {f"{item['path']}.part" for item in files} | {INSTALL_MARKER})
        progress("Checking downloaded files…")
        if gguf:
            reused = {item["path"] for item in files if verified(folder / item["path"], item, pause)}
    elif marker.is_file():
        try:
            current = json.loads(marker.read_text(encoding="utf-8"))
            if current.get("revision") == spec["revision"]:
                model, projector = model_files(folder, spec)
                inspect_model(model, projector_path=projector)
                if gguf and any((folder / item["path"]).stat().st_size != item["size"] for item in files):
                    raise ValueError("An installed GGUF file has an unexpected length.")
                progress(PREPARING_MODEL_FILES)
                progress("Recommended text model is already installed.")
                return folder
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    stage.mkdir(exist_ok=True)
    needed = [item for item in files if item["path"] not in reused and not verified(stage / item["path"], item, pause)]
    required_missing = sum(
        max(0, item["size"] - ((stage / item["path"]).with_name(Path(item["path"]).name + ".part").stat().st_size
                              if (stage / item["path"]).with_name(Path(item["path"]).name + ".part").is_file()
                              else 0))
        for item in needed
    )
    required_free = required_missing + (MINIMUM_FREE_BYTES if not repair or needed or not gguf else 0)
    if shutil.disk_usage(root).free < required_free:
        needed_gb = math.ceil(required_free / 10_000_000) / 100
        action = "repairing" if repair else "installing"
        raise RuntimeError(f"Free at least {needed_gb:.2f} GB before {action} this text model.")
    if repair:
        if needed:
            progress(f"Repairing {spec['name']}…")
    else:
        action = "Resuming" if has_partial_download(root, spec) else "Downloading"
        progress(f"{action} {spec['name']} from {spec['repo']} · {sum(file['size'] for file in files) / 1e9:.2f} GB.")
    for file in needed:
        target = stage / file["path"]
        partial = target.with_name(target.name + ".part")
        source = folder / file["path"]
        if repair and not gguf and not partial.exists() and verified(source, file, pause):
            progress(f"Reusing {source.name}…")
            with source.open("rb") as reader, partial.open("wb") as writer:
                while block := reader.read(4 * 1024 * 1024):
                    check_download_pause(pause)
                    writer.write(block)
        url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{file['path']}"
        download_file(url, target, file, progress, pause=pause)
    check_download_pause(pause)
    progress(PREPARING_MODEL_FILES)
    model, projector = model_files(stage, spec)
    if gguf:
        if spec["modelFile"] in reused:
            model = folder / spec["modelFile"]
        if projector is not None and projector.name in reused:
            projector = folder / projector.name
    else:
        convert_tokenizers(stage, progress)
    try:
        inspect_model(model, projector_path=projector, validate_ir=True)
    except ValueError as error:
        raise RuntimeError(f"The downloaded export failed Fern's model validation: {error}") from error
    metadata = {
        "modelId": model_id,
        "name": spec["name"],
        "repo": spec["repo"],
        "revision": spec["revision"],
        "format": spec["format"],
        "tokenizersConvertedByFern": not gguf,
        "verifiedChecksums": True,
    }
    (stage / INSTALL_MARKER).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    if repair:
        try:
            for name in sorted(model_package_files(spec) - reused):
                os.replace(stage / name, folder / name)
            os.replace(stage / INSTALL_MARKER, marker)
        except OSError as error:
            raise RuntimeError("Fern could not replace the files. Close any other app using the model and retry.") from error
        for name in reused | {f"{item['path']}.part" for item in files}:
            try:
                (stage / name).unlink(missing_ok=True)
            except OSError:
                pass
        progress("Model files repaired and verified.")
        return folder
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
    progress("Recommended text model installed and verified.")
    return folder


def install_model(model_id: str, model_root: str | Path, progress: Callable[[str], None] = print, *,
                  pause: Event | None = None, repair: bool = False) -> Path:
    check_download_pause(pause)
    spec = model_spec(model_id)
    root = Path(model_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with model_install_lock(root, spec):
        return _install_model(model_id, root, progress, pause=pause, repair=repair)


@contextmanager
def model_install_lock(root: Path, spec: dict):
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
            raise RuntimeError("Another Fern process is already changing this text model.") from error
        try:
            yield
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
        metadata = json.loads((folder / INSTALL_MARKER).read_text(encoding="utf-8"))
        if spec.get("format") == "gguf":
            return metadata.get("modelId") == model_id and metadata.get("revision") == spec["revision"] and all(
                (folder / file["path"]).stat().st_size == file["size"] for file in spec["files"]
            )
        return metadata.get("modelId") == model_id and metadata.get("revision") == spec["revision"] and all(
            (folder / name).is_file() and (folder / name).stat().st_size > 0
            for name in REQUIRED_MODEL_FILES + (
                "openvino_tokenizer.xml", "openvino_tokenizer.bin",
                "openvino_detokenizer.xml", "openvino_detokenizer.bin",
            )
        )
    except (OSError, ValueError, json.JSONDecodeError):
        return False
