from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import os
import shutil
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image


def _resolve_root() -> Path:
    env_root = (
        os.environ.get("FERN_ROOT", "").strip()
        or os.environ.get("INTEL_IRIS_ROOT", "").strip()
    )
    if env_root:
        return Path(env_root).resolve()
    return Path(__file__).resolve().parents[1]


ROOT = _resolve_root()
SCRIPTS = Path(__file__).resolve().parent
PROJECT_SCRIPTS = ROOT / "scripts"

for path in (PROJECT_SCRIPTS, SCRIPTS):
    if path.exists():
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)

import flux2_klein_pipeline as flux2
from generation_worker import GenerationWorker, GenerationCancelled

GENERATION_WORKER = GenerationWorker()
from model_manager import ModelManager
from model_catalog import model_spec
import gallery_store
import storage_manager
from device_adapters import device_label, normalize_device


OUTPUTS = ROOT / "outputs"
DATA_DIR = ROOT / "data"
MODELS_DIR = ROOT / "models"
CACHE_DIR = ROOT / ".cache"
MODEL_MANAGER = ModelManager(MODELS_DIR)

FLUX_JOB_LOCK = threading.Lock()
FLUX_JOB: dict[str, Any] = {
    "id": None,
    "threadId": None,
    "status": "idle",
    "logs": [],
    "startedAt": None,
    "finishedAt": None,
    "output": None,
    "error": None,
}
FLUX_CANCEL_EVENT: threading.Event | None = None

RUNTIME_LOCK = threading.Lock()
RUNTIME_STATUS: dict[str, Any] = {
    "status": "idle",
    "message": "Model will load when you generate an image.",
    "device": None,
    "logs": [],
    "startedAt": None,
    "finishedAt": None,
    "error": None,
}


FluxGenerationCancelled = GenerationCancelled

MODEL_CHECK_LOCK = threading.Lock()
MODEL_CHECK_STARTED = False
MODEL_CHECK_RESULTS: dict[str, Any] = {}


def model_snapshot(device: str, model="9b") -> dict[str, Any]:
    """Hardware imports must never hold gallery/status requests hostage."""
    global MODEL_CHECK_STARTED
    device = normalize_device(device)
    if model not in ("auto", "9b", "4b"): model = "9b"
    requested_model = model
    model = flux2.resolve_model(model, device)
    with MODEL_CHECK_LOCK:
        if not MODEL_CHECK_STARTED:
            MODEL_CHECK_STARTED = True
            def check():
                try:
                    results = {(key, choice): flux2.model_status(key, choice) for choice in ("9b", "4b") for key in ("AUTO", "INTEL_GPU", "NVIDIA_GPU", "CPU")}
                except Exception as error:
                    results = {(key, choice): {"runtimeReady": False, "checking": False,
                                    "runtimeNote": f"Could not check generation runtime: {error}"}
                               for choice in ("9b", "4b") for key in ("AUTO", "INTEL_GPU", "NVIDIA_GPU", "CPU")}
                with MODEL_CHECK_LOCK:
                    MODEL_CHECK_RESULTS.update(results)
            threading.Thread(target=check, daemon=True).start()
        cached = MODEL_CHECK_RESULTS.get((device, model))
        if cached and not cached.get("runtimeNote", "").startswith("Could not check"):
            return flux2.model_status(device, requested_model)
        return dict(MODEL_CHECK_RESULTS.get((device, model), {
            "runtimeReady": False, "checking": True,
            "runtimeNote": "Checking installed runtime… You can browse your library.",
            "requestedDevice": device, "adapters": [],
        }))


def mark_runtime(**updates: Any) -> None:
    with RUNTIME_LOCK:
        RUNTIME_STATUS.update(updates)


def append_runtime_log(message: str) -> None:
    with RUNTIME_LOCK:
        RUNTIME_STATUS["message"] = message
        RUNTIME_STATUS["logs"].append(message)
        RUNTIME_STATUS["logs"] = RUNTIME_STATUS["logs"][-8:]


