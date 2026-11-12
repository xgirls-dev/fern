"""Download a public LoRA into Fern's managed local storage."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class LoraDownloadManager:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.lock = threading.RLock()
        self.cancel_event: threading.Event | None = None
        self.state: dict[str, Any] = {"status": "idle"}

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.state)

    def start(self, url: str) -> None:
        if not isinstance(url, str) or len(url) > 4096:
            raise ValueError("Paste a Hugging Face file link or Civitai model link.")
        url = url.strip()
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in ("huggingface.co", "www.huggingface.co", "civitai.com", "www.civitai.com") or parsed.username or parsed.password:
            raise ValueError("Use an HTTPS link from Hugging Face or Civitai.")
        with self.lock:
            if self.cancel_event is not None:
                raise ValueError("A LoRA download is already in progress.")
            self.cancel_event = threading.Event()
            self.state = {"status": "checking", "downloaded": 0, "bytes": 0, "error": None}
            threading.Thread(target=self._run, args=(url, self.cancel_event), daemon=True, name="fern-lora-download").start()

    def cancel(self) -> None:
        with self.lock:
            if self.cancel_event:
                self.cancel_event.set()

    def _resolve(self, url: str) -> tuple[str, str]:
        parsed = urllib.parse.urlsplit(url)
        if parsed.hostname in ("huggingface.co", "www.huggingface.co"):
            path = parsed.path.replace("/blob/", "/resolve/", 1)
            repo = re.fullmatch(r"/([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/?", path)
            if repo:
                request = urllib.request.Request(f"https://huggingface.co/api/models/{repo.group(1)}/{repo.group(2)}", headers={"User-Agent": "Fern/1.0"})
                with urllib.request.urlopen(request, timeout=30) as response:
                    info = json.loads(response.read(2_000_000))
                files = [item.get("rfilename", "") for item in info.get("siblings", []) if str(item.get("rfilename", "")).lower().endswith(".safetensors")]
                if len(files) != 1:
                    raise ValueError("This repository has multiple or no safetensors files. Paste a link to the specific LoRA file.")
                filename = files[0]
                revision = info.get("sha") if re.fullmatch(r"[0-9a-f]{40}", str(info.get("sha", ""))) else "main"
                return f"https://huggingface.co/{repo.group(1)}/{repo.group(2)}/resolve/{revision}/{urllib.parse.quote(filename, safe='/')}", filename.rsplit("/", 1)[-1]
            name = urllib.parse.unquote(path.rsplit("/", 1)[-1])
            if "/resolve/" not in path or not name.lower().endswith(".safetensors"):
                raise ValueError("Paste a Hugging Face repository or .safetensors file link.")
            return urllib.parse.urlunsplit(("https", "huggingface.co", path, parsed.query, "")), name
        match = re.match(r"^/models/(\d+)(?:/|$)", parsed.path)
        if match:
            version = urllib.parse.parse_qs(parsed.query).get("modelVersionId", [""])[0]
            endpoint = f"https://civitai.com/api/v1/model-versions/{version}" if version.isdigit() else f"https://civitai.com/api/v1/models/{match.group(1)}"
            request = urllib.request.Request(endpoint, headers={"User-Agent": "Fern/1.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read(2_000_000))
            if not version.isdigit():
                versions = data.get("modelVersions") or []
                if not versions:
                    raise ValueError("This Civitai model has no downloadable versions.")
                data = versions[0]
            files = [item for item in data.get("files", []) if str(item.get("name", "")).lower().endswith(".safetensors")]
            if not files:
                raise ValueError("This Civitai version has no .safetensors file.")
            chosen = next((item for item in files if item.get("primary")), files[0])
            download_url = str(chosen.get("downloadUrl") or f"https://civitai.com/api/download/models/{data['id']}")
            target = urllib.parse.urlsplit(download_url)
            if target.scheme != "https" or target.hostname not in ("civitai.com", "www.civitai.com"):
                raise ValueError("Civitai returned an unsupported download link.")
            return download_url, str(chosen["name"])
        if re.match(r"^/api/download/models/\d+", parsed.path):
            return url, f"civitai-{parsed.path.rsplit('/', 1)[-1]}.safetensors"
        raise ValueError("Paste a Civitai model page or download link.")

    def _run(self, url: str, cancel: threading.Event) -> None:
        stage: Path | None = None
        try:
            download_url, name = self._resolve(url)
            if urllib.parse.urlsplit(download_url).scheme != "https":
                raise ValueError("The LoRA download must use HTTPS.")
            name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(name).name)
            if not name.lower().endswith(".safetensors"):
                raise ValueError("The download must be a .safetensors file.")
            name = name[:-12][:120] + ".safetensors"
            self.root.mkdir(parents=True, exist_ok=True)
            target = self.root / (hashlib.sha256(url.encode()).hexdigest()[:12] + "-" + name)
            stage = target.with_suffix(target.suffix + ".partial")
            if target.is_file():
                with self.lock: self.state = {"status": "complete", "path": str(target), "name": name, "downloaded": target.stat().st_size, "bytes": target.stat().st_size}
                return
            request = urllib.request.Request(download_url, headers={"User-Agent": "Fern/1.0"})
            with urllib.request.urlopen(request, timeout=30) as response, stage.open("wb") as output:
                total = int(response.headers.get("Content-Length") or 0)
                if total and shutil.disk_usage(self.root).free < total + 1024**3:
                    raise ValueError("Not enough disk space; leave at least 1 GB free after the download.")
                with self.lock: self.state.update(status="downloading", bytes=total, name=name)
                next_space_check = 0
                while True:
                    if cancel.is_set(): raise InterruptedError()
                    chunk = response.read(1024 * 1024)
                    if not chunk: break
                    output.write(chunk)
                    with self.lock: self.state["downloaded"] += len(chunk)
                    if output.tell() >= next_space_check:
                        if shutil.disk_usage(self.root).free < 1024**3:
                            raise ValueError("Download stopped to keep at least 1 GB of disk space free.")
                        next_space_check = output.tell() + 64 * 1024**2
            if cancel.is_set(): raise InterruptedError()
            if total and stage.stat().st_size != total: raise ValueError("The LoRA download was incomplete. Try again.")
            with stage.open("rb") as downloaded:
                size_bytes = downloaded.read(8)
                header_size = int.from_bytes(size_bytes, "little")
                if len(size_bytes) != 8 or not 2 <= header_size <= min(stage.stat().st_size - 8, 100_000_000):
                    raise ValueError("The downloaded file is not a valid safetensors file.")
                header = json.loads(downloaded.read(header_size))
                if not isinstance(header, dict) or not any(key != "__metadata__" for key in header):
                    raise ValueError("The downloaded file contains no tensors.")
                if not any("lora" in key.lower() for key in header if key != "__metadata__"):
                    raise ValueError("This safetensors file does not appear to contain a LoRA.")
            os.replace(stage, target)
            with self.lock: self.state.update(status="complete", path=str(target), name=name)
        except InterruptedError:
            with self.lock: self.state.update(status="cancelled", error=None)
        except Exception as error:
            with self.lock: self.state.update(status="failed", error=str(error))
        finally:
            if stage: stage.unlink(missing_ok=True)
            with self.lock:
                if self.cancel_event is cancel: self.cancel_event = None
