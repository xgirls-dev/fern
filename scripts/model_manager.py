"""Cancellable, resumable model installer. Only catalog-owned paths are managed."""

import hashlib
import json
import os
import shutil
import threading
import urllib.request
from pathlib import Path
from model_catalog import CATALOG, installed, model_spec


class ModelManager:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.lock = threading.RLock()
        self.jobs = {}
        self.events = {}

    def folder(self, model, staging=False):
        path = (
            self.root / (model_spec(model)["folder"] + (".download" if staging else ""))
        ).resolve()
        if path.parent != self.root:
            raise ValueError("Invalid model folder")
        return path

    def snapshot(self):
        with self.lock:
            return [
                {
                    **{k: v for k, v in spec.items() if k != "files"},
                    "bytes": sum(f["size"] for f in spec["files"]),
                    "installed": installed(self.root, key),
                    **self.jobs.get(
                        key,
                        {
                            "state": (
                                "installed"
                                if installed(self.root, key)
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
                }
                for key, spec in CATALOG.items()
            ]

    def start(self, model):
        model_spec(model)
        with self.lock:
            if any(
                j["state"] in ("downloading", "verifying", "removing")
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
                j["state"] in ("downloading", "verifying", "removing")
                for j in self.jobs.values()
            ):
                raise ValueError("Pause downloads before removing a model.")
            self.jobs[model] = {"state": "removing", "downloaded": 0}
            try:
                for staging in (False, True):
                    path = self.folder(model, staging)
                    if path.exists():
                        shutil.rmtree(path)
                cache_root = (self.root.parent / ".cache" / "openvino").resolve()
                cache = (cache_root / f"flux2-klein-{model}").resolve()
                if cache.parent != cache_root:
                    raise ValueError("Invalid model cache folder")
                if cache.exists():
                    shutil.rmtree(cache)
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
            remaining = sum(
                (
                    max(0, f["size"] - (stage / f["path"]).stat().st_size)
                    if (stage / f["path"]).exists()
                    else f["size"]
                )
                for f in spec["files"]
            )
            if shutil.disk_usage(stage).free < remaining + 2 * 1024**3:
                raise ValueError(
                    "Not enough free disk space; leave at least 2 GB after installation."
                )
            done = 0
            for item in spec["files"]:
                if event.is_set():
                    raise InterruptedError()
                target = (stage / item["path"]).resolve()
                if not target.is_relative_to(stage.resolve()):
                    raise ValueError("Invalid model asset path")
                target.parent.mkdir(parents=True, exist_ok=True)
                offset = target.stat().st_size if target.exists() else 0
                if offset > item["size"]:
                    target.unlink()
                    offset = 0
                if offset < item["size"]:
                    url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{item['path']}"
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
                        "Download verification failed. Resume to retry the damaged file."
                    )
                done += item["size"]
                self._update(model, state="downloading", downloaded=done)
            if event.is_set():
                raise InterruptedError()
            (stage / ".fern-model.json").write_text(
                json.dumps({"model": model, "revision": spec["revision"]})
            )
            stage.rename(self.folder(model))
            self._update(model, state="installed")
        except InterruptedError:
            self._update(model, state="paused")
        except Exception as error:
            self._update(model, state="failed", error=str(error))