def runtime_snapshot() -> dict[str, Any]:
    with RUNTIME_LOCK:
        return {
            "status": RUNTIME_STATUS["status"],
            "message": RUNTIME_STATUS["message"],
            "device": RUNTIME_STATUS["device"],
            "logs": list(RUNTIME_STATUS["logs"]),
            "startedAt": RUNTIME_STATUS["startedAt"],
            "finishedAt": RUNTIME_STATUS["finishedAt"],
            "error": RUNTIME_STATUS["error"],
        }


def latest_images() -> list[dict[str, Any]]:
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    metadata = gallery_store.metadata_snapshot()
    records = []
    for path in OUTPUTS.glob("*.png"):
        try:
            modified = path.stat().st_mtime
        except FileNotFoundError:
            continue  # An image can be moved to Recycle Bin during a listing.
        records.append(gallery_store.enrich_image_record({
            "name": path.name,
            "url": f"/outputs/{urllib.parse.quote(path.name)}",
            "mtime": modified,
        }, metadata))
    return sorted(records, key=lambda record: record["mtime"], reverse=True)


def image_record(path: Path, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    record = {
        "name": path.name,
        "url": f"/outputs/{urllib.parse.quote(path.name)}",
        "mtime": path.stat().st_mtime,
    }
    if metadata:
        gallery_store.save_image_metadata(path.name, metadata)
    return gallery_store.enrich_image_record(record)


def mark_flux_job(**updates: Any) -> None:
    with FLUX_JOB_LOCK:
        FLUX_JOB.update(updates)


def format_flux_log(message: str) -> str:
    return f"[{time.strftime('%H:%M:%S')}] {message}"


def append_flux_log(message: str) -> None:
    with FLUX_JOB_LOCK:
        FLUX_JOB["logs"].append(format_flux_log(message))


def flux_job_snapshot() -> dict[str, Any]:
    with FLUX_JOB_LOCK:
        output = FLUX_JOB["output"]
        if output and not (OUTPUTS / Path(output["name"]).name).is_file():
            output = None
        return {
            "id": FLUX_JOB["id"],
            "threadId": FLUX_JOB.get("threadId"),
            "model": FLUX_JOB.get("model"),
            "status": FLUX_JOB["status"],
            "logs": list(FLUX_JOB["logs"]),
            "startedAt": FLUX_JOB["startedAt"],
            "finishedAt": FLUX_JOB["finishedAt"],
            "output": output,
            "error": FLUX_JOB["error"],
        }


def decode_flux_reference_image(value: Any) -> Image.Image | None:
    if not value:
        return None
    if not isinstance(value, str) or not value.startswith("data:image/") or "," not in value:
        raise ValueError("Reference image must be a PNG, JPEG, or WebP upload.")
    encoded = value.split(",", 1)[1]
    if len(encoded) > 14 * 1024 * 1024:
        raise ValueError("Reference image is too large. Choose an image smaller than 10 MB.")
    try:
        raw = base64.b64decode(encoded, validate=True)
        with Image.open(io.BytesIO(raw)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"}:
                raise ValueError("Reference image must be a PNG, JPEG, or WebP upload.")
            source.load()
            if source.width * source.height > 16_000_000:
                raise ValueError("Reference image is too large. Keep it at 16 megapixels or less.")
            return source.convert("RGB")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Could not read the reference image.") from exc


def validate_flux_payload(payload: dict[str, Any]) -> dict[str, Any]:
    model = payload.get("model", "9b")
    if model != "auto": model_spec(model)
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        raise ValueError("Prompt is required.")
    raw_device = str(payload.get("device", flux2.DEFAULT_DEVICE)).strip().upper()
    if raw_device not in {
        "",
        "AUTO",
        "GPU",
        "INTEL",
        "INTEL_GPU",
        "OPENVINO_GPU",
        "NVIDIA",
        "CUDA",
        "NVIDIA_GPU",
        "CPU",
    }:
        raise ValueError("Device must be Auto-select, Intel GPU, NVIDIA GPU, or CPU.")
    device = normalize_device(raw_device)
    width = int(payload.get("width", flux2.DEFAULT_WIDTH))
    height = int(payload.get("height", flux2.DEFAULT_HEIGHT))
    steps = int(payload.get("steps", flux2.DEFAULT_STEPS))
    guidance = float(payload.get("guidance", flux2.DEFAULT_GUIDANCE))
    seed = int(payload.get("seed", 42))
    batch_size = int(payload.get("batch_size", 1))
    thread_id = payload.get("thread_id")
    if thread_id is not None and (
        not isinstance(thread_id, str)
        or not 1 <= len(thread_id) <= 128
        or not all(character.isascii() and (character.isalnum() or character in "-_") for character in thread_id)
    ):
        raise ValueError("Thread ID must contain 1 to 128 letters, numbers, hyphens, or underscores.")
    reference_image = decode_flux_reference_image(payload.get("reference_image"))

    if width < 256 or width > 1920 or width % 16 != 0:
        raise ValueError("Width must be 256 to 1920 and divisible by 16.")
    if height < 256 or height > 1920 or height % 16 != 0:
        raise ValueError("Height must be 256 to 1920 and divisible by 16.")
    if steps < 1 or steps > 50:
        raise ValueError("Steps must be 1 to 50.")
    if guidance < 0 or guidance > 10:
        raise ValueError("Guidance must be 0 to 10.")
    if batch_size < 1 or batch_size > 4:
        raise ValueError("Batch size must be 1 to 4.")

    return {
        "prompt": prompt,
        "device": device,
        "width": width,
        "height": height,
        "steps": steps,
        "guidance": guidance,
        "seed": seed,
        "batch_size": batch_size,
        "thread_id": thread_id,
        "reference_image": reference_image,
        "model": model,
        "reference_source": payload.get("reference_image") if reference_image is not None else None,
    }


def run_flux_generation(
    job_id: str,
    payload: dict[str, Any],
    cancel_event: threading.Event,
) -> None:
    def log_generation(message: str) -> None:
        append_flux_log(message)
        if message.startswith("Loading Flux"):
            mark_runtime(status="loading", message="Loading model for generation…", error=None)
        elif message.startswith("Seed:"):
            mark_runtime(status="ready", device=payload["device"], message="Model ready.", error=None)
        if cancel_event.is_set():
            raise FluxGenerationCancelled("Generation stopped by user.")

    stage = CACHE_DIR / ("generation-" + job_id)
    try:
        if stage.resolve().parent != CACHE_DIR.resolve():
            raise ValueError("Invalid generation staging path.")
        stage.mkdir(parents=True, exist_ok=True)
        last_record = None
        for index in range(payload["batch_size"]):
            if cancel_event.is_set():
                raise FluxGenerationCancelled("Generation stopped by user.")
            seed = payload["seed"] + index
            append_flux_log(f"Batch image {index + 1}/{payload['batch_size']} | seed {seed}")
            metadata = {
                "threadId": payload.get("thread_id"),
                "prompt": payload["prompt"],
                "seed": seed,
                "width": payload["width"],
                "height": payload["height"],
                "steps": payload["steps"],
                "guidance": payload["guidance"],
                "device": payload["device"],
                "modelPath": str(flux2.model_dir_for(payload["device"], payload.get("model", "9b"))),
                "model": payload.get("model", "9b"),
                "modelRevision": payload.get("modelRevision", "legacy-unverified"),
                "createdAt": time.time(),
            }
            output_path, generation_time = GENERATION_WORKER.generate(
                cancel_event=cancel_event,
                model=payload.get("model", "9b"),
                prompt=payload["prompt"],
                width=payload["width"],
                height=payload["height"],
                steps=payload["steps"],
                guidance=payload["guidance"],
                seed=seed,
                device=payload["device"],
                reference_image=payload["reference_image"],
                output_dir=stage,
                log=log_generation,
            )
            if cancel_event.is_set():
                raise FluxGenerationCancelled("Generation stopped by user.")
            destination = OUTPUTS / output_path.name
            if output_path != destination:
                output_path.replace(destination)
            output_path = destination
            metadata["referenceUsed"] = payload["reference_image"] is not None
            if payload["reference_image"] is not None:
                references = DATA_DIR / "references"
                references.mkdir(parents=True, exist_ok=True)
                source = payload.get("reference_source")
                if source:
                    header, encoded = source.split(",", 1)
                    extension = ".jpg" if "image/jpeg" in header else ".webp" if "image/webp" in header else ".png"
                    reference_name = output_path.name + extension
                    (references / reference_name).write_bytes(base64.b64decode(encoded, validate=True))
                else:
                    reference_name = output_path.name + ".png"
                    payload["reference_image"].save(references / reference_name, format="PNG")
                metadata["referenceUrl"] = "/references/" + urllib.parse.quote(reference_name)
            metadata["generationTime"] = round(generation_time, 1)
            last_record = image_record(output_path, metadata)
        append_flux_log(f"Batch complete | {payload['batch_size']} image(s).")
        mark_flux_job(
            status="complete",
            finishedAt=time.time(),
            output=last_record,
            error=None,
        )
        storage_manager.cleanup_cache(ROOT, CACHE_DIR)
    except FluxGenerationCancelled:
        mark_runtime(status="idle", message="Generation stopped. Model will reload on the next generation.", error=None)
        append_flux_log("Generation stopped by user.")
        mark_flux_job(status="cancelled", finishedAt=time.time(), output=None, error=None)
    except Exception as exc:
        mark_runtime(status="idle", message="Ready to retry generation.", error=None)
        append_flux_log(str(exc))
        mark_flux_job(status="failed", finishedAt=time.time(), output=None, error=str(exc))
    finally:
        # Only this job's validated staging directory is removed. Cancelled/partial
        # worker files never become anonymous images in the user's gallery.
        if stage.resolve().parent == CACHE_DIR.resolve():
            shutil.rmtree(stage, ignore_errors=True)
        global FLUX_CANCEL_EVENT
        with FLUX_JOB_LOCK:
            if FLUX_CANCEL_EVENT is cancel_event:
                FLUX_CANCEL_EVENT = None


def delete_thread_assets(thread_id: str, legacy_names: list[str]) -> list[str]:
    if not isinstance(legacy_names, list):
        raise ValueError("Image names must be a list.")
    metadata = gallery_store.metadata_snapshot()
    names = {name for name, record in metadata.items() if record.get("threadId") == thread_id}
    for name in legacy_names:
        if isinstance(name, str) and not metadata.get(name, {}).get("threadId"):
            names.add(name)
    for name in names:
        if "/" in name or "\\" in name or not name.lower().endswith(".png") or Path(name).name != name:
            raise ValueError("Invalid image name.")
    for name in names:
        (OUTPUTS / name).unlink(missing_ok=True)
        for extension in (".png", ".jpg", ".webp"):
            (DATA_DIR / "references" / (name + extension)).unlink(missing_ok=True)
    gallery_store.remove_image_metadata(names)
    with FLUX_JOB_LOCK:
        if FLUX_JOB.get("threadId") == thread_id:
            FLUX_JOB.update(threadId=None, output=None, logs=[], error=None)
    return sorted(names)


class Handler(BaseHTTPRequestHandler):
    server_version = "Fern/1.0"
    allow_cors = False

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", flush=True)

    def send_cors_headers(self) -> None:
        if not self.allow_cors:
            return
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object.")
        return payload

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/models":
            self.send_json(200, {"models": MODEL_MANAGER.snapshot()})
            return

        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True, "service": "fern"})
            return

        if parsed.path == "/api/flux2/status":
            query = urllib.parse.parse_qs(parsed.query)
            requested_device = query.get("device", [flux2.DEFAULT_DEVICE])[0]
            self.send_json(
                200,
                {
                    "job": flux_job_snapshot(),
                    "images": latest_images() if query.get("images", ["1"])[0] != "0" else None,
                    "installedModels": [{"id": item["id"], "label": item["label"]} for item in MODEL_MANAGER.snapshot() if item["installed"]],
                    "model": model_snapshot(requested_device, query.get("model", ["9b"])[0]),
                    "runtime": runtime_snapshot(),
                    "defaults": {
                        "device": flux2.DEFAULT_DEVICE,
                        "width": flux2.DEFAULT_WIDTH,
                        "height": flux2.DEFAULT_HEIGHT,
                        "steps": flux2.DEFAULT_STEPS,
                        "guidance": flux2.DEFAULT_GUIDANCE,
                    },
                },
            )
            return

        if parsed.path == "/api/storage/status":
            self.send_json(
                200,
                storage_manager.storage_status(
                    ROOT,
                    cache_dir=CACHE_DIR,
                    outputs_dir=OUTPUTS,
                    data_dir=DATA_DIR,
                    models_dir=MODELS_DIR,
                ),
            )
            return

        if parsed.path.startswith(("/outputs/", "/references/")):
            base = DATA_DIR / "references" if parsed.path.startswith("/references/") else OUTPUTS
            filename = urllib.parse.unquote(parsed.path.split("/", 2)[-1])
            if filename != Path(filename).name or "\\" in filename:
                self.send_error(404)
                return
            path = (base / filename).resolve()
            try:
                path.relative_to(base.resolve())
            except ValueError:
                self.send_error(404)
                return

            if not path.exists() or not path.is_file():
                self.send_error(404)
                return

            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_error(404)

    def do_POST(self) -> None:
        global FLUX_CANCEL_EVENT
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/threads/delete":
            try:
                payload = self.read_json_body()
                thread_id = payload.get("thread_id")
                if not isinstance(thread_id, str) or not thread_id:
                    raise ValueError("Thread id is required.")
                current = flux_job_snapshot()
                if current["status"] == "running" and current.get("threadId") == thread_id:
                    self.send_json(409, {"error": "Stop generation before deleting this thread."})
                    return
                names = delete_thread_assets(thread_id, payload.get("image_names", []))
                self.send_json(200, {"deleted": names})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/api/flux2/stop":
            current = flux_job_snapshot()
            if current["status"] != "running":
                self.send_json(409, {"error": "No generation is currently running.", "job": current})
                return
            with FLUX_JOB_LOCK:
                cancel_event = FLUX_CANCEL_EVENT
            if cancel_event is None:
                self.send_json(409, {"error": "The generation job cannot be stopped.", "job": current})
                return
            cancel_event.set()
            append_flux_log("Stopping generation...")
            self.send_json(202, {"job": flux_job_snapshot()})
            return

        if parsed.path == "/api/storage/cleanup-cache":
            current = flux_job_snapshot()
            if current["status"] == "running":
                self.send_json(409, {"error": "Wait for the current generation to finish."})
                return
            GENERATION_WORKER.close()
            flux2.release_pipeline()
            result = storage_manager.cleanup_cache(ROOT, CACHE_DIR, force=True)
            self.send_json(
                200,
                {
                    "cleanup": result,
                    "storage": storage_manager.storage_status(
                        ROOT,
                        cache_dir=CACHE_DIR,
                        outputs_dir=OUTPUTS,
                        data_dir=DATA_DIR,
                        models_dir=MODELS_DIR,
                    ),
                },
            )
            return

        if parsed.path == "/api/storage/clear-local-data":
            current = flux_job_snapshot()
            if current["status"] == "running":
                self.send_json(409, {"error": "Wait for the current generation to finish."})
                return

            GENERATION_WORKER.close()
            flux2.release_pipeline()
            cache_result = storage_manager.cleanup_cache(ROOT, CACHE_DIR, force=True)
            output_files, output_bytes = storage_manager.clear_directory(OUTPUTS)
            metadata_files, metadata_bytes = storage_manager.clear_directory(DATA_DIR)
            mark_flux_job(
                id=None,
                status="idle",
                logs=[],
                startedAt=None,
                finishedAt=None,
                output=None,
                error=None,
            )
            self.send_json(
                200,
                {
                    "removed": {
                        "cacheBytes": cache_result["removedBytes"],
                        "outputBytes": output_bytes,
                        "outputFiles": output_files,
                        "metadataBytes": metadata_bytes,
                        "metadataFiles": metadata_files,
                    },
                    "storage": storage_manager.storage_status(
                        ROOT,
                        cache_dir=CACHE_DIR,
                        outputs_dir=OUTPUTS,
                        data_dir=DATA_DIR,
                        models_dir=MODELS_DIR,
                    ),
                },
            )
            return

        if parsed.path in ("/api/models/install", "/api/models/pause", "/api/models/remove"):
            try:
                model = self.read_json_body().get("model")
                model_spec(model)
                if parsed.path.endswith("install"): MODEL_MANAGER.start(model)
                elif parsed.path.endswith("pause"): MODEL_MANAGER.cancel(model)
                else:
                    with FLUX_JOB_LOCK:
                        if FLUX_JOB["status"] == "running": raise ValueError("Stop generation before removing a model.")
                        GENERATION_WORKER.close()
                        MODEL_MANAGER.remove(model)
                self.send_json(200, {"models": MODEL_MANAGER.snapshot()})
            except Exception as error: self.send_json(400, {"error": str(error)})
            return

        if parsed.path != "/api/flux2/generate":
            self.send_error(404)
            return

        current = flux_job_snapshot()
        if current["status"] == "running":
            self.send_json(409, {"error": "A generation job is already running."})
            return

        try:
            payload = validate_flux_payload(self.read_json_body())
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})
            return

        status = flux2.model_status(payload["device"], payload["model"])
        if not status["runtimeReady"]:
            self.send_json(400, {"error": status["runtimeNote"], "model": status})
            return

        # Resolve Auto-select once at queue time so generation, logs, and saved
        # metadata all describe the adapter that actually ran.
        payload["device"] = status["selectedDevice"]
        payload["model"] = status["selectedModel"]
        payload["modelRevision"] = status["modelRevision"]

        job_id = str(int(time.time() * 1000))
        cancel_event = threading.Event()
        with FLUX_JOB_LOCK:
            if FLUX_JOB["status"] == "running":
                self.send_json(409, {"error": "A generation job is already running."})
                return
            FLUX_JOB["status"] = "running"
            FLUX_CANCEL_EVENT = cancel_event
        model_label = model_spec(payload["model"])["label"]
        mark_flux_job(
            id=job_id,
            threadId=payload.get("thread_id"),
            model=payload["model"],
            status="running",
            logs=[
                format_flux_log(
                    f"Queued {model_label} on "
                    f"{device_label(status['selectedDevice'])}: {payload['width']}x{payload['height']}, "
                    f"{payload['steps']} steps, guidance {payload['guidance']:.1f}, "
                    f"seed {payload['seed']}, batch {payload['batch_size']}"
                ),
                format_flux_log(
                    f"{model_label} text-to-image mode"
                    if payload["reference_image"] is None
                    else f"{model_label} image-to-image enabled"
                ),
            ],
            startedAt=time.time(),
            finishedAt=None,
            output=None,
            error=None,
        )
        thread = threading.Thread(
            target=run_flux_generation,
            args=(job_id, payload, cancel_event),
            daemon=True,
        )
        thread.start()
        self.send_json(202, {"job": flux_job_snapshot()})


def run_server(port: int = 8000, *, allow_cors: bool = False) -> None:
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    cleanup = storage_manager.cleanup_cache(ROOT, CACHE_DIR)
    if cleanup["removedFiles"]:
        print(
            f"Cache cleanup removed {cleanup['removedFiles']} file(s) "
            f"({cleanup['removedBytes']} bytes).",
            flush=True,
        )

    class ConfiguredHandler(Handler):
        pass

    ConfiguredHandler.allow_cors = allow_cors
    server = ThreadingHTTPServer(("127.0.0.1", port), ConfiguredHandler)
    print(f"Fern API running on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        GENERATION_WORKER.close()
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fern image generation API server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--cors", action="store_true", help="Allow cross-origin requests (dev mode)")
    args = parser.parse_args()
    run_server(args.port, allow_cors=args.cors)


if __name__ == "__main__":
    main()
