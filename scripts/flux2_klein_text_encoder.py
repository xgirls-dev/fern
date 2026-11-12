"""Optional OpenVINO text encoder for FLUX.2 Klein 4B."""
from __future__ import annotations

import json
import os
import shutil
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


REPO_ID = "xgirls/Qwen3-4B-uncensored-klein-text-encoder-int4-ov"
REPO_FALLBACKS = ("PabloHoties/Qwen3-4B-uncensored-klein-text-encoder-int4-ov",)
REQUIRED_FILES = (
    "text_encoder/config.json",
    "text_encoder/openvino_model.xml",
    "text_encoder/openvino_model.bin",
)
FINAL_FOLDER = "text_encoder_uncensored"


class KleinTextEncoderManager:
    def __init__(self, root: Path, state_path: Path):
        self.root = Path(root).resolve()
        self.model_root = (self.root / "flux2-klein-4b-int4").resolve()
        self.final_dir = (self.model_root / FINAL_FOLDER).resolve()
        self.stage_dir = self.final_dir.with_name(self.final_dir.name + ".download")
        self.state_path = Path(state_path)
        self.lock = threading.RLock()
        self.cancel_event: threading.Event | None = None
        self.job: dict[str, Any] = {"state": "not-installed", "downloaded": 0, "bytes": 0, "error": None}
        self.enabled = self._read_enabled()

    def _read_enabled(self) -> bool:
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
            return value.get("useUncensoredTextEncoder") is True
        except (OSError, ValueError, AttributeError):
            return False

    def _write_enabled(self, enabled: bool) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_name(self.state_path.name + ".tmp")
        temporary.write_text(json.dumps({"useUncensoredTextEncoder": enabled}), encoding="utf-8")
        os.replace(temporary, self.state_path)
        self.enabled = enabled

    def installed(self) -> bool:
        return all((self.final_dir / Path(name).name).is_file() and (self.final_dir / Path(name).name).stat().st_size > 0 for name in REQUIRED_FILES)

    def snapshot(self, model_installed: bool) -> dict[str, Any]:
        with self.lock:
            installed = model_installed and self.installed()
            state = self.job.get("state", "not-installed")
            if state not in ("downloading", "verifying", "paused", "failed", "removing"):
                state = "installed" if installed else "not-installed" if model_installed else "unavailable"
            return {
                "repoId": REPO_ID,
                "installed": installed,
                "enabled": bool(installed and self.enabled),
                "state": state,
                "downloaded": int(self.job.get("downloaded", 0)),
                "bytes": int(self.job.get("bytes", 0)),
                "phase": self.job.get("phase"),
                "error": self.job.get("error"),
            }

    def set_enabled(self, enabled: bool, model_installed: bool) -> None:
        if not isinstance(enabled, bool):
            raise ValueError("The text encoder setting must be on or off.")
        if enabled and (not model_installed or not self.installed()):
            raise ValueError("Download the uncensored text encoder and Klein 4B before enabling it.")
        with self.lock:
            self._write_enabled(enabled)

    def start(self, model_installed: bool) -> None:
        if not model_installed:
            raise ValueError("Install FLUX.2 Klein 4B before downloading its optional text encoder.")
        with self.lock:
            if self.job.get("state") in ("downloading", "verifying", "removing"):
                raise ValueError("The optional text encoder is already being changed.")
            if self.installed():
                raise ValueError("The optional text encoder is already installed.")
            self.cancel_event = threading.Event()
            self.job = {"state": "downloading", "downloaded": 0, "bytes": 0, "phase": "Checking model download access…", "error": None}
            threading.Thread(target=self._download, args=(self.cancel_event,), daemon=True, name="fern-klein-uncensored-encoder-download").start()

    def cancel(self) -> None:
        with self.lock:
            if self.cancel_event is not None:
                self.cancel_event.set()

    def remove(self) -> None:
        with self.lock:
            if self.job.get("state") in ("downloading", "verifying", "removing"):
                raise ValueError("Cancel the text encoder download before removing it.")
            self.job = {"state": "removing", "downloaded": 0, "bytes": 0, "error": None}
            self._write_enabled(False)
            for path in (self.stage_dir, self.final_dir):
                if path.exists():
                    if path.resolve().parent != self.model_root:
                        raise ValueError("Invalid optional text encoder path.")
                    shutil.rmtree(path, onerror=self._clear_readonly_and_retry)
            self.job = {"state": "not-installed", "downloaded": 0, "bytes": 0, "error": None}

    @staticmethod
    def _clear_readonly_and_retry(function, name, _error):
        os.chmod(name, 0o666)
        function(name)

    def _download(self, cancel: threading.Event) -> None:
        stage = self.stage_dir
        try:
            if not self.model_root.is_dir():
                raise ValueError("Install FLUX.2 Klein 4B before downloading its optional text encoder.")
            stage.mkdir(parents=True, exist_ok=True)
            from huggingface_hub import HfApi, get_token

            token = get_token()
            api = HfApi(token=token)
            info = None
            access_error: Exception | None = None
            for repo_id in (REPO_ID, *REPO_FALLBACKS):
                try:
                    info = api.model_info(repo_id, files_metadata=True, token=token)
                    break
                except Exception as error:
                    access_error = error
            if info is None:
                message = str(access_error or "Repository is unavailable.")
                if any(marker in message.casefold() for marker in ("gated", "401", "403", "404", "repository not found")):
                    raise ValueError(
                        "The encoder repository is access-restricted. Its publisher must enable public downloads "
                        "for Fern to install it without requiring a Hugging Face account."
                    ) from access_error
                raise RuntimeError(message) from access_error
            resolved_repo_id = getattr(info, "id", None) or REPO_ID
            files = {item.rfilename: item for item in (info.siblings or [])}
            missing = [name for name in REQUIRED_FILES if name not in files]
            if missing:
                raise ValueError(
                    "The encoder repository does not expose its OpenVINO files for public download. "
                    "Its publisher must enable public downloads for Fern to install it without an account."
                )
            sizes = {name: int(getattr(files[name], "size", 0) or 0) for name in REQUIRED_FILES}
            if any(size <= 0 for size in sizes.values()):
                raise ValueError("Hugging Face did not provide file sizes for the text encoder.")
            total = sum(sizes.values())
            if shutil.disk_usage(self.model_root).free < total + 1024**3:
                raise ValueError("Not enough free disk space; leave at least 1 GB free after the text encoder download.")
            with self.lock:
                self.job.update(bytes=total, downloaded=0, phase="Downloading OpenVINO text encoder…")

            done = 0
            for remote_name in REQUIRED_FILES:
                if cancel.is_set():
                    raise InterruptedError()
                destination = (stage / Path(remote_name).name).resolve()
                if destination.parent != stage.resolve():
                    raise ValueError("Invalid text encoder asset path.")
                expected = sizes[remote_name]
                offset = destination.stat().st_size if destination.exists() else 0
                if offset > expected:
                    destination.unlink()
                    offset = 0
                if offset < expected:
                    encoded_name = urllib.parse.quote(remote_name, safe="/")
                    url = f"https://huggingface.co/{resolved_repo_id}/resolve/{info.sha}/{encoded_name}"
                    headers = {"Range": f"bytes={offset}-"} if offset else {}
                    if token:
                        headers["Authorization"] = f"Bearer {token}"
                    request = urllib.request.Request(url, headers=headers)
                    with urllib.request.urlopen(request, timeout=30) as response:
                        if offset and response.status != 206:
                            offset = 0
                        with destination.open("ab" if offset else "wb") as output:
                            while True:
                                if cancel.is_set():
                                    raise InterruptedError()
                                chunk = response.read(1024 * 1024)
                                if not chunk:
                                    break
                                output.write(chunk)
                                offset += len(chunk)
                                with self.lock:
                                    self.job["downloaded"] = done + offset
                                    self.job["phase"] = f"Downloading {Path(remote_name).name}…"
                if cancel.is_set():
                    raise InterruptedError()
                if destination.stat().st_size != expected:
                    destination.unlink(missing_ok=True)
                    raise ValueError(f"Download size check failed for {Path(remote_name).name}.")
                done += expected
                with self.lock:
                    self.job.update(downloaded=done, phase="Verifying text encoder files…", state="verifying")
            if cancel.is_set():
                raise InterruptedError()
            (stage / ".fern-text-encoder.json").write_text(
                json.dumps({"repoId": resolved_repo_id, "revision": info.sha, "files": list(REQUIRED_FILES)}),
                encoding="utf-8",
            )
            if self.final_dir.exists():
                raise ValueError("An incomplete optional text encoder folder already exists; remove it and retry.")
            stage.rename(self.final_dir)
            with self.lock:
                self.job = {"state": "installed", "downloaded": total, "bytes": total, "error": None}
        except InterruptedError:
            with self.lock:
                self.job.update(state="paused", phase="Download paused.", error=None)
        except Exception as error:
            message = str(error)
            if isinstance(error, (urllib.error.HTTPError, urllib.error.URLError)):
                message = (
                    "The encoder repository is access-restricted. Its publisher must enable public downloads "
                    "for Fern to install it without requiring a Hugging Face account."
                )
            with self.lock:
                self.job.update(state="failed", phase=None, error=message)

