"""Managed Hugging Face downloads for user-added OpenVINO image exports."""
from __future__ import annotations

import re
import shutil
import threading
from urllib.parse import urlsplit
from pathlib import Path
from typing import Any
import os

from huggingface_hub import snapshot_download
from huggingface_hub.utils import tqdm as HubTqdm

import custom_image_registry


class _DownloadCancelled(Exception):
    pass


class CustomImageDownloadManager:
    def __init__(self, models_root: str | Path):
        self.project_root = Path(models_root).resolve().parent
        self.root = Path(models_root).resolve() / "custom-image-models"
        self._lock = threading.RLock()
        self._cancel: threading.Event | None = None
        self._state: dict[str, Any] = {"status": "idle"}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def start(self, repo_id: str, family: str) -> dict[str, Any]:
        repo_id = repo_id.strip() if isinstance(repo_id, str) else ""
        if repo_id.startswith(("https://", "http://")):
            parsed = urlsplit(repo_id)
            parts = parsed.path.strip("/").split("/")
            if parsed.hostname not in ("huggingface.co", "www.huggingface.co") or len(parts) != 2:
                raise ValueError("Paste a Hugging Face model URL or enter owner/model.")
            repo_id = "/".join(parts)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*", repo_id):
            raise ValueError("Enter a Hugging Face repository as owner/model.")
        if family not in custom_image_registry.FAMILIES:
            raise ValueError("Choose a supported OpenVINO image model family.")
        with self._lock:
            if self._state.get("status") in ("checking", "downloading", "validating"):
                raise ValueError("A custom model download is already in progress.")
            existing = next((item for item in custom_image_registry.MODEL_REGISTRY.snapshot() if item.get("repoId", "").casefold() == repo_id.casefold()), None)
            if existing:
                raise ValueError(f"{repo_id} is already in the model library.")
            self.root.mkdir(parents=True, exist_ok=True)
            import hashlib
            slug = hashlib.sha256(repo_id.casefold().encode("utf-8")).hexdigest()[:20]
            target = self._safe_child(slug)
            if target.exists():
                raise ValueError("A previous download left files in Fern's model storage. Remove that folder before retrying.")
            cancel = threading.Event()
            self._cancel = cancel
            self._state = {
                "id": "custom-image-download", "repoId": repo_id,
                "label": repo_id.rsplit("/", 1)[-1], "family": family,
                "status": "checking", "phase": "Checking repository files…",
                "downloaded": 0, "bytes": 0, "error": None,
            }
            self._thread = threading.Thread(target=self._run, args=(repo_id, family, slug, cancel), daemon=True, name="fern-custom-image-download")
            self._thread.start()
            return dict(self._state)

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            if self._cancel is None or self._state.get("status") not in ("checking", "downloading", "validating"):
                raise ValueError("There is no custom model download to cancel.")
            self._state["phase"] = "Cancelling download…"
            self._cancel.set()
            return dict(self._state)

    def _safe_child(self, name: str) -> Path:
        candidate = (self.root / name).resolve()
        if candidate.parent != self.root:
            raise ValueError("The custom model download path is outside Fern model storage.")
        return candidate

    def _run(self, repo_id: str, family: str, slug: str, cancel: threading.Event) -> None:
        stage = self._safe_child(slug + ".partial")
        target = self._safe_child(slug)
        promoted = False
        try:
            if cancel.is_set():
                raise _DownloadCancelled()
            token = self._hub_token()
            # Resolve the repo's file sizes first so the library can show useful progress.
            files = snapshot_download(repo_id=repo_id, dry_run=True, token=token)
            total = sum(max(0, int(getattr(item, "file_size", 0) or 0)) for item in files or [])
            if cancel.is_set():
                raise _DownloadCancelled()
            with self._lock:
                self._state.update(status="downloading", phase="Downloading from Hugging Face…", bytes=total)

            manager = self

            class ProgressTqdm(HubTqdm):
                def __init__(self, *args, **kwargs):
                    self._counts_download_bytes = str(kwargs.get("desc", "")).startswith("Reconstructing")
                    super().__init__(*args, **kwargs)

                def update(self, n=1):
                    if cancel.is_set():
                        raise _DownloadCancelled()
                    result = super().update(n)
                    if self._counts_download_bytes:
                        with manager._lock:
                            if manager._cancel is cancel:
                                manager._state["downloaded"] = min(total, int(manager._state.get("downloaded", 0)) + int(n or 0)) if total else int(manager._state.get("downloaded", 0)) + int(n or 0)
                    return result

            stage.mkdir(parents=True, exist_ok=True)
            snapshot_download(repo_id=repo_id, local_dir=stage, token=token, tqdm_class=ProgressTqdm)
            if cancel.is_set():
                raise _DownloadCancelled()
            with self._lock:
                self._state.update(status="validating", phase="Validating OpenVINO export…")
            custom_image_registry.inspect_model(stage, family)
            if cancel.is_set():
                raise _DownloadCancelled()
            # staging and destination share a parent so this promotes atomically.
            stage.replace(target)
            promoted = True
            custom_image_registry.MODEL_REGISTRY.add(
                str(target), family, source_type="huggingface", repo_id=repo_id,
                label=repo_id.rsplit("/", 1)[-1],
            )
            with self._lock:
                self._state.update(status="complete", phase="Model added to Fern.", downloaded=total, bytes=total, error=None)
        except _DownloadCancelled:
            self._remove_stage(stage)
            if promoted:
                self._remove_stage(target)
            with self._lock:
                self._state.update(status="cancelled", phase="Download cancelled.", error=None)
        except Exception as error:
            self._remove_stage(stage)
            if promoted:
                self._remove_stage(target)
            with self._lock:
                self._state.update(status="failed", phase="Download or validation failed.", error=str(error))
        finally:
            with self._lock:
                if self._cancel is cancel:
                    self._cancel = None

    def _hub_token(self) -> str | None:
        token = os.environ.get("HF_TOKEN")
        if token:
            return token
        env_file = self.project_root / ".env"
        if not env_file.is_file():
            return None
        try:
            from decouple import Config, RepositoryEnv

            settings = Config(RepositoryEnv(str(env_file)))
            return settings("HF_TOKEN", default=None) or settings("hf_token", default=None)
        except Exception:
            # A malformed optional .env should not prevent public model downloads.
            return None

    def _remove_stage(self, stage: Path) -> None:
        try:
            resolved = stage.resolve()
            if resolved.parent == self.root and resolved.exists():
                shutil.rmtree(resolved)
        except OSError:
            pass
