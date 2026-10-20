from __future__ import annotations

import argparse
import base64
import hashlib
import io
import importlib.util
import json
import math
from contextlib import nullcontext
import mimetypes
import os
import shutil
import sys
import subprocess
import threading
import time
import uuid
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
import flux3_klein_pipeline as flux3
import flux3_klein_runtime
import tame_pony_pipeline as tame_pony
from generation_worker import GenerationWorker, GenerationCancelled, tame_pony_inference_loop
from tts_generation_worker import TtsGenerationWorker
from text_generation_process import TextGenerationProcess
from text_model_registry import TextModelRegistry
from text_model_download import DEFAULT_MODEL_ID as DEFAULT_TEXT_MODEL_ID
from text_model_download import catalog as text_model_catalog, install_model as install_text_model
from tts_model_download import model_ready as tts_export_ready

GENERATION_WORKER = GenerationWorker()
TAME_PONY_GENERATION_WORKER = GenerationWorker(target=tame_pony_inference_loop)
TTS_GENERATION_WORKER = TtsGenerationWorker()
TEXT_GENERATION_WORKER = TextGenerationProcess()
from model_manager import ModelManager
from model_catalog import model_spec
import gallery_store
from media_http import byte_range
import storage_manager
from device_adapters import device_label, normalize_device
from qwen21_turbo_download import download_model as download_qwen_turbo_model


OUTPUTS = ROOT / "outputs"
DATA_DIR = ROOT / "data"
MODELS_DIR = ROOT / "models"
CACHE_DIR = ROOT / ".cache"
TTS_MODEL_ROOT = Path(os.environ.get("FERN_TTS_MODEL_ROOT", MODELS_DIR / "qwen3-tts")).resolve()
TTS_ENV = Path(os.environ.get("FERN_TTS_ENV", ROOT / ".venv-qwen3-tts")).resolve()
TEXT_MODEL_REGISTRY = TextModelRegistry(Path(os.environ.get("FERN_TEXT_MODEL_REGISTRY", DATA_DIR / "text-models.json")))
TEXT_MODEL_ROOT = Path(os.environ.get("FERN_TEXT_MODEL_ROOT", MODELS_DIR / "text")).resolve()
TEXT_MODEL_INSTALL_LOCK = threading.Lock()
TEXT_MODEL_INSTALL: dict[str, Any] = {"id": None, "status": "idle", "phase": None, "error": None}
QWEN_TURBO_MODEL_ID = "qwen21-turbo"
QWEN_TURBO_MODEL_ROOT = Path(os.environ.get("FERN_QWEN_TURBO_MODEL_ROOT", MODELS_DIR / "qwen-image-2.1-turbo-openvino-int8")).resolve()
QWEN_TURBO_PARTIAL_ROOT = QWEN_TURBO_MODEL_ROOT.with_name(QWEN_TURBO_MODEL_ROOT.name + ".partial")
QWEN_TURBO_DOWNLOAD_ROOT = QWEN_TURBO_MODEL_ROOT.with_name(QWEN_TURBO_MODEL_ROOT.name + ".download")
QWEN_TURBO_QUANT_CATALOG = SCRIPTS / "qwen21_turbo_model_catalog.json"
QWEN_TURBO_SOURCE_ROOT = Path(os.environ.get("FERN_QWEN_TURBO_SOURCE_ROOT", CACHE_DIR / "openvino" / "hub")).resolve()
QWEN_TURBO_HF_CACHE = QWEN_TURBO_SOURCE_ROOT
QWEN_TURBO_BASE_RUNTIME = ROOT / ".venv-qwen21-export"
QWEN_TURBO_OVERLAY_RUNTIME = ROOT / ".venv-qwen21-turbo-export"
QWEN_TURBO_PYTHON = Path(sys.executable)
MODEL_MANAGER = ModelManager(MODELS_DIR)
FLUX3_SETUP_LOCK = threading.Lock()
FLUX3_SETUP_STATE: dict[str, Any] = {"status": "idle", "phase": None, "error": None}
FLUX3_SETUP_CANCEL: threading.Event | None = None

TTS_MODELS = {
    "custom-0.6b": {"label": "Custom Voice · 0.6B", "kind": "custom_voice"},
    "custom-1.7b": {"label": "Custom Voice · 1.7B", "kind": "custom_voice"},
    "base-0.6b": {"label": "Voice Clone · 0.6B", "kind": "base"},
    "base-1.7b": {"label": "Voice Clone · 1.7B", "kind": "base"},
    "voice-design-1.7b": {"label": "Voice Design · 1.7B", "kind": "voice_design"},
}
TTS_JOB_LOCK = threading.Lock()
TTS_PROCESS_LOCK = threading.Lock()
TTS_ACTIVE_PROCESS: subprocess.Popen[str] | None = None
TTS_CANCEL_EVENT: threading.Event | None = None
TTS_JOB: dict[str, Any] = {
    "id": None, "threadId": None, "model": None, "status": "idle",
    "operation": None, "logs": [], "startedAt": None, "finishedAt": None,
    "output": None, "error": None, "diagnostics": [], "phase": None,
}
TEXT_JOB_LOCK = threading.Lock()
# Serialize admission and cancellation across modalities.
JOB_ADMISSION_LOCK = threading.RLock()
TEXT_CANCEL_EVENT: threading.Event | None = None
TEXT_JOB: dict[str, Any] = {
    "id": None, "threadId": None, "modelId": None, "status": "idle",
    "phase": None, "partialText": "", "startedAt": None, "finishedAt": None,
    "result": None, "error": None,
}


def text_model_install_running() -> bool:
    with TEXT_MODEL_INSTALL_LOCK:
        return TEXT_MODEL_INSTALL.get("status") in ("downloading", "preparing")


def run_text_model_install(model_id: str, job_id: str) -> None:
    def progress(phase: str) -> None:
        with TEXT_MODEL_INSTALL_LOCK:
            if TEXT_MODEL_INSTALL.get("id") == job_id:
                TEXT_MODEL_INSTALL.update(status="preparing" if phase.startswith("Converting") else "downloading", phase=phase)
    try:
        TEXT_GENERATION_WORKER.close()
        folder = install_text_model(model_id, TEXT_MODEL_ROOT, progress)
        model = TEXT_MODEL_REGISTRY.add(str(folder))
        with TEXT_MODEL_INSTALL_LOCK:
            TEXT_MODEL_INSTALL.update(status="complete", phase="Installed and verified.", error=None, modelId=model["id"])
    except Exception as error:
        with TEXT_MODEL_INSTALL_LOCK:
            TEXT_MODEL_INSTALL.update(status="failed", phase=None, error=str(error)[:1000])
QWEN_JOB_LOCK = threading.Lock()
QWEN_PROCESS_LOCK = threading.Lock()
QWEN_ACTIVE_PROCESS: subprocess.Popen[str] | None = None
QWEN_CANCEL_EVENT: threading.Event | None = None
QWEN_GENERATION_WORKER = TtsGenerationWorker()
FLUX3_GENERATION_WORKER = TtsGenerationWorker()
QWEN_JOB: dict[str, Any] = {
    "status": "idle", "logs": [], "phase": None, "error": None,
    "downloaded": 0, "bytes": 23_201_764_848,
    "startedAt": None, "finishedAt": None,
}
QWEN_RUNTIME_LOCK = threading.Lock()
QWEN_RUNTIME_CHECK_LOCK = threading.Lock()
QWEN_MODEL_OPERATION_LOCK = threading.Lock()
QWEN_RUNTIME_READY: bool | None = None
QWEN_RUNTIME_CHECK_STARTED = False
QWEN_RUNTIME_CHECK_COMPLETE = False
QWEN_RUNTIME_CHECK_VERSION = 0
QWEN_RUNTIME_DEVICES: set[str] = set()
QWEN_MODEL_READY_LOCK = threading.Lock()
QWEN_MODEL_READY_SIGNATURE: tuple[Any, ...] | None = None
QWEN_MODEL_READY_RESULT = False
IMAGE_LIST_LOCK = threading.Lock()
IMAGE_LIST_CACHE: dict[str, Any] = {"key": None, "checkedAt": 0.0, "records": []}


def tts_model_ready(model: str) -> bool:
    if not tts_environment_ready():
        return False
    return tts_export_ready(TTS_MODEL_ROOT / f"{model}-OV", model)


