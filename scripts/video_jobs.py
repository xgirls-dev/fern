"""Track local video jobs and publish clips only after a successful render."""

import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from model_catalog import INTEL_MEDIA_CATALOG


class VideoJobs:
    def __init__(self, runtime, cache: Path, data: Path, outputs: Path):
        self.runtime = runtime
        self.cache = cache
        self.metadata = data / "videos"
        self.posters = data / "references"
        self.outputs = outputs
        self.lock = threading.Lock()
        self.job = {"id": None, "status": "idle", "phase": None, "output": None, "error": None}
        self.cancel = None
        self.worker = None

    def snapshot(self):
        with self.lock:
            return dict(self.job)

    def running(self):
        return self.snapshot()["status"] in ("running", "stopping")

    def clear(self):
        with self.lock:
            self.job.update(id=None, status="idle", phase=None, output=None, error=None)

    def history(self):
        records = []
        for path in sorted(self.metadata.glob("*.json"), reverse=True):
            identifier = path.stem
            if not re.fullmatch(r"[0-9]{13}-[a-f0-9]{8}", identifier):
                continue
            if not (self.outputs / f"wan-{identifier}.webm").is_file():
                continue
            try:
                records.append(json.loads(path.read_text(encoding="utf-8")))
            except (ValueError, OSError):
                continue
        return records

    def start(self, request, release_models):
        from intel_media import VIDEO_ID

        spec = INTEL_MEDIA_CATALOG[VIDEO_ID]
        frames = request.get("frames", spec["frames"])
        if type(frames) is not int or frames not in spec["frameOptions"]:
            raise ValueError("Choose one of the available video durations.")
        request = {**request, "frames": frames}
        with self.lock:
            if self.job["status"] in ("running", "stopping"):
                raise ValueError("A video job is already running.")
            identifier = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
            event = threading.Event()
            self.cancel = event
            self.job.update(id=identifier, status="running", phase="Preparing video…", output=None, error=None)
            self.worker = threading.Thread(
                target=self.run, args=(identifier, request, event, release_models), daemon=True,
            )
            self.worker.start()
            return dict(self.job)

    def stop(self):
        with self.lock:
            if self.job["status"] not in ("running", "stopping") or self.cancel is None:
                return dict(self.job)
            self.cancel.set()
            self.job.update(status="stopping", phase="Stopping…")
            return dict(self.job)

    def close(self):
        with self.lock:
            if self.cancel:
                self.cancel.set()
            worker = self.worker
        if worker:
            worker.join(timeout=5)

    def remove(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[0-9]{13}-[a-f0-9]{8}", identifier):
            raise ValueError("Choose a saved Fern video.")
        with self.lock:
            if self.job["id"] == identifier and self.job["status"] in ("running", "stopping"):
                raise ValueError("Stop this video generation before deleting it.")
            (self.outputs / f"wan-{identifier}.webm").unlink(missing_ok=True)
            (self.metadata / f"{identifier}.json").unlink(missing_ok=True)
            (self.posters / f"wan-{identifier}.jpg").unlink(missing_ok=True)
            if self.job["id"] == identifier:
                self.job.update(id=None, status="idle", phase=None, output=None, error=None)

    def run(self, identifier, request, event, release_models):
        from intel_media import VIDEO_ID, check_cancel

        stage = self.cache / f"video-{identifier}"
        filename = f"wan-{identifier}.webm"
        poster_name = f"wan-{identifier}.jpg"
        clip = self.outputs / filename
        poster = self.posters / poster_name
        metadata = self.metadata / f"{identifier}.json"

        def log(message):
            with self.lock:
                if not event.is_set():
                    self.job["phase"] = message

        try:
            release_models()
            check_cancel(event)
            stage.mkdir(parents=True, exist_ok=False)
            source, elapsed = self.runtime.generate_video(request, stage, event, log)
            spec = INTEL_MEDIA_CATALOG[VIDEO_ID]
            record = {
                "id": identifier, "name": filename, "url": "/outputs/" + filename,
                "posterUrl": "/references/" + poster_name,
                "prompt": request["prompt"], "seed": request["seed"],
                "width": spec["defaultWidth"], "height": spec["defaultHeight"],
                "fps": spec["fps"], "frames": request["frames"], "duration": request["frames"] / spec["fps"],
                "model": VIDEO_ID, "modelLabel": spec["label"], "modelRevision": spec["revision"],
                "device": "INTEL_GPU", "generationTime": round(elapsed, 2), "createdAt": time.time(),
            }
            request["reference"].save(stage / "poster.jpg", format="JPEG", quality=85)
            (stage / "video.json").write_text(json.dumps(record), encoding="utf-8")
            with self.lock:
                check_cancel(event)
                self.metadata.mkdir(parents=True, exist_ok=True)
                self.posters.mkdir(parents=True, exist_ok=True)
                self.outputs.mkdir(parents=True, exist_ok=True)
                source.replace(clip)
                (stage / "poster.jpg").replace(poster)
                (stage / "video.json").replace(metadata)
                self.job.update(status="complete", phase=None, error=None, output=record)
        except Exception as error:
            for path in (clip, poster, metadata):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            with self.lock:
                cancelled = event.is_set()
                self.job.update(
                    status="cancelled" if cancelled else "failed", phase=None, output=None,
                    error=None if cancelled else str(error),
                )
        finally:
            shutil.rmtree(stage, ignore_errors=True)
            with self.lock:
                if self.cancel is event:
                    self.cancel = None
                    self.worker = None
