"""Cancellable, resumable model installer. Only catalog-owned paths are managed."""

import hashlib
import json
import math
import os
import shutil
import stat
import threading
import urllib.request
from pathlib import Path
from model_catalog import MODEL_CATALOG, installed, model_spec


DOWNLOAD_RESERVE_BYTES = 2 * 1024**3


def remove_tree(path):
    """Remove a model-owned tree, including read-only OpenVINO/HF cache files."""
    target = Path(path)
    if not target.exists():
        return

    def retry_after_clearing_readonly(function, name, _error):
        os.chmod(name, stat.S_IWRITE)
        function(name)

    shutil.rmtree(target, onerror=retry_after_clearing_readonly)


class ModelManager:
    def __init__(self, root, prepare=None, preflight=None):
        self.root = Path(root).resolve()
        self.lock = threading.RLock()
        self.prepare = prepare
        self.preflight = preflight
        self.jobs = {}
        self.events = {}

    def folder(self, model, staging=False):
        path = (
            self.root / model_spec(model)["folder"]
        ).resolve()
        if staging:
            path = path.with_name(path.name + ".download")
        if path == self.root or not path.is_relative_to(self.root):
            raise ValueError("Invalid model folder")
        return path

    def snapshot(self):
        with self.lock:
            result = []
            for key, spec in MODEL_CATALOG.items():
                is_installed = installed(self.root, key)
                download_bytes = sum(f["size"] for f in spec["files"])
                result.append({
                    **{k: v for k, v in spec.items() if k != "files"},
                    "bytes": download_bytes,
                    "minimumFreeBytes": download_bytes + DOWNLOAD_RESERVE_BYTES,
                    "installed": is_installed,
                    **self.jobs.get(
                        key,
                        {
                            "state": (
                                "installed"
                                if is_installed
                                else (
                                    "repair-needed"
                                    if self.folder(key).exists()
                                    else (
                                        "paused"
                                        if self.folder(key, True).exists()
                                        else "not-installed"
                                    )
                                )
                            ),
                            "downloaded": 0,
                        },
                    ),
                })
            return result

    def start(self, model):
        model_spec(model)
        with self.lock:
            if any(
                j["state"] in ("downloading", "verifying", "preparing", "removing")
                for j in self.jobs.values()
            ):
                raise ValueError("Wait for the current model operation to finish.")
            if installed(self.root, model):
                raise ValueError("This model is already installed.")
            if self.folder(model).exists():
                raise ValueError("Remove the incomplete installation before retrying.")
            event = threading.Event()
            self.events[model] = event
            self.jobs[model] = {"state": "downloading", "downloaded": 0, "error": None}
            threading.Thread(
                target=self._download, args=(model, event), daemon=True
            ).start()

    def cancel(self, model):
        model_spec(model)
        with self.lock:
            if model in self.events:
                self.events[model].set()

    def remove(self, model):
        model_spec(model)
        with self.lock:
            if any(
                j["state"] in ("downloading", "verifying", "preparing", "removing")
                for j in self.jobs.values()
            ):
                raise ValueError("Pause downloads before removing a model.")
            self.jobs[model] = {"state": "removing", "downloaded": 0}
            try:
                for staging in (False, True):
                    path = self.folder(model, staging)
                    if path.exists():
                        remove_tree(path)
                if model in ("9b", "4b", "tame-pony-v25-sdxl", "tame-pony-v25-sdxl-int8"):
                    cache_root = (self.root.parent / ".cache" / "openvino").resolve()
                    cache_name = (
                        f"flux2-klein-{model}"
                        if model in ("9b", "4b")
                        else model
                    )
                    cache = (cache_root / cache_name).resolve()
                    if cache.parent != cache_root:
                        raise ValueError("Invalid model cache folder")
                    if cache.exists():
                        remove_tree(cache)
                self.jobs.pop(model, None)
            except Exception as error:
                self.jobs[model] = {
                    "state": "failed",
                    "downloaded": 0,
                    "error": str(error),
                }
                raise

    def _update(self, model, **values):
        with self.lock:
            self.jobs[model].update(values)

    def _download(self, model, event):
        spec = model_spec(model)
        stage = self.folder(model, True)
        try:
            stage.mkdir(parents=True, exist_ok=True)
            staged_files = []
            remaining = 0
            for item in spec["files"]:
                target = (stage / item["path"]).resolve()
                if not target.is_relative_to(stage.resolve()):
                    raise ValueError("Invalid model asset path")
                offset = target.stat().st_size if target.exists() else 0
                if offset > item["size"]:
                    target.unlink()
                    offset = 0
                remaining += item["size"] - offset
                staged_files.append((item, target, offset))
            required = remaining + DOWNLOAD_RESERVE_BYTES
            if shutil.disk_usage(stage).free < required:
                gigabytes = math.ceil(required / 10_000_000) / 100
                raise ValueError(f"Free at least {gigabytes:.2f} GB to download the remaining model files.")
            def set_phase(phase):
                self._update(model, state="preparing", phase=phase)

            if self.preflight:
                self.preflight(model, stage, event, set_phase)
                self._update(model, state="downloading", phase=None)
            done = 0
            for item, target, offset in staged_files:
                if event.is_set():
                    raise InterruptedError()
                target.parent.mkdir(parents=True, exist_ok=True)
                if offset < item["size"]:
                    url = item.get("url") or f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{item['path']}"
                    req = urllib.request.Request(
                        url, headers={"Range": f"bytes={offset}-"} if offset else {}
                    )
                    with urllib.request.urlopen(req, timeout=20) as response:
                        if response.status != 206:
                            offset = 0
                        with target.open("ab" if offset else "wb") as output:
                            while True:
                                if event.is_set():
                                    raise InterruptedError()
                                chunk = response.read(1024 * 1024)
                                if not chunk:
                                    break
                                output.write(chunk)
                                offset += len(chunk)
                                self._update(model, downloaded=done + offset)
                self._update(model, state="verifying")
                digest = (
                    hashlib.sha256()
                    if item["sha256"]
                    else hashlib.sha1(f"blob {item['size']}\0".encode())
                )
                with target.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        if event.is_set():
                            raise InterruptedError()
                        digest.update(chunk)
                if target.stat().st_size != item["size"] or digest.hexdigest() != (
                    item["sha256"] or item["blob"]
                ):
                    target.unlink()
                    raise ValueError(
                        f"Download verification failed for {item['path']}. "
                        "Resume to retry the damaged file."
                    )
                done += item["size"]
                self._update(model, state="downloading", downloaded=done)
            if event.is_set():
                raise InterruptedError()
            if self.prepare:
                self.prepare(model, stage, event, set_phase)
            if event.is_set():
                raise InterruptedError()
            (stage / ".fern-model.json").write_text(
                json.dumps({"model": model, "revision": spec["revision"]})
            )
            destination = self.folder(model)
            stage.rename(destination)
            if spec.get("temporarySources"):
                # Downloaded inputs for a locally converted model can be removed
                # only after the prepared installation is ready to use.
                shutil.rmtree(destination / "source", ignore_errors=True)
            self._update(model, state="installed", phase=None)
        except InterruptedError:
            self._update(model, state="paused", phase=None)
        except Exception as error:
            self._update(model, state="failed", phase=None, error=str(error))
