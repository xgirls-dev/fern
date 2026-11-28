"""Track local video jobs and publish clips only after a successful render."""

import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from model_catalog import INTEL_MEDIA_CATALOG


VIDEO_JOB_ID = re.compile(r"[0-9]{13}-[a-f0-9]{8}")
MAX_ACTIVITY_LINES = 120


class VideoJobs:
    def __init__(self, runtime, cache: Path, data: Path, outputs: Path):
        self.runtime = runtime
        self.cache = cache
        self.metadata = data / "videos"
        self.posters = data / "references"
        self.outputs = outputs
        self.lock = threading.Lock()
        self.job = {"id": None, "status": "idle", "phase": None, "logs": [], "output": None, "error": None}
        self.cancel = None
        self.worker = None
        self._recover_publications()

    def snapshot(self):
        with self.lock:
            return dict(self.job)

    def running(self):
        return self.snapshot()["status"] in ("running", "stopping")

    def clear(self):
        with self.lock:
            self.job.update(id=None, status="idle", phase=None, logs=[], output=None, error=None)

    def _record_activity(self, message):
        logs = self.job["logs"]
        if not logs or logs[-1] != message:
            # Replace the list so already returned snapshots don't change.
            self.job["logs"] = [*logs[-(MAX_ACTIVITY_LINES - 1):], message]

    def history(self):
        records = []
        for path in sorted(self.metadata.glob("*.json"), reverse=True):
            identifier = path.stem
            if not VIDEO_JOB_ID.fullmatch(identifier):
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
            self.job.update(id=identifier, status="running", phase="Preparing video…", logs=["Preparing video…"], output=None, error=None)
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
            self._record_activity("Stopping…")
            return dict(self.job)

    def close(self):
        with self.lock:
            if self.cancel:
                self.cancel.set()
            worker = self.worker
        if worker:
            worker.join(timeout=5)

    def remove(self, identifier):
        if not isinstance(identifier, str) or not VIDEO_JOB_ID.fullmatch(identifier):
            raise ValueError("Choose a saved Fern video.")
        with self.lock:
            if self.job["id"] == identifier and self.job["status"] in ("running", "stopping"):
                raise ValueError("Stop this video generation before deleting it.")
            stage = self.cache / f"video-{identifier}"
            pending = stage / "publish.json"
            if not stage.is_symlink() and pending.is_file():
                pending.unlink(missing_ok=True)
                shutil.rmtree(stage, ignore_errors=True)
            (self.outputs / f"wan-{identifier}.webm").unlink(missing_ok=True)
            (self.metadata / f"{identifier}.json").unlink(missing_ok=True)
            (self.posters / f"wan-{identifier}.jpg").unlink(missing_ok=True)
            if self.job["id"] == identifier:
                self.job.update(id=None, status="idle", phase=None, logs=[], output=None, error=None)

    def _recover_publications(self):
        for stage in self.cache.glob("video-*"):
            identifier = stage.name.removeprefix("video-")
            if not VIDEO_JOB_ID.fullmatch(identifier) or stage.is_symlink():
                continue
            pending = stage / "publish.json"
            if pending.is_symlink() or not pending.is_file():
                continue
            try:
                record = json.loads(pending.read_text(encoding="utf-8"))
                if not isinstance(record, dict) or (
                    record.get("id"), record.get("name"), record.get("url"), record.get("posterUrl")
                ) != (
                    identifier, f"wan-{identifier}.webm", f"/outputs/wan-{identifier}.webm",
                    f"/references/wan-{identifier}.jpg",
                ):
                    continue
                self._publish(stage, identifier)
            except (OSError, ValueError):
                # Preserve anything already rendered so a later restart can retry.
                continue
            shutil.rmtree(stage, ignore_errors=True)

    def _publish(self, stage, identifier):
        for source, destination in (
            (stage / "video.webm", self.outputs / f"wan-{identifier}.webm"),
            (stage / "poster.jpg", self.posters / f"wan-{identifier}.jpg"),
        ):
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_file() and not source.is_symlink():
                source.replace(destination)
            elif not destination.is_file() or destination.is_symlink():
                raise FileNotFoundError(f"Missing staged video file: {source.name}")
        self.metadata.mkdir(parents=True, exist_ok=True)
        (stage / "publish.json").replace(self.metadata / f"{identifier}.json")

    def run(self, identifier, request, event, release_models):
        from intel_media import VIDEO_ID, check_cancel

        stage = self.cache / f"video-{identifier}"
        filename = f"wan-{identifier}.webm"
        poster_name = f"wan-{identifier}.jpg"
        made_stage = False
        publishing = False

        def log(message):
            with self.lock:
                if not event.is_set():
                    self.job["phase"] = message
                    self._record_activity(message)

        try:
            release_models()
            check_cancel(event)
            stage.mkdir(parents=True, exist_ok=False)
            made_stage = True
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
            staged_clip = stage / "video.webm"
            if source != staged_clip:
                source.replace(staged_clip)
            request["reference"].save(stage / "poster.jpg", format="JPEG", quality=85)
            (stage / "video.json").write_text(json.dumps(record), encoding="utf-8")
            with self.lock:
                check_cancel(event)
                # Commit intent only after the job can no longer be cancelled.
                (stage / "video.json").replace(stage / "publish.json")
                publishing = True
                self._publish(stage, identifier)
                publishing = False
                self._record_activity("Video saved.")
                self.job.update(status="complete", phase=None, error=None, output=record)
        except Exception as error:
            with self.lock:
                cancelled = event.is_set() and not publishing
                self._record_activity("Generation stopped." if cancelled else "Video generation failed.")
                self.job.update(
                    status="cancelled" if cancelled else "failed", phase=None, output=None,
                    error=None if cancelled else str(error),
                )
        finally:
            if made_stage and not publishing:
                shutil.rmtree(stage, ignore_errors=True)
            with self.lock:
                if self.cancel is event:
                    self.cancel = None
                    self.worker = None