def qwen_turbo_runtime_ready() -> bool:
    global QWEN_RUNTIME_READY
    if QWEN_RUNTIME_READY is not None:
        return QWEN_RUNTIME_READY
    with QWEN_RUNTIME_LOCK:
        if QWEN_RUNTIME_READY is not None:
            return QWEN_RUNTIME_READY
        try:
            probe = subprocess.run(
                [str(QWEN_TURBO_PYTHON), "-c", (
                    "import transformers.models.qwen2_vl.modeling_qwen2_vl as q2; "
                    "q2.VisionRotaryEmbedding=q2.Qwen2VLRotaryEmbedding; "
                    "import transformers.models.qwen3_vl.modeling_qwen3_vl as q3; "
                    "import transformers.models.qwen3_5.modeling_qwen3_5 as q35; "
                    "from transformers.vision_utils import get_vision_position_ids; "
                    "rot=lambda self,grid:(get_vision_position_ids(grid,self.spatial_merge_size).unsqueeze(-1)*self.rotary_pos_emb.inv_freq).flatten(1); "
                    "q3.Qwen3VLVisionModel.rot_pos_emb=rot; q35.Qwen3_5VisionModel.rot_pos_emb=rot; "
                    "from optimum.intel import OVQwenImage21Pipeline; assert OVQwenImage21Pipeline"
                )],
                cwd=ROOT, env=qwen_turbo_child_env(), capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=90, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            QWEN_RUNTIME_READY = probe.returncode == 0
        except (OSError, subprocess.SubprocessError):
            QWEN_RUNTIME_READY = False
        return QWEN_RUNTIME_READY


def qwen_turbo_quant_bytes() -> int:
    try:
        catalog = json.loads(QWEN_TURBO_QUANT_CATALOG.read_text(encoding="utf-8-sig"))
        size = catalog.get("bytes")
        if isinstance(size, int) and size > 0:
            return size
    except (OSError, ValueError, TypeError):
        pass
    return 23_201_764_848


def _check_qwen_turbo_runtime(version: int) -> None:
    global QWEN_RUNTIME_CHECK_STARTED, QWEN_RUNTIME_CHECK_COMPLETE, QWEN_RUNTIME_DEVICES
    devices: set[str] = set()
    try:
        if qwen_turbo_runtime_ready():
            probe = subprocess.run(
                [str(QWEN_TURBO_PYTHON), "-c", (
                    "import json, openvino as ov; "
                    "print(json.dumps(ov.Core().available_devices))"
                )],
                cwd=ROOT, env=qwen_turbo_child_env(), capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=60,
                check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if probe.returncode == 0:
                parsed = json.loads(probe.stdout.strip().splitlines()[-1])
                if isinstance(parsed, list):
                    devices = {item for item in parsed if isinstance(item, str)}
    except Exception:
        devices = set()
    finally:
        with QWEN_RUNTIME_CHECK_LOCK:
            if version == QWEN_RUNTIME_CHECK_VERSION:
                QWEN_RUNTIME_DEVICES = devices
                QWEN_RUNTIME_CHECK_COMPLETE = True
                QWEN_RUNTIME_CHECK_STARTED = False


def _check_qwen_turbo_runtime_with_lock(version: int) -> None:
    with QWEN_MODEL_OPERATION_LOCK:
        _check_qwen_turbo_runtime(version)


def qwen_turbo_runtime_status() -> tuple[bool | None, set[str]]:
    global QWEN_RUNTIME_CHECK_STARTED
    with QWEN_RUNTIME_CHECK_LOCK:
        if not QWEN_RUNTIME_CHECK_COMPLETE and not QWEN_RUNTIME_CHECK_STARTED:
            QWEN_RUNTIME_CHECK_STARTED = True
            version = QWEN_RUNTIME_CHECK_VERSION
            threading.Thread(target=_check_qwen_turbo_runtime_with_lock, args=(version,), daemon=True).start()
        if not QWEN_RUNTIME_CHECK_COMPLETE:
            return None, set()
        return QWEN_RUNTIME_READY, set(QWEN_RUNTIME_DEVICES)


def invalidate_qwen_turbo_runtime_status() -> None:
    global QWEN_RUNTIME_READY, QWEN_RUNTIME_CHECK_STARTED
    global QWEN_RUNTIME_CHECK_COMPLETE, QWEN_RUNTIME_CHECK_VERSION, QWEN_RUNTIME_DEVICES
    with QWEN_RUNTIME_LOCK:
        QWEN_RUNTIME_READY = None
    with QWEN_RUNTIME_CHECK_LOCK:
        QWEN_RUNTIME_CHECK_VERSION += 1
        QWEN_RUNTIME_CHECK_STARTED = False
        QWEN_RUNTIME_CHECK_COMPLETE = False
        QWEN_RUNTIME_DEVICES = set()


def qwen_turbo_model_ready() -> bool:
    global QWEN_MODEL_READY_SIGNATURE, QWEN_MODEL_READY_RESULT
    components = (
        "transformer", "text_encoder", "text_encoder_i2i",
        "vision_encoder", "vae_encoder", "vae_decoder",
    )
    required = (
        ".fern-qwen21-turbo-openvino.json", "model_index.json",
        ".fern-validation.png", ".fern-validation.json", ".fern-sample-sigmas.json",
        *(f"{component}/openvino_model.{extension}" for component in components for extension in ("xml", "bin")),
    )
    signature_items: list[Any] = []
    for name in required:
        path = QWEN_TURBO_MODEL_ROOT / name
        try:
            stat = path.stat()
            signature_items.append((name, stat.st_size, stat.st_mtime_ns))
        except OSError:
            signature_items.append((name, None, None))
    signature = tuple(signature_items)
    with QWEN_MODEL_READY_LOCK:
        if signature == QWEN_MODEL_READY_SIGNATURE:
            return QWEN_MODEL_READY_RESULT
        QWEN_MODEL_READY_SIGNATURE = signature
        QWEN_MODEL_READY_RESULT = False
        if any(size is None or size <= 0 for _, size, _ in signature_items):
            return False
    try:
        marker = json.loads((QWEN_TURBO_MODEL_ROOT / ".fern-qwen21-turbo-openvino.json").read_text(encoding="utf-8-sig"))
        if not (
            marker.get("repo") == "Qwen/Qwen-Image-2.1-Turbo"
            and marker.get("revision") == "84d3f71fff32fc6c4740b89f5556657d0c65af27"
            and marker.get("format") == "openvino-int8"
            and marker.get("weightBits") == 8
        ):
            return False
        model_index = json.loads((QWEN_TURBO_MODEL_ROOT / "model_index.json").read_text(encoding="utf-8-sig"))
        sidecar = json.loads((QWEN_TURBO_MODEL_ROOT / ".fern-sample-sigmas.json").read_text(encoding="utf-8-sig"))
        sigmas = model_index.get("sample_sigmas")
        if not isinstance(sigmas, list) or len(sigmas) != 8 or sigmas != sidecar.get("sample_sigmas"):
            return False
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in sigmas):
            return False
        evidence_path = QWEN_TURBO_MODEL_ROOT / ".fern-validation.json"
        image_path = QWEN_TURBO_MODEL_ROOT / ".fern-validation.png"
        evidence = json.loads(evidence_path.read_text(encoding="utf-8-sig"))
        if not (
            evidence.get("device") == "GPU"
            and evidence.get("steps") == 8
            and evidence.get("useKvCache") is False
            and evidence.get("width") == 512
            and evidence.get("height") == 512
            and evidence.get("sampleSigmas") == sigmas
            and isinstance(evidence.get("pixelStdDev"), (int, float))
            and evidence["pixelStdDev"] >= 0.5
            and evidence.get("sha256") == hashlib.sha256(image_path.read_bytes()).hexdigest()
        ):
            return False
        with Image.open(image_path) as image:
            image.verify()
        with Image.open(image_path) as image:
            if image.size != (512, 512):
                return False
    except (OSError, ValueError, TypeError, KeyError):
        QWEN_MODEL_READY_RESULT = False
        return False
    QWEN_MODEL_READY_RESULT = True
    return True


def resolve_qwen_turbo_device(device: str) -> str:
    if device == "CPU":
        return "CPU"
    try:
        import openvino as ov
        if "GPU" in ov.Core().available_devices:
            return "GPU"
    except Exception:
        pass
    raise ValueError("OpenVINO GPU is unavailable. Select CPU explicitly to continue.")


def qwen_turbo_snapshot() -> dict[str, Any]:
    with QWEN_JOB_LOCK:
        job = dict(QWEN_JOB)
        job["logs"] = list(QWEN_JOB["logs"])
    model_ready = qwen_turbo_model_ready()
    runtime_ready, _ = qwen_turbo_runtime_status() if model_ready else (False, set())
    installed = runtime_ready is True and model_ready
    active = job["status"] in ("setting_up", "downloading")
    partial_is_resumable = (QWEN_TURBO_PARTIAL_ROOT / ".openvino_export_complete").is_file()
    download_is_resumable = QWEN_TURBO_DOWNLOAD_ROOT.is_dir()
    has_incomplete_files = QWEN_TURBO_MODEL_ROOT.exists() or (
        QWEN_TURBO_PARTIAL_ROOT.exists() and not partial_is_resumable
    )
    state = (
        "installed" if installed else
        "installing" if active else
        "paused" if job["status"] == "paused" or (job["status"] == "idle" and (download_is_resumable or partial_is_resumable)) else
        "checking-runtime" if model_ready and runtime_ready is None else
        "runtime-unavailable" if model_ready and not runtime_ready else
        "repair-needed" if has_incomplete_files else
        "failed" if job["status"] == "failed" else
        "not-installed"
    )
    return {
        "id": QWEN_TURBO_MODEL_ID,
        "label": "Qwen Image 2.1 Turbo · official",
        "bytes": qwen_turbo_quant_bytes(),
        "downloaded": int(job.get("downloaded") or 0),
        "installed": installed,
        "state": state,
        "error": job.get("error"),
        "phase": job.get("phase"),
        "logs": job["logs"],
        "runtimeReady": runtime_ready is True,
        "supportsReferenceImage": True,
    }


def model_library_snapshot() -> list[dict[str, Any]]:
    """Merge the regular catalog with Flux.3's separate runtime setup state."""
    models = MODEL_MANAGER.snapshot()
    flux3_item = next((item for item in models if item["id"] == flux3.MODEL_KEY), None)
    if flux3_item is not None:
        with FLUX3_SETUP_LOCK:
            setup = dict(FLUX3_SETUP_STATE)
        flux3_item["runtimeReady"] = flux3_klein_runtime.runtime_ready()
        flux3_item["supportsReferenceImage"] = False
        if setup["status"] == "installing":
            flux3_item.update(state="installing", phase=setup.get("phase"), error=None)
        elif setup["status"] == "failed":
            flux3_item.update(
                state="runtime-unavailable" if flux3_item["installed"] else "failed",
                error=setup.get("error"),
            )
        elif flux3_item["installed"] and not flux3_item["runtimeReady"]:
            flux3_item["state"] = "runtime-unavailable"
    runtime = flux2._OPENVINO_DEPENDENCY_STATUS
    for pony_item in (item for item in models if tame_pony.is_model(item["id"])):
        pony_item["supportsReferenceImage"] = False
        pony_item["runtimeReady"] = bool(runtime and runtime.get("installed"))
        if pony_item["installed"] and runtime and not runtime.get("installed"):
            pony_item["state"] = "runtime-unavailable"
    return models + [qwen_turbo_snapshot()]


def _run_flux3_setup(cancel_event: threading.Event) -> None:
    try:
        def progress(message: str) -> None:
            with FLUX3_SETUP_LOCK:
                FLUX3_SETUP_STATE["phase"] = message

        flux3_klein_runtime.ensure_runtime(progress, cancel_event)
        if cancel_event.is_set():
            raise InterruptedError("FLUX.3 setup was cancelled.")
        flux3.refresh_devices()
        if not next(
            item for item in MODEL_MANAGER.snapshot() if item["id"] == flux3.MODEL_KEY
        )["installed"]:
            MODEL_MANAGER.start(flux3.MODEL_KEY)
        with FLUX3_SETUP_LOCK:
            FLUX3_SETUP_STATE.update(status="idle", phase=None, error=None)
    except InterruptedError as error:
        with FLUX3_SETUP_LOCK:
            FLUX3_SETUP_STATE.update(status="idle", phase=None, error=str(error))
    except Exception as error:
        with FLUX3_SETUP_LOCK:
            FLUX3_SETUP_STATE.update(
                status="failed", phase=None, error=str(error) or type(error).__name__
            )


def start_flux3_setup() -> None:
    global FLUX3_SETUP_CANCEL
    with FLUX3_SETUP_LOCK:
        if FLUX3_SETUP_STATE["status"] == "installing":
            raise ValueError("FLUX.3 setup is already running.")
        FLUX3_SETUP_CANCEL = threading.Event()
        FLUX3_SETUP_STATE.update(
            status="installing", phase="Preparing the isolated FLUX.3 runtime…", error=None
        )
        event = FLUX3_SETUP_CANCEL
    threading.Thread(target=_run_flux3_setup, args=(event,), daemon=True).start()


def cancel_flux3_setup() -> None:
    with FLUX3_SETUP_LOCK:
        if FLUX3_SETUP_STATE["status"] == "installing":
            if FLUX3_SETUP_CANCEL is not None:
                FLUX3_SETUP_CANCEL.set()
            return
    MODEL_MANAGER.cancel(flux3.MODEL_KEY)


def cleanup_cache_when_model_idle() -> dict[str, Any] | None:
    # Qwen's pinned source snapshot lives under CACHE_DIR. Serialize the check
    # with install/remove so cleanup cannot erase source files during export.
    with QWEN_MODEL_OPERATION_LOCK:
        with QWEN_JOB_LOCK:
            if QWEN_JOB["status"] in ("setting_up", "downloading"):
                return None
        return storage_manager.cleanup_cache(ROOT, CACHE_DIR)


def tts_environment_ready() -> bool:
    python = TTS_ENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    runtime_present = (
        python.is_file()
        and (SCRIPTS / "tts_runtime" / "qwen_3_tts_helper.py").is_file()
        and (SCRIPTS / "tts_runtime" / "qwen_tts").is_dir()
    )
    if not runtime_present:
        return False
    marker = TTS_ENV / ".fern-runtime.json"
    if marker.is_file():
        try:
            import hashlib
            metadata = json.loads(marker.read_text(encoding="utf-8-sig"))
            expected = hashlib.sha256((SCRIPTS / "requirements-qwen3-tts-runtime.txt").read_bytes()).hexdigest()
            return metadata.get("requirementsSha256") == expected
        except (OSError, ValueError):
            return False
    # Existing converted installations already completed the old dependency setup.
    # A newly created or interrupted venv alone is never considered ready.
    return (TTS_MODEL_ROOT / "qwen_3_tts_helper.py").is_file() and (TTS_MODEL_ROOT / "Qwen3-TTS" / "qwen_tts").is_dir()


def tts_snapshot() -> dict[str, Any]:
    with TTS_JOB_LOCK:
        job = dict(TTS_JOB)
        job["logs"] = list(TTS_JOB["logs"])
        job["diagnostics"] = list(TTS_JOB.get("diagnostics", []))
    job["models"] = [
        {"id": key, **spec, "installed": tts_model_ready(key)}
        for key, spec in TTS_MODELS.items()
    ]
    job["environmentReady"] = tts_environment_ready()
    return job


def text_runtime_snapshot() -> dict[str, Any]:
    try:
        # Keep native GenAI libraries in the worker. Importing them from
        # simultaneous HTTP threads can contend with OpenVINO initialization.
        missing = [name for name in ("openvino", "openvino_genai", "openvino_tokenizers")
                   if importlib.util.find_spec(name) is None]
        if missing:
            raise RuntimeError("Missing text runtime packages: " + ", ".join(missing))
        runtime_available = True
        runtime_error = None
    except Exception as error:
        runtime_available = False
        runtime_error = str(error).splitlines()[-1][:300]
    with TEXT_JOB_LOCK:
        job = dict(TEXT_JOB)
    try:
        models = TEXT_MODEL_REGISTRY.snapshot()
        registry_error = None
    except ValueError as error:
        models = []
        registry_error = str(error)
    with TEXT_MODEL_INSTALL_LOCK:
        model_install = dict(TEXT_MODEL_INSTALL)
    recommended = []
    for model_id, spec in text_model_catalog().items():
        folder = TEXT_MODEL_ROOT / spec["folder"]
        entry = next((model for model in models if Path(model.get("path", "")).resolve() == folder), None)
        recommended.append({
            "id": model_id,
            "name": spec["name"],
            "repo": spec["repo"],
            "bytes": sum(file["size"] for file in spec["files"]),
            "installed": bool(entry and entry.get("installed")),
        })
    return {
        "job": job,
        "models": models,
        "recommendedModels": recommended,
        "defaultModelId": DEFAULT_TEXT_MODEL_ID,
        "modelInstall": model_install,
        "registryError": registry_error,
        "runtimeAvailable": runtime_available,
        "runtimeError": runtime_error,
        "devices": ["AUTO", "GPU", "CPU"],
    }


def append_text_event(job_id: str, *, phase: str | None = None, token: str | None = None) -> None:
    with TEXT_JOB_LOCK:
        if TEXT_JOB.get("id") != job_id or TEXT_JOB.get("status") != "running":
            return
        if phase is not None:
            TEXT_JOB["phase"] = phase[:500]
        if token:
            current = str(TEXT_JOB.get("partialText") or "")
            if len(current) < 100_000:
                TEXT_JOB["partialText"] = current + token[:100_000 - len(current)]


def text_job_running() -> bool:
    with TEXT_JOB_LOCK:
        return TEXT_JOB.get("status") == "running"


def qwen_turbo_setup_running() -> bool:
    with QWEN_JOB_LOCK:
        return QWEN_JOB.get("status") in ("setting_up", "downloading")


def run_text_generation(payload: dict[str, Any], job_id: str, cancel_event: threading.Event) -> None:
    try:
        GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TTS_GENERATION_WORKER.close()
        flux2.release_pipeline()
        if cancel_event.is_set():
            raise InterruptedError()
        model = next(
            (item for item in TEXT_MODEL_REGISTRY.snapshot() if item["id"] == payload["modelId"]),
            None,
        )
        if model is None or not model.get("installed"):
            raise ValueError("Add this OpenVINO model again; its folder is no longer available.")
        device = payload["device"]
        append_text_event(job_id, phase=f"Loading {model['name']} on {device_label(device)}…")
        result = TEXT_GENERATION_WORKER.generate(
            model_path=model["path"],
            device=device,
            command=[str(Path(sys.executable)), "-u", str(SCRIPTS / "text_generation_worker.py"), model["path"], device],
            request={**payload, "op": "generate"},
            cwd=ROOT,
            env={
                **os.environ,
                "PYTHONUNBUFFERED": "1",
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
            },
            on_token=lambda token: append_text_event(job_id, token=token),
            on_phase=lambda phase: append_text_event(job_id, phase=phase),
            cancel_event=cancel_event,
        )
        if cancel_event.is_set():
            raise InterruptedError()
        with TEXT_JOB_LOCK:
            if cancel_event.is_set():
                raise InterruptedError()
            if TEXT_JOB.get("id") == job_id:
                result.update(modelId=model["id"], modelName=model["name"], device=result.get("device", device),
                              seed=payload["seed"], temperature=payload["temperature"],
                              topP=payload["topP"], maxNewTokens=payload["maxNewTokens"])
                TEXT_JOB.update(
                    status="complete", finishedAt=time.time(), phase="Response complete.",
                    partialText=result.get("text", ""), result=result, error=None,
                )
    except InterruptedError:
        with TEXT_JOB_LOCK:
            if TEXT_JOB.get("id") == job_id:
                TEXT_JOB.update(status="stopped", finishedAt=time.time(), phase="Generation stopped.", error=None)
    except Exception as error:
        with TEXT_JOB_LOCK:
            if TEXT_JOB.get("id") == job_id:
                stopped = cancel_event.is_set()
                TEXT_JOB.update(status="stopped" if stopped else "failed", finishedAt=time.time(),
                                phase="Generation stopped." if stopped else "Generation failed.",
                                error=None if stopped else (str(error) or type(error).__name__)[-1000:])


def tts_job_running() -> bool:
    with TTS_JOB_LOCK:
        return TTS_JOB["status"] in ("running", "setting_up", "stopping")


class TtsJobCancelled(Exception):
    pass


def terminate_tts_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/pid", str(process.pid), "/t", "/f"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        process.terminate()


def mark_tts_stopped(job_id: str) -> None:
    with TTS_JOB_LOCK:
        if TTS_JOB["id"] == job_id:
            TTS_JOB.update(status="stopped", finishedAt=time.time(), output=None, error=None)
            TTS_JOB["logs"].append(f"[{time.strftime('%H:%M:%S')}] Audio job stopped.")
            TTS_JOB["logs"] = TTS_JOB["logs"][-120:]


def append_tts_log(message: str) -> None:
    # Only our explicit progress messages enter the user-facing timeline.
    # Library warnings, tracebacks and conversion output remain inspectable.
    progress_prefix = "FERN_TTS_PROGRESS:"
    is_progress = message.startswith(progress_prefix)
    if is_progress:
        message = message[len(progress_prefix):]
    with TTS_JOB_LOCK:
        elapsed = max(0, time.time() - (TTS_JOB.get("startedAt") or time.time()))
        stamp = f"[{time.strftime('%H:%M:%S')} +{elapsed:.1f}s]"
        key = "logs" if is_progress else "diagnostics"
        TTS_JOB.setdefault(key, []).append(f"{stamp} {message}")
        TTS_JOB[key] = TTS_JOB[key][-120:]
        if is_progress:
            TTS_JOB["phase"] = message


def tts_child_env(clean_python_env: bool = True) -> dict[str, str]:
    child_env = os.environ.copy()
    if clean_python_env:
        child_env.pop("PYTHONHOME", None)
        child_env.pop("PYTHONPATH", None)
    child_env["PYTHONUNBUFFERED"] = "1"
    child_env["PYTHONUTF8"] = "1"
    child_env["PYTHONIOENCODING"] = "utf-8"
    tts_hf_cache = TTS_MODEL_ROOT / "huggingface-cache"
    child_env["HF_HOME"] = str(tts_hf_cache)
    child_env["HF_HUB_CACHE"] = str(tts_hf_cache / "hub")
    return child_env


def qwen_turbo_child_env() -> dict[str, str]:
    child_env = os.environ.copy()
    child_env.pop("PYTHONHOME", None)
    python_paths = [
        QWEN_TURBO_OVERLAY_RUNTIME / "Lib" / "site-packages",
        QWEN_TURBO_BASE_RUNTIME / "Lib" / "site-packages",
        Path(child_env["PYTHONPATH"]) if child_env.get("PYTHONPATH") else None,
    ]
    child_env["PYTHONPATH"] = os.pathsep.join(str(path) for path in python_paths if path)
    child_env["PYTHONUNBUFFERED"] = "1"
    child_env["PYTHONUTF8"] = "1"
    child_env["PYTHONIOENCODING"] = "utf-8"
    child_env["HF_HOME"] = str(QWEN_TURBO_HF_CACHE)
    child_env["HF_HUB_CACHE"] = str(QWEN_TURBO_HF_CACHE / "hub")
    return child_env


def append_qwen_turbo_log(message: str) -> None:
    with QWEN_JOB_LOCK:
        QWEN_JOB["logs"].append(message)
        QWEN_JOB["logs"] = QWEN_JOB["logs"][-100:]
        QWEN_JOB["phase"] = message


def terminate_qwen_turbo_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/pid", str(process.pid), "/t", "/f"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_qwen_turbo_process(command: list[str], cancel_event: threading.Event) -> tuple[int, str]:
    global QWEN_ACTIVE_PROCESS
    process = subprocess.Popen(
        command, cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        bufsize=1, env=qwen_turbo_child_env(),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    with QWEN_PROCESS_LOCK:
        QWEN_ACTIVE_PROCESS = process
    lines: list[str] = []
    try:
        assert process.stdout is not None
        for line in process.stdout:
            line = line.rstrip()
            if line:
                lines.append(line)
                append_qwen_turbo_log(line)
            if cancel_event.is_set():
                terminate_qwen_turbo_process(process)
                raise TtsJobCancelled()
        code = process.wait()
        if cancel_event.is_set():
            raise TtsJobCancelled()
        return code, "\n".join(lines)
    finally:
        with QWEN_PROCESS_LOCK:
            if QWEN_ACTIVE_PROCESS is process:
                QWEN_ACTIVE_PROCESS = None


def _run_qwen_turbo_setup(job_id: str, cancel_event: threading.Event) -> None:
    try:
        # Model setup can allocate substantial memory and disk bandwidth. Drop
        # any warm inference pipelines before exporting or validating it.
        GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TTS_GENERATION_WORKER.close()
        TEXT_GENERATION_WORKER.close()
        flux2.release_pipeline()
        if cancel_event.is_set():
            raise TtsJobCancelled()
        model_ready = qwen_turbo_model_ready()
        if not model_ready:
            if QWEN_TURBO_MODEL_ROOT.exists():
                raise RuntimeError("Incomplete Qwen Turbo files are present. Remove them before reinstalling.")
            legacy_export_ready = (QWEN_TURBO_PARTIAL_ROOT / ".openvino_export_complete").is_file()
            if legacy_export_ready:
                append_qwen_turbo_log("Validating the preserved local OpenVINO INT8 export.")
                command = [
                    sys.executable, "-u", str(SCRIPTS / "qwen21_turbo_openvino.py"),
                    "setup", str(QWEN_TURBO_SOURCE_ROOT), str(QWEN_TURBO_MODEL_ROOT),
                ]
                code, output = run_qwen_turbo_process(command, cancel_event)
                if code:
                    raise RuntimeError(output.splitlines()[-1] if output else "Qwen Turbo validation failed.")
            else:
                if not QWEN_TURBO_QUANT_CATALOG.is_file():
                    raise RuntimeError("The pinned public Qwen Turbo model catalog is not configured.")
                append_qwen_turbo_log("Downloading the pinned Fern OpenVINO INT8 model from Hugging Face.")
                last_file = ""

                def report_download(downloaded: int, total: int, path: str) -> None:
                    nonlocal last_file
                    with QWEN_JOB_LOCK:
                        QWEN_JOB["downloaded"] = downloaded
                        QWEN_JOB["bytes"] = total
                        QWEN_JOB["phase"] = f"Downloading {Path(path).name}"
                    if path != last_file:
                        append_qwen_turbo_log(f"Downloading {path}")
                        last_file = path

                download_qwen_turbo_model(
                    QWEN_TURBO_QUANT_CATALOG,
                    QWEN_TURBO_DOWNLOAD_ROOT,
                    cancel_event,
                    report_download,
                )
                if cancel_event.is_set():
                    raise TtsJobCancelled()
                if QWEN_TURBO_MODEL_ROOT.exists():
                    raise RuntimeError("Qwen Turbo files appeared during installation; refusing to overwrite them.")
                QWEN_TURBO_DOWNLOAD_ROOT.replace(QWEN_TURBO_MODEL_ROOT)
                if not qwen_turbo_model_ready():
                    raise RuntimeError("The downloaded Qwen Turbo model failed Fern's export and validation checks.")

        runtime_ready = qwen_turbo_runtime_ready()
        if not runtime_ready:
            append_qwen_turbo_log("Repairing the OpenVINO runtime for the existing export.")
            command = [sys.executable, "-u", str(SCRIPTS / "qwen21_turbo_openvino.py"), "repair-runtime"]
            code, output = run_qwen_turbo_process(command, cancel_event)
            if code:
                raise RuntimeError(output.splitlines()[-1] if output else "Qwen Turbo OpenVINO setup failed.")
            invalidate_qwen_turbo_runtime_status()
        if cancel_event.is_set():
            raise TtsJobCancelled()
        if not qwen_turbo_model_ready():
            raise RuntimeError("The OpenVINO INT8 export did not pass the required component checks.")
        with QWEN_JOB_LOCK:
            if QWEN_JOB.get("id") == job_id:
                QWEN_JOB.update(status="complete", finishedAt=time.time(), error=None, phase="Official Qwen Turbo OpenVINO INT8 export is ready.")
    except (TtsJobCancelled, InterruptedError):
        with QWEN_JOB_LOCK:
            if QWEN_JOB.get("id") == job_id:
                QWEN_JOB.update(status="paused", finishedAt=time.time(), phase="Setup paused. Resume to continue.")
    except Exception as error:
        with QWEN_JOB_LOCK:
            if QWEN_JOB.get("id") == job_id:
                QWEN_JOB.update(status="failed", finishedAt=time.time(), error=str(error), phase="Setup failed.")


def run_qwen_turbo_setup(job_id: str, cancel_event: threading.Event) -> None:
    with QWEN_MODEL_OPERATION_LOCK:
        _run_qwen_turbo_setup(job_id, cancel_event)


def start_qwen_turbo_setup() -> dict[str, Any]:
    global QWEN_CANCEL_EVENT
    with QWEN_MODEL_OPERATION_LOCK:
        if qwen_turbo_model_ready() and qwen_turbo_runtime_ready():
            raise ValueError("Official Qwen Turbo is already installed.")
        with QWEN_JOB_LOCK:
            if QWEN_JOB["status"] in ("setting_up", "downloading"):
                raise ValueError("Qwen Turbo setup is already running.")
            job_id = str(int(time.time() * 1000))
            cancel_event = threading.Event()
            QWEN_CANCEL_EVENT = cancel_event
            QWEN_JOB.update(
                status="setting_up", id=job_id, logs=[], phase="Starting setup…", error=None,
                downloaded=0, bytes=qwen_turbo_quant_bytes(), startedAt=time.time(), finishedAt=None,
            )
        threading.Thread(target=run_qwen_turbo_setup, args=(job_id, cancel_event), daemon=True).start()
    return qwen_turbo_snapshot()


def cancel_qwen_turbo_setup() -> dict[str, Any]:
    with QWEN_JOB_LOCK:
        if QWEN_JOB["status"] not in ("setting_up", "downloading"):
            raise ValueError("No Qwen Turbo setup is running.")
        cancel_event = QWEN_CANCEL_EVENT
    if cancel_event is not None:
        cancel_event.set()
    with QWEN_PROCESS_LOCK:
        process = QWEN_ACTIVE_PROCESS
    terminate_qwen_turbo_process(process)
    return qwen_turbo_snapshot()


def run_tts_process(
    command: list[str], stdin_data: str | None = None, clean_python_env: bool = True,
    cancel_event: threading.Event | None = None,
) -> tuple[int, str]:
    global TTS_ACTIVE_PROCESS
    if cancel_event is not None and cancel_event.is_set():
        raise TtsJobCancelled()
    process = subprocess.Popen(
        command, cwd=str(ROOT), stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        bufsize=1, env=tts_child_env(clean_python_env), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    with TTS_PROCESS_LOCK:
        TTS_ACTIVE_PROCESS = process
    try:
        if cancel_event is not None and cancel_event.is_set():
            terminate_tts_process(process)
            raise TtsJobCancelled()
        if stdin_data is not None and process.stdin:
            process.stdin.write(stdin_data)
            process.stdin.close()
        lines: list[str] = []
        assert process.stdout is not None
        for line in process.stdout:
            line = line.rstrip()
            if line:
                lines.append(line)
                append_tts_log(line)
        code = process.wait()
        if cancel_event is not None and cancel_event.is_set():
            raise TtsJobCancelled()
        return code, "\n".join(lines)
    finally:
        with TTS_PROCESS_LOCK:
            if TTS_ACTIVE_PROCESS is process:
                TTS_ACTIVE_PROCESS = None


def run_tts_setup(model: str, job_id: str, cancel_event: threading.Event) -> None:
    try:
        append_tts_log("FERN_TTS_PROGRESS:Preparing the local speech environment.")
        if cancel_event.is_set():
            raise TtsJobCancelled()
        # The separate speech environment is installed while no generation is
        # active; also release idle workers so setup has predictable headroom.
        GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TEXT_GENERATION_WORKER.close()
        flux2.release_pipeline()
        TTS_GENERATION_WORKER.close()
        if not tts_environment_ready():
            install_script = SCRIPTS / "install-qwen3-tts.ps1"
            powershell = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")
            if not powershell:
                raise RuntimeError("PowerShell is required to set up the separate Qwen3-TTS environment.")
            install_code, install_output = run_tts_process([
                powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(install_script),
                "-BasePython", sys.executable, "-ModelRoot", str(TTS_MODEL_ROOT),
            ], clean_python_env=False, cancel_event=cancel_event)
            if install_code:
                raise RuntimeError("Speech runtime installation failed. Retry setup; Technical diagnostics contain the installer error.")
        python = TTS_ENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        code, output = run_tts_process([
            str(python), str(SCRIPTS / "qwen3_tts_worker.py"), "setup", "--model", model,
            "--model-root", str(TTS_MODEL_ROOT),
        ], cancel_event=cancel_event)
        if code:
            try:
                message = json.loads(output.strip().splitlines()[-1]).get("error")
            except (ValueError, IndexError, AttributeError):
                message = None
            raise RuntimeError(message or "Could not download the OpenVINO speech model. Retry setup to resume the download.")
        with TTS_JOB_LOCK:
            if cancel_event.is_set():
                raise TtsJobCancelled()
            if TTS_JOB["id"] == job_id:
                TTS_JOB.update(status="complete", finishedAt=time.time(), error=None)
        append_tts_log("FERN_TTS_PROGRESS:Model setup complete. Ready to generate speech.")
    except TtsJobCancelled:
        mark_tts_stopped(job_id)
    except Exception as error:
        if cancel_event.is_set():
            mark_tts_stopped(job_id)
            return
        append_tts_log(str(error))
        summary = str(error).splitlines()[-1][:500] or "Model setup failed. Open Technical diagnostics for details."
        with TTS_JOB_LOCK:
            if TTS_JOB["id"] == job_id:
                TTS_JOB.update(status="failed", finishedAt=time.time(), error=summary)
        append_tts_log(f"FERN_TTS_PROGRESS:Setup failed: {summary}")


def run_tts_generation(payload: dict[str, Any], job_id: str, cancel_event: threading.Event | None = None) -> None:
    cancel_event = cancel_event or threading.Event()
    try:
        TEXT_GENERATION_WORKER.close()
        GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        flux2.release_pipeline()
        if cancel_event.is_set():
            raise TtsJobCancelled()
        append_tts_log("FERN_TTS_PROGRESS:Preparing a new audio take.")
        python = TTS_ENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        output_name = f"qwen3-tts-{job_id}.wav"
        request = dict(payload, outputName=output_name)
        result = TTS_GENERATION_WORKER.generate(key=(payload["model"], payload["device"]), command=[
            str(python), "-u", str(SCRIPTS / "qwen3_tts_worker.py"), "serve", "--model", payload["model"],
            "--model-root", str(TTS_MODEL_ROOT), "--outputs", str(OUTPUTS), "--device", payload["device"],
        ], request=request, cwd=ROOT, env=tts_child_env(), log=append_tts_log)
        if cancel_event.is_set():
            raise TtsJobCancelled()
        with TTS_JOB_LOCK:
            if cancel_event.is_set():
                raise TtsJobCancelled()
            if TTS_JOB["id"] == job_id:
                elapsed = time.time() - (TTS_JOB.get("startedAt") or time.time())
                result["generationSeconds"] = elapsed
                TTS_JOB.update(status="complete", finishedAt=time.time(), output=result, error=None)
        append_tts_log(f"FERN_TTS_PROGRESS:Take saved · {result.get('duration', 0):.1f}s audio · {elapsed:.1f}s total.")
    except TtsJobCancelled:
        TTS_GENERATION_WORKER.close()
        (OUTPUTS / f"qwen3-tts-{job_id}.wav").unlink(missing_ok=True)
        mark_tts_stopped(job_id)
    except Exception as error:
        if cancel_event.is_set():
            TTS_GENERATION_WORKER.close()
            (OUTPUTS / f"qwen3-tts-{job_id}.wav").unlink(missing_ok=True)
            mark_tts_stopped(job_id)
            return
        with TTS_JOB_LOCK:
            if TTS_JOB["id"] == job_id:
                TTS_JOB.update(status="failed", finishedAt=time.time(), error=str(error))
        append_tts_log(f"FERN_TTS_PROGRESS:Generation failed: {error}")

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
    if model == QWEN_TURBO_MODEL_ID:
        model_ready = qwen_turbo_model_ready()
        runtime_ready, devices = qwen_turbo_runtime_status() if model_ready else (False, set())
        checking = model_ready and runtime_ready is None
        installed = model_ready and runtime_ready is True
        selected = "INTEL_GPU" if device in ("AUTO", "INTEL_GPU") and "GPU" in devices else "CPU" if device == "CPU" and "CPU" in devices else None
        runtime_ready_for_device = bool(installed and selected is not None)
        return {
            "selectedModel": QWEN_TURBO_MODEL_ID, "runtimeReady": runtime_ready_for_device,
            "checking": checking,
            "runtimeNote": "Checking the OpenVINO runtime and available devices…" if checking else
                "Official Qwen Turbo uses the OpenVINO INT8 export." if runtime_ready_for_device else
                "OpenVINO GPU is unavailable. Select CPU explicitly to try it." if installed and device in ("AUTO", "INTEL_GPU") else
                "OpenVINO runtime is unavailable. Repair it in Preferences." if model_ready else
                "Install the official checkpoint and OpenVINO INT8 export before generating.",
            "modelId": "Qwen/Qwen-Image-2.1-Turbo", "modelDir": str(QWEN_TURBO_MODEL_ROOT),
            "pipelineClass": "OVQwenImage21Pipeline", "runtimeBackend": "OpenVINO · INT8",
            "supportsReferenceImage": True, "requestedDevice": device, "selectedDevice": selected,
            "supportsKvCache": False,
            "modelRevision": "84d3f71fff32fc6c4740b89f5556657d0c65af27",
            "adapters": [
                {"id": "INTEL_GPU", "label": "Intel GPU", "available": "GPU" in devices, "runtimeReady": bool(installed and "GPU" in devices), "note": "Checking OpenVINO devices…" if checking else None, "supportsReferenceImage": True},
                {"id": "CPU", "label": "CPU", "available": "CPU" in devices, "runtimeReady": bool(installed and "CPU" in devices), "note": "Checking OpenVINO devices…" if checking else None, "supportsReferenceImage": True},
            ],
        }
    if model == flux3.MODEL_KEY:
        return flux3.model_status(device)
    if tame_pony.is_model(model):
        with MODEL_CHECK_LOCK:
            if not MODEL_CHECK_STARTED:
                MODEL_CHECK_STARTED = True
                def check():
                    results = {}
                    for choice in ("9b", "4b", *tame_pony.MODEL_KEYS):
                        for adapter in ("AUTO", "INTEL_GPU", "NVIDIA_GPU", "CPU"):
                            try:
                                result = (
                                    tame_pony.model_status(adapter, choice)
                                    if tame_pony.is_model(choice)
                                    else flux2.model_status(adapter, choice)
                                )
                            except Exception as error:
                                result = {
                                    "runtimeReady": False,
                                    "checking": False,
                                    "runtimeNote": f"Could not check generation runtime: {error}",
                                }
                            results[(adapter, choice)] = result
                    with MODEL_CHECK_LOCK:
                        MODEL_CHECK_RESULTS.update(results)
                threading.Thread(target=check, daemon=True).start()
            cached = MODEL_CHECK_RESULTS.get((device, model))
        if cached and not cached.get("runtimeNote", "").startswith("Could not check"):
            return tame_pony.model_status(device, model)
        return dict(cached or {
            "selectedModel": model,
            "runtimeReady": False,
            "checking": True,
            "runtimeNote": "Checking OpenVINO runtime and available devices…",
            "requestedDevice": device,
            "adapters": [],
        })
    if model not in ("auto", "9b", "4b"): model = "9b"
    requested_model = model
    resolved_model = flux2.resolve_model(model, device)
    with MODEL_CHECK_LOCK:
        if not MODEL_CHECK_STARTED:
            MODEL_CHECK_STARTED = True
            def check():
                results = {}
                for choice in ("9b", "4b", *tame_pony.MODEL_KEYS):
                    for adapter in ("AUTO", "INTEL_GPU", "NVIDIA_GPU", "CPU"):
                        try:
                            result = (
                                tame_pony.model_status(adapter, choice)
                                if tame_pony.is_model(choice)
                                else flux2.model_status(adapter, choice)
                            )
                        except Exception as error:
                            result = {
                                "runtimeReady": False,
                                "checking": False,
                                "runtimeNote": f"Could not check generation runtime: {error}",
                            }
                        results[(adapter, choice)] = result
                with MODEL_CHECK_LOCK:
                    MODEL_CHECK_RESULTS.update(results)
            threading.Thread(target=check, daemon=True).start()
        cached = MODEL_CHECK_RESULTS.get((device, resolved_model))
        if cached and not cached.get("runtimeNote", "").startswith("Could not check"):
            return flux2.model_status(device, requested_model)
        return dict(MODEL_CHECK_RESULTS.get((device, resolved_model), {
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
    metadata_path = gallery_store.GALLERY_PATH
    try:
        metadata_mtime = metadata_path.stat().st_mtime_ns
    except FileNotFoundError:
        metadata_mtime = 0
    key = (OUTPUTS.stat().st_mtime_ns, metadata_mtime)
    now = time.monotonic()
    with IMAGE_LIST_LOCK:
        if IMAGE_LIST_CACHE["key"] == key and now - IMAGE_LIST_CACHE["checkedAt"] < 30:
            return list(IMAGE_LIST_CACHE["records"])
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
        records.sort(key=lambda record: record["mtime"], reverse=True)
        IMAGE_LIST_CACHE.update(key=key, checkedAt=now, records=records)
        return list(records)


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
    if model not in ("auto", QWEN_TURBO_MODEL_ID, flux3.MODEL_KEY): model_spec(model)
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
    if model == QWEN_TURBO_MODEL_ID:
        if device not in ("AUTO", "INTEL_GPU", "CPU"):
            raise ValueError("Official Qwen Turbo uses the OpenVINO Intel GPU or an explicitly selected CPU.")
        if not (qwen_turbo_runtime_ready() and qwen_turbo_model_ready()):
            raise ValueError("Install the official Qwen Turbo OpenVINO INT8 model from Preferences before generating.")
    backend = flux2
    width = int(payload.get("width", backend.DEFAULT_WIDTH))
    height = int(payload.get("height", backend.DEFAULT_HEIGHT))
    steps = int(payload.get("steps", backend.DEFAULT_STEPS))
    guidance = float(payload.get("guidance", backend.DEFAULT_GUIDANCE))
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
    if model == flux3.MODEL_KEY and reference_image is not None:
        raise ValueError("This FLUX.3 Klein OpenVINO quant currently supports text-to-image only.")
    is_tame_pony = tame_pony.is_model(model)
    if is_tame_pony and reference_image is not None:
        raise ValueError("Tame Pony SDXL currently supports text-to-image only.")

    maximum = 1920
    dimension_multiple = 8 if is_tame_pony else 32 if model == QWEN_TURBO_MODEL_ID else 16
    minimum = 512 if is_tame_pony else 256
    model_maximum = 1536 if is_tame_pony else maximum
    if width < minimum or width > model_maximum or width % dimension_multiple != 0:
        raise ValueError(f"Width must be {minimum} to {model_maximum} and divisible by {dimension_multiple}.")
    if height < minimum or height > model_maximum or height % dimension_multiple != 0:
        raise ValueError(f"Height must be {minimum} to {model_maximum} and divisible by {dimension_multiple}.")
    if model == flux3.MODEL_KEY and (width != flux3.VALIDATED_WIDTH or height != flux3.VALIDATED_HEIGHT):
        raise ValueError("This FLUX.3 quant is currently validated at 1024×1024 only.")
    if steps < 1 or steps > 50:
        raise ValueError("Steps are outside the supported range.")
    if guidance < 0 or guidance > 10:
        raise ValueError("Guidance must be 0 to 10.")
    if batch_size < 1 or batch_size > 4:
        raise ValueError("Batch size must be 1 to 4.")
    if model in (QWEN_TURBO_MODEL_ID, flux3.MODEL_KEY) and batch_size != 1:
        raise ValueError("Qwen Turbo and FLUX.3 Klein currently support one image per generation.")

    return {
        "prompt": prompt,
        "device": device,
        "width": width,
        "height": height,
        "steps": 8 if model == QWEN_TURBO_MODEL_ID else flux3.DEFAULT_STEPS if model == flux3.MODEL_KEY else steps,
        "guidance": 1.0 if model == QWEN_TURBO_MODEL_ID else flux3.DEFAULT_GUIDANCE if model == flux3.MODEL_KEY else guidance,
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
        display_message = message
        for prefix in ("FERN_QWEN_PROGRESS:", "FERN_TTS_PROGRESS:", flux3.PROGRESS_PREFIX):
            if display_message.startswith(prefix):
                display_message = display_message[len(prefix):].strip()
                break
        append_flux_log(display_message)
        if message.startswith(("Loading Flux", "Loading Qwen", "Loading Tame Pony", "Loading the OpenVINO")):
            mark_runtime(status="loading", message="Loading model for generation…", error=None)
        elif message.startswith(("Seed:", "Qwen denoising step", "Tame Pony SDXL ")):
            mark_runtime(status="ready", device=payload["device"], message="Model ready.", error=None)
        elif message.startswith("FERN_QWEN_PROGRESS:"):
            progress = message.removeprefix("FERN_QWEN_PROGRESS:").strip()
            if progress.startswith("Step "):
                mark_runtime(
                    status="ready", device=payload["device"],
                    message=f"Qwen Turbo · {progress}", error=None,
                )
            elif progress.lower().startswith(("loading", "compiling", "preparing")):
                mark_runtime(status="loading", device=payload["device"], message=progress, error=None)
        elif message.startswith(flux3.PROGRESS_PREFIX):
            progress = message.removeprefix(flux3.PROGRESS_PREFIX).strip()
            if progress.lower().startswith(("loading", "compiling", "preparing")):
                mark_runtime(status="loading", device=payload["device"], message=progress, error=None)
            elif progress.lower().startswith("completed"):
                mark_runtime(status="ready", device=payload["device"], message=progress, error=None)
        if cancel_event.is_set():
            raise FluxGenerationCancelled("Generation stopped by user.")

    stage = CACHE_DIR / ("generation-" + job_id)
    try:
        TEXT_GENERATION_WORKER.close()
        TTS_GENERATION_WORKER.close()
        if payload.get("model") != QWEN_TURBO_MODEL_ID:
            QWEN_GENERATION_WORKER.close()
        if not tame_pony.is_model(payload.get("model", "")):
            TAME_PONY_GENERATION_WORKER.close()
        GENERATION_WORKER.close()
        if payload.get("model") != flux3.MODEL_KEY:
            FLUX3_GENERATION_WORKER.close()
        if stage.resolve().parent != CACHE_DIR.resolve():
            raise ValueError("Invalid generation staging path.")
        stage.mkdir(parents=True, exist_ok=True)
        if payload["model"] == QWEN_TURBO_MODEL_ID:
            mark_runtime(
                status="loading", device=payload["device"], error=None,
                message="Preparing Qwen Turbo on the selected OpenVINO device…",
            )
        qwen_reference_path = None
        if payload["model"] == QWEN_TURBO_MODEL_ID and payload["reference_image"] is not None:
            qwen_reference_path = stage / "reference.png"
            payload["reference_image"].save(qwen_reference_path, format="PNG")
        reference_url = None
        if payload.get("reference_source"):
            header, encoded = payload["reference_source"].split(",", 1)
            extension = {
                "data:image/png;base64": "png",
                "data:image/jpeg;base64": "jpg",
                "data:image/webp;base64": "webp",
            }.get(header.lower())
            if extension is None:
                raise ValueError("Reference image must be a PNG, JPEG, or WebP upload.")
            reference_bytes = base64.b64decode(encoded, validate=True)
            reference_name = f"reference-{hashlib.sha256(reference_bytes).hexdigest()[:32]}.{extension}"
            references = DATA_DIR / "references"
            references.mkdir(parents=True, exist_ok=True)
            reference_path = references / reference_name
            if not reference_path.exists():
                reference_path.write_bytes(reference_bytes)
            reference_url = f"/references/{urllib.parse.quote(reference_name)}"
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
                "device": resolve_qwen_turbo_device(payload["device"]) if payload["model"] == QWEN_TURBO_MODEL_ID else payload["device"],
                "modelPath": str(
                    QWEN_TURBO_MODEL_ROOT
                    if payload["model"] == QWEN_TURBO_MODEL_ID
                    else flux3.MODEL_DIR
                    if payload["model"] == flux3.MODEL_KEY
                    else tame_pony.model_dir_for(payload["model"])
                    if tame_pony.is_model(payload["model"])
                    else flux2.model_dir_for(payload["device"], payload.get("model", "9b"))
                ),
                "model": payload.get("model", "9b"),
                "modelRevision": (
                    "84d3f71fff32fc6c4740b89f5556657d0c65af27"
                    if payload["model"] == QWEN_TURBO_MODEL_ID
                    else payload.get("modelRevision", model_spec(payload.get("model", "9b"))["revision"])
                ),
                "createdAt": time.time(),
            }
            if payload["model"] == QWEN_TURBO_MODEL_ID:
                python = sys.executable
                output_name = f"qwen21-turbo-{job_id}-{index + 1}.png"
                result = QWEN_GENERATION_WORKER.generate(
                    key=(QWEN_TURBO_MODEL_ID, resolve_qwen_turbo_device(payload["device"])),
                    command=[
                        str(QWEN_TURBO_PYTHON), "-u", str(SCRIPTS / "qwen21_turbo_openvino.py"),
                        "serve", str(QWEN_TURBO_MODEL_ROOT), str(CACHE_DIR),
                        "--device", resolve_qwen_turbo_device(payload["device"]),
                    ],
                    request={
                        "prompt": payload["prompt"], "width": payload["width"],
                        "height": payload["height"], "seed": seed, "outputName": output_name,
                        "outputDir": str(stage),
                        "referencePath": str(qwen_reference_path) if qwen_reference_path else None,
                    },
                    cwd=ROOT, env=qwen_turbo_child_env(), log=log_generation,
                    runtime_label="Qwen Image 2.1 Turbo",
                    progress_prefix="FERN_QWEN_PROGRESS:",
                )
                output_path = Path(result["path"])
                if output_path.resolve().parent != stage.resolve() or output_path.name != output_name:
                    raise RuntimeError("Qwen Turbo returned an image outside its generation workspace.")
                if not output_path.is_file() or output_path.stat().st_size <= 0:
                    raise RuntimeError("Qwen Turbo did not create a valid output image.")
                generation_time = float(result["generationTime"])
                if not math.isfinite(generation_time) or generation_time < 0:
                    raise RuntimeError("Qwen Turbo returned an invalid generation duration.")
                evidence_path = output_path.with_suffix(".json")
                evidence = json.loads(evidence_path.read_text(encoding="utf-8-sig"))
                if not (
                    evidence.get("modelRevision") == "84d3f71fff32fc6c4740b89f5556657d0c65af27"
                    and evidence.get("width") == payload["width"]
                    and evidence.get("height") == payload["height"]
                    and evidence.get("steps") == 8
                    and evidence.get("useKvCache") is False
                    and evidence.get("seed") == seed
                    and evidence.get("sha256") == hashlib.sha256(output_path.read_bytes()).hexdigest()
                ):
                    raise RuntimeError("Qwen Turbo output metadata failed validation.")
                with Image.open(output_path) as output_image:
                    output_image.verify()
                with Image.open(output_path) as output_image:
                    if output_image.size != (payload["width"], payload["height"]):
                        raise RuntimeError("Qwen Turbo output dimensions do not match the request.")
            elif payload["model"] == flux3.MODEL_KEY:
                output_name = f"flux3-{job_id}-{index + 1}.png"
                result = FLUX3_GENERATION_WORKER.generate(
                    key=(flux3.MODEL_KEY, payload["device"]),
                    command=[
                        str(Path(sys.executable)), "-u", str(SCRIPTS / "flux3_klein_pipeline.py"),
                        "serve", str(flux3.MODEL_DIR), "--device",
                        {"NVIDIA_GPU": "NVIDIA", "INTEL_GPU": "GPU", "CPU": "CPU"}[payload["device"]],
                    ],
                    request={
                        "prompt": payload["prompt"], "width": payload["width"],
                        "height": payload["height"], "steps": payload["steps"],
                        "seed": seed, "outputName": output_name, "outputDir": str(stage),
                    },
                    cwd=ROOT,
                    env=flux3_klein_runtime.child_env(),
                    log=log_generation,
                    runtime_label="FLUX.3 Klein",
                    progress_prefix=flux3.PROGRESS_PREFIX,
                )
                output_path = Path(result["path"])
                if output_path.resolve().parent != stage.resolve() or output_path.name != output_name:
                    raise RuntimeError("FLUX.3 Klein returned an image outside its generation workspace.")
                if not output_path.is_file() or output_path.stat().st_size <= 0:
                    raise RuntimeError("FLUX.3 Klein did not create a valid output image.")
                generation_time = float(result.get("generationTime", float("nan")))
                if not math.isfinite(generation_time) or generation_time < 0:
                    raise RuntimeError("FLUX.3 Klein returned an invalid generation duration.")
                with Image.open(output_path) as output_image:
                    output_image.verify()
                with Image.open(output_path) as output_image:
                    if output_image.size != (payload["width"], payload["height"]):
                        raise RuntimeError("FLUX.3 Klein output dimensions do not match the request.")
            elif tame_pony.is_model(payload["model"]):
                output_name = f"tame-pony-{job_id}-{index + 1}.png"
                output_path, generation_time = TAME_PONY_GENERATION_WORKER.generate(
                    cancel_event=cancel_event,
                    prompt=payload["prompt"],
                    model_key=payload["model"],
                    width=payload["width"],
                    height=payload["height"],
                    steps=payload["steps"],
                    guidance=payload["guidance"],
                    seed=seed,
                    device=payload["device"],
                    output_dir=stage,
                    output_name=output_name,
                    log=log_generation,
                )
                if output_path.resolve().parent != stage.resolve() or output_path.name != output_name:
                    raise RuntimeError("Tame Pony returned an image outside its generation workspace.")
                if not output_path.is_file() or output_path.stat().st_size <= 0:
                    raise RuntimeError("Tame Pony did not create a valid output image.")
                if not math.isfinite(generation_time) or generation_time < 0:
                    raise RuntimeError("Tame Pony returned an invalid generation duration.")
                with Image.open(output_path) as output_image:
                    output_image.verify()
                with Image.open(output_path) as output_image:
                    if output_image.size != (payload["width"], payload["height"]):
                        raise RuntimeError("Tame Pony output dimensions do not match the request.")
            else:
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
            if reference_url:
                metadata["referenceUrl"] = reference_url
            metadata["generationTime"] = round(generation_time, 1)
            last_record = image_record(output_path, metadata)
        append_flux_log(f"Batch complete | {payload['batch_size']} image(s).")
        mark_flux_job(
            status="complete",
            finishedAt=time.time(),
            output=last_record,
            error=None,
        )
        if payload["model"] == QWEN_TURBO_MODEL_ID:
            mark_runtime(status="ready", device=payload["device"], message="Qwen Turbo is ready for another image.", error=None)
        elif payload["model"] == flux3.MODEL_KEY:
            mark_runtime(status="ready", device=payload["device"], message="FLUX.3 Klein is ready for another image.", error=None)
        elif tame_pony.is_model(payload["model"]):
            mark_runtime(status="ready", device=payload["device"], message=f"{tame_pony.display_name(payload['model'])} is ready for another image.", error=None)
        cleanup_cache_when_model_idle()
    except FluxGenerationCancelled:
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TAME_PONY_GENERATION_WORKER.close()
        mark_runtime(status="idle", message="Generation stopped. Model will reload on the next generation.", error=None)
        append_flux_log("Generation stopped by user.")
        mark_flux_job(status="cancelled", finishedAt=time.time(), output=None, error=None)
    except Exception as exc:
        if cancel_event.is_set():
            QWEN_GENERATION_WORKER.close()
            FLUX3_GENERATION_WORKER.close()
            TAME_PONY_GENERATION_WORKER.close()
            mark_runtime(status="idle", message="Generation stopped. Model will reload on the next generation.", error=None)
            append_flux_log("Generation stopped by user.")
            mark_flux_job(status="cancelled", finishedAt=time.time(), output=None, error=None)
            return
        if payload.get("model") == QWEN_TURBO_MODEL_ID:
            QWEN_GENERATION_WORKER.close()
        if payload.get("model") == flux3.MODEL_KEY:
            FLUX3_GENERATION_WORKER.close()
        if tame_pony.is_model(payload.get("model", "")):
            TAME_PONY_GENERATION_WORKER.close()
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

        if parsed.path == "/api/text/status":
            self.send_json(200, text_runtime_snapshot())
            return

        if parsed.path == "/api/tts/status":
            self.send_json(200, tts_snapshot())
            return

        if parsed.path == "/api/models":
            self.send_json(200, {"models": model_library_snapshot()})
            return

        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True, "service": "fern"})
            return

        if parsed.path == "/api/flux2/status":
            query = urllib.parse.parse_qs(parsed.query)
            requested_device = query.get("device", [flux2.DEFAULT_DEVICE])[0]
            qwen_model_ready = qwen_turbo_model_ready()
            qwen_runtime_ready, _ = qwen_turbo_runtime_status() if qwen_model_ready else (False, set())
            self.send_json(
                200,
                {
                    "job": flux_job_snapshot(),
                    "images": latest_images() if query.get("images", ["1"])[0] != "0" else None,
                    "installedModels": [{"id": item["id"], "label": item["label"]} for item in model_library_snapshot() if item["installed"]]
                    + ([{"id": QWEN_TURBO_MODEL_ID, "label": "Qwen Image 2.1 Turbo · official"}] if qwen_model_ready and qwen_runtime_ready is not False else []),
                    "model": model_snapshot(requested_device, query.get("model", ["9b"])[0]),
                    "runtime": runtime_snapshot(),
                    "defaults": {
                        "device": flux2.DEFAULT_DEVICE,
                "width": (tame_pony.DEFAULT_WIDTH if tame_pony.is_model(query.get("model", [""])[0]) else flux3.DEFAULT_WIDTH if query.get("model", [""])[0] == flux3.MODEL_KEY else flux2.DEFAULT_WIDTH),
                "height": (tame_pony.DEFAULT_HEIGHT if tame_pony.is_model(query.get("model", [""])[0]) else flux3.DEFAULT_HEIGHT if query.get("model", [""])[0] == flux3.MODEL_KEY else flux2.DEFAULT_HEIGHT),
                "steps": (tame_pony.DEFAULT_STEPS if tame_pony.is_model(query.get("model", [""])[0]) else flux3.DEFAULT_STEPS if query.get("model", [""])[0] == flux3.MODEL_KEY else flux2.DEFAULT_STEPS),
                "guidance": (tame_pony.DEFAULT_GUIDANCE if tame_pony.is_model(query.get("model", [""])[0]) else flux3.DEFAULT_GUIDANCE if query.get("model", [""])[0] == flux3.MODEL_KEY else flux2.DEFAULT_GUIDANCE),
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
            size = path.stat().st_size
            try:
                requested = byte_range(self.headers.get("Range"), size)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_cors_headers()
                self.end_headers()
                return
            start, end = requested if requested else (0, size - 1)
            self.send_response(206 if requested else 200)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if requested:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_cors_headers()
            self.end_headers()
            try:
                with path.open("rb") as media:
                    media.seek(start)
                    remaining = end - start + 1
                    while remaining > 0:
                        chunk = media.read(min(remaining, 256 * 1024))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Seeking or navigating away cancels the old media request.
            return

        self.send_error(404)

    def do_POST(self) -> None:
        with JOB_ADMISSION_LOCK:
            self.handle_post()

    def handle_post(self) -> None:
        global FLUX_CANCEL_EVENT, TTS_CANCEL_EVENT, TEXT_CANCEL_EVENT
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/text/stop":
            with TEXT_JOB_LOCK:
                running = TEXT_JOB.get("status") == "running"
                if running:
                    TEXT_JOB["phase"] = "Stopping generation…"
                    cancel_event = TEXT_CANCEL_EVENT
                    if cancel_event is not None:
                        cancel_event.set()
            if running:
                TEXT_GENERATION_WORKER.interrupt()
            self.send_json(202, {"job": text_runtime_snapshot()})
            return

        if parsed.path == "/api/text/models/install":
            try:
                payload = self.read_json_body()
                model_id = payload.get("modelId")
                if not isinstance(model_id, str) or model_id not in text_model_catalog():
                    raise ValueError("Choose a recommended OpenVINO text model.")
                with TTS_JOB_LOCK:
                    audio_busy = TTS_JOB.get("status") in ("running", "setting_up", "stopping")
                with FLUX_JOB_LOCK:
                    image_busy = FLUX_JOB.get("status") == "running"
                if audio_busy or image_busy or text_job_running() or tts_job_running() or qwen_turbo_setup_running() or text_model_install_running():
                    raise ValueError("Finish the active generation or model setup before installing a text model.")
                job_id = str(uuid.uuid4())
                with TEXT_MODEL_INSTALL_LOCK:
                    TEXT_MODEL_INSTALL.update(id=job_id, status="downloading", phase="Preparing download…", error=None, modelId=model_id)
                threading.Thread(target=run_text_model_install, args=(model_id, job_id), daemon=True).start()
                self.send_json(202, text_runtime_snapshot())
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path in ("/api/text/models/import", "/api/text/models/remove"):
            try:
                payload = self.read_json_body()
                if text_job_running() or text_model_install_running():
                    raise ValueError("Wait for the current text response or model installation before changing models.")
                if parsed.path.endswith("/import"):
                    folder = payload.get("path")
                    if not isinstance(folder, str) or not folder.strip() or len(folder) > 4096:
                        raise ValueError("Choose a local OpenVINO model folder.")
                    model = TEXT_MODEL_REGISTRY.add(folder)
                else:
                    model_id = payload.get("modelId")
                    if not isinstance(model_id, str) or len(model_id) > 64:
                        raise ValueError("Choose a model to remove from the library.")
                    model = next((item for item in TEXT_MODEL_REGISTRY.snapshot() if item["id"] == model_id), None)
                    if model is None:
                        raise ValueError("That text model is no longer in the library.")
                    TEXT_GENERATION_WORKER.close()
                    TEXT_MODEL_REGISTRY.remove(model_id)
                self.send_json(200, {"model": model, "models": TEXT_MODEL_REGISTRY.snapshot()})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/api/text/generate":
            try:
                payload = self.read_json_body()
                model_id = payload.get("modelId")
                if not isinstance(model_id, str) or len(model_id) > 64:
                    raise ValueError("Select an OpenVINO text model first.")
                model = next((item for item in TEXT_MODEL_REGISTRY.snapshot() if item["id"] == model_id), None)
                if model is None or not model.get("installed"):
                    raise ValueError("Add the selected OpenVINO model folder again.")
                thread_id = payload.get("threadId")
                if not isinstance(thread_id, str) or not thread_id.startswith("text-thread-") or len(thread_id) > 100:
                    raise ValueError("The text conversation is invalid. Start a new text thread and retry.")
                messages = payload.get("messages")
                if not isinstance(messages, list) or not 1 <= len(messages) <= 100:
                    raise ValueError("A conversation must contain 1 to 100 messages.")
                safe_messages = []
                total_chars = 0
                for message in messages:
                    if not isinstance(message, dict) or message.get("role") not in ("user", "assistant"):
                        raise ValueError("The conversation contains an unsupported message.")
                    content = message.get("content")
                    if not isinstance(content, str) or not content.strip() or len(content) > 20_000:
                        raise ValueError("Each message must contain between 1 and 20,000 characters.")
                    total_chars += len(content)
                    safe_messages.append({"role": message["role"], "content": content})
                if safe_messages[-1]["role"] != "user" or any(item["role"] != ("user" if index % 2 == 0 else "assistant") for index, item in enumerate(safe_messages)):
                    raise ValueError("The last conversation message must be from you.")
                if total_chars > 80_000:
                    raise ValueError("This conversation is too long. Start a new text thread to continue.")
                system_prompt = payload.get("systemPrompt", "")
                if not isinstance(system_prompt, str) or len(system_prompt) > 10_000:
                    raise ValueError("The system prompt must be 10,000 characters or fewer.")
                device = payload.get("device", "AUTO")
                if device not in ("AUTO", "GPU", "CPU"):
                    raise ValueError("Choose Auto, Intel GPU, or CPU.")
                max_new_tokens = payload.get("maxNewTokens", 512)
                if isinstance(max_new_tokens, bool) or not isinstance(max_new_tokens, int) or not 1 <= max_new_tokens <= 8192:
                    raise ValueError("Maximum output length must be between 1 and 8,192 tokens.")
                temperature = payload.get("temperature", 0.7)
                top_p = payload.get("topP", 0.9)
                if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not 0 <= temperature <= 2:
                    raise ValueError("Temperature must be between 0 and 2.")
                if isinstance(top_p, bool) or not isinstance(top_p, (int, float)) or not 0.01 <= top_p <= 1:
                    raise ValueError("Top P must be between 0.01 and 1.")
                seed = payload.get("seed", 0)
                if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2_147_483_647:
                    raise ValueError("Seed must be an integer between 0 and 2,147,483,647.")
                with TTS_JOB_LOCK:
                    audio_busy = TTS_JOB.get("status") in ("running", "setting_up", "stopping")
                with FLUX_JOB_LOCK:
                    image_busy = FLUX_JOB.get("status") == "running"
                if audio_busy or image_busy or tts_job_running() or qwen_turbo_setup_running() or text_model_install_running():
                    raise ValueError("Finish the active image/audio job or model setup before starting a text response.")
                with TEXT_JOB_LOCK:
                    if TEXT_JOB.get("status") == "running":
                        raise ValueError("A text response is already running.")
                    job_id = payload.get("requestId") or str(uuid.uuid4())
                    if not isinstance(job_id, str) or len(job_id) > 100:
                        raise ValueError("Invalid text request ID.")
                    cancel_event = threading.Event()
                    TEXT_CANCEL_EVENT = cancel_event
                    TEXT_JOB.update(
                        id=job_id, threadId=thread_id, modelId=model_id,
                        status="running", phase="Queued…", partialText="",
                        startedAt=time.time(), finishedAt=None, result=None, error=None,
                    )
                generation = {
                    "modelId": model_id, "device": device,
                    "messages": safe_messages, "systemPrompt": system_prompt.strip(),
                    "temperature": float(temperature), "topP": float(top_p),
                    "maxNewTokens": max_new_tokens,
                    "seed": seed,
                }
                threading.Thread(target=run_text_generation, args=(generation, job_id, cancel_event), daemon=True).start()
                self.send_json(202, {"job": text_runtime_snapshot()})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        if parsed.path == "/api/tts/stop":
            with TTS_JOB_LOCK:
                if TTS_JOB["status"] not in ("running", "setting_up", "stopping"):
                    self.send_json(409, {"error": "No Qwen3-TTS job is running."})
                    return
                TTS_JOB["status"] = "stopping"
                cancel_event = TTS_CANCEL_EVENT
            if cancel_event is not None:
                cancel_event.set()
            with TTS_PROCESS_LOCK:
                process = TTS_ACTIVE_PROCESS
            terminate_tts_process(process)
            TTS_GENERATION_WORKER.interrupt()
            self.send_json(202, {"job": tts_snapshot()})
            return

        if parsed.path in ("/api/tts/setup", "/api/tts/generate"):
            try:
                payload = self.read_json_body()
                if text_job_running() or flux_job_snapshot()["status"] == "running" or qwen_turbo_setup_running() or text_model_install_running():
                    raise ValueError("Stop the active image/text response or model setup before starting an audio job.")
                model = payload.get("model")
                if model not in TTS_MODELS:
                    raise ValueError("Choose a supported Qwen3-TTS model.")
                generation = None
                if parsed.path.endswith("generate"):
                    if not tts_model_ready(model):
                        raise ValueError("Set up this Qwen3-TTS model before generating speech.")
                    text = payload.get("text")
                    if not isinstance(text, str) or not text.strip() or len(text) > 10_000:
                        raise ValueError("Enter text between 1 and 10,000 characters.")
                    language = payload.get("language", "Auto")
                    if language not in ("Auto", "Chinese", "English", "Japanese", "Korean", "French", "German", "Spanish", "Portuguese", "Russian", "Italian"):
                        raise ValueError("Choose a supported language or Auto.")
                    speaker = payload.get("speaker", "Vivian")
                    if speaker not in ("Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"):
                        raise ValueError("Choose a supported preset speaker.")
                    reference_audio = payload.get("referenceAudio")
                    if reference_audio is not None and (not isinstance(reference_audio, str) or len(reference_audio) > 16 * 1024 * 1024):
                        raise ValueError("Reference audio must be smaller than 12 MB.")
                    if TTS_MODELS[model]["kind"] == "base" and not reference_audio:
                        raise ValueError("Voice cloning requires a reference audio clip.")
                    device = payload.get("device", "AUTO")
                    if device not in ("CPU", "GPU", "AUTO"):
                        raise ValueError("Choose CPU, GPU, or Auto for OpenVINO.")
                    generation = {
                        "model": model, "text": text.strip(), "language": language,
                        "speaker": speaker, "instruction": str(payload.get("instruction", ""))[:2000],
                        "referenceText": str(payload.get("referenceText", ""))[:5000],
                        "referenceAudio": reference_audio, "device": device,
                        "max_new_tokens": payload.get("maxNewTokens", 2048),
                    }
                with TTS_JOB_LOCK:
                    if TTS_JOB["status"] in ("running", "setting_up", "stopping"):
                        self.send_json(409, {"error": "A Qwen3-TTS job is already running."})
                        return
                    job_id = str(int(time.time() * 1000))
                    cancel_event = threading.Event()
                    TTS_CANCEL_EVENT = cancel_event
                    TTS_JOB.update(
                        id=job_id, threadId=payload.get("threadId"), model=model,
                        status="setting_up" if parsed.path.endswith("setup") else "running",
                        operation="setup" if parsed.path.endswith("setup") else "generate",
                        logs=[], diagnostics=[], phase="Starting…", startedAt=time.time(), finishedAt=None, output=None, error=None,
                    )
                if parsed.path.endswith("setup"):
                    threading.Thread(target=run_tts_setup, args=(model, job_id, cancel_event), daemon=True).start()
                    self.send_json(202, {"job": tts_snapshot()})
                    return
                assert generation is not None
                threading.Thread(target=run_tts_generation, args=(generation, job_id, cancel_event), daemon=True).start()
                self.send_json(202, {"job": tts_snapshot()})
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

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
            if FLUX_JOB.get("model") == QWEN_TURBO_MODEL_ID:
                QWEN_GENERATION_WORKER.interrupt()
            elif FLUX_JOB.get("model") == flux3.MODEL_KEY:
                FLUX3_GENERATION_WORKER.interrupt()
            elif tame_pony.is_model(FLUX_JOB.get("model", "")):
                TAME_PONY_GENERATION_WORKER.interrupt()
            append_flux_log("Stopping generation...")
            self.send_json(202, {"job": flux_job_snapshot()})
            return

        if parsed.path == "/api/storage/cleanup-cache":
            with QWEN_MODEL_OPERATION_LOCK:
                current = flux_job_snapshot()
                with QWEN_JOB_LOCK:
                    qwen_setup_active = QWEN_JOB["status"] in ("setting_up", "downloading")
                if current["status"] == "running" or tts_job_running() or text_job_running() or text_model_install_running() or qwen_setup_active:
                    self.send_json(409, {"error": "Wait for the current generation or model setup to finish."})
                    return
                GENERATION_WORKER.close()
                TAME_PONY_GENERATION_WORKER.close()
                QWEN_GENERATION_WORKER.close()
                FLUX3_GENERATION_WORKER.close()
                TEXT_GENERATION_WORKER.close()
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
            with QWEN_MODEL_OPERATION_LOCK:
                current = flux_job_snapshot()
                with QWEN_JOB_LOCK:
                    qwen_setup_active = QWEN_JOB["status"] in ("setting_up", "downloading")
                if current["status"] == "running" or tts_job_running() or text_job_running() or text_model_install_running() or qwen_setup_active:
                    self.send_json(409, {"error": "Wait for the current generation or model setup to finish."})
                    return

                GENERATION_WORKER.close()
                TAME_PONY_GENERATION_WORKER.close()
                QWEN_GENERATION_WORKER.close()
                FLUX3_GENERATION_WORKER.close()
                TEXT_GENERATION_WORKER.close()
                with TEXT_JOB_LOCK:
                    TEXT_JOB.update(id=None, threadId=None, status="idle", partialText="", result=None, error=None)
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
                if model == flux3.MODEL_KEY:
                    if parsed.path.endswith("install"):
                        if flux_job_snapshot()["status"] == "running" or tts_job_running() or text_job_running() or text_model_install_running():
                            raise ValueError("Finish the active image, audio, or text job before setting up FLUX.3 Klein.")
                        if any(
                            item["state"] in ("downloading", "verifying", "removing")
                            for item in MODEL_MANAGER.snapshot()
                        ):
                            raise ValueError("Wait for the current model operation to finish.")
                        start_flux3_setup()
                    elif parsed.path.endswith("pause"):
                        cancel_flux3_setup()
                    else:
                        with FLUX_JOB_LOCK:
                            if FLUX_JOB["status"] == "running":
                                raise ValueError("Stop generation before removing FLUX.3 Klein.")
                        with FLUX3_SETUP_LOCK:
                            if FLUX3_SETUP_STATE["status"] == "installing":
                                raise ValueError("Wait for FLUX.3 runtime setup to finish before removing the model.")
                        FLUX3_GENERATION_WORKER.close()
                        MODEL_MANAGER.remove(model)
                        flux3_klein_runtime.remove_runtime()
                    self.send_json(200, {"models": model_library_snapshot()})
                    return
                if model == QWEN_TURBO_MODEL_ID:
                    if parsed.path.endswith("install"):
                        if flux_job_snapshot()["status"] == "running" or tts_job_running() or text_job_running() or text_model_install_running():
                            raise ValueError("Finish the active image, audio, or text job before setting up Qwen Turbo.")
                        start_qwen_turbo_setup()
                    elif parsed.path.endswith("pause"):
                        cancel_qwen_turbo_setup()
                    else:
                        with QWEN_MODEL_OPERATION_LOCK:
                            with FLUX_JOB_LOCK:
                                if FLUX_JOB["status"] == "running":
                                    raise ValueError("Stop generation before removing a model.")
                            with QWEN_JOB_LOCK:
                                if QWEN_JOB["status"] in ("setting_up", "downloading"):
                                    raise ValueError("Cancel setup before removing Qwen Turbo.")
                            QWEN_GENERATION_WORKER.close()
                            source_repo = QWEN_TURBO_SOURCE_ROOT / "models--Qwen--Qwen-Image-2.1-Turbo"
                            source_locks = QWEN_TURBO_SOURCE_ROOT / ".locks" / "models--Qwen--Qwen-Image-2.1-Turbo"
                            for target in (
                                QWEN_TURBO_MODEL_ROOT, QWEN_TURBO_PARTIAL_ROOT,
                                QWEN_TURBO_DOWNLOAD_ROOT, source_repo, source_locks,
                            ):
                                if target.exists() and target.resolve().is_relative_to(ROOT.resolve()):
                                    shutil.rmtree(target)
                            with QWEN_JOB_LOCK:
                                QWEN_JOB.update(
                                    status="idle", logs=[], phase=None, error=None,
                                    downloaded=0, bytes=qwen_turbo_quant_bytes(),
                                    startedAt=None, finishedAt=None,
                                )
                    self.send_json(200, {"models": model_library_snapshot()})
                    return
                model_spec(model)
                if parsed.path.endswith("install"): MODEL_MANAGER.start(model)
                elif parsed.path.endswith("pause"): MODEL_MANAGER.cancel(model)
                else:
                    with FLUX_JOB_LOCK:
                        if FLUX_JOB["status"] == "running": raise ValueError("Stop generation before removing a model.")
                        GENERATION_WORKER.close()
                        MODEL_MANAGER.remove(model)
                self.send_json(200, {"models": model_library_snapshot()})
            except Exception as error: self.send_json(400, {"error": str(error)})
            return

        if parsed.path != "/api/flux2/generate":
            self.send_error(404)
            return

        current = flux_job_snapshot()
        if current["status"] == "running":
            self.send_json(409, {"error": "A generation job is already running."})
            return
        if text_job_running() or text_model_install_running() or tts_job_running() or qwen_turbo_setup_running():
            self.send_json(409, {"error": "Stop the active text/audio response or model setup before starting image generation."})
            return

        try:
            payload = validate_flux_payload(self.read_json_body())
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})
            return

        operation_lock = (
            QWEN_MODEL_OPERATION_LOCK
            if payload["model"] == QWEN_TURBO_MODEL_ID
            else nullcontext()
        )
        with operation_lock:
            status = (
                model_snapshot(payload["device"], payload["model"])
                if payload["model"] == QWEN_TURBO_MODEL_ID
                else flux3.model_status(payload["device"])
                if payload["model"] == flux3.MODEL_KEY
                else tame_pony.model_status(payload["device"], payload["model"])
                if tame_pony.is_model(payload["model"])
                else flux2.model_status(payload["device"], payload["model"])
            )
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
        model_label = (
            "Qwen Image 2.1 Turbo · official"
            if payload["model"] == QWEN_TURBO_MODEL_ID
            else model_spec(payload["model"])["label"]
        )
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
        TAME_PONY_GENERATION_WORKER.close()
        TTS_GENERATION_WORKER.close()
        QWEN_GENERATION_WORKER.close()
        FLUX3_GENERATION_WORKER.close()
        TEXT_GENERATION_WORKER.close()
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Fern image generation API server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--cors", action="store_true", help="Allow cross-origin requests (dev mode)")
    args = parser.parse_args()
    run_server(args.port, allow_cors=args.cors)


if __name__ == "__main__":
    main()
